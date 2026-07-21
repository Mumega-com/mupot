import { describe, expect, it } from 'vitest'
import { createMarketingMonitorFixtureSource } from './fixtures/marketing-monitor'
import {
  collectMarketingSnapshots,
  isCollectedMarketingSnapshot,
  MAX_OBSERVATIONS_PER_RUN,
  MAX_OBSERVATIONS_PER_SOURCE,
  CONTENT_CHANNEL_SOURCE_METRICS,
  SEO_CHANNEL_SOURCE_METRICS,
} from '../src/addons/marketing/sources'
import { MARKETING_MONITOR_METRIC_CONTRACT } from '../src/addons/marketing/types'
import * as MarketingTypes from '../src/addons/marketing/types'
import type {
  MarketingMonitorSource,
  MonitorObservation,
  MonitorWindow,
  ResolvedAddonBinding,
  SourceSnapshot,
} from '../src/addons/marketing/types'
import type { Env } from '../src/types'

const env = { TENANT_SLUG: 'tenant-a' } as Env
const window: MonitorWindow = {
  start: '2026-07-16T00:00:00.000Z',
  end: '2026-07-16T23:59:59.999Z',
}
const bindings: readonly ResolvedAddonBinding[] = [{
  id: 'binding-web-analytics',
  slot: 'web_analytics',
  adapter: 'first_party',
  bindingKind: 'internal_adapter',
  capability: 'read',
  connectorId: null,
}]

interface TestConnector {
  id: string
  type: string
  tenant?: string
  revoked?: boolean
  resolvedId?: string
}

function envWithConnectors(connectors: TestConnector[], queries: string[] = []): Env {
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        queries.push(sql)
        let values: unknown[] = []
        const statement = {
          bind(...bound: unknown[]) {
            values = bound
            return statement
          },
          async first() {
            const [connectorId, tenant] = values
            const connector = connectors.find((candidate) => (
              candidate.id === connectorId
              && (candidate.tenant ?? 'tenant-a') === tenant
              && !candidate.revoked
            ))
            if (!connector) return null
            return {
              id: connector.resolvedId ?? connector.id,
              type: connector.type,
              label: 'Safe connector fixture',
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
  }
}

function observation(overrides: Partial<MonitorObservation> = {}): MonitorObservation {
  return {
    id: 'evidence-1',
    runId: 'run-1',
    metricKey: 'seo.ai_citations',
    value: 1,
    unit: 'count',
    authority: 'first-party',
    observedAt: '2026-07-16T12:00:00.000Z',
    sourceKey: 'analytics',
    sourceSlot: 'web_analytics',
    ...overrides,
  }
}

function source(
  key: string,
  slot: string,
  read: MarketingMonitorSource['read'],
): MarketingMonitorSource {
  return { key, slot, read }
}

function available(observations: readonly MonitorObservation[]): SourceSnapshot {
  return { status: 'available', observations }
}

describe('collectMarketingSnapshots', () => {
  it('declares the immutable canonical monitor binding contract', () => {
    const contract = (MarketingTypes as Record<string, unknown>).MARKETING_MONITOR_BINDING_CONTRACT
    expect(contract).toEqual({
      web_analytics: {
        first_party: { capability: 'read', bindingKind: 'internal_adapter', connectorId: 'null' },
        posthog: { capability: 'read', bindingKind: 'vault_connector', connectorId: 'required' },
      },
      content_surface: {
        inkwell: { capability: 'read', bindingKind: 'vault_connector', connectorId: 'required' },
        mcpwp: { capability: 'read', bindingKind: 'vault_connector', connectorId: 'required' },
      },
      search_performance: {
        google_search_console: { capability: 'read', bindingKind: 'vault_connector', connectorId: 'required' },
      },
      crm: {
        ghl: { capability: 'read', bindingKind: 'vault_connector', connectorId: 'required' },
        crm: { capability: 'read', bindingKind: 'vault_connector', connectorId: 'required' },
      },
    })
    expect(Object.isFrozen(contract)).toBe(true)
  })

  it('keeps future ai_visibility bindings unreachable and never reads their source', async () => {
    let reads = 0
    const snapshot = await collectMarketingSnapshots(env, [{
      id: 'binding-ai-visibility',
      slot: 'ai_visibility',
      adapter: 'ai_visibility',
      bindingKind: 'vault_connector',
      capability: 'read',
      connectorId: 'connector-ai-visibility',
    }], window, [source('ai-source', 'ai_visibility', async () => {
      reads += 1
      return available([observation({ authority: 'ai_visibility' })])
    })])

    expect(reads).toBe(0)
    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({
      status: 'unavailable',
      reason: 'binding_not_configured',
    })
  })

  it('declares immutable exact units for every monitor metric', () => {
    expect(Object.fromEntries(Object.entries(MARKETING_MONITOR_METRIC_CONTRACT).map(
      ([metricKey, contract]) => [metricKey, (contract as { unit?: string }).unit],
    ))).toEqual({
      'seo.ai_citations': 'count',
      'seo.organic_sessions': 'count',
      'growth.leads': 'count',
      'growth.replies': 'count',
      'seo.conversion_rate': 'ratio',
      'seo.keyword_gap_queries': 'count',
      'finance.revenue': 'usd',
      'content.posts_published': 'count',
    })
    expect([...SEO_CHANNEL_SOURCE_METRICS]).toEqual([
      'seo.ai_citations',
      'seo.organic_sessions',
      'seo.conversion_rate',
      'seo.keyword_gap_queries',
    ])
    expect([...CONTENT_CHANNEL_SOURCE_METRICS]).toEqual([
      'content.posts_published',
    ])
    expect(Object.isFrozen(SEO_CHANNEL_SOURCE_METRICS)).toBe(true)
    expect(Object.isFrozen(CONTENT_CHANNEL_SOURCE_METRICS)).toBe(true)
    expect(Object.isFrozen(MARKETING_MONITOR_METRIC_CONTRACT)).toBe(true)
    expect(Object.values(MARKETING_MONITOR_METRIC_CONTRACT).every(Object.isFrozen)).toBe(true)
  })

  it('accepts seo.keyword_gap_queries from a search_performance GSC binding', async () => {
    const gapObservation = observation({
      id: 'gsc-keyword-gap',
      metricKey: 'seo.keyword_gap_queries',
      value: 17,
      unit: 'count',
      authority: 'gsc',
      sourceKey: 'gsc',
      sourceSlot: 'search_performance',
    })
    const gscBinding: ResolvedAddonBinding = {
      id: 'binding-gsc',
      slot: 'search_performance',
      adapter: 'google_search_console',
      bindingKind: 'vault_connector',
      capability: 'read',
      connectorId: 'connector-gsc',
    }

    const snapshot = await collectMarketingSnapshots(
      envWithConnectors([{ id: 'connector-gsc', type: 'google_search_console' }]),
      [gscBinding],
      window,
      [source('gsc', 'search_performance', async () => available([gapObservation]))],
    )

    expect(snapshot.sources[0]).toMatchObject({ status: 'available', observationCount: 1 })
    expect(snapshot.observations).toEqual([expect.objectContaining({
      metricKey: 'seo.keyword_gap_queries',
      value: 17,
      authority: 'gsc',
      sourceSlot: 'search_performance',
    })])
  })

  it('keeps healthy source evidence when an optional source fails', async () => {
    const healthyFixture = createMarketingMonitorFixtureSource({
      runId: 'run-1',
      observedAt: '2026-07-16T12:00:00.000Z',
      window,
    })
    const failingFixture = source('content', 'content_surface', async () => {
      throw new Error('upstream token=secret should never escape')
    })

    const snapshot = await collectMarketingSnapshots(envWithConnectors([
      { id: 'connector-content', type: 'inkwell' },
    ]), [
      ...bindings,
      {
        id: 'binding-content',
        slot: 'content_surface',
        adapter: 'inkwell',
        bindingKind: 'vault_connector',
        capability: 'read',
        connectorId: 'connector-content',
      },
    ], window, [healthyFixture, failingFixture])

    expect(snapshot.observations).toHaveLength(5)
    expect(snapshot.sources).toEqual([
      expect.objectContaining({ key: 'first_party_fixture', status: 'available', observationCount: 5 }),
      expect.objectContaining({ key: 'content', status: 'failed', reason: 'source_read_failed' }),
    ])
  })

  it('isolates a failing bound source with a stable non-secret reason', async () => {
    const failed = source('analytics', 'web_analytics', async () => {
      throw new Error('Bearer top-secret upstream failure')
    })
    const healthy = source('second', 'web_analytics', async () => available([observation({ id: 'evidence-2' })]))

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [failed, healthy])

    expect(snapshot.observations).toEqual([observation({ id: 'evidence-2', sourceKey: 'second' })])
    expect(snapshot.sources).toEqual([
      { key: 'analytics', slot: 'web_analytics', status: 'failed', reason: 'source_read_failed', observationCount: 0 },
      { key: 'second', slot: 'web_analytics', status: 'available', observationCount: 1 },
    ])
    expect(JSON.stringify(snapshot)).not.toContain('top-secret')
  })

  it('never invokes a caller-owned sources map', async () => {
    let mapCalls = 0
    let reads = 0
    const forgedSource = source('forged-source', 'web_analytics', async () => {
      reads += 1
      return available([observation({ id: 'forged-source-evidence' })])
    })
    const hostileSources: MarketingMonitorSource[] = []
    Object.defineProperty(hostileSources, 'map', {
      value: (callback: (entry: MarketingMonitorSource, index: number) => unknown) => {
        mapCalls += 1
        return [callback(forgedSource, 0)]
      },
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, hostileSources)

    expect(mapCalls).toBe(0)
    expect(reads).toBe(0)
    expect(snapshot.sources).toEqual([])
    expect(snapshot.observations).toEqual([])
  })

  it('never invokes a caller-owned bindings iterator', async () => {
    let iteratorCalls = 0
    let reads = 0
    const hostileBindings: ResolvedAddonBinding[] = []
    Object.defineProperty(hostileBindings, Symbol.iterator, {
      value: function* () {
        iteratorCalls += 1
        yield bindings[0]
      },
    })

    const snapshot = await collectMarketingSnapshots(env, hostileBindings, window, [
      source('analytics', 'web_analytics', async () => {
        reads += 1
        return available([observation()])
      }),
    ])

    expect(iteratorCalls).toBe(0)
    expect(reads).toBe(0)
    expect(snapshot.sources[0]).toMatchObject({
      status: 'unavailable',
      reason: 'binding_not_configured',
    })
  })

  it('invokes captured reads with Reflect.apply instead of a function-owned call override', async () => {
    let bodyCalls = 0
    let callOverrideCalls = 0
    const read = async () => {
      bodyCalls += 1
      return available([observation({ id: 'trusted-read-evidence' })])
    }
    Object.defineProperty(read, 'call', {
      value: () => {
        callOverrideCalls += 1
        return available([observation({ id: 'forged-call-evidence' })])
      },
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', read),
    ])

    expect(callOverrideCalls).toBe(0)
    expect(bodyCalls).toBe(1)
    expect(snapshot.observations).toEqual([observation({ id: 'trusted-read-evidence' })])
  })

  it('uses module-captured includes, freeze, and WeakSet add after source execution', async () => {
    const originalIncludes = Array.prototype.includes
    const originalFreeze = Object.freeze
    const originalWeakSetAdd = WeakSet.prototype.add
    let snapshot: Awaited<ReturnType<typeof collectMarketingSnapshots>> | undefined

    try {
      snapshot = await collectMarketingSnapshots(env, bindings, window, [
        source('intrinsic-mutator', 'web_analytics', async () => {
          Array.prototype.includes = () => true
          Object.freeze = ((value: unknown) => value) as typeof Object.freeze
          WeakSet.prototype.add = function () { return this }
          return available([observation({
            metricKey: 'finance.revenue',
            unit: 'usd',
            authority: 'first-party',
          })])
        }),
      ])
    } finally {
      Array.prototype.includes = originalIncludes
      Object.freeze = originalFreeze
      WeakSet.prototype.add = originalWeakSetAdd
    }

    expect(snapshot?.observations).toEqual([])
    expect(snapshot?.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'metric_authority_not_allowed',
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot?.sources[0])).toBe(true)
    expect(isCollectedMarketingSnapshot(snapshot)).toBe(true)
  })

  it('rejects more than 16 source declarations without reading them', async () => {
    let reads = 0
    const tooManySources = Array.from({ length: 17 }, (_, index) => source(
      `source-${index}`,
      'web_analytics',
      async () => {
        reads += 1
        return available([])
      },
    ))

    const snapshot = await collectMarketingSnapshots(env, bindings, window, tooManySources)

    expect(reads).toBe(0)
    expect(snapshot.sources).toEqual([
      { key: 'source_config_0', slot: 'unconfigured', status: 'failed', reason: 'invalid_source_configuration', observationCount: 0 },
    ])
  })

  it.each([
    {} as unknown,
    new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') return 1.5
        return Reflect.get(target, property, receiver)
      },
    }),
  ])('rejects non-array or non-integer source inputs with a stable configuration failure', async (sourceInputs) => {
    const snapshot = await collectMarketingSnapshots(
      env,
      bindings,
      window,
      sourceInputs as readonly MarketingMonitorSource[],
    )

    expect(snapshot.sources).toEqual([
      { key: 'source_config_0', slot: 'unconfigured', status: 'failed', reason: 'invalid_source_configuration', observationCount: 0 },
    ])
  })

  it('rejects more than 16 bindings before reading safely identified sources', async () => {
    let reads = 0
    const tooManyBindings = new Proxy(Array.from({ length: 17 }, (_, index) => ({
      ...bindings[0],
      id: `binding-${index}`,
    })), {
      get(target, property, receiver) {
        if (property === '0') throw new Error('over-limit binding secret')
        return Reflect.get(target, property, receiver)
      },
    })

    const snapshot = await collectMarketingSnapshots(env, tooManyBindings, window, [
      source('analytics', 'web_analytics', async () => {
        reads += 1
        return available([])
      }),
    ])

    expect(reads).toBe(0)
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'invalid_binding_configuration',
    })
  })

  it.each([
    {} as unknown,
    new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') return 1.5
        return Reflect.get(target, property, receiver)
      },
    }),
  ])('rejects non-array or non-integer binding inputs before source reads', async (bindingInputs) => {
    let reads = 0
    const snapshot = await collectMarketingSnapshots(
      env,
      bindingInputs as readonly ResolvedAddonBinding[],
      window,
      [source('analytics', 'web_analytics', async () => {
        reads += 1
        return available([])
      })],
    )

    expect(reads).toBe(0)
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'invalid_binding_configuration',
    })
  })

  it('isolates a throwing source index getter and continues later sources', async () => {
    const sourceInputs = new Proxy([
      source('unreachable', 'web_analytics', async () => available([])),
      source('healthy', 'web_analytics', async () => available([observation({ id: 'healthy-evidence' })])),
    ], {
      get(target, property, receiver) {
        if (property === '0') throw new Error('source index secret')
        return Reflect.get(target, property, receiver)
      },
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, sourceInputs)

    expect(snapshot.sources).toEqual([
      { key: 'source_config_0', slot: 'unconfigured', status: 'failed', reason: 'invalid_source_configuration', observationCount: 0 },
      { key: 'healthy', slot: 'web_analytics', status: 'available', observationCount: 1 },
    ])
    expect(snapshot.observations).toEqual([observation({ id: 'healthy-evidence', sourceKey: 'healthy' })])
    expect(JSON.stringify(snapshot)).not.toContain('index secret')
  })

  it('fails safely identified sources closed when a binding index getter throws', async () => {
    let reads = 0
    const bindingInputs = new Proxy([
      bindings[0],
      bindings[0],
    ], {
      get(target, property, receiver) {
        if (property === '0') throw new Error('binding index secret')
        return Reflect.get(target, property, receiver)
      },
    })

    const snapshot = await collectMarketingSnapshots(env, bindingInputs, window, [
      source('analytics', 'web_analytics', async () => {
        reads += 1
        return available([])
      }),
    ])

    expect(reads).toBe(0)
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'invalid_binding_configuration',
    })
    expect(JSON.stringify(snapshot)).not.toContain('index secret')
  })

  it('re-resolves a vault binding and rejects a GHL adapter backed by a PostHog connector before read', async () => {
    let reads = 0
    const queries: string[] = []
    const ghlBinding: ResolvedAddonBinding = {
      id: 'binding-crm',
      slot: 'crm',
      adapter: 'ghl',
      bindingKind: 'vault_connector',
      capability: 'read',
      connectorId: 'connector-crm',
    }

    const snapshot = await collectMarketingSnapshots(envWithConnectors([
      { id: 'connector-crm', type: 'posthog' },
    ], queries), [ghlBinding], window, [source('crm-source', 'crm', async () => {
      reads += 1
      return available([observation({
        metricKey: 'finance.revenue',
        unit: 'usd',
        authority: 'ghl',
      })])
    })])

    expect(reads).toBe(0)
    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({ status: 'failed', reason: 'adapter_type_mismatch' })
    expect(queries).toHaveLength(1)
    expect(queries[0]).not.toContain('encrypted_secret')
  })

  it.each([
    [{ id: 'connector-crm', type: 'ghl', resolvedId: 'different-id' }],
    [{ id: 'connector-crm', type: 'ghl', tenant: 'tenant-b' }],
    [{ id: 'connector-crm', type: 'ghl', revoked: true }],
  ] as TestConnector[][])('rejects vault connectors unavailable by exact ID, tenant, or active status', async (connectors) => {
    let reads = 0
    const snapshot = await collectMarketingSnapshots(envWithConnectors(connectors), [{
      id: 'binding-crm',
      slot: 'crm',
      adapter: 'ghl',
      bindingKind: 'vault_connector',
      capability: 'read',
      connectorId: 'connector-crm',
    }], window, [source('crm-source', 'crm', async () => {
      reads += 1
      return available([])
    })])

    expect(reads).toBe(0)
    expect(snapshot.sources[0]).toMatchObject({ status: 'failed', reason: 'connector_not_available' })
  })

  it.each([
    ['changes type', (connector: TestConnector) => { connector.type = 'posthog' }, 'adapter_type_mismatch'],
    ['is revoked', (connector: TestConnector) => { connector.revoked = true }, 'connector_not_available'],
  ] as const)('re-resolves a vault connector after read when it %s', async (_label, mutate, reason) => {
    const connector: TestConnector = { id: 'connector-crm', type: 'ghl' }
    const snapshot = await collectMarketingSnapshots(envWithConnectors([connector]), [{
      id: 'binding-crm',
      slot: 'crm',
      adapter: 'ghl',
      bindingKind: 'vault_connector',
      capability: 'read',
      connectorId: 'connector-crm',
    }], window, [source('crm-source', 'crm', async () => {
      mutate(connector)
      return available([observation({
        metricKey: 'finance.revenue',
        unit: 'usd',
        authority: 'ghl',
      })])
    })])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({ status: 'failed', reason })
  })

  it('uses the captured tenant and DB when final vault verification runs', async () => {
    const realConnector: TestConnector = { id: 'connector-crm', type: 'ghl' }
    const mutableEnv = envWithConnectors([realConnector])
    const fakeEnv = envWithConnectors([
      { id: 'connector-crm', type: 'ghl', tenant: 'tenant-b' },
    ])
    const originalDB = mutableEnv.DB
    const originalTenant = mutableEnv.TENANT_SLUG
    let snapshot: Awaited<ReturnType<typeof collectMarketingSnapshots>> | undefined

    try {
      snapshot = await collectMarketingSnapshots(mutableEnv, [{
        id: 'binding-crm',
        slot: 'crm',
        adapter: 'ghl',
        bindingKind: 'vault_connector',
        capability: 'read',
        connectorId: 'connector-crm',
      }], window, [source('crm-source', 'crm', async () => {
        realConnector.revoked = true
        mutableEnv.DB = fakeEnv.DB
        mutableEnv.TENANT_SLUG = 'tenant-b'
        return available([observation({
          metricKey: 'finance.revenue',
          unit: 'usd',
          authority: 'ghl',
        })])
      })])
    } finally {
      mutableEnv.DB = originalDB
      mutableEnv.TENANT_SLUG = originalTenant
    }

    expect(snapshot?.observations).toEqual([])
    expect(snapshot?.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'connector_not_available',
    })
  })

  it('uses the captured prepare function and original DB receiver for final verification', async () => {
    const realConnector: TestConnector = { id: 'connector-crm', type: 'ghl' }
    const mutableEnv = envWithConnectors([realConnector])
    const fakeEnv = envWithConnectors([{ id: 'connector-crm', type: 'ghl' }])
    const originalPrepare = mutableEnv.DB.prepare
    let snapshot: Awaited<ReturnType<typeof collectMarketingSnapshots>> | undefined

    try {
      snapshot = await collectMarketingSnapshots(mutableEnv, [{
        id: 'binding-crm',
        slot: 'crm',
        adapter: 'ghl',
        bindingKind: 'vault_connector',
        capability: 'read',
        connectorId: 'connector-crm',
      }], window, [source('crm-source', 'crm', async () => {
        realConnector.revoked = true
        mutableEnv.DB.prepare = fakeEnv.DB.prepare
        return available([observation({
          metricKey: 'finance.revenue',
          unit: 'usd',
          authority: 'ghl',
        })])
      })])
    } finally {
      mutableEnv.DB.prepare = originalPrepare
    }

    expect(snapshot?.observations).toEqual([])
    expect(snapshot?.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'connector_not_available',
    })
  })

  it('performs the final connector type check after an observation index getter runs', async () => {
    const connector: TestConnector = { id: 'connector-crm', type: 'ghl' }
    const observations = new Array<MonitorObservation>(1)
    Object.defineProperty(observations, '0', {
      enumerable: true,
      get() {
        connector.type = 'posthog'
        return observation({
          metricKey: 'finance.revenue',
          unit: 'usd',
          authority: 'ghl',
        })
      },
    })

    const snapshot = await collectMarketingSnapshots(envWithConnectors([connector]), [{
      id: 'binding-crm',
      slot: 'crm',
      adapter: 'ghl',
      bindingKind: 'vault_connector',
      capability: 'read',
      connectorId: 'connector-crm',
    }], window, [source('crm-source', 'crm', async () => available(observations))])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({ status: 'failed', reason: 'adapter_type_mismatch' })
  })

  it('performs the final active connector check after observation property getters run', async () => {
    const connector: TestConnector = { id: 'connector-crm', type: 'ghl' }
    const hostileObservation = observation({
      metricKey: 'finance.revenue',
      unit: 'usd',
      authority: 'ghl',
    }) as unknown as Record<string, unknown>
    Object.defineProperty(hostileObservation, 'authority', {
      enumerable: true,
      get() {
        connector.revoked = true
        return 'ghl'
      },
    })

    const snapshot = await collectMarketingSnapshots(envWithConnectors([connector]), [{
      id: 'binding-crm',
      slot: 'crm',
      adapter: 'ghl',
      bindingKind: 'vault_connector',
      capability: 'read',
      connectorId: 'connector-crm',
    }], window, [source('crm-source', 'crm', async () => available([
      hostileObservation as unknown as MonitorObservation,
    ]))])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({ status: 'failed', reason: 'connector_not_available' })
  })

  it('isolates post-read snapshot and observation getter failures per source', async () => {
    const hostileSnapshot = { status: 'available' } as Record<string, unknown>
    Object.defineProperty(hostileSnapshot, 'observations', {
      enumerable: true,
      get: () => { throw new Error('snapshot secret') },
    })
    const hostileObservation = observation({ id: 'hostile-observation' }) as unknown as Record<string, unknown>
    Object.defineProperty(hostileObservation, 'authority', {
      enumerable: true,
      get: () => { throw new Error('observation secret') },
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('snapshot-getter', 'web_analytics', async () => hostileSnapshot as unknown as SourceSnapshot),
      source('observation-getter', 'web_analytics', async () => available([
        hostileObservation as unknown as MonitorObservation,
      ])),
      source('healthy', 'web_analytics', async () => available([observation({ id: 'healthy-evidence' })])),
    ])

    expect(snapshot.sources).toEqual([
      { key: 'snapshot-getter', slot: 'web_analytics', status: 'failed', reason: 'invalid_source_snapshot', observationCount: 0 },
      { key: 'observation-getter', slot: 'web_analytics', status: 'failed', reason: 'invalid_source_snapshot', observationCount: 0 },
      { key: 'healthy', slot: 'web_analytics', status: 'available', observationCount: 1 },
    ])
    expect(snapshot.observations).toEqual([observation({ id: 'healthy-evidence', sourceKey: 'healthy' })])
    expect(JSON.stringify(snapshot)).not.toContain('secret')
  })

  it('never invokes a source-owned map that forges invalid revenue from a zero-length array', async () => {
    const forgedRevenue = [observation({
      id: 'forged-revenue',
      metricKey: 'finance.revenue',
      unit: 'usd',
      authority: 'first-party',
    })]
    Object.defineProperty(forgedRevenue, 'map', {
      value: () => [null],
    })
    const hostileObservations: MonitorObservation[] = []
    Object.defineProperty(hostileObservations, 'map', {
      value: () => forgedRevenue,
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('hostile-array', 'web_analytics', async () => available(hostileObservations)),
    ])

    expect(snapshot.rawObservationCount).toBe(0)
    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources).toEqual([
      { key: 'hostile-array', slot: 'web_analytics', status: 'available', observationCount: 0 },
    ])
  })

  it('never accepts 201 observations returned by source-owned array methods after zero-length cap checks', async () => {
    const forged = Array.from({ length: MAX_OBSERVATIONS_PER_RUN + 1 }, (_, index) => observation({
      id: `forged-${index}`,
    }))
    Object.defineProperty(forged, 'map', {
      value: () => [null],
    })
    const hostileObservations: MonitorObservation[] = []
    Object.defineProperty(hostileObservations, 'map', {
      value: () => forged,
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('hostile-array', 'web_analytics', async () => available(hostileObservations)),
    ])

    expect(snapshot.rawObservationCount).toBe(0)
    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({ status: 'available', observationCount: 0 })
  })

  it.each([1.5, 2 ** 32])('rejects an untrusted array length outside JS array bounds: %s', async (length) => {
    const hostileObservations = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') return length
        return Reflect.get(target, property, receiver)
      },
    }) as MonitorObservation[]

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('hostile-length', 'web_analytics', async () => available(hostileObservations)),
    ])

    expect(snapshot.rawObservationCount).toBe(0)
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'invalid_source_snapshot',
    })
  })

  it('isolates source key, slot, and read getter failures with synthetic identities', async () => {
    const hostileSource = (field: 'key' | 'slot' | 'read'): MarketingMonitorSource => {
      const candidate: Record<string, unknown> = {
        key: `${field}-source`,
        slot: 'web_analytics',
        read: async () => available([]),
      }
      Object.defineProperty(candidate, field, {
        enumerable: true,
        get: () => { throw new Error(`${field} getter secret`) },
      })
      return candidate as unknown as MarketingMonitorSource
    }

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      hostileSource('key'),
      hostileSource('slot'),
      hostileSource('read'),
      source('healthy', 'web_analytics', async () => available([observation({ id: 'healthy-evidence' })])),
    ])

    expect(snapshot.sources).toEqual([
      { key: 'source_config_0', slot: 'unconfigured', status: 'failed', reason: 'invalid_source_configuration', observationCount: 0 },
      { key: 'source_config_1', slot: 'unconfigured', status: 'failed', reason: 'invalid_source_configuration', observationCount: 0 },
      { key: 'source_config_2', slot: 'unconfigured', status: 'failed', reason: 'invalid_source_configuration', observationCount: 0 },
      { key: 'healthy', slot: 'web_analytics', status: 'available', observationCount: 1 },
    ])
    expect(snapshot.observations).toEqual([observation({ id: 'healthy-evidence', sourceKey: 'healthy' })])
    expect(JSON.stringify(snapshot)).not.toContain('getter secret')
  })

  it('rejects noncanonical source keys and slots with synthetic configuration failures', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('Bad Key', 'web_analytics', async () => available([])),
      source('valid-key', 'Web Analytics', async () => available([])),
      source('healthy', 'web_analytics', async () => available([observation({ id: 'healthy-evidence' })])),
    ])

    expect(snapshot.sources).toEqual([
      { key: 'source_config_0', slot: 'unconfigured', status: 'failed', reason: 'invalid_source_configuration', observationCount: 0 },
      { key: 'source_config_1', slot: 'unconfigured', status: 'failed', reason: 'invalid_source_configuration', observationCount: 0 },
      { key: 'healthy', slot: 'web_analytics', status: 'available', observationCount: 1 },
    ])
  })

  it('reserves synthetic source keys so declarations cannot collide with failure identities', async () => {
    const hostile = { key: 'hostile', read: async () => available([]) } as Record<string, unknown>
    Object.defineProperty(hostile, 'slot', {
      enumerable: true,
      get: () => { throw new Error('slot secret') },
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      hostile as unknown as MarketingMonitorSource,
      source('source_config_0', 'web_analytics', async () => available([])),
    ])

    expect(snapshot.sources.map((entry) => entry.key)).toEqual(['source_config_0', 'source_config_1'])
    expect(snapshot.sources.every((entry) => entry.reason === 'invalid_source_configuration')).toBe(true)
  })

  it('collapses duplicate source keys into one failure without reading either declaration', async () => {
    let reads = 0
    const duplicate = (slot: string) => source('duplicate-source', slot, async () => {
      reads += 1
      return available([])
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      duplicate('web_analytics'),
      duplicate('content_surface'),
    ])

    expect(reads).toBe(0)
    expect(snapshot.sources).toEqual([
      { key: 'duplicate-source', slot: 'web_analytics', status: 'failed', reason: 'duplicate_source_identity', observationCount: 0 },
    ])
  })

  it('normalizes adapter-supplied unavailable reasons instead of returning arbitrary text', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => ({
        status: 'unavailable',
        reason: 'Authorization: Bearer top-secret',
        observations: [],
      })),
    ])

    expect(snapshot.sources).toEqual([
      { key: 'analytics', slot: 'web_analytics', status: 'unavailable', reason: 'source_unavailable', observationCount: 0 },
    ])
    expect(JSON.stringify(snapshot)).not.toContain('top-secret')
  })

  it('rejects source-asserted authority that differs from the binding adapter authority', async () => {
    const forgedRevenue = observation({
      metricKey: 'finance.revenue' as MonitorObservation['metricKey'],
      unit: 'usd',
      authority: 'stripe',
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => available([forgedRevenue])),
    ])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'observation_authority_mismatch',
    })
  })

  it('rejects revenue when the binding-derived authority is not allowed for that metric', async () => {
    const firstPartyRevenue = observation({
      metricKey: 'finance.revenue' as MonitorObservation['metricKey'],
      unit: 'usd',
      authority: 'first-party',
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => available([firstPartyRevenue])),
    ])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'metric_authority_not_allowed',
    })
  })

  it('rejects a slot-adapter mismatch before a source can fabricate revenue', async () => {
    let reads = 0
    const mismatchedBinding = {
      ...bindings[0],
      adapter: 'ghl',
      bindingKind: 'vault_connector',
      connectorId: 'connector-ghl',
    } as ResolvedAddonBinding

    const snapshot = await collectMarketingSnapshots(env, [mismatchedBinding], window, [
      source('analytics', 'web_analytics', async () => {
        reads += 1
        return available([observation({
          metricKey: 'finance.revenue',
          unit: 'usd',
          authority: 'ghl',
        })])
      }),
    ])

    expect(reads).toBe(0)
    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'invalid_binding_configuration',
    })
  })

  it('rejects a stateful adapter object without invoking primitive coercion', async () => {
    let coercions = 0
    let reads = 0
    const statefulAdapter = {
      [Symbol.toPrimitive]() {
        coercions += 1
        return coercions === 1 ? 'first_party' : 'ghl'
      },
    }
    const binding = {
      ...bindings[0],
      adapter: statefulAdapter,
    } as unknown as ResolvedAddonBinding

    const snapshot = await collectMarketingSnapshots(env, [binding], window, [
      source('analytics', 'web_analytics', async () => {
        reads += 1
        return available([observation({
          metricKey: 'finance.revenue',
          unit: 'usd',
          authority: 'ghl',
        })])
      }),
    ])

    expect(coercions).toBe(0)
    expect(reads).toBe(0)
    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'invalid_binding_configuration',
    })
  })

  it.each([
    { ...bindings[0], id: '' },
    { ...bindings[0], capability: 'write' },
    { ...bindings[0], bindingKind: 'vault_connector', connectorId: 'connector-first-party' },
    { ...bindings[0], adapter: 'posthog', bindingKind: 'vault_connector', connectorId: null },
  ] as unknown as ResolvedAddonBinding[])('rejects malformed binding metadata before reading a source', async (binding) => {
    let reads = 0
    const snapshot = await collectMarketingSnapshots(env, [binding], window, [
      source('analytics', 'web_analytics', async () => {
        reads += 1
        return available([])
      }),
    ])

    expect(reads).toBe(0)
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'invalid_binding_configuration',
    })
  })

  it('rejects a nonempty unit that differs from the metric contract', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => available([
        observation({ metricKey: 'seo.ai_citations', unit: 'ratio' }),
      ])),
    ])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'observation_unit_mismatch',
    })
  })

  it('rejects a source that exceeds its observation cap without truncating its evidence', async () => {
    const tooMany = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE + 1 }, (_, index) => observation({
      id: `evidence-${index}`,
    }))

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => available(tooMany)),
    ])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources).toEqual([
      { key: 'analytics', slot: 'web_analytics', status: 'failed', reason: 'source_observation_limit_exceeded', observationCount: 0 },
    ])
  })

  it('applies the source cap before inspecting failed status or observation semantics', async () => {
    const tooMany = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE + 1 }, (_, index) => observation({
      id: `failed-${index}`,
      metricKey: 'unknown.metric' as MonitorObservation['metricKey'],
    }))

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => ({
        status: 'failed',
        reason: 'Authorization: Bearer source-secret',
        observations: tooMany,
      })),
    ])

    expect(snapshot.sources[0]).toEqual({
      key: 'analytics',
      slot: 'web_analytics',
      status: 'failed',
      reason: 'source_observation_limit_exceeded',
      observationCount: 0,
    })
  })

  it('rejects non-available snapshots that contain observations', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => ({
        status: 'unavailable',
        reason: 'connector_not_configured',
        observations: [observation()],
      })),
    ])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toEqual({
      key: 'analytics',
      slot: 'web_analytics',
      status: 'failed',
      reason: 'invalid_source_snapshot',
      observationCount: 0,
    })
  })

  it('rejects a source whose accepted observations would exceed the run cap', async () => {
    const first = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE }, (_, index) => observation({ id: `first-${index}` }))
    const second = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE }, (_, index) => observation({ id: `second-${index}` }))
    const overflow = [observation({ id: 'overflow-1' })]

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('first', 'web_analytics', async () => available(first)),
      source('second', 'web_analytics', async () => available(second)),
      source('overflow', 'web_analytics', async () => available(overflow)),
    ])

    expect(snapshot.observations).toHaveLength(MAX_OBSERVATIONS_PER_RUN)
    expect(snapshot.sources[2]).toEqual({
      key: 'overflow',
      slot: 'web_analytics',
      status: 'failed',
      reason: 'run_observation_limit_exceeded',
      observationCount: 0,
    })
  })

  it('applies the run cap before inspecting a later snapshot status or semantics', async () => {
    const first = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE }, (_, index) => observation({ id: `first-${index}` }))
    const second = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE }, (_, index) => observation({ id: `second-${index}` }))

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('first', 'web_analytics', async () => available(first)),
      source('second', 'web_analytics', async () => available(second)),
      source('overflow', 'web_analytics', async () => ({
        status: 'failed',
        reason: 'source-secret',
        observations: [observation({ metricKey: 'unknown.metric' as MonitorObservation['metricKey'] })],
      })),
    ])

    expect(snapshot.observations).toHaveLength(MAX_OBSERVATIONS_PER_RUN)
    expect(snapshot.sources[2]).toEqual({
      key: 'overflow',
      slot: 'web_analytics',
      status: 'failed',
      reason: 'run_observation_limit_exceeded',
      observationCount: 0,
    })
  })

  it('charges failed and unavailable observation arrays to the raw run budget', async () => {
    const rejected = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE }, (_, index) => observation({
      id: `rejected-${index}`,
    }))

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('unavailable-source', 'web_analytics', async () => ({
        status: 'unavailable',
        observations: rejected,
      })),
      source('failed-source', 'web_analytics', async () => ({
        status: 'failed',
        observations: rejected,
      })),
      source('overflow-source', 'web_analytics', async () => available([
        observation({ id: 'overflow-evidence' }),
      ])),
      source('later-source', 'web_analytics', async () => ({
        status: 'unavailable',
        observations: [],
      })),
    ])

    expect(snapshot.rawObservationCount).toBe(201)
    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources.map((entry) => entry.reason)).toEqual([
      'invalid_source_snapshot',
      'invalid_source_snapshot',
      'run_observation_limit_exceeded',
      'run_observation_limit_exceeded',
    ])
  })

  it('charges an over-source-cap array before rejecting later sources on the run cap', async () => {
    const overSourceCap = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE + 1 }, (_, index) => observation({
      id: `over-source-${index}`,
    }))
    const next = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE }, (_, index) => observation({
      id: `next-${index}`,
    }))

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('over-source', 'web_analytics', async () => available(overSourceCap)),
      source('next-source', 'web_analytics', async () => available(next)),
    ])

    expect(snapshot.rawObservationCount).toBe(201)
    expect(snapshot.sources.map((entry) => entry.reason)).toEqual([
      'source_observation_limit_exceeded',
      'run_observation_limit_exceeded',
    ])
  })

  it('keeps the raw run cap latched for later sources before binding checks', async () => {
    const overflow = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE + 1 }, (_, index) => observation({
      id: `overflow-${index}`,
    }))
    const fill = Array.from({ length: MAX_OBSERVATIONS_PER_SOURCE }, (_, index) => observation({
      id: `fill-${index}`,
    }))

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('overflow-source', 'web_analytics', async () => available(overflow)),
      source('fill-source', 'web_analytics', async () => available(fill)),
      source('unbound-later-source', 'content_surface', async () => available([])),
    ])

    expect(snapshot.rawObservationCount).toBe(201)
    expect(snapshot.sources[2]).toMatchObject({
      status: 'failed',
      reason: 'run_observation_limit_exceeded',
    })
  })

  it('rejects duplicate observation IDs within one source as a whole', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => available([
        observation({ id: 'duplicate-id', metricKey: 'seo.ai_citations' }),
        observation({ id: 'duplicate-id', metricKey: 'growth.leads' }),
      ])),
    ])

    expect(snapshot.runId).toBeNull()
    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({
      status: 'failed',
      reason: 'duplicate_observation_id',
      observationCount: 0,
    })
  })

  it('rejects globally duplicate observation IDs without removing prior evidence', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('first', 'web_analytics', async () => available([observation({ id: 'global-id' })])),
      source('duplicate', 'web_analytics', async () => available([
        observation({ id: 'global-id', metricKey: 'growth.leads' }),
      ])),
    ])

    expect(snapshot.runId).toBe('run-1')
    expect(snapshot.observations).toEqual([observation({ id: 'global-id', sourceKey: 'first' })])
    expect(snapshot.sources[1]).toMatchObject({
      status: 'failed',
      reason: 'duplicate_observation_id',
      observationCount: 0,
    })
  })

  it('adds collector-owned source attribution to normalized observations', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('attributed_source', 'web_analytics', async () => available([
        observation({ id: 'attributed' }),
      ])),
    ])

    expect(snapshot.observations).toEqual([
      expect.objectContaining({
        id: 'attributed',
        sourceKey: 'attributed_source',
        sourceSlot: 'web_analytics',
      }),
    ])
  })

  it('does not let raw source values assert normalized source attribution', async () => {
    const raw = {
      ...observation({ id: 'spoofed-attribution' }),
      sourceKey: 'forged_source',
      sourceSlot: 'crm',
    }
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('trusted_source', 'web_analytics', async () => available([raw])),
    ])

    expect(snapshot.observations[0]).toEqual(expect.objectContaining({
      sourceKey: 'trusted_source',
      sourceSlot: 'web_analytics',
    }))
    expect(snapshot.observations[0]).not.toEqual(expect.objectContaining({
      sourceKey: 'forged_source',
    }))
  })

  it('rejects a source with a different runId as a whole without partial acceptance', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('first', 'web_analytics', async () => available([observation({ id: 'first-id' })])),
      source('mismatch', 'web_analytics', async () => available([
        observation({ id: 'same-run-id', metricKey: 'growth.leads' }),
        observation({ id: 'different-run-id', runId: 'run-2', metricKey: 'growth.replies' }),
      ])),
    ])

    expect(snapshot.runId).toBe('run-1')
    expect(snapshot.observations).toEqual([observation({ id: 'first-id', sourceKey: 'first' })])
    expect(snapshot.sources[1]).toMatchObject({
      status: 'failed',
      reason: 'run_id_mismatch',
      observationCount: 0,
    })
  })

  it.each([
    observation({ metricKey: 'unknown.metric' }),
    observation({ value: Number.NaN }),
    observation({ unit: ' ' }),
    observation({ authority: '' }),
    observation({ observedAt: 'not-a-timestamp' }),
    observation({ observedAt: '2026-02-30T12:00:00.000Z' }),
    observation({ observedAt: '2026-07-17T00:00:00.000Z' }),
  ])('rejects malformed observation evidence', async (invalid) => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => available([invalid])),
    ])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({ status: 'failed', reason: 'invalid_observation' })
  })

  it('accepts 256-character observation IDs and rejects longer IDs as invalid observations', async () => {
    const acceptedId = 'a'.repeat(256)
    const oversizedId = 'b'.repeat(257)
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('accepted', 'web_analytics', async () => available([observation({ id: acceptedId })])),
      source('oversized', 'web_analytics', async () => available([observation({
        id: oversizedId,
        metricKey: 'seo.organic_sessions',
      })])),
    ])

    expect(snapshot.observations).toEqual([observation({ id: acceptedId, sourceKey: 'accepted' })])
    expect(snapshot.sources[1]).toMatchObject({
      status: 'failed',
      reason: 'invalid_observation',
      observationCount: 0,
    })
  })

  it('rejects monitor windows that omit canonical millisecond precision', async () => {
    await expect(collectMarketingSnapshots(env, bindings, {
      start: '2026-07-16T00:00:00Z',
      end: '2026-07-16T23:59:59.999Z',
    }, [])).rejects.toThrow('invalid_monitor_window')
  })

  it('reads window boundaries once and passes an immutable canonical clone to every source', async () => {
    let startReads = 0
    let endReads = 0
    const callerWindow = {} as MonitorWindow
    Object.defineProperties(callerWindow, {
      start: {
        enumerable: true,
        get() {
          startReads += 1
          return window.start
        },
      },
      end: {
        enumerable: true,
        get() {
          endReads += 1
          return window.end
        },
      },
    })
    const receivedWindows: MonitorWindow[] = []
    const readsWindow = (key: string, id: string) => source(key, 'web_analytics', async (_env, _binding, received) => {
      receivedWindows.push(received)
      Reflect.set(received as unknown as Record<string, unknown>, 'start', '2020-01-01T00:00:00.000Z')
      return available([observation({ id })])
    })

    const snapshot = await collectMarketingSnapshots(env, bindings, callerWindow, [
      readsWindow('first', 'first-evidence'),
      readsWindow('second', 'second-evidence'),
    ])

    expect(startReads).toBe(1)
    expect(endReads).toBe(1)
    expect(receivedWindows).toHaveLength(2)
    expect(receivedWindows[0]).toBe(receivedWindows[1])
    expect(receivedWindows[0]).not.toBe(callerWindow)
    expect(receivedWindows[0]).toEqual(window)
    expect(Object.isFrozen(receivedWindows[0])).toBe(true)
    expect(snapshot.observations.map((entry) => entry.id)).toEqual(['first-evidence', 'second-evidence'])
  })

  it('rejects observation timestamps that omit canonical millisecond precision', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => available([
        observation({ observedAt: '2026-07-16T12:00:00Z' }),
      ])),
    ])

    expect(snapshot.observations).toEqual([])
    expect(snapshot.sources[0]).toMatchObject({ status: 'failed', reason: 'invalid_observation' })
  })

  it('accepts observations exactly on both inclusive window boundaries', async () => {
    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => available([
        observation({ id: 'at-start', observedAt: window.start }),
        observation({ id: 'at-end', metricKey: 'growth.leads', observedAt: window.end }),
      ])),
    ])

    expect(snapshot.observations.map((entry) => entry.id)).toEqual(['at-start', 'at-end'])
    expect(snapshot.sources[0]).toMatchObject({ status: 'available', observationCount: 2 })
  })

  it('runs sources sequentially and preserves source and evidence order without mutation', async () => {
    const calls: string[] = []
    const firstObservations = [observation({ id: 'first-b' }), observation({ id: 'first-a' })]
    const secondObservations = [observation({ id: 'second-a' })]
    Object.freeze(firstObservations)
    Object.freeze(secondObservations)
    Object.freeze(bindings)
    Object.freeze(window)

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('first', 'web_analytics', async () => {
        calls.push('first:start')
        await Promise.resolve()
        calls.push('first:end')
        return available(firstObservations)
      }),
      source('second', 'web_analytics', async () => {
        calls.push('second:start')
        return available(secondObservations)
      }),
    ])

    expect(calls).toEqual(['first:start', 'first:end', 'second:start'])
    expect(snapshot.sources.map((entry) => entry.key)).toEqual(['first', 'second'])
    expect(snapshot.observations.map((entry) => entry.id)).toEqual(['first-b', 'first-a', 'second-a'])
    expect(firstObservations.map((entry) => entry.id)).toEqual(['first-b', 'first-a'])
    expect(secondObservations.map((entry) => entry.id)).toEqual(['second-a'])
  })

  it('clones and freezes accepted evidence so later source mutation cannot alter it', async () => {
    const mutableObservation = observation({ id: 'mutable-evidence', value: 7 })
    const sourceObservations = [mutableObservation]

    const snapshot = await collectMarketingSnapshots(env, bindings, window, [
      source('analytics', 'web_analytics', async () => available(sourceObservations)),
    ])

    const mutableEvidence = mutableObservation as { value: number }
    mutableEvidence.value = 99
    sourceObservations.push(observation({ id: 'late-evidence' }))

    expect(snapshot.observations).toEqual([observation({ id: 'mutable-evidence', value: 7 })])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.sources)).toBe(true)
    expect(Object.isFrozen(snapshot.sources[0])).toBe(true)
    expect(Object.isFrozen(snapshot.observations)).toBe(true)
    expect(Object.isFrozen(snapshot.observations[0])).toBe(true)
  })
})
