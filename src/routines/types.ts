export type RoutineStatus = 'draft' | 'enabled' | 'paused' | 'archived'
export type RoutineTriggerKind = 'manual' | 'once' | 'cron'
export type RoutineOverlapPolicy = 'skip' | 'queue'
export type RoutineExecutionMode = 'propose' | 'execute_internal'
export type RoutineRunStatus =
  | 'queued' | 'leased' | 'observing' | 'waiting' | 'running'
  | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type RoutineWaitingReason = 'agent' | 'approval' | 'answer' | 'review' | 'budget'
export type RoutineActionKind =
  | 'create_task' | 'dispatch_flight' | 'request_review' | 'ask_human' | 'no_action'

export type RoutineSchedule =
  | { kind: 'manual'; timezone: string; runOnceAt?: never; cronExpression?: never }
  | { kind: 'once'; timezone: string; runOnceAt: string; cronExpression?: never }
  | { kind: 'cron'; timezone: string; runOnceAt?: never; cronExpression: string }

export interface Routine {
  id: string
  tenant: string
  project_id: string
  name: string
  objective: string
  status: RoutineStatus
  trigger_kind: RoutineTriggerKind
  run_once_at: string | null
  cron_expression: string | null
  timezone: string
  next_run_at: string | null
  overlap_policy: RoutineOverlapPolicy
  execution_mode: RoutineExecutionMode
  responsible_squad_id: string
  preferred_agent_id: string | null
  budget_micro_usd: number
  max_attempts: number
  retry_backoff_seconds: number
  max_occurrences: number | null
  stop_at: string | null
  revision: number
  enabled_by: string | null
  enabled_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface RoutinePolicySnapshot {
  execution_mode: RoutineExecutionMode
  overlap_policy: RoutineOverlapPolicy
  responsible_squad_id: string
  preferred_agent_id: string | null
  budget_micro_usd: number
  max_attempts: number
  retry_backoff_seconds: number
}

export interface RoutineRun {
  id: string
  tenant: string
  project_id: string
  routine_id: string
  routine_revision: number
  policy_json: string
  occurrence_key: string
  trigger_kind: RoutineTriggerKind
  scheduled_for: string | null
  status: RoutineRunStatus
  waiting_reason: RoutineWaitingReason | null
  lease_owner: string | null
  lease_expires_at: string | null
  attempt: number
  retry_at: string | null
  assigned_agent_id: string | null
  task_id: string | null
  flight_id: string | null
  situation_digest: string | null
  proposal_json: string | null
  result_summary: string | null
  cost_micro_usd: number
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export type RoutineAction =
  | { key: string; kind: 'create_task'; input: Record<string, unknown> }
  | { key: string; kind: 'dispatch_flight'; input: Record<string, unknown> }
  | { key: string; kind: 'request_review'; input: Record<string, unknown> }
  | { key: string; kind: 'ask_human'; input: Record<string, unknown> }
  | { key: string; kind: 'no_action'; input: Record<string, unknown> }
