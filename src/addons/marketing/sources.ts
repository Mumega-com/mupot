import type { Env } from '../../types'
import {
  MARKETING_MONITOR_METRIC_KEYS,
  type CollectedSourceStatus,
  type MarketingMonitorSource,
  type MarketingSnapshotCollection,
  type MonitorObservation,
  type MonitorWindow,
  type ResolvedAddonBinding,
  type SourceSnapshot,
} from './types'

export const MAX_OBSERVATIONS_PER_SOURCE = 100
export const MAX_OBSERVATIONS_PER_RUN = 200

const DECLARED_METRIC_KEYS = new Set<string>(MARKETING_MONITOR_METRIC_KEYS)
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
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z')
  return new Date(timestamp).toISOString() === canonical
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

function validObservation(observation: unknown, bounds: { start: number; end: number }): observation is MonitorObservation {
  if (typeof observation !== 'object' || observation === null || Array.isArray(observation)) return false
  const value = observation as Record<string, unknown>
  if (
    !isNonEmptyString(value.id)
    || !isNonEmptyString(value.runId)
    || !isNonEmptyString(value.metricKey)
    || !DECLARED_METRIC_KEYS.has(value.metricKey)
    || typeof value.value !== 'number'
    || !Number.isFinite(value.value)
    || !isNonEmptyString(value.unit)
    || !isNonEmptyString(value.authority)
    || !isIsoTimestamp(value.observedAt)
  ) return false

  const observedAt = Date.parse(value.observedAt)
  return observedAt >= bounds.start && observedAt <= bounds.end
}

function failedStatus(
  source: MarketingMonitorSource,
  reason: string,
): CollectedSourceStatus {
  return {
    key: source.key,
    slot: source.slot,
    status: 'failed',
    reason,
    observationCount: 0,
  }
}

function unavailableStatus(source: MarketingMonitorSource, reason: string): CollectedSourceStatus {
  return {
    key: source.key,
    slot: source.slot,
    status: 'unavailable',
    reason,
    observationCount: 0,
  }
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

  for (const source of sources) {
    const binding = bindingsBySlot.get(source.slot)
    if (!binding) {
      sourceStatuses.push(unavailableStatus(source, 'binding_not_configured'))
      continue
    }

    let snapshot: SourceSnapshot
    try {
      snapshot = await source.read(env, binding, window)
    } catch {
      sourceStatuses.push(failedStatus(source, 'source_read_failed'))
      continue
    }

    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.observations)) {
      sourceStatuses.push(failedStatus(source, 'invalid_source_snapshot'))
      continue
    }

    if (snapshot.status === 'unavailable') {
      sourceStatuses.push(unavailableStatus(source, stableSnapshotReason(snapshot)))
      continue
    }

    if (snapshot.status === 'failed') {
      sourceStatuses.push(failedStatus(source, stableSnapshotReason(snapshot)))
      continue
    }

    if (snapshot.status !== 'available') {
      sourceStatuses.push(failedStatus(source, 'invalid_source_snapshot'))
      continue
    }

    if (snapshot.observations.length > MAX_OBSERVATIONS_PER_SOURCE) {
      sourceStatuses.push(failedStatus(source, 'source_observation_limit_exceeded'))
      continue
    }

    if (!snapshot.observations.every((observation) => validObservation(observation, bounds))) {
      sourceStatuses.push(failedStatus(source, 'invalid_observation'))
      continue
    }

    if (observations.length + snapshot.observations.length > MAX_OBSERVATIONS_PER_RUN) {
      sourceStatuses.push(failedStatus(source, 'run_observation_limit_exceeded'))
      continue
    }

    observations.push(...snapshot.observations)
    sourceStatuses.push({
      key: source.key,
      slot: source.slot,
      status: 'available',
      observationCount: snapshot.observations.length,
    })
  }

  return {
    sources: sourceStatuses,
    observations,
  }
}
