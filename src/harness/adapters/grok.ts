// src/harness/adapters/grok.ts — Grokbot / Grok CLI Harness Adapter.
//
// Implements HarnessAdapter SPI for Grok runtimes attached via Herdr/MCP.
// Rather than an external cloud REST call, Grok agents consume work via
// Mupot-native inbox dispatches and bus receipts.
//
// Shared invariant: Mupot reserves Task + Flight + reservation record first.
// The dispatch wake uses idempotent request_id = `harness:${reservationId}`.

import type { Env, Task } from '../../types'
import { createTask } from '../../tasks/service'
import { dispatchFlight } from '../../flight/dispatch'
import { FLIGHT_META_V1_SCHEMA } from '../../flight/meta'
import {
  bindReservationTaskFlight,
  bindVendorExecution,
  claimAttachLease,
  computeRequestDigest,
  getReservation,
  insertReservation,
  isReservationStuck,
  markReconciled,
  markReservationFailed,
  type HarnessReservationRow,
} from '../reservations'
import { publicHarnessError } from './cursor'
import { assertExecutionNotPaused, ExecutionPausedError } from '../pause'
import type {
  DispatchRequest,
  DispatchOutcome,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessContext,
  ReconcileResult,
  RunStatusResult,
  StatusQuery,
} from '../types'

export const GROK_CLI_DONE_WHEN =
  'Grokbot completes the assigned task with passing verification evidence and commits'

async function loadTask(env: Env, taskId: string): Promise<Task | null> {
  const result = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first<Task>()
  return result ?? null
}

export const grokCliAdapter: HarnessAdapter = {
  kind: 'grok-cli',

  capabilities(): HarnessCapabilities {
    return {
      kind: 'grok-cli',
      launch: true,
      followUp: false,
      status: true,
      cancel: false,
      asyncAttach: false,
      requiresRepoUrl: false,
      requiresApiToken: false,
    }
  },

  isAvailable(_env: Env): boolean {
    return true
  },

  async dispatch(
    env: Env,
    req: DispatchRequest,
    _ctx?: HarnessContext,
  ): Promise<DispatchOutcome> {
    const adapter = 'grok-cli'
    const title = req.name.trim()
    const idempotencyKey = req.idempotencyKey.trim()

    // Dry-run is the default (router_tick pattern, #1780/#1807): nothing is reserved, created or woken unless the
    // caller passes an explicit dryRun:false.
    if (req.dryRun !== false) {
      return {
        accepted: false,
        error: 'dry_run',
        detail: { adapter, would_reserve: { name: title, squadId: req.squadId, agentId: req.agentId, idempotencyKey } },
      }
    }

    // Pause fence before ANY side effect (incl. the reservation INSERT).
    try {
      await assertExecutionNotPaused(env, req.agentId)
    } catch (error) {
      if (error instanceof ExecutionPausedError) return { accepted: false, error: 'execution_paused' }
      throw error
    }

    const digest = await computeRequestDigest(adapter, req)

    const replayOutcome = (row: HarnessReservationRow): DispatchOutcome => ({
      accepted: true,
      state: row.state === 'attached' ? 'attached' : 'reserved',
      reservationId: row.id,
      taskId: row.task_id,
      flightId: row.flight_id,
      adapter,
      idempotencyKey,
      replay: true,
      vendorAgentId: row.vendor_agent_id ?? undefined,
      vendorRunId: row.vendor_run_id ?? undefined,
      vendorUrl: row.vendor_url ?? undefined,
    })

    // INSERT FIRST (the UNIQUE key is the lock): a racing duplicate is decided here, before any Task/Flight exists.
    const reservationId = crypto.randomUUID()
    const insertResult = await insertReservation(env, {
      id: reservationId,
      adapter,
      idempotencyKey,
      requestDigest: digest,
      agentId: req.agentId,
      squadId: req.squadId,
      actor: req.actor,
    })
    if (insertResult.outcome === 'conflict') {
      return { accepted: false, error: 'idempotency_key_conflict' }
    }
    if (insertResult.outcome === 'replay') {
      if (insertResult.row.state === 'failed') {
        return { accepted: false, error: publicHarnessError(insertResult.row.last_error), reservationId: insertResult.row.id }
      }
      return replayOutcome(insertResult.row)
    }

    const reservedTaskId = req.taskId?.trim() || crypto.randomUUID()
    const reservedFlightId = req.flightId?.trim() || crypto.randomUUID()

    const lines = [
      req.prompt.trim(),
      '',
      `harness: grok-cli`,
      `reservation: ${reservationId}`,
    ]
    if (req.repoUrl) {
      lines.push(`repo: ${req.repoUrl.trim()}`)
    }

    let task: Task
    let flightGo: boolean
    try {
      task = await createTask(
        env,
        {
          squad_id: req.squadId,
          title,
          body: lines.join('\n'),
          done_when: GROK_CLI_DONE_WHEN,
          assignee_agent_id: req.agentId,
          status: 'in_progress',
        },
        {
          id: reservedTaskId,
          actor: req.actor,
          skipMirror: true,
        },
      )

      const flight = await dispatchFlight(
        env,
        {
          agent: req.agentId,
          goal: title,
          trigger_source: 'api',
          meta: {
            schema: FLIGHT_META_V1_SCHEMA,
            goal_id: `grok-cli:${reservationId}`,
            objective_id: task.id,
            squad_ids: [req.squadId],
            task_ids: [task.id],
            done_when: [GROK_CLI_DONE_WHEN],
            artifact_refs: [],
            receipt_refs: [],
            confidentiality: 'internal',
            publication_target: 'none',
            parent_flight_id: null,
          },
        },
        {
          contextComplete: true,
          toolsReachable: true,
          budgetRemainingMicroUsd: 1_000_000,
          budgetEstimateMicroUsd: 10_000,
          recentProgress: 0.9,
          progressPerStep: 0.8,
          wastePerStep: 0.1,
          stepSeconds: 30,
        },
        undefined,
        { id: reservedFlightId },
      )
      flightGo = flight.go
    } catch {
      await markReservationFailed(env, reservationId, 'reserve_failed')
      return { accepted: false, error: 'reserve_failed', reservationId }
    }

    await bindReservationTaskFlight(env, reservationId, task.id, reservedFlightId, { held: !flightGo })
    if (!flightGo) {
      return { accepted: false, error: 'flight_gate_held', reservationId, taskId: task.id, flightId: reservedFlightId }
    }

    // reserved -> attaching (lease + fencing token) -> attached. Never insert as 'attached'.
    const leaseId = await claimAttachLease(env, reservationId)
    if (!leaseId) {
      const row = await getReservation(env, reservationId)
      return row ? replayOutcome(row) : { accepted: false, error: 'attach_failed', reservationId }
    }
    const runId = `run-${reservationId.slice(0, 8)}`
    const bound = await bindVendorExecution(env, reservationId, leaseId, {
      agentId: req.agentId,
      runId,
      url: `mupot:inbox:${req.agentId}`,
      status: 'dispatched',
    })
    if (!bound) {
      return { accepted: false, error: 'bind_lost_lease', reservationId, taskId: task.id, flightId: reservedFlightId }
    }

    return {
      accepted: true,
      state: 'attached',
      reservationId,
      taskId: task.id,
      flightId: reservedFlightId,
      adapter,
      idempotencyKey,
      replay: false,
      vendorAgentId: req.agentId,
      vendorRunId: runId,
      vendorUrl: `mupot:inbox:${req.agentId}`,
    }
  },

  async status(env: Env, query: StatusQuery): Promise<RunStatusResult> {
    const row = query.reservationId ? await getReservation(env, query.reservationId) : null
    const reservationId = row?.id ?? query.reservationId ?? 'unknown'
    const taskId = row?.task_id ?? query.taskId

    let taskResult: string | null = null
    if (taskId) {
      const task = await loadTask(env, taskId)
      if (task) {
        taskResult = task.result ?? null
      }
    }

    return {
      reservationId,
      adapter: 'grok-cli',
      state: row?.state ?? 'attached',
      vendorStatus: row?.last_vendor_status ?? 'dispatched',
      vendorAgentId: row?.vendor_agent_id ?? undefined,
      vendorRunId: row?.vendor_run_id ?? undefined,
      vendorUrl: row?.vendor_url ?? undefined,
      result: taskResult,
      ...(row && isReservationStuck(row) ? { stuck: true } : {}),
    }
  },

  async reconcile(env: Env, reservationId: string): Promise<ReconcileResult> {
    const row = await getReservation(env, reservationId)
    if (!row) {
      throw new Error(`reservation_not_found: ${reservationId}`)
    }

    const previousState = row.state
    const task = row.task_id ? await loadTask(env, row.task_id) : null

    if (task && (task.status === 'done' || task.status === 'review')) {
      const changed = await markReconciled(env, reservationId, task.status)
      return {
        reservationId,
        previousState,
        nextState: changed ? 'reconciled' : previousState,
        vendorStatus: task.status,
        changed,
      }
    }

    return {
      reservationId,
      previousState,
      nextState: previousState,
      changed: false,
    }
  },
}
