import { describe, expect, it } from 'vitest'
import { createMarketingMonitorFixtureSource } from './fixtures/marketing-monitor'
import { collectMarketingSnapshots, MAX_OBSERVATIONS_PER_RUN, MAX_OBSERVATIONS_PER_SOURCE } from '../src/addons/marketing/sources'
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

function observation(overrides: Partial<MonitorObservation> = {}): MonitorObservation {
  return {
    id: 'evidence-1',
    runId: 'run-1',
    metricKey: 'seo.ai_citations',
    value: 1,
    unit: 'count',
    authority: 'first-party',
    observedAt: '2026-07-16T12:00:00.000Z',
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
  it('keeps healthy source evidence when an optional source fails', async () => {
    const healthyFixture = createMarketingMonitorFixtureSource({
      runId: 'run-1',
      observedAt: '2026-07-16T12:00:00.000Z',
      window,
    })
    const failingFixture = source('content', 'content_surface', async () => {
      throw new Error('upstream token=secret should never escape')
    })

    const snapshot = await collectMarketingSnapshots(env, [
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

    expect(snapshot.observations).toEqual([observation({ id: 'evidence-2' })])
    expect(snapshot.sources).toEqual([
      { key: 'analytics', slot: 'web_analytics', status: 'failed', reason: 'source_read_failed', observationCount: 0 },
      { key: 'second', slot: 'web_analytics', status: 'available', observationCount: 1 },
    ])
    expect(JSON.stringify(snapshot)).not.toContain('top-secret')
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
    expect(snapshot.observations).toEqual([observation({ id: 'healthy-evidence' })])
    expect(JSON.stringify(snapshot)).not.toContain('secret')
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
    expect(snapshot.observations).toEqual([observation({ id: 'global-id' })])
    expect(snapshot.sources[1]).toMatchObject({
      status: 'failed',
      reason: 'duplicate_observation_id',
      observationCount: 0,
    })
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
    expect(snapshot.observations).toEqual([observation({ id: 'first-id' })])
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

  it('rejects monitor windows that omit canonical millisecond precision', async () => {
    await expect(collectMarketingSnapshots(env, bindings, {
      start: '2026-07-16T00:00:00Z',
      end: '2026-07-16T23:59:59.999Z',
    }, [])).rejects.toThrow('invalid_monitor_window')
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
