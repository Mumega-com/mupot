#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RECEIPT_TYPE = 'mupot-addon-lifecycle/v1'
export const ADDON_KEY = 'fixture-addon'
export const EXPECTED_TRANSITIONS = Object.freeze([
  'installed',
  'configured',
  'active',
  'disabled',
  'active',
  'disabled',
  'archived',
])

const LIFECYCLE = Object.freeze([
  { action: 'install', previousState: null, state: 'installed', status: 201 },
  { action: 'configure', previousState: 'installed', state: 'configured', status: 200 },
  { action: 'activate', previousState: 'configured', state: 'active', status: 200 },
  { action: 'disable', previousState: 'active', state: 'disabled', status: 200 },
  { action: 'activate', previousState: 'disabled', state: 'active', status: 200 },
  { action: 'disable', previousState: 'active', state: 'disabled', status: 200 },
  { action: 'archive', previousState: 'disabled', state: 'archived', status: 200 },
])

const SENSITIVE_KEY_RE = /authorization|token|secret|password/i
const SHA256_RE = /^[a-f0-9]{64}$/

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function shellQuote(value) {
  const raw = String(value)
  if (/^[A-Za-z0-9_./:=@%+~,#-]+$/.test(raw)) return raw
  return `'${raw.replace(/'/g, `'\\''`)}'`
}

function redactedPlanBaseUrl(value) {
  const raw = stripTrailingSlash(value)
  if (!raw) return 'https://<pot-host>'

  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return 'https://<pot-host>'
    return url.origin
  } catch {
    return 'https://<pot-host>'
  }
}

export function parseArgs(argv) {
  const opts = {
    plan: false,
    check: false,
    help: false,
    baseUrl: '',
    tokenEnv: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[index]
    }

    if (arg === '--plan') opts.plan = true
    else if (arg === '--check') opts.check = true
    else if (arg === '--base-url') opts.baseUrl = stripTrailingSlash(next())
    else if (arg === '--token-env') opts.tokenEnv = next()
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }

  return opts
}

export function usage() {
  return [
    'Usage: node scripts/addon-lifecycle-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                    print the no-write operator plan',
    '  --check                   execute and check the fixture lifecycle',
    '  --base-url <url>          Mupot deployment base URL',
    '  --token-env <ENV_NAME>    environment variable containing the bearer',
    '  -h, --help                show this help',
  ].join('\n')
}

export function formatPlan(opts = {}) {
  const baseUrl = redactedPlanBaseUrl(opts.baseUrl)
  const tokenEnv = opts.tokenEnv || '<ENV_NAME>'
  const lines = [
    'Mupot native addon lifecycle evidence plan',
    '',
    'This mode performs no writes. Run the following check against a fresh fixture-addon lifecycle.',
    `1. Read the bearer only from environment variable ${tokenEnv}; never print it.`,
    '2. GET /api/addons/fixture-addon/evidence and record the deployed manifest plus full business-state digest.',
    '3. GET /api/addons/fixture-addon/receipts and require empty fresh-lifecycle evidence with zero ownership claims.',
    '4. POST /api/addons/fixture-addon/install -> 201.',
    '5. Re-read evidence and require the business-state digest is unchanged; require ownershipClaimCount is zero.',
    '6. Validate the install receipt identity, exact state edge, sequence, actor, ID, and chronology.',
    '7. POST configure, activate, disable, activate, disable, then POST /api/addons/fixture-addon/archive; validate each exact receipt edge.',
    '8. POST /api/addons/fixture-addon/activate -> 409 after archive.',
    '9. Require fixture-addon remains archived and the final seven receipts exactly match the observed journal.',
    '10. Emit one redacted mupot-addon-lifecycle/v1 JSON receipt.',
    '',
    `node scripts/addon-lifecycle-receipt.mjs --check --base-url ${shellQuote(baseUrl)} --token-env ${shellQuote(tokenEnv)}`,
  ]
  return `${lines.join('\n')}\n`
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasSensitiveKey(value, path = []) {
  if (Array.isArray(value)) return value.some((entry, index) => hasSensitiveKey(entry, [...path, index]))
  if (!isRecord(value)) return false

  for (const [key, child] of Object.entries(value)) {
    const requiredSentinel = path.length === 0 && key === 'secrets_present'
    if (!requiredSentinel && SENSITIVE_KEY_RE.test(key)) return true
    if (hasSensitiveKey(child, [...path, key])) return true
  }
  return false
}

function hasCredentialValue(value, credential) {
  if (typeof value === 'string') return value.includes(credential)
  if (Array.isArray(value)) return value.some((entry) => hasCredentialValue(entry, credential))
  if (!isRecord(value)) return false
  return Object.values(value).some((entry) => hasCredentialValue(entry, credential))
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isReceiptId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

function sameTransitions(actual) {
  return Array.isArray(actual)
    && actual.length === EXPECTED_TRANSITIONS.length
    && actual.every((state, index) => state === EXPECTED_TRANSITIONS[index])
}

function validSequenceEvidence(value) {
  return Array.isArray(value)
    && value.length === LIFECYCLE.length
    && value.every((sequence) => Number.isSafeInteger(sequence) && sequence > 0)
    && value.every((sequence, index) => index === 0 || sequence > value[index - 1])
}

function validChronologyEvidence(value) {
  if (!Array.isArray(value) || value.length !== LIFECYCLE.length) return false
  const times = value.map((entry) => typeof entry === 'string' ? Date.parse(entry) : Number.NaN)
  return times.every(Number.isFinite)
    && times.every((time, index) => index === 0 || time >= times[index - 1])
}

export function validateReceipt(value) {
  const errors = []
  if (!isRecord(value)) return { ok: false, errors: ['receipt_not_object'] }

  if (value.receipt_type !== RECEIPT_TYPE) errors.push('receipt_type_invalid')
  if (value.status !== 'pass') errors.push('status_not_pass')
  if (value.addon_key !== ADDON_KEY) errors.push('addon_key_invalid')
  if (!sameTransitions(value.transitions)) errors.push('transitions_mismatch')
  if (Array.isArray(value.transitions)) {
    const archivedAt = value.transitions.indexOf('archived')
    if (archivedAt >= 0 && value.transitions.slice(archivedAt + 1).includes('active')) {
      errors.push('archived_reactivation')
    }
  }
  if (value.install_side_effect_count !== 0) errors.push('install_side_effect_count_nonzero')
  if (typeof value.manifest_sha256 !== 'string' || !SHA256_RE.test(value.manifest_sha256)) {
    errors.push('manifest_sha256_invalid')
  }
  if (!isNonEmptyString(value.installed_version)) errors.push('installed_version_invalid')
  if (!isNonEmptyString(value.publisher)) errors.push('publisher_invalid')
  if (value.trust_class !== 'native_reviewed') errors.push('trust_class_invalid')
  if (!isNonEmptyString(value.actor_id)) errors.push('actor_id_invalid')
  if (!Array.isArray(value.receipt_ids)
    || value.receipt_ids.length !== LIFECYCLE.length
    || !value.receipt_ids.every(isReceiptId)
    || new Set(value.receipt_ids).size !== value.receipt_ids.length) {
    errors.push('receipt_ids_invalid')
  }
  if (!validSequenceEvidence(value.receipt_sequences)) errors.push('receipt_sequences_invalid')
  if (!validChronologyEvidence(value.receipt_created_at)) errors.push('receipt_chronology_invalid')
  if (value.secrets_present !== false) errors.push('secrets_present')
  if (hasSensitiveKey(value)) errors.push('sensitive_key_present')

  return { ok: errors.length === 0, errors }
}

class LifecycleFailure extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function checkedBaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('--base-url must be an absolute HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('--base-url must be an absolute HTTP(S) URL without credentials')
  }
  return stripTrailingSlash(url.href)
}

function receiptList(body) {
  if (!isRecord(body) || !Array.isArray(body.receipts)) throw new LifecycleFailure('receipts_response_invalid')
  return body.receipts
}

function ownershipClaimCount(body) {
  if (!isRecord(body) || !Number.isSafeInteger(body.ownershipClaimCount) || body.ownershipClaimCount < 0) {
    throw new LifecycleFailure('ownership_claim_count_invalid')
  }
  return body.ownershipClaimCount
}

function deployedEvidence(body) {
  if (!isRecord(body)
    || typeof body.businessStateSha256 !== 'string'
    || !SHA256_RE.test(body.businessStateSha256)
    || typeof body.manifestSha256 !== 'string'
    || !SHA256_RE.test(body.manifestSha256)
    || !isNonEmptyString(body.installedVersion)
    || !isNonEmptyString(body.mupotCompatibility)
    || !isNonEmptyString(body.publisher)
    || body.trustClass !== 'native_reviewed') {
    throw new LifecycleFailure('deployed_evidence_invalid')
  }
  return {
    businessStateSha256: body.businessStateSha256,
    manifestSha256: body.manifestSha256,
    installedVersion: body.installedVersion,
    mupotCompatibility: body.mupotCompatibility,
    publisher: body.publisher,
    trustClass: body.trustClass,
  }
}

function sameDeployment(left, right) {
  return left.manifestSha256 === right.manifestSha256
    && left.installedVersion === right.installedVersion
    && left.mupotCompatibility === right.mupotCompatibility
    && left.publisher === right.publisher
    && left.trustClass === right.trustClass
}

function receiptFingerprint(receipt) {
  return JSON.stringify([
    receipt.sequence,
    receipt.id,
    receipt.action,
    receipt.previousState,
    receipt.nextState,
    receipt.addonKey,
    receipt.installedVersion,
    receipt.manifestSha256,
    receipt.mupotCompatibility,
    receipt.publisher,
    receipt.trustClass,
    receipt.actorId,
    receipt.outcome,
    receipt.errorCode,
    receipt.createdAt,
  ])
}

function validateObservedReceipt(receipt, expected, deployment, prior, bearer) {
  if (!isRecord(receipt)
    || !Number.isSafeInteger(receipt.sequence)
    || receipt.sequence <= 0
    || !isReceiptId(receipt.id)
    || receipt.id.includes(bearer)
    || receipt.action !== expected.action
    || receipt.previousState !== expected.previousState
    || receipt.nextState !== expected.state
    || receipt.addonKey !== ADDON_KEY
    || receipt.installedVersion !== deployment.installedVersion
    || receipt.manifestSha256 !== deployment.manifestSha256
    || receipt.mupotCompatibility !== deployment.mupotCompatibility
    || receipt.publisher !== deployment.publisher
    || receipt.trustClass !== deployment.trustClass
    || !isNonEmptyString(receipt.actorId)
    || receipt.outcome !== 'pass'
    || receipt.errorCode !== null
    || typeof receipt.createdAt !== 'string') {
    return null
  }
  const createdAtMs = Date.parse(receipt.createdAt)
  if (!Number.isFinite(createdAtMs)
    || (prior.sequence !== null && receipt.sequence <= prior.sequence)
    || (prior.createdAtMs !== null && createdAtMs < prior.createdAtMs)
    || (prior.actorId !== null && receipt.actorId !== prior.actorId)) {
    return null
  }
  return {
    id: receipt.id,
    sequence: receipt.sequence,
    actorId: receipt.actorId,
    createdAt: receipt.createdAt,
    createdAtMs,
    fingerprint: receiptFingerprint(receipt),
  }
}

function onlyNewReceipt(receipts, seenIds) {
  const candidates = receipts.filter((receipt) => (
    !isRecord(receipt) || typeof receipt.id !== 'string' || !seenIds.has(receipt.id)
  ))
  return candidates.length === 1 ? candidates[0] : null
}

function archivedCatalogStateIsValid(body) {
  if (!isRecord(body) || !Array.isArray(body.addons)) return false
  const matching = body.addons.filter((addon) => isRecord(addon) && addon.key === ADDON_KEY)
  return matching.length === 1 && matching[0].state === 'archived'
}

function finalReceiptsAreExact(receipts, expectedFingerprints, receiptIds, bearer) {
  if (receipts.length !== expectedFingerprints.size) return false
  const sequences = []
  const ids = new Set()
  for (const receipt of receipts) {
    if (!isRecord(receipt)
      || !isReceiptId(receipt.id)
      || receipt.id.includes(bearer)
      || ids.has(receipt.id)
      || expectedFingerprints.get(receipt.id) !== receiptFingerprint(receipt)
      || !Number.isSafeInteger(receipt.sequence)) {
      return false
    }
    ids.add(receipt.id)
    sequences.push({ id: receipt.id, sequence: receipt.sequence })
  }
  sequences.sort((left, right) => left.sequence - right.sequence)
  return sequences.every((entry, index) => entry.id === receiptIds[index])
}

export async function runLifecycleCheck(opts, deps = {}) {
  const baseUrl = checkedBaseUrl(opts.baseUrl)
  const requestOrigin = new URL(baseUrl).origin
  const tokenEnv = String(opts.tokenEnv || '')
  if (!tokenEnv) throw new Error('--token-env is required')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error('--token-env must name an environment variable')
  const env = deps.env ?? process.env
  const bearer = env[tokenEnv]
  if (typeof bearer !== 'string' || bearer.length === 0) {
    throw new Error(`environment variable ${tokenEnv} is empty or unset`)
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')

  const transitions = []
  const receiptIds = []
  const receiptSequences = []
  const receiptCreatedAt = []
  const seenReceiptIds = new Set()
  const expectedFingerprints = new Map()
  const httpStatuses = []
  const failureCodes = []
  let installSideEffectCount = -1
  let secretsPresent = false
  let deployment = null
  let actorId = null
  let priorSequence = null
  let priorCreatedAtMs = null

  const request = async (step, path, method = 'GET') => {
    let response
    try {
      response = await fetchImpl(new URL(path, `${baseUrl}/`), {
        method,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${bearer}`,
          cookie: `mupot_session=${encodeURIComponent(bearer)}`,
          origin: requestOrigin,
        },
      })
    } catch {
      throw new LifecycleFailure(`${step}_request_failed`)
    }
    httpStatuses.push({ step, status: response.status })

    let body = null
    try {
      const raw = await response.text()
      body = raw ? JSON.parse(raw) : null
    } catch {
      throw new LifecycleFailure(`${step}_response_invalid`)
    }
    if (hasSensitiveKey(body) || hasCredentialValue(body, bearer)) secretsPresent = true
    return { status: response.status, body }
  }

  const requireStatus = (actual, expected, step) => {
    if (actual !== expected) throw new LifecycleFailure(`${step}_http_status`)
  }

  try {
    const evidenceBefore = await request('evidence_before_install', `/api/addons/${ADDON_KEY}/evidence`)
    requireStatus(evidenceBefore.status, 200, 'evidence_before_install')
    deployment = deployedEvidence(evidenceBefore.body)

    const receiptsBefore = await request('receipts_before_install', `/api/addons/${ADDON_KEY}/receipts`)
    requireStatus(receiptsBefore.status, 200, 'receipts_before_install')
    if (receiptList(receiptsBefore.body).length !== 0 || ownershipClaimCount(receiptsBefore.body) !== 0) {
      throw new LifecycleFailure('fresh_lifecycle_evidence_not_empty')
    }

    for (const expected of LIFECYCLE) {
      const mutation = await request(expected.action, `/api/addons/${ADDON_KEY}/${expected.action}`, 'POST')
      requireStatus(mutation.status, expected.status, expected.action)
      if (!isRecord(mutation.body)
        || mutation.body.ok !== true
        || mutation.body.key !== ADDON_KEY
        || mutation.body.state !== expected.state) {
        throw new LifecycleFailure(`${expected.action}_response_invalid`)
      }
      transitions.push(mutation.body.state)

      let receiptResponse
      if (expected.action === 'install') {
        const evidenceAfter = await request('evidence_after_install', `/api/addons/${ADDON_KEY}/evidence`)
        requireStatus(evidenceAfter.status, 200, 'evidence_after_install')
        const confirmedDeployment = deployedEvidence(evidenceAfter.body)
        if (!sameDeployment(deployment, confirmedDeployment)) {
          throw new LifecycleFailure('deployed_manifest_changed')
        }
        receiptResponse = await request('install_receipts', `/api/addons/${ADDON_KEY}/receipts`)
        requireStatus(receiptResponse.status, 200, 'install_receipts')
        installSideEffectCount = ownershipClaimCount(receiptResponse.body)
          + (deployment.businessStateSha256 === confirmedDeployment.businessStateSha256 ? 0 : 1)
      } else {
        receiptResponse = await request(`${expected.action}_receipts`, `/api/addons/${ADDON_KEY}/receipts`)
        requireStatus(receiptResponse.status, 200, `${expected.action}_receipts`)
      }

      const listedReceipts = receiptList(receiptResponse.body)
      if (listedReceipts.length !== seenReceiptIds.size + 1) {
        throw new LifecycleFailure(`${expected.action}_receipt_count_invalid`)
      }
      const candidate = onlyNewReceipt(listedReceipts, seenReceiptIds)
      const observed = validateObservedReceipt(candidate, expected, deployment, {
        actorId,
        sequence: priorSequence,
        createdAtMs: priorCreatedAtMs,
      }, bearer)
      if (!observed) throw new LifecycleFailure(`${expected.action}_receipt_invalid`)

      actorId = observed.actorId
      priorSequence = observed.sequence
      priorCreatedAtMs = observed.createdAtMs
      seenReceiptIds.add(observed.id)
      expectedFingerprints.set(observed.id, observed.fingerprint)
      receiptIds.push(observed.id)
      receiptSequences.push(observed.sequence)
      receiptCreatedAt.push(observed.createdAt)
    }

    const rejected = await request('archived_reactivation', `/api/addons/${ADDON_KEY}/activate`, 'POST')
    requireStatus(rejected.status, 409, 'archived_reactivation')
    if (!isRecord(rejected.body) || rejected.body.error !== 'invalid_state') {
      throw new LifecycleFailure('archived_reactivation_response_invalid')
    }

    const catalog = await request('archived_catalog', '/api/addons')
    requireStatus(catalog.status, 200, 'archived_catalog')
    if (!archivedCatalogStateIsValid(catalog.body)) failureCodes.push('archived_catalog_state_invalid')

    const finalReceipts = await request('archived_receipts', `/api/addons/${ADDON_KEY}/receipts`)
    requireStatus(finalReceipts.status, 200, 'archived_receipts')
    if (!finalReceiptsAreExact(
      receiptList(finalReceipts.body),
      expectedFingerprints,
      receiptIds,
      bearer,
    )) {
      failureCodes.push('archived_receipts_invalid')
    }
  } catch (error) {
    failureCodes.push(error instanceof LifecycleFailure ? error.code : 'lifecycle_check_failed')
  }

  const receipt = {
    receipt_type: RECEIPT_TYPE,
    status: 'pass',
    addon_key: ADDON_KEY,
    transitions,
    install_side_effect_count: installSideEffectCount,
    manifest_sha256: deployment?.manifestSha256 ?? '',
    installed_version: deployment?.installedVersion ?? '',
    publisher: deployment?.publisher ?? '',
    trust_class: deployment?.trustClass ?? '',
    actor_id: actorId ?? '',
    secrets_present: secretsPresent,
    http_statuses: httpStatuses,
    receipt_ids: receiptIds,
    receipt_sequences: receiptSequences,
    receipt_created_at: receiptCreatedAt,
  }
  const validation = validateReceipt(receipt)
  if (failureCodes.length > 0 || !validation.ok) {
    receipt.status = 'fail'
    receipt.failure_codes = [...new Set([...failureCodes, ...validation.errors])]
  }
  return receipt
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || (!opts.plan && !opts.check)) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (opts.plan === opts.check) throw new Error('choose exactly one of --plan or --check')
  if (opts.plan) {
    process.stdout.write(formatPlan(opts))
    return
  }
  if (!opts.baseUrl) throw new Error('--base-url is required with --check')
  if (!opts.tokenEnv) throw new Error('--token-env is required with --check')

  const receipt = await runLifecycleCheck(opts)
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (receipt.status !== 'pass') process.exitCode = 1
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`addon-lifecycle-receipt: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
