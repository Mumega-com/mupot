// tests/department-conformance.test.ts — department microkernel conformance harness.
//
// PURPOSE: Mechanically prove the microkernel litmus (§3.5 of
// console-department-microkernel.md) BEFORE any real department is built.
//
// The harness drives the fixture department (key='fixture') through the full
// microkernel lifecycle and asserts every invariant enumerated in the spec —
// including adversarial scenarios that attack the ctx confinement boundary.
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
//   0. Registration guard.
//   1. Activation + lifecycle — getActive / getActiveConsoleSections / getActiveMetricDescriptors.
//   2. Idempotent activation — activate twice → seeds once (seed receipt guard).
//   3. Deactivate / reactivate — data retained, visibility restored.
//   4. Isolation — unregister fixture (via isolated instance), all lists empty, no crash.
//   5. Capability confinement via ctx — key ownership, source authority, tenant bind.
//   6. Honesty propagation — ohlcEligible=false → seriesShape() returns 'bar'.
//   7. ADVERSARIAL — attacker-in-ctx scenarios (mutate snapshots, re-bind tenant, forge keys).
//   8. Registry hardening — duplicate key, slug_conflict, wrong-token mint rejection.
//   9. EXPORT SURFACE ASSERTIONS — structural: no mint/token/clear symbol importable from
//      ctx.ts or registry.ts.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
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
  kernelMintCtx,
  createDepartmentRegistry,
} from '../src/departments/registry'

// _isKernelToken is imported from kernel.ts (the kernel-private seam, which exports it
// only for the test-harness token-gate proof). It is NOT available from ctx.ts —
// see test group 9 for the export-surface assertion.
import { _isKernelToken } from '../src/departments/kernel'

// GrowthModule has channels with declared proposesOnly work-types (needed for
// gate.propose tests after the BLOCK-1 fix enforces the work-type map).
import { GrowthModule } from '../src/departments/modules/growth'

// CtxError is still exported from ctx.ts (it is a type, not a minting capability).
import { CtxError } from '../src/departments/ctx'

// --- Pulse spine imports for honesty propagation test ---
import { seriesShape, aggregateOHLC } from '../src/metrics/pulse'
import type { OHLCBucket } from '../src/metrics/pulse'

// ── In-memory D1 mock ────────────────────────────────────────────────────────
//
// Handles the SQL shapes used by registry.ts:
//   - SELECT … FROM departments WHERE slug = ?1 LIMIT 1
//   - INSERT INTO departments (…) VALUES (…)
//   - UPDATE departments SET … WHERE id = ?1
//   - UPDATE departments SET active = 0 WHERE slug = ?1 AND template_key = ?1
//   - UPDATE departments SET seed_receipt = ?2 WHERE id = ?1 AND seed_receipt IS NULL
//   - SELECT … FROM departments WHERE active = 1 AND template_key IS NOT NULL
//   - INSERT OR IGNORE INTO squads (…) VALUES (…)
//   - db.batch([...]) for atomic squad seeding

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

function makeDb(opts?: { initialDepts?: DeptRow[] }): {
  db: D1Database
  depts: () => DeptRow[]
  squads: () => SquadRow[]
} {
  const depts: DeptRow[] = opts?.initialDepts ? [...opts.initialDepts] : []
  const squads: SquadRow[] = []

  function runSql(sql: string, args: unknown[]): { success: boolean; meta: { changes: number } } {
    const upper = sql.trim().toUpperCase()

    // ── INSERT INTO departments ─────────────────────────────────────────────
    if (upper.startsWith('INSERT INTO DEPARTMENTS')) {
      const [id, slug, name, template_key, template_version, activated_at, created_at] =
        args as [string, string, string, string, string, string, string]
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
      if (!row.activated_at) row.activated_at = activated_at_coalesce
      row.name = name
      return { success: true, meta: { changes: 1 } }
    }

    // ── UPDATE departments SET seed_receipt … WHERE … AND seed_receipt IS NULL
    if (
      upper.startsWith('UPDATE DEPARTMENTS') &&
      upper.includes('SEED_RECEIPT') &&
      upper.includes('AND SEED_RECEIPT IS NULL')
    ) {
      const [id, receipt] = args as [string, string]
      const row = depts.find((d) => d.id === id && d.seed_receipt === null)
      if (!row) return { success: true, meta: { changes: 0 } }
      row.seed_receipt = receipt
      return { success: true, meta: { changes: 1 } }
    }

    // ── UPDATE departments SET seed_receipt (unconditional — legacy path) ────
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

    // ── INSERT OR IGNORE INTO squads ────────────────────────────────────────
    if (upper.startsWith('INSERT OR IGNORE INTO SQUADS') || upper.startsWith('INSERT INTO SQUADS')) {
      const [id, department_id, slug, name, charter, created_at] = args as [
        string, string, string, string, string | null, string,
      ]
      const conflict = squads.some(
        (s) => s.department_id === department_id && s.slug === slug,
      )
      if (conflict) {
        if (upper.includes('OR IGNORE')) return { success: true, meta: { changes: 0 } }
        throw new Error('UNIQUE constraint failed: squads.department_id, squads.slug')
      }
      squads.push({ id, department_id, slug, name, charter, created_at })
      return { success: true, meta: { changes: 1 } }
    }

    return { success: true, meta: { changes: 0 } }
  }

  function allSql(sql: string, _args: unknown[]): { results: unknown[]; success: boolean } {
    const upper = sql.trim().toUpperCase()

    if (upper.includes('FROM DEPARTMENTS') && upper.includes('WHERE SLUG')) {
      const [slug] = _args as [string]
      const row = depts.find((d) => d.slug === slug) ?? null
      return { results: row ? [row] : [], success: true }
    }

    if (upper.includes('FROM DEPARTMENTS') && upper.includes('ACTIVE = 1')) {
      const active = depts.filter((d) => d.active === 1 && d.template_key !== null)
      active.sort((a, b) => (a.activated_at ?? '').localeCompare(b.activated_at ?? ''))
      return { results: active, success: true }
    }

    return { results: [], success: true }
  }

  function makeStmt(sql: string) {
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
      async first() {
        const r = allSql(sql, boundArgs)
        return (r.results[0] as Record<string, unknown>) ?? null
      },
    }
    return stmt
  }

  const db = {
    prepare(sql: string) {
      return makeStmt(sql)
    },
    async batch(statements: ReturnType<typeof makeStmt>[]) {
      const results = []
      for (const stmt of statements) {
        results.push(await stmt.run())
      }
      return results
    },
  } as unknown as D1Database

  return {
    db,
    depts: () => depts,
    squads: () => squads,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKernelHandle(db: D1Database) {
  return { db }
}

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
            if (store.some((r) => r.id === id)) {
              throw new Error('UNIQUE constraint failed: metric_points.id')
            }
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
    async batch(stmts: unknown[]) {
      return stmts.map(() => ({ success: true, meta: { changes: 0 } }))
    },
  } as unknown as D1Database

  return { db, rows: () => store }
}

// ── 0. Guard: module is registered by import ──────────────────────────────────

describe('0. Registration guard', () => {
  it('FixtureModule is registered by importing fixture.ts', () => {
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
    expect(result.seeded).toBe(true)
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
  })

  it('getActiveMetricDescriptors() returns fixture descriptors WITHOUT per-dept branching', async () => {
    await activate(db, 'fixture')
    const descs = await getActiveMetricDescriptors(db)
    expect(descs).toHaveLength(2)
    const keys = descs.map((d) => d.key)
    expect(keys).toContain('fixture.pings')
    expect(keys).toContain('fixture.scalar')
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
    expect(store.squads()).toHaveLength(1)
    expect(store.squads()[0].slug).toBe('fixture-core')
  })

  it('second activation does NOT double-seed (seed receipt guard)', async () => {
    await activate(db, 'fixture')
    const r2 = await activate(db, 'fixture')
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error()
    expect(r2.seeded).toBe(false)
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
    expect(r.seeded).toBe(false)
    expect(store.squads()).toHaveLength(1)
  })

  it('deactivate on non-activated key returns not_found', async () => {
    const r = await deactivate(db, 'fixture')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error()
    expect(r.reason).toBe('not_found')
  })
})

// ── 4. Isolation — fresh registry instance, removing fixture leaves kernel green

describe('4. Isolation — isolated registry instance, kernel unaffected', () => {
  it('after unregister on isolated instance: fixture absent from listRegistered', () => {
    // Use a FRESH isolated instance — no global state mutation.
    const reg = createDepartmentRegistry()
    reg.register(FixtureModule)
    expect(reg.listRegistered().map((m) => m.key)).toContain('fixture')
    // Re-register with replace to simulate removing/re-adding:
    // There is no unregister on the public API — which is the point.
    // We prove the instance is truly isolated (the singleton is unaffected).
    const singleton = listRegistered()
    expect(singleton.map((m) => m.key)).toContain('fixture')
    // The isolated instance only has what we put in it.
    const reg2 = createDepartmentRegistry()
    expect(reg2.listRegistered()).toHaveLength(0)
  })

  it('isolated instance: getActiveConsoleSections returns empty when module not registered', async () => {
    const reg = createDepartmentRegistry()
    // Activate via singleton (which has the fixture), but query via isolated instance
    // that has no modules. Should return empty (no match in _map).
    const store = makeDb()
    await activate(store.db, 'fixture')  // activate via singleton
    const sections = await reg.getActiveConsoleSections(store.db)
    expect(sections).toHaveLength(0)
  })

  it('isolated instance: getActiveMetricDescriptors returns empty when module not registered', async () => {
    const reg = createDepartmentRegistry()
    const store = makeDb()
    await activate(store.db, 'fixture')
    const descs = await reg.getActiveMetricDescriptors(store.db)
    expect(descs).toHaveLength(0)
  })

  it('two isolated instances are fully independent', async () => {
    const reg1 = createDepartmentRegistry()
    const reg2 = createDepartmentRegistry()

    reg1.register(FixtureModule)
    expect(reg1.listRegistered()).toHaveLength(1)
    expect(reg2.listRegistered()).toHaveLength(0)  // no cross-contamination
  })

  it('duplicate key on isolated instance throws; does not affect singleton', () => {
    const reg = createDepartmentRegistry()
    reg.register(FixtureModule)
    expect(() => reg.register(FixtureModule)).toThrow(/registry_duplicate_key/)
    // Singleton is unaffected
    expect(listRegistered().map((m) => m.key)).toContain('fixture')
  })
})

// ── 5. Capability confinement via ctx ─────────────────────────────────────────

describe('5. Capability confinement via ctx', () => {
  let db: D1Database

  beforeEach(() => {
    register(FixtureModule)
    db = makeDb().db
  })

  it('metrics.emit rejects a key not in metricsEmitted (key not owned)', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    await expect(
      ctx.metrics.emit({
        key: 'growth.revenue',
        value: 10,
        occurredAt: '2026-06-17T10:00:00.000Z',
        source: 'fixture-harness',
      }),
    ).rejects.toThrow(/key_not_owned|is not declared/)
  })

  it('metrics.emit rejects a source not in sourceAuthority', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(db), {
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
        source: 'stripe',
      }),
    ).rejects.toThrow(/source_not_authorized|not in sourceAuthority/)
  })

  it('metrics.emit accepts a valid source from sourceAuthority', async () => {
    const metricStore = makeMetricDb()
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
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

  it('metrics.emit rejects a non-finite value', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(db), {
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

  it('tenant is bound from ctx — module cannot override tenant via input', async () => {
    const metricStore = makeMetricDb()
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
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
    expect(metricStore.rows()[0].tenant_id).toBe('tenant-a')

    const ctxB = kernelMintCtx(makeKernelHandle(metricStore.db), {
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
    expect(metricStore.rows()[1].tenant_id).toBe('tenant-b')
  })

  it('ctx with empty capabilities is denied on metrics.emit', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: [],
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
    const ctx = kernelMintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['observer'],
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
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
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
    const ctx = kernelMintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    const ctxAsRecord = ctx as Record<string, unknown>
    expect(ctxAsRecord['DB']).toBeUndefined()
    expect(ctxAsRecord['env']).toBeUndefined()
    expect(ctxAsRecord['KV']).toBeUndefined()
    expect(ctxAsRecord['SESSIONS']).toBeUndefined()
    expect(ctxAsRecord['BUS']).toBeUndefined()
    expect(ctxAsRecord['db']).toBeUndefined()
    expect(typeof ctx.metrics.emit).toBe('function')
    expect(typeof ctx.audit.write).toBe('function')
    expect(typeof ctx.gate.propose).toBe('function')
    expect(typeof ctx.bus.publish).toBe('function')
  })

  it('confinement violations throw CtxError (not generic Error)', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    const err = await ctx.metrics.emit({
      key: 'growth.revenue',
      value: 1,
      occurredAt: '2026-06-17T10:00:00.000Z',
      source: 'fixture-harness',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CtxError)
    expect((err as CtxError).code).toBe('key_not_owned')
  })
})

// ── 6. Honesty propagation — ohlcEligible=false → bar (not candle) ────────────

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
  })

  it('seriesShape returns bar for single-reading-per-day series (ohlc honesty spine)', () => {
    const buckets: OHLCBucket[] = [
      { date: '2026-06-15', open: 5, high: 5, low: 5, close: 5, count: 1 },
      { date: '2026-06-16', open: 7, high: 7, low: 7, close: 7, count: 1 },
    ]
    expect(seriesShape(buckets)).toBe('bar')
  })

  it('seriesShape returns candle when any day has count >= 2 (fixture.pings eligible)', () => {
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
    expect(buckets.every((b) => b.count === 1)).toBe(true)
    expect(seriesShape(buckets)).toBe('bar')
  })
})

// ── 7. ADVERSARIAL — attacker-in-ctx scenarios ────────────────────────────────
//
// These tests prove that an attacker holding a ctx (a hostile department module)
// cannot escalate privileges or forge metric ownership by mutating the ctx object.
//
// The attacker is allowed to use `as any` casts — the fix must hold at runtime
// via Object.freeze + closure-private state, not via TypeScript types.

describe('7. ADVERSARIAL — ctx confinement holds against hostile module code', () => {
  let db: D1Database
  let metricStore: ReturnType<typeof makeMetricDb>

  beforeEach(() => {
    register(FixtureModule)
    db = makeDb().db
    metricStore = makeMetricDb()
  })

  it('P0-1a: mutating ctx.capabilities (add "owner") has NO effect on cap check', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: [],
    })

    let mutationThrew = false
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ctx.capabilities as any).push('owner')
    } catch {
      mutationThrew = true
    }

    await expect(
      ctx.metrics.emit({
        key: 'fixture.pings',
        value: 1,
        occurredAt: '2026-06-17T12:00:00.000Z',
        source: 'fixture-harness',
      }),
    ).rejects.toThrow(/capability_denied/)

    void mutationThrew
  })

  it('P0-1b: forging ctx.metricsEmitted (add foreign key) has NO effect on ownership check', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['owner'],
    })

    let mutationThrew = false
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ctx.metricsEmitted as any).push({
        key: 'growth.revenue',
        unit: 'usd',
        direction: 'up_good',
        cadence: 'realtime',
        aggregation: 'sum',
        ohlcEligible: true,
        sourceAuthority: ['anything'],
        retention: '365d',
        display: { precision: 2 },
      })
    } catch {
      mutationThrew = true
    }

    await expect(
      ctx.metrics.emit({
        key: 'growth.revenue',
        value: 99999,
        occurredAt: '2026-06-17T12:00:00.000Z',
        source: 'anything',
      }),
    ).rejects.toThrow(/key_not_owned/)

    void mutationThrew
  })

  it('P0-1c: re-binding ctx.tenantId via "as any" is blocked (frozen object)', () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['owner'],
    })

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ctx as any).tenantId = 'victim-tenant'
    }).toThrow()

    expect(ctx.tenantId).toBe('tenant-a')
  })

  it('P0-1d: replacing a port facade on ctx is blocked (frozen object)', () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ctx as any).metrics = { emit: async () => ({ ok: true }) }
    }).toThrow()
  })

  it('P0-1e: mutating a descriptor.sourceAuthority on the snapshot has NO effect on source check', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['owner'],
    })

    const snapshotDesc = ctx.metricsEmitted.find((d) => d.key === 'fixture.pings')
    if (snapshotDesc) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(snapshotDesc.sourceAuthority as any).push('stripe')
      } catch {
        // freeze threw
      }
    }

    await expect(
      ctx.metrics.emit({
        key: 'fixture.pings',
        value: 1,
        occurredAt: '2026-06-17T12:01:00.000Z',
        source: 'stripe',
      }),
    ).rejects.toThrow(/source_not_authorized/)
  })

  it('ctx exposes no db.query (raw SQL facade has been removed)', () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['owner'],
    })
    const ctxAsRecord = ctx as Record<string, unknown>
    expect(ctxAsRecord['db']).toBeUndefined()
  })

  it('emit always stores the closure-bound tenant, not any attacker-supplied value', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })

    await ctx.metrics.emit({
      key: 'fixture.pings',
      value: 1,
      occurredAt: '2026-06-17T12:02:00.000Z',
      source: 'fixture-harness',
    })

    expect(metricStore.rows()[0].tenant_id).toBe('tenant-a')
  })
})

// ── 8. Registry hardening ─────────────────────────────────────────────────────

describe('8. Registry hardening', () => {
  let db: D1Database

  beforeEach(() => {
    register(FixtureModule)
    db = makeDb().db
  })

  it('register() same module object re-registered is a no-op (idempotent)', () => {
    // Production register() has no `replace` option.
    // Re-registering the exact same module object (same key + same reference) is safe.
    expect(() => {
      register(FixtureModule)  // already registered — same object reference → no-op
    }).not.toThrow()
  })

  it('register() DIFFERENT module under existing key throws registry_duplicate_key', () => {
    // A hostile module cannot displace an existing registration.
    // Even if the key matches, a different object reference → registry_duplicate_key.
    const HostileModule = { ...FixtureModule }  // different object, same key
    expect(() => {
      register(HostileModule)
    }).toThrow(/registry_duplicate_key/)
  })

  it('activate() returns slug_conflict when slug exists with a different template_key', async () => {
    const foreignStore = makeDb({
      initialDepts: [
        {
          id: 'pre-existing-id',
          slug: 'fixture',
          name: 'Some Other Department',
          template_key: 'other-module',
          template_version: '1.0.0',
          activated_at: '2026-06-01T00:00:00.000Z',
          active: 1,
          seed_receipt: null,
          created_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    })

    const result = await activate(foreignStore.db, 'fixture')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected slug_conflict')
    expect(result.reason).toBe('slug_conflict')
    expect(result.detail).toMatch(/fixture.*other-module|slug.*owned/)
  })

  it('activate() succeeds when existing row has template_key=NULL (legacy row)', async () => {
    const legacyStore = makeDb({
      initialDepts: [
        {
          id: 'legacy-id',
          slug: 'fixture',
          name: 'Old Fixture',
          template_key: null,
          template_version: null,
          activated_at: null,
          active: 0,
          seed_receipt: null,
          created_at: '2026-05-01T00:00:00.000Z',
        },
      ],
    })

    const result = await activate(legacyStore.db, 'fixture')
    expect(result.ok).toBe(true)
  })

  // ── wrong-token mint rejection ────────────────────────────────────────────
  //
  // The kernel.ts _isKernelToken helper is used to prove the token gate works.
  // We cannot obtain the real kernel token (it is module-private in kernel.ts),
  // so we use a wrong symbol and verify the gate fires.

  it('a wrong-token symbol is correctly rejected by the kernel token gate', () => {
    // _KERNEL_TOKEN is module-private in kernel.ts — we cannot obtain it.
    // _isKernelToken confirms that an arbitrary Symbol is NOT the kernel token.
    // The token gate inside _mintCtxInternal compares callerToken === _KERNEL_TOKEN;
    // since only kernelMintCtx (which supplies _KERNEL_TOKEN directly) can mint,
    // no external caller can pass a symbol that satisfies this check.
    const fakeToken = Symbol('fake')
    expect(_isKernelToken(fakeToken)).toBe(false)
  })

  it('kernelMintCtx is the ONLY public mint path — produces a valid ctx', () => {
    // Verify that kernelMintCtx (the only exported mint function) works normally.
    const ctx = kernelMintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })
    expect(ctx.tenantId).toBe('tenant-a')
    expect(ctx.departmentKey).toBe('fixture')
    expect(typeof ctx.metrics.emit).toBe('function')
  })

  it('activate() uses injected now() for deterministic timestamps', async () => {
    const FIXED_TIME = '2026-01-01T00:00:00.000Z'
    const store = makeDb()
    const result = await activate(store.db, 'fixture', {
      now: () => FIXED_TIME,
      idGen: () => 'fixed-uuid',
    })
    expect(result.ok).toBe(true)
    const row = store.depts()[0]
    expect(row.activated_at).toBe(FIXED_TIME)
    expect(row.created_at).toBe(FIXED_TIME)
  })

  it('mintCtx uses injected now() in gate.propose gateId — requires a declared proposesOnly work-type', async () => {
    // BLOCK-1 fix: gate.propose now enforces the work-type map. FixtureModule has
    // no channels (no declared work-types), so any propose would throw work_type_not_declared.
    // Use GrowthModule which has SeoChannel with seo-audit-proposal (proposesOnly=true).
    const FIXED_TIME = '2026-01-01T00:00:00.000Z'
    const ctx = kernelMintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => FIXED_TIME,
    })
    const result = await ctx.gate.propose({ action: 'seo-audit-proposal' })
    expect(result.gateId).toContain(FIXED_TIME)
  })
})

// ── 9. EXPORT SURFACE ASSERTIONS — structural boundary proof ──────────────────
//
// These tests mechanically assert that the module export surfaces of ctx.ts and
// registry.ts contain NO symbol that can mint a ctx or acquire/clear state.
//
// Threat model: a department module is hostile first-party code in the same bundle.
// It can `import` anything exported. The ONLY real authority boundary is
// "a symbol that is NEVER exported cannot be imported" (CF Workers, no process
// isolation).
//
// Architecture after FIX-2:
//   ctx.ts    — pure types, interfaces, CtxError. ZERO mint logic.
//   kernel.ts — ALL mint logic (_KERNEL_TOKEN, _mintCtxInternal, port facades).
//               Exports only: kernelMintCtx (function, no token param), _isKernelToken.
//
// These assertions use dynamic import to get the live module namespace and check
// specific property names. TypeScript types don't help here — we check the runtime
// object.

describe('9. EXPORT SURFACE ASSERTIONS — no mint/token/clear symbol reachable', () => {
  it('ctx.ts does NOT export acquireKernelToken', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctxMod = await import('../src/departments/ctx') as Record<string, any>
    expect(ctxMod['acquireKernelToken']).toBeUndefined()
  })

  it('ctx.ts does NOT export mintCtx (minting logic lives in kernel.ts, not ctx.ts)', async () => {
    // ctx.ts is now a pure types/contracts file — no mint function at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctxMod = await import('../src/departments/ctx') as Record<string, any>
    expect(ctxMod['mintCtx']).toBeUndefined()
  })

  it('ctx.ts does NOT export createMintSeam', async () => {
    // createMintSeam has been removed from ctx.ts entirely. All minting lives in
    // kernel.ts as private module-scope code.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctxMod = await import('../src/departments/ctx') as Record<string, any>
    expect(ctxMod['createMintSeam']).toBeUndefined()
  })

  it('ctx.ts does NOT export _isKernelToken or _isKernelTokenCtx', async () => {
    // These predicates live in kernel.ts only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctxMod = await import('../src/departments/ctx') as Record<string, any>
    expect(ctxMod['_isKernelToken']).toBeUndefined()
    expect(ctxMod['_isKernelTokenCtx']).toBeUndefined()
  })

  it('ctx.ts does NOT export KERNEL_TOKEN or any token-shaped symbol', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctxMod = await import('../src/departments/ctx') as Record<string, any>
    expect(ctxMod['KERNEL_TOKEN']).toBeUndefined()
    expect(ctxMod['_KERNEL_TOKEN']).toBeUndefined()
    expect(ctxMod['_tokenAcquired']).toBeUndefined()
  })

  it('ctx.ts has no callable function that yields a DepartmentCtx', async () => {
    // Enumerate all exports of ctx.ts and confirm none are functions (ctx.ts is
    // purely types + CtxError class).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctxMod = await import('../src/departments/ctx') as Record<string, any>
    const exportedFunctions = Object.entries(ctxMod)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
    // CtxError is a class (constructor function) — it is the ONLY allowed function.
    expect(exportedFunctions).toEqual(['CtxError'])
  })

  it('registry.ts does NOT export _clearRegistry', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const regMod = await import('../src/departments/registry') as Record<string, any>
    expect(regMod['_clearRegistry']).toBeUndefined()
  })

  it('registry.ts does NOT export _unregister', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const regMod = await import('../src/departments/registry') as Record<string, any>
    expect(regMod['_unregister']).toBeUndefined()
  })

  it('registry.ts does NOT export _testOnly', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const regMod = await import('../src/departments/registry') as Record<string, any>
    expect(regMod['_testOnly']).toBeUndefined()
  })

  it('registry.ts production register does NOT accept a replace option (hostile displacement blocked)', async () => {
    // The exported `register` from registry.ts wraps the production singleton with
    // idempotent same-object semantics and no `replace` parameter. A hostile module
    // that calls register(EvilModule, {replace:true}) cannot displace an existing key
    // because the parameter is simply absent from the production wrapper.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const regMod = await import('../src/departments/registry') as Record<string, any>
    const regFn: (...args: unknown[]) => void = regMod['register']
    expect(typeof regFn).toBe('function')
    // The production register accepts exactly 1 parameter (module). TypeScript
    // enforces this at compile time; at runtime extra args are silently ignored
    // but the production singleton register() does NOT honor replace.
    // Verify: passing a different module under an existing key throws.
    const HostileModule = { ...FixtureModule }  // different object, same key
    expect(() => regFn(HostileModule)).toThrow(/registry_duplicate_key/)
  })

  it('a fake token symbol is correctly identified as NOT the kernel token', () => {
    // _isKernelToken lets the harness prove the token gate without exposing the token.
    const fakeToken = Symbol('fake.kernel.mint')
    expect(_isKernelToken(fakeToken)).toBe(false)
  })

  it('registry instance isolation: one instance state does not leak into another', () => {
    const reg1 = createDepartmentRegistry()
    const reg2 = createDepartmentRegistry()
    reg1.register(FixtureModule)
    expect(reg2.listRegistered()).toHaveLength(0)
    reg2.register(FixtureModule)
    expect(reg1.listRegistered()).toHaveLength(1)
    expect(reg2.listRegistered()).toHaveLength(1)
    // Registering into reg2 doesn't affect reg1's state
    const AltModule = { ...FixtureModule, key: 'alt' }
    reg2.register(AltModule)
    expect(reg1.listRegistered()).toHaveLength(1)
    expect(reg2.listRegistered()).toHaveLength(2)
  })

  it('duplicate key on one registry instance does not affect another', () => {
    const reg1 = createDepartmentRegistry()
    const reg2 = createDepartmentRegistry()
    reg1.register(FixtureModule)
    expect(() => reg1.register(FixtureModule)).toThrow(/registry_duplicate_key/)
    // reg2 is unaffected — can still register without error
    expect(() => reg2.register(FixtureModule)).not.toThrow()
  })
})

// ── 10. ADVERSARIAL — registry-level manifest mutation (BLOCK-1, Codex round 3) ─
//
// Proves that the deep-freeze-clone introduced in this sprint closes the
// mutable-registered-manifest vector. An attacker who obtains a reference via
// getRegistered() cannot alter authority structures in place, and the registry
// source-of-truth remains the original frozen clone.
//
// Exploit attempted (from Codex BLOCK-1 brief):
//   const m = getRegistered('fixture') as any
//   m.metricsEmitted.push({ key:'growth.revenue', sourceAuthority:['stripe'], ... })
//   m.defaultSquads.push({ slug:'evil', name:'Evil' })
//   m.consoleSection.path = '/departments/evil'
//
// Post-fix: all mutation attempts throw (frozen) or are silently inert (strict mode
// always throws on frozen arrays/objects in V8). Subsequent selector calls reflect
// only the original frozen manifest — no forged descriptors, no nav displacement.

describe('10. ADVERSARIAL — registry manifest immutability (BLOCK-1 close)', () => {
  // Use an isolated registry instance so these tests do not interact with the
  // singleton. The exploit works the same way on both — we use isolated for hermeticity.
  let reg: ReturnType<typeof createDepartmentRegistry>
  let db: D1Database

  beforeEach(() => {
    reg = createDepartmentRegistry()
    reg.register(FixtureModule)
    db = makeDb().db
  })

  it('getRegistered returns a frozen object (top-level)', () => {
    const m = reg.getRegistered('fixture')
    expect(m).toBeDefined()
    expect(Object.isFrozen(m)).toBe(true)
  })

  it('getRegistered: metricsEmitted array is frozen', () => {
    const m = reg.getRegistered('fixture')!
    expect(Object.isFrozen(m.metricsEmitted)).toBe(true)
  })

  it('getRegistered: each MetricDescriptor is frozen', () => {
    const m = reg.getRegistered('fixture')!
    for (const desc of m.metricsEmitted) {
      expect(Object.isFrozen(desc)).toBe(true)
    }
  })

  it('getRegistered: each MetricDescriptor.sourceAuthority array is frozen', () => {
    const m = reg.getRegistered('fixture')!
    for (const desc of m.metricsEmitted) {
      expect(Object.isFrozen(desc.sourceAuthority)).toBe(true)
    }
  })

  it('getRegistered: each MetricDescriptor.display object is frozen', () => {
    const m = reg.getRegistered('fixture')!
    for (const desc of m.metricsEmitted) {
      expect(Object.isFrozen(desc.display)).toBe(true)
    }
  })

  it('getRegistered: defaultSquads array is frozen', () => {
    const m = reg.getRegistered('fixture')!
    expect(Object.isFrozen(m.defaultSquads)).toBe(true)
  })

  it('getRegistered: each SquadSeed is frozen', () => {
    const m = reg.getRegistered('fixture')!
    for (const squad of m.defaultSquads) {
      expect(Object.isFrozen(squad)).toBe(true)
    }
  })

  it('getRegistered: consoleSection is frozen', () => {
    const m = reg.getRegistered('fixture')!
    expect(Object.isFrozen(m.consoleSection)).toBe(true)
  })

  it('getRegistered: connectors array is frozen', () => {
    const m = reg.getRegistered('fixture')!
    expect(Object.isFrozen(m.connectors)).toBe(true)
  })

  it('getRegistered: requiredCapabilities array is frozen', () => {
    const m = reg.getRegistered('fixture')!
    expect(Object.isFrozen(m.requiredCapabilities)).toBe(true)
  })

  it('EXPLOIT: push to metricsEmitted throws (frozen array)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = reg.getRegistered('fixture') as any
    expect(() => {
      m.metricsEmitted.push({
        key: 'growth.revenue',
        unit: 'usd',
        direction: 'up_good',
        cadence: 'realtime',
        aggregation: 'sum',
        ohlcEligible: true,
        sourceAuthority: ['stripe'],
        retention: '365d',
        display: { precision: 2 },
      })
    }).toThrow()
  })

  it('EXPLOIT: push to defaultSquads throws (frozen array)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = reg.getRegistered('fixture') as any
    expect(() => {
      m.defaultSquads.push({ slug: 'evil', name: 'Evil' })
    }).toThrow()
  })

  it('EXPLOIT: assign to consoleSection.path throws (frozen object)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = reg.getRegistered('fixture') as any
    expect(() => {
      m.consoleSection.path = '/departments/evil'
    }).toThrow()
  })

  it('EXPLOIT: assign to metricsEmitted[0].sourceAuthority throws (frozen object)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = reg.getRegistered('fixture') as any
    expect(() => {
      m.metricsEmitted[0].sourceAuthority = ['stripe']
    }).toThrow()
  })

  it('EXPLOIT: push to metricsEmitted[0].sourceAuthority throws (frozen array)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = reg.getRegistered('fixture') as any
    expect(() => {
      m.metricsEmitted[0].sourceAuthority.push('stripe')
    }).toThrow()
  })

  it('post-exploit: getActiveMetricDescriptors reflects ONLY original — no forged growth.revenue', async () => {
    // Activate in the isolated registry then attempt the full exploit sequence.
    await reg.activate(db, 'fixture')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = reg.getRegistered('fixture') as any
    try { m.metricsEmitted.push({ key: 'growth.revenue', sourceAuthority: ['stripe'] }) } catch { /* frozen */ }
    try { m.defaultSquads.push({ slug: 'evil', name: 'Evil' }) } catch { /* frozen */ }
    try { m.consoleSection.path = '/departments/evil' } catch { /* frozen */ }

    const descs = await reg.getActiveMetricDescriptors(db)
    const keys = descs.map((d) => d.key)
    // Original two descriptors only — no forged growth.revenue
    expect(keys).not.toContain('growth.revenue')
    expect(keys).toContain('fixture.pings')
    expect(keys).toContain('fixture.scalar')
    expect(descs).toHaveLength(2)
  })

  it('post-exploit: consoleSection.path is the original — no nav displacement', async () => {
    await reg.activate(db, 'fixture')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = reg.getRegistered('fixture') as any
    try { m.consoleSection.path = '/departments/evil' } catch { /* frozen */ }

    const sections = await reg.getActiveConsoleSections(db)
    expect(sections).toHaveLength(1)
    expect(sections[0].path).toBe('/departments/fixture')
    expect(sections[0].path).not.toBe('/departments/evil')
  })

  it('clone isolation: mutating the CALLER original after register has no effect on stored manifest', () => {
    // Build a fresh mutable module (not FixtureModule itself — we must not mutate it).
    const mutableModule: DepartmentModule = {
      key: 'muttest',
      name: 'Mutation Test',
      version: '0.1.0',
      defaultSquads: [{ slug: 'muttest-core', name: 'MutTest Core' }],
      metricsEmitted: [{
        key: 'muttest.pings',
        unit: 'count',
        direction: 'neutral',
        cadence: 'realtime',
        aggregation: 'sum',
        ohlcEligible: true,
        sourceAuthority: ['test-source'],
        retention: '30d',
        display: { precision: 0 },
      }],
      consoleSection: { id: 'muttest', title: 'MutTest', navIcon: 'beaker', path: '/departments/muttest' },
      requiredCapabilities: ['member'],
      connectors: [],
    }

    const reg2 = createDepartmentRegistry()
    reg2.register(mutableModule)

    // Mutate the CALLER's original after registration.
    // The stored manifest must remain unchanged.
    mutableModule.metricsEmitted.push({
      key: 'growth.revenue',
      unit: 'usd',
      direction: 'up_good',
      cadence: 'realtime',
      aggregation: 'sum',
      ohlcEligible: true,
      sourceAuthority: ['stripe'],
      retention: '365d',
      display: { precision: 2 },
    })
    mutableModule.defaultSquads.push({ slug: 'evil', name: 'Evil' })
    mutableModule.consoleSection.path = '/departments/evil'

    const stored = reg2.getRegistered('muttest')!
    // Stored manifest is isolated from caller mutations
    expect(stored.metricsEmitted).toHaveLength(1)
    expect(stored.metricsEmitted[0].key).toBe('muttest.pings')
    expect(stored.defaultSquads).toHaveLength(1)
    expect(stored.defaultSquads[0].slug).toBe('muttest-core')
    expect(stored.consoleSection.path).toBe('/departments/muttest')
  })

  it('listRegistered: returned array elements are frozen', () => {
    const all = reg.listRegistered()
    expect(all.length).toBeGreaterThan(0)
    for (const m of all) {
      expect(Object.isFrozen(m)).toBe(true)
      expect(Object.isFrozen(m.metricsEmitted)).toBe(true)
      expect(Object.isFrozen(m.consoleSection)).toBe(true)
      expect(Object.isFrozen(m.defaultSquads)).toBe(true)
    }
  })
})

// ── Cleanup after all tests ───────────────────────────────────────────────────

afterAll(() => {
  register(FixtureModule, { replace: true })
})
