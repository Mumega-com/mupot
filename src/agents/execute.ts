// mupot — task execution core. The last mile: an agent DOES a task.
//
// This is the pure, DO-independent orchestration so it is unit-testable in the
// same style as the rest of the codebase (a hand-mocked Env, an injected model).
// AgentDO.executeTask delegates here; the DO only owns its private runtime state
// (cycle counter / last decision), not the execution itself.
//
// Contract (spec §2):
//  - load the task by ID from this tenant DB, then authorize execution before any
//    mutation. Assigned tasks must still resolve to this active agent with current
//    target-squad authority; unassigned tasks remain home-squad-only;
//  - idempotent: a task already 'done' is left untouched (the bus may redeliver);
//  - K6: execute no-ops for gate-terminal statuses (approved, review) and
//    already-terminal statuses (done). Only {open, blocked, rejected}
//    proceed to execution. This prevents a re-wake from resurrecting an approved or
//    under-review task back to in_progress.
//  - mark in_progress + claim the assignee (if unset) BEFORE the model call;
//  - K1: SUCCESS on a gated task (gate_owner set) lands status='review', not 'done'.
//    The task waits for a human/agent verdict before completing. SUCCESS on an
//    ungated task lands status='done' as before.
//  - FAILURE → status=blocked, result=<short note>, completed_at=now, emit
//    task.blocked. The model call is wrapped so a throw can NEVER leave the task
//    stuck in_progress.
//  - Rate-limit (issue #4): checkAndReserve runs AFTER claiming the task but
//    BEFORE the model call. On block: task lands 'blocked' with a rate_limited
//    note; no tokens are spent.

import type { Env, Agent, Task, ModelMessage, ModelPort, BusEvent } from '../types'
import { checkTransition, assertCompletableDoneWhen } from '../tasks/service'
import { resolveTaskAssignee } from '../tasks/assignee'
import { createModel } from '../model'
import { createBus } from '../bus'
import { createMemory } from '../memory'
import { checkAndReserve, recordTokens } from './meter'
import { costMicroUsd } from './cost'
import { detectContentIntent } from './content-intent'
import type { ContentIntent } from './content-intent'
import { getRegistered, kernelMintCtx } from '../departments/registry'
import { CtxError } from '../departments/ctx'

// Hard ceiling on a persisted result (chars). Keeps a runaway model answer from
// bloating the row / GitHub mirror. ~16KB.
export const MAX_RESULT_CHARS = 16 * 1024
// Tokens the execute call may spend. Conservative cap; the org's provider/model
// choice still applies (createModel routes by org settings).
export const EXECUTE_MAX_TOKENS = 2048
// Long enough for a normal model cycle; bounded so a terminated AgentDO can be
// resumed by the same receipt instead of leaving the task in_progress forever.
export const EXECUTION_CLAIM_LEASE_MS = 15 * 60_000

export interface ExecuteResult {
  ok: boolean
  task_id: string
  decided: string
  task_status?: Task['status']
  error?: string
}

// Injectable seams so the orchestration can be unit-tested without a DO or a
// live model. Defaults wire the real model + bus.
export interface ExecuteDeps {
  // Durable ownership token for this execution attempt. Queue dispatch passes its
  // receipt ID; direct callers get a fresh ID so concurrent claims remain isolated.
  executionReceiptId?: string
  model?: ModelPort
  emit?: (event: BusEvent) => Promise<void>
  // Best-effort memory write on success so the agent's future recalls compound on
  // what it did. Injectable so tests don't reach Vectorize/Workers-AI.
  remember?: (agentId: string, text: string, concepts?: string[]) => Promise<unknown>
  // Meter seam: injectable so tests drive the meter independently of D1.
  // Defaults to the real meter (checkAndReserve + recordTokens from ./meter).
  meter?: {
    checkAndReserve: typeof checkAndReserve
    recordTokens: typeof recordTokens
  }
}

export async function runTaskExecution(
  env: Env,
  agent: Agent,
  taskId: string,
  deps: ExecuteDeps = {},
): Promise<ExecuteResult> {
  const model = deps.model ?? createModel(env)
  const emit = deps.emit ?? ((e: BusEvent) => createBus(env).emit(e))
  const remember =
    deps.remember ?? ((id: string, text: string, concepts?: string[]) => createMemory(env).remember(id, text, concepts))
  const meter = deps.meter ?? { checkAndReserve, recordTokens }
  const executionReceiptId = deps.executionReceiptId ?? crypto.randomUUID()

  // Load within this tenant DB, then fail closed on assignment and current
  // authority. The coarse response intentionally does not reveal which check failed.
  let task = await loadTaskById(env, taskId)
  if (!task || !(await canAgentExecuteTask(env, agent, task))) {
    return { ok: false, task_id: taskId, decided: `task ${taskId} not found`, error: 'task_not_found' }
  }

  // K6: execute only drives tasks in workable statuses. Gate-terminal statuses
  // (review, approved) and done are no-ops. A re-wake must NOT resurrect an
  // approved or under-review task back to in_progress.
  //
  // Workable: open | blocked | rejected
  // No-op:    in_progress | done | review | approved
  //
  // 'rejected' is workable — it means rework is authorised; the agent should
  // re-attempt the task. 'blocked' is workable — the caller may retry after
  // resolving the blocker.
  const WORKABLE: ReadonlySet<Task['status']> = new Set(['open', 'blocked', 'rejected'])
  const now = Date.now()
  const resumableInProgress = task.status === 'in_progress' && !task.execution_receipt_id
  if (!WORKABLE.has(task.status) && !resumableInProgress) {
    return { ok: true, task_id: taskId, decided: `no_op:${task.status}`, task_status: task.status }
  }

  // Claim + mark working before spending the model budget.
  const startedAt = new Date().toISOString()
  const executionClaimExpiresAt = now + EXECUTION_CLAIM_LEASE_MS
  const claimed = await claimTaskProgress(
    env, task, agent, startedAt, executionReceiptId, executionClaimExpiresAt,
  )
  if (!claimed) {
    return { ok: false, task_id: task.id, decided: '', error: 'task_claim_lost' }
  }
  const claimedTask = await loadTaskById(env, task.id)
  if (!claimedTask || !(await canAgentExecuteTask(env, agent, claimedTask))) {
    return { ok: false, task_id: task.id, decided: '', error: 'task_claim_lost' }
  }
  task = claimedTask

  // ── Content-intent short-circuit (flight-1: task → gated content-write) ──
  //
  // A task whose title matches the "publish:" convention (detectContentIntent,
  // ./content-intent.ts) is a content-write REQUEST, not a question — route it
  // to the department kernel's gate.propose() instead of spending a model call
  // on a freeform answer nobody reads. This runs BEFORE the meter reservation
  // below: no model.chat happens on this path, so no token budget is spent and
  // none should be reserved.
  const contentIntent = detectContentIntent(task)
  if (contentIntent) {
    return finishContentProposal(env, task, agent, executionReceiptId, contentIntent, emit)
  }

  // ── Rate-limit check (issue #4): enforce per-agent daily dispatch + token caps ──
  // Runs AFTER claiming the task (so status is never left as stale 'open') but
  // BEFORE the model call (so no tokens are spent when blocked).
  // On block: mark the task 'blocked' with a clear note so it is not stuck
  // in_progress and the caller knows why it did not execute.
  // This is the chokepoint: ALL execute paths converge on runTaskExecution
  // (HTTP POST dispatch, bus consumer, and DO alarm), so one check covers all.
  // Cost of one execute cycle (issue #15): the conservative token bound priced at
  // the agent's model rate, in micro-USD. Computed once; used as the pre-call
  // estimate for the dollar-cap gate (#4), stamped on the task row, and accumulated
  // in the meter on every path that actually calls the model.
  const cycleCostMicroUsd = costMicroUsd(agent.model, EXECUTE_MAX_TOKENS)

  const meterResult = await meter.checkAndReserve(env, agent.id, {
    estimateMicroUsd: cycleCostMicroUsd,
    budgetCapCents: agent.budget_cap_cents,
    budgetWindow: agent.budget_window,
  })
  if (!meterResult.ok) {
    const note = capResult(
      `rate_limited: ${meterResult.reason} — daily cap reached (window ${meterResult.windowKey}). ` +
      `Retry after ${meterResult.retryAfterSec}s (next UTC day resets the window).`,
    )
    const finishedAt = new Date().toISOString()
    if (!(await finishTask(env, task.id, agent.id, executionReceiptId, 'blocked', note, finishedAt))) {
      return { ok: false, task_id: task.id, decided: '', error: 'task_claim_lost' }
    }
    await emitSafe(emit, executionEvent('task.blocked', env, agent, task, 'blocked'))
    return {
      ok: false,
      task_id: task.id,
      decided: '',
      task_status: 'blocked',
      error: meterResult.reason,
    }
  }

  try {
    const charter = await loadSquadCharter(env, task.squad_id)
    const messages: ModelMessage[] = [
      { role: 'system', content: buildExecuteSystem(agent, charter) },
      { role: 'user', content: buildExecutePrompt(task) },
    ]
    const raw = await model.chat(messages, { model: agent.model, maxTokens: EXECUTE_MAX_TOKENS })
    const result = capResult(typeof raw === 'string' ? raw : '')
    const finishedAt = new Date().toISOString()

    // K1: if a gate_owner is set, execution success lands 'review' — the task
    // waits for a gated verdict before completing. Only an ungated task goes
    // directly to 'done'. The transition matrix allows in_progress → review and
    // in_progress → done, so both are legal here.
    const successStatus: 'done' | 'review' = task.gate_owner ? 'review' : 'done'
    // Enforce the transition at the service write layer (catches future misuse).
    const transitionErr = checkTransition('in_progress', successStatus)
    if (transitionErr) {
      // This branch should never fire given the matrix; log and fall through to blocked.
      throw new Error(`gate_transition_invariant_violated: in_progress → ${successStatus}`)
    }

    // Door 5 — completion gate: refuse DONE while done_when is a placeholder.
    // Ungated tasks (gate_owner absent) go directly to 'done'; gated tasks land
    // 'review' first, so the placeholder check only fires on the direct-done path.
    // A placeholder done_when means the predicate was never set — the agent cannot
    // verify completion against a sentinel. Block it here; surface as 'blocked' so
    // the task stays visible and the operator can update done_when + retry.
    if (successStatus === 'done') {
      try {
        assertCompletableDoneWhen(task.done_when)
      } catch (placeholderErr) {
        const note = capResult(
          `done_when_placeholder: cannot mark done — done_when is a placeholder sentinel ("${String(task.done_when).trim()}"). ` +
          'Update done_when to a real, checkable predicate before retrying.',
        )
        if (!(await finishTask(env, task.id, agent.id, executionReceiptId, 'blocked', note, finishedAt, cycleCostMicroUsd))) {
          return { ok: false, task_id: task.id, decided: '', error: 'task_claim_lost' }
        }
        await emitSafe(emit, executionEvent('task.blocked', env, agent, task, 'blocked'))
        return {
          ok: false,
          task_id: task.id,
          decided: 'done_when_placeholder',
          task_status: 'blocked',
          error: 'done_when_placeholder',
        }
      }
    }
    if (!(await finishTask(env, task.id, agent.id, executionReceiptId, successStatus, result, finishedAt, cycleCostMicroUsd))) {
      await recordTokensSafe(meter.recordTokens, env, agent.id, EXECUTE_MAX_TOKENS, cycleCostMicroUsd)
      return { ok: false, task_id: task.id, decided: '', error: 'task_claim_lost' }
    }
    // Emit task.completed for ungated (terminal); task.review for gated (awaiting verdict).
    const eventType = successStatus === 'done' ? 'task.completed' : 'task.review'
    await emitSafe(emit, executionEvent(eventType, env, agent, task, successStatus))
    // best-effort memory so the agent's future recalls compound on what it did.
    await rememberSafe(remember, agent.id, `Executed task "${task.title}" → ${successStatus}.`)
    // Best-effort token + cost accounting: record EXECUTE_MAX_TOKENS as a conservative
    // estimate, priced at the model rate (#15). When the model port surfaces actual
    // usage, replace EXECUTE_MAX_TOKENS with the real count (cost follows automatically).
    await recordTokensSafe(meter.recordTokens, env, agent.id, EXECUTE_MAX_TOKENS, cycleCostMicroUsd)
    return { ok: true, task_id: task.id, decided: `completed: ${task.title}`, task_status: successStatus }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'execution_failed'
    const note = capResult(`Execution failed: ${msg}`)
    const finishedAt = new Date().toISOString()
    // NEVER leave in_progress stuck — land it in blocked with the error note.
    if (!(await finishTask(env, task.id, agent.id, executionReceiptId, 'blocked', note, finishedAt, cycleCostMicroUsd))) {
      await recordTokensSafe(meter.recordTokens, env, agent.id, EXECUTE_MAX_TOKENS, cycleCostMicroUsd)
      return { ok: false, task_id: task.id, decided: '', error: 'task_claim_lost' }
    }
    await emitSafe(emit, executionEvent('task.blocked', env, agent, task, 'blocked'))
    // Still count tokens + cost on model failure: the call was attempted.
    await recordTokensSafe(meter.recordTokens, env, agent.id, EXECUTE_MAX_TOKENS, cycleCostMicroUsd)
    return { ok: false, task_id: task.id, decided: '', task_status: 'blocked', error: msg }
  }
}

// ── DB helpers (tenant DB is env.DB; execution policy is checked after load) ──

async function loadTaskById(env: Env, taskId: string): Promise<Task | null> {
  // K1: gate_owner is selected so execute knows whether to land 'review' or 'done'
  // on success. K6: status is used to no-op on gate-terminal statuses. done_when
  // is required by the completion gate before a direct-done write.
  const row = await env.DB.prepare(
    `SELECT id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, github_issue_url,
            result, completed_at, gate_owner, execution_receipt_id, execution_claim_expires_at,
            created_at, updated_at
       FROM tasks WHERE id = ? LIMIT 1`,
  )
    .bind(taskId)
    .first<Task>()
  return row ?? null
}

async function canAgentExecuteTask(env: Env, agent: Agent, task: Task): Promise<boolean> {
  if (task.assignee_agent_id === null) {
    return task.squad_id === agent.squad_id
  }
  if (task.assignee_agent_id !== agent.id) return false

  const assignee = await resolveTaskAssignee(env, agent.id, task.squad_id)
  return assignee.error === undefined && assignee.value === agent.id
}

async function loadSquadCharter(env: Env, squadId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT charter FROM squads WHERE id = ? LIMIT 1')
    .bind(squadId)
    .first<{ charter: string | null }>()
  return row?.charter ?? null
}

async function claimTaskProgress(
  env: Env,
  task: Task,
  agent: Agent,
  updatedAt: string,
  executionReceiptId: string,
  executionClaimExpiresAt: number,
): Promise<boolean> {
  const isResume = task.status === 'in_progress'
  const executionCondition = isResume ? ' AND execution_receipt_id IS NULL' : ''
  const result = task.assignee_agent_id === null
    ? await env.DB.prepare(
      `UPDATE tasks
          SET status = 'in_progress', assignee_agent_id = ?, updated_at = ?,
              execution_receipt_id = ?, execution_claim_expires_at = ?
        WHERE id = ? AND squad_id = ? AND status = ? AND assignee_agent_id IS NULL
          ${executionCondition}
          AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND status = 'active')`,
    ).bind(
      agent.id, updatedAt, executionReceiptId, executionClaimExpiresAt,
      task.id, agent.squad_id, task.status, agent.id,
    ).run()
    : await env.DB.prepare(
      `UPDATE tasks
          SET status = 'in_progress', updated_at = ?, execution_receipt_id = ?,
              execution_claim_expires_at = ?
        WHERE id = ? AND squad_id = ? AND status = ? AND assignee_agent_id = ?
          ${executionCondition}
          AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND status = 'active')`,
    ).bind(
      updatedAt, executionReceiptId, executionClaimExpiresAt,
      task.id, task.squad_id, task.status, agent.id, agent.id,
    ).run()
  return result.meta?.changes === 1
}

async function finishTask(
  env: Env,
  taskId: string,
  agentId: string,
  executionReceiptId: string,
  // K1: 'review' is a valid success-landing for gated tasks (awaits verdict).
  status: 'done' | 'blocked' | 'review',
  result: string,
  completedAt: string,
  // #15: cost of the cycle in micro-USD, stamped on the task for the per-task
  // cost chip. Defaults to 0 so non-execute callers stay unchanged.
  costMicroUsd = 0,
): Promise<boolean> {
  const dbResult = await env.DB.prepare(
    `UPDATE tasks
        SET status = ?, result = ?, completed_at = ?, updated_at = ?, cost_micro_usd = ?,
            execution_claim_expires_at = NULL
      WHERE id = ? AND assignee_agent_id = ? AND execution_receipt_id = ? AND status = 'in_progress'`,
  )
    .bind(
      status, result, completedAt, completedAt, Math.max(0, Math.round(costMicroUsd)),
      taskId, agentId, executionReceiptId,
    )
    .run()
  return dbResult.meta?.changes === 1
}

// ── content-intent proposal (flight-1) ────────────────────────────────────────
//
// The gate-owner capability namespace stamped on a content-publish task. Mirrors
// LOOP_GATE_OWNER = 'gate:loops' in src/loops/gate.ts — owner/admin always see and
// verdict every gate_owner (src/dashboard/approvals.ts isOwnerAdmin bypass); a
// delegated non-admin reviewer would need an explicit gate_grants row for this
// capability string, same mechanism as loop-gated tasks.
export const CONTENT_GATE_OWNER = 'gate:content'

// The department that owns the content-publish work-type today (WordpressChannel,
// composed under GrowthModule alongside SeoChannel — src/departments/modules/growth.ts).
// A single hardcoded department key is a deliberate flight-1 simplification: there is
// exactly one department in this codebase that declares 'content-publish'.
// Exported so the dashboard's Publish button (POST /admin/departments/:dept/execute/:gateId)
// targets the same dept key this module used to propose the gate — one source of truth.
export const CONTENT_DEPARTMENT_KEY = 'growth'

/**
 * Turn a detected content intent into a GATED department proposal and land the
 * task at 'review' — never spends a model call, never writes past the gate.
 *
 * THE SEAM: ctx is minted with idGen: () => task.id, so ctx.gate.propose()'s
 * internally-generated gateId (kernel.ts: `const gateId = idFn()`) equals this
 * task's own id. That means the SAME `tasks` row IS the gate record that
 * executor.execute()'s _hasApprovedVerdict (kernel.ts) reads via task_verdicts
 * WHERE task_id = gateId — no new table, no new UI. The proposal shows at
 * GET /approvals and is verdicted through the existing POST /api/tasks/:id/verdict
 * exactly like any other gated task, with zero changes to either surface.
 *
 * Fail-closed: any propose-time error (department not registered, capability
 * denied, undeclared work-type) lands the task 'blocked' with a clear reason —
 * the same "never leave in_progress stuck" invariant runTaskExecution's model
 * path already guarantees.
 */
async function finishContentProposal(
  env: Env,
  task: Task,
  agent: Agent,
  executionReceiptId: string,
  intent: ContentIntent,
  emit: (event: BusEvent) => Promise<void>,
): Promise<ExecuteResult> {
  const finishedAt = new Date().toISOString()

  const module = getRegistered(CONTENT_DEPARTMENT_KEY)
  if (!module) {
    const note = capResult(
      `content_proposal_failed: department '${CONTENT_DEPARTMENT_KEY}' is not registered — cannot propose a content-publish gate.`,
    )
    if (!(await finishTask(env, task.id, agent.id, executionReceiptId, 'blocked', note, finishedAt))) {
      return { ok: false, task_id: task.id, decided: '', error: 'task_claim_lost' }
    }
    await emitSafe(emit, executionEvent('task.blocked', env, agent, task, 'blocked'))
    return { ok: false, task_id: task.id, decided: '', task_status: 'blocked', error: 'department_not_registered' }
  }

  // This whole block (propose → transition-invariant check → claim-scoped write)
  // is wrapped in ONE try/catch. finishContentProposal is called OUTSIDE
  // runTaskExecution's own top-level try/catch (it runs before the meter
  // reservation), so it must be self-contained: no exception may escape this
  // function, or the task would be left stuck 'in_progress' — the exact bug
  // class the model path's own try/catch (below, in runTaskExecution) exists
  // to prevent.
  try {
    // capabilities: ['lead'] — the minimum WordpressChannel's 'content-publish'
    // work-type requires (src/departments/channels/wordpress-channel.ts). The
    // REAL human authority boundary is the /approvals verdict + the separate
    // owner/admin-gated execute route (src/dashboard/index.ts) that follows —
    // this capability is a structural floor inside the kernel, not the gate.
    const ctx = kernelMintCtx(
      { db: env.DB },
      {
        tenantId: env.TENANT_SLUG,
        departmentKey: CONTENT_DEPARTMENT_KEY,
        module,
        capabilities: ['lead'],
        idGen: () => task.id,
      },
    )
    const proposal = await ctx.gate.propose({
      action: 'content-publish',
      payload: {
        executor: intent.executor,
        title: intent.title,
        content: intent.content,
        // Defence-in-depth: the Inkwell internal endpoint server-forces draft
        // regardless (workers/inkwell-api/src/routes/internal-content.ts), but
        // this proposal is explicit about it too — nothing here ever asks for
        // 'published'.
        status: 'draft',
      },
    })
    const gateId = proposal.gateId

    // gateId === task.id by construction (idGen above) — the propose call above
    // cannot itself have changed task.status (it only touched
    // department_proposals + the in-memory pending store), so the claim-scoped
    // WHERE guard in finishContentProposalWrite still finds the row at
    // 'in_progress'.
    //
    // Enforce the transition at the service write layer, same discipline as the
    // model path below (in_progress → review is legal per the matrix regardless
    // of this branch; this only guards against future misuse of this function).
    const transitionErr = checkTransition('in_progress', 'review')
    if (transitionErr) {
      throw new Error('content_proposal_transition_invariant_violated: in_progress → review')
    }

    const note = capResult(
      `Proposed content-publish ("${intent.title}") to ${intent.executor} — awaiting approval at /approvals.`,
    )
    if (!(await finishContentProposalWrite(env, gateId, agent.id, executionReceiptId, note, finishedAt))) {
      return { ok: false, task_id: task.id, decided: '', error: 'task_claim_lost' }
    }
    await emitSafe(emit, executionEvent('task.review', env, agent, task, 'review'))
    await rememberSafe(
      (id, text, concepts) => createMemory(env).remember(id, text, concepts),
      agent.id,
      `Proposed content-publish "${intent.title}" (gate ${gateId}).`,
    )
    return { ok: true, task_id: task.id, decided: `content_proposed: ${intent.title}`, task_status: 'review' }
  } catch (err) {
    const reason = err instanceof CtxError ? err.code : 'propose_failed'
    const msg = err instanceof Error ? err.message : 'propose_failed'
    const note = capResult(`content_proposal_failed: ${msg}`)
    if (!(await finishTask(env, task.id, agent.id, executionReceiptId, 'blocked', note, finishedAt))) {
      return { ok: false, task_id: task.id, decided: '', error: 'task_claim_lost' }
    }
    await emitSafe(emit, executionEvent('task.blocked', env, agent, task, 'blocked'))
    return { ok: false, task_id: task.id, decided: '', task_status: 'blocked', error: reason }
  }
}

// Claim-scoped write for the content-proposal path — structurally the same
// optimistic-concurrency guard as finishTask, but ALSO stamps gate_owner
// (a content-publish task typically starts ungated, gate_owner = null, since
// the operator's IM/console/POST /api/tasks entry point creates it like any
// other task; the gating decision is made HERE, at execution time, once the
// title is known to be a "publish:" request) and forces status='review'
// unconditionally rather than the model path's `task.gate_owner ? 'review' : 'done'`
// ternary — a content proposal is ALWAYS gated, never auto-'done'.
// COALESCE preserves an operator-set gate_owner (e.g. a delegated reviewer
// capability) if one was already present on the row.
async function finishContentProposalWrite(
  env: Env,
  taskId: string,
  agentId: string,
  executionReceiptId: string,
  result: string,
  completedAt: string,
): Promise<boolean> {
  const dbResult = await env.DB.prepare(
    `UPDATE tasks
        SET status = 'review', result = ?, completed_at = ?, updated_at = ?,
            gate_owner = COALESCE(gate_owner, ?), execution_claim_expires_at = NULL
      WHERE id = ? AND assignee_agent_id = ? AND execution_receipt_id = ? AND status = 'in_progress'`,
  )
    .bind(result, completedAt, completedAt, CONTENT_GATE_OWNER, taskId, agentId, executionReceiptId)
    .run()
  return dbResult.meta?.changes === 1
}

// ── prompts ────────────────────────────────────────────────────────────────────

// System turn: grounds the agent in its identity, role, and the squad charter (the
// tenant-authored culture/mandate) so the work reflects this org.
export function buildExecuteSystem(agent: Agent, charter: string | null): string {
  const lines = [
    `You are ${agent.name}, a ${agent.role} agent in this organization.`,
    'You have been assigned a task. Do it now and respond with the completed work',
    'itself — the answer, the draft, the analysis, the plan — not a description of',
    'how you would do it. Be direct and useful.',
  ]
  if (charter && charter.trim().length > 0) {
    lines.push('', `Your squad's charter (its mandate and culture):`, charter.trim())
  }
  return lines.join('\n')
}

// User turn: the task itself. Prose answer, not the cortex JSON schema.
export function buildExecutePrompt(task: Task): string {
  const lines = [
    `Task: ${task.title}`,
    task.body ? `Details:\n${task.body}` : 'Details: (none provided)',
  ]
  return lines.join('\n\n')
}

export function capResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS - 1)}…`
}

// ── bus ──────────────────────────────────────────────────────────────────────

function executionEvent(
  // K1: 'task.review' is emitted when gated execution succeeds (task awaits verdict).
  type: 'task.completed' | 'task.blocked' | 'task.review',
  env: Env,
  agent: Agent,
  task: Task,
  status: Task['status'],
): BusEvent<{ task_id: string; project_id: string | null; agent_id: string; status: Task['status']; title: string }> {
  return {
    type,
    tenant: env.TENANT_SLUG,
    squad_id: task.squad_id,
    agent_id: agent.id,
    actor: { kind: 'agent', id: agent.id },
    payload: { task_id: task.id, project_id: task.project_id, agent_id: agent.id, status, title: task.title },
    ts: new Date().toISOString(),
  }
}

// A failed bus emit must not undo the persisted result (the row is the source of
// truth). Swallow.
async function emitSafe(emit: (event: BusEvent) => Promise<void>, event: BusEvent): Promise<void> {
  try {
    await emit(event)
  } catch {
    // observability only
  }
}

// A failed memory write must not undo the persisted result. Swallow.
async function rememberSafe(
  remember: (agentId: string, text: string, concepts?: string[]) => Promise<unknown>,
  agentId: string,
  text: string,
): Promise<void> {
  try {
    await remember(agentId, text, ['task', 'execution'])
  } catch {
    // best-effort
  }
}

// A failed token-record write must not undo the persisted result. Swallow.
async function recordTokensSafe(
  record: typeof recordTokens,
  env: Env,
  agentId: string,
  tokens: number,
  costMicroUsd = 0,
): Promise<void> {
  try {
    await record(env, agentId, tokens, costMicroUsd)
  } catch {
    // best-effort
  }
}

// Read a task id from a plain wake input (top-level task_id) or a raw BusEvent body
// (payload.task_id). Returns null when neither carries one. Shared by AgentDO and
// the squad coordinator.
export function resolveTaskId(input: { task_id?: unknown; payload?: unknown }): string | null {
  if (typeof input.task_id === 'string' && input.task_id.length > 0) return input.task_id
  const payload = input.payload
  if (payload && typeof payload === 'object' && 'task_id' in payload) {
    const v = (payload as Record<string, unknown>).task_id
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

export function resolveDispatchReceiptId(input: { payload?: unknown }): string | null {
  const payload = input.payload
  if (payload && typeof payload === 'object' && 'dispatch_receipt_id' in payload) {
    const value = (payload as Record<string, unknown>).dispatch_receipt_id
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}
