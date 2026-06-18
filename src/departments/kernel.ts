// mupot — department microkernel: kernel-private mint seam.
//
// This file holds ALL ctx minting logic. It is the ONLY file that can produce a
// DepartmentCtx. Nothing in this file's minting path is re-exported to department
// modules — the only exports are `kernelMintCtx` (a function, no token param) and
// `_isKernelToken` (a test-harness predicate, yields only true/false).
//
// IMPORT DISCIPLINE:
//   - Only registry.ts may import from this file.
//   - Department modules MUST NOT import from kernel.ts.
//   - ctx.ts exports ONLY types, interfaces, and CtxError — no mint logic.
//   - There is no circular dependency: ctx.ts → (no imports from kernel.ts);
//     kernel.ts → ctx.ts (for types + CtxError); registry.ts → kernel.ts.
//
// STRUCTURAL BOUNDARY (the single-truth statement):
//   In CF Workers there is no process isolation. The only real authority boundary
//   is "a symbol that is NEVER exported cannot be imported."
//
//   _KERNEL_TOKEN is a module-level const — never exported, never returned from
//   any exported function. _mintCtxInternal is a module-private function — same.
//   kernelMintCtx has the token baked into its call to _mintCtxInternal; callers
//   supply only (handle, opts). A department module that imports kernel.ts receives
//   kernelMintCtx — a function that ALREADY holds the token internally — and
//   _isKernelToken — a predicate that reveals only true/false.
//
//   Crucially: department modules are NOT supposed to import kernel.ts at all (only
//   registry.ts does). But even if one did, it still cannot obtain _KERNEL_TOKEN or
//   call _mintCtxInternal directly, because neither is exported.
//
//   ctx.ts has no mint logic at all — it is a pure types/contracts file. A module
//   that imports ctx.ts receives zero minting capability.

import type { Capability } from '../types'
import type { DepartmentModule, MetricDescriptor } from './contract'
import { emitMetric } from '../metrics/pulse'
import type { EmitOutcome } from '../metrics/pulse'

import {
  CtxError,
} from './ctx'
import type {
  KernelHandle,
  DepartmentCtx,
  MetricsPort,
  MetricsEmitInput,
  AuditPort,
  GatePort,
  BusPort,
} from './ctx'
import { composeDeptMetricDescriptors, deepFreezeChannels } from './channels/compose'

// Re-export types so registry.ts only needs to import from kernel.ts.
export type { KernelHandle, DepartmentCtx } from './ctx'

// ── Module-private kernel token ────────────────────────────────────────────────
//
// A unique unforgeable Symbol created once at module load. Never exported,
// never returned from any exported function. The only way to hold this value is
// to be running code inside this file's module scope.

const _KERNEL_TOKEN = Symbol('mupot.kernel.mint')

// ── Capability ladder (module-private) ────────────────────────────────────────
//
// Kept private — ctx facades do NOT call the authz module (no circular dep).
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

// ── _mintCtxInternal (module-private — NOT exported) ─────────────────────────
//
// The actual minting logic. Only called by kernelMintCtx (which supplies the
// real _KERNEL_TOKEN). Never exported.

function _mintCtxInternal(
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
): DepartmentCtx {
  // ── Token gate ─────────────────────────────────────────────────────────────
  if (callerToken !== _KERNEL_TOKEN) {
    throw new CtxError(
      'kernel_token_invalid',
      'kernelMintCtx requires the kernel mint token — department modules may not call this directly',
    )
  }

  const { tenantId, departmentKey, capabilities } = opts
  const nowFn = opts.now ?? (() => new Date().toISOString())
  const idFn = opts.idGen ?? (() => crypto.randomUUID())

  // ── WARN-2: departmentKey / module.key agreement check ────────────────────
  //
  // The two are supplied independently by the caller. A mismatch means the
  // authority map would be built for one key while the ctx is labelled with
  // another — a silent structural lie. Fail loudly at mint time instead.
  if (opts.departmentKey !== opts.module.key) {
    throw new CtxError(
      'key_mismatch',
      `kernelMintCtx: departmentKey '${opts.departmentKey}' does not match module.key '${opts.module.key}'`,
    )
  }

  // ── WARN-1: deep-freeze the module at the kernel boundary ─────────────────
  //
  // The caller may pass a mutable module reference (e.g. the directly-imported
  // GrowthModule singleton). A pre-mint mutation of that reference would silently
  // widen the authority map built below. We structuredClone + deep-freeze the
  // module here — BEFORE reading any authority-bearing field — so the kernel
  // boundary is closed for ALL callers regardless of whether the registry's own
  // frozen copy was used. Belt-and-suspenders with the registry's deepFreezeClone.
  const module: DepartmentModule = ((): DepartmentModule => {
    const clone = structuredClone(opts.module) as DepartmentModule
    for (const desc of clone.metricsEmitted) {
      Object.freeze((desc as { sourceAuthority: readonly string[] }).sourceAuthority)
      Object.freeze((desc as { display: object }).display)
      Object.freeze(desc)
    }
    Object.freeze(clone.metricsEmitted)
    for (const squad of clone.defaultSquads) Object.freeze(squad)
    Object.freeze(clone.defaultSquads)
    Object.freeze(clone.consoleSection)
    for (const conn of clone.connectors) Object.freeze(conn)
    Object.freeze(clone.connectors)
    Object.freeze(clone.requiredCapabilities)
    // Freeze channels if present — same depth as registry.ts deepFreezeClone.
    if (clone.channels) {
      deepFreezeChannels(clone.channels)
    }
    return Object.freeze(clone)
  })()

  // ── Closure-private authority state (NOT exposed on ctx) ──────────────────
  const _capSet: ReadonlySet<Capability> = new Set(capabilities)

  // Build _metricsMap from the COMPOSED set: metricsEmitted ∪ channels[].metricDescriptors.
  // This means a collector emitting a channel metric key (e.g. growth.leads via OutboundChannel)
  // is authorized through the kernel's source-authority check — no channel bypasses the guard.
  // composeDeptMetricDescriptors throws ChannelComposeError on any duplicate key, so a
  // misconfigured module cannot shadow an existing key to widen sourceAuthority.
  const _composedDescriptors = composeDeptMetricDescriptors(module.metricsEmitted, module.channels ?? [])
  const _metricsMap = new Map<string, Readonly<MetricDescriptor>>(
    _composedDescriptors.map((d) => {
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

// ── kernelMintCtx ─────────────────────────────────────────────────────────────
//
// The ONLY public path to create a DepartmentCtx. Used by registry.ts and by
// the conformance test harness. Department modules never receive or call this.
//
// The kernel token is closure-private to this module — it is never passed to callers.

export function kernelMintCtx(
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
  return _mintCtxInternal(_KERNEL_TOKEN, handle, opts)
}

// ── _isKernelToken ────────────────────────────────────────────────────────────
//
// Test-harness helper: verify that a given symbol IS the kernel token.
// Used by the conformance harness to prove that a wrong symbol is rejected by
// the token gate.
//
// NOT useful for attacking the boundary: calling _isKernelToken(x) only tells
// you true/false; it does not give you the real token or any minting capability.

export function _isKernelToken(sym: symbol): boolean {
  return sym === _KERNEL_TOKEN
}
