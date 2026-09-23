import { html, raw } from 'hono/html'
import type { AuthContext, Env } from '../types'
import { ROUTES } from '../types'
import { listNeedsYou, type NeedsYouItem } from '../attention/service'
import { routinePrincipal } from '../routines/access'
import { emptyState, pageHeader, pill, sectionPanel } from './ui'
import type { Html } from './ui'

// mupot lifecycle-warning: the Recommit button posts to the EXISTING
// POST /projects/:id/recommit route (src/projects/index.ts) — the SAME
// RBAC'd write path the project_recommit MCP tool calls. No new write path.
// Same-origin fetch + hono/csrf's Origin check (dashboardApp.use('*', csrf()))
// covers CSRF; no token field is needed (see src/dashboard/index.ts's own
// "same-origin POST forms" comment on that middleware).
//
// ROUND 2 P0-2 (adversarial): projectsApp is mounted at ROUTES.projects
// ('/api/projects', src/types.ts) by src/index.ts's `app.route(ROUTES.projects,
// projectsApp)` — projectsApp's OWN route table has no idea it lives under
// that prefix. The button's fetch target MUST be built from ROUTES.projects,
// not a guessed '/projects/...' path (which 404s in prod and shows a
// misleading "network error" on the button) — see
// tests/dashboard-recommit-route.test.ts's "composed root mount" case, which
// dispatches through app.route(ROUTES.projects, projectsApp) — the EXACT
// mount call src/index.ts makes — rather than projectsApp.fetch() directly,
// which would pass even with the wrong prefix baked in here.
const RECOMMIT_BUTTON_CLASS = 'needs-you-recommit-btn'

export interface NeedsYouDashboardView {
  items: NeedsYouItem[]
  nextCursor: string | null
  truncated: boolean
  truncatedSources: string[]
}

export async function loadNeedsYouDashboard(
  env: Env,
  auth: AuthContext,
  options: { limit?: number; after?: string } = {},
): Promise<NeedsYouDashboardView> {
  const page = await listNeedsYou(env, routinePrincipal(auth), options)
  return { items: page.items, nextCursor: page.next_cursor, truncated: page.truncated, truncatedSources: page.truncated_sources }
}

function urgencyTone(urgency: NeedsYouItem['urgency']): 'danger' | 'warn' | 'primary' | 'dim' {
  if (urgency === 'urgent') return 'danger'
  if (urgency === 'high') return 'warn'
  if (urgency === 'normal') return 'primary'
  return 'dim'
}

function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

// 'recommit' has no separate page to link to (unlike approve/reject/publish,
// which route to /approvals — a page that itself owns the write). It renders
// as a real button, wired by recommitScript() below, that POSTs to the
// existing recommit route directly. Every other action stays a plain link
// into its authority-owning surface — this module still creates no NEW write
// path; it only avoids requiring a page reload to reach the one that exists.
function actionLinks(item: NeedsYouItem): Html {
  const links = item.allowed_actions.map((action) => {
    if (action === 'recommit') {
      return html`<button
        type="button"
        class="ui-link ${raw(RECOMMIT_BUTTON_CLASS)}"
        data-project-id="${item.project_id}"
        style="background:none;border:none;padding:0;font:inherit;cursor:pointer;"
      >recommit</button><span class="recommit-status" style="margin-left:6px;"></span>`
    }
    const href = actionHref(item, action)
    return html`<a class="ui-link" href="${href}">${action.replaceAll('_', ' ')}</a>`
  })
  return html`<span style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">${links}</span>`
}

function actionHref(item: NeedsYouItem, action: NeedsYouItem['allowed_actions'][number]): string {
  if (action === 'view') return item.safe_url
  if (action === 'approve' || action === 'reject' || action === 'publish') return '/approvals'
  if (item.source_type === 'project') return `/projects/${encodeURIComponent(item.project_id)}`
  if (item.source_type === 'routine_run') {
    return `/projects/${encodeURIComponent(item.project_id)}/routines?run_id=${encodeURIComponent(item.source_id)}`
  }
  return `/projects/${encodeURIComponent(item.project_id)}#work`
}

// Vanilla JS wiring the Recommit buttons — same fetch/credentials/error-
// surfacing pattern as obsQueueScript()/approvalsScript() in
// src/dashboard/index.ts (same-origin, JSON body, disable while pending,
// re-enable + show the server's error string on failure so a refused
// self-recommit is legible instead of a silent no-op).
function recommitScript(): Html {
  return html`<script>${raw(`
    (function () {
      document.querySelectorAll('.${RECOMMIT_BUTTON_CLASS}').forEach(function (btn) {
        var projectId = btn.getAttribute('data-project-id');
        var status = btn.nextElementSibling;
        btn.addEventListener('click', function () {
          btn.disabled = true;
          if (status) status.textContent = '…';
          fetch('${ROUTES.projects}/' + encodeURIComponent(projectId) + '/recommit', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'dashboard_recommit' }),
          }).then(function (res) {
            return res.json().then(function (data) { return { ok: res.ok, data: data }; });
          }).then(function (r) {
            if (r.ok) {
              if (status) status.textContent = 'recommitted';
              btn.remove();
            } else {
              if (status) status.textContent = (r.data && r.data.error) || 'failed';
              btn.disabled = false;
            }
          }).catch(function () {
            if (status) status.textContent = 'network error — try again';
            btn.disabled = false;
          });
        });
      });
    })();
  `)}</script>`
}

function table(rows: Html[][]): Html {
  const columns = [
    { label: 'Urgency', width: 'auto' }, { label: 'Request', width: '1.4fr' }, { label: 'Project', width: '1fr' },
    { label: 'Responsible', width: '1fr' }, { label: 'Reason', width: '1.5fr' }, { label: 'Source actions', width: 'auto' },
  ]
  const tracks = columns.map(column => column.width).join(' ')
  return html`<div role="region" aria-label="Needs You queue" tabindex="0" style="max-width:100%;overflow-x:auto;">
    <div class="ui-table" role="table" aria-label="Needs You queue" style="min-width:72rem;">
      <div class="ui-tr ui-thead" role="row" style="grid-template-columns:${raw(tracks)}">${columns.map(column => html`<div class="ui-th" role="columnheader">${column.label}</div>`)}</div>
      ${rows.length ? rows.map(cells => html`<div class="ui-tr ui-row" role="row" style="grid-template-columns:${raw(tracks)}">${cells.map(cell => html`<div class="ui-td" role="cell" style="overflow-wrap:anywhere;">${cell}</div>`)}</div>`) : html`<div class="ui-table-empty">No attention items are visible to this account.</div>`}
    </div>
  </div>`
}

/**
 * Mostly a read-only projection: every action link enters an authority-owning
 * source surface. The one exception is 'recommit', which has no separate page
 * to link to (unlike approve/reject/publish, whose owning surface is
 * /approvals) — its button POSTs directly to the EXISTING RBAC-gated
 * POST /projects/:id/recommit route via recommitScript() below. Still NO new
 * write path: same route, same server-side gates (workspaceAdmin +
 * proposeProjectRecommit's self_recommit refusal) as the project_recommit
 * MCP tool and the project detail page's own recommit control call.
 */
export function needsYouBody(view: NeedsYouDashboardView): Html {
  if (!view.items.length) {
    return html`${pageHeader({ crumbs: 'Workspace', title: 'Needs You', sub: 'Accountable decisions across readable Projects.' })}${emptyState({ title: 'No attention items', detail: 'No unresolved work requires a response.' })}`
  }
  const hasRecommit = view.items.some(item => item.allowed_actions.includes('recommit'))
  const rows = view.items.map(item => [
    pill(title(item.urgency), urgencyTone(item.urgency)),
    html`<span style="display:grid;gap:3px;"><strong>${item.title}</strong><span class="ui-panel-sub">${item.kind.replaceAll('_', ' ')}</span></span>`,
    html`<a class="ui-link" href="/projects/${encodeURIComponent(item.project_id)}">${item.project_name}</a>`,
    html`<span>${item.responsible ?? 'Unassigned'}<span class="ui-panel-sub">Requested by ${item.requested_by ?? 'system'}</span></span>`,
    html`<span>${item.reason}<span class="ui-panel-sub">${item.deadline_at ?? item.created_at}</span></span>`,
    actionLinks(item),
  ])
  const continuation = view.nextCursor ? `/needs-you?cursor=${encodeURIComponent(view.nextCursor)}` : null
  return html`${pageHeader({ crumbs: 'Workspace', title: 'Needs You', sub: 'Accountable decisions across readable Projects.' })}
    ${sectionPanel({ title: 'Attention queue', body: html`${table(rows)}${continuation ? html`<p class="ui-panel-sub">${view.truncated ? `Source scan caps applied: ${view.truncatedSources.join(', ')}. ` : ''}<a class="ui-link" href="${continuation}">Continue queue</a></p>` : ''}` })}
    ${hasRecommit ? recommitScript() : ''}`
}
