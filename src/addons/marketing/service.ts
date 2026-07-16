import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { Env } from '../../types'
import type { AddonActor } from '../service'
import { getRegisteredAddon } from '../registry'
import '../modules'
import {
  collectMarketingSnapshots,
  MAX_MARKETING_MONITOR_OBSERVATION_ID_LENGTH,
  MAX_MARKETING_MONITOR_SOURCES,
  MAX_OBSERVATIONS_PER_RUN,
} from './sources'
import { deriveMarketingOutcomes } from './outcomes'
import {
  MARKETING_MONITOR_METRIC_CONTRACT,
  type MarketingMonitorRun,
  type MarketingMonitorRunSource,
  type MarketingMonitorSource,
  type MarketingOutcomes,
  type MonitorObservation,
  type MonitorWindow,
  type OutcomeValue,
  type ResolvedAddonBinding,
  type SourceStatus,
} from './types'

export const MARKETING_MONITOR_PROGRAM_VERSION = 'marketing-cro-monitor-v1'
export const MAX_MARKETING_MONITOR_WINDOW_MS = 31 * 24 * 60 * 60 * 1000
export const MAX_MARKETING_MONITOR_RUN_LIST = 50

const MARKETING_ADDON_KEY = 'marketing-cro-monitor'
const EVIDENCE_SCHEMA = 'mupot.marketing-monitor-evidence/v1'
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const HEX_SHA256 = /^[a-f0-9]{64}$/
const DateIntrinsic = Date
const reflectApplyIntrinsic = Reflect.apply
const objectKeysIntrinsic = Object.keys
const numberIsFiniteIntrinsic = Number.isFinite
const numberIsIntegerIntrinsic = Number.isInteger
const arrayPushIntrinsic = Array.prototype.push
const arrayIncludesIntrinsic = Array.prototype.includes
const dateParseIntrinsic = Date.parse.bind(Date)
const dateToISOStringIntrinsic = Date.prototype.toISOString
const jsonParseIntrinsic = JSON.parse.bind(JSON)
const jsonStringifyIntrinsic = JSON.stringify.bind(JSON)
const randomUUIDIntrinsic = crypto.randomUUID.bind(crypto)
const digestIntrinsic = crypto.subtle.digest.bind(crypto.subtle)
const arraySortIntrinsic = Array.prototype.sort
const setHasIntrinsic = Set.prototype.has
const setAddIntrinsic = Set.prototype.add
const stringLocaleCompareIntrinsic = String.prototype.localeCompare
const STABLE_SOURCE_REASONS = new Set([
  'adapter_type_mismatch',
  'authoritative_source_missing',
  'binding_adapter_not_supported',
  'binding_not_configured',
  'connector_not_available',
  'connector_not_configured',
  'connector_revoked',
  'duplicate_observation_id',
  'duplicate_source_identity',
  'invalid_binding_configuration',
  'invalid_observation',
  'invalid_source_configuration',
  'invalid_source_snapshot',
  'metric_authority_not_allowed',
  'observation_authority_mismatch',
  'observation_unit_mismatch',
  'run_id_mismatch',
  'run_observation_limit_exceeded',
  'source_observation_limit_exceeded',
  'source_read_failed',
  'source_unavailable',
  'window_mismatch',
])
const OUTCOME_SOURCES = new Set(['first-party', 'posthog', 'gsc', 'ghl', 'crm', 'mcpwp', 'inkwell', 'ai_visibility'])
const OUTCOME_UNITS = new Set(['count', 'ratio', 'usd'])
const STORED_OUTCOME_METRICS = {
  visibility: 'seo.ai_citations',
  qualifiedTraffic: 'seo.organic_sessions',
  leads: 'growth.leads',
  conversion: 'seo.conversion_rate',
  revenue: 'finance.revenue',
} as const

interface InstallationRow {
  id: string
  tenant: string
  addon_key: string
  installed_version: string
  publisher: string
  trust_class: 'native_reviewed'
  mupot_compatibility: string
  manifest_sha256: string
  state: string
}

interface GenerationRow {
  id: string
  binding_count: number
}

interface BindingRow {
  id: string
  slot: string
  adapter: string
  binding_kind: 'internal_adapter' | 'vault_connector'
  capability: 'read'
  connector_id: string | null
}

interface StoredRunRow {
  id: string
  program_version: string
  status: string
  window_start: string
  window_end: string
  source_count: number
  observation_count: number
  raw_observation_count: number
  outcomes_json: string
  evidence_digest: string
  created_at: string
  completed_at: string
  sources_json: string
  observations_json: string
}

interface LiveContext {
  installation: InstallationRow
  generation: GenerationRow
  bindings: ResolvedAddonBinding[]
}

export interface MarketingMonitorSourceFactoryContext {
  readonly runId: string
  readonly window: MonitorWindow
}

export type MarketingMonitorSourceFactory = (
  context: MarketingMonitorSourceFactoryContext,
) => readonly MarketingMonitorSource[] | Promise<readonly MarketingMonitorSource[]>

export interface MarketingMonitorServiceDeps {
  readonly sourceFactory?: MarketingMonitorSourceFactory
}

export type MarketingMonitorFailureReason =
  | 'not_authorized'
  | 'invalid_window'
  | 'invalid_limit'
  | 'addon_not_active'
  | 'addon_identity_mismatch'
  | 'binding_generation_not_live'
  | 'collection_failed'
  | 'collection_invalid'
  | 'fence_lost'
  | 'stored_run_invalid'
  | 'write_failed'

export type RunMarketingMonitorResult =
  | { readonly ok: true; readonly idempotent: boolean; readonly run: MarketingMonitorRun }
  | { readonly ok: false; readonly reason: MarketingMonitorFailureReason }

export type GetMarketingMonitorRunResult =
  | { readonly ok: true; readonly run: MarketingMonitorRun | null }
  | { readonly ok: false; readonly reason: MarketingMonitorFailureReason }

export type ListMarketingMonitorRunsResult =
  | { readonly ok: true; readonly runs: readonly MarketingMonitorRun[] }
  | { readonly ok: false; readonly reason: MarketingMonitorFailureReason }

interface CapturedDatabase {
  readonly db: D1Database
  readonly tenant: string
}

function captureDatabase(env: Env): CapturedDatabase | null {
  try {
    if (!env || typeof env !== 'object' || typeof env.TENANT_SLUG !== 'string' || env.TENANT_SLUG.length === 0) {
      return null
    }
    const receiver = env.DB
    const prepare = receiver?.prepare
    const batch = receiver?.batch
    if (typeof prepare !== 'function' || typeof batch !== 'function') return null
    const db = Object.freeze({
      prepare(sql: string) {
        return reflectApplyIntrinsic(prepare, receiver, [sql])
      },
      batch(statements: D1PreparedStatement[]) {
        return reflectApplyIntrinsic(batch, receiver, [statements])
      },
    }) as unknown as D1Database
    return Object.freeze({ db, tenant: env.TENANT_SLUG })
  } catch {
    return null
  }
}

function isAdminPlus(actor: AddonActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin'
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return false
  const milliseconds = dateParseIntrinsic(value)
  if (!numberIsFiniteIntrinsic(milliseconds)) return false
  return reflectApplyIntrinsic(dateToISOStringIntrinsic, new DateIntrinsic(milliseconds), []) === value
}

export function canonicalMarketingMonitorWindow(value: unknown): MonitorWindow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (objectKeysIntrinsic(record).length !== 2 || !Object.hasOwn(record, 'start') || !Object.hasOwn(record, 'end')) return null
  if (!canonicalTimestamp(record.start) || !canonicalTimestamp(record.end)) return null
  const start = dateParseIntrinsic(record.start)
  const end = dateParseIntrinsic(record.end)
  if (start > end || end - start > MAX_MARKETING_MONITOR_WINDOW_MS) return null
  return Object.freeze({ start: record.start, end: record.end })
}

function nowIso(): string {
  return reflectApplyIntrinsic(dateToISOStringIntrinsic, new DateIntrinsic(), [])
}

function exactRegisteredIdentity(installation: InstallationRow): boolean {
  const entry = getRegisteredAddon(MARKETING_ADDON_KEY)
  return Boolean(entry)
    && installation.addon_key === entry?.manifest.key
    && installation.installed_version === entry.manifest.version
    && installation.publisher === entry.manifest.publisher
    && installation.trust_class === entry.manifest.trustClass
    && installation.mupot_compatibility === entry.manifest.mupotCompatibility
    && installation.manifest_sha256 === entry.manifestSha256
}

async function loadLiveContext(captured: CapturedDatabase): Promise<
  | { ok: true; context: LiveContext }
  | { ok: false; reason: MarketingMonitorFailureReason }
> {
  const installation = await captured.db.prepare(`
    SELECT id, tenant, addon_key, installed_version, publisher, trust_class,
           mupot_compatibility, manifest_sha256, state
      FROM addon_installations
     WHERE tenant = ?1 AND addon_key = ?2 AND state <> 'archived'
     LIMIT 1
  `).bind(captured.tenant, MARKETING_ADDON_KEY).first<InstallationRow>()
  if (!installation || installation.state !== 'active') return { ok: false, reason: 'addon_not_active' }
  if (!exactRegisteredIdentity(installation)) return { ok: false, reason: 'addon_identity_mismatch' }

  const generation = await captured.db.prepare(`
    SELECT id, binding_count
      FROM addon_binding_generations
     WHERE tenant = ?1 AND installation_id = ?2
       AND manifest_sha256 = ?3 AND revoked_at IS NULL
     LIMIT 1
  `).bind(captured.tenant, installation.id, installation.manifest_sha256).first<GenerationRow>()
  if (!generation) return { ok: false, reason: 'binding_generation_not_live' }

  const rows = await captured.db.prepare(`
    SELECT id, slot, adapter, binding_kind, capability, connector_id
      FROM addon_connector_bindings
     WHERE tenant = ?1 AND installation_id = ?2 AND generation_id = ?3
       AND revoked_at IS NULL
     ORDER BY slot, id
  `).bind(captured.tenant, installation.id, generation.id).all<BindingRow>()
  const bindings = (rows.results ?? []).map((row) => ({
    id: row.id,
    slot: row.slot,
    adapter: row.adapter,
    bindingKind: row.binding_kind,
    capability: row.capability,
    connectorId: row.connector_id,
  }))
  if (generation.binding_count !== bindings.length) return { ok: false, reason: 'binding_generation_not_live' }
  return { ok: true, context: { installation, generation, bindings } }
}

function compareSource(left: MarketingMonitorRunSource, right: MarketingMonitorRunSource): number {
  return reflectApplyIntrinsic(stringLocaleCompareIntrinsic, left.key, [right.key])
    || reflectApplyIntrinsic(stringLocaleCompareIntrinsic, left.slot, [right.slot])
}

function compareObservation(left: MonitorObservation, right: MonitorObservation): number {
  return reflectApplyIntrinsic(stringLocaleCompareIntrinsic, left.sourceKey, [right.sourceKey])
    || reflectApplyIntrinsic(stringLocaleCompareIntrinsic, left.sourceSlot, [right.sourceSlot])
    || reflectApplyIntrinsic(stringLocaleCompareIntrinsic, left.observedAt, [right.observedAt])
    || reflectApplyIntrinsic(stringLocaleCompareIntrinsic, left.id, [right.id])
}

function sortedCopy<T>(values: readonly T[], compare: (left: T, right: T) => number): T[] {
  const copy: T[] = []
  for (let index = 0; index < values.length; index += 1) {
    reflectApplyIntrinsic(arrayPushIntrinsic, copy, [values[index]])
  }
  reflectApplyIntrinsic(arraySortIntrinsic, copy, [compare])
  return copy
}

async function sha256Json(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(jsonStringifyIntrinsic(value))
  const digest = new Uint8Array(await digestIntrinsic('SHA-256', encoded))
  let hex = ''
  for (let index = 0; index < digest.length; index += 1) hex += digest[index].toString(16).padStart(2, '0')
  return hex
}

function runSelect(whereClause: string, limitClause = ''): string {
  return `
    SELECT run.id, run.program_version, run.status, run.window_start, run.window_end,
           run.source_count, run.observation_count, run.raw_observation_count,
           run.outcomes_json, run.evidence_digest, run.created_at, run.completed_at,
           COALESCE((
             SELECT json_group_array(json_object(
               'key', ordered.source_key,
               'slot', ordered.source_slot,
               'status', ordered.status,
               'reason', ordered.reason,
               'observationCount', ordered.observation_count
             ))
               FROM (
                 SELECT source_key, source_slot, status, reason, observation_count
                   FROM marketing_monitor_sources
                  WHERE run_id = run.id
                  ORDER BY position
               ) AS ordered
           ), '[]') AS sources_json,
           COALESCE((
             SELECT json_group_array(json_object(
               'id', ordered.id,
               'runId', ordered.run_id,
               'metricKey', ordered.metric_key,
               'value', ordered.value,
               'unit', ordered.unit,
               'authority', ordered.authority,
               'observedAt', ordered.observed_at,
               'sourceKey', ordered.source_key,
               'sourceSlot', ordered.source_slot
             ))
               FROM (
                 SELECT id, run_id, metric_key, value, unit, authority, observed_at,
                        source_key, source_slot
                   FROM marketing_monitor_observations
                  WHERE run_id = run.id
                  ORDER BY position
               ) AS ordered
           ), '[]') AS observations_json
      FROM marketing_monitor_runs AS run
     WHERE ${whereClause}
     ORDER BY run.completed_at DESC, run.id DESC
     ${limitClause}
  `
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function includesCaptured<T>(values: readonly T[], value: unknown): boolean {
  return reflectApplyIntrinsic(arrayIncludesIntrinsic, values, [value]) as boolean
}

function setHasCaptured<T>(values: Set<T>, value: T): boolean {
  return reflectApplyIntrinsic(setHasIntrinsic, values, [value]) as boolean
}

function setAddCaptured<T>(values: Set<T>, value: T): void {
  reflectApplyIntrinsic(setAddIntrinsic, values, [value])
}

function pushCaptured<T>(values: T[], value: T): void {
  reflectApplyIntrinsic(arrayPushIntrinsic, values, [value])
}

function validOutcome(value: unknown): value is OutcomeValue {
  if (!isObject(value) || typeof value.status !== 'string') return false
  if (value.status === 'unavailable') {
    return objectKeysIntrinsic(value).length === 2 && value.reason === 'authoritative_source_missing'
  }
  return value.status === 'available'
    && objectKeysIntrinsic(value).length === 5
    && typeof value.value === 'number'
    && numberIsFiniteIntrinsic(value.value)
    && typeof value.unit === 'string'
    && setHasCaptured(OUTCOME_UNITS, value.unit)
    && typeof value.source === 'string'
    && setHasCaptured(OUTCOME_SOURCES, value.source)
    && canonicalTimestamp(value.observedAt)
}

function validOutcomes(value: unknown): value is MarketingOutcomes {
  if (!isObject(value)) return false
  const keys = ['visibility', 'qualifiedTraffic', 'leads', 'conversion', 'revenue'] as const
  if (objectKeysIntrinsic(value).length !== keys.length) return false
  for (let index = 0; index < keys.length; index += 1) {
    if (!validOutcome(value[keys[index]])) return false
  }
  return true
}

function parseSources(value: unknown): MarketingMonitorRunSource[] | null {
  if (!Array.isArray(value) || value.length > MAX_MARKETING_MONITOR_SOURCES) return null
  const sources: MarketingMonitorRunSource[] = []
  const keys = new Set<string>()
  for (const entry of value) {
    if (!isObject(entry)) return null
    const entryKeys = objectKeysIntrinsic(entry)
    for (let index = 0; index < entryKeys.length; index += 1) {
      if (!includesCaptured(['key', 'slot', 'status', 'reason', 'observationCount'], entryKeys[index])) return null
    }
    if (
      typeof entry.key !== 'string' || typeof entry.slot !== 'string'
      || !includesCaptured(['available', 'unavailable', 'failed'], String(entry.status))
      || !numberIsIntegerIntrinsic(entry.observationCount)
      || Number(entry.observationCount) < 0 || Number(entry.observationCount) > 100
      || setHasCaptured(keys, entry.key)
      || (entry.status === 'available'
        ? entry.reason !== null
        : typeof entry.reason !== 'string' || !setHasCaptured(STABLE_SOURCE_REASONS, entry.reason))
    ) return null
    setAddCaptured(keys, entry.key)
    pushCaptured(sources, {
      key: entry.key,
      slot: entry.slot,
      status: entry.status as SourceStatus,
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
      observationCount: Number(entry.observationCount),
    })
  }
  return sources
}

function parseObservations(value: unknown, runId: string, window: MonitorWindow): MonitorObservation[] | null {
  if (!Array.isArray(value) || value.length > MAX_OBSERVATIONS_PER_RUN) return null
  const windowStart = dateParseIntrinsic(window.start)
  const windowEnd = dateParseIntrinsic(window.end)
  const observations: MonitorObservation[] = []
  const ids = new Set<string>()
  for (const entry of value) {
    if (!isObject(entry) || objectKeysIntrinsic(entry).length !== 9) return null
    if (
      typeof entry.id !== 'string' || entry.id.length === 0
      || entry.id.length > MAX_MARKETING_MONITOR_OBSERVATION_ID_LENGTH
      || setHasCaptured(ids, entry.id)
      || entry.runId !== runId
      || typeof entry.metricKey !== 'string' || !Object.hasOwn(MARKETING_MONITOR_METRIC_CONTRACT, entry.metricKey)
      || typeof entry.value !== 'number' || !numberIsFiniteIntrinsic(entry.value)
      || typeof entry.unit !== 'string' || typeof entry.authority !== 'string'
      || !canonicalTimestamp(entry.observedAt)
      || typeof entry.sourceKey !== 'string' || typeof entry.sourceSlot !== 'string'
    ) return null
    const metric = MARKETING_MONITOR_METRIC_CONTRACT[entry.metricKey as keyof typeof MARKETING_MONITOR_METRIC_CONTRACT]
    const observedAt = dateParseIntrinsic(entry.observedAt as string)
    if (
      observedAt < windowStart || observedAt > windowEnd
      || entry.unit !== metric.unit
      || !includesCaptured(metric.authorities as readonly string[], entry.authority)
    ) return null
    setAddCaptured(ids, entry.id)
    pushCaptured(observations, entry as unknown as MonitorObservation)
  }
  return observations
}

function deriveStoredOutcomes(observations: readonly MonitorObservation[]): MarketingOutcomes {
  const outcomeFor = (metricKey: keyof typeof MARKETING_MONITOR_METRIC_CONTRACT): OutcomeValue => {
    let matching: MonitorObservation | undefined
    for (let index = 0; index < observations.length; index += 1) {
      const observation = observations[index]
      if (
        observation.metricKey === metricKey
        && (
          matching === undefined
          || observation.observedAt > matching.observedAt
          || (observation.observedAt === matching.observedAt && observation.id > matching.id)
        )
      ) matching = observation
    }
    return matching
      ? {
          status: 'available',
          value: matching.value,
          unit: matching.unit,
          source: matching.authority,
          observedAt: matching.observedAt,
        }
      : { status: 'unavailable', reason: 'authoritative_source_missing' }
  }
  return {
    visibility: outcomeFor(STORED_OUTCOME_METRICS.visibility),
    qualifiedTraffic: outcomeFor(STORED_OUTCOME_METRICS.qualifiedTraffic),
    leads: outcomeFor(STORED_OUTCOME_METRICS.leads),
    conversion: outcomeFor(STORED_OUTCOME_METRICS.conversion),
    revenue: outcomeFor(STORED_OUTCOME_METRICS.revenue),
  }
}

function outcomesEqual(left: MarketingOutcomes, right: MarketingOutcomes): boolean {
  const keys = objectKeysIntrinsic(STORED_OUTCOME_METRICS) as Array<keyof MarketingOutcomes>
  for (let index = 0; index < keys.length; index += 1) {
    const leftOutcome = left[keys[index]]
    const rightOutcome = right[keys[index]]
    if (leftOutcome.status !== rightOutcome.status) return false
    if (leftOutcome.status === 'unavailable' || rightOutcome.status === 'unavailable') {
      if (
        leftOutcome.status !== 'unavailable'
        || rightOutcome.status !== 'unavailable'
        || leftOutcome.reason !== rightOutcome.reason
      ) return false
      continue
    }
    if (
      leftOutcome.value !== rightOutcome.value
      || leftOutcome.unit !== rightOutcome.unit
      || leftOutcome.source !== rightOutcome.source
      || leftOutcome.observedAt !== rightOutcome.observedAt
    ) return false
  }
  return true
}

function isCanonicalOrder<T>(values: readonly T[], compare: (left: T, right: T) => number): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1], values[index]) > 0) return false
  }
  return true
}

async function parseStoredRun(row: StoredRunRow): Promise<MarketingMonitorRun | null> {
  try {
    if (
      row.status !== 'completed'
      || row.program_version !== MARKETING_MONITOR_PROGRAM_VERSION
      || !canonicalTimestamp(row.window_start) || !canonicalTimestamp(row.window_end)
      || dateParseIntrinsic(row.window_start) > dateParseIntrinsic(row.window_end)
      || !canonicalTimestamp(row.created_at) || !canonicalTimestamp(row.completed_at)
      || !HEX_SHA256.test(row.evidence_digest)
      || !numberIsIntegerIntrinsic(row.source_count) || row.source_count < 0 || row.source_count > MAX_MARKETING_MONITOR_SOURCES
      || !numberIsIntegerIntrinsic(row.observation_count) || row.observation_count < 0 || row.observation_count > MAX_OBSERVATIONS_PER_RUN
      || !numberIsIntegerIntrinsic(row.raw_observation_count) || row.raw_observation_count < row.observation_count
    ) return null
    const window = { start: row.window_start, end: row.window_end }
    const sources = parseSources(jsonParseIntrinsic(row.sources_json))
    const observations = parseObservations(jsonParseIntrinsic(row.observations_json), row.id, window)
    const outcomes = jsonParseIntrinsic(row.outcomes_json)
    if (!sources || !observations || !validOutcomes(outcomes)) return null
    if (sources.length !== row.source_count || observations.length !== row.observation_count) return null
    const sourceByKey = new Map(sources.map((source) => [source.key, source]))
    for (const source of sources) {
      const count = observations.filter((observation) => (
        observation.sourceKey === source.key && observation.sourceSlot === source.slot
      )).length
      if (count !== source.observationCount) return null
    }
    if (observations.some((observation) => sourceByKey.get(observation.sourceKey)?.slot !== observation.sourceSlot)) return null
    if (!isCanonicalOrder(sources, compareSource) || !isCanonicalOrder(observations, compareObservation)) return null

    // Stored rows are not branded as fresh Task 3 collections; verify the same deterministic outcome contract directly.
    const expectedOutcomes = deriveStoredOutcomes(observations)
    if (!outcomesEqual(outcomes, expectedOutcomes)) return null
    const expectedDigest = await sha256Json({
      schema: EVIDENCE_SCHEMA,
      programVersion: row.program_version,
      window,
      sources,
      observations,
      outcomes: expectedOutcomes,
    })
    if (expectedDigest !== row.evidence_digest) return null
    return {
      id: row.id,
      programVersion: row.program_version,
      status: 'completed',
      window,
      sourceCount: row.source_count,
      observationCount: row.observation_count,
      rawObservationCount: row.raw_observation_count,
      sources,
      observations,
      outcomes: expectedOutcomes,
      evidenceDigest: row.evidence_digest,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }
  } catch {
    return null
  }
}

async function loadExactCompleted(
  captured: CapturedDatabase,
  installationId: string,
  window: MonitorWindow,
): Promise<{ state: 'none' } | { state: 'invalid' } | { state: 'valid'; run: MarketingMonitorRun }> {
  const row = await captured.db.prepare(runSelect(`
    run.tenant = ?1 AND run.installation_id = ?2 AND run.program_version = ?3
    AND run.window_start = ?4 AND run.window_end = ?5 AND run.status = 'completed'
  `, 'LIMIT 1')).bind(
    captured.tenant,
    installationId,
    MARKETING_MONITOR_PROGRAM_VERSION,
    window.start,
    window.end,
  ).first<StoredRunRow>()
  if (!row) return { state: 'none' }
  const run = await parseStoredRun(row)
  return run ? { state: 'valid', run } : { state: 'invalid' }
}

function resultsWritten(result: D1Result<unknown> | undefined): boolean {
  return Boolean(result?.success) && Number(result?.meta?.changes ?? 0) === 1
}

const emptySourceFactory: MarketingMonitorSourceFactory = () => []

export async function runMarketingMonitor(
  env: Env,
  actor: AddonActor,
  input: { readonly window: MonitorWindow },
  deps: MarketingMonitorServiceDeps = {},
): Promise<RunMarketingMonitorResult> {
  if (!isAdminPlus(actor)) return { ok: false, reason: 'not_authorized' }
  const window = canonicalMarketingMonitorWindow(input?.window)
  if (!window) return { ok: false, reason: 'invalid_window' }
  const captured = captureDatabase(env)
  if (!captured) return { ok: false, reason: 'write_failed' }

  let loaded: Awaited<ReturnType<typeof loadLiveContext>>
  try {
    loaded = await loadLiveContext(captured)
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
  if (!loaded.ok) return loaded
  const { installation, generation, bindings } = loaded.context

  try {
    const existing = await loadExactCompleted(captured, installation.id, window)
    if (existing.state === 'invalid') return { ok: false, reason: 'stored_run_invalid' }
    if (existing.state === 'valid') return { ok: true, idempotent: true, run: existing.run }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }

  const runId = randomUUIDIntrinsic()
  const createdAt = nowIso()
  let collection
  try {
    const sources = await (deps.sourceFactory ?? emptySourceFactory)({ runId, window })
    collection = await collectMarketingSnapshots(env, bindings, window, sources)
  } catch {
    return { ok: false, reason: 'collection_failed' }
  }

  if (
    collection.sources.length > MAX_MARKETING_MONITOR_SOURCES
    || collection.observations.length > MAX_OBSERVATIONS_PER_RUN
    || !numberIsIntegerIntrinsic(collection.rawObservationCount)
    || collection.rawObservationCount < collection.observations.length
    || collection.rawObservationCount > 4294967295
    || (collection.observations.length === 0 ? collection.runId !== null : collection.runId !== runId)
  ) return { ok: false, reason: 'collection_invalid' }

  const sources = sortedCopy(collection.sources, compareSource)
  const observations = sortedCopy(collection.observations, compareObservation)
  const outcomes = deriveMarketingOutcomes(collection)
  const evidenceDigest = await sha256Json({
    schema: EVIDENCE_SCHEMA,
    programVersion: MARKETING_MONITOR_PROGRAM_VERSION,
    window,
    sources,
    observations,
    outcomes,
  })
  const completedAt = nowIso()
  const sourcesJson = jsonStringifyIntrinsic(sources)
  const observationsJson = jsonStringifyIntrinsic(observations)
  const outcomesJson = jsonStringifyIntrinsic(outcomes)

  const batch: D1PreparedStatement[] = [
    captured.db.prepare(`
      INSERT INTO marketing_monitor_runs (
        id, tenant, installation_id, binding_generation_id, addon_key,
        installed_version, publisher, trust_class, mupot_compatibility, manifest_sha256,
        program_version, window_start, window_end, status, source_count,
        observation_count, raw_observation_count, outcomes_json, evidence_digest,
        created_at, completed_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, 'building', ?14, ?15, ?16, NULL, NULL, ?17, NULL
      )
    `).bind(
      runId, captured.tenant, installation.id, generation.id, installation.addon_key,
      installation.installed_version, installation.publisher, installation.trust_class,
      installation.mupot_compatibility, installation.manifest_sha256,
      MARKETING_MONITOR_PROGRAM_VERSION, window.start, window.end,
      sources.length, observations.length, collection.rawObservationCount, createdAt,
    ),
    captured.db.prepare(`
      INSERT INTO marketing_monitor_sources (
        run_id, tenant, installation_id, binding_generation_id, position,
        source_key, source_slot, status, reason, observation_count
      )
      SELECT ?2, ?3, ?4, ?5, CAST(source.key AS INTEGER),
             json_extract(source.value, '$.key'), json_extract(source.value, '$.slot'),
             json_extract(source.value, '$.status'), json_extract(source.value, '$.reason'),
             json_extract(source.value, '$.observationCount')
        FROM json_each(?1) AS source
    `).bind(sourcesJson, runId, captured.tenant, installation.id, generation.id),
    captured.db.prepare(`
      INSERT INTO marketing_monitor_observations (
        run_id, tenant, installation_id, binding_generation_id, position, id,
        source_key, source_slot, metric_key, value, unit, authority, observed_at
      )
      SELECT ?2, ?3, ?4, ?5, CAST(observation.key AS INTEGER),
             json_extract(observation.value, '$.id'),
             json_extract(observation.value, '$.sourceKey'),
             json_extract(observation.value, '$.sourceSlot'),
             json_extract(observation.value, '$.metricKey'),
             json_extract(observation.value, '$.value'),
             json_extract(observation.value, '$.unit'),
             json_extract(observation.value, '$.authority'),
             json_extract(observation.value, '$.observedAt')
        FROM json_each(?1) AS observation
    `).bind(observationsJson, runId, captured.tenant, installation.id, generation.id),
    captured.db.prepare(`
      UPDATE marketing_monitor_runs
         SET status = 'completed', completed_at = ?1, evidence_digest = ?2, outcomes_json = ?3
       WHERE id = ?4 AND tenant = ?5 AND installation_id = ?6
         AND binding_generation_id = ?7 AND status = 'building'
    `).bind(completedAt, evidenceDigest, outcomesJson, runId, captured.tenant, installation.id, generation.id),
    captured.db.prepare(runSelect(`
      run.id = ?1 AND run.tenant = ?2 AND run.installation_id = ?3
      AND run.binding_generation_id = ?4 AND run.status = 'completed'
    `, 'LIMIT 1')).bind(runId, captured.tenant, installation.id, generation.id),
  ]

  try {
    const results = await captured.db.batch<StoredRunRow>(batch)
    if (!resultsWritten(results[0]) || !resultsWritten(results[3])) throw new Error('monitor_batch_not_written')
    const row = results[4]?.results?.[0]
    const run = row ? await parseStoredRun(row) : null
    return run
      ? { ok: true, idempotent: false, run }
      : { ok: false, reason: 'stored_run_invalid' }
  } catch {
    try {
      const raced = await loadExactCompleted(captured, installation.id, window)
      if (raced.state === 'valid') return { ok: true, idempotent: true, run: raced.run }
      if (raced.state === 'invalid') return { ok: false, reason: 'stored_run_invalid' }
      const live = await loadLiveContext(captured)
      return !live.ok || live.context.generation.id !== generation.id
        ? { ok: false, reason: 'fence_lost' }
        : { ok: false, reason: 'write_failed' }
    } catch {
      return { ok: false, reason: 'fence_lost' }
    }
  }
}

function readIdentityWhere(): string {
  const entry = getRegisteredAddon(MARKETING_ADDON_KEY)
  if (!entry) return '0'
  return `
    run.tenant = ?1 AND run.addon_key = ?2 AND run.installed_version = ?3
    AND run.publisher = ?4 AND run.trust_class = ?5 AND run.mupot_compatibility = ?6
    AND run.manifest_sha256 = ?7 AND run.program_version = ?8 AND run.status = 'completed'
  `
}

function readIdentityBindings(captured: CapturedDatabase): unknown[] {
  const entry = getRegisteredAddon(MARKETING_ADDON_KEY)
  if (!entry) return []
  return [
    captured.tenant,
    entry.manifest.key,
    entry.manifest.version,
    entry.manifest.publisher,
    entry.manifest.trustClass,
    entry.manifest.mupotCompatibility,
    entry.manifestSha256,
    MARKETING_MONITOR_PROGRAM_VERSION,
  ]
}

export async function getLatestMarketingMonitorRun(
  env: Env,
  actor: AddonActor,
): Promise<GetMarketingMonitorRunResult> {
  if (!isAdminPlus(actor)) return { ok: false, reason: 'not_authorized' }
  const captured = captureDatabase(env)
  if (!captured) return { ok: false, reason: 'write_failed' }
  try {
    const row = await captured.db.prepare(runSelect(readIdentityWhere(), 'LIMIT 1'))
      .bind(...readIdentityBindings(captured)).first<StoredRunRow>()
    if (!row) return { ok: true, run: null }
    const run = await parseStoredRun(row)
    return run ? { ok: true, run } : { ok: false, reason: 'stored_run_invalid' }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

export async function listMarketingMonitorRuns(
  env: Env,
  actor: AddonActor,
  input: { readonly limit: number },
): Promise<ListMarketingMonitorRunsResult> {
  if (!isAdminPlus(actor)) return { ok: false, reason: 'not_authorized' }
  if (!numberIsIntegerIntrinsic(input.limit) || input.limit < 1 || input.limit > MAX_MARKETING_MONITOR_RUN_LIST) {
    return { ok: false, reason: 'invalid_limit' }
  }
  const captured = captureDatabase(env)
  if (!captured) return { ok: false, reason: 'write_failed' }
  try {
    const result = await captured.db.prepare(runSelect(readIdentityWhere(), 'LIMIT ?9'))
      .bind(...readIdentityBindings(captured), input.limit).all<StoredRunRow>()
    const runs: MarketingMonitorRun[] = []
    for (const row of result.results ?? []) {
      const run = await parseStoredRun(row)
      if (!run) return { ok: false, reason: 'stored_run_invalid' }
      pushCaptured(runs, run)
    }
    return { ok: true, runs }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}
