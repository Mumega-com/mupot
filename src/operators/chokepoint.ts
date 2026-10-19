// mupot — THE structural-write chokepoint (Operators + Admission W0, mumega-com#1386).
//
// WHY ONE FUNCTION. Before W0 every structural tool carried its own `if (auth.boundAgentId) return fail(403,
// 'operator_principal_required')`, the HTTP twins carried a different rule (or none), and an org-admin agent was
// refused on MCP while the same act over HTTP went through requireCapability, which ignores boundAgentId (#1357).
// Same act, two surfaces, opposite answers. Every structural write, on both doors, now asks THIS function whether
// the caller is an agent and, if so, what that agent may do.
//
// WHAT IT DECIDES. Only the AGENT-BOUND half. A non-agent caller gets `{ kind: 'principal' }` and the site keeps its
// own capability checks, unchanged. For an agent-bound caller the answer is one of:
//   - refused          operator_principal_required (no delegation / not delegable), outside_delegation_scope,
//                      requires_human_approval (above the ceiling, machine-readable), or a flat hard refusal.
//   - agent_legacy     the pre-W0 lane for THIS action is still open (a live human-approved elevation grant, or the
//                      caller's own capability grants where MCP always allowed that) — the site runs its old logic.
//   - delegated        a live delegation covers the target, the delegator human STILL holds admin over the
//                      delegation scope right now, and the act is inside the ceiling. The authority is fully
//                      decided here, an authorization receipt (agent + delegator + delegation id) is already
//                      written, and the site must NOT re-derive standing from the agent's own grants.
//
// RE-DERIVED PER REQUEST. Nothing here caches. The delegation row, the delegator's membership, the delegator's
// live rank on the delegation scope and on the target, and the agent's own live rank are all read on every call, so
// a revocation or a delegator demotion bites on the very next request.
//
// WHAT A DELEGATION CAN NEVER BUY (not delegable, whatever rows exist): admin/owner grants, gate_grants, minting
// or revealing a token or credential, any act on a human member or the delegator, any act on the agent ITSELF,
// changing a delegation, money / deploy / publish. These are `delegable: false` in STRUCTURAL_ACTIONS, and the
// self/human target rules below apply to every delegated act regardless.

import { attachedAuthority, ceilingCapability } from '../auth/attached-ceiling'
import type { AuthContext, Capability, Env } from '../types'
import { boundAgentHasAnyLiveGrantForAction } from '../auth/elevation'
import { beginElevationReceipt, finishElevationReceipt } from '../auth/elevation-receipt'
import { capabilityRank, currentMemberRankOnScope, targetMaxRankAcrossScopes } from '../auth/capability'
import {
  agentIdForSeatMember,
  capabilityScopeForDelegation,
  delegatedOperatorsEnabled,
  listLiveDelegationsForAgent,
  memberLooksAgentBound,
  type DelegationRow,
} from './delegations'
import {
  installerDelegationsFor,
  reserveInstallerWrite,
  windowUsageCount,
  installerTierNeededFor,
  isInstallerDelegationId,
  liveInstallerWindows,
  type LiveInstallerWindow,
} from './installer-window'
import { INSTALLER_EXCLUDED_ACTS, INSTALLER_REFUSED_LOG_CAP, INSTALLER_STANDING_GRANT_CAP, INSTALLER_TIERS, installerWindowEnabled } from './installer-tiers'

/** Every act that writes org structure, standing authority or credentials. The registry is the ratchet's source. */
export type StructuralAction =
  // delegable under a live delegation
  | 'create_squad'
  | 'create_agent'
  | 'squad_member_add'
  | 'squad_member_remove'
  | 'grant_agent_capability'
  | 'move_agent_squad'
  | 'project_squad_set'
  | 'project_squad_remove'
  | 'member_capability_grant'
  | 'member_capability_revoke'
  // never delegable: an agent gets its pre-W0 lane or a refusal
  | 'create_department'
  // activating an addon materializes its department (and squads) through activateDepartment: structural, never delegable
  | 'activate_addon'
  | 'update_squad'
  | 'update_department'
  | 'update_agent'
  | 'deactivate_agent'
  | 'mint_agent_token'
  | 'list_agent_tokens'
  | 'revoke_agent_token'
  | 'list_agent_sessions'
  | 'revoke_agent_session'
  | 'provision_agent_connection'
  | 'register_agent_key'
  | 'grant_gate_capability'
  | 'revoke_gate_capability'
  | 'team_bootstrap'
  | 'team_bootstrap_release'
  | 'mint_member_token'
  | 'revoke_member_token'
  | 'suspend_member'
  | 'unbind_member_telegram'
  | 'create_invite'
  // points an agent's wake signal at an external URL with a bearer: the agent itself may (self lane, in the tool), nobody else's agent may
  | 'set_agent_webhook_doorbell'
  // changing or even reading who may act for whom is a human act: an agent never creates, extends, revokes or lists
  // delegations, its own or anyone's
  | 'manage_delegations'
  // W1 (#1875) adds project_repos, whose writes are structural. It adds no write tool; when one lands it MUST ask the
  // chokepoint for one of these (refuse-lane for agents until a wave decides otherwise).
  | 'grant_agent_membership'
  | 'project_create'
  | 'project_start'
  | 'project_repo_set'
  | 'project_repo_remove'

export interface StructuralPolicy {
  /** A live delegation can authorise this act (flag on). */
  readonly delegable: boolean
  /**
   * What an agent-bound caller with no covering delegation gets:
   *  - 'refuse':     operator_principal_required, always.
   *  - 'capability': the caller's own capability grants decide (the pre-W0 MCP behaviour for create_*, project_squad_*,
   *                  deactivate_agent, ...). With the flag ON a DELEGABLE act closes this lane — delegation replaces it.
   */
  readonly agentLane: 'refuse' | 'capability'
  /** A human-approved elevation action that still opens the pre-W0 lane for a live session. */
  readonly elevationAction?: string
}

/** Delegated acts that change what an EXISTING agent holds or where it sits. Each one checks the target's GLOBAL
 *  standing against max_grant. Kept as one named set (not an inline list) so a renamed or new act cannot silently
 *  drop out of the guard: gate r2 found the HTTP memberships route renamed to grant_agent_membership and unguarded.
 *  A ratchet test pins that every delegable act carrying an agent target is a member. */
export const TOUCHES_TARGET_STANDING: ReadonlySet<StructuralAction> = new Set<StructuralAction>([
  'squad_member_add', 'squad_member_remove', 'grant_agent_capability', 'grant_agent_membership',
  'member_capability_grant', 'member_capability_revoke', 'move_agent_squad',
])

export const STRUCTURAL_ACTIONS: Readonly<Record<StructuralAction, StructuralPolicy>> = {
  create_squad: { delegable: true, agentLane: 'capability', elevationAction: 'action:project_lifecycle' },
  create_agent: { delegable: true, agentLane: 'capability' },
  squad_member_add: { delegable: true, agentLane: 'refuse' },
  squad_member_remove: { delegable: true, agentLane: 'refuse' },
  grant_agent_capability: { delegable: true, agentLane: 'refuse', elevationAction: 'action:manage_access' },
  move_agent_squad: { delegable: true, agentLane: 'refuse' },
  project_squad_set: { delegable: true, agentLane: 'capability' },
  project_squad_remove: { delegable: true, agentLane: 'capability' },
  // POST /api/org/agents/:id/memberships: the HTTP twin of squad_member_add / grant_agent_capability, WITHOUT the MCP
  // manage_access elevation lane (main refuses every bound agent on this route; only a delegation opens it).
  grant_agent_membership: { delegable: true, agentLane: 'refuse' },
  member_capability_grant: { delegable: true, agentLane: 'refuse' },
  member_capability_revoke: { delegable: true, agentLane: 'refuse' },

  create_department: { delegable: false, agentLane: 'capability', elevationAction: 'action:org_department_create' },
  activate_addon: { delegable: false, agentLane: 'capability' },
  update_squad: { delegable: false, agentLane: 'refuse', elevationAction: 'action:org_structure' },
  update_department: { delegable: false, agentLane: 'refuse', elevationAction: 'action:org_structure' },
  update_agent: { delegable: false, agentLane: 'refuse' },
  deactivate_agent: { delegable: false, agentLane: 'capability' },
  mint_agent_token: { delegable: false, agentLane: 'refuse', elevationAction: 'action:mint_token' },
  list_agent_tokens: { delegable: false, agentLane: 'refuse' },
  revoke_agent_token: { delegable: false, agentLane: 'refuse' },
  list_agent_sessions: { delegable: false, agentLane: 'refuse' },
  revoke_agent_session: { delegable: false, agentLane: 'refuse' },
  provision_agent_connection: { delegable: false, agentLane: 'refuse' },
  register_agent_key: { delegable: false, agentLane: 'refuse' },
  // Gate authority is never an agent's to hand out, delegation or not. Before W0 an org-admin agent could reach these
  // on MCP through its own capability grants; W0 closes that unconditionally (the one flag-independent tightening
  // besides the HTTP doors, called out in the PR).
  grant_gate_capability: { delegable: false, agentLane: 'refuse' },
  revoke_gate_capability: { delegable: false, agentLane: 'refuse' },
  team_bootstrap: { delegable: false, agentLane: 'refuse' },
  team_bootstrap_release: { delegable: false, agentLane: 'refuse' },
  mint_member_token: { delegable: false, agentLane: 'refuse' },
  revoke_member_token: { delegable: false, agentLane: 'refuse' },
  suspend_member: { delegable: false, agentLane: 'refuse' },
  unbind_member_telegram: { delegable: false, agentLane: 'refuse' },
  create_invite: { delegable: false, agentLane: 'refuse' },
  set_agent_webhook_doorbell: { delegable: false, agentLane: 'refuse' },
  manage_delegations: { delegable: false, agentLane: 'refuse' },
  // project_create attaches the creator's own squad edge; project_start (planned -> active) provisions a department, squad,
  // agent, an admin edge and grants. Neither is delegable: an agent keeps exactly its pre-W0 lane (flag on or off).
  project_create: { delegable: false, agentLane: 'capability', elevationAction: 'action:workspace_project' },
  project_start: { delegable: false, agentLane: 'capability' },
  project_repo_set: { delegable: false, agentLane: 'refuse' },
  project_repo_remove: { delegable: false, agentLane: 'refuse' },
}

/** MCP tool name -> the action it must ask the chokepoint about. The ratchet test walks this against the source. */
export const STRUCTURAL_MCP_TOOLS: Readonly<Record<string, StructuralAction>> = {
  create_department: 'create_department',
  addon_activate: 'activate_addon',
  addon_setup: 'activate_addon',
  create_squad: 'create_squad',
  create_agent: 'create_agent',
  update_squad: 'update_squad',
  update_department: 'update_department',
  update_agent: 'update_agent',
  deactivate_agent: 'deactivate_agent',
  mint_agent_token: 'mint_agent_token',
  list_agent_tokens: 'list_agent_tokens',
  revoke_agent_token: 'revoke_agent_token',
  list_agent_sessions: 'list_agent_sessions',
  revoke_agent_session: 'revoke_agent_session',
  provision_agent_connection: 'provision_agent_connection',
  register_agent_key: 'register_agent_key',
  grant_agent_capability: 'grant_agent_capability',
  move_agent_squad: 'move_agent_squad',
  squad_member_add: 'squad_member_add',
  squad_member_remove: 'squad_member_remove',
  project_squad_set: 'project_squad_set',
  project_squad_remove: 'project_squad_remove',
  project_create: 'project_create',
  project_update: 'project_start',
  grant_gate_capability: 'grant_gate_capability',
  revoke_gate_capability: 'revoke_gate_capability',
  team_bootstrap: 'team_bootstrap',
  team_bootstrap_release: 'team_bootstrap_release',
  set_agent_webhook_doorbell: 'set_agent_webhook_doorbell',
  operator_delegate: 'manage_delegations',
  operator_revoke: 'manage_delegations',
  operator_list: 'manage_delegations',
}

export type StructuralStatus = 400 | 403 | 404 | 409

export interface StructuralRefusal {
  kind: 'refused'
  status: StructuralStatus
  error: string
  detail?: Record<string, unknown>
}

export type ProjectAccessLevel = 'read' | 'write' | 'admin'

/** What the act touches. Every field is optional; an action reads only the ones it needs. */
export interface StructuralTarget {
  squadId?: string
  /** move_agent_squad: the agent's current squad. */
  fromSquadId?: string
  departmentId?: string
  projectId?: string
  agentId?: string
  memberId?: string
  /** The rank the act confers; null/undefined = the act confers none. */
  capability?: Capability | null
  projectAccessLevel?: ProjectAccessLevel
  /** create_agent: the slug being created; a collision with ANY agent in the tenant is refused under delegation. */
  slug?: string
  /** Free-form, ends up in the receipt. Never put a secret in here. */
  detail?: Record<string, unknown>
}

export type StructuralTargetThunk = () => Promise<StructuralTarget | StructuralRefusal>

export interface DelegatedAuthorization {
  kind: 'delegated'
  /** The delegation that authorised the act: among overlapping live delegations, the one that permits it with the highest ceiling. */
  delegation: DelegationRow
  /** project_squad_set only: the squad-covering (org/department/squad) delegation that authorised the ATTACH. Both ids are in the receipt. */
  attachDelegation?: DelegationRow
  /** The target exactly as the gate resolved it (a seat member's agent id filled in). Sites compare their own re-resolution to it. */
  target: StructuralTarget
  /** min(max_grant, delegator live rank, agent live rank) on the target, as a capabilityRank number. */
  ceilingRank: number
  receiptId: string
  /** Installer window only: the elevation_usage_log row opened (pending) for this act, closed with the receipt. */
  installerUsageId?: string
}

export type StructuralVerdict =
  | { kind: 'principal' }
  | { kind: 'agent_legacy' }
  | DelegatedAuthorization
  | StructuralRefusal

export interface StructuralOptions {
  surface?: 'mcp' | 'http'
}

function refuse(status: StructuralStatus, error: string, detail?: Record<string, unknown>): StructuralRefusal {
  return { kind: 'refused', status, error, detail }
}

function isRefusal(v: StructuralTarget | StructuralRefusal): v is StructuralRefusal {
  return (v as StructuralRefusal).kind === 'refused'
}

function requiresHumanApproval(
  action: StructuralAction,
  reason: string,
  delegation: DelegationRow,
  extra: Record<string, unknown>,
): StructuralRefusal {
  return refuse(403, 'requires_human_approval', {
    requires_human_approval: true,
    act: action,
    reason,
    delegation_id: delegation.id,
    ...extra,
  })
}

interface SquadFacts {
  id: string
  department_id: string
  kind: string
}

async function loadSquad(env: Env, squadId: string): Promise<SquadFacts | null> {
  const row = await env.DB.prepare('SELECT id, department_id, kind FROM squads WHERE id = ?1 LIMIT 1')
    .bind(squadId)
    .first<SquadFacts>()
  return row ?? null
}

/** The delegator must be a live, active HUMAN holding admin over the delegation's own scope RIGHT NOW. */
async function delegatorIsLive(env: Env, d: DelegationRow): Promise<boolean> {
  const member = await env.DB.prepare(
    "SELECT status FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1",
  )
    .bind(d.delegator_member_id, env.TENANT_SLUG)
    .first<{ status: string }>()
  if (!member || member.status !== 'active') return false
  if (await memberLooksAgentBound(env, d.delegator_member_id)) return false
  const cap = capabilityScopeForDelegation(d.scope_type, d.scope_id)
  const rank = await currentMemberRankOnScope(env, d.delegator_member_id, cap.type, cap.id)
  return rank >= capabilityRank('admin')
}

type Element =
  | { type: 'squad'; squad: SquadFacts }
  | { type: 'department'; id: string }
  | { type: 'project'; id: string }

/**
 * Does this delegation cover this element? A delegation covers ONLY what its own scope names, and nothing that any
 * agent act can change at runtime. In particular a PROJECT delegation covers the project's own edge-management acts and
 * no squad at all: "squads linked to the project" is mutable state (project_squad_set, or a human link later), so
 * counting it would let a delegation widen its own scope (gate round 1, P0).
 */
async function delegationCovers(_env: Env, d: DelegationRow, el: Element): Promise<boolean> {
  if (d.scope_type === 'org') return true
  if (el.type === 'department') return d.scope_type === 'department' && d.scope_id === el.id
  if (el.type === 'project') return d.scope_type === 'project' && d.scope_id === el.id
  if (d.scope_type === 'squad') return d.scope_id === el.squad.id
  if (d.scope_type === 'department') return d.scope_id === el.squad.department_id
  return false
}

/**
 * The target agent's HIGHEST live standing anywhere: its seat's capabilities across org, department and squad scopes plus
 * the legacy role plane (targetMaxRankAcrossScopes, the #1411 rank-ceiling rule), and every membership row of the agent.
 * Standing is global, not per squad: an org-admin agent is not a lead-capped delegate's to demote or move just because it
 * holds nothing on the squad being touched.
 */
async function agentStandingGlobal(env: Env, agentId: string): Promise<number> {
  const seat = await env.DB.prepare(
    'SELECT member_id FROM agent_member_bindings WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1',
  )
    .bind(env.TENANT_SLUG, agentId)
    .first<{ member_id: string }>()
  const seatRank = seat ? await targetMaxRankAcrossScopes(env, seat.member_id) : 0
  const mem = await env.DB.prepare('SELECT capability FROM memberships WHERE agent_id = ?1')
    .bind(agentId)
    .all<{ capability: Capability }>()
  let membershipRank = 0
  for (const m of mem.results ?? []) membershipRank = Math.max(membershipRank, capabilityRank(m.capability))
  // Gate authority is not a rank, so it is never "below" a delegation's ceiling: an agent (or its seat member) holding ANY
  // gate_grants row is top standing, and no delegate can add, remove or move it.
  const gate = await env.DB.prepare(
    `SELECT 1 AS one FROM gate_grants
      WHERE (principal_type = 'agent' AND principal_id = ?1)
         OR (principal_type = 'member' AND principal_id = ?2)
      LIMIT 1`,
  )
    .bind(agentId, seat?.member_id ?? '')
    .first<{ one: number }>()
  const gateRank = gate ? capabilityRank('owner') : 0
  return Math.max(seatRank, membershipRank, gateRank)
}

const LEVEL_TO_CAPABILITY: Record<ProjectAccessLevel, Capability> = {
  read: 'observer',
  write: 'member',
  admin: 'admin',
}

type ReceiptOutcome = 'attempted' | 'applied' | 'refused'

/** One delegation that took part in authorising an act, as recorded in the receipt's detail. */
interface DelegationRef {
  id: string
  delegator_member_id: string
  scope_type: string
  scope_id: string | null
  role: 'covering' | 'attach_squad'
}

function delegationRef(d: DelegationRow, role: DelegationRef['role']): DelegationRef {
  return { id: d.id, delegator_member_id: d.delegator_member_id, scope_type: d.scope_type, scope_id: d.scope_id, role }
}

/**
 * Receipts opened for a request and not yet closed, keyed by the request's AuthContext object (one per request on HTTP
 * and per invokeTool dispatch on MCP; JSON-RPC calls in a batch run sequentially). This is what lets the dispatcher and
 * the HTTP apps close EVERY receipt a site opened, structurally, instead of trusting each early return to remember
 * (finishDelegatedReceipt on the happy path is still the precise record; this is the backstop).
 */
const OPEN_RECEIPTS = new WeakMap<AuthContext, string[]>()
/** Installer window: receipt id -> the elevation_usage_log row opened beside it, so the backstop can close both. */
const OPEN_INSTALLER_USAGE = new WeakMap<AuthContext, Map<string, string>>()

async function insertReceipt(
  env: Env,
  auth: AuthContext,
  delegation: DelegationRow,
  action: StructuralAction,
  surface: 'mcp' | 'http',
  target: StructuralTarget,
  outcome: ReceiptOutcome,
  extra: Record<string, unknown>,
): Promise<string> {
  const receiptId = crypto.randomUUID()
  const scopeType = target.squadId ? 'squad' : target.departmentId ? 'department' : target.projectId ? 'project' : null
  const scopeId = target.squadId ?? target.departmentId ?? target.projectId ?? null
  await env.DB.prepare(
    `INSERT INTO operator_delegation_receipts
       (id, tenant, delegation_id, agent_id, delegator_member_id, action, surface,
        target_scope_type, target_scope_id, detail, outcome)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      receiptId,
      env.TENANT_SLUG,
      delegation.id,
      auth.boundAgentId as string, // a bound-agent caller is the only path into this function
      delegation.delegator_member_id,
      action,
      surface,
      scopeType,
      scopeId,
      JSON.stringify({
        agent_member_id: auth.memberId ?? null,
        target_agent_id: target.agentId ?? null,
        target_member_id: target.memberId ?? null,
        from_squad_id: target.fromSquadId ?? null,
        capability: target.capability ?? null,
        ...(target.detail ?? {}),
        ...extra,
      }),
      outcome,
    )
    .run()
  if (outcome === 'attempted') {
    const open = OPEN_RECEIPTS.get(auth)
    if (open) open.push(receiptId)
    else OPEN_RECEIPTS.set(auth, [receiptId])
  }
  return receiptId
}

/**
 * Close a delegated act's receipt: 'applied' when the write landed, 'refused' when a later check inside the site refused
 * it (or the write was a no-op: nothing changed, so nothing was "applied"). A site calls this once, right after the
 * write result is known. One-way by trigger, only from 'attempted'.
 */
export async function finishDelegatedReceipt(env: Env, verdict: StructuralVerdict, applied: boolean): Promise<void> {
  if (verdict.kind !== 'delegated') return
  await env.DB.prepare(
    "UPDATE operator_delegation_receipts SET outcome = ?1 WHERE id = ?2 AND outcome = 'attempted'",
  )
    .bind(applied ? 'applied' : 'refused', verdict.receiptId)
    .run()
  if (verdict.installerUsageId) {
    await finishElevationReceipt(env, verdict.installerUsageId, applied ? { status: 'applied' } : { status: 'failed', errorCode: 'not_applied' })
  }
}

/**
 * The structural backstop: close every receipt this request opened and left at 'attempted'. Called by the MCP dispatcher
 * after a tool returns and by the HTTP apps after a route returns, with the HTTP status / ToolOutcome status. A KNOWN
 * outcome closes the receipt (2xx -> applied, 4xx -> refused); a 5xx or a throw is left 'attempted' on purpose, because
 * there the write may or may not have landed and "authorised, outcome unknown" is the honest record. A site that already
 * closed its receipt precisely is untouched (the UPDATE only moves a row that is still 'attempted').
 */
export async function settleOpenDelegatedReceipts(env: Env, auth: AuthContext | undefined, status: number): Promise<void> {
  if (!auth) return
  const open = OPEN_RECEIPTS.get(auth)
  if (!open || open.length === 0) return
  OPEN_RECEIPTS.delete(auth)
  const usage = OPEN_INSTALLER_USAGE.get(auth)
  OPEN_INSTALLER_USAGE.delete(auth)
  if (status >= 500) return
  const outcome: ReceiptOutcome = status < 400 ? 'applied' : 'refused'
  for (const id of open) {
    await env.DB.prepare("UPDATE operator_delegation_receipts SET outcome = ?1 WHERE id = ?2 AND outcome = 'attempted'")
      .bind(outcome, id)
      .run()
    const usageId = usage?.get(id)
    if (usageId) {
      await finishElevationReceipt(env, usageId, outcome === 'applied' ? { status: 'applied' } : { status: 'failed', errorCode: 'refused_after_authorization' })
    }
  }
}

/**
 * A delegated verdict authorised ONE resolved target. A site that resolves the references again after the gate (the agent
 * by slug, the squad by slug, the agent's current squad) must prove it resolved the same things, or refuse: otherwise a
 * reference that moves between the gate and the write is a write the gate never saw (TOCTOU, gate P2 on move_agent_squad).
 * Returns null when the act may proceed.
 */
export function delegatedTargetDrift(
  verdict: StructuralVerdict,
  resolved: { agentId?: string; squadId?: string; fromSquadId?: string; projectId?: string },
): StructuralRefusal | null {
  if (verdict.kind !== 'delegated') return null
  const t = verdict.target
  for (const key of ['agentId', 'squadId', 'fromSquadId', 'projectId'] as const) {
    const now = resolved[key]
    if (now !== undefined && t[key] !== undefined && now !== t[key]) {
      return refuse(409, 'target_changed', { field: key })
    }
  }
  return null
}

type CandidateOutcome =
  | {
      ok: true
      delegation: DelegationRow
      attach: DelegationRow | null
      ceilingRank: number
      confers: Capability | null
      evidence: Record<string, unknown>
    }
  | {
      ok: false
      delegation: DelegationRow
      attach: DelegationRow | null
      refusal: StructuralRefusal
      confers: Capability | null
    }

async function evaluateCandidate(
  env: Env,
  auth: AuthContext,
  action: StructuralAction,
  target: StructuralTarget,
  d: DelegationRow,
  attachedSquad: SquadFacts | null,
  delegations: DelegationRow[],
  isLive: (x: DelegationRow) => Promise<boolean>,
  standing: number | null,
): Promise<CandidateOutcome> {
  // project_squad_set under delegation: the ATTACHED squad must itself be covered by a NON-project delegation scope
  // (org, department or squad) whose delegator is still live. A project delegation alone can never link a squad and then
  // act there. Among several such delegations the one with the highest max_grant is used.
  let attach: DelegationRow | null = null
  let ceilingMaxGrant = d.max_grant
  if (action === 'project_squad_set' && attachedSquad) {
    for (const x of delegations) {
      if (x.scope_type === 'project') continue
      if (!(await delegationCovers(env, x, { type: 'squad', squad: attachedSquad }))) continue
      if (!(await isLive(x))) continue
      if (!attach || capabilityRank(x.max_grant) > capabilityRank(attach.max_grant)) attach = x
    }
    if (!attach) {
      return {
        ok: false, delegation: d, attach: null, confers: null,
        refusal: refuse(403, 'outside_delegation_scope', { act: action, reason: 'attached_squad_not_covered' }),
      }
    }
    if (capabilityRank(attach.max_grant) < capabilityRank(ceilingMaxGrant)) ceilingMaxGrant = attach.max_grant
  }

  // ── the ceiling: min(max_grant, delegator's live rank, agent's own live rank) ───────────────────────────────
  let confers: Capability | null = target.capability ?? null
  if (target.projectAccessLevel) confers = LEVEL_TO_CAPABILITY[target.projectAccessLevel]
  const maxGrantRank = capabilityRank(ceilingMaxGrant)
  const evidence: Record<string, unknown> = { max_grant: ceilingMaxGrant }
  let ceilingRank = maxGrantRank
  let binding: 'above_max_grant' | 'above_delegator_rank' | 'above_agent_rank' = 'above_max_grant'
  // An act that CONFERS a rank on a squad (including create_agent, which writes a member-rank membership) is bounded by
  // the delegator's and the agent's own live standing there. A project edge is bounded by max_grant alone (a project has
  // no capability scope of its own).
  if (confers && target.squadId && !target.projectAccessLevel) {
    const delegatorRank = await currentMemberRankOnScope(env, d.delegator_member_id, 'squad', target.squadId)
    const agentRank = auth.memberId
      ? await currentMemberRankOnScope(env, auth.memberId, 'squad', target.squadId)
      : 0
    evidence.delegator_rank = delegatorRank
    evidence.agent_rank = agentRank
    if (delegatorRank < ceilingRank) {
      ceilingRank = delegatorRank
      binding = 'above_delegator_rank'
    }
    if (agentRank < ceilingRank) {
      ceilingRank = agentRank
      binding = 'above_agent_rank'
    }
  }
  evidence.ceiling_rank = ceilingRank
  if (confers && capabilityRank(confers) > ceilingRank) {
    return {
      ok: false, delegation: d, attach, confers,
      refusal: requiresHumanApproval(action, binding, d, { requested: { capability: confers }, ...evidence }),
    }
  }

  // A target whose standing ANYWHERE is above max_grant is not the agent's to touch at all.
  if (standing !== null && standing > capabilityRank(ceilingMaxGrant)) {
    return {
      ok: false, delegation: d, attach, confers,
      refusal: requiresHumanApproval(action, 'target_outranks_delegation', d, { target_standing_rank: standing, ...evidence }),
    }
  }
  return { ok: true, delegation: d, attach, ceilingRank, confers, evidence }
}

async function evaluateDelegated(
  env: Env,
  auth: AuthContext,
  action: StructuralAction,
  requested: StructuralTarget,
  delegations: DelegationRow[],
  surface: 'mcp' | 'http',
): Promise<DelegatedAuthorization | StructuralRefusal> {
  // ── acts that are refused for an agent whatever delegation exists ───────────────────────────────────────────
  let target = requested
  if (
    (target.agentId && target.agentId === auth.boundAgentId)
    || (target.memberId && auth.memberId && target.memberId === auth.memberId)
  ) {
    return refuse(403, 'cannot_act_on_self', { act: action })
  }
  if (target.memberId) {
    // The target's identity is resolved HERE, from the binding table whatever the seat member's status, so no site can
    // omit it and no suspended seat can make it vanish (gate P1: an active-only resolver returned null for a suspended
    // seat, the standing guard was skipped, and a lead-capped delegate could demote an admin-ranked agent).
    const seatAgentId = await agentIdForSeatMember(env, target.memberId)
    // A grant/revoke aimed at a human member (including the delegator) is never an agent's to make.
    if (!seatAgentId) return refuse(403, 'human_target_forbidden', { act: action })
    if (target.agentId && target.agentId !== seatAgentId) return refuse(403, 'target_identity_mismatch', { act: action })
    if (seatAgentId === auth.boundAgentId) return refuse(403, 'cannot_act_on_self', { act: action })
    target = { ...target, agentId: seatAgentId }
  }
  // Fail closed: an act that changes what an existing agent holds MUST name the agent, or its standing cannot be judged.
  if (TOUCHES_TARGET_STANDING.has(action) && !target.agentId) {
    return refuse(403, 'target_identity_required', { act: action })
  }

  // ── what the act touches ────────────────────────────────────────────────────────────────────────────────────
  const isProjectEdge = action === 'project_squad_set' || action === 'project_squad_remove'
  const elements: Element[] = []
  const squadIds: string[] = []
  let attachedSquad: SquadFacts | null = null
  if (target.departmentId) {
    const dep = await env.DB.prepare('SELECT kind FROM departments WHERE id = ?1 LIMIT 1')
      .bind(target.departmentId)
      .first<{ kind: string }>()
    if (!dep) return refuse(404, 'department_not_found')
    if (dep.kind === 'home') return refuse(403, 'home_scope_not_grantable')
    elements.push({ type: 'department', id: target.departmentId })
  }
  if (target.projectId) elements.push({ type: 'project', id: target.projectId })
  for (const id of [target.squadId, target.fromSquadId]) {
    if (!id || squadIds.includes(id)) continue
    squadIds.push(id)
  }
  for (const id of squadIds) {
    const sq = await loadSquad(env, id)
    if (!sq) return refuse(404, 'squad_not_found')
    if (sq.kind === 'home') return refuse(403, 'home_scope_not_grantable')
    if (isProjectEdge) {
      // The squad a project edge names is the thing being ATTACHED. It is not what authorises the act, but a delegation
      // must not be able to widen its own reach by attaching it (see below).
      attachedSquad = sq
      continue
    }
    elements.push({ type: 'squad', squad: sq })
  }
  if (elements.length === 0) return refuse(403, 'outside_delegation_scope', { act: action })

  // ── EVERY live delegation that covers EVERY element is a candidate; its delegator must still be admin ──────────
  const liveCache = new Map<string, boolean>()
  const isLive = async (x: DelegationRow): Promise<boolean> => {
    const hit = liveCache.get(x.id)
    if (hit !== undefined) return hit
    const live = await delegatorIsLive(env, x)
    liveCache.set(x.id, live)
    return live
  }
  const candidates: DelegationRow[] = []
  let sawCovering = false
  for (const d of delegations) {
    let all = true
    for (const el of elements) {
      if (!(await delegationCovers(env, d, el))) {
        all = false
        break
      }
    }
    if (!all) continue
    sawCovering = true
    if (await isLive(d)) candidates.push(d)
  }
  if (candidates.length === 0) {
    return sawCovering
      ? refuse(403, 'delegator_authority_lost', { act: action })
      : refuse(403, 'outside_delegation_scope', { act: action })
  }

  const standing = target.agentId && TOUCHES_TARGET_STANDING.has(action)
    ? await agentStandingGlobal(env, target.agentId)
    : null

  // Overlapping delegations (an org/member row AND a squad/lead row, say): judge the act under each and use the one that
  // PERMITS it with the highest ceiling. The oldest row no longer decides alone (gate P2).
  const outcomes: CandidateOutcome[] = []
  for (const d of candidates) {
    outcomes.push(await evaluateCandidate(env, auth, action, target, d, attachedSquad, delegations, isLive, standing))
  }
  let best: Extract<CandidateOutcome, { ok: true }> | null = null
  for (const o of outcomes) {
    if (o.ok && (!best || o.ceilingRank > best.ceilingRank)) best = o
  }
  const considered = candidates.map((c) => c.id)
  const refs = (o: CandidateOutcome): DelegationRef[] => [
    delegationRef(o.delegation, 'covering'),
    ...(o.attach ? [delegationRef(o.attach, 'attach_squad')] : []),
  ]

  // From here a delegation is known to cover the act, so every refusal leaves a 'refused' receipt (who asked, under what).
  const refusedWith = async (
    o: CandidateOutcome,
    r: StructuralRefusal,
    confersNow: Capability | null,
  ): Promise<StructuralRefusal> => {
    await insertReceipt(env, auth, o.delegation, action, surface, target, 'refused', {
      refusal: r.error,
      reason: r.detail?.reason ?? null,
      capability: confersNow,
      delegations: refs(o),
      considered_delegation_ids: considered,
    })
    return r
  }

  if (!best) {
    // Refuse under the most permissive candidate (highest max_grant, oldest on a tie): its refusal is the most informative.
    let top = outcomes[0] as Extract<CandidateOutcome, { ok: false }>
    for (const o of outcomes) {
      if (!o.ok && capabilityRank(o.delegation.max_grant) > capabilityRank(top.delegation.max_grant)) top = o
    }
    return refusedWith(top, top.refusal, top.confers)
  }

  // A squad created under delegation must not collide with ANY existing squad slug (squad slugs are only unique per
  // department, so a duplicate makes squad-by-slug resolution ambiguous for every human: a resolve DoS, gate r2).
  if (action === 'create_squad' && typeof target.slug === 'string' && target.slug.length > 0) {
    const dupe = await env.DB.prepare('SELECT 1 AS one FROM squads WHERE slug = ?1 LIMIT 1')
      .bind(target.slug.trim().toLowerCase())
      .first<{ one: number }>()
    if (dupe) return refusedWith(best, refuse(409, 'squad_slug_taken', { act: action }), best.confers)
  }

  // An agent created under delegation must not collide with ANY existing agent slug in the tenant: a duplicate makes
  // slug resolution ambiguous for every human who names it (a denial of service on resolve).
  if (action === 'create_agent' && typeof target.slug === 'string') {
    const dupe = await env.DB.prepare('SELECT 1 AS one FROM agents WHERE slug = ?1 LIMIT 1')
      .bind(target.slug)
      .first<{ one: number }>()
    if (dupe) return refusedWith(best, refuse(409, 'slug_taken', { act: action }), best.confers)
  }

  // ── authorization receipt, BEFORE the write: agent + delegator + delegation id(s), outcome 'attempted' ──────────
  const receiptId = await insertReceipt(env, auth, best.delegation, action, surface, target, 'attempted', {
    ceiling_rank: best.ceilingRank,
    capability: best.confers,
    delegations: refs(best),
    considered_delegation_ids: considered,
  })
  return {
    kind: 'delegated',
    delegation: best.delegation,
    attachDelegation: best.attach ?? undefined,
    ceilingRank: best.ceilingRank,
    receiptId,
    target,
  }
}

function clampDelegationsForAttached(auth: AuthContext, all: DelegationRow[]): DelegationRow[] {
  const att = attachedAuthority(auth)
  if (!att) return all
  const cap = ceilingCapability(att.ceiling)
  return all
    .filter((d) => d.delegator_member_id === att.humanMemberId)
    .map((d) => (cap !== null && capabilityRank(d.max_grant) > capabilityRank(cap) ? { ...d, max_grant: cap as DelegationRow['max_grant'] } : d)) // as: cap is 'member' | 'lead', both valid max_grant values
}

/**
 * The ONE answer to: "may this caller use STANDING authority for this act, or must it hold a grant matching the target?"
 * (mupot#1906.)
 *
 * authorizeStructuralWrite returns `agent_legacy` when the agent holds ANY live grant for the act's elevation action: it
 * cannot see the target. A handler that then checks the agent's standing capability FIRST turns a grant on unrelated scope Y
 * into permission to act on every scope X the agent already administers: no usage-log row, none of the elevated-path guards.
 * So a BOUND AGENT must go through the scope-matched elevation check (hasElevatedAction) whenever the act has an elevation
 * door that the standing lane is not independently open for:
 *  - agentLane 'refuse': the standing lane is never open for an agent, so the grant is the only way in;
 *  - agentLane 'capability' on a delegable act with DELEGATED_OPERATORS on: delegation replaced the capability lane, so only
 *    a delegation or a matching grant opens it. Flag off, the pre-W0 capability lane is open on its own and stays as before.
 * Acts with agentLane 'capability' that are not delegable (project_create, create_department) keep standing authority open
 * independently of any grant, so the grant is not their door and there is nothing for it to widen.
 * Humans (no bound agent) keep the standing path. Every handler that consumes an `agent_legacy` verdict for an act with an
 * elevationAction MUST consult this; tests/elevation-standing-bypass.test.ts pins that by source scan.
 */
export function agentMustHoldMatchingGrant(env: Env, auth: AuthContext, action: StructuralAction): boolean {
  if (!auth.boundAgentId) return false
  const policy = STRUCTURAL_ACTIONS[action]
  if (!policy.elevationAction) return false
  return policy.agentLane === 'refuse' || (policy.delegable && delegatedOperatorsEnabled(env))
}

/**
 * THE chokepoint. Call it from every structural write on MCP and HTTP, as the FIRST statement that reads `auth`.
 * `target` may be a thunk: it is invoked only when a live delegation could apply, so an agent with no delegation is
 * refused before any caller-supplied reference is resolved (no existence oracle).
 */
export async function authorizeStructuralWrite(
  env: Env,
  auth: AuthContext,
  action: StructuralAction,
  target: StructuralTarget | StructuralTargetThunk,
  options: StructuralOptions = {},
): Promise<StructuralVerdict> {
  if (!auth.boundAgentId) return { kind: 'principal' }
  const policy = STRUCTURAL_ACTIONS[action]
  const surface = options.surface ?? 'mcp'

  const flagOn = delegatedOperatorsEnabled(env)
  // Installer window (design S1): rows synthesized from LIVE install grants join the standing delegations and are judged by the
  // same evaluateDelegated. Flag off => installerOn is false, nothing below runs, and the flow is the pre-PR-C flow exactly.
  const installerOn = installerWindowEnabled(env)
  const installer = installerOn && policy.delegable
    ? await installerDelegationsFor(env, auth, action)
    : { rows: [] as DelegationRow[], windows: [] as LiveInstallerWindow[], capped: [] as LiveInstallerWindow[] }
  let sawDelegation = false
  if ((flagOn || installerOn) && policy.delegable) {
    // W2: a thread ATTACHED to this agent acts for the attaching human only. Another human's delegation to the same agent
    // is the agent's authority, not the thread's, and every delegation is clamped to the admission ceiling.
    const standing = flagOn ? await listLiveDelegationsForAgent(env, auth.boundAgentId) : []
    const delegations = clampDelegationsForAttached(auth, [...standing, ...installer.rows])
    sawDelegation = delegations.length > 0
    if (sawDelegation) {
      // Only the delegated path is tenant-fenced here: the legacy lanes keep their own (pre-W0) behaviour exactly.
      if (auth.tenant !== env.TENANT_SLUG) return refuse(403, 'forbidden', { reason: 'tenant_scope' })
      const resolved = typeof target === 'function' ? await target() : target
      if (isRefusal(resolved)) return resolved
      const verdict = await evaluateDelegated(env, auth, action, resolved, delegations, surface)
      if (verdict.kind === 'delegated') {
        const w = installerWindowOf(installer.windows, verdict)
        if (w) {
          // Window-only fences the delegation engine does not know (the standing-grant cap and the per-window write cap). The receipt is already written: close it refused.
          const fenced = installerFence(action, verdict)
          if (fenced) {
            await finishDelegatedReceipt(env, verdict, false)
            return refusedUnderWindow(env, auth, action, installer.windows, fenced)
          }
        }
        return withInstallerUsage(env, auth, action, installer.windows, verdict)
      }
      // A refusal that is about the CEILING or a hard rule must not silently fall to a lane that was not asked for.
      if (verdict.error !== 'outside_delegation_scope') return refusedUnderWindow(env, auth, action, installer.windows, verdict)
      // Outside every delegation: only a live elevation lane may still apply.
      if (policy.elevationAction && (await boundAgentHasAnyLiveGrantForAction(env, auth, policy.elevationAction))) {
        return { kind: 'agent_legacy' }
      }
      return refusedUnderWindow(env, auth, action, installer.windows, verdict)
    }
  }

  // Project edges never ride a window (INSTALLER_EXCLUDED_ACTS): while one is live, say so instead of falling to the legacy lane.
  // Every covering window is at its write cap and nothing else covers the act: say so (instead of the generic lane/refusal).
  if (installer.rows.length === 0 && installer.capped.length > 0 && !sawDelegation) {
    return refusedUnderWindow(env, auth, action, installer.capped, capReachedRefusal(action, installer.capped[0]))
  }
  const liveForExcluded = installerOn && INSTALLER_EXCLUDED_ACTS.has(action) ? await liveInstallerWindows(env, auth) : []
  if (liveForExcluded.length > 0) {
    await logRefusedUsage(env, auth, action, liveForExcluded[0], 'not_in_installer_window')
    return refuse(403, 'not_in_installer_window', {
      act: action,
      who_acts: 'owner',
      next_step: 'Project edges are never part of an installer window: the edge outlives the window. Your human makes this edge directly.',
      needs: 'human_approval',
    })
  }
  if (policy.elevationAction && (await boundAgentHasAnyLiveGrantForAction(env, auth, policy.elevationAction))) {
    return { kind: 'agent_legacy' }
  }
  if (policy.agentLane === 'capability' && !(flagOn && policy.delegable)) {
    return { kind: 'agent_legacy' }
  }
  if (installerOn) return refuseWithoutWindow(env, auth, action)
  return refuse(403, 'operator_principal_required')
}

// ── installer window: usage log + refusal wording (flag on only; none of this is reached with the flag off) ──────────

/** The window whose synthesized row covered (or attached for) this verdict, if any. */
function installerWindowOf(windows: LiveInstallerWindow[], verdict: DelegatedAuthorization): LiveInstallerWindow | undefined {
  const ids = [verdict.delegation.id, verdict.attachDelegation?.id].filter((x): x is string => typeof x === 'string' && isInstallerDelegationId(x))
  return windows.find((w) => ids.includes(`elev:${w.grant.id}`))
}

/**
 * Fences that only an installer window needs and the delegation engine does not know: standing grants above MEMBER
 * (INSTALLER_STANDING_GRANT_CAP), whatever the tier ceiling. The per-window write cap is enforced atomically at reservation
 * (reserveInstallerWrite) and by dropping capped windows from candidate selection (installerDelegationsFor). Returns a refusal or null.
 */
function installerFence(
  action: StructuralAction,
  verdict: DelegatedAuthorization,
): StructuralRefusal | null {
  const t = verdict.target
  const confers: Capability | null = t.capability ?? null
  if (confers && capabilityRank(confers) > capabilityRank(INSTALLER_STANDING_GRANT_CAP)) {
    return refuse(403, 'requires_human_approval', {
      requires_human_approval: true, act: action, reason: 'installer_standing_grant_cap_member', who_acts: 'owner', needs: 'human_approval',
      next_step: 'Standing grants made inside an installer window are capped at member. Ask your human to grant anything higher directly.',
    })
  }
  return null
}

/** One elevation_usage_log row per authorised act, reserved ATOMICALLY (cap-checked in the insert) BEFORE the write and closed with the chokepoint receipt. */
async function withInstallerUsage(
  env: Env,
  auth: AuthContext,
  action: StructuralAction,
  windows: LiveInstallerWindow[],
  verdict: DelegatedAuthorization,
): Promise<DelegatedAuthorization | StructuralRefusal> {
  if (!isInstallerDelegationId(verdict.delegation.id)) return verdict
  const w = windows.find((x) => `elev:${x.grant.id}` === verdict.delegation.id)
  if (!w) return verdict
  // "If the log write fails, the action must fail": the insert throws, the dispatcher leaves the chokepoint receipt at 'attempted'
  // (authorised, outcome unknown), and no write has happened yet.
  const usageId = await reserveInstallerWrite(env, auth.tenant, w, action, {
    receipt_id: verdict.receiptId, act: action, tier: w.tier, target_agent_id: verdict.target.agentId ?? null, target_squad_id: verdict.target.squadId ?? null, capability: verdict.target.capability ?? null,
  })
  if (usageId === null) {
    // Lost the race for the last slot (or the window filled between selection and reservation): close the receipt refused.
    await finishDelegatedReceipt(env, verdict, false)
    return refusedUnderWindow(env, auth, action, [w], capReachedRefusal(action, w))
  }
  const open = OPEN_INSTALLER_USAGE.get(auth)
  if (open) open.set(verdict.receiptId, usageId)
  else OPEN_INSTALLER_USAGE.set(auth, new Map([[verdict.receiptId, usageId]]))
  return { ...verdict, installerUsageId: usageId }
}

function capReachedRefusal(action: StructuralAction, w: LiveInstallerWindow): StructuralRefusal {
  const def = INSTALLER_TIERS[w.tier]
  return refuse(403, 'installer_window_cap_reached', {
    act: action, cap: def.writeCap, who_acts: 'owner', next_tool: 'request_elevation', needs: 'human_approval',
    next_step: `This installer window reached its ${def.writeCap}-write cap. Ask your human for a new window if you still need one: request_elevation { actions: ["${def.action}"], scope_type, duration_minutes: 60, reason }.`,
  })
}

/** One failed usage row for an attempt under a live window, capped so the log cannot be flooded (the refusal is still returned). */
async function logRefusedUsage(env: Env, auth: AuthContext, action: StructuralAction, w: LiveInstallerWindow, errorCode: string): Promise<void> {
  if ((await windowUsageCount(env, auth.tenant, w.grant, true)) >= INSTALLER_REFUSED_LOG_CAP) return
  const usageId = await beginElevationReceipt(
    env,
    auth.tenant,
    { id: w.grant.id, agent_session_id: w.agentSessionId, action: w.grant.action },
    action,
    { act: action, tier: w.tier, refusal: errorCode },
  )
  await finishElevationReceipt(env, usageId, { status: 'failed', errorCode })
}

const ASK_HIGH = 'This act needs the high window (grants up to lead). Ask your human for it: request_elevation { actions: ["action:install_high"], scope_type, duration_minutes: 60, reason }. They approve with a passkey. Nothing is lost.'
const ASK_STANDARD = 'Ask your human for an installer window: request_elevation { actions: ["action:install_standard"], scope_type, duration_minutes: 60, reason }. They get a button in Telegram. Nothing is lost.'

/** A refusal under a live window is logged as a failed usage row (who tried what), and told the tier that would cover it. */
async function refusedUnderWindow(
  env: Env,
  auth: AuthContext,
  action: StructuralAction,
  windows: LiveInstallerWindow[],
  refusal: StructuralRefusal,
): Promise<StructuralRefusal> {
  // Attribute the refusal to the window the engine actually evaluated (named by the refusal's delegation_id), else the widest.
  const named = typeof refusal.detail?.delegation_id === 'string' ? windows.find((x) => `elev:${x.grant.id}` === refusal.detail?.delegation_id) : undefined
  const w = named ?? windows[0]
  if (!w) return refusal
  await logRefusedUsage(env, auth, action, w, refusal.error)
  const detail: Record<string, unknown> = { ...(refusal.detail ?? {}), installer_window: w.tier }
  if (refusal.error === 'requires_human_approval' && w.tier === 'standard' && detail.next_step === undefined) {
    detail.who_acts = 'owner'
    detail.next_step = ASK_HIGH
    detail.next_tool = 'request_elevation'
    detail.needs = 'human_approval'
  } else if (refusal.error === 'outside_delegation_scope' && detail.next_step === undefined) {
    detail.who_acts = 'owner'
    detail.next_step = 'This act is outside the scope your installer window covers. Ask your human for a window whose scope_type/scope_id covers it: request_elevation { actions: ["action:install_' + w.tier + '"], scope_type, scope_id, duration_minutes: 60, reason }.'
    detail.next_tool = 'request_elevation'
    detail.needs = 'human_approval'
  }
  return { ...refusal, detail }
}

/** No live window: the pre-PR-C refusal, taught. An ended window is named (`installer_window_expired`); credentials never ride a window. */
async function refuseWithoutWindow(env: Env, auth: AuthContext, action: StructuralAction): Promise<StructuralRefusal> {
  const base = refuse(403, 'operator_principal_required')
  const live = await liveInstallerWindows(env, auth)
  if (live.length > 0) {
    // A window is live but this act is not in its tier. Credential mint is the named exclusion.
    if (CREDENTIAL_ACTIONS.has(action)) {
      await logRefusedUsage(env, auth, action, live[0], 'not_in_installer_window')
      return refuse(403, 'not_in_installer_window', {
        act: action,
        who_acts: 'owner',
        next_step: 'Credentials are never part of an installer window. Ask for action:mint_token separately: request_elevation { actions: ["action:mint_token"], scope_type, scope_id, duration_minutes: 15, reason }.',
        next_tool: 'request_elevation',
        needs: 'human_approval',
      })
    }
    // The act exists only in the high tier and the caller holds only a standard window.
    if (installerTierNeededFor(action) === 'high' && !live.some((w) => w.tier === 'high')) {
      await logRefusedUsage(env, auth, action, live[0], 'act_needs_high_window')
      return refuse(403, 'requires_human_approval', {
        requires_human_approval: true,
        act: action,
        reason: 'act_needs_high_window',
        who_acts: 'owner',
        next_step: ASK_HIGH,
        next_tool: 'request_elevation',
        needs: 'human_approval',
      })
    }
    return base
  }
  if (installerTierNeededFor(action) === null) return base
  const ended = await lastEndedInstallerWindow(env, auth)
  if (ended) {
    return refuse(403, 'installer_window_expired', {
      act: action,
      ended_at: ended,
      who_acts: 'owner',
      next_step: `Your installer window ended at ${ended}. Ask again if you still need it; the work done under it is receipted. ${ASK_STANDARD}`,
      next_tool: 'request_elevation',
      needs: 'human_approval',
    })
  }
  return refuse(403, 'operator_principal_required', {
    act: action,
    who_acts: 'owner',
    next_step: ASK_STANDARD,
    next_tool: 'request_elevation',
    needs: 'human_approval',
  })
}

/** Credential acts: never in a tier. A refusal for one under a live window names the exclusion instead of the generic code. */
const CREDENTIAL_ACTIONS: ReadonlySet<StructuralAction> = new Set<StructuralAction>([
  'mint_agent_token', 'mint_member_token', 'register_agent_key',
])

/** When this session's most recent install grant ended (expired or revoked), or null. Presentation only: never grants anything. */
async function lastEndedInstallerWindow(env: Env, auth: AuthContext): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT g.expires_at AS expires_at, g.revoked_at AS revoked_at
       FROM elevation_grants g
       JOIN agent_sessions s ON s.id = g.agent_session_id
      WHERE g.tenant = ?1 AND s.agent_id = ?2 AND g.action IN ('action:install_standard', 'action:install_high')
      ORDER BY g.created_at DESC LIMIT 1`,
  )
    .bind(auth.tenant, auth.boundAgentId)
    .first<{ expires_at: string; revoked_at: string | null }>()
  if (!row) return null
  if (row.revoked_at) return row.revoked_at
  return Date.parse(row.expires_at) <= Date.now() ? row.expires_at : null // a still-unexpired, unrevoked grant that is not live lost its approver or session: not an 'ended' window
}

/** HTTP shape of a refusal: the error code plus any detail keys, flat (the existing route convention). */
export function structuralRefusalBody(r: StructuralRefusal): Record<string, unknown> {
  return { error: r.error, ...(r.detail ?? {}) }
}
