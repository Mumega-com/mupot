// /dashboard/fleet — the "Host agents · signed control" panel (Deliverable 2 UI).
//
// PURE PRESENTATION. Renders the fleet_agents registry (reported by the host daemon) with
// start/stop/restart controls that POST /fleet/host-control → a SIGNED control-request the host
// verifies before executing. Every reported field (agent_id, display, squads, status, runtime) is
// interpolated through the `html` tagged template / ui primitives, which AUTO-ESCAPE — so a status
// row from the daemon can never inject markup (Opus stored-XSS note: escape on render, never trust
// the 200-char cap). The control cell is one form with multiple submit buttons (one per verb), and
// onsubmit disables them so a double-click can't fire a second distinct command (codex idempotency
// note — each click is one verb; we don't auto-retry).

import { html } from 'hono/html'
import { sectionPanel, dataTable, statusDot, pill, emptyState, type Html, type Tone } from './ui'
import type { FleetAgentRow } from '../fleet/registry'

const STATUS_TONE: Record<string, Tone> = { running: 'ok', stopped: 'dim', unknown: 'warn' }

function controlCell(agentId: string): Html {
  // One form, three submit buttons sharing name="verb" — the browser sends only the CLICKED verb.
  return html`<form method="post" action="/fleet/host-control"
      onsubmit="Array.from(this.querySelectorAll('button')).forEach(b=>b.disabled=true)">
    <input type="hidden" name="agent_id" value="${agentId}">
    <button class="btn sm" name="verb" value="start">Start</button>
    <button class="btn sm secondary" name="verb" value="stop">Stop</button>
    <button class="btn sm secondary" name="verb" value="restart">Restart</button>
  </form>`
}

export interface HostPanelOpts {
  configured: boolean // FLEET_PANEL_SK + FLEET_CONSUMER_AGENT set
  canControl: boolean // the viewer is the owner
  flash: string | null // result of a just-submitted control action (?hc=...)
}

export function hostAgentsPanel(agents: FleetAgentRow[], opts: HostPanelOpts): Html {
  const body: Html = agents.length === 0
    ? emptyState({
        title: 'No host agents reported yet',
        detail: opts.configured
          ? 'The host consumer daemon has not reported any controllable agents yet.'
          : 'Fleet control is not configured (FLEET_PANEL_SK / consumer agent not set).',
      })
    : dataTable({
        cols: [
          { label: 'Agent' }, { label: 'Runtime' }, { label: 'Squads' }, { label: 'Status' }, { label: 'Control' },
        ],
        rows: agents.map((a) => [
          html`<span class="ui-mono-dim">${a.agent_id}</span>${a.display ? html` ${a.display}` : ''}`,
          html`${a.runtime || '—'}`,
          a.squads.length ? html`${a.squads.map((s) => pill(s, 'accent2'))}` : html`<span class="ui-panel-sub">—</span>`,
          statusDot(STATUS_TONE[a.status] ?? 'warn', a.status),
          opts.canControl && opts.configured
            ? controlCell(a.agent_id)
            : html`<span class="ui-panel-sub">${opts.configured ? 'owner only' : 'not configured'}</span>`,
        ]),
      })

  const flash: Html | undefined = opts.flash
    ? html`<span class="ui-panel-sub">${opts.flash === 'ok' ? 'Control request sent — the host verifies + executes.' : `Control failed: ${opts.flash}`}</span>`
    : undefined

  return sectionPanel({ title: 'Host agents · signed control', right: flash, body })
}
