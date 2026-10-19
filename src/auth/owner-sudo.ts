// mupot — OWNER SUDO ("/muapprove = sudo"; SENSITIVE).
//
// Four owner-only tools refuse every agent (`operator_principal_required`): squad_member_add, the update_squad dyad pin,
// grant_gate_capability and the seat-event grant. This module is the ONE way an agent gets one call of one of them, and only
// with a LIVE, human-approved elevation whose action names exactly that tool and covers exactly that scope:
//
//   action:sudo_squad_member_add      squad_member_add
//   action:sudo_squad_dyad_pin        update_squad, only when the call is a dyad pin and changes nothing else
//   action:sudo_grant_gate_capability grant_gate_capability
//   action:sudo_seat_event_grant      seat_event_grant
//
// WHAT HAPPENS. invokeTool asks resolveOwnerSudo before the capability floor. When it says `sudo`, the tool body runs with an
// AuthContext built LIVE for the APPROVING human (buildAuth), so every check the tool already makes (org owner/admin, rank
// ceilings, home-squad refusals, archived squads) is answered by the human's real standing right now, not by anything the agent
// holds. `auth.ownerSudo` names the agent as executor; the human is the authority. Nothing here widens a tool: it only changes
// WHO the tool sees, and only when every condition below holds on this call.
//
// EVERY CONDITION (re-derived per call, nothing cached; each has a test that breaks it):
//   1. the caller is a bound agent that is NOT an attached chat (attached chats may use only ATTACHED_SUDO_ACTIONS);
//   2. the call's arguments parse to exactly the act the action names (a dyad pin is ONLY a dyad pin) and to a scope;
//   3. hasElevatedAction, literal action: the agent's own live session, a live unexpired unrevoked grant covering THIS scope,
//      the approver's CURRENT admin authority (incl. the owner's legacy role plane) and the approver's session still live;
//   4. the approver is still an active human member;
//   5. act fences: no conferring lead/admin, never to the requesting agent itself, never gate authority to itself;
//   6. SINGLE USE: a guarded insert claims the grant (one 'pending' or 'applied' usage row per grant); a second call, a
//      concurrent call, and a call after success all lose. A call that fails (the tool refused) frees the claim.
// Expiry and /murevoke end a grant on the very next call because condition 3 reads it live.
import type { AuthContext, CapabilityScopeType, Env } from '../types'
import { buildAuth, memberIsActiveHuman } from '../access/identity'
import { CAPABILITY_LIVE_PREDICATE, capabilityRank, hasCapability, loadSquadScope, nowCapabilitySql, resolveCapabilities } from './capability'
import {
  boundAgentHasAnyLiveGrantForAction,
  elevationRemedyMessage,
  hasElevatedAction,
  revokeElevationGrant,
  type ElevationGrantRecord,
  type HasElevatedActionOptions,
} from './elevation'
import { finishElevationReceipt } from './elevation-receipt'
import { attachedAuthority } from './attached-ceiling'
import { parseGateGrantArgs } from '../gates/grants'
import { resolveAgentRef, resolveSquadRef } from '../org/resolve'

export type OwnerSudoTool = 'squad_member_add' | 'update_squad' | 'grant_gate_capability' | 'seat_event_grant'

/** tool -> the ONE action that opens it. The ratchet test pins this map against OWNER_SUDO_ACTIONS in both directions. */
export const OWNER_SUDO_ACTION_FOR_TOOL: Readonly<Record<OwnerSudoTool, string>> = Object.freeze({
  squad_member_add: 'action:sudo_squad_member_add',
  update_squad: 'action:sudo_squad_dyad_pin',
  grant_gate_capability: 'action:sudo_grant_gate_capability',
  seat_event_grant: 'action:sudo_seat_event_grant',
})

export function isOwnerSudoTool(name: string): name is OwnerSudoTool {
  return Object.prototype.hasOwnProperty.call(OWNER_SUDO_ACTION_FOR_TOOL, name)
}

/** What a sudo call may confer through squad_member_add: the same ceiling an elevated agent has on grant_agent_capability. */
const SUDO_MEMBER_ADD_CAPABILITIES: ReadonlySet<string> = new Set(['observer', 'member'])
/** The one call that pins a squad's review pair, for an agent that cannot: shown on every dyad refusal (hint on the floor, detail in the tool). */
export const DYAD_PIN_SUDO_STEP = 'Ask your human to approve ONE call: request_elevation { actions: ["action:sudo_squad_dyad_pin"], scope_type: "squad", scope_id: <the squad id>, duration_minutes: 15, reason }. They tap Approve in Telegram. Then call update_squad with only squad, dyad_agent_a and dyad_agent_b.'
const DYAD_PIN_KEYS: ReadonlySet<string> = new Set(['squad', 'dyad_agent_a', 'dyad_agent_b', 'reason'])

export interface SudoRefusal { status: 400 | 403 | 404 | 409; error: string; detail?: unknown }

interface Plan {
  scopeType: CapabilityScopeType
  scopeId: string | null
  squadDepartmentId: string | null
  detail: Record<string, unknown>
}

function refusal(status: SudoRefusal['status'], error: string, detail?: unknown): { ok: false; refusal: SudoRefusal } {
  return { ok: false, refusal: { status, error, detail } }
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

/** Turn the call's arguments into the one act and scope it names, or refuse. Pure reads. */
async function planFor(env: Env, auth: AuthContext, tool: OwnerSudoTool, args: Record<string, unknown>): Promise<{ ok: true; plan: Plan } | { ok: false; refusal: SudoRefusal }> {
  if (tool === 'squad_member_add') {
    const aRef = text(args.agent)
    const sRef = text(args.squad)
    const cap = text(args.capability)
    if (!aRef || !sRef || !cap) return refusal(400, 'invalid_args', 'agent, squad and capability required')
    if (!SUDO_MEMBER_ADD_CAPABILITIES.has(cap)) {
      return refusal(403, 'sudo_capability_ceiling', { remedy: "an owner-sudo squad_member_add may confer observer or member; a standing lead/admin is granted by standing authority" })
    }
    const a = await resolveAgentRef(env, aRef)
    const sq = await resolveSquadRef(env, sRef)
    if (!a.ok || !sq.ok) return refusal(404, !a.ok ? 'agent_not_found' : 'squad_not_found')
    if (auth.boundAgentId && a.value.id === auth.boundAgentId) {
      return refusal(403, 'cannot_grant_to_self', 'a sudo call may not add the requesting agent to a squad')
    }
    // ADD, never demote: the call may raise a standing it cannot restore from the agent's side, but never lower one (both planes,
    // same rule an elevated agent has on grant_agent_capability: the higher of memberships and live capabilities counts).
    const [heldCap, heldMembership] = await Promise.all([
      env.DB.prepare(
        `SELECT c.capability AS capability FROM capabilities c
           JOIN agent_member_bindings b ON b.member_id = c.member_id AND b.tenant = ?4
          WHERE b.agent_id = ?1 AND c.scope_type = 'squad' AND c.scope_id = ?2 AND ${CAPABILITY_LIVE_PREDICATE('c', '?3')} LIMIT 1`,
      ).bind(a.value.id, sq.value.id, nowCapabilitySql(), env.TENANT_SLUG).first<{ capability: Parameters<typeof capabilityRank>[0] }>(),
      env.DB.prepare(`SELECT m.capability AS capability FROM memberships m WHERE m.agent_id = ?1 AND m.squad_id = ?2 AND ${CAPABILITY_LIVE_PREDICATE('m', '?3')} LIMIT 1`).bind(a.value.id, sq.value.id, nowCapabilitySql()).first<{ capability: Parameters<typeof capabilityRank>[0] }>(),
    ])
    const held = Math.max(heldCap ? capabilityRank(heldCap.capability) : -1, heldMembership ? capabilityRank(heldMembership.capability) : -1)
    if (held > capabilityRank(cap as Parameters<typeof capabilityRank>[0])) { // cap is observer|member here (checked above)
      return refusal(403, 'sudo_cannot_demote', { remedy: 'an owner-sudo squad_member_add adds; it never lowers a standing the agent already holds on that squad' })
    }
    return { ok: true, plan: { scopeType: 'squad', scopeId: sq.value.id, squadDepartmentId: sq.value.department_id, detail: { agent_id: a.value.id, squad_id: sq.value.id, capability: cap } } }
  }
  if (tool === 'update_squad') {
    const sRef = text(args.squad)
    if (!sRef) return refusal(400, 'invalid_args', 'squad required')
    const extra = Object.keys(args).filter((k) => !DYAD_PIN_KEYS.has(k))
    if (extra.length > 0 || !('dyad_agent_a' in args) || !('dyad_agent_b' in args)) {
      return refusal(403, 'sudo_covers_dyad_pin_only', { remedy: 'this approval covers ONE update_squad call that sets or clears the dyad pair and changes nothing else (squad, dyad_agent_a, dyad_agent_b, reason only)' })
    }
    const sq = await resolveSquadRef(env, sRef)
    if (!sq.ok) return refusal(404, 'squad_not_found')
    return { ok: true, plan: { scopeType: 'squad', scopeId: sq.value.id, squadDepartmentId: sq.value.department_id, detail: { squad_id: sq.value.id, dyad_a: args.dyad_agent_a === null ? null : 'set', dyad_b: args.dyad_agent_b === null ? null : 'set' } } }
  }
  if (tool === 'grant_gate_capability') {
    const parsed = parseGateGrantArgs(args)
    if (!parsed.ok) return refusal(400, parsed.error)
    // Gate authority is never an agent's to hand itself: not to its own agent row, not to its own welded member.
    if (parsed.principalType === 'agent' && parsed.principalId === auth.boundAgentId) return refusal(403, 'cannot_grant_to_self', 'a sudo call may not give gate authority to the requesting agent')
    if (parsed.principalType === 'member' && (parsed.principalId === auth.memberId || parsed.principalId === auth.userId)) return refusal(403, 'cannot_grant_to_self', 'a sudo call may not give gate authority to the requesting agent\'s own member')
    return { ok: true, plan: { scopeType: 'org', scopeId: null, squadDepartmentId: null, detail: { capability: parsed.capability, principal_type: parsed.principalType, principal_id: parsed.principalId } } }
  }
  // seat_event_grant: the scope is the squad of the agent the host would receive hints for.
  const target = text(args.agent_id)
  if (!target) return refusal(400, 'invalid_args', 'agent_id required')
  const row = await env.DB.prepare('SELECT squad_id FROM agents WHERE id = ?1 LIMIT 1').bind(target).first<{ squad_id: string }>()
  const squad = row ? await loadSquadScope(env, row.squad_id) : null
  if (!row || !squad) return refusal(404, 'agent_not_visible')
  return { ok: true, plan: { scopeType: 'squad', scopeId: row.squad_id, squadDepartmentId: squad.department_id, detail: { agent_id: target, host_agent_id: text(args.host_agent_id) } } }
}

/** The grant check with a LITERAL action at each site (tests/elevation-actions-enforced.test.ts scans for exactly that). */
function checkGrant(env: Env, auth: AuthContext, tool: OwnerSudoTool, plan: Plan, nowMs: number): ReturnType<typeof hasElevatedAction> {
  // approverRolePlane: the owner's authority may live on the legacy role plane (no capability rows); recordUsage false: the
  // single-use claim below is the usage row, and an extra 'applied' row would count as a use.
  const opts: HasElevatedActionOptions = { nowMs, approverRolePlane: true, recordUsage: false, toolName: tool, detail: plan.detail, squadDepartmentId: plan.squadDepartmentId }
  if (tool === 'squad_member_add') return hasElevatedAction(env, auth, 'action:sudo_squad_member_add', plan.scopeType, plan.scopeId, opts)
  if (tool === 'update_squad') return hasElevatedAction(env, auth, 'action:sudo_squad_dyad_pin', plan.scopeType, plan.scopeId, opts)
  if (tool === 'grant_gate_capability') return hasElevatedAction(env, auth, 'action:sudo_grant_gate_capability', plan.scopeType, plan.scopeId, opts)
  return hasElevatedAction(env, auth, 'action:sudo_seat_event_grant', plan.scopeType, plan.scopeId, opts)
}

export interface OwnerSudoClaim {
  grant: ElevationGrantRecord
  usageId: string
  authorityMemberId: string
  executorAgentId: string
  tool: OwnerSudoTool
}

/** Everything resolveOwnerSudo proved, not yet spent. Spending it (claimOwnerSudo) is a separate step so a refusal that comes
 *  after resolution (capability floor, schema validation) can never use up the approval. */
export interface OwnerSudoPending {
  grant: ElevationGrantRecord
  tool: OwnerSudoTool
  executorAgentId: string
  tenant: string
  detail: Record<string, unknown>
}

export type OwnerSudoVerdict =
  | { kind: 'none' }
  | { kind: 'refused'; refusal: SudoRefusal }
  | { kind: 'sudo'; memberAuth: AuthContext; pending: OwnerSudoPending }

/**
 * Decide whether THIS call runs as the approving human. `none` = this is not a sudo situation (not an agent, not a sudo tool,
 * an attached chat, or the agent holds no live grant for the tool's action): the caller proceeds exactly as before this module
 * existed, and the tool's own refusal stands. `refused` = the agent holds a grant for the action but this call is not covered.
 * Writes nothing.
 */
export async function resolveOwnerSudo(env: Env, auth: AuthContext, toolName: string, args: Record<string, unknown>, nowMs: number = Date.now()): Promise<OwnerSudoVerdict> {
  if (!auth.boundAgentId || !isOwnerSudoTool(toolName)) return { kind: 'none' }
  if (attachedAuthority(auth)) return { kind: 'none' }
  const tool: OwnerSudoTool = toolName
  const action = OWNER_SUDO_ACTION_FOR_TOOL[tool]
  // A cheap existence probe, so an agent with no sudo grant for this tool sees byte-for-byte the refusal it always saw.
  if (!(await boundAgentHasAnyLiveGrantForAction(env, auth, action, nowMs))) return { kind: 'none' }

  const planned = await planFor(env, auth, tool, args)
  if (!planned.ok) return { kind: 'refused', refusal: planned.refusal }
  const checked = await checkGrant(env, auth, tool, planned.plan, nowMs)
  if (!checked.granted) {
    return { kind: 'refused', refusal: { status: 403, error: 'forbidden', detail: { sudo_denied: checked.reason, remedy: elevationRemedyMessage(checked.reason), action } } }
  }
  const grant = checked.grant
  if (!(await memberIsActiveHuman(env, grant.approved_by_member_id))) {
    return { kind: 'refused', refusal: { status: 403, error: 'forbidden', detail: { sudo_denied: 'approver_authority_lost', remedy: elevationRemedyMessage('approver_authority_lost'), action } } }
  }
  const memberAuth = await buildAuth(env, grant.approved_by_member_id)
  // The same two planes this human's own session carries. buildAuth leaves `capabilities` UNDEFINED for a legacy owner/admin role
  // (the dashboard cookie rule: assigning rows to a role-only owner DOWNGRADES them, hasWorkspaceAdmin then reads rows only). The
  // tools here also read the rows (memberCanOnSquad), so an owner who ALSO holds an org admin/owner row carries them; an owner
  // without one stays role-plane only, never downgraded to [].
  if (memberAuth.capabilities === undefined) {
    const rows = await resolveCapabilities(env, grant.approved_by_member_id)
    if (hasCapability(rows, 'org', null, 'admin')) memberAuth.capabilities = rows
  }
  memberAuth.ownerSudo = {
    executorAgentId: auth.boundAgentId,
    executorMemberId: auth.memberId ?? null,
    grantId: grant.id,
    elevationRequestId: grant.elevation_request_id,
    action,
    tool,
  }
  return { kind: 'sudo', memberAuth, pending: { grant, tool, executorAgentId: auth.boundAgentId, tenant: auth.tenant, detail: planned.plan.detail } }
}

export const SUDO_ALREADY_USED: SudoRefusal = {
  status: 409,
  error: 'sudo_already_used',
  detail: { remedy: 'an owner-sudo approval covers ONE call and it was used (or is being used); ask your human for a new approval with request_elevation' },
}

/**
 * SINGLE USE: spend the approval. One guarded insert is the claim; a 'pending' or 'applied' usage row for this grant means it is
 * spent (or being spent), so a second call, a concurrent call and a call after success all get null. Call it immediately before
 * the tool body runs, after every refusal that can still happen. If the insert throws, the tool must not run.
 */
export async function claimOwnerSudo(env: Env, pending: OwnerSudoPending, nowMs: number = Date.now()): Promise<OwnerSudoClaim | null> {
  const usageId = crypto.randomUUID()
  const claimed = await env.DB.prepare(
    `INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at, status)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending'
      WHERE NOT EXISTS (SELECT 1 FROM elevation_usage_log WHERE elevation_grant_id = ?3 AND status IN ('pending', 'applied') AND occurred_at >= ?9)`,
  ).bind(
    usageId, pending.tenant, pending.grant.id, pending.grant.agent_session_id, pending.grant.action, pending.tool,
    JSON.stringify({ ...pending.detail, authority_member_id: pending.grant.approved_by_member_id }), new Date(nowMs).toISOString(),
    pending.grant.created_at, // a renewed grant keeps its id: only usage since ITS approval counts
  ).run()
  if (Number(claimed.meta?.changes ?? 0) !== 1) return null
  return { grant: pending.grant, usageId, authorityMemberId: pending.grant.approved_by_member_id, executorAgentId: pending.executorAgentId, tool: pending.tool }
}

/** Close the claim and write the audit receipt (agent = executor, human = authority). A refused tool frees the claim. Never throws. */
export async function finishOwnerSudo(env: Env, claim: OwnerSudoClaim, outcome: { ok: true } | { ok: false; status: number; error: string }): Promise<void> {
  await finishElevationReceipt(env, claim.usageId, outcome.ok ? { status: 'applied' } : { status: 'failed', errorCode: outcome.error.slice(0, 120) }).catch(() => undefined)
  // Spent: the approval ends now, visibly (revoked, not merely un-claimable), and a fresh approval for the same act can be written.
  if (outcome.ok) await revokeElevationGrant(env, env.TENANT_SLUG, claim.grant.id, 'owner_sudo_spent').catch(() => undefined)
  await env.DB.prepare(
    `INSERT INTO mutation_audit_entries (
       id, tenant, principal_kind, principal_id, member_id, agent_id, origin, handler, operation,
       target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
     VALUES (?1, ?2, 'agent', ?3, ?4, ?3, 'mcp', 'owner_sudo', ?5, 'elevation_grant', ?6, ?7, ?7, ?8, ?9)
     ON CONFLICT DO NOTHING`,
  ).bind(
    crypto.randomUUID(), env.TENANT_SLUG, claim.executorAgentId, claim.authorityMemberId, `owner_sudo:${claim.tool}`, claim.grant.id, `owner-sudo:${claim.usageId}`,
    JSON.stringify({ executor_agent_id: claim.executorAgentId, authority_member_id: claim.authorityMemberId, grant_id: claim.grant.id, elevation_request_id: claim.grant.elevation_request_id, action: claim.grant.action, tool: claim.tool, ok: outcome.ok, ...(outcome.ok ? {} : { status: outcome.status, error: outcome.error }) }),
    new Date().toISOString(),
  ).run().catch(() => undefined)
}
