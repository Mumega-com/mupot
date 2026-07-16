import type { MarketingOutcomes, MonitorObservation, OutcomeValue } from './types'

const OUTCOME_METRICS = {
  visibility: 'seo.ai_citations',
  qualifiedTraffic: 'seo.organic_sessions',
  leads: 'growth.leads',
  conversion: 'seo.conversion_rate',
  revenue: 'growth.revenue',
} as const

const REVENUE_AUTHORITIES = new Set(['commerce', 'crm', 'ghl', 'stripe'])

function unavailable(): OutcomeValue {
  return { status: 'unavailable', reason: 'authoritative_source_missing' }
}

function outcomeFor(
  observations: readonly MonitorObservation[],
  metricKey: string,
): OutcomeValue {
  let matching: MonitorObservation | undefined
  for (const observation of observations) {
    if (
      observation.metricKey === metricKey
      && (metricKey !== OUTCOME_METRICS.revenue || REVENUE_AUTHORITIES.has(observation.authority))
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
  observations: readonly MonitorObservation[],
): MarketingOutcomes {
  return {
    visibility: outcomeFor(observations, OUTCOME_METRICS.visibility),
    qualifiedTraffic: outcomeFor(observations, OUTCOME_METRICS.qualifiedTraffic),
    leads: outcomeFor(observations, OUTCOME_METRICS.leads),
    conversion: outcomeFor(observations, OUTCOME_METRICS.conversion),
    revenue: outcomeFor(observations, OUTCOME_METRICS.revenue),
  }
}
