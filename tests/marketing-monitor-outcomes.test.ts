import { describe, expect, it } from 'vitest'
import { createMarketingMonitorFixtureSource } from './fixtures/marketing-monitor'
import { deriveMarketingOutcomes, deriveContentChannelSignals, deriveSeoChannelSignals, keywordGapQueryOutcome } from '../src/addons/marketing/outcomes'
import { collectMarketingSnapshots } from '../src/addons/marketing/sources'
import type {
  MarketingMonitorSource,
  MarketingSnapshotCollection,
  MonitorObservation,
  MonitorWindow,
  ResolvedAddonBinding,
} from '../src/addons/marketing/types'
import type { Env } from '../src/types'

const env = { TENANT_SLUG: 'tenant-a' } as Env
const window: MonitorWindow = {
  start: '2026-07-16T00:00:00.000Z',
  end: '2026-07-16T23:59:59.999Z',
}
const firstPartyBinding: ResolvedAddonBinding = {
  id: 'binding-web-analytics',
  slot: 'web_analytics',
  adapter: 'first_party',
  bindingKind: 'internal_adapter',
  capability: 'read',
  connectorId: null,
}
const ghlBinding: ResolvedAddonBinding = {
  id: 'binding-crm',
  slot: 'crm',
  adapter: 'ghl',
  bindingKind: 'vault_connector',
  capability: 'read',
  connectorId: 'connector-ghl',
}

const envWithGhlConnector = {
  ...env,
  DB: {
    prepare() {
      let values: unknown[] = []
      const statement = {
        bind(...bound: unknown[]) {
          values = bound
          return statement
        },
        async first() {
          if (values[0] !== 'connector-ghl' || values[1] !== 'tenant-a') return null
          return {
            id: 'connector-ghl',
            type: 'ghl',
            label: 'Safe GHL fixture',
            meta: null,
            scope_type: 'pot',
            scope_id: null,
            created_at: '2026-07-16T00:00:00.000Z',
          }
        },
      }
      return statement
    },
  } as Env['DB'],
} as Env

function observation(overrides: Partial<MonitorObservation> = {}): MonitorObservation {
  return {
    id: 'evidence-visibility',
    runId: 'run-1',
    metricKey: 'seo.ai_citations',
    value: 1,
    unit: 'count',
    authority: 'first-party',
    observedAt: '2026-07-16T12:00:00.000Z',
    ...overrides,
  }
}

async function collectObservations(
  observations: readonly MonitorObservation[],
  binding: ResolvedAddonBinding = firstPartyBinding,
): Promise<MarketingSnapshotCollection> {
  const source: MarketingMonitorSource = {
    key: 'outcome-source',
    slot: binding.slot,
    async read() {
      return { status: 'available', observations }
    },
  }
  return collectMarketingSnapshots(
    binding.bindingKind === 'vault_connector' ? envWithGhlConnector : env,
    [binding],
    window,
    [source],
  )
}

async function fixtureCollection(): Promise<MarketingSnapshotCollection> {
  const source = createMarketingMonitorFixtureSource({
    runId: 'run-1',
    observedAt: '2026-07-16T12:00:00.000Z',
    window,
  })
  return collectMarketingSnapshots(env, [firstPartyBinding], window, [source])
}

describe('deriveMarketingOutcomes', () => {
  it('maps the five fixture metrics to available outcomes without fabricating revenue', async () => {
    const outcomes = deriveMarketingOutcomes(await fixtureCollection())

    expect(outcomes.visibility).toMatchObject({ status: 'available', value: 8, unit: 'count', source: 'first-party' })
    expect(outcomes.qualifiedTraffic).toMatchObject({ status: 'available', value: 240, unit: 'count', source: 'first-party' })
    expect(outcomes.leads).toMatchObject({ status: 'available', value: 12, unit: 'count', source: 'first-party' })
    expect(outcomes.conversion).toMatchObject({ status: 'available', value: 0.05, unit: 'ratio', source: 'first-party' })
    expect(outcomes.revenue).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
    expect(outcomes.content).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
  })

  it('does not render missing revenue as zero', async () => {
    const outcomes = deriveMarketingOutcomes(await collectObservations([]))

    expect(outcomes.revenue).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
    expect(outcomes.revenue).not.toMatchObject({ value: 0 })
    expect(outcomes.visibility).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
  })

  it('does not mutate or convert an absent authoritative metric to zero', async () => {
    const observations = [observation({ value: 0 })]
    Object.freeze(observations)

    const outcomes = deriveMarketingOutcomes(await collectObservations(observations))

    expect(outcomes.visibility).toMatchObject({ status: 'available', value: 0 })
    expect(outcomes.revenue).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
    expect(observations).toHaveLength(1)
    expect(observations[0].metricKey).toBe('seo.ai_citations')
  })

  it('does not use revenue evidence from a non-authoritative source', async () => {
    const collection = await collectObservations([observation({
      id: 'evidence-revenue',
      metricKey: 'finance.revenue',
      value: 500,
      unit: 'usd',
      authority: 'first-party',
    })])

    expect(deriveMarketingOutcomes(collection).revenue).toEqual({
      status: 'unavailable',
      reason: 'authoritative_source_missing',
    })
  })

  it('uses finance revenue from a supported CRM authority', async () => {
    const collection = await collectObservations([observation({
      id: 'evidence-revenue',
      metricKey: 'finance.revenue',
      value: 500,
      unit: 'usd',
      authority: 'ghl',
    })], ghlBinding)

    expect(deriveMarketingOutcomes(collection).revenue).toEqual({
      status: 'available',
      value: 500,
      unit: 'usd',
      source: 'ghl',
      observedAt: '2026-07-16T12:00:00.000Z',
    })
  })

  it('selects the latest observedAt instead of the last input observation', async () => {
    const collection = await collectObservations([
      observation({
        id: 'latest-evidence',
        value: 9,
        observedAt: '2026-07-16T18:00:00.000Z',
      }),
      observation({
        id: 'older-evidence',
        value: 2,
        observedAt: '2026-07-16T08:00:00.000Z',
      }),
    ])

    expect(deriveMarketingOutcomes(collection).visibility).toMatchObject({
      value: 9,
      observedAt: '2026-07-16T18:00:00.000Z',
    })
  })

  it('breaks equal observedAt ties by greatest observation ID', async () => {
    const collection = await collectObservations([
      observation({ id: 'z-evidence', value: 9 }),
      observation({ id: 'a-evidence', value: 2 }),
    ])

    expect(deriveMarketingOutcomes(collection).visibility).toMatchObject({
      value: 9,
      observedAt: '2026-07-16T12:00:00.000Z',
    })
  })

  it('derives from a genuine collection after WeakSet methods are replaced', async () => {
    const collection = await fixtureCollection()
    const originalHas = WeakSet.prototype.has
    const originalAdd = WeakSet.prototype.add
    let outcomes: ReturnType<typeof deriveMarketingOutcomes> | undefined

    try {
      WeakSet.prototype.has = () => false
      WeakSet.prototype.add = function () { throw new Error('mutated WeakSet add') }
      outcomes = deriveMarketingOutcomes(collection)
    } finally {
      WeakSet.prototype.has = originalHas
      WeakSet.prototype.add = originalAdd
    }

    expect(outcomes?.visibility).toMatchObject({ status: 'available', value: 8 })
  })

  it('uses indexed traversal and captured includes/freeze after intrinsic replacement', async () => {
    const collection = await fixtureCollection()
    const originalIterator = Array.prototype[Symbol.iterator]
    const originalIncludes = Array.prototype.includes
    const originalFreeze = Object.freeze
    let outcomes: ReturnType<typeof deriveMarketingOutcomes> | undefined

    try {
      Array.prototype[Symbol.iterator] = function () { throw new Error('mutated array iterator') }
      Array.prototype.includes = () => false
      Object.freeze = ((value: unknown) => value) as typeof Object.freeze
      outcomes = deriveMarketingOutcomes(collection)
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator
      Array.prototype.includes = originalIncludes
      Object.freeze = originalFreeze
    }

    expect(outcomes?.visibility).toMatchObject({ status: 'available', value: 8 })
    expect(Object.isFrozen(outcomes)).toBe(true)
    expect(Object.isFrozen(outcomes?.visibility)).toBe(true)
  })

  it('rejects a forged collection with a stable provenance error', () => {
    const forged = Object.freeze({
      runId: 'run-1',
      rawObservationCount: 1,
      sources: Object.freeze([]),
      observations: Object.freeze([observation()]),
    }) as MarketingSnapshotCollection

    expect(() => deriveMarketingOutcomes(forged)).toThrow('unnormalized_marketing_snapshot')
  })

  it('rejects raw observations instead of bypassing collector normalization', () => {
    const raw = [observation()] as unknown as MarketingSnapshotCollection

    expect(() => deriveMarketingOutcomes(raw)).toThrow('unnormalized_marketing_snapshot')
  })

  it('derives an SEO keyword-gap signal from weak organic lead capture', async () => {
    const outcomes = deriveMarketingOutcomes(await fixtureCollection())
    const signals = deriveSeoChannelSignals(outcomes, {
      status: 'unavailable',
      reason: 'authoritative_source_missing',
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      kind: 'keyword_gap',
      primaryKpi: 'qualifiedTraffic',
      reason: 'organic_lead_capture_below_ceiling',
      measuredGap: 12 / 240,
    })
  })

  it('prefers explicit keyword-gap query evidence over the funnel proxy', async () => {
    const outcomes = deriveMarketingOutcomes(await fixtureCollection())
    const signals = deriveSeoChannelSignals(outcomes, {
      status: 'available',
      value: 17,
      unit: 'count',
      source: 'gsc',
      observedAt: '2026-07-16T12:00:00.000Z',
    })

    expect(signals[0]).toMatchObject({
      kind: 'keyword_gap',
      reason: 'search_queries_without_ranking_url',
      measuredGap: 17,
    })
  })

  it('derives an SEO content-candidate signal when conversion is weak and leads are unavailable', () => {
    const signals = deriveSeoChannelSignals({
      visibility: { status: 'unavailable', reason: 'authoritative_source_missing' },
      qualifiedTraffic: {
        status: 'available',
        value: 100,
        unit: 'count',
        source: 'first-party',
        observedAt: '2026-07-16T12:00:00.000Z',
      },
      leads: { status: 'unavailable', reason: 'authoritative_source_missing' },
      conversion: {
        status: 'available',
        value: 0.02,
        unit: 'ratio',
        source: 'first-party',
        observedAt: '2026-07-16T12:00:00.000Z',
      },
      revenue: { status: 'unavailable', reason: 'authoritative_source_missing' },
      content: { status: 'unavailable', reason: 'authoritative_source_missing' },
    }, { status: 'unavailable', reason: 'authoritative_source_missing' })

    expect(signals[0]).toMatchObject({
      kind: 'content_candidate',
      primaryKpi: 'conversion',
      reason: 'organic_conversion_below_ceiling',
    })
  })

  it('derives a content publish-cadence signal when posts_published is zero', () => {
    const signals = deriveContentChannelSignals({
      visibility: { status: 'unavailable', reason: 'authoritative_source_missing' },
      qualifiedTraffic: { status: 'unavailable', reason: 'authoritative_source_missing' },
      leads: { status: 'unavailable', reason: 'authoritative_source_missing' },
      conversion: { status: 'unavailable', reason: 'authoritative_source_missing' },
      revenue: { status: 'unavailable', reason: 'authoritative_source_missing' },
      content: {
        status: 'available',
        value: 0,
        unit: 'count',
        source: 'mcpwp',
        observedAt: '2026-07-16T12:00:00.000Z',
      },
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      kind: 'publish_cadence',
      primaryKpi: 'content',
      reason: 'no_posts_published_in_window',
    })
  })

  it('reads keyword-gap queries from a normalized collection without fabricating zero', async () => {
    const collection = await collectObservations([observation({
      id: 'gap-evidence',
      metricKey: 'seo.keyword_gap_queries',
      value: 9,
      unit: 'count',
      authority: 'first-party',
    })])

    expect(keywordGapQueryOutcome(collection)).toEqual({
      status: 'available',
      value: 9,
      unit: 'count',
      source: 'first-party',
      observedAt: '2026-07-16T12:00:00.000Z',
    })
    expect(keywordGapQueryOutcome(await collectObservations([]))).toEqual({
      status: 'unavailable',
      reason: 'authoritative_source_missing',
    })
  })
})
