// mupot — bootstrap_self: the exit ramp from "connected but mute" (mupot#925).
//
// findOrCreateMember (src/mcp/oauth-authorize.ts) auto-creates a members row for
// ANY verified Google email on first OAuth callback — the door IS registration.
// The consent screen's only choice for a newcomer is "No agent — continue
// unbound" (src/mcp/oauth-authorize.ts renderConsentPage), and an unbound seat
// is then MUTE on the directory channel: send/inbox/inbox_lease/inbox_ack all
// 403 not_agent_bound (src/mcp/index.ts). bootstrapSelf is the exit ramp: the
// human NAMES an agent and this path stands one up, with its OWN workspace-
// channel credential — the same shape mint_agent_token already hands an admin.
//
// River's ruling (rul-2026-08-11-bootstrap-self, APPROVE WITH CONDITIONS):
//   1. agent_name is REQUIRED — naming is the witness act. No silent auto-create,
//      no defaulted name.
//   2. Gate: auth.channel === 'directory' && !auth.boundAgentId ONLY. An
//      agent-bound token already has a voice and must refuse outright.
//   3. The clamp is re-validated live: the new agent is a MEMBER on its own
//      home squad, never lead/admin/owner. mintAgentBoundToken's escalation
//      guard enforces this structurally (AGENT_TOKEN_CAPABILITIES is
//      ['observer','member'] — see src/members/service.ts); this path also
//      requests 'member' explicitly rather than relying on the default.
//   4. Provenance from birth: this path writes its OWN agent_audit row, with
//      before_state and after_state computed as plain JS values BEFORE any
//      INSERT runs (never a two-phase ''-sentinel-then-backfill — see the field
//      list note below). before_state is the honest empty-identity image (the
//      agent did not exist); after_state is the full created snapshot. A blank
//      after_state is unacceptable here by design — that is a governance
//      requirement (a self-commissioned identity must not start unproven, and
//      the record must be written by the path that did the deed), independent
//      of any platform-behaviour question.
//   5. Idempotent-once PER MEMBER, not per token — a second connection (a new
//      token, the SAME human) must not mint a second agent. Enforced
//      STRUCTURALLY: the audit INSERT below is the fifth statement of the SAME
//      env.DB.batch() call that creates the agent/member/binding/capability/
//      token, and migration 0092 puts a partial UNIQUE index on
//      agent_audit(actor_id) WHERE action = 'bootstrap_self'. A second
//      first-time attempt for the same human aborts the WHOLE batch — no
//      partial agent/member/binding/token is ever left live. The app-level
//      pre-check further down is an optimization (skip five doomed writes on
//      the common repeat-call path), not the correctness guarantee.
//      Plus a per-member attempt throttle (5/hour) — keyed on the member, not
//      the IP: an IP-keyed throttle is bypassed by rotating IPs, but a human
//      cannot rotate their own member id (adversarial review, LOW-1).
//
// SCOPE (river): agent + its home department + home squad are MANDATORY
// (squads.department_id is TEXT NOT NULL REFERENCES departments(id) —
// migrations/0001_init.sql:14 — and task_create requires squad_id — src/mcp/
// index.ts toolTaskCreate). A project is DEFERRED: task_create's project_id is
// optional, so nothing requires one. The home squad is auto, invisible, and
// never a colony squad — zero ambient visibility for a first-run external user.
//
// SLUGS ARE SERVER-DERIVED, NEVER THE HUMAN'S INPUT (adversarial review, P0-1).
// agent_name only ever becomes the agent's `name` (a display label) — never a
// slug. agents.slug is UNIQUE(squad_id, slug), NOT tenant-global (migrations/
// 0001_init.sql:31), so a caller-chosen slug would let any Google-verified
// stranger mint an agent slugged "kasra"/"river"/"loom" on THEIR OWN new squad,
// poisoning every id-or-slug resolver that treats a bare slug match as
// meaningful (src/org/resolve.ts's ambiguity refusal, src/fleet/registry.ts's
// runtime lookup, deactivate_agent's slug-keyed cleanup — src/mcp/provision.ts).
// Instead every slug here is DERIVED from the consenting human's own member id
// (`dept-home-<memberId>`, `home-<memberId>`, `self-<memberId>`) — a UUID is
// already slug-safe (lowercase hex + single hyphens, well under the 48-char
// cap), and because it is 1:1 with a globally-unique member id, no two humans
// EVER DERIVE the same slug independently. That does NOT mean the slug is
// unclaimable by anyone else, though (WARN-1, adversarial review THIRD pass,
// PR #928): slug is a plain caller-chosen field on POST /departments,
// the dashboard, and MCP create_department/create_squad — nothing stops a
// DIFFERENT org:admin from deliberately creating a department or squad slugged
// `dept-home-<victim-uuid>` / `home-<victim-uuid>` first. So a slug match is
// NOT by itself proof of "this human's own prior partial attempt" — the
// adopt-existing path (findDepartmentBySlug/findSquadBySlug, below) requires
// kind='home' on the row it would adopt for exactly this reason; a squatted
// work-kind row is refused, never silently adopted into this human's identity
// chain.
//
// DIRECTORY-SESSION CAVEAT + THE FOUNDER GRANT (adversarial review P0-2,
// resolved by river addendum A — rul-2026-08-11-bootstrap-self): the raw token
// this path returns is a WORKSPACE-channel credential (same shape as
// mint_agent_token), not a directory-channel one, and does NOT by itself
// retroactively bind the CALLER'S CURRENT OAuth/directory session — B1 (src/
// mcp/oauth-authorize.ts) must keep a directory seat at zero ambient capability
// regardless of what it just minted elsewhere. The human can use the returned
// raw token directly in a client that accepts a bearer token (the same
// workflow mint_agent_token already supports).
//
// Separately, this path ALSO grants the founding human themselves squad:admin
// on their OWN new home squad (see `founderAdminStatement` below) — river's
// reasoning: the home is created BY the bootstrap act, the human is its
// founder, and "a room whose owner cannot admit a second chair is a cell."
// This is a SEPARATE principal and a SEPARATE row from the agent's own
// 'member' grant — condition 3 (the agent stays member, never higher) is
// unchanged. Because the human now genuinely holds squad:admin on the home
// squad, they CAN separately choose to complete the normal /oauth/consent flow
// (mupot#903b) to bind THIS SAME OAuth session to the new agent — they clear
// that gate's P0-3 admin floor on its own honest terms, not because the floor
// was lowered. This function does not touch /oauth/consent's gate logic at
// all. See the `directory_session_note` field in the success result.
//
// ARCHITECTURE: department and squad are created via the EXISTING createDepartment
// / createSquad (src/org/service.ts) — two individually-committing calls, exactly
// as every other caller of those functions uses them. Neither row is ever
// referenced by anything with a delete-guard trigger (unlike what follows), so if
// either the squad create or everything after it fails, both are safely, fully
// compensable with a plain DELETE.
//
// The agent, its home-squad membership, its dedicated member, its
// agent_member_bindings weld, its home-squad capability grant, its bearer
// token, AND this function's own agent_audit row are NOT created via separate
// calls. They are all PREPARED (not committed) — prepareAgentCreate (src/org/
// service.ts) and prepareAgentBoundTokenMint (src/members/service.ts, the
// SAME shared grant path start-gate.ts's doctrine names: "through the shared
// members/service grant path — NEVER a forked provisioner"; this path does not
// hand-sequence the mint's rows itself, it composes the EXACT statements that
// function already builds) — then run together as ONE env.DB.batch() call. D1
// batch is all-or-nothing (mintAgentBoundToken's own doc comment: "FOUR ROWS,
// ONE BATCH — all land or none do"), so there is no partial state to
// compensate for that cluster: either everything lands, or nothing does.
//
// This matters concretely: migration 0071's
// agent_member_bindings_delete_requires_no_tokens trigger aborts a DELETE on
// agent_member_bindings if ANY member_tokens row (revoked or not) references
// that (tenant, agent_id) — so once a token has been minted, that binding can
// NEVER be deleted again, by this function or anything else. A compensator
// written against a multi-step sequence (create agent, THEN mint, THEN audit)
// could reach a state after a successful mint that it structurally cannot
// unwind. Folding agent + mint + audit into one batch removes that failure mode
// entirely: if the audit INSERT's uniqueness check fails, the agent and its
// mint never landed in the first place.
//
// ── SECOND ADVERSARIAL PASS (mupot#925, 2026-08-11) — findings in the SHARED
// HELPERS this function calls, not in this function's own first-pass fixes,
// which the pass re-verified as genuinely closed:
//
//   P0-N1 (river ruling, addendum C) — src/org/service.ts's create* functions
//   counted departments/squads/agents POT-WIDE with no kind distinction, so a
//   freshly provisioned pot (fails closed to 'free': 1 squad / 2 agents, no
//   department limit existed at all) admitted exactly ONE human via this
//   function before every subsequent caller hit squad_limit_reached. Fix: a
//   `kind` column (migration 0093) — every row this function creates is
//   kind:'home', structurally exempt from the plan counters; every other
//   caller in the codebase is untouched and keeps writing kind:'work' by
//   omission. See src/billing/plans.ts and src/org/service.ts.
//
//   P0-N2 — deptSlug/squadSlug collisions used to be permanent: no
//   adopt-existing branch meant a worker dying between the createSquad commit
//   and the atomic batch below left that human locked out of bootstrap_self
//   FOREVER (createDepartment's slug_taken becoming
//   provisioning_failed{stage:'department'} on every retry, since the slug is
//   deterministic and departments.slug is globally UNIQUE). Fixed by
//   findDepartmentBySlug/findSquadBySlug below — adopt a prior partial
//   attempt's own row instead of failing on it.
//
//   WARN-1 — the batch-failure compensator ran deleteOrphanedDeptAndSquad
//   BEFORE classifying the error, unconditionally, even against rows this
//   call did not itself create. Fixed by compensateCreatedRows: classify
//   first, compensate second, each DELETE in its own try/catch, and only ever
//   on ids this specific invocation created (never an adopted row).
//
//   WARN-3 — BootstrapAuth was a hand-declared duck type with no compile-time
//   link to AuthContext (src/types.ts). Fixed: `Pick<AuthContext, ...>`.
//
//   LOW-1 — the per-member throttle ran AFTER the already-bootstrapped
//   pre-check, so a member who already bootstrapped could poll this tool at
//   an unmetered rate. Fixed: throttle first. Paired with a best-effort
//   refund (refundBootstrapSelfRateLimit) for the *_limit_reached family,
//   which P0-N1 has since made unreachable through this function — see that
//   function's own doc comment.
//
// ── THIRD ADVERSARIAL PASS (PR #928 review) — the kind:'home' exemption
// P0-N1 above shipped in fixed itself introduced a WORSE hole, plus two
// findings in this file's own adopt/founder-grant logic. NOTE: this pass
// reuses the labels WARN-1/WARN-2/WARN-3 from the reviewer's own numbering —
// they are UNRELATED to the SECOND-pass WARN-1/WARN-3 above (different
// findings entirely); every inline comment for this pass says "THIRD pass"
// explicitly to avoid the collision.
//
//   BLOCK-1 (P0) — src/org/index.ts's three org routes cast an unvalidated
//   JSON body straight into DepartmentInput/SquadInput/AgentInput
//   (`body = (await c.req.json()) as CreateXBody` — a CAST, not a parse), so
//   `kind` living on those Input interfaces meant any org:admin/
//   department:admin/squad:lead caller could POST {"kind":"home",...} and
//   skip the plan-entitlement gate entirely — worse than P0-N1, and the
//   planted rows are invisible (the GET routes never select kind). FIX: kind
//   no longer lives on any Input interface — src/org/service.ts's
//   createDepartment/createSquad/prepareAgentCreate now take it as a
//   SEPARATE `opts: CreateOpts` parameter that only this function supplies.
//   A route body has nowhere to bind `kind` to anymore; the exemption is
//   unrepresentable from an HTTP request, not merely filtered.
//
//   WARN-1 (THIRD pass) — findDepartmentBySlug/findSquadBySlug adopted any
//   slug match, but slug is caller-chosen everywhere else in the codebase
//   (POST /departments, the dashboard, MCP create_department/create_squad) —
//   proving the slug is not proving provenance. FIX: both lookups now
//   additionally require kind='home' on the row they adopt; a colliding
//   work-kind (or otherwise squatted) row is refused, not adopted.
//
//   WARN-2 (THIRD pass) — the founder-grant INSERT (river addendum A) was
//   unconditional; capabilities' UNIQUE(member_id, scope_type, scope_id)
//   meant a pre-existing capability row for this member on the adopted
//   squad made every retry fail identically, forever (a permanent lockout,
//   the P0-N2 shape from the other direction). FIX: pre-check the exact
//   tuple before building the batch; a pre-existing row is adopted (its real
//   capability value is returned, never widened to admin), and the INSERT
//   statement is omitted from the batch entirely rather than made a no-op —
//   assertBatchWritten's per-statement receipt check stays meaningful.
//
//   WARN-3 (THIRD pass) — no test exercised compensateCreatedRows against a
//   batch that ACTUALLY COMMITTED (every prior test used a stub that never
//   writes). Added — see tests/bootstrap-self.test.ts's "compensator vs a
//   real committed winner" describe block. compensateCreatedRows is now
//   exported for that test to call directly (WARN-3's own comment already
//   explains why calling it through bootstrapSelf a second time cannot reach
//   this state: the already-bootstrapped pre-check intercepts a second call
//   for the same human before the batch ever runs).
//
// See the build report for exact line references, literal test output, and
// per-mutation evidence.

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env, Agent, AuthContext, Department, Squad, Capability } from '../types'
import { createDepartment, createSquad, prepareAgentCreate, isValidSlug } from '../org/service'
import { prepareAgentBoundTokenMint, resolveActiveAgentMember, type AgentForMint } from './service'
import { assertBatchWritten, type D1WriteLike } from '../lib/receipt'

// Mirrors AGENT_SNAPSHOT_JSON's field list (src/org/service.ts, ~line 757) so a
// bootstrap-creation record and an update_agent correction record are directly
// comparable — same shape, different story (nonexistent -> created, vs. one
// value -> another).
const AGENT_SNAPSHOT_FIELDS = [
  'squad_id', 'slug', 'name', 'role', 'status', 'model', 'model_fallback',
  'purpose', 'owner', 'capabilities', 'skills', 'parent_agent_id', 'qnft_ref',
  'budget_cap_cents', 'budget_window',
] as const

/** The honest "this agent did not exist" image — every audited field null. Not
 *  the blank-string sentinel updateAgentProfile's two-phase write uses; a real
 *  JSON object that says nothing existed yet. */
function emptyIdentitySnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}
  for (const field of AGENT_SNAPSHOT_FIELDS) snapshot[field] = null
  return snapshot
}

/** The full created-agent snapshot, read directly off the in-memory object this
 *  function already holds — never re-SELECTed from D1. There is nothing to race:
 *  these are the exact values about to be INSERTed. */
function createdAgentSnapshot(agent: Agent): Record<string, unknown> {
  return {
    squad_id: agent.squad_id,
    slug: agent.slug,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    model: agent.model,
    model_fallback: agent.model_fallback,
    purpose: agent.purpose,
    owner: agent.owner,
    capabilities: agent.capabilities,
    skills: agent.skills,
    parent_agent_id: agent.parent_agent_id,
    qnft_ref: agent.qnft_ref,
    budget_cap_cents: agent.budget_cap_cents,
    budget_window: agent.budget_window,
  }
}

// ── per-member attempt throttle (adversarial review LOW-1) ────────────────────
// Keyed on the MEMBER, not the IP: an IP-keyed limiter (the OAuth door's own B2)
// is bypassed by rotating IPs, but a human cannot rotate their own member id —
// it is the row findOrCreateMember resolved from their verified Google email.
// Same KV-counter shape as B2 (src/mcp/oauth-authorize.ts), independent
// instance: this gates a DIFFERENT action (minting an agent) than B2 gates
// (minting a member), and the two must not share a budget.
const BOOTSTRAP_RL_MAX = 5
const BOOTSTRAP_RL_TTL = 3600 // seconds (1 hour)

export interface RateLimitResult {
  allowed: boolean
  retryAfter: number
}

export async function checkBootstrapSelfRateLimit(env: Env, memberId: string): Promise<RateLimitResult> {
  const key = `bootstrap-self-rl:${memberId}`
  try {
    const raw = await env.SESSIONS.get(key)
    const count = raw !== null ? parseInt(raw, 10) : 0
    if (count >= BOOTSTRAP_RL_MAX) return { allowed: false, retryAfter: BOOTSTRAP_RL_TTL }
    await env.SESSIONS.put(key, String(count + 1), { expirationTtl: BOOTSTRAP_RL_TTL })
    return { allowed: true, retryAfter: 0 }
  } catch {
    // Fail-open: KV unavailability must not lock a legitimate first-run human
    // out entirely. Same posture as B2.
    return { allowed: true, retryAfter: 0 }
  }
}

// LOW-1 (adversarial review, second pass): a pot-wide entitlement failure
// (department/squad/agent_limit_reached) is not the caller's fault — spamming
// retries into a full pot is not attempt-abuse, so it must not burn the same
// per-member throttle budget a genuine retry storm would. Best-effort refund;
// never throws (fail-open, same posture as the check itself).
//
// NOTE ON REACHABILITY: as of mupot#925 P0-N1 (the kind='home' exemption),
// bootstrap_self ALWAYS passes kind:'home' to createDepartment/createSquad/
// prepareAgentCreate, and all three skip their entitlement gate entirely for a
// 'home' create (src/org/service.ts) — so today this function has no live call
// site that can actually fire from INSIDE bootstrapSelf. It is wired in anyway,
// at the three stages that used to be able to return a *_limit_reached reason
// before that fix, as defense-in-depth against a future change that re-exposes
// a limit check on the home-creation path. See the build report for the
// reachability argument in full.
export async function refundBootstrapSelfRateLimit(env: Env, memberId: string): Promise<void> {
  const key = `bootstrap-self-rl:${memberId}`
  try {
    const raw = await env.SESSIONS.get(key)
    const count = raw !== null ? parseInt(raw, 10) : 0
    if (count <= 0) return
    // KV has no partial-TTL-preserving write in this binding surface — a
    // refund necessarily resets the window's clock along with the count. That
    // is a minor imprecision (a refunded attempt gets a fresh hour rather than
    // the remainder of the old one), never a correctness problem: it can only
    // ever WIDEN the caller's remaining budget, never narrow it.
    await env.SESSIONS.put(key, String(count - 1), { expirationTtl: BOOTSTRAP_RL_TTL })
  } catch {
    // best-effort; never block on a refund.
  }
}

/** True for the three provisioning_failed reasons a pot-wide entitlement gate
 *  (not the caller's fault) can produce — see refundBootstrapSelfRateLimit. */
function isEntitlementLimitReason(reason: unknown): boolean {
  return reason === 'department_limit_reached'
    || reason === 'squad_limit_reached'
    || reason === 'agent_limit_reached'
}

// ── the gate this whole path hangs off ─────────────────────────────────────────
// WARN-3 (adversarial review, second pass): this used to be a hand-declared duck
// type with no compile-time link to AuthContext (src/types.ts) — a rename of
// AuthContext.boundAgentId would leave `!auth.boundAgentId` at
// isUnboundDirectorySession permanently true (an always-undefined field reads as
// falsy), silently passing an agent-bound session through the gate, with no
// TypeScript error anywhere. `Pick` makes that rename a compile error here
// instead: the real caller (src/mcp/bootstrap.ts's `run(auth, env, args)`) always
// passes a full AuthContext, which is trivially assignable to this narrower type.
export type BootstrapAuth = Pick<AuthContext, 'channel' | 'boundAgentId' | 'memberId'>

function isUnboundDirectorySession(auth: BootstrapAuth): auth is BootstrapAuth & { memberId: string } {
  return auth.channel === 'directory' && !auth.boundAgentId && typeof auth.memberId === 'string'
}

export type BootstrapSelfFailure =
  | 'agent_name_required'
  | 'not_unbound_directory_session'
  | 'rate_limited'
  | 'already_bootstrapped'
  | 'provisioning_failed'

export interface BootstrapSelfOk {
  ok: true
  disposition: 'created'
  department: { id: string; slug: string }
  squad: { id: string; slug: string; name: string }
  agent: { id: string; slug: string; name: string }
  member_id: string // the agent's OWN dedicated member — never the human's
  token: { id: string; raw: string; capability: 'observer' | 'member' }
  // river addendum A — the FOUNDING HUMAN's own grant, a separate principal
  // from `member_id` above. Always scope_type='squad', scope_id=squad.id.
  // capability is 'admin' when this call wrote the grant fresh; WARN-2: when a
  // pre-existing row was adopted instead (never widened), capability reflects
  // that row's REAL value and disposition is 'existing', not 'created'.
  founder_grant: { member_id: string; squad_id: string; capability: Capability; disposition: 'created' | 'existing' }
  audit_id: string
  directory_session_note: string
}

export interface BootstrapSelfErr {
  ok: false
  error: BootstrapSelfFailure
  detail?: unknown
}

export type BootstrapSelfResult = BootstrapSelfOk | BootstrapSelfErr

const DIRECTORY_SESSION_NOTE =
  'This token is a WORKSPACE-channel credential — put it in a client that sends a bearer token '
  + 'directly (e.g. your agent\'s .mcp.json), the same way mint_agent_token\'s output is used. '
  + 'It does NOT change THIS OAuth/directory session by itself, which stays unbound (zero '
  + 'standing capability) on purpose. Separately, you (the human) now hold admin on your new '
  + 'home squad (see founder_grant) — so if you want THIS session bound instead, you can go '
  + 'through the normal /oauth/consent flow and choose this agent; you will clear its admin '
  + 'floor honestly, because you now are admin on this squad.'

function isBootstrapAuditConflict(err: unknown): boolean {
  return err instanceof Error
    && /UNIQUE constraint failed/i.test(err.message)
    && err.message.includes('agent_audit')
}

async function findExistingBootstrap(
  env: Env,
  consentingMemberId: string,
): Promise<{ agent_id: string } | null> {
  return env.DB.prepare(
    `SELECT agent_id FROM agent_audit WHERE actor_id = ?1 AND action = 'bootstrap_self' LIMIT 1`,
  ).bind(consentingMemberId).first<{ agent_id: string }>()
}

async function alreadyBootstrappedResult(env: Env, consentingMemberId: string): Promise<BootstrapSelfErr> {
  const existing = await findExistingBootstrap(env, consentingMemberId)
  if (!existing) return { ok: false, error: 'already_bootstrapped' }
  const binding = await resolveActiveAgentMember(env, existing.agent_id)
  return {
    ok: false,
    error: 'already_bootstrapped',
    detail: {
      agent_id: existing.agent_id,
      member_id: binding === 'unminted' || binding === 'ambiguous' ? null : binding,
    },
  }
}

/**
 * WARN-1 (adversarial review, second pass): each DELETE gets its OWN try/catch.
 * Before this fix, a single unguarded call ran both deletes; once the batch has
 * actually landed (e.g. a real D1 commit followed by an app-level throw — see
 * LOW-3's assertBatchWritten, or the WARN-2 test), DELETE FROM squads reaches
 * agents via ON DELETE CASCADE, and agent_member_bindings.agent_id's
 * ON DELETE RESTRICT (migration 0071) refuses that cascade — the squads DELETE
 * itself throws "FOREIGN KEY constraint failed", the department DELETE never
 * even runs, and the exception used to escape uncaught (a bare 500 with the
 * real stage/reason lost). Splitting the two into independent try/catch means a
 * blocked squad delete no longer suppresses the department delete attempt, and
 * neither ever throws out of this function — the caller always gets back the
 * structured provisioning_failed it was already building.
 *
 * Only ever called with ids THIS invocation itself created (never an ADOPTED,
 * pre-existing row from a prior attempt — see findDepartmentBySlug/
 * findSquadBySlug below) — deleting an adopted row out from under a possibly-
 * still-live prior identity would be the P0-N2 lockout's mirror-image bug.
 *
 * Exported (WARN-3, THIRD pass, PR #928) SOLELY so tests/bootstrap-self.test.ts
 * can drive it directly against a REAL, already-committed winner's rows — the
 * exact "batch that actually committed" case no test exercised before. Calling
 * bootstrapSelf itself a second time for the same human cannot reach that
 * state: findExistingBootstrap's pre-check intercepts the second call before
 * any batch ever runs (see the file header, condition 5).
 */
export async function compensateCreatedRows(
  env: Env,
  squadId: string | null,
  departmentId: string | null,
): Promise<void> {
  if (squadId) {
    try {
      await env.DB.prepare('DELETE FROM squads WHERE id = ?1').bind(squadId).run()
    } catch {
      // Best-effort. If this is FK-blocked (an agent already landed for real —
      // see the file comment above), the department delete below must still be
      // attempted rather than skipped.
    }
  }
  if (departmentId) {
    try {
      await env.DB.prepare('DELETE FROM departments WHERE id = ?1').bind(departmentId).run()
    } catch {
      // Best-effort; see above. An orphaned dept/squad is never delete-guarded
      // by anything ELSE in the schema, so leaving one behind on a genuinely
      // failed delete is always safe for a future retry/adopt (P0-N2) rather
      // than something worth looping or escalating on here.
    }
  }
}

// P0-N2 (adversarial review, second pass) — orphan lockout fix.
//
// deptSlug/squadSlug are SERVER-DERIVED from consentingMemberId (see the file
// header) and departments.slug is GLOBALLY UNIQUE (migrations/0001_init.sql).
// Before this fix there was no adopt-existing branch: createDepartment's
// slug_taken became provisioning_failed{stage:'department'} FOREVER, with no
// audit row and no way to recover — every retry hit the exact same dead end
// whenever a prior bootstrap_self attempt for this same human had committed
// the department (or squad) but never finished, e.g. the worker died between
// the createSquad commit and the final atomic batch.
//
// WARN-1 (adversarial review, THIRD pass, PR #928) — the PREVIOUS
// version of this comment asserted "the only way this slug can exist is a
// prior bootstrap_self by the same human." That claim is FALSE and this
// function must not rely on it: `dept-home-<memberId>` / `home-<memberId>`
// are ordinary valid slugs (isValidSlug has no reserved-prefix concept), and
// slug is CALLER-CHOSEN on POST /departments (src/org/index.ts), the
// dashboard, and MCP create_department/create_squad — any org:admin can
// create a department slugged exactly `dept-home-<some-other-uuid>` today.
// Proving the slug matches is therefore NOT proof of provenance; only
// kind='home' is (every OTHER creation path in this codebase always defaults
// to kind='work' — see src/org/service.ts's CreateOpts block comment — so
// kind='home' is, by construction, reachable ONLY through this function).
//
// FIX: both lookups now require kind='home' on the row they would adopt. A
// slug collision against a kind='work' row (or a 'home' row seeded by
// something other than this exact human, in some future world where kind
// alone is not enough) is treated as NOT FOUND — the caller's existing
// slug_taken_but_not_found handling then refuses provisioning outright
// (provisioning_failed) rather than silently adopting a stranger's — or a
// wrong-kind — row into this human's identity chain.
async function findDepartmentBySlug(env: Env, slug: string): Promise<Department | null> {
  return env.DB.prepare(`SELECT * FROM departments WHERE slug = ?1 AND kind = 'home' LIMIT 1`)
    .bind(slug)
    .first<Department>()
}

async function findSquadBySlug(env: Env, departmentId: string, slug: string): Promise<Squad | null> {
  return env.DB.prepare(`SELECT * FROM squads WHERE department_id = ?1 AND slug = ?2 AND kind = 'home' LIMIT 1`)
    .bind(departmentId, slug)
    .first<Squad>()
}

export interface BootstrapSelfDeps {
  createDepartment: typeof createDepartment
  createSquad: typeof createSquad
  prepareAgentCreate: typeof prepareAgentCreate
  prepareAgentBoundTokenMint: typeof prepareAgentBoundTokenMint
  checkRateLimit: typeof checkBootstrapSelfRateLimit
  batch: (env: Env, statements: D1PreparedStatement[]) => Promise<D1WriteLike[]>
}

export function defaultBootstrapSelfDeps(): BootstrapSelfDeps {
  return {
    createDepartment,
    createSquad,
    prepareAgentCreate,
    prepareAgentBoundTokenMint,
    checkRateLimit: checkBootstrapSelfRateLimit,
    batch: (env, statements) => env.DB.batch(statements),
  }
}

/**
 * bootstrapSelf — mint a self-service agent identity for an unbound, verified
 * directory session that has just NAMED an agent in conversation. See the file
 * header for the full design (River's conditions, the atomicity argument, and
 * the directory-session caveat).
 */
export async function bootstrapSelf(
  env: Env,
  auth: BootstrapAuth,
  agentNameArg: unknown,
  deps: BootstrapSelfDeps = defaultBootstrapSelfDeps(),
): Promise<BootstrapSelfResult> {
  // Condition 2 — ONLY an unbound, Google-verified DIRECTORY session. An
  // agent-bound token already has a voice; every other channel (workspace/im/
  // dashboard) is not the public first-run door this path exists for.
  if (!isUnboundDirectorySession(auth)) {
    return { ok: false, error: 'not_unbound_directory_session' }
  }
  const consentingMemberId = auth.memberId

  // Condition 1 — agent_name is REQUIRED. Naming is the witness act; there is
  // no silent auto-create and no defaulted name.
  const agentName = typeof agentNameArg === 'string' ? agentNameArg.trim() : ''
  if (!agentName) return { ok: false, error: 'agent_name_required' }
  if (agentName.length > 128) {
    return { ok: false, error: 'agent_name_required', detail: 'agent_name must be 128 characters or fewer' }
  }

  // Per-member attempt throttle (adversarial review LOW-1) — runs BEFORE the
  // already-bootstrapped pre-check, not after. Before this reorder, a member
  // who already bootstrapped could hammer this tool for free forever: the
  // pre-check short-circuited every repeat call BEFORE it ever reached the
  // throttle, so an unlimited-rate loop of "is this member bootstrapped yet"
  // reads never cost the caller anything. Now every call, including a cheap
  // already_bootstrapped repeat, spends one unit of the SAME 5/hour budget.
  const rl = await deps.checkRateLimit(env, consentingMemberId)
  if (!rl.allowed) {
    return { ok: false, error: 'rate_limited', detail: { retry_after_seconds: rl.retryAfter } }
  }

  // Condition 5 (part 1 of 2 — see migration 0092 for the structural half) —
  // optimization only: skip five doomed writes on the common repeat-call path.
  const preCheck = await findExistingBootstrap(env, consentingMemberId)
  if (preCheck) return alreadyBootstrappedResult(env, consentingMemberId)

  // Server-derived slugs (adversarial review P0-1) — see the file header for
  // why this is structurally collision-proof and needs no extra uniqueness
  // probe. Defensive-only: isValidSlug can only fail here if consentingMemberId
  // is ever something other than the UUID findOrCreateMember always mints.
  const deptSlug = `dept-home-${consentingMemberId}`
  const squadSlug = `home-${consentingMemberId}`
  const agentSlug = `self-${consentingMemberId}`
  if (!isValidSlug(deptSlug) || !isValidSlug(squadSlug) || !isValidSlug(agentSlug)) {
    return { ok: false, error: 'provisioning_failed', detail: { stage: 'slug_derivation' } }
  }

  const homeName = `Home — ${agentName}`

  // ── department, squad: individually-committing, always fully compensable ────
  // Every row this function creates is kind:'home' (mupot#925 P0-N1) — a
  // structural exemption from the pot's plan-limit counters (src/org/service.ts,
  // src/billing/plans.ts), never a tier carve-out. A human bootstrapping their
  // own identity is never "one more work squad"; it is the room they speak in.
  let departmentId: string
  let departmentCreatedHere = false
  const deptResult = await deps.createDepartment(env, { slug: deptSlug, name: homeName }, { kind: 'home' })
  if (deptResult.ok) {
    departmentId = deptResult.value.id
    departmentCreatedHere = true
  } else if (deptResult.error === 'slug_taken') {
    // P0-N2 (adversarial review, second pass) — adopt-existing, gated by
    // kind='home' (WARN-1). See findDepartmentBySlug's doc comment: a slug
    // match alone is NOT proof this is a prior attempt by the same human —
    // only kind='home' is, since every other creation path defaults to
    // kind='work'. A colliding non-home row is treated as not found below.
    const existing = await findDepartmentBySlug(env, deptSlug)
    if (!existing) {
      return { ok: false, error: 'provisioning_failed', detail: { stage: 'department', reason: 'slug_taken_but_not_found' } }
    }
    departmentId = existing.id
  } else {
    if (isEntitlementLimitReason(deptResult.error)) await refundBootstrapSelfRateLimit(env, consentingMemberId)
    return { ok: false, error: 'provisioning_failed', detail: { stage: 'department', reason: deptResult.error } }
  }

  let squad: Squad
  let squadCreatedHere = false
  const squadResult = await deps.createSquad(env, departmentId, { slug: squadSlug, name: homeName }, { kind: 'home' })
  if (squadResult.ok) {
    squad = squadResult.value
    squadCreatedHere = true
  } else if (squadResult.error === 'slug_taken') {
    // P0-N2 — adopt-existing, same kind='home' gate as the department above
    // (WARN-1): a squad slug match under this department is only adoptable
    // when it is ALSO kind='home' — a work-kind squad squatting on this slug
    // is never adopted, treated as not-found below instead.
    const existing = await findSquadBySlug(env, departmentId, squadSlug)
    if (!existing) {
      await compensateCreatedRows(env, null, departmentCreatedHere ? departmentId : null)
      return { ok: false, error: 'provisioning_failed', detail: { stage: 'squad', reason: 'slug_taken_but_not_found' } }
    }
    squad = existing
  } else {
    if (isEntitlementLimitReason(squadResult.error)) await refundBootstrapSelfRateLimit(env, consentingMemberId)
    await compensateCreatedRows(env, null, departmentCreatedHere ? departmentId : null)
    return { ok: false, error: 'provisioning_failed', detail: { stage: 'squad', reason: squadResult.error } }
  }

  // ── agent + member + weld + capability + token + audit: ONE atomic batch ───
  const preparedAgent = await deps.prepareAgentCreate(env, squad.id, { slug: agentSlug, name: agentName }, { kind: 'home' })
  if (!preparedAgent.ok) {
    if (isEntitlementLimitReason(preparedAgent.error)) await refundBootstrapSelfRateLimit(env, consentingMemberId)
    await compensateCreatedRows(
      env,
      squadCreatedHere ? squad.id : null,
      departmentCreatedHere ? departmentId : null,
    )
    return { ok: false, error: 'provisioning_failed', detail: { stage: 'agent', reason: preparedAgent.error } }
  }
  const agent = preparedAgent.value.agent

  const agentForMint: AgentForMint = {
    id: agent.id,
    squad_id: agent.squad_id,
    slug: agent.slug,
    name: agent.name,
  }

  let preparedMint
  try {
    // Condition 3 — 'member' requested explicitly (never the default left
    // implicit). mintAgentBoundToken's own escalation guard hard-caps this to
    // observer/member regardless; this is belt-and-braces, not the only
    // enforcement. THE SHARED GRANT PATH (src/projects/start-gate.ts:298-301
    // doctrine): these are the exact statements that path already prepares —
    // not a forked re-implementation of the weld.
    preparedMint = await deps.prepareAgentBoundTokenMint(
      env,
      agentForMint,
      `bootstrap-self:${agent.slug}`,
      'member',
    )
  } catch (err) {
    await compensateCreatedRows(
      env,
      squadCreatedHere ? squad.id : null,
      departmentCreatedHere ? departmentId : null,
    )
    return {
      ok: false,
      error: 'provisioning_failed',
      detail: { stage: 'mint_prepare', reason: err instanceof Error ? err.message : String(err) },
    }
  }

  // ── the founder grant (river addendum A) — the HUMAN, not the agent ─────────
  // The home squad is created BY this act; its founder's key to their own room
  // is ownership, not privilege. This is a SEPARATE principal and a SEPARATE
  // row from the agent's own 'member' grant above — never conflate the two:
  //   agent (its own dedicated member)  -> squad:member  (condition 3, unchanged)
  //   founding human (consentingMemberId) -> squad:admin (this grant)
  // BOUND EXACTLY: scope_type='squad', scope_id=squad.id (the UUID just
  // created by createSquad above — NEVER the slug; WARN-3: a slug-valued
  // scope_id is invisible to the capability-ceiling triggers in BOTH
  // directions, and there is a live slug-valued row in production today).
  // Never org (scope_id NULL = tenant-wide, migrations/0002_members.sql:32-33)
  // or department scope, and never any squad other than this one — the human
  // gets a key to the room they just built, nothing wider.
  //
  // This does NOT touch /oauth/consent's eligibility floor (mupot#903b P0-3,
  // src/mcp/oauth-authorize.ts:206-231) — that gate is unchanged. The human
  // simply now, genuinely, holds squad:admin on the home squad it checks, so
  // they can clear it on its own terms if they later choose to bind THIS SAME
  // OAuth session to the new agent via the normal consent flow.
  //
  // WARN-2 (adversarial review, THIRD pass, PR #928): this used to be
  // an UNCONDITIONAL INSERT. capabilities carries UNIQUE(member_id, scope_type,
  // scope_id) (migrations/0002_members.sql:36) — if the ADOPTED squad (P0-N2,
  // above) already has ANY capability row for this member on ('squad',
  // squad.id) — e.g. an operator pre-seated this human on their own home squad
  // before bootstrap_self ever ran — the unconditional INSERT threw a UNIQUE
  // violation INSIDE the atomic batch. That error message contains
  // "capabilities", never "agent_audit", so isBootstrapAuditConflict
  // misclassified it as a hard failure, and every input here is deterministic
  // (server-derived slugs, same member, same squad), so every retry failed
  // identically — a PERMANENT lockout, the P0-N2 shape reached from the other
  // direction.
  //
  // FIX: pre-check for an existing row on the EXACT (consentingMemberId,
  // 'squad', squad.id) tuple BEFORE building the batch, and only ever include
  // founderAdminStatement when none exists. A pre-existing row is therefore
  // never fatal — and NEVER WIDENED: if the pre-seated row already holds
  // something other than 'admin' (e.g. an operator granted 'member'), this
  // path does not touch it. The ceiling story (river's condition 3, the
  // agent's OWN grant clamp) depends on nothing here ever escalating a row it
  // did not create — see prepareAgentBoundTokenMintForBinding's own "clamp,
  // never widen" comment (src/members/service.ts) for the sibling doctrine
  // this mirrors. A statement that is never added cannot trip
  // assertBatchWritten's per-statement receipt check either — the batch below
  // only ever contains statements this call actually expects to write >=1 row.
  //
  // Residual TOCTOU: a row inserted by something else in the narrow window
  // between this SELECT and the batch commit would still throw inside the
  // batch (no ON CONFLICT clause — belt-and-suspenders would fight
  // assertBatchWritten's uniform per-statement expectation). That failure is
  // NOT a lockout: it lands in the generic provisioning_failed{stage:'batch'}
  // path below, and the department/squad were already individually committed
  // (never touched by this race), so a plain retry re-runs this same pre-check,
  // now sees the row, and succeeds — unlike the P0-N2/WARN-2 shapes, nothing
  // here is deterministically doomed.
  const existingFounderGrant = await env.DB.prepare(
    `SELECT capability FROM capabilities
      WHERE member_id = ?1 AND scope_type = 'squad' AND scope_id = ?2
      LIMIT 1`,
  ).bind(consentingMemberId, squad.id).first<{ capability: Capability }>()

  const founderGrantId = crypto.randomUUID()
  const founderAdminStatement = existingFounderGrant
    ? null
    : env.DB.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         VALUES (?1, ?2, 'squad', ?3, 'admin')`,
      ).bind(founderGrantId, consentingMemberId, squad.id)

  // Condition 4 — before/after computed as plain JS values, right here, before
  // any INSERT runs. Nothing later in this function reads them back from D1.
  // This is a governance requirement, not a workaround for any platform
  // behaviour: a self-commissioned identity must not start unproven, and the
  // record must be written by the path that did the deed.
  const auditId = crypto.randomUUID()
  const beforeState = JSON.stringify(emptyIdentitySnapshot())
  const afterState = JSON.stringify(createdAgentSnapshot(agent))
  const auditStatement = env.DB.prepare(
    `INSERT INTO agent_audit
       (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
     VALUES (?1, ?2, ?3, 'user', 'bootstrap_self', ?4, ?5, ?6)`,
  ).bind(
    auditId,
    agent.id,
    consentingMemberId,
    JSON.stringify(AGENT_SNAPSHOT_FIELDS),
    beforeState,
    afterState,
  )

  const allStatements: D1PreparedStatement[] = [
    ...preparedAgent.value.statements,
    ...preparedMint.statements,
    // Only included when there is no pre-existing founder grant to conflict
    // with (WARN-2 above) — omitted, not a no-op statement, so
    // assertBatchWritten's per-statement expected>=1 check stays meaningful
    // for every statement that IS in this array.
    ...(founderAdminStatement ? [founderAdminStatement] : []),
    auditStatement,
  ]

  try {
    // LOW-3: same receipt discipline commitPreparedAgentTokenMint applies to
    // the identical statements (src/members/service.ts) — a D1 batch call can
    // report success while a statement inside it silently wrote zero rows (a
    // swallowed ON CONFLICT, a replica that didn't land). Without this, a
    // "minted" bootstrap whose token/binding/audit row never actually landed
    // would still return ok:true.
    const writes = await deps.batch(env, allStatements)
    assertBatchWritten(writes, 'bootstrap_self', 1)
  } catch (err) {
    // WARN-1 (adversarial review, second pass): CLASSIFY FIRST, compensate
    // SECOND — the reverse of the original order. A losing race on the
    // agent_audit uniqueness guard (migration 0092) means the WINNING caller's
    // batch already committed for real; reporting already_bootstrapped must
    // not first run a delete against rows a real, live identity may now
    // depend on. See compensateCreatedRows' doc comment for the FK-cascade
    // failure mode that made an unconditional pre-classification delete
    // dangerous (escaped exceptions, and — worse — a delete that could
    // silently succeed against a real winner's rows in a shape this repo's
    // FK graph does not actually allow, but a future schema change could).
    //
    // Only ever compensate rows THIS invocation created (never an ADOPTED
    // row — P0-N2): if department/squad were adopted from a prior partial
    // attempt, deleting them on THIS attempt's batch failure would reproduce
    // the exact orphan-lockout P0-N2 exists to close, just from the other
    // direction.
    const auditConflict = isBootstrapAuditConflict(err)
    if (!auditConflict) {
      await compensateCreatedRows(
        env,
        squadCreatedHere ? squad.id : null,
        departmentCreatedHere ? departmentId : null,
      )
    }
    if (auditConflict) {
      // A concurrent bootstrap for the SAME human won the race. Report exactly
      // what the pre-check would have reported to a slightly-later caller.
      return alreadyBootstrappedResult(env, consentingMemberId)
    }
    return {
      ok: false,
      error: 'provisioning_failed',
      detail: { stage: 'batch', reason: err instanceof Error ? err.message : String(err) },
    }
  }

  return {
    ok: true,
    disposition: 'created',
    department: { id: departmentId, slug: deptSlug },
    squad: { id: squad.id, slug: squadSlug, name: squad.name },
    agent: { id: agent.id, slug: agent.slug, name: agent.name },
    member_id: preparedMint.memberId,
    token: { id: preparedMint.tokenId, raw: preparedMint.raw, capability: preparedMint.grantCapability },
    // WARN-2: report the REAL row, not always 'admin' — when a pre-existing
    // grant was adopted rather than written, capability reflects whatever it
    // actually holds and disposition says so, so a caller can never be told
    // "you have admin" when what genuinely exists on the row is something
    // this path deliberately left untouched.
    founder_grant: existingFounderGrant
      ? { member_id: consentingMemberId, squad_id: squad.id, capability: existingFounderGrant.capability, disposition: 'existing' }
      : { member_id: consentingMemberId, squad_id: squad.id, capability: 'admin', disposition: 'created' },
    audit_id: auditId,
    directory_session_note: DIRECTORY_SESSION_NOTE,
  }
}
