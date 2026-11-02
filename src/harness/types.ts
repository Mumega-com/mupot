// src/harness/types.ts — Harness Adapter SPI v1.
//
// Mupot is an AI operations microkernel governing tasks, flights, presence,
// runtimes, receipts, and budgets.
// This SPI abstracts how Mupot launches, tracks, and reconciles agent work across
// different execution harnesses (Cursor Cloud, Grok CLI, Hermes, Codex, etc.).
//
// Crucial distinction:
// - `runtime-adapter/v1` (docs/runtime-adapter-contract.md) governs how long-running
//   external processes ATTACH to Mupot and send/receive messages.
// - `harness-adapter/v1` (this SPI) governs how Mupot DISPATCHES and RESERVES vendor
//   or local agent runs, ensuring Mupot remains the authoritative control plane.

import type { Env } from '../types'

export const HARNESS_ADAPTER_V1 = 'harness-adapter/v1' as const

export type HarnessKind =
  | 'cursor-cloud'
  | 'grok-cli'
  | 'hermes'
  | 'codex-cli'
  | 'claude-code'
  | 'antigravity-cli'

export type HarnessDispatchState =
  | 'reserved'
  | 'attaching'
  | 'attached'
  | 'failed'
  | 'reconciled'

/**
 * Whether the WORK left Mupot. Deliberately separate from HarnessDispatchState, which tracks the
 * reservation record. The two diverge: a reservation can be `attached` to a vendor execution row
 * while nothing has been handed to any worker — Grok's record-only path is exactly that, and
 * reading `attached` as "the agent got it" is what this type exists to stop (mupot#2283).
 *
 *   reserved  — Mupot holds the reservation; nobody has been given the work
 *   delivered — the work reached a worker's queue (inbox row, or a vendor that accepted it)
 *   claimed   — a worker took it (lease held / task in progress under that runtime)
 */
export type HarnessDeliveryState = 'reserved' | 'delivered' | 'claimed'

export interface HarnessCapabilities {
  kind: HarnessKind
  launch: boolean
  followUp: boolean
  status: boolean
  cancel: boolean
  asyncAttach: boolean
  requiresRepoUrl: boolean
  requiresApiToken: boolean
}

export interface HarnessActor {
  kind: 'member' | 'agent'
  id: string
}

export interface DispatchRequest {
  name: string
  prompt: string
  repoUrl?: string
  model?: string
  squadId: string
  agentId: string
  actor: HarnessActor
  /** Caller-scoped idempotency key. Pattern: ^[A-Za-z0-9_.:-]{1,128}$ */
  idempotencyKey: string
  flightId?: string
  taskId?: string
  /**
   * Local (non-vendor) adapters only: anything other than an explicit `false` plans the dispatch and writes nothing
   * (same default as router_tick, #1780/#1807). Vendor-cloud adapters are gated by their own MCP tool.
   */
  dryRun?: boolean
  metadata?: Record<string, unknown>
}

export interface DispatchResult {
  accepted: true
  state: Extract<HarnessDispatchState, 'reserved' | 'attaching' | 'attached'>
  /**
   * Whether the work actually left Mupot. `state: 'attached'` with `delivery: 'reserved'` is a
   * recorded dispatch, not a delivery — callers must branch on this, never on `state` alone.
   */
  delivery: HarnessDeliveryState
  /**
   * Descriptive labels for this attempt. Recorded for audit; they grant NO authority. `model`,
   * `harness` and `host` are caller claims, not proofs, and no fence or grant may read them.
   */
  labels: AttemptLabels
  reservationId: string
  /** null = reserved, not yet bound to a Task/Flight. */
  taskId: string | null
  flightId: string | null
  adapter: HarnessKind
  idempotencyKey: string
  replay: boolean
  vendorAgentId?: string
  vendorRunId?: string
  vendorUrl?: string
}

export interface AttemptLabels {
  /** The harness kind that is actually running the attempt. */
  harness: HarnessKind
  model?: string | null
  /** Where it ran (machine name). Kept for the audit trail, not for routing. */
  host?: string | null
}

export interface DispatchFailure {
  accepted: false
  error: string
  detail?: unknown
  reservationId?: string
  taskId?: string | null
  flightId?: string | null
}

export type DispatchOutcome = DispatchResult | DispatchFailure

export interface StatusQuery {
  reservationId?: string
  taskId?: string
  flightId?: string
  vendorAgentId?: string
  vendorRunId?: string
}

export interface RunStatusResult {
  reservationId: string
  adapter: HarnessKind
  state: HarnessDispatchState
  /** Same distinction as DispatchResult.delivery: attached is not delivered. */
  delivery: HarnessDeliveryState
  labels?: AttemptLabels
  vendorStatus?: string
  vendorAgentId?: string
  vendorRunId?: string
  vendorUrl?: string
  prUrl?: string | null
  branch?: string | null
  result?: string | null
  error?: string | null
  /** true = reserved/attaching for longer than RESERVATION_STUCK_MS: needs a reconcile or operator. */
  stuck?: boolean
}

export interface ReconcileResult {
  reservationId: string
  previousState: HarnessDispatchState
  nextState: HarnessDispatchState
  vendorStatus?: string
  changed: boolean
}

export interface HarnessContext {
  waitUntil?: (promise: Promise<unknown>) => void
}

export interface HarnessAdapter {
  readonly kind: HarnessKind
  capabilities(): HarnessCapabilities
  isAvailable(env: Env): boolean
  dispatch(env: Env, req: DispatchRequest, ctx?: HarnessContext): Promise<DispatchOutcome>
  status(env: Env, query: StatusQuery): Promise<RunStatusResult>
  reconcile(env: Env, reservationId: string): Promise<ReconcileResult>
}
