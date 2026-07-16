import type { Env } from '../../types'
import {
  MARKETING_MONITOR_ADAPTER_AUTHORITIES,
  MARKETING_MONITOR_BINDING_CONTRACT,
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

const collectedMarketingSnapshots = new WeakSet<object>()

export function isCollectedMarketingSnapshot(value: unknown): value is MarketingSnapshotCollection {
  return typeof value === 'object'
    && value !== null
    && collectedMarketingSnapshots.has(value)
}

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
  | 'observation_unit_mismatch'

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
  if (!(metric.authorities as readonly string[]).includes(bindingAuthority)) {
    return 'metric_authority_not_allowed'
  }
  return value.unit === metric.unit ? null : 'observation_unit_mismatch'
}

interface SourceIdentity {
  readonly key: string
  readonly slot: string
}

type SourceDeclaration =
  | {
      readonly valid: true
      readonly source: MarketingMonitorSource
      readonly identity: SourceIdentity
      readonly read: MarketingMonitorSource['read']
    }
  | {
      readonly valid: false
      readonly identity: SourceIdentity
    }

function isCanonicalSourceIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
}

function isCanonicalSourceKey(value: unknown): value is string {
  return isCanonicalSourceIdentifier(value) && !value.startsWith('source_config_')
}

function sourceDeclaration(source: MarketingMonitorSource, sourceIndex: number): SourceDeclaration {
  try {
    const key = source.key
    const slot = source.slot
    const read = source.read
    if (!isCanonicalSourceKey(key) || !isCanonicalSourceIdentifier(slot) || typeof read !== 'function') {
      throw new Error('invalid_source_configuration')
    }
    return { valid: true, source, identity: { key, slot }, read }
  } catch {
    return {
      valid: false,
      identity: { key: `source_config_${sourceIndex}`, slot: 'unconfigured' },
    }
  }
}

type BindingEntry =
  | { readonly valid: true; readonly binding: ResolvedAddonBinding }
  | { readonly valid: false }

function validatedBindingEntry(binding: ResolvedAddonBinding): {
  readonly slot: string | null
  readonly entry: BindingEntry
} {
  let slot: unknown = null
  try {
    slot = binding.slot
    const id = binding.id
    const adapter = binding.adapter
    const bindingKind = binding.bindingKind
    const capability = binding.capability
    const connectorId = binding.connectorId
    if (
      typeof slot !== 'string'
      || !Object.prototype.hasOwnProperty.call(MARKETING_MONITOR_BINDING_CONTRACT, slot)
    ) return { slot: null, entry: { valid: false } }

    const slotContract = MARKETING_MONITOR_BINDING_CONTRACT[
      slot as keyof typeof MARKETING_MONITOR_BINDING_CONTRACT
    ] as Readonly<Record<string, Readonly<{
      capability: 'read'
      bindingKind: 'internal_adapter' | 'vault_connector'
      connectorId: 'null' | 'required'
    }>>>
    const rule = slotContract[adapter]
    const validConnector = rule?.connectorId === 'null'
      ? connectorId === null
      : isNonEmptyString(connectorId)
    if (
      !isNonEmptyString(id)
      || capability !== 'read'
      || !rule
      || bindingKind !== rule.bindingKind
      || !validConnector
    ) return { slot, entry: { valid: false } }

    return {
      slot,
      entry: {
        valid: true,
        binding: Object.freeze({ id, slot, adapter, bindingKind, capability, connectorId }),
      },
    }
  } catch {
    return {
      slot: typeof slot === 'string'
        && Object.prototype.hasOwnProperty.call(MARKETING_MONITOR_BINDING_CONTRACT, slot)
        ? slot
        : null,
      entry: { valid: false },
    }
  }
}

function failedStatus(
  source: SourceIdentity,
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

function unavailableStatus(source: SourceIdentity, reason: string): CollectedSourceStatus {
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

  const bindingsBySlot = new Map<string, BindingEntry>()
  for (const binding of bindings) {
    const validated = validatedBindingEntry(binding)
    if (validated.slot === null) continue
    bindingsBySlot.set(validated.slot, bindingsBySlot.has(validated.slot)
      ? { valid: false }
      : validated.entry)
  }

  const sourceDeclarations = sources.map(sourceDeclaration)
  const sourceKeyCounts = new Map<string, number>()
  for (const declaration of sourceDeclarations) {
    if (!declaration.valid) continue
    sourceKeyCounts.set(declaration.identity.key, (sourceKeyCounts.get(declaration.identity.key) ?? 0) + 1)
  }
  const emittedDuplicateKeys = new Set<string>()

  const sourceStatuses: CollectedSourceStatus[] = []
  const observations: MonitorObservation[] = []
  const observationIds = new Set<string>()
  let runId: string | null = null
  let rawObservationCount = 0

  for (const declaration of sourceDeclarations) {
    const sourceIdentity = declaration.identity
    if (!declaration.valid) {
      sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_source_configuration'))
      continue
    }
    if ((sourceKeyCounts.get(sourceIdentity.key) ?? 0) > 1) {
      if (!emittedDuplicateKeys.has(sourceIdentity.key)) {
        emittedDuplicateKeys.add(sourceIdentity.key)
        sourceStatuses.push(failedStatus(sourceIdentity, 'duplicate_source_identity'))
      }
      continue
    }
    const source = declaration.source
    const readSource = declaration.read

    if (rawObservationCount > MAX_OBSERVATIONS_PER_RUN) {
      sourceStatuses.push(failedStatus(sourceIdentity, 'run_observation_limit_exceeded'))
      continue
    }

    const bindingEntry = bindingsBySlot.get(sourceIdentity.slot)
    if (!bindingEntry) {
      sourceStatuses.push(unavailableStatus(sourceIdentity, 'binding_not_configured'))
      continue
    }
    if (!bindingEntry.valid) {
      sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_binding_configuration'))
      continue
    }
    const binding = bindingEntry.binding
    const bindingAuthority = MARKETING_MONITOR_ADAPTER_AUTHORITIES[
      binding.adapter as keyof typeof MARKETING_MONITOR_ADAPTER_AUTHORITIES
    ]
    if (!bindingAuthority) {
      sourceStatuses.push(failedStatus(sourceIdentity, 'binding_adapter_not_supported'))
      continue
    }

    let snapshot: SourceSnapshot
    try {
      snapshot = await readSource.call(source, env, binding, window)
    } catch {
      sourceStatuses.push(failedStatus(sourceIdentity, 'source_read_failed'))
      continue
    }

    try {
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.observations)) {
        sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }
      const sourceObservations = snapshot.observations
      rawObservationCount += sourceObservations.length

      if (sourceObservations.length > MAX_OBSERVATIONS_PER_SOURCE) {
        sourceStatuses.push(failedStatus(sourceIdentity, 'source_observation_limit_exceeded'))
        continue
      }

      if (rawObservationCount > MAX_OBSERVATIONS_PER_RUN) {
        sourceStatuses.push(failedStatus(sourceIdentity, 'run_observation_limit_exceeded'))
        continue
      }

      if (snapshot.status === 'unavailable') {
        sourceStatuses.push(sourceObservations.length === 0
          ? unavailableStatus(sourceIdentity, stableSnapshotReason(snapshot))
          : failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }

      if (snapshot.status === 'failed') {
        sourceStatuses.push(sourceObservations.length === 0
          ? failedStatus(sourceIdentity, stableSnapshotReason(snapshot))
          : failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }

      if (snapshot.status !== 'available') {
        sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }

      const clonedObservations = sourceObservations.map(cloneObservationValue)
      const observationFailure = clonedObservations
        .map((observation) => observationFailureReason(observation, bounds, bindingAuthority))
        .find((reason) => reason !== null)
      if (observationFailure) {
        sourceStatuses.push(failedStatus(sourceIdentity, observationFailure))
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
        sourceStatuses.push(failedStatus(sourceIdentity, 'duplicate_observation_id'))
        continue
      }

      const sourceRunIds = new Set(acceptedSourceObservations.map((observation) => observation.runId))
      const sourceRunId = acceptedSourceObservations[0]?.runId ?? null
      if (sourceRunIds.size > 1 || (sourceRunId !== null && runId !== null && sourceRunId !== runId)) {
        sourceStatuses.push(failedStatus(sourceIdentity, 'run_id_mismatch'))
        continue
      }

      observations.push(...acceptedSourceObservations)
      for (const id of sourceIds) observationIds.add(id)
      if (runId === null && sourceRunId !== null) runId = sourceRunId
      sourceStatuses.push(Object.freeze({
        key: sourceIdentity.key,
        slot: sourceIdentity.slot,
        status: 'available',
        observationCount: sourceObservations.length,
      }))
    } catch {
      sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_source_snapshot'))
    }
  }

  const collection = Object.freeze({
    runId,
    rawObservationCount,
    sources: Object.freeze([...sourceStatuses]),
    observations: Object.freeze([...observations]),
  })
  collectedMarketingSnapshots.add(collection)
  return collection
}
