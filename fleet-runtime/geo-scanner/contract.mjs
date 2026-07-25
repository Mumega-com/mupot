import { isAbsolute } from 'node:path'
import { isIP } from 'node:net'

export const SCANNER_CONFIG_SCHEMA = 'dme.geo-scanner-config/v1'
export const GEO_EVENT_SCHEMA = 'dme.geo-scan/v1'
export const GEO_RECEIPT_SCHEMA = 'mupot.geo-scan-receipt/v1'
export const MAX_DAILY_GROUNDED_QUERIES = 25

const CONFIG_KEYS = [
  'schema',
  'project_id',
  'google_project_id',
  'location',
  'model',
  'posthog_host',
  'daily_query_cap',
  'state_file',
  'mupot',
  'profiles',
]
const MUPOT_KEYS = ['base_url', 'receipt_to']
const PROFILE_KEYS = ['id', 'target_domain', 'market', 'tracked_competitors', 'prompts']
const PROMPT_KEYS = ['id', 'text']
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const GCP_PROJECT_RE = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

function fail(code) {
  throw new TypeError(code)
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code)
  const actual = Object.keys(value).sort()
  const wanted = expected.slice().sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code)
}

function boundedString(value, { min = 1, max = 128, code = 'invalid_string' } = {}) {
  if (typeof value !== 'string') fail(code)
  const normalized = value.trim()
  if (normalized.length < min || normalized.length > max || normalized.includes('\0')) fail(code)
  return normalized
}

function ref(value, code) {
  const normalized = boundedString(value, { max: 128, code })
  if (!REF_RE.test(normalized)) fail(code)
  return normalized
}

function isPrivateIp(hostname) {
  const ipVersion = isIP(hostname)
  if (ipVersion === 4) {
    const octets = hostname.split('.').map(Number)
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] === 0
  }
  if (ipVersion === 6) {
    const lower = hostname.toLowerCase()
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8')
      || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')
  }
  return false
}

export function validatePublicHttpsOrigin(value, code = 'invalid_https_origin') {
  const raw = boundedString(value, { max: 2048, code })
  let url
  try {
    url = new URL(raw)
  } catch {
    fail(code)
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'metadata.google.internal'
    || isPrivateIp(hostname)
  ) fail(code)
  return url.origin
}

function domain(value) {
  const normalized = boundedString(value, { max: 253, code: 'invalid_target_domain' })
    .toLowerCase()
    .replace(/\.$/, '')
  if (!DOMAIN_RE.test(normalized)) fail('invalid_target_domain')
  return normalized
}

function normalizePrompt(raw) {
  exactKeys(raw, PROMPT_KEYS, 'invalid_prompt_keys')
  return {
    id: ref(raw.id, 'invalid_prompt_id'),
    text: boundedString(raw.text, { max: 600, code: 'invalid_prompt_text' }),
  }
}

function normalizeProfile(raw) {
  exactKeys(raw, PROFILE_KEYS, 'invalid_profile_keys')
  if (!Array.isArray(raw.tracked_competitors) || raw.tracked_competitors.length > 10) {
    fail('invalid_tracked_competitors')
  }
  const trackedCompetitors = raw.tracked_competitors.map((value) =>
    boundedString(value, { max: 128, code: 'invalid_tracked_competitor' }))
  if (new Set(trackedCompetitors.map((value) => value.toLowerCase())).size !== trackedCompetitors.length) {
    fail('duplicate_tracked_competitor')
  }
  if (!Array.isArray(raw.prompts) || raw.prompts.length < 1 || raw.prompts.length > 5) fail('invalid_prompts')
  const prompts = raw.prompts.map(normalizePrompt)
  if (new Set(prompts.map((prompt) => prompt.id)).size !== prompts.length) fail('duplicate_prompt_id')
  return {
    id: ref(raw.id, 'invalid_profile_id'),
    targetDomain: domain(raw.target_domain),
    market: boundedString(raw.market, { max: 128, code: 'invalid_market' }),
    trackedCompetitors,
    prompts,
  }
}

export function validateScannerConfig(raw) {
  exactKeys(raw, CONFIG_KEYS, 'invalid_config_keys')
  if (raw.schema !== SCANNER_CONFIG_SCHEMA) fail('invalid_config_schema')
  const projectId = ref(raw.project_id, 'invalid_project_id')
  const googleProjectId = boundedString(raw.google_project_id, { max: 63, code: 'invalid_google_project_id' })
  if (!GCP_PROJECT_RE.test(googleProjectId)) fail('invalid_google_project_id')
  if (raw.location !== 'global') fail('invalid_location')
  if (raw.model !== 'gemini-2.5-flash') fail('invalid_model')
  if (
    !Number.isInteger(raw.daily_query_cap)
    || raw.daily_query_cap < 1
    || raw.daily_query_cap > MAX_DAILY_GROUNDED_QUERIES
  ) fail('invalid_daily_query_cap')
  const stateFile = boundedString(raw.state_file, { max: 1024, code: 'invalid_state_file' })
  if (!isAbsolute(stateFile)) fail('invalid_state_file')

  exactKeys(raw.mupot, MUPOT_KEYS, 'invalid_mupot_keys')
  const mupot = {
    baseUrl: validatePublicHttpsOrigin(raw.mupot.base_url, 'invalid_mupot_base_url'),
    receiptTo: ref(raw.mupot.receipt_to, 'invalid_receipt_to'),
  }

  if (!Array.isArray(raw.profiles) || raw.profiles.length < 1 || raw.profiles.length > 5) {
    fail('invalid_profiles')
  }
  const profiles = raw.profiles.map(normalizeProfile)
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) fail('duplicate_profile_id')
  const promptCount = profiles.reduce((count, profile) => count + profile.prompts.length, 0)
  if (promptCount > raw.daily_query_cap) fail('prompt_count_exceeds_daily_query_cap')

  return {
    schema: SCANNER_CONFIG_SCHEMA,
    projectId,
    googleProjectId,
    location: 'global',
    model: 'gemini-2.5-flash',
    posthogHost: validatePublicHttpsOrigin(raw.posthog_host, 'invalid_posthog_host'),
    dailyQueryCap: raw.daily_query_cap,
    stateFile,
    mupot,
    profiles,
  }
}
