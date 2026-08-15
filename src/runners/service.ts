// src/runners/service.ts — Flight-004 TENTACLES: Runner receipts service

import type { Env } from '../types'
import type { RunnerReceipt, RecordRunnerInput, ListRunnersFilter, RunnerStatus } from './types'

const VALID_STATUSES: Set<RunnerStatus> = new Set(['running', 'landed', 'failed'])

export async function recordRunner(
  env: Env,
  input: RecordRunnerInput,
  callerAgentId?: string,
): Promise<RunnerReceipt> {
  const seatAgentId = input.seat_agent_id || callerAgentId
  if (!seatAgentId) {
    throw new Error('seat_agent_id_required: must provide seat_agent_id or have caller identity')
  }

  if (!input.name || typeof input.name !== 'string') {
    throw new Error('name_required: runner must have a name')
  }

  if (!input.task || typeof input.task !== 'string') {
    throw new Error('task_required: runner must have a task summary')
  }

  if (!VALID_STATUSES.has(input.status)) {
    throw new Error(`invalid_status: status must be one of 'running', 'landed', 'failed'`)
  }

  const id = input.id || crypto.randomUUID()
  const tenant = env.TENANT_SLUG || 'mumega'
  const now = Date.now()
  const startedAt = input.started_at ?? now
  const endedAt = input.ended_at ?? (input.status === 'landed' || input.status === 'failed' ? now : null)

  let squadId = input.squad_id
  if (squadId === undefined) {
    const agentRow = await env.DB.prepare('SELECT squad_id FROM agents WHERE id = ?1 OR slug = ?1 LIMIT 1')
      .bind(seatAgentId)
      .first<{ squad_id: string | null }>()
    squadId = agentRow?.squad_id ?? null
  }

  await env.DB.prepare(
    `INSERT INTO runner_receipts (
      id, tenant, seat_agent_id, squad_id, name, task, status,
      started_at, ended_at, evidence_summary, verdict_line, log_url,
      created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      ended_at = excluded.ended_at,
      evidence_summary = COALESCE(excluded.evidence_summary, runner_receipts.evidence_summary),
      verdict_line = COALESCE(excluded.verdict_line, runner_receipts.verdict_line),
      log_url = COALESCE(excluded.log_url, runner_receipts.log_url),
      updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      tenant,
      seatAgentId,
      squadId ?? null,
      input.name,
      input.task,
      input.status,
      startedAt,
      endedAt,
      input.evidence_summary ?? null,
      input.verdict_line ?? null,
      input.log_url ?? null,
      now,
      now,
    )
    .run()

  const row = await env.DB.prepare('SELECT * FROM runner_receipts WHERE id = ?1').bind(id).first<RunnerReceipt>()
  if (!row) {
    throw new Error('failed_to_load_recorded_runner')
  }
  return row
}

export async function listRunners(
  env: Env,
  filter: ListRunnersFilter = {},
): Promise<RunnerReceipt[]> {
  const tenant = env.TENANT_SLUG || 'mumega'
  const conditions: string[] = ['tenant = ?1']
  const params: unknown[] = [tenant]
  let pIdx = 2

  if (filter.squad_ids !== undefined && filter.squad_ids !== null) {
    if (filter.squad_ids.length === 0) {
      return [] // fail-closed
    }
    const placeholders = filter.squad_ids.map(() => `?${pIdx++}`).join(', ')
    conditions.push(`squad_id IN (${placeholders})`)
    params.push(...filter.squad_ids)
  } else if (filter.squad_id) {
    conditions.push(`squad_id = ?${pIdx++}`)
    params.push(filter.squad_id)
  }

  if (filter.seat_agent_id) {
    conditions.push(`seat_agent_id = ?${pIdx++}`)
    params.push(filter.seat_agent_id)
  }

  if (filter.status) {
    conditions.push(`status = ?${pIdx++}`)
    params.push(filter.status)
  }

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  params.push(limit)

  const sql = `SELECT * FROM runner_receipts WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?${pIdx}`
  const result = await env.DB.prepare(sql).bind(...params).all<RunnerReceipt>()
  return result.results ?? []
}
