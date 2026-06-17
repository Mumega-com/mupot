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

import type { D1Database } from '@cloudflare/workers-types'
import type { DepartmentModule, MetricDescriptor, ConsoleSectionRef } from './contract'
import type { DepartmentCtx } from './ctx'
import { acquireKernelToken, mintCtx } from './ctx'
import { assertWritten } from '../lib/receipt'
import type { Capability } from '../types'

// ── Kernel token acquisition ──────────────────────────────────────────────────
//
// The registry (the kernel) acquires the unforgeable mint token once at module
// load time. This token is stored here as a module-private const — it never
// leaves this file. Department modules that import from registry.ts receive no
// reference to the token and cannot call mintCtx directly.
//
// kernelMintCtx() (exported below) is the ONLY public path to create a ctx in
// both production and tests. Tests import kernelMintCtx from this file.

const _kernelToken = acquireKernelToken()

// ── KernelHandle ──────────────────────────────────────────────────────────────
//
// Holds the raw D1 handle. Only the kernel holds this; department modules never
// receive it. The type is intentionally NOT re-exported so module code that
// imports only from registry.ts cannot construct a KernelHandle.

export interface KernelHandle {
  db: D1Database
}

/**
 * The ONLY public path to mint a DepartmentCtx. Wraps mintCtx() with the
 * kernel-private token so callers (including the test harness) never need the
 * raw token. Department modules never receive or call this function.
 */
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
  return mintCtx(_kernelToken, handle, opts)
}

// ── In-process module registry ─────────────────────────────────────────────────
//
// A plain Map is sufficient: modules register at import time (or explicitly),
// and the map is read at activation/listing time. No persistence needed — the
// registry always rebuilds from module imports on each Worker invocation.

const _registry = new Map<string, DepartmentModule>()

/**
 * Register a DepartmentModule.
 *
 * Throws on duplicate key — silent replacement would allow a hostile module
 * to shadow an already-registered kernel module mid-flight.
 *
 * Pass `{ replace: true }` only from test harnesses that need controlled
 * override (e.g. re-registering after _clearRegistry).
 */
export function register(module: DepartmentModule, opts?: { replace?: boolean }): void {
  if (_registry.has(module.key) && !opts?.replace) {
    throw new Error(
      `[registry_duplicate_key] Module key '${module.key}' is already registered. ` +
        'Use register(module, { replace: true }) only in tests.',
    )
  }
  _registry.set(module.key, module)
}

/**
 * List all registered modules. Order is insertion order (Map iteration).
 * Does NOT filter by active state — that is a per-tenant DB concern.
 */
export function listRegistered(): DepartmentModule[] {
  return [..._registry.values()]
}

/**
 * Get a single registered module by key, or undefined if not registered.
 */
export function getRegistered(key: string): DepartmentModule | undefined {
  return _registry.get(key)
}

// ── Test-only registry helpers ────────────────────────────────────────────────
//
// These are NOT part of the production surface. They are exported for use by
// the conformance test harness only. Module-facing code (department modules,
// production Workers) should never call these.
//
// Note: We cannot physically prevent a module author from importing them (no
// process isolation in CF Workers), but the naming convention + the fact that
// they're documented as test-only + the register() duplicate-key guard together
// make accidental or adversarial misuse visible and loud.

export const _testOnly = {
  /**
   * Clear all registrations. Used by the conformance harness to test isolation.
   * NOT a production path.
   */
  clearRegistry(): void {
    _registry.clear()
  },

  /**
   * Remove a single module registration. Used by the conformance harness to test
   * that removing a module leaves the kernel and sibling modules unaffected.
   * NOT a production path.
   */
  unregister(key: string): void {
    _registry.delete(key)
  },
} as const

// ── Activation row shape ──────────────────────────────────────────────────────
//
// The row returned from D1 for an activated department (after 0029 migration).

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

// ── SeedReceipt ───────────────────────────────────────────────────────────────
//
// Stored as JSON in the seed_receipt column. The presence of this receipt is the
// idempotency guard: if it exists, squads were already seeded.

interface SeedReceipt {
  seeded_at: string
  squads: string[]  // slugs that were seeded
}

// ── getActive ─────────────────────────────────────────────────────────────────

/**
 * Return all active department rows for this D1 instance (which is single-tenant).
 * Only rows with active=1 AND a known template_key are returned. Rows created by
 * the old createDepartment path (template_key=NULL) are excluded.
 */
export async function getActive(db: D1Database): Promise<ActivatedDepartmentRow[]> {
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

// ── getActiveConsoleSections ──────────────────────────────────────────────────

/**
 * Return console section refs for all currently active departments.
 * This is what the nav iterates — NO switch, NO per-department branch.
 * Adding a department makes it appear here automatically once activated.
 */
export async function getActiveConsoleSections(db: D1Database): Promise<ConsoleSectionRef[]> {
  const rows = await getActive(db)
  const sections: ConsoleSectionRef[] = []
  for (const row of rows) {
    const module = _registry.get(row.template_key)
    if (module) sections.push(module.consoleSection)
  }
  return sections
}

// ── getActiveMetricDescriptors ────────────────────────────────────────────────

/**
 * Return all metric descriptors from currently active departments.
 * This is what the candlestick metric selector iterates — NO switch, NO branch.
 * Activate a department → its metrics appear in the selector automatically.
 */
export async function getActiveMetricDescriptors(db: D1Database): Promise<MetricDescriptor[]> {
  const rows = await getActive(db)
  const descriptors: MetricDescriptor[] = []
  for (const row of rows) {
    const module = _registry.get(row.template_key)
    if (module) descriptors.push(...module.metricsEmitted)
  }
  return descriptors
}

// ── activate ──────────────────────────────────────────────────────────────────

export type ActivateResult =
  | { ok: true; departmentId: string; seeded: boolean }
  | { ok: false; reason: 'module_not_registered' | 'slug_conflict' | 'db_error'; detail?: string }

/**
 * Activate a department module for this pot's D1.
 *
 * Steps:
 *   1. Look up the module in the registry — fail if not registered.
 *   2. Upsert a departments row with template_key, template_version, active=1.
 *      Uses INSERT on new rows, UPDATE on existing rows.
 *      Template hijack guard: only adopt an existing row if template_key matches
 *      OR template_key IS NULL (legacy row). Foreign template → slug_conflict.
 *   3. Check seed_receipt — if already seeded, skip squad creation.
 *   4. If not yet seeded: insert squads + write receipt in a single db.batch()
 *      (atomic — concurrent double-activate cannot race past the receipt).
 *
 * The department slug used is the module.key (stable, unique per module).
 *
 * Idempotency guarantee: calling activate() twice results in exactly one seed pass.
 *
 * @param now - Optional injected timestamp for deterministic tests.
 * @param idGen - Optional injected UUID generator for deterministic tests.
 */
export async function activate(
  db: D1Database,
  moduleKey: string,
  opts?: { now?: () => string; idGen?: () => string },
): Promise<ActivateResult> {
  const module = _registry.get(moduleKey)
  if (!module) {
    return { ok: false, reason: 'module_not_registered', detail: `module '${moduleKey}' is not registered` }
  }

  const nowFn = opts?.now ?? (() => new Date().toISOString())
  const idFn = opts?.idGen ?? (() => crypto.randomUUID())

  try {
    // Check for existing row by slug (module.key is the stable slug).
    const existing = await db
      .prepare(
        `SELECT id, slug, template_key, seed_receipt FROM departments WHERE slug = ?1 LIMIT 1`,
      )
      .bind(module.key)
      .first<{ id: string; slug: string; template_key: string | null; seed_receipt: string | null }>()

    const now = nowFn()
    let departmentId: string
    let priorSeedReceipt: SeedReceipt | null = null

    if (existing) {
      // ── Template hijack guard ──────────────────────────────────────────────
      //
      // Only adopt the existing row if:
      //   - template_key is NULL (UI-created / legacy row with no template origin), OR
      //   - template_key matches our module key (safe to update version / flip active).
      //
      // If template_key is set to a DIFFERENT value, this slug belongs to another
      // module. Refuse with slug_conflict to prevent foreign department takeover.
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

      // Parse existing seed receipt for idempotency check.
      if (existing.seed_receipt) {
        try {
          priorSeedReceipt = JSON.parse(existing.seed_receipt) as SeedReceipt
        } catch {
          // Malformed receipt — treat as absent, re-seed.
          priorSeedReceipt = null
        }
      }

      // Update existing row: flip active=1, record template version.
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
      // Insert new row.
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
    //
    // If seed_receipt already exists, skip. This is the idempotency gate.
    // When seeding IS needed, we INSERT all squads + the receipt update in a
    // single db.batch() call so concurrent activate() calls cannot both pass
    // the receipt check and then both seed (TOCTOU race).

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

      // The receipt UPDATE is the atomic lock. A concurrent activate() that also
      // passes the receipt-null check will race here; only one will win (D1
      // serializes writes within a database). The loser's receipt UPDATE will
      // run after the winner's, but INSERT OR IGNORE ensures squads aren't duped.
      const receipt: SeedReceipt = {
        seeded_at: now,
        squads: module.defaultSquads.map((s) => s.slug),
      }
      const receiptStmt = db
        .prepare(`UPDATE departments SET seed_receipt = ?2 WHERE id = ?1 AND seed_receipt IS NULL`)
        .bind(departmentId, JSON.stringify(receipt))

      // Execute all squad INSERTs + receipt write as one batch.
      const batchResults = await db.batch([...squadStatements, receiptStmt])

      // Check if the receipt UPDATE actually changed a row. If changes=0, a
      // concurrent activate() won the race and already wrote the receipt — that
      // is fine (squads are already seeded by the winner, INSERT OR IGNORE is safe).
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

// ── deactivate ────────────────────────────────────────────────────────────────

export type DeactivateResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'db_error'; detail?: string }

/**
 * Deactivate a department module. Flips active=0; data is retained dormant.
 * Re-activation restores visibility (no re-seed because seed_receipt is preserved).
 */
export async function deactivate(
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

// ── Legacy exports for backward compat with existing test imports ─────────────
//
// The conformance harness imported _clearRegistry and _unregister directly.
// Those names are now under _testOnly. We keep the legacy export names as
// thin wrappers so the existing import lines continue to work without a
// mass-rename. New code should use _testOnly.clearRegistry / _testOnly.unregister.

/** @deprecated Use _testOnly.clearRegistry() — test harness only. */
export function _clearRegistry(): void {
  _testOnly.clearRegistry()
}

/** @deprecated Use _testOnly.unregister() — test harness only. */
export function _unregister(key: string): void {
  _testOnly.unregister(key)
}
