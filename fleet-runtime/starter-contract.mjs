import { isAbsolute, posix } from 'node:path'

import { SECRET_VALUE_PATTERNS } from './service-context.mjs'
import { normalizeAgentProfile } from './profile-contract.mjs'

export const STARTER_RECEIPT_TYPE = 'mupot-fleet-starter-receipt/v1'

export const STARTER_ARTIFACT_ROLES = Object.freeze([
  'install',
  'service',
  'host',
  'continuous',
  'runtime_inbox',
  'lifecycle_control_start',
  'lifecycle_control_stop',
  'receipt_bundle_manifest',
])

export const STARTER_CHECKS = Object.freeze([
  'starter_manifest_valid',
  'install_receipt_pass',
  'service_receipt_pass',
  'host_receipt_pass',
  'continuous_receipt_pass',
  'runtime_inbox_receipt_pass',
  'lifecycle_control_start_receipt_pass',
  'lifecycle_control_stop_receipt_pass',
  'receipt_bundle_manifest_pass',
  'artifact_paths_portable',
  'artifact_digests_valid',
])

export const STARTER_MANIFEST_KEYS = Object.freeze([
  'version',
  'tenant',
  'base_url',
  'service_manager',
  'agents',
  'control_consumer_agent_id',
])
const STARTER_MANIFEST_PROFILE_KEYS = Object.freeze([...STARTER_MANIFEST_KEYS, 'profiles'])

const AGENT_KEYS = Object.freeze(['agent_id', 'runtime', 'probe', 'handler'])
const RECEIPT_KEYS = Object.freeze(['receipt_type', 'generated_at', 'status', 'manifest', 'artifacts', 'checks'])
const MANIFEST_REF_KEYS = Object.freeze(['path', 'sha256'])
const ARTIFACT_KEYS = Object.freeze(['role', 'path', 'sha256'])
const CHECK_KEYS = Object.freeze(['check', 'ok'])
const SHA256_RE = /^[a-f0-9]{64}$/
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const RUNTIMES = new Set(['hermes', 'codex'])
const SERVICE_MANAGERS = new Set(['auto', 'launchd', 'systemd'])
const SECRET_FIELD_RE = /(?:^|[_-])(authorization|bearer|token|secret|password|passwd|api[_-]?key|private[_-]?key|client[_-]?secret|cookie)(?:$|[_-])/i
const PRODUCTION_IDENTITY_RE = /(?:^|[^a-z0-9])mumega(?:[^a-z0-9]|$)|\.mumega\.com(?:[/:]|$)/i

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
}

function containsSecret(value, key = '') {
  if (SECRET_FIELD_RE.test(key)) return true
  if (typeof value === 'string') return SECRET_VALUE_PATTERNS.some(([, pattern]) => pattern.test(value))
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry))
  if (!isPlainObject(value)) return false
  if (typeof value.kty === 'string' && typeof value.d === 'string') return true
  return Object.entries(value).some(([childKey, child]) => containsSecret(child, childKey))
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

export function isPortableStarterPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) return false
  if (isAbsolute(value) || value.startsWith('~/') || value === '.' || value === '..') return false
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false
  return posix.normalize(value) === value
}

function normalizeAgent(raw) {
  if (!hasExactKeys(raw, AGENT_KEYS) || !AGENT_ID_RE.test(raw.agent_id ?? '') || !RUNTIMES.has(raw.runtime)) return null
  if (typeof raw.probe !== 'string' || raw.probe.trim().length === 0 || typeof raw.handler !== 'string' || raw.handler.trim().length === 0) return null
  if (containsSecret(raw)) return null
  return { agent_id: raw.agent_id, runtime: raw.runtime, probe: raw.probe, handler: raw.handler }
}

export function normalizeStarterManifest(raw) {
  const hasProfiles = isPlainObject(raw) && Object.hasOwn(raw, 'profiles')
  if (!hasExactKeys(raw, hasProfiles ? STARTER_MANIFEST_PROFILE_KEYS : STARTER_MANIFEST_KEYS) || containsSecret(raw)) return null
  if (raw.version !== 1 || !TENANT_RE.test(raw.tenant ?? '') || PRODUCTION_IDENTITY_RE.test(raw.tenant)) return null
  if (!SERVICE_MANAGERS.has(raw.service_manager) || !Array.isArray(raw.agents) || raw.agents.length === 0) return null

  let baseUrl
  try {
    baseUrl = new URL(raw.base_url)
  } catch {
    return null
  }
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || PRODUCTION_IDENTITY_RE.test(baseUrl.hostname)) return null

  const agents = raw.agents.map(normalizeAgent)
  if (agents.some((agent) => agent === null)) return null
  const ids = agents.map((agent) => agent.agent_id)
  if (new Set(ids).size !== ids.length || !ids.includes(raw.control_consumer_agent_id)) return null

  let profiles
  if (hasProfiles) {
    if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) return null
    profiles = raw.profiles.map(normalizeAgentProfile)
    if (profiles.some((profile) => profile === null)) return null
    const profileIds = profiles.map((profile) => profile.agent_id)
    if (new Set(profileIds).size !== profileIds.length || profileIds.some((agentId) => !ids.includes(agentId))) return null
  }

  return {
    version: 1,
    tenant: raw.tenant,
    base_url: raw.base_url,
    service_manager: raw.service_manager,
    agents,
    control_consumer_agent_id: raw.control_consumer_agent_id,
    ...(profiles ? { profiles } : {}),
  }
}

export function validateStarterManifest(raw) {
  const normalized = normalizeStarterManifest(raw)
  if (!normalized) throw new TypeError('invalid sterile starter manifest contract')
  return normalized
}

function normalizeArtifact(raw, expectedRole) {
  if (!hasExactKeys(raw, ARTIFACT_KEYS) || raw.role !== expectedRole) return null
  if (!isPortableStarterPath(raw.path) || !SHA256_RE.test(raw.sha256 ?? '')) return null
  return { role: raw.role, path: raw.path, sha256: raw.sha256 }
}

export function normalizeStarterReceipt(raw) {
  if (!hasExactKeys(raw, RECEIPT_KEYS) || containsSecret(raw)) return null
  if (raw.receipt_type !== STARTER_RECEIPT_TYPE || raw.status !== 'pass' || !validTimestamp(raw.generated_at)) return null
  if (!hasExactKeys(raw.manifest, MANIFEST_REF_KEYS) || !isPortableStarterPath(raw.manifest.path) || !SHA256_RE.test(raw.manifest.sha256 ?? '')) return null
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length !== STARTER_ARTIFACT_ROLES.length) return null
  const artifacts = raw.artifacts.map((artifact, index) => normalizeArtifact(artifact, STARTER_ARTIFACT_ROLES[index]))
  if (artifacts.some((artifact) => artifact === null)) return null
  const paths = [raw.manifest.path, ...artifacts.map((artifact) => artifact.path)]
  if (new Set(paths).size !== paths.length) return null
  if (!Array.isArray(raw.checks) || raw.checks.length !== STARTER_CHECKS.length) return null
  const checks = raw.checks.map((check, index) => {
    if (!hasExactKeys(check, CHECK_KEYS) || check.check !== STARTER_CHECKS[index] || check.ok !== true) return null
    return { check: check.check, ok: true }
  })
  if (checks.some((check) => check === null)) return null

  return {
    receipt_type: STARTER_RECEIPT_TYPE,
    generated_at: raw.generated_at,
    status: 'pass',
    manifest: { path: raw.manifest.path, sha256: raw.manifest.sha256 },
    artifacts,
    checks,
  }
}

export function validateStarterReceipt(raw) {
  const normalized = normalizeStarterReceipt(raw)
  if (!normalized) throw new TypeError('invalid starter receipt contract')
  return normalized
}
