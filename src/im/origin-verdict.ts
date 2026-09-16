// mupot#1424/#1425 slice — harness-attested human origin for task_verdict.
//
// The class of problem (Hadi, direct, 2026-09-16): today a human decides over
// Telegram only via the raw `/im/webhook` update. The next shape is a human
// talking to their OWN agent (KayHermes) in natural language; the HARNESS
// (never the LLM) stamps the message's origin onto the agent's mupot calls;
// mupot resolves that origin to the member and writes the verdict AS the
// member. No origin, or an origin that does not resolve, and the call runs
// under the agent's own seat only — unchanged from today. One call, two
// authorities.
//
// This module is the ONE place that resolution happens, called from
// task_verdict's MCP/actions handler (src/mcp/index.ts) — never re-derived
// per call site, same discipline as evaluateVerdictGates
// (src/tasks/index.ts) being the one shared verdict-gate predicate.
//
// mupot#1425 adversarial gate (kasra-review BLOCK + Athena, 2026-09-16) found
// the defect CLASS this file's first version shipped with: side effects
// (the Telegram-identity bind, the replay reservation) ran BEFORE the
// authorization they were supposed to depend on, and the new ownership
// column (agents.owner_member_id) had no target-rank ceiling. Both are fixed
// here by RE-ORDERING, not by adding more checks on top: every read-only
// conjunct (ownership, member active, chat fence, conflict of interest, rate
// limit, squad membership, the real evaluateVerdictGates predicate) runs
// FIRST, against the member's REAL fresh capabilities, with zero writes. Only
// when that dry run says "this exact task+verdict would be authorized for
// this member" does this module reserve the replay slot and (if needed)
// mint the Telegram identity bind — and those two writes land in ONE D1
// batch (see commitOriginDecision) so a thrown exception mid-commit rolls
// BOTH back atomically: "a failure reserves nothing."
//
// Trust boundary, stated plainly (also see docs/architecture/
// human-decision-channel-contract.md, "Harness-attested origin"): the HARNESS
// is the attestation boundary. mupot trusts a stamp only because (a) the
// agent seat is owned by the resolved member (agents.owner_member_id — now
// itself gated by an org-scope-local target-rank ceiling on WHO may set it,
// see src/mcp/provision.ts), (b) the member is bound to that exact chat (or
// this exact request first-binds it, only AFTER the verdict is proven
// authorized), and (c) the message is FRESH and UNREPLAYED. mupot cannot
// itself distinguish a harness-stamped human_origin from one a model typed
// into its own tool call — it never sees the raw Telegram update, only the
// stamp — so every defense that IS server-checkable is enforced here, not
// merely assumed of the harness. Freshness alone is NOT proof the harness
// told the truth about *when* the human spoke (message_at is caller-
// supplied — an injected model can stamp `new Date().toISOString()` just as
// easily as a real harness); what freshness actually buys is a short shelf
// life for a captured (chat_id, message_id) pair, so a stamp scraped from
// old context cannot be replayed indefinitely — the replay reservation and
// the per-member rate limit are what actually bound repetition. The honest
// blast radius: a caller that already holds a legitimately-`owner_member_id`
// -owned agent seat can cast, per fresh/unreplayed origin message, exactly
// the verdicts that member's OWN real capabilities would allow — no more,
// no wider, and never for a member the ceiling above would have refused to
// point that agent at in the first place.
//
// Every conjunct below is re-checked at call time (no caching across calls):
// caller is agent-bound; the agent has an owner; the owner is active; the
// origin is a well-formed, private-chat-shaped, FRESH Telegram identity; the
// origin resolves to (or is eligible to first-bind) that SAME member; the
// member is not barred by conflict of interest (the calling agent IS the
// task's assignee, OR the assignee agent's OWN owner_member_id is this same
// member — the load-bearing check now that agent_keys is empty in prod for
// the pilot agent; agent_keys' memberOwnsAssigneeAgent is kept as an
// additional, cheap, non-load-bearing check); this (member) has not already
// applied a decision within the rate window; and the member's fresh
// capabilities actually authorize this exact task+verdict
// (evaluateVerdictGates, the SAME predicate every other verdict surface
// uses). ANY conjunct false falls back to the calling agent's own
// authority — this module never raises for that; the ONLY hard failures are
// the two the caller (task_verdict) must itself refuse the whole request
// for: a non-agent-bound caller supplying human_origin at all, and a
// replayed origin message.

import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { AuthContext, Env, Member } from '../types'
import { resolveCapabilities, canOnSquad } from '../auth/capability'
import { canonicalJsonDigest } from '../lib/canonical-json'
import { MEMBER_BIND_ELIGIBLE_SQL } from '../members/project-invites'
import { memberAuth, memberForChat, memberOwnsAssigneeAgent, telegramId } from './index'
import { completeTelegramUpdate, type TelegramUpdateIdentity } from './telegram-receipts'
import { evaluateVerdictGates } from '../tasks/index'

export interface HumanOriginInput {
  channel: 'telegram'
  user_id: string
  chat_id: string
  message_id: string
  message_at: string
}

export type HumanOriginFailureReason =
  | 'invalid_origin_shape'
  | 'origin_stale'
  | 'agent_not_owned'
  | 'member_inactive'
  | 'origin_member_mismatch'
  | 'chat_already_bound'
  | 'member_not_eligible'
  | 'assignee_conflict'
  | 'origin_rate_limited'
  | 'origin_not_gate_authorized'

export type HumanOriginResolution =
  | { replayed: true }
  | { replayed: false; applied: true; member: Member; auth: AuthContext; boundNow: boolean }
  | { replayed: false; applied: false; reason: HumanOriginFailureReason }

interface OriginTaskRef {
  squad_id: string
  gate_owner: string
  assignee_agent_id: string | null
}

// Freshness window — a short shelf life for a captured (chat_id, message_id,
// message_at) triple, so a stale stamp scraped from earlier context cannot
// be replayed indefinitely. NOT proof of when the human actually spoke
// (message_at is caller-supplied) — see the trust-boundary comment above.
const FRESHNESS_MAX_AGE_MS = 10 * 60 * 1000 // 10 minutes old
const FRESHNESS_MAX_FUTURE_MS = 60 * 1000 // 60 seconds ahead of server clock

// Per-MEMBER rate window (mupot#1425 P2-5, kasra-review: keying this on the
// CALLING agent let one member who owns several agents apply many verdicts
// within one window by rotating agents — the resolved member is the real
// identity being rate-limited, so key on that, not on whichever agent
// happened to relay the message).
const RATE_LIMIT_WINDOW_MS = 30 * 1000

// Validation strictness mirrors the IM webhook path (src/im/index.ts):
// digit-only immutable ids (telegramId, the SAME validator the real webhook
// uses — no second copy of "what is a valid Telegram id"), and the identical
// private-chat invariant `/im/webhook` assumes (message.from.id ===
// message.chat.id). message_at is REQUIRED (not optional) — freshness
// cannot be checked against a timestamp the caller may omit.
type ParsedOrigin =
  | { ok: true; value: HumanOriginInput }
  | { ok: false; reason: 'invalid_origin_shape' | 'origin_stale' }

function parseHumanOrigin(raw: unknown, now: number = Date.now()): ParsedOrigin {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_origin_shape' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.channel !== 'telegram') return { ok: false, reason: 'invalid_origin_shape' }
  const userId = telegramId(obj.user_id)
  const chatId = telegramId(obj.chat_id)
  const messageId = telegramId(obj.message_id)
  if (!userId || !chatId || !messageId) return { ok: false, reason: 'invalid_origin_shape' }
  if (userId !== chatId) return { ok: false, reason: 'invalid_origin_shape' } // private-chat invariant
  if (typeof obj.message_at !== 'string') return { ok: false, reason: 'invalid_origin_shape' }
  const messageAtMs = new Date(obj.message_at).getTime()
  if (Number.isNaN(messageAtMs)) return { ok: false, reason: 'invalid_origin_shape' }

  const age = now - messageAtMs
  if (age > FRESHNESS_MAX_AGE_MS || age < -FRESHNESS_MAX_FUTURE_MS) {
    return { ok: false, reason: 'origin_stale' }
  }

  return {
    ok: true,
    value: { channel: 'telegram', user_id: userId, chat_id: chatId, message_id: messageId, message_at: obj.message_at },
  }
}

function isUniqueViolationOn(error: unknown, column: string): boolean {
  return error instanceof Error && new RegExp(`UNIQUE constraint failed: .*${column}`, 'i').test(error.message)
}

function rowsChanged(result: D1Result | undefined): number {
  return Number(result?.meta?.changes ?? 0)
}

function claimTimestamp(): string {
  const iso = new Date().toISOString()
  const random = new Uint32Array(1)
  crypto.getRandomValues(random)
  const suffix = String(random[0] % 1_000_000).padStart(6, '0')
  return iso.replace('Z', `${suffix}Z`)
}

async function recentAppliedOriginExists(env: Env, memberId: string, nowMs: number): Promise<boolean> {
  const cutoff = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString()
  const row = await env.DB.prepare(
    `SELECT 1
       FROM task_verdicts
      WHERE decided_by = ?1
        AND decided_via = 'agent_attested_origin'
        AND decided_at > ?2
      LIMIT 1`,
  ).bind(memberId, cutoff).first<{ 1: number }>()
  return row !== null
}

/**
 * Conflict of interest. mupot#1425 P0-3 (kasra-review): the ORIGINAL check
 * here was memberOwnsAssigneeAgent (agent_keys) alone — proven empty in prod
 * for the pilot agent by this PR's own migration header, making it a no-op
 * for exactly the deployment this ships for. The LOAD-BEARING checks now
 * are direct: the calling agent cannot BE the task's assignee (it would be
 * approving its own work using a stamp it wrote itself), and the resolved
 * member cannot be the OWNER of the assignee agent (agents.owner_member_id)
 * — the same ownership fact this module already trusts for the calling
 * agent, applied to the assignee side too. agent_keys is kept as an
 * additional, cheap, non-load-bearing check for the day it is populated.
 */
async function hasConflictOfInterest(
  env: Env,
  boundAgentId: string,
  memberId: string,
  assigneeAgentId: string | null,
): Promise<boolean> {
  if (!assigneeAgentId) return false
  if (assigneeAgentId === boundAgentId) return true
  const assignee = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?')
    .bind(assigneeAgentId)
    .first<{ owner_member_id: string | null }>()
  if (assignee?.owner_member_id === memberId) return true
  return memberOwnsAssigneeAgent(env, memberId, assigneeAgentId)
}

type DryRunResult =
  | { ok: true; owner: Member; needsFirstBind: boolean; auth: AuthContext }
  | { ok: false; reason: HumanOriginFailureReason }

/**
 * Every conjunct EXCEPT replay, entirely READ-ONLY. Returns whether this
 * exact (member, task, verdict) triple would be authorized — used to decide
 * whether to commit ANY write at all. mupot#1425 P0-2 (kasra-review): the
 * previous version minted the Telegram bind and the replay reservation
 * before this check ever ran, so an agent owned by a member with ZERO
 * capabilities could still durably bind a caller-supplied chat_id to that
 * member — a credential mint that did not require the ability to cast a
 * verdict. Nothing below writes to D1.
 */
async function dryRunAuthorize(
  env: Env,
  boundAgentId: string,
  origin: HumanOriginInput,
  verdict: 'approved' | 'rejected',
  task: OriginTaskRef,
): Promise<DryRunResult> {
  // (1) the calling agent must be OWNED by a member — agents.owner_member_id
  // (0155), re-read fresh every call, never cached across a session. Setting
  // this column is itself now rank-ceilinged (src/mcp/provision.ts) — an
  // actor without standing over the target member can never make this row
  // true for that member, closing the K1/K1b escalation chain at its source.
  const agentRow = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?')
    .bind(boundAgentId)
    .first<{ owner_member_id: string | null }>()
  const ownerMemberId = agentRow?.owner_member_id ?? null
  if (!ownerMemberId) return { ok: false, reason: 'agent_not_owned' }

  const owner = await env.DB.prepare(
    `SELECT id, email, display_name, telegram_chat_id, status, created_at
       FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  ).bind(ownerMemberId, env.TENANT_SLUG).first<Member>()
  if (!owner || owner.status !== 'active') {
    return { ok: false, reason: 'member_inactive' }
  }

  // (2) chat fence — read-only. A first-bind is only a CANDIDATE at this
  // point (`needsFirstBind`); nothing is written until authorization is
  // proven below.
  const needsFirstBind = owner.telegram_chat_id === null
  if (!needsFirstBind && owner.telegram_chat_id !== origin.chat_id) {
    return { ok: false, reason: 'origin_member_mismatch' }
  }

  // (3) conflict of interest — see hasConflictOfInterest's own doc comment.
  if (await hasConflictOfInterest(env, boundAgentId, owner.id, task.assignee_agent_id)) {
    return { ok: false, reason: 'assignee_conflict' }
  }

  // (4) per-member rate limit.
  if (await recentAppliedOriginExists(env, owner.id, Date.now())) {
    return { ok: false, reason: 'origin_rate_limited' }
  }

  // (5)-(6) fresh capabilities, role forced 'member' — through memberAuth,
  // the SAME helper the IM path builds its AuthContext with. Not re-derived.
  const grants = await resolveCapabilities(env, owner.id)
  const candidateAuth = memberAuth(env, owner, grants)

  // (7) base squad-membership floor — the same guard every task mutation
  // requires, checked here so a member with no standing on this squad at
  // all can never reach a mint via the gate-evaluation branch below.
  if (!(await canOnSquad(env, grants, task.squad_id, 'member'))) {
    return { ok: false, reason: 'origin_not_gate_authorized' }
  }

  // (8) the REAL predicate — the same evaluateVerdictGates every other
  // verdict surface (HTTP, MCP, IM) calls. This is the actual authorization
  // this entire module exists to gate side effects behind.
  const gateResult = await evaluateVerdictGates(
    env,
    candidateAuth,
    { squad_id: task.squad_id, gate_owner: task.gate_owner, assignee_agent_id: task.assignee_agent_id },
    verdict,
  )
  if (!gateResult.allowed) {
    return { ok: false, reason: 'origin_not_gate_authorized' }
  }

  return { ok: true, owner, needsFirstBind, auth: candidateAuth }
}

/**
 * Commit phase — reached ONLY after dryRunAuthorize proves this exact
 * decision would be authorized. Reserves the replay slot and (if needed)
 * mints the Telegram identity bind in ONE D1 batch (mupot#1425 P0-2/P1-4
 * fix round, kasra-review + Athena): the bind UPDATE and its audit INSERT
 * are gated, in SQL, on THIS call's own reservation having actually landed
 * (a unique per-call stamp, `reservedAt` — the same "landed PROOF" pattern
 * `MEMBER_BIND_LANDED_GUARD_SQL` uses in src/members/project-invites.ts, not
 * a re-derivation of it). A UNIQUE-constraint throw (another member already
 * holds this exact chat_id) aborts the WHOLE batch — D1 batch is one
 * transaction — so the reservation itself is never left committed either:
 * "a failure reserves nothing." `writeVerdict` itself stays a SEPARATE call
 * in the caller (src/mcp/index.ts), unchanged — its own K5 conditional-
 * UPDATE race guard is documented (src/tasks/service.ts) as deliberately
 * NOT batchable ("D1 batch cannot conditionally abort in the middle"); a
 * verdict-write race lost AFTER this commit is a narrow, already-handled
 * `verdict_race` outcome, not a privilege escalation, and is accepted as
 * the cost of not forcing two independently-designed race guards into one
 * transaction.
 */
async function commitOriginDecision(
  env: Env,
  owner: Member,
  boundAgentId: string,
  origin: HumanOriginInput,
  taskId: string,
  verdict: 'approved' | 'rejected',
  needsFirstBind: boolean,
  auth: AuthContext,
): Promise<HumanOriginResolution> {
  const updateId = `origin:telegram:${origin.chat_id}:${origin.message_id}`
  const digest = await canonicalJsonDigest({
    chat_id: origin.chat_id,
    user_id: origin.user_id,
    message_id: origin.message_id,
    task_id: taskId,
    verdict,
  })
  const identity: TelegramUpdateIdentity = { update_id: updateId, telegram_user_id: origin.user_id, request_digest: digest }
  const reservedAt = claimTimestamp()
  const boundAt = needsFirstBind ? claimTimestamp() : null

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at)
       VALUES (?, ?, ?, ?, 'processing', ?)
       ON CONFLICT (tenant, update_id) DO NOTHING`,
    ).bind(env.TENANT_SLUG, updateId, origin.user_id, digest, reservedAt),
  ]

  if (needsFirstBind) {
    // Gated on THIS call's own reservation stamp existing in state
    // 'processing' — if our INSERT above lost the ON CONFLICT race (someone
    // else's reservation already occupies this key), this EXISTS is false
    // and the bind cannot land even though both statements are in the same
    // batch (D1 batch runs every statement; it cannot skip one based on a
    // sibling's row count, only on a WHERE clause referencing durable state
    // — same reasoning as CLAIM_INVITE_SQL's own receipt-processing conjunct).
    statements.push(
      env.DB.prepare(
        `UPDATE members
            SET telegram_chat_id = ?, telegram_bound_at = ?
          WHERE ${MEMBER_BIND_ELIGIBLE_SQL}
            AND EXISTS (
              SELECT 1 FROM telegram_webhook_receipts
               WHERE tenant = ? AND update_id = ? AND created_at = ? AND state = 'processing'
            )`,
      ).bind(origin.chat_id, boundAt, owner.id, env.TENANT_SLUG, origin.chat_id, env.TENANT_SLUG, updateId, reservedAt),
    )
    statements.push(
      env.DB.prepare(
        `INSERT INTO telegram_origin_bind_receipts (id, tenant, member_id, agent_id, chat_id, message_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM members WHERE id = ? AND telegram_bound_at = ?)`,
      ).bind(crypto.randomUUID(), env.TENANT_SLUG, owner.id, boundAgentId, origin.chat_id, origin.message_id, new Date().toISOString(), owner.id, boundAt),
    )
  }

  let results: D1Result[]
  try {
    results = await env.DB.batch(statements)
  } catch (err) {
    if (isUniqueViolationOn(err, 'telegram_chat_id')) {
      // Whole batch rolled back atomically — the reservation was never
      // committed either. Never overwrite someone else's binding.
      return { replayed: false, applied: false, reason: 'chat_already_bound' }
    }
    throw err
  }

  if (rowsChanged(results[0]) !== 1) {
    // Our reservation INSERT was a no-op: a reservation already occupies
    // this exact (chat, message) key — genuine replay. Nothing else in this
    // batch could have landed either, since every later statement's WHERE
    // required OUR stamp to already be committed in state 'processing'.
    return { replayed: true }
  }

  if (needsFirstBind && rowsChanged(results[1]) !== 1) {
    // Our reservation landed but the bind did not — a race lost between the
    // dry run and this commit (e.g. the member went inactive, or something
    // else bound them to a DIFFERENT chat, in the interim). Disambiguate
    // with a read-only follow-up; complete the reservation with the real
    // outcome so this exact origin message stays spent.
    const fresh = await env.DB.prepare('SELECT telegram_chat_id FROM members WHERE id = ?')
      .bind(owner.id).first<{ telegram_chat_id: string | null }>()
    const reason: HumanOriginFailureReason =
      fresh?.telegram_chat_id && fresh.telegram_chat_id !== origin.chat_id
        ? 'origin_member_mismatch'
        : 'member_not_eligible'
    await completeTelegramUpdate(env, identity, JSON.stringify({ applied: false, reason }))
    return { replayed: false, applied: false, reason }
  }

  // Real defence in depth (confirmed live by Athena's own probe on this PR):
  // resolve via the SAME helper the IM path uses (memberForChat) — proves
  // this bind (or pre-existing bind) reads back exactly the way /approve
  // etc. over the real Telegram webhook would see it, not merely that our
  // own write believes it landed. Kept even though the batch above already
  // proves the write landed structurally.
  const resolved = await memberForChat(env, origin.chat_id)
  if (!resolved || resolved.id !== owner.id) {
    await completeTelegramUpdate(env, identity, JSON.stringify({ applied: false, reason: 'origin_member_mismatch' }))
    return { replayed: false, applied: false, reason: 'origin_member_mismatch' }
  }

  const outcome: HumanOriginResolution = { replayed: false, applied: true, member: resolved, auth, boundNow: needsFirstBind }
  await completeTelegramUpdate(env, identity, JSON.stringify({ applied: true, member_id: resolved.id, bound_now: needsFirstBind }))
  return outcome
}

/**
 * Resolve a harness-attested `human_origin` into the member's own AuthContext,
 * or a named reason it does not apply. `boundAgentId` is the CALLING agent
 * (auth.boundAgentId) — the caller (task_verdict) must have already confirmed
 * this is set before calling here; a null/undefined boundAgentId is a caller
 * bug, not a resolvable outcome of this function.
 *
 * Order, load-bearing (mupot#1425 fix round): parse + freshness (no reads) →
 * dryRunAuthorize (every conjunct, ALL reads, zero writes) → ONLY IF
 * authorized → commitOriginDecision (reserve + first-bind, one D1 batch).
 */
export async function resolveHarnessAttestedOrigin(
  env: Env,
  boundAgentId: string,
  rawOrigin: unknown,
  taskId: string,
  verdict: 'approved' | 'rejected',
  task: OriginTaskRef,
): Promise<HumanOriginResolution> {
  const parsed = parseHumanOrigin(rawOrigin)
  if (!parsed.ok) return { replayed: false, applied: false, reason: parsed.reason }
  const origin = parsed.value

  const dryRun = await dryRunAuthorize(env, boundAgentId, origin, verdict, task)
  if (!dryRun.ok) return { replayed: false, applied: false, reason: dryRun.reason }

  return commitOriginDecision(env, dryRun.owner, boundAgentId, origin, taskId, verdict, dryRun.needsFirstBind, dryRun.auth)
}
