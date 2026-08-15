// src/dashboard/mission-control.ts — Unified Mission Control interface for Mupot (#Flight-003B).
//
// Consolidates /radar, /fleet, /coordination, and /motherboard into a single, cohesive, tabbed surface:
//   1. Radar: Real-time ATC map, collision alarms, brain physics, and agent cards.
//   2. Fleet: Agent roster, token liveness, models, spend meter, and host presence.
//   3. Motherboard: Interactive 2D visual topology engine across departments, squads, and nodes.
//   4. Departures: Coordination departures board and flight telemetry.

import { html, raw } from 'hono/html'
import type { Html } from './ui'
import type { FleetRadar } from './radar'
import type { PresenceView } from '../fleet/presence'
import type { MotherboardViewData } from './motherboard'
import type { DepartureCard } from '../coordination/journeys'
import type { RunnerReceipt } from '../runners/types'
import { renderBrainImage, renderAgentCard } from './radar-view'
import { motherboardPageBody } from './motherboard'
import { potFleetBody, controlTowerBody } from './mission-control-views'
import { renderTentaclesPanel } from './tentacles-view'

export interface MissionControlData {
  radar: FleetRadar
  presence: PresenceView[]
  hostPanelHtml: Html
  squadPanelHtml: Html
  motherboard: MotherboardViewData
  departures: DepartureCard[]
  runners?: RunnerReceipt[]
  activeTab: 'radar' | 'fleet' | 'motherboard' | 'departures' | 'tentacles'
}

export function missionControlBody(data: MissionControlData): Html {
  const { radar, presence, hostPanelHtml, squadPanelHtml, motherboard, departures, runners = [], activeTab } = data

  const squadNameByAgent = new Map<string, string>()
  for (const s of radar.squads) {
    for (const id of s.member_agent_ids) squadNameByAgent.set(id, s.name)
  }
  const nowMs = radar.generated_at_ms

  const radarCards = radar.agents.map((a) =>
    raw(renderAgentCard(a, { squadName: squadNameByAgent.get(a.agent_id) ?? null, nowMs })),
  )
  const generatedLabel = new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ') + ' UTC'

  return html`
    <style>
      .mc-tabs {
        display: flex;
        gap: 8px;
        border-bottom: 1px solid var(--border);
        margin: 16px 0 24px;
        padding-bottom: 2px;
      }
      .mc-tab {
        padding: 8px 16px;
        font-size: 13px;
        font-weight: 500;
        color: var(--dim);
        text-decoration: none;
        border-radius: 6px 6px 0 0;
        border-bottom: 2px solid transparent;
        transition: all 0.15s ease;
      }
      .mc-tab:hover {
        color: var(--fg);
        background: rgba(255, 255, 255, 0.03);
      }
      .mc-tab.active {
        color: var(--fg);
        border-bottom-color: var(--primary);
        background: rgba(255, 255, 255, 0.05);
      }
      .mc-badge {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.1);
        margin-left: 6px;
      }
      .radar-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
      }
    </style>

    <p class="crumbs"><a href="/">Overview</a> / Mission Control</p>
    <div class="ui-pagehead">
      <h1 class="ui-h1">Mission Control</h1>
      <span class="ui-pill" style="--pill:var(--primary)">Live Fleet Operations</span>
    </div>
    <p class="ui-sub">Unified flight command, presence telemetry, fractal motherboard topology, and departures awareness.</p>

    <div class="mc-tabs">
      <a class="mc-tab ${activeTab === 'radar' ? 'active' : ''}" href="/radar?tab=radar">
        ATC Radar <span class="mc-badge">${radar.agents.length}</span>
      </a>
      <a class="mc-tab ${activeTab === 'fleet' ? 'active' : ''}" href="/radar?tab=fleet">
        Fleet Presence <span class="mc-badge">${presence.length}</span>
      </a>
      <a class="mc-tab ${activeTab === 'motherboard' ? 'active' : ''}" href="/radar?tab=motherboard">
        Topology Map
      </a>
      <a class="mc-tab ${activeTab === 'departures' ? 'active' : ''}" href="/radar?tab=departures">
        Departures <span class="mc-badge">${departures.length}</span>
      </a>
      <a class="mc-tab ${activeTab === 'tentacles' ? 'active' : ''}" href="/radar?tab=tentacles">
        Tentacles <span class="mc-badge">${runners.length}</span>
      </a>
    </div>

    ${
      activeTab === 'radar'
        ? html`
            <div style="font-size:11px;color:var(--dim);margin-bottom:14px">ATC telemetry synchronized: ${generatedLabel}</div>
            ${raw(renderBrainImage(radar, nowMs))}
            <h2 style="margin-top:24px">Active Agents</h2>
            ${
              radar.agents.length
                ? html`<div class="radar-grid">${radarCards}</div>`
                : html`<div class="card"><p class="empty">No agents in this pot yet.</p></div>`
            }
          `
        : activeTab === 'fleet'
        ? html`
            ${hostPanelHtml}
            ${squadPanelHtml}
            ${potFleetBody(presence)}
          `
        : activeTab === 'motherboard'
        ? motherboardPageBody(motherboard)
        : activeTab === 'departures'
        ? html`
            ${controlTowerBody(departures)}
          `
        : renderTentaclesPanel({ runners, nowMs })
    }
  `
}
