import { html, raw } from 'hono/html'
import type { AuthContext, Env } from '../types'
import { listNeedsYou, type NeedsYouItem } from '../attention/service'
import { routinePrincipal } from '../routines/access'
import { emptyState, pageHeader, pill, sectionPanel } from './ui'
import type { Html } from './ui'

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

function actionLink(item: NeedsYouItem): { href: string; label: string } {
  const project = encodeURIComponent(item.project_id)
  if (item.source_type === 'routine_run') {
    return { href: `/projects/${project}/routines?run_id=${encodeURIComponent(item.source_id)}`, label: 'Open routine run' }
  }
  if (item.kind === 'approval' || item.kind === 'publishable_output') return { href: '/approvals', label: item.kind === 'approval' ? 'Open approval' : 'Open publication' }
  return { href: `/projects/${project}#work`, label: 'Open Project work' }
}

function table(rows: Html[][]): Html {
  const columns = [
    { label: 'Urgency', width: 'auto' }, { label: 'Request', width: '1.4fr' }, { label: 'Project', width: '1fr' },
    { label: 'Responsible', width: '1fr' }, { label: 'Reason', width: '1.5fr' }, { label: 'Source action', width: 'auto' },
  ]
  const tracks = columns.map(column => column.width).join(' ')
  return html`<div role="region" aria-label="Needs You queue" tabindex="0" style="max-width:100%;overflow-x:auto;">
    <div class="ui-table" role="table" aria-label="Needs You queue" style="min-width:72rem;">
      <div class="ui-tr ui-thead" role="row" style="grid-template-columns:${raw(tracks)}">${columns.map(column => html`<div class="ui-th" role="columnheader">${column.label}</div>`)}</div>
      ${rows.length ? rows.map(cells => html`<div class="ui-tr ui-row" role="row" style="grid-template-columns:${raw(tracks)}">${cells.map(cell => html`<div class="ui-td" role="cell" style="overflow-wrap:anywhere;">${cell}</div>`)}</div>`) : html`<div class="ui-table-empty">No attention items are visible to this account.</div>`}
    </div>
  </div>`
}

/** Read-only projection. Its links enter the authority-owning source surfaces; it creates no generic write control. */
export function needsYouBody(view: NeedsYouDashboardView): Html {
  if (!view.items.length) {
    return html`${pageHeader({ crumbs: 'Workspace', title: 'Needs You', sub: 'Accountable decisions across readable Projects.' })}${emptyState({ title: 'No attention items', detail: 'No unresolved work requires a response.' })}`
  }
  const rows = view.items.map(item => {
    const action = actionLink(item)
    return [
      pill(title(item.urgency), urgencyTone(item.urgency)),
      html`<span style="display:grid;gap:3px;"><strong>${item.title}</strong><span class="ui-panel-sub">${item.kind.replaceAll('_', ' ')}</span></span>`,
      html`<a class="ui-link" href="/projects/${encodeURIComponent(item.project_id)}">${item.project_name}</a>`,
      html`<span>${item.responsible ?? 'Unassigned'}<span class="ui-panel-sub">Requested by ${item.requested_by ?? 'system'}</span></span>`,
      html`<span>${item.reason}<span class="ui-panel-sub">${item.deadline_at ?? item.created_at}</span></span>`,
      html`<a class="ui-link" href="${action.href}">${action.label}</a>`,
    ]
  })
  const continuation = view.nextCursor ? `/needs-you?cursor=${encodeURIComponent(view.nextCursor)}` : null
  return html`${pageHeader({ crumbs: 'Workspace', title: 'Needs You', sub: 'Accountable decisions across readable Projects.' })}
    ${sectionPanel({ title: 'Attention queue', body: html`${table(rows)}${continuation ? html`<p class="ui-panel-sub">${view.truncated ? `Source scan caps applied: ${view.truncatedSources.join(', ')}. ` : ''}<a class="ui-link" href="${continuation}">Continue queue</a></p>` : ''}` })}`
}
