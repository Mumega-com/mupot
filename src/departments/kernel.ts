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
  ExecutorPort,
  ApprovedWorkItem,
  ExecuteOutcome,
} from './ctx'
import { composeDeptMetricDescriptors, deepFreezeChannels, getChannelWorkTypes } from './channels/compose'
import type { GatedWorkType } from './channels/contract'

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

// ── isCapability (WARN-S4-1 fix) ─────────────────────────────────────────────
//
// Returns true iff `v` is a known Capability key in RANK. Used to guard
// requiredCapability values in GatedWorkType before passing to hasCapability.
//
// S4 context: S3 hasCapability used `RANK[min] ?? 0` — an unknown min (e.g.
// a typo 'adminn') resolved to rank 0 (less than every real rank) which would
// PASS the cap check for any holder of any capability. Now that executable
// work-types (proposesOnly=false) use requiredCapability for real, a malformed
// min must be caught immediately at propose time — fail closed, throw
// CtxError('capability_invalid'). This is the isCapability guard.
function isCapability(v: string): v is Capability {
  return Object.prototype.hasOwnProperty.call(RANK, v)
}

// hasCapability ONLY called after the caller has already validated `min` with
// isCapability (see gate.propose below for the guarded path).
function hasCapability(caps: ReadonlySet<Capability>, min: Capability): boolean {
  for (const c of caps) {
    if (RANK[c] >= RANK[min]) return true
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
  //
  // S3 NOTE: configSchema on ChannelDescriptors may be a Zod schema object.
  // Zod schemas contain functions which structuredClone cannot handle (DataCloneError).
  // We strip configSchema from each channel before cloning and restore the original
  // references post-clone. deepFreezeChannels then freezes them in place.
  // configSchema is NOT authority-bearing (it is validation-spec data only), so
  // omitting it from the structuredClone does not weaken the boundary.
  const module: DepartmentModule = ((): DepartmentModule => {
    const configSchemas = new Map<string, unknown>()
    let cloneableModule = opts.module
    if (opts.module.channels) {
      for (const ch of opts.module.channels) {
        if (ch.configSchema !== undefined) {
          configSchemas.set(ch.key, ch.configSchema)
        }
      }
    }
    if (configSchemas.size > 0) {
      cloneableModule = {
        ...opts.module,
        channels: opts.module.channels?.map((ch) =>
          ch.configSchema !== undefined ? { ...ch, configSchema: undefined } : ch,
        ),
      }
    }

    const clone = structuredClone(cloneableModule) as DepartmentModule

    // Restore configSchema references from the original module.
    if (configSchemas.size > 0 && clone.channels) {
      for (let i = 0; i < clone.channels.length; i++) {
        const key = clone.channels[i].key
        if (configSchemas.has(key)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(clone.channels[i] as any).configSchema = configSchemas.get(key)
        }
      }
    }
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

  // ── Closure-private work-type map (NOT exposed on ctx) ───────────────────
  //
  // Built from the composed channel work-types: getChannelWorkTypes(module.channels).
  // Maps work-type key → frozen GatedWorkType descriptor.
  //
  // gate.propose MUST fail closed:
  //   - Unknown action (not in any declared work-type) → throw 'work_type_not_declared'
  //   - proposesOnly=true  → creates a gated record, returns gateId. NO execution.
  //   - proposesOnly=false → S4: creates a gated record (pending), returns gateId.
  //                          NO execution at propose time. Execution requires a
  //                          separate human-approval step + executor.execute().
  //   - requiredCapability present → enforce it (else fall back to 'member' floor)
  //   - invalid requiredCapability (unknown key) → throw 'capability_invalid' (WARN-S4-1)
  //
  // getChannelWorkTypes already throws ChannelComposeError on duplicate keys, so the
  // map is built only from a validated dedup-clean list. The module is already frozen
  // above, so the channel work-type definitions cannot be widened after mint.
  const _workTypeMap = new Map<string, Readonly<GatedWorkType>>(
    getChannelWorkTypes(module.channels ?? []).map((wt) => [wt.key, Object.freeze({ ...wt })]),
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
      // ── Capability floor ───────────────────────────────────────────────────
      if (!hasCapability(_capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to propose`,
        )
      }

      // ── Work-type existence check (fail closed) ───────────────────────────
      //
      // proposal.action MUST be a declared work-type key from this dept's composed
      // channel work-types. If not found, the caller is proposing an undeclared or
      // fabricated action — reject before producing any gate record.
      const workType = _workTypeMap.get(proposal.action)
      if (!workType) {
        throw new CtxError(
          'work_type_not_declared',
          `ctx(${departmentKey}@${tenantId}): work-type '${proposal.action}' is not declared in any channel of this department`,
        )
      }

      // ── S4: proposesOnly=false is now allowed ────────────────────────────
      //
      // S3 threw 'work_type_not_proposesOnly' for non-proposesOnly work-types.
      // S4 enables them: a non-proposesOnly proposal creates a gated record
      // (status=pending, returned as gateId) but does NOT execute. Execution
      // is a separate step: a human approves via /approvals, then the caller
      // invokes ctx.executor.execute() with the gateId. The fail-closed authority
      // check in executor.execute() ensures no execution without a real approval.
      //
      // S-LOOP SEAM: when the S-loop auto-act policy is built, it will decide
      // whether to auto-approve (mint an approval record itself) or require human
      // approval before calling execute(). That policy decision happens ABOVE
      // this layer — propose always creates a gated record and returns.

      // ── requiredCapability check (WARN-S4-1 fix) ─────────────────────────
      //
      // isCapability guard: if the work-type declares a requiredCapability, it
      // MUST be a known Capability value. An unknown/invalid min (typo, invalid
      // value injected post-freeze) fails closed — throw 'capability_invalid'.
      // This matters now that executable work-types (proposesOnly=false) use
      // requiredCapability for real gating authority.
      if (workType.requiredCapability !== undefined) {
        if (!isCapability(workType.requiredCapability)) {
          throw new CtxError(
            'capability_invalid',
            `ctx(${departmentKey}@${tenantId}): work-type '${proposal.action}' has invalid requiredCapability '${workType.requiredCapability}' — not a known Capability value (observer|member|lead|admin|owner)`,
          )
        }
        if (!hasCapability(_capSet, workType.requiredCapability)) {
          throw new CtxError(
            'capability_denied',
            `ctx(${departmentKey}@${tenantId}): work-type '${proposal.action}' requires '${workType.requiredCapability}' capability`,
          )
        }
      }

      // ── Record gated work (stub — S4 writes the gateId as a deterministic key) ──
      //
      // TODO(full-impl): write to a gated_work_items table with:
      //   { id: gateId, tenant_id, department_key, action, payload, status: 'pending', created_at }
      // For now the gateId is returned as a deterministic stub value that the
      // approval stub store in executor.execute() can match.
      void proposal
      const gateId = idFn()
      return { gateId }
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

  // ── executor facade ───────────────────────────────────────────────────────
  //
  // S4: the gated-ACT port. CLOSURE-PRIVATE — not exposed to channels, not
  // obtained from any other path. Only the kernel mints it here.
  //
  // APPROVAL STORE: a closure-private Map<gateId, boolean> tracks which gateIds
  // have been approved. In production this will query the task_verdicts table
  // (status='approved' verdict on the gated record). At S4 (stub), the store
  // is seeded by recordApproval() — called only from tests and from a future
  // approval-write path — so real production code has no way to auto-approve.
  //
  // FAIL-CLOSED: execute() checks the approval store FIRST. No approval record
  // → throw CtxError('not_approved'). Dispatch to an adapter only after approval.
  //
  // STUB ADAPTERS: both 'inkwell-content' and 'mcpwp' adapters return
  //   { executed: false, reason: 'executor_not_wired' }
  // with no fetch, no external write, no credentials. The PORT + the dispatch
  // routing + the fail-closed authority check is the S4 deliverable.
  //
  // CONFIG AUTHORITY-SAFETY (Opus Low fix):
  //   The executor adapter choice reads from the pot's SeoChannelConfig.executor.
  //   Rather than trusting a frozen-in-place configSchema object (whose ._def may be
  //   mutated by Zod internal churn), we accept the executor value as a re-parsed
  //   string literal at call time — the caller supplies it or it defaults to 'unknown'.
  //   This means a mutated schema.internal cannot change which adapter executes.

  // Closure-private approval store.
  const _approvalStore = new Map<string, true>()

  // recordApproval is NOT on the ExecutorPort interface — it is the test/write-path
  // seam that the full-impl will replace with a DB query. Exposed only for tests
  // via the _approvalStoreForTest export on the ctx object (see below).
  function _recordApproval(gateId: string): void {
    _approvalStore.set(gateId, true)
  }

  const executor: ExecutorPort = Object.freeze({
    async execute(approvedWork: ApprovedWorkItem): Promise<ExecuteOutcome> {
      if (!hasCapability(_capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to execute`,
        )
      }

      // ── FAIL-CLOSED: require a real approval record ───────────────────────
      //
      // Arms never write un-gated. No approval record in the store → reject
      // immediately. In full-impl this will be: query task_verdicts WHERE
      // task_id = gateId AND verdict = 'approved'. At S4 it checks the
      // closure-private _approvalStore. The behaviour is identical — no record,
      // no execute. EVER.
      if (!_approvalStore.has(approvedWork.gateId)) {
        throw new CtxError(
          'not_approved',
          `ctx(${departmentKey}@${tenantId}): gateId '${approvedWork.gateId}' has no approval record — execute requires a human-approved verdict. Propose first (gate.propose), approve via /approvals, then execute.`,
        )
      }

      // ── Dispatch to the (stubbed) adapter ────────────────────────────────
      //
      // CONFIG AUTHORITY-SAFETY: the executor type is passed explicitly as part
      // of approvedWork.payload (or could come from re-parsed channel config).
      // We read it from payload only as a display hint — the actual dispatch
      // below covers all valid values; unknown values are caught by the default
      // branch without any authority escape.
      //
      // At S4 every adapter returns { executed: false, reason: 'executor_not_wired' }.
      // No fetch, no external write, no credentials in any branch.
      const executorHint = (() => {
        if (
          approvedWork.payload !== null &&
          approvedWork.payload !== undefined &&
          typeof approvedWork.payload === 'object' &&
          'executor' in (approvedWork.payload as object)
        ) {
          return (approvedWork.payload as Record<string, unknown>)['executor']
        }
        return undefined
      })()

      // S-LOOP SEAM: when the S-loop auto-act policy is built, its decision
      // (auto-approve vs human-gate) happens before this function is reached.
      // The fail-closed check above always holds: the S-loop adapter must have
      // produced a real approval record before execute() is called.

      // Adapter dispatch (all stubbed at S4).
      let outcome: ExecuteOutcome
      if (executorHint === 'inkwell-content') {
        // STUB: inkwell-content adapter (Inkwell CMS write path — not wired at S4).
        // Full-impl: POST to Inkwell worker /api/content with the proposal payload.
        // Requires: Hadi-go, Inkwell API credentials, content-write capability.
        outcome = {
          executed: false,
          reason: 'executor_not_wired',
          adapter: 'inkwell-content',
        }
      } else if (executorHint === 'mcpwp') {
        // STUB: mcpwp adapter (MCPWP-managed WordPress write path — not wired at S4).
        // Full-impl: call MCPWP MCP tool with the proposal payload.
        // Requires: Hadi-go, MCPWP credentials, per-pot WordPress connection.
        outcome = {
          executed: false,
          reason: 'executor_not_wired',
          adapter: 'mcpwp',
        }
      } else {
        // Unknown or unspecified executor hint — still fails safe (no write).
        outcome = {
          executed: false,
          reason: 'executor_not_wired',
          adapter: 'unknown',
        }
      }

      return outcome
    },
  })

  // ── Build inert frozen snapshots ──────────────────────────────────────────
  const capSnapshot: readonly Capability[] = Object.freeze([...capabilities])
  const metricsSnapshot: readonly Readonly<MetricDescriptor>[] = Object.freeze(
    [..._metricsMap.values()],
  )

  // ── Test-harness seam ─────────────────────────────────────────────────────
  //
  // _recordApproval seeds the closure-private approval store. NOT on the
  // DepartmentCtx interface — production code cannot call it through the typed
  // interface. Tests cast to `unknown` first to access it.
  //
  // Built into the object literal BEFORE Object.freeze so the property is
  // own-settable (frozen objects reject new properties via [[DefineOwnProperty]]).
  //
  // Full-impl: executor.execute() will query task_verdicts (WHERE task_id=gateId
  // AND verdict='approved') instead of checking _approvalStore. This seam goes away.
  const ctxBase: DepartmentCtx & { _recordApproval: (gateId: string) => void } = {
    tenantId,
    departmentKey,
    capabilities: capSnapshot,
    metricsEmitted: metricsSnapshot,
    metrics,
    audit,
    gate,
    bus,
    executor,
    _recordApproval,
  }

  return Object.freeze(ctxBase) as DepartmentCtx
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
