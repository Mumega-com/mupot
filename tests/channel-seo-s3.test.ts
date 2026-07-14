// tests/channel-seo-s3.test.ts — S3 SEO channel conformance + collector harness.
//
// PURPOSE: prove the S3 invariants from docs/architecture/marketing-channels.md §7:
//
//   1. SeoChannel structure — descriptor is well-formed.
//   2. configSchema Zod validation — SeoChannelConfigSchema accepts/rejects correctly.
//   3. configSchema deep-frozen after deepFreezeChannels — S3 TODO CLOSED.
//   4. SeoChannel composes into the Growth dept — 3 (outbound) + 5 (seo) = 8 total.
//   5. Foreign source rejected — 'first-party' is in seo.* sourceAuthority; 'evil' is not.
//   6. Key-shadow guard — SeoChannel key collides with sibling → ChannelComposeError.
//   7. Collector: first-party empty state + gated proposal.
//   8. S3 invariant: propose-not-mutate-without-Gate — emitted=0 when no first-party data.
//   9. Regression: outbound + seo channels both in GrowthModule, no collisions.

import { describe, it, expect } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

// ── Channel + compose imports ─────────────────────────────────────────────────

import { SeoChannel, SeoChannelConfigSchema } from '../src/departments/channels/seo-channel'
import { OutboundChannel } from '../src/departments/channels/outbound-channel'
import {
  deepFreezeChannels,
  composeDeptMetricDescriptors,
  getChannelWorkTypes,
  ChannelComposeError,
} from '../src/departments/channels/compose'
import type { ChannelDescriptor } from '../src/departments/channels/contract'

// ── Dept + registry imports ───────────────────────────────────────────────────

import { GrowthModule } from '../src/departments/modules/growth'
import {
  kernelMintCtx,
  createDepartmentRegistry,
} from '../src/departments/registry'

// ── Collector imports ─────────────────────────────────────────────────────────

import {
  collectSeoMetrics,
  readSeoFirstPartySignals,
} from '../src/departments/collectors/seo-collector'

// ── In-memory DB helpers ──────────────────────────────────────────────────────

interface MetricRow {
  id: string
  tenant_id: string
  metric_key: string
  value: number
  occurred_at: string
  source: string
  created_at: string
}

// A metric DB that supports INSERT into metric_points and SELECT from metric_points
// (both the seo.% query in readSeoFirstPartySignals and the pulse-write path).
function makeSeoDb(
  existingRows: Array<{ tenant_id: string; metric_key: string; value: number; occurred_at: string; source: string }> = [],
): { db: D1Database; metricRows: () => MetricRow[] } {
  const store: MetricRow[] = existingRows.map((r, i) => ({
    id: `existing-${i}`,
    tenant_id: r.tenant_id,
    metric_key: r.metric_key,
    value: r.value,
    occurred_at: r.occurred_at,
    source: r.source,
    created_at: r.occurred_at,
  }))

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
          if (upper.includes('FROM METRIC_POINTS') && upper.includes("LIKE 'SEO.%'")) {
            const [tenantId] = boundArgs as [string]
            const rows = store.filter(
              (r) => r.tenant_id === tenantId && r.metric_key.startsWith('seo.'),
            )
            return { results: rows, success: true }
          }
          // getActive() query (departments table) — return empty for SEO collector tests
          if (upper.includes('FROM DEPARTMENTS')) {
            return { results: [], success: true }
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

  return { db, metricRows: () => store }
}

const NOW = '2026-06-18T10:00:00.000Z'
const TENANT = 'mumega'
let idCounter = 0
function makeId() { return `s3-id-${++idCounter}` }

// ── 1. SeoChannel structure ───────────────────────────────────────────────────

describe('1. SeoChannel structure — descriptor is well-formed', () => {
  it('key is seo', () => {
    expect(SeoChannel.key).toBe('seo')
  })

  it('name is SEO & Content', () => {
    expect(SeoChannel.name).toBe('SEO & Content')
  })

  it('has exactly 5 metricDescriptors', () => {
    expect(SeoChannel.metricDescriptors).toHaveLength(5)
  })

  it('metricDescriptor keys are the 5 expected seo.* keys', () => {
    const keys = SeoChannel.metricDescriptors.map((d) => d.key)
    expect(keys).toContain('seo.organic_sessions')
    expect(keys).toContain('seo.conversion_rate')
    expect(keys).toContain('seo.indexed_pages')
    expect(keys).toContain('seo.issues_open')
    expect(keys).toContain('seo.ai_citations')
  })

  it('all descriptors have cadence=daily and ohlcEligible=false', () => {
    for (const desc of SeoChannel.metricDescriptors) {
      expect(desc.cadence).toBe('daily')
      expect(desc.ohlcEligible).toBe(false)
    }
  })

  it('seo.issues_open has direction=down_good (fewer open issues = better)', () => {
    const desc = SeoChannel.metricDescriptors.find((d) => d.key === 'seo.issues_open')
    expect(desc).toBeDefined()
    expect(desc?.direction).toBe('down_good')
  })

  it('seo.conversion_rate has aggregation=last and unit=ratio', () => {
    const desc = SeoChannel.metricDescriptors.find((d) => d.key === 'seo.conversion_rate')
    expect(desc).toBeDefined()
    expect(desc?.aggregation).toBe('last')
    expect(desc?.unit).toBe('ratio')
  })

  it('seo.ai_citations has sourceAuthority: [first-party] only', () => {
    const desc = SeoChannel.metricDescriptors.find((d) => d.key === 'seo.ai_citations')
    expect(desc).toBeDefined()
    expect(desc?.sourceAuthority).toEqual(['first-party'])
  })

  it('has exactly 4 proposesOnly=true workTypes (S3 original; S4 adds 2 more executable)', () => {
    // S3 shipped 4 proposesOnly=true work-types. S4 adds seo-meta-fix + seo-internal-links
    // (proposesOnly=false). Total is now 6; this test checks the S3 subset.
    const proposesOnlyTypes = SeoChannel.workTypes.filter((w) => w.proposesOnly)
    expect(proposesOnlyTypes).toHaveLength(4)
    for (const wt of proposesOnlyTypes) {
      expect(wt.proposesOnly).toBe(true)
    }
  })

  it('workType keys are the 4 expected seo work-types', () => {
    const keys = SeoChannel.workTypes.map((w) => w.key)
    expect(keys).toContain('seo-audit-proposal')
    expect(keys).toContain('keyword-gap-proposal')
    expect(keys).toContain('comparison-page-proposal')
    expect(keys).toContain('content-refresh-proposal')
  })

  it('has 2 connectorRefs (posthog + gsc), both required=false', () => {
    expect(SeoChannel.connectorRefs).toHaveLength(2)
    for (const ref of SeoChannel.connectorRefs) {
      expect(ref.required).toBe(false)
    }
    const keys = SeoChannel.connectorRefs.map((r) => r.key)
    expect(keys).toContain('posthog')
    expect(keys).toContain('gsc')
  })

  it('renderHints.panelTitle is SEO & Content with order=2', () => {
    expect(SeoChannel.renderHints).toBeDefined()
    expect(SeoChannel.renderHints?.panelTitle).toBe('SEO & Content')
    expect(SeoChannel.renderHints?.order).toBe(2)
  })

  it('configSchema is defined and is a plain object (not undefined, null, or a string)', () => {
    expect(SeoChannel.configSchema).toBeDefined()
    expect(SeoChannel.configSchema).not.toBeNull()
    expect(typeof SeoChannel.configSchema).toBe('object')
    expect(typeof SeoChannel.configSchema).not.toBe('string')
    expect(typeof SeoChannel.configSchema).not.toBe('function')
  })

  it('top-level sourceAuthority includes first-party, posthog, and gsc', () => {
    expect(SeoChannel.sourceAuthority).toContain('first-party')
    expect(SeoChannel.sourceAuthority).toContain('posthog')
    expect(SeoChannel.sourceAuthority).toContain('gsc')
  })
})

// ── 2. configSchema Zod validation ───────────────────────────────────────────

describe('2. configSchema Zod validation — SeoChannelConfigSchema accepts/rejects correctly', () => {
  it('valid config parses successfully', () => {
    const valid = {
      domain: 'mumega.com',
      keywordClusters: ['agent platform', 'sovereign pot'],
      competitors: ['dust.tt'],
      executor: 'inkwell-content' as const,
    }
    const result = SeoChannelConfigSchema.safeParse(valid)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.domain).toBe('mumega.com')
      expect(result.data.executor).toBe('inkwell-content')
    }
  })

  it('valid config with executor=mcpwp parses successfully', () => {
    const result = SeoChannelConfigSchema.safeParse({
      domain: 'digid.ca',
      keywordClusters: [],
      competitors: [],
      executor: 'mcpwp',
    })
    expect(result.success).toBe(true)
  })

  it('missing domain → validation fails', () => {
    const result = SeoChannelConfigSchema.safeParse({
      keywordClusters: [],
      competitors: [],
      executor: 'inkwell-content',
    })
    expect(result.success).toBe(false)
  })

  it('empty domain string → fails (min(1))', () => {
    const result = SeoChannelConfigSchema.safeParse({
      domain: '',
      keywordClusters: [],
      competitors: [],
      executor: 'inkwell-content',
    })
    expect(result.success).toBe(false)
  })

  it('invalid executor value → validation fails', () => {
    const result = SeoChannelConfigSchema.safeParse({
      domain: 'mumega.com',
      keywordClusters: [],
      competitors: [],
      executor: 'wordpress-direct', // not in enum
    })
    expect(result.success).toBe(false)
  })

  it('missing executor → validation fails', () => {
    const result = SeoChannelConfigSchema.safeParse({
      domain: 'mumega.com',
      keywordClusters: [],
      competitors: [],
    })
    expect(result.success).toBe(false)
  })

  it('SeoChannelConfigSchema.parse() throws on invalid input', () => {
    expect(() => {
      SeoChannelConfigSchema.parse({ domain: '', executor: 'inkwell-content', keywordClusters: [], competitors: [] })
    }).toThrow()
  })

  it('keywordClusters and competitors can be empty arrays', () => {
    const result = SeoChannelConfigSchema.safeParse({
      domain: 'test.com',
      keywordClusters: [],
      competitors: [],
      executor: 'mcpwp',
    })
    expect(result.success).toBe(true)
  })
})

// ── 3. configSchema deep-frozen after deepFreezeChannels ─────────────────────

describe('3. configSchema deep-frozen after deepFreezeChannels — S3 TODO CLOSED', () => {
  it('configSchema is frozen after deepFreezeChannels', () => {
    const copy: ChannelDescriptor = { ...SeoChannel }
    deepFreezeChannels([copy])
    expect(Object.isFrozen(copy.configSchema)).toBe(true)
  })

  it('attempting to mutate configSchema.shape post-freeze throws in strict mode', () => {
    const copy: ChannelDescriptor = { ...SeoChannel }
    deepFreezeChannels([copy])
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(copy.configSchema as any).shape = {}
    }).toThrow()
  })

  it('descriptor itself is frozen after deepFreezeChannels', () => {
    const copy: ChannelDescriptor = { ...SeoChannel, metricDescriptors: [...SeoChannel.metricDescriptors] }
    deepFreezeChannels([copy])
    expect(Object.isFrozen(copy)).toBe(true)
  })

  it('a channel without configSchema is still frozen correctly (configSchema undefined)', () => {
    const noConfig: ChannelDescriptor = {
      key: 'no-config-channel',
      name: 'No Config',
      metricDescriptors: [],
      sourceAuthority: ['test'],
      connectorRefs: [],
      workTypes: [],
      // configSchema is undefined (omitted)
    }
    // Should not throw
    expect(() => deepFreezeChannels([noConfig])).not.toThrow()
    expect(Object.isFrozen(noConfig)).toBe(true)
  })

  it('WARN-1 fix: configSchema.shape getter result is frozen post-deepFreezeChannels (nested freeze)', () => {
    // WARN-1 (Opus + Codex gate): Object.freeze(configSchema) is top-level only.
    // Zod v4 exposes .shape as a getter whose return value is a mutable object.
    // deepFreezeChannels must also freeze the .shape result so nested field
    // descriptors cannot be mutated post-registration.
    const copy: ChannelDescriptor = { ...SeoChannel }
    deepFreezeChannels([copy])

    const schemaWithShape = copy.configSchema as Record<string, unknown>
    expect(typeof schemaWithShape['shape']).toBe('object')
    expect(Object.isFrozen(schemaWithShape['shape'])).toBe(true)
  })

  it('WARN-1 fix: attempting to mutate configSchema.shape.domain post-freeze throws in strict mode', () => {
    // The .shape object (Zod field map) must be frozen so a caller cannot
    // inject a new field or replace an existing one post-registration.
    const copy: ChannelDescriptor = { ...SeoChannel }
    deepFreezeChannels([copy])

    const schemaWithShape = copy.configSchema as Record<string, Record<string, unknown>>
    expect(() => {
      schemaWithShape['shape']['domain'] = 'REPLACED'
    }).toThrow() // TypeError: Cannot assign to read only property in strict mode
  })

  it('WARN-1 fix: .parse() still works after deep-freeze of configSchema and its .shape', () => {
    // Regression: freezing configSchema and configSchema.shape must not break
    // SeoChannelConfigSchema.parse() — the Zod parse path reads own properties
    // of the frozen shape but never adds to it.
    const copy: ChannelDescriptor = { ...SeoChannel }
    deepFreezeChannels([copy])

    // Import the original schema and verify parse still functions.
    // The schema stored on the channel IS SeoChannelConfigSchema — cast and test.
    const frozenSchema = copy.configSchema as { safeParse: (v: unknown) => { success: boolean } }
    expect(typeof frozenSchema.safeParse).toBe('function')
    const result = frozenSchema.safeParse({
      domain: 'mumega.com',
      keywordClusters: ['agent'],
      competitors: [],
      executor: 'inkwell-content',
    })
    expect(result.success).toBe(true)
  })

  it('WARN-1 fix: configSchema.shape is also frozen on GrowthModule registration path', () => {
    // Prove the registry deepFreezeClone path (which calls deepFreezeChannels)
    // also freezes configSchema.shape on SeoChannel.
    // We verify by reading the registered frozen module from the registry instance
    // already imported at the top of this file.
    const reg = createDepartmentRegistry()
    reg.register(GrowthModule)
    const frozen = reg.getRegistered('growth')
    const seoChannel = frozen?.channels?.find((c: { key: string }) => c.key === 'seo')
    expect(seoChannel).toBeDefined()
    expect(Object.isFrozen(seoChannel?.configSchema)).toBe(true)
    const schemaShape = (seoChannel?.configSchema as Record<string, unknown>)?.['shape']
    expect(typeof schemaShape).toBe('object')
    expect(Object.isFrozen(schemaShape)).toBe(true)
  })
})

// ── 4. SeoChannel composes into the Growth dept ───────────────────────────────

describe('4. SeoChannel composes into GrowthModule — 3 outbound + 5 seo = 8 total', () => {
  it('composeDeptMetricDescriptors(GrowthModule) produces 8 total descriptors', () => {
    const composed = composeDeptMetricDescriptors(GrowthModule.metricsEmitted, GrowthModule.channels ?? [])
    // growth own: 0, outbound: 3, seo: 5 → 8
    expect(composed).toHaveLength(8)
  })

  it('composed set includes all 5 seo.* keys', () => {
    const composed = composeDeptMetricDescriptors(GrowthModule.metricsEmitted, GrowthModule.channels ?? [])
    const keys = composed.map((d) => d.key)
    expect(keys).toContain('seo.organic_sessions')
    expect(keys).toContain('seo.conversion_rate')
    expect(keys).toContain('seo.indexed_pages')
    expect(keys).toContain('seo.issues_open')
    expect(keys).toContain('seo.ai_citations')
  })

  it('composed set includes all 3 outbound keys', () => {
    const composed = composeDeptMetricDescriptors(GrowthModule.metricsEmitted, GrowthModule.channels ?? [])
    const keys = composed.map((d) => d.key)
    expect(keys).toContain('growth.leads')
    expect(keys).toContain('growth.replies')
    expect(keys).toContain('growth.conversion')
  })

  it('getChannelWorkTypes(GrowthModule.channels) includes all 4 seo work-type keys', () => {
    const wts = getChannelWorkTypes(GrowthModule.channels ?? [])
    const keys = wts.map((w) => w.key)
    expect(keys).toContain('seo-audit-proposal')
    expect(keys).toContain('keyword-gap-proposal')
    expect(keys).toContain('comparison-page-proposal')
    expect(keys).toContain('content-refresh-proposal')
  })

  it('getChannelWorkTypes includes outbound work-type key too', () => {
    const wts = getChannelWorkTypes(GrowthModule.channels ?? [])
    const keys = wts.map((w) => w.key)
    expect(keys).toContain('outreach-send')
  })

  it('no duplicate metric keys across outbound + seo channels', () => {
    // If there were duplicates, composeDeptMetricDescriptors would throw.
    expect(() => {
      composeDeptMetricDescriptors(GrowthModule.metricsEmitted, GrowthModule.channels ?? [])
    }).not.toThrow()
  })

  it('no duplicate work-type keys across outbound + seo channels', () => {
    expect(() => {
      getChannelWorkTypes(GrowthModule.channels ?? [])
    }).not.toThrow()
  })

  it('GrowthModule.channels has 3 channels (OutboundChannel + SeoChannel + WordpressChannel, #370)', () => {
    expect(GrowthModule.channels).toHaveLength(3)
    const channelKeys = GrowthModule.channels?.map((c) => c.key) ?? []
    expect(channelKeys).toContain('outbound')
    expect(channelKeys).toContain('seo')
    expect(channelKeys).toContain('wordpress')
  })
})

// ── 5. Foreign source rejected ────────────────────────────────────────────────

describe('5. Foreign source rejected — first-party authorized, evil rejected', () => {
  it('emitting seo.organic_sessions from evil-source throws source_not_authorized', async () => {
    const { db } = makeSeoDb()
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
      idGen: makeId,
    })

    await expect(
      ctx.metrics.emit({
        key: 'seo.organic_sessions',
        value: 100,
        occurredAt: NOW,
        source: 'evil-source',
      }),
    ).rejects.toThrow(/source_not_authorized|not in sourceAuthority/)
  })

  it('emitting seo.organic_sessions from first-party source succeeds', async () => {
    const { db } = makeSeoDb()
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
      idGen: makeId,
    })

    const result = await ctx.metrics.emit({
      key: 'seo.organic_sessions',
      value: 42,
      occurredAt: NOW,
      source: 'first-party',
    })
    expect(result.ok).toBe(true)
  })

  it('emitting seo.indexed_pages from gsc source succeeds (gsc is in sourceAuthority)', async () => {
    const { db } = makeSeoDb()
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
      idGen: makeId,
    })

    const result = await ctx.metrics.emit({
      key: 'seo.indexed_pages',
      value: 99,
      occurredAt: NOW,
      source: 'gsc',
    })
    expect(result.ok).toBe(true)
  })

  it('emitting seo.ai_citations from posthog throws (posthog not in ai_citations sourceAuthority)', async () => {
    const { db } = makeSeoDb()
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
      idGen: makeId,
    })

    // seo.ai_citations sourceAuthority is ['first-party'] only — posthog is NOT in it.
    await expect(
      ctx.metrics.emit({
        key: 'seo.ai_citations',
        value: 5,
        occurredAt: NOW,
        source: 'posthog',
      }),
    ).rejects.toThrow(/source_not_authorized|not in sourceAuthority/)
  })
})

// ── 6. Key-shadow guard ───────────────────────────────────────────────────────

describe('6. Key-shadow guard — SeoChannel key collides with a sibling → ChannelComposeError', () => {
  it('a channel declaring seo.organic_sessions alongside SeoChannel throws ChannelComposeError', () => {
    const shadowingChannel: ChannelDescriptor = {
      key: 'evil-seo-shadow',
      name: 'Evil Shadow',
      metricDescriptors: [
        {
          key: 'seo.organic_sessions', // COLLISION with SeoChannel
          unit: 'count',
          direction: 'up_good',
          cadence: 'daily',
          aggregation: 'sum',
          ohlcEligible: false,
          sourceAuthority: ['attacker-source'],
          retention: '90d',
          display: { precision: 0 },
        },
      ],
      sourceAuthority: ['attacker-source'],
      connectorRefs: [],
      workTypes: [],
    }

    expect(() => {
      composeDeptMetricDescriptors(GrowthModule.metricsEmitted, [
        ...GrowthModule.channels ?? [],
        shadowingChannel,
      ])
    }).toThrow(ChannelComposeError)
  })

  it('the error code is duplicate_metric_key with the colliding key', () => {
    const shadowingChannel: ChannelDescriptor = {
      key: 'shadow-ch',
      name: 'Shadow',
      metricDescriptors: [
        {
          key: 'seo.indexed_pages', // COLLISION with SeoChannel
          unit: 'count',
          direction: 'up_good',
          cadence: 'daily',
          aggregation: 'last',
          ohlcEligible: false,
          sourceAuthority: ['evil'],
          retention: '90d',
          display: { precision: 0 },
        },
      ],
      sourceAuthority: ['evil'],
      connectorRefs: [],
      workTypes: [],
    }

    let caught: unknown
    try {
      composeDeptMetricDescriptors(GrowthModule.metricsEmitted, [SeoChannel, shadowingChannel])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ChannelComposeError)
    expect((caught as ChannelComposeError).code).toBe('duplicate_metric_key')
    expect((caught as ChannelComposeError).key).toBe('seo.indexed_pages')
  })

  it('a channel declaring a seo work-type key alongside SeoChannel throws ChannelComposeError', () => {
    const shadowingWtChannel: ChannelDescriptor = {
      key: 'shadow-wt-ch',
      name: 'Shadow WT',
      metricDescriptors: [],
      sourceAuthority: [],
      connectorRefs: [],
      workTypes: [
        {
          key: 'seo-audit-proposal', // COLLISION with SeoChannel workType
          name: 'Evil Audit',
          proposesOnly: true,
        },
      ],
    }

    expect(() => {
      getChannelWorkTypes([SeoChannel, shadowingWtChannel])
    }).toThrow(ChannelComposeError)
  })
})

// ── 7. Collector: first-party signals + gated proposal ───────────────────────

describe('7. Collector: first-party + gated proposal', () => {
  it('zero seo metric_points rows → emitted=0, firstParty=empty, 1 audit proposal', async () => {
    const { db } = makeSeoDb() // no pre-existing rows

    const result = await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })

    expect(result.emitted).toBe(0)
    expect(result.sources.firstParty).toBe('empty')
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].workType).toBe('seo-audit-proposal')
  })

  it('audit proposal gateId is present in result', async () => {
    const { db } = makeSeoDb()
    const result = await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(result.proposals[0].gateId).toBeDefined()
    expect(typeof result.proposals[0].gateId).toBe('string')
    expect(result.proposals[0].gateId.length).toBeGreaterThan(0)
  })

  it('posthog and gsc sources are both { connected: false } in S3', async () => {
    const { db } = makeSeoDb()
    const result = await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(result.sources.posthog.connected).toBe(false)
    expect(result.sources.gsc.connected).toBe(false)
  })

  it('posthog and gsc report connector_not_configured reason in S3', async () => {
    const { db } = makeSeoDb()
    const result = await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(result.sources.posthog.reason).toBe('connector_not_configured')
    expect(result.sources.gsc.reason).toBe('connector_not_configured')
  })

  it('5 outcomes are recorded, all skipped when no first-party data', async () => {
    const { db } = makeSeoDb()
    const result = await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const skippedOutcomes = result.outcomes.filter((o) => o.outcome === 'skipped')
    expect(skippedOutcomes).toHaveLength(5)
    const skippedKeys = skippedOutcomes.map((o) => o.key)
    expect(skippedKeys).toContain('seo.organic_sessions')
    expect(skippedKeys).toContain('seo.conversion_rate')
    expect(skippedKeys).toContain('seo.indexed_pages')
    expect(skippedKeys).toContain('seo.issues_open')
    expect(skippedKeys).toContain('seo.ai_citations')
  })

  it('proposal outcome is recorded in outcomes', async () => {
    const { db } = makeSeoDb()
    const result = await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })
    const proposedOutcome = result.outcomes.find((o) => o.outcome === 'proposed')
    expect(proposedOutcome).toBeDefined()
    expect(proposedOutcome?.key).toBe('seo-audit-proposal')
    expect(proposedOutcome?.detail).toMatch(/gateId=/)
  })

  it('when seo.* rows exist → firstParty=available, skipped=5 (no re-emit in S3)', async () => {
    const { db } = makeSeoDb([
      { tenant_id: TENANT, metric_key: 'seo.organic_sessions', value: 100, occurred_at: '2026-06-17T10:00:00.000Z', source: 'first-party' },
    ])

    const result = await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })

    expect(result.sources.firstParty).toBe('available')
    // Still skipped because no NEW data from live connector (S3 — no re-emit)
    expect(result.emitted).toBe(0)
    expect(result.skipped).toBe(5)
    // Still proposes (periodic audit when data exists)
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].workType).toBe('seo-audit-proposal')
  })
})

// ── 8. S3 invariant: no fabrication, proposals are proposesOnly work-types ────

describe('8. S3 invariant — propose-not-mutate-without-Gate', () => {
  it('emitted=0 when no first-party data (no fabricated zeros)', async () => {
    const { db } = makeSeoDb()
    const result = await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })
    expect(result.emitted).toBe(0)
  })

  it('all proposals use a proposesOnly=true work-type from SeoChannel', async () => {
    const { db } = makeSeoDb()
    const result = await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })

    const proposesOnlyKeys = new Set(
      SeoChannel.workTypes.filter((w) => w.proposesOnly).map((w) => w.key),
    )
    for (const proposal of result.proposals) {
      expect(proposesOnlyKeys.has(proposal.workType)).toBe(true)
    }
  })

  it('readSeoFirstPartySignals returns hasData=false when no seo.* rows', async () => {
    const { db } = makeSeoDb()
    const signals = await readSeoFirstPartySignals(db, TENANT)
    expect(signals.hasData).toBe(false)
    expect(signals.rowCount).toBe(0)
  })

  it('readSeoFirstPartySignals returns hasData=true when seo.* rows exist', async () => {
    const { db } = makeSeoDb([
      { tenant_id: TENANT, metric_key: 'seo.indexed_pages', value: 50, occurred_at: '2026-06-17T10:00:00.000Z', source: 'gsc' },
      { tenant_id: TENANT, metric_key: 'seo.issues_open', value: 3, occurred_at: '2026-06-17T10:00:00.000Z', source: 'gsc' },
    ])
    const signals = await readSeoFirstPartySignals(db, TENANT)
    expect(signals.hasData).toBe(true)
    expect(signals.rowCount).toBe(2)
  })

  it('readSeoFirstPartySignals does not return rows from a different tenant', async () => {
    const { db } = makeSeoDb([
      { tenant_id: 'other-tenant', metric_key: 'seo.indexed_pages', value: 50, occurred_at: '2026-06-17T10:00:00.000Z', source: 'gsc' },
    ])
    const signals = await readSeoFirstPartySignals(db, TENANT)
    expect(signals.hasData).toBe(false)
    expect(signals.rowCount).toBe(0)
  })

  it('collector does not write metric_points rows when no first-party data (no fabrication)', async () => {
    const { db, metricRows } = makeSeoDb()
    await collectSeoMetrics({ db }, TENANT, NOW, { idGen: makeId })
    // The metric store should only have rows if something was emitted.
    // With no first-party data, emitted=0, so no seo.* rows should be written.
    const seoRows = metricRows().filter((r) => r.metric_key.startsWith('seo.'))
    expect(seoRows).toHaveLength(0)
  })
})

// ── 9. Regression: outbound + seo in GrowthModule — existing tests remain green ─

describe('9. Regression: GrowthModule with SeoChannel — outbound keys intact, no collisions', () => {
  it('GrowthModule registers and provides 8 descriptors (0 own + 3 outbound + 5 seo)', async () => {
    const reg = createDepartmentRegistry()
    reg.register(GrowthModule)

    const db = makeSeoDb().db
    // We need a departments table in this db for getActive. Since makeSeoDb
    // returns empty for departments, getActiveMetricDescriptors will include 0
    // active depts, so we check composeDeptMetricDescriptors directly instead.
    const composed = composeDeptMetricDescriptors(
      GrowthModule.metricsEmitted,
      GrowthModule.channels ?? [],
    )
    expect(composed).toHaveLength(8)
  })

  it('all outbound keys still present in composed GrowthModule', () => {
    const composed = composeDeptMetricDescriptors(GrowthModule.metricsEmitted, GrowthModule.channels ?? [])
    const keys = composed.map((d) => d.key)
    expect(keys).toContain('growth.leads')
    expect(keys).toContain('growth.replies')
    expect(keys).toContain('growth.conversion')
  })

  it('all seo keys present in composed GrowthModule', () => {
    const composed = composeDeptMetricDescriptors(GrowthModule.metricsEmitted, GrowthModule.channels ?? [])
    const keys = composed.map((d) => d.key)
    expect(keys).toContain('seo.organic_sessions')
    expect(keys).toContain('seo.conversion_rate')
    expect(keys).toContain('seo.indexed_pages')
    expect(keys).toContain('seo.issues_open')
    expect(keys).toContain('seo.ai_citations')
  })

  it('no duplicate keys across the full composed set', () => {
    const composed = composeDeptMetricDescriptors(GrowthModule.metricsEmitted, GrowthModule.channels ?? [])
    const keys = composed.map((d) => d.key)
    const uniqueKeys = new Set(keys)
    expect(uniqueKeys.size).toBe(keys.length)
  })

  it('8 work-types total (1 outbound + 6 seo + 1 wordpress), no duplicates', () => {
    // S3: 1 outbound + 4 seo = 5. S4 adds 2 executable seo work-types → 7 total.
    // #370: WordpressChannel adds 1 executable work-type (content-publish) → 8 total.
    const wts = getChannelWorkTypes(GrowthModule.channels ?? [])
    expect(wts).toHaveLength(8)
    const keys = wts.map((w) => w.key)
    const uniqueKeys = new Set(keys)
    expect(uniqueKeys.size).toBe(8)
  })

  it('registered GrowthModule channels are frozen (deepFreezeClone covers channels)', () => {
    const reg = createDepartmentRegistry()
    reg.register(GrowthModule)
    const frozen = reg.getRegistered('growth')
    expect(frozen).toBeDefined()
    expect(Object.isFrozen(frozen?.channels)).toBe(true)
    // SeoChannel is now channels[1]
    const seoCh = frozen?.channels?.[1]
    expect(seoCh?.key).toBe('seo')
    expect(Object.isFrozen(seoCh)).toBe(true)
    expect(Object.isFrozen(seoCh?.configSchema)).toBe(true)
  })

  it('OutboundChannel export surface is unchanged — no mint/register/ctx symbols', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../src/departments/channels/outbound-channel') as Record<string, any>
    expect(mod['mint']).toBeUndefined()
    expect(mod['register']).toBeUndefined()
    expect(mod['kernelMintCtx']).toBeUndefined()
    expect(typeof mod['OutboundChannel']).toBe('object')
  })

  it('SeoChannel export surface has no mint/register/ctx symbols', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../src/departments/channels/seo-channel') as Record<string, any>
    expect(mod['mint']).toBeUndefined()
    expect(mod['register']).toBeUndefined()
    expect(mod['kernelMintCtx']).toBeUndefined()
    expect(mod['activate']).toBeUndefined()
    expect(mod['deactivate']).toBeUndefined()
    expect(mod['ctx']).toBeUndefined()
    // SeoChannel (descriptor) and SeoChannelConfigSchema (Zod schema) should be exported
    expect(typeof mod['SeoChannel']).toBe('object')
    expect(typeof mod['SeoChannelConfigSchema']).toBe('object')
  })
})
