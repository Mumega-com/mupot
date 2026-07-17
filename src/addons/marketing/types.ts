import type { Env } from '../../types'

export const MARKETING_MONITOR_ADAPTER_AUTHORITIES = Object.freeze({
  first_party: 'first-party',
  posthog: 'posthog',
  google_search_console: 'gsc',
  ghl: 'ghl',
  crm: 'crm',
  mcpwp: 'mcpwp',
  inkwell: 'inkwell',
  ai_visibility: 'ai_visibility',
} as const)

export type MarketingMonitorAuthority =
  (typeof MARKETING_MONITOR_ADAPTER_AUTHORITIES)[keyof typeof MARKETING_MONITOR_ADAPTER_AUTHORITIES]

const internalBinding = () => Object.freeze({
  capability: 'read',
  bindingKind: 'internal_adapter',
  connectorId: 'null',
} as const)

const vaultBinding = () => Object.freeze({
  capability: 'read',
  bindingKind: 'vault_connector',
  connectorId: 'required',
} as const)

export const MARKETING_MONITOR_BINDING_CONTRACT = Object.freeze({
  web_analytics: Object.freeze({
    first_party: internalBinding(),
    posthog: vaultBinding(),
  }),
  content_surface: Object.freeze({
    inkwell: vaultBinding(),
    mcpwp: vaultBinding(),
  }),
  search_performance: Object.freeze({
    google_search_console: vaultBinding(),
  }),
  crm: Object.freeze({
    ghl: vaultBinding(),
    crm: vaultBinding(),
  }),
} as const)

export const MARKETING_MONITOR_METRIC_CONTRACT = Object.freeze({
  'seo.ai_citations': Object.freeze({
    unit: 'count',
    authorities: Object.freeze(['first-party', 'ai_visibility'] as const),
  }),
  'seo.organic_sessions': Object.freeze({
    unit: 'count',
    authorities: Object.freeze(['first-party', 'posthog'] as const),
  }),
  'growth.leads': Object.freeze({
    unit: 'count',
    authorities: Object.freeze(['first-party', 'ghl', 'crm'] as const),
  }),
  'growth.replies': Object.freeze({
    unit: 'count',
    authorities: Object.freeze(['first-party', 'ghl', 'crm'] as const),
  }),
  'seo.conversion_rate': Object.freeze({
    unit: 'ratio',
    authorities: Object.freeze(['first-party', 'posthog'] as const),
  }),
  'finance.revenue': Object.freeze({
    unit: 'usd',
    authorities: Object.freeze(['ghl', 'crm'] as const),
  }),
} as const)

export type MarketingMonitorMetricKey = keyof typeof MARKETING_MONITOR_METRIC_CONTRACT

export const MARKETING_MONITOR_METRIC_KEYS = Object.freeze(
  Object.keys(MARKETING_MONITOR_METRIC_CONTRACT) as MarketingMonitorMetricKey[],
)

export interface MonitorWindow {
  readonly start: string
  readonly end: string
}

/**
 * The source-facing binding intentionally contains only safe routing metadata.
 * Connector secrets and raw connector rows must be resolved behind an adapter boundary.
 */
export interface ResolvedAddonBinding {
  readonly id: string
  readonly slot: string
  readonly adapter: string
  readonly bindingKind: 'internal_adapter' | 'vault_connector'
  readonly capability: 'read'
  readonly connectorId: string | null
}

export interface SourceObservation {
  readonly id: string
  readonly runId: string
  readonly metricKey: MarketingMonitorMetricKey
  readonly value: number
  readonly unit: string
  readonly authority: string
  readonly observedAt: string
}

export interface MonitorObservation extends SourceObservation {
  readonly sourceKey: string
  readonly sourceSlot: string
}

export type SourceStatus = 'available' | 'unavailable' | 'failed'

export interface SourceSnapshot {
  readonly status: SourceStatus
  readonly observations: readonly SourceObservation[]
  readonly reason?: string
}

export interface MarketingMonitorSource {
  readonly key: string
  readonly slot: string
  read(env: Env, binding: ResolvedAddonBinding, window: MonitorWindow): Promise<SourceSnapshot>
}

export interface CollectedSourceStatus {
  readonly key: string
  readonly slot: string
  readonly status: SourceStatus
  readonly reason?: string
  readonly observationCount: number
}

export interface MarketingSnapshotCollection {
  readonly runId: string | null
  readonly rawObservationCount: number
  readonly sources: readonly CollectedSourceStatus[]
  readonly observations: readonly MonitorObservation[]
}

export type OutcomeValue =
  | { readonly status: 'available'; readonly value: number; readonly unit: string; readonly source: string; readonly observedAt: string }
  | { readonly status: 'unavailable'; readonly reason: string }

export interface MarketingOutcomes {
  readonly visibility: OutcomeValue
  readonly qualifiedTraffic: OutcomeValue
  readonly leads: OutcomeValue
  readonly conversion: OutcomeValue
  readonly revenue: OutcomeValue
}

export interface MarketingMonitorRunSource {
  readonly key: string
  readonly slot: string
  readonly status: SourceStatus
  readonly reason?: string
  readonly observationCount: number
}

export interface MarketingMonitorRun {
  readonly id: string
  readonly programVersion: string
  readonly status: 'completed'
  readonly window: MonitorWindow
  readonly sourceCount: number
  readonly observationCount: number
  readonly rawObservationCount: number
  readonly sources: readonly MarketingMonitorRunSource[]
  readonly observations: readonly MonitorObservation[]
  readonly outcomes: MarketingOutcomes
  readonly evidenceDigest: string
  readonly createdAt: string
  readonly completedAt: string
}
