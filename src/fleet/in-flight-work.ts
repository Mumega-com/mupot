/**
 * The one "is this agent mid-work" check. move_agent_squad (src/mcp/provision.ts) refuses with 409
 * fleet_dispatch_active on it, and squad_choose (src/members/squad-choice.ts) refuses with in_flight_work:
 * severing squad grants mid-flight can break a live dispatch/receipt path. Keep ONE predicate.
 */
import type { Env } from '../types'

export interface InFlightWork {
  flight: { id: string; status: string } | null
  taskId: string | null
  dispatchReceiptId: string | null
}

export async function findInFlightWork(env: Env, agentId: string): Promise<InFlightWork | null> {
  const [liveFlight, liveTask, liveDispatch] = await Promise.all([
    env.DB.prepare(
      `SELECT id, status FROM flights
        WHERE tenant = ?1 AND agent = ?2
          AND status IN ('preflight', 'running', 'waiting', 'sleeping')
        LIMIT 1`,
    ).bind(env.TENANT_SLUG, agentId).first<{ id: string; status: string }>(),
    env.DB.prepare(
      `SELECT id FROM tasks
        WHERE assignee_agent_id = ?1 AND status = 'in_progress'
        LIMIT 1`,
    ).bind(agentId).first<{ id: string }>(),
    env.DB.prepare(
      `SELECT id, task_id FROM task_dispatch_receipts
        WHERE tenant = ?1 AND agent_id = ?2 AND consumed_at IS NULL
        LIMIT 1`,
    ).bind(env.TENANT_SLUG, agentId).first<{ id: string; task_id: string }>(),
  ])
  if (!liveFlight && !liveTask && !liveDispatch) return null
  return {
    flight: liveFlight ?? null,
    taskId: liveTask?.id ?? liveDispatch?.task_id ?? null,
    dispatchReceiptId: liveDispatch?.id ?? null,
  }
}
