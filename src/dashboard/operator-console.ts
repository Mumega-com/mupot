// mupot — operator console (GET /operator, POST /operator/*).
//
// The rest of what /enroll (#1254) does not do: create an agent, create a
// squad, create a project, link project↔squad, set what an agent can access,
// and see the WHOLE roster — including every agent this operator cannot yet
// use, with the reason and the remedy in plain language.
//
// ── requirement 1, restated because it is the reason this file exists ────────
// #1254's picker (listConsentableAgents) INNER JOINs agent_member_bindings and
// filters status = 'active'. A live drive on a 5-agent seed showed 2 — the
// other 3 (one unminted, one paused, one the operator held no squad-admin on)
// were simply absent, and the page's only explanatory text fires when the
// list is EMPTY, never on a partial one. loadOperatorRoster below is the
// fix: it LEFT JOINs everything, filters nothing, and computes a reason for
// every row that is not immediately enrollable. Fail closed on AUTHORITY
// (nothing here grants more than the underlying tool would), never on
// INFORMATION (a row that exists is always shown).
//
// ── one write path ────────────────────────────────────────────────────────
// Every mutation below calls the SAME service function its MCP-tool sibling
// calls (createAgent, createSquad, createProject, upsertProjectSquadAccess,
// addSquadMember) — never a parallel INSERT. Minting stays entirely inside
// /enroll/mint (src/dashboard/enroll.ts, src/dashboard/index.ts); this file
// only links to it and, for an unminted agent, renders an inline form that
// POSTs to that SAME existing route — it does not read or write a token.
//
// ── operator_principal_required ───────────────────────────────────────────
// Every tool this page drives (create_squad, create_agent, grant_agent_capability,
// project_create/project_squad_set, squad_member_add) refuses an agent-bound
// caller server-side (src/mcp/provision.ts:463,594,649,771,893 and the project/
// squad-membership equivalents). This page works ONLY because a browser
// dashboard session always has boundAgentId: null — it is never itself the
// source of authority. requireOperatorConsoleAuthority below re-asserts that;
// it does not (and must not) add any route an agent-bound token could call.

import { html, raw as honoRaw } from 'hono/html'
import type { AuthContext, BusEvent, Env } from '../types'
import { canOnSquad, hasCapability, isOrgAdmin } from '../auth/capability'
import { createAgent, createSquad, type AgentInput, type SquadInput } from '../org/service'
import { resolveAgentRef, resolveDepartmentRef, resolveSquadRef } from '../org/resolve'
import { createProject, listProjects, upsertProjectSquadAccess } from '../projects/service'
import { slugFromProjectName } from '../projects/urls'
import { addSquadMember, type SquadMembershipTarget } from '../members/squad-membership'
import { isAgentAccessCapability, type AgentAccessCapability } from '../members/agent-access'
import { createBus } from '../bus'

// ── attributed audit events ─────────────────────────────────────────────────
//
// src/mcp/provision.ts and src/mcp/projects.ts each already carry an
// `emitProvisioned` / `emitProjectMutation` helper that does exactly this
// (same event type, same shape). They are NOT imported here on purpose:
// src/mcp/index.ts assembles its TOOLS array from src/mcp/provision.ts at
// module-eval time (`...PROVISION_TOOLS`), and pulling provision.ts into the
// dashboard's import graph from this file created a NEW circular-import edge
// (dashboard/index → operator-console → mcp/provision → mcp/index →
// mcp/provision again) that made PROVISION_TOOLS observably undefined during
// module init — proven by running `npm test`, which turned 37 unrelated
// dashboard test files red with "PROVISION_TOOLS is not iterable". Emitting
// the SAME event shape locally (this is telemetry, not the write path — the
// actual org-chart writes below still call the one shared service function
// each MCP tool calls) avoids the cycle entirely. If these ever move to a
// shared non-mcp module, switch back to importing them.
async function emitOperatorProvisioned(
  env: Env,
  memberId: string,
  kind: 'agent' | 'squad',
  id: string,
  extra: { squad_id?: string; agent_id?: string } = {},
): Promise<void> {
  const event: BusEvent<{ kind: string; id: string; by: string }> = {
    type: 'org.provisioned',
    tenant: env.TENANT_SLUG,
    squad_id: extra.squad_id,
    agent_id: extra.agent_id,
    actor: { kind: 'member', id: memberId },
    payload: { kind, id, by: memberId },
    ts: new Date().toISOString(),
  }
  try {
    await createBus(env).emit(event)
  } catch (error) {
    console.error('operator-console: org.provisioned emit failed (non-fatal)', {
      tenant: env.TENANT_SLUG,
      kind,
      id,
    })
  }
}

async function emitOperatorProjectMutation(
  env: Env,
  memberId: string,
  operation: 'created' | 'squad_access_set',
  projectId: string,
  extra: { squad_id?: string } = {},
): Promise<void> {
  const event: BusEvent<{ operation: string; project_id: string; squad_id?: string }> = {
    type: 'project.mutated',
    tenant: env.TENANT_SLUG,
    squad_id: extra.squad_id,
    actor: { kind: 'member', id: memberId },
    payload: { operation, project_id: projectId, ...(extra.squad_id ? { squad_id: extra.squad_id } : {}) },
    ts: new Date().toISOString(),
  }
  try {
    await createBus(env).emit(event)
  } catch (error) {
    console.error('operator-console: project.mutated emit failed (non-fatal)', {
      tenant: env.TENANT_SLUG,
      operation,
      project_id: projectId,
    })
  }
}

// Slugs are derived server-side everywhere on this page, never taken from a
// form field — see deriveSlugFromName's doc comment for why that is a hard
// requirement for agents specifically. slugFromProjectName's algorithm
// (lowercase, non-alnum runs → one hyphen, trim, cap 48) already produces
// exactly the shape org/service's isValidSlug requires; reusing it here means
// there is one slugify implementation in the codebase, not two.
export const deriveSlugFromName = slugFromProjectName

// ── roster ───────────────────────────────────────────────────────────────────

export type RosterReason = 'unminted' | 'paused' | 'inactive' | 'no_capability' | null

export interface RosterRow {
  id: string
  slug: string
  name: string
  status: string
  squad_id: string
  squad_name: string
  department_name: string
  /** True once mint_agent_token / POST /enroll/mint has run for this agent at
   *  least once (an agent_member_bindings row exists). */
  bound: boolean
  /** capability from `memberships` — the routing weld every agent gets on its
   *  own home squad at create_agent time, independent of whether it has ever
   *  been minted. */
  membership_capability: string | null
  /** capability from `capabilities` — the actual RBAC grant, resolvable only
   *  once the agent is bound. NULL here while `membership_capability` is
   *  non-null is not a bug to hide: it is exactly mupot#1261 (a squad member
   *  invisible to the messaging layer because it was never capability-granted)
   *  and this page surfaces it rather than papering over it. */
  grant_capability: string | null
  eligible: boolean
  reason: RosterReason
}

interface RosterQueryRow {
  id: string
  slug: string
  name: string
  status: string
  squad_id: string
  squad_name: string
  department_name: string
  bound_member_id: string | null
  membership_capability: string | null
  grant_capability: string | null
}

/**
 * Every agent in the tenant, LEFT JOINed against binding/membership/capability
 * state — never an INNER JOIN, never a status filter in the WHERE clause. Each
 * row is annotated in JS with WHY it is or is not usable from this console
 * right now. This is the query #1254's listConsentableAgents deliberately is
 * not (that function's narrower INNER-JOIN shape is correct for ITS purpose —
 * "what can this human act as via OAuth consent" — but wrong reused as "what
 * exists").
 */
export async function loadOperatorRoster(env: Env, auth: AuthContext): Promise<RosterRow[]> {
  const grants = auth.capabilities ?? []
  const rows = await env.DB.prepare(
    `SELECT a.id AS id, a.slug AS slug, a.name AS name, a.status AS status,
            a.squad_id AS squad_id, sq.name AS squad_name, d.name AS department_name,
            b.member_id AS bound_member_id,
            m.capability AS membership_capability,
            c.capability AS grant_capability
       FROM agents a
       JOIN squads sq ON sq.id = a.squad_id
       JOIN departments d ON d.id = sq.department_id
       LEFT JOIN agent_member_bindings b ON b.tenant = ?1 AND b.agent_id = a.id
       LEFT JOIN memberships m ON m.agent_id = a.id AND m.squad_id = a.squad_id
       LEFT JOIN capabilities c
         ON c.member_id = b.member_id AND c.scope_type = 'squad' AND c.scope_id = a.squad_id
      ORDER BY sq.name ASC, a.name ASC`,
  ).bind(env.TENANT_SLUG).all<RosterQueryRow>()

  const out: RosterRow[] = []
  for (const row of rows.results ?? []) {
    const bound = row.bound_member_id !== null
    const admin = await canOnSquad(env, grants, row.squad_id, 'admin')
    let reason: RosterReason = null
    if (row.status === 'paused') reason = 'paused'
    else if (row.status === 'inactive') reason = 'inactive'
    else if (!bound) reason = 'unminted'
    else if (!admin) reason = 'no_capability'
    out.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      squad_id: row.squad_id,
      squad_name: row.squad_name,
      department_name: row.department_name,
      bound,
      membership_capability: row.membership_capability,
      grant_capability: row.grant_capability,
      eligible: reason === null,
      reason,
    })
  }
  return out
}

/** Plain-language reason + remedy, named per row so a partial list never
 *  leaves an operator guessing why an agent they expected isn't usable yet. */
export function rosterReasonCopy(row: RosterRow): { label: string; remedy: string } {
  switch (row.reason) {
    case 'unminted':
      return {
        label: 'Not minted yet',
        remedy: 'No credential has ever been coined for this agent. Mint one below to activate it.',
      }
    case 'paused':
      return {
        label: 'Paused',
        remedy: `Resume it from its agent console (/agents/${row.id}) before it can be enrolled.`,
      }
    case 'inactive':
      return {
        label: 'Retired',
        remedy: 'This identity was deliberately deactivated and does not resume — create a new agent instead.',
      }
    case 'no_capability':
      return {
        label: 'No capability on that squad',
        remedy: `You do not hold admin on "${row.squad_name}" yet. Ask an org-admin or that squad's admin to grant it.`,
      }
    default:
      return { label: 'Eligible', remedy: '' }
  }
}

// ── option lists for the create/link forms ──────────────────────────────────

export interface DepartmentOption { id: string; name: string }
export interface SquadOption { id: string; name: string; department_name: string }
export interface ProjectOption { id: string; slug: string; name: string; status: string }

export async function loadDepartmentOptions(env: Env): Promise<DepartmentOption[]> {
  const rows = await env.DB.prepare(`SELECT id, name FROM departments ORDER BY name ASC`)
    .all<DepartmentOption>()
  return rows.results ?? []
}

export async function loadSquadOptions(env: Env): Promise<SquadOption[]> {
  const rows = await env.DB.prepare(
    `SELECT sq.id AS id, sq.name AS name, d.name AS department_name
       FROM squads sq JOIN departments d ON d.id = sq.department_id
      ORDER BY d.name ASC, sq.name ASC`,
  ).all<SquadOption>()
  return rows.results ?? []
}

export async function loadProjectOptions(env: Env): Promise<ProjectOption[]> {
  const projects = await listProjects(env)
  return projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name, status: p.status }))
}

export interface OperatorConsoleView {
  roster: RosterRow[]
  departments: DepartmentOption[]
  squads: SquadOption[]
  projects: ProjectOption[]
}

export async function loadOperatorConsoleView(env: Env, auth: AuthContext): Promise<OperatorConsoleView> {
  const [roster, departments, squads, projects] = await Promise.all([
    loadOperatorRoster(env, auth),
    loadDepartmentOptions(env),
    loadSquadOptions(env),
    loadProjectOptions(env),
  ])
  return { roster, departments, squads, projects }
}

// ── page-level authority (BINDING — do not loosen) ──────────────────────────
//
// Gated at isOrgAdmin, not a per-row capability check: this console can create
// squads/agents/projects and grant capability across the whole org-chart, so
// the floor is the same one project_create/project_squad_set already require
// (workspace admin) rather than something narrower this page invents. A
// squad-scoped lead who wants to add their own squad's members still has
// squad_member_add itself (MCP) — this page is the org-admin console, not a
// replacement for every narrower door.
export function requireOperatorConsoleAuthority(
  auth: AuthContext,
): { ok: true } | { ok: false; reason: 'operator_principal_required' | 'org_admin_required' } {
  if (auth.boundAgentId) return { ok: false, reason: 'operator_principal_required' }
  if (!isOrgAdmin(auth)) return { ok: false, reason: 'org_admin_required' }
  return { ok: true }
}

// ── mutation flows ───────────────────────────────────────────────────────────
//
// Each flow is a thin wrapper: resolve refs, re-check the SAME scope the
// underlying MCP tool checks, derive/validate, call the ONE shared service
// function, emit the SAME attributed event the MCP tool emits. No SQL in this
// file ever INSERTs/UPDATEs org-chart rows directly.

export type FlowResult<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string }

/**
 * create_agent's slug is caller-chosen in the MCP tool (src/mcp/provision.ts)
 * because that tool is used by harnesses that already know what they want to
 * call themselves. A browser FORM is a much softer input surface — no schema
 * validation on the client, easy to fat-finger, and the failure mode of a bad
 * agent slug is not cosmetic: agents.slug is UNIQUE(squad_id, slug), NOT
 * tenant-global (see bootstrap-self.ts's header comment), so a slug that
 * collides with an agent in ANOTHER squad silently breaks deactivate_agent's
 * bare-slug cleanup sweep (`SELECT COUNT(*) FROM agents WHERE slug = ?`, which
 * skips the credential sweep the moment that count is >1 — this fired in
 * production today on a real retirement, slug_sweep_skipped: true) and can
 * confuse any other bare-slug resolver. So THIS surface never takes a slug
 * from the form at all: it derives one from the name (same algorithm as
 * project creation) and additionally refuses — rather than silently
 * succeeding — when that derived slug already exists ANYWHERE in the tenant,
 * naming the squad that already holds it. bootstrap_self takes the same
 * "derive, never accept" stance for the identical reason.
 */
export async function createAgentFlow(
  env: Env,
  auth: AuthContext,
  input: { squadRef: string; name: string },
): Promise<FlowResult<{ id: string; slug: string; name: string; squadName: string }>> {
  // Every MCP tool this flow mirrors independently refuses an agent-bound
  // caller (operator_principal_required) rather than relying solely on a
  // shared gate — this flow does the same, so it stays safe if it is ever
  // reached from anywhere other than the route-level check in index.ts.
  if (auth.boundAgentId) return { ok: false, error: 'operator_principal_required' }
  const squadRef = input.squadRef.trim()
  const name = input.name.trim()
  if (!squadRef) return { ok: false, error: 'invalid_args', detail: 'Choose a squad.' }
  if (!name) return { ok: false, error: 'invalid_args', detail: 'Name the agent.' }

  const squadResult = await resolveSquadRef(env, squadRef)
  if (!squadResult.ok) return { ok: false, error: 'squad_not_found' }
  const squad = squadResult.value

  const grants = auth.capabilities ?? []
  if (!(await canOnSquad(env, grants, squad.id, 'lead'))) {
    return { ok: false, error: 'forbidden', detail: 'lead on the squad is required' }
  }

  const slug = deriveSlugFromName(name)
  if (!slug) {
    return {
      ok: false,
      error: 'invalid_name',
      detail: 'That name has no letters or digits in it, so no identifier could be derived from it.',
    }
  }

  const collision = await env.DB.prepare(
    `SELECT sq.name AS squad_name FROM agents a JOIN squads sq ON sq.id = a.squad_id
      WHERE a.slug = ?1 LIMIT 1`,
  ).bind(slug).first<{ squad_name: string }>()
  if (collision) {
    return {
      ok: false,
      error: 'slug_taken',
      detail: `An agent named "${name}" already resolves to an identical identifier already used by an agent in squad "${collision.squad_name}". Pick a more distinct name.`,
    }
  }

  const created = await createAgent(env, squad.id, { slug, name } satisfies AgentInput)
  if (!created.ok) {
    return { ok: false, error: created.error }
  }
  await emitOperatorProvisioned(env, auth.memberId as string, 'agent', created.value.id, {
    squad_id: squad.id,
    agent_id: created.value.id,
  })

  const squadRow = await env.DB.prepare('SELECT name FROM squads WHERE id = ?1 LIMIT 1')
    .bind(squad.id)
    .first<{ name: string }>()
  return {
    ok: true,
    value: { id: created.value.id, slug: created.value.slug, name: created.value.name, squadName: squadRow?.name ?? '' },
  }
}

export async function createSquadFlow(
  env: Env,
  auth: AuthContext,
  input: { departmentRef: string; name: string },
): Promise<FlowResult<{ id: string; slug: string; name: string }>> {
  // Every MCP tool this flow mirrors independently refuses an agent-bound
  // caller (operator_principal_required) rather than relying solely on a
  // shared gate — this flow does the same, so it stays safe if it is ever
  // reached from anywhere other than the route-level check in index.ts.
  if (auth.boundAgentId) return { ok: false, error: 'operator_principal_required' }
  const departmentRef = input.departmentRef.trim()
  const name = input.name.trim()
  if (!departmentRef) return { ok: false, error: 'invalid_args', detail: 'Choose a department.' }
  if (!name) return { ok: false, error: 'invalid_args', detail: 'Name the squad.' }

  const deptResult = await resolveDepartmentRef(env, departmentRef)
  if (!deptResult.ok) return { ok: false, error: 'department_not_found' }
  const dept = deptResult.value

  const grants = auth.capabilities ?? []
  if (!hasCapability(grants, 'department', dept.id, 'admin')) {
    return { ok: false, error: 'forbidden', detail: 'admin on the department is required' }
  }

  const slug = deriveSlugFromName(name)
  if (!slug) {
    return {
      ok: false,
      error: 'invalid_name',
      detail: 'That name has no letters or digits in it, so no identifier could be derived from it.',
    }
  }

  const created = await createSquad(env, dept.id, { slug, name } satisfies SquadInput)
  if (!created.ok) {
    // squads.slug is UNIQUE(department_id, slug), not tenant-global — a collision
    // here only means "this exact name already exists in this department", which
    // slug_taken already says precisely; unlike the agent case there is no
    // bare-slug resolver elsewhere in the codebase that silently mismatches
    // across scopes, so no extra tenant-wide probe is needed.
    return { ok: false, error: created.error }
  }
  await emitOperatorProvisioned(env, auth.memberId as string, 'squad', created.value.id, {
    squad_id: created.value.id,
  })
  return { ok: true, value: { id: created.value.id, slug: created.value.slug, name: created.value.name } }
}

export async function createProjectFlow(
  env: Env,
  auth: AuthContext,
  input: { name: string },
): Promise<FlowResult<{ id: string; slug: string; name: string }>> {
  // Every MCP tool this flow mirrors independently refuses an agent-bound
  // caller (operator_principal_required) rather than relying solely on a
  // shared gate — this flow does the same, so it stays safe if it is ever
  // reached from anywhere other than the route-level check in index.ts.
  if (auth.boundAgentId) return { ok: false, error: 'operator_principal_required' }
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'invalid_args', detail: 'Name the project.' }
  if (!isOrgAdmin(auth)) return { ok: false, error: 'forbidden', detail: 'admin on the org is required' }

  // No slug field on this form at all — createProject already derives one
  // from the name (slugFromProjectName) when input.slug is omitted, and
  // projects.slug is globally UNIQUE (migration 0069), so there is no
  // squad-scoped ambiguity class to guard against here the way there is for
  // agents.
  const created = await createProject(env, { name })
  if (!created.ok) return { ok: false, error: created.error }
  await emitOperatorProjectMutation(env, auth.memberId as string, 'created', created.value.id)
  return { ok: true, value: { id: created.value.id, slug: created.value.slug, name: created.value.name } }
}

export async function linkProjectSquadFlow(
  env: Env,
  auth: AuthContext,
  input: { projectId: string; squadId: string; accessLevel: string },
): Promise<FlowResult<{ projectId: string; squadId: string; accessLevel: string }>> {
  // Every MCP tool this flow mirrors independently refuses an agent-bound
  // caller (operator_principal_required) rather than relying solely on a
  // shared gate — this flow does the same, so it stays safe if it is ever
  // reached from anywhere other than the route-level check in index.ts.
  if (auth.boundAgentId) return { ok: false, error: 'operator_principal_required' }
  const projectId = input.projectId.trim()
  const squadId = input.squadId.trim()
  if (!projectId) return { ok: false, error: 'invalid_args', detail: 'Choose a project.' }
  if (!squadId) return { ok: false, error: 'invalid_args', detail: 'Choose a squad.' }
  if (!isOrgAdmin(auth)) return { ok: false, error: 'forbidden', detail: 'admin on the org is required' }

  const result = await upsertProjectSquadAccess(env, projectId, squadId, input.accessLevel)
  if (!result.ok) return { ok: false, error: result.error }
  await emitOperatorProjectMutation(env, auth.memberId as string, 'squad_access_set', projectId, { squad_id: squadId })
  return { ok: true, value: { projectId, squadId, accessLevel: result.value.access_level } }
}

/**
 * "Set what an agent can access" (requirement 4) is ONE write in this
 * codebase, reached by two MCP tools that gate it differently:
 * grant_agent_capability requires admin on the target squad;
 * squad_member_add requires only lead, plus a rank-ceiling and a self-grant
 * guard (src/members/squad-membership.ts, authorizeSquadMembershipWrite).
 * Both ultimately call commitAgentSquadAccess, which writes `memberships`
 * AND `capabilities` atomically in the same batch — there is no path in this
 * codebase where granting a capability updates one table without the other.
 * This flow calls addSquadMember (squad_member_add's function): its floor is
 * a SUPERSET-SAFE choice for this console — lead is weaker than admin, but
 * the rank-ceiling check inside it means a caller can still never grant more
 * than their OWN standing rank allows, so nothing wider is reachable than
 * grant_agent_capability already permits for an org-admin operator. Using it
 * also means every grant made from this page carries squad_membership's
 * receipt row, which grant_agent_capability's path does not add.
 */
export async function setAgentCapabilityFlow(
  env: Env,
  auth: AuthContext,
  input: { agentRef: string; squadRef: string; capability: string },
): Promise<FlowResult<{ agentId: string; squadId: string; capability: string; result: string }>> {
  // Every MCP tool this flow mirrors independently refuses an agent-bound
  // caller (operator_principal_required) rather than relying solely on a
  // shared gate — this flow does the same, so it stays safe if it is ever
  // reached from anywhere other than the route-level check in index.ts.
  if (auth.boundAgentId) return { ok: false, error: 'operator_principal_required' }
  const agentRef = input.agentRef.trim()
  const squadRef = input.squadRef.trim()
  if (!agentRef) return { ok: false, error: 'invalid_args', detail: 'Choose an agent.' }
  if (!squadRef) return { ok: false, error: 'invalid_args', detail: 'Choose a squad.' }
  if (!isAgentAccessCapability(input.capability)) {
    return { ok: false, error: 'invalid_capability', detail: 'capability must be observer, member, lead, or admin' }
  }
  const capability: AgentAccessCapability = input.capability

  const agentResult = await resolveAgentRef(env, agentRef)
  if (!agentResult.ok) return { ok: false, error: 'agent_not_found' }
  const agent = agentResult.value

  const squadResult = await resolveSquadRef(env, squadRef)
  if (!squadResult.ok) return { ok: false, error: 'squad_not_found' }
  const squad: SquadMembershipTarget = squadResult.value

  const outcome = await addSquadMember({ env, auth, agentId: agent.id, squad, capability })
  if (!outcome.ok) return { ok: false, error: outcome.error }
  return {
    ok: true,
    value: { agentId: agent.id, squadId: squad.id, capability, result: outcome.result },
  }
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface OperatorConsoleNotice {
  kind: 'success' | 'error'
  message: string
}

function noticeHtml(notice?: OperatorConsoleNotice): string {
  if (!notice) return ''
  const cls = notice.kind === 'success' ? 'warn-box' : 'warn-box'
  const prefix = notice.kind === 'success' ? 'Done: ' : 'Not done: '
  const style = notice.kind === 'success'
    ? 'border-color:var(--ok);color:var(--ok)'
    : ''
  return `<div class="${cls}" style="margin-bottom:18px;${style}"><strong>${prefix}</strong>${esc(notice.message)}</div>`
}

function statusDot(status: string): string {
  const color = status === 'active' ? 'var(--ok)' : status === 'paused' ? 'var(--warn, #b45309)' : 'var(--dim)'
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>`
}

function reasonBadge(row: RosterRow): string {
  if (row.eligible) {
    return `<span style="color:var(--ok);font-size:12px;font-weight:600">ELIGIBLE</span>`
  }
  const { label, remedy } = rosterReasonCopy(row)
  return `<span style="color:var(--dim);font-size:12px;font-weight:600">${esc(label).toUpperCase()}</span>
    <p style="margin:4px 0 0;font-size:13px;color:var(--muted)">${esc(remedy)}</p>`
}

function rosterRowAction(row: RosterRow): string {
  if (row.eligible) {
    // Relative link into the EXISTING /enroll page (src/dashboard/enroll.ts),
    // preselecting this agent — same picker, same mint route, no new surface.
    return `<a class="btn secondary sm" href="/enroll?agent=${encodeURIComponent(row.slug)}">Enroll →</a>`
  }
  if (row.reason === 'unminted') {
    // Reuses the EXISTING /enroll/mint route verbatim — same CSRF, same
    // authorizeEnrollMint gate, same mintAgentBoundToken call. This form is
    // not a second mint path; it is a second DOOR to the same one.
    return `
    <form method="post" action="/enroll/mint" style="margin-top:6px">
      <input type="hidden" name="agent_id" value="${esc(row.id)}" />
      <input type="hidden" name="seat" value="operator-console" />
      <button class="btn secondary sm" type="submit">Mint &amp; enroll</button>
    </form>`
  }
  if (row.reason === 'paused') {
    return `<a class="btn secondary sm" href="/agents/${esc(row.id)}">Open agent console →</a>`
  }
  return ''
}

function rosterTable(roster: RosterRow[]): string {
  if (roster.length === 0) {
    return `<div class="card"><p style="margin:0;font-size:14px;color:var(--muted)">No agents exist in this tenant yet. Create one below.</p></div>`
  }
  const rowsHtml = roster.map((row) => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid var(--border-soft)">
        ${statusDot(row.status)}<strong>${esc(row.name)}</strong>
        <div style="font-size:12px;color:var(--dim)"><code class="inline">${esc(row.slug)}</code></div>
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid var(--border-soft);font-size:13px">
        ${esc(row.squad_name)}<div style="font-size:12px;color:var(--dim)">${esc(row.department_name)}</div>
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid var(--border-soft);font-size:13px">
        ${row.bound ? 'minted' : 'unminted'}
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid var(--border-soft);font-size:13px">
        membership: <code class="inline">${esc(row.membership_capability ?? 'none')}</code><br/>
        grant: <code class="inline">${esc(row.grant_capability ?? 'none')}</code>
        ${row.membership_capability && !row.grant_capability
          ? `<div style="color:var(--dim);font-size:12px">no capability grant yet — invisible to squad-scoped messaging</div>`
          : ''}
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid var(--border-soft)">
        ${reasonBadge(row)}
        ${rosterRowAction(row)}
      </td>
    </tr>`).join('')
  return `
  <div class="card" style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="text-align:left;color:var(--dim);font-size:12px;text-transform:uppercase">
          <th style="padding:6px 8px">Agent</th>
          <th style="padding:6px 8px">Squad / department</th>
          <th style="padding:6px 8px">Identity</th>
          <th style="padding:6px 8px">Access on home squad</th>
          <th style="padding:6px 8px">Status</th>
        </tr>
      </thead>
      <tbody>${honoRaw(rowsHtml)}</tbody>
    </table>
  </div>`
}

function squadOptionsHtml(squads: SquadOption[]): string {
  return squads.map((s) => `<option value="${esc(s.id)}">${esc(s.department_name)} / ${esc(s.name)}</option>`).join('')
}

function departmentOptionsHtml(departments: DepartmentOption[]): string {
  return departments.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')
}

function projectOptionsHtml(projects: ProjectOption[]): string {
  return projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.status)})</option>`).join('')
}

function agentOptionsHtml(roster: RosterRow[]): string {
  return roster
    .filter((a) => a.bound)
    .map((a) => `<option value="${esc(a.id)}">${esc(a.name)} — ${esc(a.squad_name)}</option>`)
    .join('')
}

export function operatorConsoleBody(view: OperatorConsoleView, notice?: OperatorConsoleNotice) {
  const unbound = view.roster.filter((r) => !r.bound).length
  const ineligible = view.roster.filter((r) => !r.eligible).length

  return html`
<div class="crumbs"><a href="/">Overview</a> › Operator console</div>
<h1>Operator console</h1>
<p style="color:var(--muted);font-size:14px;max-width:720px;margin-bottom:20px">
  Every agent in this tenant is listed below, including the ones you cannot
  use yet — each with why, and what fixes it. Nothing here mints or reveals a
  credential except by handing off to <a href="/enroll">/enroll</a>, exactly
  as before.
</p>

${honoRaw(noticeHtml(notice))}

<h2>Roster${view.roster.length > 0 ? ` (${view.roster.length} agent${view.roster.length === 1 ? '' : 's'}, ${ineligible} not yet usable${unbound > 0 ? `, ${unbound} unminted` : ''})` : ''}</h2>
${honoRaw(rosterTable(view.roster))}

<h2 style="margin-top:28px">Create an agent</h2>
<div class="card" style="margin-bottom:18px">
  <p style="margin:0 0 12px;font-size:13px;color:var(--muted)">
    The slug is derived from the name — it is never a form field, because a
    caller-chosen agent slug is how <code class="inline">deactivate_agent</code>'s
    cleanup sweep silently skips a retirement (this fired in production).
  </p>
  <form method="post" action="/operator/agents">
    <label>Squad
      <select name="squad" required style="min-width:260px;margin-top:6px">${honoRaw(squadOptionsHtml(view.squads))}</select>
    </label>
    <label style="margin-left:16px">Name
      <input name="name" required maxlength="128" style="min-width:220px;margin-top:6px" />
    </label>
    <div style="margin-top:14px"><button class="btn" type="submit">Create agent</button></div>
  </form>
</div>

<h2>Create a squad</h2>
<div class="card" style="margin-bottom:18px">
  <form method="post" action="/operator/squads">
    <label>Department
      <select name="department" required style="min-width:260px;margin-top:6px">${honoRaw(departmentOptionsHtml(view.departments))}</select>
    </label>
    <label style="margin-left:16px">Name
      <input name="name" required maxlength="128" style="min-width:220px;margin-top:6px" />
    </label>
    <div style="margin-top:14px"><button class="btn" type="submit">Create squad</button></div>
  </form>
</div>

<h2>Create a project</h2>
<div class="card" style="margin-bottom:18px">
  <form method="post" action="/operator/projects">
    <label>Name
      <input name="name" required maxlength="128" style="min-width:220px;margin-top:6px" />
    </label>
    <div style="margin-top:14px"><button class="btn" type="submit">Create project</button></div>
  </form>
</div>

<h2>Link a project to a squad</h2>
<div class="card" style="margin-bottom:18px">
  <form method="post" action="/operator/projects/link">
    <label>Project
      <select name="project_id" required style="min-width:220px;margin-top:6px">${honoRaw(projectOptionsHtml(view.projects))}</select>
    </label>
    <label style="margin-left:16px">Squad
      <select name="squad_id" required style="min-width:220px;margin-top:6px">${honoRaw(squadOptionsHtml(view.squads))}</select>
    </label>
    <label style="margin-left:16px">Access
      <select name="access_level" required style="margin-top:6px">
        <option value="read">read</option>
        <option value="write" selected>write</option>
        <option value="admin">admin</option>
      </select>
    </label>
    <div style="margin-top:14px"><button class="btn" type="submit">Link</button></div>
  </form>
</div>

<h2>Set what an agent can access</h2>
<div class="card" style="margin-bottom:18px">
  <p style="margin:0 0 12px;font-size:13px;color:var(--muted)">
    Only minted agents are listed — an unminted agent has no member identity
    to grant a capability to yet; mint it from the roster above first.
  </p>
  <form method="post" action="/operator/capability">
    <label>Agent
      <select name="agent" required style="min-width:220px;margin-top:6px">${honoRaw(agentOptionsHtml(view.roster))}</select>
    </label>
    <label style="margin-left:16px">Squad
      <select name="squad" required style="min-width:220px;margin-top:6px">${honoRaw(squadOptionsHtml(view.squads))}</select>
    </label>
    <label style="margin-left:16px">Capability
      <select name="capability" required style="margin-top:6px">
        <option value="observer">observer</option>
        <option value="member" selected>member</option>
        <option value="lead">lead</option>
        <option value="admin">admin</option>
      </select>
    </label>
    <div style="margin-top:14px"><button class="btn" type="submit">Set capability</button></div>
  </form>
</div>`
}

// ── error → operator-facing copy ─────────────────────────────────────────────
//
// Every flow above already writes a human `detail` for the errors it can say
// something specific about (a bad name, a slug collision naming the squad
// that holds it, a missing selection). This is the fallback for error codes
// that bubble straight up from the shared service functions (entitlement
// limits, rank-ceiling refusals, the unminted-identity guard) — named here
// once so every route gets the same wording instead of each handler
// inventing its own.
const FLOW_ERROR_COPY: Record<string, string> = {
  squad_not_found: 'That squad could not be found — reload the page and try again.',
  department_not_found: 'That department could not be found — reload the page and try again.',
  agent_not_found: 'That agent could not be found — reload the page and try again.',
  project_not_found: 'That project could not be found — reload the page and try again.',
  invalid_slug: 'The derived identifier was not valid — try a different name.',
  slug_taken: 'That name is already taken — pick a more distinct one.',
  department_limit_reached: "This tenant's plan has reached its department limit.",
  squad_limit_reached: "This tenant's plan has reached its squad limit.",
  agent_limit_reached: "This tenant's plan has reached its agent limit.",
  invalid_capability: 'capability must be observer, member, lead, or admin.',
  agent_identity_unminted: 'This agent has never been minted — mint it from the roster above first.',
  self_grant: 'You cannot grant or change access for the agent identity bound to your own session.',
  cannot_grant_above_own_rank: 'You cannot grant a capability higher than your own standing rank.',
  cannot_affect_higher_rank: "You cannot change an agent's access when it already outranks you on that squad.",
  missing_member_identity: 'No member identity resolved for this session.',
  home_squad_immutable: "An agent's access on its own home squad cannot be changed this way.",
  receipt_failed: 'The write could not be confirmed — nothing was changed. Try again.',
  invalid_access_level: 'Access level must be read, write, or admin.',
  archived_project: 'That project is archived and cannot be linked.',
  agent_identity_conflict: 'This agent is bound to a different member identity than expected.',
}

export function describeOperatorFlowError(error: string, detail?: string): string {
  if (detail) return detail
  return FLOW_ERROR_COPY[error] ?? `Refused (${error}).`
}
