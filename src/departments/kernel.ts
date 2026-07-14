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

import type { D1Database } from '@cloudflare/workers-types'
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
import { inkwellContentWrite, InkwellExecutorError } from './executors/inkwell'
import { wpContentWrite, WpExecutorError } from './executors/mcpwp'

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
// BLOCK-2 fix (2026-06-18): execute() reads the action/payload/tenantId/
// departmentKey ONLY from this stored record — the caller supplies only a gateId.
//
// NOTE: this record carries the proposal CONTENT (the S4 in-memory content stub).
// It deliberately holds NO `approved` field. Approval is NOT an in-process flag —
// it is a row in the real Gate store (task_verdicts), read by execute() via
// handle.db (see _hasApprovedVerdict). That is the BLOCK-1 structural close: there
// is no in-process approval writer, so there is nothing importable to self-approve.
interface PendingRecord {
  gateId: string
  action: string
  payload: unknown
  tenantId: string
  departmentKey: string
}

// ── _hasApprovedVerdict — approval lives in the REAL Gate store ───────────────
//
// BLOCK-1 structural close (2026-06-18): the ONLY approval path is an `approved`
// row in task_verdicts, written EXCLUSIVELY by the authenticated verdict route
// (writeVerdict ← POST /api/tasks/:id/verdict, RBAC-gated on the task's gate_owner).
// No in-process function can mint that row. A hostile/future collector holds a
// ctx but the ctx exposes NO approval writer — and it cannot forge a DB verdict.
//
// execute() calls this with handle.db (the same D1 the verdict route writes to).
// Tests "approve the real way" by writing an approved task_verdicts row to the
// same store — modeling the verdict route's output — never via a kernel export.
//
// LATEST-VERDICT SEMANTICS (Codex cross-vendor catch, 2026-06-18): task_verdicts is
// append-only and multiple verdicts per task are legitimate (rejected → in_progress
// → review → approved, per src/tasks/service.ts). A query for "any approved row ever"
// would keep execution authority open after a LATER rejection — a stale-verdict
// authority bug. So we read the LATEST verdict (ORDER BY decided_at DESC LIMIT 1)
// and require it to be 'approved' — matching the production readers in
// src/workflows/pipeline.ts and src/integrations/ghl.ts.
async function _hasApprovedVerdict(db: D1Database, gateId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT verdict FROM task_verdicts WHERE task_id = ?1 ORDER BY decided_at DESC LIMIT 1`)
    .bind(gateId)
    .first<{ verdict: string }>()
  return row?.verdict === 'approved'
}

// ── Durable proposal store (S4 durability slice) ──────────────────────────────
//
// gate.propose() write-throughs the proposal CONTENT here so executor.execute()
// can find it across requests / isolates (the in-memory _pendingStore is a
// same-isolate fast-path only). NO approval flag and NO secret is stored — only the
// content + the tenant/department BINDING that execute() re-checks. Fail-closed: if
// the durable write fails, propose() throws (a gateId that won't survive a cold
// isolate is worse than a failed propose).
async function _persistProposal(db: D1Database, r: PendingRecord): Promise<void> {
  const payloadJson = r.payload === undefined ? null : JSON.stringify(r.payload)
  await db
    .prepare(
      `INSERT OR REPLACE INTO department_proposals
         (gate_id, tenant_id, department_key, action, payload_json)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(r.gateId, r.tenantId, r.departmentKey, r.action, payloadJson)
    .run()
}

// Read-fallback for execute(): reconstruct the PendingRecord from the durable row.
// Returns null when no row exists (→ execute() fails not_approved, as before).
async function _loadProposal(db: D1Database, gateId: string): Promise<PendingRecord | null> {
  const row = await db
    .prepare(
      `SELECT gate_id, tenant_id, department_key, action, payload_json
         FROM department_proposals WHERE gate_id = ?1 LIMIT 1`,
    )
    .bind(gateId)
    .first<{ gate_id: string; tenant_id: string; department_key: string; action: string; payload_json: string | null }>()
  if (!row) return null
  return {
    gateId: row.gate_id,
    tenantId: row.tenant_id,
    departmentKey: row.department_key,
    action: row.action,
    payload: row.payload_json === null ? undefined : JSON.parse(row.payload_json),
  }
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

      // ── Record gated work (BLOCK-2 fix: store full record keyed by gateId) ──
      //
      // The proposal CONTENT is stored in the closure-private _pendingStore.
      // executor.execute() looks up this record by gateId and dispatches using
      // ONLY the stored action + payload — not caller-supplied values. The record
      // holds NO approval flag: approval is a task_verdicts row (the real Gate),
      // not an in-process bit (see executor / _hasApprovedVerdict).
      //
      // Durable content store (S4 durability slice): write the proposal row to
      // department_proposals so execute() reads the content across requests/isolates
      // too. The in-memory _pendingStore is a same-isolate fast-path. The approval
      // gate is already the real DB verdict (task_verdicts).
      const gateId = idFn()
      const pendingRecord: PendingRecord = {
        gateId,
        action: proposal.action,
        payload: proposal.payload,
        tenantId,
        departmentKey,
      }
      _pendingStore.set(gateId, pendingRecord)
      // Fail-closed: a non-durable proposal (lost on a cold isolate) is worse than a
      // failed propose, so let a durable-write error propagate.
      await _persistProposal(handle.db, pendingRecord)
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
  // PENDING STORE: a closure-private Map<gateId, PendingRecord> stores the
  // record created by gate.propose(). The record holds action, payload, tenantId,
  // and departmentKey — CONTENT ONLY, NO approval flag. Approval lives in the DB
  // (task_verdicts), read via _hasApprovedVerdict (latest-verdict semantics).
  //
  // APPROVAL: an `approved` row in task_verdicts (the real Gate store), written
  // EXCLUSIVELY by the authenticated verdict route (writeVerdict ← POST
  // /api/tasks/:id/verdict, RBAC-gated on gate_owner). The ctx object has NO method
  // that can approve a record, and there is NO importable approval function in this
  // module — the approval is data in a DB the ctx cannot write. A ctx-holder using
  // `(ctx as any)` finds NO approval method; a module importer finds NO approve fn.
  //
  // FAIL-CLOSED + CONTENT-BOUND (BLOCK-1 + BLOCK-2 close, 2026-06-18):
  //   execute(gateId):
  //     1. Check capability (member floor).
  //     2. Look up gateId in _pendingStore (content + binding) → not found: not_approved.
  //     3. Check record.tenantId === tenantId AND record.departmentKey === departmentKey
  //        → mismatch: throw not_approved (cross-tenant / cross-dept rejected).
  //     4. Query task_verdicts via handle.db for an `approved` verdict on gateId
  //        → none: throw not_approved. THIS is the gate — unforgeable by ctx code.
  //     5. Dispatch using record.action and record.payload — NOT caller-supplied values.
  //
  // CONTENT NOTE: _pendingStore holds the proposal CONTENT (the documented S4
  // in-memory content stub). Durable content (a proposal row read across requests)
  // lands when real adapters wire; the APPROVAL gate is already real (DB verdict).
  //
  // ADAPTERS: both 'inkwell-content' and 'mcpwp' (#370) dispatch to a real adapter
  // when the Worker boundary resolved the matching connector config into
  // handle.executorEnv. Absent config → { executed: false, reason: 'executor_not_wired' }
  // with no fetch, no external write, no credentials — identical stub behavior to S4.
  // The PORT + the dispatch routing + the fail-closed authority check is unchanged.

  // Closure-private content store (proposal action/payload + tenant/dept binding).
  // Holds NO approval flag — approval lives in task_verdicts (see _hasApprovedVerdict).
  const _pendingStore = new Map<string, PendingRecord>()

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
      // 1. Look up the proposal content. In-memory fast-path first, then the durable
      //    department_proposals row (cross-request / cold-isolate). No record in
      //    either → never proposed → reject.
      const record = _pendingStore.get(gateId) ?? (await _loadProposal(handle.db, gateId))
      if (!record) {
        throw new CtxError(
          'not_approved',
          `ctx(${departmentKey}@${tenantId}): gateId '${gateId}' has no proposal record — execute requires a prior gate.propose in this ctx, a human-approved verdict, then execute.`,
        )
      }

      // 2. Cross-tenant / cross-department binding check.
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

      // 3. THE GATE — approval is a real `approved` row in task_verdicts, written
      //    ONLY by the authenticated verdict route. No in-process function can
      //    forge it; a ctx-holder cannot write it. This is the structural close of
      //    the self-approve seam (BLOCK-1): there is no importable approval path.
      const approved = await _hasApprovedVerdict(handle.db, gateId)
      if (!approved) {
        throw new CtxError(
          'not_approved',
          `ctx(${departmentKey}@${tenantId}): gateId '${gateId}' has no approved verdict in the Gate store — execute requires a human-approved verdict (POST /api/tasks/${gateId}/verdict). Propose, approve via /approvals, then execute.`,
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
        // inkwell-content adapter — real Inkwell content write (S4).
        // FAIL-CLOSED: only fires when the Worker boundary resolved the per-pot
        // 'inkwell' connector credential (Hadi-go) into handle.executorEnv.inkwell.
        // Absent → executor_not_wired (every current call site). The payload is the
        // STORED record's (content-bound), never caller-supplied.
        const inkwellCfg = handle.executorEnv?.inkwell
        if (!inkwellCfg) {
          outcome = { executed: false, reason: 'executor_not_wired', adapter: 'inkwell-content' }
        } else {
          try {
            const written = await inkwellContentWrite(inkwellCfg, storedPayload)
            outcome = { executed: true, adapter: 'inkwell-content', artifactUrl: written.url }
          } catch (e) {
            // Fail-closed on any adapter error (config/payload/HTTP) — never throw out
            // of execute(); surface the reason for the receipt/console.
            const reason = e instanceof InkwellExecutorError ? e.reason : 'inkwell_error'
            outcome = { executed: false, reason, adapter: 'inkwell-content' }
          }
        }
      } else if (executorHint === 'mcpwp') {
        // mcpwp adapter — real WordPress content write (#370). Structural twin of
        // the inkwell-content branch above. FAIL-CLOSED: only fires when the Worker
        // boundary resolved the per-pot 'mcpwp' connector credential into
        // handle.executorEnv.mcpwp. Absent → executor_not_wired. The payload is the
        // STORED record's (content-bound), never caller-supplied.
        //
        // NOTE (#370 scope): this writes directly to the WordPress REST API
        // (wp-json/wp/v2/posts), not through the mumcp MCP server — see the
        // FOLLOW-UP comment in executors/mcpwp.ts.
        const wpCfg = handle.executorEnv?.mcpwp
        if (!wpCfg) {
          outcome = { executed: false, reason: 'executor_not_wired', adapter: 'mcpwp' }
        } else {
          try {
            const written = await wpContentWrite(wpCfg, storedPayload)
            outcome = { executed: true, adapter: 'mcpwp', artifactUrl: written.artifactUrl }
          } catch (e) {
            // Fail-closed on any adapter error (config/payload/HTTP) — never throw out
            // of execute(); surface the reason for the receipt/console.
            const reason = e instanceof WpExecutorError ? e.reason : 'mcpwp_error'
            outcome = { executed: false, reason, adapter: 'mcpwp' }
          }
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

  // ── Ctx build (BLOCK-1 structural close) ─────────────────────────────────
  //
  // The ctx carries NO approval writer — not on the object, not in any module
  // WeakMap, not behind any exported function. Approval is a row in task_verdicts
  // (the real Gate store) that only the authenticated verdict route can write and
  // that execute() reads via handle.db. A hostile ctx-holder using `(ctx as any)`
  // finds no approval method; a module importer finds no approve function to call.
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

  return Object.freeze(ctxBase)
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

// ── NO approval export ────────────────────────────────────────────────────────
//
// BLOCK-1 structural close (2026-06-18): there is intentionally NO
// _kernelApproveForTest / _recordApproval / approve* export in this module.
// Approval is a row in task_verdicts written ONLY by the authenticated verdict
// route (writeVerdict ← POST /api/tasks/:id/verdict, RBAC-gated on gate_owner).
// execute() reads it via handle.db (_hasApprovedVerdict). Tests approve by writing
// an approved task_verdicts row to the same store — never via a kernel export.
//
// A guard test (tests/kernel-no-approval-export.test.ts) asserts this module
// exports nothing matching /approve/i, so the seam cannot silently return.
