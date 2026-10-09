// src/runners/service.ts — Flight-004 TENTACLES: Runner receipts service

import type { Env } from '../types'
import type { RunnerReceipt, RecordRunnerInput, ListRunnersFilter, RunnerStatus } from './types'
import { verifyRunnerReceiptSig } from './signature'
import { chunkForD1InList } from '../lib/d1-in-list'

const VALID_STATUSES: Set<RunnerStatus> = new Set(['running', 'landed', 'failed'])

export async function recordRunner(
  env: Env,
  input: RecordRunnerInput,
  callerAgentId?: string,
): Promise<RunnerReceipt> {
  if (callerAgentId && input.seat_agent_id && input.seat_agent_id !== callerAgentId) {
    throw new Error('forbidden_seat_spoofing: seat_agent_id must match authenticated bound agent')
  }

  const seatAgentId = callerAgentId || input.seat_agent_id
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

  if (input.log_url !== undefined && input.log_url !== null) {
    const rawUrl = String(input.log_url).trim()
    if (rawUrl.length > 0) {
      const isAllowedScheme = /^https?:\/\//i.test(rawUrl) || /^file:\/\/\//i.test(rawUrl)
      if (!isAllowedScheme) {
        throw new Error('invalid_log_url: log_url must start with http://, https://, or file:///')
      }
    }
  }

  const id = input.id || crypto.randomUUID()
  const tenant = env.TENANT_SLUG || 'mumega'
  const now = Date.now()

  // Optional provenance signature (Flight-005 Slice 2b). If ANY sig field is
  // present, all three are required and the signature must verify against the
  // seat's active Ed25519 key. Absent signature = strict bearer-bound clamping.
  if (input.sig !== undefined || input.sig_ts !== undefined || input.sig_nonce !== undefined) {
    if (typeof input.sig !== 'string' || typeof input.sig_ts !== 'number' || typeof input.sig_nonce !== 'string') {
      throw new Error('invalid_signature: sig, sig_ts and sig_nonce must all be present')
    }
    await verifyRunnerReceiptSig(env, seatAgentId, input.name, input.task, input.status, {
      sig: input.sig,
      sig_ts: input.sig_ts,
      sig_nonce: input.sig_nonce,
    })
  }

  // Check existing row if updating by ID
  const existing = await env.DB.prepare('SELECT * FROM runner_receipts WHERE id = ?1').bind(id).first<RunnerReceipt>()
  if (existing) {
    if (existing.seat_agent_id !== seatAgentId) {
      throw new Error('forbidden_cross_seat_mutation: cannot modify runner receipt owned by another seat')
    }
    // Status lock (Flight-005): a terminal receipt is immutable evidence. Once
    // landed/failed, the owning seat cannot flip the status, re-open to running,
    // or rewrite evidence — any further mutation throws.
    if (existing.status === 'landed' || existing.status === 'failed') {
      throw new Error('receipt_locked: terminal runner receipts (landed/failed) are immutable')
    }
  }

  const startedAt = input.started_at ?? (existing ? existing.started_at : now)
  const endedAt = input.ended_at !== undefined ? input.ended_at : (input.status === 'landed' || input.status === 'failed' ? (existing?.ended_at ?? now) : null)

  // PROVENANCE (Flight-005 Slice 2b): seat + squad are authoritative from the
  // authenticated context and D1, never from caller-supplied foreign keys.
  const agentRow = await env.DB.prepare('SELECT squad_id FROM agents WHERE id = ?1 OR slug = ?1 LIMIT 1')
    .bind(seatAgentId)
    .first<{ squad_id: string | null }>()
  if (!agentRow) {
    throw new Error('seat_agent_not_found: seat_agent_id must resolve to a registered agent')
  }
  const authoritativeSquadId = agentRow.squad_id

  // Reject any non-null caller-supplied squad_id that disagrees with the D1
  // authoritative squad (a null means "derive it", matching the previous API).
  if (input.squad_id != null && input.squad_id !== authoritativeSquadId) {
    throw new Error('forbidden_cross_squad_mutation: squad_id does not match seat agent squad')
  }
  const squadId = authoritativeSquadId

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

/**
 * listRunners — both existing callers (mcp/runners.ts's `runner_list` tool,
 * dashboard/mission-control-routes.ts's /radar) are viewer-facing, so the
 * home-squad exclusion below is UNCONDITIONAL, matching every other
 * resolveAccessibleSquadIds-consumer query in this codebase (agents-admin.ts,
 * kanban-routes.ts, fleet/registry.ts) — an org-admin/unrestricted caller
 * (squad_ids: null) must not see a runner receipt recorded against a
 * member's home squad (resolveAccessibleSquadIds consumer audit, G-FP1b).
 */
export async function listRunners(
  env: Env,
  filter: ListRunnersFilter = {},
): Promise<RunnerReceipt[]> {
  const tenant = env.TENANT_SLUG || 'mumega'
  const conditions: string[] = [
    'tenant = ?1',
    `(squad_id IS NULL OR NOT EXISTS (SELECT 1 FROM squads s WHERE s.id = runner_receipts.squad_id AND s.kind = 'home'))`,
  ]
  const params: unknown[] = [tenant]
  let pIdx = 2

  // mupot#1774: the squad list scales with the caller's squad grants, so it is split across
  // statements (each stays under D1's 100-bind ceiling) and the per-chunk pages are merged.
  let squadChunks: string[][] | null = null
  if (filter.squad_ids !== undefined && filter.squad_ids !== null) {
    if (filter.squad_ids.length === 0) {
      return [] // fail-closed
    }
    // Fixed binds besides the squad list: tenant + optional seat/status + limit (<= 4).
    squadChunks = chunkForD1InList([...new Set(filter.squad_ids)], undefined, 4)
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
  const runChunk = async (squadChunk: string[] | null): Promise<RunnerReceipt[]> => {
    const where = [...conditions]
    const binds = [...params]
    let idx = pIdx
    if (squadChunk !== null) {
      where.push(`squad_id IN (${squadChunk.map(() => `?${idx++}`).join(', ')})`)
      binds.push(...squadChunk)
    }
    binds.push(limit)
    const sql = `SELECT * FROM runner_receipts WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?${idx}`
    const result = await env.DB.prepare(sql).bind(...binds).all<RunnerReceipt>()
    return result.results ?? []
  }
  if (squadChunks === null) return runChunk(null)
  // Each chunk returns its own newest `limit`; the global newest `limit` is among their union.
  const merged: RunnerReceipt[] = []
  for (const squadChunk of squadChunks) merged.push(...await runChunk(squadChunk))
  merged.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1))
  return merged.slice(0, limit)
}
