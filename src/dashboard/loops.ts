// mupot — /dashboard/loops view (#36 polish): watch active loops + the outreach funnel.
//
// Read-only operator visibility so the live test is observable: which loops are running,
// their goal/KPI/budget, and the prospect funnel (queued → replied). Pairs with
// /approvals (where the gated sends wait). No mutation here.

import { html, raw } from 'hono/html'
import type { Env } from '../types'
import { listLoops } from '../loops/service'
import { countByStatus } from '../loops/prospects'
import { formatUsd } from '../agents/cost'

export interface LoopRowView {
  id: string
  okr: string
  status: string
  kpiSignal: string
  kpiTarget: number
  capMicroUsd: number | null
  window: string
  effort: string
  ownerKind: 'agent' | 'squad'
}

export interface LoopsView {
  loops: LoopRowView[]
  queued: number
  drafted: number
  sent: number
  replied: number
}

export interface LoopsViewDeps {
  list?: (env: Env) => Promise<Awaited<ReturnType<typeof listLoops>>>
  count?: (env: Env, status: 'queued' | 'drafted' | 'sent' | 'replied') => Promise<number>
}

export async function loadLoopsView(env: Env, deps: LoopsViewDeps = {}): Promise<LoopsView> {
  const list = deps.list ?? ((e) => listLoops(e))
  const count = deps.count ?? ((e, s) => countByStatus(e, s))

  const loops = await list(env)
  const [queued, drafted, sent, replied] = await Promise.all([
    count(env, 'queued'),
    count(env, 'drafted'),
    count(env, 'sent'),
    count(env, 'replied'),
  ])

  return {
    queued,
    drafted,
    sent,
    replied,
    loops: loops.map((l) => ({
      id: l.id,
      okr: l.okr,
      status: l.status,
      kpiSignal: l.kpi.signal,
      kpiTarget: l.kpi.target,
      capMicroUsd: l.budget.cap_micro_usd ?? null,
      window: l.budget.window ?? 'day',
      effort: l.budget.effort ?? 'standard',
      ownerKind: l.agent_id ? 'agent' : 'squad',
    })),
  }
}

export function loopsBody(v: LoopsView) {
  const rows = v.loops
    .map(
      (l) => html`
        <tr>
          <td><span class="status status-${raw(l.status)}">${l.status}</span></td>
          <td>${l.okr}</td>
          <td>${l.kpiSignal} · target ${l.kpiTarget}</td>
          <td>${l.capMicroUsd === null ? raw('<em>none</em>') : `${formatUsd(l.capMicroUsd)}/${l.window}`}</td>
          <td>${l.effort}</td>
          <td>${l.ownerKind}</td>
        </tr>`,
    )

  const funnel = html`
    <div class="card" style="display:flex;gap:24px;flex-wrap:wrap">
      <div><strong style="font-size:22px">${v.queued}</strong><br><span class="muted">queued</span></div>
      <div><strong style="font-size:22px">${v.drafted}</strong><br><span class="muted">drafted</span></div>
      <div><strong style="font-size:22px">${v.sent}</strong><br><span class="muted">sent</span></div>
      <div><strong style="font-size:22px;color:var(--ink-primary,#0a7)">${v.replied}</strong><br><span class="muted">replied (KPI)</span></div>
    </div>`

  return html`
    <p class="crumbs"><a href="/">Overview</a> / Loops</p>
    <h1>Loops</h1>
    <p class="empty" style="margin-top:0;max-width:680px">
      Goal-seeking work-units running on the heartbeat. Each drives itself toward its KPI
      within its budget; every customer-facing act waits at the <a href="/approvals">gate</a>.
    </p>
    ${funnel}
    ${
      v.loops.length
        ? html`<table class="grid">
            <thead><tr><th>Status</th><th>Goal (OKR)</th><th>KPI</th><th>Budget</th><th>Effort</th><th>Owner</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : html`<div class="card"><p class="empty">No loops yet. An owner can seed the outreach loop with
            <code>POST /api/loops/seed-outreach</code>, then import prospects with
            <code>POST /api/prospects/import</code>.</p></div>`
    }`
}
