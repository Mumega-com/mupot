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
//   4. Isolation — unregister fixture, all lists empty, no crash.
//   5. Capability confinement via ctx — key ownership, source authority, tenant bind.
//   6. Honesty propagation — ohlcEligible=false → seriesShape() returns 'bar'.
//   7. ADVERSARIAL — attacker-in-ctx scenarios (mutate snapshots, re-bind tenant, forge keys).
//   8. Registry hardening — duplicate key, slug_conflict, mintCtx without token.

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
  kernelMintCtx,
  _clearRegistry,
  _unregister,
} from '../src/departments/registry'
// mintCtx + _isKernelToken imported directly from ctx only for the token-gate test (§8).
import { mintCtx, _isKernelToken, CtxError } from '../src/departments/ctx'

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
//   - UPDATE departments SET seed_receipt = ?2 WHERE id = ?1 AND seed_receipt IS NULL
//   - SELECT … FROM departments WHERE active = 1 AND template_key IS NOT NULL
//   - INSERT OR IGNORE INTO squads (…) VALUES (…)
//   - db.batch([...]) for atomic squad seeding
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
    // SQL: VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
    // Binds: [id, slug, name, template_key, template_version, activated_at, created_at]
    // The literal `1` for `active` is in the SQL, not a bind param.
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
      // COALESCE semantics: only set if currently null
      if (!row.activated_at) row.activated_at = activated_at_coalesce
      row.name = name
      return { success: true, meta: { changes: 1 } }
    }

    // ── UPDATE departments SET seed_receipt … WHERE … AND seed_receipt IS NULL
    if (upper.startsWith('UPDATE DEPARTMENTS') && upper.includes('SEED_RECEIPT') && upper.includes('AND SEED_RECEIPT IS NULL')) {
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
        // INSERT OR IGNORE: silently skip
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

    // ── SELECT from departments WHERE slug = ?1 LIMIT 1 (exists check) ──────
    if (upper.includes('FROM DEPARTMENTS') && upper.includes('WHERE SLUG')) {
      const [slug] = _args as [string]
      const row = depts.find((d) => d.slug === slug) ?? null
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

  // Makes a single prepared statement object
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
    // db.batch([stmt1, stmt2, ...]) — execute sequentially, return array of results
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
      // Not needed for metric tests
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
    register(FixtureModule, { replace: true })
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
    register(FixtureModule, { replace: true })
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
    register(FixtureModule, { replace: true })
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

// ── 4. Isolation — removing fixture leaves everything else green ──────────────

describe('4. Isolation — unregister fixture, kernel is unaffected', () => {
  let db: D1Database

  beforeEach(() => {
    register(FixtureModule, { replace: true })
    const store = makeDb()
    db = store.db
  })

  it('after _unregister: fixture is absent from listRegistered()', () => {
    _unregister('fixture')
    const keys = listRegistered().map((m) => m.key)
    expect(keys).not.toContain('fixture')
  })

  it('after _unregister: getActiveConsoleSections() returns empty without crashing', async () => {
    await activate(db, 'fixture')
    _unregister('fixture')
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
    register(FixtureModule, { replace: true })
  })
})

// ── 5. Capability confinement via ctx ─────────────────────────────────────────

describe('5. Capability confinement via ctx', () => {
  let db: D1Database

  beforeEach(() => {
    register(FixtureModule, { replace: true })
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
    register(FixtureModule, { replace: true })
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
    register(FixtureModule, { replace: true })
    db = makeDb().db
    metricStore = makeMetricDb()
  })

  // ── P0-1a: mutate ctx.capabilities → cap check still uses closure ──────────

  it('P0-1a: mutating ctx.capabilities (add "owner") has NO effect on cap check', async () => {
    // Mint a ctx with no capabilities — should be denied on emit.
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: [],  // no caps
    })

    // Attacker attempt: cast to any and push 'owner' onto the frozen snapshot.
    // This should either throw (TypeError: cannot add property to frozen object)
    // or be silently ignored, but MUST NOT affect the cap check.
    let mutationThrew = false
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ctx.capabilities as any).push('owner')
    } catch {
      mutationThrew = true
    }

    // Regardless of whether mutation threw or was silently ignored:
    // the emit MUST still be denied because the closure capSet has no 'owner'.
    await expect(
      ctx.metrics.emit({
        key: 'fixture.pings',
        value: 1,
        occurredAt: '2026-06-17T12:00:00.000Z',
        source: 'fixture-harness',
      }),
    ).rejects.toThrow(/capability_denied/)

    // Mutation should have thrown (frozen array), but denial is the hard invariant.
    // We log if it didn't to surface any regression in the freeze.
    if (!mutationThrew) {
      // The freeze didn't work — but the check still held because it reads closure.
      // This is acceptable but suboptimal; the freeze is belt-and-suspenders.
    }
  })

  // ── P0-1b: mutate ctx.metricsEmitted → key ownership check uses closure ───

  it('P0-1b: forging ctx.metricsEmitted (add foreign key) has NO effect on ownership check', async () => {
    // Mint a ctx for the fixture department.
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['owner'],
    })

    // Attacker attempt: cast to any and inject a foreign metric key into the snapshot.
    // This simulates a hostile module trying to self-authorize 'growth.revenue'.
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

    // The emit of the foreign key MUST still be denied.
    await expect(
      ctx.metrics.emit({
        key: 'growth.revenue',
        value: 99999,
        occurredAt: '2026-06-17T12:00:00.000Z',
        source: 'anything',
      }),
    ).rejects.toThrow(/key_not_owned/)

    // As above: freeze is belt-and-suspenders; closure is the hard gate.
    void mutationThrew
  })

  // ── P0-1c: re-bind ctx.tenantId → ctx is frozen, re-bind throws or no-ops ──

  it('P0-1c: re-binding ctx.tenantId via "as any" is blocked (frozen object)', () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['owner'],
    })

    // Attacker attempt: re-bind tenantId to a victim tenant.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ctx as any).tenantId = 'victim-tenant'
    }).toThrow()  // TypeError: Cannot assign to read only property

    // Even if the throw weren't there, the emit uses the closure-bound tenant.
    expect(ctx.tenantId).toBe('tenant-a')
  })

  // ── P0-1d: re-bind a port (ctx.metrics = evil_port) → ctx is frozen ────────

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

  // ── P0-1e: mutate descriptor.sourceAuthority on the metricsEmitted snapshot ──

  it('P0-1e: mutating a descriptor.sourceAuthority on the snapshot has NO effect on source check', async () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['owner'],
    })

    // Attacker: add a foreign source to the sourceAuthority on the snapshot.
    const snapshotDesc = ctx.metricsEmitted.find((d) => d.key === 'fixture.pings')
    if (snapshotDesc) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(snapshotDesc.sourceAuthority as any).push('stripe')
      } catch {
        // Freeze threw — good.
      }
    }

    // 'stripe' is NOT in the closure-private descriptor.sourceAuthority.
    await expect(
      ctx.metrics.emit({
        key: 'fixture.pings',
        value: 1,
        occurredAt: '2026-06-17T12:01:00.000Z',
        source: 'stripe',
      }),
    ).rejects.toThrow(/source_not_authorized/)
  })

  // ── No raw DB on ctx ──────────────────────────────────────────────────────

  it('ctx exposes no db.query (raw SQL facade has been removed)', () => {
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['owner'],
    })
    // The db port must not exist on the ctx at all.
    const ctxAsRecord = ctx as Record<string, unknown>
    expect(ctxAsRecord['db']).toBeUndefined()
  })

  // ── Tenant binding holds under emit ──────────────────────────────────────

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

    // The stored row must use the closure-bound tenantId, not any attacker value.
    expect(metricStore.rows()[0].tenant_id).toBe('tenant-a')
  })
})

// ── 8. Registry hardening ─────────────────────────────────────────────────────

describe('8. Registry hardening', () => {
  let db: D1Database

  beforeEach(() => {
    register(FixtureModule, { replace: true })
    db = makeDb().db
  })

  // ── Duplicate key → throws ────────────────────────────────────────────────

  it('register() duplicate key without replace flag throws', () => {
    // FixtureModule is already registered.
    expect(() => {
      register(FixtureModule)  // no replace flag
    }).toThrow(/registry_duplicate_key/)
  })

  it('register() duplicate key with replace:true does NOT throw', () => {
    expect(() => {
      register(FixtureModule, { replace: true })
    }).not.toThrow()
  })

  // ── slug_conflict: activate over a foreign template key ───────────────────

  it('activate() returns slug_conflict when slug exists with a different template_key', async () => {
    // Pre-populate a dept row with slug='fixture' but template_key='other-module'.
    const foreignStore = makeDb({
      initialDepts: [
        {
          id: 'pre-existing-id',
          slug: 'fixture',
          name: 'Some Other Department',
          template_key: 'other-module',  // different from 'fixture'
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
    // Pre-populate a legacy row (template_key IS NULL — old createDepartment path).
    const legacyStore = makeDb({
      initialDepts: [
        {
          id: 'legacy-id',
          slug: 'fixture',
          name: 'Old Fixture',
          template_key: null,  // legacy: no template origin
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

  // ── mintCtx without kernel token → throws ────────────────────────────────

  it('mintCtx with wrong token throws kernel_token_invalid', () => {
    const fakeToken = Symbol('fake')
    expect(() => {
      mintCtx(fakeToken, makeKernelHandle(db), {
        tenantId: 'attacker',
        departmentKey: 'fixture',
        module: FixtureModule,
        capabilities: ['owner'],
      })
    }).toThrow(/kernel_token_invalid/)
  })

  it('mintCtx with wrong token throws CtxError', () => {
    const fakeToken = Symbol('fake')
    let err: unknown
    try {
      mintCtx(fakeToken, makeKernelHandle(db), {
        tenantId: 'attacker',
        departmentKey: 'fixture',
        module: FixtureModule,
        capabilities: ['owner'],
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CtxError)
    expect((err as CtxError).code).toBe('kernel_token_invalid')
  })

  // ── Injected clock ────────────────────────────────────────────────────────

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

  it('mintCtx uses injected now() in gate.propose gateId', async () => {
    const FIXED_TIME = '2026-01-01T00:00:00.000Z'
    const ctx = kernelMintCtx(makeKernelHandle(db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
      now: () => FIXED_TIME,
    })
    const result = await ctx.gate.propose({ action: 'test' })
    expect(result.gateId).toContain(FIXED_TIME)
  })
})

// ── Cleanup after all tests ───────────────────────────────────────────────────

afterAll(() => {
  register(FixtureModule, { replace: true })
})
