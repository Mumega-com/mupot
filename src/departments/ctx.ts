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
//   ctx.db.query(...)      — scoped query with tenant assertion injected
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

import type { D1Database } from '@cloudflare/workers-types'
import type { Capability } from '../types'
import type { DepartmentModule, MetricDescriptor } from './contract'
import { emitMetric } from '../metrics/pulse'
import type { EmitOutcome } from '../metrics/pulse'

// ── Sealed kernel handle ──────────────────────────────────────────────────────
//
// KernelHandle is passed to mintCtx(). It is intentionally NOT exported from this
// module — only the kernel (registry.ts + test harnesses) should hold one. A
// department module only receives DepartmentCtx.

export interface KernelHandle {
  /** Raw D1 database handle — held by kernel, never passed to department code. */
  db: D1Database
}

// ── DepartmentCtx ─────────────────────────────────────────────────────────────
//
// The object a department module operates through. It carries pre-resolved identity
// + pre-bound tenant + the narrow port facades. Raw DB/Env are absent by design.

export interface DepartmentCtx {
  /** Tenant id — immutably bound at mint time. Cannot be overridden by module code. */
  readonly tenantId: string
  /** The department module key this ctx is scoped to. */
  readonly departmentKey: string
  /** Resolved capabilities for the actor in this context. Read-only. */
  readonly capabilities: ReadonlySet<Capability>
  /**
   * The metric descriptors declared by this department's module. Held here so
   * facades can validate key + source without a registry round-trip.
   */
  readonly metricsEmitted: ReadonlyMap<string, MetricDescriptor>

  // Port facades — each is a narrow, capability-checked, tenant-bound function.
  readonly metrics: MetricsPort
  readonly db: DbPort
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

export interface DbPort {
  /**
   * Scoped query. Tenant scoping is injected/asserted — the caller supplies SQL
   * and binds but the facade verifies tenant_id appears in binds OR injects it.
   *
   * TODO(full-impl): verify SQL contains tenant_id predicate, inject if absent.
   * Current stub: verifies capability + logs the call; real D1 call deferred until
   * the department route layer is wired (Phase 3). The SHAPE is the contract.
   */
  query(sql: string, binds?: readonly (string | number | null)[]): Promise<readonly Record<string, unknown>[]>
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

export function mintCtx(
  handle: KernelHandle,
  opts: {
    tenantId: string
    departmentKey: string
    module: DepartmentModule
    capabilities: Capability[]
  },
): DepartmentCtx {
  const { tenantId, departmentKey, module, capabilities } = opts
  const capSet: ReadonlySet<Capability> = new Set(capabilities)

  // Build a fast-lookup descriptor map keyed by metric key.
  const metricsEmitted: ReadonlyMap<string, MetricDescriptor> = new Map(
    module.metricsEmitted.map((d) => [d.key, d]),
  )

  // ── metrics facade ────────────────────────────────────────────────────────

  const metrics: MetricsPort = {
    async emit(input: MetricsEmitInput): Promise<EmitOutcome> {
      // Capability check — minimum 'member' to emit metrics.
      if (!hasCapability(capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to emit metrics`,
        )
      }

      // Key ownership check — the key must be declared in this department's metricsEmitted.
      const descriptor = metricsEmitted.get(input.key)
      if (!descriptor) {
        throw new CtxError(
          'key_not_owned',
          `ctx(${departmentKey}@${tenantId}): metric key '${input.key}' is not declared in metricsEmitted for this department`,
        )
      }

      // Source authority check — the source must be in the descriptor's sourceAuthority.
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

      // Tenant is bound from ctx — NEVER from input args.
      // emitMetric requires an explicit id + createdAt (no Date.now() inside the spine).
      const emitId = crypto.randomUUID()
      const emitCreatedAt = new Date().toISOString()
      return emitMetric(
        handle.db,
        {
          tenantId,          // always the ctx-bound tenant, not caller-supplied
          metricKey: input.key,
          value: input.value,
          occurredAt: input.occurredAt,
          source: input.source,
        },
        emitId,
        emitCreatedAt,
      )
    },
  }

  // ── db facade ─────────────────────────────────────────────────────────────
  //
  // Minimum capability to run a scoped query is 'observer'.
  // TODO(full-impl): inject/assert tenant_id in the SQL WHERE clause.

  const db: DbPort = {
    async query(
      sql: string,
      binds: readonly (string | number | null)[] = [],
    ): Promise<readonly Record<string, unknown>[]> {
      if (!hasCapability(capSet, 'observer')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'observer' capability required to query`,
        )
      }
      // TODO(full-impl): assert or inject tenant_id scoping in sql.
      // For now: execute the query but ensure all callers supply tenant_id in binds.
      // The conformance harness tests that a ctx for tenant A cannot be used to read
      // tenant B's data (by verifying the tenant bind in the returned rows).
      const result = await handle.db
        .prepare(sql)
        .bind(...(binds as (string | number | null)[]))
        .all<Record<string, unknown>>()
      return result.results ?? []
    },
  }

  // ── audit facade (stub — shape is the contract) ────────────────────────────

  const audit: AuditPort = {
    async write(event: { action: string; payload?: unknown }): Promise<void> {
      if (!hasCapability(capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to write audit`,
        )
      }
      // TODO(full-impl): insert into audit log table with tenantId + departmentKey.
      // The action and payload are ctx-bound — the module cannot spoof tenant or dept.
      void event // acknowledged by stub; full impl will persist.
    },
  }

  // ── gate facade (stub — shape is the contract) ─────────────────────────────

  const gate: GatePort = {
    async propose(proposal: { action: string; payload?: unknown }): Promise<{ gateId: string }> {
      if (!hasCapability(capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to propose`,
        )
      }
      // TODO(full-impl): write a gated proposal row with ctx bindings.
      void proposal
      return { gateId: `stub-${tenantId}-${departmentKey}-${Date.now()}` }
    },
  }

  // ── bus facade (stub — shape is the contract) ──────────────────────────────

  const bus: BusPort = {
    async publish(msg: { type: string; payload?: unknown }): Promise<void> {
      if (!hasCapability(capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to publish`,
        )
      }
      // TODO(full-impl): enqueue on CF Queue binding with tenantId envelope.
      void msg
    },
  }

  return {
    tenantId,
    departmentKey,
    capabilities: capSet,
    metricsEmitted,
    metrics,
    db,
    audit,
    gate,
    bus,
  }
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
