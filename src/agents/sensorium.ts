// mupot — sensorium: deterministic self-state block for the goal loop.
//
// S1 keystone: every runGoalCycle tick reads a compact, LLM-free self-state
// snapshot (the sensorium) so the agent re-enters KNOWING its situation instead
// of firing blind. The sensorium is:
//   - DETERMINISTIC: same DB state + same runtime input → identical output.
//   - LLM-FREE: no model calls, no Vectorize, no external fetch.
//   - BOUNDED: every list output is capped so the prompt block never grows
//              unboundedly.
//   - INJECTABLE: a `now` seam lets tests freeze time; a `buildSensorium?` seam
//                 in LoopDeps lets tests skip D1 entirely.
//
// The SENSORIUM_VERSION constant is a future fingerprint preimage (the signature
// of the sensorium block feeds into the episodic-memory hash in S2+).
//
// Fields:
//   clock        — current time, agent age, cycles, last_woke_at
//   situation    — agent name/role/autonomy/effort + wake reason
//   schedule     — task status counts (open/in_progress/done/blocked),
//                  overdue count, ≤5 oldest open task titles
//   vitals       — kpi_progress, kpi_target, budget remaining (from meter)
//   delegations  — tasks this agent has dispatched (≤5)
//   tasks        — alias of schedule.oldest_open_tasks (convenience for loop injection)
//
// Wire: AgentDO populates an AgentRuntime and passes it into runGoalCycle via
// LoopDeps.sensoriumRuntime. buildSensorium uses it for non-DB runtime fields.

import type { Env, Agent, Effort, Autonomy } from '../types'

// ── Version ─────────────────────────────────────────────────────────────────

export const SENSORIUM_VERSION = 'v1' as const

// ── Bounded list cap ─────────────────────────────────────────────────────────

/** Maximum open tasks surfaced in the prompt. Keeps the block O(1). */
export const SENSORIUM_TASK_CAP = 5

/** Maximum delegated tasks surfaced in the prompt. */
export const SENSORIUM_DELEGATION_CAP = 5

/** Tasks older than this (in hours) with status open/in_progress are flagged overdue. */
export const SENSORIUM_OVERDUE_HOURS = 48

// ── Runtime state (from AgentDO; not persisted in D1) ─────────────────────

/**
 * AgentRuntime holds the volatile state that lives only in the DO's embedded
 * SQLite. buildSensorium accepts this as an optional arg; when absent, those
 * fields are omitted from the sensorium (cycle 0, no last_woke_at).
 *
 * AgentDO passes this to runGoalCycle via LoopDeps.sensoriumRuntime so the
 * sensorium stays DO-independent and fully testable.
 */
export interface AgentRuntime {
  cycles: number
  last_woke_at: string | null
  last_decision: string | null
  wake_reason?: string | null
}

// ── Sensorium shape ──────────────────────────────────────────────────────────

export interface SensoriumClock {
  now: string             // ISO-8601, injected for determinism
  agent_age_days: number  // floor((now - created_at) / 86400000)
  cycles: number
  last_woke_at: string | null
}

export interface SensoriumSituation {
  agent_name: string
  agent_role: string
  autonomy: Autonomy | null
  effort: Effort | null
  wake_reason: string | null
}

export interface TaskStatusCounts {
  open: number
  in_progress: number
  done: number
  blocked: number
}

export interface SensoriumSchedule {
  counts: TaskStatusCounts
  overdue: number               // open/in_progress tasks older than SENSORIUM_OVERDUE_HOURS
  oldest_open_tasks: string[]   // ≤ SENSORIUM_TASK_CAP titles, deterministic ORDER BY created_at ASC
}

export interface SensoriumVitals {
  kpi_progress: number    // 0-100
  kpi_target: string | null
  budget_remaining_micro_usd: number | null  // null = no cap or unknown
  budget_window: string
}

export interface SensoriumDelegation {
  task_id: string
  title: string
  status: string
}

export interface Sensorium {
  version: typeof SENSORIUM_VERSION
  clock: SensoriumClock
  situation: SensoriumSituation
  schedule: SensoriumSchedule
  vitals: SensoriumVitals
  delegations: SensoriumDelegation[]
  /** Convenience alias — the oldest open task titles (same as schedule.oldest_open_tasks). */
  tasks: string[]
}

// ── Options / seams ───────────────────────────────────────────────────────────

export interface BuildSensoriumOpts {
  /**
   * Inject a fixed ISO string for `clock.now` to make the sensorium deterministic
   * in tests. In production this defaults to new Date().toISOString().
   */
  now?: string
}

// ── Core builder ──────────────────────────────────────────────────────────────

/**
 * buildSensorium — compute the self-state block from D1 + runtime state.
 *
 * Pure I/O: reads from D1 + the passed-in runtime; makes NO model calls,
 * NO Vectorize queries, NO external fetches. Failures in individual reads
 * degrade gracefully (zero / null values) so a DB hiccup never aborts the
 * goal cycle.
 *
 * All list outputs are BOUNDED (SENSORIUM_TASK_CAP / SENSORIUM_DELEGATION_CAP).
 * Ordering is deterministic (ORDER BY created_at ASC → oldest first).
 */
export async function buildSensorium(
  env: Env,
  agent: Agent,
  runtime?: AgentRuntime | null,
  opts?: BuildSensoriumOpts,
): Promise<Sensorium> {
  const now = opts?.now ?? new Date().toISOString()

  // ── clock ────────────────────────────────────────────────────────────────
  const agentAgeMs =
    agent.created_at ? new Date(now).getTime() - new Date(agent.created_at).getTime() : 0
  const agentAgeDays = Math.max(0, Math.floor(agentAgeMs / 86_400_000))

  const clock: SensoriumClock = {
    now,
    agent_age_days: agentAgeDays,
    cycles: runtime?.cycles ?? 0,
    last_woke_at: runtime?.last_woke_at ?? null,
  }

  // ── situation ────────────────────────────────────────────────────────────
  const situation: SensoriumSituation = {
    agent_name: agent.name,
    agent_role: agent.role,
    autonomy: agent.autonomy ?? null,
    effort: agent.effort ?? null,
    wake_reason: runtime?.wake_reason ?? null,
  }

  // ── schedule: task counts + overdue + bounded open list ─────────────────
  const schedule = await safeReadSchedule(env, agent, now)

  // ── vitals: kpi + budget ─────────────────────────────────────────────────
  const vitals = await safeReadVitals(env, agent)

  // ── delegations: tasks dispatched TO this agent ──────────────────────────
  const delegations = await safeReadDelegations(env, agent)

  return {
    version: SENSORIUM_VERSION,
    clock,
    situation,
    schedule,
    vitals,
    delegations,
    tasks: schedule.oldest_open_tasks,
  }
}

// ── Renderer ─────────────────────────────────────────────────────────────────

/**
 * renderSensorium — compact, stable, deterministically-ordered text block for
 * prompt injection. The agent reads this every cycle before proposing tasks.
 *
 * Ordering is intentional and fixed: clock → situation → schedule → vitals →
 * delegations → open task list. Tests should assert on this exact ordering.
 */
export function renderSensorium(s: Sensorium): string {
  const lines: string[] = []

  lines.push(`[SENSORIUM ${s.version}]`)

  // Clock
  lines.push(`Now: ${s.clock.now} | Age: ${s.clock.agent_age_days}d | Cycles: ${s.clock.cycles}`)
  if (s.clock.last_woke_at) {
    lines.push(`Last woke: ${s.clock.last_woke_at}`)
  }

  // Situation
  lines.push(`Agent: ${s.situation.agent_name} (${s.situation.agent_role})`)
  lines.push(`Autonomy: ${s.situation.autonomy ?? 'unknown'} | Effort: ${s.situation.effort ?? 'unknown'}`)
  if (s.situation.wake_reason) {
    lines.push(`Wake reason: ${s.situation.wake_reason}`)
  }

  // Schedule
  const c = s.schedule.counts
  lines.push(
    `Tasks: open=${c.open} in_progress=${c.in_progress} done=${c.done} blocked=${c.blocked}` +
    (s.schedule.overdue > 0 ? ` overdue=${s.schedule.overdue}` : ''),
  )

  // Vitals
  lines.push(
    `KPI: ${s.vitals.kpi_progress}% / target: ${s.vitals.kpi_target ?? '(unset)'}`,
  )
  if (s.vitals.budget_remaining_micro_usd !== null) {
    const remainingCents = (s.vitals.budget_remaining_micro_usd / 10_000).toFixed(2)
    lines.push(`Budget remaining: $${remainingCents} (${s.vitals.budget_window} window)`)
  }

  // Open tasks (bounded list)
  if (s.tasks.length > 0) {
    lines.push('Oldest open tasks:')
    for (const title of s.tasks) {
      lines.push(`  - ${title}`)
    }
  }

  // Delegations
  if (s.delegations.length > 0) {
    lines.push('Delegated tasks:')
    for (const d of s.delegations) {
      lines.push(`  - [${d.status}] ${d.title}`)
    }
  }

  return lines.join('\n')
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function safeReadSchedule(
  env: Env,
  agent: Agent,
  now: string,
): Promise<SensoriumSchedule> {
  const empty: SensoriumSchedule = {
    counts: { open: 0, in_progress: 0, done: 0, blocked: 0 },
    overdue: 0,
    oldest_open_tasks: [],
  }
  try {
    // Count tasks by status for this agent (assignee_agent_id OR squad)
    // We scope to assignee_agent_id first — that's the agent's direct responsibility.
    const countRows = await env.DB.prepare(
      `SELECT status, COUNT(*) AS cnt
         FROM tasks
        WHERE assignee_agent_id = ?
        GROUP BY status`,
    )
      .bind(agent.id)
      .all<{ status: string; cnt: number }>()

    const counts: TaskStatusCounts = { open: 0, in_progress: 0, done: 0, blocked: 0 }
    for (const row of countRows.results ?? []) {
      if (row.status === 'open') counts.open = row.cnt
      else if (row.status === 'in_progress') counts.in_progress = row.cnt
      else if (row.status === 'done') counts.done = row.cnt
      else if (row.status === 'blocked') counts.blocked = row.cnt
      // review/approved/rejected intentionally not counted in basic schedule
    }

    // Overdue heuristic: open/in_progress older than SENSORIUM_OVERDUE_HOURS
    const overdueThreshold = new Date(
      new Date(now).getTime() - SENSORIUM_OVERDUE_HOURS * 3_600_000,
    ).toISOString()

    const overdueRow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt
         FROM tasks
        WHERE assignee_agent_id = ?
          AND status IN ('open','in_progress')
          AND created_at < ?`,
    )
      .bind(agent.id, overdueThreshold)
      .first<{ cnt: number }>()

    const overdue = overdueRow?.cnt ?? 0

    // Bounded list of oldest open task titles (≤ SENSORIUM_TASK_CAP)
    const openRows = await env.DB.prepare(
      `SELECT title
         FROM tasks
        WHERE assignee_agent_id = ?
          AND status = 'open'
        ORDER BY created_at ASC
        LIMIT ?`,
    )
      .bind(agent.id, SENSORIUM_TASK_CAP)
      .all<{ title: string }>()

    const oldest_open_tasks = (openRows.results ?? []).map((r) => r.title)

    return { counts, overdue, oldest_open_tasks }
  } catch {
    // DB failure degrades to zeros rather than aborting the cycle
    return empty
  }
}

async function safeReadVitals(env: Env, agent: Agent): Promise<SensoriumVitals> {
  const base: SensoriumVitals = {
    kpi_progress: agent.kpi_progress,
    kpi_target: agent.kpi_target,
    budget_remaining_micro_usd: null,
    budget_window: agent.budget_window ?? 'day',
  }

  if (!agent.budget_cap_cents || agent.budget_cap_cents <= 0) {
    return base
  }

  // Read today's spend from execution_meter to compute remaining budget
  try {
    const tenant = env.TENANT_SLUG
    const today = isoDateUtc(new Date())
    const windowKey = `${tenant}:${agent.id}:${today}`

    const meterRow = await env.DB.prepare(
      `SELECT cost_micro_usd FROM execution_meter WHERE window_key = ? LIMIT 1`,
    )
      .bind(windowKey)
      .first<{ cost_micro_usd: number }>()

    const spentMicroUsd = meterRow?.cost_micro_usd ?? 0
    const capMicroUsd = agent.budget_cap_cents * 10_000 // 1 cent = 10,000 micro-USD
    const remaining = Math.max(0, capMicroUsd - spentMicroUsd)

    return { ...base, budget_remaining_micro_usd: remaining }
  } catch {
    return base
  }
}

async function safeReadDelegations(
  env: Env,
  agent: Agent,
): Promise<SensoriumDelegation[]> {
  try {
    // Delegations = tasks ASSIGNED TO this agent that are non-terminal
    // (non-done, in-flight). Bounded + deterministic ordering.
    const rows = await env.DB.prepare(
      `SELECT id, title, status
         FROM tasks
        WHERE assignee_agent_id = ?
          AND status NOT IN ('done','approved','rejected')
        ORDER BY created_at ASC
        LIMIT ?`,
    )
      .bind(agent.id, SENSORIUM_DELEGATION_CAP)
      .all<{ id: string; title: string; status: string }>()

    return (rows.results ?? []).map((r) => ({
      task_id: r.id,
      title: r.title,
      status: r.status,
    }))
  } catch {
    return []
  }
}

/** YYYY-MM-DD (UTC) for a Date. Mirrors meter.ts internal helper. */
function isoDateUtc(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
