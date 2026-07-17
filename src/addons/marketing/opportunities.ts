import type { MarketingMonitorRun, OutcomeValue } from './types'

export type MarketingOpportunityKind =
  | 'conversion_review'
  | 'revenue_review'
  | 'lead_generation_review'
  | 'organic_traffic_review'
  | 'ai_visibility_review'

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
]

const OUTCOME_ORDER: readonly MarketingOpportunityKpi[] = [
  'visibility',
  'qualifiedTraffic',
  'leads',
  'conversion',
  'revenue',
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

export function rankMarketingOpportunities(
  run: MarketingMonitorRun,
): readonly MarketingOpportunityCandidate[] {
  if (run.status !== 'completed') return Object.freeze([])
  const limitingEvidence = Object.freeze(unavailableEvidence(run))
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
