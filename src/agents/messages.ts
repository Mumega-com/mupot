// mupot — agent↔agent durable messaging (squad → mupot migration, S3).
//
// The pure service behind the `send` / `inbox` MCP tools: persist a message to another
// agent's inbox, and read (consume) one's own inbox. This is the bus primitive mupot lacked
// — a durable, ordered, addressed, consume-once message store (see migrations/0032).
//
// Discipline (identical to the rest of the sovereign core):
//   - Tenant is env.TENANT_SLUG, NEVER client-supplied. Fail-closed if absent.
//   - The sender identity (from_agent / from_member) is the AUTHENTICATED caller, passed in
//     by the tool from auth.boundAgentId / auth.memberId — never read from args.
//   - Every field is validated + capped before the write. Writes are receipt-guarded.
//   - request_id gives replay-once (UNIQUE(tenant, request_id)) — a duplicate send is an
//     idempotent no-op returning the original, so the ACK protocol can't double-deliver.

import type { Env } from '../types'
import { resolveAgentRef } from '../org/resolve'

// ── tunables ────────────────────────────────────────────────────────────────────────────
const MAX_BODY_CHARS = 8000
const MAX_REF_CHARS = 128 // agent ids / member ids
const DEFAULT_INBOX_LIMIT = 20
const MAX_INBOX_LIMIT = 100
// Backpressure / anti-DoS: a recipient may hold at most this many UNREAD messages. A sender
// is refused (inbox_full) past the cap so a compromised agent-bound token cannot spam a
// recipient's inbox into unbounded storage growth. Reads (consume) free the budget.
export const MAX_UNREAD_PER_RECIPIENT = 1000
const KINDS = ['message', 'request', 'ack'] as const
type MessageKind = (typeof KINDS)[number]
// ACK-protocol rid shape: a uuid or a slug-ish token. Linear, bounded — no ReDoS.
const RID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

// ── types ───────────────────────────────────────────────────────────────────────────────
export interface SendInput {
  fromAgent: string
  fromMember: string
  toAgent: string
  body: string
  kind?: MessageKind
  requestId?: string
  inReplyTo?: string
}

export interface SendResult {
  ok: true
  id: string
  seq: number
  duplicate: boolean
}

export interface InboxMessage {
  seq: number
  id: string
  from_agent: string
  from_member: string
  kind: string
  body: string
  request_id: string | null
  in_reply_to: string | null
  created_at: string
}

export interface InboxResult {
  ok: true
  messages: InboxMessage[]
  remaining: number
}

export type SendFailure = {
  ok: false
  reason:
    | 'no_tenant'
    | 'invalid_from'
    | 'invalid_to'
    | 'invalid_body'
    | 'invalid_kind'
    | 'invalid_request_id'
    | 'invalid_in_reply_to'
    | 'request_id_conflict'
    | 'inbox_full'
    | 'db_error'
  detail?: string
}

export type InboxFailure = {
  ok: false
  reason: 'no_tenant' | 'invalid_agent' | 'invalid_limit' | 'db_error'
  detail?: string
}

interface Opts {
  now?: () => string
  idGen?: () => string
  /** Override the per-recipient unread cap (tests). Defaults to MAX_UNREAD_PER_RECIPIENT. */
  maxUnread?: number
}

function isRef(v: string): boolean {
  return v.length > 0 && v.length <= MAX_REF_CHARS
}

// Recipient resolution is NOT done here — the tool uses the canonical, security-reviewed
// resolveAgentRef (src/org/resolve.ts): id-first, then slug with AMBIGUITY REFUSAL (a bare
// slug is not globally unique, and a LIMIT-1 slug pick is a self-poisoning defect). This
// service receives an already-resolved, existence-checked agent id as toAgent.

// ── send ────────────────────────────────────────────────────────────────────────────────
export async function sendAgentMessage(
  env: Env,
  input: SendInput,
  opts: Opts = {},
): Promise<SendResult | SendFailure> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return { ok: false, reason: 'no_tenant' }

  if (typeof input.fromAgent !== 'string' || !isRef(input.fromAgent))
    return { ok: false, reason: 'invalid_from', detail: 'fromAgent required' }
  if (typeof input.fromMember !== 'string' || !isRef(input.fromMember))
    return { ok: false, reason: 'invalid_from', detail: 'fromMember required' }
  if (typeof input.toAgent !== 'string' || !isRef(input.toAgent))
    return { ok: false, reason: 'invalid_to', detail: 'toAgent required' }
  if (typeof input.body !== 'string' || input.body.length === 0)
    return { ok: false, reason: 'invalid_body', detail: 'body required' }
  if (input.body.length > MAX_BODY_CHARS)
    return { ok: false, reason: 'invalid_body', detail: `body exceeds ${MAX_BODY_CHARS} chars` }

  const kind: MessageKind = input.kind ?? 'message'
  if (!KINDS.includes(kind)) return { ok: false, reason: 'invalid_kind', detail: `kind ∈ ${KINDS.join('|')}` }

  if (input.requestId !== undefined && !RID_RE.test(input.requestId))
    return { ok: false, reason: 'invalid_request_id', detail: 'request_id must match [A-Za-z0-9_.:-]{1,128}' }
  if (input.inReplyTo !== undefined && !RID_RE.test(input.inReplyTo))
    return { ok: false, reason: 'invalid_in_reply_to', detail: 'in_reply_to must match [A-Za-z0-9_.:-]{1,128}' }

  const now = opts.now ?? (() => new Date().toISOString())
  const idGen = opts.idGen ?? (() => crypto.randomUUID())

  // replay-once, SENDER-SCOPED: if THIS sender already used this rid, it's idempotent only
  // when the content is identical — otherwise it's a conflict (a reused key with a different
  // message), rejected loudly so a sender is never told "delivered" for a message that wasn't.
  // Scoping by from_agent means another agent's rid namespace can't poison this one.
  if (input.requestId !== undefined) {
    const existing = await findBySenderRequestId(env, tenant, input.fromAgent, input.requestId)
    if (existing) return idempotentOrConflict(existing, input, kind)
  }

  // Backpressure / anti-DoS: the unread cap is enforced ATOMICALLY inside the INSERT —
  // INSERT … SELECT … WHERE (unread count) < cap. SQLite evaluates the guard subquery against
  // committed state under the write lock, so concurrent sends to the same recipient are
  // serialized and cannot race past the cap (a separate COUNT-then-INSERT could overshoot —
  // Codex WARN-2). changes === 0 means the guard refused the write → inbox_full. That is a
  // LEGITIMATE non-write (the cap), not a phantom drop, so it replaces assertWritten here.
  const maxUnread = opts.maxUnread ?? MAX_UNREAD_PER_RECIPIENT
  const id = idGen()
  const createdAt = now()
  try {
    const result = await env.DB.prepare(
      `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at)
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
             WHERE (SELECT COUNT(*) FROM agent_messages
                     WHERE tenant = ?2 AND to_agent = ?3 AND read_at IS NULL) < ?11`,
    )
      .bind(
        id,
        tenant,
        input.toAgent,
        input.fromAgent,
        input.fromMember,
        kind,
        input.body,
        input.requestId ?? null,
        input.inReplyTo ?? null,
        createdAt,
        maxUnread,
      )
      .run()
    if ((result.meta?.changes ?? 0) === 0) {
      // The cap guard refused — BUT a 0-row insert also means the UNIQUE(tenant, from_agent,
      // request_id) index was never consulted (no row was attempted). So a same-(sender,rid)
      // duplicate that a concurrent writer landed AFTER our pre-check would be masked as
      // inbox_full. Resolve replay-once FIRST: dedup must win over the cap, consistently with
      // the pre-check and the catch path — an idempotent retry returns its original, never a
      // spurious inbox_full for a message that actually landed.
      if (input.requestId !== undefined) {
        const existing = await findBySenderRequestId(env, tenant, input.fromAgent, input.requestId)
        if (existing) return idempotentOrConflict(existing, input, kind)
      }
      return { ok: false, reason: 'inbox_full', detail: `recipient at unread cap ${maxUnread}` }
    }
    const seq = Number(result.meta?.last_row_id ?? 0)
    return { ok: true, id, seq, duplicate: false }
  } catch (err) {
    // A UNIQUE(tenant, from_agent, request_id) collision means THIS sender already landed this
    // rid (a concurrent retry) — re-read and apply the same idempotent-or-conflict decision.
    if (input.requestId !== undefined) {
      const existing = await findBySenderRequestId(env, tenant, input.fromAgent, input.requestId)
      if (existing) return idempotentOrConflict(existing, input, kind)
    }
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

interface ExistingMessage {
  id: string
  seq: number
  to_agent: string
  kind: string
  body: string
  in_reply_to: string | null
}

/** A same-(tenant, from_agent, request_id) row: idempotent no-op iff every immutable field
 *  matches, else a conflict (the rid was reused for a DIFFERENT message — reject, never claim
 *  success for a message that was not stored). */
function idempotentOrConflict(
  existing: ExistingMessage,
  input: SendInput,
  kind: MessageKind,
): SendResult | SendFailure {
  const same =
    existing.to_agent === input.toAgent &&
    existing.kind === kind &&
    existing.body === input.body &&
    (existing.in_reply_to ?? null) === (input.inReplyTo ?? null)
  return same
    ? { ok: true, id: existing.id, seq: Number(existing.seq), duplicate: true }
    : { ok: false, reason: 'request_id_conflict', detail: 'request_id reused with different content' }
}

async function findBySenderRequestId(
  env: Env,
  tenant: string,
  fromAgent: string,
  requestId: string,
): Promise<ExistingMessage | null> {
  const row = await env.DB.prepare(
    `SELECT id, seq, to_agent, kind, body, in_reply_to FROM agent_messages
      WHERE tenant = ?1 AND from_agent = ?2 AND request_id = ?3 LIMIT 1`,
  )
    .bind(tenant, fromAgent, requestId)
    .first<ExistingMessage>()
  return row ? { ...row, seq: Number(row.seq) } : null
}

// ── inbox ───────────────────────────────────────────────────────────────────────────────
// Read the CALLER's own inbox (to_agent = agent), oldest-first. Default CONSUMES: the returned
// messages are marked read in the SAME statement (UPDATE…RETURNING), so each is delivered once
// even under concurrent reads. peek=true reads without consuming.
export async function readAgentInbox(
  env: Env,
  input: { agent: string; limit?: number; peek?: boolean },
  opts: Opts = {},
): Promise<InboxResult | InboxFailure> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return { ok: false, reason: 'no_tenant' }
  if (typeof input.agent !== 'string' || !isRef(input.agent))
    return { ok: false, reason: 'invalid_agent', detail: 'agent required' }

  let limit = DEFAULT_INBOX_LIMIT
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isFinite(input.limit))
      return { ok: false, reason: 'invalid_limit', detail: 'limit must be a number' }
    limit = Math.min(MAX_INBOX_LIMIT, Math.max(1, Math.floor(input.limit)))
  }
  const peek = input.peek === true
  const now = opts.now ?? (() => new Date().toISOString())

  const cols = 'seq, id, from_agent, from_member, kind, body, request_id, in_reply_to, created_at'
  try {
    let messages: InboxMessage[]
    if (peek) {
      const rows = await env.DB.prepare(
        `SELECT ${cols} FROM agent_messages
          WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL
          ORDER BY seq ASC LIMIT ?3`,
      )
        .bind(tenant, input.agent, limit)
        .all<InboxMessage>()
      messages = rows.results ?? []
    } else {
      // Atomic consume: mark the oldest `limit` unread as read and return exactly those rows.
      // RETURNING order is unspecified → sort by seq after. Marking + reading in one statement
      // means a concurrent reader cannot also claim the same rows (delivered once).
      const rows = await env.DB.prepare(
        `UPDATE agent_messages SET read_at = ?1
          WHERE seq IN (
            SELECT seq FROM agent_messages
             WHERE tenant = ?2 AND to_agent = ?3 AND read_at IS NULL
             ORDER BY seq ASC LIMIT ?4
          )
        RETURNING ${cols}`,
      )
        .bind(now(), tenant, input.agent, limit)
        .all<InboxMessage>()
      messages = (rows.results ?? []).slice().sort((a, b) => Number(a.seq) - Number(b.seq))
    }

    const remainingRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL`,
    )
      .bind(tenant, input.agent)
      .first<{ n: number }>()
    const remaining = Number(remainingRow?.n ?? 0)

    // normalize seq to number (D1 returns it as a number already, but be defensive)
    for (const m of messages) m.seq = Number(m.seq)
    return { ok: true, messages, remaining }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

// ── send by ref (shared by the MCP `send` tool AND the HTTP /api/inbox/send route) ─────────
// Resolves a recipient REF (id or unique slug) via the canonical, security-reviewed
// resolveAgentRef (id-first, slug-ambiguity refused), then delegates to sendAgentMessage. One
// code path so the MCP and HTTP surfaces can NEVER diverge on validation/replay/cap semantics.
export type SendToRefResult =
  | { ok: true; id: string; seq: number; duplicate: boolean; toAgent: string }
  | { ok: false; reason: 'recipient_not_found' | 'recipient_ambiguous' | SendFailure['reason']; detail?: string }

export async function sendToRef(
  env: Env,
  input: {
    fromAgent: string
    fromMember: string
    toRef: string
    body: string
    kind?: MessageKind
    requestId?: string
    inReplyTo?: string
  },
  opts: Opts = {},
): Promise<SendToRefResult> {
  const resolved = await resolveAgentRef(env, input.toRef)
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason === 'ambiguous' ? 'recipient_ambiguous' : 'recipient_not_found' }
  }
  const res = await sendAgentMessage(
    env,
    {
      fromAgent: input.fromAgent,
      fromMember: input.fromMember,
      toAgent: resolved.value.id,
      body: input.body,
      kind: input.kind,
      requestId: input.requestId,
      inReplyTo: input.inReplyTo,
    },
    opts,
  )
  if (!res.ok) return res
  return { ok: true, id: res.id, seq: res.seq, duplicate: res.duplicate, toAgent: resolved.value.id }
}
