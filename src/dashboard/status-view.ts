// dashboard/status-view — GET /status: one phone-readable board status page, server-rendered.
//
// VISIBILITY: every task row comes through the shared task-visibility chokepoint
// (resolveVisibleTaskScope + visibleTaskClause, src/tasks/visibility.ts) — the same
// predicate task_list/task_board use. "Needs you" is listNeedsYou (via loadNeedsYouDashboard),
// the needs_you tool's own source. Flights come from listFlights (the /flights page's reader).
// The build sha is publicHealth(), the source /health uses. No SQL here re-derives who may see
// what. Task text is data: it only ever flows through the `html` tag (auto-escaped).
//
// PERF: the two task queries ride ONE D1 batch (one round trip); needs-you, flights and the
// batch run concurrently.
import { html } from 'hono/html'
import type { AuthContext, Env } from '../types'
import { priorityOrderSql } from '../tasks/ranking'
import { resolveVisibleTaskScope, visibleTaskClause } from '../tasks/visibility'
import { listFlights } from '../flight/service'
import { publicHealth } from '../health'
import { loadNeedsYouDashboard } from './needs-you'
import type { NeedsYouDashboardView } from './needs-you'
import { emptyState } from './ui'
import type { Html } from './ui'

const PER_SECTION_CAP = 40
const TEXT_CAP = 160

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
  sha: string | null
  clean: boolean
}

export async function loadStatusView(env: Env, auth: AuthContext): Promise<StatusView> {
  const scope = await resolveVisibleTaskScope(env, auth)
  const clause = visibleTaskClause(scope, 1, 't')
  const [batch, needs, flights] = await Promise.all([
    env.DB.batch<Record<string, unknown>>([
      env.DB.prepare(
        `SELECT * FROM (
           SELECT t.id, t.title, t.priority, t.status,
                  substr(t.done_when, 1, ${TEXT_CAP}) AS done_when,
                  substr(COALESCE(NULLIF(t.result, ''), t.body, ''), 1, ${TEXT_CAP}) AS reason,
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
    ]),
    loadNeedsYouDashboard(env, auth),
    listFlights(env),
  ])
  const rows = (batch[0]?.results ?? []) as unknown as StatusTaskRow[] // shape fixed by the SELECT above
  const countRows = (batch[1]?.results ?? []) as unknown as { status: string; priority: string | null; n: number }[]
  const sum = (pred: (r: { status: string; priority: string | null }) => boolean) =>
    countRows.filter(pred).reduce((acc, r) => acc + Number(r.n), 0)
  const health = publicHealth(env.TENANT_SLUG, env.RELEASE_SHA)
  return {
    needs,
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
    flights: flights.filter((f) => f.status === 'running').map((f) => ({
      id: f.id, goal: f.goal, agent: f.agent_name ?? f.agent, started_at: f.started_at, created_at: f.created_at,
    })),
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

function section(title: string, count: number, body: Html | ''): Html {
  return html`<section class="sv-sec"><h2>${title} <span class="sv-n">${String(count)}</span></h2>${body === '' ? emptyState({ title: 'Nothing here', detail: 'All clear.' }) : body}</section>`
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
  <div class="sv-chips">${chip('need you', v.needs.items.length)}${chip('P0', c.open_p0)}${chip('P1', c.open_p1)}${chip('in progress', c.in_progress)}${chip('blocked', c.blocked)}${chip('in review', c.review)}${chip('flights', v.flights.length)}</div>
  ${section('Needs you', v.needs.items.length, needsList)}
  ${section('Open P0 / P1', v.open.length, list(v.open, false))}
  ${section('In progress', c.in_progress, list(v.inProgress, false))}
  ${section('Blocked', c.blocked, list(v.blocked, true))}
  ${section('Review queue', c.review, list(v.review, false))}
  ${section('Running flights', v.flights.length, flights)}
  <p class="sv-build">Build ${v.sha ? v.sha.slice(0, 8) : 'unknown'}${v.sha && !v.clean ? ' (unverified)' : ''}</p>`
}
