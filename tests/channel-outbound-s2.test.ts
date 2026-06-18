// tests/channel-outbound-s2.test.ts — S2 channel wiring conformance harness.
//
// PURPOSE: prove the S2 invariants from docs/architecture/marketing-channels.md §6:
//
//   1. COMPOSED MANIFEST: getActiveMetricDescriptors for an activated Growth module
//      includes growth.leads, growth.replies, growth.conversion (via OutboundChannel).
//
//   2. COLLECTOR AUTHORIZATION: the Growth collector still emits leads/replies/conversion
//      via the composed manifest; a foreign source is still rejected (sourceAuthority
//      unchanged at ['prospects']).
//
//   3. ISOLATION: removing OutboundChannel from growth.channels (channels: []) removes
//      the 3 funnel metrics from getActiveMetricDescriptors, leaves dept own metrics
//      (empty in S2) and sibling departments intact.
//
//   4. FROZEN CHANNELS: after registering the Growth module, attempting to mutate
//      OutboundChannel.metricDescriptors throws (frozen). Confirms module.channels is
//      frozen post-registration.
//
//   5. DEPT-OWN DUP-KEY REJECTED (Step 2): passing deptOwn with a duplicate key throws
//      ChannelComposeError.
//
//   6. KEY-SHADOW GUARD STILL FIRES: a channel declaring a key in deptOwn throws
//      ChannelComposeError.
//
//   7. REGRESSION: all S1/S2 structural invariants verified with the real growth module.

import { describe, it, expect } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

// ── Imports ───────────────────────────────────────────────────────────────────

import { OutboundChannel } from '../src/departments/channels/outbound-channel'
import {
  composeDeptMetricDescriptors,
  deepFreezeChannels,
  ChannelComposeError,
} from '../src/departments/channels/compose'
import { GrowthModule } from '../src/departments/modules/growth'
import {
  createDepartmentRegistry,
  kernelMintCtx,
} from '../src/departments/registry'
import { collectGrowthMetrics } from '../src/departments/collectors/growth-collector'

// ── In-memory DB helpers ──────────────────────────────────────────────────────

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

// A minimal dept DB that supports getActive() only (enough for getActiveMetricDescriptors).
function makeDeptDb(activeTemplateKeys: string[]): D1Database {
  const rows: DeptRow[] = activeTemplateKeys.map((key, i) => ({
    id: `dept-${i}`,
    slug: key,
    name: key,
    template_key: key,
    template_version: '0.1.0',
    activated_at: '2026-06-18T00:00:00.000Z',
    active: 1,
    seed_receipt: null,
    created_at: '2026-06-18T00:00:00.000Z',
  }))

  const db = {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase()
      const boundArgs: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) { boundArgs.push(...args); return stmt },
        async run() { return { success: true, meta: { changes: 0 } } },
        async all() {
          if (upper.includes('FROM DEPARTMENTS') && upper.includes('ACTIVE = 1')) {
            return { results: rows.filter((r) => r.active === 1), success: true }
          }
          return { results: [], success: true }
        },
        async first() { return null },
      }
      return stmt
    },
    async batch(stmts: unknown[]) {
      return (stmts as Array<ReturnType<typeof db.prepare>>).map(() => ({
        success: true,
        meta: { changes: 0 },
      }))
    },
  } as unknown as D1Database

  return db
}

// A combined metric + prospect DB for collector tests.
function makeCollectorDb(prospects: ProspectRow[]): {
  db: D1Database
  metricRows: () => MetricRow[]
} {
  const metricStore: MetricRow[] = []

  const db = {
    prepare(sql: string) {
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
          if (upper.includes('FROM PROSPECTS') && upper.includes('GROUP BY STATUS')) {
            const [tenantId] = boundArgs as [string]
            const filtered = prospects.filter((p) => p.tenant === tenantId)
            const counts = new Map<string, number>()
            for (const p of filtered) {
              if (['queued', 'drafted', 'sent', 'replied'].includes(p.status)) {
                counts.set(p.status, (counts.get(p.status) ?? 0) + 1)
              }
            }
            return {
              results: [...counts.entries()].map(([status, c]) => ({ status, c })),
              success: true,
            }
          }
          return { results: [], success: true }
        },
        async first() { return null },
      }
      return stmt
    },
    async batch(stmts: unknown[]) {
      return (stmts as Array<unknown>).map(() => ({ success: true, meta: { changes: 0 } }))
    },
  } as unknown as D1Database

  return { db, metricRows: () => metricStore }
}

const NOW = '2026-06-18T10:00:00.000Z'
const TENANT = 'mumega'
let idCounter = 0
function makeId() { return `s2-id-${++idCounter}` }

// ── 1. COMPOSED MANIFEST ──────────────────────────────────────────────────────

describe('1. COMPOSED MANIFEST — getActiveMetricDescriptors includes OutboundChannel metrics', () => {
  it('getActiveMetricDescriptors for growth returns growth.leads, growth.replies, growth.conversion', async () => {
    const reg = createDepartmentRegistry()
    reg.register(GrowthModule)

    const db = makeDeptDb(['growth'])
    const descriptors = await reg.getActiveMetricDescriptors(db)

    const keys = descriptors.map((d) => d.key)
    expect(keys).toContain('growth.leads')
    expect(keys).toContain('growth.replies')
    expect(keys).toContain('growth.conversion')
  })

  it('getActiveMetricDescriptors returns exactly 8 descriptors for growth (S3: 3 outbound + 5 seo)', async () => {
    const reg = createDepartmentRegistry()
    reg.register(GrowthModule)

    const db = makeDeptDb(['growth'])
    const descriptors = await reg.getActiveMetricDescriptors(db)
    // growth.metricsEmitted is [] + OutboundChannel (3) + SeoChannel (5) = 8
    expect(descriptors).toHaveLength(8)
  })

  it('composeDeptMetricDescriptors(GrowthModule.metricsEmitted, GrowthModule.channels) produces 8 descriptors (S3)', () => {
    const composed = composeDeptMetricDescriptors(GrowthModule.metricsEmitted, GrowthModule.channels ?? [])
    // S3: OutboundChannel (3) + SeoChannel (5) = 8
    expect(composed).toHaveLength(8)
    const keys = composed.map((d) => d.key)
    expect(keys).toContain('growth.leads')
    expect(keys).toContain('growth.replies')
    expect(keys).toContain('growth.conversion')
    // SEO metrics also present
    expect(keys).toContain('seo.organic_sessions')
    expect(keys).toContain('seo.indexed_pages')
  })
})

// ── 2. COLLECTOR AUTHORIZATION ────────────────────────────────────────────────

describe('2. COLLECTOR AUTHORIZATION — collector still authorized via composed manifest', () => {
  it('collectGrowthMetrics emits growth.leads, growth.replies, growth.conversion with prospects data', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
    ])

    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(result.emitted).toBe(3) // leads + replies + conversion (sent=1 > 0)

    const keys = metricRows().map((r) => r.metric_key)
    expect(keys).toContain('growth.leads')
    expect(keys).toContain('growth.replies')
    expect(keys).toContain('growth.conversion')
  })

  it('foreign source (not prospects) is still rejected by the composed ctx', async () => {
    const { db } = makeCollectorDb([])
    // kernelMintCtx with GrowthModule — composed set includes OutboundChannel metrics.
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
    })

    // growth.leads IS in the composed set, but 'stripe' is NOT in its sourceAuthority.
    await expect(
      ctx.metrics.emit({ key: 'growth.leads', value: 1, occurredAt: NOW, source: 'stripe' }),
    ).rejects.toThrow(/source_not_authorized|not in sourceAuthority/)
  })

  it('prospects source is authorized for growth.leads via composed manifest', async () => {
    const { db, metricRows } = makeCollectorDb([])
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
      idGen: makeId,
    })

    const result = await ctx.metrics.emit({
      key: 'growth.leads',
      value: 5,
      occurredAt: NOW,
      source: 'prospects',
    })
    expect(result.ok).toBe(true)
    expect(metricRows().find((r) => r.metric_key === 'growth.leads')).toBeDefined()
  })
})

// ── 3. ISOLATION ──────────────────────────────────────────────────────────────

describe('3. ISOLATION — removing OutboundChannel from channels removes funnel metrics', () => {
  it('channels: [] → composeDeptMetricDescriptors produces 0 descriptors (growth own is empty)', () => {
    const composed = composeDeptMetricDescriptors(GrowthModule.metricsEmitted, [])
    // Growth own = [], no channels = 0 total
    expect(composed).toHaveLength(0)
  })

  it('channels: [] → growth.leads is not in the composed set', () => {
    const composed = composeDeptMetricDescriptors(GrowthModule.metricsEmitted, [])
    const keys = composed.map((d) => d.key)
    expect(keys).not.toContain('growth.leads')
    expect(keys).not.toContain('growth.replies')
    expect(keys).not.toContain('growth.conversion')
  })

  it('removing OutboundChannel does not affect a sibling department in an isolated registry', async () => {
    // Register a sibling (FixtureModule) alongside a modified growth (no channels).
    const { FixtureModule } = await import('../src/departments/modules/fixture')
    const reg = createDepartmentRegistry()
    reg.register(FixtureModule)
    // Register a modified growth with channels: [] (no OutboundChannel)
    reg.register({ ...GrowthModule, channels: [] }, { replace: false })

    const db = makeDeptDb(['fixture', 'growth'])
    const descriptors = await reg.getActiveMetricDescriptors(db)
    const keys = descriptors.map((d) => d.key)

    // Fixture's own metrics remain intact
    expect(keys).toContain('fixture.pings')
    expect(keys).toContain('fixture.scalar')
    // Growth's funnel metrics (via OutboundChannel) are gone
    expect(keys).not.toContain('growth.leads')
    expect(keys).not.toContain('growth.replies')
    expect(keys).not.toContain('growth.conversion')
  })
})

// ── 4. FROZEN CHANNELS ────────────────────────────────────────────────────────

describe('4. FROZEN CHANNELS — module.channels is frozen post-registration', () => {
  it('OutboundChannel.metricDescriptors is frozen after deepFreezeChannels', () => {
    // deepFreezeChannels is the explicit freeze utility — test it directly.
    const copy = [{ ...OutboundChannel, metricDescriptors: [...OutboundChannel.metricDescriptors] }]
    deepFreezeChannels(copy)
    expect(Object.isFrozen(copy[0].metricDescriptors)).toBe(true)
  })

  it('registered GrowthModule.channels is frozen (deepFreezeClone in registry covers channels)', () => {
    const reg = createDepartmentRegistry()
    reg.register(GrowthModule)
    const frozen = reg.getRegistered('growth')
    expect(frozen).toBeDefined()
    // The registered clone's channels array is frozen
    expect(Object.isFrozen(frozen?.channels)).toBe(true)
  })

  it('attempting to push to registered module.channels throws (frozen)', () => {
    const reg = createDepartmentRegistry()
    reg.register(GrowthModule)
    const frozen = reg.getRegistered('growth')
    expect(frozen).toBeDefined()

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(frozen!.channels as any).push({ key: 'evil-channel' })
    }).toThrow()
  })

  it('attempting to push to OutboundChannel.metricDescriptors on the registered clone throws', () => {
    const reg = createDepartmentRegistry()
    reg.register(GrowthModule)
    const frozen = reg.getRegistered('growth')
    expect(frozen).toBeDefined()

    const outboundCh = frozen!.channels?.[0]
    expect(outboundCh).toBeDefined()

    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(outboundCh!.metricDescriptors as any).push({ key: 'growth.evil' })
    }).toThrow()
  })
})

// ── 5. DEPT-OWN DUP-KEY REJECTED ─────────────────────────────────────────────

describe('5. DEPT-OWN DUP-KEY — composeDeptMetricDescriptors rejects duplicates within deptOwn', () => {
  it('deptOwn with duplicate key throws ChannelComposeError (duplicate_metric_key)', () => {
    const duplicateDeptOwn = [
      {
        key: 'some.metric',
        unit: 'count',
        direction: 'up_good' as const,
        cadence: 'daily' as const,
        aggregation: 'sum' as const,
        ohlcEligible: false,
        sourceAuthority: ['source-a'],
        retention: '30d',
        display: { precision: 0 },
      },
      {
        key: 'some.metric', // DUPLICATE KEY within deptOwn
        unit: 'count',
        direction: 'up_good' as const,
        cadence: 'daily' as const,
        aggregation: 'sum' as const,
        ohlcEligible: false,
        sourceAuthority: ['source-b'], // different authority — authority-shadow if silently deduped
        retention: '30d',
        display: { precision: 0 },
      },
    ]

    expect(() => {
      composeDeptMetricDescriptors(duplicateDeptOwn, [])
    }).toThrow(ChannelComposeError)
  })

  it('the deptOwn dup-key error has code=duplicate_metric_key and the duplicate key', () => {
    const deptOwn = [
      {
        key: 'dup.key',
        unit: 'count',
        direction: 'neutral' as const,
        cadence: 'daily' as const,
        aggregation: 'sum' as const,
        ohlcEligible: false,
        sourceAuthority: ['s1'],
        retention: '30d',
        display: { precision: 0 },
      },
      {
        key: 'dup.key', // duplicate
        unit: 'count',
        direction: 'neutral' as const,
        cadence: 'daily' as const,
        aggregation: 'sum' as const,
        ohlcEligible: false,
        sourceAuthority: ['s2'],
        retention: '30d',
        display: { precision: 0 },
      },
    ]

    let caught: unknown
    try {
      composeDeptMetricDescriptors(deptOwn, [])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ChannelComposeError)
    const err = caught as ChannelComposeError
    expect(err.code).toBe('duplicate_metric_key')
    expect(err.key).toBe('dup.key')
  })

  it('result is NEVER produced when deptOwn has a dup (fail closed)', () => {
    const deptOwn = [
      { key: 'x', unit: 'count', direction: 'neutral' as const, cadence: 'daily' as const, aggregation: 'sum' as const, ohlcEligible: false, sourceAuthority: ['s'], retention: '30d', display: { precision: 0 } },
      { key: 'x', unit: 'count', direction: 'neutral' as const, cadence: 'daily' as const, aggregation: 'sum' as const, ohlcEligible: false, sourceAuthority: ['s'], retention: '30d', display: { precision: 0 } },
    ]

    let result: unknown = 'not-set'
    try {
      result = composeDeptMetricDescriptors(deptOwn, [])
    } catch {
      // expected
    }
    expect(result).toBe('not-set')
  })
})

// ── 6. KEY-SHADOW GUARD ───────────────────────────────────────────────────────

describe('6. KEY-SHADOW GUARD — channel cannot shadow a deptOwn key', () => {
  it('channel with key already in deptOwn throws ChannelComposeError', () => {
    const deptOwn = [
      { key: 'growth.own', unit: 'count', direction: 'up_good' as const, cadence: 'daily' as const, aggregation: 'sum' as const, ohlcEligible: false, sourceAuthority: ['internal'], retention: '30d', display: { precision: 0 } },
    ]
    const shadowingChannel = {
      ...OutboundChannel,
      key: 'shadow-attempt',
      metricDescriptors: [
        {
          key: 'growth.own', // COLLISION: same as deptOwn key
          unit: 'count',
          direction: 'up_good' as const,
          cadence: 'daily' as const,
          aggregation: 'sum' as const,
          ohlcEligible: false,
          sourceAuthority: ['prospects', 'stripe'], // wider authority
          retention: '30d',
          display: { precision: 0 },
        },
      ],
    }

    expect(() => {
      composeDeptMetricDescriptors(deptOwn, [shadowingChannel])
    }).toThrow(ChannelComposeError)
  })

  it('the shadow error has code=duplicate_metric_key', () => {
    const deptOwn = [
      { key: 'growth.owned-key', unit: 'count', direction: 'up_good' as const, cadence: 'daily' as const, aggregation: 'sum' as const, ohlcEligible: false, sourceAuthority: ['internal'], retention: '30d', display: { precision: 0 } },
    ]
    const shadowCh = {
      ...OutboundChannel,
      metricDescriptors: [
        { key: 'growth.owned-key', unit: 'count', direction: 'up_good' as const, cadence: 'daily' as const, aggregation: 'sum' as const, ohlcEligible: false, sourceAuthority: ['wide'], retention: '30d', display: { precision: 0 } },
      ],
    }

    let caught: unknown
    try {
      composeDeptMetricDescriptors(deptOwn, [shadowCh])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ChannelComposeError)
    expect((caught as ChannelComposeError).code).toBe('duplicate_metric_key')
    expect((caught as ChannelComposeError).key).toBe('growth.owned-key')
  })
})

// ── 7. OUTBOUND CHANNEL STRUCTURE ────────────────────────────────────────────

describe('7. OutboundChannel structure — descriptor is well-formed', () => {
  it('OutboundChannel.key is outbound', () => {
    expect(OutboundChannel.key).toBe('outbound')
  })

  it('OutboundChannel has 3 metricDescriptors', () => {
    expect(OutboundChannel.metricDescriptors).toHaveLength(3)
  })

  it('OutboundChannel metricDescriptor keys are growth.leads, growth.replies, growth.conversion', () => {
    const keys = OutboundChannel.metricDescriptors.map((d) => d.key)
    expect(keys).toContain('growth.leads')
    expect(keys).toContain('growth.replies')
    expect(keys).toContain('growth.conversion')
  })

  it('all OutboundChannel descriptors have sourceAuthority: [prospects]', () => {
    for (const desc of OutboundChannel.metricDescriptors) {
      expect(desc.sourceAuthority).toEqual(['prospects'])
    }
  })

  it('all OutboundChannel descriptors are ohlcEligible=false (daily scalar → bar honest)', () => {
    for (const desc of OutboundChannel.metricDescriptors) {
      expect(desc.ohlcEligible).toBe(false)
    }
  })

  it('growth.conversion has aggregation=last and unit=ratio', () => {
    const conv = OutboundChannel.metricDescriptors.find((d) => d.key === 'growth.conversion')
    expect(conv).toBeDefined()
    expect(conv?.aggregation).toBe('last')
    expect(conv?.unit).toBe('ratio')
  })

  it('OutboundChannel has 1 workType: outreach-send (proposesOnly=true)', () => {
    expect(OutboundChannel.workTypes).toHaveLength(1)
    expect(OutboundChannel.workTypes[0].key).toBe('outreach-send')
    expect(OutboundChannel.workTypes[0].proposesOnly).toBe(true)
  })

  it('OutboundChannel exports NO mint/register/ctx symbols (pure data)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../src/departments/channels/outbound-channel') as Record<string, any>
    expect(mod['mint']).toBeUndefined()
    expect(mod['register']).toBeUndefined()
    expect(mod['kernelMintCtx']).toBeUndefined()
    expect(mod['_KERNEL_TOKEN']).toBeUndefined()
    expect(mod['activate']).toBeUndefined()
    expect(mod['deactivate']).toBeUndefined()
    expect(mod['ctx']).toBeUndefined()
    // Only OutboundChannel (a plain object) should be exported
    expect(typeof mod['OutboundChannel']).toBe('object')
  })
})

// ── 8. CONVERSION-HONESTY INTACT ─────────────────────────────────────────────

describe('8. CONVERSION-HONESTY intact — collector logic unchanged', () => {
  it('reached=0 (queued only) → conversion skipped, not emitted', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'queued' },
      { tenant: TENANT, status: 'queued' },
    ])

    const result = await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(result.emitted).toBe(2) // leads + replies; conversion skipped
    expect(result.skipped).toBe(1)
    expect(metricRows().find((r) => r.metric_key === 'growth.conversion')).toBeUndefined()
    const convOutcome = result.outcomes.find((o) => o.key === 'growth.conversion')
    expect(convOutcome?.outcome).toBe('skipped')
    expect(convOutcome?.detail).toMatch(/reached=0/)
  })

  it('replied/(sent+replied) bounded in [0,1] — collector unchanged', async () => {
    // sent=0, replied=3 → reached=3, conversion=1.0 (NOT skipped, NOT >1)
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'replied' },
      { tenant: TENANT, status: 'replied' },
      { tenant: TENANT, status: 'replied' },
    ])

    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(row?.value).toBeCloseTo(1.0, 5)
    expect(row?.value ?? 2).toBeLessThanOrEqual(1.0)
  })

  it('sent=2, replied=1 → reached=3, conversion≈0.333 (not 0.5 from old broken formula)', async () => {
    const { db, metricRows } = makeCollectorDb([
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'sent' },
      { tenant: TENANT, status: 'replied' },
    ])

    await collectGrowthMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const row = metricRows().find((r) => r.metric_key === 'growth.conversion')
    expect(row?.value).toBeCloseTo(1 / 3, 5)
  })
})
