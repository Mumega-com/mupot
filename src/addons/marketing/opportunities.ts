import {
  deriveContentChannelSignals,
  deriveSeoChannelSignals,
  type ContentChannelSignal,
  type SeoChannelSignal,
} from './outcomes'
import type { MarketingMonitorRun, OutcomeValue } from './types'

export type MarketingOpportunityKind =
  | 'conversion_review'
  | 'revenue_review'
  | 'lead_generation_review'
  | 'organic_traffic_review'
  | 'ai_visibility_review'
  | 'content_review'

export type MarketingOpportunityKpi = keyof MarketingMonitorRun['outcomes']

export interface LimitingMarketingEvidence {
  readonly outcome: MarketingOpportunityKpi
  readonly status: 'unavailable'
  readonly reason: string
}

export interface MarketingOpportunityCandidate {
  readonly rank: number
  readonly kind: MarketingOpportunityKind
  readonly target: string
  readonly problem: string
  readonly hypothesis: string
  readonly primaryKpi: MarketingOpportunityKpi
  readonly kpiBaseline: OutcomeValue
  readonly limitingEvidence: readonly LimitingMarketingEvidence[]
}

const CANDIDATES: ReadonlyArray<{
  readonly kind: MarketingOpportunityKind
  readonly target: string
  readonly primaryKpi: MarketingOpportunityKpi
  readonly label: string
}> = [
  {
    kind: 'conversion_review',
    target: 'resource:web-ops/conversion-funnel',
    primaryKpi: 'conversion',
    label: 'conversion',
  },
  {
    kind: 'revenue_review',
    target: 'resource:web-ops/revenue-path',
    primaryKpi: 'revenue',
    label: 'attributable revenue',
  },
  {
    kind: 'lead_generation_review',
    target: 'resource:web-ops/lead-capture',
    primaryKpi: 'leads',
    label: 'lead generation',
  },
  {
    kind: 'organic_traffic_review',
    target: 'resource:web-ops/organic-acquisition',
    primaryKpi: 'qualifiedTraffic',
    label: 'qualified traffic',
  },
  {
    kind: 'ai_visibility_review',
    target: 'resource:web-ops/ai-visibility',
    primaryKpi: 'visibility',
    label: 'AI visibility',
  },
  {
    kind: 'content_review',
    target: 'resource:content/publish-cadence',
    primaryKpi: 'content',
    label: 'content publish cadence',
  },
]

const OUTCOME_ORDER: readonly MarketingOpportunityKpi[] = [
  'visibility',
  'qualifiedTraffic',
  'leads',
  'conversion',
  'revenue',
  'content',
]

function unavailableEvidence(run: MarketingMonitorRun): LimitingMarketingEvidence[] {
  const limiting: LimitingMarketingEvidence[] = []
  for (const outcome of OUTCOME_ORDER) {
    const value = run.outcomes[outcome]
    if (value.status === 'unavailable') {
      limiting.push(Object.freeze({ outcome, status: 'unavailable', reason: value.reason }))
    }
  }
  return limiting
}

function baselineSummary(value: Extract<OutcomeValue, { status: 'available' }>): string {
  return `${value.value} ${value.unit} from ${value.source}`
}

function latestKeywordGapFromObservations(run: MarketingMonitorRun): OutcomeValue {
  let matching: (typeof run.observations)[number] | undefined
  for (let index = 0; index < run.observations.length; index += 1) {
    const observation = run.observations[index]
    if (observation.metricKey !== 'seo.keyword_gap_queries') continue
    if (observation.authority !== 'first-party' && observation.authority !== 'gsc') continue
    if (
      matching === undefined
      || observation.observedAt > matching.observedAt
      || (observation.observedAt === matching.observedAt && observation.id > matching.id)
    ) matching = observation
  }
  if (!matching) {
    return Object.freeze({ status: 'unavailable', reason: 'authoritative_source_missing' })
  }
  return Object.freeze({
    status: 'available',
    value: matching.value,
    unit: matching.unit,
    source: matching.authority,
    observedAt: matching.observedAt,
  })
}

function seoChannelCandidate(
  signal: SeoChannelSignal,
  limitingEvidence: readonly LimitingMarketingEvidence[],
): MarketingOpportunityCandidate {
  if (signal.kind === 'keyword_gap') {
    const gapDetail = signal.reason === 'search_queries_without_ranking_url'
      ? `${signal.measuredGap} search queries with impressions lack a ranking URL`
      : `organic lead capture is ${(signal.measuredGap * 100).toFixed(1)}% of sessions (below the SEO channel ceiling)`
    return Object.freeze({
      rank: 1,
      kind: 'organic_traffic_review',
      target: 'resource:seo/keyword-gap',
      problem: `SEO keyword gap: ${baselineSummary(signal.traffic)} arrives while ${gapDetail}; the evidence does not establish an approved content coverage action.`,
      hypothesis: 'A human-reviewed keyword-gap proposal for the SEO channel can prioritize missing query coverage without any external publish or connector write before approval.',
      primaryKpi: signal.primaryKpi,
      kpiBaseline: Object.freeze({ ...signal.traffic }),
      limitingEvidence,
    })
  }

  return Object.freeze({
    rank: 1,
    kind: 'organic_traffic_review',
    target: 'resource:seo/content-candidate',
    problem: `SEO content candidate: ${baselineSummary(signal.traffic)} converts at ${baselineSummary(signal.supporting)}; the page set under-converts organic intent and no approved content change exists.`,
    hypothesis: 'A human-reviewed SEO content-candidate proposal can improve the measured organic conversion baseline without any external change before approval.',
    primaryKpi: signal.primaryKpi,
    kpiBaseline: Object.freeze({ ...signal.supporting }),
    limitingEvidence,
  })
}

function contentChannelCandidate(
  signal: ContentChannelSignal,
  limitingEvidence: readonly LimitingMarketingEvidence[],
): MarketingOpportunityCandidate {
  return Object.freeze({
    rank: 1,
    kind: 'content_review',
    target: 'resource:content/publish-cadence',
    problem: `Content channel: ${baselineSummary(signal.content)} publishes in the evidence window (${signal.reason}); the surface is bound but no approved content proposal exists.`,
    hypothesis: 'A human-reviewed content publish-cadence proposal can restore channel output without any external write before approval.',
    primaryKpi: signal.primaryKpi,
    kpiBaseline: Object.freeze({ ...signal.content }),
    limitingEvidence,
  })
}

/**
 * Rank at most one bounded opportunity.
 * Priority: SEO-channel signals → content-channel cadence → generic outcome reviews.
 */
export function rankMarketingOpportunities(
  run: MarketingMonitorRun,
): readonly MarketingOpportunityCandidate[] {
  if (run.status !== 'completed') return Object.freeze([])
  const limitingEvidence = Object.freeze(unavailableEvidence(run))

  const seoSignals = deriveSeoChannelSignals(
    run.outcomes,
    latestKeywordGapFromObservations(run),
  )
  if (seoSignals.length > 0) {
    return Object.freeze([seoChannelCandidate(seoSignals[0], limitingEvidence)])
  }

  const contentSignals = deriveContentChannelSignals(run.outcomes)
  if (contentSignals.length > 0) {
    return Object.freeze([contentChannelCandidate(contentSignals[0], limitingEvidence)])
  }

  for (let index = 0; index < CANDIDATES.length; index += 1) {
    const definition = CANDIDATES[index]
    const baseline = run.outcomes[definition.primaryKpi]
    if (baseline.status !== 'available') continue
    return Object.freeze([Object.freeze({
      rank: index + 1,
      kind: definition.kind,
      target: definition.target,
      problem: `The latest ${definition.label} baseline is ${baselineSummary(baseline)}; the evidence does not establish an approved improvement action.`,
      hypothesis: `A human-reviewed website experiment targeted at ${definition.label} can improve the measured baseline without any external change before approval.`,
      primaryKpi: definition.primaryKpi,
      kpiBaseline: Object.freeze({ ...baseline }),
      limitingEvidence,
    })])
  }
  return Object.freeze([])
}
