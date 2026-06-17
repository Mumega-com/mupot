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

import type { D1Database } from '@cloudflare/workers-types'
import type { Capability } from '../types'
import type { DepartmentModule, MetricDescriptor } from './contract'
import { emitMetric } from '../metrics/pulse'
import type { EmitOutcome } from '../metrics/pulse'

// ── Kernel-mint token ─────────────────────────────────────────────────────────
//
// An unforgeable module-private Symbol. mintCtx() requires this token as its
// first argument. Because the Symbol is NOT exported from this module, department
// code (which never imports from ctx.ts directly) cannot call mintCtx.
//
// Only the kernel (registry.ts) holds a reference, obtained via the exported
// accessor acquireKernelToken() — which itself is guarded so it can only be
// called once (by the kernel at boot).

const KERNEL_TOKEN = Symbol('mupot.kernel.mint')

// Tracks whether the token has been handed out. The kernel calls
// acquireKernelToken() exactly once at module load time.
let _tokenAcquired = false

/**
 * Called ONCE — by registry.ts at module load — to acquire the kernel mint token.
 * Returns the token on first call. Throws on any subsequent call.
 *
 * The token is then used internally by registry.ts's kernelMintCtx() wrapper, which
 * is the only public path for creating a DepartmentCtx in production and in tests.
 * Department modules NEVER import or call this function.
 */
export function acquireKernelToken(): symbol {
  if (_tokenAcquired) {
    throw new Error(
      '[kernel_token_already_acquired] The kernel mint token may only be acquired once. ' +
        'Department modules must not call acquireKernelToken.',
    )
  }
  _tokenAcquired = true
  return KERNEL_TOKEN
}

/**
 * Verify that a given symbol IS the kernel token (for testing the gate itself).
 * Returns true only when the symbol is the real KERNEL_TOKEN.
 * Used by the test harness to prove that a wrong symbol is rejected.
 */
export function _isKernelToken(sym: symbol): boolean {
  return sym === KERNEL_TOKEN
}

// ── Sealed kernel handle ──────────────────────────────────────────────────────
//
// KernelHandle is passed to mintCtx(). It is intentionally NOT exported from
// this module — only the kernel (registry.ts) holds one. A department module
// only receives DepartmentCtx.

interface KernelHandle {
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

// ── mintCtx ───────────────────────────────────────────────────────────────────
//
// The ONLY path through which a DepartmentCtx is created. Called by the kernel
// (registry.ts) after resolving tenant + actor + capabilities. A department module
// never calls mintCtx; it receives the ctx.
//
// REQUIRES the kernel-mint token as first argument. Throws if the token is wrong.

export function mintCtx(
  kernelToken: symbol,
  handle: KernelHandle,
  opts: {
    tenantId: string
    departmentKey: string
    module: DepartmentModule
    capabilities: Capability[]
    /** Optional injected clock for deterministic tests (default: Date.now / crypto.randomUUID). */
    now?: () => string
    idGen?: () => string
  },
): DepartmentCtx {
  // ── Token gate — only the kernel may mint ctx ──────────────────────────────
  if (kernelToken !== KERNEL_TOKEN) {
    throw new CtxError(
      'kernel_token_invalid',
      'mintCtx requires the kernel mint token — department modules may not call mintCtx directly',
    )
  }

  const { tenantId, departmentKey, module, capabilities } = opts
  const nowFn = opts.now ?? (() => new Date().toISOString())
  const idFn = opts.idGen ?? (() => crypto.randomUUID())

  // ── Closure-private authority state (NOT exposed on ctx) ──────────────────
  //
  // These are the instances the facade checks read. They are private to this
  // closure. Mutating ctx.capabilities or ctx.metricsEmitted (the frozen
  // snapshots) has zero effect here.
  const _capSet: ReadonlySet<Capability> = new Set(capabilities)

  // Build a fast-lookup descriptor map keyed by metric key.
  // Deep-freeze each descriptor + its sourceAuthority array.
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
      // Capability check — minimum 'member' to emit metrics.
      if (!hasCapability(_capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to emit metrics`,
        )
      }

      // Key ownership check — reads from closure-private _metricsMap, NOT ctx field.
      const descriptor = _metricsMap.get(input.key)
      if (!descriptor) {
        throw new CtxError(
          'key_not_owned',
          `ctx(${departmentKey}@${tenantId}): metric key '${input.key}' is not declared in metricsEmitted for this department`,
        )
      }

      // Source authority check — reads from frozen descriptor.sourceAuthority array.
      if (!descriptor.sourceAuthority.includes(input.source)) {
        throw new CtxError(
          'source_not_authorized',
          `ctx(${departmentKey}@${tenantId}): source '${input.source}' is not in sourceAuthority for metric '${input.key}' (allowed: ${descriptor.sourceAuthority.join(', ')})`,
        )
      }

      // Non-finite guard (defense-in-depth; pulse.emitMetric also checks this).
      if (!Number.isFinite(input.value)) {
        throw new CtxError(
          'value_not_finite',
          `ctx(${departmentKey}@${tenantId}): metric value must be finite (got ${input.value})`,
        )
      }

      // Tenant is bound from closure-private tenantId — NEVER from input args.
      // emitMetric requires an explicit id + createdAt (no Date.now() inside the spine).
      const emitId = idFn()
      const emitCreatedAt = nowFn()
      return emitMetric(
        handle.db,
        {
          tenantId,          // always the closure-bound tenant, not caller-supplied
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

  // ── audit facade (stub — shape is the contract) ────────────────────────────

  const audit: AuditPort = Object.freeze({
    async write(event: { action: string; payload?: unknown }): Promise<void> {
      if (!hasCapability(_capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to write audit`,
        )
      }
      // TODO(full-impl): insert into audit log table with tenantId + departmentKey.
      void event
    },
  })

  // ── gate facade (stub — shape is the contract) ─────────────────────────────

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

  // ── bus facade (stub — shape is the contract) ──────────────────────────────

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

  // ── Build inert frozen snapshots for ctx.capabilities / ctx.metricsEmitted ──
  //
  // These are COPIES — mutating them has zero effect on _capSet or _metricsMap.
  const capSnapshot: readonly Capability[] = Object.freeze([...capabilities])
  const metricsSnapshot: readonly Readonly<MetricDescriptor>[] = Object.freeze(
    [..._metricsMap.values()],
  )

  // Return a fully frozen ctx. Every nested object is already frozen above.
  // Using Object.freeze at the top level prevents tenantId/departmentKey re-binding.
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

// ── Internal helper ────────────────────────────────────────────────────────────
//
// Capability ladder (mirrors capability.ts). Kept private here — ctx facades do
// NOT call the authz module (no circular dep). This is a structural check only;
// the full RBAC (grants, scope inheritance) lives in auth/capability.ts.

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
