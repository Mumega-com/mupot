import type { Env } from '../../types'
import {
  MARKETING_MONITOR_ADAPTER_AUTHORITIES,
  MARKETING_MONITOR_METRIC_CONTRACT,
  type CollectedSourceStatus,
  type MarketingMonitorMetricKey,
  type MarketingMonitorSource,
  type MarketingSnapshotCollection,
  type MonitorObservation,
  type MonitorWindow,
  type ResolvedAddonBinding,
  type SourceSnapshot,
} from './types'

export const MAX_OBSERVATIONS_PER_SOURCE = 100
export const MAX_OBSERVATIONS_PER_RUN = 200

const STABLE_SOURCE_REASONS = new Set([
  'authoritative_source_missing',
  'binding_not_configured',
  'connector_not_configured',
  'connector_revoked',
  'source_unavailable',
  'window_mismatch',
])

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(timestamp).toISOString() === value
}

function windowBounds(window: MonitorWindow): { start: number; end: number } | null {
  if (!isIsoTimestamp(window.start) || !isIsoTimestamp(window.end)) return null
  const start = Date.parse(window.start)
  const end = Date.parse(window.end)
  return start <= end ? { start, end } : null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function cloneObservationValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const observation = value as Record<string, unknown>
  return Object.freeze({
    id: observation.id,
    runId: observation.runId,
    metricKey: observation.metricKey,
    value: observation.value,
    unit: observation.unit,
    authority: observation.authority,
    observedAt: observation.observedAt,
  })
}

type ObservationFailureReason =
  | 'invalid_observation'
  | 'observation_authority_mismatch'
  | 'metric_authority_not_allowed'

function observationFailureReason(
  observation: unknown,
  bounds: { start: number; end: number },
  bindingAuthority: string,
): ObservationFailureReason | null {
  if (typeof observation !== 'object' || observation === null || Array.isArray(observation)) return 'invalid_observation'
  const value = observation as Record<string, unknown>
  if (
    !isNonEmptyString(value.id)
    || !isNonEmptyString(value.runId)
    || !isNonEmptyString(value.metricKey)
    || !Object.prototype.hasOwnProperty.call(MARKETING_MONITOR_METRIC_CONTRACT, value.metricKey)
    || typeof value.value !== 'number'
    || !Number.isFinite(value.value)
    || !isNonEmptyString(value.unit)
    || !isNonEmptyString(value.authority)
    || !isIsoTimestamp(value.observedAt)
  ) return 'invalid_observation'

  const observedAt = Date.parse(value.observedAt)
  if (observedAt < bounds.start || observedAt > bounds.end) return 'invalid_observation'
  if (value.authority !== bindingAuthority) return 'observation_authority_mismatch'

  const metric = MARKETING_MONITOR_METRIC_CONTRACT[value.metricKey as MarketingMonitorMetricKey]
  return (metric.authorities as readonly string[]).includes(bindingAuthority)
    ? null
    : 'metric_authority_not_allowed'
}

function failedStatus(
  source: MarketingMonitorSource,
  reason: string,
): CollectedSourceStatus {
  return Object.freeze({
    key: source.key,
    slot: source.slot,
    status: 'failed',
    reason,
    observationCount: 0,
  })
}

function unavailableStatus(source: MarketingMonitorSource, reason: string): CollectedSourceStatus {
  return Object.freeze({
    key: source.key,
    slot: source.slot,
    status: 'unavailable',
    reason,
    observationCount: 0,
  })
}

function stableSnapshotReason(snapshot: SourceSnapshot): string {
  return isNonEmptyString(snapshot.reason) && STABLE_SOURCE_REASONS.has(snapshot.reason)
    ? snapshot.reason
    : 'source_unavailable'
}

export async function collectMarketingSnapshots(
  env: Env,
  bindings: readonly ResolvedAddonBinding[],
  window: MonitorWindow,
  sources: readonly MarketingMonitorSource[],
): Promise<MarketingSnapshotCollection> {
  const bounds = windowBounds(window)
  if (!bounds) throw new Error('invalid_monitor_window')

  const bindingsBySlot = new Map<string, ResolvedAddonBinding>()
  for (const binding of bindings) {
    if (!bindingsBySlot.has(binding.slot)) bindingsBySlot.set(binding.slot, binding)
  }

  const sourceStatuses: CollectedSourceStatus[] = []
  const observations: MonitorObservation[] = []
  const observationIds = new Set<string>()
  let runId: string | null = null

  for (const source of sources) {
    const binding = bindingsBySlot.get(source.slot)
    if (!binding) {
      sourceStatuses.push(unavailableStatus(source, 'binding_not_configured'))
      continue
    }
    const bindingAuthority = MARKETING_MONITOR_ADAPTER_AUTHORITIES[
      binding.adapter as keyof typeof MARKETING_MONITOR_ADAPTER_AUTHORITIES
    ]
    if (!bindingAuthority) {
      sourceStatuses.push(failedStatus(source, 'binding_adapter_not_supported'))
      continue
    }

    let snapshot: SourceSnapshot
    try {
      snapshot = await source.read(env, binding, window)
    } catch {
      sourceStatuses.push(failedStatus(source, 'source_read_failed'))
      continue
    }

    try {
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.observations)) {
        sourceStatuses.push(failedStatus(source, 'invalid_source_snapshot'))
        continue
      }
      const sourceObservations = snapshot.observations

      if (sourceObservations.length > MAX_OBSERVATIONS_PER_SOURCE) {
        sourceStatuses.push(failedStatus(source, 'source_observation_limit_exceeded'))
        continue
      }

      if (observations.length + sourceObservations.length > MAX_OBSERVATIONS_PER_RUN) {
        sourceStatuses.push(failedStatus(source, 'run_observation_limit_exceeded'))
        continue
      }

      if (snapshot.status === 'unavailable') {
        sourceStatuses.push(sourceObservations.length === 0
          ? unavailableStatus(source, stableSnapshotReason(snapshot))
          : failedStatus(source, 'invalid_source_snapshot'))
        continue
      }

      if (snapshot.status === 'failed') {
        sourceStatuses.push(sourceObservations.length === 0
          ? failedStatus(source, stableSnapshotReason(snapshot))
          : failedStatus(source, 'invalid_source_snapshot'))
        continue
      }

      if (snapshot.status !== 'available') {
        sourceStatuses.push(failedStatus(source, 'invalid_source_snapshot'))
        continue
      }

      const clonedObservations = sourceObservations.map(cloneObservationValue)
      const observationFailure = clonedObservations
        .map((observation) => observationFailureReason(observation, bounds, bindingAuthority))
        .find((reason) => reason !== null)
      if (observationFailure) {
        sourceStatuses.push(failedStatus(source, observationFailure))
        continue
      }
      const acceptedSourceObservations = clonedObservations as MonitorObservation[]

      const sourceIds = new Set<string>()
      let duplicateId = false
      for (const observation of acceptedSourceObservations) {
        if (sourceIds.has(observation.id) || observationIds.has(observation.id)) {
          duplicateId = true
          break
        }
        sourceIds.add(observation.id)
      }
      if (duplicateId) {
        sourceStatuses.push(failedStatus(source, 'duplicate_observation_id'))
        continue
      }

      const sourceRunIds = new Set(acceptedSourceObservations.map((observation) => observation.runId))
      const sourceRunId = acceptedSourceObservations[0]?.runId ?? null
      if (sourceRunIds.size > 1 || (sourceRunId !== null && runId !== null && sourceRunId !== runId)) {
        sourceStatuses.push(failedStatus(source, 'run_id_mismatch'))
        continue
      }

      observations.push(...acceptedSourceObservations)
      for (const id of sourceIds) observationIds.add(id)
      if (runId === null && sourceRunId !== null) runId = sourceRunId
      sourceStatuses.push(Object.freeze({
        key: source.key,
        slot: source.slot,
        status: 'available',
        observationCount: sourceObservations.length,
      }))
    } catch {
      sourceStatuses.push(failedStatus(source, 'invalid_source_snapshot'))
    }
  }

  return Object.freeze({
    runId,
    sources: Object.freeze([...sourceStatuses]),
    observations: Object.freeze([...observations]),
  })
}
