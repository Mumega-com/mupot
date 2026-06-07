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
//  - mark in_progress + claim the assignee (if unset) BEFORE the model call;
//  - SUCCESS → status=done, result=<output capped>, completed_at=now, emit
//    task.completed {task_id, agent_id};
//  - FAILURE → status=blocked, result=<short note>, completed_at=now, emit
//    task.blocked. The model call is wrapped so a throw can NEVER leave the task
//    stuck in_progress.

import type { Env, Agent, Task, ModelMessage, ModelPort, BusEvent } from '../types'
import { createModel } from '../model'
import { createBus } from '../bus'
import { createMemory } from '../memory'

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

  // Fail-closed scope: must exist AND be in this agent's squad.
  const task = await loadTaskForSquad(env, taskId, agent.squad_id)
  if (!task) {
    return { ok: false, task_id: taskId, decided: `task ${taskId} not found in squad`, error: 'task_not_found' }
  }

  // Idempotency: a finished task is never re-executed.
  if (task.status === 'done') {
    return { ok: true, task_id: taskId, decided: 'already_done', task_status: 'done' }
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
    await finishTask(env, task.id, 'done', result, finishedAt)
    await emitSafe(emit, executionEvent('task.completed', env, agent, task, 'done'))
    // best-effort memory so the agent's future recalls compound on what it did.
    await rememberSafe(remember, agent.id, `Executed task "${task.title}" → done.`)
    return { ok: true, task_id: task.id, decided: `completed: ${task.title}`, task_status: 'done' }
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
  const row = await env.DB.prepare(
    `SELECT id, squad_id, title, body, status, assignee_agent_id, github_issue_url, result, completed_at, created_at, updated_at
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
  status: 'done' | 'blocked',
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
  type: 'task.completed' | 'task.blocked',
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
