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
// can ever collide on it. That structural uniqueness is why no additional
// "refuse if this slug exists tenant-wide" check is needed on top: the only way
// `home-<memberId>` already exists is if THIS SAME human already has a home
// squad, which the idempotency check above already handles.
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

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env, Agent } from '../types'
import { createDepartment, createSquad, prepareAgentCreate, isValidSlug } from '../org/service'
import { prepareAgentBoundTokenMint, resolveActiveAgentMember, type AgentForMint } from './service'

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

// ── the gate this whole path hangs off ─────────────────────────────────────────
export interface BootstrapAuth {
  channel?: string
  boundAgentId?: string | null
  memberId?: string
}

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
  founder_grant: { member_id: string; squad_id: string; capability: 'admin' }
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

/** Department and squad are never referenced by anything with a delete-guard
 *  trigger, so both are always safely, fully deletable — no partial state can
 *  ever survive this. Missing ids are simply skipped (nothing to undo yet). */
async function deleteOrphanedDeptAndSquad(
  env: Env,
  squadId: string | null,
  departmentId: string | null,
): Promise<void> {
  if (squadId) await env.DB.prepare('DELETE FROM squads WHERE id = ?1').bind(squadId).run()
  if (departmentId) await env.DB.prepare('DELETE FROM departments WHERE id = ?1').bind(departmentId).run()
}

export interface BootstrapSelfDeps {
  createDepartment: typeof createDepartment
  createSquad: typeof createSquad
  prepareAgentCreate: typeof prepareAgentCreate
  prepareAgentBoundTokenMint: typeof prepareAgentBoundTokenMint
  checkRateLimit: typeof checkBootstrapSelfRateLimit
  batch: (env: Env, statements: D1PreparedStatement[]) => Promise<unknown[]>
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

  // Condition 5 (part 1 of 2 — see migration 0092 for the structural half) —
  // optimization only: skip five doomed writes on the common repeat-call path.
  const preCheck = await findExistingBootstrap(env, consentingMemberId)
  if (preCheck) return alreadyBootstrappedResult(env, consentingMemberId)

  // Per-member attempt throttle (adversarial review LOW-1).
  const rl = await deps.checkRateLimit(env, consentingMemberId)
  if (!rl.allowed) {
    return { ok: false, error: 'rate_limited', detail: { retry_after_seconds: rl.retryAfter } }
  }

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
  const deptResult = await deps.createDepartment(env, { slug: deptSlug, name: homeName })
  if (!deptResult.ok) {
    return { ok: false, error: 'provisioning_failed', detail: { stage: 'department', reason: deptResult.error } }
  }
  const departmentId = deptResult.value.id

  const squadResult = await deps.createSquad(env, departmentId, { slug: squadSlug, name: homeName })
  if (!squadResult.ok) {
    await deleteOrphanedDeptAndSquad(env, null, departmentId)
    return { ok: false, error: 'provisioning_failed', detail: { stage: 'squad', reason: squadResult.error } }
  }
  const squad = squadResult.value

  // ── agent + member + weld + capability + token + audit: ONE atomic batch ───
  const preparedAgent = await deps.prepareAgentCreate(env, squad.id, { slug: agentSlug, name: agentName })
  if (!preparedAgent.ok) {
    await deleteOrphanedDeptAndSquad(env, squad.id, departmentId)
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
    await deleteOrphanedDeptAndSquad(env, squad.id, departmentId)
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
  const founderGrantId = crypto.randomUUID()
  const founderAdminStatement = env.DB.prepare(
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
    founderAdminStatement,
    auditStatement,
  ]

  try {
    await deps.batch(env, allStatements)
  } catch (err) {
    // The batch is all-or-nothing: NOTHING in it landed. Only department/squad
    // (committed earlier, outside this batch) can possibly be orphaned — and
    // both are always safely deletable (see the file header).
    await deleteOrphanedDeptAndSquad(env, squad.id, departmentId)
    if (isBootstrapAuditConflict(err)) {
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
    founder_grant: { member_id: consentingMemberId, squad_id: squad.id, capability: 'admin' },
    audit_id: auditId,
    directory_session_note: DIRECTORY_SESSION_NOTE,
  }
}
