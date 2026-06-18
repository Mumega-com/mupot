// mupot — department microkernel: object-capability ctx types and port contracts.
//
// THE CONFINEMENT MECHANISM (§3.4 of console-department-microkernel.md).
//
// CF Workers give NO process isolation — "user space" is architectural, not physical,
// one bundle. Without this ctx layer, a department module that receives raw DB/KV/env
// makes capability confinement THEATER: it could read any tenant's data, write to any
// metric key, and bypass every gate.
//
// The fix: a module NEVER receives raw Env/DB/KV/session. The kernel mints a
// DepartmentCtx after resolving { tenantId, actor, departmentKey, capabilities }
// and hands the module only narrow port facades:
//   ctx.metrics.emit(...)  — validates key ownership + source authority + tenant bind
//   ctx.audit.write(...)   — capability-checked audit stub
//   ctx.gate.propose(...)  — capability-checked gate stub
//   ctx.bus.publish(...)   — capability-checked bus stub
//
// Invariants a test must prove (conformance harness §6):
//   - A ctx for tenant A cannot emit to or read from tenant B's data.
//   - A ctx cannot emit a metric key not in its department's metricsEmitted.
//   - A ctx cannot emit from a source not in the key's sourceAuthority.
//   - A ctx with insufficient capability is denied before any DB call.
//   - A module holding ctx has no raw DB/env handle — the Env type is never exposed.
//   - Mutating ctx.capabilities or ctx.metricsEmitted has NO effect on any check.
//   - The ctx object and all nested port objects are frozen (TypeError on mutation).
//
// EXPORT SURFACE INVARIANT (structural, not naming):
//   This file exports ONLY: pure types/interfaces and CtxError.
//   NO mint function, NO token, NO minting capability is exported from here.
//   All minting logic lives in kernel.ts as module-private code. Department modules
//   that import ctx.ts receive ONLY type definitions and CtxError — nothing that
//   can produce a ctx.

import type { D1Database } from '@cloudflare/workers-types'
import type { Capability } from '../types'
import type { MetricDescriptor } from './contract'
import type { EmitOutcome } from '../metrics/pulse'

// ── KernelHandle ──────────────────────────────────────────────────────────────
//
// Holds the raw D1 handle. Only the kernel (kernel.ts via registry.ts) holds one.
// Department modules never receive it.

export interface KernelHandle {
  /** Raw D1 database handle — held by kernel, never passed to department code. */
  db: D1Database
}

// ── DepartmentCtx ─────────────────────────────────────────────────────────────
//
// The object a department module operates through. It carries pre-resolved
// identity + pre-bound tenant + the narrow port facades.
//
// SECURITY NOTE: the fields ctx.capabilities and ctx.metricsEmitted are
// INERT FROZEN SNAPSHOTS (array of strings / frozen descriptor array).
// They are NOT the live instances the facade checks read. Mutating them —
// even via `(ctx.capabilities as any).push(...)` — has zero effect on any
// cap check or ownership check. The checks read closure-private consts inside
// kernel.ts.

export interface DepartmentCtx {
  /** Tenant id — immutably bound at mint time. Cannot be overridden by module code. */
  readonly tenantId: string
  /** The department module key this ctx is scoped to. */
  readonly departmentKey: string
  /**
   * Frozen snapshot of capability strings for display / introspection only.
   * The facade checks read the closure-private capSet in kernel.ts, NOT this field.
   * Mutating this array (even with `as any`) has NO effect on any check.
   */
  readonly capabilities: readonly Capability[]
  /**
   * Frozen snapshot of metric descriptors for display / introspection only.
   * The facade checks read the closure-private metricsEmitted Map in kernel.ts, NOT
   * this field. Mutating this array (even with `as any`) has NO effect on any
   * ownership check.
   */
  readonly metricsEmitted: readonly Readonly<MetricDescriptor>[]

  // Port facades — each is a narrow, capability-checked, tenant-bound function.
  readonly metrics: MetricsPort
  readonly audit: AuditPort
  readonly gate: GatePort
  readonly bus: BusPort
  /**
   * S4: executor port. Fail-closed — requires a real approval record per gateId.
   * Adapters are STUBBED at S4 (no external writes, no creds).
   * Closure-private in the kernel: channels cannot hold or call it directly.
   */
  readonly executor: ExecutorPort
}

// ── Port facade interfaces ─────────────────────────────────────────────────────

export interface MetricsEmitInput {
  key: string
  value: number
  occurredAt: string
  source: string
}

export interface MetricsPort {
  /**
   * Emit a metric reading. Tenant is bound from ctx (never from args).
   *
   * Rejects:
   *   - key not in ctx.metricsEmitted (ownership)
   *   - source not in descriptor.sourceAuthority (anti-pollution)
   *   - non-finite value (pulse guard, re-enforced here for defense-in-depth)
   *   - insufficient capability (requires 'member' minimum)
   */
  emit(input: MetricsEmitInput): Promise<EmitOutcome>
}

export interface AuditPort {
  /**
   * Write an audit event. Capability-checked + tenant-bound.
   *
   * TODO(full-impl): write to the audit log table with ctx.tenantId + ctx.departmentKey.
   * Shape is the contract; enforcement is ctx-first + capability-checked.
   */
  write(event: { action: string; payload?: unknown }): Promise<void>
}

export interface GatePort {
  /**
   * Propose a gated action (agent proposes, human authorizes — wake-not-steer).
   *
   * TODO(full-impl): write to gates table with ctx bindings.
   * Shape is the contract; enforcement is ctx-first + capability-checked.
   */
  propose(proposal: { action: string; payload?: unknown }): Promise<{ gateId: string }>
}

export interface BusPort {
  /**
   * Publish a bus message. Tenant-bound + capability-checked.
   *
   * TODO(full-impl): publish via the CF Queue binding with ctx.tenantId envelope.
   * Shape is the contract; enforcement is ctx-first + capability-checked.
   */
  publish(msg: { type: string; payload?: unknown }): Promise<void>
}

// ── ExecutorPort ──────────────────────────────────────────────────────────────
//
// S4: the gated-ACT port. Only the kernel can mint this. Channels never hold it.
//
// execute() is fail-closed: it REQUIRES a real approval record for the work item
// before dispatching to any adapter. No approval → throws CtxError('not_approved').
//
// Adapters are STUBBED at S4 — each returns
//   { executed: false, reason: 'executor_not_wired' }
// with NO external writes, NO fetch, NO credentials. The port + the dispatch +
// the fail-closed authority surface is the S4 build; real adapters (inkwell-content,
// mcpwp) are a later connector increment.
//
// S-LOOP SEAM (auto-act policy — NOT built at S4):
//   The S-loop's policy engine (auto-act low-risk within envelope vs always-gate)
//   will call execute() from inside its decision path. At S4 every executable
//   action requires human approval: the auto-act fast-path is intentionally absent.
//   When S-loop is built, the entry point is: policy decides → if approved-auto →
//   mint an approval record via the policy authority → call execute().
//   The fail-closed check here (real approval required) always holds — the S-loop
//   adapter must produce a real record, not a bypass.

export interface ApprovedWorkItem {
  /** The gate record id returned by gate.propose() for this piece of work. */
  gateId: string
  /** The work-type action key (must match the gated record). */
  action: string
  /** The original proposal payload. */
  payload?: unknown
}

export interface ExecuteOutcome {
  /** Always false at S4 — real adapters are not wired yet. */
  executed: boolean
  /** Reason when executed=false: 'executor_not_wired' at S4. */
  reason?: string
  /** Which adapter was targeted (e.g. 'inkwell-content' | 'mcpwp'). */
  adapter?: string
}

export interface ExecutorPort {
  /**
   * Execute an approved piece of work, dispatching to the pot's configured adapter.
   *
   * FAIL-CLOSED: throws CtxError('not_approved') if no real approval record
   * exists for this gateId. A gated record that has not been approved by a human
   * via the /approvals gate MUST NOT execute — ever.
   *
   * @param approvedWork - The approved work item (gateId + action + payload).
   * @returns ExecuteOutcome — at S4 always { executed: false, reason: 'executor_not_wired' }.
   */
  execute(approvedWork: ApprovedWorkItem): Promise<ExecuteOutcome>
}

// ── CtxError ─────────────────────────────────────────────────────────────────

export class CtxError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    // Include the code in the message so `.toThrow(/code/)` patterns work in tests.
    super(`[${code}] ${message}`)
    this.code = code
  }
}
