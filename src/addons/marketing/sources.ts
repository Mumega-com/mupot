import type { Env } from '../../types'
import { resolveConnectorByIdWithMeta } from '../../connectors/service'
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
export const MAX_MARKETING_MONITOR_BINDINGS = 16
export const MAX_MARKETING_MONITOR_SOURCES = 16
const MAX_JS_ARRAY_LENGTH = 2 ** 32 - 1
const INPUT_ENTRY_FAILURE = Symbol('input_entry_failure')

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

function canonicalWindow(input: MonitorWindow): {
  readonly window: MonitorWindow
  readonly bounds: { readonly start: number; readonly end: number }
} | null {
  try {
    if (typeof input !== 'object' || input === null) return null
    const startValue = Reflect.get(input, 'start')
    const endValue = Reflect.get(input, 'end')
    if (!isIsoTimestamp(startValue) || !isIsoTimestamp(endValue)) return null
    const start = Date.parse(startValue)
    const end = Date.parse(endValue)
    if (start > end) return null
    return {
      window: Object.freeze({ start: startValue, end: endValue }),
      bounds: Object.freeze({ start, end }),
    }
  } catch {
    return null
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

interface CapturedInputArray {
  readonly valid: boolean
  readonly entryFailure: boolean
  readonly entries: readonly unknown[]
}

function captureInputArray(input: unknown, maxLength: number): CapturedInputArray {
  try {
    if (!Array.isArray(input)) return { valid: false, entryFailure: false, entries: [] }
    const length = Reflect.get(input, 'length')
    if (!Number.isInteger(length) || length < 0 || length > maxLength) {
      return { valid: false, entryFailure: false, entries: [] }
    }
    const entries: unknown[] = []
    let entryFailure = false
    for (let index = 0; index < length; index += 1) {
      try {
        entries.push(Reflect.get(input, index))
      } catch {
        entryFailure = true
        entries.push(INPUT_ENTRY_FAILURE)
      }
    }
    return { valid: true, entryFailure, entries }
  } catch {
    return { valid: false, entryFailure: false, entries: [] }
  }
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
    || !Object.hasOwn(MARKETING_MONITOR_METRIC_CONTRACT, value.metricKey)
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

function sourceDeclaration(sourceValue: unknown, sourceIndex: number): SourceDeclaration {
  try {
    if ((typeof sourceValue !== 'object' && typeof sourceValue !== 'function') || sourceValue === null) {
      throw new Error('invalid_source_configuration')
    }
    const key = Reflect.get(sourceValue, 'key')
    const slot = Reflect.get(sourceValue, 'slot')
    const read = Reflect.get(sourceValue, 'read')
    if (!isCanonicalSourceKey(key) || !isCanonicalSourceIdentifier(slot) || typeof read !== 'function') {
      throw new Error('invalid_source_configuration')
    }
    const source = sourceValue as MarketingMonitorSource
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

function validatedBindingEntry(bindingValue: unknown): {
  readonly slot: string | null
  readonly entry: BindingEntry
} {
  let slot: unknown = null
  try {
    if ((typeof bindingValue !== 'object' && typeof bindingValue !== 'function') || bindingValue === null) {
      return { slot: null, entry: { valid: false } }
    }
    slot = Reflect.get(bindingValue, 'slot')
    const id = Reflect.get(bindingValue, 'id')
    const adapter = Reflect.get(bindingValue, 'adapter')
    const bindingKind = Reflect.get(bindingValue, 'bindingKind')
    const capability = Reflect.get(bindingValue, 'capability')
    const connectorId = Reflect.get(bindingValue, 'connectorId')
    if (
      typeof slot !== 'string'
      || !Object.hasOwn(MARKETING_MONITOR_BINDING_CONTRACT, slot)
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
        && Object.hasOwn(MARKETING_MONITOR_BINDING_CONTRACT, slot)
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

function freezeLocalArray<T>(values: readonly T[]): readonly T[] {
  const copy: T[] = []
  for (let index = 0; index < values.length; index += 1) copy.push(values[index])
  return Object.freeze(copy)
}

function finalizeCollection(
  runId: string | null,
  rawObservationCount: number,
  sourceStatuses: readonly CollectedSourceStatus[],
  observations: readonly MonitorObservation[],
): MarketingSnapshotCollection {
  const collection = Object.freeze({
    runId,
    rawObservationCount,
    sources: freezeLocalArray(sourceStatuses),
    observations: freezeLocalArray(observations),
  })
  collectedMarketingSnapshots.add(collection)
  return collection
}

function stableSnapshotReason(reason: unknown): string {
  return isNonEmptyString(reason) && STABLE_SOURCE_REASONS.has(reason)
    ? reason
    : 'source_unavailable'
}

async function vaultBindingFailureReason(
  env: Env,
  binding: ResolvedAddonBinding,
): Promise<'connector_not_available' | 'adapter_type_mismatch' | null> {
  if (binding.bindingKind !== 'vault_connector') return null
  const connectorId = binding.connectorId
  if (!connectorId) return 'connector_not_available'
  try {
    const connector = await resolveConnectorByIdWithMeta(env, connectorId)
    if (!connector || connector.id !== connectorId) return 'connector_not_available'
    return connector.type === binding.adapter ? null : 'adapter_type_mismatch'
  } catch {
    return 'connector_not_available'
  }
}

export async function collectMarketingSnapshots(
  env: Env,
  bindings: readonly ResolvedAddonBinding[],
  window: MonitorWindow,
  sources: readonly MarketingMonitorSource[],
): Promise<MarketingSnapshotCollection> {
  const canonical = canonicalWindow(window)
  if (!canonical) throw new Error('invalid_monitor_window')
  const { bounds, window: sourceWindow } = canonical

  const sourceInput = captureInputArray(sources, MAX_MARKETING_MONITOR_SOURCES)
  if (!sourceInput.valid) {
    return finalizeCollection(null, 0, [failedStatus(
      { key: 'source_config_0', slot: 'unconfigured' },
      'invalid_source_configuration',
    )], [])
  }
  const sourceDeclarations: SourceDeclaration[] = []
  for (let index = 0; index < sourceInput.entries.length; index += 1) {
    sourceDeclarations.push(sourceDeclaration(sourceInput.entries[index], index))
  }

  const bindingInput = captureInputArray(bindings, MAX_MARKETING_MONITOR_BINDINGS)
  const bindingInputInvalid = !bindingInput.valid || bindingInput.entryFailure
  const bindingsBySlot = new Map<string, BindingEntry>()
  if (!bindingInputInvalid) {
    for (let index = 0; index < bindingInput.entries.length; index += 1) {
      const validated = validatedBindingEntry(bindingInput.entries[index])
      if (validated.slot === null) continue
      bindingsBySlot.set(validated.slot, bindingsBySlot.has(validated.slot)
        ? { valid: false }
        : validated.entry)
    }
  }

  const sourceKeyCounts = new Map<string, number>()
  for (let index = 0; index < sourceDeclarations.length; index += 1) {
    const declaration = sourceDeclarations[index]
    if (!declaration.valid) continue
    sourceKeyCounts.set(declaration.identity.key, (sourceKeyCounts.get(declaration.identity.key) ?? 0) + 1)
  }
  const emittedDuplicateKeys = new Set<string>()

  const sourceStatuses: CollectedSourceStatus[] = []
  const observations: MonitorObservation[] = []
  const observationIds = new Set<string>()
  let runId: string | null = null
  let rawObservationCount = 0

  for (let sourceIndex = 0; sourceIndex < sourceDeclarations.length; sourceIndex += 1) {
    const declaration = sourceDeclarations[sourceIndex]
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
    if (bindingInputInvalid) {
      sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_binding_configuration'))
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
    const preReadBindingFailure = await vaultBindingFailureReason(env, binding)
    if (preReadBindingFailure) {
      sourceStatuses.push(failedStatus(sourceIdentity, preReadBindingFailure))
      continue
    }

    let snapshot: SourceSnapshot
    try {
      snapshot = await Reflect.apply(readSource, source, [env, binding, sourceWindow])
    } catch {
      sourceStatuses.push(failedStatus(sourceIdentity, 'source_read_failed'))
      continue
    }

    try {
      if (!snapshot || typeof snapshot !== 'object') {
        sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }
      const sourceObservations = Reflect.get(snapshot, 'observations')
      if (!Array.isArray(sourceObservations)) {
        sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }
      const sourceObservationCount = Reflect.get(sourceObservations, 'length')
      if (
        !Number.isInteger(sourceObservationCount)
        || sourceObservationCount < 0
        || sourceObservationCount > MAX_JS_ARRAY_LENGTH
      ) {
        sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }
      rawObservationCount += sourceObservationCount

      if (sourceObservationCount > MAX_OBSERVATIONS_PER_SOURCE) {
        sourceStatuses.push(failedStatus(sourceIdentity, 'source_observation_limit_exceeded'))
        continue
      }

      if (rawObservationCount > MAX_OBSERVATIONS_PER_RUN) {
        sourceStatuses.push(failedStatus(sourceIdentity, 'run_observation_limit_exceeded'))
        continue
      }

      const snapshotStatus = Reflect.get(snapshot, 'status')
      if (snapshotStatus === 'unavailable') {
        sourceStatuses.push(sourceObservationCount === 0
          ? unavailableStatus(sourceIdentity, stableSnapshotReason(Reflect.get(snapshot, 'reason')))
          : failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }

      if (snapshotStatus === 'failed') {
        sourceStatuses.push(sourceObservationCount === 0
          ? failedStatus(sourceIdentity, stableSnapshotReason(Reflect.get(snapshot, 'reason')))
          : failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }

      if (snapshotStatus !== 'available') {
        sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }

      const postReadBindingFailure = await vaultBindingFailureReason(env, binding)
      if (postReadBindingFailure) {
        sourceStatuses.push(failedStatus(sourceIdentity, postReadBindingFailure))
        continue
      }

      const copiedObservations: unknown[] = []
      for (let index = 0; index < sourceObservationCount; index += 1) {
        copiedObservations.push(Reflect.get(sourceObservations, index))
      }
      const clonedObservations: unknown[] = []
      let observationFailure: ObservationFailureReason | null = null
      for (let index = 0; index < copiedObservations.length; index += 1) {
        const cloned = cloneObservationValue(copiedObservations[index])
        const failure = observationFailureReason(cloned, bounds, bindingAuthority)
        if (failure) {
          observationFailure = failure
          break
        }
        clonedObservations.push(cloned)
      }
      if (observationFailure) {
        sourceStatuses.push(failedStatus(sourceIdentity, observationFailure))
        continue
      }
      const acceptedSourceObservations = clonedObservations as MonitorObservation[]

      const sourceIds = new Set<string>()
      let duplicateId = false
      for (let index = 0; index < acceptedSourceObservations.length; index += 1) {
        const observation = acceptedSourceObservations[index]
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

      const sourceRunId = acceptedSourceObservations[0]?.runId ?? null
      let sourceRunMismatch = false
      for (let index = 1; index < acceptedSourceObservations.length; index += 1) {
        if (acceptedSourceObservations[index].runId !== sourceRunId) {
          sourceRunMismatch = true
          break
        }
      }
      if (sourceRunMismatch || (sourceRunId !== null && runId !== null && sourceRunId !== runId)) {
        sourceStatuses.push(failedStatus(sourceIdentity, 'run_id_mismatch'))
        continue
      }

      for (let index = 0; index < acceptedSourceObservations.length; index += 1) {
        const observation = acceptedSourceObservations[index]
        observations.push(observation)
        observationIds.add(observation.id)
      }
      if (runId === null && sourceRunId !== null) runId = sourceRunId
      sourceStatuses.push(Object.freeze({
        key: sourceIdentity.key,
        slot: sourceIdentity.slot,
        status: 'available',
        observationCount: sourceObservationCount,
      }))
    } catch {
      sourceStatuses.push(failedStatus(sourceIdentity, 'invalid_source_snapshot'))
    }
  }

  return finalizeCollection(runId, rawObservationCount, sourceStatuses, observations)
}
