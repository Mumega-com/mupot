// src/harness/adapters/cursor.ts — Cursor Cloud Harness Adapter.
//
// Implements HarnessAdapter SPI for ephemeral Cursor Cloud agents:
// - Fast pre-reservation in Mupot D1 (<200ms) to beat the 30s MCP client timeout.
// - Asynchronous attachment via ToolCtx.waitUntil or background reconcile.
// - Status polling and terminal state reconciliation.

import type { Env } from '../../types'
import { getCursorRun, resolveCursorApiToken } from '../../cursor/client'
import { kernelFlightSignals, DEFAULT_CURSOR_RUN_ESTIMATE_CENTS, MICRO_USD_PER_CENT } from '../kernel'
import {
  attachCursorCloudExecution,
  reserveCursorCloudWork,
} from '../../cursor/dispatch'
import {
  getReservation,
  isReservationStuck,
  markReconciled,
  markReservationFailed,
  type HarnessReservationRow,
} from '../reservations'
import { ExecutionPausedError } from '../pause'
import type {
  DispatchRequest,
  DispatchOutcome,
  HarnessContext,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredentialNeeds,
  ReconcileResult,
  RunStatusResult,
  StatusQuery,
} from '../types'

/**
 * Public error vocabulary. Raw exception text (D1/SQL, vendor) is NEVER returned to callers: anything outside
 * this set (after stripping a `: detail` suffix) collapses to `dispatch_failed`.
 */
const PUBLIC_ERROR_CODES = new Set([
  'idempotency_key_conflict',
  'execution_paused',
  'flight_gate_held',
  'launch_unconfirmed',
  'bind_unconfirmed',
  'bind_lost_lease',
  'cursor_token_missing',
  'provider_disabled',
  'budget_blocked',
  'repo_url_required',
  'reservation_unbound',
  'reserve_failed',
  'task_missing',
  'attach_failed',
])

export function publicHarnessError(raw: string | undefined | null): string {
  if (!raw) return 'attach_failed'
  const code = raw.split(':')[0]?.trim() ?? ''
  return PUBLIC_ERROR_CODES.has(code) ? code : 'dispatch_failed'
}

/** Report the row's real in-flight state: 'attaching' is never relabelled 'reserved'. */
export function acceptedStateOf(state: string): 'reserved' | 'attaching' | 'attached' {
  if (state === 'attached') return 'attached'
  if (state === 'attaching') return 'attaching'
  return 'reserved'
}

export const cursorCloudAdapter: ProviderAdapter = {
  kind: 'cursor-cloud',

  capabilities(): ProviderCapabilities {
    return {
      kind: 'cursor-cloud',
      usage: 'none', // Cursor exposes no per-run usage: the kernel books the flat estimate, marked estimate=true
      vendorBudget: false,
      callback: 'none', // whether Cursor's API accepts a per-run MCP credential is unverified: no run token is minted
      webhook: false,
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

  credentialNeeds(): ProviderCredentialNeeds {
    return { slot: 'cursor_api', kinds: ['operator'] }
  },

  /** Flat per-run estimate (cents, default 50): the meter reserves against it and finalize books it (estimate=true). */
  estimate(env: Env): number {
    const raw = Number(env.CURSOR_RUN_ESTIMATE_CENTS)
    return (Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CURSOR_RUN_ESTIMATE_CENTS) * MICRO_USD_PER_CENT
  },

  launch(env: Env, req: DispatchRequest, ctx?: HarnessContext): Promise<DispatchOutcome> {
    return cursorCloudAdapter.dispatch(env, req, ctx)
  },

  async usage(): Promise<null> {
    return null
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
        preflightSignals: await kernelFlightSignals(env, req.agentId, cursorCloudAdapter.estimate(env, req)),
      })

      if (reserved.state === 'failed') {
        // The real reason (flight gate, launch_unconfirmed, ...) lives on the row; never invent flight_gate_held.
        return {
          accepted: false,
          error: publicHarnessError(reserved.row.last_error),
          reservationId: reserved.reservationId,
          taskId: reserved.task?.id ?? reserved.row.task_id,
          flightId: reserved.flight?.id ?? reserved.row.flight_id,
        }
      }

      if (reserved.replay && reserved.state === 'attached') {
        return {
          accepted: true,
          state: 'attached',
          reservationId: reserved.reservationId,
          taskId: reserved.task?.id ?? reserved.row.task_id,
          flightId: reserved.flight?.id ?? reserved.row.flight_id,
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
          state: acceptedStateOf(reserved.state),
          reservationId: reserved.reservationId,
          taskId: reserved.task?.id ?? reserved.row.task_id,
          flightId: reserved.flight?.id ?? reserved.row.flight_id,
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
      if (attached.state === 'failed' || attached.error === 'execution_paused') {
        return {
          accepted: false,
          error: publicHarnessError(attached.error),
          reservationId: reserved.reservationId,
          taskId: reserved.task?.id ?? reserved.row.task_id,
          flightId: reserved.flight?.id ?? reserved.row.flight_id,
        }
      }
      return {
        accepted: true,
        state: acceptedStateOf(attached.state),
        reservationId: reserved.reservationId,
        taskId: reserved.task?.id ?? reserved.row.task_id,
        flightId: reserved.flight?.id ?? reserved.row.flight_id,
        adapter: 'cursor-cloud',
        idempotencyKey: req.idempotencyKey,
        replay: reserved.replay || attached.replay,
        vendorAgentId: attached.cursor?.agentId,
        vendorRunId: attached.cursor?.runId,
        vendorUrl: attached.cursor?.agentUrl,
      }
    } catch (error) {
      if (error instanceof ExecutionPausedError) return { accepted: false, error: 'execution_paused' }
      // Fixed code only: raw DB/vendor exception text must never reach the caller.
      const msg = error instanceof Error ? error.message : ''
      return { accepted: false, error: publicHarnessError(msg) }
    }
  },

  async status(env: Env, query: StatusQuery): Promise<RunStatusResult> {
    let row = query.reservationId ? await getReservation(env, query.reservationId) : null
    if (!row && query.taskId) {
      row = await env.DB.prepare(
        `SELECT * FROM harness_reservations WHERE tenant = ? AND task_id = ?`,
      )
        .bind(env.TENANT_SLUG, query.taskId)
        .first<HarnessReservationRow>()
    }
    const stuck = row ? isReservationStuck(row) : false

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
          ...(stuck ? { stuck } : {}),
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
          ...(stuck ? { stuck } : {}),
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
      ...(stuck ? { stuck } : {}),
    }
  },

  async reconcile(env: Env, reservationId: string): Promise<ReconcileResult> {
    const row = await getReservation(env, reservationId)
    if (!row) {
      throw new Error(`reservation_not_found: ${reservationId}`)
    }

    const previousState = row.state

    if (row.state === 'reserved' && !row.task_id) {
      // Insert-first crash window: the inserter died before binding Task/Flight. Past the stuck horizon the key is
      // failed (never launched); before it, the inserter may still be working.
      if (isReservationStuck(row)) {
        const failed = await markReservationFailed(env, reservationId, 'reserve_failed: unbound_timeout')
        return { reservationId, previousState, nextState: failed ? 'failed' : previousState, changed: failed }
      }
      return { reservationId, previousState, nextState: previousState, changed: false }
    }

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
        const changed = await markReconciled(env, reservationId, run.status)
        return {
          reservationId,
          previousState,
          nextState: changed ? 'reconciled' : previousState,
          vendorStatus: run.status,
          changed,
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
