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
} from '../types'

import { requireAuth } from '../auth'

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

// ── routes ───────────────────────────────────────────────────────────────────

// GET / — org overview: departments → squads → agents.
dashboardApp.get('/', async (c) => {
  const auth = c.get('auth')
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
      @media (max-width: 720px) { .board { grid-template-columns: 1fr 1fr; } }
    </style>
  </head>
  <body>
    <header class="top">
      <div class="brand"><b>${brand}</b> · substrate console</div>
      <nav>
        <a href="/">Overview</a>
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
