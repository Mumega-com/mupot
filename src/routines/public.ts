import type { RoutineRun } from './types'

export interface PublicRoutineRun {
  id: string
  project_id: string
  routine_id: string
  routine_revision: number
  trigger_kind: RoutineRun['trigger_kind']
  scheduled_for: string | null
  status: RoutineRun['status']
  waiting_reason: RoutineRun['waiting_reason']
  attempt: number
  assigned_agent_id: string | null
  task_id: string | null
  flight_id: string | null
  result_summary: string | null
  cost_micro_usd: number
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export function publicRoutineRun(run: RoutineRun): PublicRoutineRun {
  return {
    id: run.id,
    project_id: run.project_id,
    routine_id: run.routine_id,
    routine_revision: run.routine_revision,
    trigger_kind: run.trigger_kind,
    scheduled_for: run.scheduled_for,
    status: run.status,
    waiting_reason: run.waiting_reason,
    attempt: run.attempt,
    assigned_agent_id: run.assigned_agent_id,
    task_id: run.task_id,
    flight_id: run.flight_id,
    result_summary: run.result_summary,
    cost_micro_usd: run.cost_micro_usd,
    started_at: run.started_at,
    finished_at: run.finished_at,
    created_at: run.created_at,
    updated_at: run.updated_at,
  }
}
