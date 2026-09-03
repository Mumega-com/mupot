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
//   - Every field is validated + capped before the write.
//   - request_id gives SENDER-SCOPED replay-once (UNIQUE(tenant, from_agent, request_id)) — a
//     same-sender re-send with identical content is an idempotent no-op returning the original;
//     with different content it is rejected (request_id_conflict), never a silent drop. Scoping
//     by from_agent stops one agent poisoning another's rid namespace. Dedup wins over the cap.

import type { Env, CapabilityGrant, MessageCreatedPayload } from '../types'
import { createBus } from '../bus'
import { resolveAgentRef } from '../org/resolve'
import { canOnSquad } from '../auth/capability'
import { sha256Hex } from '../lib/canonical-json'
import { TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'
import { evaluateReplyExpectation, type ReplyBasis } from './reply-expectation'

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
  projectId?: string
  targetSeat?: string
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
  project_id: string | null
  target_seat?: string | null
  body_length: number | null
  checksum_sha256: string | null
  is_intact: boolean | null
  /** Does this message ask its recipient for a reply? Server-computed, never client-supplied.
   *  See ./reply-expectation — one predicate over kind, request_id and the body prose token. */
  expects_reply?: boolean
  /** Which input decided expects_reply. 'body_token' is the weak, quotable one — a consumer
   *  that acts only on structured intent should require 'request_id_field'. */
  reply_basis?: ReplyBasis
}

async function annotateMessages(messages: InboxMessage[]): Promise<void> {
  for (const message of messages) {
    const storedLength = typeof message.body_length === 'number'
      && Number.isInteger(message.body_length)
      && message.body_length >= 0
      ? message.body_length
      : null
    const storedChecksum = typeof message.checksum_sha256 === 'string'
      && /^[0-9a-f]{64}$/.test(message.checksum_sha256)
      ? message.checksum_sha256
      : null

    message.body_length = storedLength
    message.checksum_sha256 = storedChecksum
    message.is_intact = storedLength === null || storedChecksum === null
      ? null
      : message.body.length === storedLength
        && await sha256Hex(message.body) === storedChecksum

    // Reply expectation rides in the SAME pass as integrity, deliberately. Both are read-time
    // annotations that every inbox surface needs, and three call sites already exist (read,
    // lease, dead-letters). A second, separate pass would be three more places to forget one.
    const expectation = evaluateReplyExpectation({
      kind: message.kind,
      requestId: message.request_id,
      body: message.body,
    })
    message.expects_reply = expectation.expected
    message.reply_basis = expectation.basis
  }
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
    | 'project_not_found'
    | 'project_archived'
    | 'project_access_denied'
    | 'request_id_conflict'
    | 'dispatch_fenced'
    | 'send_target_not_visible'
    | 'inbox_full'
    | 'db_error'
  detail?: string
}

export type InboxFailure = {
  ok: false
  reason: 'no_tenant' | 'invalid_agent' | 'invalid_limit' | 'consumer_fenced' | 'db_error'
  detail?: string
}

interface GuestVisibilityFence {
  squadId: string
  scopeType: CapabilityGrant['scope_type']
  scopeId: string | null
  capability: CapabilityGrant['capability']
}

interface Opts {
  now?: () => string
  idGen?: () => string
  /** Override the per-recipient unread cap (tests). Defaults to MAX_UNREAD_PER_RECIPIENT. */
  maxUnread?: number
  /** Internal task-dispatch attribution has a system sender and is authorized by the task. */
  systemProjectAttribution?: boolean
  /** Internal atomic fence for a Routine dispatch envelope. */
  routineRunFence?: { runId: string; projectId: string }
  /** Current durable guest-membership authority must still exist in the message INSERT. */
  guestVisibilityFence?: GuestVisibilityFence
}

function isRef(v: string): boolean {
  return v.length > 0 && v.length <= MAX_REF_CHARS
}

async function routineDispatchAllowed(
  env: Env,
  tenant: string,
  fence: NonNullable<Opts['routineRunFence']>,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM routine_runs rr
      WHERE rr.id = ? AND rr.tenant = ? AND rr.project_id = ? AND rr.status = 'observing'
        AND NOT EXISTS (
          SELECT 1 FROM routine_run_events requested
           WHERE requested.run_id = rr.id AND requested.tenant = rr.tenant
             AND requested.kind = 'cancellation_requested'
        )
      LIMIT 1`,
  ).bind(fence.runId, tenant, fence.projectId).first()
  return row !== null
}

// Recipient resolution is NOT done here — the tool uses the canonical, security-reviewed
// resolveAgentRef (src/org/resolve.ts): id-first, then slug with AMBIGUITY REFUSAL (a bare
// slug is not globally unique, and a LIMIT-1 slug pick is a self-poisoning defect). This
// service receives an already-resolved, existence-checked agent id as toAgent.

// Compile-time forcing function (#401 WARN follow-up, adversarial re-gate on PR #401):
// sendAgentMessage itself has NO confinement of its own — Gate 1's squad/project-visibility
// check lives one layer up, in sendToRef, and only runs for callers that go through
// resolveAgentRef + sendToRef. Before this, nothing stopped a FUTURE tool from importing this
// primitive directly with an attacker-controlled toAgent and silently getting unconfined
// tenant-wide send back — the 3 callers that already do this today (`bus/fleet-bridge.ts`
// task-dispatch, `fleet/control.ts` fixed FLEET_CONSUMER_AGENT target, `mcp/index.ts`
// `broadcast` querying an already squad-scoped set) are safe by CONTEXT, not by any check this
// function makes, and that safety is invisible at the call site. `authz` makes every caller
// spell out its authorization story: either it's the SAME SendTargetAuthz sendToRef used for
// its own confinement decision (threaded through unchanged), or the caller is one of the
// system-internal cases above and passes `{ system: true, reason: '<why this target is not
// attacker-controlled>' }`. Not read at runtime — the type is the guardrail; a new caller
// literally cannot compile without making this call.
export type SendAuthzDecision = SendTargetAuthz | { system: true; reason: string }

// ── send ────────────────────────────────────────────────────────────────────────────────
export async function sendAgentMessage(
  env: Env,
  input: SendInput,
  authz: SendAuthzDecision,
  opts: Opts = {},
): Promise<SendResult | SendFailure> {
  // authz is a compile-time forcing function, not a runtime check (see SendAuthzDecision doc
  // above) — this primitive still trusts its caller's confinement decision. Nothing to branch
  // on here; the `void` just satisfies noUnusedParameters without disguising the param as
  // dead via a leading underscore (its name documents the contract at every call site).
  void authz
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

  if (input.projectId !== undefined) {
    if (typeof input.projectId !== 'string' || !isRef(input.projectId)) {
      return { ok: false, reason: 'project_not_found' }
    }
    const access = await validateMessageProjectAccess(
      env,
      input.projectId,
      input.fromAgent,
      input.toAgent,
      opts.systemProjectAttribution === true,
    )
    if (access !== null) return { ok: false, reason: access }
  }

  const now = opts.now ?? (() => new Date().toISOString())

  // mupot#1272 adversarial-gate P1 (kasra-code, flight-20260902-seat-bind, round 2): the
  // seat-bind fix earlier in this PR made `inbox`/`inbox_lease` read-side STRICT — a caller can
  // only ever read the ONE seat its own live token is labelled with (resolveBoundSeat,
  // src/mcp/index.ts). Left alone, `send`'s write side only checked isRef(targetSeat) — any
  // syntactically valid string, typo or case-mismatch included. A `target_seat` that matches no
  // LIVE token label for the recipient creates an ORPHAN row: no `inbox`/`inbox_lease` caller can
  // ever be bound to that seat (there is no such token), `inbox_ack` needs an id nobody can
  // obtain, and `inbox_dead_letters` needs `dead_lettered_at`, which only the LEASE path sets —
  // and lease can never see the row either, so `delivery_attempts` stays 0 forever. Worse,
  // MAX_UNREAD_PER_RECIPIENT is per `to_agent` and seat-BLIND: enough orphans pin the whole
  // agent's inbox at `inbox_full`, for every seat, with no drain path — a permanent DoS any
  // peer with send rights could trigger with nothing more than a typo. Proven A/B against base
  // by kasra-review on this same PR. Validating at the WRITE side, once, here — rather than in
  // the MCP `send` tool handler — is deliberate: this primitive is also the REST send path
  // (`POST /api/inbox/send`, src/agents/inbox-routes.ts), and both must refuse the same orphan
  // shape, not just the MCP one.
  //
  // mupot#1272 adversarial-gate round 3 (kasra-review): the FIRST version of this guard refused
  // with a distinct `seat_unknown` reason + a confirming detail string — which is itself a new
  // enumeration oracle. Proven live: any caller who can send to agent X can distinguish
  // "seat exists but is not X's live label" from "no such seat at all" by the refusal alone,
  // side-effect-free, and seat labels are NOT opaque (`oauth:<email-localpart>`,
  // `[preset:<id>:<scope>]`, machine names — see the label-corpus finding on this PR's earlier
  // review round). Collapsed onto the SAME `send_target_not_visible` string this function
  // already uses for its OTHER internal existence/visibility refusals a few lines below (and
  // that `sendToRef` collapses non-admin/invisible-target failures onto, #401) — no detail, no
  // distinguishing shape. A sender cannot tell "bad seat" from "bad recipient" from any other
  // reason this string already covers.
  if (input.targetSeat !== undefined) {
    if (!isRef(input.targetSeat))
      return { ok: false, reason: 'invalid_body', detail: 'target_seat must be a valid reference string' }
    const liveSeatToken = await env.DB.prepare(
      `SELECT 1 FROM member_tokens t
        WHERE t.tenant = ?1 AND t.agent_id = ?2 AND t.label = ?3
          AND ${TOKEN_LIVE_PREDICATE('?4')}
        LIMIT 1`,
    ).bind(tenant, input.toAgent, input.targetSeat, now()).first()
    if (!liveSeatToken) {
      return { ok: false, reason: 'send_target_not_visible' }
    }
  }

  const idGen = opts.idGen ?? (() => crypto.randomUUID())
  const routineFence = opts.routineRunFence
  if (routineFence && input.projectId !== routineFence.projectId) {
    return { ok: false, reason: 'dispatch_fenced' }
  }

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
  const bodyLength = input.body.length
  const bodyChecksum = await sha256Hex(input.body)
  try {
    const values: unknown[] = [
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
      input.projectId ?? null,
      input.targetSeat ?? null,
      bodyLength,
      bodyChecksum,
    ]
    let guestVisibilitySql = ''
    const guestVisibilityFence = opts.guestVisibilityFence
    if (guestVisibilityFence) {
      guestVisibilitySql = guestVisibilityWriteFenceSql(values.length + 1)
      values.push(
        guestVisibilityFence.squadId,
        guestVisibilityFence.scopeType,
        guestVisibilityFence.scopeId,
        guestVisibilityFence.capability,
      )
    }
    const routineRunParam = values.length + 1
    const result = routineFence
      ? await env.DB.prepare(
        `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, project_id, target_seat, body_length, checksum_sha256)
              SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?12, ?13, ?14, ?15
               WHERE (SELECT COUNT(*) FROM agent_messages
                       WHERE tenant = ?2 AND to_agent = ?3 AND read_at IS NULL) < ?11
                 ${guestVisibilitySql}
                 AND EXISTS (
                   SELECT 1 FROM routine_runs rr
                    WHERE rr.id = ?${routineRunParam} AND rr.tenant = ?2 AND rr.project_id = ?12
                      AND rr.status = 'observing'
                      AND NOT EXISTS (
                        SELECT 1 FROM routine_run_events requested
                         WHERE requested.run_id = rr.id AND requested.tenant = rr.tenant
                           AND requested.kind = 'cancellation_requested'
                      )
                 )`,
      ).bind(...values, routineFence.runId).run()
      : await env.DB.prepare(
        `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, project_id, target_seat, body_length, checksum_sha256)
              SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?12, ?13, ?14, ?15
               WHERE (SELECT COUNT(*) FROM agent_messages
                       WHERE tenant = ?2 AND to_agent = ?3 AND read_at IS NULL) < ?11
                 ${guestVisibilitySql}`,
      ).bind(...values).run()
    if ((result.meta?.changes ?? 0) === 0) {
      if (routineFence && !await routineDispatchAllowed(env, tenant, routineFence)) {
        return { ok: false, reason: 'dispatch_fenced' }
      }
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
      if (guestVisibilityFence) {
        const guestStillAllowed = await guestVisibilityFenceIsCurrent(
          env,
          input.fromMember,
          input.toAgent,
          guestVisibilityFence,
        )
        const projectStillAllowed = input.projectId !== undefined
          && await validateMessageProjectAccess(
            env,
            input.projectId,
            input.fromAgent,
            input.toAgent,
            opts.systemProjectAttribution === true,
          ) === null
        if (!guestStillAllowed && !projectStillAllowed) {
          return { ok: false, reason: 'send_target_not_visible' }
        }
      }
      return { ok: false, reason: 'inbox_full', detail: `recipient at unread cap ${maxUnread}` }
    }
    const seq = Number(result.meta?.last_row_id ?? 0)

    // mumega-com#970 — the push seam. Emitted HERE and nowhere else, because this is the
    // only point at which a row is proven to have landed:
    //   * capped inbox / routine fence  -> changes === 0, returns above, no event
    //   * idempotent duplicate          -> idempotentOrConflict() above, no event
    // so "one landed message = exactly one event" holds without a dedup table. The
    // UNIQUE(tenant, from_agent, request_id) index is what makes that true, not this code.
    //
    // Delivery is the Queue's problem, not ours: durability, batching, retry and the DLQ
    // are already configured (wrangler.toml). We do not await a downstream endpoint here.
    //
    // FAIL-OPEN, DELIBERATELY. The message IS committed to D1 at this point. If the emit
    // throws, the send must still succeed — a notification failure must never roll back or
    // fail a delivered message, and the inbox remains the source of truth. The failure is
    // logged loudly rather than swallowed, because a silent emit failure would recreate the
    // exact defect this seam exists to remove: something that looks delivered and is not.
    try {
      await createBus(env).emit({
        type: 'message.created',
        tenant,
        agent_id: input.toAgent,
        actor: { kind: 'agent', id: input.fromAgent },
        payload: {
          message_id: id,
          seq,
          to_agent: input.toAgent,
          target_seat: input.targetSeat ?? null,
          from_agent: input.fromAgent,
          from_member: input.fromMember,
          kind,
          request_id: input.requestId ?? null,
          in_reply_to: input.inReplyTo ?? null,
          project_id: input.projectId ?? null,
          created_at: createdAt,
        } satisfies MessageCreatedPayload,
        ts: createdAt,
      })
    } catch (emitErr) {
      console.error(
        '[message.created] emit FAILED — message %s is committed but no push event was ' +
        'published; a subscriber will not learn of it until the inbox is read: %s',
        id,
        emitErr instanceof Error ? emitErr.message : String(emitErr),
      )
    }

    return { ok: true, id, seq, duplicate: false }
  } catch (err) {
    if (routineFence && !await routineDispatchAllowed(env, tenant, routineFence)) {
      return { ok: false, reason: 'dispatch_fenced' }
    }
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
  project_id: string | null
  target_seat: string | null
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
    (existing.in_reply_to ?? null) === (input.inReplyTo ?? null) &&
    (existing.project_id ?? null) === (input.projectId ?? null) &&
    (existing.target_seat ?? null) === (input.targetSeat ?? null)
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
    `SELECT id, seq, to_agent, kind, body, in_reply_to, project_id, target_seat FROM agent_messages
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
type InboxReader = 'bearer' | 'signed'

function readerCanRead(
  mode: string,
  reader: InboxReader,
  fencedKeyFingerprint: string | null,
  signedKeyFingerprint: string | undefined,
): boolean {
  if (reader === 'signed' && fencedKeyFingerprint !== signedKeyFingerprint) return false
  return mode === (reader === 'signed' ? 'signed_only' : 'bearer_only')
}

async function readAgentInboxForReader(
  env: Env,
  input: { agent: string; limit?: number; peek?: boolean; keyFingerprint?: string; sinceSeq?: number; seat?: string },
  reader: InboxReader,
  opts: Opts,
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
  // Cursor for streaming consumers: only rows STRICTLY above this seq are returned. This is
  // what lets an SSE stream advance past a pinned unread window (see inbox-routes /stream):
  // without it, once unread >= limit the oldest-`limit` rows never move and the stream starves.
  const sinceSeq = Number.isFinite(input.sinceSeq) && (input.sinceSeq ?? 0) > 0 ? Math.floor(input.sinceSeq as number) : 0
  const signedKeyFingerprint = reader === 'signed' && /^[a-f0-9]{64}$/.test(input.keyFingerprint ?? '')
    ? input.keyFingerprint
    : undefined
  if (reader === 'signed' && !signedKeyFingerprint) return { ok: false, reason: 'consumer_fenced' }
  const now = opts.now ?? (() => new Date().toISOString())

  const targetSeat = typeof input.seat === 'string' && input.seat.trim().length > 0 ? input.seat.trim() : null

  const cols = 'seq, id, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, project_id, target_seat, body_length, checksum_sha256'
  try {
    let messages: InboxMessage[]
    if (peek) {
      if (reader === 'signed') {
        const seatSql = targetSeat ? 'AND (target_seat = ?6 OR target_seat IS NULL)' : 'AND target_seat IS NULL'
        const binds = targetSeat
          ? [tenant, input.agent, sinceSeq, limit, signedKeyFingerprint, targetSeat]
          : [tenant, input.agent, sinceSeq, limit, signedKeyFingerprint]
        const rows = await env.DB.prepare(
          `SELECT ${cols} FROM agent_messages
            WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL AND seq > ?3
              ${seatSql}
              AND EXISTS (SELECT 1 FROM agent_inbox_fences
                           WHERE tenant = ?1 AND agent_id = ?2
                             AND mode = 'signed_only' AND key_fingerprint = ?5)
            ORDER BY seq ASC LIMIT ?4`,
        ).bind(...binds).all<InboxMessage>()
        messages = rows.results ?? []
      } else {
        const seatSql = targetSeat ? 'AND (target_seat = ?5 OR target_seat IS NULL)' : 'AND target_seat IS NULL'
        const binds = targetSeat
          ? [tenant, input.agent, sinceSeq, limit, targetSeat]
          : [tenant, input.agent, sinceSeq, limit]
        const rows = await env.DB.prepare(
          `SELECT ${cols} FROM agent_messages
            WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL AND seq > ?3
              ${seatSql}
              AND COALESCE((SELECT mode FROM agent_inbox_fences
                             WHERE tenant = ?1 AND agent_id = ?2), 'bearer_only') = 'bearer_only'
            ORDER BY seq ASC LIMIT ?4`,
        ).bind(...binds).all<InboxMessage>()
        messages = rows.results ?? []
      }
    } else {
      // Atomic consume: mark the oldest `limit` unread as read and return exactly those rows.
      // RETURNING order is unspecified → sort by seq after. Marking + reading in one statement
      // means a concurrent reader cannot also claim the same rows (delivered once).
      if (reader === 'signed') {
        const seatSql = targetSeat ? 'AND (target_seat = ?6 OR target_seat IS NULL)' : 'AND target_seat IS NULL'
        const binds = targetSeat
          ? [now(), tenant, input.agent, limit, signedKeyFingerprint, targetSeat]
          : [now(), tenant, input.agent, limit, signedKeyFingerprint]
        const rows = await env.DB.prepare(
          `UPDATE agent_messages SET read_at = ?1
            WHERE seq IN (
              SELECT seq FROM agent_messages
               WHERE tenant = ?2 AND to_agent = ?3 AND read_at IS NULL
                 ${seatSql}
                 AND EXISTS (SELECT 1 FROM agent_inbox_fences
                             WHERE tenant = ?2 AND agent_id = ?3
                               AND mode = 'signed_only' AND key_fingerprint = ?5)
               ORDER BY seq ASC LIMIT ?4
            )
          RETURNING ${cols}`,
        ).bind(...binds).all<InboxMessage>()
        messages = (rows.results ?? []).slice().sort((a, b) => Number(a.seq) - Number(b.seq))
      } else {
        const seatSql = targetSeat ? 'AND (target_seat = ?5 OR target_seat IS NULL)' : 'AND target_seat IS NULL'
        const binds = targetSeat
          ? [now(), tenant, input.agent, limit, targetSeat]
          : [now(), tenant, input.agent, limit]
        const rows = await env.DB.prepare(
          `UPDATE agent_messages SET read_at = ?1
            WHERE seq IN (
              SELECT seq FROM agent_messages
               WHERE tenant = ?2 AND to_agent = ?3 AND read_at IS NULL
                 ${seatSql}
                 AND COALESCE((SELECT mode FROM agent_inbox_fences
                               WHERE tenant = ?2 AND agent_id = ?3), 'bearer_only') = 'bearer_only'
               ORDER BY seq ASC LIMIT ?4
            )
          RETURNING ${cols}`,
        ).bind(...binds).all<InboxMessage>()
        messages = (rows.results ?? []).slice().sort((a, b) => Number(a.seq) - Number(b.seq))
      }
    }

    const fence = await env.DB.prepare(
      `SELECT mode, generation, key_fingerprint FROM agent_inbox_fences
        WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1`,
    ).bind(tenant, input.agent).first<{ mode: string; generation: number; key_fingerprint: string | null }>()
    const effectiveMode = fence?.mode ?? 'bearer_only'
    if (effectiveMode !== 'bearer_only' && effectiveMode !== 'signed_only') {
      return { ok: false, reason: 'db_error' }
    }
    if (messages.length === 0 && !readerCanRead(
      effectiveMode, reader, fence?.key_fingerprint ?? null, signedKeyFingerprint,
    )) {
      return { ok: false, reason: 'consumer_fenced' }
    }

    let remaining = 0
    if (reader === 'signed') {
      const seatSql = targetSeat ? 'AND (target_seat = ?4 OR target_seat IS NULL)' : 'AND target_seat IS NULL'
      const binds = targetSeat
        ? [tenant, input.agent, signedKeyFingerprint, targetSeat]
        : [tenant, input.agent, signedKeyFingerprint]
      const remainingRow = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM agent_messages
          WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL
            ${seatSql}
            AND EXISTS (SELECT 1 FROM agent_inbox_fences
                         WHERE tenant = ?1 AND agent_id = ?2
                           AND mode = 'signed_only' AND key_fingerprint = ?3)`,
      ).bind(...binds).first<{ n: number }>()
      remaining = Number(remainingRow?.n ?? 0)
    } else {
      const seatSql = targetSeat ? 'AND (target_seat = ?3 OR target_seat IS NULL)' : 'AND target_seat IS NULL'
      const binds = targetSeat
        ? [tenant, input.agent, targetSeat]
        : [tenant, input.agent]
      const remainingRow = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM agent_messages
          WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL
            ${seatSql}
            AND COALESCE((SELECT mode FROM agent_inbox_fences
                           WHERE tenant = ?1 AND agent_id = ?2), 'bearer_only') = 'bearer_only'`,
      ).bind(...binds).first<{ n: number }>()
      remaining = Number(remainingRow?.n ?? 0)
    }

    // normalize seq to number (D1 returns it as a number already, but be defensive)
    for (const m of messages) m.seq = Number(m.seq)
    for (const m of messages) m.project_id = m.project_id ?? null
    for (const m of messages) m.target_seat = m.target_seat ?? null
    await annotateMessages(messages)
    return { ok: true, messages, remaining }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

export function readAgentInbox(
  env: Env,
  input: { agent: string; limit?: number; peek?: boolean; sinceSeq?: number; seat?: string },
  opts: Opts = {},
): Promise<InboxResult | InboxFailure> {
  return readAgentInboxForReader(env, input, 'bearer', opts)
}

// ── lease / ack / dead-letter (#899) ───────────────────────────────────────────────────
//
// The problem this closes. `inbox` has exactly two modes and neither can express "I got it
// but I have not handled it yet": peek reads without claiming (so a crashed reader re-reads
// the same head forever), and the default consume marks the WHOLE BATCH read in one
// UPDATE…RETURNING (so a reader that dies on message #1 has already told the pot all six
// were delivered). Every harness therefore keeps a LOCAL file spool to hold the difference,
// and the spool is where the truth goes to hide: on 2026-08-10 a responder timed out on one
// oversized message five times across ~55 minutes, head-of-line blocking a queue of six, and
// in the pot those rows read simply as "read".
//
// The fix is the same shape mupot already uses for its own events (wrangler.toml:
// mupot-events -> mupot-events-dlq): a visibility lease, an explicit per-message ack, and an
// automatic dead-letter after a bounded number of attempts.
//
//   inbox_lease  hands rows out and makes them invisible until lease_expires_at, WITHOUT
//                setting read_at. A reader that dies gets the rows back when the lease
//                expires — that is the crash recovery the local spool was standing in for.
//   inbox_ack    sets read_at for the ids the caller ACTUALLY handled. Per message, so a
//                poison message at the head no longer buries the five behind it.
//   dead-letter  after MAX_DELIVERY_ATTEMPTS hand-outs the row stops being leased and
//                becomes a queryable fact in the pot instead of a file in a failed/ dir.
//
// `inbox` is untouched. Its SQL, its predicates and its two callers (the MCP tool and
// GET /api/inbox) are exactly as they were — five live seats depend on that path right now,
// and this is purely additive alongside it. A row consumed the old way simply never has
// delivery_attempts or lease_expires_at touched.
//
// The consumer fence (agent_inbox_fences, migration 0058) applies to all three, using the
// IDENTICAL bearer predicate as readAgentInboxForReader. That is not decoration: lease reads
// bodies and ack sets read_at, so an agent fenced to signed_only whose bearer token could
// still lease or ack would have the fence bypassed outright — the bearer caller could drain
// or destroy the inbox the signed consumer is supposed to own.

/** Hand-outs allowed before a message is dead-lettered instead of leased again. The 55-minute
 *  incident was ~5 retries of one message; at the default 300s lease that is ~25 minutes of
 *  blockage before the pot itself says "this one is stuck". */
export const MAX_DELIVERY_ATTEMPTS = 5
/** Default visibility timeout for a leased message. */
export const DEFAULT_LEASE_SECONDS = 300
/** Caller-override ceiling. An unbounded lease is a self-inflicted outage: nothing else can
 *  pick the message up until it expires, and there is no unlease call. */
export const MAX_LEASE_SECONDS = 3600
const MIN_LEASE_SECONDS = 1
/** Ids accepted by one inbox_ack call — the lease cap is MAX_INBOX_LIMIT, so a caller can
 *  always ack a full lease in one shot. */
const MAX_ACK_IDS = MAX_INBOX_LIMIT

export interface LeasedMessage extends InboxMessage {
  delivery_attempts: number
  lease_expires_at: string
}

export interface LeaseResult {
  ok: true
  messages: LeasedMessage[]
  /** Unread, not dead-lettered, not currently leased — i.e. how many MORE could be leased now. */
  remaining: number
  /** Unread rows parked by the dead-letter rule. Non-zero means a seat is stuck. */
  dead_lettered: number
  lease_seconds: number
}

export interface DeadLetteredMessage extends InboxMessage {
  delivery_attempts: number
  dead_lettered_at: string
  dead_letter_reason: string
}

export interface AckResult {
  ok: true
  /** Ids this call moved from unread to read. */
  acked: string[]
  /** Ids already read — idempotent success, NOT an error (a retried ack must not fail). */
  already_read: string[]
  /** Ids that are not this agent's to ack. Deliberately merges "no such message" with
   *  "exists, addressed to someone else": splitting them turns ack into a tenant-wide
   *  message-id oracle, the same class the send path collapses to send_target_not_visible. */
  refused: string[]
}

export type LeaseFailure = {
  ok: false
  reason: 'no_tenant' | 'invalid_agent' | 'invalid_limit' | 'invalid_lease' | 'consumer_fenced' | 'db_error'
  detail?: string
}

export type AckFailure = {
  ok: false
  reason: 'no_tenant' | 'invalid_agent' | 'invalid_ids' | 'consumer_fenced' | 'db_error'
  detail?: string
}

const LEASE_COLS =
  'seq, id, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, project_id, delivery_attempts, lease_expires_at, target_seat, body_length, checksum_sha256'

/** The bearer half of the 0058 consumer fence, written once so lease/ack/dead-letter cannot
 *  drift from the predicate readAgentInboxForReader enforces. `?N` numbering is caller-chosen
 *  because these statements bind different positions. */
function bearerFencePredicate(tenantParam: string, agentParam: string): string {
  return `COALESCE((SELECT mode FROM agent_inbox_fences
                     WHERE tenant = ${tenantParam} AND agent_id = ${agentParam}), 'bearer_only') = 'bearer_only'`
}

async function bearerFenceBlocks(env: Env, tenant: string, agent: string): Promise<boolean> {
  const fence = await env.DB.prepare(
    `SELECT mode FROM agent_inbox_fences WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1`,
  ).bind(tenant, agent).first<{ mode: string }>()
  return (fence?.mode ?? 'bearer_only') !== 'bearer_only'
}

/**
 * Lease the oldest unread, non-dead-lettered, non-leased messages for the caller's own inbox.
 *
 * Does NOT set read_at — only inbox_ack does. The row is hidden from the next lease until
 * lease_expires_at passes, at which point it becomes leasable again.
 */
export async function leaseAgentInbox(
  env: Env,
  input: { agent: string; limit?: number; leaseSeconds?: number; seat?: string },
  opts: Pick<Opts, 'now'> = {},
): Promise<LeaseResult | LeaseFailure> {
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

  let leaseSeconds = DEFAULT_LEASE_SECONDS
  if (input.leaseSeconds !== undefined) {
    if (typeof input.leaseSeconds !== 'number' || !Number.isFinite(input.leaseSeconds))
      return { ok: false, reason: 'invalid_lease', detail: 'lease_seconds must be a number' }
    leaseSeconds = Math.min(MAX_LEASE_SECONDS, Math.max(MIN_LEASE_SECONDS, Math.floor(input.leaseSeconds)))
  }

  const now = opts.now ?? (() => new Date().toISOString())
  const nowIso = now()
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(nowMs)) return { ok: false, reason: 'db_error', detail: 'clock' }
  const expiresIso = new Date(nowMs + leaseSeconds * 1000).toISOString()

  const targetSeat = typeof input.seat === 'string' && input.seat.trim().length > 0 ? input.seat.trim() : null

  // "Not currently leased" — NULL means never leased; a lease at or before now has expired.
  // Both timestamps are ISO-8601 UTC with a fixed shape, so lexicographic <= IS chronological.
  const leasable = (t: string, a: string, nowParam: string, seatParam: string) =>
    `tenant = ${t} AND to_agent = ${a} AND read_at IS NULL AND dead_lettered_at IS NULL
     AND (lease_expires_at IS NULL OR lease_expires_at <= ${nowParam})
     AND (CASE WHEN ${seatParam} IS NULL THEN target_seat IS NULL ELSE (target_seat = ${seatParam} OR target_seat IS NULL) END)`

  const bearerFencePredicate = (t: string, a: string) =>
    `COALESCE((SELECT mode FROM agent_inbox_fences WHERE tenant = ${t} AND agent_id = ${a}), 'bearer_only') = 'bearer_only'`

  try {
    // Step 1 — dead-letter overdue poisoned messages BEFORE the lease. Done here (not on
    // release) so a message that crashed its consumer never blocks a subsequent lease:
    // the next lease runs the reaper first and moves the row out of the way. Reaping
    // inside the lease would hand the poison message straight back to the caller.
    await env.DB.prepare(
      `UPDATE agent_messages
          SET dead_lettered_at = ?4,
              dead_letter_reason = 'max_delivery_attempts_exceeded:' || delivery_attempts
        WHERE ${leasable('?1', '?2', '?3', '?6')}
          AND delivery_attempts >= ?5
          AND ${bearerFencePredicate('?1', '?2')}`,
    ).bind(tenant, input.agent, nowIso, nowIso, MAX_DELIVERY_ATTEMPTS, targetSeat).run()

    // Step 2 — the lease. ONE statement, same shape as the existing consume: the rows are
    // selected and stamped together, so two concurrent leases cannot hand out the same row.
    // The loser's subquery re-evaluates against the winner's committed lease_expires_at (now
    // in the future) and selects nothing. delivery_attempts increments here, on hand-out —
    // the count is "times delivered", which is what the dead-letter rule needs to be true.
    const rows = await env.DB.prepare(
      `UPDATE agent_messages
          SET delivery_attempts = delivery_attempts + 1,
              lease_expires_at = ?5
        WHERE seq IN (
          SELECT seq FROM agent_messages
           WHERE ${leasable('?1', '?2', '?3', '?6')}
             AND ${bearerFencePredicate('?1', '?2')}
           ORDER BY seq ASC LIMIT ?4
        )
        RETURNING ${LEASE_COLS}`,
    ).bind(tenant, input.agent, nowIso, limit, expiresIso, targetSeat).all<LeasedMessage>()

    const messages = (rows.results ?? []).slice().sort((a, b) => Number(a.seq) - Number(b.seq))
    for (const m of messages) {
      m.seq = Number(m.seq)
      m.delivery_attempts = Number(m.delivery_attempts)
      m.project_id = m.project_id ?? null
      m.target_seat = m.target_seat ?? null
    }
    await annotateMessages(messages)

    // Post-check, mirroring readAgentInboxForReader. The pre-check above is NOT the fence —
    // it cannot be, because a fence flip between it and the UPDATE would slip through. The
    // fence is the predicate INSIDE both statements; this re-read exists only so a caller
    // that lost that race is told `consumer_fenced` rather than an ambiguous empty inbox.
    // If rows WERE claimed, they were claimed while the fence still allowed it and must be
    // returned — dropping them here would lose messages the pot has already counted as
    // delivered once.
    if (messages.length === 0 && await bearerFenceBlocks(env, tenant, input.agent)) {
      return { ok: false, reason: 'consumer_fenced' }
    }

    const counts = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN dead_lettered_at IS NULL
                   AND (lease_expires_at IS NULL OR lease_expires_at <= ?3) THEN 1 ELSE 0 END) AS leasable,
         SUM(CASE WHEN dead_lettered_at IS NOT NULL THEN 1 ELSE 0 END) AS dead
        FROM agent_messages
       WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL
         AND (CASE WHEN ?4 IS NULL THEN target_seat IS NULL ELSE (target_seat = ?4 OR target_seat IS NULL) END)`,
    ).bind(tenant, input.agent, nowIso, targetSeat).first<{ leasable: number | null; dead: number | null }>()

    return {
      ok: true,
      messages,
      remaining: Number(counts?.leasable ?? 0),
      dead_lettered: Number(counts?.dead ?? 0),
      lease_seconds: leaseSeconds,
    }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Acknowledge messages the caller ACTUALLY handled: set read_at and drop the lease.
 *
 * Only the bound recipient may ack, and only rows addressed to them — enforced in SQL by
 * `to_agent = ?`, never by trusting an argument. Acking an already-read row is an idempotent
 * no-op success: a retried ack after a network blip must not look like a failure, or every
 * caller re-invents the retry bookkeeping this tool exists to remove.
 */
export async function ackAgentMessages(
  env: Env,
  input: { agent: string; ids: string[] },
  opts: Pick<Opts, 'now'> = {},
): Promise<AckResult | AckFailure> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return { ok: false, reason: 'no_tenant' }
  if (typeof input.agent !== 'string' || !isRef(input.agent))
    return { ok: false, reason: 'invalid_agent', detail: 'agent required' }
  if (!Array.isArray(input.ids) || input.ids.length === 0)
    return { ok: false, reason: 'invalid_ids', detail: 'ids must be a non-empty array' }
  if (input.ids.length > MAX_ACK_IDS)
    return { ok: false, reason: 'invalid_ids', detail: `at most ${MAX_ACK_IDS} ids per call` }
  if (!input.ids.every((id) => typeof id === 'string' && isRef(id)))
    return { ok: false, reason: 'invalid_ids', detail: 'each id must be a non-empty string' }

  // De-duplicate so a repeated id inside ONE call cannot land in both `acked` and `refused`.
  const ids = [...new Set(input.ids)]
  const now = opts.now ?? (() => new Date().toISOString())
  const placeholders = ids.map((_, i) => `?${i + 4}`).join(', ')

  try {
    // The fence lives in the statement below and in the post-check after it — see the note in
    // leaseAgentInbox on why there is no pre-flight check here.
    // One statement, RETURNING the ids it actually moved. Rows addressed to another agent
    // never match `to_agent = ?2`, so a non-recipient's ack writes nothing at all — the
    // refusal is a property of the SQL, not of a check that could be skipped above it.
    const acked = await env.DB.prepare(
      `UPDATE agent_messages
          SET read_at = ?3, lease_expires_at = NULL
        WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL
          AND id IN (${placeholders})
          AND ${bearerFencePredicate('?1', '?2')}
        RETURNING id`,
    ).bind(tenant, input.agent, now(), ...ids).all<{ id: string }>()
    const ackedIds = new Set((acked.results ?? []).map((r) => r.id))

    // Same post-check as lease: the in-statement predicate is the fence, this only turns a
    // lost race into an honest reason instead of a silent all-refused result.
    if (ackedIds.size === 0 && await bearerFenceBlocks(env, tenant, input.agent)) {
      return { ok: false, reason: 'consumer_fenced' }
    }

    // Whatever did not move is either already-read (the caller's own row: safe to name, and
    // naming it is what makes the retry idempotent rather than ambiguous) or not theirs.
    const rest = ids.filter((id) => !ackedIds.has(id))
    const alreadyRead = new Set<string>()
    if (rest.length > 0) {
      const restPlaceholders = rest.map((_, i) => `?${i + 3}`).join(', ')
      const owned = await env.DB.prepare(
        `SELECT id FROM agent_messages
          WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NOT NULL
            AND id IN (${restPlaceholders})`,
      ).bind(tenant, input.agent, ...rest).all<{ id: string }>()
      for (const r of owned.results ?? []) alreadyRead.add(r.id)
    }

    return {
      ok: true,
      acked: ids.filter((id) => ackedIds.has(id)),
      already_read: rest.filter((id) => alreadyRead.has(id)),
      refused: rest.filter((id) => !alreadyRead.has(id)),
    }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * List the caller's dead-lettered (parked) messages, oldest first.
 *
 * This is the whole point of dead-lettering in the pot rather than in a local failed/ dir:
 * a stuck seat is a row anyone with the right to read that inbox can see, not something
 * found by grepping journalctl on one host.
 */
export async function listDeadLetteredMessages(
  env: Env,
  input: { agent: string; limit?: number },
): Promise<{ ok: true; messages: DeadLetteredMessage[]; total: number } | LeaseFailure> {
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

  try {
    // Fenced identically to lease: this returns message BODIES, so a bearer caller on a
    // signed_only agent must not be able to read its inbox through the dead-letter door.
    // The fence predicate is IN the SELECT, exactly like readAgentInboxForReader's peek path:
    // a flip landing between the pre-check and this read would otherwise disclose the bodies
    // the flip exists to withhold.
    const rows = await env.DB.prepare(
      `SELECT seq, id, from_agent, from_member, kind, body, request_id, in_reply_to, created_at,
              project_id, delivery_attempts, dead_lettered_at, dead_letter_reason, target_seat,
              body_length, checksum_sha256
         FROM agent_messages
        WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL AND dead_lettered_at IS NOT NULL
          AND ${bearerFencePredicate('?1', '?2')}
        ORDER BY seq ASC LIMIT ?3`,
    ).bind(tenant, input.agent, limit).all<DeadLetteredMessage>()
    const messages = rows.results ?? []
    for (const m of messages) {
      m.seq = Number(m.seq)
      m.delivery_attempts = Number(m.delivery_attempts)
      m.project_id = m.project_id ?? null
      m.target_seat = m.target_seat ?? null
    }
    await annotateMessages(messages)

    if (messages.length === 0 && await bearerFenceBlocks(env, tenant, input.agent)) {
      return { ok: false, reason: 'consumer_fenced' }
    }

    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM agent_messages
        WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL AND dead_lettered_at IS NOT NULL
          AND ${bearerFencePredicate('?1', '?2')}`,
    ).bind(tenant, input.agent).first<{ n: number }>()

    return { ok: true, messages, total: Number(totalRow?.n ?? 0) }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Dead-letter roll-up across every inbox in the pot — METADATA ONLY, no bodies.
 *
 * The operator question "which seat is stuck?" cannot be answered from a self-scoped tool,
 * and answering it must not quietly mint a new admin-reads-every-agent's-messages
 * capability. So this returns counts and the parking reason per agent, and nothing an
 * operator could not already infer from the fact that a seat is not draining.
 */
export async function summarizeDeadLetters(
  env: Env,
  limit = 100,
): Promise<{ ok: true; agents: Array<{ agent_id: string; dead_lettered: number; oldest_dead_lettered_at: string; max_delivery_attempts: number }> } | LeaseFailure> {
  const tenant = env.TENANT_SLUG
  if (!tenant) return { ok: false, reason: 'no_tenant' }
  const capped = Math.min(MAX_INBOX_LIMIT, Math.max(1, Math.floor(limit)))
  try {
    const rows = await env.DB.prepare(
      `SELECT to_agent AS agent_id, COUNT(*) AS dead_lettered,
              MIN(dead_lettered_at) AS oldest_dead_lettered_at,
              MAX(delivery_attempts) AS max_delivery_attempts
         FROM agent_messages
        WHERE tenant = ?1 AND read_at IS NULL AND dead_lettered_at IS NOT NULL
        GROUP BY to_agent
        ORDER BY dead_lettered DESC, to_agent ASC
        LIMIT ?2`,
    ).bind(tenant, capped).all<{
      agent_id: string; dead_lettered: number; oldest_dead_lettered_at: string; max_delivery_attempts: number
    }>()
    return {
      ok: true,
      agents: (rows.results ?? []).map((r) => ({
        agent_id: r.agent_id,
        dead_lettered: Number(r.dead_lettered),
        oldest_dead_lettered_at: r.oldest_dead_lettered_at,
        max_delivery_attempts: Number(r.max_delivery_attempts),
      })),
    }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Remove only the deterministic loopback row created by agent-connection
 * verification. Every identity/correlation field is server-derived by the
 * caller; a mismatch is a non-write, never a broad cleanup.
 */
export async function deleteAgentConnectionMessage(
  env: Env,
  input: {
    messageId: string
    agentId: string
    requestId: string
  },
): Promise<
  | { ok: true }
  | { ok: false; reason: 'message_not_found' | 'db_error' }
> {
  try {
    const result = await env.DB.prepare(
      `DELETE FROM agent_messages
        WHERE tenant = ?
          AND id = ?
          AND to_agent = ?
          AND from_agent = ?
          AND request_id = ?`,
    ).bind(
      env.TENANT_SLUG,
      input.messageId,
      input.agentId,
      input.agentId,
      input.requestId,
    ).run()
    const changed = result.meta?.changes ?? result.meta?.rows_written ?? 0
    return changed === 1
      ? { ok: true }
      : { ok: false, reason: 'message_not_found' }
  } catch {
    return { ok: false, reason: 'db_error' }
  }
}

/** Called only by the cryptographic verify-and-read boundary in fleet/signed-inbox.ts. */
export function readVerifiedSignedAgentInbox(
  env: Env,
  input: { agent: string; limit?: number; peek?: boolean; keyFingerprint: string },
  opts: Pick<Opts, 'now'> = {},
): Promise<InboxResult | InboxFailure> {
  return readAgentInboxForReader(env, input, 'signed', opts)
}

// ── send by ref (shared by the MCP `send` tool AND the HTTP /api/inbox/send route) ─────────
// Resolves a recipient REF (id or unique slug) via the canonical, security-reviewed
// resolveAgentRef (id-first, slug-ambiguity refused), then delegates to sendAgentMessage. One
// code path so the MCP and HTTP surfaces can NEVER diverge on validation/replay/cap semantics.
//
// GATE 1 (#392, welded-token send confinement): resolveAgentRef resolves ANY agent tenant-wide
// — it has to, for admin/system callers (mint_agent_token, orient, provision, fleet). But a
// non-admin, agent-bound (welded) member token calling `send`/POST /api/inbox/send must NOT be
// able to message an arbitrary agent elsewhere in the pot just because it knows (or guesses) an
// id/slug. The target is confined to:
//   (a) agents in a squad the sender can read (memberCanOnSquad/canOnSquad, ≥observer) — the
//       SAME grants machinery every other per-squad gate in this codebase uses, or
//   (b) a destination the send's own projectId scoping already authorizes: sendAgentMessage
//       ALREADY runs validateMessageProjectAccess whenever input.projectId is supplied, which
//       requires BOTH sender and recipient to sit on a squad with project_squad_access to that
//       project (this is the "project-link mapping" surface — project_squad_access is the
//       table addons/project-link's local_squad_id/local_agent_id bind into). So: when (a)
//       fails but a projectId is present, this function does NOT block early — it lets
//       sendAgentMessage's existing project-access check be the authority (OR semantics).
// Admin/owner (authz.isAdmin) keeps the current tenant-wide behavior unchanged — no visibility
// gate, original recipient_not_found/recipient_ambiguous errors preserved.
//
// Fail-closed + non-leaking: for a non-admin, EVERY path that would otherwise reveal whether a
// ref names a real-but-invisible agent vs. no agent at all (ref doesn't resolve, resolves
// ambiguously, or resolves but isn't visible with no project to fall back on) collapses to the
// SAME reason string, 'send_target_not_visible' — an attacker probing refs cannot distinguish
// "no such agent" from "exists, not yours to reach."
export interface SendTargetAuthz {
  /** org-admin/owner capability (hasCapability(grants, 'org', null, 'admin')) — preserves the
   *  pre-gate tenant-wide send behavior for admin/system-operator principals. */
  isAdmin: boolean
  /** the SENDER's own capability grants (never the recipient's) — used for the squad-visibility
   *  check (case a) only when isAdmin is false. */
  grants: CapabilityGrant[]
}

export type SendToRefResult =
  | { ok: true; id: string; seq: number; duplicate: boolean; toAgent: string }
  | {
      ok: false
      reason: 'recipient_not_found' | 'recipient_ambiguous' | 'send_target_not_visible' | SendFailure['reason']
      detail?: string
    }

// Case (a) visibility: home squad OR guest membership on a squad the sender can observe.
// #392 confined send to the recipient HOME squad only. That made guest members of a
// shared flight squad (muvps-loom is lead on hadi-mac, home 813ca010) roster-visible
// but unreachable — send_target_not_visible. Shared membership is the same authority
// as joining the squad; it does not widen to tenant-wide send. Non-admin failures still
// collapse to send_target_not_visible (no existence oracle).
function ambientVisibilityGrants(
  grants: CapabilityGrant[],
  memberId: string,
): Array<Pick<CapabilityGrant, 'scope_type' | 'scope_id' | 'capability'>> {
  const seen = new Set<string>()
  const result: Array<Pick<CapabilityGrant, 'scope_type' | 'scope_id' | 'capability'>> = []
  for (const grant of grants) {
    if (grant.member_id !== memberId) continue
    const key = `${grant.scope_type}\u0000${grant.scope_id ?? ''}\u0000${grant.capability}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      scope_type: grant.scope_type,
      scope_id: grant.scope_id,
      capability: grant.capability,
    })
  }
  return result
}

function capabilityRankSql(value: string): string {
  return `(CASE ${value}
    WHEN 'observer' THEN 1
    WHEN 'member' THEN 2
    WHEN 'lead' THEN 3
    WHEN 'admin' THEN 4
    WHEN 'owner' THEN 5
    ELSE 0 END)`
}

async function recipientVisibilityOnSenderSquads(
  env: Env,
  memberId: string,
  grants: CapabilityGrant[],
  recipient: { id: string; squad_id: string },
): Promise<{ visible: boolean; guestFence?: GuestVisibilityFence }> {
  if (await canOnSquad(env, grants, recipient.squad_id, 'observer')) {
    return { visible: true }
  }

  // Guest visibility is one bounded query, not one canOnSquad call per membership.
  // The ambient grants are a ceiling: a row is usable only when the same grant still
  // exists on a durable capability plane at this read.
  const ambient = ambientVisibilityGrants(grants, memberId)
  if (ambient.length === 0) return { visible: false }
  const ambientJson = JSON.stringify(ambient)
  const row = await env.DB.prepare(
    `WITH ambient(scope_type, scope_id, capability) AS (
            SELECT json_extract(value, '$.scope_type'),
                   json_extract(value, '$.scope_id'),
                   json_extract(value, '$.capability')
              FROM json_each(?4)
          ),
          durable_grants(scope_type, scope_id, capability) AS (
            SELECT c.scope_type, c.scope_id, a.capability
              FROM capabilities c
              JOIN ambient a
                ON a.scope_type = c.scope_type
               AND a.scope_id IS c.scope_id
               AND ${capabilityRankSql('c.capability')} >= ${capabilityRankSql('a.capability')}
             WHERE c.member_id = ?1
            UNION ALL
            SELECT 'squad', cg.squad_id, a.capability
              FROM channel_capability_grants cg
              JOIN ambient a
                ON a.scope_type = 'squad'
               AND a.scope_id = cg.squad_id
               AND ${capabilityRankSql('cg.capability')} >= ${capabilityRankSql('a.capability')}
             WHERE cg.member_id = ?1
          )
     SELECT m.squad_id, d.scope_type, d.scope_id, d.capability
       FROM memberships m
       JOIN squads s ON s.id = m.squad_id
       JOIN durable_grants d
         ON d.scope_type = 'org'
         OR (d.scope_type = 'squad' AND d.scope_id = m.squad_id)
         OR (d.scope_type = 'department' AND d.scope_id = s.department_id)
      WHERE m.agent_id = ?2
        AND m.squad_id <> ?3
      LIMIT 1`,
  ).bind(memberId, recipient.id, recipient.squad_id, ambientJson).first<{
    squad_id: string
    scope_type: CapabilityGrant['scope_type']
    scope_id: string | null
    capability: CapabilityGrant['capability']
  }>()
  if (!row) return { visible: false }
  return {
    visible: true,
    guestFence: {
      squadId: row.squad_id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      capability: row.capability,
    },
  }
}

function guestVisibilityWriteFenceSql(first: number): string {
  const squad = `?${first}`
  const scopeType = `?${first + 1}`
  const scopeId = `?${first + 2}`
  const capability = `?${first + 3}`
  return `AND (
    EXISTS (
      SELECT 1
        FROM memberships m
        JOIN squads s ON s.id = m.squad_id
       WHERE m.agent_id = ?3
         AND m.squad_id = ${squad}
         AND (
           ${scopeType} = 'org'
           OR (${scopeType} = 'squad' AND ${scopeId} = m.squad_id)
           OR (${scopeType} = 'department' AND ${scopeId} = s.department_id)
         )
         AND (
           EXISTS (
             SELECT 1 FROM capabilities c
              WHERE c.member_id = ?5
                AND c.scope_type = ${scopeType}
                AND c.scope_id IS ${scopeId}
                AND ${capabilityRankSql('c.capability')} >= ${capabilityRankSql(capability)}
           )
           OR (
             ${scopeType} = 'squad'
             AND EXISTS (
               SELECT 1 FROM channel_capability_grants cg
                WHERE cg.member_id = ?5
                  AND cg.squad_id = ${scopeId}
                  AND ${capabilityRankSql('cg.capability')} >= ${capabilityRankSql(capability)}
             )
           )
         )
    )
    OR (
      ?12 IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM projects p
         WHERE p.id = ?12
           AND p.status <> 'archived'
           AND EXISTS (
             SELECT 1 FROM memberships sender_membership
             JOIN project_squad_access sender_access
               ON sender_access.squad_id = sender_membership.squad_id
              AND sender_access.project_id = p.id
              WHERE sender_membership.agent_id = ?4
           )
           AND EXISTS (
             SELECT 1 FROM memberships recipient_membership
             JOIN project_squad_access recipient_access
               ON recipient_access.squad_id = recipient_membership.squad_id
              AND recipient_access.project_id = p.id
              WHERE recipient_membership.agent_id = ?3
           )
      )
    )
  )`
}

async function guestVisibilityFenceIsCurrent(
  env: Env,
  memberId: string,
  recipientAgentId: string,
  fence: GuestVisibilityFence,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1
       FROM memberships m
       JOIN squads s ON s.id = m.squad_id
      WHERE m.agent_id = ?1
        AND m.squad_id = ?2
        AND (
          ?4 = 'org'
          OR (?4 = 'squad' AND ?5 = m.squad_id)
          OR (?4 = 'department' AND ?5 = s.department_id)
        )
        AND (
          EXISTS (
            SELECT 1 FROM capabilities c
             WHERE c.member_id = ?3
               AND c.scope_type = ?4
               AND c.scope_id IS ?5
               AND ${capabilityRankSql('c.capability')} >= ${capabilityRankSql('?6')}
          )
          OR (
            ?4 = 'squad'
            AND EXISTS (
              SELECT 1 FROM channel_capability_grants cg
               WHERE cg.member_id = ?3
                 AND cg.squad_id = ?5
                 AND ${capabilityRankSql('cg.capability')} >= ${capabilityRankSql('?6')}
            )
          )
        )
      LIMIT 1`,
  ).bind(
    recipientAgentId,
    fence.squadId,
    memberId,
    fence.scopeType,
    fence.scopeId,
    fence.capability,
  ).first()
  return row !== null
}

// ── resolveVisibleSendTarget — the authorized pre-send visibility primitive ────────────
// Oracle-close repair (P0 fix-forward on PR #868/e117832, Loom's gate finding): the
// central-command mention-rate-wall charge (src/channels/index.ts dispatchMention) used to
// gate on bare `resolveAgentRef` — EXISTENCE only, no visibility check — before charging.
// That let any linked member with zero grants distinguish "real agent I can't see" (resolves
// → charges → 11th call surfaces a target-specific rate-limited message) from "no such agent"
// (never resolves → never charges → always send_target_not_visible): a tenant-wide agent-slug
// enumeration oracle, same class as BLOCK-3 above, reintroduced through the budget side-channel.
//
// This is CASE (a) of sendToRef's own gate below — resolveAgentRef, then (for a non-admin)
// recipientVisibleOnSenderSquads — factored out so a pre-send caller (e.g. a rate-limit charge
// gate) can ask "is this ref a REAL, VISIBLE-TO-THIS-CALLER recipient" using the EXACT SAME
// check sendToRef applies before it will ever touch sendAgentMessage, rather than
// reimplementing (and risking drift from) that logic. Any non-admin failure mode — doesn't
// resolve, resolves ambiguously, resolves but isn't squad-visible — collapses to the same
// 'send_target_not_visible' so nothing downstream of this primitive (a charge, a log line, a
// timing difference) can leak which case occurred.
//
// Deliberately does NOT implement sendToRef's case (b) projectId fallback: that fallback is only
// authoritative via sendAgentMessage's own project-access check (validateMessageProjectAccess),
// which this resolve-only primitive cannot decide. A caller with a projectId must still go
// through sendToRef itself for the send-time decision — this primitive is for pre-send
// visibility gating (e.g. rate-limit charge keys) only, never a substitute for the real send.
// sendToRef consumes this decision and carries any matched guest grant into the atomic message
// INSERT, so a membership/grant removed after preflight cannot authorize the write.
export async function resolveVisibleSendTarget(
  env: Env,
  toRef: string,
  authz: SendTargetAuthz,
): Promise<
  | { ok: true; value: { id: string; squad_id: string; slug: string; name: string } }
  | { ok: false; reason: 'recipient_not_found' | 'recipient_ambiguous' | 'send_target_not_visible' }
> {
  const resolved = await resolveAgentRef(env, toRef)
  if (!resolved.ok) {
    if (!authz.isAdmin) return { ok: false, reason: 'send_target_not_visible' }
    return { ok: false, reason: resolved.reason === 'ambiguous' ? 'recipient_ambiguous' : 'recipient_not_found' }
  }
  if (authz.isAdmin) return { ok: true, value: resolved.value }
  const memberIds = [...new Set(authz.grants.map((grant) => grant.member_id).filter(Boolean))]
  if (memberIds.length !== 1) return { ok: false, reason: 'send_target_not_visible' }
  const visibility = await recipientVisibilityOnSenderSquads(
    env,
    memberIds[0],
    authz.grants,
    resolved.value,
  )
  if (!visibility.visible) return { ok: false, reason: 'send_target_not_visible' }
  return { ok: true, value: resolved.value }
}

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
    projectId?: string
    targetSeat?: string
  },
  authz: SendTargetAuthz,
  opts: Opts = {},
): Promise<SendToRefResult> {
  const resolved = await resolveAgentRef(env, input.toRef)
  if (!resolved.ok) {
    if (!authz.isAdmin) return { ok: false, reason: 'send_target_not_visible' }
    return { ok: false, reason: resolved.reason === 'ambiguous' ? 'recipient_ambiguous' : 'recipient_not_found' }
  }

  // squadVisible stays `true` for admins (case (a) is never consulted, so it must never gate
  // the fallback-collapse below either) and is only computed — and only matters — once we know
  // we're in the non-admin path.
  let squadVisible = true
  let guestVisibilityFence: GuestVisibilityFence | undefined
  if (!authz.isAdmin) {
    if (authz.grants.some((grant) => grant.member_id !== input.fromMember)) {
      return { ok: false, reason: 'send_target_not_visible' }
    }
    const visibility = await recipientVisibilityOnSenderSquads(
      env,
      input.fromMember,
      authz.grants,
      resolved.value,
    )
    squadVisible = visibility.visible
    guestVisibilityFence = visibility.guestFence
    // Case (a) failed. Case (b) can only save it if a projectId is attached — otherwise there
    // is no other authorization surface to consult, so refuse now, before ever calling
    // sendAgentMessage (no DB write attempted, no existence oracle for the target).
    if (!squadVisible && input.projectId === undefined) {
      return { ok: false, reason: 'send_target_not_visible' }
    }
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
      projectId: input.projectId,
      targetSeat: input.targetSeat,
    },
    authz,
    guestVisibilityFence ? { ...opts, guestVisibilityFence } : opts,
  )
  if (!res.ok) {
    // Existence-oracle closure (re-gate fix, #401): once squad-visibility (case a) has failed,
    // reaching sendAgentMessage AT ALL already proves resolveAgentRef found a real agent — the
    // early `!resolved.ok` branch above is the ONLY path that returns before validation for a
    // ref that doesn't exist. So for a non-admin whose squad check failed, ANY failure reason
    // sendAgentMessage can produce here — project_not_found / project_archived /
    // project_access_denied, but just as much invalid_body / request_id_conflict / inbox_full /
    // db_error — is itself a distinguisher (a nonexistent ref can never surface those). Collapse
    // every one of them to the SAME send_target_not_visible a nonexistent ref gets. This does
    // not touch the admin path or the case-(a)-succeeded path, where the specific reason is
    // legitimate operational feedback, not a leak.
    if (!authz.isAdmin && !squadVisible) {
      return { ok: false, reason: 'send_target_not_visible' }
    }
    return res
  }
  return { ok: true, id: res.id, seq: res.seq, duplicate: res.duplicate, toAgent: resolved.value.id }
}

type MessageProjectFailure = 'project_not_found' | 'project_archived' | 'project_access_denied'

export async function validateMessageProjectAccess(
  env: Env,
  projectId: string,
  fromAgent: string,
  toAgent: string,
  systemAttribution = false,
): Promise<MessageProjectFailure | null> {
  const project = await env.DB.prepare(
    `SELECT status,
            EXISTS (
              SELECT 1 FROM memberships m
              JOIN project_squad_access psa ON psa.squad_id = m.squad_id
              WHERE psa.project_id = ?1 AND m.agent_id = ?2
            ) AS sender_allowed,
            EXISTS (
              SELECT 1 FROM memberships m
              JOIN project_squad_access psa ON psa.squad_id = m.squad_id
              WHERE psa.project_id = ?1 AND m.agent_id = ?3
            ) AS recipient_allowed
       FROM projects WHERE id = ?1 LIMIT 1`,
  ).bind(projectId, fromAgent, toAgent).first<{
    status: string
    sender_allowed: number
    recipient_allowed: number
  }>()
  if (!project) return 'project_not_found'
  if (project.status === 'archived') return 'project_archived'
  if (!systemAttribution && (!project.sender_allowed || !project.recipient_allowed)) {
    return 'project_access_denied'
  }
  return null
}
