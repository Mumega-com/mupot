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

import type { Env, CapabilityGrant } from '../types'
import { resolveAgentRef } from '../org/resolve'
import { canOnSquad } from '../auth/capability'

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
    | 'inbox_full'
    | 'db_error'
  detail?: string
}

export type InboxFailure = {
  ok: false
  reason: 'no_tenant' | 'invalid_agent' | 'invalid_limit' | 'consumer_fenced' | 'db_error'
  detail?: string
}

interface Opts {
  now?: () => string
  idGen?: () => string
  /** Override the per-recipient unread cap (tests). Defaults to MAX_UNREAD_PER_RECIPIENT. */
  maxUnread?: number
  /** Internal task-dispatch attribution has a system sender and is authorized by the task. */
  systemProjectAttribution?: boolean
}

function isRef(v: string): boolean {
  return v.length > 0 && v.length <= MAX_REF_CHARS
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
      `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, project_id)
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?12
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
        input.projectId ?? null,
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
  project_id: string | null
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
    (existing.project_id ?? null) === (input.projectId ?? null)
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
    `SELECT id, seq, to_agent, kind, body, in_reply_to, project_id FROM agent_messages
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
  input: { agent: string; limit?: number; peek?: boolean; keyFingerprint?: string },
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
  const signedKeyFingerprint = reader === 'signed' && /^[a-f0-9]{64}$/.test(input.keyFingerprint ?? '')
    ? input.keyFingerprint
    : undefined
  if (reader === 'signed' && !signedKeyFingerprint) return { ok: false, reason: 'consumer_fenced' }
  const now = opts.now ?? (() => new Date().toISOString())

  const cols = 'seq, id, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, project_id'
  try {
    let messages: InboxMessage[]
    const peekPolicyPredicate = reader === 'bearer'
      ? `AND COALESCE((
          SELECT mode FROM agent_inbox_fences
           WHERE tenant = ?1 AND agent_id = ?2
        ), 'bearer_only') = 'bearer_only'`
      : `AND EXISTS (SELECT 1 FROM agent_inbox_fences
                      WHERE tenant = ?1 AND agent_id = ?2
                        AND mode = 'signed_only' AND key_fingerprint = ?4)`
    if (peek) {
      const statement = env.DB.prepare(
        `SELECT ${cols} FROM agent_messages
          WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL
          ${peekPolicyPredicate}
          ORDER BY seq ASC LIMIT ?3`,
      )
      const rows = await (reader === 'signed'
        ? statement.bind(tenant, input.agent, limit, signedKeyFingerprint)
        : statement.bind(tenant, input.agent, limit)).all<InboxMessage>()
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
               AND ${reader === 'bearer'
                 ? `COALESCE((SELECT mode FROM agent_inbox_fences
                               WHERE tenant = ?2 AND agent_id = ?3), 'bearer_only') = 'bearer_only'`
                 : `EXISTS (SELECT 1 FROM agent_inbox_fences
                             WHERE tenant = ?2 AND agent_id = ?3
                               AND mode = 'signed_only' AND key_fingerprint = ?5)`}
             ORDER BY seq ASC LIMIT ?4
          )
        RETURNING ${cols}`,
      )
        .bind(...(reader === 'signed'
          ? [now(), tenant, input.agent, limit, signedKeyFingerprint]
          : [now(), tenant, input.agent, limit]))
        .all<InboxMessage>()
      messages = (rows.results ?? []).slice().sort((a, b) => Number(a.seq) - Number(b.seq))
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

    const remainingPredicate = reader === 'bearer'
      ? `AND COALESCE((SELECT mode FROM agent_inbox_fences
                       WHERE tenant = ?1 AND agent_id = ?2), 'bearer_only') = 'bearer_only'`
      : `AND EXISTS (SELECT 1 FROM agent_inbox_fences
                     WHERE tenant = ?1 AND agent_id = ?2
                       AND mode = 'signed_only' AND key_fingerprint = ?3)`
    const remainingStatement = env.DB.prepare(
      `SELECT COUNT(*) AS n FROM agent_messages
        WHERE tenant = ?1 AND to_agent = ?2 AND read_at IS NULL
          ${remainingPredicate}`,
    )
    const remainingRow = await (reader === 'signed'
      ? remainingStatement.bind(tenant, input.agent, signedKeyFingerprint)
      : remainingStatement.bind(tenant, input.agent)).first<{ n: number }>()
    const remaining = Number(remainingRow?.n ?? 0)

    // normalize seq to number (D1 returns it as a number already, but be defensive)
    for (const m of messages) m.seq = Number(m.seq)
    for (const m of messages) m.project_id = m.project_id ?? null
    return { ok: true, messages, remaining }
  } catch (err) {
    return { ok: false, reason: 'db_error', detail: err instanceof Error ? err.message : String(err) }
  }
}

export function readAgentInbox(
  env: Env,
  input: { agent: string; limit?: number; peek?: boolean },
  opts: Opts = {},
): Promise<InboxResult | InboxFailure> {
  return readAgentInboxForReader(env, input, 'bearer', opts)
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
  if (!authz.isAdmin) {
    squadVisible = await canOnSquad(env, authz.grants, resolved.value.squad_id, 'observer')
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
    },
    authz,
    opts,
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
