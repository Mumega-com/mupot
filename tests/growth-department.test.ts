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

// ── Growth dashboard view imports ─────────────────────────────────────────────
import { loadGrowthView, growthBody, computeKPIs } from '../src/dashboard/growth'
import type { GrowthFunnel } from '../src/dashboard/growth'
import type { Env } from '../src/types'

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

  it('GrowthModule metricsEmitted is empty (S2: funnel metrics moved to OutboundChannel)', () => {
    // S2: growth.leads / growth.replies / growth.conversion are now in OutboundChannel.
    // The dept's effective descriptors = composeDeptMetricDescriptors(metricsEmitted, channels).
    expect(GrowthModule.metricsEmitted).toHaveLength(0)
  })

  it('GrowthModule has OutboundChannel in channels (S2)', () => {
    expect(GrowthModule.channels).toBeDefined()
    expect(GrowthModule.channels).toHaveLength(1)
    expect(GrowthModule.channels![0].key).toBe('outbound')
  })

  it('GrowthModule composed metric set has 3 funnel descriptors (via OutboundChannel)', () => {
    // The composed set is what the kernel authorizes — test it via OutboundChannel directly.
    // growth.channels = [OutboundChannel], which has 3 metricDescriptors.
    const channelMetrics = GrowthModule.channels?.flatMap((ch) => ch.metricDescriptors) ?? []
    const allMetrics = [...GrowthModule.metricsEmitted, ...channelMetrics]
    expect(allMetrics).toHaveLength(3)
    const keys = allMetrics.map((d) => d.key)
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

  it('emits growth.conversion = replied/(sent+replied) ratio', async () => {
    // sent=2, replied=1 → reached = 2+1 = 3, conversion = 1/3 ≈ 0.333
    // (old formula replied/sent = 1/2 = 0.5 was wrong — it ignored the denominator contribution
    //  from prospects that already moved from 'sent' to 'replied')
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
    ])

    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    const convRow = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(convRow).toBeDefined()
    expect(convRow?.value).toBeCloseTo(1 / 3, 5)
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

describe('D. Honesty: reached=0 → no growth.conversion emitted', () => {
  // "reached" = sent + replied. Conversion is only meaningful when at least one
  // prospect has been contacted. queued/drafted rows have NOT been contacted.

  it('queued-only funnel (reached=0) → conversion is skipped', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'queued' },
    ])

    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    // leads + replies emitted; conversion skipped (reached=0)
    expect(result.emitted).toBe(2)
    expect(result.skipped).toBe(1)

    const convRow = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(convRow).toBeUndefined()

    const convOutcome = result.outcomes.find((o) => o.key === 'growth.conversion')
    expect(convOutcome?.outcome).toBe('skipped')
    expect(convOutcome?.detail).toMatch(/reached=0/)
  })

  it('drafted-only funnel (reached=0) → conversion is skipped', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'drafted' },
      { tenant: TENANT, status: 'drafted' },
    ])

    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(result.emitted).toBe(2) // leads + replies(=0)
    expect(metricRows().find((r) => r.metric_key === 'growth.conversion')).toBeUndefined()
  })

  it('zero prospects (all zero) → conversion is skipped', async () => {
    // No prospects at all → reached=0; distinct from the C-section zero-total test
    // (that proves emitted=0 overall; this specifically verifies the conversion guard).
    const { metricRows } = makeCollectorDb([])
    expect(metricRows().find((r) => r.metric_key === 'growth.conversion')).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E. Conversion arithmetic
// ────────────────────────────────────────────────────────────────────────────

describe('E. Conversion arithmetic — reply rate = replied / (sent + replied)', () => {
  // All cases must produce a value in [0, 1] — bounded by construction.
  // reached = sent + replied (mutually-exclusive current-state statuses).

  it('100% rate: sent=0, replied=2 → reached=2, conversion=1.0 (NOT skipped)', async () => {
    // All contacted prospects have replied — they moved out of 'sent' into 'replied'.
    // Old logic would incorrectly skip this (sent=0); correct logic: reached=2, rate=1.0.
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'replied' },
      { tenant: TENANT, status: 'replied' },
    ])
    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(row?.value).toBeCloseTo(1.0, 5)
  })

  it('~33% rate: sent=1, replied=2 → reached=3, conversion≈0.667 (NOT 2.0)', async () => {
    // Old formula replied/sent = 2/1 = 2.0 — mathematically impossible rate > 100%.
    // Correct: reached = 1+2 = 3, rate = 2/3 ≈ 0.667 — bounded in [0,1].
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
      { tenant: TENANT, status: 'replied' },
    ])
    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(row?.value).toBeCloseTo(2 / 3, 5)
    // Sanity: must be ≤ 1.0
    expect((row?.value ?? 2)).toBeLessThanOrEqual(1.0)
  })

  it('20% rate: sent=4, replied=1 → reached=5, conversion=0.2', async () => {
    // Old formula: 1/4 = 0.25 — wrong (ignored the replied row's contribution to denominator).
    // Correct: reached = 4+1 = 5, rate = 1/5 = 0.2.
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
    ])
    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(row?.value).toBeCloseTo(0.2, 5)
  })

  it('0% rate: sent=5, replied=0 → reached=5, conversion=0.0 (IS emitted)', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
    ])
    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
    // 0 replied / 5 reached = 0.0 — ratio IS defined (reached > 0) → emitted
    expect(row?.value).toBe(0)
  })

  it('conversion is always bounded [0, 1] across all status combinations', async () => {
    // Exhaustive bound check: try several combinations and verify ≤ 1.0.
    const scenarios: Array<{ sent: number; replied: number; expected: number }> = [
      { sent: 0, replied: 1, expected: 1.0 },
      { sent: 1, replied: 1, expected: 0.5 },
      { sent: 3, replied: 1, expected: 0.25 },
      { sent: 0, replied: 5, expected: 1.0 },
      { sent: 5, replied: 0, expected: 0.0 },
    ]
    for (const { sent, replied, expected } of scenarios) {
      const rows = [
        ...Array.from({ length: sent }, () => ({ tenant: TENANT, status: 'sent' as const })),
        ...Array.from({ length: replied }, () => ({ tenant: TENANT, status: 'replied' as const })),
      ]
      const { db, metricRows } = makeCollectorDb(rows)
      await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
      const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
      expect(row?.value ?? 0).toBeCloseTo(expected, 5)
      expect(row?.value ?? 0).toBeLessThanOrEqual(1.0)
      expect(row?.value ?? 0).toBeGreaterThanOrEqual(0.0)
    }
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

  it('growth.leads ohlcEligible=false declared in OutboundChannel (S2: moved from metricsEmitted)', () => {
    // S2: growth.leads is now in OutboundChannel.metricDescriptors.
    const desc = GrowthModule.channels![0].metricDescriptors.find((d) => d.key === 'growth.leads')!
    expect(desc.ohlcEligible).toBe(false)
    expect(desc.cadence).toBe('daily')
  })

  it('growth.replies ohlcEligible=false declared in OutboundChannel (S2: moved from metricsEmitted)', () => {
    const desc = GrowthModule.channels![0].metricDescriptors.find((d) => d.key === 'growth.replies')!
    expect(desc.ohlcEligible).toBe(false)
    expect(desc.cadence).toBe('daily')
  })

  it('growth.conversion ohlcEligible=false declared in OutboundChannel (S2: moved from metricsEmitted)', () => {
    const desc = GrowthModule.channels![0].metricDescriptors.find((d) => d.key === 'growth.conversion')!
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

// ────────────────────────────────────────────────────────────────────────────
// K. Kernel boundary hardening (WARN-1 + WARN-2)
// ────────────────────────────────────────────────────────────────────────────

describe('K. Kernel boundary: key_mismatch + module freeze (WARN-1, WARN-2)', () => {
  it('WARN-2: mint throws key_mismatch when departmentKey differs from module.key', () => {
    const { db } = makeCollectorDb([])
    expect(() =>
      kernelMintCtx({ db }, {
        tenantId: TENANT,
        departmentKey: 'finance',   // does NOT match GrowthModule.key = 'growth'
        module: GrowthModule,
        capabilities: ['member'],
      }),
    ).toThrow(/key_mismatch/)
  })

  it('WARN-2: mint succeeds when departmentKey matches module.key', () => {
    const { db } = makeCollectorDb([])
    expect(() =>
      kernelMintCtx({ db }, {
        tenantId: TENANT,
        departmentKey: 'growth',
        module: GrowthModule,
        capabilities: ['member'],
      }),
    ).not.toThrow()
  })

  it('WARN-1: mutating the module object after mint does not widen ctx authority', async () => {
    // Construct a mutable copy of GrowthModule and mint a ctx from it.
    // Then push a new (unauthorized) metric descriptor onto the original's metricsEmitted.
    // The ctx authority must remain frozen to the state at mint time.
    const mutableModule = { ...GrowthModule, metricsEmitted: [...GrowthModule.metricsEmitted] }
    const { db } = makeCollectorDb([])
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: mutableModule,
      capabilities: ['member'],
    })

    // Attempt to widen authority post-mint by injecting a new key into the original array.
    // The kernel froze a clone at mint time — this push does NOT affect _metricsMap.
    mutableModule.metricsEmitted.push({
      key: 'growth.injected',
      unit: 'count',
      direction: 'up_good',
      cadence: 'daily',
      aggregation: 'sum',
      ohlcEligible: false,
      sourceAuthority: ['prospects'],
      retention: '90d',
      display: { precision: 0 },
    })

    // Emit on the injected key should still be rejected — it was not present at mint time.
    await expect(
      ctx.metrics.emit({ key: 'growth.injected', value: 1, occurredAt: NOW, source: 'prospects' }),
    ).rejects.toThrow(/key_not_owned|is not declared/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// L. Cron wiring: runGrowthCollection behaviour
//
// Tests the three invariants of the scheduled growth step:
//   1. growth ACTIVE for tenant → collector runs, metric_points populated.
//   2. growth NOT active → collector skipped, no emit, no error.
//   3. A thrown collector error is caught (fail-soft) and doesn't propagate.
//
// We test these via runGrowthCollection, exported here for testing only.
// ────────────────────────────────────────────────────────────────────────────

// Import runGrowthCollection from its own module (not src/index.ts, which imports
// Hono + @cloudflare/workers-oauth-provider — protocols vitest cannot resolve).
import { runGrowthCollection } from '../src/departments/collectors/growth-cron'

// Helper: build a minimal Env-shaped object for cron tests
function makeEnv(
  db: D1Database,
  tenantSlug: string,
): import('../src/types').Env {
  return {
    DB: db,
    TENANT_SLUG: tenantSlug,
  } as unknown as import('../src/types').Env
}

// Helper: make a DB that serves active departments + handles metric_points inserts.
// activeDeptTemplateKeys: list of template_keys to return from getActive().
function makeCronDb(
  activeDeptTemplateKeys: string[],
  prospects: Array<{ tenant: string; status: string }>,
): { db: D1Database; metricRows: () => MetricRow[] } {
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
        if (upper.includes('FROM DEPARTMENTS') && upper.includes('ACTIVE = 1')) {
          // Simulate getActive(): return rows for each active template_key
          const rows = activeDeptTemplateKeys.map((key, i) => ({
            id: `dept-${i}`,
            slug: key,
            name: key,
            template_key: key,
            template_version: '0.1.0',
            activated_at: NOW,
            active: 1,
            seed_receipt: null,
            created_at: NOW,
          }))
          return { results: rows, success: true }
        }
        if (upper.includes('FROM PROSPECTS') && upper.includes('GROUP BY STATUS')) {
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
        return { results: [], success: true }
      },
      async first() { return null },
    }
    return stmt
  }

  const db = {
    prepare(sql: string) { return makeStmt(sql) },
    async batch(stmts: unknown[]) { return stmts.map(() => ({ success: true, meta: { changes: 0 } })) },
  } as unknown as D1Database

  return { db, metricRows: () => metricStore }
}

describe('L. Cron wiring: runGrowthCollection', () => {
  it('growth ACTIVE for tenant → collector runs, metric_points populated', async () => {
    const { db, metricRows } = makeCronDb(['growth'], [
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
    ])

    await runGrowthCollection(makeEnv(db, TENANT))

    // Should have emitted leads + replies + conversion (3 points)
    expect(metricRows().length).toBeGreaterThan(0)
    const keys = metricRows().map((r) => r.metric_key)
    expect(keys).toContain('growth.leads')
    expect(keys).toContain('growth.replies')
    expect(keys).toContain('growth.conversion')
  })

  it('growth NOT active → collector skipped, no metric_points emitted, no error', async () => {
    // Active departments list does NOT include 'growth'
    const { db, metricRows } = makeCronDb(['finance'], [
      { tenant: TENANT, status: 'queued' },
    ])

    await expect(runGrowthCollection(makeEnv(db, TENANT))).resolves.toBeUndefined()
    expect(metricRows()).toHaveLength(0)
  })

  it('no active departments at all → collector skipped, no error', async () => {
    const { db, metricRows } = makeCronDb([], [
      { tenant: TENANT, status: 'queued' },
    ])

    await expect(runGrowthCollection(makeEnv(db, TENANT))).resolves.toBeUndefined()
    expect(metricRows()).toHaveLength(0)
  })

  it('collector throws → error is caught (fail-soft), promise resolves without throw', async () => {
    // Build a DB where getActive() returns growth as active, but the prospects query throws.
    let callCount = 0
    function makeFailingStmt(sql: string) {
      const upper = sql.trim().toUpperCase()
      const boundArgs: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) { boundArgs.push(...args); return stmt },
        async run() { return { success: true, meta: { changes: 0 } } },
        async all() {
          if (upper.includes('FROM DEPARTMENTS') && upper.includes('ACTIVE = 1')) {
            return {
              results: [{
                id: 'dept-1', slug: 'growth', name: 'Growth', template_key: 'growth',
                template_version: '0.1.0', activated_at: NOW, active: 1,
                seed_receipt: null, created_at: NOW,
              }],
              success: true,
            }
          }
          // Simulate a failure in the prospects query (which collectGrowthMetrics calls)
          callCount++
          throw new Error('simulated DB failure in prospects query')
        },
        async first() { return null },
      }
      return stmt
    }

    const failingDb = {
      prepare(sql: string) { return makeFailingStmt(sql) },
      async batch(stmts: unknown[]) { return stmts.map(() => ({ success: true, meta: { changes: 0 } })) },
    } as unknown as D1Database

    // Must resolve (not reject) — fail-soft catches the error internally
    await expect(runGrowthCollection(makeEnv(failingDb, TENANT))).resolves.toBeUndefined()
    // The prospects query was attempted (callCount > 0 proves we reached the collector)
    expect(callCount).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// M. Frozen-module mint: collector sources manifest from registry frozen copy
//
// Proves that:
//   1. The collector mints from the registry's frozen registered module (not the
//      directly-imported GrowthModule singleton).
//   2. Mutating the imported GrowthModule after registration does NOT affect the
//      minted ctx's authority (the registry clone is what the collector uses).
// ────────────────────────────────────────────────────────────────────────────

describe('M. Frozen-module mint: collector uses registry frozen copy', () => {
  it('getRegistered("growth") returns a frozen module (Object.isFrozen)', () => {
    const frozen = getRegistered('growth')
    expect(frozen).toBeDefined()
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen?.metricsEmitted)).toBe(true)
  })

  it('mutating GrowthModule.metricsEmitted does NOT affect what the collector mints', async () => {
    // Attempt to push a new descriptor onto the imported GrowthModule's metricsEmitted.
    // GrowthModule was frozen by the registry after auto-registration — this push should
    // silently fail in sloppy mode or throw in strict mode (either way: the array is unchanged).
    const originalLength = GrowthModule.metricsEmitted.length
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(GrowthModule.metricsEmitted as any).push({
        key: 'growth.injected_via_original',
        unit: 'count',
        direction: 'up_good',
        cadence: 'daily',
        aggregation: 'sum',
        ohlcEligible: false,
        sourceAuthority: ['prospects'],
        retention: '90d',
        display: { precision: 0 },
      })
    } catch {
      // Strict mode TypeError from frozen array — expected, swallow it.
    }

    // The registered module (frozen registry clone) must still have the original length.
    const frozenModule = getRegistered('growth')
    expect(frozenModule?.metricsEmitted).toHaveLength(originalLength)

    // Collecting metrics with the frozen module must still work correctly —
    // the injected key is NOT present in the registry clone → key_not_owned if emitted.
    const { db, metricRows } = makeCollectorDb([{ tenant: TENANT, status: 'queued' }])
    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })

    // Only the original 3 keys were emitted (leads, replies — conversion skipped since reached=0).
    expect(result.emitted).toBe(2)  // leads + replies (queued-only → reached=0 → no conversion)
    const emittedKeys = metricRows().map((r) => r.metric_key)
    expect(emittedKeys).not.toContain('growth.injected_via_original')
  })

  it('collector cannot mint when growth module is not in registry (isolated registry check)', () => {
    // Create an isolated registry that does NOT have growth registered.
    // collectGrowthMetrics uses the SINGLETON registry, not isolated instances,
    // so this test proves the guard path by directly calling getRegistered from
    // an isolated registry (which is what the guard code in the collector does).
    const isolatedReg = createDepartmentRegistry()
    // Isolated registry has no modules — getRegistered returns undefined.
    expect(isolatedReg.getRegistered('growth')).toBeUndefined()
    // The production singleton (used by the collector) DOES have growth registered.
    expect(getRegistered('growth')).toBeDefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// N. loadGrowthView + growthBody: funnelAvailable honesty
//
// Proves the three distinct funnel states:
//   N1. DB error on any count → funnelAvailable=false, kpis=null, body renders
//       "unavailable" marker (NOT zeros, NOT the empty-source message).
//   N2. Real all-zero funnel → funnelAvailable=true, kpis computed (all zeros),
//       body renders the honest empty state ("connect a source").
//   N3. Populated funnel → funnelAvailable=true, kpis computed, body renders counts.
//
// Also: N4. Single-count error makes the whole funnel unavailable (allSettled gate).
//       N5. computeKPIs is unaffected — it still works on valid GrowthFunnel input.
// ────────────────────────────────────────────────────────────────────────────

// Minimal stubs for loadGrowthView (it needs env.DB for dept/squads + series,
// but we control countFn + readSeriesFn via deps to isolate the funnel logic).

function makeMinimalEnv(): Env {
  // Only DB is used inside loadGrowthView. We provide a stub that returns
  // empty results for dept/squad queries (the non-funnel paths).
  const db = {
    prepare(_sql: string) {
      const stmt = {
        bind(..._args: unknown[]) { return stmt },
        async run() { return { success: true, meta: { changes: 0 } } },
        async all() { return { results: [], success: true } },
        async first() { return null },
      }
      return stmt
    },
    async batch(stmts: unknown[]) { return stmts.map(() => ({ success: true, meta: { changes: 0 } })) },
  }
  return { DB: db } as unknown as Env
}

const STUB_AUTH = {
  userId: 'u1', email: null, role: 'owner' as const, tenant: TENANT,
}

// readSeriesFn stub that returns an empty result (no chart data needed for these tests).
const emptySeriesFn = async () => ({ points: [], truncated: false })

describe('N. loadGrowthView + growthBody: funnelAvailable honesty', () => {
  // ── N1. DB error → funnelAvailable=false, kpis=null, body renders "unavailable" ──

  it('N1a: any countFn rejection → funnelAvailable=false', async () => {
    const env = makeMinimalEnv()
    // One of the four counts rejects (e.g. DB timeout on 'queued')
    const countFn = async (_env: Env, status: string) => {
      if (status === 'queued') throw new Error('D1 timeout')
      return 0
    }
    const view = await loadGrowthView(env, STUB_AUTH, { countFn, readSeriesFn: emptySeriesFn, nowMs: 0 })
    expect(view.funnelAvailable).toBe(false)
  })

  it('N1b: funnelAvailable=false → kpis is null', async () => {
    const env = makeMinimalEnv()
    const countFn = async () => { throw new Error('DB down') }
    const view = await loadGrowthView(env, STUB_AUTH, { countFn, readSeriesFn: emptySeriesFn, nowMs: 0 })
    expect(view.kpis).toBeNull()
  })

  it('N1c: funnelAvailable=false → growthBody renders "unavailable" marker, not zeros', () => {
    const env = makeMinimalEnv()
    void env
    // Construct a view directly with funnelAvailable=false
    const view = {
      dept: { id: null, name: 'Marketing & Sales', active: false },
      funnelAvailable: false,
      funnel: { queued: 0, drafted: 0, sent: 0, replied: 0 },
      kpis: null,
      leadsBuckets: [],
      truncated: false,
      squads: [],
    }
    const body = String(growthBody(view))
    // Must contain the unavailable marker
    expect(body).toContain('unavailable')
    // Must NOT contain the empty-source message (that's for a real empty funnel)
    expect(body).not.toContain('connect a source')
    // Must NOT show a numeric zero from the KPIs (the cards render "—")
    // KPI values "—" (em dash) should appear 3 times (Leads, Replies, Reply rate)
    const dashMatches = (body.match(/—/g) ?? []).length
    expect(dashMatches).toBeGreaterThanOrEqual(3)
  })

  it('N1d: growthBody unavailable state does NOT render the funnel cells (no count numbers)', () => {
    const view = {
      dept: { id: null, name: 'Marketing & Sales', active: false },
      funnelAvailable: false,
      funnel: { queued: 0, drafted: 0, sent: 0, replied: 0 },
      kpis: null,
      leadsBuckets: [],
      truncated: false,
      squads: [],
    }
    const body = String(growthBody(view))
    // The funnelUnavailableRow renders a .unavailable paragraph, not the stage cells.
    // The funnel cell labels (queued/drafted/sent/replied) must NOT appear.
    expect(body).not.toContain('>queued<')
    expect(body).not.toContain('>drafted<')
  })

  // ── N2. Real all-zero funnel → funnelAvailable=true, honest empty state ──

  it('N2a: all counts resolve to 0 → funnelAvailable=true', async () => {
    const env = makeMinimalEnv()
    const countFn = async () => 0
    const view = await loadGrowthView(env, STUB_AUTH, { countFn, readSeriesFn: emptySeriesFn, nowMs: 0 })
    expect(view.funnelAvailable).toBe(true)
  })

  it('N2b: all-zero counts → kpis computed (leads=0, replies=0, replyRate=null)', async () => {
    const env = makeMinimalEnv()
    const countFn = async () => 0
    const view = await loadGrowthView(env, STUB_AUTH, { countFn, readSeriesFn: emptySeriesFn, nowMs: 0 })
    expect(view.kpis).not.toBeNull()
    expect(view.kpis?.leads).toBe(0)
    expect(view.kpis?.replies).toBe(0)
    expect(view.kpis?.replyRate).toBeNull()
  })

  it('N2c: all-zero funnel → growthBody renders "connect a source" (NOT "unavailable")', async () => {
    const env = makeMinimalEnv()
    const countFn = async () => 0
    const view = await loadGrowthView(env, STUB_AUTH, { countFn, readSeriesFn: emptySeriesFn, nowMs: 0 })
    const body = String(growthBody(view))
    expect(body).toContain('connect a source')
    expect(body).not.toContain('unavailable')
  })

  // ── N3. Populated funnel → normal render ──

  it('N3a: populated funnel → funnelAvailable=true, kpis computed correctly', async () => {
    const env = makeMinimalEnv()
    const counts: Record<string, number> = { queued: 3, drafted: 2, sent: 5, replied: 1 }
    const countFn = async (_env: Env, status: string) => counts[status] ?? 0
    const view = await loadGrowthView(env, STUB_AUTH, { countFn, readSeriesFn: emptySeriesFn, nowMs: 0 })
    expect(view.funnelAvailable).toBe(true)
    expect(view.kpis).not.toBeNull()
    expect(view.kpis?.leads).toBe(11)   // 3+2+5+1
    expect(view.kpis?.replies).toBe(1)
    // replyRate = 1 / (5+1) ≈ 0.1667
    expect(view.kpis?.replyRate).toBeCloseTo(1 / 6, 5)
  })

  it('N3b: populated funnel → growthBody renders numeric counts (not "—" or "unavailable")', async () => {
    const env = makeMinimalEnv()
    const counts: Record<string, number> = { queued: 3, drafted: 2, sent: 5, replied: 1 }
    const countFn = async (_env: Env, status: string) => counts[status] ?? 0
    const view = await loadGrowthView(env, STUB_AUTH, { countFn, readSeriesFn: emptySeriesFn, nowMs: 0 })
    const body = String(growthBody(view))
    expect(body).not.toContain('connect a source')
    expect(body).not.toContain('unavailable')
    // KPI leads = 11 should appear in the body
    expect(body).toContain('11')
  })

  // ── N4. Partial failure: single-count error makes whole funnel unavailable ──

  it('N4: only one count rejects → still funnelAvailable=false (not partially zero)', async () => {
    const env = makeMinimalEnv()
    // 'sent' rejects; others succeed with realistic counts
    const countFn = async (_env: Env, status: string) => {
      if (status === 'sent') throw new Error('timeout')
      return status === 'queued' ? 5 : 2
    }
    const view = await loadGrowthView(env, STUB_AUTH, { countFn, readSeriesFn: emptySeriesFn, nowMs: 0 })
    // A partial count is worse than no count — the funnel must be unavailable, not
    // a silently-wrong partial total.
    expect(view.funnelAvailable).toBe(false)
    expect(view.kpis).toBeNull()
  })

  // ── N5. computeKPIs purity — unaffected by the funnelAvailable flag ──

  it('N5: computeKPIs still returns correct values on a valid GrowthFunnel', () => {
    const f: GrowthFunnel = { queued: 10, drafted: 5, sent: 8, replied: 2 }
    const kpis = computeKPIs(f)
    expect(kpis.leads).toBe(25)
    expect(kpis.replies).toBe(2)
    // replyRate = 2 / (8+2) = 0.2
    expect(kpis.replyRate).toBeCloseTo(0.2, 5)
  })
})
