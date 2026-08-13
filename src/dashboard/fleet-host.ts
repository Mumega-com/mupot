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

// ── squad control (engine.control_squad on the host) ────────────────────────────────────────
//
// A squad verb fans out to EVERY manifest whose `squads` includes the target squad_id — one
// click can start or stop several live agent sessions at once (kasra-review's adversarial gate
// on PR #954 named `squad-core` specifically: it resolves to 7 real agents on the live
// registry, and a squad-scoped stop would tear down live interactive tmux sessions). So unlike
// the single-agent buttons above, each squad action requires an explicit confirm naming who is
// affected before it submits.

export interface SquadGroup {
  squad_id: string
  members: FleetAgentRuntimeView[]
}

/** Group the SAME agents list rendered per-row above by their declared squads — the exact
 *  `squads[]` data the manifest/registry already carries, no separate squad lookup. An agent
 *  belonging to N squads appears in N groups. Pure. */
export function groupBySquad(agents: FleetAgentRuntimeView[]): SquadGroup[] {
  const bySquad = new Map<string, FleetAgentRuntimeView[]>()
  for (const a of agents) {
    for (const s of a.squads) {
      const list = bySquad.get(s)
      if (list) list.push(a)
      else bySquad.set(s, [a])
    }
  }
  return [...bySquad.entries()]
    .map(([squad_id, members]) => ({ squad_id, members }))
    .sort((x, y) => x.squad_id.localeCompare(y.squad_id))
}

function squadControlCell(group: SquadGroup): Html {
  // data-* attributes only — never string-interpolated into the onclick body. Mirrors
  // brain.ts's brainControl(this) pattern: an agent-reported display name goes through normal
  // HTML-attribute escaping (safe against breaking OUT of the attribute) and is read back via
  // .dataset in JS, so it is never concatenated into a raw onclick JS-string literal (which a
  // display name containing a quote could break out of).
  const memberList = group.members.map((m) => m.display || m.agent_id).join(', ')
  return html`<form method="post" action="/fleet/host-control">
    <input type="hidden" name="squad_id" value="${group.squad_id}">
    <button class="btn sm" name="verb" value="start"
      data-squad="${group.squad_id}" data-members="${memberList}" data-verb="start"
      onclick="return fleetSquadConfirm(this)">Start squad</button>
    <button class="btn sm secondary" name="verb" value="stop"
      data-squad="${group.squad_id}" data-members="${memberList}" data-verb="stop"
      onclick="return fleetSquadConfirm(this)">Stop squad</button>
  </form>`
}

const SQUAD_CONFIRM_SCRIPT: Html = html`
<script>
function fleetSquadConfirm(btn) {
  var squad = btn.dataset.squad;
  var verb = btn.dataset.verb;
  var members = btn.dataset.members;
  var verbLabel = verb === 'stop' ? 'STOP' : 'START';
  return confirm(verbLabel + ' the WHOLE "' + squad + '" squad? This affects: ' + members + '.');
}
</script>`

/** The "Squad control" panel — one row per declared squad, each with its own confirm-gated
 *  start/stop pair. Rendered alongside hostAgentsPanel (same agents list, same opts). */
export function squadControlPanel(agents: FleetAgentRuntimeView[], opts: HostPanelOpts): Html {
  const groups = groupBySquad(agents)
  const body: Html = groups.length === 0
    ? emptyState({
        title: 'No squads reported yet',
        detail: 'No host agent has reported a squads[] membership yet.',
      })
    : dataTable({
        cols: [{ label: 'Squad' }, { label: 'Members' }, { label: 'Control' }],
        rows: groups.map((g) => [
          html`<span class="ui-mono-dim">${g.squad_id}</span>`,
          html`${g.members.map((m) => pill(m.display || m.agent_id, 'accent2'))}`,
          opts.canControl && opts.configured
            ? squadControlCell(g)
            : html`<span class="ui-panel-sub">${opts.configured ? 'owner only' : 'not configured'}</span>`,
        ]),
      })
  // The confirm script is only needed (and only emitted) when the control buttons themselves
  // are rendered — matching the same canControl/configured gate as the buttons.
  const script = opts.canControl && opts.configured ? SQUAD_CONFIRM_SCRIPT : html``
  return html`${sectionPanel({ title: 'Squad control · signed', body })}${script}`
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
