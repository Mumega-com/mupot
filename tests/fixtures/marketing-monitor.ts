import type {
  MarketingMonitorSource,
  MonitorWindow,
  ResolvedAddonBinding,
  SourceSnapshot,
} from '../../src/addons/marketing/types'

export interface MarketingMonitorFixtureInput {
  readonly runId: string
  readonly observedAt: string
  readonly window: MonitorWindow
}

export function createMarketingMonitorFixtureSource(
  input: MarketingMonitorFixtureInput,
): MarketingMonitorSource {
  const observations = [
    ['seo.ai_citations', 8, 'count'],
    ['seo.organic_sessions', 240, 'count'],
    ['growth.leads', 12, 'count'],
    ['growth.replies', 3, 'count'],
    ['seo.conversion_rate', 0.05, 'ratio'],
  ] as const

  return {
    key: 'first_party_fixture',
    slot: 'web_analytics',
    async read(_env: unknown, _binding: ResolvedAddonBinding, window: MonitorWindow): Promise<SourceSnapshot> {
      if (window.start !== input.window.start || window.end !== input.window.end) {
        return { status: 'unavailable', reason: 'window_mismatch', observations: [] }
      }
      return {
        status: 'available',
        observations: observations.map(([metricKey, value, unit]) => ({
          id: `${input.runId}:${metricKey}`,
          runId: input.runId,
          metricKey,
          value,
          unit,
          authority: 'first-party',
          observedAt: input.observedAt,
        })),
      }
    },
  }
}
