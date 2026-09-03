import type { Env } from '../types'

/**
 * Agent profile panels.
 *
 * An agent in mupot has been a row in a picker: a name, a slug, a squad, and a
 * wake button. Nothing showed what it had done, who it worked with, or whether
 * it could be trusted with anything. This is the layer that makes an agent
 * legible — to the person choosing which one to act as, and to the squad
 * deciding who to hand work to.
 *
 * WHY A REGISTRY AND NOT A LAYOUT. The signals worth showing are not all
 * available yet, and some need a decision before they can exist at all (see
 * "reliability" below). A page hard-coded around today's four queries has to be
 * rewritten for the fifth. A registry means a new signal is a new registration.
 *
 * THE CONTRACT, and every clause exists because of a specific way this goes wrong:
 *
 *   available()  Can this panel resolve for this agent, in this tenant, at all?
 *                Distinct from "resolved and found nothing". An agent with no
 *                flights and a flights table we cannot read must not look alike.
 *   load()       Returns data OR a typed empty/unavailable — never an empty chart
 *                and never a zero that means "unknown". A zero that means unknown
 *                is the worst thing this page could ship, because it reads as a
 *                measurement.
 *   render()     Owns its own presentation and knows nothing of its neighbours,
 *                so one slow or failing panel cannot hold or corrupt the page.
 *
 * WHAT IS DELIBERATELY NOT HERE. A "mistakes" or reliability count. Gate receipts
 * record a verdict against a COMMIT, not against an agent, so a blocked review is
 * not currently attributable to whoever authored it. Four definitions are
 * defensible — gate returned BLOCK, a merge later reverted, a red required check
 * on their branch, a task that came back from review — and each produces a
 * different number. A counter labelled "mistakes" is a judgement about a
 * colleague; it should be legible about what it counts or be named something
 * narrower and true. That is a decision, not a query, and it is not mine to make
 * silently.
 */

export type PanelState = 'ready' | 'empty' | 'unavailable'

export interface PanelResult<T> {
  state: PanelState
  /** Present only when state === 'ready'. */
  data?: T
  /** Why the panel could not resolve. Shown to the reader, not swallowed. */
  reason?: string
}

/** Reads that failed are 'unavailable', never 'empty'. An unread table is not an empty one. */
export function unavailable<T>(reason: string): PanelResult<T> {
  return { state: 'unavailable', reason }
}

export function empty<T>(): PanelResult<T> {
  return { state: 'empty' }
}

export function ready<T>(data: T): PanelResult<T> {
  return { state: 'ready', data }
}

// ── flights ──────────────────────────────────────────────────────────────────

export interface FlightSummary {
  total: number
  landed: number
  failed: number
  held: number
  running: number
  /** Total spend in micro-USD across every flight this agent flew. */
  costMicroUsd: number
  recent: { id: string; goal: string; status: string; created_at: string }[]
}

/**
 * Flights carry `agent` directly, so this is a genuine group-by rather than a
 * reconstruction. `cost_micro_usd` is summed as stored — a flight reaped by the
 * watchdog at zero cost really did cost zero, and rounding that away would hide
 * the most interesting failure mode on this deployment.
 */
export function summariseFlights(
  rows: { id: string; goal: string; status: string; cost_micro_usd: number | null; created_at: string }[],
): FlightSummary {
  const summary: FlightSummary = {
    total: rows.length,
    landed: 0,
    failed: 0,
    held: 0,
    running: 0,
    costMicroUsd: 0,
    recent: [],
  }
  for (const r of rows) {
    if (r.status === 'landed') summary.landed += 1
    else if (r.status === 'failed') summary.failed += 1
    else if (r.status === 'held') summary.held += 1
    else if (r.status === 'running') summary.running += 1
    const cost = Number(r.cost_micro_usd)
    if (Number.isFinite(cost)) summary.costMicroUsd += cost
  }
  summary.recent = rows.slice(0, 5).map((r) => ({
    id: r.id,
    goal: r.goal,
    status: r.status,
    created_at: r.created_at,
  }))
  return summary
}

export async function loadFlightPanel(env: Env, agentId: string): Promise<PanelResult<FlightSummary>> {
  try {
    const res = await env.DB.prepare(
      `SELECT id, goal, status, cost_micro_usd, created_at
         FROM flights
        WHERE tenant = ?1 AND agent = ?2
        ORDER BY created_at DESC
        LIMIT 200`,
    ).bind(env.TENANT_SLUG, agentId).all<{
      id: string; goal: string; status: string; cost_micro_usd: number | null; created_at: string
    }>()
    const rows = res.results ?? []
    if (rows.length === 0) return empty()
    return ready(summariseFlights(rows))
  } catch (err) {
    // The distinction that matters: we could not READ, which is not the same as
    // this agent having flown nothing.
    console.error('[agent-profile] flight panel read failed:', err)
    return unavailable('Flight history could not be read.')
  }
}

// ── work (tasks) ─────────────────────────────────────────────────────────────

export interface WorkSummary {
  total: number
  open: number
  done: number
  /** Tasks that carry a GitHub issue link — the ones with an outside record. */
  tracked: number
  recent: { id: string; title: string; status: string; github_issue_url: string | null }[]
}

const DONE_STATES = new Set(['done', 'approved'])

export function summariseWork(
  rows: { id: string; title: string; status: string; github_issue_url: string | null }[],
): WorkSummary {
  const summary: WorkSummary = { total: rows.length, open: 0, done: 0, tracked: 0, recent: [] }
  for (const r of rows) {
    if (DONE_STATES.has(r.status)) summary.done += 1
    else summary.open += 1
    if (r.github_issue_url) summary.tracked += 1
  }
  summary.recent = rows.slice(0, 5)
  return summary
}

export async function loadWorkPanel(env: Env, agentId: string): Promise<PanelResult<WorkSummary>> {
  try {
    const res = await env.DB.prepare(
      `SELECT id, title, status, github_issue_url
         FROM tasks
        WHERE assignee_agent_id = ?1
        ORDER BY updated_at DESC
        LIMIT 200`,
    ).bind(agentId).all<{
      id: string; title: string; status: string; github_issue_url: string | null
    }>()
    const rows = res.results ?? []
    if (rows.length === 0) return empty()
    return ready(summariseWork(rows))
  } catch (err) {
    console.error('[agent-profile] work panel read failed:', err)
    return unavailable('Assigned work could not be read.')
  }
}

// ── registry ─────────────────────────────────────────────────────────────────

export interface PanelSpec {
  key: string
  title: string
  /** Empty-state copy. Says what is true, never invents a number. */
  emptyLabel: string
}

/**
 * Ordered. A new signal is appended here plus one loader — not a page rewrite.
 * Registered panels not yet built (relationships, code, reliability) are absent
 * rather than stubbed, so the page never shows a placeholder that looks like data.
 */
export const PANELS: readonly PanelSpec[] = [
  { key: 'flights', title: 'Flights', emptyLabel: 'This agent has not flown.' },
  { key: 'work', title: 'Work', emptyLabel: 'No tasks are assigned to this agent.' },
]

export function panelByKey(key: string): PanelSpec | undefined {
  return PANELS.find((p) => p.key === key)
}

/** micro-USD to a human string. Zero is shown as zero — it is a real, informative value here. */
export function formatCost(microUsd: number): string {
  if (!Number.isFinite(microUsd) || microUsd < 0) return '—'
  if (microUsd === 0) return '$0.00'
  return `$${(microUsd / 1_000_000).toFixed(2)}`
}
