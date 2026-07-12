// mupot — durable task pipeline core (issue #7).
//
// This module is the PURE, testable orchestration layer.  It deliberately does
// NOT import 'cloudflare:workers' so Vitest can run it without a CF runtime.
// The thin CF adapter (task-workflow.ts) is the only file that touches the CF
// Workflows runtime; everything it does is delegated here.
//
// Design contract:
//   - D1 is the authoritative source of task status and verdict AT ALL TIMES.
//     The event payload delivered by step.waitForEvent is treated as a wake
//     signal only — readLatestVerdict re-reads D1 after every resume AND after
//     a timeout.  A dropped event (sendEvent before waitForEvent, CF-level loss)
//     cannot cause a silent wrong verdict because we never trust the payload.
//   - The pipeline is ADDITIVE and OPT-IN. It delegates task authorization and
//     current capability rechecks to the shared runTaskExecution engine used by
//     AgentDO. Starting a pipeline is a
//     separate POST /api/tasks/:id/pipeline call; tasks without
//     workflow_instance_id run exactly as before.
//   - The pipeline NEVER flips task status or writes verdict receipts.  The
//     authoritative gate (POST /api/tasks/:id/verdict) is the only status-flip
//     path.  workflow_receipts are observability: they record what the pipeline
//     SAW (execute outcome, whether it waited, what verdict D1 held on resume).

import type { Env, Agent, Task } from '../types'
import { runTaskExecution } from '../agents/execute'
import type { ExecuteResult } from '../agents/execute'
import { runApprovedActs } from '../integrations/ghl'
import type { ActRunResult, GHLDeps } from '../integrations/ghl'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Params carried in the Workflow event payload (JSON-serialisable). */
export interface TaskPipelineParams {
  taskId: string
  squadId: string
  agentId: string
}

/**
 * Minimal step seam the pipeline uses.  WorkflowStep (from cloudflare:workers)
 * satisfies this interface; tests provide a hand-mock.
 *
 * Why a local interface instead of importing WorkflowStep?
 *   WorkflowStep lives in 'cloudflare:workers', which is unavailable in the
 *   Vitest environment.  Defining StepLike here breaks the import cycle and
 *   keeps pipeline.ts fully unit-testable.
 */
export interface StepConfig {
  retries?: {
    limit: number
    delay: number | string
    backoff?: 'linear' | 'constant' | 'exponential'
  }
  timeout?: string
}

export interface StepLike {
  do<T>(name: string, cb: () => Promise<T>): Promise<T>
  do<T>(name: string, config: StepConfig, cb: () => Promise<T>): Promise<T>
  waitForEvent<T>(name: string, opts: { type: string; timeout?: string }): Promise<{ payload: T }>
}

/** The verdict row shape we need from D1. */
export interface VerdictRow {
  verdict: string
}

/** Summary returned by runTaskPipeline. */
export interface PipelineSummary {
  taskId: string
  finalStatus: string | null
  gated: boolean
  resolved: boolean
  /** Outbound acts result — set when approved verdict triggered the GHL send step. */
  actsResult?: ActRunResult
}

// ── Injectable deps (seams for unit tests) ────────────────────────────────────

export interface PipelineDeps {
  /** Override the execute fn — defaults to the real runTaskExecution. */
  runTaskExecution?: (env: Env, agent: Agent, taskId: string) => Promise<ExecuteResult>
  /** Override the agent loader — defaults to a D1 SELECT. */
  loadAgent?: (env: Env, agentId: string) => Promise<Agent | null>
  /** Override D1 verdict read — defaults to readLatestVerdictFromD1. */
  readLatestVerdict?: (env: Env, taskId: string) => Promise<VerdictRow | null>
  /** Override receipt writer — defaults to writeReceiptToD1. */
  writeReceipt?: (
    env: Env,
    row: {
      instanceId: string
      taskId: string
      stepName: string
      status: string
      detail?: string
    },
  ) => Promise<void>
  /** Injectable GHL deps for the outbound-acts step (seam for tests). */
  ghlDeps?: GHLDeps
  /** Override the pending-acts COUNT check (returns count of pending acts). */
  countPendingActs?: (env: Env, taskId: string) => Promise<number>
}

// ── Real default implementations ──────────────────────────────────────────────

async function countPendingActsFromD1(env: Env, taskId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM outbound_acts WHERE task_id = ? AND status = 'pending'`,
  )
    .bind(taskId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

async function loadAgentFromD1(env: Env, agentId: string): Promise<Agent | null> {
  const row = await env.DB.prepare(
    `SELECT id, squad_id, slug, name, role, model, status,
            okr, kpi_target, kpi_progress, effort, autonomy,
            budget_cap_cents, budget_window, created_at
       FROM agents WHERE id = ? LIMIT 1`,
  )
    .bind(agentId)
    .first<Agent>()
  return row ?? null
}

/**
 * Read the most-recently-written verdict for a task from D1 (task_verdicts).
 * Returns null when no verdict exists yet.
 *
 * This is the authoritative read the pipeline uses after waitForEvent resumes
 * or times out.  The event payload is NEVER the source of truth.
 */
export async function readLatestVerdictFromD1(
  env: Env,
  taskId: string,
): Promise<VerdictRow | null> {
  const row = await env.DB.prepare(
    `SELECT verdict FROM task_verdicts WHERE task_id = ? ORDER BY decided_at DESC LIMIT 1`,
  )
    .bind(taskId)
    .first<{ verdict: string }>()
  return row ?? null
}

/**
 * Append a receipt row.  INSERT OR IGNORE makes this idempotent on Workflow
 * replay: if the step whose callback called writeReceipt is replayed, the
 * second INSERT hits the UNIQUE(instance_id, step_name) constraint and is a
 * no-op.  This is intentional — "completed step is not re-run" in CF Workflows
 * means the DB write will not happen again anyway, but if the outer step.do
 * ever re-runs (e.g. the step callback threw before completion), the second
 * receipt write is safe.
 */
export async function writeReceiptToD1(
  env: Env,
  row: {
    instanceId: string
    taskId: string
    stepName: string
    status: string
    detail?: string
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_receipts
       (id, instance_id, task_id, step_name, status, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      row.instanceId,
      row.taskId,
      row.stepName,
      row.status,
      row.detail ?? null,
      new Date().toISOString(),
    )
    .run()
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

/**
 * runTaskPipeline — durable task execution with optional gate pause.
 *
 * a. step.do('execute'): calls runTaskExecution, writes receipt with outcome.
 *    The receipt write is INSIDE the step.do callback so it is durable and not
 *    duplicated on replay (CF Workflows caches completed step results).
 *
 * b. If the task has gate_owner set AND execution landed status='review':
 *    - write 'await-gate' / 'waiting' receipt.
 *    - step.waitForEvent('await-gate', { type: 'gate-verdict', timeout: '7 days' })
 *      — pauses the instance at zero cost until a verdict resumes it, OR times out.
 *    - REGARDLESS of the event payload (which may be dropped or stale):
 *      re-read the verdict from D1 (readLatestVerdict).  D1 is truth.
 *    - write 'gate-resolved' or 'gate-timeout' receipt.
 *    - Pipeline NEVER flips task status — the verdict endpoint already did.
 *
 * c. Return a summary for observability.
 *
 * @param env         - Tenant Cloudflare Env (DB binding used for reads/writes)
 * @param params      - Pipeline params from the Workflow event
 * @param step        - Step handle (real WorkflowStep or a test mock)
 * @param instanceId  - CF Workflow instance id (stamped on receipts)
 * @param deps        - Injectable seams for unit tests
 */
export async function runTaskPipeline(
  env: Env,
  params: TaskPipelineParams,
  step: StepLike,
  instanceId: string,
  deps: PipelineDeps = {},
): Promise<PipelineSummary> {
  const { taskId, agentId } = params

  // Resolve injectable defaults.
  const doLoadAgent = deps.loadAgent ?? loadAgentFromD1
  const doExecute = deps.runTaskExecution ?? runTaskExecution
  const doReadVerdict = deps.readLatestVerdict ?? readLatestVerdictFromD1
  const doWriteReceipt = deps.writeReceipt ?? writeReceiptToD1
  const doCountPendingActs = deps.countPendingActs ?? countPendingActsFromD1

  // ── Step a: execute the task ──────────────────────────────────────────────
  //
  // The receipt write is inside the step.do callback, so it participates in CF
  // Workflows' replay-cache: if the step has already completed (status='ok'),
  // its callback will NOT be re-invoked and the receipt will not be double-written.
  const executeResult = await (step.do as (
    name: string,
    config: StepConfig,
    cb: () => Promise<ExecuteResult>,
  ) => Promise<ExecuteResult>)('execute', {
    retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
  }, async () => {
    const agent = await doLoadAgent(env, agentId)
    if (!agent) {
      // Write a receipt so the pipeline state is visible even on failure.
      await doWriteReceipt(env, {
        instanceId,
        taskId,
        stepName: 'execute',
        status: 'agent_not_found',
      })
      // Return a synthetic ExecuteResult — the task row is untouched (the
      // execute engine sets its own status; we just record we couldn't load).
      return {
        ok: false,
        task_id: taskId,
        decided: 'agent_not_found',
        task_status: undefined,
        error: 'agent_not_found',
      } satisfies ExecuteResult
    }

    const result = await doExecute(env, agent, taskId)
    await doWriteReceipt(env, {
      instanceId,
      taskId,
      stepName: 'execute',
      status: 'ok',
      detail: JSON.stringify({ task_status: result.task_status, ok: result.ok }),
    })
    return result
  })

  const taskStatus = executeResult.task_status ?? null
  const gated = taskStatus === 'review'

  // ── Step b: wait for gate verdict (gated path only) ───────────────────────
  let resolved = false

  if (gated) {
    // Write 'await-gate' receipt BEFORE pausing — this is outside a step.do so
    // it is a best-effort DB write, not cached by the Workflow runtime.  If the
    // Worker crashes here, the instance will re-enter this block after resume
    // and write a duplicate — INSERT OR IGNORE handles that.
    await doWriteReceipt(env, {
      instanceId,
      taskId,
      stepName: 'await-gate',
      status: 'waiting',
    })

    // Pause until the verdict endpoint calls sendEvent, or 7 days elapse.
    // CF Workflows: waitForEvent THROWS on timeout (not returns null).
    // We intentionally IGNORE the returned event payload: a sendEvent to an
    // instance not currently parked on a matching waitForEvent is silently
    // dropped by CF.  D1 is always re-read as the authoritative verdict source.
    try {
      await step.waitForEvent<{ verdict: string }>('await-gate', {
        type: 'gate-verdict',
        timeout: '7 days',
      })
      // Payload intentionally unused — see design note above.
    } catch {
      // Timeout or other error: fall through and consult D1.
    }

    // Re-read verdict from D1 regardless of what the event payload contained.
    const verdictRow = await doReadVerdict(env, taskId)

    if (verdictRow !== null) {
      resolved = true
      await doWriteReceipt(env, {
        instanceId,
        taskId,
        stepName: 'gate-resolved',
        status: 'gate-resolved',
        detail: JSON.stringify({ verdict: verdictRow.verdict }),
      })
    } else {
      // No verdict in D1 yet — either it genuinely timed out or the row is not
      // visible yet (unlikely on D1 but defensive).  Pipeline does NOT flip
      // status; a human or the verdict endpoint must still act.
      //
      // DISTINCT step name from 'gate-resolved' (adversarial gate, #7 P1): the
      // receipt table is UNIQUE(instance_id, step_name) with INSERT OR IGNORE. If
      // both outcomes shared 'gate-resolved', a timeout receipt written first
      // would silently suppress a later real 'gate-resolved' row and the log
      // would permanently disagree with the authoritative verdict in D1. Separate
      // names let both rows coexist — the receipt log can never lie about a verdict.
      await doWriteReceipt(env, {
        instanceId,
        taskId,
        stepName: 'gate-timeout',
        status: 'gate-timeout',
      })
    }
  }

  // ── Step c: outbound acts (approved gate only) ────────────────────────────
  //
  // Fires ONLY when:
  //   - The gate resolved with an approved verdict (verdictRow.verdict === 'approved')
  //   - There are pending outbound acts (cheap COUNT — avoids a step when 0 acts)
  //
  // runApprovedActs re-checks the verdict independently (defense in depth).
  // Rejected verdicts, timeouts, and ungated tasks never reach this block.
  let actsResult: ActRunResult | undefined

  if (gated && resolved) {
    // Safe: 'resolved' is only true when verdictRow !== null (see above).
    // Read verdictRow again to get the verdict value; we re-read D1 here because
    // the variable is out of scope — the step.do below re-reads via runApprovedActs.
    // The pipeline ONLY enters this branch if gated+resolved, and runApprovedActs
    // does its own independent D1 re-read — so no assumption about the local variable.
    const pendingCount = await doCountPendingActs(env, taskId)

    if (pendingCount > 0) {
      // step.do wraps the GHL send in a durable step so Workflow replay does not
      // re-fire sends that already succeeded (CF Workflows caches completed step
      // results). A retry is also safe at the act level: runApprovedActs claims
      // each act pending→sending atomically BEFORE the external call, so a retried
      // step never re-sends an already-claimed/sent act (#8 P1 fix).
      actsResult = await (step.do as (
        name: string,
        config: StepConfig,
        cb: () => Promise<ActRunResult>,
      ) => Promise<ActRunResult>)('outbound-acts', {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
      }, async () => {
        // runApprovedActs independently re-reads the verdict and GHL config.
        // On rejected verdict: marks acts refused. On missing config: no-op (pending).
        const result = await runApprovedActs(env, taskId, deps.ghlDeps ?? {})

        await doWriteReceipt(env, {
          instanceId,
          taskId,
          stepName: 'outbound-acts',
          status: 'ok',
          detail: JSON.stringify({ sent: result.sent, refused: result.refused, failed: result.failed }),
        })

        return result
      })
    }
  }

  return {
    taskId,
    finalStatus: taskStatus,
    gated,
    resolved,
    ...(actsResult !== undefined ? { actsResult } : {}),
  }
}

// ── startTaskPipeline ─────────────────────────────────────────────────────────

/**
 * Create a CF Workflow instance for a task and persist the instance id.
 *
 * Guards:
 *   - Task must exist and belong to the expected squad.
 *   - workflow_instance_id must be null (not already started).
 *   - Task must be in a runnable status (open | in_progress | blocked | rejected).
 *
 * Returns { instanceId } so the caller can return it in the HTTP response.
 *
 * The TASK_WORKFLOW binding is on env; because `Workflow` is an abstract class
 * (not a plain interface) in @cloudflare/workers-types it cannot be used as a
 * direct type annotation in the Env interface without importing from the global
 * scope.  We cast env to the extended type inline with a minimal shape so the
 * production path type-checks while tests can pass a plain mock object.
 */
export async function startTaskPipeline(
  env: Env,
  taskId: string,
  squadId: string,
): Promise<{ instanceId: string }> {
  const task = await env.DB.prepare(
    `SELECT id, squad_id, status, assignee_agent_id, workflow_instance_id, execution_receipt_id
       FROM tasks WHERE id = ? AND squad_id = ? LIMIT 1`,
  )
    .bind(taskId, squadId)
    .first<Pick<Task, 'id' | 'squad_id' | 'status' | 'assignee_agent_id' | 'execution_receipt_id'> & { workflow_instance_id: string | null }>()

  if (!task) {
    throw Object.assign(new Error('task_not_found'), { code: 'task_not_found' as const })
  }

  if (task.workflow_instance_id !== null) {
    throw Object.assign(new Error('pipeline_already_started'), {
      code: 'pipeline_already_started' as const,
      instanceId: task.workflow_instance_id,
    })
  }

  const RUNNABLE: ReadonlySet<Task['status']> = new Set(['open', 'in_progress', 'blocked', 'rejected'])
  if (!RUNNABLE.has(task.status) || (task.status === 'in_progress' && task.execution_receipt_id)) {
    throw Object.assign(new Error('task_not_runnable'), {
      code: 'task_not_runnable' as const,
      status: task.status,
    })
  }

  const agentId = task.assignee_agent_id
  if (!agentId) {
    throw Object.assign(new Error('task_has_no_assignee'), {
      code: 'task_has_no_assignee' as const,
    })
  }

  // Create the Workflow instance.  The TASK_WORKFLOW binding satisfies the
  // abstract Workflow<TaskPipelineParams> shape; we access it through the
  // WorkflowEnv extension below so TypeScript validates the call.
  const wfEnv = env as Env & { TASK_WORKFLOW: { create(opts: { params: TaskPipelineParams }): Promise<{ id: string }> } }
  const instance = await wfEnv.TASK_WORKFLOW.create({
    params: { taskId: task.id, squadId: task.squad_id, agentId },
  })

  // Persist the instance id so the verdict endpoint can resume the waiting instance.
  await env.DB.prepare(
    `UPDATE tasks SET workflow_instance_id = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(instance.id, new Date().toISOString(), task.id)
    .run()

  return { instanceId: instance.id }
}
