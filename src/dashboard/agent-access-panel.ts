// mupot — dashboard "Access" panel for one agent (/agents/:id) and its write,
// POST /agents/:id/access.
//
// ONE org-admin control to set which squad an agent sits on and at which access
// level ({observer, member, lead, admin}, never owner), or to revoke it.
//
// The write goes through the EXISTING setAgentSquadAccess / removeAgentSquadAccess
// machinery in src/members/agent-access.ts (commitAgentSquadAccess and
// commitRemoveAgentSquadAccess with their extra-statements hook). This module never
// writes memberships or capabilities itself. What it adds is ONE statement in that
// same D1 batch: an INSERT into agent_access_receipts (migration 0187) that
//
//   1. carries every authority guard as an EXISTS / NOT EXISTS leaf, evaluated at
//      write time inside the batch, not only at the route, and
//   2. turns a failed guard into a NOT NULL violation on the receipt id. D1 rolls a
//      batch back only when a statement THROWS, never when it writes 0 rows, so the
//      guard has to throw or the access rows would land without a receipt.
//
// Result: the receipt row exists if and only if the access rows changed, and the
// outcome reported to the admin is read back from the receipt row.

import { html } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import {
  actorRankOnScopeFor,
  capabilityRank,
  currentMemberRankAtLeastSql,
  exceedsTargetRankCeiling,
  isOrgAdmin,
  RANK_SQL_CASE,
  sessionMemberId,
  targetMaxRankAcrossScopes,
} from '../auth/capability'
import {
  commitAgentSquadAccess,
  commitRemoveAgentSquadAccess,
  isAgentAccessCapability,
} from '../members/agent-access'
import type { AgentAccessCapability } from '../members/agent-access'
import { INVITER_ACTIVE_MEMBER_SQL } from '../members/index'
import { resolveAgentMemberBinding } from '../members/service'
import type { AuthContext, Env } from '../types'

export const ACCESS_LEVELS: readonly AgentAccessCapability[] = ['observer', 'member', 'lead', 'admin']
export const REASON_MAX_LENGTH = 500

/** The lowest rank that may create, change or remove agent access: admin. */
const ACTOR_RANK_FLOOR = capabilityRank('admin')

export type AccessAction = 'set' | 'revoke'

export type AccessRefusal =
  | 'agent_session_forbidden'
  | 'org_admin_required'
  | 'actor_member_required'
  | 'actor_is_agent'
  | 'self_change_forbidden'
  | 'agent_not_found'
  | 'agent_identity_unminted'
  | 'squad_not_found'
  | 'home_squad_immutable'
  | 'squad_archived'
  | 'invalid_capability'
  | 'invalid_expected_prior'
  | 'invalid_reason'
  | 'insufficient_rank'
  | 'target_outranks_actor'
  | 'target_above_admin_floor'
  | 'rows_disagree'
  | 'owner_access_untouchable'
  | 'stale_state'
  | 'nothing_to_revoke'
  | 'unchanged'
  | 'refused_at_write'
  | 'receipt_missing'

export interface AccessChangeInput {
  agentRef: string
  squadId: string
  action: AccessAction
  /** Required for 'set'. There is no default level: an omitted level is refused. */
  capability: string
  /** What the admin SAW: 'none' or the level shown on the page. Compared at write time. */
  expectedPrior: string
  reason: string
}

export type AccessChangeResult =
  | {
      ok: true
      receiptId: string
      action: 'enroll' | 'change' | 'revoke'
      agentName: string
      squadName: string
      capability: AgentAccessCapability | null
    }
  | { ok: false; error: AccessRefusal; status: 400 | 403 | 404 | 409 }

const fail = (error: AccessRefusal, status: 400 | 403 | 404 | 409): AccessChangeResult => ({
  ok: false,
  error,
  status,
})

interface AgentRow {
  id: string
  name: string
  squad_id: string
}

interface SquadRow {
  id: string
  name: string
  kind: string
  status: string
}

interface CapabilityRow {
  capability: string
}

// ── the in-batch receipt statement ────────────────────────────────────────────

export interface ReceiptPlan {
  receiptId: string
  actorMemberId: string
  agentId: string
  squadId: string
  agentMemberId: string
  prior: AgentAccessCapability | null
  next: AgentAccessCapability | null
  action: 'enroll' | 'change' | 'revoke'
  reason: string | null
  requiredRank: number
  /** The agent's home squad as read when the plan was made. Re-asserted at write time. */
  homeSquadId: string
}

// Parameter map (every ?N is bound once, used many times):
//   ?1 receipt id      ?2 actor member   ?3 agent id     ?4 squad id
//   ?5 prior level     ?6 new level      ?7 action       ?8 reason
//   ?9 tenant          ?10 required squad rank           ?11 agent's member id
//   ?12 org-admin floor / target-rank ceiling floor
//   ?13 the agent's home squad as planned
function guardSql(plan: ReceiptPlan): string {
  const orgAdmin = currentMemberRankAtLeastSql('org', {
    inviterIdParam: '?2',
    scopeIdParam: '?4',
    requiredRankParam: '?12',
  })
  const squadRank = currentMemberRankAtLeastSql('squad', {
    inviterIdParam: '?2',
    scopeIdParam: '?4',
    requiredRankParam: '?10',
  })
  const capRow = (cap: string | null): string =>
    `EXISTS (SELECT 1 FROM capabilities WHERE member_id = ?11 AND scope_type = 'squad' AND scope_id = ?4${cap ? ` AND capability = ${cap}` : ''})`
  const memRow = (cap: string | null): string =>
    `EXISTS (SELECT 1 FROM memberships WHERE agent_id = ?3 AND squad_id = ?4${cap ? ` AND capability = ${cap}` : ''})`

  // Compare-and-swap on what the admin saw. 'none' means neither row exists.
  const priorMatches = plan.prior === null
    ? `NOT ${capRow(null)} AND NOT ${memRow(null)}`
    : `${capRow('?5')} AND ${memRow('?5')}`
  return [
    // (1) the actor is a live member of this tenant
    `EXISTS (SELECT 1 FROM members WHERE ${INVITER_ACTIVE_MEMBER_SQL('?2', '?9')})`,
    // (1)+(7) the actor is org admin, judged from live D1 rows
    orgAdmin,
    // (1)+(2)+(7) the actor's live rank ON THIS SQUAD covers admin and the granted level
    squadRank,
    // (4) a work squad, not archived
    `EXISTS (SELECT 1 FROM squads WHERE id = ?4 AND kind <> 'home' AND status = 'active')`,
    // (5) no agent-bound member can act: also covers an agent editing itself
    `NOT EXISTS (SELECT 1 FROM agent_member_bindings WHERE member_id = ?2)`,
    // the target identity is still the welded one we authorized
    `EXISTS (SELECT 1 FROM agent_member_bindings WHERE tenant = ?9 AND agent_id = ?3 AND member_id = ?11)`,
    // owner access is never touched from here. An owner CAPABILITY row cannot pass
    // priorMatches below (it demands prior 'none' or a non-owner level), so only the
    // membership table needs its own leaf.
    `NOT ${memRow("'owner'")}`,
    // (7) target rank ceiling, floor of admin: the agent's member holds nothing above
    // admin on ANY plane exceedsTargetRankCeiling / targetMaxRankAcrossScopes reads:
    //   - capability rows on any work scope (home-squad grants excluded, as there),
    //   - channel_capability_grants on a non-home squad (resolveCapabilities' second
    //     branch, same join and same home filter),
    //   - the legacy role plane (members.email -> lower() -> users.role, the same
    //     bridge as targetLegacyRoleRank / legacyRoleRankSql), which is global.
    `NOT EXISTS (SELECT 1 FROM capabilities t WHERE t.member_id = ?11 AND ${RANK_SQL_CASE('t.capability')} > ?12
        AND NOT (t.scope_type = 'squad' AND EXISTS (SELECT 1 FROM squads hs WHERE hs.id = t.scope_id AND hs.kind = 'home')))`,
    `NOT EXISTS (SELECT 1 FROM channel_capability_grants ccg JOIN squads cs ON cs.id = ccg.squad_id
        WHERE ccg.member_id = ?11 AND cs.kind <> 'home' AND ${RANK_SQL_CASE('ccg.capability')} > ?12)`,
    `NOT EXISTS (SELECT 1 FROM members rm JOIN users ru ON lower(ru.email) = lower(rm.email)
        WHERE rm.id = ?11 AND ${RANK_SQL_CASE('ru.role')} > ?12)`,
    // the agent's CURRENT home squad is the one this plan was computed against. The
    // route refuses the agent's home squad as a target; if the home moved between that
    // read and this write, the refusal was about a different squad. Equality here also
    // makes the target squad (planned as not-home) still not-home.
    `EXISTS (SELECT 1 FROM agents WHERE id = ?3 AND squad_id = ?13)`,
    // (6) the level the admin saw is still the level in BOTH tables (a disagreement
    // between membership and capability rows is refused, never silently overwritten). A set to the level
    // already held cannot get past here as a receipt either: the table CHECK demands
    // prior <> new for 'change', and 'enroll' demands prior NULL.
    priorMatches,
  ].map((leaf) => `(${leaf})`).join('\n      AND ')
}

/** Exported so tests can drive the in-batch guard directly, past the route's pre-checks. */
export function receiptStatement(env: Env, plan: ReceiptPlan) {
  return env.DB.prepare(
    `INSERT INTO agent_access_receipts
       (id, actor_member_id, agent_id, squad_id, prior_capability, new_capability, action, reason)
     SELECT CASE WHEN ${guardSql(plan)} THEN ?1 END,
            ?2, ?3, ?4, ?5, ?6, ?7, ?8`,
  ).bind(
    plan.receiptId,
    plan.actorMemberId,
    plan.agentId,
    plan.squadId,
    plan.prior,
    plan.next,
    plan.action,
    plan.reason,
    env.TENANT_SLUG,
    plan.requiredRank,
    plan.agentMemberId,
    ACTOR_RANK_FLOOR,
    plan.homeSquadId,
  )
}

// ── the write ─────────────────────────────────────────────────────────────────

async function resolveAgent(env: Env, ref: string): Promise<AgentRow | null> {
  return env.DB.prepare('SELECT id, name, squad_id FROM agents WHERE id = ? LIMIT 1')
    .bind(ref)
    .first<AgentRow>()
}

async function currentMembership(env: Env, agentId: string, squadId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ? LIMIT 1',
  ).bind(agentId, squadId).first<CapabilityRow>()
  return row?.capability ?? null
}

async function currentCapability(
  env: Env,
  memberId: string,
  squadId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT capability FROM capabilities
      WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ? LIMIT 1`,
  ).bind(memberId, squadId).first<CapabilityRow>()
  return row?.capability ?? null
}

export async function applyAgentAccessChange(
  env: Env,
  auth: AuthContext,
  input: AccessChangeInput,
): Promise<AccessChangeResult> {
  // (3) any agent-bound session: refused outright, no elevation path at any level.
  if (auth.boundAgentId) return fail('agent_session_forbidden', 403)
  if (!isOrgAdmin(auth)) return fail('org_admin_required', 403)
  const actorMemberId = sessionMemberId(auth)
  if (!actorMemberId) return fail('actor_member_required', 403)

  const agent = await resolveAgent(env, input.agentRef)
  if (!agent) return fail('agent_not_found', 404)
  const binding = await resolveAgentMemberBinding(env, agent.id)
  if (binding.kind !== 'bound') return fail('agent_identity_unminted', 409)
  // (5) self-exempt: the target's own member is never the actor.
  if (binding.memberId === actorMemberId) return fail('self_change_forbidden', 403)
  const actorIsAgent = await env.DB.prepare(
    'SELECT 1 AS x FROM agent_member_bindings WHERE member_id = ? LIMIT 1',
  ).bind(actorMemberId).first<{ x: number }>()
  if (actorIsAgent) return fail('actor_is_agent', 403)

  const squad = await env.DB.prepare(
    'SELECT id, name, kind, status FROM squads WHERE id = ? LIMIT 1',
  ).bind(input.squadId).first<SquadRow>()
  if (!squad) return fail('squad_not_found', 404)
  // (4)
  if (squad.kind === 'home' || squad.id === agent.squad_id) return fail('home_squad_immutable', 409)
  if (squad.status !== 'active') return fail('squad_archived', 409)

  // level: required for set, never owner, never defaulted
  let next: AgentAccessCapability | null = null
  if (input.action === 'set') {
    if (!isAgentAccessCapability(input.capability)) return fail('invalid_capability', 400)
    next = input.capability
  }

  let prior: AgentAccessCapability | null = null
  if (input.expectedPrior !== 'none') {
    if (input.expectedPrior === 'owner') return fail('owner_access_untouchable', 403)
    if (!isAgentAccessCapability(input.expectedPrior)) return fail('invalid_expected_prior', 400)
    prior = input.expectedPrior
  }

  const reason = input.reason.trim()
  if (reason.length > REASON_MAX_LENGTH) return fail('invalid_reason', 400)

  // (2)+(7) live rank on this squad, org-scope-local target ceiling. The same facts
  // are re-asserted in SQL inside the batch below; this is the early, readable refusal.
  const requiredRank = Math.max(
    ACTOR_RANK_FLOOR,
    next ? capabilityRank(next) : 0,
    prior ? capabilityRank(prior) : 0,
  )
  const actorRank = await actorRankOnScopeFor(env, auth, 'squad', squad.id)
  if (actorRank < requiredRank) return fail('insufficient_rank', 403)
  if (await exceedsTargetRankCeiling(env, auth, binding.memberId)) {
    return fail('target_outranks_actor', 403)
  }

  const live = await currentCapability(env, binding.memberId, squad.id)
  const liveMembership = await currentMembership(env, agent.id, squad.id)
  if (live === 'owner' || liveMembership === 'owner') return fail('owner_access_untouchable', 403)
  if (live !== liveMembership) return fail('rows_disagree', 409)
  // Same agreement the SQL guard demands, in JS: the ceiling above is per-plane, this
  // is the agent's own standing floor (admin) across every plane, so an org owner gets
  // a specific refusal instead of a generic write-time one.
  if ((await targetMaxRankAcrossScopes(env, binding.memberId)) > ACTOR_RANK_FLOOR) {
    return fail('target_above_admin_floor', 403)
  }
  if (input.action === 'revoke' && prior === null) return fail('nothing_to_revoke', 409)
  if ((live ?? 'none') !== (prior ?? 'none')) return fail('stale_state', 409)
  // A set to the level already held is a no-op: answered here, and refused again
  // by the receipt CHECK (prior <> new) and the compare-and-swap in SQL, so it can never
  // leave a receipt behind.
  if (input.action === 'set' && prior !== null && prior === next) return fail('unchanged', 409)

  const plan: ReceiptPlan = {
    receiptId: crypto.randomUUID(),
    actorMemberId,
    agentId: agent.id,
    squadId: squad.id,
    agentMemberId: binding.memberId,
    prior,
    next,
    action: input.action === 'revoke' ? 'revoke' : prior === null ? 'enroll' : 'change',
    reason: reason === '' ? null : reason,
    requiredRank,
    homeSquadId: agent.squad_id,
  }

  let refusal: AccessRefusal | null = null
  try {
    if (input.action === 'set' && next) {
      const outcome = await commitAgentSquadAccess(
        env,
        { agentId: agent.id, memberId: binding.memberId, squadId: squad.id, capability: next },
        (_prepared) => [receiptStatement(env, plan)],
      )
      if (!outcome.ok) refusal = outcome.error === 'home_squad_immutable' ? 'home_squad_immutable' : 'refused_at_write'
    } else {
      const outcome = await commitRemoveAgentSquadAccess(
        env,
        { agentId: agent.id, memberId: binding.memberId, squadId: squad.id },
        (_prior) => [receiptStatement(env, plan)],
        { evaluateExtrasWhenAbsent: true },
      )
      if (!outcome.ok) refusal = outcome.error === 'home_squad_immutable' ? 'home_squad_immutable' : 'refused_at_write'
    }
  } catch {
    // The in-batch guard threw: D1 rolled the WHOLE batch back, so neither the
    // access rows nor a receipt exist. Reported below from the receipt row.
    refusal = 'refused_at_write'
  }

  // The outcome is anchored on the receipt row, never on the return value: the
  // receipt was written in the same batch as the access rows, so it exists iff
  // they changed.
  const receipt = await env.DB.prepare(
    'SELECT id FROM agent_access_receipts WHERE id = ? LIMIT 1',
  ).bind(plan.receiptId).first<{ id: string }>()
  if (!receipt) return fail(refusal ?? 'receipt_missing', 409)
  return {
    ok: true,
    receiptId: receipt.id,
    action: plan.action,
    agentName: agent.name,
    squadName: squad.name,
    capability: plan.next,
  }
}

/** Plain-language confirmation. No token is ever shown or minted here. */
export function accessChangeMessage(result: Extract<AccessChangeResult, { ok: true }>): string {
  return result.capability === null
    ? `${result.agentName} no longer has access to ${result.squadName}. Effective on its next request.`
    : `${result.agentName} is now ${result.capability} on ${result.squadName}. Effective on its next request.`
}

const REFUSAL_TEXT: Record<AccessRefusal, string> = {
  agent_session_forbidden: 'An agent session cannot change agent access.',
  org_admin_required: 'Changing agent access requires org admin.',
  actor_member_required: 'Your session is not tied to a member, so the change cannot be recorded.',
  actor_is_agent: 'Agent identities cannot change agent access.',
  self_change_forbidden: 'You cannot change your own access.',
  agent_not_found: 'Agent not found.',
  agent_identity_unminted: 'This agent has no welded identity yet. Access cannot be set until it has one.',
  squad_not_found: 'Squad not found.',
  home_squad_immutable: 'A home squad cannot be changed here.',
  squad_archived: 'That squad is archived.',
  invalid_capability: 'Choose an access level: observer, member, lead or admin.',
  invalid_expected_prior: 'The form is out of date. Reload and try again.',
  invalid_reason: `The reason is limited to ${REASON_MAX_LENGTH} characters.`,
  insufficient_rank: 'You need admin on that squad to set this level.',
  target_outranks_actor: 'This agent holds standing above yours elsewhere, so you cannot change it.',
  target_above_admin_floor: 'This agent holds owner standing on another scope. Agent access is only changed for agents whose standing is admin or below, even for an org owner.',
  rows_disagree: 'This agent\'s membership and capability rows for that squad disagree. An engineer needs to reconcile them before the level can be changed here.',
  owner_access_untouchable: 'Owner access is never changed from this panel.',
  stale_state: 'This agent\'s access changed since you loaded the page. Reload and try again.',
  nothing_to_revoke: 'There is no access on that squad to revoke.',
  unchanged: 'The agent already has exactly that access. Nothing was changed.',
  refused_at_write: 'The change was refused at write time: access changed underneath you, or your authority on that squad no longer covers it. Nothing was changed.',
  receipt_missing: 'The change could not be recorded, so nothing was changed.',
}

export function accessRefusalMessage(error: AccessRefusal): string {
  return REFUSAL_TEXT[error]
}

// ── the read + the panel ──────────────────────────────────────────────────────

export interface AccessRow {
  squadId: string
  squadName: string
  departmentName: string | null
  home: boolean
  archived: boolean
  /** What the capability plane says; the authoritative side. */
  capability: string | null
  /** What the membership row says. Differs from `capability` only on drift. */
  membership: string | null
}

export interface ChoosableSquad {
  id: string
  name: string
  departmentName: string | null
}

export interface AgentAccessView {
  bound: boolean
  agentMemberId: string | null
  rows: AccessRow[]
  choosable: ChoosableSquad[]
}

export async function loadAgentAccessView(env: Env, agentId: string): Promise<AgentAccessView> {
  const binding = await resolveAgentMemberBinding(env, agentId)
  const memberId = binding.kind === 'bound' ? binding.memberId : null
  const [memberships, grants, squads] = await Promise.all([
    env.DB.prepare('SELECT squad_id, capability FROM memberships WHERE agent_id = ?')
      .bind(agentId).all<{ squad_id: string; capability: string }>(),
    memberId
      ? env.DB.prepare(
          `SELECT scope_id, capability FROM capabilities
            WHERE member_id = ? AND scope_type = 'squad'`,
        ).bind(memberId).all<{ scope_id: string; capability: string }>()
      : Promise.resolve({ results: [] as Array<{ scope_id: string; capability: string }> }),
    env.DB.prepare(
      `SELECT s.id, s.name, s.kind, s.status, d.name AS department_name
         FROM squads s LEFT JOIN departments d ON d.id = s.department_id
        ORDER BY d.name, s.name`,
    ).all<{ id: string; name: string; kind: string; status: string; department_name: string | null }>(),
  ])
  const mem = new Map((memberships.results ?? []).map((m) => [m.squad_id, m.capability]))
  const cap = new Map((grants.results ?? []).map((g) => [g.scope_id, g.capability]))
  const rows: AccessRow[] = []
  const choosable: ChoosableSquad[] = []
  for (const s of squads.results ?? []) {
    const held = mem.has(s.id) || cap.has(s.id)
    if (held) {
      rows.push({
        squadId: s.id,
        squadName: s.name,
        departmentName: s.department_name,
        home: s.kind === 'home',
        archived: s.status !== 'active',
        capability: cap.get(s.id) ?? null,
        membership: mem.get(s.id) ?? null,
      })
    } else if (s.kind !== 'home' && s.status === 'active') {
      choosable.push({ id: s.id, name: s.name, departmentName: s.department_name })
    }
  }
  return { bound: memberId !== null, agentMemberId: memberId, rows, choosable }
}

type Html = HtmlEscapedString | Promise<HtmlEscapedString>

function levelOptions(selected: string | null): Html[] {
  return ACCESS_LEVELS.map((level) => html`<option value="${level}"${level === selected ? ' selected' : ''}>${level}</option>`)
}

/** The Access panel. Rendered for org admins only; the write re-checks everything. */
export function agentAccessPanel(
  agent: { id: string; name: string; squad_id: string },
  view: AgentAccessView,
  notice: string | null,
): Html {
  const action = `/agents/${agent.id}/access`
  const noticeHtml = notice ? html`<p class="notice" role="status">${notice}</p>` : ''
  if (!view.bound) {
    return html`<h2>Access</h2>
      ${noticeHtml}
      <div class="card"><p class="dim">This agent has no welded identity yet, so it has no
      squad access to manage. Access is set only after an identity exists; this panel never
      creates one and never shows a token.</p></div>`
  }
  const rowHtml = view.rows.map((row) => {
    const dept = row.departmentName ?? '—'
    const label = html`<strong>${row.squadName}</strong> <span class="dim">· department ${dept}</span>`
    if (row.home) {
      return html`<li>${label}: <code>${row.capability ?? row.membership ?? '—'}</code>
        <span class="dim">home squad, not editable here</span></li>`
    }
    if (row.archived) {
      return html`<li>${label}: <code>${row.capability ?? row.membership ?? '—'}</code>
        <span class="dim">archived squad, not editable here</span></li>`
    }
    if (row.capability === null || row.membership !== row.capability || row.capability === 'owner') {
      return html`<li>${label}: <code>${row.capability ?? '—'}</code>
        <span class="dim">membership and capability rows disagree, or owner access; not editable here</span></li>`
    }
    return html`<li>${label}: <code>${row.capability}</code>
      <form method="post" action="${action}" autocomplete="off" class="inline">
        <input type="hidden" name="squad_id" value="${row.squadId}" />
        <input type="hidden" name="expected_prior" value="${row.capability}" />
        <label>Level <select name="capability" required>${levelOptions(row.capability)}</select></label>
        <label>Reason <input name="reason" maxlength="${REASON_MAX_LENGTH}" placeholder="optional" /></label>
        <button type="submit" name="action" value="set" class="btn">Change level</button>
        <button type="submit" name="action" value="revoke" class="btn secondary">Revoke</button>
      </form></li>`
  })
  const enroll = view.choosable.length === 0
    ? html`<p class="dim">No other squad is available to enroll this agent in.</p>`
    : html`<form method="post" action="${action}" autocomplete="off">
        <input type="hidden" name="expected_prior" value="none" />
        <input type="hidden" name="action" value="set" />
        <label>Squad <select name="squad_id" required>
          <option value="" selected disabled>Choose a squad</option>
          ${view.choosable.map((s) => html`<option value="${s.id}">${s.name} (department ${s.departmentName ?? '—'})</option>`)}
        </select></label>
        <label>Access level <select name="capability" required>
          <option value="" selected disabled>Choose a level</option>
          ${levelOptions(null)}
        </select></label>
        <label>Reason <input name="reason" maxlength="${REASON_MAX_LENGTH}" placeholder="optional" /></label>
        <button type="submit" class="btn">Enroll</button>
      </form>`
  return html`<h2>Access</h2>
    ${noticeHtml}
    <div class="card">
      <p class="dim">Department follows the squad and is shown for reference. Levels are observer,
      member, lead and admin. A change takes effect on the agent's next request. This panel never
      shows or mints a token.</p>
      ${view.rows.length === 0 ? html`<p class="dim">No squad access yet.</p>` : html`<ul>${rowHtml}</ul>`}
      <h3>Enroll on another squad</h3>
      ${enroll}
    </div>`
}
