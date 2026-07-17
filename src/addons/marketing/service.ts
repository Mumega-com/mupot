import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { Env } from '../../types'
import { createFlight as canonicalCreateFlight } from '../../flight/service'
import { FLIGHT_META_V1_SCHEMA, parseFlightMetaV1, type FlightMetaV1 } from '../../flight/meta'
import { createTask as canonicalCreateTask } from '../../tasks/service'
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
import { MARKETING_MONITOR_ADAPTERS } from './adapters'
import {
  rankMarketingOpportunities,
  type LimitingMarketingEvidence,
  type MarketingOpportunityCandidate,
  type MarketingOpportunityKind,
  type MarketingOpportunityKpi,
} from './opportunities'
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
export const MARKETING_RECOMMENDATION_GATE_OWNER = 'gate:addons:marketing-cro-monitor:promote_recommendation'

const MARKETING_ADDON_KEY = 'marketing-cro-monitor'
const EVIDENCE_SCHEMA = 'mupot.marketing-monitor-evidence/v1'
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const HEX_SHA256 = /^[a-f0-9]{64}$/
const SOURCE_IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SYNTHETIC_SOURCE_KEY = /^source_config_(?:[0-9]|1[0-5])$/
const RESERVED_SOURCE_KEY = /^source_config_/
const DateIntrinsic = Date
const SetIntrinsic = Set
const Uint8ArrayIntrinsic = Uint8Array
const TextEncoderIntrinsic = TextEncoder
const reflectApplyIntrinsic = Reflect.apply
const objectKeysIntrinsic = Object.keys
const objectFreezeIntrinsic = Object.freeze
const objectHasOwnIntrinsic = Object.hasOwn
const numberIsFiniteIntrinsic = Number.isFinite
const numberIsIntegerIntrinsic = Number.isInteger
const arrayIsArrayIntrinsic = Array.isArray
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
const regexpTestIntrinsic = RegExp.prototype.test
const textEncoderIntrinsic = new TextEncoderIntrinsic()
const textEncoderEncodeIntrinsic = TextEncoderIntrinsic.prototype.encode
const STABLE_SOURCE_REASONS = new SetIntrinsic([
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
const OUTCOME_SOURCES = new SetIntrinsic(['first-party', 'posthog', 'gsc', 'ghl', 'crm', 'mcpwp', 'inkwell', 'ai_visibility'])
const OUTCOME_UNITS = new SetIntrinsic(['count', 'ratio', 'usd'])
const RECOMMENDATION_KINDS = new SetIntrinsic([
  'conversion_review',
  'revenue_review',
  'lead_generation_review',
  'organic_traffic_review',
  'ai_visibility_review',
])
const RECOMMENDATION_KPIS = new SetIntrinsic([
  'visibility',
  'qualifiedTraffic',
  'leads',
  'conversion',
  'revenue',
])
const UNAVAILABLE_SOURCE_REASONS = new SetIntrinsic([
  'authoritative_source_missing',
  'binding_not_configured',
  'connector_not_configured',
  'connector_revoked',
  'source_unavailable',
  'window_mismatch',
])
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

interface StoredRecommendationRow {
  id: string
  installation_id: string
  run_id: string
  program_version: string
  kind: MarketingOpportunityKind
  target: string
  problem: string
  hypothesis: string
  primary_kpi: MarketingOpportunityKpi
  kpi_baseline_json: string
  limiting_evidence_json: string
  evidence_digest: string
  dedup_key: string
  task_id: string
  flight_id: string
  approval_required: 1
  approval_action: 'promote_recommendation'
  required_capability: 'owner'
  self_approval: 0
  terminal_action: 'recommendation_ready'
  receipt_digest: string
  status: 'ready'
  created_at: string
  prepared_at: string
}

interface RecommendationPreparationRow {
  id: string
  installation_id: string
  binding_generation_id: string
  run_id: string
  program_version: string
  kind: MarketingOpportunityKind
  target: string
  evidence_digest: string
  dedup_key: string
  squad_id: string
  created_by: string
  created_at: string
  status: 'preparing'
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

export interface MarketingRecommendationDeps {
  readonly createTask?: typeof canonicalCreateTask
  readonly createFlight?: typeof canonicalCreateFlight
}

export interface MarketingRecommendation {
  readonly id: string
  readonly installationId: string
  readonly runId: string
  readonly programVersion: string
  readonly kind: MarketingOpportunityKind
  readonly target: string
  readonly problem: string
  readonly hypothesis: string
  readonly primaryKpi: MarketingOpportunityKpi
  readonly kpiBaseline: OutcomeValue
  readonly limitingEvidence: readonly LimitingMarketingEvidence[]
  readonly evidenceDigest: string
  readonly dedupKey: string
  readonly taskId: string
  readonly flightId: string
  readonly approval: {
    readonly required: true
    readonly action: 'promote_recommendation'
    readonly requiredCapability: 'owner'
    readonly selfApproval: false
  }
  readonly terminalAction: 'recommendation_ready'
  readonly receiptDigest: string
  readonly createdAt: string
  readonly preparedAt: string
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

export type MarketingRecommendationFailureReason =
  | MarketingMonitorFailureReason
  | 'run_not_latest'
  | 'no_opportunity'
  | 'approval_policy_missing'
  | 'web_operations_squad_not_found'
  | 'recommendation_busy'

export type PrepareMarketingRecommendationResult =
  | { readonly ok: true; readonly idempotent: boolean; readonly recommendation: MarketingRecommendation }
  | { readonly ok: false; readonly reason: MarketingRecommendationFailureReason }

export type GetMarketingRecommendationResult =
  | { readonly ok: true; readonly recommendation: MarketingRecommendation | null }
  | { readonly ok: false; readonly reason: MarketingRecommendationFailureReason }

export type MarketingMonitorReadScopeInput =
  | {
      readonly installationId?: undefined
      readonly generationId?: undefined
      readonly bindingCount?: undefined
    }
  | {
      readonly installationId: string
      readonly generationId: string
      readonly bindingCount: number
    }

interface CapturedDatabase {
  readonly db: D1Database
  readonly tenant: string
  readonly env: Env
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
    const tenant = env.TENANT_SLUG
    const db = objectFreezeIntrinsic({
      prepare(sql: string) {
        return reflectApplyIntrinsic(prepare, receiver, [sql])
      },
      batch(statements: D1PreparedStatement[]) {
        return reflectApplyIntrinsic(batch, receiver, [statements])
      },
    }) as unknown as D1Database
    const pinnedEnv = objectFreezeIntrinsic({ DB: db, TENANT_SLUG: tenant }) as Env
    return objectFreezeIntrinsic({ db, tenant, env: pinnedEnv })
  } catch {
    return null
  }
}

function isAdminPlus(actor: AddonActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin'
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !reflectApplyIntrinsic(regexpTestIntrinsic, ISO_TIMESTAMP, [value])) return false
  const milliseconds = dateParseIntrinsic(value)
  if (!numberIsFiniteIntrinsic(milliseconds)) return false
  return reflectApplyIntrinsic(dateToISOStringIntrinsic, new DateIntrinsic(milliseconds), []) === value
}

export function canonicalMarketingMonitorWindow(value: unknown): MonitorWindow | null {
  if (typeof value !== 'object' || value === null || arrayIsArrayIntrinsic(value)) return null
  const record = value as Record<string, unknown>
  if (
    objectKeysIntrinsic(record).length !== 2
    || !objectHasOwnIntrinsic(record, 'start')
    || !objectHasOwnIntrinsic(record, 'end')
  ) return null
  if (!canonicalTimestamp(record.start) || !canonicalTimestamp(record.end)) return null
  const start = dateParseIntrinsic(record.start)
  const end = dateParseIntrinsic(record.end)
  if (start > end || end - start > MAX_MARKETING_MONITOR_WINDOW_MS) return null
  return objectFreezeIntrinsic({ start: record.start, end: record.end })
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
  const bindings: ResolvedAddonBinding[] = []
  const bindingRows = rows.results ?? []
  for (let index = 0; index < bindingRows.length; index += 1) {
    const row = bindingRows[index]
    pushCaptured(bindings, {
      id: row.id,
      slot: row.slot,
      adapter: row.adapter,
      bindingKind: row.binding_kind,
      capability: row.capability,
      connectorId: row.connector_id,
    })
  }
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

function trustedJsonStringify(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const serialized = jsonStringifyIntrinsic(value)
    if (typeof serialized !== 'string') throw new Error('unsupported_json_value')
    return serialized
  }
  if (arrayIsArrayIntrinsic(value)) {
    let serialized = '['
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) serialized += ','
      serialized += trustedJsonStringify(value[index])
    }
    return `${serialized}]`
  }
  if (typeof value !== 'object') throw new Error('unsupported_json_value')
  const record = value as Record<string, unknown>
  const keys = objectKeysIntrinsic(record)
  let serialized = '{'
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) serialized += ','
    const key = keys[index]
    serialized += `${trustedJsonStringify(key)}:${trustedJsonStringify(record[key])}`
  }
  return `${serialized}}`
}

async function sha256Json(value: unknown): Promise<string> {
  const canonicalJson = trustedJsonStringify(value)
  const encoded = reflectApplyIntrinsic(textEncoderEncodeIntrinsic, textEncoderIntrinsic, [canonicalJson]) as Uint8Array
  const digest = new Uint8ArrayIntrinsic(await digestIntrinsic('SHA-256', encoded))
  const hexAlphabet = '0123456789abcdef'
  let hex = ''
  for (let index = 0; index < digest.length; index += 1) {
    const byte = digest[index]
    hex += hexAlphabet[byte >>> 4] + hexAlphabet[byte & 15]
  }
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
  return typeof value === 'object' && value !== null && !arrayIsArrayIntrinsic(value)
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
  if (!arrayIsArrayIntrinsic(value) || value.length > MAX_MARKETING_MONITOR_SOURCES) return null
  const sources: MarketingMonitorRunSource[] = []
  const keys = new SetIntrinsic<string>()
  for (let entryIndex = 0; entryIndex < value.length; entryIndex += 1) {
    const entry = value[entryIndex]
    if (!isObject(entry)) return null
    const entryKeys = objectKeysIntrinsic(entry)
    if (entryKeys.length !== 5) return null
    for (let index = 0; index < entryKeys.length; index += 1) {
      if (!includesCaptured(['key', 'slot', 'status', 'reason', 'observationCount'], entryKeys[index])) return null
    }
    const synthetic = typeof entry.key === 'string'
      && reflectApplyIntrinsic(regexpTestIntrinsic, SYNTHETIC_SOURCE_KEY, [entry.key]) as boolean
    const canonicalKey = typeof entry.key === 'string'
      && reflectApplyIntrinsic(regexpTestIntrinsic, SOURCE_IDENTIFIER, [entry.key]) as boolean
      && !(reflectApplyIntrinsic(regexpTestIntrinsic, RESERVED_SOURCE_KEY, [entry.key]) as boolean)
    const canonicalSlot = typeof entry.slot === 'string'
      && reflectApplyIntrinsic(regexpTestIntrinsic, SOURCE_IDENTIFIER, [entry.slot]) as boolean
    if (
      typeof entry.key !== 'string' || typeof entry.slot !== 'string'
      || typeof entry.status !== 'string'
      || !includesCaptured(['available', 'unavailable', 'failed'], entry.status)
      || !numberIsIntegerIntrinsic(entry.observationCount)
      || (entry.observationCount as number) < 0 || (entry.observationCount as number) > 100
      || setHasCaptured(keys, entry.key)
    ) return null
    if (synthetic) {
      if (
        entry.slot !== 'unconfigured'
        || entry.status !== 'failed'
        || entry.reason !== 'invalid_source_configuration'
        || entry.observationCount !== 0
      ) return null
    } else {
      if (!canonicalKey || !canonicalSlot) return null
      if (entry.status === 'available') {
        if (entry.reason !== null) return null
      } else if (
        entry.observationCount !== 0
        || typeof entry.reason !== 'string'
        || (entry.status === 'unavailable'
          ? !setHasCaptured(UNAVAILABLE_SOURCE_REASONS, entry.reason)
          : entry.reason === 'invalid_source_configuration'
            || !setHasCaptured(STABLE_SOURCE_REASONS, entry.reason))
      ) return null
    }
    setAddCaptured(keys, entry.key)
    pushCaptured(sources, {
      key: entry.key,
      slot: entry.slot,
      status: entry.status as SourceStatus,
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
      observationCount: entry.observationCount as number,
    })
  }
  return sources
}

function parseObservations(value: unknown, runId: string, window: MonitorWindow): MonitorObservation[] | null {
  if (!arrayIsArrayIntrinsic(value) || value.length > MAX_OBSERVATIONS_PER_RUN) return null
  const windowStart = dateParseIntrinsic(window.start)
  const windowEnd = dateParseIntrinsic(window.end)
  const observations: MonitorObservation[] = []
  const ids = new SetIntrinsic<string>()
  for (let entryIndex = 0; entryIndex < value.length; entryIndex += 1) {
    const entry = value[entryIndex]
    if (!isObject(entry) || objectKeysIntrinsic(entry).length !== 9) return null
    if (
      typeof entry.id !== 'string' || entry.id.length === 0
      || entry.id.length > MAX_MARKETING_MONITOR_OBSERVATION_ID_LENGTH
      || setHasCaptured(ids, entry.id)
      || entry.runId !== runId
      || typeof entry.metricKey !== 'string' || !objectHasOwnIntrinsic(MARKETING_MONITOR_METRIC_CONTRACT, entry.metricKey)
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
      || dateParseIntrinsic(row.window_end) - dateParseIntrinsic(row.window_start) > MAX_MARKETING_MONITOR_WINDOW_MS
      || !canonicalTimestamp(row.created_at) || !canonicalTimestamp(row.completed_at)
      || !(reflectApplyIntrinsic(regexpTestIntrinsic, HEX_SHA256, [row.evidence_digest]) as boolean)
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
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      const source = sources[sourceIndex]
      let count = 0
      for (let observationIndex = 0; observationIndex < observations.length; observationIndex += 1) {
        const observation = observations[observationIndex]
        if (observation.sourceKey === source.key && observation.sourceSlot === source.slot) count += 1
      }
      if (count !== source.observationCount) return null
    }
    for (let observationIndex = 0; observationIndex < observations.length; observationIndex += 1) {
      const observation = observations[observationIndex]
      let attributed = false
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
        const source = sources[sourceIndex]
        if (
          source.status === 'available'
          && source.key === observation.sourceKey
          && source.slot === observation.sourceSlot
        ) {
          attributed = true
          break
        }
      }
      if (!attributed) return null
    }
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

function createRegisteredSources(
  runId: string,
  bindings: readonly ResolvedAddonBinding[],
): readonly MarketingMonitorSource[] {
  const sources: MarketingMonitorSource[] = []
  for (let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex += 1) {
    const binding = bindings[bindingIndex]
    for (let adapterIndex = 0; adapterIndex < MARKETING_MONITOR_ADAPTERS.length; adapterIndex += 1) {
      const registered = MARKETING_MONITOR_ADAPTERS[adapterIndex]
      if (registered.adapter !== binding.adapter) continue
      pushCaptured(sources, registered.create(runId))
      break
    }
  }
  return sources
}

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
    const sources = deps.sourceFactory
      ? await deps.sourceFactory({ runId, window })
      : createRegisteredSources(runId, bindings)
    collection = await collectMarketingSnapshots(captured.env, bindings, window, sources)
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
  const sourcesJson = trustedJsonStringify(sources)
  const observationsJson = trustedJsonStringify(observations)
  const outcomesJson = trustedJsonStringify(outcomes)

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

interface MarketingMonitorReadScope {
  readonly installationId: string
  readonly generationId: string
  readonly bindingCount: number
}

function normalizedReadScope(input: MarketingMonitorReadScopeInput): MarketingMonitorReadScope | null | undefined {
  const hasInstallation = typeof input.installationId === 'string'
  const hasGeneration = typeof input.generationId === 'string'
  const hasBindingCount = typeof input.bindingCount === 'number'
    && numberIsIntegerIntrinsic(input.bindingCount)
    && input.bindingCount >= 0
  if (!hasInstallation && !hasGeneration && input.bindingCount === undefined) return null
  if (!hasInstallation || !hasGeneration || !hasBindingCount) return undefined
  return {
    installationId: input.installationId,
    generationId: input.generationId,
    bindingCount: input.bindingCount,
  }
}

function scopedRunSelect(limitClause: string): string {
  const entry = getRegisteredAddon(MARKETING_ADDON_KEY)
  if (!entry) return 'SELECT NULL WHERE 0'
  return `
    WITH live_scope AS (
      SELECT installation.id AS installation_id, generation.id AS generation_id
        FROM addon_installations AS installation
        JOIN addon_binding_generations AS generation
          ON generation.tenant = installation.tenant
         AND generation.installation_id = installation.id
         AND generation.manifest_sha256 = installation.manifest_sha256
         AND generation.revoked_at IS NULL
       WHERE installation.tenant = ?1
         AND installation.addon_key = ?2
         AND installation.installed_version = ?3
         AND installation.publisher = ?4
         AND installation.trust_class = ?5
         AND installation.mupot_compatibility = ?6
         AND installation.manifest_sha256 = ?7
         AND installation.state <> 'archived'
         AND generation.binding_count = (
           SELECT COUNT(*)
             FROM addon_connector_bindings AS binding
            WHERE binding.tenant = generation.tenant
              AND binding.installation_id = generation.installation_id
              AND binding.generation_id = generation.id
              AND binding.manifest_sha256 = generation.manifest_sha256
              AND binding.revoked_at IS NULL
         )
         AND (
           ?9 IS NULL OR (
             installation.id = ?9
             AND generation.id = ?10
             AND generation.binding_count = ?11
           )
         )
    )
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
      FROM live_scope
      LEFT JOIN marketing_monitor_runs AS run
        ON run.tenant = ?1
       AND run.installation_id = live_scope.installation_id
       AND run.binding_generation_id = live_scope.generation_id
       AND run.addon_key = ?2
       AND run.installed_version = ?3
       AND run.publisher = ?4
       AND run.trust_class = ?5
       AND run.mupot_compatibility = ?6
       AND run.manifest_sha256 = ?7
       AND run.program_version = ?8
       AND run.status = 'completed'
     ORDER BY run.completed_at DESC, run.id DESC
     ${limitClause}
  `
}

function readIdentityBindings(captured: CapturedDatabase, scope: MarketingMonitorReadScope | null): unknown[] {
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
    scope?.installationId ?? null,
    scope?.generationId ?? null,
    scope?.bindingCount ?? null,
  ]
}

export async function getLatestMarketingMonitorRun(
  env: Env,
  actor: AddonActor,
  input: MarketingMonitorReadScopeInput = {},
): Promise<GetMarketingMonitorRunResult> {
  if (!isAdminPlus(actor)) return { ok: false, reason: 'not_authorized' }
  const captured = captureDatabase(env)
  if (!captured) return { ok: false, reason: 'write_failed' }
  try {
    const scope = normalizedReadScope(input)
    if (scope === undefined) return { ok: false, reason: 'fence_lost' }
    const row = await captured.db.prepare(scopedRunSelect('LIMIT 1'))
      .bind(...readIdentityBindings(captured, scope)).first<StoredRunRow>()
    if (!row) return { ok: false, reason: 'fence_lost' }
    if (row.id === null) return { ok: true, run: null }
    const run = await parseStoredRun(row)
    return run ? { ok: true, run } : { ok: false, reason: 'stored_run_invalid' }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

export async function listMarketingMonitorRuns(
  env: Env,
  actor: AddonActor,
  input: { readonly limit: number } & MarketingMonitorReadScopeInput,
): Promise<ListMarketingMonitorRunsResult> {
  if (!isAdminPlus(actor)) return { ok: false, reason: 'not_authorized' }
  if (!numberIsIntegerIntrinsic(input.limit) || input.limit < 1 || input.limit > MAX_MARKETING_MONITOR_RUN_LIST) {
    return { ok: false, reason: 'invalid_limit' }
  }
  const captured = captureDatabase(env)
  if (!captured) return { ok: false, reason: 'write_failed' }
  try {
    const scope = normalizedReadScope(input)
    if (scope === undefined) return { ok: false, reason: 'fence_lost' }
    const result = await captured.db.prepare(scopedRunSelect('LIMIT ?12'))
      .bind(...readIdentityBindings(captured, scope), input.limit).all<StoredRunRow>()
    const runs: MarketingMonitorRun[] = []
    const rows = result.results ?? []
    if (rows.length === 0) return { ok: false, reason: 'fence_lost' }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (row.id === null) return rows.length === 1
        ? { ok: true, runs: [] }
        : { ok: false, reason: 'stored_run_invalid' }
      const run = await parseStoredRun(row)
      if (!run) return { ok: false, reason: 'stored_run_invalid' }
      pushCaptured(runs, run)
    }
    return { ok: true, runs }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

function parseLimitingEvidence(value: unknown): readonly LimitingMarketingEvidence[] | null {
  if (!arrayIsArrayIntrinsic(value) || value.length > 5) return null
  const limiting: LimitingMarketingEvidence[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (typeof item !== 'object' || item === null || arrayIsArrayIntrinsic(item)) return null
    const record = item as Record<string, unknown>
    if (
      objectKeysIntrinsic(record).length !== 3
      || !setHasCaptured(RECOMMENDATION_KPIS, record.outcome)
      || record.status !== 'unavailable'
      || typeof record.reason !== 'string'
      || record.reason.length === 0
    ) return null
    reflectApplyIntrinsic(arrayPushIntrinsic, limiting, [objectFreezeIntrinsic({
      outcome: record.outcome as MarketingOpportunityKpi,
      status: 'unavailable' as const,
      reason: record.reason,
    })])
  }
  return objectFreezeIntrinsic(limiting)
}

function recommendationFromRow(row: StoredRecommendationRow): MarketingRecommendation | null {
  try {
    const baseline = jsonParseIntrinsic(row.kpi_baseline_json)
    const limiting = parseLimitingEvidence(jsonParseIntrinsic(row.limiting_evidence_json))
    if (
      row.status !== 'ready'
      || row.program_version !== MARKETING_MONITOR_PROGRAM_VERSION
      || !setHasCaptured(RECOMMENDATION_KINDS, row.kind)
      || !setHasCaptured(RECOMMENDATION_KPIS, row.primary_kpi)
      || !validOutcome(baseline)
      || !limiting
      || !(reflectApplyIntrinsic(regexpTestIntrinsic, HEX_SHA256, [row.evidence_digest]) as boolean)
      || !(reflectApplyIntrinsic(regexpTestIntrinsic, HEX_SHA256, [row.dedup_key]) as boolean)
      || !(reflectApplyIntrinsic(regexpTestIntrinsic, HEX_SHA256, [row.receipt_digest]) as boolean)
      || row.approval_required !== 1
      || row.approval_action !== 'promote_recommendation'
      || row.required_capability !== 'owner'
      || row.self_approval !== 0
      || row.terminal_action !== 'recommendation_ready'
      || !canonicalTimestamp(row.created_at)
      || !canonicalTimestamp(row.prepared_at)
      || row.prepared_at < row.created_at
    ) return null
    return objectFreezeIntrinsic({
      id: row.id,
      installationId: row.installation_id,
      runId: row.run_id,
      programVersion: row.program_version,
      kind: row.kind,
      target: row.target,
      problem: row.problem,
      hypothesis: row.hypothesis,
      primaryKpi: row.primary_kpi,
      kpiBaseline: objectFreezeIntrinsic({ ...baseline }),
      limitingEvidence: limiting,
      evidenceDigest: row.evidence_digest,
      dedupKey: row.dedup_key,
      taskId: row.task_id,
      flightId: row.flight_id,
      approval: objectFreezeIntrinsic({
        required: true as const,
        action: 'promote_recommendation' as const,
        requiredCapability: 'owner' as const,
        selfApproval: false as const,
      }),
      terminalAction: 'recommendation_ready' as const,
      receiptDigest: row.receipt_digest,
      createdAt: row.created_at,
      preparedAt: row.prepared_at,
    })
  } catch {
    return null
  }
}

const RECOMMENDATION_COLUMNS = `
  id, installation_id, run_id, program_version, kind, target, problem, hypothesis,
  primary_kpi, kpi_baseline_json, limiting_evidence_json, evidence_digest, dedup_key,
  task_id, flight_id, approval_required, approval_action, required_capability,
  self_approval, terminal_action, receipt_digest, status, created_at, prepared_at
`

const JOINED_RECOMMENDATION_COLUMNS = `
  recommendation.id AS id,
  recommendation.installation_id AS installation_id,
  recommendation.run_id AS run_id,
  recommendation.program_version AS program_version,
  recommendation.kind AS kind,
  recommendation.target AS target,
  recommendation.problem AS problem,
  recommendation.hypothesis AS hypothesis,
  recommendation.primary_kpi AS primary_kpi,
  recommendation.kpi_baseline_json AS kpi_baseline_json,
  recommendation.limiting_evidence_json AS limiting_evidence_json,
  recommendation.evidence_digest AS evidence_digest,
  recommendation.dedup_key AS dedup_key,
  recommendation.task_id AS task_id,
  recommendation.flight_id AS flight_id,
  recommendation.approval_required AS approval_required,
  recommendation.approval_action AS approval_action,
  recommendation.required_capability AS required_capability,
  recommendation.self_approval AS self_approval,
  recommendation.terminal_action AS terminal_action,
  recommendation.receipt_digest AS receipt_digest,
  recommendation.status AS status,
  recommendation.created_at AS created_at,
  recommendation.prepared_at AS prepared_at
`

async function loadReadyRecommendationByDedup(
  captured: CapturedDatabase,
  installationId: string,
  dedupKey: string,
): Promise<MarketingRecommendation | null> {
  const row = await captured.db.prepare(`
    SELECT ${RECOMMENDATION_COLUMNS}
      FROM marketing_recommendations
     WHERE tenant = ?1 AND installation_id = ?2 AND dedup_key = ?3 AND status = 'ready'
     LIMIT 1
  `).bind(captured.tenant, installationId, dedupKey).first<StoredRecommendationRow>()
  return row ? recommendationFromRow(row) : null
}

async function resolveOwnedWebOperationsSquad(
  captured: CapturedDatabase,
  installationId: string,
): Promise<string | null> {
  const row = await captured.db.prepare(`
    SELECT squad.id
      FROM addon_resource_ownership AS claim
      JOIN departments AS department
        ON department.id = claim.resource_id
       AND department.template_key = claim.resource_key
       AND department.active = 1
      JOIN squads AS squad ON squad.department_id = department.id
     WHERE claim.tenant = ?1
       AND claim.installation_id = ?2
       AND claim.resource_type = 'department'
       AND claim.resource_key = 'web-ops'
       AND claim.active = 1
     ORDER BY CASE WHEN squad.slug = 'strategy' THEN 0 ELSE 1 END, squad.slug, squad.id
     LIMIT 1
  `).bind(captured.tenant, installationId).first<{ id: string }>()
  return row?.id ?? null
}

function recommendationTaskBody(
  run: MarketingMonitorRun,
  candidate: MarketingOpportunityCandidate,
  recommendationId: string,
  dedupKey: string,
): string {
  return trustedJsonStringify({
    schema: 'mupot.marketing-recommendation/v1',
    recommendation: {
      id: recommendationId,
      dedupKey,
    },
    target: candidate.target,
    problem: candidate.problem,
    hypothesis: candidate.hypothesis,
    primaryKpi: candidate.primaryKpi,
    kpiBaseline: candidate.kpiBaseline,
    limitingEvidence: candidate.limitingEvidence,
    evidence: {
      programVersion: run.programVersion,
      window: run.window,
      digest: run.evidenceDigest,
    },
    approval: {
      required: true,
      action: 'promote_recommendation',
      requiredCapability: 'owner',
      selfApproval: false,
    },
  })
}

async function loadRecommendationPreparation(
  captured: CapturedDatabase,
  installationId: string,
  dedupKey: string,
): Promise<RecommendationPreparationRow | null> {
  return captured.db.prepare(`
    SELECT id, installation_id, binding_generation_id, run_id, program_version,
           kind, target, evidence_digest, dedup_key, squad_id, created_by, created_at, status
      FROM marketing_recommendations
     WHERE tenant = ?1 AND installation_id = ?2 AND dedup_key = ?3 AND status = 'preparing'
     LIMIT 1
  `).bind(captured.tenant, installationId, dedupKey).first<RecommendationPreparationRow>()
}

function validRecommendationPreparation(
  row: RecommendationPreparationRow,
  context: LiveContext,
  run: MarketingMonitorRun,
  candidate: MarketingOpportunityCandidate,
  dedupKey: string,
  squadId: string,
): boolean {
  return row.installation_id === context.installation.id
    && row.binding_generation_id === context.generation.id
    && row.run_id === run.id
    && row.program_version === run.programVersion
    && row.kind === candidate.kind
    && row.target === candidate.target
    && row.evidence_digest === run.evidenceDigest
    && row.dedup_key === dedupKey
    && row.squad_id === squadId
    && row.status === 'preparing'
    && canonicalTimestamp(row.created_at)
}

async function loadPreparedRecommendationTask(
  captured: CapturedDatabase,
  squadId: string,
  title: string,
  body: string,
  doneWhen: string,
): Promise<{ id: string } | null> {
  return captured.db.prepare(`
    SELECT id
      FROM tasks
     WHERE squad_id = ?1
       AND title = ?2
       AND body = ?3
       AND done_when = ?4
       AND status = 'review'
       AND gate_owner = ?5
     LIMIT 1
  `).bind(
    squadId,
    title,
    body,
    doneWhen,
    MARKETING_RECOMMENDATION_GATE_OWNER,
  ).first<{ id: string }>()
}

async function loadPreparedRecommendationFlight(
  captured: CapturedDatabase,
  goalId: string,
  expectedMeta: FlightMetaV1,
): Promise<string | null> {
  const row = await captured.db.prepare(`
    SELECT id, meta
      FROM flights
     WHERE tenant = ?1
       AND agent = 'addon:marketing-cro-monitor'
       AND status = 'preflight'
       AND json_valid(meta)
       AND json_extract(meta, '$.schema') = ?2
       AND json_extract(meta, '$.goal_id') = ?3
     LIMIT 1
  `).bind(captured.tenant, FLIGHT_META_V1_SCHEMA, goalId).first<{ id: string; meta: string }>()
  if (!row) return null
  try {
    const parsed = parseFlightMetaV1(jsonParseIntrinsic(row.meta))
    return parsed && trustedJsonStringify(parsed) === trustedJsonStringify(expectedMeta)
      ? row.id
      : null
  } catch {
    return null
  }
}

export async function prepareMarketingRecommendation(
  env: Env,
  actor: AddonActor,
  runId: string,
  deps: MarketingRecommendationDeps = {},
): Promise<PrepareMarketingRecommendationResult> {
  if (!isAdminPlus(actor)) return { ok: false, reason: 'not_authorized' }
  if (typeof runId !== 'string' || runId.length === 0) return { ok: false, reason: 'run_not_latest' }
  const captured = captureDatabase(env)
  if (!captured) return { ok: false, reason: 'write_failed' }

  let context: LiveContext
  try {
    const loaded = await loadLiveContext(captured)
    if (!loaded.ok) return loaded
    context = loaded.context
  } catch {
    return { ok: false, reason: 'write_failed' }
  }

  const latestResult = await getLatestMarketingMonitorRun(captured.env, actor, {
    installationId: context.installation.id,
    generationId: context.generation.id,
    bindingCount: context.generation.binding_count,
  })
  if (!latestResult.ok) return latestResult
  if (!latestResult.run || latestResult.run.id !== runId) return { ok: false, reason: 'run_not_latest' }
  const run = latestResult.run
  const candidate = rankMarketingOpportunities(run)[0]
  if (!candidate) return { ok: false, reason: 'no_opportunity' }

  const entry = getRegisteredAddon(MARKETING_ADDON_KEY)
  const approval = entry?.manifest.approvalPolicies.find(
    (policy) => policy.action === 'promote_recommendation',
  )
  if (!approval || approval.requiredCapability !== 'owner' || approval.selfApproval !== false) {
    return { ok: false, reason: 'approval_policy_missing' }
  }

  let squadId: string | null
  try {
    squadId = await resolveOwnedWebOperationsSquad(captured, context.installation.id)
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
  if (!squadId) return { ok: false, reason: 'web_operations_squad_not_found' }

  const dedupKey = await sha256Json({
    schema: 'mupot.marketing-recommendation-dedup/v1',
    tenant: captured.tenant,
    installationId: context.installation.id,
    programVersion: run.programVersion,
    target: candidate.target,
    window: run.window,
    kind: candidate.kind,
  })
  let recommendationId = randomUUIDIntrinsic()
  let createdAt = nowIso()
  let claimed: D1Result<unknown>
  try {
    claimed = await captured.db.prepare(`
      INSERT INTO marketing_recommendations (
        id, tenant, installation_id, binding_generation_id, run_id, program_version,
        kind, target, problem, hypothesis, primary_kpi, kpi_baseline_json,
        limiting_evidence_json, evidence_digest, dedup_key, squad_id,
        approval_required, approval_action, required_capability, self_approval,
        terminal_action, status, created_by, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11, ?12,
        ?13, ?14, ?15, ?16,
        1, 'promote_recommendation', 'owner', 0,
        'recommendation_ready', 'preparing', ?17, ?18
      )
      ON CONFLICT (tenant, dedup_key) DO NOTHING
    `).bind(
      recommendationId,
      captured.tenant,
      context.installation.id,
      context.generation.id,
      run.id,
      run.programVersion,
      candidate.kind,
      candidate.target,
      candidate.problem,
      candidate.hypothesis,
      candidate.primaryKpi,
      trustedJsonStringify(candidate.kpiBaseline),
      trustedJsonStringify(candidate.limitingEvidence),
      run.evidenceDigest,
      dedupKey,
      squadId,
      actor.id,
      createdAt,
    ).run()
  } catch {
    return { ok: false, reason: 'write_failed' }
  }

  if (!resultsWritten(claimed)) {
    try {
      const existing = await loadReadyRecommendationByDedup(captured, context.installation.id, dedupKey)
      if (existing) return { ok: true, idempotent: true, recommendation: existing }
      const preparation = await loadRecommendationPreparation(captured, context.installation.id, dedupKey)
      if (!preparation || !validRecommendationPreparation(
        preparation,
        context,
        run,
        candidate,
        dedupKey,
        squadId,
      )) return { ok: false, reason: 'fence_lost' }
      recommendationId = preparation.id
      createdAt = preparation.created_at
    } catch {
      return { ok: false, reason: 'write_failed' }
    }
  }

  const doCreateTask = deps.createTask ?? canonicalCreateTask
  const doCreateFlight = deps.createFlight ?? canonicalCreateFlight
  const doneWhen = 'An owner approves or rejects the recommendation; no external change is executed'
  const taskTitle = `Review CRO recommendation: ${candidate.primaryKpi}`
  const taskBody = recommendationTaskBody(run, candidate, recommendationId, dedupKey)
  try {
    const existingTask = await loadPreparedRecommendationTask(
      captured,
      squadId,
      taskTitle,
      taskBody,
      doneWhen,
    )
    const task = existingTask ?? await doCreateTask(
      env,
      {
        squad_id: squadId,
        title: taskTitle,
        body: taskBody,
        done_when: doneWhen,
        status: 'review',
        gate_owner: MARKETING_RECOMMENDATION_GATE_OWNER,
      },
      { actor: { kind: 'member', id: actor.id }, skipMirror: true },
    )
    const goalId = `marketing-recommendation:${recommendationId}`
    const flightMeta: FlightMetaV1 = {
      schema: FLIGHT_META_V1_SCHEMA,
      goal_id: goalId,
      objective_id: candidate.kind,
      squad_ids: [squadId],
      task_ids: [task.id],
      done_when: [doneWhen],
      artifact_refs: [goalId],
      receipt_refs: [`marketing-monitor-evidence:${run.evidenceDigest}`],
      confidentiality: 'internal',
      publication_target: 'none',
      parent_flight_id: null,
    }
    const existingFlightId = await loadPreparedRecommendationFlight(captured, goalId, flightMeta)
    const flightId = existingFlightId ?? await doCreateFlight(env, {
      agent: 'addon:marketing-cro-monitor',
      goal: `Prepare ${candidate.kind} for owner review`,
      trigger_source: 'event',
      budget_micro_usd: 0,
      meta: flightMeta,
    })
    const preparedAt = nowIso()
    const receiptDigest = await sha256Json({
      schema: 'mupot.marketing-recommendation-receipt/v1',
      recommendationId,
      tenant: captured.tenant,
      installationId: context.installation.id,
      runId: run.id,
      programVersion: run.programVersion,
      window: run.window,
      evidenceDigest: run.evidenceDigest,
      candidate,
      dedupKey,
      taskId: task.id,
      flightId,
      approval: {
        required: true,
        action: 'promote_recommendation',
        requiredCapability: 'owner',
        selfApproval: false,
      },
      terminalAction: 'recommendation_ready',
      executor: null,
      createdAt,
      preparedAt,
    })
    const finalized = await captured.db.prepare(`
      UPDATE marketing_recommendations
         SET task_id = ?1, flight_id = ?2, receipt_digest = ?3,
             prepared_at = ?4, status = 'ready'
       WHERE id = ?5 AND tenant = ?6 AND installation_id = ?7
         AND dedup_key = ?8 AND status = 'preparing'
    `).bind(
      task.id,
      flightId,
      receiptDigest,
      preparedAt,
      recommendationId,
      captured.tenant,
      context.installation.id,
      dedupKey,
    ).run()
    if (!resultsWritten(finalized)) {
      const existing = await loadReadyRecommendationByDedup(captured, context.installation.id, dedupKey)
      return existing
        ? { ok: true, idempotent: true, recommendation: existing }
        : { ok: false, reason: 'fence_lost' }
    }
    const recommendation = await loadReadyRecommendationByDedup(
      captured,
      context.installation.id,
      dedupKey,
    )
    return recommendation
      ? { ok: true, idempotent: false, recommendation }
      : { ok: false, reason: 'stored_run_invalid' }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}

export async function getLatestMarketingRecommendation(
  env: Env,
  actor: AddonActor,
  input: { readonly installationId: string; readonly runId?: string },
): Promise<GetMarketingRecommendationResult> {
  if (!isAdminPlus(actor)) return { ok: false, reason: 'not_authorized' }
  const captured = captureDatabase(env)
  if (!captured) return { ok: false, reason: 'write_failed' }
  const entry = getRegisteredAddon(MARKETING_ADDON_KEY)
  if (!entry) return { ok: false, reason: 'addon_identity_mismatch' }
  try {
    const row = await captured.db.prepare(`
      SELECT ${JOINED_RECOMMENDATION_COLUMNS}
        FROM marketing_recommendations AS recommendation
        JOIN addon_installations AS installation
          ON installation.id = recommendation.installation_id
         AND installation.tenant = recommendation.tenant
       WHERE recommendation.tenant = ?1
         AND recommendation.installation_id = ?2
         AND (?3 IS NULL OR recommendation.run_id = ?3)
         AND recommendation.status = 'ready'
         AND installation.addon_key = ?4
         AND installation.installed_version = ?5
         AND installation.publisher = ?6
         AND installation.trust_class = ?7
         AND installation.mupot_compatibility = ?8
         AND installation.manifest_sha256 = ?9
       ORDER BY recommendation.prepared_at DESC, recommendation.id DESC
       LIMIT 1
    `).bind(
      captured.tenant,
      input.installationId,
      input.runId ?? null,
      entry.manifest.key,
      entry.manifest.version,
      entry.manifest.publisher,
      entry.manifest.trustClass,
      entry.manifest.mupotCompatibility,
      entry.manifestSha256,
    ).first<StoredRecommendationRow>()
    if (!row) return { ok: true, recommendation: null }
    const recommendation = recommendationFromRow(row)
    return recommendation
      ? { ok: true, recommendation }
      : { ok: false, reason: 'stored_run_invalid' }
  } catch {
    return { ok: false, reason: 'write_failed' }
  }
}
