// src/runners/types.ts — Flight-004 TENTACLES: Runner receipt types

export type RunnerStatus = 'running' | 'landed' | 'failed'

export interface RunnerReceipt {
  id: string
  tenant: string
  seat_agent_id: string
  squad_id: string | null
  name: string
  task: string
  status: RunnerStatus
  started_at: number
  ended_at: number | null
  evidence_summary: string | null
  verdict_line: string | null
  log_url: string | null
  created_at: number
  updated_at: number
}

export interface RecordRunnerInput {
  id?: string
  seat_agent_id?: string
  squad_id?: string | null
  name: string
  task: string
  status: RunnerStatus
  started_at?: number
  ended_at?: number | null
  evidence_summary?: string | null
  verdict_line?: string | null
  log_url?: string | null
}

export interface ListRunnersFilter {
  seat_agent_id?: string | null
  squad_id?: string | null
  squad_ids?: readonly string[] | null
  status?: RunnerStatus | null
  limit?: number
}
