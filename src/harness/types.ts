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
  metadata?: Record<string, unknown>
}

export interface DispatchResult {
  accepted: true
  state: Extract<HarnessDispatchState, 'reserved' | 'attaching' | 'attached'>
  reservationId: string
  taskId: string
  flightId: string
  adapter: HarnessKind
  idempotencyKey: string
  replay: boolean
  vendorAgentId?: string
  vendorRunId?: string
  vendorUrl?: string
}

export interface DispatchFailure {
  accepted: false
  error: string
  detail?: unknown
  reservationId?: string
  taskId?: string
  flightId?: string
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
  vendorStatus?: string
  vendorAgentId?: string
  vendorRunId?: string
  vendorUrl?: string
  prUrl?: string | null
  branch?: string | null
  result?: string | null
  error?: string | null
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
