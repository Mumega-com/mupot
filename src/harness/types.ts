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
  /**
   * Set ONLY by the provider kernel, and only for an adapter whose `capabilities().callback` is 'mcp_token': a mupot credential
   * minted for THIS run (member tier, short TTL), revoked by the kernel's finalize. The adapter hands it to the vendor and never
   * stores or logs it; it is never read from env and never reaches a tool result.
   */
  runToken?: { raw: string; id: string }
}

export interface HarnessAdapter {
  readonly kind: HarnessKind
  capabilities(): HarnessCapabilities
  isAvailable(env: Env): boolean
  dispatch(env: Env, req: DispatchRequest, ctx?: HarnessContext): Promise<DispatchOutcome>
  status(env: Env, query: StatusQuery): Promise<RunStatusResult>
  reconcile(env: Env, reservationId: string): Promise<ReconcileResult>
}

// ── Provider adapter v2 ──────────────────────────────────────────────────────────────────────────────────────
//
// `harness-adapter/v1` (above) plus what the provider KERNEL (harness/kernel.ts) needs to hold the policy once, for every
// provider: the adapter is a thin vendor client, the kernel owns the kill switch, the budget gate, the run token and the
// settlement. An adapter never checks budgets, never mints tokens and never decides who may dispatch.

export const PROVIDER_ADAPTER_V2 = 'provider-adapter/v2' as const

/** What `usage()` can return for a finished run. 'none' = the vendor exposes no usage, so the kernel books the pre-call estimate. */
export type ProviderUsageKind = 'vendor_exact' | 'vendor_tokens' | 'none'

export interface ProviderCapabilities extends HarnessCapabilities {
  usage: ProviderUsageKind
  /** The vendor can enforce a hard per-run $ cap itself. */
  vendorBudget: boolean
  /** 'mcp_token': the run can be handed a mupot credential (the kernel mints and revokes one). 'none': it cannot. */
  callback: 'mcp_token' | 'none'
  /** The vendor can call a signed webhook (verifyWebhook). The reconcile cron is mandatory regardless: webhooks are lossy. */
  webhook: boolean
}

/** Which key slot an adapter needs. PR 1 only declares it; slot resolution (tenant BYOK vs operator) lands in a later PR. */
export type ProviderSlot = 'cursor_api' | 'anthropic_api' | 'openai_api'

export interface ProviderCredentialNeeds {
  /** null = no vendor key (a local adapter). */
  slot: ProviderSlot | null
  kinds: Array<'operator' | 'tenant_byok'>
}

/** What a finished run cost, as the VENDOR reports it (never the model's self-report). */
export interface ProviderUsage {
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  /** Authoritative vendor cost when the vendor states one, micro-USD. */
  costMicroUsd: number
}

export type ProviderCancelOutcome = 'cancelled' | 'already_terminal' | 'unsupported'

export interface ProviderAdapter extends HarnessAdapter {
  capabilities(): ProviderCapabilities
  credentialNeeds(): ProviderCredentialNeeds
  /** Micro-USD upper bound the meter reserves against BEFORE launch. Reads policy numbers from env, never a key, never the network. */
  estimate(env: Env, req: DispatchRequest): number
  /** Reserve + launch. For Cursor and Grok this is the existing `dispatch` (vendor I/O inside the attach step). */
  launch(env: Env, req: DispatchRequest, ctx?: HarnessContext): Promise<DispatchOutcome>
  /** Vendor-reported usage for a terminal run, or null when the vendor reports none. */
  usage(env: Env, run: { reservationId: string; vendorAgentId: string | null; vendorRunId: string | null }): Promise<ProviderUsage | null>
  cancel?(env: Env, run: { reservationId: string; vendorAgentId: string | null; vendorRunId: string | null }): Promise<ProviderCancelOutcome>
  verifyWebhook?(req: Request, secret: string): Promise<{ vendorRef: string; eventId: string } | null>
  /** Delete vendor-side artefacts (vaults, sessions) after settlement. Best effort. */
  cleanup?(env: Env, run: { reservationId: string; vendorAgentId: string | null; vendorRunId: string | null }): Promise<void>
}

export function isProviderAdapter(a: HarnessAdapter): a is ProviderAdapter {
  const p = a as Partial<ProviderAdapter>
  return typeof p.estimate === 'function' && typeof p.launch === 'function' && typeof p.usage === 'function' && typeof p.credentialNeeds === 'function'
}
