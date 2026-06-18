// mupot — department microkernel: registry + lifecycle.
//
// The registry is the kernel's data-driven catalogue of DepartmentModule definitions.
// It is NOT a switch statement — adding a department requires NO edit here beyond
// calling register() once (and even that can be done from the module's own file).
//
// Key invariants (§3.3, §3.5 of console-department-microkernel.md):
//
//   REGISTRATION is DATA-DRIVEN:
//     - `register(module)` adds a module to the in-process map keyed by module.key.
//     - Duplicate key → throws (prevents silent replacement in production).
//     - `listRegistered()` returns all registered modules.
//     - No switch / if-else on department keys anywhere in this file.
//
//   ACTIVATION is IDEMPOTENT (§3.4b):
//     - `activate()` checks for a seed_receipt before seeding squads.
//     - Re-activating an already-active department re-flips the active flag but
//       does NOT re-seed squads (seed receipt guard).
//     - template_version is recorded as activated_version at activation time.
//     - Template hijack guard: only adopt an existing row if template_key matches
//       or template_key IS NULL (legacy / UI-created row). Foreign slug → slug_conflict.
//     - Seed is atomic: INSERTs + receipt written in a single db.batch() call.
//
//   DEACTIVATION retains data:
//     - `deactivate()` flips active=0 and nulls the console section from nav.
//     - Data (squads, metric_points) is retained dormant.
//     - Re-activation restores visibility.
//
//   ISOLATION:
//     - Removing a module from the registry (by not calling register()) leaves all
//       other modules and all kernel tests green (no sibling coupling).
//
//   DYNAMIC LISTS:
//     - `getActiveConsoleSections(db)` — what the nav iterates (no switch).
//     - `getActiveMetricDescriptors(db)` — what the candlestick metric selector
//       iterates (no switch, no per-department branch).
//
//   REGISTRY FACTORY + NO GLOBAL MUTATORS (FIX-2):
//     - `createDepartmentRegistry()` returns an isolated registry instance.
//     - Tests create their OWN fresh instance via createDepartmentRegistry() instead
//       of clearing a global — no global-mutation surface exported.
//     - Production holds ONE singleton instance (the module-level `_singleton`).
//     - There are NO exported _clearRegistry / _unregister / _testOnly symbols.
//     - A hostile module that imports registry.ts receives only: createDepartmentRegistry,
//       register, listRegistered, getRegistered, getActive, getActiveConsoleSections,
//       getActiveMetricDescriptors, activate, deactivate, kernelMintCtx — plus the
//       type/result exports. None of these can clear the singleton or displace an
//       existing registration (register() throws on duplicate without replace flag).

import type { D1Database } from '@cloudflare/workers-types'
import type { DepartmentModule, MetricDescriptor, ConsoleSectionRef } from './contract'
import { assertWritten } from '../lib/receipt'
import { composeDeptMetricDescriptors, deepFreezeChannels } from './channels/compose'

// ── deepFreezeClone ───────────────────────────────────────────────────────────
//
// Clones a DepartmentModule manifest with structuredClone (Web API, available on
// CF Workers + Node 18+) and then deeply freezes the clone so no post-registration
// mutation can alter authority structures.
//
// Why clone-then-freeze (registry-side normalization):
//   - The caller keeps their original mutable object — we cannot freeze it for them.
//   - Future callers who mutate the original must not affect the stored manifest.
//   - Callers who obtain the stored manifest via getRegistered() / listRegistered()
//     cannot push/assign to freeze-protected arrays or objects.
//
// Structures frozen (authority-bearing surfaces):
//   metricsEmitted array + each MetricDescriptor + its sourceAuthority array + display object
//   defaultSquads array + each SquadSeed
//   consoleSection object
//   connectors array + each ConnectorRef
//   requiredCapabilities array
//   The top-level DepartmentModule object itself

function deepFreezeClone(module: DepartmentModule): DepartmentModule {
  // structuredClone is the Web-API-standard deep-copy utility available on
  // CF Workers (via the V8 structured-clone algorithm) and Node 17+.
  const clone = structuredClone(module) as DepartmentModule

  // Freeze nested authority arrays and their elements before freezing the top object.
  for (const desc of clone.metricsEmitted) {
    Object.freeze((desc as { sourceAuthority: readonly string[] }).sourceAuthority)
    Object.freeze((desc as { display: object }).display)
    Object.freeze(desc)
  }
  Object.freeze(clone.metricsEmitted)

  for (const squad of clone.defaultSquads) {
    Object.freeze(squad)
  }
  Object.freeze(clone.defaultSquads)

  Object.freeze(clone.consoleSection)

  for (const conn of clone.connectors) {
    Object.freeze(conn)
  }
  Object.freeze(clone.connectors)

  Object.freeze(clone.requiredCapabilities)

  // Freeze channels if present. deepFreezeChannels freezes each ChannelDescriptor
  // and all nested arrays/objects (metricDescriptors, sourceAuthority, workTypes,
  // connectorRefs, renderHints) to match the depth of the rest of this function.
  if (clone.channels) {
    deepFreezeChannels(clone.channels)
  }

  Object.freeze(clone)

  return clone
}

// Re-export so callers only need to import from registry.ts.
export type { KernelHandle } from './ctx'
// TODO(non-blocking): kernelMintCtx is a public export here, usable only with a
// raw D1 handle that department modules cannot obtain. Keep it out of module-facing
// barrels (e.g. a future departments/index.ts) in a later pass to narrow the surface
// further. The current re-export from registry.ts is already scoped to kernel-internal
// callers — no module receives a D1 handle directly.
export { kernelMintCtx } from './kernel'

// ── Activation row shape ──────────────────────────────────────────────────────

export interface ActivatedDepartmentRow {
  id: string
  slug: string
  name: string
  template_key: string
  template_version: string
  activated_at: string
  active: number
  seed_receipt: string | null
  created_at: string
}

// ── SeedReceipt (module-private) ──────────────────────────────────────────────

interface SeedReceipt {
  seeded_at: string
  squads: string[]
}

// ── Result types ──────────────────────────────────────────────────────────────

export type ActivateResult =
  | { ok: true; departmentId: string; seeded: boolean }
  | { ok: false; reason: 'module_not_registered' | 'slug_conflict' | 'db_error'; detail?: string }

export type DeactivateResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'db_error'; detail?: string }

// ── Registry instance type ────────────────────────────────────────────────────

export interface DepartmentRegistry {
  register(module: DepartmentModule, opts?: { replace?: boolean }): void
  listRegistered(): DepartmentModule[]
  getRegistered(key: string): DepartmentModule | undefined
  getActive(db: D1Database): Promise<ActivatedDepartmentRow[]>
  getActiveConsoleSections(db: D1Database): Promise<ConsoleSectionRef[]>
  getActiveMetricDescriptors(db: D1Database): Promise<MetricDescriptor[]>
  activate(
    db: D1Database,
    moduleKey: string,
    opts?: { now?: () => string; idGen?: () => string },
  ): Promise<ActivateResult>
  deactivate(db: D1Database, moduleKey: string): Promise<DeactivateResult>
}

// ── RegistryInternal ─────────────────────────────────────────────────────────
//
// Internal-only type that extends DepartmentRegistry with _getOriginal.
// This method is NOT exported via the DepartmentRegistry interface — it is only
// used by the production singleton wrapper to maintain the same-object idempotency
// check after deep-freeze-clone changes getRegistered() return type.
//
// It is NOT accessible via module-facing barrels or the exported DepartmentRegistry
// interface. The only caller is the `register` export below, which holds a direct
// reference to `_singleton` (typed as RegistryInternal, a module-private type).

interface RegistryInternal extends DepartmentRegistry {
  _getOriginal(key: string): DepartmentModule | undefined
}

// ── createDepartmentRegistry ──────────────────────────────────────────────────
//
// Factory that returns an isolated registry instance. Tests create fresh instances
// per test so there is no shared global state to clear, and no global-mutation
// surface needs to be exported.
//
// The narrow public API:
//   register / listRegistered / getRegistered — module catalogue
//   activate / deactivate                     — lifecycle
//   getActive / getActiveConsoleSections / getActiveMetricDescriptors — queries
//
// Notably absent: _clearRegistry, _unregister, _testOnly. Tests use their own
// fresh instance instead.
//
// Note: the returned concrete object also carries _getOriginal (needed by the
// singleton wrapper for same-object idempotency), but the public return type is
// DepartmentRegistry so callers cannot observe or call _getOriginal.

export function createDepartmentRegistry(): DepartmentRegistry {
  // _map holds the frozen deep-clone of each registered manifest.
  // _originals maps key → the ORIGINAL (caller's) module reference.
  // _originals is used ONLY by the production singleton's same-object idempotency
  // check (existing === module → no-op). It is NOT exposed on the DepartmentRegistry
  // interface — no module-facing API can reach the original mutable reference.
  const _map = new Map<string, DepartmentModule>()
  const _originals = new Map<string, DepartmentModule>()

  function register(module: DepartmentModule, opts?: { replace?: boolean }): void {
    if (_map.has(module.key) && !opts?.replace) {
      throw new Error(
        `[registry_duplicate_key] Module key '${module.key}' is already registered. ` +
          'Use register(module, { replace: true }) only in tests.',
      )
    }
    // Deep-clone then deep-freeze the manifest before storing.
    // The stored manifest is immutable — push/assign on any nested authority
    // structure throws in strict mode and is silently inert in sloppy mode.
    // Callers who retain their original mutable object cannot affect the stored clone.
    const frozen = deepFreezeClone(module)
    _map.set(module.key, frozen)
    _originals.set(module.key, module)
  }

  function listRegistered(): DepartmentModule[] {
    // Return the frozen stored clones. Callers may spread the array, but the
    // elements themselves are frozen — mutation of any descriptor / authority
    // array throws in strict mode.
    return [..._map.values()]
  }

  function getRegistered(key: string): DepartmentModule | undefined {
    // Returns the frozen stored clone, never the live caller reference.
    return _map.get(key)
  }

  // Internal accessor used ONLY by the production singleton wrapper's same-object
  // idempotency check. Not part of the DepartmentRegistry interface.
  function _getOriginal(key: string): DepartmentModule | undefined {
    return _originals.get(key)
  }

  async function getActive(db: D1Database): Promise<ActivatedDepartmentRow[]> {
    const result = await db
      .prepare(
        `SELECT id, slug, name, template_key, template_version, activated_at, active, seed_receipt, created_at
           FROM departments
          WHERE active = 1
            AND template_key IS NOT NULL
          ORDER BY activated_at ASC`,
      )
      .all<ActivatedDepartmentRow>()
    return result.results ?? []
  }

  async function getActiveConsoleSections(db: D1Database): Promise<ConsoleSectionRef[]> {
    const rows = await getActive(db)
    const sections: ConsoleSectionRef[] = []
    for (const row of rows) {
      const module = _map.get(row.template_key)
      if (module) sections.push(module.consoleSection)
    }
    return sections
  }

  async function getActiveMetricDescriptors(db: D1Database): Promise<MetricDescriptor[]> {
    const rows = await getActive(db)
    const descriptors: MetricDescriptor[] = []
    for (const row of rows) {
      const module = _map.get(row.template_key)
      if (module) {
        // Use the composed set: metricsEmitted ∪ channels[].metricDescriptors.
        // composeDeptMetricDescriptors throws ChannelComposeError on duplicate key — any
        // such error here is a registration-time config bug that should surface loudly.
        const composed = composeDeptMetricDescriptors(module.metricsEmitted, module.channels ?? [])
        descriptors.push(...composed)
      }
    }
    return descriptors
  }

  async function activate(
    db: D1Database,
    moduleKey: string,
    opts?: { now?: () => string; idGen?: () => string },
  ): Promise<ActivateResult> {
    const module = _map.get(moduleKey)
    if (!module) {
      return {
        ok: false,
        reason: 'module_not_registered',
        detail: `module '${moduleKey}' is not registered`,
      }
    }

    const nowFn = opts?.now ?? (() => new Date().toISOString())
    const idFn = opts?.idGen ?? (() => crypto.randomUUID())

    try {
      const existing = await db
        .prepare(
          `SELECT id, slug, template_key, seed_receipt FROM departments WHERE slug = ?1 LIMIT 1`,
        )
        .bind(module.key)
        .first<{
          id: string
          slug: string
          template_key: string | null
          seed_receipt: string | null
        }>()

      const now = nowFn()
      let departmentId: string
      let priorSeedReceipt: SeedReceipt | null = null

      if (existing) {
        // ── Template hijack guard ────────────────────────────────────────────
        if (existing.template_key !== null && existing.template_key !== module.key) {
          return {
            ok: false,
            reason: 'slug_conflict',
            detail:
              `slug '${module.key}' is already owned by module '${existing.template_key}'. ` +
              `Cannot activate module '${module.key}' over a foreign slug.`,
          }
        }

        departmentId = existing.id

        if (existing.seed_receipt) {
          try {
            priorSeedReceipt = JSON.parse(existing.seed_receipt) as SeedReceipt
          } catch {
            priorSeedReceipt = null
          }
        }

        const updateResult = await db
          .prepare(
            `UPDATE departments
                SET active = 1,
                    template_key = ?2,
                    template_version = ?3,
                    activated_at = COALESCE(activated_at, ?4),
                    name = ?5
              WHERE id = ?1`,
          )
          .bind(departmentId, module.key, module.version, now, module.name)
          .run()
        assertWritten(updateResult, `departments.activate.update(${module.key})`)
      } else {
        departmentId = idFn()
        const insertResult = await db
          .prepare(
            `INSERT INTO departments (id, slug, name, template_key, template_version, activated_at, active, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)`,
          )
          .bind(departmentId, module.key, module.name, module.key, module.version, now, now)
          .run()
        assertWritten(insertResult, `departments.activate.insert(${module.key})`)
      }

      // ── Idempotent squad seeding (atomic batch) ────────────────────────────
      let seeded = false
      if (!priorSeedReceipt && module.defaultSquads.length > 0) {
        const squadStatements = module.defaultSquads.map((seed) => {
          const squadId = idFn()
          return db
            .prepare(
              `INSERT OR IGNORE INTO squads (id, department_id, slug, name, charter, created_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            )
            .bind(squadId, departmentId, seed.slug, seed.name, seed.charter ?? null, now)
        })

        const receipt: SeedReceipt = {
          seeded_at: now,
          squads: module.defaultSquads.map((s) => s.slug),
        }
        const receiptStmt = db
          .prepare(
            `UPDATE departments SET seed_receipt = ?2 WHERE id = ?1 AND seed_receipt IS NULL`,
          )
          .bind(departmentId, JSON.stringify(receipt))

        const batchResults = await db.batch([...squadStatements, receiptStmt])
        const receiptResult = batchResults[batchResults.length - 1]
        seeded = (receiptResult.meta.changes ?? 0) > 0
      }

      return { ok: true, departmentId, seeded }
    } catch (err) {
      return {
        ok: false,
        reason: 'db_error',
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async function deactivate(
    db: D1Database,
    moduleKey: string,
  ): Promise<DeactivateResult> {
    try {
      const result = await db
        .prepare(`UPDATE departments SET active = 0 WHERE slug = ?1 AND template_key = ?1`)
        .bind(moduleKey)
        .run()

      if (!result.meta.changes) {
        return { ok: false, reason: 'not_found' }
      }
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        reason: 'db_error',
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // Return the concrete object (a RegistryInternal superset of DepartmentRegistry).
  // The function's declared return type is DepartmentRegistry so external callers
  // cannot observe _getOriginal. The singleton variable is cast to RegistryInternal
  // internally (module-private cast) to access it for idempotency checks.
  const instance: RegistryInternal = {
    register,
    listRegistered,
    getRegistered,
    getActive,
    getActiveConsoleSections,
    getActiveMetricDescriptors,
    activate,
    deactivate,
    _getOriginal,
  }
  return instance
}

// ── Singleton production registry ─────────────────────────────────────────────
//
// One instance for the production bundle. Module-level exports below delegate to
// this instance so callers (fixture.ts, production routes) use the same API as
// before without any change.
//
// SECURITY: the production `register` exported here does NOT accept a `replace`
// option. Registration on the singleton is idempotent for the same module object
// (same key + same identity reference → no-op) and throws `registry_duplicate_key`
// for any different module under an existing key. This closes the hostile-displacement
// attack: a module cannot call register(EvilModule, {replace:true}) to displace a
// sibling's key. `replace` exists only on isolated `createDepartmentRegistry()`
// instances used by tests.
//
// THERE ARE NO global-mutation exports (_clearRegistry, _unregister, _testOnly).
// Tests use createDepartmentRegistry() for isolated instances.

// Cast to RegistryInternal so we can call _getOriginal in the singleton wrapper.
// RegistryInternal is a module-private type — it is NOT exported and cannot be
// imported by hostile module code. The DepartmentRegistry interface (exported)
// has no _getOriginal member.
const _singleton = createDepartmentRegistry() as RegistryInternal

export function register(module: DepartmentModule): void {
  // Idempotent for the same module object (same key + same reference) — no-op.
  // After deep-freeze-clone, getRegistered() returns the frozen CLONE, not the
  // original. We use _getOriginal (internal only, not on DepartmentRegistry) to
  // compare against the caller's reference for the idempotency check.
  // Different module under existing key → throws registry_duplicate_key.
  // No `replace` accepted: production registration is permanent.
  const original = _singleton._getOriginal(module.key)
  if (original === module) return  // same object re-imported → safe no-op
  _singleton.register(module)     // throws registry_duplicate_key if key taken by different object
}

export function listRegistered(): DepartmentModule[] {
  return _singleton.listRegistered()
}

export function getRegistered(key: string): DepartmentModule | undefined {
  return _singleton.getRegistered(key)
}

export async function getActive(db: D1Database): Promise<ActivatedDepartmentRow[]> {
  return _singleton.getActive(db)
}

export async function getActiveConsoleSections(db: D1Database): Promise<ConsoleSectionRef[]> {
  return _singleton.getActiveConsoleSections(db)
}

export async function getActiveMetricDescriptors(db: D1Database): Promise<MetricDescriptor[]> {
  return _singleton.getActiveMetricDescriptors(db)
}

export async function activate(
  db: D1Database,
  moduleKey: string,
  opts?: { now?: () => string; idGen?: () => string },
): Promise<ActivateResult> {
  return _singleton.activate(db, moduleKey, opts)
}

export async function deactivate(
  db: D1Database,
  moduleKey: string,
): Promise<DeactivateResult> {
  return _singleton.deactivate(db, moduleKey)
}
