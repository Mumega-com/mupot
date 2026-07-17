#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RECEIPT_TYPE = 'mupot-marketing-monitor-lifecycle/v1'
export const ADDON_KEY = 'marketing-cro-monitor'
export const EXPECTED_PHASES = Object.freeze([
  'installed',
  'configured',
  'active',
  'monitor_completed',
  'recommendation_visible',
  'disabled',
  'archived',
  'reinstalled',
  'reconfigured',
  'reactivated',
  'monitor_repeated',
  'redisabled',
  'rearchived',
])

const SHA256_RE = /^[a-f0-9]{64}$/
const UUID_TEXT_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
const SENSITIVE_KEY_RE = /authorization|cookie|token|secret|password|session/i
const DEFAULT_WINDOW = Object.freeze({
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-07-01T23:59:59.999Z',
})

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function shellQuote(value) {
  const raw = String(value)
  if (/^[A-Za-z0-9_./:=@%+~,#-]+$/.test(raw)) return raw
  return `'${raw.replace(/'/g, `'\\''`)}'`
}

function redactedBaseUrl(value) {
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
    sessionCookieEnv: '',
    window: { ...DEFAULT_WINDOW },
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
    else if (arg === '--session-cookie-env') opts.sessionCookieEnv = next()
    else if (arg === '--window-start') opts.window.start = next()
    else if (arg === '--window-end') opts.window.end = next()
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

export function usage() {
  return [
    'Usage: node scripts/marketing-monitor-lifecycle-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                         print the no-write operator plan',
    '  --check                        execute and check the Marketing/CRO monitor lifecycle',
    '  --base-url <url>               Mupot deployment base URL',
    '  --token-env <ENV_NAME>         environment variable containing the admin bearer',
    '  --session-cookie-env <ENV>     optional dashboard session cookie env var for console proof',
    '  --window-start <ISO>           monitor window start',
    '  --window-end <ISO>             monitor window end',
    '  -h, --help                     show this help',
  ].join('\n')
}

export function formatPlan(opts = {}) {
  const baseUrl = redactedBaseUrl(opts.baseUrl)
  const tokenEnv = opts.tokenEnv || '<ADMIN_BEARER_ENV>'
  const sessionCookieEnv = opts.sessionCookieEnv || '<SESSION_COOKIE_ENV>'
  return `${[
    'Marketing/CRO monitor lifecycle evidence plan',
    '',
    'This mode performs no writes. The check mode writes only addon lifecycle, first-party binding, monitor, and archive actions for the named pot.',
    `1. Read the bearer only from ${tokenEnv}; never print it.`,
    `2. If browser console proof is required, read the dashboard cookie only from ${sessionCookieEnv}; never print it.`,
    `3. GET /api/addons/${ADDON_KEY}/evidence and pin the deployed manifest digest.`,
    `4. POST install, configure with first_party, activate, then POST /api/addons/${ADDON_KEY}/monitor.`,
    '5. Verify latest/list monitor reads agree, unavailable outcomes are not numeric zero, and source slots are unique.',
    '6. Verify the console exposes Review task and Flight record links without raw task or flight IDs.',
    '7. Disable, archive, require zero ownership claims, reinstall, repeat the monitor, and archive again.',
    '8. Emit one redacted mupot-marketing-monitor-lifecycle/v1 JSON receipt.',
    '',
    `node scripts/marketing-monitor-lifecycle-receipt.mjs --check --base-url ${shellQuote(baseUrl)} --token-env ${shellQuote(tokenEnv)} --session-cookie-env ${shellQuote(sessionCookieEnv)}`,
  ].join('\n')}\n`
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasSensitiveKey(value, path = []) {
  if (Array.isArray(value)) return value.some((entry, index) => hasSensitiveKey(entry, [...path, index]))
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) => {
    const nextPath = [...path, key]
    if (nextPath.length === 1 && key === 'secrets_present') return false
    return SENSITIVE_KEY_RE.test(key) || hasSensitiveKey(child, nextPath)
  })
}

function hasCredentialValue(value, credential) {
  if (!credential) return false
  if (typeof value === 'string') return value.includes(credential)
  if (Array.isArray(value)) return value.some((entry) => hasCredentialValue(entry, credential))
  if (!isRecord(value)) return false
  return Object.values(value).some((entry) => hasCredentialValue(entry, credential))
}

function validSequence(value) {
  return Array.isArray(value)
    && value.length === 10
    && value.every((sequence) => Number.isSafeInteger(sequence) && sequence > 0)
    && value.every((sequence, index) => index === 0 || sequence > value[index - 1])
}

function validChronology(value) {
  if (!Array.isArray(value) || value.length !== 10) return false
  const times = value.map((entry) => typeof entry === 'string' ? Date.parse(entry) : Number.NaN)
  return times.every(Number.isFinite) && times.every((time, index) => index === 0 || time >= times[index - 1])
}

export function validateReceipt(value) {
  const errors = []
  if (!isRecord(value)) return { ok: false, errors: ['receipt_not_object'] }
  if (value.receipt_type !== RECEIPT_TYPE) errors.push('receipt_type_invalid')
  if (value.status !== 'pass') errors.push('status_not_pass')
  if (value.addon_key !== ADDON_KEY) errors.push('addon_key_invalid')
  if (!Array.isArray(value.phases)
    || value.phases.length !== EXPECTED_PHASES.length
    || !value.phases.every((phase, index) => phase === EXPECTED_PHASES[index])) {
    errors.push('phases_mismatch')
  }
  if (typeof value.manifest_sha256 !== 'string' || !SHA256_RE.test(value.manifest_sha256)) errors.push('manifest_sha256_invalid')
  if (typeof value.installed_version !== 'string' || value.installed_version.length === 0) errors.push('installed_version_invalid')
  if (typeof value.publisher !== 'string' || value.publisher.length === 0) errors.push('publisher_invalid')
  if (value.trust_class !== 'native_reviewed') errors.push('trust_class_invalid')
  if (!Array.isArray(value.monitor_run_ids)
    || value.monitor_run_ids.length !== 2
    || !value.monitor_run_ids.every((id) => typeof id === 'string' && id.length > 0)
    || new Set(value.monitor_run_ids).size !== value.monitor_run_ids.length) {
    errors.push('monitor_run_ids_invalid')
  }
  if (value.recommendation_visible !== true) errors.push('recommendation_not_visible')
  if (!isRecord(value.recommendation_links)
    || value.recommendation_links.review_task !== true
    || value.recommendation_links.flight_record !== true) {
    errors.push('recommendation_links_invalid')
  }
  if (value.archive_ownership_claim_count !== 0) errors.push('archive_ownership_claim_count_nonzero')
  if (value.unavailable_not_zero !== true) errors.push('unavailable_rendered_as_zero')
  if (value.secrets_present !== false) errors.push('secrets_present')
  if (hasSensitiveKey(value)) errors.push('sensitive_key_present')
  if (!validSequence(value.receipt_sequences)) errors.push('receipt_sequences_invalid')
  if (!validChronology(value.receipt_created_at)) errors.push('receipt_chronology_invalid')
  return { ok: errors.length === 0, errors }
}

class ReceiptFailure extends Error {
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

function checkedEnvName(name, label) {
  const value = String(name || '')
  if (!value) throw new Error(`${label} is required`)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${label} must name an environment variable`)
  return value
}

async function responseJson(response, step) {
  try {
    const raw = await response.text()
    return raw ? JSON.parse(raw) : null
  } catch {
    throw new ReceiptFailure(`${step}_response_invalid`)
  }
}

function deployedEvidence(body) {
  if (!isRecord(body)
    || typeof body.manifestSha256 !== 'string'
    || !SHA256_RE.test(body.manifestSha256)
    || typeof body.installedVersion !== 'string'
    || body.installedVersion.length === 0
    || typeof body.publisher !== 'string'
    || body.publisher.length === 0
    || body.trustClass !== 'native_reviewed') {
    throw new ReceiptFailure('deployed_evidence_invalid')
  }
  return {
    manifestSha256: body.manifestSha256,
    installedVersion: body.installedVersion,
    publisher: body.publisher,
    trustClass: body.trustClass,
  }
}

function receiptsFrom(body) {
  if (!isRecord(body) || !Array.isArray(body.receipts)) throw new ReceiptFailure('receipts_response_invalid')
  return body.receipts
}

function ownershipClaimCount(body) {
  if (!isRecord(body) || !Number.isSafeInteger(body.ownershipClaimCount) || body.ownershipClaimCount < 0) {
    throw new ReceiptFailure('ownership_claim_count_invalid')
  }
  return body.ownershipClaimCount
}

function newestReceipt(receipts, priorSequence) {
  const candidates = receipts.filter((receipt) => (
    isRecord(receipt)
    && Number.isSafeInteger(receipt.sequence)
    && (priorSequence === null || receipt.sequence > priorSequence)
  ))
  return candidates.length === 1 ? candidates[0] : null
}

function validateLifecycleReceipt(receipt, expected, deployment, prior) {
  if (!isRecord(receipt)
    || !Number.isSafeInteger(receipt.sequence)
    || receipt.sequence <= 0
    || receipt.action !== expected.action
    || receipt.previousState !== expected.previousState
    || receipt.nextState !== expected.state
    || receipt.addonKey !== ADDON_KEY
    || receipt.installedVersion !== deployment.installedVersion
    || receipt.manifestSha256 !== deployment.manifestSha256
    || receipt.publisher !== deployment.publisher
    || receipt.trustClass !== deployment.trustClass
    || receipt.outcome !== 'pass'
    || receipt.errorCode !== null
    || typeof receipt.createdAt !== 'string') {
    return null
  }
  const createdAtMs = Date.parse(receipt.createdAt)
  if (!Number.isFinite(createdAtMs)
    || (prior.sequence !== null && receipt.sequence <= prior.sequence)
    || (prior.createdAtMs !== null && createdAtMs < prior.createdAtMs)) {
    return null
  }
  return {
    sequence: receipt.sequence,
    createdAt: receipt.createdAt,
    createdAtMs,
  }
}

function monitorRunIsValid(run) {
  const codes = []
  if (!isRecord(run)
    || typeof run.id !== 'string'
    || run.id.length === 0
    || run.status !== 'completed'
    || !Number.isSafeInteger(run.sourceCount)
    || run.sourceCount <= 0
    || !Number.isSafeInteger(run.observationCount)
    || run.observationCount <= 0
    || typeof run.evidenceDigest !== 'string'
    || !SHA256_RE.test(run.evidenceDigest)
    || !Array.isArray(run.sources)
    || !isRecord(run.outcomes)) {
    return { ok: false, codes: ['monitor_run_invalid'] }
  }
  const slots = new Set()
  for (const source of run.sources) {
    if (!isRecord(source) || typeof source.slot !== 'string' || slots.has(source.slot)) {
      codes.push('monitor_sources_duplicated')
      continue
    }
    slots.add(source.slot)
  }
  for (const outcome of Object.values(run.outcomes)) {
    if (!isRecord(outcome) || typeof outcome.status !== 'string') {
      codes.push('monitor_outcomes_invalid')
      continue
    }
    if (outcome.status === 'unavailable' && Object.hasOwn(outcome, 'value')) {
      codes.push('unavailable_rendered_as_zero')
    }
    if (outcome.status === 'available' && !Number.isFinite(outcome.value)) {
      codes.push('monitor_outcomes_invalid')
    }
  }
  return codes.length === 0 ? { ok: true, codes: [] } : { ok: false, codes: [...new Set(codes)] }
}

function catalogStateIs(body, state) {
  return isRecord(body)
    && Array.isArray(body.addons)
    && body.addons.some((addon) => isRecord(addon) && addon.key === ADDON_KEY && addon.state === state)
}

function consoleEvidence(html) {
  const reviewTask = /href=["']\/approvals["'][^>]*>\s*Review task/i.test(html)
  const flightRecord = /href=["']\/flights["'][^>]*>\s*Flight record/i.test(html)
  const leaksRaw = /\btask-[A-Za-z0-9_-]{4,}\b|\bflight-[A-Za-z0-9_-]{4,}\b/.test(html)
    || UUID_TEXT_RE.test(html)
  const unavailableRenderedAsZero = /Revenue[\s\S]{0,240}<strong>\s*(?:\$?0(?:\.0+)?|0%)\s*<\/strong>/i.test(html)
  const unavailableVisible = />\s*Unavailable\s*</i.test(html)
  return { reviewTask, flightRecord, leaksRaw, unavailableRenderedAsZero, unavailableVisible }
}

function recommendationIsValid(body) {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.recommendation)) return false
  const recommendation = body.recommendation
  const serialized = JSON.stringify(recommendation)
  if (/(taskId|flightId|dedupKey|task_id|flight_id|dedup_key)/.test(serialized)) return false
  return isRecord(recommendation.links)
    && recommendation.links.reviewTask === '/approvals'
    && recommendation.links.flightRecord === '/flights'
    && recommendation.terminalAction === 'recommendation_ready'
    && typeof recommendation.receiptDigest === 'string'
    && SHA256_RE.test(recommendation.receiptDigest)
}

export async function runMarketingMonitorLifecycleCheck(opts, deps = {}) {
  const baseUrl = checkedBaseUrl(opts.baseUrl)
  const tokenEnv = checkedEnvName(opts.tokenEnv, '--token-env')
  const sessionCookieEnv = opts.sessionCookieEnv ? checkedEnvName(opts.sessionCookieEnv, '--session-cookie-env') : ''
  const env = deps.env ?? process.env
  const bearer = env[tokenEnv]
  if (typeof bearer !== 'string' || bearer.length === 0) throw new Error(`environment variable ${tokenEnv} is empty or unset`)
  const sessionCookie = sessionCookieEnv ? env[sessionCookieEnv] : ''
  if (sessionCookieEnv && (typeof sessionCookie !== 'string' || sessionCookie.length === 0)) {
    throw new Error(`environment variable ${sessionCookieEnv} is empty or unset`)
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')

  const phases = []
  const receiptSequences = []
  const receiptCreatedAt = []
  const monitorRunIds = []
  const httpStatuses = []
  const failureCodes = []
  let secretsPresent = false
  let deployment = null
  let priorSequence = null
  let priorCreatedAtMs = null
  let archiveOwnershipClaimCount = -1
  let unavailableNotZero = true
  let recommendationVisible = false
  let recommendationLinks = { review_task: false, flight_record: false }

  const request = async (step, path, options = {}) => {
    let response
    const headers = {
      accept: options.accept ?? 'application/json',
      origin: new URL(baseUrl).origin,
      ...(options.auth === false ? {} : { authorization: `Bearer ${bearer}` }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    }
    try {
      response = await fetchImpl(new URL(path, `${baseUrl}/`), {
        method: options.method ?? 'GET',
        redirect: 'error',
        headers,
        ...(options.body ? { body: options.body } : {}),
      })
    } catch {
      throw new ReceiptFailure(`${step}_request_failed`)
    }
    httpStatuses.push({ step, status: response.status })
    return response
  }

  const jsonRequest = async (step, path, options = {}) => {
    const response = await request(step, path, options)
    const body = await responseJson(response, step)
    if (hasSensitiveKey(body) || hasCredentialValue(body, bearer) || hasCredentialValue(body, sessionCookie)) {
      secretsPresent = true
    }
    return { status: response.status, body }
  }

  const requireStatus = (actual, expected, step) => {
    if (actual !== expected) throw new ReceiptFailure(`${step}_http_status`)
  }

  const lifecycle = async (label, action, previousState, state, expectedStatus) => {
    const body = action === 'configure'
      ? JSON.stringify({ bindings: [{ slot: 'web_analytics', adapter: 'first_party', bindingKind: 'internal_adapter' }] })
      : undefined
    const mutation = await jsonRequest(label, `/api/addons/${ADDON_KEY}/${action}`, {
      method: 'POST',
      ...(body ? { body } : {}),
    })
    requireStatus(mutation.status, expectedStatus, label)
    if (!isRecord(mutation.body) || mutation.body.ok !== true || mutation.body.key !== ADDON_KEY || mutation.body.state !== state) {
      throw new ReceiptFailure(`${label}_response_invalid`)
    }
    const listed = await jsonRequest(`${label}_receipts`, `/api/addons/${ADDON_KEY}/receipts`)
    requireStatus(listed.status, 200, `${label}_receipts`)
    const receipt = validateLifecycleReceipt(
      newestReceipt(receiptsFrom(listed.body), priorSequence),
      { action, previousState, state },
      deployment,
      { sequence: priorSequence, createdAtMs: priorCreatedAtMs },
    )
    if (!receipt) throw new ReceiptFailure(`${label}_receipt_invalid`)
    receiptSequences.push(receipt.sequence)
    receiptCreatedAt.push(receipt.createdAt)
    priorSequence = receipt.sequence
    priorCreatedAtMs = receipt.createdAtMs
    phases.push(label.startsWith('second_') ? `re${state === 'active' ? 'activated' : state}` : state)
  }

  const monitor = async (label) => {
    const body = JSON.stringify({ window: opts.window ?? DEFAULT_WINDOW })
    const created = await jsonRequest(label, `/api/addons/${ADDON_KEY}/monitor`, { method: 'POST', body })
    if (created.status !== 201 && created.status !== 200) throw new ReceiptFailure(`${label}_http_status`)
    const run = isRecord(created.body) ? created.body.run : null
    const checked = monitorRunIsValid(run)
    if (!checked.ok) {
      for (const code of checked.codes) {
        if (code === 'unavailable_rendered_as_zero') unavailableNotZero = false
        failureCodes.push(code)
      }
      throw new ReceiptFailure(`${label}_run_invalid`)
    }
    const latest = await jsonRequest(`${label}_latest`, `/api/addons/${ADDON_KEY}/monitor/latest`)
    requireStatus(latest.status, 200, `${label}_latest`)
    if (!isRecord(latest.body) || !isRecord(latest.body.run) || latest.body.run.id !== run.id) {
      throw new ReceiptFailure(`${label}_latest_mismatch`)
    }
    const listed = await jsonRequest(`${label}_list`, `/api/addons/${ADDON_KEY}/monitor?limit=1`)
    requireStatus(listed.status, 200, `${label}_list`)
    if (!isRecord(listed.body)
      || !Array.isArray(listed.body.runs)
      || listed.body.runs.length !== 1
      || listed.body.runs[0]?.id !== run.id) {
      throw new ReceiptFailure(`${label}_list_mismatch`)
    }
    monitorRunIds.push(run.id)
    phases.push(label === 'first_monitor' ? 'monitor_completed' : 'monitor_repeated')
    return run.id
  }

  const prepareRecommendation = async (runId) => {
    const prepared = await jsonRequest('recommendation', `/api/addons/${ADDON_KEY}/recommendation`, {
      method: 'POST',
      body: JSON.stringify({ runId }),
    })
    if (prepared.status !== 201 && prepared.status !== 200) throw new ReceiptFailure('recommendation_http_status')
    if (!recommendationIsValid(prepared.body)) throw new ReceiptFailure('recommendation_response_invalid')
  }

  try {
    const before = await jsonRequest('evidence_before_install', `/api/addons/${ADDON_KEY}/evidence`)
    requireStatus(before.status, 200, 'evidence_before_install')
    deployment = deployedEvidence(before.body)

    await lifecycle('first_install', 'install', null, 'installed', 201)
    await lifecycle('first_configure', 'configure', 'installed', 'configured', 200)
    await lifecycle('first_activate', 'activate', 'configured', 'active', 200)
    const firstRunId = await monitor('first_monitor')
    await prepareRecommendation(firstRunId)

    if (sessionCookie) {
      const consoleResponse = await request('console', '/addons/marketing-cro-monitor', {
        auth: false,
        accept: 'text/html',
        cookie: sessionCookie,
      })
      requireStatus(consoleResponse.status, 200, 'console')
      const body = await consoleResponse.text()
      if (body.includes(bearer) || body.includes(sessionCookie)) secretsPresent = true
      const evidence = consoleEvidence(body)
      recommendationLinks = { review_task: evidence.reviewTask, flight_record: evidence.flightRecord }
      if (evidence.unavailableRenderedAsZero || !evidence.unavailableVisible) {
        unavailableNotZero = false
        failureCodes.push('unavailable_rendered_as_zero')
      }
      recommendationVisible = evidence.reviewTask && evidence.flightRecord && !evidence.leaksRaw
      if (!recommendationVisible) failureCodes.push('recommendation_not_visible')
    } else {
      failureCodes.push('recommendation_not_visible')
    }
    phases.push('recommendation_visible')

    await lifecycle('first_disable', 'disable', 'active', 'disabled', 200)
    await lifecycle('first_archive', 'archive', 'disabled', 'archived', 200)
    const archived = await jsonRequest('first_archive_receipts_final', `/api/addons/${ADDON_KEY}/receipts`)
    requireStatus(archived.status, 200, 'first_archive_receipts_final')
    archiveOwnershipClaimCount = ownershipClaimCount(archived.body)
    if (archiveOwnershipClaimCount !== 0) failureCodes.push('archive_ownership_claim_count_nonzero')

    const afterArchiveEvidence = await jsonRequest('evidence_after_archive', `/api/addons/${ADDON_KEY}/evidence`)
    requireStatus(afterArchiveEvidence.status, 200, 'evidence_after_archive')
    if (deployedEvidence(afterArchiveEvidence.body).manifestSha256 !== deployment.manifestSha256) {
      failureCodes.push('manifest_digest_drift')
    }
    const catalog = await jsonRequest('catalog_after_archive', '/api/addons')
    requireStatus(catalog.status, 200, 'catalog_after_archive')
    if (!catalogStateIs(catalog.body, 'archived')) failureCodes.push('archived_catalog_state_invalid')

    await lifecycle('second_install', 'install', null, 'installed', 201)
    await lifecycle('second_configure', 'configure', 'installed', 'configured', 200)
    await lifecycle('second_activate', 'activate', 'configured', 'active', 200)
    await monitor('second_monitor')
    await lifecycle('second_disable', 'disable', 'active', 'disabled', 200)
    await lifecycle('second_archive', 'archive', 'disabled', 'archived', 200)
    const finalArchived = await jsonRequest('second_archive_receipts_final', `/api/addons/${ADDON_KEY}/receipts`)
    requireStatus(finalArchived.status, 200, 'second_archive_receipts_final')
    const finalArchiveClaimCount = ownershipClaimCount(finalArchived.body)
    archiveOwnershipClaimCount = Math.max(archiveOwnershipClaimCount, finalArchiveClaimCount)
    if (finalArchiveClaimCount !== 0) failureCodes.push('archive_ownership_claim_count_nonzero')
    const finalCatalog = await jsonRequest('catalog_after_second_archive', '/api/addons')
    requireStatus(finalCatalog.status, 200, 'catalog_after_second_archive')
    if (!catalogStateIs(finalCatalog.body, 'archived')) failureCodes.push('archived_catalog_state_invalid')
  } catch (error) {
    if (error instanceof ReceiptFailure) {
      if (error.code === 'unavailable_rendered_as_zero') unavailableNotZero = false
      failureCodes.push(error.code)
    } else {
      failureCodes.push('marketing_monitor_lifecycle_check_failed')
    }
  }

  const receipt = {
    receipt_type: RECEIPT_TYPE,
    status: 'pass',
    addon_key: ADDON_KEY,
    phases,
    manifest_sha256: deployment?.manifestSha256 ?? '',
    installed_version: deployment?.installedVersion ?? '',
    publisher: deployment?.publisher ?? '',
    trust_class: deployment?.trustClass ?? '',
    monitor_run_ids: monitorRunIds,
    recommendation_visible: recommendationVisible,
    recommendation_links: recommendationLinks,
    archive_ownership_claim_count: archiveOwnershipClaimCount,
    secrets_present: secretsPresent,
    unavailable_not_zero: unavailableNotZero,
    http_statuses: httpStatuses,
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
  const receipt = await runMarketingMonitorLifecycleCheck(opts)
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (receipt.status !== 'pass') process.exitCode = 1
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`marketing-monitor-lifecycle-receipt: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
