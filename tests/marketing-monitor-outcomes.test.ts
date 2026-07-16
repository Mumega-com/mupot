import { describe, expect, it } from 'vitest'
import { createMarketingMonitorFixtureSource } from './fixtures/marketing-monitor'
import { deriveMarketingOutcomes } from '../src/addons/marketing/outcomes'
import type { MonitorObservation, MonitorWindow, ResolvedAddonBinding } from '../src/addons/marketing/types'
import type { Env } from '../src/types'

const env = { TENANT_SLUG: 'tenant-a' } as Env
const window: MonitorWindow = {
  start: '2026-07-16T00:00:00.000Z',
  end: '2026-07-16T23:59:59.999Z',
}
const binding: ResolvedAddonBinding = {
  id: 'binding-web-analytics',
  slot: 'web_analytics',
  adapter: 'first_party',
  bindingKind: 'internal_adapter',
  capability: 'read',
  connectorId: null,
}

async function fixtureObservations(): Promise<readonly MonitorObservation[]> {
  const source = createMarketingMonitorFixtureSource({
    runId: 'run-1',
    observedAt: '2026-07-16T12:00:00.000Z',
    window,
  })
  const snapshot = await source.read(env, binding, window)
  return snapshot.observations
}

describe('deriveMarketingOutcomes', () => {
  it('maps the five fixture metrics to available outcomes without fabricating revenue', async () => {
    const outcomes = deriveMarketingOutcomes(await fixtureObservations())

    expect(outcomes.visibility).toMatchObject({ status: 'available', value: 8, unit: 'count', source: 'first-party' })
    expect(outcomes.qualifiedTraffic).toMatchObject({ status: 'available', value: 240, unit: 'count', source: 'first-party' })
    expect(outcomes.leads).toMatchObject({ status: 'available', value: 12, unit: 'count', source: 'first-party' })
    expect(outcomes.conversion).toMatchObject({ status: 'available', value: 0.05, unit: 'ratio', source: 'first-party' })
    expect(outcomes.revenue).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
  })

  it('does not render missing revenue as zero', () => {
    const outcomes = deriveMarketingOutcomes([])

    expect(outcomes.revenue).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
    expect(outcomes.revenue).not.toMatchObject({ value: 0 })
    expect(outcomes.visibility).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
  })

  it('does not mutate or convert an absent authoritative metric to zero', () => {
    const observations: MonitorObservation[] = [{
      id: 'evidence-visibility',
      runId: 'run-1',
      metricKey: 'seo.ai_citations',
      value: 0,
      unit: 'count',
      authority: 'first-party',
      observedAt: '2026-07-16T12:00:00.000Z',
    }]
    Object.freeze(observations)

    const outcomes = deriveMarketingOutcomes(observations)

    expect(outcomes.visibility).toMatchObject({ status: 'available', value: 0 })
    expect(outcomes.revenue).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
    expect(observations).toHaveLength(1)
    expect(observations[0].metricKey).toBe('seo.ai_citations')
  })

  it('does not use revenue evidence from a non-authoritative source', () => {
    const outcomes = deriveMarketingOutcomes([{
      id: 'evidence-revenue',
      runId: 'run-1',
      metricKey: 'finance.revenue' as MonitorObservation['metricKey'],
      value: 500,
      unit: 'usd',
      authority: 'first-party',
      observedAt: '2026-07-16T12:00:00.000Z',
    }])

    expect(outcomes.revenue).toEqual({ status: 'unavailable', reason: 'authoritative_source_missing' })
  })

  it('uses finance revenue from a supported CRM authority', () => {
    const outcomes = deriveMarketingOutcomes([{
      id: 'evidence-revenue',
      runId: 'run-1',
      metricKey: 'finance.revenue' as MonitorObservation['metricKey'],
      value: 500,
      unit: 'usd',
      authority: 'ghl',
      observedAt: '2026-07-16T12:00:00.000Z',
    }])

    expect(outcomes.revenue).toEqual({
      status: 'available',
      value: 500,
      unit: 'usd',
      source: 'ghl',
      observedAt: '2026-07-16T12:00:00.000Z',
    })
  })

  it('selects the latest observedAt instead of the last input observation', () => {
    const outcomes = deriveMarketingOutcomes([
      {
        id: 'latest-evidence',
        runId: 'run-1',
        metricKey: 'seo.ai_citations',
        value: 9,
        unit: 'count',
        authority: 'first-party',
        observedAt: '2026-07-16T18:00:00.000Z',
      },
      {
        id: 'older-evidence',
        runId: 'run-1',
        metricKey: 'seo.ai_citations',
        value: 2,
        unit: 'count',
        authority: 'first-party',
        observedAt: '2026-07-16T08:00:00.000Z',
      },
    ])

    expect(outcomes.visibility).toMatchObject({ value: 9, observedAt: '2026-07-16T18:00:00.000Z' })
  })

  it('breaks equal observedAt ties by greatest observation ID', () => {
    const outcomes = deriveMarketingOutcomes([
      {
        id: 'z-evidence',
        runId: 'run-1',
        metricKey: 'seo.ai_citations',
        value: 9,
        unit: 'count',
        authority: 'first-party',
        observedAt: '2026-07-16T12:00:00.000Z',
      },
      {
        id: 'a-evidence',
        runId: 'run-1',
        metricKey: 'seo.ai_citations',
        value: 2,
        unit: 'count',
        authority: 'first-party',
        observedAt: '2026-07-16T12:00:00.000Z',
      },
    ])

    expect(outcomes.visibility).toMatchObject({ value: 9, observedAt: '2026-07-16T12:00:00.000Z' })
  })
})
