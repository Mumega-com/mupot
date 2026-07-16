import {
  MARKETING_MONITOR_METRIC_CONTRACT,
  type MarketingMonitorMetricKey,
  type MarketingOutcomes,
  type MarketingSnapshotCollection,
  type MonitorObservation,
  type OutcomeValue,
} from './types'
import { isCollectedMarketingSnapshot } from './sources'

const OUTCOME_METRICS = {
  visibility: 'seo.ai_citations',
  qualifiedTraffic: 'seo.organic_sessions',
  leads: 'growth.leads',
  conversion: 'seo.conversion_rate',
  revenue: 'finance.revenue',
} as const

function unavailable(): OutcomeValue {
  return { status: 'unavailable', reason: 'authoritative_source_missing' }
}

function outcomeFor(
  observations: readonly MonitorObservation[],
  metricKey: MarketingMonitorMetricKey,
): OutcomeValue {
  let matching: MonitorObservation | undefined
  const authorities = MARKETING_MONITOR_METRIC_CONTRACT[metricKey].authorities as readonly string[]
  for (const observation of observations) {
    if (
      observation.metricKey === metricKey
      && authorities.includes(observation.authority)
      && (
        matching === undefined
        || observation.observedAt > matching.observedAt
        || (observation.observedAt === matching.observedAt && observation.id > matching.id)
      )
    ) matching = observation
  }
  if (!matching) return unavailable()
  return {
    status: 'available',
    value: matching.value,
    unit: matching.unit,
    source: matching.authority,
    observedAt: matching.observedAt,
  }
}

export function deriveMarketingOutcomes(
  collection: MarketingSnapshotCollection,
): MarketingOutcomes {
  if (!isCollectedMarketingSnapshot(collection)) {
    throw new Error('unnormalized_marketing_snapshot')
  }
  const observations = collection.observations
  return {
    visibility: outcomeFor(observations, OUTCOME_METRICS.visibility),
    qualifiedTraffic: outcomeFor(observations, OUTCOME_METRICS.qualifiedTraffic),
    leads: outcomeFor(observations, OUTCOME_METRICS.leads),
    conversion: outcomeFor(observations, OUTCOME_METRICS.conversion),
    revenue: outcomeFor(observations, OUTCOME_METRICS.revenue),
  }
}
