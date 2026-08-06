// mupot — agent inbox HTTP surface (squad → mupot migration, S3 follow-on).
//
// The MCP `send`/`inbox` tools serve in-session arms. But the cold-start wake-wiring (the bash
// hooks check-inbox.sh / activation-watcher.sh) speaks HTTP/curl, not MCP JSON-RPC — so it needs
// a thin HTTP mirror to poll the pot for new delegations. These routes are that mirror, over the
// SAME pure service (sendToRef / readAgentInbox), so the HTTP and MCP surfaces can never diverge.
//
//   GET  /api/inbox?peek=1&limit=N  — read the CALLER's own inbox (consume by default; peek=1
//                                     reads without consuming, for a poll that doesn't drain).
//   GET  /api/inbox/stream          — SSE stream of NEW messages (server-side poll over the
//                                     same readAgentInbox service; initial flush + subsequent
//                                     message events; ?since=<seq> to skip already-seen rows;
//                                     ?poll_ms=<N> to tune the poll cadence).
//   POST /api/inbox/send            — send to another agent (e.g. a hook ACKing a delegation).
//
// Auth: the agent's pot member-token (bearer), resolved server-side. Identity (from/to-scope)
// is the token's weld (boundAgentId) — NEVER from the request body. Inbound only (pot stays
// sealed). A non-agent-bound token is refused (only welded agents have an agent inbox).

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { sendToRef, readAgentInbox } from './messages'
import { verifyAndReadSignedInbox } from '../fleet/signed-inbox'

const MAX_BODY_BYTES = 8192

// ── inbox stream (SSE) ────────────────────────────────────────────────────────────────────
// The durable inbox is pull-only; this endpoint is the push side of #706. It is a thin SSE
// wrapper over the SAME readAgentInbox service (peek=true), so the stream can never diverge
// from the MCP/HTTP inbox surfaces on ordering or auth. It does NOT consume — consumption
// stays with the inbox tool/route so delivery and ack remain separate (matches #622's
// at-least-once framing: the stream is the notification, the consume is the ack).
const DEFAULT_STREAM_POLL_MS = 1000
const MIN_STREAM_POLL_MS = 250
const MAX_STREAM_POLL_MS = 30_000

export interface StreamMessage {
  seq: number
  id: string
  from_agent: string
  kind: string
  body: string
  request_id: string | null
  in_reply_to: string | null
  created_at: string
}

export type InboxStreamEvent =
  | { type: 'initial'; since: number; messages: StreamMessage[] }
  | { type: 'message'; message: StreamMessage }
  | { type: 'heartbeat' }

interface StreamOpts {
  /** Async sleep used between polls — injectable for tests (like now/idGen in messages.ts). */
  sleep?: (ms: number) => Promise<void>
  /** AbortSignal: when aborted (client disconnect), the generator stops polling and ends. */
  signal?: AbortSignal
}

/** Poll the agent's unread inbox on a cadence, yielding new messages (seq > since) as events.
 *  Pure + injectable: the Hono route owns auth and the SSE wire format only. */
export async function* streamInboxEvents(
  env: Env,
  input: { agent: string; since?: number; pollMs?: number; revalidate?: () => Promise<boolean> },
  opts: StreamOpts = {},
): AsyncGenerator<InboxStreamEvent> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return
  const agent = input.agent
  const since = Number.isFinite(input.since) && (input.since ?? 0) > 0 ? Math.floor(input.since as number) : 0
  const pollMs = Math.min(MAX_STREAM_POLL_MS, Math.max(MIN_STREAM_POLL_MS, Math.floor(input.pollMs ?? DEFAULT_STREAM_POLL_MS)))
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const aborted = () => opts.signal?.aborted === true

  let lastSeq = since
  const isNew = (m: StreamMessage) => m.seq > lastSeq

  // Initial flush: anything unread above the client's cursor, oldest-first.
  const initial = await readAgentInbox(env, { agent, peek: true, limit: 100, sinceSeq: lastSeq })
  if (initial.ok) {
    const fresh = initial.messages.filter(isNew)
    if (fresh.length > 0) {
      lastSeq = fresh[fresh.length - 1].seq
      yield { type: 'initial', since: lastSeq, messages: fresh }
    }
  }

  // Poll loop: re-read unread above the cursor, emit only rows newer than the last emitted seq.
  for (;;) {
    if (aborted()) return
    // P0-2: the bearer credential is re-validated every poll. A revoked token or
    // deactivated agent ends the stream rather than leaking the full inbox.
    if (input.revalidate !== undefined) {
      const stillValid = await input.revalidate()
      if (!stillValid) return
    }
    await sleep(pollMs)
    if (aborted()) return
    const res = await readAgentInbox(env, { agent, peek: true, limit: 100, sinceSeq: lastSeq })
    if (!res.ok) {
      // Transient DB failure — keep the stream alive; the client re-reads on reconnect.
      yield { type: 'heartbeat' }
      continue
    }
    const fresh = res.messages.filter((m) => m.seq > lastSeq)
    if (fresh.length === 0) {
      yield { type: 'heartbeat' }
      continue
    }
    lastSeq = fresh[fresh.length - 1].seq
    for (const m of fresh) {
      yield { type: 'message', message: m }
    }
  }
}

export const inboxApp = new Hono<{ Bindings: Env }>()

// GET /api/inbox/stream — SSE stream of new inbox messages (recipient's own inbox only).
inboxApp.get('/stream', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401) // generic — no auth oracle
  if (!id.boundAgentId) return c.json({ error: 'not_agent_bound' }, 403)

  const sinceQ = c.req.query('since')
  let since: number | undefined
  if (sinceQ !== undefined) {
    const n = Number(sinceQ)
    if (!Number.isFinite(n) || n < 0) return c.json({ error: 'invalid_since' }, 400)
    since = n
  }
  const pollMsQ = c.req.query('poll_ms')
  let pollMs: number | undefined
  if (pollMsQ !== undefined) {
    const n = Number(pollMsQ)
    if (!Number.isFinite(n) || n <= 0) return c.json({ error: 'invalid_poll_ms' }, 400)
    pollMs = n
  }

  const events = streamInboxEvents(
    c.env,
    {
      agent: id.boundAgentId,
      since,
      pollMs,
      // P0-2: re-validate the bearer credential on every poll so a revoked token or
      // deactivated agent ends the stream instead of leaking the full inbox forever.
      revalidate: async () => {
        const current = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
        return current?.boundAgentId === id.boundAgentId
      },
    },
    { signal: c.req.raw.signal },
  )
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of events) {
          // Comment frame keeps proxies from timing the connection out between polls.
          if (ev.type === 'heartbeat') {
            controller.enqueue(encoder.encode(': ping\n\n'))
            continue
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
        }
      } finally {
        try {
          controller.close()
        } catch {
          // already closed — client went away mid-frame
        }
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

type ParsedBody = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 413; error: string }

async function readJsonObjectCapped(c: Context<{ Bindings: Env }>): Promise<ParsedBody> {
  const declaredLen = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large' }
  }
  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'payload_too_large' }
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'invalid_body' }
  }
  return { ok: true, value: body as Record<string, unknown> }
}

// GET /api/inbox — read (and by default CONSUME) the authenticated agent's own inbox.
inboxApp.get('/', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401) // generic — no auth oracle
  if (!id.boundAgentId) return c.json({ error: 'not_agent_bound' }, 403)

  const peekQ = c.req.query('peek')
  const peek = peekQ === '1' || peekQ === 'true'
  let limit: number | undefined
  const limitQ = c.req.query('limit')
  if (limitQ !== undefined) {
    const n = Number(limitQ)
    if (!Number.isFinite(n)) return c.json({ error: 'invalid_limit' }, 400)
    limit = n
  }

  const res = await readAgentInbox(c.env, { agent: id.boundAgentId, peek, limit })
  if (!res.ok) {
    // Never forward a raw DB error string to the client (leak-guard, matches the MCP path).
    if (res.reason === 'db_error') return c.json({ error: res.reason }, 500)
    if (res.reason === 'consumer_fenced') return c.json({ error: res.reason }, 409)
    return c.json({ error: res.reason, detail: res.detail }, 400)
  }
  return c.json({ ok: true, messages: res.messages, remaining: res.remaining, consumed: !peek })
})

// POST /api/inbox/signed — read the signed agent's own inbox without a bearer token.
//
// This is the fleet-daemon path: the host proves possession of the registered
// Ed25519 private key, and the worker resolves the target inbox strictly from
// the signed agent_id. No request field can name some other recipient.
inboxApp.post('/signed', async (c) => {
  const parsed = await readJsonObjectCapped(c)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

  const res = await verifyAndReadSignedInbox(c.env, parsed.value)
  if (!res.ok) return c.json({ error: res.error, detail: res.detail }, res.status as 400 | 401 | 409 | 500)
  return c.json({
    ok: true,
    agent: res.agent_id,
    messages: res.messages,
    remaining: res.remaining,
    consumed: res.consumed,
  })
})

// POST /api/inbox/send — leave a message in another agent's inbox. Sender = the token's weld.
inboxApp.post('/send', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  if (!id.boundAgentId) return c.json({ error: 'not_agent_bound' }, 403)

  const parsed = await readJsonObjectCapped(c)
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)
  const body = parsed.value as { to?: unknown; body?: unknown; kind?: unknown; request_id?: unknown; in_reply_to?: unknown; project_id?: unknown }

  const to = typeof body.to === 'string' ? body.to : ''
  const text = typeof body.body === 'string' ? body.body : ''
  if (!to) return c.json({ error: 'invalid_args', detail: 'to required' }, 400)
  if (!text) return c.json({ error: 'invalid_args', detail: 'body required' }, 400)
  if (body.kind !== undefined && typeof body.kind !== 'string') return c.json({ error: 'invalid_args', detail: 'kind must be a string' }, 400)
  if (body.request_id !== undefined && typeof body.request_id !== 'string') return c.json({ error: 'invalid_args', detail: 'request_id must be a string' }, 400)
  if (body.in_reply_to !== undefined && typeof body.in_reply_to !== 'string') return c.json({ error: 'invalid_args', detail: 'in_reply_to must be a string' }, 400)
  if (body.project_id !== undefined && typeof body.project_id !== 'string') return c.json({ error: 'invalid_args', detail: 'project_id must be a string' }, 400)

  // Gate 1 (#392): confine the send target for non-admin welded tokens — the SAME rule the MCP
  // `send` tool enforces (see the docstring on sendToRef in ./messages.ts). This bearer surface
  // has no AuthContext/role, only a resolved member id, so org-admin is derived directly from
  // the member's own capability grants.
  const grants = await resolveCapabilities(c.env, id.memberId)
  const isAdmin = hasCapability(grants, 'org', null, 'admin')

  const res = await sendToRef(
    c.env,
    {
      fromAgent: id.boundAgentId,
      fromMember: id.memberId,
      toRef: to,
      body: text,
      kind: body.kind as 'message' | 'request' | 'ack' | undefined,
      requestId: typeof body.request_id === 'string' ? body.request_id : undefined,
      inReplyTo: typeof body.in_reply_to === 'string' ? body.in_reply_to : undefined,
      projectId: typeof body.project_id === 'string' ? body.project_id : undefined,
    },
    { isAdmin, grants },
  )
  if (!res.ok) {
    // Never forward a raw DB error string to the client (leak-guard, matches the MCP path).
    if (res.reason === 'db_error') return c.json({ error: res.reason }, 500)
    const status =
      res.reason === 'recipient_not_found' || res.reason === 'project_not_found' || res.reason === 'send_target_not_visible'
        ? 404
        : res.reason === 'project_access_denied'
          ? 403
          : res.reason === 'recipient_ambiguous' || res.reason === 'request_id_conflict' || res.reason === 'inbox_full' || res.reason === 'project_archived'
          ? 409
          : 400
    return c.json({ error: res.reason, detail: res.detail }, status)
  }
  return c.json({ ok: true, id: res.id, seq: res.seq, duplicate: res.duplicate, to: res.toAgent, project_id: typeof body.project_id === 'string' ? body.project_id : null })
})
