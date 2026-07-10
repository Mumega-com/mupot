// dashboard/observatory.ts — data layer for the swimlane observatory home (#13).
//
// Read-only. Every query targets this tenant's D1 (one DB per pot — no tenant
// column needed). Data shapes are intentionally narrow: we only select the
// columns the view layer consumes, so the cost of an accidental field exposure
// is near-zero.
//
// Time window: last 24 h, organised into an hourly grid (24 buckets). The
// swimlane bars are derived from tasks.created_at → completed_at (or now for
// in-flight tasks). Agents with zero activity in the window still get a lane.
//
// Cost (#15): task-level spend is now metered. tasks.cost_micro_usd is stamped at
// execution time; AgentStat.spend_micro_usd sums it over the 24h window and
// RecentTask.cost_micro_usd carries the per-task figure. Both are estimates priced
// from token usage via src/agents/cost.ts (see that module for the caveats).

import type { Env, Agent } from '../types'
import { derivePresence, presenceTtlSec } from '../fleet/registry'

// ── Time window ───────────────────────────────────────────────────────────────

/** ISO-8601 timestamp for 24 hours ago (used in every SELECT). */
function windowStart(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
}

// ── Per-agent stats ───────────────────────────────────────────────────────────

export interface AgentStat {
  agent_id: string
  task_count: number   // total tasks in last 24 h
  done_count: number   // status = 'done'
  // success_pct = done / task_count × 100; 0 when task_count = 0
  success_pct: number
  in_flight: number    // open | in_progress tasks right now
  // #15: summed task cost over the 24h window, in micro-USD (0 when unmetered).
  spend_micro_usd: number
}

/**
 * Aggregate task counts per agent over the last 24 h.
 * Returns a map keyed by agent_id so the view can O(1) look up stats per lane.
 */
export async function loadAgentStats(env: Env): Promise<Map<string, AgentStat>> {
  const since = windowStart()
  // One scan per agent (GROUP BY). D1 has a 1000-row cap on .all() but a
  // small pot has O(tens) of agents; COUNT aggregates keep the result tiny.
  const rows = await env.DB.prepare(
    `SELECT
       a.id                                                      AS agent_id,
       COUNT(t.id)                                               AS task_count,
       COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done_count,
       COALESCE(SUM(CASE WHEN t.status IN ('open','in_progress') THEN 1 ELSE 0 END), 0) AS in_flight,
       COALESCE(SUM(t.cost_micro_usd), 0)                             AS spend_micro_usd
     FROM agents a
     LEFT JOIN tasks t
            ON t.assignee_agent_id = a.id
           AND t.created_at >= ?1
     GROUP BY a.id`,
  )
    .bind(since)
    .all<{ agent_id: string; task_count: number; done_count: number; in_flight: number; spend_micro_usd: number }>()

  const map = new Map<string, AgentStat>()
  for (const r of rows.results ?? []) {
    const task_count = r.task_count ?? 0
    const done_count = r.done_count ?? 0
    map.set(r.agent_id, {
      agent_id: r.agent_id,
      task_count,
      done_count,
      success_pct: task_count > 0 ? Math.round((done_count / task_count) * 100) : 0,
      in_flight: r.in_flight ?? 0,
      spend_micro_usd: r.spend_micro_usd ?? 0,
    })
  }
  return map
}

// ── Swimlane bars ─────────────────────────────────────────────────────────────
//
// A "bar" is one task placed on the 24-hour time grid. We derive:
//   left_pct  = (created_at_offset_ms / 24h) × 100
//   width_pct = (duration_ms / 24h) × 100  (min 0.4% so bars are always visible)
//
// For in-flight tasks (no completed_at) we use now as the right edge and mark
// the bar "growing". The view renders a live "breathing" animation on these.
//
// Status drives colour:
//   done/approved → accent (green)
//   in_progress   → secondary (cyan)
//   open          → muted (grey)
//   blocked       → warn / amber
//   review        → accent (gold, same as manual tasks in the mock)
//   rejected      → danger (red)

export type BarStatus = 'done' | 'in_progress' | 'open' | 'blocked' | 'review' | 'approved' | 'rejected'

export interface SwimlaneBar {
  id: string
  agent_id: string
  title: string
  status: BarStatus
  left_pct: number   // 0–100; left edge on the 24h grid
  width_pct: number  // 0–100; duration on the 24h grid (clamped)
  growing: boolean   // true if still in-flight (right edge = now)
  created_at: string
  completed_at: string | null
}

const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * All tasks that overlap the last-24h window, projected as swimlane bars.
 * We fetch assigned tasks regardless of status so blocking/review states show.
 * Unassigned tasks (assignee_agent_id IS NULL) are excluded — no lane to put them on.
 */
export async function loadSwimlaneBars(env: Env): Promise<SwimlaneBar[]> {
  const since = windowStart()
  const nowMs = Date.now()
  const windowStartMs = nowMs - WINDOW_MS

  const rows = await env.DB.prepare(
    `SELECT id, assignee_agent_id AS agent_id, title, status, created_at, completed_at
       FROM tasks
      WHERE assignee_agent_id IS NOT NULL
        AND created_at >= ?1
      ORDER BY created_at ASC`,
  )
    .bind(since)
    .all<{
      id: string
      agent_id: string
      title: string
      status: string
      created_at: string
      completed_at: string | null
    }>()

  const bars: SwimlaneBar[] = []
  for (const r of rows.results ?? []) {
    const createdMs = new Date(r.created_at).getTime()
    // Right edge: completed_at (if present) or now for in-flight.
    const endMs = r.completed_at ? new Date(r.completed_at).getTime() : nowMs
    const growing = !r.completed_at

    // Clamp to the window (task may have started before the 24h window, but
    // we only fetch tasks created_at >= since, so leftMs >= windowStartMs always).
    const leftMs = Math.max(createdMs, windowStartMs)
    const rightMs = Math.min(endMs, nowMs)

    const left_pct = clamp(((leftMs - windowStartMs) / WINDOW_MS) * 100, 0, 100)
    const raw_width_pct = ((rightMs - leftMs) / WINDOW_MS) * 100
    // Minimum 0.4% so even instant tasks are visible at 1280px.
    const width_pct = clamp(Math.max(raw_width_pct, 0.4), 0, 100 - left_pct)

    bars.push({
      id: r.id,
      agent_id: r.agent_id,
      title: r.title,
      status: r.status as BarStatus,
      left_pct,
      width_pct,
      growing,
      created_at: r.created_at,
      completed_at: r.completed_at,
    })
  }
  return bars
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// ── Hourly grid labels ────────────────────────────────────────────────────────

/**
 * 7 evenly-spaced tick labels across the 24h window, formatted as HH:mm.
 * The last tick is always labelled "now".
 * Used by the view to render the time axis — purely derived from Date.now().
 */
export function buildHourlyTicks(): string[] {
  const nowMs = Date.now()
  const ticks: string[] = []
  // 0, 4h, 8h, 12h, 16h, 20h, 24h (7 ticks = 6 intervals of 4h)
  const STEP_MS = 4 * 60 * 60 * 1000
  for (let i = 0; i < 6; i++) {
    const t = new Date(nowMs - WINDOW_MS + i * STEP_MS)
    ticks.push(fmtHHmm(t))
  }
  ticks.push('now')
  return ticks
}

function fmtHHmm(d: Date): string {
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  return `${h}:${m}`
}

// ── Recent tasks ──────────────────────────────────────────────────────────────

export interface RecentTask {
  id: string
  title: string
  status: string
  agent_id: string | null
  agent_name: string | null
  squad_name: string | null
  completed_at: string | null
  created_at: string
  // #15: cost stamped at execution time, in micro-USD (0 when never executed).
  cost_micro_usd: number
}

/** Last 10 tasks across all squads, ordered by most recent update first. */
export async function loadRecentTasks(env: Env): Promise<RecentTask[]> {
  const rows = await env.DB.prepare(
    `SELECT t.id, t.title, t.status,
            t.assignee_agent_id AS agent_id, a.name AS agent_name,
            s.name AS squad_name,
            t.completed_at, t.created_at,
            COALESCE(t.cost_micro_usd, 0) AS cost_micro_usd
       FROM tasks t
       LEFT JOIN agents a ON a.id = t.assignee_agent_id
       LEFT JOIN squads s ON s.id = t.squad_id
      ORDER BY t.updated_at DESC
      LIMIT 10`,
  ).all<RecentTask>()
  return rows.results ?? []
}

// ── Full observatory payload ──────────────────────────────────────────────────
//
// One parallel fetch; callers get a single well-typed object rather than
// managing multiple awaits.

export interface ObservatoryData {
  agents: Agent[]
  stats: Map<string, AgentStat>
  runtimeStates: Map<string, AgentRuntimeState>
  bars: SwimlaneBar[]
  ticks: string[]
  recentTasks: RecentTask[]
}

// An active catalog row means the operator enabled an agent. It does not mean a
// trusted runtime is connected: that requires both its signing key and a fresh
// fleet heartbeat.
export type AgentRuntimeState = 'live' | 'stale' | 'offline' | 'unattached'

interface AgentRuntimeEvidence {
  agent_id: string
  key_agent_id: string | null
  fleet_status: string | null
  last_reported_at: string | null
}

export function deriveAgentRuntimeState(
  evidence: Pick<AgentRuntimeEvidence, 'key_agent_id' | 'fleet_status' | 'last_reported_at'>,
  ttlSec: number,
  nowMs: number,
): AgentRuntimeState {
  if (!evidence.key_agent_id) return 'unattached'
  if (!evidence.fleet_status) return 'offline'
  return derivePresence(evidence.fleet_status, evidence.last_reported_at ?? '', ttlSec, nowMs)
}

export async function loadAgentRuntimeStates(env: Env, nowMs = Date.now()): Promise<Map<string, AgentRuntimeState>> {
  const rows = await env.DB.prepare(
    `SELECT a.id AS agent_id,
            k.agent_id AS key_agent_id,
            f.status AS fleet_status,
            f.last_reported_at
       FROM agents a
       LEFT JOIN agent_keys k
              ON k.tenant = ?1 AND k.agent_id = a.id
       LEFT JOIN fleet_agents f
              ON f.tenant = ?1 AND f.agent_id = a.id
      ORDER BY a.created_at ASC, a.name ASC`,
  )
    .bind(env.TENANT_SLUG)
    .all<AgentRuntimeEvidence>()

  const states = new Map<string, AgentRuntimeState>()
  const ttlSec = presenceTtlSec(env)
  for (const row of rows.results ?? []) {
    states.set(row.agent_id, deriveAgentRuntimeState(row, ttlSec, nowMs))
  }
  return states
}

export async function loadObservatory(env: Env): Promise<ObservatoryData> {
  const [agentRows, statsMap, runtimeStates, bars, recentTasks] = await Promise.all([
    env.DB.prepare(
      'SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents ORDER BY created_at ASC, name ASC',
    ).all<Agent>(),
    loadAgentStats(env),
    loadAgentRuntimeStates(env),
    loadSwimlaneBars(env),
    loadRecentTasks(env),
  ])

  return {
    agents: agentRows.results ?? [],
    stats: statsMap,
    runtimeStates,
    bars,
    ticks: buildHourlyTicks(),
    recentTasks,
  }
}

// ── Gradient helper (deterministic from agent name, no uploads) ───────────────
// Same algorithm as the Astro mock (seed = name → hue pair).
export function agentGradient(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h * 31 + name.charCodeAt(i)) % 360 + 360) % 360
  const h2 = (h + 48) % 360
  return `linear-gradient(135deg,hsl(${h} 58% 46%),hsl(${h2} 62% 38%))`
}
