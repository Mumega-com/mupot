// mupot — agent inbox HTTP surface (squad → mupot migration, S3 follow-on).
//
// The MCP `send`/`inbox` tools serve in-session arms. But the cold-start wake-wiring (the bash
// hooks check-inbox.sh / activation-watcher.sh) speaks HTTP/curl, not MCP JSON-RPC — so it needs
// a thin HTTP mirror to poll the pot for new delegations. These routes are that mirror, over the
// SAME pure service (sendToRef / readAgentInbox), so the HTTP and MCP surfaces can never diverge.
//
//   GET  /api/inbox?peek=1&limit=N  — read the CALLER's own inbox (consume by default; peek=1
//                                     reads without consuming, for a poll that doesn't drain).
//   POST /api/inbox/send            — send to another agent (e.g. a hook ACKing a delegation).
//
// Auth: the agent's pot member-token (bearer), resolved server-side. Identity (from/to-scope)
// is the token's weld (boundAgentId) — NEVER from the request body. Inbound only (pot stays
// sealed). A non-agent-bound token is refused (only welded agents have an agent inbox).

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { sendToRef, readAgentInbox } from './messages'

const MAX_BODY_BYTES = 8192

export const inboxApp = new Hono<{ Bindings: Env }>()

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
    return c.json({ error: res.reason, detail: res.detail }, 400)
  }
  return c.json({ ok: true, messages: res.messages, remaining: res.remaining, consumed: !peek })
})

// POST /api/inbox/send — leave a message in another agent's inbox. Sender = the token's weld.
inboxApp.post('/send', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  if (!id.boundAgentId) return c.json({ error: 'not_agent_bound' }, 403)

  // size-cap before parse (byte budget — char count would let multibyte slip)
  const declaredLen = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413)
  }
  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, 413)
  }
  let body: { to?: unknown; body?: unknown; kind?: unknown; request_id?: unknown; in_reply_to?: unknown }
  try {
    body = JSON.parse(raw)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (body === null || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400)

  const to = typeof body.to === 'string' ? body.to : ''
  const text = typeof body.body === 'string' ? body.body : ''
  if (!to) return c.json({ error: 'invalid_args', detail: 'to required' }, 400)
  if (!text) return c.json({ error: 'invalid_args', detail: 'body required' }, 400)
  if (body.kind !== undefined && typeof body.kind !== 'string') return c.json({ error: 'invalid_args', detail: 'kind must be a string' }, 400)
  if (body.request_id !== undefined && typeof body.request_id !== 'string') return c.json({ error: 'invalid_args', detail: 'request_id must be a string' }, 400)
  if (body.in_reply_to !== undefined && typeof body.in_reply_to !== 'string') return c.json({ error: 'invalid_args', detail: 'in_reply_to must be a string' }, 400)

  const res = await sendToRef(c.env, {
    fromAgent: id.boundAgentId,
    fromMember: id.memberId,
    toRef: to,
    body: text,
    kind: body.kind as 'message' | 'request' | 'ack' | undefined,
    requestId: typeof body.request_id === 'string' ? body.request_id : undefined,
    inReplyTo: typeof body.in_reply_to === 'string' ? body.in_reply_to : undefined,
  })
  if (!res.ok) {
    // Never forward a raw DB error string to the client (leak-guard, matches the MCP path).
    if (res.reason === 'db_error') return c.json({ error: res.reason }, 500)
    const status =
      res.reason === 'recipient_not_found'
        ? 404
        : res.reason === 'recipient_ambiguous' || res.reason === 'request_id_conflict' || res.reason === 'inbox_full'
          ? 409
          : 400
    return c.json({ error: res.reason, detail: res.detail }, status)
  }
  return c.json({ ok: true, id: res.id, seq: res.seq, duplicate: res.duplicate, to: res.toAgent })
})
