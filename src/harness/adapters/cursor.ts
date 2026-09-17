// src/harness/adapters/cursor.ts — Cursor Cloud Harness Adapter.
//
// Implements HarnessAdapter SPI for ephemeral Cursor Cloud agents:
// - Fast pre-reservation in Mupot D1 (<200ms) to beat the 30s MCP client timeout.
// - Asynchronous attachment via ToolCtx.waitUntil or background reconcile.
// - Status polling and terminal state reconciliation.

import type { Env } from '../../types'
import { getCursorRun, resolveCursorApiToken } from '../../cursor/client'
import {
  attachCursorCloudExecution,
  reserveCursorCloudWork,
} from '../../cursor/dispatch'
import {
  getReservation,
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

export const cursorCloudAdapter: HarnessAdapter = {
  kind: 'cursor-cloud',

  capabilities(): HarnessCapabilities {
    return {
      kind: 'cursor-cloud',
      launch: true,
      followUp: true,
      status: true,
      cancel: false,
      asyncAttach: true,
      requiresRepoUrl: true,
      requiresApiToken: true,
    }
  },

  isAvailable(env: Env): boolean {
    return Boolean(resolveCursorApiToken(env))
  },

  async dispatch(
    env: Env,
    req: DispatchRequest,
    ctx?: HarnessContext,
  ): Promise<DispatchOutcome> {
    if (!req.repoUrl) {
      return { accepted: false, error: 'repo_url_required' }
    }
    const token = resolveCursorApiToken(env)
    if (!token) {
      return { accepted: false, error: 'cursor_token_missing' }
    }

    try {
      const reserved = await reserveCursorCloudWork(env, {
        name: req.name,
        repoUrl: req.repoUrl,
        prompt: req.prompt,
        squadId: req.squadId,
        agentId: req.agentId,
        actor: req.actor,
        idempotencyKey: req.idempotencyKey,
        model: req.model,
        flightId: req.flightId,
        taskId: req.taskId,
      })

      if (reserved.state === 'failed') {
        return {
          accepted: false,
          error: 'flight_gate_held',
          reservationId: reserved.reservationId,
          taskId: reserved.task.id,
          flightId: reserved.flight.id,
        }
      }

      if (reserved.replay && reserved.state === 'attached') {
        return {
          accepted: true,
          state: 'attached',
          reservationId: reserved.reservationId,
          taskId: reserved.task.id,
          flightId: reserved.flight.id,
          adapter: 'cursor-cloud',
          idempotencyKey: req.idempotencyKey,
          replay: true,
          vendorAgentId: reserved.row.vendor_agent_id ?? undefined,
          vendorRunId: reserved.row.vendor_run_id ?? undefined,
          vendorUrl: reserved.row.vendor_url ?? undefined,
        }
      }

      if (ctx?.waitUntil) {
        ctx.waitUntil(
          attachCursorCloudExecution(env, reserved.reservationId, { model: req.model })
            .catch((err) => {
              console.error('attachCursorCloudExecution async failure:', err)
            }),
        )
        return {
          accepted: true,
          state: (reserved.state === 'attached' ? 'attached' : 'reserved') as 'reserved' | 'attached',
          reservationId: reserved.reservationId,
          taskId: reserved.task.id,
          flightId: reserved.flight.id,
          adapter: 'cursor-cloud',
          idempotencyKey: req.idempotencyKey,
          replay: reserved.replay,
          vendorAgentId: reserved.row.vendor_agent_id ?? undefined,
          vendorRunId: reserved.row.vendor_run_id ?? undefined,
          vendorUrl: reserved.row.vendor_url ?? undefined,
        }
      }

      // Synchronous attach fallback (for unit tests or non-waitUntil callers)
      const attached = await attachCursorCloudExecution(env, reserved.reservationId, { model: req.model })
      if (attached.state === 'failed') {
        return {
          accepted: false,
          error: attached.error ?? 'attach_failed',
          reservationId: reserved.reservationId,
          taskId: reserved.task.id,
          flightId: reserved.flight.id,
        }
      }
      return {
        accepted: true,
        state: attached.state === 'attached' ? 'attached' : 'reserved',
        reservationId: reserved.reservationId,
        taskId: reserved.task.id,
        flightId: reserved.flight.id,
        adapter: 'cursor-cloud',
        idempotencyKey: req.idempotencyKey,
        replay: attached.replay,
        vendorAgentId: attached.cursor?.agentId,
        vendorRunId: attached.cursor?.runId,
        vendorUrl: attached.cursor?.agentUrl,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return {
        accepted: false,
        error: msg.startsWith('idempotency_key_conflict') ? 'idempotency_key_conflict' : msg,
      }
    }
  },

  async status(env: Env, query: StatusQuery): Promise<RunStatusResult> {
    let row = query.reservationId ? await getReservation(env, query.reservationId) : null
    if (!row && query.taskId) {
      const res = await env.DB.prepare(
        `SELECT * FROM harness_reservations WHERE tenant = ? AND task_id = ?`,
      )
        .bind(env.TENANT_SLUG, query.taskId)
        .first()
      row = res as any
    }

    const token = resolveCursorApiToken(env)
    const agentId = query.vendorAgentId ?? row?.vendor_agent_id
    const runId = query.vendorRunId ?? row?.vendor_run_id

    if (!row && (!agentId || !runId)) {
      throw new Error('reservation_or_vendor_ids_required')
    }

    const reservationId = row?.id ?? `adhoc:${agentId}`
    const state = row?.state ?? 'attached'

    if (token && agentId && runId) {
      try {
        const run = await getCursorRun(token, agentId, runId)
        const branch = run.git?.branches?.[0]
        return {
          reservationId,
          adapter: 'cursor-cloud',
          state,
          vendorStatus: run.status,
          vendorAgentId: agentId,
          vendorRunId: runId,
          vendorUrl: row?.vendor_url ?? `https://cursor.com/agents/${agentId}`,
          prUrl: branch?.prUrl ?? null,
          branch: branch?.branch ?? null,
          result: run.result ?? null,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          reservationId,
          adapter: 'cursor-cloud',
          state,
          vendorAgentId: agentId,
          vendorRunId: runId,
          vendorUrl: row?.vendor_url ?? undefined,
          error: msg,
        }
      }
    }

    return {
      reservationId,
      adapter: 'cursor-cloud',
      state,
      vendorAgentId: agentId ?? undefined,
      vendorRunId: runId ?? undefined,
      vendorUrl: row?.vendor_url ?? undefined,
      error: row?.last_error ?? undefined,
    }
  },

  async reconcile(env: Env, reservationId: string): Promise<ReconcileResult> {
    const row = await getReservation(env, reservationId)
    if (!row) {
      throw new Error(`reservation_not_found: ${reservationId}`)
    }

    const previousState = row.state

    if (row.state === 'reserved' || row.state === 'attaching') {
      const attached = await attachCursorCloudExecution(env, reservationId)
      return {
        reservationId,
        previousState,
        nextState: attached.state,
        changed: attached.state !== previousState,
      }
    }

    if (row.state === 'attached' && row.vendor_agent_id && row.vendor_run_id) {
      const token = resolveCursorApiToken(env)
      if (!token) {
        return { reservationId, previousState, nextState: previousState, changed: false }
      }

      const run = await getCursorRun(token, row.vendor_agent_id, row.vendor_run_id)
      const terminalStatuses = ['FINISHED', 'ERROR', 'CANCELLED', 'EXPIRED']
      if (terminalStatuses.includes(run.status)) {
        await markReconciled(env, reservationId, run.status)
        return {
          reservationId,
          previousState,
          nextState: 'reconciled',
          vendorStatus: run.status,
          changed: true,
        }
      }

      return {
        reservationId,
        previousState,
        nextState: previousState,
        vendorStatus: run.status,
        changed: false,
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
