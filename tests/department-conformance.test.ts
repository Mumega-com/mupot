// tests/department-conformance.test.ts — department microkernel conformance harness.
//
// PURPOSE: Mechanically prove the microkernel litmus (§3.5 of
// console-department-microkernel.md) BEFORE any real department is built.
//
// The harness drives the fixture department (key='fixture') through the full
// microkernel lifecycle and asserts every invariant enumerated in the spec.
//
// STRUCTURAL ASSERTION (§3.5 — the litmus, stated once in prose):
//   Adding the fixture department to the microkernel required ONLY:
//     1. src/departments/modules/fixture.ts  (new module file)
//     2. One register() call within that file (registry plumbing — NOT a kernel edit)
//   The following were NOT edited:
//     - src/departments/contract.ts          (kernel contract — unchanged)
//     - src/departments/registry.ts          (kernel registry logic — unchanged)
//     - src/departments/ctx.ts               (confinement mechanism — unchanged)
//     - src/dashboard/index.ts               (nav/shell — unchanged)
//     - src/metrics/pulse.ts                 (metric selector spine — unchanged)
//     - src/auth/capability.ts               (capability resolver — unchanged)
//     - migrations/                          (DB schema — 0029 adds columns, not dept-specific)
//     - any sibling department module        (none exist yet; adding one later = same rule)
//   Isolation: removing fixture.ts + its register() call leaves all other tests GREEN.
//
// Test groups:
//   1. Registration — module appears in registry after import.
//   2. Activation + lifecycle — getActive / getActiveConsoleSections / getActiveMetricDescriptors.
//   3. Idempotent activation — activate twice → seeds once (seed receipt guard).
//   4. Deactivate / reactivate — data retained, visibility restored.
//   5. Isolation — unregister fixture, all lists empty, no crash.
//   6. Capability confinement via ctx — key ownership, source authority, tenant bind.
//   7. Honesty propagation — ohlcEligible=false → seriesShape() returns 'bar'.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

// --- Department microkernel imports ---
import { FixtureModule } from '../src/departments/modules/fixture'
import {
  register,
  listRegistered,
  getRegistered,
  getActive,
  getActiveConsoleSections,
  getActiveMetricDescriptors,
  activate,
  deactivate,
  _clearRegistry,
  _unregister,
} from '../src/departments/registry'
import { mintCtx, CtxError } from '../src/departments/ctx'

// --- Pulse spine imports for honesty propagation test ---
import { seriesShape, aggregateOHLC } from '../src/metrics/pulse'
import type { OHLCBucket } from '../src/metrics/pulse'

// ── In-memory D1 mock ────────────────────────────────────────────────────────
//
// Handles the SQL shapes used by registry.ts:
//   - SELECT … FROM departments WHERE slug = ?1 LIMIT 1       (lookup by slug)
//   - INSERT INTO departments (…) VALUES (…)
//   - UPDATE departments SET … WHERE id = ?1
//   - UPDATE departments SET active = 0 WHERE slug = ?1 AND template_key = ?1
//   - SELECT … FROM departments WHERE active = 1 AND template_key IS NOT NULL
//   - INSERT INTO squads (…) VALUES (…)
//
// The store is a plain array — real row semantics (UNIQUE on slug enforced).

interface DeptRow {
  id: string
  slug: string
  name: string
  template_key: string | null
  template_version: string | null
  activated_at: string | null
  active: number
  seed_receipt: string | null
  created_at: string
}

interface SquadRow {
  id: string
  department_id: string
  slug: string
  name: string
  charter: string | null
  created_at: string
}

function makeDb(): {
  db: D1Database
  depts: () => DeptRow[]
  squads: () => SquadRow[]
} {
  const depts: DeptRow[] = []
  const squads: SquadRow[] = []

  function runSql(sql: string, args: unknown[]) {
    const upper = sql.trim().toUpperCase()

    // ── INSERT INTO departments ─────────────────────────────────────────────
    if (upper.startsWith('INSERT INTO DEPARTMENTS')) {
      const [id, slug, name, template_key, template_version, activated_at, , created_at] =
        args as [string, string, string, string, string, string, number, string]
      const conflict = depts.some((d) => d.slug === slug)
      if (conflict) throw new Error('UNIQUE constraint failed: departments.slug')
      depts.push({
        id,
        slug,
        name,
        template_key,
        template_version,
        activated_at,
        active: 1,
        seed_receipt: null,
        created_at,
      })
      return { success: true, meta: { changes: 1 } }
    }

    // ── UPDATE departments SET active=1 / template fields ───────────────────
    if (upper.startsWith('UPDATE DEPARTMENTS') && upper.includes('SET ACTIVE = 1')) {
      const [id, template_key, template_version, activated_at_coalesce, name] = args as [
        string, string, string, string, string,
      ]
      const row = depts.find((d) => d.id === id)
      if (!row) return { success: true, meta: { changes: 0 } }
      row.active = 1
      row.template_key = template_key
      row.template_version = template_version
      // COALESCE semantics: only set if currently null
      if (!row.activated_at) row.activated_at = activated_at_coalesce
      row.name = name
      return { success: true, meta: { changes: 1 } }
    }

    // ── UPDATE departments SET seed_receipt ──────────────────────────────────
    if (upper.startsWith('UPDATE DEPARTMENTS') && upper.includes('SEED_RECEIPT')) {
      const [id, receipt] = args as [string, string]
      const row = depts.find((d) => d.id === id)
      if (!row) return { success: true, meta: { changes: 0 } }
      row.seed_receipt = receipt
      return { success: true, meta: { changes: 1 } }
    }

    // ── UPDATE departments SET active=0 (deactivate) ────────────────────────
    if (upper.startsWith('UPDATE DEPARTMENTS') && upper.includes('ACTIVE = 0')) {
      const [slug] = args as [string]
      const row = depts.find((d) => d.slug === slug && d.template_key === slug)
      if (!row) return { success: true, meta: { changes: 0 } }
      row.active = 0
      return { success: true, meta: { changes: 1 } }
    }

    // ── INSERT INTO squads ──────────────────────────────────────────────────
    if (upper.startsWith('INSERT INTO SQUADS')) {
      const [id, department_id, slug, name, charter, created_at] = args as [
        string, string, string, string, string | null, string,
      ]
      const conflict = squads.some(
        (s) => s.department_id === department_id && s.slug === slug,
      )
      if (conflict) throw new Error('UNIQUE constraint failed: squads.department_id, squads.slug')
      squads.push({ id, department_id, slug, name, charter, created_at })
      return { success: true, meta: { changes: 1 } }
    }

    return { success: true, meta: { changes: 0 } }
  }

  function allSql(sql: string, _args: unknown[]) {
    const upper = sql.trim().toUpperCase()

    // ── SELECT from departments WHERE slug = ?1 LIMIT 1 (exists check) ──────
    if (upper.includes('FROM DEPARTMENTS') && upper.includes('WHERE SLUG')) {
      const [slug] = _args as [string]
      const row = depts.find((d) => d.slug === slug) ?? null
      // first() is called on this stmt — return { results: [row] } or { results: [] }
      return { results: row ? [row] : [], success: true }
    }

    // ── SELECT from departments WHERE active = 1 AND template_key IS NOT NULL ─
    if (upper.includes('FROM DEPARTMENTS') && upper.includes('ACTIVE = 1')) {
      const active = depts.filter((d) => d.active === 1 && d.template_key !== null)
      active.sort((a, b) => (a.activated_at ?? '').localeCompare(b.activated_at ?? ''))
      return { results: active, success: true }
    }

    return { results: [], success: true }
  }

  const db = {
    prepare(sql: string) {
      const boundArgs: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) {
          boundArgs.push(...args)
          return stmt
        },
        async run() {
          return runSql(sql, boundArgs)
        },
        async all() {
          return allSql(sql, boundArgs)
        },
        // first() — used by the SELECT ... LIMIT 1 slug lookup
        async first() {
          const r = allSql(sql, boundArgs)
          return r.results[0] ?? null
        },
      }
      return stmt
    },
  } as unknown as D1Database

  return {
    db,
    depts: () => depts,
    squads: () => squads,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal KernelHandle-like object for mintCtx. */
function makeKernelHandle(db: D1Database) {
  return { db }
}

// A D1 mock that handles metric_points INSERTs (used by ctx.metrics.emit tests).
// Separate from makeDb() which handles departments/squads.
interface MetricRow {
  id: string
  tenant_id: string
  metric_key: string
  value: number
  occurred_at: string
  source: string
  created_at: string
}

function makeMetricDb(): { db: D1Database; rows: () => MetricRow[] } {
  const store: MetricRow[] = []

  const db = {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase()
      const boundArgs: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) {
          boundArgs.push(...args)
          return stmt
        },
        async run() {
          if (upper.includes('INSERT INTO METRIC_POINTS')) {
            const [id, tenant_id, metric_key, value, occurred_at, source, created_at] =
              boundArgs as [string, string, string, number, string, string, string]
            // PK collision
            if (store.some((r) => r.id === id)) {
              throw new Error('UNIQUE constraint failed: metric_points.id')
            }
            // Composite UNIQUE collision
            if (
              store.some(
                (r) =>
                  r.tenant_id === tenant_id &&
                  r.metric_key === metric_key &&
                  r.occurred_at === occurred_at &&
                  r.source === source,
              )
            ) {
              throw new Error(
                'UNIQUE constraint failed: metric_points.tenant_id, metric_points.metric_key, metric_points.occurred_at, metric_points.source',
              )
            }
            store.push({ id, tenant_id, metric_key, value, occurred_at, source, created_at })
            return { success: true, meta: { changes: 1 } }
          }
          return { success: true, meta: { changes: 0 } }
        },
        async all() {
          return { results: [], success: true }
        },
        async first() {
          return null
        },
      }
      return stmt
    },
  } as unknown as D1Database

  return { db, rows: () => store }
}

// ── 0. Guard: module is registered by import ──────────────────────────────────
//
// FixtureModule is imported at the top of this file; the side-effect register()
// call in fixture.ts fires at import time. Verify it's in the registry.

describe('0. Registration guard', () => {
  it('FixtureModule is registered by importing fixture.ts', () => {
    // Importing the module at top-of-file already called register(FixtureModule).
    const found = getRegistered('fixture')
    expect(found).toBeDefined()
    expect(found?.key).toBe('fixture')
    expect(found?.name).toBe('Fixture (Test Department)')
  })

  it('listRegistered() includes fixture (registry-driven, no switch)', () => {
    const all = listRegistered()
    const keys = all.map((m) => m.key)
    expect(keys).toContain('fixture')
  })

  it('fixture declares 2 metric descriptors', () => {
    expect(FixtureModule.metricsEmitted).toHaveLength(2)
    const keys = FixtureModule.metricsEmitted.map((d) => d.key)
    expect(keys).toContain('fixture.pings')
    expect(keys).toContain('fixture.scalar')
  })
})

// ── 1. Activation + dynamic lists ────────────────────────────────────────────

describe('1. Activation — getActive / ConsoleSections / MetricDescriptors', () => {
  let db: D1Database

  beforeEach(() => {
    // Re-register fixture in case isolation tests cleared the registry.
    register(FixtureModule)
    const store = makeDb()
    db = store.db
  })

  it('before activation: getActive returns empty list', async () => {
    const active = await getActive(db)
    expect(active).toHaveLength(0)
  })

  it('activate() returns ok:true and a departmentId', async () => {
    const result = await activate(db, 'fixture')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('activation failed')
    expect(typeof result.departmentId).toBe('string')
    expect(result.departmentId.length).toBeGreaterThan(0)
    expect(result.seeded).toBe(true) // first activation → squads seeded
  })

  it('after activation: getActive includes the fixture row', async () => {
    await activate(db, 'fixture')
    const active = await getActive(db)
    expect(active).toHaveLength(1)
    expect(active[0].template_key).toBe('fixture')
    expect(active[0].active).toBe(1)
    expect(active[0].template_version).toBe('0.1.0')
  })

  it('getActiveConsoleSections() returns fixture section WITHOUT per-dept branching', async () => {
    await activate(db, 'fixture')
    const sections = await getActiveConsoleSections(db)
    expect(sections).toHaveLength(1)
    expect(sections[0].id).toBe('fixture')
    expect(sections[0].navIcon).toBe('beaker')
    expect(sections[0].path).toBe('/departments/fixture')
    // STRUCTURAL: the registry iterated getActive() → matched registered module.
    // No switch statement was needed to produce this result.
  })

  it('getActiveMetricDescriptors() returns fixture descriptors WITHOUT per-dept branching', async () => {
    await activate(db, 'fixture')
    const descs = await getActiveMetricDescriptors(db)
    expect(descs).toHaveLength(2)
    const keys = descs.map((d) => d.key)
    expect(keys).toContain('fixture.pings')
    expect(keys).toContain('fixture.scalar')
    // STRUCTURAL: no switch — the registry iterated active rows and spread metricsEmitted.
  })

  it('activate() fails cleanly for an unregistered module key', async () => {
    const result = await activate(db, 'no-such-module')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('should have failed')
    expect(result.reason).toBe('module_not_registered')
  })
})

// ── 2. Idempotent activation — seed receipt guard ────────────────────────────

describe('2. Idempotent activation — activate twice → seeds once', () => {
  let db: D1Database
  let store: ReturnType<typeof makeDb>

  beforeEach(() => {
    register(FixtureModule)
    store = makeDb()
    db = store.db
  })

  it('first activation seeds the default squad', async () => {
    const r1 = await activate(db, 'fixture')
    expect(r1.ok).toBe(true)
    if (!r1.ok) throw new Error()
    expect(r1.seeded).toBe(true)
    // One squad row created.
    expect(store.squads()).toHaveLength(1)
    expect(store.squads()[0].slug).toBe('fixture-core')
  })

  it('second activation does NOT double-seed (seed receipt guard)', async () => {
    await activate(db, 'fixture')
    const r2 = await activate(db, 'fixture')
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error()
    // seeded=false: receipt found, squad creation skipped.
    expect(r2.seeded).toBe(false)
    // Still exactly one squad row — NOT two.
    expect(store.squads()).toHaveLength(1)
  })

  it('seed_receipt column is written after first activation', async () => {
    await activate(db, 'fixture')
    const row = store.depts().find((d) => d.template_key === 'fixture')!
    expect(row.seed_receipt).not.toBeNull()
    const receipt = JSON.parse(row.seed_receipt!) as { seeded_at: string; squads: string[] }
    expect(receipt.squads).toContain('fixture-core')
    expect(typeof receipt.seeded_at).toBe('string')
  })

  it('three activations → still only one squad row', async () => {
    await activate(db, 'fixture')
    await activate(db, 'fixture')
    await activate(db, 'fixture')
    expect(store.squads()).toHaveLength(1)
  })
})

// ── 3. Deactivate / reactivate — data retained ───────────────────────────────

describe('3. Deactivate / reactivate — data retained', () => {
  let db: D1Database
  let store: ReturnType<typeof makeDb>

  beforeEach(() => {
    register(FixtureModule)
    store = makeDb()
    db = store.db
  })

  it('deactivate hides department from getActive', async () => {
    await activate(db, 'fixture')
    expect(await getActive(db)).toHaveLength(1)

    const r = await deactivate(db, 'fixture')
    expect(r.ok).toBe(true)

    expect(await getActive(db)).toHaveLength(0)
  })

  it('deactivate removes section from getActiveConsoleSections', async () => {
    await activate(db, 'fixture')
    await deactivate(db, 'fixture')
    const sections = await getActiveConsoleSections(db)
    expect(sections).toHaveLength(0)
  })

  it('deactivate removes descriptors from getActiveMetricDescriptors', async () => {
    await activate(db, 'fixture')
    await deactivate(db, 'fixture')
    const descs = await getActiveMetricDescriptors(db)
    expect(descs).toHaveLength(0)
  })

  it('squad row is retained (data dormant) after deactivation', async () => {
    await activate(db, 'fixture')
    await deactivate(db, 'fixture')
    // Squad rows are NOT deleted on deactivation — data retained dormant.
    expect(store.squads()).toHaveLength(1)
  })

  it('reactivate after deactivate restores visibility', async () => {
    await activate(db, 'fixture')
    await deactivate(db, 'fixture')
    await activate(db, 'fixture')

    expect(await getActive(db)).toHaveLength(1)
    expect(await getActiveConsoleSections(db)).toHaveLength(1)
    expect(await getActiveMetricDescriptors(db)).toHaveLength(2)
  })

  it('reactivation after deactivate does NOT re-seed (receipt preserved)', async () => {
    await activate(db, 'fixture')
    await deactivate(db, 'fixture')
    const r = await activate(db, 'fixture')
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error()
    expect(r.seeded).toBe(false) // seed_receipt still present → skip
    expect(store.squads()).toHaveLength(1) // still one squad
  })

  it('deactivate on non-activated key returns not_found', async () => {
    const r = await deactivate(db, 'fixture')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error()
    expect(r.reason).toBe('not_found')
  })
})

// ── 4. Isolation — removing fixture leaves everything else green ──────────────
//
// This group verifies that the fixture has NO coupling to the kernel or siblings.
// After _unregister('fixture'), the dynamic lists return empty; no other test fails.

describe('4. Isolation — unregister fixture, kernel is unaffected', () => {
  let db: D1Database

  beforeEach(() => {
    register(FixtureModule)
    const store = makeDb()
    db = store.db
  })

  it('after _unregister: fixture is absent from listRegistered()', () => {
    _unregister('fixture')
    const keys = listRegistered().map((m) => m.key)
    expect(keys).not.toContain('fixture')
  })

  it('after _unregister: getActiveConsoleSections() returns empty without crashing', async () => {
    await activate(db, 'fixture') // activate while registered
    _unregister('fixture')
    // The row exists in DB but the module is gone from the registry.
    // getActiveConsoleSections skips rows whose template_key has no registered module.
    const sections = await getActiveConsoleSections(db)
    expect(sections).toHaveLength(0)
  })

  it('after _unregister: getActiveMetricDescriptors() returns empty without crashing', async () => {
    await activate(db, 'fixture')
    _unregister('fixture')
    const descs = await getActiveMetricDescriptors(db)
    expect(descs).toHaveLength(0)
  })

  it('after _clearRegistry: all lists are empty; no crash or exception', async () => {
    await activate(db, 'fixture')
    _clearRegistry()
    expect(listRegistered()).toHaveLength(0)
    expect(await getActiveConsoleSections(db)).toHaveLength(0)
    expect(await getActiveMetricDescriptors(db)).toHaveLength(0)
  })

  afterEach(() => {
    // Restore fixture so subsequent groups work.
    register(FixtureModule)
  })
})

// ── 5. Capability confinement via ctx ─────────────────────────────────────────
//
// These tests prove that DepartmentCtx enforces ownership + source authority +
// tenant binding WITHOUT the module holding any raw DB/Env handle.

describe('5. Capability confinement via ctx', () => {
  let db: D1Database

  beforeEach(() => {
    register(FixtureModule)
    db = makeDb().db
  })

  // ── metrics.emit: key ownership ──────────────────────────────────────────

  it('metrics.emit rejects a key not in metricsEmitted (key not owned)', async () => {
    const ctx = mintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    await expect(
      ctx.metrics.emit({
        key: 'growth.revenue', // not a fixture key
        value: 10,
        occurredAt: '2026-06-17T10:00:00.000Z',
        source: 'fixture-harness',
      }),
    ).rejects.toThrow(/key_not_owned|is not declared/)
  })

  // ── metrics.emit: source authority ───────────────────────────────────────

  it('metrics.emit rejects a source not in sourceAuthority', async () => {
    const ctx = mintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    await expect(
      ctx.metrics.emit({
        key: 'fixture.pings',
        value: 5,
        occurredAt: '2026-06-17T10:00:00.000Z',
        source: 'stripe', // NOT in fixture.pings.sourceAuthority
      }),
    ).rejects.toThrow(/source_not_authorized|not in sourceAuthority/)
  })

  it('metrics.emit accepts a valid source from sourceAuthority', async () => {
    // Use the metric_points-aware mock so the INSERT path succeeds.
    const metricStore = makeMetricDb()
    const ctx = mintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    const result = await ctx.metrics.emit({
      key: 'fixture.pings',
      value: 3,
      occurredAt: '2026-06-17T10:01:00.000Z',
      source: 'fixture-harness',
    })
    expect(result.ok).toBe(true)
  })

  // ── metrics.emit: non-finite value ────────────────────────────────────────

  it('metrics.emit rejects a non-finite value', async () => {
    const ctx = mintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    await expect(
      ctx.metrics.emit({
        key: 'fixture.pings',
        value: NaN,
        occurredAt: '2026-06-17T10:00:00.000Z',
        source: 'fixture-harness',
      }),
    ).rejects.toThrow(/value_not_finite|must be finite/)
  })

  // ── tenant binding ────────────────────────────────────────────────────────
  //
  // A ctx minted for tenant-a binds tenant-a in all emitMetric calls.
  // A ctx minted for tenant-b cannot emit to tenant-a's namespace.
  // We verify this by checking the stored row's tenant_id.

  it('tenant is bound from ctx — module cannot override tenant via input', async () => {
    // Use the metric_points-aware mock so both emits can succeed.
    const metricStore = makeMetricDb()
    const ctx = mintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    await ctx.metrics.emit({
      key: 'fixture.pings',
      value: 1,
      occurredAt: '2026-06-17T10:02:00.000Z',
      source: 'fixture-harness',
    })
    // Verify tenant-a's row is in the store.
    expect(metricStore.rows()[0].tenant_id).toBe('tenant-a')

    // A ctx for tenant-b emitting the same key+time+source → different tenant_id
    // → NOT a UNIQUE collision (the composite key includes tenant_id).
    const ctxB = mintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-b',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    const r = await ctxB.metrics.emit({
      key: 'fixture.pings',
      value: 99,
      occurredAt: '2026-06-17T10:02:00.000Z',
      source: 'fixture-harness',
    })
    expect(r.ok).toBe(true)
    // Verify tenant-b's row is stored separately.
    expect(metricStore.rows()[1].tenant_id).toBe('tenant-b')
  })

  // ── capability check ──────────────────────────────────────────────────────

  it('ctx with empty capabilities is denied on metrics.emit', async () => {
    const ctx = mintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: [], // no capabilities
    })
    await expect(
      ctx.metrics.emit({
        key: 'fixture.pings',
        value: 1,
        occurredAt: '2026-06-17T10:00:00.000Z',
        source: 'fixture-harness',
      }),
    ).rejects.toThrow(/capability_denied/)
  })

  it('ctx with observer capability is denied on metrics.emit (requires member)', async () => {
    const ctx = mintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['observer'], // below 'member'
    })
    await expect(
      ctx.metrics.emit({
        key: 'fixture.pings',
        value: 1,
        occurredAt: '2026-06-17T10:00:00.000Z',
        source: 'fixture-harness',
      }),
    ).rejects.toThrow(/capability_denied/)
  })

  it('ctx with lead capability passes (lead > member)', async () => {
    const metricStore = makeMetricDb()
    const ctx = mintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['lead'],
    })
    const r = await ctx.metrics.emit({
      key: 'fixture.pings',
      value: 7,
      occurredAt: '2026-06-17T11:00:00.000Z',
      source: 'fixture-harness',
    })
    expect(r.ok).toBe(true)
  })

  it('ctx has NO raw db/env properties — module cannot access raw handle', () => {
    const ctx = mintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    // The ctx object must NOT expose raw DB or Env.
    // We check that none of the known raw-handle keys are present on the ctx.
    const ctxAsRecord = ctx as Record<string, unknown>
    expect(ctxAsRecord['DB']).toBeUndefined()
    expect(ctxAsRecord['env']).toBeUndefined()
    expect(ctxAsRecord['KV']).toBeUndefined()
    expect(ctxAsRecord['SESSIONS']).toBeUndefined()
    expect(ctxAsRecord['BUS']).toBeUndefined()
    // The ctx DOES expose port facades — verify they are functions, not raw handles.
    expect(typeof ctx.metrics.emit).toBe('function')
    expect(typeof ctx.db.query).toBe('function')
    expect(typeof ctx.audit.write).toBe('function')
    expect(typeof ctx.gate.propose).toBe('function')
    expect(typeof ctx.bus.publish).toBe('function')
  })

  // ── CtxError is used for confinement violations ────────────────────────────

  it('confinement violations throw CtxError (not generic Error)', async () => {
    const ctx = mintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    const err = await ctx.metrics.emit({
      key: 'growth.revenue', // not owned
      value: 1,
      occurredAt: '2026-06-17T10:00:00.000Z',
      source: 'fixture-harness',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CtxError)
    expect((err as CtxError).code).toBe('key_not_owned')
  })
})

// ── 6. Honesty propagation — ohlcEligible=false → bar (not candle) ────────────
//
// §4.2: a MetricDescriptor with ohlcEligible=false must NEVER yield a candle,
// even when there are multiple readings per day. The honesty guard is:
//   1. Declared on the descriptor (ohlcEligible field).
//   2. Propagated via getActiveMetricDescriptors() so the selector can filter.
//   3. seriesShape() independently returns 'bar' for single-reading days (the
//      OHLC spine guard). This tests that the descriptor's declaration matches
//      real series behavior.

describe('6. Honesty propagation — ohlcEligible and seriesShape', () => {
  let db: D1Database

  beforeEach(() => {
    register(FixtureModule)
    db = makeDb().db
  })

  it('fixture.scalar descriptor declares ohlcEligible=false', () => {
    const scalar = FixtureModule.metricsEmitted.find((d) => d.key === 'fixture.scalar')!
    expect(scalar).toBeDefined()
    expect(scalar.ohlcEligible).toBe(false)
    expect(scalar.cadence).toBe('daily')
  })

  it('fixture.pings descriptor declares ohlcEligible=true', () => {
    const pings = FixtureModule.metricsEmitted.find((d) => d.key === 'fixture.pings')!
    expect(pings).toBeDefined()
    expect(pings.ohlcEligible).toBe(true)
    expect(pings.cadence).toBe('realtime')
  })

  it('getActiveMetricDescriptors propagates ohlcEligible=false for fixture.scalar', async () => {
    await activate(db, 'fixture')
    const descs = await getActiveMetricDescriptors(db)
    const scalar = descs.find((d) => d.key === 'fixture.scalar')!
    expect(scalar.ohlcEligible).toBe(false)
    // The candlestick metric selector must filter this out of candle options.
  })

  it('seriesShape returns bar for single-reading-per-day series (ohlc honesty spine)', () => {
    // A fixture.scalar series: one reading per day — O==H==L==C → bar, not candle.
    const buckets: OHLCBucket[] = [
      { date: '2026-06-15', open: 5, high: 5, low: 5, close: 5, count: 1 },
      { date: '2026-06-16', open: 7, high: 7, low: 7, close: 7, count: 1 },
    ]
    expect(seriesShape(buckets)).toBe('bar')
  })

  it('seriesShape returns candle when any day has count >= 2 (fixture.pings eligible)', () => {
    // A fixture.pings series: multiple readings in a day → real OHLC.
    const buckets: OHLCBucket[] = [
      { date: '2026-06-15', open: 1, high: 5, low: 1, close: 4, count: 4 },
      { date: '2026-06-16', open: 2, high: 2, low: 2, close: 2, count: 1 },
    ]
    expect(seriesShape(buckets)).toBe('candle')
  })

  it('empty series → bar (honest empty state, no fabricated candle)', () => {
    expect(seriesShape([])).toBe('bar')
  })

  it('aggregateOHLC on single-reading-per-day → count=1 per bucket (confirms bar verdict)', () => {
    const readings = [
      { value: 5, occurredAt: '2026-06-15T09:00:00.000Z' },
      { value: 7, occurredAt: '2026-06-16T09:00:00.000Z' },
    ]
    const buckets = aggregateOHLC(readings, { bucket: 'day' })
    expect(buckets).toHaveLength(2)
    // Each bucket has count=1 → O==H==L==C → seriesShape returns 'bar'.
    expect(buckets.every((b) => b.count === 1)).toBe(true)
    expect(seriesShape(buckets)).toBe('bar')
  })
})

// ── Cleanup after all tests ───────────────────────────────────────────────────

// Restore the fixture registration so it doesn't bleed into other test files.
// (vitest runs test files in isolated module contexts by default, but this is
// belt-and-suspenders for in-process registry state.)
afterAll(() => {
  register(FixtureModule)
})
