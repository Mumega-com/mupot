import {
  MARKETING_MONITOR_METRIC_CONTRACT,
  type MarketingMonitorMetricKey,
  type MarketingOutcomes,
  type MarketingSnapshotCollection,
  type MonitorObservation,
  type OutcomeValue,
} from './types'
import { isCollectedMarketingSnapshot } from './sources'
import { freezeIntrinsic, includesIntrinsic } from './intrinsics'

const OUTCOME_METRICS = {
  visibility: 'seo.ai_citations',
  qualifiedTraffic: 'seo.organic_sessions',
  leads: 'growth.leads',
  conversion: 'seo.conversion_rate',
  revenue: 'finance.revenue',
  content: 'content.posts_published',
} as const

/** Lead capture rate below this (leads / organic sessions) suggests a keyword-gap review. */
export const SEO_KEYWORD_GAP_LEAD_RATE_CEILING = 0.1

/** Conversion rate below this with organic traffic suggests an SEO content candidate. */
export const SEO_CONTENT_CANDIDATE_CONVERSION_CEILING = 0.1

export type SeoChannelSignalKind = 'keyword_gap' | 'content_candidate'

export interface SeoChannelSignal {
  readonly kind: SeoChannelSignalKind
  readonly primaryKpi: 'qualifiedTraffic' | 'conversion'
  readonly traffic: Extract<OutcomeValue, { status: 'available' }>
  readonly supporting: Extract<OutcomeValue, { status: 'available' }>
  readonly measuredGap: number
  readonly reason: string
}

export type ContentChannelSignalKind = 'publish_cadence'

export interface ContentChannelSignal {
  readonly kind: ContentChannelSignalKind
  readonly primaryKpi: 'content'
  readonly content: Extract<OutcomeValue, { status: 'available' }>
  readonly reason: string
}

function unavailable(): OutcomeValue {
  return freezeIntrinsic({ status: 'unavailable', reason: 'authoritative_source_missing' })
}

function outcomeFor(
  observations: readonly MonitorObservation[],
  metricKey: MarketingMonitorMetricKey,
): OutcomeValue {
  let matching: MonitorObservation | undefined
  const authorities = MARKETING_MONITOR_METRIC_CONTRACT[metricKey].authorities as readonly string[]
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]
    if (
      observation.metricKey === metricKey
      && includesIntrinsic(authorities, observation.authority)
      && (
        matching === undefined
        || observation.observedAt > matching.observedAt
        || (observation.observedAt === matching.observedAt && observation.id > matching.id)
      )
    ) matching = observation
  }
  if (!matching) return unavailable()
  return freezeIntrinsic({
    status: 'available',
    value: matching.value,
    unit: matching.unit,
    source: matching.authority,
    observedAt: matching.observedAt,
  })
}

/**
 * Latest authoritative keyword-gap query count from the normalized snapshot.
 * Returns unavailable when no GSC/first-party observation exists — never zero-fills.
 */
export function keywordGapQueryOutcome(
  collection: MarketingSnapshotCollection,
): OutcomeValue {
  if (!isCollectedMarketingSnapshot(collection)) {
    throw new Error('unnormalized_marketing_snapshot')
  }
  return outcomeFor(collection.observations, 'seo.keyword_gap_queries')
}

/**
 * Derive SEO-channel recommendation signals from available outcomes (and optional
 * keyword-gap query evidence). Pure: does not mutate inputs; at most one signal
 * is returned, preferring explicit keyword-gap query evidence over funnel proxies.
 */
export function deriveSeoChannelSignals(
  outcomes: MarketingOutcomes,
  keywordGapQueries: OutcomeValue,
): readonly SeoChannelSignal[] {
  if (keywordGapQueries.status === 'available' && keywordGapQueries.value > 0) {
    const traffic = outcomes.qualifiedTraffic
    if (traffic.status === 'available') {
      return freezeIntrinsic([freezeIntrinsic({
        kind: 'keyword_gap' as const,
        primaryKpi: 'qualifiedTraffic' as const,
        traffic: freezeIntrinsic({ ...traffic }),
        supporting: freezeIntrinsic({ ...keywordGapQueries }),
        measuredGap: keywordGapQueries.value,
        reason: 'search_queries_without_ranking_url',
      })])
    }
  }

  const traffic = outcomes.qualifiedTraffic
  const leads = outcomes.leads
  if (
    traffic.status === 'available'
    && traffic.value > 0
    && leads.status === 'available'
  ) {
    const leadRate = leads.value / traffic.value
    if (leadRate < SEO_KEYWORD_GAP_LEAD_RATE_CEILING) {
      return freezeIntrinsic([freezeIntrinsic({
        kind: 'keyword_gap' as const,
        primaryKpi: 'qualifiedTraffic' as const,
        traffic: freezeIntrinsic({ ...traffic }),
        supporting: freezeIntrinsic({ ...leads }),
        measuredGap: leadRate,
        reason: 'organic_lead_capture_below_ceiling',
      })])
    }
  }

  const conversion = outcomes.conversion
  if (
    traffic.status === 'available'
    && traffic.value > 0
    && conversion.status === 'available'
    && conversion.value < SEO_CONTENT_CANDIDATE_CONVERSION_CEILING
  ) {
    return freezeIntrinsic([freezeIntrinsic({
      kind: 'content_candidate' as const,
      primaryKpi: 'conversion' as const,
      traffic: freezeIntrinsic({ ...traffic }),
      supporting: freezeIntrinsic({ ...conversion }),
      measuredGap: conversion.value,
      reason: 'organic_conversion_below_ceiling',
    })])
  }

  return freezeIntrinsic([])
}

/**
 * Content-channel signal from content_surface cadence. Zero publishes in-window with
 * an available content outcome is a bounded review candidate (propose-not-mutate).
 */
export function deriveContentChannelSignals(
  outcomes: MarketingOutcomes,
): readonly ContentChannelSignal[] {
  const content = outcomes.content
  if (content.status === 'available' && content.value === 0) {
    return freezeIntrinsic([freezeIntrinsic({
      kind: 'publish_cadence' as const,
      primaryKpi: 'content' as const,
      content: freezeIntrinsic({ ...content }),
      reason: 'no_posts_published_in_window',
    })])
  }
  return freezeIntrinsic([])
}

export function deriveMarketingOutcomes(
  collection: MarketingSnapshotCollection,
): MarketingOutcomes {
  if (!isCollectedMarketingSnapshot(collection)) {
    throw new Error('unnormalized_marketing_snapshot')
  }
  const observations = collection.observations
  return freezeIntrinsic({
    visibility: outcomeFor(observations, OUTCOME_METRICS.visibility),
    qualifiedTraffic: outcomeFor(observations, OUTCOME_METRICS.qualifiedTraffic),
    leads: outcomeFor(observations, OUTCOME_METRICS.leads),
    conversion: outcomeFor(observations, OUTCOME_METRICS.conversion),
    revenue: outcomeFor(observations, OUTCOME_METRICS.revenue),
    content: outcomeFor(observations, OUTCOME_METRICS.content),
  })
}
