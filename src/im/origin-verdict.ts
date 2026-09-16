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
// mupot#1425 fix-round history (all adversarial, all executed-not-inferred):
//
//   Round 1 (kasra-review BLOCK): side effects (the Telegram-identity bind,
//   the replay reservation) ran BEFORE the authorization they were supposed
//   to depend on, and agents.owner_member_id had no target-rank ceiling.
//   Fixed by splitting into dryRunAuthorize (read-only) → commitOriginDecision
//   (writes), reached only when the dry run says authorized.
//
//   Round 2 (kasra-review BLOCK + Athena): the round-1 reorder enumerated 2
//   of 3 refusals that could still land AFTER a commit — writeVerdict's own
//   project-evidence fence fired after the bind had already landed (P0-B),
//   agents.owner_member_id's ceiling compared the RAW string while the write
//   stored the TRIMMED one, a one-space id bypassed it entirely (P0-A), the
//   ceiling had no ORG-SCOPE FLOOR paired with it the way every sibling
//   authenticate-as-X door has (Athena), agent ownership and member-active
//   were read in the dry run and never re-asserted at commit (P1-C), and the
//   bind's "landed proof" guard used a timestamp coincidence instead of the
//   digest already sitting on that same row (P3-G). Fixed by putting the
//   VERDICT WRITE itself inside the SAME atomic D1 batch as the reservation
//   and the bind.
//
//   Round 3 (kasra-review BLOCK): "atomic" was not "one guard set." D1 batch
//   rolls back only on a statement THROW, never on a statement that merely
//   changes 0 rows — so three statements sharing OVERLAPPING but not
//   IDENTICAL guards could still diverge: the bind's guards could all hold
//   while the verdict's guard (task status='review', among others) did not,
//   landing a durable Telegram bind and an audit row for a call refused
//   with 409 (P0-1). Separately, the verdict INSERT's own landed-proof was a
//   bare millisecond timestamp with no nonce, so a genuine race LOSER could
//   still insert a row — the exact class P3-G had already closed one
//   statement away (P0-2). Fixed structurally: the VERDICT ROW is now the
//   ONE anchor. `buildVerdictStatements` (src/tasks/service.ts) carries the
//   full guard set and a `claimTimestamp()` nonce (not a bare timestamp,
//   fixing P0-2 for all four verdict surfaces, not just this one); the bind
//   and its audit receipt are demoted to depending SOLELY on
//   `EXISTS (SELECT 1 FROM task_verdicts WHERE id = <this call's own uuid>)`
//   — a fact reachable only if the verdict's own, strictly-larger guard set
//   already held. "No verdict row ⇒ nothing else lands," by construction,
//   not by enumerating one more guard to keep in sync by hand.
//
// Trust boundary, stated plainly (also see docs/architecture/
// human-decision-channel-contract.md, "Harness-attested origin"): the HARNESS
// is the attestation boundary. mupot trusts a stamp only because (a) the
// agent seat is owned by the resolved member (agents.owner_member_id — set
// only by an org-scope admin who does not fail the target-rank ceiling, see
// src/mcp/provision.ts, and re-asserted again at commit, not merely at dry
// run), (b) the member is bound to that exact chat (or this exact request
// first-binds it, only AFTER the ENTIRE decision — bind, reservation, and
// verdict together — is proven authorized), and (c) the message is FRESH and
// UNREPLAYED. mupot cannot itself distinguish a harness-stamped human_origin
// from one a model typed into its own tool call — it never sees the raw
// Telegram update, only the stamp — so every defense that IS server-checkable
// is enforced here, not merely assumed of the harness. Freshness alone is NOT
// proof the harness told the truth about *when* the human spoke (message_at
// is caller-supplied); what freshness buys is a short shelf life for a
// captured (chat_id, message_id) pair. Residual, stated honestly and not
// fixed here (P1-D, kasra-review round 2): the target-rank ceiling on
// owner_member_id is evaluated ONCE, at set time — a member promoted to
// higher standing AFTER being pointed at by a lower-ranked actor keeps the
// binding, unre-checked, for as long as the column stays set. Tracked as a
// follow-up issue, not fixed in this slice.
//
// Every conjunct below is re-checked at call time (no caching across calls):
// caller is agent-bound; the agent has an owner; the owner is active; the
// origin is a well-formed, private-chat-shaped, FRESH Telegram identity; the
// origin resolves to (or is eligible to first-bind) that SAME member; the
// member is not barred by conflict of interest (the calling agent IS the
// task's assignee, OR the assignee agent's OWN owner_member_id is this same
// member — the load-bearing check now that agent_keys is empty in prod for
// the pilot agent; agent_keys' memberOwnsAssigneeAgent is kept as an
// additional, cheap, non-load-bearing check); this member has not already
// applied a decision within the rate window; the member's fresh capabilities
// actually authorize this exact task+verdict (evaluateVerdictGates, the SAME
// predicate every other verdict surface uses); and the task's own
// project-evidence fence (assertVerdictWritable) still holds. ANY conjunct
// false falls back to the calling agent's own authority — this module never
// raises for that; the ONLY hard failures are the two the caller
// (task_verdict) must itself refuse the whole request for: a non-agent-bound
// caller supplying human_origin at all, and a replayed origin message (plus
// the pre-existing, shared VerdictRaceError for a genuine post-dry-run race
// on the task's own status, propagated exactly as the non-origin path does).
//
// Known residual, not fixed here (documented, not silently assumed away):
// member CAPABILITIES cannot be re-asserted as a SQL condition inside the
// commit batch — `evaluateVerdictGates` is a multi-table, multi-branch JS
// predicate, not a single EXISTS clause. The window between the dry run's
// capability read and the commit is therefore real, but bounded to a single
// request's own async gap (milliseconds, same-process) — not a
// cross-request race an attacker can widen. Agent ownership and member-active
// ARE re-asserted in SQL (see commitOriginDecision) precisely because both
// ARE single-row EXISTS-expressible facts.

import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { AuthContext, Env, Member, Task } from '../types'
import { resolveCapabilities, canOnSquad } from '../auth/capability'
import { canonicalJsonDigest, sha256Hex } from '../lib/canonical-json'
import { MEMBER_BIND_ELIGIBLE_SQL } from '../members/project-invites'
import { claimTimestamp } from '../lib/claim-timestamp'
import { memberAuth, memberForChat, memberOwnsAssigneeAgent, telegramId } from './index'
import { completeTelegramUpdate, type TelegramUpdateIdentity } from './telegram-receipts'
import { evaluateVerdictGates } from '../tasks/index'
import {
  assertVerdictWritable,
  buildVerdictStatements,
  emitVerdictBusEvent,
  TaskEvidenceFenceError,
  VerdictRaceError,
  type TaskActor,
} from '../tasks/service'
import type { TaskVerdict } from '../types'

export interface HumanOriginInput {
  channel: 'telegram'
  user_id: string
  chat_id: string
  message_id: string
  message_at: string
  // text (mupot#1425 round 4 addendum, plugin gate P2-1): the human's
  // message. A harness-attested chat_id/message_id pair alone binds
  // WHO — it says nothing about WHAT the human actually named. Without
  // this, a model could spend a genuine, fresh, unreplayed human stamp on
  // ANY task it chose, not the one the human was actually looking at. Bound
  // server-side below (see `taskNamedInText`) and folded into the replay
  // digest so a stamp cannot be re-attached to different text after capture.
  text: string
}

export type HumanOriginFailureReason =
  | 'invalid_origin_shape'
  | 'text_required'
  | 'origin_stale'
  | 'task_not_named'
  | 'agent_not_owned'
  | 'member_inactive'
  | 'origin_member_mismatch'
  | 'chat_already_bound'
  | 'member_not_eligible'
  | 'assignee_conflict'
  | 'origin_rate_limited'
  | 'origin_not_gate_authorized'
  | 'project_write_forbidden'

export type HumanOriginResolution =
  | { replayed: true }
  | { replayed: false; applied: true; member: Member; auth: AuthContext; boundNow: boolean; task: Task; verdict: TaskVerdict }
  | { replayed: false; applied: false; reason: HumanOriginFailureReason }

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
  | { ok: false; reason: 'invalid_origin_shape' | 'text_required' | 'origin_stale' }

// text (round 4 addendum): required whenever human_origin is supplied at
// all, capped well under Telegram's own 4096-char message limit — this is
// the human's words, not a payload, and a 2048-char intent-binding search
// string is already generous.
const TEXT_MAX_LEN = 2048

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
  // P3 (kasra-review r4): a missing `text` is common and actionable (an
  // older harness build that has not picked up the round-4 addendum yet) —
  // give it its OWN reason rather than folding it into the generic shape
  // bucket. A `text` that IS present but malformed (wrong type, empty, or
  // over the cap) is a genuine shape violation, unchanged.
  if (obj.text === undefined) {
    return { ok: false, reason: 'text_required' }
  }
  if (typeof obj.text !== 'string' || obj.text.length === 0 || obj.text.length > TEXT_MAX_LEN) {
    return { ok: false, reason: 'invalid_origin_shape' }
  }

  const age = now - messageAtMs
  if (age > FRESHNESS_MAX_AGE_MS || age < -FRESHNESS_MAX_FUTURE_MS) {
    return { ok: false, reason: 'origin_stale' }
  }

  return {
    ok: true,
    value: { channel: 'telegram', user_id: userId, chat_id: chatId, message_id: messageId, message_at: obj.message_at, text: obj.text },
  }
}

/**
 * mupot#1425 round 4 addendum (plugin gate P2-1): a harness-attested
 * chat_id/message_id pair proves WHO spoke; it says nothing about WHICH
 * task the human meant. Bound here, server-side, so a model relaying the
 * call cannot spend a genuine human stamp on a task the human never named.
 * Matches the FULL task id as a substring (case-insensitive), or any
 * contiguous run of 8+ hex characters in the text that is a PREFIX of the
 * task id's own leading hex characters (hyphens stripped for the prefix
 * comparison only — a UUID's hyphens are formatting, not content a human
 * would necessarily type) — e.g. "approve f9408956" names task
 * `f9408956-...`. A run shorter than 8 hex characters never counts: too
 * short to be a meaningful task reference rather than an accidental match.
 */
function taskNamedInText(text: string, taskId: string): boolean {
  const lowerText = text.toLowerCase()
  const lowerId = taskId.toLowerCase()
  if (lowerText.includes(lowerId)) return true
  const idHexOnly = lowerId.replace(/-/g, '')
  const hexRuns = lowerText.match(/[0-9a-f]{8,}/g) ?? []
  return hexRuns.some((run) => idHexOnly.startsWith(run))
}

function isUniqueViolationOn(error: unknown, column: string): boolean {
  return error instanceof Error && new RegExp(`UNIQUE constraint failed: .*${column}`, 'i').test(error.message)
}

function rowsChanged(result: D1Result | undefined): number {
  return Number(result?.meta?.changes ?? 0)
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
 *
 * Known gap, not fixed here (round 2, kasra-review P2-E): `task.assignee_
 * member_id` (0150, the HUMAN-owner column) is never consulted — a member
 * who owns a task directly (no assignee agent at all) can still approve it
 * via a harness-attested origin. This mirrors a PRE-EXISTING gap in
 * `evaluateVerdictGates` itself (its self-verdict check also only compares
 * against `assignee_agent_id`), not something this module introduced or can
 * fix in isolation — tracked as a follow-up, not silently assumed closed.
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
 * whether to commit ANY write at all. mupot#1425 P0-2 (kasra-review round 1):
 * a previous version minted the Telegram bind and the replay reservation
 * before this check ever ran. mupot#1425 P0-B (round 2): a LATER version
 * still let `writeVerdict`'s own project-evidence fence fire AFTER the
 * commit — `assertVerdictWritable` is now called here too, so that refusal
 * is also proven BEFORE any write, not just gate ownership and squad
 * membership. Nothing below writes to D1.
 */
async function dryRunAuthorize(
  env: Env,
  boundAgentId: string,
  origin: HumanOriginInput,
  verdict: 'approved' | 'rejected',
  task: Task,
  gateOwner: string,
): Promise<DryRunResult> {
  // (1) the calling agent must be OWNED by a member — agents.owner_member_id
  // (0155), re-read fresh every call, never cached across a session. Setting
  // this column is itself now rank-ceilinged AND org-scope-floored
  // (src/mcp/provision.ts) — an actor without standing over the target
  // member, or without org-scope admin at all, can never make this row true
  // for that member, closing the K1/K1b escalation chain at its source.
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
    { squad_id: task.squad_id, gate_owner: gateOwner, assignee_agent_id: task.assignee_agent_id },
    verdict,
  )
  if (!gateResult.allowed) {
    return { ok: false, reason: 'origin_not_gate_authorized' }
  }

  // (9) mupot#1425 P0-B (kasra-review round 2): the project-evidence fence
  // `writeVerdict` itself enforces — proven, live, to fire AFTER a bind had
  // already landed when it lived only inside `writeVerdict`. Checked here,
  // read-only, before ANY write in this module.
  try {
    await assertVerdictWritable(env, task)
  } catch (err) {
    if (err instanceof TaskEvidenceFenceError) {
      return { ok: false, reason: 'project_write_forbidden' }
    }
    throw err
  }

  return { ok: true, owner, needsFirstBind, auth: candidateAuth }
}

/**
 * Commit phase — reached ONLY after dryRunAuthorize proves this exact
 * decision would be authorized.
 *
 * mupot#1425 round 4 (kasra-review BLOCK, 2 P0 — "make the VERDICT ROW the
 * anchor, one guard set"): rounds 1-3 put the reservation, the bind, and the
 * verdict in one atomic D1 batch, but D1 batch atomicity means "all-or-
 * nothing on a statement THROW" — it does NOT abort mid-batch on a
 * statement that merely changes 0 rows (a 0-row conditional UPDATE is a
 * SUCCESSFUL statement). So three statements in one batch with THREE
 * different (overlapping but not identical) guard sets could still diverge:
 * the bind's guards (chat-eligibility, reservation-landed, ownership) could
 * all hold while the verdict's guard (task status='review', among others)
 * did not — landing a durable Telegram identity bind and an append-only
 * audit row for a call the API refused with 409 `verdict_race` (P0-1,
 * proven live). Separately, the verdict INSERT's own landed-proof compared
 * a bare millisecond timestamp with no nonce, so a genuine race LOSER could
 * still insert a `task_verdicts` row after its own UPDATE changed 0 rows —
 * the exact class round 2's P3-G fix closed one statement away and left
 * open here (P0-2, now fixed centrally in `buildVerdictStatements`,
 * src/tasks/service.ts, for all four verdict surfaces, not just this one).
 *
 * Round 4's fix is structural, not another enumerated guard: the VERDICT
 * ROW is the ONE anchor. `buildVerdictStatements` carries the FULL guard set
 * (task status='review', ownership, chat-eligibility via the SAME
 * `MEMBER_BIND_ELIGIBLE_SQL` the bind statement itself uses — not a second
 * copy — and the reservation having landed) and is the ONLY statement that
 * REALLY decides whether this call succeeds. The bind UPDATE and the bind-
 * receipt INSERT are demoted to being PURELY conditioned on
 * `EXISTS (SELECT 1 FROM task_verdicts WHERE id = <this call's own UUID>)`
 * — a fact that can only be true if EVERY conjunct the verdict statement
 * checked already held, in the SAME transaction, with nothing else able to
 * write in between. There is no longer a second, independently-guarded path
 * to a bind: "no verdict row ⇒ nothing else lands," by construction, not by
 * enumeration. After the batch, this function reads back whether the
 * verdict itself landed — not the bind, not the reservation — as the single
 * source of truth for the outcome.
 */
async function commitOriginDecision(
  env: Env,
  owner: Member,
  boundAgentId: string,
  origin: HumanOriginInput,
  task: Task,
  verdict: 'approved' | 'rejected',
  note: string | null,
  needsFirstBind: boolean,
  auth: AuthContext,
): Promise<HumanOriginResolution> {
  const updateId = `origin:telegram:${origin.chat_id}:${origin.message_id}`
  // text_hash (round 4 addendum): the digest binds not just WHO and WHICH
  // task/verdict, but WHAT the human said, via its hash rather than the raw
  // text itself (the digest is stored on the reservation row and is not
  // meant to carry free text) — a stamp cannot be recaptured and reattached
  // to different wording after the fact.
  const textHash = await sha256Hex(origin.text)
  const digest = await canonicalJsonDigest({
    chat_id: origin.chat_id,
    user_id: origin.user_id,
    message_id: origin.message_id,
    task_id: task.id,
    verdict,
    text_hash: textHash,
  })
  const identity: TelegramUpdateIdentity = { update_id: updateId, telegram_user_id: origin.user_id, request_digest: digest }
  const reservedAt = claimTimestamp()
  const boundAt = needsFirstBind ? claimTimestamp() : null

  // The FULL guard set — everything the verdict statement (and ONLY the
  // verdict statement) must re-assert in SQL. `MEMBER_BIND_ELIGIBLE_SQL`
  // (src/members/project-invites.ts) is reused verbatim, not re-derived —
  // the SAME predicate the bind statement below uses to decide WHAT to set,
  // now also gating WHETHER the decision itself may land. This is what
  // makes the verdict's own guard set a strict SUPERSET of the bind's own
  // eligibility check: if the verdict lands, the bind's WHERE (checked
  // microseconds later, same transaction, nothing else can have written in
  // between) is guaranteed already true.
  const ownershipGuardSql = 'EXISTS (SELECT 1 FROM agents WHERE id = ? AND owner_member_id = ?)'
  const chatEligibleGuardSql = `EXISTS (SELECT 1 FROM members WHERE ${MEMBER_BIND_ELIGIBLE_SQL})`
  const reservationLandedGuardSql =
    "EXISTS (SELECT 1 FROM telegram_webhook_receipts WHERE tenant = ? AND update_id = ? AND created_at = ? AND request_digest = ? AND state = 'processing')"

  const verdictBuild = buildVerdictStatements(
    env,
    { task, verdict, note, decidedBy: owner.id, decidedVia: 'agent_attested_origin', originAgentId: boundAgentId },
    {
      sql: `${ownershipGuardSql} AND ${chatEligibleGuardSql} AND ${reservationLandedGuardSql}`,
      params: [
        boundAgentId, owner.id, // ownership
        owner.id, env.TENANT_SLUG, origin.chat_id, // MEMBER_BIND_ELIGIBLE_SQL (id, tenant, chat_id)
        env.TENANT_SLUG, updateId, reservedAt, digest, // reservation-landed
      ],
    },
  )
  const verdictId = verdictBuild.verdictRow.id
  // THE anchor every other statement depends on — see this function's own
  // doc comment. Deliberately the ONLY guard on the statements below.
  const verdictLandedGuardSql = 'EXISTS (SELECT 1 FROM task_verdicts WHERE id = ?)'

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at)
       VALUES (?, ?, ?, ?, 'processing', ?)
       ON CONFLICT (tenant, update_id) DO NOTHING`,
    ).bind(env.TENANT_SLUG, updateId, origin.user_id, digest, reservedAt),
    ...verdictBuild.statements, // [0]=tasks status UPDATE (full guard set), [1]=task_verdicts INSERT (the anchor)
  ]
  const verdictInsertIndex = statements.length - 1

  if (needsFirstBind) {
    statements.push(
      env.DB.prepare(
        `UPDATE members
            SET telegram_chat_id = ?, telegram_bound_at = ?
          WHERE ${MEMBER_BIND_ELIGIBLE_SQL}
            AND ${verdictLandedGuardSql}`,
      ).bind(origin.chat_id, boundAt, owner.id, env.TENANT_SLUG, origin.chat_id, verdictId),
    )
    statements.push(
      env.DB.prepare(
        `INSERT INTO telegram_origin_bind_receipts (id, tenant, member_id, agent_id, chat_id, message_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM members WHERE id = ? AND telegram_bound_at = ?)
            AND ${verdictLandedGuardSql}`,
      ).bind(crypto.randomUUID(), env.TENANT_SLUG, owner.id, boundAgentId, origin.chat_id, origin.message_id, new Date().toISOString(), owner.id, boundAt, verdictId),
    )
  }
  const bindStatusIndex = needsFirstBind ? verdictInsertIndex + 1 : null

  let results: D1Result[]
  try {
    results = await env.DB.batch(statements)
  } catch (err) {
    if (isUniqueViolationOn(err, 'telegram_chat_id')) {
      // Whole batch rolled back atomically — the reservation and the verdict
      // were never committed either. Never overwrite someone else's binding.
      return { replayed: false, applied: false, reason: 'chat_already_bound' }
    }
    throw err
  }

  if (rowsChanged(results[0]) !== 1) {
    // Our reservation INSERT was a no-op: a reservation already occupies
    // this exact (chat, message) key — genuine replay. Nothing else in this
    // batch could have landed either, since the verdict statement's WHERE
    // required OUR stamp to already be committed in state 'processing'.
    return { replayed: true }
  }

  // THE decisive check (round 4) — did the verdict itself land? Everything
  // else in this batch was gated on this exact row's existence, so this one
  // read subsumes checking the bind and the reservation separately.
  const verdictLanded = rowsChanged(results[verdictInsertIndex]) === 1

  if (!verdictLanded) {
    // Diagnostic disambiguation only (read-only — the atomic guard above
    // already decided the outcome; these reads choose which message to
    // report) and complete the reservation so this exact origin message
    // stays spent.
    const stillOwned = await env.DB.prepare('SELECT 1 FROM agents WHERE id = ? AND owner_member_id = ?')
      .bind(boundAgentId, owner.id).first()
    if (!stillOwned) {
      await completeTelegramUpdate(env, identity, JSON.stringify({ applied: false, reason: 'agent_not_owned' }))
      return { replayed: false, applied: false, reason: 'agent_not_owned' }
    }
    const stillEligible = await env.DB.prepare(`SELECT 1 FROM members WHERE ${MEMBER_BIND_ELIGIBLE_SQL}`)
      .bind(owner.id, env.TENANT_SLUG, origin.chat_id).first()
    if (!stillEligible) {
      const fresh = await env.DB.prepare('SELECT telegram_chat_id, status FROM members WHERE id = ?')
        .bind(owner.id).first<{ telegram_chat_id: string | null; status: string }>()
      const reason: HumanOriginFailureReason =
        fresh?.status !== 'active'
          ? 'member_inactive'
          : fresh?.telegram_chat_id && fresh.telegram_chat_id !== origin.chat_id
            ? 'origin_member_mismatch'
            : 'member_not_eligible'
      await completeTelegramUpdate(env, identity, JSON.stringify({ applied: false, reason }))
      return { replayed: false, applied: false, reason }
    }
    // Ownership and chat-eligibility both still hold — the ONLY remaining
    // explanation is the verdict's own task-status='review' guard: a
    // genuine, pre-existing K5 race (another verdict won concurrently).
    // Same shared outcome the non-origin path already surfaces — propagate
    // it identically rather than inventing a second race code, so the
    // caller (src/mcp/index.ts) handles both with the SAME catch block.
    await completeTelegramUpdate(env, identity, JSON.stringify({ applied: false, reason: 'verdict_race' }))
    throw new VerdictRaceError(task.id)
  }

  // The verdict landed ⇒ by construction, the bind (when needed) ALSO
  // landed — its guard is the SAME `MEMBER_BIND_ELIGIBLE_SQL` fact the
  // verdict statement itself already re-checked, evaluated microseconds
  // later against unchanged data (nothing else can write inside this one
  // transaction). Confirmed, not merely assumed, via the row-count check
  // below and the memberForChat readback after it.
  if (bindStatusIndex !== null && rowsChanged(results[bindStatusIndex]) !== 1) {
    // Structurally unreachable given the guard-set argument above; fail
    // loudly rather than silently reporting success if it ever is.
    throw new Error('origin-verdict: verdict landed but its own bind guard did not — guard sets have diverged')
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

  const updatedTask: Task = { ...task, status: verdictBuild.newStatus, updated_at: verdictBuild.now }
  const actor: TaskActor = { kind: 'member', id: owner.id }
  await emitVerdictBusEvent(env, task, { task, verdict, note, decidedBy: owner.id }, verdictBuild.newStatus, verdictBuild.now, actor)

  await completeTelegramUpdate(env, identity, JSON.stringify({ applied: true, member_id: resolved.id, bound_now: needsFirstBind }))
  return {
    replayed: false,
    applied: true,
    member: resolved,
    auth,
    boundNow: needsFirstBind,
    task: updatedTask,
    verdict: verdictBuild.verdictRow,
  }
}

/**
 * Resolve a harness-attested `human_origin` into the member's own AuthContext
 * PLUS the already-committed verdict, or a named reason it does not apply.
 * `boundAgentId` is the CALLING agent (auth.boundAgentId) — the caller
 * (task_verdict) must have already confirmed this is set, and that
 * `task.gate_owner` is non-null and `task.status === 'review'`, before
 * calling here; those are caller-shape invariants, not resolvable outcomes
 * of this function.
 *
 * Order, load-bearing (mupot#1425 fix round 1+2): parse + freshness (no
 * reads) → dryRunAuthorize (every conjunct including the project-evidence
 * fence, ALL reads, zero writes) → ONLY IF authorized →
 * commitOriginDecision (reserve + first-bind + THE VERDICT ITSELF, one D1
 * batch). May throw VerdictRaceError — propagate it exactly as the
 * non-origin path does (src/mcp/index.ts).
 */
export async function resolveHarnessAttestedOrigin(
  env: Env,
  boundAgentId: string,
  rawOrigin: unknown,
  task: Task,
  gateOwner: string,
  verdict: 'approved' | 'rejected',
  note: string | null,
): Promise<HumanOriginResolution> {
  const parsed = parseHumanOrigin(rawOrigin)
  if (!parsed.ok) return { replayed: false, applied: false, reason: parsed.reason }
  const origin = parsed.value

  // Round 4 addendum — bind INTENT before spending anything else. Pure,
  // no reads, checked immediately after shape/freshness for the same
  // reason those are: a call that fails this can never reach a write.
  if (!taskNamedInText(origin.text, task.id)) {
    return { replayed: false, applied: false, reason: 'task_not_named' }
  }

  const dryRun = await dryRunAuthorize(env, boundAgentId, origin, verdict, task, gateOwner)
  if (!dryRun.ok) return { replayed: false, applied: false, reason: dryRun.reason }

  return commitOriginDecision(env, dryRun.owner, boundAgentId, origin, task, verdict, note, dryRun.needsFirstBind, dryRun.auth)
}
