// mupot — /dashboard/brain: per-pot brain panel (S-BRAIN-CTRL-MUPOT-1).
//
// Renders:
//   1. Decision feed — cycle outcomes from loop_decisions (newest-first).
//   2. Governor controls — pause / resume / kill per loop + budget override.
//      Writes are isAdmin-gated (AC#7). Reads are requireAuth only.
//
// This module is the data layer + HTML body only. The route wiring and admin
// gate live in dashboard/index.ts. All writes go through EXISTING endpoints:
//   - POST /api/loops/:id/status (pause/resume/kill) — src/loops/routes.ts:63
//   - loop_controls signal: new POST endpoint wired in dashboard/index.ts
//
// Capability descriptor field (AC#8 / E-BRAIN-CONTROL §12): threaded as a
// design property. The feed renders it when present; the runtime persists it
// as a null stub until the loop owner's model field is wired (P3). The UX
// shows "—" when null so the column is always visible (born tier-aware).

import { html, raw } from 'hono/html'
import type { Env } from '../types'
import { listLoops } from '../loops/service'
import { listLoopDecisions } from '../loops/decisions'
import type { LoopDecisionRow } from '../loops/decisions'
import type { LoopManifest } from '../loops/manifest'

// ── data layer ────────────────────────────────────────────────────────────────

export interface BrainLoopRow {
  id: string
  okr: string
  status: string
  ownerKind: 'agent' | 'squad'
  effort: string
  kpiSignal: string
  kpiTarget: number
  capMicroUsd: number | null
  window: string
}

export interface BrainView {
  loops: BrainLoopRow[]
  /** Recent decisions across ALL loops (or a specific loop if loop_id filtered). */
  decisions: LoopDecisionRow[]
}

export interface BrainViewDeps {
  listLoopsFn?: (env: Env) => Promise<LoopManifest[]>
  listDecisionsFn?: (env: Env, loopId: string, opts?: { limit?: number }) => Promise<LoopDecisionRow[]>
}

/**
 * loadBrainView — load the data for the /brain panel.
 *
 * Loads all loops + the last 20 decisions from each (limit per loop so the
 * page stays snappy). In practice most pots have 1-3 active loops so the
 * total query count is bounded.
 */
export async function loadBrainView(env: Env, deps: BrainViewDeps = {}): Promise<BrainView> {
  const listFn = deps.listLoopsFn ?? ((e) => listLoops(e))
  const decisionsFn = deps.listDecisionsFn ?? listLoopDecisions

  const loops = await listFn(env)
  const loopRows: BrainLoopRow[] = loops.map((l) => ({
    id: l.id,
    okr: l.okr,
    status: l.status,
    ownerKind: l.agent_id ? 'agent' : 'squad',
    effort: l.budget.effort ?? 'standard',
    kpiSignal: l.kpi.signal,
    kpiTarget: l.kpi.target,
    capMicroUsd: l.budget.cap_micro_usd ?? null,
    window: l.budget.window ?? 'day',
  }))

  // Collect decisions across all loops, newest-first, capped to 20 per loop.
  const decisionSets = await Promise.all(
    loops.map((l) => decisionsFn(env, l.id, { limit: 20 }).catch(() => [])),
  )
  // Flatten and re-sort by recorded_at DESC (each set is already sorted, so merge).
  const decisions: LoopDecisionRow[] = decisionSets
    .flat()
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
    .slice(0, 100) // cap the combined feed at 100 rows

  return { loops: loopRows, decisions }
}

// ── HTML body ────────────────────────────────────────────────────────────────

function decidedBadgeClass(decided: string): string {
  switch (decided) {
    case 'acted': return 'decided-acted'
    case 'gated_pending': return 'decided-gated'
    case 'kpi-met': return 'decided-kpimet'
    case 'budget_exhausted':
    case 'rate_limited': return 'decided-budget'
    case 'dry': return 'decided-dry'
    case 'inactive': return 'decided-inactive'
    default: return 'decided-other'
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'active': return 'loop-active'
    case 'paused': return 'loop-paused'
    case 'done':
    case 'killed': return 'loop-terminal'
    default: return ''
  }
}

/**
 * brainBody — server-rendered HTML for the /brain panel.
 *
 * canAdmin controls whether governor controls (pause/resume/kill/budget) are
 * rendered. Non-admins see the feed read-only (AC#7).
 */
export function brainBody(view: BrainView, canAdmin: boolean) {
  const loopRows = view.loops.map((l) => {
    const statusClass = statusBadgeClass(l.status)
    const govControls = canAdmin
      ? html`
          <div class="brain-gov-controls">
            ${l.status === 'active'
              ? html`<button class="btn sm brain-ctrl-btn secondary"
                    data-loop="${l.id}" data-action="pause"
                    onclick="brainControl(this)">Pause</button>`
              : l.status === 'paused'
              ? html`<button class="btn sm brain-ctrl-btn"
                    data-loop="${l.id}" data-action="resume"
                    onclick="brainControl(this)">Resume</button>`
              : html``}
            ${l.status !== 'done' && l.status !== 'killed'
              ? html`<button class="btn sm brain-ctrl-btn secondary"
                  style="color:var(--warn2);border-color:var(--warn2)"
                  data-loop="${l.id}" data-action="kill"
                  onclick="brainControl(this)">Kill</button>`
              : html``}
          </div>`
      : html``

    return html`
      <div class="brain-loop-card">
        <div class="brain-loop-head">
          <span class="brain-loop-okr">${l.okr}</span>
          <span class="brain-loop-status ${raw(statusClass)}">${l.status}</span>
        </div>
        <div class="brain-loop-meta">
          <span class="brain-meta-item"><span class="brain-meta-label">KPI</span> ${l.kpiSignal} · target ${l.kpiTarget}</span>
          <span class="brain-meta-item"><span class="brain-meta-label">Effort</span> ${l.effort}</span>
          <span class="brain-meta-item"><span class="brain-meta-label">Owner</span> ${l.ownerKind}</span>
        </div>
        ${govControls}
      </div>`
  })

  const decisionRows = view.decisions.map((d) => {
    const badgeClass = decidedBadgeClass(d.decided)
    const capDesc = d.capability_descriptor
      ? raw(escHtml(d.capability_descriptor))
      : raw('<em>—</em>')
    const errCell = d.error ? html`<span class="brain-err" title="${d.error}">err</span>` : html``
    const shortTime = d.recorded_at.slice(0, 16).replace('T', ' ')
    return html`
      <tr>
        <td><span class="brain-decided-badge ${raw(badgeClass)}">${d.decided}</span>${errCell}</td>
        <td>${d.loop_id.slice(0, 8)}</td>
        <td>${d.cycle_num}</td>
        <td>${d.perceived}</td>
        <td>${d.acted}</td>
        <td>${d.gated}</td>
        <td>${d.kpi}</td>
        <td>${capDesc}</td>
        <td class="brain-time">${shortTime}</td>
      </tr>`
  })

  const adminScript = canAdmin
    ? html`
<script>
async function brainControl(btn) {
  const loopId = btn.dataset.loop;
  const action = btn.dataset.action;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    if (action === 'pause' || action === 'kill') {
      const status = action === 'kill' ? 'done' : 'paused';
      const r = await fetch('/api/loops/' + loopId + '/status', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ status })
      });
      if (!r.ok) throw new Error(await r.text());
      window.location.reload();
    } else if (action === 'resume') {
      const r = await fetch('/api/loops/' + loopId + '/status', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ status: 'active' })
      });
      if (!r.ok) throw new Error(await r.text());
      window.location.reload();
    }
  } catch(e) {
    btn.disabled = false;
    btn.textContent = action;
    alert('Control failed: ' + e.message);
  }
}
</script>`
    : html``

  return html`
    <style>
      .brain-loops { display: flex; flex-direction: column; gap: 10px; margin-bottom: 28px; }
      .brain-loop-card {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 14px 16px;
      }
      .brain-loop-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .brain-loop-okr { font-weight: 600; font-size: 14px; }
      .brain-loop-status {
        font-size: 11px; font-weight: 700; padding: 2px 8px;
        border-radius: 999px; border: 1px solid;
      }
      .loop-active  { color: var(--ok);    border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
      .loop-paused  { color: var(--dim);   border-color: var(--border); }
      .loop-terminal{ color: var(--warn2); border-color: color-mix(in srgb, var(--warn2) 40%, var(--border)); }
      .brain-loop-meta { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 8px; font-size: 13px; color: var(--muted); }
      .brain-meta-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); margin-right: 3px; }
      .brain-gov-controls { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      .brain-ctrl-btn { min-width: 60px; }

      /* decision feed */
      .brain-feed { width: 100%; border-collapse: collapse; font-size: 13px; }
      .brain-feed th, .brain-feed td {
        text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: middle;
      }
      .brain-feed th { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
      .brain-feed tr:last-child td { border-bottom: none; }
      .brain-time { color: var(--dim); font-size: 12px; white-space: nowrap; }
      .brain-err {
        font-size: 10px; font-weight: 700; color: var(--danger);
        border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
        border-radius: 4px; padding: 1px 4px; margin-left: 6px;
      }

      /* decided badges */
      .brain-decided-badge {
        font-size: 11px; font-weight: 700; padding: 2px 8px;
        border-radius: 999px; border: 1px solid; display: inline-block;
      }
      .decided-acted    { color: var(--ok);    border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
      .decided-gated    { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
      .decided-kpimet   { color: var(--accent2); border-color: color-mix(in srgb, var(--accent2) 40%, var(--border)); }
      .decided-budget   { color: var(--warn2); border-color: color-mix(in srgb, var(--warn2) 40%, var(--border)); }
      .decided-dry      { color: var(--dim);   border-color: var(--border); }
      .decided-inactive { color: var(--dim);   border-color: var(--border); opacity: .6; }
      .decided-other    { color: var(--muted); border-color: var(--border); }
    </style>

    <p class="crumbs"><a href="/">Overview</a> / Brain</p>
    <h1>Brain</h1>
    <p class="empty" style="margin-top:0;max-width:680px">
      Per-pot loop governor. Decision feed shows what each loop decided last cycle.
      Governor controls pause, resume, or kill a loop${canAdmin ? raw('') : raw(' (admin only)')}.
    </p>

    <h2>Loops</h2>
    ${
      view.loops.length
        ? html`<div class="brain-loops">${loopRows}</div>`
        : html`<div class="card"><p class="empty">No loops. Seed one at <code>POST /api/loops/seed-outreach</code>.</p></div>`
    }

    <h2>Decision feed</h2>
    ${
      view.decisions.length
        ? html`<div class="card" style="padding:0;overflow:hidden">
            <table class="brain-feed">
              <thead><tr>
                <th>Decided</th><th>Loop</th><th>Cycle</th>
                <th>Perceived</th><th>Acted</th><th>Gated</th><th>KPI</th>
                <th>Tier</th><th>Time</th>
              </tr></thead>
              <tbody>${decisionRows}</tbody>
            </table>
          </div>`
        : html`<div class="card"><p class="empty">No decisions yet. The feed populates after the first heartbeat cycle.</p></div>`
    }

    ${adminScript}`
}

// ── helpers ───────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
