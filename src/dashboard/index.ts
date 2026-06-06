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

// First-run setup wizard (the easy-onboard centerpiece). Mounted under '/setup'
// on this same dashboard app, so it inherits the auth + tenant guard below.
import { wizardApp } from './wizard'
import { isOnboardingComplete } from './settings'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export const dashboardApp = new Hono<AppEnv>()

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
  return c.html(shell(c.env.BRAND, 'Overview', overviewBody(c.env.BRAND, tree, auth)))
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
      `SELECT id, squad_id, title, body, status, assignee_agent_id, github_issue_url, created_at, updated_at
         FROM tasks WHERE squad_id = ? ORDER BY updated_at DESC`,
    )
      .bind(squadId)
      .all<Task>(),
  ])
  return c.html(
    shell(
      c.env.BRAND,
      `Squad · ${squad.name}`,
      squadBoardBody(squad, agents.results ?? [], tasks.results ?? []),
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
  const canWake = auth.role === 'owner' || auth.role === 'admin'
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
      @media (max-width: 720px) { .board { grid-template-columns: 1fr 1fr; } }
    </style>
  </head>
  <body>
    <header class="top">
      <div class="brand"><b>${brand}</b> · substrate console</div>
      <nav>
        <a href="/">Overview</a>
        <a href="/admin/members">Members</a>
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

function overviewBody(brand: string, tree: DepartmentNode[], auth: AuthContext) {
  if (tree.length === 0) {
    return html`
      <h1>${brand} org</h1>
      <p class="crumbs">Signed in as ${auth.email ?? auth.userId} · ${auth.role}</p>
      <div class="card"><p class="empty">No departments yet. Seed the org via the API
        (<code>POST /api/org/departments</code>) and they'll appear here.</p></div>`
  }
  return html`
    <h1>${brand} org</h1>
    <p class="crumbs">Signed in as ${auth.email ?? auth.userId} · ${auth.role} ·
      ${tree.length} department${tree.length === 1 ? '' : 's'}</p>
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
    )}`
}

function squadBoardBody(squad: Squad, agents: Agent[], tasks: Task[]) {
  const byLane = new Map<Task['status'], Task[]>()
  for (const t of tasks) {
    const list = byLane.get(t.status) ?? []
    list.push(t)
    byLane.set(t.status, list)
  }
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
