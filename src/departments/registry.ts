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
//     - `listRegistered()` returns all registered modules.
//     - No switch / if-else on department keys anywhere in this file.
//
//   ACTIVATION is IDEMPOTENT (§3.4b):
//     - `activate()` checks for a seed_receipt before seeding squads.
//     - Re-activating an already-active department re-flips the active flag but
//       does NOT re-seed squads (seed receipt guard).
//     - template_version is recorded as activated_version at activation time.
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
import { assertWritten } from '../lib/receipt'

// ── In-process module registry ─────────────────────────────────────────────────
//
// A plain Map is sufficient: modules register at import time (or explicitly),
// and the map is read at activation/listing time. No persistence needed — the
// registry always rebuilds from module imports on each Worker invocation.

const _registry = new Map<string, DepartmentModule>()

/**
 * Register a DepartmentModule. Idempotent: re-registering the same key replaces
 * the previous entry (useful during tests). Registration is DATA-DRIVEN — this
 * function is the ONLY registration path. No switch or if-else on module.key.
 */
export function register(module: DepartmentModule): void {
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
  | { ok: false; reason: 'module_not_registered' | 'db_error'; detail?: string }

/**
 * Activate a department module for this pot's D1.
 *
 * Steps:
 *   1. Look up the module in the registry — fail if not registered.
 *   2. Upsert a departments row with template_key, template_version, active=1.
 *      Uses INSERT OR REPLACE (by slug) so activation is idempotent at the row level.
 *   3. Check seed_receipt — if already seeded, skip squad creation.
 *   4. If not yet seeded: call createSquad for each defaultSquad, write seed receipt.
 *
 * The department slug used is the module.key (stable, unique per module).
 * If a departments row with that slug already exists (from a prior activation),
 * we UPDATE rather than INSERT to preserve the existing id and created_at.
 *
 * Idempotency guarantee: calling activate() twice results in exactly one seed pass.
 */
export async function activate(
  db: D1Database,
  moduleKey: string,
): Promise<ActivateResult> {
  const module = _registry.get(moduleKey)
  if (!module) {
    return { ok: false, reason: 'module_not_registered', detail: `module '${moduleKey}' is not registered` }
  }

  try {
    // Check for existing row by slug (module.key is the stable slug).
    const existing = await db
      .prepare(
        `SELECT id, slug, seed_receipt FROM departments WHERE slug = ?1 LIMIT 1`,
      )
      .bind(module.key)
      .first<{ id: string; slug: string; seed_receipt: string | null }>()

    const now = new Date().toISOString()
    let departmentId: string
    let priorSeedReceipt: SeedReceipt | null = null

    if (existing) {
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
      departmentId = crypto.randomUUID()
      const insertResult = await db
        .prepare(
          `INSERT INTO departments (id, slug, name, template_key, template_version, activated_at, active, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)`,
        )
        .bind(departmentId, module.key, module.name, module.key, module.version, now, now)
        .run()
      assertWritten(insertResult, `departments.activate.insert(${module.key})`)
    }

    // ── Idempotent squad seeding ───────────────────────────────────────────
    //
    // If seed_receipt already exists and covers the same set of squads, skip.
    // Guard is: receipt present = already seeded = no double-seed.

    let seeded = false
    if (!priorSeedReceipt && module.defaultSquads.length > 0) {
      const seededSlugs: string[] = []

      for (const seed of module.defaultSquads) {
        const squadId = crypto.randomUUID()
        try {
          const r = await db
            .prepare(
              `INSERT INTO squads (id, department_id, slug, name, charter, created_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            )
            .bind(squadId, departmentId, seed.slug, seed.name, seed.charter ?? null, now)
            .run()
          assertWritten(r, `squads.seed(${seed.slug})`)
          seededSlugs.push(seed.slug)
        } catch (err) {
          // UNIQUE(department_id, slug) conflict means squad already exists — skip.
          if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
            seededSlugs.push(seed.slug)
            continue
          }
          throw err
        }
      }

      // Write seed receipt so re-activation skips this block.
      const receipt: SeedReceipt = { seeded_at: now, squads: seededSlugs }
      const receiptResult = await db
        .prepare(`UPDATE departments SET seed_receipt = ?2 WHERE id = ?1`)
        .bind(departmentId, JSON.stringify(receipt))
        .run()
      assertWritten(receiptResult, `departments.seed_receipt(${module.key})`)
      seeded = true
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

// ── clearRegistry (test use only) ─────────────────────────────────────────────
//
// Used by the conformance harness to test isolation (remove fixture module and
// verify siblings are unaffected). NOT exported as part of the public API — only
// test files import this.

export function _clearRegistry(): void {
  _registry.clear()
}

export function _unregister(key: string): void {
  _registry.delete(key)
}
