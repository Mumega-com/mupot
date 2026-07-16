import type { Env } from '../../types'
import { resolveConnectorByIdWithMeta } from '../../connectors/service'
import {
  applyIntrinsic,
  createMap,
  createSet,
  createWeakSet,
  dateToISOStringIntrinsic,
  freezeIntrinsic,
  getIntrinsic,
  hasOwnIntrinsic,
  includesIntrinsic,
  isArrayIntrinsic,
  isFiniteIntrinsic,
  isIntegerIntrinsic,
  mapGetIntrinsic,
  mapHasIntrinsic,
  mapSetIntrinsic,
  parseDateIntrinsic,
  pushIntrinsic,
  setAddIntrinsic,
  setHasIntrinsic,
  startsWithIntrinsic,
  testIntrinsic,
  trimIntrinsic,
  weakSetAddIntrinsic,
  weakSetHasIntrinsic,
} from './intrinsics'
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

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SOURCE_IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/
const collectedMarketingSnapshots = createWeakSet<object>()

export function isCollectedMarketingSnapshot(value: unknown): value is MarketingSnapshotCollection {
  return typeof value === 'object'
    && value !== null
    && weakSetHasIntrinsic(collectedMarketingSnapshots, value)
}

const STABLE_SOURCE_REASONS = createSet<string>()
setAddIntrinsic(STABLE_SOURCE_REASONS, 'authoritative_source_missing')
setAddIntrinsic(STABLE_SOURCE_REASONS, 'binding_not_configured')
setAddIntrinsic(STABLE_SOURCE_REASONS, 'connector_not_configured')
setAddIntrinsic(STABLE_SOURCE_REASONS, 'connector_revoked')
setAddIntrinsic(STABLE_SOURCE_REASONS, 'source_unavailable')
setAddIntrinsic(STABLE_SOURCE_REASONS, 'window_mismatch')

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || trimIntrinsic(value) === '') return false
  const timestamp = parseDateIntrinsic(value)
  return isFiniteIntrinsic(timestamp)
    && testIntrinsic(ISO_TIMESTAMP, value)
    && dateToISOStringIntrinsic(timestamp) === value
}

function canonicalWindow(input: MonitorWindow): {
  readonly window: MonitorWindow
  readonly bounds: { readonly start: number; readonly end: number }
} | null {
  try {
    if (typeof input !== 'object' || input === null) return null
    const startValue = getIntrinsic(input, 'start')
    const endValue = getIntrinsic(input, 'end')
    if (!isIsoTimestamp(startValue) || !isIsoTimestamp(endValue)) return null
    const start = parseDateIntrinsic(startValue)
    const end = parseDateIntrinsic(endValue)
    if (start > end) return null
    return {
      window: freezeIntrinsic({ start: startValue, end: endValue }),
      bounds: freezeIntrinsic({ start, end }),
    }
  } catch {
    return null
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && trimIntrinsic(value).length > 0
}

interface CapturedInputArray {
  readonly valid: boolean
  readonly entryFailure: boolean
  readonly entries: readonly unknown[]
}

function captureInputArray(input: unknown, maxLength: number): CapturedInputArray {
  try {
    if (!isArrayIntrinsic(input)) return { valid: false, entryFailure: false, entries: [] }
    const length = getIntrinsic(input, 'length')
    if (!isIntegerIntrinsic(length) || (length as number) < 0 || (length as number) > maxLength) {
      return { valid: false, entryFailure: false, entries: [] }
    }
    const entries: unknown[] = []
    let entryFailure = false
    for (let index = 0; index < (length as number); index += 1) {
      try {
        pushIntrinsic(entries, getIntrinsic(input, index))
      } catch {
        entryFailure = true
        pushIntrinsic(entries, INPUT_ENTRY_FAILURE)
      }
    }
    return { valid: true, entryFailure, entries }
  } catch {
    return { valid: false, entryFailure: false, entries: [] }
  }
}

function cloneObservationValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || isArrayIntrinsic(value)) return value
  const observation = value as Record<string, unknown>
  return freezeIntrinsic({
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
  if (typeof observation !== 'object' || observation === null || isArrayIntrinsic(observation)) return 'invalid_observation'
  const value = observation as Record<string, unknown>
  if (
    !isNonEmptyString(value.id)
    || !isNonEmptyString(value.runId)
    || !isNonEmptyString(value.metricKey)
    || !hasOwnIntrinsic(MARKETING_MONITOR_METRIC_CONTRACT, value.metricKey)
    || typeof value.value !== 'number'
    || !isFiniteIntrinsic(value.value)
    || !isNonEmptyString(value.unit)
    || !isNonEmptyString(value.authority)
    || !isIsoTimestamp(value.observedAt)
  ) return 'invalid_observation'

  const observedAt = parseDateIntrinsic(value.observedAt)
  if (observedAt < bounds.start || observedAt > bounds.end) return 'invalid_observation'
  if (value.authority !== bindingAuthority) return 'observation_authority_mismatch'

  const metric = MARKETING_MONITOR_METRIC_CONTRACT[value.metricKey as MarketingMonitorMetricKey]
  if (!includesIntrinsic(metric.authorities as readonly string[], bindingAuthority)) {
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
  return typeof value === 'string' && testIntrinsic(SOURCE_IDENTIFIER, value)
}

function isCanonicalSourceKey(value: unknown): value is string {
  return isCanonicalSourceIdentifier(value) && !startsWithIntrinsic(value, 'source_config_')
}

function sourceDeclaration(sourceValue: unknown, sourceIndex: number): SourceDeclaration {
  try {
    if ((typeof sourceValue !== 'object' && typeof sourceValue !== 'function') || sourceValue === null) {
      throw new Error('invalid_source_configuration')
    }
    const key = getIntrinsic(sourceValue, 'key')
    const slot = getIntrinsic(sourceValue, 'slot')
    const read = getIntrinsic(sourceValue, 'read')
    if (!isCanonicalSourceKey(key) || !isCanonicalSourceIdentifier(slot) || typeof read !== 'function') {
      throw new Error('invalid_source_configuration')
    }
    const source = sourceValue as MarketingMonitorSource
    return {
      valid: true,
      source,
      identity: { key, slot },
      read: read as MarketingMonitorSource['read'],
    }
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
    slot = getIntrinsic(bindingValue, 'slot')
    const id = getIntrinsic(bindingValue, 'id')
    const adapter = getIntrinsic(bindingValue, 'adapter')
    const bindingKind = getIntrinsic(bindingValue, 'bindingKind')
    const capability = getIntrinsic(bindingValue, 'capability')
    const connectorId = getIntrinsic(bindingValue, 'connectorId')
    if (
      !isNonEmptyString(slot)
      || !hasOwnIntrinsic(MARKETING_MONITOR_BINDING_CONTRACT, slot)
    ) return { slot: null, entry: { valid: false } }

    const slotContract = MARKETING_MONITOR_BINDING_CONTRACT[
      slot as keyof typeof MARKETING_MONITOR_BINDING_CONTRACT
    ] as Readonly<Record<string, Readonly<{
      capability: 'read'
      bindingKind: 'internal_adapter' | 'vault_connector'
      connectorId: 'null' | 'required'
    }>>>
    if (!isNonEmptyString(adapter) || !hasOwnIntrinsic(slotContract, adapter)) {
      return { slot, entry: { valid: false } }
    }
    const rule = slotContract[adapter]
    const validConnector = rule?.connectorId === 'null'
      ? connectorId === null
      : isNonEmptyString(connectorId)
    if (
      !isNonEmptyString(id)
      || !isNonEmptyString(bindingKind)
      || !isNonEmptyString(capability)
      || capability !== 'read'
      || bindingKind !== rule.bindingKind
      || !validConnector
    ) return { slot, entry: { valid: false } }
    const normalizedConnectorId = rule.connectorId === 'null'
      ? null
      : connectorId as string

    return {
      slot,
      entry: {
        valid: true,
        binding: freezeIntrinsic({
          id,
          slot,
          adapter,
          bindingKind,
          capability,
          connectorId: normalizedConnectorId,
        }),
      },
    }
  } catch {
    return {
      slot: typeof slot === 'string'
        && hasOwnIntrinsic(MARKETING_MONITOR_BINDING_CONTRACT, slot)
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
  return freezeIntrinsic({
    key: source.key,
    slot: source.slot,
    status: 'failed',
    reason,
    observationCount: 0,
  })
}

function unavailableStatus(source: SourceIdentity, reason: string): CollectedSourceStatus {
  return freezeIntrinsic({
    key: source.key,
    slot: source.slot,
    status: 'unavailable',
    reason,
    observationCount: 0,
  })
}

function freezeLocalArray<T>(values: readonly T[]): readonly T[] {
  const copy: T[] = []
  for (let index = 0; index < values.length; index += 1) pushIntrinsic(copy, values[index])
  return freezeIntrinsic(copy)
}

function finalizeCollection(
  runId: string | null,
  rawObservationCount: number,
  sourceStatuses: readonly CollectedSourceStatus[],
  observations: readonly MonitorObservation[],
): MarketingSnapshotCollection {
  const collection = freezeIntrinsic({
    runId,
    rawObservationCount,
    sources: freezeLocalArray(sourceStatuses),
    observations: freezeLocalArray(observations),
  })
  weakSetAddIntrinsic(collectedMarketingSnapshots, collection)
  return collection
}

function stableSnapshotReason(reason: unknown): string {
  return isNonEmptyString(reason) && setHasIntrinsic(STABLE_SOURCE_REASONS, reason)
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
    pushIntrinsic(sourceDeclarations, sourceDeclaration(sourceInput.entries[index], index))
  }

  const bindingInput = captureInputArray(bindings, MAX_MARKETING_MONITOR_BINDINGS)
  const bindingInputInvalid = !bindingInput.valid || bindingInput.entryFailure
  const bindingsBySlot = createMap<string, BindingEntry>()
  if (!bindingInputInvalid) {
    for (let index = 0; index < bindingInput.entries.length; index += 1) {
      const validated = validatedBindingEntry(bindingInput.entries[index])
      if (validated.slot === null) continue
      mapSetIntrinsic(bindingsBySlot, validated.slot, mapHasIntrinsic(bindingsBySlot, validated.slot)
        ? { valid: false }
        : validated.entry)
    }
  }

  const sourceKeyCounts = createMap<string, number>()
  for (let index = 0; index < sourceDeclarations.length; index += 1) {
    const declaration = sourceDeclarations[index]
    if (!declaration.valid) continue
    mapSetIntrinsic(
      sourceKeyCounts,
      declaration.identity.key,
      (mapGetIntrinsic(sourceKeyCounts, declaration.identity.key) ?? 0) + 1,
    )
  }
  const emittedDuplicateKeys = createSet<string>()

  const sourceStatuses: CollectedSourceStatus[] = []
  const observations: MonitorObservation[] = []
  const observationIds = createSet<string>()
  let runId: string | null = null
  let rawObservationCount = 0

  for (let sourceIndex = 0; sourceIndex < sourceDeclarations.length; sourceIndex += 1) {
    const declaration = sourceDeclarations[sourceIndex]
    const sourceIdentity = declaration.identity
    if (!declaration.valid) {
      pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'invalid_source_configuration'))
      continue
    }
    if ((mapGetIntrinsic(sourceKeyCounts, sourceIdentity.key) ?? 0) > 1) {
      if (!setHasIntrinsic(emittedDuplicateKeys, sourceIdentity.key)) {
        setAddIntrinsic(emittedDuplicateKeys, sourceIdentity.key)
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'duplicate_source_identity'))
      }
      continue
    }
    if (bindingInputInvalid) {
      pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'invalid_binding_configuration'))
      continue
    }
    const source = declaration.source
    const readSource = declaration.read

    if (rawObservationCount > MAX_OBSERVATIONS_PER_RUN) {
      pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'run_observation_limit_exceeded'))
      continue
    }

    const bindingEntry = mapGetIntrinsic(bindingsBySlot, sourceIdentity.slot)
    if (!bindingEntry) {
      pushIntrinsic(sourceStatuses, unavailableStatus(sourceIdentity, 'binding_not_configured'))
      continue
    }
    if (!bindingEntry.valid) {
      pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'invalid_binding_configuration'))
      continue
    }
    const binding = bindingEntry.binding
    const bindingAuthority = MARKETING_MONITOR_ADAPTER_AUTHORITIES[
      binding.adapter as keyof typeof MARKETING_MONITOR_ADAPTER_AUTHORITIES
    ]
    if (!bindingAuthority) {
      pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'binding_adapter_not_supported'))
      continue
    }
    const preReadBindingFailure = await vaultBindingFailureReason(env, binding)
    if (preReadBindingFailure) {
      pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, preReadBindingFailure))
      continue
    }

    let snapshot: SourceSnapshot
    try {
      snapshot = await applyIntrinsic(readSource, source, [env, binding, sourceWindow])
    } catch {
      pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'source_read_failed'))
      continue
    }

    try {
      if (!snapshot || typeof snapshot !== 'object') {
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }
      const sourceObservations = getIntrinsic(snapshot, 'observations')
      if (!isArrayIntrinsic(sourceObservations)) {
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }
      const sourceObservationCount = getIntrinsic(sourceObservations, 'length')
      if (
        !isIntegerIntrinsic(sourceObservationCount)
        || (sourceObservationCount as number) < 0
        || (sourceObservationCount as number) > MAX_JS_ARRAY_LENGTH
      ) {
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }
      const acceptedSourceObservationCount = sourceObservationCount as number
      rawObservationCount += acceptedSourceObservationCount

      if (acceptedSourceObservationCount > MAX_OBSERVATIONS_PER_SOURCE) {
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'source_observation_limit_exceeded'))
        continue
      }

      if (rawObservationCount > MAX_OBSERVATIONS_PER_RUN) {
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'run_observation_limit_exceeded'))
        continue
      }

      const snapshotStatus = getIntrinsic(snapshot, 'status')
      if (snapshotStatus === 'unavailable') {
        pushIntrinsic(sourceStatuses, acceptedSourceObservationCount === 0
          ? unavailableStatus(sourceIdentity, stableSnapshotReason(getIntrinsic(snapshot, 'reason')))
          : failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }

      if (snapshotStatus === 'failed') {
        pushIntrinsic(sourceStatuses, acceptedSourceObservationCount === 0
          ? failedStatus(sourceIdentity, stableSnapshotReason(getIntrinsic(snapshot, 'reason')))
          : failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }

      if (snapshotStatus !== 'available') {
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'invalid_source_snapshot'))
        continue
      }

      const copiedObservations: unknown[] = []
      for (let index = 0; index < acceptedSourceObservationCount; index += 1) {
        pushIntrinsic(copiedObservations, getIntrinsic(sourceObservations, index))
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
        pushIntrinsic(clonedObservations, cloned)
      }
      if (observationFailure) {
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, observationFailure))
        continue
      }
      const acceptedSourceObservations = clonedObservations as MonitorObservation[]

      const sourceIds = createSet<string>()
      let duplicateId = false
      for (let index = 0; index < acceptedSourceObservations.length; index += 1) {
        const observation = acceptedSourceObservations[index]
        if (setHasIntrinsic(sourceIds, observation.id) || setHasIntrinsic(observationIds, observation.id)) {
          duplicateId = true
          break
        }
        setAddIntrinsic(sourceIds, observation.id)
      }
      if (duplicateId) {
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'duplicate_observation_id'))
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
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'run_id_mismatch'))
        continue
      }

      const postReadBindingFailure = await vaultBindingFailureReason(env, binding)
      if (postReadBindingFailure) {
        pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, postReadBindingFailure))
        continue
      }

      for (let index = 0; index < acceptedSourceObservations.length; index += 1) {
        const observation = acceptedSourceObservations[index]
        pushIntrinsic(observations, observation)
        setAddIntrinsic(observationIds, observation.id)
      }
      if (runId === null && sourceRunId !== null) runId = sourceRunId
      pushIntrinsic(sourceStatuses, freezeIntrinsic({
        key: sourceIdentity.key,
        slot: sourceIdentity.slot,
        status: 'available',
        observationCount: acceptedSourceObservationCount,
      }))
    } catch {
      pushIntrinsic(sourceStatuses, failedStatus(sourceIdentity, 'invalid_source_snapshot'))
    }
  }

  return finalizeCollection(runId, rawObservationCount, sourceStatuses, observations)
}
