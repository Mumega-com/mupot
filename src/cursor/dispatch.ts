// Shared Cursor Cloud → mupot control-plane write path.
//
// Hardened for Harness Adapter SPI v1:
// 1. reserveCursorCloudWork creates the authoritative Mupot Task + Flight +
//    harness_reservations row in D1 (<200ms) BEFORE any vendor HTTP call.
// 2. attachCursorCloudExecution contacts Cursor Cloud API and binds the vendor IDs
//    asynchronously via ToolCtx.waitUntil or background reconcile.
// 3. recordCursorCloudWork is preserved as a backward-compatible wrapper.

import type { Env } from '../types'
import { createTask } from '../tasks/service'
import type { Task } from '../types'
import { dispatchFlight } from '../flight/dispatch'
import type { DispatchResult } from '../flight/dispatch'
import type { FlightSignals } from '../flight/preflight'
import { FLIGHT_META_V1_SCHEMA } from '../flight/meta'
import { createCursorAgent, resolveCursorApiToken } from './client'
import {
  bindVendorExecution,
  claimAttachLease,
  computeRequestDigest,
  getReservation,
  getReservationByIdempotency,
  insertReservation,
  markReservationFailed,
  type HarnessReservationRow,
} from '../harness/reservations'
import type { HarnessActor, HarnessDispatchState } from '../harness/types'

export const CURSOR_CLOUD_DONE_WHEN =
  'Cursor Cloud run finishes with a recorded result or pull request'

export const CURSOR_CLOUD_PREFLIGHT_SIGNALS: FlightSignals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 1_000_000,
  budgetEstimateMicroUsd: 10_000,
  recentProgress: 0.8,
  progressPerStep: 0.6,
  wastePerStep: 0.1,
  stepSeconds: 60,
}

export interface CursorCloudRecord {
  agentId: string
  runId: string
  agentUrl: string
}

export {
  CURSOR_CLOUD_SEAT,
  CURSOR_CLOUD_HARNESS,
  CURSOR_CLOUD_MODEL,
  CURSOR_CLOUD_EFFORT,
  CURSOR_CLOUD_MACHINE,
  sevenAxisCheckInDeclaration,
  injectSevenAxisSeatDeclaration,
} from './seat-identity'

import { injectSevenAxisSeatDeclaration } from './seat-identity'

export interface ReserveCursorCloudWorkInput {
  name: string
  repoUrl: string
  prompt: string
  squadId: string
  agentId: string
  actor: HarnessActor
  idempotencyKey: string
  model?: string
  flightId?: string
  taskId?: string
}

export interface ReserveCursorCloudWorkResult {
  reservationId: string
  task: Task
  flight: DispatchResult
  replay: boolean
  state: HarnessDispatchState
  row: HarnessReservationRow
}

async function loadTask(env: Env, taskId: string): Promise<Task | null> {
  const result = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<Task>()
  return result ?? null
}

export async function reserveCursorCloudWork(
  env: Env,
  input: ReserveCursorCloudWorkInput,
): Promise<ReserveCursorCloudWorkResult> {
  const title = input.name.trim()
  const idempotencyKey = input.idempotencyKey.trim()
  const adapter = 'cursor-cloud'

  const digest = await computeRequestDigest(adapter, {
    name: title,
    prompt: input.prompt,
    repoUrl: input.repoUrl,
    model: input.model,
    squadId: input.squadId,
    agentId: input.agentId,
    actor: input.actor,
    idempotencyKey,
  })

  const existing = await getReservationByIdempotency(env, adapter, idempotencyKey)
  if (existing) {
    if (existing.request_digest !== digest) {
      throw new Error(`idempotency_key_conflict: ${idempotencyKey}`)
    }
    const existingTask = await loadTask(env, existing.task_id)
    if (!existingTask) {
      throw new Error(`corrupt_reservation_task_missing: ${existing.task_id}`)
    }
    const fakeFlight: DispatchResult = {
      id: existing.flight_id,
      go: true,
      status: 'running',
      reasons: [],
      score: 1.0,
    }
    return {
      reservationId: existing.id,
      task: existingTask,
      flight: fakeFlight,
      replay: true,
      state: existing.state,
      row: existing,
    }
  }

  const reservationId = crypto.randomUUID()
  const reservedTaskId = input.taskId?.trim() || crypto.randomUUID()
  const reservedFlightId = input.flightId?.trim() || crypto.randomUUID()
  const launchedPrompt = injectSevenAxisSeatDeclaration(input.prompt, reservedFlightId)

  const lines = [
    launchedPrompt,
    '',
    `repo: ${input.repoUrl.trim()}`,
    `reservation: ${reservationId}`,
  ]
  if (input.model) {
    lines.push(`model: ${input.model.trim()}`)
  }

  const task = await createTask(
    env,
    {
      squad_id: input.squadId,
      title,
      body: lines.join('\n'),
      done_when: CURSOR_CLOUD_DONE_WHEN,
      assignee_agent_id: input.agentId,
      status: 'in_progress',
    },
    {
      id: reservedTaskId,
      actor: input.actor,
      skipMirror: true,
    },
  )

  const flight = await dispatchFlight(
    env,
    {
      agent: input.agentId,
      goal: title,
      trigger_source: 'api',
      meta: {
        schema: FLIGHT_META_V1_SCHEMA,
        goal_id: `cursor-cloud:${reservationId}`,
        objective_id: task.id,
        squad_ids: [input.squadId],
        task_ids: [task.id],
        done_when: [CURSOR_CLOUD_DONE_WHEN],
        artifact_refs: [],
        receipt_refs: [],
        confidentiality: 'internal',
        publication_target: 'none',
        parent_flight_id: null,
      },
    },
    CURSOR_CLOUD_PREFLIGHT_SIGNALS,
    undefined,
    { id: reservedFlightId },
  )

  const insertResult = await insertReservation(env, {
    id: reservationId,
    adapter,
    idempotencyKey,
    requestDigest: digest,
    taskId: task.id,
    flightId: reservedFlightId,
    agentId: input.agentId,
    squadId: input.squadId,
    actor: input.actor,
    state: flight.go ? 'reserved' : 'failed',
  })

  if (insertResult.outcome === 'conflict') {
    throw new Error(`idempotency_key_conflict: ${idempotencyKey}`)
  }

  if (insertResult.outcome === 'replay') {
    const existingTask = await loadTask(env, insertResult.row.task_id)
    return {
      reservationId: insertResult.row.id,
      task: existingTask ?? task,
      flight: {
        id: insertResult.row.flight_id,
        go: true,
        status: 'running',
        reasons: [],
        score: 1.0,
      },
      replay: true,
      state: insertResult.row.state,
      row: insertResult.row,
    }
  }

  return {
    reservationId,
    task,
    flight,
    replay: false,
    state: insertResult.row.state,
    row: insertResult.row,
  }
}

export interface AttachCursorCloudExecutionResult {
  reservationId: string
  state: HarnessDispatchState
  cursor?: CursorCloudRecord
  replay: boolean
  error?: string
}

export async function appendCursorCloudBinding(
  env: Env,
  taskId: string,
  cursor: CursorCloudRecord,
): Promise<void> {
  const extra = [
    '',
    `cursor_agent: ${cursor.agentId}`,
    `cursor_run: ${cursor.runId}`,
    `cursor_url: ${cursor.agentUrl}`,
  ].join('\n')

  await env.DB.prepare(
    `UPDATE tasks
     SET body = body || ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(extra, new Date().toISOString(), taskId)
    .run()
}

export async function attachCursorCloudExecution(
  env: Env,
  reservationId: string,
  opts?: { model?: string },
): Promise<AttachCursorCloudExecutionResult> {
  const row = await getReservation(env, reservationId)
  if (!row) {
    throw new Error(`reservation_not_found: ${reservationId}`)
  }

  if (row.state === 'attached' && row.vendor_run_id) {
    return {
      reservationId,
      state: 'attached',
      cursor: {
        agentId: row.vendor_agent_id!,
        runId: row.vendor_run_id!,
        agentUrl: row.vendor_url ?? `https://cursor.com/agents/${row.vendor_agent_id}`,
      },
      replay: true,
    }
  }

  if (row.state === 'failed') {
    return {
      reservationId,
      state: 'failed',
      error: row.last_error ?? 'previously_failed',
      replay: true,
    }
  }

  const token = resolveCursorApiToken(env)
  if (!token) {
    await markReservationFailed(env, reservationId, 'cursor_token_missing')
    return {
      reservationId,
      state: 'failed',
      error: 'cursor_token_missing',
      replay: false,
    }
  }

  const leased = await claimAttachLease(env, reservationId)
  if (!leased) {
    return {
      reservationId,
      state: 'attaching',
      replay: false,
    }
  }

  const task = await loadTask(env, row.task_id)
  if (!task) {
    await markReservationFailed(env, reservationId, 'task_missing')
    return {
      reservationId,
      state: 'failed',
      error: 'task_missing',
      replay: false,
    }
  }

  // Parse repoUrl and prompt from task body
  let repoUrl = ''
  let model = opts?.model
  const promptLines: string[] = []
  for (const line of (task.body ?? '').split('\n')) {
    if (line.startsWith('repo: ')) {
      repoUrl = line.slice(6).trim()
    } else if (line.startsWith('model: ') && !model) {
      model = line.slice(7).trim()
    } else if (line.startsWith('reservation: ') || line.startsWith('cursor_')) {
      // skip metadata trailers
    } else {
      promptLines.push(line)
    }
  }

  const promptText = promptLines.join('\n').trim()
  const agentName = `mupot:${reservationId.slice(0, 8)} ${task.title}`

  try {
    const launched = await createCursorAgent(token, {
      name: agentName,
      repoUrl,
      prompt: promptText,
      model,
    })

    await bindVendorExecution(env, reservationId, {
      agentId: launched.agent.id,
      runId: launched.run.id,
      url: launched.agent.url,
      status: launched.run.status,
    })

    const cursorRecord: CursorCloudRecord = {
      agentId: launched.agent.id,
      runId: launched.run.id,
      agentUrl: launched.agent.url,
    }

    await appendCursorCloudBinding(env, task.id, cursorRecord)

    return {
      reservationId,
      state: 'attached',
      cursor: cursorRecord,
      replay: false,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    await markReservationFailed(env, reservationId, msg)
    return {
      reservationId,
      state: 'failed',
      error: msg,
      replay: false,
    }
  }
}

// ── Backward-compatible wrapper ─────────────────────────────────────────────
export interface RecordCursorCloudWorkInput {
  name: string
  repoUrl: string
  prompt: string
  squadId: string
  agentId: string
  actor?: { kind: 'member' | 'agent'; id: string }
  cursor?: CursorCloudRecord
  flightId?: string
}

export interface RecordCursorCloudWorkResult {
  task: Task
  flight: DispatchResult
}

export async function recordCursorCloudWork(
  env: Env,
  input: RecordCursorCloudWorkInput,
): Promise<RecordCursorCloudWorkResult> {
  const actor: HarnessActor = input.actor ?? { kind: 'agent', id: input.agentId }
  const idempotencyKey = crypto.randomUUID()

  const reserved = await reserveCursorCloudWork(env, {
    name: input.name,
    repoUrl: input.repoUrl,
    prompt: input.prompt,
    squadId: input.squadId,
    agentId: input.agentId,
    actor,
    idempotencyKey,
    flightId: input.flightId,
  })

  if (input.cursor) {
    await bindVendorExecution(env, reserved.reservationId, {
      agentId: input.cursor.agentId,
      runId: input.cursor.runId,
      url: input.cursor.agentUrl,
    })
    await appendCursorCloudBinding(env, reserved.task.id, input.cursor)
  }

  return { task: reserved.task, flight: reserved.flight }
}
