import { createBus } from '../bus'
import type { Env, Task, BusEvent } from '../types'
import { resolveTaskAssignee } from './assignee'

export type TaskDispatchFailureCode =
  | 'task_not_runnable'
  | 'task_not_dispatchable'
  | 'dispatch_failed'

export class TaskDispatchFailure extends Error {
  constructor(
    readonly code: TaskDispatchFailureCode,
    readonly receiptId?: string,
  ) {
    super(code)
    this.name = 'TaskDispatchFailure'
  }
}

export interface TaskDispatchReceipt {
  id: string
  dispatched_by: { kind: 'member'; id: string }
  dispatched_at: string
}

/**
 * Creates the sole durable receipt before emitting the one receipt-bearing wake
 * that the queue consumer translates into a runtime.dispatch/v1 inbox envelope.
 * Authorization belongs to the calling surface; this operation validates only
 * the current runnable task and its current assignable assignee.
 */
export async function dispatchAssignedTask(
  env: Env,
  task: Task,
  memberId: string,
): Promise<{ task: Task; receipt: TaskDispatchReceipt }> {
  if (!['open', 'blocked', 'rejected'].includes(task.status)) {
    throw new TaskDispatchFailure('task_not_runnable')
  }
  if (!task.assignee_agent_id) {
    throw new TaskDispatchFailure('task_not_dispatchable')
  }

  const assignee = await resolveTaskAssignee(env, task.assignee_agent_id, task.squad_id)
  if (assignee.error || assignee.value !== task.assignee_agent_id) {
    throw new TaskDispatchFailure('task_not_dispatchable')
  }

  const receiptId = crypto.randomUUID()
  const dispatchedAt = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO task_dispatch_receipts
       (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, 'member', ?, ?, 1)`,
  ).bind(
    receiptId,
    env.TENANT_SLUG,
    task.id,
    task.squad_id,
    task.assignee_agent_id,
    memberId,
    dispatchedAt,
  ).run()

  const event: BusEvent<{ task_id: string; by: string; dispatch_receipt_id: string }> = {
    type: 'agent.wake',
    tenant: env.TENANT_SLUG,
    squad_id: task.squad_id,
    agent_id: task.assignee_agent_id,
    actor: { kind: 'member', id: memberId },
    payload: { task_id: task.id, by: memberId, dispatch_receipt_id: receiptId },
    ts: dispatchedAt,
  }
  try {
    await createBus(env).emit(event)
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'dispatch_failed'
    await env.DB.prepare(
      `UPDATE task_dispatch_receipts
          SET last_error = ?
        WHERE tenant = ? AND id = ?`,
    ).bind(message, env.TENANT_SLUG, receiptId).run()
    throw new TaskDispatchFailure('dispatch_failed', receiptId)
  }

  return {
    task,
    receipt: {
      id: receiptId,
      dispatched_by: { kind: 'member', id: memberId },
      dispatched_at: dispatchedAt,
    },
  }
}
