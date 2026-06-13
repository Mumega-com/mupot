// mupot — goal-seeking loop (issue #27: design loops, not prompts).
//
// A work-unit with an OKR/KPI is NOT prompted task-by-task. The human sets
// knobs (okr / kpi_target / effort / autonomy / budget_cap_cents) once; the
// unit runs its OWN cycle toward the KPI, surfacing only gate approvals.
//
// This module is the pure, DO-independent loop body, mirroring how execute.ts
// is structured: injected deps, no Durable Object import. AgentDO.alarm wires
// it in; tests mock the injected seams.
//
// ── Effort → task budget map ─────────────────────────────────────────────────
// How many tasks this unit may SPAWN per tick. 'low' = observe-only (0 new
// tasks — the loop still runs to update kpi_progress but adds nothing new).
//
//   low      → 0   (observe / update progress, no new work)
//   standard → 1
//   high     → 2
//   sprint   → 3
//
// ── Autonomy → task disposition ──────────────────────────────────────────────
//   suggest              → create task status='open', no assignee, no gate
//   draft                → create task status='open', no assignee, no gate
//   execute              → create task status='open' + dispatch (bus wake)
//   execute_with_approval → create task status='open' + gate_owner auto-set
//                           (autonomyImpliesGate), then dispatch (K1 lands
//                           'review' after execution; human sees it in the
//                           approvals queue)
//
// Note on 'suggest' vs 'draft': both land 'open' — the semantic difference is
// intent (suggest = idea for human to pick up; draft = artefact to complete).
// The loop does not currently dispatch either; a human or future rule promotes
// them. This matches the schema intent in 0009_work_unit.sql.
//
// ── KPI progress ─────────────────────────────────────────────────────────────
// updateKpiProgress derives a COARSE progress signal from done task count:
//
//   done_count / target_count * 100  (clamped to [0, 100])
//
// target_count is parsed as a leading integer from kpi_target (e.g. "10
// tasks/week" → 10). When kpi_target is absent or non-numeric, progress is
// left unchanged. This is intentionally coarse — real KPI attribution (e.g.
// revenue, PR count, user signups) requires a dedicated data source wired per
// domain. A code comment marks the integration point.
//
// ── Budget governor ───────────────────────────────────────────────────────────
// checkAndReserve is called from the meter (execution_meter table) before any
// model spend. On block → {decided:'rate_limited'}, no tasks spawned, no tokens
// burned.

import type { Env, Agent, Effort, Autonomy, ModelMessage, ModelPort } from '../types'
import { isEffort, isAutonomy } from '../types'
import { autonomyImpliesGate } from '../org/service'
import { createTask } from '../tasks/service'
import { createModel } from '../model'
import { createMemory } from '../memory'
import { checkAndReserve, recordTokens } from './meter'
import { costMicroUsd } from './cost'

// ── Effort → max tasks spawned per tick ──────────────────────────────────────

export const EFFORT_TASK_BUDGET: Record<Effort, number> = {
  low: 0,       // observe-only: progress update but no new task spawn
  standard: 1,
  high: 2,
  sprint: 3,
}

/** Conservative token bound for pricing ONE planning (proposal) model call (#4). */
export const LOOP_PLANNING_MAX_TOKENS = 8_000

// ── Result shapes ─────────────────────────────────────────────────────────────

export type GoalCycleDecided =
  | 'no-goal'          // agent has no okr/kpi_target — loop is a no-op
  | 'kpi-met'          // kpi_progress >= 100 — goal reached, nothing to do
  | 'rate_limited'     // meter blocked the cycle (count/token cap) — no spend
  | 'budget_exhausted' // dollar cap reached — loop paused, zero spend (#4)
  | 'observe-only'     // effort=low — progress updated, no tasks spawned
  | 'spawned'          // at least one task was created

export interface GoalCycleResult {
  ok: boolean
  decided: GoalCycleDecided
  spawned: number        // tasks created this tick
  autonomy: Autonomy | null
  effort: Effort | null
  error?: string
}

export interface KpiUpdateResult {
  ok: boolean
  previous: number  // kpi_progress before the update
  current: number   // kpi_progress after (written to DB); unchanged when no denominator
  updated: boolean  // false when no change was written (no denominator or same value)
}

// ── Injectable seams (same pattern as execute.ts) ─────────────────────────────

export interface LoopDeps {
  model?: ModelPort
  // Meter seam: checkAndReserve gates the cycle pre-call; recordTokens accumulates
  // the planning call's (conservative) spend AFTER it so the dollar cap (#4) sees the
  // loop's OWN burn, not just execute-mode spend. Both injectable for tests.
  meterCheck?: typeof checkAndReserve
  recordTokens?: typeof recordTokens
  // Memory: recall recent task results to seed the prompt. Injectable to keep
  // tests off Vectorize.
  recall?: (agentId: string, query: string, limit?: number) => Promise<Array<{ text: string; score: number; id: string }>>
  // createTask seam: injectable so tests verify disposition without D1.
  createTask?: typeof createTask
  // dispatch seam: called after createTask when autonomy ∈ {execute, execute_with_approval}.
  // In production this posts to the bus or wakes the agent DO stub. Tests stub it.
  dispatch?: (taskId: string, squadId: string, agentId: string) => Promise<void>
  // kpi_progress write seam: injectable so tests can verify the SQL without D1.
  writeProgress?: (env: Env, agentId: string, progress: number) => Promise<void>
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * runGoalCycle — the loop body for one metabolism tick.
 *
 * Called from AgentDO.alarm when the agent has a goal (okr set). Goal-less
 * agents skip this and run the existing cortex propose-cycle unchanged.
 *
 * Preconditions verified here:
 *  1. Agent must have an okr (truthy string). No okr → no-goal no-op.
 *  2. kpi_progress < 100. Met goal → kpi-met no-op.
 *  3. Meter must allow the cycle. Blocked → rate_limited.
 *  4. effort maps to task budget. low → 0 tasks (observe-only).
 *
 * On success the function:
 *  - calls the model to generate up to N task proposals (N = effort budget)
 *  - routes each proposal through the autonomy gate
 *  - returns telemetry
 */
export async function runGoalCycle(
  env: Env,
  agent: Agent,
  deps: LoopDeps = {},
): Promise<GoalCycleResult> {
  // ── Guard 1: goal present ────────────────────────────────────────────────────
  if (!agent.okr || agent.okr.trim().length === 0) {
    return { ok: true, decided: 'no-goal', spawned: 0, autonomy: null, effort: null }
  }

  // ── Guard 2: KPI not already met ─────────────────────────────────────────────
  if (agent.kpi_progress >= 100) {
    return { ok: true, decided: 'kpi-met', spawned: 0, autonomy: agent.autonomy, effort: agent.effort }
  }

  // ── Guard 3: autonomy + effort must be valid (defensive; schema enforces at write) ──
  const autonomy: Autonomy = isAutonomy(agent.autonomy) ? agent.autonomy : 'draft'
  const effort: Effort = isEffort(agent.effort) ? agent.effort : 'standard'

  // ── Guard 4: effort → task budget (low = observe-only; no model call needed) ──
  const taskBudget = EFFORT_TASK_BUDGET[effort]

  // ── Guard 5: meter check (economic governor) ─────────────────────────────────
  const meterCheck = deps.meterCheck ?? checkAndReserve
  const estimateMicroUsd = costMicroUsd(agent.model, LOOP_PLANNING_MAX_TOKENS)
  const meterResult = await meterCheck(env, agent.id, {
    estimateMicroUsd,
    budgetCapCents: agent.budget_cap_cents,
    budgetWindow: agent.budget_window,
  })
  if (!meterResult.ok) {
    const decided: GoalCycleDecided =
      meterResult.reason === 'budget_cap_exceeded' ? 'budget_exhausted' : 'rate_limited'
    return {
      ok: false,
      decided,
      spawned: 0,
      autonomy,
      effort,
      error: meterResult.reason,
    }
  }

  // ── Observe-only: effort=low just tracks progress, skips model call ───────────
  if (taskBudget === 0) {
    // Still update kpi_progress on each observe tick so the dashboard stays fresh.
    const writeProgress = deps.writeProgress ?? defaultWriteProgress
    await safeWriteProgress(writeProgress, env, agent)
    return { ok: true, decided: 'observe-only', spawned: 0, autonomy, effort }
  }

  // ── Model call: generate next step proposals toward the KPI ─────────────────
  try {
    const model = deps.model ?? createModel(env)
    const recall = deps.recall ?? ((id, q, lim) => createMemory(env).recall(id, q, lim))

    const hits = await safeRecall(recall, agent.id, agent.okr, 5)
    const recentContext = hits.map((h) => `- ${h.text}`).join('\n')

    const messages: ModelMessage[] = [
      {
        role: 'system',
        content:
          'You are an autonomous work unit running a goal-seeking loop. ' +
          'You have an OKR and a KPI target. Your job is to propose the next concrete ' +
          `step(s) toward the KPI. Propose at most ${taskBudget} task(s). ` +
          'Respond ONLY with a compact JSON object: ' +
          '{"summary": string, "tasks": [{"title": string, "body": string}]}. ' +
          'If the goal is already served, return an empty tasks array.',
      },
      {
        role: 'user',
        content: buildGoalPrompt(agent, taskBudget, recentContext),
      },
    ]

    const raw = await model.chat(messages, { model: agent.model })

    // Record this planning call's (conservative) spend so the dollar cap (#4) sees
    // the loop's OWN burn, not just execute-mode spend. Best-effort — a failed
    // accounting write must never abort the cycle.
    const recordSpend = deps.recordTokens ?? recordTokens
    try {
      await recordSpend(env, agent.id, LOOP_PLANNING_MAX_TOKENS, estimateMicroUsd)
    } catch {
      // best-effort accounting
    }

    const proposals = parseProposals(raw, taskBudget)

    // ── Dispatch: create tasks + apply autonomy disposition ─────────────────
    const doCreateTask = deps.createTask ?? createTask
    const doDispatch = deps.dispatch

    let spawned = 0
    for (const proposal of proposals) {
      const gateOwner = autonomyImpliesGate(autonomy) ? 'lead' : null

      // 'execute' and 'execute_with_approval' self-assign to the agent.
      const assignee =
        autonomy === 'execute' || autonomy === 'execute_with_approval' ? agent.id : null

      const task = await doCreateTask(
        env,
        {
          squad_id: agent.squad_id,
          title: proposal.title,
          body: proposal.body,
          // Loop-proposed tasks carry a sentinel; the operator or the next cycle
          // should update done_when to a real predicate before marking done.
          done_when: '(agent-generated — set via task update)',
          gate_owner: gateOwner,
          assignee_agent_id: assignee,
        },
        { actor: { kind: 'agent', id: agent.id } },
      )

      // Dispatch (wake execute mode) for execute + execute_with_approval.
      // For suggest + draft the task is left 'open' for humans to pick up.
      if ((autonomy === 'execute' || autonomy === 'execute_with_approval') && doDispatch) {
        await safeDispatch(doDispatch, task.id, task.squad_id, agent.id)
      }

      spawned++
    }

    // ── Update kpi_progress post-tick ────────────────────────────────────────
    const writeProgress = deps.writeProgress ?? defaultWriteProgress
    await safeWriteProgress(writeProgress, env, agent)

    const decided: GoalCycleDecided = 'spawned'
    return { ok: true, decided, spawned, autonomy, effort }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'goal_cycle_failed'
    return { ok: false, decided: 'spawned', spawned: 0, autonomy, effort, error: msg }
  }
}

// ── KPI progress update ───────────────────────────────────────────────────────

/**
 * updateKpiProgress — recomputes kpi_progress from a real signal (done task count).
 *
 * Signal: done_count / target_count * 100, clamped to [0, 100].
 *
 * target_count is the leading integer from kpi_target (e.g. "10 tasks/week" → 10).
 * When kpi_target is absent or non-integer, progress is left unchanged (honest:
 * we don't fabricate a number without a denominator).
 *
 * Future integration point: replace the done_count query with a domain-specific
 * KPI signal (e.g. GitHub PRs merged, revenue events, signups). The function
 * signature and the DB write path are already in place.
 */
export async function updateKpiProgress(
  env: Env,
  agentId: string,
  kpiTarget: string | null,
): Promise<KpiUpdateResult> {
  // Parse the denominator from kpi_target. We only look at the leading integer.
  // "10 tasks/week" → 10; "20" → 20; "ship features" → null (no denominator).
  const targetCount = parseLeadingInt(kpiTarget)

  // Read current kpi_progress from DB.
  const currentRow = await env.DB.prepare(
    'SELECT kpi_progress FROM agents WHERE id = ? LIMIT 1',
  )
    .bind(agentId)
    .first<{ kpi_progress: number }>()

  const previous = currentRow?.kpi_progress ?? 0

  if (targetCount === null) {
    // No denominator available — leave progress unchanged.
    // COARSENESS NOTE: real KPI attribution is future work (per-domain datasource).
    return { ok: true, previous, current: previous, updated: false }
  }

  if (targetCount <= 0) {
    return { ok: true, previous, current: previous, updated: false }
  }

  // Count done tasks for this agent.
  // FUTURE: replace with domain-specific signal (e.g. GitHub PRs, revenue events).
  const doneRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM tasks
       WHERE assignee_agent_id = ? AND status = 'done' LIMIT 1`,
  )
    .bind(agentId)
    .first<{ cnt: number }>()

  const doneCount = doneRow?.cnt ?? 0
  const computed = Math.min(100, (doneCount / targetCount) * 100)
  const progress = Math.round(computed * 10) / 10 // 1 decimal place

  await env.DB.prepare('UPDATE agents SET kpi_progress = ?, updated_at = ? WHERE id = ?')
    .bind(progress, new Date().toISOString(), agentId)
    .run()

  return { ok: true, previous, current: progress, updated: true }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildGoalPrompt(agent: Agent, taskBudget: number, recentContext: string): string {
  const lines = [
    `Agent: ${agent.name} (role: ${agent.role})`,
    `OKR: ${agent.okr}`,
    `KPI target: ${agent.kpi_target ?? '(not set)'}`,
    `KPI progress: ${agent.kpi_progress}%`,
    `Task budget this tick: ${taskBudget}`,
  ]
  if (recentContext) {
    lines.push(`\nRecent activity:\n${recentContext}`)
  }
  lines.push('\nPropose the next concrete step(s) toward the KPI. Output JSON only.')
  return lines.join('\n')
}

interface Proposal {
  title: string
  body: string
}

/** Parse model output defensively — never throw. */
function parseProposals(raw: string, limit: number): Proposal[] {
  const empty: Proposal[] = []
  if (!raw) return empty
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return empty
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (typeof parsed !== 'object' || parsed === null) return empty
    const obj = parsed as { tasks?: unknown }
    if (!Array.isArray(obj.tasks)) return empty
    return obj.tasks
      .filter(
        (t): t is { title: string; body?: string } =>
          typeof t === 'object' && t !== null && typeof (t as { title?: unknown }).title === 'string',
      )
      .slice(0, Math.max(0, limit))
      .map((t) => ({
        title: String(t.title).slice(0, 200),
        body: typeof t.body === 'string' ? t.body.slice(0, 4000) : '',
      }))
  } catch {
    return empty
  }
}

/** Parse the leading integer from a kpi_target string. Returns null if none found. */
export function parseLeadingInt(s: string | null | undefined): number | null {
  if (!s || s.trim().length === 0) return null
  const m = s.trim().match(/^(\d+)/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Write kpi_progress using the given writer seam (injected or real). */
async function defaultWriteProgress(env: Env, agentId: string, progress: number): Promise<void> {
  await env.DB.prepare('UPDATE agents SET kpi_progress = ?, updated_at = ? WHERE id = ?')
    .bind(progress, new Date().toISOString(), agentId)
    .run()
}

/** Calls updateKpiProgress and writes via the seam. Wraps in a try/catch (best-effort). */
async function safeWriteProgress(
  write: (env: Env, agentId: string, progress: number) => Promise<void>,
  env: Env,
  agent: Agent,
): Promise<void> {
  try {
    const result = await updateKpiProgress(env, agent.id, agent.kpi_target)
    if (result.updated) {
      await write(env, agent.id, result.current)
    }
  } catch {
    // best-effort; a failed progress write must not abort the cycle
  }
}

/** Safe recall: swallow on error (memory miss is acceptable). */
async function safeRecall(
  recall: (agentId: string, query: string, limit?: number) => Promise<Array<{ text: string; score: number; id: string }>>,
  agentId: string,
  query: string,
  limit: number,
): Promise<Array<{ text: string; score: number; id: string }>> {
  try {
    return await recall(agentId, query, limit)
  } catch {
    return []
  }
}

/** Safe dispatch: swallow on error (the task row is already persisted). */
async function safeDispatch(
  dispatch: (taskId: string, squadId: string, agentId: string) => Promise<void>,
  taskId: string,
  squadId: string,
  agentId: string,
): Promise<void> {
  try {
    await dispatch(taskId, squadId, agentId)
  } catch {
    // best-effort; the task is created; the dispatch is a wake signal
  }
}
