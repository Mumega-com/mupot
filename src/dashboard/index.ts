// mupot — dashboard (server-rendered HTML console, no build step).
//
// This is the SUBSTRATE UI: it shows org STRUCTURE (departments → squads →
// agents), a squad board, and a per-agent console with a 'wake' button. It is
// NOT the tenant's business content — the pot, not the plant.
//
// dashboardApp — mounted at ROUTES.dashboard ('/'):
//   GET /                  org overview (dept → squad → agent tree)
//   GET /squads/:id        squad board (charter + agents + tasks)
//   GET /agents/:id        agent console (status + a 'wake' button)
//
// Auth: gated by requireAuth. Because these are HTML pages (not an API),
// unauthenticated requests are REDIRECTED to /auth/login rather than handed a
// 401 JSON body. We run the auth component's requireAuth and, if it produced an
// unauthenticated (4xx) response, swap it for a redirect.
//
// Data: rendered directly from this tenant's D1 (env.DB). One pot = one DB, so
// the org tables carry no tenant column; we still HARD GUARD that the caller's
// AuthContext.tenant matches env.TENANT_SLUG so a misrouted token can never read
// another pot. The wake action is performed by the browser POSTing to the
// RBAC-gated /api/agents/:id/wake endpoint owned by the agents component.

import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type {
  Env,
  AuthContext,
  Department,
  Squad,
  Agent,
  Membership,
  Task,
  Member,
  CapabilityGrant,
  Capability,
  CapabilityScopeType,
  ConnectionChannel,
} from '../types'

import { requireAuth } from '../auth'
// Fine-grained RBAC — the dashboard's mutating handlers reuse the SAME gates the
// JSON API uses (admin on org for tokens / departments; admin on the department for
// a squad; lead on the squad for an agent). Identity is always server-derived.
import { resolveCapabilities, hasCapability } from '../auth/capability'

// Shared creation paths — the dashboard handlers call the SAME service functions
// the /api routes call, never re-implementing the write/validation logic.
import { createDepartment, createSquad, createAgent } from '../org/service'
import { mintMemberToken, revokeMemberToken, loadLiveTokens, isChannel } from '../members/service'
import type { MintedToken, PublicMemberToken } from '../members/service'

// Connect-config builders (pure) for the Connect card.
import { mcpEndpoint, claudeCodeSnippet, codexSnippet } from './connect'
import { loadApprovals, resultPreview } from './approvals'
import type { ApprovalItem } from './approvals'

// First-run setup wizard (the easy-onboard centerpiece). Mounted under '/setup'
// on this same dashboard app, so it inherits the auth + tenant guard below.
import { wizardApp } from './wizard'
import { isOnboardingComplete } from './settings'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export const dashboardApp = new Hono<AppEnv>()

// ── browser-surface hardening ─────────────────────────────────────────────────
// CSRF: every mutating dashboard route is a cookie-authenticated HTML-form POST.
// SameSite=Lax already blocks cross-site POSTs; hono/csrf adds an Origin check so
// Lax is never the single line of defense on token minting (adversarial WARN-1).
dashboardApp.use('*', csrf())

// Authenticated UI: never cache (the show-once token page especially must not
// survive in any shared/proxy/back-button cache), never leak Referer off-origin.
dashboardApp.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
})

// ── auth gate (redirect HTML callers to login instead of 401 JSON) ───────────

dashboardApp.use('*', async (c, next) => {
  // Run the shared requireAuth. It either sets c.get('auth') and calls next(),
  // or short-circuits with a 401 JSON response (no auth populated).
  let proceeded = false
  await requireAuth(c, async () => {
    proceeded = true
  })
  if (!proceeded || !c.get('auth')) {
    // Unauthenticated → send the browser to the login flow.
    return c.redirect('/auth/login')
  }
  // Hard tenant guard: the DB is per-tenant, but a stolen/misrouted token must
  // never render another pot's structure.
  const auth = c.get('auth')
  if (auth.tenant !== c.env.TENANT_SLUG) {
    return c.html(shell(c.env.BRAND, 'Forbidden', errorBody('This session is not scoped to this org.')), 403)
  }
  await next()
})

// ── setup wizard ─────────────────────────────────────────────────────────────
// Mounted on the authenticated, tenant-guarded dashboard app. The wizard enforces
// its own owner-only gate (org role 'owner' OR org-capability 'owner') internally.
dashboardApp.route('/setup', wizardApp)

// ── routes ───────────────────────────────────────────────────────────────────

// GET / — org overview: departments → squads → agents.
dashboardApp.get('/', async (c) => {
  const auth = c.get('auth')
  // First-run nudge: an owner landing on an un-onboarded pot goes straight to the
  // wizard. Non-owners (and completed pots) see the normal overview. The wizard
  // itself re-checks owner + completion, so this is a convenience redirect only.
  if ((auth.role === 'owner' || hasOrgOwnerCapability(auth)) && !(await isOnboardingComplete(c.env))) {
    return c.redirect('/setup')
  }
  const tree = await loadTree(c.env)
  const origin = new URL(c.req.url).origin
  return c.html(
    shell(c.env.BRAND, 'Overview', overviewBody(c.env.BRAND, c.env.TENANT_SLUG, origin, tree, auth)),
  )
})

// GET /send — the "Send a task" page. The last mile: a person writes a task,
// picks one of their agents, submits, and watches it get done. The form POSTs to
// the RBAC-gated /api/tasks (dispatch:true) and polls GET /api/tasks/:id. All auth
// + CSRF + no-store/Referrer-Policy come from the dashboard middleware above.
dashboardApp.get('/send', async (c) => {
  const agents = await loadActiveAgentsWithSquad(c.env)
  return c.html(shell(c.env.BRAND, 'Send a task', sendPageBody(agents)))
})

// GET /approvals — the gate queue (#6). Tasks in 'review' the caller may
// verdict (owner/admin: all; others: gate_grants visibility == authority).
// Buttons POST to the existing RBAC'd /api/tasks/:id/verdict — this page adds
// no new write path.
dashboardApp.get('/approvals', async (c) => {
  const items = await loadApprovals(c.env, c.get('auth'))
  return c.html(shell(c.env.BRAND, 'Approvals', approvalsBody(items)))
})

// GET /squads/:id — squad board: charter, agents, tasks by lane.
dashboardApp.get('/squads/:id', async (c) => {
  const squadId = c.req.param('id')
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) {
    return c.html(shell(c.env.BRAND, 'Squad', errorBody('Squad not found.')), 404)
  }
  const [agents, tasks] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents WHERE squad_id = ? ORDER BY created_at ASC, slug ASC',
    )
      .bind(squadId)
      .all<Agent>(),
    c.env.DB.prepare(
      `SELECT id, squad_id, title, body, status, assignee_agent_id, github_issue_url, result, completed_at, created_at, updated_at
         FROM tasks WHERE squad_id = ? ORDER BY updated_at DESC`,
    )
      .bind(squadId)
      .all<Task>(),
  ])
  const auth = c.get('auth')
  const canAddAgent = await canOnSquad(c.env, auth, squadId)
  return c.html(
    shell(
      c.env.BRAND,
      `Squad · ${squad.name}`,
      squadBoardBody(squad, agents.results ?? [], tasks.results ?? [], canAddAgent),
    ),
  )
})

// GET /agents/:id — agent console: identity, status, wake button.
dashboardApp.get('/agents/:id', async (c) => {
  const agentId = c.req.param('id')
  const agent = await getById<Agent>(c.env, 'agents', agentId)
  if (!agent) {
    return c.html(shell(c.env.BRAND, 'Agent', errorBody('Agent not found.')), 404)
  }
  const squad = await getById<Squad>(c.env, 'squads', agent.squad_id)
  const auth = c.get('auth')
  // Mirror the wake API's real gate (lead+ on the agent's squad) so squad leads
  // see a working button — the API re-checks server-side either way.
  const canWake = await canOnSquad(c.env, auth, agent.squad_id)
  return c.html(
    shell(c.env.BRAND, `Agent · ${agent.name}`, agentConsoleBody(agent, squad, canWake)),
  )
})

// ── members + divisions admin (humans as first-class network nodes) ───────────
//
// These two views are ADMIN-only (org role owner|admin). The mutating actions are
// NOT performed here — every button POSTs to the RBAC-gated member-admin API
// (/api/members/*), which re-checks fine-grained capability server-side. The
// dashboard only renders structure (read directly from this pot's D1) and the
// forms; it never trusts client-supplied identity or duplicates the API's writes.

// GET /admin/members — roster: each member, their capability grants, their live
// connection channels, suspend/reactivate, grant-capability + invite forms.
dashboardApp.get('/admin/members', async (c) => {
  const auth = c.get('auth')
  if (!isAdmin(auth)) {
    return c.html(
      shell(c.env.BRAND, 'Members', errorBody('Members admin requires owner or admin.')),
      403,
    )
  }
  const [members, grants, channels, depts] = await Promise.all([
    loadMembers(c.env),
    loadGrants(c.env),
    loadChannels(c.env),
    loadDepartments(c.env),
  ])
  const scopeNames = await loadScopeNames(c.env)
  return c.html(
    shell(
      c.env.BRAND,
      'Members',
      membersAdminBody(members, grants, channels, depts, scopeNames, auth),
    ),
  )
})

// GET /admin/divisions — departments → squads, each with its head(s): the
// member(s) holding lead+ capability on that scope.
dashboardApp.get('/admin/divisions', async (c) => {
  const auth = c.get('auth')
  if (!isAdmin(auth)) {
    return c.html(
      shell(c.env.BRAND, 'Divisions', errorBody('Divisions admin requires owner or admin.')),
      403,
    )
  }
  const [depts, squads, grants, members] = await Promise.all([
    loadDepartments(c.env),
    loadSquads(c.env),
    loadGrants(c.env),
    loadMembers(c.env),
  ])
  return c.html(
    shell(c.env.BRAND, 'Divisions', divisionsAdminBody(depts, squads, grants, members, auth)),
  )
})

// ── members page (GET) + token mint/revoke (POST-redirect-GET) ────────────────
//
// A focused roster: each member, their live channels, their live tokens, and
// (admin+) a mint form + per-token revoke. The Connect card on the overview shows
// the config snippet with a <MEMBER_TOKEN> placeholder; here a raw token is shown
// EXACTLY ONCE on the mint result page and never persisted/redirected. Mint + revoke
// reuse the shared members service AND the SAME org-admin gate the JSON API uses.

// GET /members — roster with mint + revoke (forms hidden for non-admins).
dashboardApp.get('/members', async (c) => {
  const auth = c.get('auth')
  const canManage = await canOnOrg(c.env, auth, 'admin')
  const [members, channels, tokens] = await Promise.all([
    loadMembers(c.env),
    loadChannels(c.env),
    loadLiveTokens(c.env),
  ])
  return c.html(
    shell(c.env.BRAND, 'Members', membersPageBody(members, channels, tokens, canManage, auth)),
  )
})

// POST /members/:id/tokens — mint a scoped token, then render the SHOW-ONCE page.
// We do NOT redirect (the raw token must not survive past this one response).
dashboardApp.post('/members/:id/tokens', async (c) => {
  const auth = c.get('auth')
  if (!(await canOnOrg(c.env, auth, 'admin'))) {
    return c.html(shell(c.env.BRAND, 'Members', errorBody('Minting a token requires admin.')), 403)
  }
  const memberId = c.req.param('id')
  const member = await c.env.DB.prepare('SELECT id, display_name FROM members WHERE id = ? LIMIT 1')
    .bind(memberId)
    .first<{ id: string; display_name: string }>()
  if (!member) {
    return c.html(shell(c.env.BRAND, 'Members', errorBody('Member not found.')), 404)
  }

  const form = await c.req.parseBody()
  const labelRaw = typeof form.label === 'string' ? form.label : ''
  if (labelRaw.length > 64) {
    return c.html(shell(c.env.BRAND, 'Members', errorBody('Label too long (max 64 chars).')), 400)
  }
  const channelRaw = typeof form.channel === 'string' ? form.channel : 'workspace'
  if (!isChannel(channelRaw)) {
    return c.html(shell(c.env.BRAND, 'Members', errorBody('Invalid channel.')), 400)
  }

  // Shared mint path — raw returned once, only the hash persisted.
  const minted = await mintMemberToken(c.env, memberId, labelRaw, channelRaw)
  const origin = new URL(c.req.url).origin
  return c.html(
    shell(c.env.BRAND, 'Token minted', tokenShowOnceBody(c.env.TENANT_SLUG, origin, member.display_name, minted)),
  )
})

// POST /members/:id/tokens/:tid/revoke — revoke a token (HTML forms can't DELETE).
dashboardApp.post('/members/:id/tokens/:tid/revoke', async (c) => {
  const auth = c.get('auth')
  if (!(await canOnOrg(c.env, auth, 'admin'))) {
    return c.html(shell(c.env.BRAND, 'Members', errorBody('Revoking a token requires admin.')), 403)
  }
  await revokeMemberToken(c.env, c.req.param('id'), c.req.param('tid'))
  // Idempotent — whether or not a live token matched, land back on the roster.
  return c.redirect('/members')
})

// ── org management (POST-redirect-GET) — create department / squad / agent ────
// Each handler runs the SAME fine-grained gate the JSON API uses, then calls the
// SAME shared service. On error we re-render the relevant page with a message.

// POST /departments — create a department (org admin+).
dashboardApp.post('/departments', async (c) => {
  const auth = c.get('auth')
  if (!(await canOnOrg(c.env, auth, 'admin'))) {
    return c.html(shell(c.env.BRAND, 'Overview', errorBody('Creating a department requires admin.')), 403)
  }
  const form = await c.req.parseBody()
  const result = await createDepartment(c.env, { slug: form.slug, name: form.name })
  if (!result.ok) {
    return c.html(
      shell(c.env.BRAND, 'Overview', errorBody(`Could not create department: ${result.error}.`)),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  return c.redirect('/')
})

// POST /squads — create a squad in a department (admin on THAT department).
dashboardApp.post('/squads', async (c) => {
  const auth = c.get('auth')
  const form = await c.req.parseBody()
  const departmentId = typeof form.department_id === 'string' ? form.department_id : ''
  if (!departmentId) {
    return c.html(shell(c.env.BRAND, 'Overview', errorBody('Pick a department for the squad.')), 400)
  }
  const dept = await getById<Department>(c.env, 'departments', departmentId)
  if (!dept) {
    return c.html(shell(c.env.BRAND, 'Overview', errorBody('Department not found.')), 404)
  }
  if (!(await canOnDepartment(c.env, auth, departmentId))) {
    return c.html(
      shell(c.env.BRAND, 'Overview', errorBody('Creating a squad requires admin on that department.')),
      403,
    )
  }
  const result = await createSquad(c.env, departmentId, {
    slug: form.slug,
    name: form.name,
    charter: form.charter,
  })
  if (!result.ok) {
    return c.html(
      shell(c.env.BRAND, 'Overview', errorBody(`Could not create squad: ${result.error}.`)),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  return c.redirect('/')
})

// POST /squads/:id/agents — add an agent to a squad (lead+ on THAT squad).
dashboardApp.post('/squads/:id/agents', async (c) => {
  const auth = c.get('auth')
  const squadId = c.req.param('id')
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) {
    return c.html(shell(c.env.BRAND, 'Squad', errorBody('Squad not found.')), 404)
  }
  if (!(await canOnSquad(c.env, auth, squadId))) {
    return c.html(
      shell(c.env.BRAND, `Squad · ${squad.name}`, errorBody('Adding an agent requires lead on this squad.')),
      403,
    )
  }
  const form = await c.req.parseBody()
  const result = await createAgent(c.env, squadId, {
    slug: form.slug,
    name: form.name,
    role: form.role,
    model: form.model,
  })
  if (!result.ok) {
    return c.html(
      shell(
        c.env.BRAND,
        `Squad · ${squad.name}`,
        errorBody(`Could not add agent: ${result.error}.`),
      ),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  return c.redirect(`/squads/${squadId}`)
})

// ── data ───────────────────────────────────────────────────────────────────

interface AgentNode extends Agent {
  memberships: Membership[]
}
interface SquadNode extends Squad {
  agents: AgentNode[]
}
interface DepartmentNode extends Department {
  squads: SquadNode[]
}

/** Assemble the full org chart in-memory from four scans (one small pot). */
async function loadTree(env: Env): Promise<DepartmentNode[]> {
  const [depts, squads, agents, memberships] = await Promise.all([
    env.DB.prepare('SELECT id, slug, name, created_at FROM departments').all<Department>(),
    env.DB.prepare(
      'SELECT id, department_id, slug, name, charter, created_at FROM squads',
    ).all<Squad>(),
    env.DB.prepare(
      'SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents',
    ).all<Agent>(),
    env.DB.prepare('SELECT id, agent_id, squad_id, capability FROM memberships').all<Membership>(),
  ])

  const membershipsByAgent = new Map<string, Membership[]>()
  for (const m of memberships.results ?? []) {
    const list = membershipsByAgent.get(m.agent_id) ?? []
    list.push(m)
    membershipsByAgent.set(m.agent_id, list)
  }
  const agentsBySquad = new Map<string, AgentNode[]>()
  for (const a of agents.results ?? []) {
    const node: AgentNode = { ...a, memberships: membershipsByAgent.get(a.id) ?? [] }
    const list = agentsBySquad.get(a.squad_id) ?? []
    list.push(node)
    agentsBySquad.set(a.squad_id, list)
  }
  const squadsByDept = new Map<string, SquadNode[]>()
  for (const s of squads.results ?? []) {
    const node: SquadNode = { ...s, agents: agentsBySquad.get(s.id) ?? [] }
    const list = squadsByDept.get(s.department_id) ?? []
    list.push(node)
    squadsByDept.set(s.department_id, list)
  }
  return (depts.results ?? []).map((d) => ({ ...d, squads: squadsByDept.get(d.id) ?? [] }))
}

type DashTable = 'departments' | 'squads' | 'agents'
async function getById<T>(env: Env, table: DashTable, id: string): Promise<T | null> {
  // table is an internal allow-listed literal — never caller-supplied.
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<T>()
  return row ?? null
}

// ── members / divisions data ──────────────────────────────────────────────────
//
// All reads are direct against this pot's D1 (one DB per tenant). The dashboard
// renders STRUCTURE only — the member-admin API owns every write.

/** admin+ means org role owner or admin. The coarse gate available server-side
 *  for HTML rendering; the API re-checks fine-grained capability on each write. */
function isAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

/** Synchronous owner check for the first-run nudge ONLY — reads the org 'owner'
 *  grant already resolved onto the AuthContext (no DB hit). The wizard does the
 *  authoritative async check (resolveCapabilities); this is a convenience so a
 *  member-authn owner is nudged too without an extra query on every overview load. */
function hasOrgOwnerCapability(auth: AuthContext): boolean {
  return (auth.capabilities ?? []).some(
    (g) => g.scope_type === 'org' && g.scope_id === null && g.capability === 'owner',
  )
}

// ── write-gates (mirror src/org exactly so the dashboard never WIDENS the API) ──
// These are the authoritative, async, fine-grained checks the dashboard's POST
// handlers run before any mutation. They replicate the org API's gate logic 1:1:
// org-admin → departments + tokens; admin-on-department → squads; lead-on-squad →
// agents (with department→squad inheritance). isAdmin() doubles as the legacy
// owner/admin escape, identical to requireCapability's.

/** Resolve a squad's department for department→squad capability inheritance. */
async function squadDepartment(env: Env, squadId: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT department_id FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ department_id: string }>()
  return r?.department_id ?? null
}

/** org-scope capability gate (e.g. minting a token / creating a department → admin). */
async function canOnOrg(env: Env, auth: AuthContext, min: 'admin' | 'owner'): Promise<boolean> {
  if (isAdmin(auth)) return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  return hasCapability(grants, 'org', null, min)
}

/** department-scope gate (creating a squad → admin on THAT department). */
async function canOnDepartment(
  env: Env,
  auth: AuthContext,
  departmentId: string,
): Promise<boolean> {
  if (isAdmin(auth)) return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  return hasCapability(grants, 'department', departmentId, 'admin')
}

/** squad-scope gate (creating an agent → lead on THAT squad, dept grants inherit). */
async function canOnSquad(env: Env, auth: AuthContext, squadId: string): Promise<boolean> {
  if (isAdmin(auth)) return true
  if (!auth.memberId) return false
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  const deptId = await squadDepartment(env, squadId)
  return hasCapability(grants, 'squad', squadId, 'lead', deptId)
}

async function loadMembers(env: Env): Promise<Member[]> {
  const rows = await env.DB.prepare(
    'SELECT id, email, display_name, telegram_chat_id, status, created_at FROM members ORDER BY created_at ASC, display_name ASC',
  ).all<Member>()
  return rows.results ?? []
}

async function loadGrants(env: Env): Promise<CapabilityGrant[]> {
  const rows = await env.DB.prepare(
    `SELECT member_id, scope_type, scope_id, capability
       FROM capabilities
     UNION ALL
     SELECT member_id, 'squad' AS scope_type, squad_id AS scope_id, capability
       FROM channel_capability_grants`,
  ).all<CapabilityGrant>()
  return rows.results ?? []
}

interface MemberChannel {
  member_id: string
  channel: ConnectionChannel
}

/** Live (non-revoked) connection channels per member, derived from member_tokens. */
async function loadChannels(env: Env): Promise<MemberChannel[]> {
  const rows = await env.DB.prepare(
    'SELECT DISTINCT member_id, channel FROM member_tokens WHERE revoked_at IS NULL',
  ).all<MemberChannel>()
  return rows.results ?? []
}

async function loadDepartments(env: Env): Promise<Department[]> {
  const rows = await env.DB.prepare(
    'SELECT id, slug, name, created_at FROM departments ORDER BY created_at ASC, name ASC',
  ).all<Department>()
  return rows.results ?? []
}

async function loadSquads(env: Env): Promise<Squad[]> {
  const rows = await env.DB.prepare(
    'SELECT id, department_id, slug, name, charter, created_at FROM squads ORDER BY created_at ASC, name ASC',
  ).all<Squad>()
  return rows.results ?? []
}

/** Active agents joined to their squad name — the /send agent picker. One pot is
 *  small, so a single join is fine. Returns a flat list with a squad label. */
interface PickerAgent {
  id: string
  name: string
  role: string
  squad_id: string
  squad_name: string
}
async function loadActiveAgentsWithSquad(env: Env): Promise<PickerAgent[]> {
  const rows = await env.DB.prepare(
    `SELECT a.id AS id, a.name AS name, a.role AS role, a.squad_id AS squad_id, s.name AS squad_name
       FROM agents a JOIN squads s ON s.id = a.squad_id
      WHERE a.status = 'active'
      ORDER BY s.name ASC, a.name ASC`,
  ).all<PickerAgent>()
  return rows.results ?? []
}

/** id → display name for department & squad scopes, so grants read as names not uuids. */
async function loadScopeNames(env: Env): Promise<Map<string, string>> {
  const [depts, squads] = await Promise.all([loadDepartments(env), loadSquads(env)])
  const m = new Map<string, string>()
  for (const d of depts) m.set(d.id, d.name)
  for (const s of squads) m.set(s.id, s.name)
  return m
}

// ── views ────────────────────────────────────────────────────────────────────

const TASK_LANES: ReadonlyArray<{ key: Task['status']; label: string }> = [
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
]

/** Outer HTML document with inline CSS (no framework, no build step). */
function shell(brand: string, title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · ${brand}</title>
    <style>
      :root {
        --bg: #0e1116; --surface: #161b22; --surface2: #1c2230; --border: #2a3140;
        --text: #e6edf3; --muted: #9aa7b5; --dim: #6b7685; --accent: #d4a017; --accent2: #06b6d4;
        --ok: #3fb950; --warn: #d29922; --radius: 10px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; background: var(--bg); color: var(--text);
        font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      a { color: var(--accent2); text-decoration: none; }
      a:hover { text-decoration: underline; }
      header.top {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--surface);
        position: sticky; top: 0; z-index: 5;
      }
      header.top .brand { font-weight: 700; letter-spacing: .3px; color: var(--text); }
      header.top .brand b { color: var(--accent); }
      header.top nav a { margin-left: 18px; color: var(--muted); font-size: 14px; }
      main { max-width: 1080px; margin: 0 auto; padding: 28px 24px 64px; }
      h1 { font-size: 22px; margin: 0 0 4px; }
      h2 { font-size: 16px; margin: 28px 0 12px; color: var(--text); }
      .crumbs { color: var(--dim); font-size: 13px; margin-bottom: 18px; }
      .crumbs a { color: var(--muted); }
      .card {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 16px 18px; margin: 12px 0;
      }
      .dept > .dept-name { font-size: 15px; font-weight: 600; color: var(--accent); margin-bottom: 8px; }
      .squad-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
        background: var(--surface2); margin: 8px 0;
      }
      .squad-row .meta { color: var(--muted); font-size: 13px; }
      .agents { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .chip {
        display: inline-flex; align-items: center; gap: 7px;
        padding: 5px 11px; border-radius: 999px; border: 1px solid var(--border);
        background: var(--bg); font-size: 13px; color: var(--text);
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
      .dot.active { background: var(--ok); }
      .dot.paused { background: var(--dim); }
      .board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
      .lane { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; min-height: 80px; }
      .lane h3 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
      .task { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; margin-bottom: 8px; font-size: 13px; }
      .task .t-title { font-weight: 600; }
      .task .t-meta { color: var(--dim); font-size: 12px; margin-top: 3px; }
      .kv { display: grid; grid-template-columns: 140px 1fr; gap: 6px 14px; font-size: 14px; }
      .kv dt { color: var(--muted); }
      .kv dd { margin: 0; }
      .charter { white-space: pre-wrap; color: var(--muted); font-size: 14px; }
      .btn {
        appearance: none; cursor: pointer; font: inherit; font-weight: 600;
        padding: 9px 18px; border-radius: 8px; border: 1px solid var(--accent);
        background: var(--accent); color: #1b1402;
      }
      .btn:disabled { opacity: .5; cursor: not-allowed; }
      .btn.secondary { background: transparent; color: var(--accent); }
      .status-line { margin-top: 12px; font-size: 13px; color: var(--muted); min-height: 18px; }
      .empty { color: var(--dim); font-size: 14px; padding: 8px 0; }
      .tag { font-size: 11px; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--border); color: var(--muted); }
      .tag.cap { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
      .tag.chan { color: var(--accent2); border-color: color-mix(in srgb, var(--accent2) 40%, var(--border)); }
      table.grid { width: 100%; border-collapse: collapse; font-size: 14px; }
      table.grid th, table.grid td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
      table.grid th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; }
      table.grid tr:last-child td { border-bottom: none; }
      table.grid td.actions { white-space: nowrap; }
      .adminform { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: end; }
      .adminform label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
      .adminform input, .adminform select {
        font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
        background: var(--bg); color: var(--text); min-width: 180px;
      }
      .btn.sm { padding: 5px 11px; font-size: 12px; margin-right: 6px; }
      .modal {
        position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex;
        align-items: center; justify-content: center; z-index: 20; padding: 20px;
      }
      .modal[hidden] { display: none; }
      .modal-card {
        background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
        padding: 20px 22px; max-width: 460px; width: 100%;
      }
      .modal-actions { display: flex; gap: 10px; margin-top: 4px; width: 100%; }
      pre.snippet {
        background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
        padding: 12px 14px; overflow-x: auto; font-size: 12.5px; line-height: 1.5;
        color: var(--text); margin: 6px 0 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      code.inline { background: var(--surface2); border: 1px solid var(--border);
        border-radius: 6px; padding: 1px 6px; font-size: 13px; color: var(--text); }
      code.token {
        display: block; word-break: break-all; background: var(--bg);
        border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
        border-radius: 8px; padding: 12px 14px; font-size: 13px; color: var(--accent);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .warn-box {
        border: 1px solid color-mix(in srgb, #f85149 50%, var(--border));
        background: color-mix(in srgb, #f85149 10%, var(--surface));
        color: #ffb4ab; border-radius: 8px; padding: 12px 14px; font-size: 13px; margin: 12px 0;
      }
      .warn-box strong { color: #ff7b72; }
      .tokenline { display: flex; align-items: center; gap: 8px; margin: 4px 0; flex-wrap: wrap; }
      .tokenline .lbl { font-size: 13px; }
      @media (max-width: 720px) { .board { grid-template-columns: 1fr 1fr; } }
    </style>
  </head>
  <body>
    <header class="top">
      <div class="brand"><b>${brand}</b> · substrate console</div>
      <nav>
        <a href="/">Overview</a>
        <a href="/send">Send a task</a>
        <a href="/approvals">Approvals</a>
        <a href="/members">Members</a>
        <a href="/admin/divisions">Divisions</a>
        <a href="/setup">Setup</a>
        <a href="/auth/logout">Sign out</a>
      </nav>
    </header>
    <main>${body}</main>
  </body>
</html>`
}

function errorBody(message: string) {
  return html`<h1>Hmm.</h1><p class="empty">${message}</p><p><a href="/">← Back to overview</a></p>`
}

function statusDot(status: Agent['status']) {
  return html`<span class="dot ${status === 'active' ? 'active' : 'paused'}"></span>`
}

function agentChip(a: Agent) {
  return html`<a class="chip" href="/agents/${a.id}">${statusDot(a.status)}${a.name}<span class="tag">${a.role}</span></a>`
}

// The Connect card — how a member points their own workspace at this pot. Shown to
// EVERY authenticated user. The snippets carry a `<MEMBER_TOKEN>` placeholder only;
// a real token comes from the Members → Mint flow (show-once). The endpoint is
// derived from the request origin, never hardcoded.
function connectCard(slug: string, origin: string) {
  return html`
    <div class="card">
      <h2 style="margin-top:0">Connect your workspace</h2>
      <p class="empty" style="margin-top:0">Point Claude Code or Codex at this pot over MCP. The
        endpoint is <code class="inline">${mcpEndpoint(origin)}</code>. Get a token from
        <a href="/members">Members → Mint token</a>, then paste it where you see
        <code class="inline">&lt;MEMBER_TOKEN&gt;</code>.</p>
      <h3 style="font-size:13px;color:var(--muted);margin:14px 0 0">Claude Code · <code class="inline">.mcp.json</code></h3>
      <pre class="snippet">${claudeCodeSnippet(slug, origin)}</pre>
      <h3 style="font-size:13px;color:var(--muted);margin:14px 0 0">Codex · <code class="inline">~/.codex/config.toml</code></h3>
      <pre class="snippet">${codexSnippet(slug, origin)}</pre>
    </div>`
}

// Inline create-department + create-squad forms (admin+). Plain HTML POST →
// /departments and /squads (POST-redirect-GET) — no client framework. The squad
// form's department <select> is built server-side from the current tree.
function orgCreateForms(tree: DepartmentNode[]) {
  const deptOptions = tree
    .map((d) => `<option value="${escAttr(d.id)}">${escHtml(d.name)}</option>`)
    .join('')
  const squadForm =
    tree.length === 0
      ? html`<p class="empty">Create a department first, then you can add squads to it.</p>`
      : html`
          <form class="adminform" method="post" action="/squads" autocomplete="off">
            <label>Department
              <select name="department_id" required>${raw(deptOptions)}</select>
            </label>
            <label>Squad name
              <input name="name" required placeholder="Dispatch" />
            </label>
            <label>Slug
              <input name="slug" required placeholder="dispatch" />
            </label>
            <label>Charter (optional)
              <input name="charter" placeholder="What this squad owns" />
            </label>
            <button type="submit" class="btn">Add squad</button>
          </form>`
  return html`
    <h2>Build the org</h2>
    <div class="card">
      <h3 style="font-size:13px;color:var(--muted);margin:0 0 8px">New department</h3>
      <form class="adminform" method="post" action="/departments" autocomplete="off">
        <label>Name
          <input name="name" required placeholder="Operations" />
        </label>
        <label>Slug (lowercase, hyphens)
          <input name="slug" required placeholder="operations" />
        </label>
        <button type="submit" class="btn">Add department</button>
      </form>
      <h3 style="font-size:13px;color:var(--muted);margin:18px 0 8px">New squad</h3>
      ${squadForm}
    </div>`
}

function overviewBody(
  brand: string,
  slug: string,
  origin: string,
  tree: DepartmentNode[],
  auth: AuthContext,
) {
  const canManage = isAdmin(auth)
  if (tree.length === 0) {
    return html`
      <h1>${brand} org</h1>
      <p class="crumbs">Signed in as ${auth.email ?? auth.userId} · ${auth.role}</p>
      ${connectCard(slug, origin)}
      ${
        canManage
          ? orgCreateForms(tree)
          : html`<div class="card"><p class="empty">No departments yet. An admin can create them
              from this page; ask whoever owns this pot.</p></div>`
      }`
  }
  return html`
    <h1>${brand} org</h1>
    <p class="crumbs">Signed in as ${auth.email ?? auth.userId} · ${auth.role} ·
      ${tree.length} department${tree.length === 1 ? '' : 's'}</p>
    <p style="margin:4px 0 16px"><a class="btn" href="/send" style="display:inline-block;text-decoration:none">Send a task →</a></p>
    ${connectCard(slug, origin)}
    ${raw(
      tree
        .map(
          (d) => html`
            <div class="card dept">
              <div class="dept-name">${d.name}</div>
              ${
                d.squads.length === 0
                  ? html`<p class="empty">No squads.</p>`
                  : raw(
                      d.squads
                        .map(
                          (s) => html`
                            <div class="squad-row">
                              <div>
                                <a href="/squads/${s.id}"><strong>${s.name}</strong></a>
                                <span class="meta"> · ${s.agents.length} agent${s.agents.length === 1 ? '' : 's'}</span>
                              </div>
                              <a class="meta" href="/squads/${s.id}">board →</a>
                            </div>
                            ${
                              s.agents.length > 0
                                ? html`<div class="agents">${raw(s.agents.map((a) => agentChip(a).toString()).join(''))}</div>`
                                : html``
                            }
                          `,
                        )
                        .map((x) => x.toString())
                        .join(''),
                    )
              }
            </div>
          `,
        )
        .map((x) => x.toString())
        .join(''),
    )}
    ${canManage ? orgCreateForms(tree) : html``}`
}

function squadBoardBody(squad: Squad, agents: Agent[], tasks: Task[], canAddAgent: boolean) {
  const byLane = new Map<Task['status'], Task[]>()
  for (const t of tasks) {
    const list = byLane.get(t.status) ?? []
    list.push(t)
    byLane.set(t.status, list)
  }
  // Add-agent form (lead+ on this squad). Plain HTML POST → /squads/:id/agents
  // (POST-redirect-GET); the model defaults to the Workers-AI llama as the API does.
  const addAgentForm = canAddAgent
    ? html`
        <form class="adminform" method="post" action="/squads/${squad.id}/agents" autocomplete="off"
          style="margin-top:14px">
          <label>Slug
            <input name="slug" required placeholder="dispatcher" />
          </label>
          <label>Name
            <input name="name" required placeholder="Dispatcher" />
          </label>
          <label>Role
            <input name="role" placeholder="member" />
          </label>
          <label>Model
            <input name="model" value="@cf/meta/llama-3.3" />
          </label>
          <button type="submit" class="btn">Add agent</button>
        </form>`
    : html``
  return html`
    <p class="crumbs"><a href="/">Overview</a> / ${squad.name}</p>
    <h1>${squad.name}</h1>
    ${
      squad.charter
        ? html`<div class="card"><h2 style="margin-top:0">Charter</h2><div class="charter">${squad.charter}</div></div>`
        : html``
    }
    <h2>Agents</h2>
    <div class="card">
      ${
        agents.length === 0
          ? html`<p class="empty">No agents in this squad yet.</p>`
          : html`<div class="agents">${raw(agents.map((a) => agentChip(a).toString()).join(''))}</div>`
      }
      ${addAgentForm}
    </div>
    <h2>Board</h2>
    <div class="board">
      ${raw(
        TASK_LANES.map((lane) => {
          const items = byLane.get(lane.key) ?? []
          const cards =
            items.length === 0
              ? '<p class="empty">—</p>'
              : items.map((t) => taskCard(t).toString()).join('')
          return html`<div class="lane"><h3>${lane.label} · ${items.length}</h3>${raw(cards)}</div>`.toString()
        }).join(''),
      )}
    </div>`
}

function taskCard(t: Task) {
  return html`<div class="task">
    <div class="t-title">${t.title}</div>
    <div class="t-meta">${t.assignee_agent_id ? html`assigned` : html`unassigned`}${
    t.github_issue_url ? html` · <a href="${t.github_issue_url}">GH</a>` : html``
  }</div>
  </div>`
}

function agentConsoleBody(agent: Agent, squad: Squad | null, canWake: boolean) {
  // The wake button calls the RBAC-gated agents endpoint. The fetch is same-origin
  // and credentialed (HttpOnly session cookie rides along automatically).
  const wakeScript = raw(`
    <script>
      (function () {
        var btn = document.getElementById('wake-btn');
        var out = document.getElementById('wake-status');
        if (!btn) return;
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          out.textContent = 'Waking…';
          try {
            var res = await fetch(${JSON.stringify(`/api/agents/${agent.id}/wake`)}, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ reason: 'dashboard manual wake' })
            });
            if (res.ok) {
              out.textContent = 'Woken. The cortex cycle is running.';
            } else if (res.status === 403) {
              out.textContent = 'Forbidden — you need admin or owner to wake an agent.';
            } else {
              out.textContent = 'Wake failed (' + res.status + ').';
            }
          } catch (e) {
            out.textContent = 'Wake request errored.';
          } finally {
            setTimeout(function () { btn.disabled = false; }, 1500);
          }
        });
      })();
    </script>`)
  return html`
    <p class="crumbs"><a href="/">Overview</a> /
      ${squad ? html`<a href="/squads/${squad.id}">${squad.name}</a>` : html`squad`} / ${agent.name}</p>
    <h1>${statusDot(agent.status)} ${agent.name}</h1>
    <div class="card">
      <dl class="kv">
        <dt>Slug</dt><dd>${agent.slug}</dd>
        <dt>Role</dt><dd>${agent.role}</dd>
        <dt>Model</dt><dd><code>${agent.model}</code></dd>
        <dt>Status</dt><dd>${agent.status}</dd>
        <dt>Squad</dt><dd>${squad ? html`<a href="/squads/${squad.id}">${squad.name}</a>` : html`—`}</dd>
        <dt>Agent id</dt><dd><code>${agent.id}</code></dd>
        <dt>Created</dt><dd>${agent.created_at}</dd>
      </dl>
    </div>
    <h2>Console</h2>
    <div class="card">
      <button id="wake-btn" class="btn" ${canWake ? raw('') : raw('disabled title="Requires admin or owner"')}>
        Wake agent
      </button>
      <span style="margin-left:12px;color:var(--dim);font-size:13px;">drives one cortex cycle</span>
      <div id="wake-status" class="status-line"></div>
      ${canWake ? html`` : html`<p class="empty">You can view this agent but only admin/owner may wake it.</p>`}
    </div>
    ${wakeScript}`
}

// ── /send — write a task, pick an agent, watch it get done ─────────────────────
//
// The picker is a flat <select> of active agents, each option labelled with its
// squad. The option VALUE carries "agentId|squadId" so the client can post both
// without a second lookup. The client posts to /api/tasks (dispatch:true) and then
// polls /api/tasks/:id every 2s (cap 120s), rendering sent → working → done.
function sendPageBody(agents: PickerAgent[]) {
  const hasAgents = agents.length > 0
  const options = agents
    .map(
      (a) =>
        `<option value="${escAttr(`${a.id}|${a.squad_id}`)}">${escHtml(a.name)} — ${escHtml(a.role)} · ${escHtml(a.squad_name)}</option>`,
    )
    .join('')

  const form = hasAgents
    ? html`
        <div class="card">
          <label class="block">
            <span class="lbl">Your agents</span>
            <select id="send-agent">${raw(options)}</select>
          </label>
          <label class="block" style="margin-top:14px">
            <span class="lbl">What do you need done?</span>
            <textarea id="send-body" rows="6" placeholder="Describe the task in your own words…"></textarea>
          </label>
          <div style="margin-top:14px">
            <button id="send-btn" class="btn">Send a task</button>
            <span id="send-hint" style="margin-left:12px;color:var(--dim);font-size:13px;">your agent does it and the result lands here</span>
          </div>
          <div id="send-status" class="status-line"></div>
          <div id="send-result" class="result-box" hidden></div>
        </div>`
    : html`<div class="card"><p class="empty">No active agents yet. Add one from a
        <a href="/">squad board</a> first, then come back to send it a task.</p></div>`

  return html`
    <p class="crumbs"><a href="/">Overview</a> / Send a task</p>
    <h1>Send a task</h1>
    <p class="empty" style="margin-top:0;max-width:640px">
      Write what you need in plain language and pick one of your agents. It does the
      work and the result appears below — no jargon, no setup.</p>
    <style>
      .block { display: flex; flex-direction: column; gap: 6px; }
      .block .lbl { font-size: 13px; color: var(--muted); }
      #send-agent, #send-body {
        font: inherit; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--border);
        background: var(--bg); color: var(--text); width: 100%; resize: vertical;
      }
      .result-box {
        margin-top: 16px; background: var(--surface2); border: 1px solid var(--border);
        border-radius: 8px; padding: 14px 16px; font-size: 14px; white-space: pre-wrap;
        line-height: 1.55;
      }
      .result-box .done-meta { color: var(--dim); font-size: 12px; margin-bottom: 10px; }
    </style>
    ${form}
    ${hasAgents ? sendScript() : html``}`
}

function sendScript() {
  // Vanilla, same-origin, credentialed. Title = first ~60 chars of the body. Polls
  // GET /api/tasks/:id every 2s up to 120s. CSRF + no-store handled by middleware.
  return raw(`
    <script>
      (function () {
        var btn = document.getElementById('send-btn');
        var bodyEl = document.getElementById('send-body');
        var agentEl = document.getElementById('send-agent');
        var status = document.getElementById('send-status');
        var resultBox = document.getElementById('send-result');
        if (!btn) return;

        var POLL_MS = 2000;
        var MAX_MS = 120000;

        function esc(s) {
          return String(s).replace(/[&<>"']/g, function (c) {
            return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
          });
        }
        function fmtSecs(ms) { return Math.max(0, Math.round(ms / 1000)) + 's'; }

        async function poll(taskId, startedAt) {
          var deadline = startedAt + MAX_MS;
          while (Date.now() < deadline) {
            await new Promise(function (r) { setTimeout(r, POLL_MS); });
            var res;
            try {
              res = await fetch('/api/tasks/' + encodeURIComponent(taskId), {
                method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }
              });
            } catch (e) { continue; }
            if (!res.ok) { continue; }
            var data = await res.json();
            var t = data.task;
            if (!t) { continue; }
            if (t.status === 'in_progress') { status.textContent = 'Working… (' + fmtSecs(Date.now() - startedAt) + ')'; continue; }
            if (t.status === 'done' || t.status === 'blocked') {
              return render(t, startedAt);
            }
            // still 'open' (dispatch in flight) — keep waiting.
            status.textContent = 'Sent. Waiting for your agent to pick it up…';
          }
          status.textContent = 'Still working after ' + fmtSecs(MAX_MS) + '. It will keep running — refresh later to see the result.';
        }

        function render(t, startedAt) {
          var took = fmtSecs(Date.now() - startedAt);
          if (t.status === 'done') {
            status.textContent = 'Done in ' + took + '.';
          } else {
            status.textContent = 'Blocked — see the note below.';
          }
          var when = t.completed_at || '';
          var who = t.assignee_agent_id || 'your agent';
          var meta = (t.status === 'done' ? 'Completed by ' : 'Blocked · ') + esc(who) + (when ? ' at ' + esc(when) : '');
          resultBox.hidden = false;
          resultBox.innerHTML = '<div class="done-meta">' + meta + '</div>' + esc(t.result || '(no output)');
        }

        btn.addEventListener('click', async function () {
          var text = (bodyEl.value || '').trim();
          if (!text) { status.textContent = 'Write what you need first.'; return; }
          var val = agentEl.value || '';
          var parts = val.split('|');
          var agentId = parts[0];
          var squadId = parts[1];
          if (!agentId || !squadId) { status.textContent = 'Pick an agent first.'; return; }

          btn.disabled = true;
          resultBox.hidden = true;
          resultBox.innerHTML = '';
          status.textContent = 'Sending…';
          var title = text.slice(0, 60);
          try {
            var res = await fetch('/api/tasks', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ squad_id: squadId, title: title, body: text, assignee_agent_id: agentId, dispatch: true })
            });
            if (res.status === 403) { status.textContent = 'You do not have permission to task that agent.'; return; }
            if (!res.ok) {
              var err = await res.json().catch(function () { return {}; });
              status.textContent = 'Could not send (' + res.status + ')' + (err.error ? ': ' + err.error : '') + '.';
              return;
            }
            var created = await res.json();
            var taskId = created.task && created.task.id;
            if (!taskId) { status.textContent = 'Sent, but no task id came back.'; return; }
            status.textContent = 'Sent. Waiting for your agent to pick it up…';
            await poll(taskId, Date.now());
          } catch (e) {
            status.textContent = 'Send failed — try again.';
          } finally {
            btn.disabled = false;
          }
        });
      })();
    </script>`)
}

// ── approvals (gate queue) ────────────────────────────────────────────────────

function approvalsBody(items: ApprovalItem[]) {
  const cards = items
    .map((t) => {
      const preview = resultPreview(t)
      return `
        <div class="card approval" data-task="${escAttr(t.id)}">
          <div class="appr-head">
            <div>
              <div class="appr-title">${escHtml(t.title)}</div>
              <div class="appr-meta">
                ${escHtml(t.agent_name ?? t.assignee_agent_id ?? 'unassigned')}
                · ${escHtml(t.squad_name ?? t.squad_id)}
                ${t.gate_owner ? `· <span class="gate-chip">${escHtml(t.gate_owner)}</span>` : ''}
              </div>
            </div>
            <div class="appr-when">${escHtml((t.completed_at ?? t.created_at).slice(0, 16).replace('T', ' '))}</div>
          </div>
          <div class="appr-body">${escHtml(t.body)}</div>
          ${preview ? `<div class="appr-result"><div class="lbl">Result</div>${escHtml(preview)}</div>` : ''}
          <div class="appr-actions">
            <input type="text" class="appr-note" placeholder="note (optional; required to reject)" />
            <button class="btn appr-approve">Approve</button>
            <button class="btn btn-reject appr-reject">Reject</button>
            <span class="appr-status"></span>
          </div>
        </div>`
    })
    .join('')

  return html`
    <p class="crumbs"><a href="/">Overview</a> / Approvals</p>
    <h1>Approvals</h1>
    <p class="empty" style="margin-top:0;max-width:640px">
      Work waiting at your gate. Approve to release it; reject sends it back with your note.
    </p>
    <style>
      .appr-head { display: flex; justify-content: space-between; gap: 12px; }
      .appr-title { font-weight: 600; }
      .appr-meta { color: var(--muted); font-size: 13px; margin-top: 2px; }
      .appr-when { color: var(--dim); font-size: 12px; white-space: nowrap; }
      .gate-chip {
        border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px;
        font-size: 12px; color: var(--accent);
      }
      .appr-body { margin-top: 10px; font-size: 14px; white-space: pre-wrap; }
      .appr-result {
        margin-top: 10px; background: var(--surface2); border: 1px solid var(--border);
        border-radius: 8px; padding: 10px 12px; font-size: 13px; white-space: pre-wrap;
      }
      .appr-result .lbl { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
      .appr-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
      .appr-note {
        flex: 1; min-width: 200px; font: inherit; font-size: 13px; padding: 7px 10px;
        border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text);
      }
      .btn-reject { background: transparent; color: var(--warn); border: 1px solid var(--warn); }
      .appr-status { font-size: 13px; color: var(--dim); }
      .approval.decided { opacity: .55; }
    </style>
    ${items.length ? raw(cards) : html`<div class="card"><p class="empty">Nothing waiting at your gates. Gated work lands here when an agent finishes it.</p></div>`}
    ${items.length ? approvalsScript() : html``}`
}

function approvalsScript() {
  // Same-origin, credentialed. POSTs to the existing RBAC'd verdict endpoint;
  // CSRF Origin check + no-store come from the dashboard middleware.
  return raw(`
    <script>
      (function () {
        document.querySelectorAll('.approval').forEach(function (card) {
          var id = card.getAttribute('data-task');
          var note = card.querySelector('.appr-note');
          var status = card.querySelector('.appr-status');
          function decide(verdict) {
            if (verdict === 'rejected' && !note.value.trim()) {
              status.textContent = 'a note is required to reject';
              note.focus();
              return;
            }
            card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
            status.textContent = '…';
            fetch('/api/tasks/' + encodeURIComponent(id) + '/verdict', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ verdict: verdict, note: note.value.trim() || undefined })
            }).then(function (res) {
              return res.json().then(function (data) { return { ok: res.ok, data: data }; });
            }).then(function (r) {
              if (r.ok) {
                status.textContent = verdict === 'approved' ? 'approved ✓' : 'rejected ✗';
                card.classList.add('decided');
              } else {
                status.textContent = (r.data && r.data.error) || 'failed';
                card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
              }
            }).catch(function () {
              status.textContent = 'network error — try again';
              card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
            });
          }
          card.querySelector('.appr-approve').addEventListener('click', function () { decide('approved'); });
          card.querySelector('.appr-reject').addEventListener('click', function () { decide('rejected'); });
        });
      })();
    </script>`)
}

// ── members + divisions views ─────────────────────────────────────────────────

// Ladder high→low — used to order capability chips and populate <select>s.
const CAPABILITY_ORDER: ReadonlyArray<Capability> = [
  'owner',
  'admin',
  'lead',
  'member',
  'observer',
]

const SCOPE_TYPES: ReadonlyArray<CapabilityScopeType> = ['org', 'department', 'squad']

const CHANNEL_LABEL: Record<ConnectionChannel, string> = {
  workspace: 'workspace',
  im: 'IM',
  dashboard: 'dashboard',
}

// ── members PAGE (GET /members) — roster + mint/revoke + show-once token ────────
// Distinct from membersAdminBody (the /admin/members grant/invite console). This is
// the connect-oriented surface: each member's live channels + live tokens, with a
// mint form and per-token revoke for admins. Forms are hidden for non-admins.

function membersPageBody(
  members: Member[],
  channels: { member_id: string; channel: ConnectionChannel }[],
  tokens: PublicMemberToken[],
  canManage: boolean,
  auth: AuthContext,
) {
  const channelsByMember = new Map<string, Set<ConnectionChannel>>()
  for (const ch of channels) {
    const set = channelsByMember.get(ch.member_id) ?? new Set<ConnectionChannel>()
    set.add(ch.channel)
    channelsByMember.set(ch.member_id, set)
  }
  const tokensByMember = new Map<string, PublicMemberToken[]>()
  for (const t of tokens) {
    const list = tokensByMember.get(t.member_id) ?? []
    list.push(t)
    tokensByMember.set(t.member_id, list)
  }

  const rows =
    members.length === 0
      ? '<p class="empty">No members yet. Invite someone from the Divisions / admin console — first connect mints their member + token.</p>'
      : members
          .map((m) =>
            memberConnectRow(
              m,
              channelsByMember.get(m.id),
              tokensByMember.get(m.id) ?? [],
              canManage,
            ),
          )
          .map((x) => x.toString())
          .join('')

  return html`
    <p class="crumbs"><a href="/">Overview</a> / Members</p>
    <h1>Members</h1>
    <p class="crumbs">Signed in as ${auth.email ?? auth.userId} · ${auth.role} ·
      ${members.length} member${members.length === 1 ? '' : 's'}. A token is what a member pastes into
      their workspace config (see the <a href="/">Connect card</a>). Mint one below — it is shown
      exactly once.</p>
    <div class="card" style="padding:0">
      <table class="grid">
        <thead>
          <tr><th>Member</th><th>Channels</th><th>Tokens</th>${
            canManage ? raw('<th>Mint</th>') : raw('')
          }</tr>
        </thead>
        <tbody>${raw(rows)}</tbody>
      </table>
    </div>`
}

function memberConnectRow(
  m: Member,
  channels: Set<ConnectionChannel> | undefined,
  tokens: PublicMemberToken[],
  canManage: boolean,
) {
  const chSet = new Set<ConnectionChannel>(channels ?? [])
  if (m.telegram_chat_id) chSet.add('im')
  const chChips =
    chSet.size === 0
      ? html`<span class="empty">—</span>`
      : raw(
          [...chSet]
            .map((ch) => `<span class="tag chan">${escHtml(CHANNEL_LABEL[ch])}</span>`)
            .join(' '),
        )

  const tokenList =
    tokens.length === 0
      ? html`<span class="empty">no live tokens</span>`
      : raw(
          tokens
            .map((t) => {
              const label = t.label.length > 0 ? t.label : '(unlabeled)'
              const revokeBtn = canManage
                ? `<form method="post" action="/members/${escAttr(t.member_id)}/tokens/${escAttr(
                    t.id,
                  )}/revoke" style="display:inline">` +
                  `<button type="submit" class="btn secondary sm">Revoke</button></form>`
                : ''
              return (
                `<div class="tokenline"><span class="tag chan">${escHtml(
                  CHANNEL_LABEL[t.channel],
                )}</span>` +
                `<span class="lbl">${escHtml(label)}</span>${revokeBtn}</div>`
              )
            })
            .join(''),
        )

  // Per-row mint form (admin+). A plain HTML POST → the show-once page.
  const mintCell = canManage
    ? html`<td>
        <form method="post" action="/members/${m.id}/tokens" class="adminform" autocomplete="off">
          <label>Label
            <input name="label" placeholder="laptop" style="min-width:120px" />
          </label>
          <label>Channel
            <select name="channel">
              <option value="workspace">workspace</option>
              <option value="im">IM</option>
              <option value="dashboard">dashboard</option>
            </select>
          </label>
          <button type="submit" class="btn sm">Mint token</button>
        </form>
      </td>`
    : html``

  return html`
    <tr data-member="${m.id}">
      <td>
        <strong>${m.display_name}</strong>
        <div class="t-meta">${m.email ?? html`<span class="empty">no email</span>`}</div>
      </td>
      <td>${chChips}</td>
      <td>${tokenList}</td>
      ${mintCell}
    </tr>`
}

// The SHOW-ONCE page. The raw token is rendered here and NOWHERE else — never
// persisted, never logged, never reachable by a redirect. Reloading this page will
// not show the token again (it does not exist server-side in raw form).
function tokenShowOnceBody(slug: string, origin: string, memberName: string, minted: MintedToken) {
  return html`
    <p class="crumbs"><a href="/">Overview</a> / <a href="/members">Members</a> / Token minted</p>
    <h1>Token minted for ${memberName}</h1>
    <div class="warn-box">
      <strong>Copy this token now — it is shown exactly once.</strong> We store only a hash, so it
      can never be displayed again. If it is lost, revoke it and mint a new one.
    </div>
    <div class="card">
      <p class="empty" style="margin-top:0">Label
        <strong>${minted.label.length > 0 ? minted.label : '(unlabeled)'}</strong> ·
        channel <span class="tag chan">${CHANNEL_LABEL[minted.channel]}</span></p>
      <code class="token">${minted.raw}</code>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Paste it into your workspace</h2>
      <p class="empty" style="margin-top:0">Replace <code class="inline">&lt;MEMBER_TOKEN&gt;</code>
        in the snippet with the token above. Endpoint:
        <code class="inline">${mcpEndpoint(origin)}</code>.</p>
      <h3 style="font-size:13px;color:var(--muted);margin:14px 0 0">Claude Code · <code class="inline">.mcp.json</code></h3>
      <pre class="snippet">${claudeCodeSnippet(slug, origin)}</pre>
      <h3 style="font-size:13px;color:var(--muted);margin:14px 0 0">Codex · <code class="inline">~/.codex/config.toml</code></h3>
      <pre class="snippet">${codexSnippet(slug, origin)}</pre>
    </div>
    <p><a href="/members">← Back to members</a></p>`
}

/** Render one capability grant as a human label: "admin · Engineering" / "owner · org". */
function grantLabel(g: CapabilityGrant, scopeNames: Map<string, string>): string {
  if (g.scope_type === 'org') return `${g.capability} · org`
  const name = g.scope_id ? (scopeNames.get(g.scope_id) ?? g.scope_id) : g.scope_id
  return `${g.capability} · ${g.scope_type} ${name ?? ''}`.trim()
}

function capabilityRank(cap: Capability): number {
  const i = CAPABILITY_ORDER.indexOf(cap)
  return i === -1 ? CAPABILITY_ORDER.length : i
}

function membersAdminBody(
  members: Member[],
  grants: CapabilityGrant[],
  channels: { member_id: string; channel: ConnectionChannel }[],
  depts: Department[],
  scopeNames: Map<string, string>,
  auth: AuthContext,
) {
  const grantsByMember = new Map<string, CapabilityGrant[]>()
  for (const g of grants) {
    const list = grantsByMember.get(g.member_id) ?? []
    list.push(g)
    grantsByMember.set(g.member_id, list)
  }
  const channelsByMember = new Map<string, Set<ConnectionChannel>>()
  for (const ch of channels) {
    const set = channelsByMember.get(ch.member_id) ?? new Set<ConnectionChannel>()
    set.add(ch.channel)
    channelsByMember.set(ch.member_id, set)
  }

  const deptOptions = depts
    .map((d) => `<option value="${escAttr(d.id)}">${escHtml(d.name)}</option>`)
    .join('')
  const capOptions = CAPABILITY_ORDER.map(
    (cap) => `<option value="${cap}">${cap}</option>`,
  ).join('')

  const rows =
    members.length === 0
      ? '<p class="empty">No members yet. Invite someone below — first connect mints their member + token.</p>'
      : members
          .map((m) => memberRow(m, grantsByMember.get(m.id) ?? [], channelsByMember.get(m.id), scopeNames))
          .map((x) => x.toString())
          .join('')

  return html`
    <p class="crumbs"><a href="/">Overview</a> / Members</p>
    <h1>Members</h1>
    <p class="crumbs">Signed in as ${auth.email ?? auth.userId} · ${auth.role} ·
      ${members.length} member${members.length === 1 ? '' : 's'} · humans are
      first-class network nodes (one person = one member, many channels).</p>

    <h2>Invite a member</h2>
    <div class="card">
      <p class="empty" style="margin-top:0">An invite is redeemed once: first connect mints the
        member, capability and a workspace token. The capability applies org-wide unless you scope it
        to a department.</p>
      <form id="invite-form" class="adminform" autocomplete="off">
        <label>Email
          <input name="email" type="email" required placeholder="person@example.com" />
        </label>
        <label>Department
          <select name="department_id">
            <option value="">— org-wide —</option>
            ${raw(deptOptions)}
          </select>
        </label>
        <label>Capability
          <select name="capability">${raw(capOptions)}</select>
        </label>
        <button type="submit" class="btn">Create invite</button>
      </form>
      <div id="invite-status" class="status-line"></div>
    </div>

    <h2>Roster</h2>
    <div class="card" style="padding:0">
      <table class="grid">
        <thead>
          <tr><th>Member</th><th>Channels</th><th>Capabilities</th><th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody>${raw(rows)}</tbody>
      </table>
    </div>

    ${membersAdminScript(scopeNamesToOptions(scopeNames, depts))}`
}

function memberRow(
  m: Member,
  grants: CapabilityGrant[],
  channels: Set<ConnectionChannel> | undefined,
  scopeNames: Map<string, string>,
) {
  const sorted = [...grants].sort((a, b) => capabilityRank(a.capability) - capabilityRank(b.capability))
  const capChips =
    sorted.length === 0
      ? html`<span class="empty">none</span>`
      : raw(
          sorted
            .map((g) => `<span class="tag cap">${escHtml(grantLabel(g, scopeNames))}</span>`)
            .join(' '),
        )

  // Channels: tokens give workspace/im/dashboard reachability; a telegram_chat_id
  // also makes the member IM-reachable even before a Hermes token is minted.
  const chSet = new Set<ConnectionChannel>(channels ?? [])
  if (m.telegram_chat_id) chSet.add('im')
  const chChips =
    chSet.size === 0
      ? html`<span class="empty">—</span>`
      : raw(
          [...chSet]
            .map((ch) => `<span class="tag chan">${escHtml(CHANNEL_LABEL[ch])}</span>`)
            .join(' '),
        )

  const suspended = m.status === 'suspended'
  return html`
    <tr data-member="${m.id}">
      <td>
        <strong>${m.display_name}</strong>
        <div class="t-meta">${m.email ?? html`<span class="empty">no email</span>`}</div>
        <div class="t-meta"><code>${m.id}</code></div>
      </td>
      <td>${chChips}</td>
      <td>${capChips}</td>
      <td>
        <span class="dot ${suspended ? 'paused' : 'active'}"></span>
        ${m.status}
      </td>
      <td class="actions">
        <button class="btn secondary sm js-suspend" data-member="${m.id}"
          data-next="${suspended ? 'active' : 'suspended'}">
          ${suspended ? 'Reactivate' : 'Suspend'}
        </button>
        <button class="btn secondary sm js-grant" data-member="${m.id}"
          data-name="${escAttr(m.display_name)}">Grant capability</button>
      </td>
    </tr>`
}

function divisionsAdminBody(
  depts: Department[],
  squads: Squad[],
  grants: CapabilityGrant[],
  members: Member[],
  auth: AuthContext,
) {
  const memberName = new Map<string, string>()
  for (const m of members) memberName.set(m.id, m.display_name)

  // Heads of a scope = members holding lead+ capability on that exact scope.
  // (org > admin > lead > member > observer; 'head' = lead or stronger.)
  const headRank = capabilityRank('lead')
  const headsByScope = new Map<string, { name: string; cap: Capability }[]>()
  for (const g of grants) {
    if (g.scope_type === 'org' || g.scope_id === null) continue
    if (capabilityRank(g.capability) > headRank) continue // weaker than lead → not a head
    const list = headsByScope.get(g.scope_id) ?? []
    list.push({ name: memberName.get(g.member_id) ?? g.member_id, cap: g.capability })
    headsByScope.set(g.scope_id, list)
  }

  const squadsByDept = new Map<string, Squad[]>()
  for (const s of squads) {
    const list = squadsByDept.get(s.department_id) ?? []
    list.push(s)
    squadsByDept.set(s.department_id, list)
  }

  const heads = (scopeId: string) => {
    const list = headsByScope.get(scopeId) ?? []
    if (list.length === 0) return html`<span class="empty">no head assigned</span>`
    return raw(
      list
        .sort((a, b) => capabilityRank(a.cap) - capabilityRank(b.cap))
        .map((h) => `<span class="tag cap">${escHtml(h.cap)} · ${escHtml(h.name)}</span>`)
        .join(' '),
    )
  }

  if (depts.length === 0) {
    return html`
      <p class="crumbs"><a href="/">Overview</a> / Divisions</p>
      <h1>Divisions</h1>
      <div class="card"><p class="empty">No departments yet. Seed the org via
        <code>POST /api/org/departments</code> and they'll appear here.</p></div>`
  }

  const cards = depts
    .map((d) => {
      const ds = squadsByDept.get(d.id) ?? []
      const squadRows =
        ds.length === 0
          ? '<p class="empty">No squads.</p>'
          : ds
              .map(
                (s) => html`
                  <div class="squad-row">
                    <div>
                      <a href="/squads/${s.id}"><strong>${s.name}</strong></a>
                      <span class="meta"> · squad</span>
                    </div>
                    <div class="meta">${heads(s.id)}</div>
                  </div>`.toString(),
              )
              .join('')
      return html`
        <div class="card dept">
          <div class="dept-name">${d.name}</div>
          <div class="t-meta" style="margin-bottom:8px">Department head: ${heads(d.id)}</div>
          ${raw(squadRows)}
        </div>`.toString()
    })
    .join('')

  return html`
    <p class="crumbs"><a href="/">Overview</a> / Divisions</p>
    <h1>Divisions</h1>
    <p class="crumbs">Signed in as ${auth.email ?? auth.userId} · ${auth.role} ·
      ${depts.length} department${depts.length === 1 ? '' : 's'} ·
      ${squads.length} squad${squads.length === 1 ? '' : 's'}. A head is any member holding
      <strong>lead</strong> or stronger capability on that scope.</p>
    ${raw(cards)}
    <p class="empty">Assign a head from the <a href="/admin/members">Members</a> page — grant a member
      <code>lead</code> (or higher) on the department or squad scope.</p>`
}

// ── client scripts (POST to the RBAC-gated /api/members/* — never write here) ──

/** Department/squad <option>s for the grant dialog's scope selector. */
function scopeNamesToOptions(scopeNames: Map<string, string>, depts: Department[]): string {
  const deptIds = new Set(depts.map((d) => d.id))
  const opts: string[] = []
  for (const [id, name] of scopeNames) {
    const kind = deptIds.has(id) ? 'department' : 'squad'
    opts.push(`<option value="${escAttr(id)}" data-kind="${kind}">${escHtml(name)} (${kind})</option>`)
  }
  return opts.join('')
}

function membersAdminScript(scopeOptions: string) {
  const capOptions = CAPABILITY_ORDER.map((c) => `<option value="${c}">${c}</option>`).join('')
  const scopeTypeOptions = SCOPE_TYPES.map((s) => `<option value="${s}">${s}</option>`).join('')
  // The member-admin API base. The Integrate phase mounts membersApp under this
  // prefix; buttons call it (we never duplicate the API's writes here).
  const api = '/api/members'
  return raw(`
    <div id="grant-modal" class="modal" hidden>
      <div class="modal-card">
        <h3 style="margin-top:0">Grant capability — <span id="grant-who"></span></h3>
        <form id="grant-form" class="adminform">
          <label>Scope type
            <select name="scope_type" id="grant-scope-type">${scopeTypeOptions}</select>
          </label>
          <label id="grant-scope-wrap">Scope
            <select name="scope_id" id="grant-scope-id">${scopeOptions}</select>
          </label>
          <label>Capability
            <select name="capability">${capOptions}</select>
          </label>
          <div class="modal-actions">
            <button type="button" class="btn secondary" id="grant-cancel">Cancel</button>
            <button type="submit" class="btn">Grant</button>
          </div>
        </form>
        <div id="grant-status" class="status-line"></div>
      </div>
    </div>
    <script>
      (function () {
        var API = ${JSON.stringify(api)};
        async function postJSON(url, method, body) {
          return fetch(url, {
            method: method,
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: body == null ? undefined : JSON.stringify(body)
          });
        }
        function reloadSoon() { setTimeout(function () { location.reload(); }, 900); }

        // ── invite ──
        var inviteForm = document.getElementById('invite-form');
        var inviteStatus = document.getElementById('invite-status');
        if (inviteForm) {
          inviteForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var fd = new FormData(inviteForm);
            var payload = {
              email: String(fd.get('email') || ''),
              capability: String(fd.get('capability') || 'member')
            };
            var dep = String(fd.get('department_id') || '');
            if (dep) payload.department_id = dep;
            inviteStatus.textContent = 'Creating invite…';
            try {
              var res = await postJSON(API + '/invites', 'POST', payload);
              var data = await res.json().catch(function () { return {}; });
              if (res.ok) {
                inviteStatus.textContent =
                  'Invite created. Redemption id: ' + (data.invite && data.invite.id) +
                  ' — share the accept link; first connect mints the member + token (shown once).';
                inviteForm.reset();
              } else if (res.status === 403) {
                inviteStatus.textContent = 'Forbidden — you need admin on this scope to invite.';
              } else {
                inviteStatus.textContent = 'Invite failed: ' + (data.error || res.status);
              }
            } catch (err) { inviteStatus.textContent = 'Invite request errored.'; }
          });
        }

        // ── suspend / reactivate ──
        document.querySelectorAll('.js-suspend').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            var id = btn.getAttribute('data-member');
            var next = btn.getAttribute('data-next');
            btn.disabled = true;
            try {
              var res = await postJSON(API + '/members/' + encodeURIComponent(id), 'PATCH', { status: next });
              if (res.ok) { reloadSoon(); }
              else if (res.status === 403) { btn.disabled = false; alert('Forbidden — admin required.'); }
              else { btn.disabled = false; alert('Update failed (' + res.status + ').'); }
            } catch (e) { btn.disabled = false; alert('Request errored.'); }
          });
        });

        // ── grant capability (modal) ──
        var modal = document.getElementById('grant-modal');
        var grantForm = document.getElementById('grant-form');
        var grantWho = document.getElementById('grant-who');
        var grantStatus = document.getElementById('grant-status');
        var scopeType = document.getElementById('grant-scope-type');
        var scopeWrap = document.getElementById('grant-scope-wrap');
        var scopeId = document.getElementById('grant-scope-id');
        var currentMember = null;

        function syncScopeVisibility() {
          var t = scopeType.value;
          if (t === 'org') { scopeWrap.setAttribute('hidden', ''); }
          else {
            scopeWrap.removeAttribute('hidden');
            // filter scope options to the chosen kind
            Array.prototype.forEach.call(scopeId.options, function (opt) {
              if (!opt.getAttribute('data-kind')) return;
              opt.hidden = opt.getAttribute('data-kind') !== t;
            });
            var firstVisible = Array.prototype.find.call(scopeId.options, function (o) { return !o.hidden; });
            if (firstVisible) scopeId.value = firstVisible.value;
          }
        }
        if (scopeType) scopeType.addEventListener('change', syncScopeVisibility);

        document.querySelectorAll('.js-grant').forEach(function (btn) {
          btn.addEventListener('click', function () {
            currentMember = btn.getAttribute('data-member');
            grantWho.textContent = btn.getAttribute('data-name') || currentMember;
            grantStatus.textContent = '';
            modal.removeAttribute('hidden');
            syncScopeVisibility();
          });
        });
        var cancel = document.getElementById('grant-cancel');
        if (cancel) cancel.addEventListener('click', function () { modal.setAttribute('hidden', ''); });

        if (grantForm) {
          grantForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!currentMember) return;
            var fd = new FormData(grantForm);
            var st = String(fd.get('scope_type') || 'org');
            var payload = { action: 'grant', scope_type: st, capability: String(fd.get('capability') || 'member') };
            if (st !== 'org') payload.scope_id = String(fd.get('scope_id') || '');
            grantStatus.textContent = 'Granting…';
            try {
              var res = await postJSON(API + '/members/' + encodeURIComponent(currentMember) + '/capabilities', 'POST', payload);
              var data = await res.json().catch(function () { return {}; });
              if (res.ok) { grantStatus.textContent = 'Granted.'; reloadSoon(); }
              else if (res.status === 403) { grantStatus.textContent = 'Forbidden — admin required on this scope.'; }
              else { grantStatus.textContent = 'Grant failed: ' + (data.error || res.status); }
            } catch (err) { grantStatus.textContent = 'Grant request errored.'; }
          });
        }
      })();
    </script>`)
}

// ── small HTML escapers (for raw-interpolated attribute/text values) ──────────
// hono's html`` template auto-escapes interpolations, but raw() strings we build
// by hand (table rows, <option>s, modal markup) must be escaped explicitly.
function escHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
function escAttr(v: string): string {
  return escHtml(v)
}
