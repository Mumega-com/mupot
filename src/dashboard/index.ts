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
import { createDepartment, createSquad, createAgent, setAgentStatus, deleteAgent, updateUnitConfig } from '../org/service'
import type { UnitConfigPatch } from '../org/service'
import { SQUAD_PACKS, seedSquadPack } from '../org/squad-packs'
import { mintMemberToken, revokeMemberToken, loadLiveTokens, isChannel } from '../members/service'
import type { MintedToken, PublicMemberToken } from '../members/service'

// Connect-config builders (pure) for the Connect card.
import { mcpEndpoint, claudeCodeSnippet, codexSnippet } from './connect'
import { loadApprovals, resultPreview } from './approvals'
import type { ApprovalItem } from './approvals'
import {
  loadObservatory,
  agentGradient,
} from './observatory'
import type { ObservatoryData, SwimlaneBar, AgentStat } from './observatory'
import { loadAllAgents, loadSquadOptions } from './agents-admin'
import type { AgentAdminRow, SquadOption } from './agents-admin'
import { formatBurn, formatUsd } from '../agents/cost'

// First-run setup wizard (the easy-onboard centerpiece). Mounted under '/setup'
// on this same dashboard app, so it inherits the auth + tenant guard below.
import { loadFleet, wakeFleetAgent, requestFleetControl, busConfigured } from './fleet'
import type { FleetRow } from './fleet'
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

// GET / — Observatory home (#13): swimlane of agents over time, operator queue,
// recent tasks. First-run onboarding redirect is retained at the top.
dashboardApp.get('/', async (c) => {
  const auth = c.get('auth')
  // First-run nudge: an owner landing on an un-onboarded pot goes straight to the
  // wizard. Non-owners (and completed pots) see the normal overview. The wizard
  // itself re-checks owner + completion, so this is a convenience redirect only.
  if ((auth.role === 'owner' || hasOrgOwnerCapability(auth)) && !(await isOnboardingComplete(c.env))) {
    return c.redirect('/setup')
  }
  // Load observatory data (agents, stats, bars, ticks, recentTasks) and the
  // operator queue (existing loadApprovals, same RBAC as the /approvals page)
  // in parallel — they hit independent D1 tables.
  const [obsData, approvals] = await Promise.all([
    loadObservatory(c.env),
    loadApprovals(c.env, auth),
  ])
  return c.html(
    shell(c.env.BRAND, 'Overview', observatoryBody(c.env.BRAND, obsData, approvals, auth)),
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

// ── fleet (company-wide agent roster over the SOS bus) ───────────────────────
// GET /fleet — see every company agent: liveness, last active, role/label.
// Window only: data comes from the bus bridge; the pot runs none of them.
dashboardApp.get('/fleet', async (c) => {
  if (!busConfigured(c.env)) {
    return c.html(shell(c.env.BRAND, 'Fleet', fleetUnconfiguredBody()))
  }
  let rows: FleetRow[] = []
  let error: string | null = null
  try {
    rows = await loadFleet(c.env, Date.now())
  } catch (e) {
    error = e instanceof Error ? e.message : 'bus_unreachable'
  }
  return c.html(shell(c.env.BRAND, 'Fleet', fleetBody(rows, error)))
})

// POST /fleet/wake — direct bus ping to the agent. Owner/admin only
// (adversarial P2 2026-06-07): the HQ BUS_TOKEN is admin-scoped, so an
// un-gated wake let any pot member ping any agent in any project by name.
// Gated to owner/admin to match /fleet/control; wakeFleetAgent also pins
// the project so the ping cannot fan out cross-tenant.
dashboardApp.post('/fleet/wake', async (c) => {
  if (!busConfigured(c.env)) return c.json({ error: 'bus_not_configured' }, 503)
  const auth = c.get('auth')
  if (auth.role !== 'owner' && auth.role !== 'admin') {
    return c.json({ error: 'forbidden', need: 'admin' }, 403)
  }
  const body = (await c.req.json().catch(() => ({}))) as { agent?: unknown }
  const agent = typeof body.agent === 'string' ? body.agent.trim() : ''
  if (!agent || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(agent)) {
    return c.json({ error: 'invalid_agent' }, 400)
  }
  const ok = await wakeFleetAgent(c.env, agent, auth.email ?? 'admin')
  return c.json(ok ? { ok: true } : { error: 'bus_send_failed' }, ok ? 200 : 502)
})

// POST /fleet/control — pause/resume/deactivate/delete REQUEST (owner/admin
// only). Never a direct host action: emits a receipted control-request on the
// bus to the operations agent, which executes server-side and acks.
dashboardApp.post('/fleet/control', async (c) => {
  if (!busConfigured(c.env)) return c.json({ error: 'bus_not_configured' }, 503)
  const auth = c.get('auth')
  if (auth.role !== 'owner' && auth.role !== 'admin') {
    return c.json({ error: 'forbidden', need: 'admin' }, 403)
  }
  const body = (await c.req.json().catch(() => ({}))) as { agent?: unknown; action?: unknown }
  const agent = typeof body.agent === 'string' ? body.agent.trim() : ''
  const action = typeof body.action === 'string' ? body.action : ''
  if (!agent || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(agent)) {
    return c.json({ error: 'invalid_agent' }, 400)
  }
  const r = await requestFleetControl(c.env, agent, action, auth.email ?? 'admin')
  return c.json(r, r.ok ? 200 : 400)
})

// ── /agents — unified agent management ───────────────────────────────────────
//
// Owner/admin gated on every mutating path (create, status, delete).
// Read (GET /agents) is open to any authenticated pot member.

// GET /agents — the management table: all agents across squads, plus an Add form.
dashboardApp.get('/agents', async (c) => {
  const [agents, squadOptions] = await Promise.all([
    loadAllAgents(c.env),
    loadSquadOptions(c.env),
  ])
  const auth = c.get('auth')
  const canManage = isAdmin(auth)
  return c.html(shell(c.env.BRAND, 'Agents', agentsBody(agents, squadOptions, canManage)))
})

// POST /agents — create an agent (owner/admin only).
dashboardApp.post('/agents', async (c) => {
  const auth = c.get('auth')
  if (!isAdmin(auth)) {
    return c.html(shell(c.env.BRAND, 'Agents', errorBody('Creating an agent requires owner or admin.')), 403)
  }
  const form = await c.req.parseBody()
  const squadId = typeof form.squad_id === 'string' ? form.squad_id.trim() : ''
  if (!squadId) {
    return c.html(shell(c.env.BRAND, 'Agents', errorBody('Pick a squad for the agent.')), 400)
  }
  // Validate the squad exists in this pot before writing.
  const squad = await getById<Squad>(c.env, 'squads', squadId)
  if (!squad) {
    return c.html(shell(c.env.BRAND, 'Agents', errorBody('Squad not found.')), 404)
  }
  const result = await createAgent(c.env, squadId, {
    slug: form.slug,
    name: form.name,
    role: form.role,
    model: form.model,
  })
  if (!result.ok) {
    const [agents, squadOptions] = await Promise.all([loadAllAgents(c.env), loadSquadOptions(c.env)])
    return c.html(
      shell(c.env.BRAND, 'Agents', agentsBody(agents, squadOptions, true, `Could not add agent: ${result.error}.`)),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  return c.redirect('/agents')
})

// POST /agents/:id/status — pause or resume an agent (owner/admin only).
dashboardApp.post('/agents/:id/status', async (c) => {
  const auth = c.get('auth')
  if (!isAdmin(auth)) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const agentId = c.req.param('id')
  // Validate agentId is a non-empty string (UUID format); we don't need to parse
  // the body format strictly since we validate the status value via isAgentStatus.
  if (!agentId || agentId.length > 64) return c.json({ error: 'invalid_agent_id' }, 400)
  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown }
  const status = body.status
  if (status !== 'active' && status !== 'paused') {
    return c.json({ error: 'invalid_status', allowed: ['active', 'paused'] }, 400)
  }
  const result = await setAgentStatus(c.env, agentId, status)
  if (!result.ok) return c.json({ error: result.error }, 404)
  return c.json({ ok: true })
})

// DELETE /agents/:id — delete an agent row (owner/admin only).
// Note: HTML forms cannot DELETE; the client sends via fetch() with method:DELETE.
dashboardApp.delete('/agents/:id', async (c) => {
  const auth = c.get('auth')
  if (!isAdmin(auth)) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const agentId = c.req.param('id')
  if (!agentId || agentId.length > 64) return c.json({ error: 'invalid_agent_id' }, 400)
  const result = await deleteAgent(c.env, agentId)
  if (!result.ok) return c.json({ error: result.error }, 404)
  return c.json({ ok: true })
})

// POST /agents/:id/config — patch work-unit knobs on an agent (owner/admin only).
// Calls the shared updateUnitConfig from org/service — no new write logic here.
dashboardApp.post('/agents/:id/config', async (c) => {
  const auth = c.get('auth')
  if (!isAdmin(auth)) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const agentId = c.req.param('id')
  if (!agentId || agentId.length > 64) return c.json({ error: 'invalid_agent_id' }, 400)

  const form = await c.req.parseBody()
  const patch = parseUnitConfigPatch(form)
  const result = await updateUnitConfig(c.env, 'agent', agentId, patch)
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : 400
    return c.json({ error: result.error }, status)
  }
  return c.redirect('/agents')
})

// POST /squads/:id/config — patch work-unit knobs on a squad (owner/admin only).
dashboardApp.post('/squads/:id/config', async (c) => {
  const auth = c.get('auth')
  if (!isAdmin(auth)) return c.json({ error: 'forbidden', need: 'admin' }, 403)
  const squadId = c.req.param('id')
  if (!squadId || squadId.length > 64) return c.json({ error: 'invalid_squad_id' }, 400)

  const form = await c.req.parseBody()
  const patch = parseUnitConfigPatch(form)
  const result = await updateUnitConfig(c.env, 'squad', squadId, patch)
  if (!result.ok) {
    const status = result.error === 'not_found' ? 404 : 400
    return c.json({ error: result.error }, status)
  }
  return c.redirect(`/squads/${squadId}`)
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
  const canManage = isAdmin(auth)
  return c.html(
    shell(
      c.env.BRAND,
      `Squad · ${squad.name}`,
      squadBoardBody(squad, agents.results ?? [], tasks.results ?? [], canAddAgent, canManage),
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

// POST /squads/packs/:key — seed a starter squad pack (#11): one squad + its
// work-units in a single owner action. Admin on the target department, mirroring
// POST /squads. Uses the shared seedSquadPack → createSquad/createAgent (no D1
// bypass; full validation). The department is the form's department_id, or the
// first department when omitted (single-department pots are the common case).
dashboardApp.post('/squads/packs/:key', async (c) => {
  const auth = c.get('auth')
  const key = c.req.param('key')
  if (!SQUAD_PACKS.some((p) => p.key === key)) {
    return c.html(shell(c.env.BRAND, 'Overview', errorBody('Unknown squad pack.')), 404)
  }

  const form = await c.req.parseBody()
  let departmentId = typeof form.department_id === 'string' ? form.department_id : ''
  if (!departmentId) {
    // Fall back to the first department so a single-department pot needs no picker.
    const first = await c.env.DB.prepare(
      'SELECT id FROM departments ORDER BY created_at ASC LIMIT 1',
    ).first<{ id: string }>()
    departmentId = first?.id ?? ''
  }
  if (!departmentId) {
    return c.html(shell(c.env.BRAND, 'Overview', errorBody('Create a department first.')), 400)
  }
  const dept = await getById<Department>(c.env, 'departments', departmentId)
  if (!dept) {
    return c.html(shell(c.env.BRAND, 'Overview', errorBody('Department not found.')), 404)
  }
  if (!(await canOnDepartment(c.env, auth, departmentId))) {
    return c.html(
      shell(c.env.BRAND, 'Overview', errorBody('Seeding a squad pack requires admin on that department.')),
      403,
    )
  }

  const result = await seedSquadPack(c.env, departmentId, key)
  if (!result.ok) {
    return c.html(
      shell(c.env.BRAND, 'Overview', errorBody(`Could not seed pack: ${result.error}.`)),
      result.error === 'slug_taken' ? 409 : 400,
    )
  }
  // Land on the new squad's board.
  return c.redirect(result.squad ? `/squads/${result.squad.id}` : '/')
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

// ── config patch helper ───────────────────────────────────────────────────────
//
// Parse a multipart form body into a UnitConfigPatch. Only fields present in the
// form are included in the patch — absent fields are not sent to updateUnitConfig,
// so they remain untouched in D1. Budget cap arrives as a dollar amount from the
// form (input type=number, step=0.01) and is converted to integer cents here.

function parseUnitConfigPatch(form: Record<string, string | File>): UnitConfigPatch {
  const patch: UnitConfigPatch = {}
  if ('okr' in form)           patch.okr = typeof form.okr === 'string' ? form.okr.trim() || null : null
  if ('kpi_target' in form)    patch.kpi_target = typeof form.kpi_target === 'string' ? form.kpi_target.trim() || null : null
  if ('effort' in form)        patch.effort = form.effort
  if ('autonomy' in form)      patch.autonomy = form.autonomy
  if ('budget_window' in form) patch.budget_window = form.budget_window
  if ('budget_cap_dollars' in form) {
    const raw = typeof form.budget_cap_dollars === 'string' ? form.budget_cap_dollars.trim() : ''
    if (raw === '' || raw === '0') {
      patch.budget_cap_cents = null
    } else {
      const dollars = parseFloat(raw)
      // Clamp to integer cents; reject NaN/negative
      patch.budget_cap_cents = Number.isFinite(dollars) && dollars >= 0
        ? Math.round(dollars * 100)
        : null
    }
  }
  return patch
}

// ── data (squad board page helpers) ─────────────────────────────────────────

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

      /* ── Observatory (#13) ─────────────────────────────────────────────────── */
      /* Danger token not in original shell; define inline for bars */
      :root { --danger: #f85149; --warn2: #d29922; }

      .obs { display: flex; flex-direction: column; gap: 14px; }
      .panel {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); overflow: hidden;
      }
      .panel-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border);
      }
      .panel-head h2 {
        font-size: 15px; font-weight: 700; margin: 0; color: var(--text);
        display: flex; align-items: center; gap: 8px;
      }
      .ph-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .legend { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); }
      .sw { width: 10px; height: 10px; border-radius: 2px; }
      .sw--done { background: var(--ok); }
      .sw--in-progress { background: var(--accent2); }
      .sw--blocked { background: var(--warn2); }
      .sw--review { background: var(--accent); }
      .count-badge {
        font-size: 11px; font-weight: 700; color: #1b1402;
        background: var(--accent); padding: 1px 6px; border-radius: 999px;
      }
      .jump-now-btn {
        font-size: 11px; color: var(--accent); background: transparent;
        border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
        border-radius: 999px; padding: 3px 9px; cursor: pointer;
      }
      .jump-now-btn:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }

      /* swimlane layout */
      .swimlane { display: flex; overflow-x: auto; }
      .lane-col {
        position: sticky; left: 0; z-index: 4;
        flex: 0 0 280px; min-width: 0;
        background: var(--surface); border-right: 1px solid var(--border);
      }
      .lane-col-head, .grid-head {
        height: 28px; display: flex; align-items: center;
        border-bottom: 1px solid var(--border); padding: 0 12px;
      }
      .axis-label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }

      .tile {
        height: 68px; display: flex; align-items: center; gap: 10px;
        padding: 0 12px; border-bottom: 1px solid var(--border);
      }
      .tile:last-child { border-bottom: none; }
      .tile-av {
        width: 32px; height: 32px; border-radius: 9px; font-size: 13px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
        color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.35); flex-shrink: 0;
      }
      .tile-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .tile-top { display: flex; align-items: center; gap: 6px; }
      .tile-name { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tile-role { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; margin-left: auto; white-space: nowrap; }
      .tile-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .tile-dot--active { background: var(--ok); }
      .tile-dot--paused { background: var(--dim); }
      .press { height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--text) 10%, var(--surface)); overflow: hidden; }
      .press-fill { height: 100%; border-radius: 2px; transition: width .3s; }
      .press-fill--green { background: var(--ok); }
      .press-fill--amber { background: var(--warn2); }
      .press-fill--red { background: var(--danger); }
      .tile-stats { font-size: 10px; color: var(--muted); display: flex; gap: 5px; flex-wrap: wrap; }
      .tile-stats .sep { color: var(--border); }

      /* time grid */
      .time-grid { position: relative; flex: 1; min-width: 520px; }
      .grid-head { position: relative; padding: 0; }
      .tick {
        position: absolute; top: 50%; transform: translate(-50%, -50%);
        font-size: 10px; color: var(--dim); white-space: nowrap;
      }
      .tick:last-child { color: var(--accent); transform: translate(-100%, -50%); }
      .grid-body { position: relative; }
      .grid-row { position: relative; height: 68px; border-bottom: 1px solid var(--border); }
      .grid-row:last-child { border-bottom: none; }
      .gridline { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--border) 60%, transparent); }
      .now-line { position: absolute; top: 0; bottom: 0; right: 0; width: 2px; background: var(--accent); z-index: 3; }
      .now-tag {
        position: absolute; top: -1px; right: 0;
        font-size: 9px; font-weight: 700; color: #1b1402;
        background: var(--accent); padding: 1px 4px; border-radius: 0 0 0 3px;
      }

      /* bars */
      .bar {
        position: absolute; top: 20px; height: 28px;
        border-radius: 5px; cursor: default;
        border: 1px solid transparent;
        transition: transform 100ms ease, filter 100ms ease;
      }
      .bar:hover { transform: translateY(-1px); filter: brightness(1.12); z-index: 6; }
      .bar--done     { background: color-mix(in srgb, var(--ok) 70%, var(--surface)); border-color: var(--ok); }
      .bar--in_progress { background: color-mix(in srgb, var(--accent2) 70%, var(--surface)); border-color: var(--accent2); }
      .bar--open     { background: color-mix(in srgb, var(--dim) 50%, var(--surface)); border-color: var(--dim); }
      .bar--blocked  { background: color-mix(in srgb, var(--warn2) 65%, var(--surface)); border-color: var(--warn2); }
      .bar--review   { background: color-mix(in srgb, var(--accent) 70%, var(--surface)); border-color: var(--accent); }
      .bar--approved { background: color-mix(in srgb, var(--ok) 70%, var(--surface)); border-color: var(--ok); }
      .bar--rejected { background: color-mix(in srgb, var(--danger) 65%, var(--surface)); border-color: var(--danger); }
      .bar--growing::after {
        content: ''; position: absolute; right: -1px; top: -1px; bottom: -1px; width: 4px;
        border-radius: 0 5px 5px 0; background: currentColor; opacity: .5;
        animation: obs-pulse 1.4s ease-in-out infinite;
      }
      @keyframes obs-pulse {
        0%, 100% { opacity: .5; }
        50% { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .bar--growing::after { animation: none; }
        .tile-dot--active { animation: none; }
      }

      /* bar tooltip */
      .bar-tip {
        display: none; position: absolute; bottom: calc(100% + 8px); left: 50%;
        transform: translateX(-50%); min-width: 170px; max-width: 230px;
        background: var(--bg); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 8px 10px;
        flex-direction: column; gap: 4px;
        box-shadow: 0 8px 24px rgba(0,0,0,.15); z-index: 10; pointer-events: none;
      }
      .bar:hover .bar-tip { display: flex; }
      .bar-tip strong { font-size: 12px; font-weight: 600; color: var(--text); line-height: 1.35; }
      .bar-tip-meta { font-size: 10px; color: var(--muted); }
      .bar-tip-st { font-weight: 700; }
      .bar-tip-st--done, .bar-tip-st--approved { color: var(--ok); }
      .bar-tip-st--in_progress { color: var(--accent2); }
      .bar-tip-st--blocked { color: var(--warn2); }
      .bar-tip-st--review { color: var(--accent); }
      .bar-tip-st--rejected { color: var(--danger); }
      .bar-tip-st--open { color: var(--dim); }

      /* operator queue (reuses .appr-* classes already defined for /approvals) */
      .queue-section .appr-head { display: flex; justify-content: space-between; gap: 12px; }
      .queue-section .appr-title { font-weight: 600; }
      .queue-section .appr-meta { color: var(--muted); font-size: 13px; margin-top: 2px; }
      .queue-section .appr-when { color: var(--dim); font-size: 12px; white-space: nowrap; }
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
        flex: 1; min-width: 180px; font: inherit; font-size: 13px; padding: 7px 10px;
        border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text);
      }
      .btn-reject { background: transparent; color: var(--warn2); border: 1px solid var(--warn2); }
      .appr-status { font-size: 13px; color: var(--dim); }
      .approval.decided { opacity: .55; }

      /* recent tasks table */
      .recent-tasks { width: 100%; border-collapse: collapse; font-size: 13px; }
      .recent-tasks th, .recent-tasks td {
        text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); vertical-align: middle;
      }
      .recent-tasks th { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
      .recent-tasks tr:last-child td { border-bottom: none; }
      .recent-tasks .task-title { max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .agent-chip {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 12px; background: var(--bg); border: 1px solid var(--border);
        padding: 2px 8px 2px 4px; border-radius: 999px; white-space: nowrap;
      }
      .agent-chip-av {
        width: 14px; height: 14px; border-radius: 3px;
        display: inline-block; flex-shrink: 0;
      }
      .st-badge {
        font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px;
      }
      .st-badge--done { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, var(--surface)); }
      .st-badge--in_progress { color: var(--accent2); background: color-mix(in srgb, var(--accent2) 14%, var(--surface)); }
      .st-badge--open { color: var(--dim); background: color-mix(in srgb, var(--dim) 14%, var(--surface)); }
      .st-badge--blocked { color: var(--warn2); background: color-mix(in srgb, var(--warn2) 14%, var(--surface)); }
      .st-badge--review { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface)); }
      .st-badge--approved { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, var(--surface)); }
      .st-badge--rejected { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, var(--surface)); }

      /* cost chip — placeholder until #15 */
      .cost-chip { font-size: 11px; color: var(--dim); }

      @media (max-width: 900px) {
        .lane-col { flex: 0 0 220px; }
        .recent-tasks .cost-chip { display: none; }
      }
      @media (max-width: 720px) {
        .lane-col { flex: 0 0 180px; }
        .tile-stats { display: none; }
        .recent-tasks th:nth-child(n+4), .recent-tasks td:nth-child(n+4) { display: none; }
      }

      /* ── Unit cards (#26) — employee-performance panel style ─────────────────── */
      /* The card grid wraps at 1280px: each card is min 300px, max 380px.
         No horizontal overflow: the knobs form uses a max-width constraint and
         budget/window inputs never overflow at 1280px. */
      .unit-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 16px;
        margin: 16px 0;
      }
      .unit-card {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); overflow: hidden;
        display: flex; flex-direction: column;
      }
      .unit-card-head {
        display: flex; align-items: center; gap: 10px;
        padding: 14px 16px 10px;
        border-bottom: 1px solid var(--border);
      }
      .unit-av {
        width: 36px; height: 36px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        font-size: 15px; font-weight: 700; color: #fff;
        text-shadow: 0 1px 2px rgba(0,0,0,.3); flex-shrink: 0;
      }
      .unit-head-body { flex: 1; min-width: 0; }
      .unit-name {
        font-weight: 700; font-size: 14px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .unit-role { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
      .unit-status-dot {
        width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
        margin-left: auto;
      }
      .unit-status-dot--active { background: var(--ok); }
      .unit-status-dot--paused { background: var(--dim); }

      .unit-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; flex: 1; }

      .unit-field { display: flex; flex-direction: column; gap: 3px; }
      .unit-field-label {
        font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); font-weight: 600;
      }
      .unit-field-value { font-size: 13px; color: var(--text); line-height: 1.4; }
      .unit-field-value.muted { color: var(--muted); }
      .unit-field-value.dim { color: var(--dim); font-style: italic; }

      /* KPI progress bar */
      .kpi-bar-wrap {
        height: 4px; background: color-mix(in srgb, var(--text) 10%, var(--surface));
        border-radius: 2px; overflow: hidden; margin-top: 4px;
      }
      .kpi-bar-fill { height: 100%; border-radius: 2px; transition: width .3s; background: var(--ok); }

      /* Effort dial — rendered as a badge with accent colour per level */
      .effort-badge {
        display: inline-block; font-size: 11px; font-weight: 700;
        padding: 2px 8px; border-radius: 999px; border: 1px solid;
      }
      .effort-low      { color: var(--ok);     border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
      .effort-standard { color: var(--accent2); border-color: color-mix(in srgb, var(--accent2) 40%, var(--border)); }
      .effort-high     { color: var(--accent);  border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
      .effort-sprint   { color: var(--danger);  border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }

      /* Autonomy badge */
      .autonomy-badge {
        display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px;
        border: 1px solid var(--border); color: var(--muted);
      }
      .autonomy-execute_with_approval { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
      .autonomy-execute { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }

      /* Budget row */
      .unit-budget { display: flex; align-items: baseline; gap: 6px; font-size: 13px; }
      .unit-budget .cap { font-weight: 600; color: var(--text); }
      .unit-budget .window { color: var(--dim); font-size: 11px; }

      /* Task title chips */
      .unit-task-chip {
        font-size: 12px; padding: 3px 8px;
        background: var(--surface2); border: 1px solid var(--border);
        border-radius: 6px; color: var(--text);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        max-width: 100%;
        display: block;
      }

      /* Knobs form — collapsible via <details> */
      .unit-knobs { border-top: 1px solid var(--border); }
      .unit-knobs summary {
        padding: 8px 16px; font-size: 12px; color: var(--muted); cursor: pointer;
        user-select: none; list-style: none; display: flex; align-items: center; gap: 6px;
      }
      .unit-knobs summary::-webkit-details-marker { display: none; }
      .unit-knobs summary::before { content: '▸'; font-size: 10px; }
      .unit-knobs[open] summary::before { content: '▾'; }
      .unit-knobs-body {
        padding: 12px 16px 14px;
        display: flex; flex-direction: column; gap: 10px;
      }
      .knob-row { display: flex; flex-direction: column; gap: 4px; }
      .knob-label { font-size: 11px; color: var(--muted); }
      .knob-input, .knob-select {
        font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 7px;
        border: 1px solid var(--border); background: var(--bg); color: var(--text);
        width: 100%;
      }
      .knob-row-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .knob-submit { margin-top: 4px; }

      /* Squad rollup header on /squads/:id */
      .squad-unit-header {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 16px 18px; margin-bottom: 18px;
      }
      .squad-unit-header h2 { margin: 0 0 12px; }
      .squad-unit-meta { display: flex; flex-wrap: wrap; gap: 10px 20px; font-size: 13px; }
      .squad-unit-meta .suf-item { display: flex; flex-direction: column; gap: 2px; }
      .squad-unit-meta .suf-label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }

      /* ── /approvals page styles (kept here to avoid duplication) ── */
    </style>
  </head>
  <body>
    <header class="top">
      <div class="brand"><b>${brand}</b> · substrate console</div>
      <nav>
        <a href="/">Overview</a>
        <a href="/send">Send</a>
        <a href="/approvals">Approvals</a>
        <a href="/agents">Agents</a>
        <a href="/fleet">Fleet</a>
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


// ── Observatory (#13) — the new GET / home ────────────────────────────────────
//
// Three sections:
//   1. Swimlane — all agents × 24h time grid with task bars.
//   2. Operator queue — tasks in 'review' the caller may verdict (reuses
//      loadApprovals + the shared verdict POST wiring from /approvals).
//   3. Recent tasks — last 10 tasks, most recent first.
//
// Read-only except the operator-queue verdict buttons (existing endpoint).
// Cost column renders '—' until #15 (metered spend) lands.

function observatoryBody(
  brand: string,
  data: ObservatoryData,
  approvals: ApprovalItem[],
  auth: AuthContext,
) {
  const { agents, stats, bars, ticks, recentTasks } = data

  // ── swimlane ──────────────────────────────────────────────────────────────
  // Bars grouped by agent_id for O(1) row render.
  const barsByAgent = new Map<string, SwimlaneBar[]>()
  for (const b of bars) {
    const list = barsByAgent.get(b.agent_id) ?? []
    list.push(b)
    barsByAgent.set(b.agent_id, list)
  }

  // Tick <span>s — 7 items. Last is 'now', positioned right-aligned.
  const tickSpans = ticks
    .map((t, i) => {
      const pct = (i / (ticks.length - 1)) * 100
      return `<span class="tick" style="left:${pct.toFixed(2)}%">${escHtml(t)}</span>`
    })
    .join('')

  // Gridline <span>s — same positions as ticks (except last = right edge = now-line).
  const gridlines = ticks
    .slice(0, -1)
    .map((_, i) => {
      const pct = (i / (ticks.length - 1)) * 100
      return `<span class="gridline" style="left:${pct.toFixed(2)}%"></span>`
    })
    .join('')

  // Agent tiles (left sticky column)
  const agentTiles = agents.length === 0
    ? '<div class="tile"><span class="empty">No agents yet.</span></div>'
    : agents.map((a) => {
        const stat: AgentStat = stats.get(a.id) ?? {
          agent_id: a.id,
          task_count: 0,
          done_count: 0,
          success_pct: 0,
          in_flight: 0,
          spend_micro_usd: 0,
        }
        const pressure = stat.in_flight > 0 ? Math.min(stat.in_flight * 25, 100) : 0
        const pressClass = pressure > 85 ? 'red' : pressure > 65 ? 'amber' : 'green'
        const grad = agentGradient(a.name)
        const initial = escHtml(a.name.slice(0, 1).toUpperCase())
        const dotClass = a.status === 'active' ? 'active' : 'paused'
        return (
          `<div class="tile">` +
          `<span class="tile-av" style="background:${grad}">${initial}</span>` +
          `<div class="tile-body">` +
          `<div class="tile-top">` +
          `<a href="/agents/${escAttr(a.id)}" class="tile-name">${escHtml(a.name)}</a>` +
          `<span class="tile-dot tile-dot--${dotClass}" title="${escAttr(a.status)}"></span>` +
          `<span class="tile-role">${escHtml(a.role)}</span>` +
          `</div>` +
          `<div class="press"><div class="press-fill press-fill--${pressClass}" style="width:${pressure}%"></div></div>` +
          `<div class="tile-stats">` +
          `<span>${escHtml(String(stat.task_count))} tasks</span><span class="sep">·</span>` +
          `<span>${escHtml(String(stat.success_pct))}%</span><span class="sep">·</span>` +
          // Cost (#15): summed task spend over the 24h window (estimated).
          `<span class="cost-chip" title="Estimated spend, last 24h">${escHtml(formatUsd(stat.spend_micro_usd))}</span>` +
          `</div>` +
          `</div>` +
          `</div>`
        )
      }).join('')

  // Grid rows (one per agent)
  const gridRows = agents.length === 0
    ? '<div class="grid-row"></div>'
    : agents.map((a) => {
        const agentBars = barsByAgent.get(a.id) ?? []
        const barHtml = agentBars
          .map((b) => {
            const growingClass = b.growing ? ' bar--growing' : ''
            const statusClass = `bar--${b.status}`
            const tipStatus = `<span class="bar-tip-st bar-tip-st--${b.status}">${escHtml(b.status.replace('_', ' '))}</span>`
            const when = b.completed_at
              ? escHtml(b.completed_at.slice(0, 16).replace('T', ' '))
              : 'in progress'
            return (
              `<div class="bar ${statusClass}${growingClass}"` +
              ` style="left:${b.left_pct.toFixed(2)}%;width:${b.width_pct.toFixed(2)}%"` +
              ` title="${escAttr(b.title)}">` +
              `<div class="bar-tip">` +
              `<strong>${escHtml(b.title)}</strong>` +
              `<span class="bar-tip-meta">${tipStatus} · ${when}</span>` +
              `</div>` +
              `</div>`
            )
          })
          .join('')
        return `<div class="grid-row">${barHtml}</div>`
      }).join('')

  const swimlaneSection = `
  <section class="panel swimlane-panel">
    <div class="panel-head">
      <h2>Fleet activity · last 24h</h2>
      <div class="ph-right">
        <span class="legend"><i class="sw sw--done"></i>done</span>
        <span class="legend"><i class="sw sw--in-progress"></i>in progress</span>
        <span class="legend"><i class="sw sw--blocked"></i>blocked</span>
        <span class="legend"><i class="sw sw--review"></i>review</span>
        <button class="jump-now-btn" id="jumpNow">Jump to now →</button>
      </div>
    </div>
    <div class="swimlane" id="swimlane">
      <div class="lane-col">
        <div class="lane-col-head"><span class="axis-label">Agents</span></div>
        ${agentTiles}
      </div>
      <div class="time-grid">
        <div class="grid-head">${tickSpans}</div>
        <div class="grid-body">
          ${gridlines}
          <span class="now-line"><span class="now-tag">NOW</span></span>
          ${gridRows}
        </div>
      </div>
    </div>
  </section>`

  // ── operator queue ────────────────────────────────────────────────────────
  const queueCount = approvals.length
  const queueCards = approvals.map((t) => approvalCardHtml(t)).join('')

  const operatorSection = `
  <section class="panel queue-section">
    <div class="panel-head">
      <h2>Needs your decision${queueCount > 0 ? ` <span class="count-badge">${queueCount}</span>` : ''}</h2>
      <a href="/approvals" style="font-size:13px;color:var(--muted)">All approvals →</a>
    </div>
    ${queueCount > 0
      ? `<div id="obs-queue">${queueCards}</div>`
      : `<div style="padding:14px 18px"><p class="empty" style="margin:0">Nothing waiting at your gates. Gated work lands here when an agent finishes it.</p></div>`
    }
  </section>`

  // ── recent tasks ──────────────────────────────────────────────────────────
  const taskRows = recentTasks.map((t) => {
    const agentName = t.agent_name ?? t.agent_id ?? '—'
    const grad = t.agent_name ? agentGradient(t.agent_name) : 'var(--dim)'
    const initial = agentName.slice(0, 1).toUpperCase()
    const when = (t.completed_at ?? t.created_at).slice(0, 16).replace('T', ' ')
    return (
      `<tr>` +
      `<td class="task-title">${escHtml(t.title)}</td>` +
      `<td>` +
      `<span class="agent-chip">` +
      `<span class="agent-chip-av" style="background:${grad}" title="${escAttr(agentName)}">${escHtml(initial)}</span>` +
      `${escHtml(agentName)}` +
      `</span>` +
      `</td>` +
      `<td><span class="st-badge st-badge--${t.status}">${escHtml(t.status.replace('_', ' '))}</span></td>` +
      // Cost (#15): per-task spend stamped at execution (estimated; '—' if never run).
      `<td class="cost-chip" title="Estimated spend for this task">${t.cost_micro_usd > 0 ? escHtml(formatUsd(t.cost_micro_usd)) : '—'}</td>` +
      `<td style="color:var(--dim);font-size:12px">${escHtml(when)}</td>` +
      `</tr>`
    )
  }).join('')

  const recentSection = `
  <section class="panel">
    <div class="panel-head">
      <h2>Recent tasks</h2>
    </div>
    ${recentTasks.length === 0
      ? `<div style="padding:14px 18px"><p class="empty" style="margin:0">No tasks yet.</p></div>`
      : `<div style="overflow-x:auto"><table class="recent-tasks">
           <thead><tr>
             <th>Task</th><th>Agent</th><th>Status</th>
             <th class="cost-chip">Cost</th><th>When</th>
           </tr></thead>
           <tbody>${taskRows}</tbody>
         </table></div>`
    }
  </section>`

  const hasData = agents.length > 0
  const hint = hasData
    ? ''
    : `<div class="card" style="margin-bottom:14px">
         <p class="empty" style="margin:0">No agents yet. <a href="/">Add departments and squads</a> from the org tree, then add agents to see them here.</p>
       </div>`

  return html`
    <h1>${brand}</h1>
    <p class="crumbs">Signed in as ${auth.email ?? auth.userId} · ${auth.role}</p>
    <p style="margin:4px 0 14px"><a class="btn" href="/send" style="display:inline-block;text-decoration:none">Send a task →</a></p>
    ${raw(hint)}
    <div class="obs">
      ${raw(swimlaneSection)}
      ${raw(operatorSection)}
      ${raw(recentSection)}
    </div>
    ${queueCount > 0 ? raw(obsQueueScript()) : html``}`
}

/**
 * Render one approval item as an HTML card string.
 * Shared between observatoryBody (operator queue) and approvalsBody (/approvals page).
 * The verdict buttons call the existing RBAC-gated POST /api/tasks/:id/verdict endpoint.
 * NO new write path is introduced here (adversarial review point from #12).
 */
function approvalCardHtml(t: ApprovalItem): string {
  const preview = resultPreview(t)
  const agentLabel = escHtml(t.agent_name ?? t.assignee_agent_id ?? 'unassigned')
  const squadLabel = escHtml(t.squad_name ?? t.squad_id)
  const gateChip = t.gate_owner
    ? `· <span class="gate-chip">${escHtml(t.gate_owner)}</span>`
    : ''
  const when = escHtml((t.completed_at ?? t.created_at).slice(0, 16).replace('T', ' '))
  const previewHtml = preview
    ? `<div class="appr-result"><div class="lbl">Result</div>${escHtml(preview)}</div>`
    : ''
  return `
    <div class="card approval" data-task="${escAttr(t.id)}" style="border-left:3px solid var(--accent)">
      <div class="appr-head">
        <div>
          <div class="appr-title">${escHtml(t.title)}</div>
          <div class="appr-meta">${agentLabel} · ${squadLabel} ${gateChip}</div>
        </div>
        <div class="appr-when">${when}</div>
      </div>
      <div class="appr-body">${escHtml(t.body)}</div>
      ${previewHtml}
      <div class="appr-actions">
        <input type="text" class="appr-note" placeholder="note (optional; required to reject)" />
        <button class="btn appr-approve">Approve</button>
        <button class="btn btn-reject appr-reject">Reject</button>
        <span class="appr-status"></span>
      </div>
    </div>`
}

/** Vanilla JS that wires the verdict buttons in the observatory operator queue.
 *  Identical logic to approvalsScript() — same endpoint, same pattern. */
function obsQueueScript(): string {
  // Escape JSON.stringify output is safe for raw() injection.
  return `
    <script>
      (function () {
        document.querySelectorAll('#obs-queue .approval').forEach(function (card) {
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
                status.textContent = verdict === 'approved' ? 'approved' : 'rejected';
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

        // Jump-to-now: scroll the swimlane grid all the way right.
        var jumpBtn = document.getElementById('jumpNow');
        if (jumpBtn) {
          jumpBtn.addEventListener('click', function () {
            var sl = document.getElementById('swimlane');
            if (sl) sl.scrollTo({ left: sl.scrollWidth, behavior: 'smooth' });
          });
        }
      })();
    </script>`
}


function squadBoardBody(squad: Squad, agents: Agent[], tasks: Task[], canAddAgent: boolean, canManage = false) {
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
            <input name="model" value="@cf/meta/llama-3.3-70b-instruct-fp8-fast" />
          </label>
          <button type="submit" class="btn">Add agent</button>
        </form>`
    : html``

  // Squad rollup header — shows the squad's own OKR/KPI/effort/autonomy if set,
  // plus a compact Configure form for admins (fractal: same knob shape as agents).
  const squadKnobs = canManage
    ? raw(unitKnobsForm(squad.id, 'squad', {
        okr: squad.okr,
        kpi_target: squad.kpi_target,
        effort: squad.effort,
        autonomy: squad.autonomy,
        budget_cap_cents: squad.budget_cap_cents,
        budget_window: squad.budget_window,
      }))
    : html``

  const kpiPct = Math.min(Math.max(squad.kpi_progress ?? 0, 0), 100)
  const squadHeader = html`
    <div class="squad-unit-header">
      <h2 style="margin-top:0;margin-bottom:10px">${squad.name} · work unit</h2>
      <div class="squad-unit-meta">
        <div class="suf-item">
          <span class="suf-label">Objective</span>
          <span style="font-size:13px">${squad.okr ? squad.okr : raw('<em style="color:var(--dim)">not set</em>')}</span>
        </div>
        <div class="suf-item">
          <span class="suf-label">KPI</span>
          <span style="font-size:13px">${squad.kpi_target ? squad.kpi_target : raw('<em style="color:var(--dim)">not set</em>')} · ${kpiPct}%</span>
        </div>
        <div class="suf-item">
          <span class="suf-label">Effort</span>
          ${raw(effortBadge(squad.effort))}
        </div>
        <div class="suf-item">
          <span class="suf-label">Autonomy</span>
          ${raw(autonomyBadge(squad.autonomy))}
        </div>
        <div class="suf-item">
          <span class="suf-label">Budget</span>
          ${raw(budgetLine(squad.budget_cap_cents, squad.budget_window))}
        </div>
      </div>
      ${squadKnobs}
    </div>`

  return html`
    <p class="crumbs"><a href="/">Overview</a> / ${squad.name}</p>
    <h1>${squad.name}</h1>
    ${squadHeader}
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

// ── approvals page (/approvals) ───────────────────────────────────────────────
//
// Card HTML is now factored into approvalCardHtml() which is shared with the
// observatory operator queue. The verdict script is also shared via approvalsScript().
// The inline <style> block for .appr-* classes was moved into shell() to avoid
// duplication across pages.

function approvalsBody(items: ApprovalItem[]) {
  // Re-use the shared card renderer. Wrap in a named container so the script can
  // scope its querySelectorAll without touching #obs-queue on the home page.
  const cards = items.map((t) => approvalCardHtml(t)).join('')

  return html`
    <p class="crumbs"><a href="/">Overview</a> / Approvals</p>
    <h1>Approvals</h1>
    <p class="empty" style="margin-top:0;max-width:640px">
      Work waiting at your gate. Approve to release it; reject sends it back with your note.
    </p>
    ${items.length ? raw(`<div id="approvals-list">${cards}</div>`) : html`<div class="card"><p class="empty">Nothing waiting at your gates. Gated work lands here when an agent finishes it.</p></div>`}
    ${items.length ? approvalsScript() : html``}`
}

function approvalsScript() {
  // Same-origin, credentialed. POSTs to the existing RBAC'd verdict endpoint;
  // CSRF Origin check + no-store come from the dashboard middleware.
  return raw(`
    <script>
      (function () {
        var list = document.getElementById('approvals-list');
        if (!list) return;
        list.querySelectorAll('.approval').forEach(function (card) {
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

// ── fleet views ───────────────────────────────────────────────────────────────

function fleetUnconfiguredBody() {
  return html`
    <p class="crumbs"><a href="/">Overview</a> / Fleet</p>
    <h1>Fleet</h1>
    <div class="card"><p class="empty">This pot has no bus connection configured
    (BUS_TOKEN). The fleet view lives on HQ pots wired to the company bus.</p></div>`
}

function fleetBody(rows: FleetRow[], error: string | null) {
  const dot = (l: string) =>
    l === 'active' ? 'var(--ok)' : l === 'idle' ? 'var(--warn)' : l === 'dead' ? '#e5534b' : 'var(--dim)'
  const tr = (r: FleetRow) => `
    <tr data-agent="${escAttr(r.agent)}" class="fl-row ${r.liveness === 'dead' || r.liveness === 'never' ? 'fl-dim' : ''}">
      <td><span class="fl-dot" style="background:${dot(r.liveness)}"></span>${escHtml(r.agent)}</td>
      <td class="fl-label">${escHtml(r.label || '—')}</td>
      <td><span class="fl-badge fl-${escAttr(r.liveness)}">${escHtml(r.liveness)}</span></td>
      <td>${escHtml(r.last_seen_human)}</td>
      <td class="fl-num">${r.messages}</td>
      <td>${r.active_token ? 'yes' : '<span style="color:var(--dim)">no</span>'}</td>
      <td class="fl-actions">
        <button class="fl-btn" data-act="wake">Run</button>
        <button class="fl-btn" data-act="pause">Pause</button>
        <button class="fl-btn" data-act="deactivate">Deactivate</button>
        <button class="fl-btn fl-danger" data-act="delete">Delete</button>
        <span class="fl-status"></span>
      </td>
    </tr>`
  const table = rows.length
    ? `<table class="fl-table">
        <thead><tr><th>Agent</th><th>Role / label</th><th>Status</th><th>Last active</th><th>Msgs</th><th>Token</th><th>Actions</th></tr></thead>
        <tbody>${rows.map(tr).join('')}</tbody>
      </table>`
    : '<p class="empty">No agents visible on the bus.</p>'
  return html`
    <p class="crumbs"><a href="/">Overview</a> / Fleet</p>
    <h1>Fleet</h1>
    <p class="empty" style="margin-top:0;max-width:680px">
      Every company agent on the bus. <b>Run</b> pings the agent directly.
      Pause / Deactivate / Delete send a receipted control request to operations
      (owner/admin only) — nothing here kills a process silently.</p>
    <style>
      .fl-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
      .fl-table th { text-align: left; color: var(--muted); font-size: 12px; text-transform: uppercase;
        letter-spacing: .5px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
      .fl-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
      .fl-dim td { opacity: .6; }
      .fl-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; }
      .fl-label { color: var(--muted); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fl-badge { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
      .fl-active { color: var(--ok); } .fl-idle { color: var(--warn); }
      .fl-dead { color: #e5534b; } .fl-never { color: var(--dim); }
      .fl-num { text-align: right; font-variant-numeric: tabular-nums; }
      .fl-actions { white-space: nowrap; }
      .fl-btn { font: inherit; font-size: 12px; padding: 3px 9px; margin-right: 4px; border-radius: 6px;
        border: 1px solid var(--border); background: var(--surface2); color: var(--text); cursor: pointer; }
      .fl-btn:hover { border-color: var(--accent); }
      .fl-danger { color: #e5534b; }
      .fl-status { font-size: 12px; color: var(--dim); margin-left: 6px; }
    </style>
    ${error ? html`<div class="card"><p class="empty">Bus error: ${error} — showing nothing rather than stale data.</p></div>` : raw(`<div class="card" style="padding:0;overflow-x:auto">${table}</div>`)}
    ${rows.length ? fleetScript() : html``}`
}

function fleetScript() {
  return raw(`
    <script>
      (function () {
        document.querySelectorAll('.fl-row').forEach(function (row) {
          var agent = row.getAttribute('data-agent');
          var status = row.querySelector('.fl-status');
          row.querySelectorAll('.fl-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var act = btn.getAttribute('data-act');
              if (act === 'delete' && !confirm('Request DELETE of agent "' + agent + '"? Operations executes and acks.')) return;
              var url = act === 'wake' ? '/dashboard/fleet/wake' : '/dashboard/fleet/control';
              var payload = act === 'wake' ? { agent: agent } : { agent: agent, action: act };
              btn.disabled = true; status.textContent = '…';
              fetch(url, { method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (r) {
                  status.textContent = r.ok
                    ? (act === 'wake' ? 'pinged ✓' : 'requested ✓ (' + (r.d.request_id || '').slice(0, 8) + ')')
                    : (r.d.error || 'failed');
                  btn.disabled = false;
                })
                .catch(function () { status.textContent = 'network error'; btn.disabled = false; });
            });
          });
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

// ── Unit card renderer (#26) ───────────────────────────────────────────────────
//
// unitCard(u, canManage) — the employee-performance panel. One card per agent.
// Layout: avatar + name/role header, then body sections: Objective (OKR), KPI +
// progress bar, Effort dial, Autonomy badge, Burn gauge ($X/hr, #15), Budget cap
// + window, Current Work (most-recent in_progress/open task), Next Approval (task
// in 'review'). Followed by a collapsed Knobs form for admins.
//
// All strings are manually escaped (escHtml/escAttr) because the card is built
// as a raw string for injection into a grid container via raw().
//
// Burn ($X/hr) is derived from today's metered spend (#15): the agent's current-day
// execution_meter window, priced via src/agents/cost.ts. The budget cap + window
// fields give the configured ceiling alongside the live rate.

function agentGradientLocal(name: string): string {
  // Same deterministic gradient as observatory — kept local to avoid a cross-module
  // import of agentGradient from observatory.ts (that module pulls in loadObservatory).
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  const h2 = (h + 48) % 360
  return `linear-gradient(135deg,hsl(${h} 58% 46%),hsl(${h2} 62% 38%))`
}

function effortBadge(effort: string): string {
  const label = effort.charAt(0).toUpperCase() + effort.slice(1)
  return `<span class="effort-badge effort-${escAttr(effort)}">${escHtml(label)}</span>`
}

function autonomyBadge(autonomy: string): string {
  const label = autonomy.replace(/_/g, ' ')
  return `<span class="autonomy-badge autonomy-${escAttr(autonomy)}">${escHtml(label)}</span>`
}

function budgetLine(capCents: number | null, window: string): string {
  if (capCents === null) return `<span class="unit-field-value dim">no cap set</span>`
  const dollars = (capCents / 100).toFixed(2)
  return (
    `<div class="unit-budget">` +
    `<span class="cap">$${escHtml(dollars)}</span>` +
    `<span class="window">/ ${escHtml(window)}</span>` +
    `</div>`
  )
}

function unitKnobsForm(id: string, kind: 'agent' | 'squad', u: {
  okr: string | null
  kpi_target: string | null
  effort: string
  autonomy: string
  budget_cap_cents: number | null
  budget_window: string
}): string {
  const action = kind === 'agent' ? `/agents/${escAttr(id)}/config` : `/squads/${escAttr(id)}/config`
  const budgetDollars = u.budget_cap_cents !== null ? (u.budget_cap_cents / 100).toFixed(2) : ''
  const effortOptions = ['low', 'standard', 'high', 'sprint']
    .map((e) => `<option value="${e}"${u.effort === e ? ' selected' : ''}>${e}</option>`)
    .join('')
  const autonomyOptions = ['suggest', 'draft', 'execute', 'execute_with_approval']
    .map((a) => `<option value="${a}"${u.autonomy === a ? ' selected' : ''}>${a.replace(/_/g, ' ')}</option>`)
    .join('')
  const windowOptions = ['day', 'week']
    .map((w) => `<option value="${w}"${u.budget_window === w ? ' selected' : ''}>${w}</option>`)
    .join('')

  return (
    `<details class="unit-knobs">` +
    `<summary>Configure</summary>` +
    `<form class="unit-knobs-body" method="post" action="${action}" autocomplete="off">` +
    `<div class="knob-row"><label class="knob-label">Objective (OKR)` +
    `<input class="knob-input" name="okr" value="${escAttr(u.okr ?? '')}" placeholder="Drive Q3 pipeline to 50 leads" /></label></div>` +
    `<div class="knob-row"><label class="knob-label">KPI target` +
    `<input class="knob-input" name="kpi_target" value="${escAttr(u.kpi_target ?? '')}" placeholder="50 leads" /></label></div>` +
    `<div class="knob-row-2col">` +
    `<div class="knob-row"><label class="knob-label">Effort` +
    `<select class="knob-select" name="effort">${effortOptions}</select></label></div>` +
    `<div class="knob-row"><label class="knob-label">Autonomy` +
    `<select class="knob-select" name="autonomy">${autonomyOptions}</select></label></div>` +
    `</div>` +
    `<div class="knob-row-2col">` +
    `<div class="knob-row"><label class="knob-label">Budget cap ($)` +
    `<input class="knob-input" name="budget_cap_dollars" type="number" min="0" step="0.01" ` +
    `value="${escAttr(budgetDollars)}" placeholder="50.00" /></label></div>` +
    `<div class="knob-row"><label class="knob-label">Window` +
    `<select class="knob-select" name="budget_window">${windowOptions}</select></label></div>` +
    `</div>` +
    `<button type="submit" class="btn sm knob-submit">Save</button>` +
    `</form>` +
    `</details>`
  )
}

/** Render one agent as an employee-performance unit card. */
function unitCard(u: AgentAdminRow, canManage: boolean): string {
  const grad = agentGradientLocal(u.name)
  const initial = escHtml(u.name.slice(0, 1).toUpperCase())
  const dotClass = u.status === 'active' ? 'active' : 'paused'

  // OKR / Objective
  const okrLine = u.okr
    ? `<span class="unit-field-value">${escHtml(u.okr)}</span>`
    : `<span class="unit-field-value dim">not set</span>`

  // KPI + progress bar
  const kpiLabel = u.kpi_target ? escHtml(u.kpi_target) : '<em style="color:var(--dim)">not set</em>'
  const kpiPct = Math.min(Math.max(u.kpi_progress ?? 0, 0), 100)
  const kpiSection =
    `<div class="unit-field">` +
    `<span class="unit-field-label">KPI</span>` +
    `<span class="unit-field-value">${kpiLabel}</span>` +
    `<div class="kpi-bar-wrap"><div class="kpi-bar-fill" style="width:${kpiPct}%"></div></div>` +
    `<span style="font-size:11px;color:var(--dim)">${kpiPct}%</span>` +
    `</div>`

  // Burn ($/hr) — derived from today's spend (#15). Shows the rate plus today's
  // running total in the tooltip. $0.00/hr when the unit has not spent today.
  const burn = formatBurn(u.spend_today_micro_usd, Date.now())
  const spentToday = formatUsd(u.spend_today_micro_usd)
  const burnLine =
    `<span class="unit-field-value" title="${escAttr(`${spentToday} spent today (UTC) · estimated from token usage`)}">` +
    `${escHtml(burn)}` +
    (u.spend_today_micro_usd > 0 ? ` <span class="dim" style="font-size:11px">· ${escHtml(spentToday)} today</span>` : '') +
    `</span>`

  // Budget cap + window (the concrete configured number)
  const budgetSection =
    `<div class="unit-field">` +
    `<span class="unit-field-label">Budget</span>` +
    budgetLine(u.budget_cap_cents, u.budget_window) +
    `</div>`

  // Current work
  const currentWork = u.current_task_title
    ? `<span class="unit-task-chip" title="${escAttr(u.current_task_title)}">${escHtml(u.current_task_title)}</span>`
    : `<span class="unit-field-value dim">idle</span>`

  // Next approval
  const nextApproval = u.review_task_title
    ? `<span class="unit-task-chip" title="${escAttr(u.review_task_title)}">${escHtml(u.review_task_title)}</span>`
    : `<span class="unit-field-value dim">—</span>`

  // Admin action buttons (pause/resume + delete) keep the existing pattern
  const actions = canManage
    ? `<div style="display:flex;gap:6px;padding:10px 16px;border-top:1px solid var(--border)">` +
      `<button class="btn sm ag-status-btn" data-agent="${escAttr(u.id)}" data-status="${escAttr(u.status)}" ` +
      `data-name="${escAttr(u.name)}">${u.status === 'active' ? 'Pause' : 'Resume'}</button>` +
      `<button class="btn sm ag-delete-btn" style="background:transparent;color:#e5534b;border-color:#e5534b" ` +
      `data-agent="${escAttr(u.id)}" data-name="${escAttr(u.name)}">Delete</button>` +
      `<span class="ag-row-status" data-agent-row="${escAttr(u.id)}" style="font-size:12px;color:var(--dim);margin-left:4px"></span>` +
      `</div>`
    : ''

  const knobsForm = canManage ? unitKnobsForm(u.id, 'agent', u) : ''

  return (
    `<div class="unit-card" data-agent-row="${escAttr(u.id)}">` +
    // Header
    `<div class="unit-card-head">` +
    `<div class="unit-av" style="background:${grad}">${initial}</div>` +
    `<div class="unit-head-body">` +
    `<a href="/agents/${escAttr(u.id)}" class="unit-name">${escHtml(u.name)}</a>` +
    `<div class="unit-role">${escHtml(u.role)}</div>` +
    `</div>` +
    `<span class="unit-status-dot unit-status-dot--${dotClass}" title="${escAttr(u.status)}"></span>` +
    `</div>` +
    // Body
    `<div class="unit-body">` +
    `<div class="unit-field"><span class="unit-field-label">Objective</span>${okrLine}</div>` +
    kpiSection +
    `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">` +
    `<div class="unit-field"><span class="unit-field-label">Effort</span><div>${effortBadge(u.effort)}</div></div>` +
    `<div class="unit-field"><span class="unit-field-label">Autonomy</span><div>${autonomyBadge(u.autonomy)}</div></div>` +
    `</div>` +
    `<div class="unit-field"><span class="unit-field-label">Burn</span>${burnLine}</div>` +
    budgetSection +
    `<div class="unit-field"><span class="unit-field-label">Current Work</span>${currentWork}</div>` +
    `<div class="unit-field"><span class="unit-field-label">Next Approval</span>${nextApproval}</div>` +
    `</div>` +
    // Knobs + admin actions
    knobsForm +
    actions +
    `</div>`
  )
}

// ── /agents view ─────────────────────────────────────────────────────────────
//
// agentsBody — renders the full agent management page:
//   - Grid of unit cards (employee-performance panel, one per agent)
//   - Per-card Pause/Resume + Delete buttons (owner/admin only, JS fetch)
//   - Per-card Knobs form (admin only): set OKR/KPI/effort/autonomy/budget
//   - Add-agent form (name, slug, role, model, squad picker)
//
// All user-supplied strings are escaped via escHtml/escAttr.
// Status mutations call POST /agents/:id/status (JSON body {status}).
// Delete calls DELETE /agents/:id (fetch with method:DELETE + confirm()).

function agentsBody(
  agents: AgentAdminRow[],
  squadOptions: SquadOption[],
  canManage: boolean,
  errorMsg: string | null = null,
) {
  const errorBanner = errorMsg
    ? `<div class="warn-box" style="margin-bottom:14px"><strong>Error:</strong> ${escHtml(errorMsg)}</div>`
    : ''

  // Squad <option>s for the add-agent form.
  const squadOptHtml = squadOptions.length === 0
    ? '<option disabled value="">No squads — create a squad first</option>'
    : squadOptions
        .map((s) => {
          const label = s.dept_name
            ? `${s.dept_name} / ${s.name}`
            : s.name
          return `<option value="${escAttr(s.id)}">${escHtml(label)}</option>`
        })
        .join('')

  // Unit card grid — employee performance panels, one per agent.
  const cardsHtml = agents.length === 0
    ? `<div class="card"><p class="empty">No agents yet. Add one below.</p></div>`
    : `<div class="unit-grid">${agents.map((a) => unitCard(a, canManage)).join('')}</div>`

  const addForm = canManage && squadOptions.length > 0
    ? `<div class="card" style="margin-top:20px">
        <h2 style="margin-top:0">Add agent</h2>
        <form class="adminform" method="post" action="/agents" autocomplete="off">
          <label>Name
            <input name="name" required placeholder="Dispatcher" />
          </label>
          <label>Slug
            <input name="slug" required placeholder="dispatcher" />
          </label>
          <label>Role
            <input name="role" placeholder="member" />
          </label>
          <label>Model
            <input name="model" value="@cf/meta/llama-3.3-70b-instruct-fp8-fast" />
          </label>
          <label>Squad
            <select name="squad_id" required>${squadOptHtml}</select>
          </label>
          <button type="submit" class="btn">Add agent</button>
        </form>
      </div>`
    : canManage
      ? `<div class="card" style="margin-top:20px"><p class="empty">Create a squad first, then add agents.</p></div>`
      : ''

  // Starter packs (#11): one-click seed of a branded squad + its work-units.
  // Admin-only; each button POSTs to the RBAC'd /squads/packs/:key seeder.
  const packsCard = canManage && SQUAD_PACKS.length > 0
    ? `<div class="card" style="margin-top:20px">
        <h2 style="margin-top:0">Starter packs</h2>
        <p class="empty" style="margin-top:0">Seed a ready-made squad and its work-units in one click. You can dial each unit's knobs afterwards.</p>
        ${SQUAD_PACKS.map((p) => (
          `<form method="post" action="/squads/packs/${escAttr(p.key)}" style="display:flex;align-items:center;gap:12px;margin-top:10px">` +
          `<div style="flex:1"><strong>${escHtml(p.name)}</strong> · <span style="color:var(--dim);font-size:13px">${escHtml(p.description)}</span> ` +
          `<span style="color:var(--dim);font-size:12px">(${p.agents.length} units)</span></div>` +
          `<button type="submit" class="btn secondary sm">Seed ${escHtml(p.name)}</button>` +
          `</form>`
        )).join('')}
      </div>`
    : ''

  return html`
    <p class="crumbs"><a href="/">Overview</a> / Agents</p>
    <h1>Agents</h1>
    <p class="empty" style="margin-top:0;max-width:680px">
      All agents across this pot. Each card shows the unit's objective, KPI, effort level, autonomy, and current work.
      ${canManage ? raw('Use the Configure panel on each card to set OKR, effort, autonomy, and budget.') : html``}
    </p>
    ${raw(errorBanner)}
    ${raw(cardsHtml)}
    ${raw(addForm)}
    ${raw(packsCard)}
    ${canManage && agents.length > 0 ? agentsScript() : html``}`
}

function agentsScript(): HtmlEscapedString {
  return raw(`
    <script>
      (function () {
        // Pause / Resume — POST /agents/:id/status {status:'active'|'paused'}
        document.querySelectorAll('.ag-status-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var agentId = btn.getAttribute('data-agent');
            var current = btn.getAttribute('data-status');
            var next = current === 'active' ? 'paused' : 'active';
            var row = document.querySelector('[data-agent-row="' + agentId + '"]');
            var rowStatus = row && row.querySelector('.ag-row-status');
            btn.disabled = true;
            if (rowStatus) rowStatus.textContent = '…';
            fetch('/agents/' + encodeURIComponent(agentId) + '/status', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ status: next })
            }).then(function (r) {
              return r.json().then(function (d) { return { ok: r.ok, d: d }; });
            }).then(function (r) {
              if (r.ok) {
                if (rowStatus) rowStatus.textContent = next === 'paused' ? 'paused' : 'resumed';
                btn.textContent = next === 'active' ? 'Pause' : 'Resume';
                btn.setAttribute('data-status', next);
              } else {
                if (rowStatus) rowStatus.textContent = (r.d && r.d.error) || 'failed';
              }
              btn.disabled = false;
            }).catch(function () {
              if (rowStatus) rowStatus.textContent = 'network error';
              btn.disabled = false;
            });
          });
        });

        // Delete — DELETE /agents/:id (confirm first)
        document.querySelectorAll('.ag-delete-btn').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var agentId = btn.getAttribute('data-agent');
            var name = btn.getAttribute('data-name');
            if (!confirm('Delete agent "' + name + '"? This cannot be undone.')) return;
            var row = document.querySelector('[data-agent-row="' + agentId + '"]');
            var rowStatus = row && row.querySelector('.ag-row-status');
            btn.disabled = true;
            if (rowStatus) rowStatus.textContent = '…';
            fetch('/agents/' + encodeURIComponent(agentId), {
              method: 'DELETE', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' }
            }).then(function (r) {
              return r.json().then(function (d) { return { ok: r.ok, d: d }; });
            }).then(function (r) {
              if (r.ok) {
                if (row) {
                  row.style.opacity = '0.4';
                  row.style.transition = 'opacity .3s';
                  setTimeout(function () { row.remove(); }, 320);
                }
              } else {
                if (rowStatus) rowStatus.textContent = (r.d && r.d.error) || 'failed';
                btn.disabled = false;
              }
            }).catch(function () {
              if (rowStatus) rowStatus.textContent = 'network error';
              btn.disabled = false;
            });
          });
        });
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
