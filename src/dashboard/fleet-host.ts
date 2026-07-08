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
import type { FleetAgentRuntimeView } from '../fleet/registry'

const PRESENCE_TONE: Record<string, Tone> = { live: 'ok', stale: 'warn', offline: 'dim' }
const INTENT_TONE: Record<string, Tone> = { running: 'ok', stopped: 'dim', unknown: 'warn' }

function controlCell(agentId: string): Html {
  // One form, three submit buttons sharing name="verb" — the browser sends only the CLICKED verb.
  // NB: do NOT disable the clicked button in onsubmit — a disabled submitter is excluded from the
  // form data, so `verb` would arrive empty and the emit silently fails as invalid_input (the bug
  // that made the live panel a no-op, 2026-07-05). Each emit is nonce-unique + idempotent by
  // requestId, so double-submit protection isn't needed here.
  return html`<form method="post" action="/fleet/host-control">
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

export function hostAgentsPanel(agents: FleetAgentRuntimeView[], opts: HostPanelOpts): Html {
  const body: Html = agents.length === 0
    ? emptyState({
        title: 'No host agents reported yet',
        detail: opts.configured
          ? 'The host consumer daemon has not reported any controllable agents yet.'
          : 'Fleet control is not configured (FLEET_PANEL_SK / consumer agent not set).',
      })
    : dataTable({
        cols: [
          { label: 'Agent' }, { label: 'Runtime' }, { label: 'Squads' }, { label: 'Presence' }, { label: 'Intent' }, { label: 'Last seen' }, { label: 'Control' },
        ],
        rows: agents.map((a) => [
          html`<span class="ui-mono-dim">${a.agent_id}</span>${a.display ? html` ${a.display}` : ''}`,
          html`${a.runtime || '—'}`,
          a.squads.length ? html`${a.squads.map((s) => pill(s, 'accent2'))}` : html`<span class="ui-panel-sub">—</span>`,
          statusDot(PRESENCE_TONE[a.presence] ?? 'warn', a.presence),
          statusDot(INTENT_TONE[a.status] ?? 'warn', a.status),
          html`<span class="ui-panel-sub">${a.last_seen || '—'}</span>`,
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
