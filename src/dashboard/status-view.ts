// dashboard/status-view — GET /status: one phone-readable board status page, server-rendered.
//
// VISIBILITY: every task row comes through the shared task-visibility chokepoint
// (resolveVisibleTaskScope + visibleTaskClause, src/tasks/visibility.ts) — the same
// predicate task_list/task_board use. "Needs you" is listNeedsYou (via loadNeedsYouDashboard),
// the needs_you tool's own source. Flights: running candidates (tenant-scoped) are each passed
// through visibleFlight (src/mcp/flight-spine.ts, the MCP flight reader's check: observer on every
// squad in meta.squad_ids + a readable project). The flight count is over the newest
// FLIGHT_SCAN_CAP running flights.
// The build sha is publicHealth(), the source /health uses. No SQL here re-derives who may see
// what. Task text is data: it only ever flows through the `html` tag (auto-escaped).
//
// PERF: the two task queries ride ONE D1 batch (one round trip); needs-you, flights and the
// batch run concurrently.
import { html } from 'hono/html'
import type { AuthContext, Env } from '../types'
import { priorityOrderSql } from '../tasks/ranking'
import { resolveVisibleTaskScope, visibleTaskClause } from '../tasks/visibility'
import { publicHealth } from '../health'
import { loadNeedsYouDashboard } from './needs-you'
import type { NeedsYouDashboardView } from './needs-you'
import { emptyState } from './ui'
import type { Html } from './ui'

const PER_SECTION_CAP = 40
const TEXT_CAP = 160
const FLIGHT_SCAN_CAP = 100

export interface StatusTaskRow {
  id: string
  title: string
  priority: string | null
  status: string
  done_when: string
  reason: string
  created_at: string
  owner: string | null
  project_name: string | null
}

export interface StatusFlightRow {
  id: string
  goal: string
  agent: string
  started_at: number | null
  created_at: number
}

export interface StatusView {
  needs: NeedsYouDashboardView
  open: StatusTaskRow[]
  inProgress: StatusTaskRow[]
  blocked: StatusTaskRow[]
  review: StatusTaskRow[]
  counts: { open_p0: number; open_p1: number; in_progress: number; blocked: number; review: number }
  flights: StatusFlightRow[]
  flightCount: number
  /** Sections whose reader threw; they render as unavailable, the rest of the page still renders. */
  errors: string[]
  sha: string | null
  clean: boolean
}

async function settle<T>(name: string, errors: string[], p: Promise<T>): Promise<T | null> {
  try {
    return await p
  } catch {
    errors.push(name)
    return null
  }
}

async function loadRunningFlights(env: Env, auth: AuthContext): Promise<StatusFlightRow[]> {
  const res = await env.DB.prepare(
    `SELECT f.id, f.goal, COALESCE(a.name, f.agent) AS agent, f.started_at, f.created_at
       FROM flights f LEFT JOIN agents a ON a.id = f.agent
      WHERE f.tenant = ?1 AND f.status = 'running'
      ORDER BY f.created_at DESC LIMIT ${FLIGHT_SCAN_CAP}`,
  ).bind(env.TENANT_SLUG).all<StatusFlightRow>()
  const rows = res.results ?? []
  // Lazy: flight-spine pulls the MCP tool registry, which would form an import cycle at module load.
  const { visibleFlight } = await import('../mcp/flight-spine')
  const ok = await Promise.all(rows.map(async (r) => (await visibleFlight(env, auth, r.id)) !== null))
  return rows.filter((_, i) => ok[i])
}

async function loadTaskBatch(env: Env, auth: AuthContext) {
  const scope = await resolveVisibleTaskScope(env, auth)
  const clause = visibleTaskClause(scope, 1, 't')
  const batch = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT * FROM (
         SELECT t.id, t.title, t.priority, t.status,
                substr(t.done_when, 1, ${TEXT_CAP}) AS done_when,
                substr(COALESCE(NULLIF(t.result, ''), t.body, ''), -${TEXT_CAP}) AS reason,
                t.created_at,
                COALESCE(a.name, m.display_name) AS owner,
                p.name AS project_name,
                ROW_NUMBER() OVER (PARTITION BY t.status ORDER BY ${priorityOrderSql('t.priority')}, t.created_at ASC, t.id) AS rn
           FROM tasks t
           LEFT JOIN agents a ON a.id = t.assignee_agent_id
           LEFT JOIN members m ON m.id = t.assignee_member_id
           LEFT JOIN projects p ON p.id = t.project_id
          WHERE ${clause.sql}
            AND ((t.status = 'open' AND t.priority IN ('P0', 'P1')) OR t.status IN ('in_progress', 'blocked', 'review'))
       ) WHERE rn <= ${PER_SECTION_CAP}
       ORDER BY ${priorityOrderSql('priority')}, created_at ASC, id`,
    ).bind(...clause.binds),
    env.DB.prepare(
      `SELECT t.status AS status, t.priority AS priority, COUNT(*) AS n
         FROM tasks t
        WHERE ${clause.sql} AND t.status IN ('open', 'in_progress', 'blocked', 'review')
        GROUP BY t.status, t.priority`,
    ).bind(...clause.binds),
  ])
  return {
    rows: (batch[0]?.results ?? []) as unknown as StatusTaskRow[], // shape fixed by the SELECT above
    countRows: (batch[1]?.results ?? []) as unknown as { status: string; priority: string | null; n: number }[],
  }
}

export async function loadStatusView(env: Env, auth: AuthContext): Promise<StatusView> {
  const errors: string[] = []
  const [tasks, needs, flights] = await Promise.all([
    settle('tasks', errors, loadTaskBatch(env, auth)),
    settle('needs', errors, loadNeedsYouDashboard(env, auth)),
    settle('flights', errors, loadRunningFlights(env, auth)),
  ])
  const rows = tasks?.rows ?? []
  const countRows = tasks?.countRows ?? []
  const sum = (pred: (r: { status: string; priority: string | null }) => boolean) =>
    countRows.filter(pred).reduce((acc, r) => acc + Number(r.n), 0)
  const health = publicHealth(env.TENANT_SLUG, env.RELEASE_SHA)
  return {
    needs: needs ?? { items: [], nextCursor: null, truncated: false, truncatedSources: [] },
    open: rows.filter((r) => r.status === 'open'),
    inProgress: rows.filter((r) => r.status === 'in_progress'),
    blocked: rows.filter((r) => r.status === 'blocked'),
    review: rows.filter((r) => r.status === 'review'),
    counts: {
      open_p0: sum((r) => r.status === 'open' && r.priority === 'P0'),
      open_p1: sum((r) => r.status === 'open' && r.priority === 'P1'),
      in_progress: sum((r) => r.status === 'in_progress'),
      blocked: sum((r) => r.status === 'blocked'),
      review: sum((r) => r.status === 'review'),
    },
    flights: (flights ?? []).slice(0, PER_SECTION_CAP),
    flightCount: flights?.length ?? 0,
    errors,
    sha: health.commit,
    clean: health.clean,
  }
}

function ageLabel(iso: string, now: number): string {
  const t = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  if (Number.isNaN(t)) return ''
  const days = Math.floor((now - t) / 86_400_000)
  if (days >= 1) return `${days}d`
  return `${Math.max(0, Math.floor((now - t) / 3_600_000))}h`
}

function taskRow(t: StatusTaskRow, now: number, showReason: boolean): Html {
  return html`<li class="sv-row">
    <span class="sv-title">${t.priority ? html`<b class="sv-pri sv-${t.priority.toLowerCase()}">${t.priority}</b> ` : ''}${t.title}</span>
    <span class="sv-meta">${t.owner ?? 'unassigned'} · ${ageLabel(t.created_at, now)}${t.project_name ? html` · ${t.project_name}` : ''}</span>
    ${showReason
      ? (t.reason ? html`<span class="sv-line">Reason: ${t.reason}</span>` : '')
      : (t.done_when ? html`<span class="sv-line">Done when: ${t.done_when}</span>` : '')}
  </li>`
}

function section(title: string, count: number, body: Html | '', opts: { failed?: boolean; more?: boolean } = {}): Html {
  const empty = opts.failed
    ? emptyState({ title: 'Unavailable', detail: 'This section could not be loaded.' })
    : opts.more
      ? html`<p class="sv-line">More items waiting - <a href="/needs-you">see Needs You</a>.</p>`
      : emptyState({ title: 'Nothing here', detail: 'All clear.' })
  return html`<section class="sv-sec"><h2>${title} <span class="sv-n">${opts.failed ? '?' : String(count)}</span></h2>${body === '' ? empty : html`${body}${opts.more ? html`<p class="sv-line"><a href="/needs-you">more...</a></p>` : ''}`}</section>`
}

export function statusBody(v: StatusView, now: number = Date.now()): Html {
  const needsList = v.needs.items.length === 0 ? '' : html`<ul class="sv-list">${v.needs.items.map((i) => html`<li class="sv-row">
      <a class="sv-title" href="${i.safe_url}">${i.title}</a>
      <span class="sv-meta">${i.project_name} · ${i.urgency} · ${ageLabel(i.created_at, now)}</span>
      <span class="sv-line">${i.reason}</span></li>`)}</ul>`
  const list = (rows: StatusTaskRow[], reason: boolean): Html | '' =>
    rows.length === 0 ? '' : html`<ul class="sv-list">${rows.map((t) => taskRow(t, now, reason))}</ul>`
  const flights = v.flights.length === 0 ? '' : html`<ul class="sv-list">${v.flights.map((f) => html`<li class="sv-row">
      <a class="sv-title" href="/flights">${f.goal}</a><span class="sv-meta">${f.agent}</span></li>`)}</ul>`
  const c = v.counts
  const chip = (label: string, n: number) => html`<span class="sv-chip"><b>${String(n)}</b> ${label}</span>`
  return html`
  <style>
    .sv-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
    .sv-chip{background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:4px 10px;font-size:13px;color:var(--text)}
    .sv-sec{margin:0 0 18px}.sv-sec h2{font-size:16px;margin:0 0 6px;color:var(--text)}
    .sv-n{color:var(--dim);font-weight:400;font-size:13px}
    .sv-list{list-style:none;margin:0;padding:0}
    .sv-row{display:flex;flex-direction:column;gap:2px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin:0 0 6px;overflow-wrap:anywhere}
    .sv-title{color:var(--text);text-decoration:none;font-weight:600}
    .sv-meta,.sv-line{color:var(--dim);font-size:13px}
    .sv-pri{font-size:12px}.sv-p0{color:var(--danger,#c0392b)}.sv-p1{color:var(--warn,#ca8a04)}
    .sv-build{color:var(--dim);font-size:13px}
  </style>
  <h1 class="ui-h1">Status</h1>
  <div class="sv-chips">${chip('need you', v.needs.items.length)}${chip('P0', c.open_p0)}${chip('P1', c.open_p1)}${chip('in progress', c.in_progress)}${chip('blocked', c.blocked)}${chip('in review', c.review)}${chip('flights', v.flightCount)}</div>
  ${section('Needs you', v.needs.items.length, needsList, { failed: v.errors.includes('needs'), more: v.needs.truncated || v.needs.nextCursor !== null })}
  ${section('Open P0 / P1', c.open_p0 + c.open_p1, list(v.open, false), { failed: v.errors.includes('tasks') })}
  ${section('In progress', c.in_progress, list(v.inProgress, false), { failed: v.errors.includes('tasks') })}
  ${section('Blocked', c.blocked, list(v.blocked, true), { failed: v.errors.includes('tasks') })}
  ${section('Review queue', c.review, list(v.review, false), { failed: v.errors.includes('tasks') })}
  ${section('Running flights', v.flightCount, flights, { failed: v.errors.includes('flights') })}
  <p class="sv-build">Build ${v.sha ? v.sha.slice(0, 8) : 'unknown'}${v.sha && !v.clean ? ' (unverified)' : ''}</p>`
}
