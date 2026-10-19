// Shared Cursor Cloud → mupot control-plane write path.
//
// Hardened for Harness Adapter SPI v1:
// 1. reserveCursorCloudWork creates the authoritative Mupot Task + Flight +
//    harness_reservations row in D1 (<200ms) BEFORE any vendor HTTP call.
// 2. attachCursorCloudExecution contacts Cursor Cloud API and binds the vendor IDs
//    asynchronously via ToolCtx.waitUntil or background reconcile.
// 3. The reservation row is INSERTed FIRST (its UNIQUE key is the idempotency lock); Task + Flight are created and
//    bound only by the inserter, so a racing duplicate never leaves an orphan Task/Flight.

import type { Env } from '../types'
import { createTask } from '../tasks/service'
import type { Task } from '../types'
import { dispatchFlight } from '../flight/dispatch'
import type { DispatchResult } from '../flight/dispatch'
import type { FlightSignals } from '../flight/preflight'
import { FLIGHT_META_V1_SCHEMA } from '../flight/meta'
import { launchCursorAgent, resolveCursorApiToken } from './client'
import { kernelFlightSignals } from '../harness/kernel'
import {
  bindReservationTaskFlight,
  blockTaskForFailedReservation,
  bindVendorExecutionWithTaskBinding,
  claimAttachLease,
  releaseAttachLease,
  computeRequestDigest,
  getReservation,
  insertReservation,
  markReservationFailed,
  type HarnessReservationRow,
} from '../harness/reservations'
import type { HarnessActor, HarnessDispatchState } from '../harness/types'
import { assertExecutionNotPaused, ExecutionPausedError } from '../harness/pause'

export const CURSOR_CLOUD_DONE_WHEN =
  'Cursor Cloud run finishes with a recorded result or pull request'

// The flight preflight signals are NOT constants any more: the provider kernel (harness/kernel.ts kernelFlightSignals) derives the
// budget numbers from the agent's real cap and spend, and the caller passes them in. (The old hardcoded 1,000,000 / 10,000
// made the preflight's budget check pass for every Cursor run, whatever the agent had left.)

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
  /** Budget-aware preflight signals from the provider kernel. Omitted: derived here from the agent's real cap and spend. There is no constant that always passes. */
  preflightSignals?: FlightSignals
}

export interface ReserveCursorCloudWorkResult {
  reservationId: string
  /** null = reserved but not yet bound to a Task (a concurrent inserter is still creating it, or it crashed). */
  task: Task | null
  flight: DispatchResult | null
  replay: boolean
  state: HarnessDispatchState
  row: HarnessReservationRow
}

async function loadTask(env: Env, taskId: string): Promise<Task | null> {
  const result = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<Task>()
  return result ?? null
}

interface FlightRow {
  id: string
  status: string
  gate_verdict: string | null
  gate_reason: string
  score: number | null
}

/** The REAL flight row, mapped to a DispatchResult (replays must not fabricate a go verdict). */
export async function loadFlightResult(env: Env, flightId: string): Promise<DispatchResult | null> {
  const row = await env.DB.prepare(
    `SELECT id, status, gate_verdict, gate_reason, score FROM flights WHERE tenant = ? AND id = ?`,
  )
    .bind(env.TENANT_SLUG, flightId)
    .first<FlightRow>()
  if (!row) return null
  const go = row.gate_verdict === 'go'
  return {
    id: row.id,
    go,
    status: row.status === 'held' || !go ? 'held' : 'running',
    reasons: row.gate_reason ? row.gate_reason.split(',').filter(Boolean) : [],
    score: row.score ?? 0,
  }
}

async function replayResult(env: Env, row: HarnessReservationRow): Promise<ReserveCursorCloudWorkResult> {
  const task = row.task_id ? await loadTask(env, row.task_id) : null
  if (row.task_id && !task) {
    throw new Error(`corrupt_reservation_task_missing: ${row.task_id}`)
  }
  const flight = row.flight_id ? await loadFlightResult(env, row.flight_id) : null
  return {
    reservationId: row.id,
    task,
    flight,
    replay: true,
    state: row.state,
    row,
  }
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

  // Pause fence BEFORE any side effect (including the reservation INSERT).
  await assertExecutionNotPaused(env, input.agentId)

  // INSERT FIRST. The UNIQUE (tenant, squad_id, adapter, idempotency_key) hit is decided here, before Task/Flight
  // exist, so the loser of a race creates nothing.
  const reservationId = crypto.randomUUID()
  const insertResult = await insertReservation(env, {
    id: reservationId,
    adapter,
    idempotencyKey,
    requestDigest: digest,
    agentId: input.agentId,
    squadId: input.squadId,
    actor: input.actor,
  })

  if (insertResult.outcome === 'conflict') {
    throw new Error(`idempotency_key_conflict: ${idempotencyKey}`)
  }
  if (insertResult.outcome === 'replay') {
    return replayResult(env, insertResult.row)
  }

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

  let task: Task | undefined
  let flight: DispatchResult
  try {
    task = await createTask(
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

    flight = await dispatchFlight(
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
      input.preflightSignals ?? await kernelFlightSignals(env, input.agentId, 0),
      undefined,
      { id: reservedFlightId },
    )
  } catch (error) {
    // The key is ours but no Task/Flight could be created: fail the reservation (never leave it 'reserved' forever)
    // and, if the Task was already created, block + unassign it (no orphan in_progress task).
    // The task is linked only on failure (never before the gate verdict: a bound-but-ungated row is leasable).
    await markReservationFailed(env, reservationId, 'reserve_failed')
    if (task) {
      // flight_id stays NULL here: the Flight row may not exist (FK), only the Task link is certain.
      await bindReservationTaskFlight(env, reservationId, task.id, null, { held: false })
      await blockTaskForFailedReservation(env, task.id, reservationId, 'reserve_failed')
    }
    throw error
  }

  await bindReservationTaskFlight(env, reservationId, task.id, reservedFlightId, { held: !flight.go })
  if (!flight.go) await blockTaskForFailedReservation(env, task.id, reservationId, 'flight_gate_held')
  const row = (await getReservation(env, reservationId)) ?? insertResult.row

  return {
    reservationId,
    task,
    flight,
    replay: false,
    state: row.state,
    row,
  }
}

export interface AttachCursorCloudExecutionResult {
  reservationId: string
  state: HarnessDispatchState
  cursor?: CursorCloudRecord
  replay: boolean
  error?: string
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

  if (row.state === 'attached' && row.vendor_agent_id && row.vendor_run_id) {
    return {
      reservationId,
      state: 'attached',
      cursor: {
        agentId: row.vendor_agent_id,
        runId: row.vendor_run_id,
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

  if (!row.task_id) {
    // Reserved but not yet bound to a Task: nothing to launch (the inserter is still creating it).
    return { reservationId, state: row.state, error: 'reservation_unbound', replay: false }
  }

  const token = resolveCursorApiToken(env)
  if (!token) {
    const marked = await markReservationFailed(env, reservationId, 'cursor_token_missing')
    return {
      reservationId,
      state: marked ? 'failed' : row.state,
      error: 'cursor_token_missing',
      replay: false,
    }
  }

  const leaseId = await claimAttachLease(env, reservationId)
  if (!leaseId) {
    // Not claimed: live lease held by another attacher, or an expired lease just moved to failed
    // (launch_unconfirmed: lease_expired). Never launch without the lease.
    const fresh = await getReservation(env, reservationId)
    const state = fresh?.state ?? 'attaching'
    return {
      reservationId,
      state,
      ...(state === 'failed' && fresh?.last_error ? { error: fresh.last_error } : {}),
      replay: false,
    }
  }

  // A pause may have landed between reserve and attach: re-check with the lease held, before any vendor call.
  try {
    await assertExecutionNotPaused(env, row.agent_id)
  } catch (error) {
    if (error instanceof ExecutionPausedError) {
      await releaseAttachLease(env, reservationId, leaseId)
      return { reservationId, state: 'reserved', error: 'execution_paused', replay: false }
    }
    throw error
  }

  const task = await loadTask(env, row.task_id)
  if (!task) {
    await markReservationFailed(env, reservationId, 'task_missing', { leaseId })
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

  // #1762 tri-state: only a clean refusal (or no request sent) is a plain failure. A maybe_launched outcome (incl. the
  // 20s client abort) may have created a real agent on the repo, so the reservation records that explicitly and the
  // key is never re-launched.
  const outcome = await launchCursorAgent(token, {
    name: agentName,
    repoUrl,
    prompt: promptText,
    model,
  })

  if (outcome.state !== 'launched') {
    const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    const msg = outcome.state === 'maybe_launched' ? `launch_unconfirmed: ${detail}` : detail
    await markReservationFailed(env, reservationId, msg, { leaseId })
    return {
      reservationId,
      state: 'failed',
      error: msg,
      replay: false,
    }
  }

  const launched = outcome.result
  const cursorRecord: CursorCloudRecord = {
    agentId: launched.agent.id,
    runId: launched.run.id,
    agentUrl: launched.agent.url,
  }

  try {
    // One atomic batch fenced on THIS attacher's lease id: the reservation flips to attached and the task body gains
    // the vendor binding together, or neither.
    const binding = await bindVendorExecutionWithTaskBinding(env, reservationId, leaseId, task.id, cursorRecord, launched.run.status)
    if (!binding) {
      // Lease lost (reclaimed): do not claim the vendor ids as ours.
      const fresh = await getReservation(env, reservationId)
      return { reservationId, state: fresh?.state ?? 'attaching', error: 'bind_lost_lease', replay: false }
    }
    return {
      reservationId,
      state: 'attached',
      cursor: cursorRecord,
      replay: false,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // The agent exists; failing to record it must not read as a clean failure.
    await markReservationFailed(env, reservationId, `bind_unconfirmed: ${msg}`, { leaseId })
    return {
      reservationId,
      state: 'failed',
      error: 'bind_unconfirmed',
      replay: false,
    }
  }
}
