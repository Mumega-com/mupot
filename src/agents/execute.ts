// mupot — task execution core. The last mile: an agent DOES a task.
//
// This is the pure, DO-independent orchestration so it is unit-testable in the
// same style as the rest of the codebase (a hand-mocked Env, an injected model).
// AgentDO.executeTask delegates here; the DO only owns its private runtime state
// (cycle counter / last decision), not the execution itself.
//
// Contract (spec §2):
//  - load the task fail-closed: it must exist AND belong to THIS agent's squad
//    (env.DB is already this tenant's DB, so squad-scoping is the boundary);
//  - idempotent: a task already 'done' is left untouched (the bus may redeliver);
//  - K6: execute no-ops for gate-terminal statuses (approved, review) and
//    already-terminal statuses (done). Only {open, in_progress, blocked, rejected}
//    proceed to execution. This prevents a re-wake from resurrecting an approved or
//    under-review task back to in_progress.
//  - mark in_progress + claim the assignee (if unset) BEFORE the model call;
//  - K1: SUCCESS on a gated task (gate_owner set) lands status='review', not 'done'.
//    The task waits for a human/agent verdict before completing. SUCCESS on an
//    ungated task lands status='done' as before.
//  - FAILURE → status=blocked, result=<short note>, completed_at=now, emit
//    task.blocked. The model call is wrapped so a throw can NEVER leave the task
//    stuck in_progress.

import type { Env, Agent, Task, ModelMessage, ModelPort, BusEvent } from '../types'
import { checkTransition } from '../tasks/service'
import { createModel } from '../model'
import { createBus } from '../bus'
import { createMemory } from '../memory'
import { checkAndReserve, recordTokens } from './meter'

// Hard ceiling on a persisted result (chars). Keeps a runaway model answer from
// bloating the row / GitHub mirror. ~16KB.
export const MAX_RESULT_CHARS = 16 * 1024
// Tokens the execute call may spend. Conservative cap; the org's provider/model
// choice still applies (createModel routes by org settings).
export const EXECUTE_MAX_TOKENS = 2048

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
  // meter will be wired into the execution path in #27 (the loop sprint). Resolved
  // here so the import survives bundling and is injectable in tests. The void cast
  // is the tsc-approved pattern for intentionally unused locals (noUnusedLocals=true).
  void (deps.meter ?? { checkAndReserve, recordTokens })

  // Fail-closed scope: must exist AND be in this agent's squad.
  const task = await loadTaskForSquad(env, taskId, agent.squad_id)
  if (!task) {
    return { ok: false, task_id: taskId, decided: `task ${taskId} not found in squad`, error: 'task_not_found' }
  }

  // K6: execute only drives tasks in workable statuses. Gate-terminal statuses
  // (review, approved) and done are no-ops. A re-wake must NOT resurrect an
  // approved or under-review task back to in_progress.
  //
  // Workable: open | in_progress | blocked | rejected
  // No-op:    done | review | approved
  //
  // 'rejected' is workable — it means rework is authorised; the agent should
  // re-attempt the task. 'blocked' is workable — the caller may retry after
  // resolving the blocker.
  const WORKABLE: ReadonlySet<Task['status']> = new Set(['open', 'in_progress', 'blocked', 'rejected'])
  if (!WORKABLE.has(task.status)) {
    return { ok: true, task_id: taskId, decided: `no_op:${task.status}`, task_status: task.status }
  }

  // Claim + mark working before spending the model budget.
  const startedAt = new Date().toISOString()
  const assignee = task.assignee_agent_id ?? agent.id
  await setTaskProgress(env, task.id, assignee, startedAt)

  try {
    const charter = await loadSquadCharter(env, agent.squad_id)
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

    await finishTask(env, task.id, successStatus, result, finishedAt)
    // Emit task.completed for ungated (terminal); task.review for gated (awaiting verdict).
    const eventType = successStatus === 'done' ? 'task.completed' : 'task.review'
    await emitSafe(emit, executionEvent(eventType, env, agent, task, successStatus))
    // best-effort memory so the agent's future recalls compound on what it did.
    await rememberSafe(remember, agent.id, `Executed task "${task.title}" → ${successStatus}.`)
    return { ok: true, task_id: task.id, decided: `completed: ${task.title}`, task_status: successStatus }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'execution_failed'
    const note = capResult(`Execution failed: ${msg}`)
    const finishedAt = new Date().toISOString()
    // NEVER leave in_progress stuck — land it in blocked with the error note.
    await finishTask(env, task.id, 'blocked', note, finishedAt)
    await emitSafe(emit, executionEvent('task.blocked', env, agent, task, 'blocked'))
    return { ok: false, task_id: task.id, decided: '', task_status: 'blocked', error: msg }
  }
}

// ── DB helpers (tenant DB is env.DB; squad-scoping is the boundary) ────────────

async function loadTaskForSquad(env: Env, taskId: string, squadId: string): Promise<Task | null> {
  // K1: gate_owner is selected so execute knows whether to land 'review' or 'done'
  // on success. K6: status is used to no-op on gate-terminal statuses.
  const row = await env.DB.prepare(
    `SELECT id, squad_id, title, body, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at
       FROM tasks WHERE id = ? AND squad_id = ? LIMIT 1`,
  )
    .bind(taskId, squadId)
    .first<Task>()
  return row ?? null
}

async function loadSquadCharter(env: Env, squadId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT charter FROM squads WHERE id = ? LIMIT 1')
    .bind(squadId)
    .first<{ charter: string | null }>()
  return row?.charter ?? null
}

async function setTaskProgress(env: Env, taskId: string, assignee: string, updatedAt: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET status = 'in_progress', assignee_agent_id = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(assignee, updatedAt, taskId)
    .run()
}

async function finishTask(
  env: Env,
  taskId: string,
  // K1: 'review' is a valid success-landing for gated tasks (awaits verdict).
  status: 'done' | 'blocked' | 'review',
  result: string,
  completedAt: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET status = ?, result = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(status, result, completedAt, completedAt, taskId)
    .run()
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
): BusEvent<{ task_id: string; agent_id: string; status: Task['status']; title: string }> {
  return {
    type,
    tenant: env.TENANT_SLUG,
    squad_id: task.squad_id,
    agent_id: agent.id,
    actor: { kind: 'agent', id: agent.id },
    payload: { task_id: task.id, agent_id: agent.id, status, title: task.title },
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
