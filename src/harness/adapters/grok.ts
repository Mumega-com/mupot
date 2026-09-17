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
  bindVendorExecution,
  computeRequestDigest,
  getReservation,
  getReservationByIdempotency,
  insertReservation,
  markReconciled,
} from '../reservations'
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

    const digest = await computeRequestDigest(adapter, req)

    const existing = await getReservationByIdempotency(env, adapter, idempotencyKey)
    if (existing) {
      if (existing.request_digest !== digest) {
        return { accepted: false, error: 'idempotency_key_conflict' }
      }
      return {
        accepted: true,
        state: existing.state === 'attached' ? 'attached' : 'reserved',
        reservationId: existing.id,
        taskId: existing.task_id,
        flightId: existing.flight_id,
        adapter,
        idempotencyKey,
        replay: true,
        vendorAgentId: existing.vendor_agent_id ?? undefined,
        vendorRunId: existing.vendor_run_id ?? undefined,
        vendorUrl: existing.vendor_url ?? undefined,
      }
    }

    const reservationId = crypto.randomUUID()
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

    const task = await createTask(
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

    await dispatchFlight(
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

    const insertResult = await insertReservation(env, {
      id: reservationId,
      adapter,
      idempotencyKey,
      requestDigest: digest,
      taskId: task.id,
      flightId: reservedFlightId,
      agentId: req.agentId,
      squadId: req.squadId,
      actor: req.actor,
      state: 'attached',
    })

    if (insertResult.outcome === 'conflict') {
      return { accepted: false, error: 'idempotency_key_conflict' }
    }

    if (insertResult.outcome === 'replay') {
      return {
        accepted: true,
        state: insertResult.row.state === 'attached' ? 'attached' : 'reserved',
        reservationId: insertResult.row.id,
        taskId: insertResult.row.task_id,
        flightId: insertResult.row.flight_id,
        adapter,
        idempotencyKey,
        replay: true,
        vendorAgentId: insertResult.row.vendor_agent_id ?? undefined,
        vendorRunId: insertResult.row.vendor_run_id ?? undefined,
        vendorUrl: insertResult.row.vendor_url ?? undefined,
      }
    }

    await bindVendorExecution(env, reservationId, {
      agentId: req.agentId,
      runId: `run-${reservationId.slice(0, 8)}`,
      url: `mupot:inbox:${req.agentId}`,
      status: 'dispatched',
    })

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
      vendorRunId: `run-${reservationId.slice(0, 8)}`,
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
    }
  },

  async reconcile(env: Env, reservationId: string): Promise<ReconcileResult> {
    const row = await getReservation(env, reservationId)
    if (!row) {
      throw new Error(`reservation_not_found: ${reservationId}`)
    }

    const previousState = row.state
    const task = await loadTask(env, row.task_id)

    if (task && (task.status === 'done' || task.status === 'review')) {
      await markReconciled(env, reservationId, task.status)
      return {
        reservationId,
        previousState,
        nextState: 'reconciled',
        vendorStatus: task.status,
        changed: previousState !== 'reconciled',
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
