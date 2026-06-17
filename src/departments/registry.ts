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

// Re-export so callers only need to import from registry.ts.
export type { KernelHandle } from './ctx'
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

export function createDepartmentRegistry(): DepartmentRegistry {
  const _map = new Map<string, DepartmentModule>()

  function register(module: DepartmentModule, opts?: { replace?: boolean }): void {
    if (_map.has(module.key) && !opts?.replace) {
      throw new Error(
        `[registry_duplicate_key] Module key '${module.key}' is already registered. ` +
          'Use register(module, { replace: true }) only in tests.',
      )
    }
    _map.set(module.key, module)
  }

  function listRegistered(): DepartmentModule[] {
    return [..._map.values()]
  }

  function getRegistered(key: string): DepartmentModule | undefined {
    return _map.get(key)
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
      if (module) descriptors.push(...module.metricsEmitted)
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

  return {
    register,
    listRegistered,
    getRegistered,
    getActive,
    getActiveConsoleSections,
    getActiveMetricDescriptors,
    activate,
    deactivate,
  }
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

const _singleton = createDepartmentRegistry()

export function register(module: DepartmentModule): void {
  // Idempotent for the same module object (same key + same reference) — no-op.
  // Different module under existing key → throws registry_duplicate_key.
  // No `replace` accepted: production registration is permanent.
  const existing = _singleton.getRegistered(module.key)
  if (existing === module) return  // same object re-imported → safe no-op
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
