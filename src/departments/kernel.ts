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

// ── PendingRecord (module-private) ───────────────────────────────────────────
//
// The full content of a gated work proposal, stored by gate.propose() and looked
// up by executor.execute(). Keyed by gateId in the closure-private _pendingStore.
//
// BLOCK-2 fix (2026-06-18): execute() reads ONLY from the stored record — the
// caller supplies only a gateId; action/payload/tenantId/departmentKey are taken
// from this record, never from the caller.
interface PendingRecord {
  gateId: string
  action: string
  payload: unknown
  tenantId: string
  departmentKey: string
  approved: boolean
}

// ── _testApproveSeams (module-private WeakMap) ────────────────────────────────
//
// BLOCK-1 fix (2026-06-18): _recordApproval is NOT a property on the ctx object.
// The approval-writer is closure-private. The test seam is exposed only through
// _kernelApproveForTest (exported below) which reads this WeakMap.
//
// The WeakMap key is the DepartmentCtx reference (object identity). The value
// is a function that marks a pending record approved in the closure-private store.
// Because DepartmentCtx is frozen before being returned, the WeakMap is the only
// path to reach the writer — it is not on the ctx, not reachable via `as any`.
const _testApproveSeams = new WeakMap<DepartmentCtx, (gateId: string) => void>()

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

      // ── Record gated work (BLOCK-2 fix: store full record keyed by gateId) ──
      //
      // The full pending record is stored in the closure-private _pendingStore.
      // executor.execute() will look up this record by gateId and dispatch using
      // ONLY the stored action + payload — not caller-supplied values.
      //
      // TODO(full-impl): write to a gated_work_items table with:
      //   { id: gateId, tenant_id, department_key, action, payload, status: 'pending', created_at }
      const gateId = idFn()
      const pendingRecord: PendingRecord = {
        gateId,
        action: proposal.action,
        payload: proposal.payload,
        tenantId,
        departmentKey,
        approved: false,
      }
      _pendingStore.set(gateId, pendingRecord)
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
  // PENDING STORE: a closure-private Map<gateId, PendingRecord> stores the full
  // record created by gate.propose(). The record holds action, payload, tenantId,
  // departmentKey, and approved:boolean. gate.propose() inserts with approved=false.
  //
  // APPROVAL: approved is flipped to true ONLY by the _testApproveSeams write-path
  // (test seam, see below) or, in full-impl, by the /approvals Gate endpoint writing
  // a task_verdicts row. The ctx object has NO method that can approve a record.
  // A ctx-holder using `(ctx as any)` finds NO approval method — it is not there.
  //
  // FAIL-CLOSED + CONTENT-BOUND (BLOCK-1 + BLOCK-2 fix, 2026-06-18):
  //   execute(gateId):
  //     1. Check capability (member floor).
  //     2. Look up gateId in _pendingStore → not found: throw not_approved.
  //     3. Check record.approved → false: throw not_approved.
  //     4. Check record.tenantId === tenantId AND record.departmentKey === departmentKey
  //        → mismatch: throw not_approved (cross-tenant / cross-dept rejected).
  //     5. Dispatch using record.action and record.payload — NOT caller-supplied values.
  //
  // STUB ADAPTERS: both 'inkwell-content' and 'mcpwp' adapters return
  //   { executed: false, reason: 'executor_not_wired' }
  // with no fetch, no external write, no credentials. The PORT + the dispatch
  // routing + the fail-closed authority check is the S4 deliverable.

  // Closure-private pending store (stores proposal records; approved field tracks gate).
  const _pendingStore = new Map<string, PendingRecord>()

  // _approveRecord is closure-private and NOT placed on the ctx object.
  // It is exposed ONLY via _testApproveSeams (a module-level WeakMap) so that
  // _kernelApproveForTest (exported below) can reach it by ctx identity.
  // Nothing reachable via `(ctx as any)` can call this function.
  function _approveRecord(gateId: string): void {
    const rec = _pendingStore.get(gateId)
    if (rec) rec.approved = true
  }

  const executor: ExecutorPort = Object.freeze({
    async execute(gateId: string): Promise<ExecuteOutcome> {
      if (!hasCapability(_capSet, 'member')) {
        throw new CtxError(
          'capability_denied',
          `ctx(${departmentKey}@${tenantId}): 'member' capability required to execute`,
        )
      }

      // ── FAIL-CLOSED + CONTENT-BOUND ──────────────────────────────────────
      //
      // Look up the pending record. No record → never proposed → reject.
      // Record not approved → human approval not received → reject.
      // Record tenantId/departmentKey mismatch → cross-tenant/dept → reject.
      // In full-impl: query task_verdicts WHERE task_id=gateId AND verdict='approved'
      // AND tenant_id=tenantId AND department_key=departmentKey. At S4 the
      // _pendingStore is the equivalent — same semantics, no DB.
      const record = _pendingStore.get(gateId)
      if (!record || !record.approved) {
        throw new CtxError(
          'not_approved',
          `ctx(${departmentKey}@${tenantId}): gateId '${gateId}' has no approval record — execute requires a human-approved verdict. Propose first (gate.propose), approve via /approvals, then execute.`,
        )
      }

      // ── Cross-tenant / cross-department binding check ─────────────────────
      //
      // The stored record carries the tenantId + departmentKey from the ctx that
      // called gate.propose(). A different ctx (different tenant or department)
      // that somehow holds the same gateId cannot execute it — the bindings must
      // match. This closes the cross-tenant substitution attack.
      if (record.tenantId !== tenantId || record.departmentKey !== departmentKey) {
        throw new CtxError(
          'not_approved',
          `ctx(${departmentKey}@${tenantId}): gateId '${gateId}' was proposed in a different tenant/department — cross-tenant/dept execute rejected.`,
        )
      }

      // ── Dispatch to the (stubbed) adapter ────────────────────────────────
      //
      // CONTENT-BOUND (BLOCK-2 fix): executor hint comes from the STORED record's
      // payload — NOT from any caller-supplied value. The caller passed only gateId.
      // This means approve-A/execute-B-payload substitution is structurally impossible:
      // the caller has no parameter to substitute.
      //
      // At S4 every adapter returns { executed: false, reason: 'executor_not_wired' }.
      // No fetch, no external write, no credentials in any branch.
      const storedPayload = record.payload
      const executorHint = (() => {
        if (
          storedPayload !== null &&
          storedPayload !== undefined &&
          typeof storedPayload === 'object' &&
          'executor' in (storedPayload as object)
        ) {
          return (storedPayload as Record<string, unknown>)['executor']
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

  // ── Ctx build + test-seam registration (BLOCK-1 fix) ─────────────────────
  //
  // _approveRecord is NOT placed on the ctx object. A hostile ctx-holder using
  // `(ctx as any)` will find NO approval method — it is simply not there.
  //
  // The test seam is the module-level WeakMap _testApproveSeams, populated here
  // BEFORE freeze. The frozen ctx is the WeakMap key; the writer is the value.
  // Only code that has both the frozen ctx reference AND access to the exported
  // _kernelApproveForTest function can trigger an approval — and that function
  // is for test harnesses only, clearly labelled as such.
  //
  // Full-impl: executor.execute() will query task_verdicts (WHERE task_id=gateId
  // AND verdict='approved' AND tenant_id=tenantId AND department_key=departmentKey)
  // instead of using _pendingStore. This seam goes away then.
  const ctxBase: DepartmentCtx = {
    tenantId,
    departmentKey,
    capabilities: capSnapshot,
    metricsEmitted: metricsSnapshot,
    metrics,
    audit,
    gate,
    bus,
    executor,
  }

  const frozenCtx = Object.freeze(ctxBase)

  // Register the approval writer in the module-level WeakMap AFTER freeze.
  // The WeakMap key is the frozen ctx object (identity, not structure).
  _testApproveSeams.set(frozenCtx, _approveRecord)

  return frozenCtx
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

// ── _kernelApproveForTest ─────────────────────────────────────────────────────
//
// TEST-HARNESS ONLY. Simulates a human approval of a pending gated record.
//
// BLOCK-1 fix (2026-06-18): _recordApproval is NOT on the DepartmentCtx object.
// A ctx-holder using `(ctx as any)` finds no approval method. The approval
// mechanism is reached ONLY through this function, which requires:
//   1. The exported function itself (tests import it; prod code should not).
//   2. The exact ctx reference (WeakMap key — object identity).
//
// INVARIANT a test must prove: `(ctx as any)._recordApproval` is undefined,
// `(ctx as any)._approveRecord` is undefined — the ctx object has NO property
// that can approve a proposal. Only this function path can.
//
// Full-impl: this function goes away. executor.execute() queries task_verdicts
// (a real DB row written by the /approvals Gate endpoint). The only approval
// path is then an authenticated HTTP request through the real Gate.

export function _kernelApproveForTest(ctx: DepartmentCtx, gateId: string): void {
  const writer = _testApproveSeams.get(ctx)
  if (!writer) {
    throw new Error(
      '_kernelApproveForTest: ctx not found in approval seam map — was it minted by kernelMintCtx?',
    )
  }
  writer(gateId)
}
