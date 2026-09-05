import { sendAgentMessage } from '../agents/messages'
import { createBus } from '../bus'
import { resolveSoleGateOwnerAgent } from '../gates/grants'
import type { Env, Task, BusEvent } from '../types'

export const REVIEW_WAKE_SENDER = 'mupot-review-gate'

function reviewWakeRequestId(taskId: string, ts: string): string {
  return `review-wake:${taskId}:${ts}`
}

/**
 * Best-effort gate notification after a task enters review. The target is
 * resolved from the server-owned gate grant, never from caller input. Both the
 * queue wake and durable inbox row are additive to the already-committed task
 * transition and must not turn it into a failed transition.
 */
export async function wakeGateOwnerOnReview(
  env: Env,
  task: Task,
  actor: { kind: 'member' | 'agent'; id: string },
  byMemberId: string,
): Promise<void> {
  const gateOwner = task.gate_owner
  if (!gateOwner) return

  let agentId: string | null
  try {
    agentId = await resolveSoleGateOwnerAgent(env, gateOwner)
  } catch {
    return
  }
  if (!agentId) return

  const ts = new Date().toISOString()
  try {
    const event: BusEvent<{ task_id: string; gate_owner: string; by: string }> = {
      type: 'agent.wake',
      tenant: env.TENANT_SLUG,
      squad_id: task.squad_id,
      agent_id: agentId,
      actor,
      payload: { task_id: task.id, gate_owner: gateOwner, by: byMemberId },
      ts,
    }
    await createBus(env).emit(event)
  } catch {
    // The durable inbox attempt below can still notify an external gate runtime.
  }

  try {
    await sendAgentMessage(
      env,
      {
        fromAgent: REVIEW_WAKE_SENDER,
        fromMember: byMemberId,
        toAgent: agentId,
        kind: 'request',
        body: JSON.stringify({ type: 'task_review', task_id: task.id, gate_owner: gateOwner, squad_id: task.squad_id }),
        requestId: reviewWakeRequestId(task.id, ts),
      },
      {
        system: true,
        reason: 'target is the sole gate_grants holder resolved server-side, not attacker input',
      },
    )
  } catch {
    // Best-effort: the task already entered review and the bus wake was attempted.
  }
}
