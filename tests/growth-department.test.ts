// tests/growth-department.test.ts — Growth department + collector tests.
//
// Proves:
//   A. GrowthModule registers + activates cleanly (seeds Demand Gen + Pipeline squads idempotently).
//   B. collectGrowthMetrics: given seeded prospect rows, emits correct metric_points.
//   C. Honesty: zero prospects → emits nothing (no fabrication).
//   D. Honesty: sent=0 → no conversion point (no divide-by-zero fabrication).
//   E. Conversion arithmetic: replied/sent computed correctly.
//   F. Metrics read back via readSeries + aggregateOHLC + seriesShape='bar' (daily scalars).
//   G. Capability confinement: growth ctx can only emit growth.* from 'prospects'.
//   H. Module cannot mint: growth.ts does not import kernelMintCtx.
//   I. Export surface: growth.ts module namespace has no mint capability.
//   J. Duplicate emit: cron re-tick at the same occurred_at → 'skipped', not an error.

import { describe, it, expect, beforeEach } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

// ── Module + registry imports ─────────────────────────────────────────────────
import { GrowthModule } from '../src/departments/modules/growth'
import {
  register,
  getRegistered,
  listRegistered,
  activate,
  createDepartmentRegistry,
  kernelMintCtx,
} from '../src/departments/registry'
import { CtxError } from '../src/departments/ctx'

// ── Collector imports ─────────────────────────────────────────────────────────
import {
  collectGrowthMetrics,
  readProspectCounts,
} from '../src/departments/collectors/growth-collector'

// ── Pulse imports for readback assertions ─────────────────────────────────────
import { aggregateOHLC, seriesShape } from '../src/metrics/pulse'
import type { OHLCBucket } from '../src/metrics/pulse'

// ────────────────────────────────────────────────────────────────────────────
// In-memory department DB mock (reused from conformance test, same shape)
// ────────────────────────────────────────────────────────────────────────────

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

    if (upper.startsWith('INSERT INTO DEPARTMENTS')) {
      const [id, slug, name, template_key, template_version, activated_at, created_at] =
        args as [string, string, string, string, string, string, string]
      if (depts.some((d) => d.slug === slug)) throw new Error('UNIQUE constraint failed: departments.slug')
      depts.push({ id, slug, name, template_key, template_version, activated_at, active: 1, seed_receipt: null, created_at })
      return { success: true, meta: { changes: 1 } }
    }

    if (upper.startsWith('UPDATE DEPARTMENTS') && upper.includes('SET ACTIVE = 1')) {
      const [id, template_key, template_version, activated_at_coalesce, name] = args as [string, string, string, string, string]
      const row = depts.find((d) => d.id === id)
      if (!row) return { success: true, meta: { changes: 0 } }
      row.active = 1; row.template_key = template_key; row.template_version = template_version
      if (!row.activated_at) row.activated_at = activated_at_coalesce
      row.name = name
      return { success: true, meta: { changes: 1 } }
    }

    if (upper.startsWith('UPDATE DEPARTMENTS') && upper.includes('SEED_RECEIPT') && upper.includes('AND SEED_RECEIPT IS NULL')) {
      const [id, receipt] = args as [string, string]
      const row = depts.find((d) => d.id === id && d.seed_receipt === null)
      if (!row) return { success: true, meta: { changes: 0 } }
      row.seed_receipt = receipt
      return { success: true, meta: { changes: 1 } }
    }

    if (upper.startsWith('UPDATE DEPARTMENTS') && upper.includes('SEED_RECEIPT')) {
      const [id, receipt] = args as [string, string]
      const row = depts.find((d) => d.id === id)
      if (!row) return { success: true, meta: { changes: 0 } }
      row.seed_receipt = receipt
      return { success: true, meta: { changes: 1 } }
    }

    if (upper.startsWith('UPDATE DEPARTMENTS') && upper.includes('ACTIVE = 0')) {
      const [slug] = args as [string]
      const row = depts.find((d) => d.slug === slug && d.template_key === slug)
      if (!row) return { success: true, meta: { changes: 0 } }
      row.active = 0
      return { success: true, meta: { changes: 1 } }
    }

    if (upper.startsWith('INSERT OR IGNORE INTO SQUADS') || upper.startsWith('INSERT INTO SQUADS')) {
      const [id, department_id, slug, name, charter, created_at] = args as [string, string, string, string, string | null, string]
      const conflict = squads.some((s) => s.department_id === department_id && s.slug === slug)
      if (conflict) {
        if (upper.includes('OR IGNORE')) return { success: true, meta: { changes: 0 } }
        throw new Error('UNIQUE constraint failed: squads')
      }
      squads.push({ id, department_id, slug, name, charter, created_at })
      return { success: true, meta: { changes: 1 } }
    }

    return { success: true, meta: { changes: 0 } }
  }

  function allSql(sql: string, args: unknown[]): { results: unknown[]; success: boolean } {
    const upper = sql.trim().toUpperCase()

    if (upper.includes('FROM DEPARTMENTS') && upper.includes('WHERE SLUG')) {
      const [slug] = args as [string]
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
      bind(...args: unknown[]) { boundArgs.push(...args); return stmt },
      async run() { return runSql(sql, boundArgs) },
      async all() { return allSql(sql, boundArgs) },
      async first() {
        const r = allSql(sql, boundArgs)
        return (r.results[0] as Record<string, unknown>) ?? null
      },
    }
    return stmt
  }

  const db = {
    prepare(sql: string) { return makeStmt(sql) },
    async batch(statements: ReturnType<typeof makeStmt>[]) {
      const results = []
      for (const stmt of statements) results.push(await stmt.run())
      return results
    },
  } as unknown as D1Database

  return { db, depts: () => depts, squads: () => squads }
}

// ── In-memory metric + prospect combined DB ───────────────────────────────────
//
// Handles both metric_points writes (for the collector) and prospects reads
// (for readProspectCounts). The DB mock is unified so the collector can use
// one handle for both tables.

interface MetricRow {
  id: string
  tenant_id: string
  metric_key: string
  value: number
  occurred_at: string
  source: string
  created_at: string
}

interface ProspectRow {
  tenant: string
  status: string
}

function makeCollectorDb(prospects: ProspectRow[]): {
  db: D1Database
  metricRows: () => MetricRow[]
} {
  const metricStore: MetricRow[] = []

  function makeStmt(sql: string) {
    const upper = sql.trim().toUpperCase()
    const boundArgs: unknown[] = []
    const stmt = {
      bind(...args: unknown[]) { boundArgs.push(...args); return stmt },
      async run() {
        if (upper.includes('INSERT INTO METRIC_POINTS')) {
          const [id, tenant_id, metric_key, value, occurred_at, source, created_at] =
            boundArgs as [string, string, string, number, string, string, string]
          // Duplicate check: same tenant+key+occurred_at+source
          if (
            metricStore.some(
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
          metricStore.push({ id, tenant_id, metric_key, value, occurred_at, source, created_at })
          return { success: true, meta: { changes: 1 } }
        }
        return { success: true, meta: { changes: 0 } }
      },
      async all() {
        if (upper.includes('FROM PROSPECTS') && upper.includes('GROUP BY STATUS')) {
          // Simulate the GROUP BY status query in readProspectCounts
          const [tenantId] = boundArgs as [string]
          const filtered = prospects.filter((p) => p.tenant === tenantId)
          const counts = new Map<string, number>()
          for (const p of filtered) {
            if (['queued', 'drafted', 'sent', 'replied'].includes(p.status)) {
              counts.set(p.status, (counts.get(p.status) ?? 0) + 1)
            }
          }
          const results = [...counts.entries()].map(([status, c]) => ({ status, c }))
          return { results, success: true }
        }
        if (upper.includes('FROM METRIC_POINTS')) {
          const [tenantId, metricKey, from, to] = boundArgs as [string, string, string, string]
          const filtered = metricStore.filter(
            (r) =>
              r.tenant_id === tenantId &&
              r.metric_key === metricKey &&
              r.occurred_at >= from &&
              r.occurred_at <= to,
          )
          return {
            results: filtered.map((r) => ({
              id: r.id,
              tenant_id: r.tenant_id,
              metric_key: r.metric_key,
              value: r.value,
              occurred_at: r.occurred_at,
              source: r.source,
              created_at: r.created_at,
            })),
            success: true,
          }
        }
        return { results: [], success: true }
      },
      async first() {
        return null
      },
    }
    return stmt
  }

  const db = {
    prepare(sql: string) { return makeStmt(sql) },
    async batch(stmts: unknown[]) { return stmts.map(() => ({ success: true, meta: { changes: 0 } })) },
  } as unknown as D1Database

  return { db, metricRows: () => metricStore }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const NOW = '2026-06-17T10:00:00.000Z'
const TENANT = 'mumega'
let idCounter = 0
function makeId() { return `id-${++idCounter}` }

// ────────────────────────────────────────────────────────────────────────────
// A. Registration + activation
// ────────────────────────────────────────────────────────────────────────────

describe('A. GrowthModule registration + activation', () => {
  it('GrowthModule is registered by importing growth.ts', () => {
    const found = getRegistered('growth')
    expect(found).toBeDefined()
    expect(found?.key).toBe('growth')
    expect(found?.name).toBe('Marketing & Sales')
  })

  it('listRegistered() includes growth', () => {
    const keys = listRegistered().map((m) => m.key)
    expect(keys).toContain('growth')
  })

  it('GrowthModule declares 3 metric descriptors', () => {
    expect(GrowthModule.metricsEmitted).toHaveLength(3)
    const keys = GrowthModule.metricsEmitted.map((d) => d.key)
    expect(keys).toContain('growth.leads')
    expect(keys).toContain('growth.replies')
    expect(keys).toContain('growth.conversion')
  })

  it('GrowthModule declares 2 default squads (demand-gen + pipeline)', () => {
    expect(GrowthModule.defaultSquads).toHaveLength(2)
    const slugs = GrowthModule.defaultSquads.map((s) => s.slug)
    expect(slugs).toContain('demand-gen')
    expect(slugs).toContain('pipeline')
  })

  it('activate() seeds both squads on first activation', async () => {
    const store = makeDb()
    register(GrowthModule)
    const result = await activate(store.db, 'growth', {
      now: () => NOW,
      idGen: makeId,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('activation failed')
    expect(result.seeded).toBe(true)
    const slugs = store.squads().map((s) => s.slug)
    expect(slugs).toContain('demand-gen')
    expect(slugs).toContain('pipeline')
    expect(store.squads()).toHaveLength(2)
  })

  it('activate() twice → seeds once (idempotent)', async () => {
    const store = makeDb()
    register(GrowthModule)
    await activate(store.db, 'growth', { now: () => NOW, idGen: makeId })
    const r2 = await activate(store.db, 'growth', { now: () => NOW, idGen: makeId })
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error()
    expect(r2.seeded).toBe(false)
    expect(store.squads()).toHaveLength(2)
  })

  it('activate() three times → still only 2 squad rows', async () => {
    const store = makeDb()
    register(GrowthModule)
    await activate(store.db, 'growth', { now: () => NOW, idGen: makeId })
    await activate(store.db, 'growth', { now: () => NOW, idGen: makeId })
    await activate(store.db, 'growth', { now: () => NOW, idGen: makeId })
    expect(store.squads()).toHaveLength(2)
  })

  it('isolated registry: growth is independent of other registrations', () => {
    const reg = createDepartmentRegistry()
    reg.register(GrowthModule)
    expect(reg.listRegistered().map((m) => m.key)).toContain('growth')
    // Fresh isolated instance has neither growth nor fixture
    const reg2 = createDepartmentRegistry()
    expect(reg2.listRegistered()).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. Collector: seeded prospects → correct metric_points
// ────────────────────────────────────────────────────────────────────────────

describe('B. collectGrowthMetrics: seeded prospects → correct emissions', () => {
  it('emits growth.leads = total funnel count (queued+drafted+sent+replied)', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'drafted' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
    ])

    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(result.emitted).toBe(3) // leads + replies + conversion (sent=1 > 0)

    const leadsRow = metricRows().find((r) => r.metric_key === 'growth.leads')
    expect(leadsRow).toBeDefined()
    expect(leadsRow?.value).toBe(5) // 2 queued + 1 drafted + 1 sent + 1 replied
    expect(leadsRow?.tenant_id).toBe(TENANT)
    expect(leadsRow?.source).toBe('prospects')
  })

  it('emits growth.replies = count of replied prospects', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
      { tenant: TENANT, status: 'replied' },
      { tenant: TENANT, status: 'replied' },
    ])

    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    const repliesRow = metricRows().find((r) => r.metric_key === 'growth.replies')
    expect(repliesRow).toBeDefined()
    expect(repliesRow?.value).toBe(3)
  })

  it('emits growth.conversion = replied/sent ratio', async () => {
    // 2 sent, 1 replied → 0.5
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
    ])

    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    const convRow = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(convRow).toBeDefined()
    expect(convRow?.value).toBeCloseTo(0.5, 5)
  })

  it('metric points have correct occurred_at (injected now)', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
    ])

    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    const rows = metricRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.occurred_at).toBe(NOW)
    }
  })

  it('tenant_id is always bound from the trusted tenantId param', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
    ])

    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    for (const row of metricRows()) {
      expect(row.tenant_id).toBe(TENANT)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. Honesty: zero prospects → emits nothing
// ────────────────────────────────────────────────────────────────────────────

describe('C. Honesty: zero prospects → no fabrication', () => {
  it('zero total prospects → emitted=0, skipped=3', async () => {
    const { db, metricRows } = makeCollectorDb([])

    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    expect(result.emitted).toBe(0)
    expect(result.skipped).toBe(3)
    expect(metricRows()).toHaveLength(0)
  })

  it('zero prospects → outcomes array has 3 skipped entries', async () => {
    const { db } = makeCollectorDb([])

    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    expect(result.outcomes).toHaveLength(3)
    for (const o of result.outcomes) {
      expect(o.outcome).toBe('skipped')
    }
    const outcomeKeys = result.outcomes.map((o) => o.key)
    expect(outcomeKeys).toContain('growth.leads')
    expect(outcomeKeys).toContain('growth.replies')
    expect(outcomeKeys).toContain('growth.conversion')
  })

  it('prospects from a different tenant do not count (tenant isolation)', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: 'other-tenant', status: 'queued' },
      { tenant: 'other-tenant', status: 'replied' },
    ])

    // Collecting for TENANT which has no prospects
    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    expect(result.emitted).toBe(0)
    expect(metricRows()).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. Honesty: sent=0 → no conversion point
// ────────────────────────────────────────────────────────────────────────────

describe('D. Honesty: sent=0 → no growth.conversion emitted', () => {
  it('queued-only funnel (no sent) → conversion is skipped', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'queued' },
    ])

    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    // leads + replies emitted; conversion skipped
    expect(result.emitted).toBe(2)
    expect(result.skipped).toBe(1)

    const convRow = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(convRow).toBeUndefined()

    const convOutcome = result.outcomes.find((o) => o.key === 'growth.conversion')
    expect(convOutcome?.outcome).toBe('skipped')
    expect(convOutcome?.detail).toMatch(/sent=0/)
  })

  it('drafted-only funnel (not yet sent) → conversion is skipped', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'drafted' },
      { tenant: TENANT, status: 'drafted' },
    ])

    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(result.emitted).toBe(2) // leads + replies(=0)
    expect(metricRows().find((r) => r.metric_key === 'growth.conversion')).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E. Conversion arithmetic
// ────────────────────────────────────────────────────────────────────────────

describe('E. Conversion arithmetic', () => {
  it('100% reply rate: all sent have replied', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
      { tenant: TENANT, status: 'replied' },
    ])
    // sent=1, replied=2 → ratio = 2/1 = 2.0
    // (cumulative model: replied can exceed sent if replies outpace current sent count)
    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(row?.value).toBeCloseTo(2.0, 5)
  })

  it('25% reply rate: 4 sent, 1 replied', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
    ])
    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(row?.value).toBeCloseTo(0.25, 5)
  })

  it('0% reply rate: 5 sent, 0 replied', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
    ])
    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
    // 0 replied / 5 sent = 0.0 — this IS emitted (sent > 0, so the ratio is defined)
    expect(row?.value).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// F. Pulse readback: emitted points → aggregateOHLC → seriesShape='bar'
// ────────────────────────────────────────────────────────────────────────────

describe('F. Pulse readback: daily scalars → seriesShape=bar', () => {
  it('one growth.leads reading per day → seriesShape=bar (ohlcEligible=false honesty)', () => {
    // Simulate two daily snapshots from separate cron ticks
    const buckets: OHLCBucket[] = [
      { date: '2026-06-16', open: 10, high: 10, low: 10, close: 10, count: 1 },
      { date: '2026-06-17', open: 12, high: 12, low: 12, close: 12, count: 1 },
    ]
    expect(seriesShape(buckets)).toBe('bar')
  })

  it('growth.leads ohlcEligible=false declared in module manifest', () => {
    const desc = GrowthModule.metricsEmitted.find((d) => d.key === 'growth.leads')!
    expect(desc.ohlcEligible).toBe(false)
    expect(desc.cadence).toBe('daily')
  })

  it('growth.replies ohlcEligible=false declared in module manifest', () => {
    const desc = GrowthModule.metricsEmitted.find((d) => d.key === 'growth.replies')!
    expect(desc.ohlcEligible).toBe(false)
    expect(desc.cadence).toBe('daily')
  })

  it('growth.conversion ohlcEligible=false declared in module manifest', () => {
    const desc = GrowthModule.metricsEmitted.find((d) => d.key === 'growth.conversion')!
    expect(desc.ohlcEligible).toBe(false)
    expect(desc.cadence).toBe('daily')
    expect(desc.unit).toBe('ratio')
    expect(desc.aggregation).toBe('last')
  })

  it('aggregateOHLC on emitted collector points returns count=1 per bucket (daily scalar)', async () => {
    // Two different days, one emit each
    const d1 = '2026-06-16T10:00:00.000Z'
    const d2 = '2026-06-17T10:00:00.000Z'

    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'replied' },
    ])

    await collectGrowthMetrics({ db }, TENANT, d1, { idGen: makeId })
    await collectGrowthMetrics({ db }, TENANT, d2, { idGen: makeId })

    const leadsPoints = metricRows()
      .filter((r) => r.metric_key === 'growth.leads' && r.tenant_id === TENANT)
      .map((r) => ({ value: r.value, occurredAt: r.occurred_at }))

    const buckets = aggregateOHLC(leadsPoints, { bucket: 'day' })
    expect(buckets).toHaveLength(2)
    expect(buckets.every((b) => b.count === 1)).toBe(true)
    expect(seriesShape(buckets)).toBe('bar')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// G. Capability confinement via ctx
// ────────────────────────────────────────────────────────────────────────────

describe('G. Capability confinement: growth ctx', () => {
  it('growth ctx rejects a key not in metricsEmitted (key not owned)', async () => {
    const { db } = makeCollectorDb([])
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
    })

    await expect(
      ctx.metrics.emit({ key: 'fixture.pings', value: 1, occurredAt: NOW, source: 'prospects' }),
    ).rejects.toThrow(/key_not_owned|is not declared/)
  })

  it('growth ctx rejects a source not in sourceAuthority', async () => {
    const { db } = makeCollectorDb([])
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
    })

    await expect(
      ctx.metrics.emit({ key: 'growth.leads', value: 5, occurredAt: NOW, source: 'stripe' }),
    ).rejects.toThrow(/source_not_authorized|not in sourceAuthority/)
  })

  it('growth ctx rejects emit from insufficient capability (observer)', async () => {
    const { db } = makeCollectorDb([])
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['observer'],
    })

    await expect(
      ctx.metrics.emit({ key: 'growth.leads', value: 5, occurredAt: NOW, source: 'prospects' }),
    ).rejects.toThrow(/capability_denied/)
  })

  it('growth ctx accepts growth.leads from prospects source with member cap', async () => {
    const { db, metricRows } = makeCollectorDb([{ tenant: TENANT, status: 'queued' }])
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
      idGen: makeId,
    })

    const result = await ctx.metrics.emit({ key: 'growth.leads', value: 1, occurredAt: NOW, source: 'prospects' })
    expect(result.ok).toBe(true)
    expect(metricRows().find((r) => r.metric_key === 'growth.leads')).toBeDefined()
  })

  it('violation throws CtxError (not generic Error)', async () => {
    const { db } = makeCollectorDb([])
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
    })
    const err = await ctx.metrics.emit({
      key: 'growth.leads', value: 1, occurredAt: NOW, source: 'stripe',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CtxError)
    expect((err as CtxError).code).toBe('source_not_authorized')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// H. Module cannot mint: structural import check
// ────────────────────────────────────────────────────────────────────────────

describe('H. growth.ts cannot mint — export surface structural assertion', () => {
  it('growth.ts module namespace has no kernelMintCtx export', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const growthMod = await import('../src/departments/modules/growth') as Record<string, any>
    expect(growthMod['kernelMintCtx']).toBeUndefined()
  })

  it('growth.ts module namespace has no _KERNEL_TOKEN export', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const growthMod = await import('../src/departments/modules/growth') as Record<string, any>
    expect(growthMod['_KERNEL_TOKEN']).toBeUndefined()
  })

  it('growth.ts module namespace exports only GrowthModule (a plain data object)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const growthMod = await import('../src/departments/modules/growth') as Record<string, any>
    const exportedFunctions = Object.entries(growthMod)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
    // No functions should be exported from a declarative module
    expect(exportedFunctions).toHaveLength(0)
  })

  it('growth.ts module is a plain object (data manifest, no methods)', () => {
    expect(typeof GrowthModule).toBe('object')
    expect(typeof GrowthModule.key).toBe('string')
    // A module is data — it has no callable methods
    const ownMethods = Object.getOwnPropertyNames(GrowthModule)
      .filter((k) => typeof (GrowthModule as Record<string, unknown>)[k] === 'function')
    expect(ownMethods).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// I. Duplicate emit: cron re-tick → skipped, not error
// ────────────────────────────────────────────────────────────────────────────

describe('I. Duplicate emit: same occurred_at → skipped outcome', () => {
  it('collecting twice at the same timestamp → duplicates are skipped gracefully', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'replied' },
      { tenant: TENANT, status: 'sent' },
    ])

    // First collect: should emit 3 points
    const r1 = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(r1.emitted).toBe(3)
    expect(metricRows()).toHaveLength(3)

    // Second collect at same timestamp: all three hit the duplicate constraint
    const r2 = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    // Duplicates → all skipped, none re-inserted
    expect(r2.emitted).toBe(0)
    expect(r2.skipped).toBe(3)
    // Still only 3 rows in the store — no double-insert
    expect(metricRows()).toHaveLength(3)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// J. readProspectCounts isolation
// ────────────────────────────────────────────────────────────────────────────

describe('J. readProspectCounts tenant isolation', () => {
  it('counts are scoped to tenantId — different tenants do not leak', async () => {
    const { db } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'replied' },
      { tenant: 'other', status: 'queued' },
      { tenant: 'other', status: 'sent' },
      { tenant: 'other', status: 'replied' },
    ])

    const counts = await readProspectCounts(db, TENANT)
    expect(counts.queued).toBe(1)
    expect(counts.replied).toBe(1)
    expect(counts.sent).toBe(0)

    const otherCounts = await readProspectCounts(db, 'other')
    expect(otherCounts.queued).toBe(1)
    expect(otherCounts.sent).toBe(1)
    expect(otherCounts.replied).toBe(1)
  })

  it('opted_out and bounced are NOT counted as funnel positions', async () => {
    const { db } = makeCollectorDb([
      { tenant: TENANT, status: 'opted_out' },
      { tenant: TENANT, status: 'bounced' },
      { tenant: TENANT, status: 'queued' },
    ])

    const counts = await readProspectCounts(db, TENANT)
    expect(counts.queued).toBe(1)
    expect(counts.drafted).toBe(0)
    expect(counts.sent).toBe(0)
    expect(counts.replied).toBe(0)
    // Total active funnel = 1, not 3
  })
})
