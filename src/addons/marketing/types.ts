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

export const MARKETING_MONITOR_METRIC_CONTRACT = Object.freeze({
  'seo.ai_citations': Object.freeze({
    authorities: Object.freeze(['first-party', 'ai_visibility'] as const),
  }),
  'seo.organic_sessions': Object.freeze({
    authorities: Object.freeze(['first-party', 'posthog'] as const),
  }),
  'growth.leads': Object.freeze({
    authorities: Object.freeze(['first-party', 'ghl', 'crm'] as const),
  }),
  'growth.replies': Object.freeze({
    authorities: Object.freeze(['first-party', 'ghl', 'crm'] as const),
  }),
  'seo.conversion_rate': Object.freeze({
    authorities: Object.freeze(['first-party', 'posthog'] as const),
  }),
  'finance.revenue': Object.freeze({
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

export interface MonitorObservation {
  readonly id: string
  readonly runId: string
  readonly metricKey: MarketingMonitorMetricKey
  readonly value: number
  readonly unit: string
  readonly authority: string
  readonly observedAt: string
}

export type SourceStatus = 'available' | 'unavailable' | 'failed'

export interface SourceSnapshot {
  readonly status: SourceStatus
  readonly observations: readonly MonitorObservation[]
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
