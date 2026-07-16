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
    authority: 'first_party',
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
})
