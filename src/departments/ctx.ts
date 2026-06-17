// mupot — department microkernel: object-capability ctx + port facades.
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
//   This file exports ONLY: types/interfaces, CtxError, createMintSeam.
//   mintCtx, acquireKernelToken, _isKernelToken, and KERNEL_TOKEN are NOT exported.
//   createMintSeam() is the single seam kernel.ts uses to obtain minting capability
//   at module-load time; it is not useful to a department module because the token
//   it returns only works with the specific mint function it co-returns.
//   A department module that imports ctx.ts receives NO function that can mint
//   a ctx without having first obtained the matching token from the same createMintSeam()
//   call — and since kernel.ts holds that call private, the boundary is real.

import type { D1Database } from '@cloudflare/workers-types'
import type { Capability } from '../types'
import type { DepartmentModule, MetricDescriptor } from './contract'
import { emitMetric } from '../metrics/pulse'
import type { EmitOutcome } from '../metrics/pulse'

// ── KernelHandle ──────────────────────────────────────────────────────────────
//
// Holds the raw D1 handle. Only the kernel (registry.ts via kernel.ts) holds one.
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
// cap check or ownership check. The checks read closure-private consts.

export interface DepartmentCtx {
  /** Tenant id — immutably bound at mint time. Cannot be overridden by module code. */
  readonly tenantId: string
  /** The department module key this ctx is scoped to. */
  readonly departmentKey: string
  /**
   * Frozen snapshot of capability strings for display / introspection only.
   * The facade checks read the closure-private capSet, NOT this field.
   * Mutating this array (even with `as any`) has NO effect on any check.
   */
  readonly capabilities: readonly Capability[]
  /**
   * Frozen snapshot of metric descriptors for display / introspection only.
   * The facade checks read the closure-private metricsEmitted Map, NOT this field.
   * Mutating this array (even with `as any`) has NO effect on any ownership check.
   */
  readonly metricsEmitted: readonly Readonly<MetricDescriptor>[]

  // Port facades — each is a narrow, capability-checked, tenant-bound function.
  readonly metrics: MetricsPort
  readonly audit: AuditPort
  readonly gate: GatePort
  readonly bus: BusPort
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

// ── CtxError ─────────────────────────────────────────────────────────────────

export class CtxError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    // Include the code in the message so `.toThrow(/code/)` patterns work in tests.
    super(`[${code}] ${message}`)
    this.code = code
  }
}

// ── Capability ladder (module-private) ────────────────────────────────────────
//
// Kept private here — ctx facades do NOT call the authz module (no circular dep).
// This is a structural check only; the full RBAC (grants, scope inheritance) lives
// in auth/capability.ts.

const RANK: Record<Capability, number> = {
  observer: 1,
  member: 2,
  lead: 3,
  admin: 4,
  owner: 5,
}

function hasCapability(caps: ReadonlySet<Capability>, min: Capability): boolean {
  for (const c of caps) {
    if ((RANK[c] ?? 0) >= (RANK[min] ?? 0)) return true
  }
  return false
}

// ── mintCtxInternal (module-private — NOT exported) ───────────────────────────
//
// The actual minting logic. Called only by the factory returned from
// createMintSeam(). Never exported, never reachable by department module code.

function mintCtxInternal(
  callerToken: symbol,
  realToken: symbol,
  handle: KernelHandle,
  opts: {
    tenantId: string
    departmentKey: string
    module: DepartmentModule
    capabilities: Capability[]
    now?: () => string
    idGen?: () => string
  },
): DepartmentCtx {
  // ── Token gate ─────────────────────────────────────────────────────────────
  if (callerToken !== realToken) {
    throw new CtxError(
      'kernel_token_invalid',
      'mintCtx requires the kernel mint token — department modules may not call mintCtx directly',
    )
  }

  const { tenantId, departmentKey, module, capabilities } = opts
  const nowFn = opts.now ?? (() => new Date().toISOString())
  const idFn = opts.idGen ?? (() => crypto.randomUUID())

  // ── Closure-private authority state (NOT exposed on ctx) ──────────────────
  const _capSet: ReadonlySet<Capability> = new Set(capabilities)

  const _metricsMap = new Map<string, Readonly<MetricDescriptor>>(
    module.metricsEmitted.map((d) => {
      const frozen: Readonly<MetricDescriptor> = Object.freeze({
        ...d,
        sourceAuthority: Object.freeze([...d.sourceAuthority]) as readonly string[],
        display: Object.freeze({ ...d.display }),
      })
      return [d.key, frozen]
    }),
  )

  // ── metrics facade ────────────────────────────────────────────────────────

  const metrics: MetricsPort = Object.freeze({
    async emit(input: MetricsEmitInput): Promise<EmitOutcome> {
      if (!hasCapability(_capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to emit metrics`,
        )
      }

      const descriptor = _metricsMap.get(input.key)
      if (!descriptor) {
        throw new CtxError(
          'key_not_owned',
          `ctx(${departmentKey}@${tenantId}): metric key '${input.key}' is not declared in metricsEmitted for this department`,
        )
      }

      if (!descriptor.sourceAuthority.includes(input.source)) {
        throw new CtxError(
          'source_not_authorized',
          `ctx(${departmentKey}@${tenantId}): source '${input.source}' is not in sourceAuthority for metric '${input.key}' (allowed: ${descriptor.sourceAuthority.join(', ')})`,
        )
      }

      if (!Number.isFinite(input.value)) {
        throw new CtxError(
          'value_not_finite',
          `ctx(${departmentKey}@${tenantId}): metric value must be finite (got ${input.value})`,
        )
      }

      const emitId = idFn()
      const emitCreatedAt = nowFn()
      return emitMetric(
        handle.db,
        {
          tenantId,
          metricKey: input.key,
          value: input.value,
          occurredAt: input.occurredAt,
          source: input.source,
        },
        emitId,
        emitCreatedAt,
      )
    },
  })

  // ── audit facade ──────────────────────────────────────────────────────────

  const audit: AuditPort = Object.freeze({
    async write(event: { action: string; payload?: unknown }): Promise<void> {
      if (!hasCapability(_capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to write audit`,
        )
      }
      void event
    },
  })

  // ── gate facade ───────────────────────────────────────────────────────────

  const gate: GatePort = Object.freeze({
    async propose(proposal: { action: string; payload?: unknown }): Promise<{ gateId: string }> {
      if (!hasCapability(_capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to propose`,
        )
      }
      void proposal
      return { gateId: `stub-${tenantId}-${departmentKey}-${nowFn()}` }
    },
  })

  // ── bus facade ────────────────────────────────────────────────────────────

  const bus: BusPort = Object.freeze({
    async publish(msg: { type: string; payload?: unknown }): Promise<void> {
      if (!hasCapability(_capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to publish`,
        )
      }
      void msg
    },
  })

  // ── Build inert frozen snapshots ──────────────────────────────────────────
  const capSnapshot: readonly Capability[] = Object.freeze([...capabilities])
  const metricsSnapshot: readonly Readonly<MetricDescriptor>[] = Object.freeze(
    [..._metricsMap.values()],
  )

  return Object.freeze({
    tenantId,
    departmentKey,
    capabilities: capSnapshot,
    metricsEmitted: metricsSnapshot,
    metrics,
    audit,
    gate,
    bus,
  } satisfies DepartmentCtx)
}

// ── createMintSeam ────────────────────────────────────────────────────────────
//
// STRUCTURAL BOUNDARY: this is the single seam through which minting capability
// is obtained. kernel.ts calls createMintSeam() ONCE at module load and holds the
// result in a module-private const — the token and the mint function never leave
// kernel.ts.
//
// Why this is a real boundary (not a naming convention):
//   - The `token` is a fresh Symbol created inside this call.
//   - The `mint` function validates that the caller passes the SAME symbol.
//   - A department module that imports ctx.ts gets CtxError and type exports only —
//     it receives NO token and NO mint function.
//   - Even if a module somehow called createMintSeam() itself, it would get a
//     DIFFERENT token (new Symbol each call) that the kernel's mint function would
//     reject. The kernel's token is bound at kernel.ts load time and is unreachable.
//
// The `isToken` helper lets kernel.ts test whether a given symbol is the real token
// (used in the conformance harness to prove the gate rejects wrong tokens).

export function createMintSeam(): {
  token: symbol
  mint: (
    callerToken: symbol,
    handle: KernelHandle,
    opts: {
      tenantId: string
      departmentKey: string
      module: DepartmentModule
      capabilities: Capability[]
      now?: () => string
      idGen?: () => string
    },
  ) => DepartmentCtx
  isToken: (sym: symbol) => boolean
} {
  const KERNEL_TOKEN = Symbol('mupot.kernel.mint')
  return {
    token: KERNEL_TOKEN,
    mint(callerToken, handle, opts) {
      return mintCtxInternal(callerToken, KERNEL_TOKEN, handle, opts)
    },
    isToken(sym) {
      return sym === KERNEL_TOKEN
    },
  }
}
