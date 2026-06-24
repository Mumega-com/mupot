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
import { buildSensorium, renderSensorium } from './sensorium'
import type { AgentRuntime, Sensorium } from './sensorium'
import { computeDecisionFp, reserveDecision } from './dedup'
import type { FpProposal } from './dedup'
import { observe } from './observer'
import type { ObserverOutcome, ObserveResult } from './observer'
import { safeRecordEpisode, safeRecentEpisodes, renderEpisodes } from './episodic'
import type { EpisodeInput, Episode } from './episodic'

// ── Effort → max tasks spawned per tick ──────────────────────────────────────

export const EFFORT_TASK_BUDGET: Record<Effort, number> = {
  low: 0,       // observe-only: progress update but no new task spawn
  standard: 1,
  high: 2,
  sprint: 3,
}

// ── S3: open-task backpressure cap ────────────────────────────────────────────
//
// When an agent already has this many open tasks assigned, skip the model call
// and the spawn entirely. This prevents unbounded pile-up: if the agent is not
// executing tasks (or they are not being completed), spawning more creates noise
// without progress. 10 is conservative — a sprint agent tops out at 3/tick, so
// this represents ~3-4 ticks of backlog before the brake engages. Adjust via
// agent config if needed in the future.
export const MAX_OPEN_TASKS = 10

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
  | 'deduped'          // same fingerprint already reserved — idempotent rest, no spawn
  | 'backpressure'     // open-task queue full — model call skipped until tasks drain

export interface GoalCycleResult {
  ok: boolean
  decided: GoalCycleDecided
  spawned: number        // tasks created this tick
  autonomy: Autonomy | null
  effort: Effort | null
  error?: string
  // S2: observer signals — AgentDO reads these to extend the alarm (cooldown)
  // and emit a single operator escalation. Absent when observer is not wired or skipped.
  observer?: ObserveResult
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
  // S3: memory write — called after a productive ('spawned') cycle to write a
  // bounded outcome engram. Injectable so tests never touch Vectorize.
  // Defaults to createMemory(env).remember in production.
  remember?: (agentId: string, text: string) => Promise<string>
  // createTask seam: injectable so tests verify disposition without D1.
  createTask?: typeof createTask
  // dispatch seam: called after createTask when autonomy ∈ {execute, execute_with_approval}.
  // In production this posts to the bus or wakes the agent DO stub. Tests stub it.
  dispatch?: (taskId: string, squadId: string, agentId: string) => Promise<void>
  // kpi_progress write seam: injectable so tests can verify the SQL without D1.
  writeProgress?: (env: Env, agentId: string, progress: number) => Promise<void>
  // Sensorium seam: builds the self-state block injected at the top of each
  // goal-cycle prompt. Injectable so tests can mock without D1 or a clock.
  // When omitted, the real buildSensorium is used (default prod path).
  buildSensorium?: typeof buildSensorium
  // Runtime state from AgentDO (cycles, last_woke_at, etc.) — passed through
  // to buildSensorium so it can populate the clock block. AgentDO sets this;
  // tests inject a fixed AgentRuntime.
  sensoriumRuntime?: AgentRuntime | null
  // S2: dedup seam — injectable so tests run without D1. Default: real computeDecisionFp.
  computeDecisionFp?: typeof computeDecisionFp
  // S2: reserve seam — injectable so tests run without D1. Default: real reserveDecision.
  reserveDecision?: typeof reserveDecision
  // S2: observer seam — injectable so tests run without D1. Default: real observe.
  observe?: typeof observe
  // S4a: episodic memory seams — injectable so tests run without D1.
  // recordEpisode: write a new episode row (best-effort; default: safeRecordEpisode).
  // recentEpisodes: fetch recent episodes for prompt injection (best-effort; default: safeRecentEpisodes).
  recordEpisode?: (env: Env, agent: Agent, ep: EpisodeInput, now?: string) => Promise<void>
  recentEpisodes?: (env: Env, agent: Agent, limit?: number) => Promise<Episode[]>
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

  // ── S2: resolve injectable seams for dedup + observer (needed in all paths below) ──
  const doComputeFp = deps.computeDecisionFp ?? computeDecisionFp
  const doReserve = deps.reserveDecision ?? reserveDecision
  const doObserve = deps.observe ?? observe

  // ── S1/S2: build the sensorium EARLY (before meter check) ────────────────────
  //
  // The sensorium is deterministic + LLM-free (no model calls, no Vectorize).
  // Building it here once serves two downstream consumers without a double query:
  //   1. Decision fingerprint (S2) — uses the raw Sensorium object
  //   2. Prompt injection (S1) — renders the sensorium block for the model call
  // (The S3 backpressure guard uses its OWN count — see below — because the
  //  sensorium's open count is assignee-only and misses suggest/draft backlog.)
  //
  // Failures are soft: safeSensoriumObj returns null on any DB hiccup, and each
  // downstream consumer degrades gracefully (fp omitted, prompt omits block).
  const doSensorium = deps.buildSensorium ?? buildSensorium
  const sensoriumObj = await safeSensoriumObj(doSensorium, env, agent, deps.sensoriumRuntime)

  // ── S4a: fetch recent episodes EARLY (alongside sensorium, before meter check) ─
  //
  // Episodes are cheap: a single D1 SELECT (no Vectorize, no AI). They are fetched
  // here so the agent re-enters with its RECENT TRAJECTORY before the model call.
  // A DB hiccup returns [] — the cycle degrades to "no recent history" gracefully.
  // Injectable seam (deps.recentEpisodes) keeps tests off D1.
  // Wrapped in safeFetchEpisodes so a throwing seam (or real DB hiccup) never aborts.
  const doRecentEpisodes = deps.recentEpisodes ?? safeRecentEpisodes
  const episodes = await safeFetchEpisodes(doRecentEpisodes, env, agent)

  // ── S3: Guard 5 — backpressure (open-task queue full) ────────────────────────
  //
  // Count the agent's OWN open backlog: tasks it must answer for. That is BOTH
  // self-assigned tasks (execute / execute_with_approval) AND the unassigned
  // tasks its loop created in its own squad (suggest / draft leave assignee NULL).
  // The sensorium's schedule.counts.open is assignee-only, so it MISSES the
  // suggest/draft backlog — we count it directly here (migration-free; the tasks
  // table has no creator column, so squad-scoped unassigned is the proxy).
  //
  // At/above MAX_OPEN_TASKS → skip the model call + spawn; the queue must drain.
  // observe() still runs so persistent backpressure accrues consecutive_noops →
  // cooldown. Independent of the sensorium (fires even if that read failed).
  const openBacklog = await safeCountOpenBacklog(env, agent)
  if (openBacklog >= MAX_OPEN_TASKS) {
    const observerResult = await safeObserve(doObserve, env, agent, 'backpressure')
    // S4a: record 'backpressure' episode — queue-full is a real operational signal.
    const doRecord = deps.recordEpisode ?? safeRecordEpisode
    await safeDoRecord(doRecord, env, agent, {
      cycle: deps.sensoriumRuntime?.cycles ?? null,
      kind: 'backpressure',
      summary: `Backpressure: ${openBacklog} open tasks (cap=${MAX_OPEN_TASKS}). Spawn skipped until queue drains.`,
      kpiProgress: agent.kpi_progress,
    })
    return {
      ok: true,
      decided: 'backpressure',
      spawned: 0,
      autonomy,
      effort,
      observer: observerResult ?? undefined,
    }
  }

  // ── Guard 6: meter check (economic governor) ─────────────────────────────────
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
    // S2: observe the meter-block as a noop (not a failure — it is a governed state).
    const observerResult = await safeObserve(doObserve, env, agent, decided as ObserverOutcome)
    return {
      ok: false,
      decided,
      spawned: 0,
      autonomy,
      effort,
      error: meterResult.reason,
      observer: observerResult ?? undefined,
    }
  }

  // ── Observe-only: effort=low just tracks progress, skips model call ───────────
  if (taskBudget === 0) {
    // Still update kpi_progress on each observe tick so the dashboard stays fresh.
    const writeProgress = deps.writeProgress ?? defaultWriteProgress
    await safeWriteProgress(writeProgress, env, agent)
    // S2: observe noop tick (best-effort — never abort on observer failure).
    const observerResult = await safeObserve(doObserve, env, agent, 'observe-only')
    return { ok: true, decided: 'observe-only', spawned: 0, autonomy, effort, observer: observerResult ?? undefined }
  }

  // ── Model call: generate next step proposals toward the KPI ─────────────────
  try {
    const model = deps.model ?? createModel(env)
    const recall = deps.recall ?? ((id, q, lim) => createMemory(env).recall(id, q, lim))

    const hits = await safeRecall(recall, agent.id, agent.okr, 5)
    const recentContext = hits.map((h) => `- ${h.text}`).join('\n')

    // Render the sensorium block for prompt injection from the already-built object.
    // sensoriumObj was built early (before meter check) — reuse it here; do not rebuild.
    const sensoriumBlock = sensoriumObj ? renderSensorium(sensoriumObj) : null

    // S4a: render recent episodes for prompt injection. The agent reads its own
    // recent trajectory before proposing — cross-run continuity without a model call.
    // episodes was fetched early (before meter check); render here for injection.
    const episodeBlock = renderEpisodes(episodes)

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
        content: buildGoalPrompt(agent, taskBudget, recentContext, sensoriumBlock, episodeBlock),
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

    // ── S2: Dedup gate — BEFORE any spawn or dispatch ─────────────────────────
    // Fingerprint the (sensorium + proposals) pair. If already reserved this tick,
    // return 'deduped' immediately — idempotent rest, no tasks created.
    if (sensoriumObj) {
      const fpProposals: FpProposal[] = proposals.map((p) => ({ title: p.title }))
      const fp = await doComputeFp(agent, sensoriumObj, fpProposals)
      const { reserved } = await doReserve(env, env.TENANT_SLUG, agent.id, fp)
      if (!reserved) {
        // Already seen this exact (state + proposals) pair — idempotent rest.
        const observerResult = await safeObserve(doObserve, env, agent, 'deduped')
        return {
          ok: true,
          decided: 'deduped',
          spawned: 0,
          autonomy,
          effort,
          observer: observerResult ?? undefined,
        }
      }
    }

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

    // ── Empty-proposal no-op: the model ran but proposed nothing (spawned===0).
    // This is NOT productive — do NOT write memory (no-op memory = noise, the
    // mumega-brain lesson) and do NOT reset the observer's productivity counters.
    // Treat it as observe-only so persistent empty ticks accrue toward cooldown.
    if (spawned === 0) {
      const observerResult = await safeObserve(doObserve, env, agent, 'observe-only')
      return { ok: true, decided: 'observe-only', spawned: 0, autonomy, effort, observer: observerResult ?? undefined }
    }

    // ── S3: goal-path memory write — PRODUCTIVE ticks only (spawned > 0) ──────
    // Write a bounded outcome engram so future recalls carry episodic context.
    // Skipped on no-op/dedup/backpressure/empty-proposal ticks (noise).
    // Injectable seam keeps tests off Vectorize. Best-effort: never abort the cycle.
    const doRemember = deps.remember ?? ((id, text) => createMemory(env).remember(id, text))
    await safeRemember(doRemember, agent.id, buildOutcomeSummary(agent, proposals, spawned))

    // ── S4a: record episode for 'spawned' — always (productive cycle) ─────────
    // Injectable seam (deps.recordEpisode) keeps tests off D1. Wrapped in
    // safeDoRecord so a throwing seam never aborts the cycle.
    const doRecord = deps.recordEpisode ?? safeRecordEpisode
    await safeDoRecord(doRecord, env, agent, {
      cycle: deps.sensoriumRuntime?.cycles ?? null,
      kind: 'spawned',
      summary: buildOutcomeSummary(agent, proposals, spawned),
      kpiProgress: agent.kpi_progress,
    })

    // ── S2: observer — productive tick resets counters ────────────────────────
    const observerResult = await safeObserve(doObserve, env, agent, 'spawned')

    // S4a: record 'escalated' episode when observer fires an escalation.
    // This is distinct from 'spawned' — it means the operator was notified.
    if (observerResult?.escalate) {
      await safeDoRecord(doRecord, env, agent, {
        cycle: deps.sensoriumRuntime?.cycles ?? null,
        kind: 'escalated',
        summary: `Observer escalation fired after 'spawned' outcome. Operator attention requested.`,
        kpiProgress: agent.kpi_progress,
      })
    }

    const decided: GoalCycleDecided = 'spawned'
    return { ok: true, decided, spawned, autonomy, effort, observer: observerResult ?? undefined }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'goal_cycle_failed'
    // S2: observer — record the error (best-effort).
    const observerResult = await safeObserve(doObserve, env, agent, 'error')
    return { ok: false, decided: 'spawned', spawned: 0, autonomy, effort, error: msg, observer: observerResult ?? undefined }
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

function buildGoalPrompt(
  agent: Agent,
  taskBudget: number,
  recentContext: string,
  sensoriumBlock?: string | null,
  episodeBlock?: string | null,
): string {
  const lines: string[] = []

  // Sensorium block at the top — the agent reads its self-state first.
  // This is the keystone of S1: the model sees its situation before proposing.
  if (sensoriumBlock) {
    lines.push(sensoriumBlock)
    lines.push('')
  }

  // S4a: Episode block — the agent reads its recent trajectory after the sensorium.
  // "What did I do in the last N cycles?" — cross-run continuity without a model call.
  if (episodeBlock) {
    lines.push(episodeBlock)
    lines.push('')
  }

  lines.push(
    `Agent: ${agent.name} (role: ${agent.role})`,
    `OKR: ${agent.okr}`,
    `KPI target: ${agent.kpi_target ?? '(not set)'}`,
    `KPI progress: ${agent.kpi_progress}%`,
    `Task budget this tick: ${taskBudget}`,
  )
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

/**
 * Safe sensorium (object form): build the raw Sensorium, swallow any error.
 * Returns the object so callers can use both the raw data (for fp) and render
 * the prompt block. Returns null on failure — the cycle degrades gracefully.
 *
 * S2: replaces the old safeSensorium string-only helper. The rendered string is
 * derived from the object at the call site via renderSensorium(sensoriumObj).
 */
async function safeSensoriumObj(
  build: typeof buildSensorium,
  env: Env,
  agent: Agent,
  runtime?: AgentRuntime | null,
): Promise<Sensorium | null> {
  try {
    return await build(env, agent, runtime)
  } catch {
    return null
  }
}

/**
 * Safe observer: call observe() and swallow any error.
 * The observer is instrumentation — it must never abort the cycle.
 * Returns null on failure (caller omits the observer field from the result).
 */
async function safeObserve(
  doObserve: typeof observe,
  env: Env,
  agent: Agent,
  outcome: ObserverOutcome,
): Promise<ObserveResult | null> {
  try {
    return await doObserve(env, agent, outcome)
  } catch {
    return null
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

/**
 * countOpenBacklog — the agent's OWN open backlog for backpressure.
 *
 * Counts open tasks the agent is responsible for: self-assigned (execute paths)
 * OR unassigned tasks in its own squad (suggest/draft leave assignee NULL). The
 * tasks table has no creator column, so squad-scoped unassigned is the proxy for
 * "tasks this agent's loop produced and left for pickup". Counts status='open'
 * only (open = not yet started backlog; in_progress = being worked, not pile-up).
 */
async function countOpenBacklog(env: Env, agent: Agent): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM tasks
       WHERE status = 'open'
         AND (assignee_agent_id = ? OR (assignee_agent_id IS NULL AND squad_id = ?))`,
  )
    .bind(agent.id, agent.squad_id)
    .first<{ cnt: number }>()
  return row?.cnt ?? 0
}

/** Safe wrapper: a DB hiccup fails OPEN (returns 0 → guard does not fire, loop proceeds). */
async function safeCountOpenBacklog(env: Env, agent: Agent): Promise<number> {
  try {
    return await countOpenBacklog(env, agent)
  } catch {
    return 0
  }
}

/**
 * safeRemember — write a memory engram best-effort.
 * A failed write must never abort the cycle — memory is enrichment, not a gate.
 */
async function safeRemember(
  remember: (agentId: string, text: string) => Promise<string>,
  agentId: string,
  text: string,
): Promise<void> {
  try {
    await remember(agentId, text)
  } catch {
    // best-effort; a Vectorize or D1 hiccup must not abort the goal cycle
  }
}

/**
 * buildOutcomeSummary — compact, bounded engram text for a productive cycle.
 *
 * Kept deterministically ordered and length-bounded so the vector index never
 * receives runaway-length embeddings. Format is human-readable to aid recall UX.
 */
function buildOutcomeSummary(agent: Agent, proposals: { title: string }[], spawned: number): string {
  const titles = proposals
    .slice(0, spawned)
    .map((p) => p.title.slice(0, 120))
    .join('; ')
  // Bounded: cycle summary never exceeds ~300 chars so the embedding model sees
  // a focused signal (large engrams dilute the semantic centroid).
  return `Goal cycle: spawned ${spawned} task(s) toward "${(agent.okr ?? '').slice(0, 80)}". Tasks: ${titles}. KPI: ${agent.kpi_progress}%`.slice(0, 300)
}

// ── S4a: episodic safe helpers ─────────────────────────────────────────────────

/**
 * safeFetchEpisodes — fetch recent episodes, degrading to [] on any error.
 *
 * Wraps the injectable seam so a throwing seam (or real DB hiccup) never aborts
 * the goal cycle. The cycle proceeds with an empty episode list.
 */
async function safeFetchEpisodes(
  fetch: typeof safeRecentEpisodes,
  env: Env,
  agent: Agent,
): Promise<Episode[]> {
  try {
    return await fetch(env, agent)
  } catch {
    // best-effort; episode fetch is enrichment, not a gate
    return []
  }
}

/**
 * safeDoRecord — record an episode best-effort.
 *
 * Wraps the injectable seam so a throwing seam (or real DB hiccup) never aborts
 * the goal cycle.
 */
async function safeDoRecord(
  record: (env: Env, agent: Agent, ep: EpisodeInput, now?: string) => Promise<void>,
  env: Env,
  agent: Agent,
  ep: EpisodeInput,
): Promise<void> {
  try {
    await record(env, agent, ep)
  } catch {
    // best-effort; episode write must never abort the cycle
  }
}
