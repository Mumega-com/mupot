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
//   0. OWNER_SUDO_ENABLED is on (default off: this module is then a no-op);
//   1. the caller is a bound agent that is NOT an attached chat (attached chats may use only ATTACHED_SUDO_ACTIONS);
//   2. the call's arguments canonicalise (owner-sudo-args.ts, with its fences) to EXACTLY the digest the human approved, and to a scope;
//   3. hasElevatedAction, literal action: the agent's own live session, a live unexpired unrevoked grant covering THIS scope,
//      the approver's CURRENT admin authority (incl. the owner's legacy role plane) and the approver's session still live;
//   4. the approver is still an active human member;
//   5. act fences: no conferring lead/admin, never to the requesting agent itself, never gate authority to itself;
//   6. SINGLE USE: a guarded insert claims the grant (one 'pending' or 'applied' usage row per grant); a second call, a
//      concurrent call, and a call after success all lose. A call that fails (the tool refused) frees the claim.
// Expiry and /murevoke end a grant on the very next call because condition 3 reads it live.
import type { AuthContext, CapabilityScopeType, Env } from '../types'
import { buildAuth, memberIsActiveHuman } from '../access/identity'
import { canonicalizeSudoArgs, ownerSudoEnabled, sudoRawFromToolArgs, type SudoActionKey } from './owner-sudo-args'
import { CAPABILITY_LIVE_PREDICATE, capabilityRank, hasCapability, loadSquadScope, nowCapabilitySql, resolveCapabilities } from './capability'
import {
  boundAgentHasAnyLiveGrantForAction,
  loadLiveElevationGrantsForSession,
  loadLiveSessionForBoundAgent,
  elevationRemedyMessage,
  hasElevatedAction,
  revokeElevationGrant,
  type ElevationGrantRecord,
  type HasElevatedActionOptions,
} from './elevation'
import { finishElevationReceipt } from './elevation-receipt'
import { attachedAuthority } from './attached-ceiling'

/** The one call that pins a squad's review pair, for an agent that cannot: shown on every dyad refusal (hint on the floor, detail in the tool). */
export const DYAD_PIN_SUDO_STEP = 'Ask your human to approve ONE exact call: request_elevation { actions: ["action:sudo_squad_dyad_pin"], scope_type: "squad", scope_id: <the squad id>, duration_minutes: 15, reason, sudo_args: { squad, agent_a, agent_b } }. They see those names in Telegram and tap Approve. Then call update_squad with only squad, dyad_agent_a and dyad_agent_b, exactly as approved.'

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

export interface SudoRefusal { status: 400 | 403 | 404 | 409 | 500; error: string; detail?: unknown }

interface Plan {
  scopeType: CapabilityScopeType
  scopeId: string | null
  squadDepartmentId: string | null
  /** The squad the call touches (pinned through the seat-event write). */
  squadId: string | null
  argsSha256: string
  detail: Record<string, unknown>
}

function refusal(status: SudoRefusal['status'], error: string, detail?: unknown): { ok: false; refusal: SudoRefusal } {
  return { ok: false, refusal: { status, error, detail } }
}

/**
 * Turn the call into the ONE act it is: its arguments go through the same canonicaliser (and its fences) as the request did, so
 * they can be compared to the digest the human approved (resolveOwnerSudo does that against each candidate grant). Pure reads.
 */
async function planFor(env: Env, auth: AuthContext, tool: OwnerSudoTool, args: Record<string, unknown>): Promise<{ ok: true; plan: Plan } | { ok: false; refusal: SudoRefusal }> {
  const action = OWNER_SUDO_ACTION_FOR_TOOL[tool] as SudoActionKey
  const raw = sudoRawFromToolArgs(tool, args)
  if (!raw) {
    return refusal(403, 'sudo_covers_dyad_pin_only', { remedy: 'this approval covers ONE update_squad call that sets or clears the dyad pair and changes nothing else (squad, dyad_agent_a, dyad_agent_b, reason only)' })
  }
  const canon = await canonicalizeSudoArgs(env, action, raw, { agentId: auth.boundAgentId ?? null, memberId: auth.memberId ?? null })
  if (!canon.ok) return refusal(canon.error === 'agent_not_visible' ? 404 : canon.error.endsWith('_not_found') ? 404 : canon.error === 'sudo_args_required' || canon.error === 'sudo_args_invalid' || canon.error === 'invalid_capability' || canon.error === 'invalid_principal_type' ? 400 : 403, canon.error, canon.detail)
  if (tool === 'squad_member_add') {
    // ADD, never demote: the call may raise a standing, never lower one the agent already holds (both planes: the higher of
    // memberships and live capabilities counts; same rule an elevated agent has on grant_agent_capability).
    const c = JSON.parse(canon.value.json) as { squad_id: string; agent_id: string; capability: 'observer' | 'member' }
    const [heldCap, heldMembership] = await Promise.all([
      env.DB.prepare(
        `SELECT c.capability AS capability FROM capabilities c
           JOIN agent_member_bindings b ON b.member_id = c.member_id AND b.tenant = ?4
          WHERE b.agent_id = ?1 AND c.scope_type = 'squad' AND c.scope_id = ?2 AND ${CAPABILITY_LIVE_PREDICATE('c', '?3')} LIMIT 1`,
      ).bind(c.agent_id, c.squad_id, nowCapabilitySql(), env.TENANT_SLUG).first<{ capability: Parameters<typeof capabilityRank>[0] }>(),
      env.DB.prepare(`SELECT m.capability AS capability FROM memberships m WHERE m.agent_id = ?1 AND m.squad_id = ?2 AND ${CAPABILITY_LIVE_PREDICATE('m', '?3')} LIMIT 1`)
        .bind(c.agent_id, c.squad_id, nowCapabilitySql()).first<{ capability: Parameters<typeof capabilityRank>[0] }>(),
    ])
    const held = Math.max(heldCap ? capabilityRank(heldCap.capability) : -1, heldMembership ? capabilityRank(heldMembership.capability) : -1)
    if (held > capabilityRank(c.capability)) {
      return refusal(403, 'sudo_cannot_demote', { remedy: 'an owner-sudo squad_member_add adds; it never lowers a standing the agent already holds on that squad' })
    }
  }
  let scopeType: CapabilityScopeType = 'org'
  let scopeId: string | null = null
  let squadDepartmentId: string | null = null
  if (canon.value.squadId) {
    const squad = await loadSquadScope(env, canon.value.squadId)
    if (!squad) return refusal(404, 'agent_not_visible')
    scopeType = 'squad'
    scopeId = canon.value.squadId
    squadDepartmentId = squad.department_id
  }
  return { ok: true, plan: { scopeType, scopeId, squadDepartmentId, squadId: canon.value.squadId, argsSha256: canon.value.sha256, detail: { args_sha256: canon.value.sha256, ...(canon.value.squadId ? { squad_id: canon.value.squadId } : {}) } } }
}

/** The grant check with a LITERAL action at each site (tests/elevation-actions-enforced.test.ts scans for exactly that). */
function checkGrant(env: Env, auth: AuthContext, tool: OwnerSudoTool, plan: Plan, nowMs: number, onlyGrantId: string): ReturnType<typeof hasElevatedAction> {
  // approverRolePlane: the owner's authority may live on the legacy role plane (no capability rows); recordUsage false: the
  // single-use claim below is the usage row, and an extra 'applied' row would count as a use.
  const opts: HasElevatedActionOptions = { nowMs, onlyGrantId, approverRolePlane: true, recordUsage: false, toolName: tool, detail: plan.detail, squadDepartmentId: plan.squadDepartmentId }
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
  if (!ownerSudoEnabled(env)) return { kind: 'none' } // flag off: a total no-op
  if (!auth.boundAgentId || !isOwnerSudoTool(toolName)) return { kind: 'none' }
  if (attachedAuthority(auth)) return { kind: 'none' }
  const tool: OwnerSudoTool = toolName
  const action = OWNER_SUDO_ACTION_FOR_TOOL[tool]
  // A cheap existence probe, so an agent with no sudo grant for this tool sees byte-for-byte the refusal it always saw.
  if (!(await boundAgentHasAnyLiveGrantForAction(env, auth, action, nowMs))) return { kind: 'none' }

  const planned = await planFor(env, auth, tool, args)
  if (!planned.ok) return { kind: 'refused', refusal: planned.refusal }
  // The approval is for ONE concrete call: only a live grant whose request carries exactly this call's digest can open it.
  const session = await loadLiveSessionForBoundAgent(env, auth, nowMs)
  const live = session ? await loadLiveElevationGrantsForSession(env, auth.tenant, session.id, nowMs) : []
  const candidates: ElevationGrantRecord[] = []
  for (const g of live) {
    if (g.action !== action) continue
    const r = await env.DB.prepare('SELECT sudo_args_sha256 FROM elevation_requests WHERE id = ?1 AND tenant = ?2 LIMIT 1').bind(g.elevation_request_id, auth.tenant).first<{ sudo_args_sha256: string | null }>().catch(() => null)
    if (r?.sudo_args_sha256 && r.sudo_args_sha256 === planned.plan.argsSha256) candidates.push(g)
  }
  if (candidates.length === 0) {
    return { kind: 'refused', refusal: { status: 403, error: 'sudo_args_mismatch', detail: { remedy: 'this approval covers exactly the call your human saw in Telegram; any different argument needs a new request_elevation with those arguments in sudo_args', action } } }
  }
  let grant: ElevationGrantRecord | null = null
  let lastDenied: Parameters<typeof elevationRemedyMessage>[0] = 'no_matching_grant'
  for (const c of candidates) {
    const checked = await checkGrant(env, auth, tool, planned.plan, nowMs, c.id)
    if (checked.granted) { grant = checked.grant; break }
    lastDenied = checked.reason
  }
  if (!grant) {
    return { kind: 'refused', refusal: { status: 403, error: 'forbidden', detail: { sudo_denied: lastDenied, remedy: elevationRemedyMessage(lastDenied), action } } }
  }
  if (!(await memberIsActiveHuman(env, grant.approved_by_member_id))) {
    return { kind: 'refused', refusal: { status: 403, error: 'forbidden', detail: { sudo_denied: 'approver_authority_lost', remedy: elevationRemedyMessage('approver_authority_lost'), action } } }
  }
  // The approver acts with the role a VERIFIED login identity proves (never members.email) plus their capability rows.
  const memberAuth = await buildAuth(env, grant.approved_by_member_id, undefined, { verifiedRole: true })
  // buildAuth leaves `capabilities` UNDEFINED for a verified owner/admin role (the dashboard cookie rule: assigning rows to a role-only
  // owner DOWNGRADES them, hasWorkspaceAdmin then reads rows only). The tools here also read the rows (memberCanOnSquad), so an owner
  // who ALSO holds an org admin/owner row carries them; an owner without one stays role-plane only, never downgraded to [].
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
    squadId: planned.plan.squadId,
  }
  return { kind: 'sudo', memberAuth, pending: { grant, tool, executorAgentId: auth.boundAgentId, tenant: auth.tenant, detail: planned.plan.detail } }
}

export const SUDO_ALREADY_USED: SudoRefusal = {
  status: 409,
  error: 'sudo_already_used',
  detail: { remedy: 'an owner-sudo approval covers ONE call and it was used (or is being used); ask your human for a new approval with request_elevation' },
}
export const SUDO_GRANT_ENDED: SudoRefusal = {
  status: 403,
  error: 'sudo_grant_ended',
  detail: { remedy: 'the approval ended (expired, revoked or renewed) before this call could start; nothing ran. Ask your human for a new approval with request_elevation' },
}
export const SUDO_RECEIPT_FAILED: SudoRefusal = {
  status: 500,
  error: 'sudo_receipt_failed',
  detail: 'the audit receipt for this call could not be written, so nothing ran and the approval is not spent',
}

export type ClaimResult = { ok: true; claim: OwnerSudoClaim } | { ok: false; refusal: SudoRefusal }

/**
 * SINGLE USE, atomic with the grant's liveness: spend the approval. ONE guarded insert is the claim, and it holds only while this
 * exact GENERATION of the grant (id + created_at) is still unrevoked and unexpired AT THE INSERT, and nobody has a 'pending' or
 * 'applied' usage row for it. So a /murevoke between resolve and claim refuses; a second, a concurrent and a post-success call lose.
 * Then the audit receipt is written BEFORE the tool runs and is mandatory: if it cannot be written the claim is released and
 * nothing executes (fail closed). Call it right before the tool body, after every refusal that can still happen.
 */
export async function claimOwnerSudo(env: Env, pending: OwnerSudoPending, nowMs: number = Date.now()): Promise<ClaimResult> {
  const usageId = crypto.randomUUID()
  const nowIso = new Date(nowMs).toISOString()
  const g = pending.grant
  const claimed = await env.DB.prepare(
    `INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at, status)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending'
      WHERE EXISTS (SELECT 1 FROM elevation_grants WHERE id = ?3 AND tenant = ?2 AND created_at = ?9 AND revoked_at IS NULL AND expires_at > ?8)
        AND NOT EXISTS (SELECT 1 FROM elevation_usage_log WHERE elevation_grant_id = ?3 AND status IN ('pending', 'applied') AND occurred_at >= ?9)`,
  ).bind(
    usageId, pending.tenant, g.id, g.agent_session_id, g.action, pending.tool,
    JSON.stringify({ ...pending.detail, authority_member_id: g.approved_by_member_id }), nowIso,
    g.created_at, // the generation the caller resolved: a renewed grant keeps its id but is a different approval
  ).run()
  if (Number(claimed.meta?.changes ?? 0) !== 1) {
    const live = await env.DB.prepare('SELECT 1 AS x FROM elevation_grants WHERE id = ?1 AND tenant = ?2 AND created_at = ?3 AND revoked_at IS NULL AND expires_at > ?4 LIMIT 1')
      .bind(g.id, pending.tenant, g.created_at, nowIso).first<{ x: number }>()
    return { ok: false, refusal: live ? SUDO_ALREADY_USED : SUDO_GRANT_ENDED }
  }
  const claim: OwnerSudoClaim = { grant: g, usageId, authorityMemberId: g.approved_by_member_id, executorAgentId: pending.executorAgentId, tool: pending.tool }
  try {
    await writeSudoAudit(env, claim, `owner_sudo:${pending.tool}`, { phase: 'authorized', args_sha256: pending.detail.args_sha256 ?? null })
  } catch {
    await finishElevationReceipt(env, usageId, { status: 'failed', errorCode: 'receipt_failed' }).catch(() => undefined)
    return { ok: false, refusal: SUDO_RECEIPT_FAILED }
  }
  return { ok: true, claim }
}

async function writeSudoAudit(env: Env, claim: OwnerSudoClaim, operation: string, extra: Record<string, unknown>): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mutation_audit_entries (
       id, tenant, principal_kind, principal_id, member_id, agent_id, origin, handler, operation,
       target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
     VALUES (?1, ?2, 'agent', ?3, ?4, ?3, 'mcp', 'owner_sudo', ?5, 'elevation_grant', ?6, ?7, ?7, ?8, ?9)`,
  ).bind(
    crypto.randomUUID(), env.TENANT_SLUG, claim.executorAgentId, claim.authorityMemberId, operation, claim.grant.id, `owner-sudo:${operation}:${claim.usageId}`,
    JSON.stringify({ executor_agent_id: claim.executorAgentId, authority_member_id: claim.authorityMemberId, grant_id: claim.grant.id, grant_generation: claim.grant.created_at, elevation_request_id: claim.grant.elevation_request_id, action: claim.grant.action, tool: claim.tool, ...extra }),
    new Date().toISOString(),
  ).run()
}

/** Close the claim and write the outcome receipt (agent = executor, human = authority). A refused tool frees the claim. Never throws. */
export async function finishOwnerSudo(env: Env, claim: OwnerSudoClaim, outcome: { ok: true } | { ok: false; status: number; error: string }): Promise<void> {
  await finishElevationReceipt(env, claim.usageId, outcome.ok ? { status: 'applied' } : { status: 'failed', errorCode: outcome.error.slice(0, 120) }).catch(() => undefined)
  // Spent: the approval ends now, visibly (revoked, not merely un-claimable), and a fresh approval for the same act can be written.
  // By GENERATION: it can only end the approval this call used, never a later approval that renewed the same grant row.
  if (outcome.ok) await revokeElevationGrant(env, env.TENANT_SLUG, claim.grant.id, 'owner_sudo_spent', Date.now(), claim.grant.created_at).catch(() => undefined)
  await writeSudoAudit(env, claim, `owner_sudo_result:${claim.tool}`, { ok: outcome.ok, ...(outcome.ok ? {} : { status: outcome.status, error: outcome.error }) }).catch(() => undefined)
}
