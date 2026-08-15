// src/dashboard/mission-control-views.ts — Presentation views for Control Tower and Pot Fleet.
//
// Extracted to break circular dependency between src/dashboard/index.ts and src/dashboard/mission-control.ts.

import { html, raw } from 'hono/html'
import type { PresenceView } from '../fleet/presence'
import type { DepartureCard } from '../coordination/journeys'
import { pageHeader, kpiRow, statCard, type Html } from './ui'

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escAttr(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '')
}

export function controlTowerBody(cards: DepartureCard[]): Html {
  const dot = (p: string) =>
    p === 'IN FLIGHT' ? 'var(--ok)' : p === 'BOARDING' ? 'var(--warn)' : p === 'DELAYED' ? '#e5534b' : 'var(--dim)'
  const tr = (c: DepartureCard) => `
    <tr class="ct-row ${c.live ? '' : 'ct-dim'}">
      <td><span class="ct-dot" style="background:${dot(c.phase)}"></span>${escHtml(c.agent)}</td>
      <td class="ct-dest">${escHtml(c.project)}</td>
      <td class="ct-label">${escHtml(c.goal || '—')}</td>
      <td><span class="ct-badge">${escHtml(c.phase)}</span></td>
      <td>${escHtml(c.departed)}</td>
      <td>${escHtml(c.eta)}</td>
      <td class="ct-label">${c.gate ? escHtml(c.gate) : '—'}</td>
      <td>${escHtml(c.age)}</td>
    </tr>`
  const live = cards.filter((c) => c.live).length
  const table = cards.length
    ? `<table class="ct-table">
        <thead><tr><th>Flight (agent)</th><th>Destination</th><th>Goal</th><th>Status</th><th>Departed</th><th>ETA</th><th>Gate</th><th>Age</th></tr></thead>
        <tbody>${cards.map(tr).join('')}</tbody>
      </table>`
    : `<p class="empty">No flights on the board. An agent boards one at <code>POST /api/coordination</code> with {project, goal, gate, eta_ms} and it appears here.</p>`
  return html`
    ${pageHeader({
      crumbs: 'Overview / Control Tower',
      title: 'Control Tower',
      sub: 'Departures board — which agent flies to which project, when, and what status. Any agent-bound token boards a flight (POST /api/coordination); the colony reads the board. Live flights first; arrived/cancelled fade to history. Times UTC.',
    })}
    ${kpiRow([statCard({ label: 'In the air', value: String(live), subTone: live > 0 ? 'ok' : 'dim' })])}
    <style>
      .ct-table{width:100%;border-collapse:collapse;font-size:14px}
      .ct-table th{text-align:left;padding:8px 10px;color:var(--dim);font-weight:600;border-bottom:1px solid var(--border)}
      .ct-table td{padding:8px 10px;border-bottom:1px solid var(--border)}
      .ct-row.ct-dim{opacity:.5}
      .ct-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:middle}
      .ct-dest{font-weight:600}
      .ct-label{color:var(--dim)}
      .ct-badge{font-size:11px;padding:2px 8px;border-radius:10px;background:var(--surface);border:1px solid var(--border)}
      .empty{color:var(--dim);padding:16px}
    </style>
    ${raw(table)}`
}

export function potFleetBody(rows: PresenceView[]): Html {
  const dot = (l: string) =>
    l === 'active' ? 'var(--ok)' : l === 'idle' ? 'var(--warn)' : l === 'dead' ? '#e5534b' : 'var(--dim)'
  const schedDot = (s: string) => (s === 'flying' ? 'var(--ok)' : s === 'sleeping' ? 'var(--warn)' : 'var(--dim)')
  const present = rows.filter(
    (r) => r.liveness === 'active' || r.schedule?.state === 'flying' || r.schedule?.state === 'sleeping',
  ).length
  const tr = (r: PresenceView) => {
    const useSched = r.schedule != null
    const dimmed = useSched ? r.schedule!.state === 'done' : r.liveness === 'dead' || r.liveness === 'never'
    const dotColor = useSched ? schedDot(r.schedule!.state) : dot(r.liveness)
    const statusLabel = useSched
      ? r.schedule!.state === 'sleeping' && r.schedule!.next_label
        ? `${r.schedule!.state} · ${r.schedule!.next_label}`
        : r.schedule!.state
      : r.liveness
    const badgeClass = useSched ? `fl-sched-${escAttr(r.schedule!.state)}` : `fl-${escAttr(r.liveness)}`
    return `
    <tr class="fl-row ${dimmed ? 'fl-dim' : ''}">
      <td><span class="fl-dot" style="background:${dotColor}"></span>${escHtml(r.display_name || '—')}</td>
      <td class="fl-label">${escHtml(r.source)}</td>
      <td class="fl-label">${escHtml(r.label || '—')}</td>
      <td><span class="fl-badge ${badgeClass}">${escHtml(statusLabel)}</span></td>
      <td>${escHtml(r.last_seen_human)}</td>
    </tr>`
  }
  const table = rows.length
    ? `<table class="fl-table">
        <thead><tr><th>Agent</th><th>Runtime</th><th>Role / label</th><th>Status</th><th>Last check-in</th></tr></thead>
        <tbody>${rows.map(tr).join('')}</tbody>
      </table>`
    : `<p class="empty">No agents have checked in yet. Give an agent this pot's flock
       pack + a member token; it checks in at <code>POST /api/fleet/checkin</code> and
       appears here (active when in, fades to dead when out).</p>`
  return html`
    ${pageHeader({
      crumbs: 'Overview / Fleet',
      title: 'Fleet',
      sub:
        'Your flock — agents that check in to this pot, on any runtime (Claude Code, Codex, Hermes, openclaw…). Always-on agents read their heartbeat (active/idle/dead); session agents read their schedule (flying / sleeping · next run / done) — a resting agent is sleeping, not dead. Times UTC. Host control uses the signed mupot control plane above.',
    })}
    ${kpiRow([statCard({ label: 'Present now', value: String(present), subTone: present > 0 ? 'ok' : 'dim' })])}
    <style>
      .fl-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
      .fl-table th { text-align: left; color: var(--muted); font-size: 12px; text-transform: uppercase;
        letter-spacing: .5px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
      .fl-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
      .fl-dim td { opacity: .6; }
      .fl-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; }
      .fl-label { color: var(--muted); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fl-badge { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
      .fl-active { color: var(--ok); } .fl-idle { color: var(--warn); }
      .fl-dead { color: #e5534b; } .fl-never { color: var(--dim); }
      .fl-sched-flying { color: var(--ok); } .fl-sched-sleeping { color: var(--warn); } .fl-sched-done { color: var(--dim); }
    </style>
    ${raw(`<div class="card" style="padding:0;overflow-x:auto">${table}</div>`)}`
}
