import { firstPartyCroSource } from '../../../cro/first-party'
import {
  MARKETING_MONITOR_METRIC_CONTRACT,
  type MarketingMonitorMetricKey,
  type MarketingMonitorSource,
  type SourceObservation,
} from '../types'

const FIRST_PARTY_AUTHORITY = 'first-party'
const MAX_OBSERVATIONS = 100

function isMarketingMetricKey(value: string): value is MarketingMonitorMetricKey {
  return Object.prototype.hasOwnProperty.call(MARKETING_MONITOR_METRIC_CONTRACT, value)
}

export function createFirstPartyMarketingSource(runId: string): MarketingMonitorSource {
  return {
    key: 'first_party',
    slot: 'web_analytics',
    async read(env, _binding, window) {
      const points = await firstPartyCroSource.collect(env)
      const start = Date.parse(window.start)
      const end = Date.parse(window.end)
      const observations: SourceObservation[] = []

      for (let index = 0; index < points.length && observations.length < MAX_OBSERVATIONS; index += 1) {
        const point = points[index]
        if (!isMarketingMetricKey(point.metric_key)) continue
        const observedAt = Date.parse(point.occurred_at)
        if (!Number.isFinite(observedAt) || observedAt < start || observedAt > end) continue
        const contract = MARKETING_MONITOR_METRIC_CONTRACT[point.metric_key]
        if (!(contract.authorities as readonly string[]).includes(FIRST_PARTY_AUTHORITY)) continue
        observations.push({
          id: `${runId}:first_party:${index}`,
          runId,
          metricKey: point.metric_key,
          value: point.value,
          unit: contract.unit,
          authority: FIRST_PARTY_AUTHORITY,
          observedAt: point.occurred_at,
        })
      }

      return { status: 'available', observations }
    },
  }
}
