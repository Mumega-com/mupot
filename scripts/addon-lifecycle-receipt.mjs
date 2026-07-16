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
export const FIXTURE_MANIFEST_SHA256 = 'daad3a1ced50ec6789d788b7112fbb4de4cb6d20fc1eee11f366de4ef8c6598a'

const LIFECYCLE = Object.freeze([
  { action: 'install', state: 'installed', status: 201 },
  { action: 'configure', state: 'configured', status: 200 },
  { action: 'activate', state: 'active', status: 200 },
  { action: 'disable', state: 'disabled', status: 200 },
  { action: 'activate', state: 'active', status: 200 },
  { action: 'disable', state: 'disabled', status: 200 },
  { action: 'archive', state: 'archived', status: 200 },
])

const SENSITIVE_KEY_RE = /authorization|token|secret|password/i

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
    '2. GET /api/org/departments and record the existing department IDs.',
    '3. POST /api/addons/fixture-addon/install -> 201.',
    '4. GET /api/org/departments and require zero added department rows.',
    '5. GET /api/addons/fixture-addon/receipts and record the install receipt ID.',
    '6. POST /api/addons/fixture-addon/configure -> 200; record its receipt ID.',
    '7. POST /api/addons/fixture-addon/activate -> 200; record its receipt ID.',
    '8. POST /api/addons/fixture-addon/disable -> 200; record its receipt ID.',
    '9. POST /api/addons/fixture-addon/activate -> 200; record its receipt ID.',
    '10. POST /api/addons/fixture-addon/disable -> 200; record its receipt ID.',
    '11. POST /api/addons/fixture-addon/archive -> 200; record its receipt ID.',
    '12. POST /api/addons/fixture-addon/activate -> 409 after archive.',
    '13. Re-read receipts and require that archived reactivation created no receipt.',
    '14. Emit one redacted mupot-addon-lifecycle/v1 JSON receipt.',
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

function sameTransitions(actual) {
  return Array.isArray(actual)
    && actual.length === EXPECTED_TRANSITIONS.length
    && actual.every((state, index) => state === EXPECTED_TRANSITIONS[index])
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
  if (typeof value.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifest_sha256)) {
    errors.push('manifest_sha256_invalid')
  }
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

function departmentIds(body) {
  if (!isRecord(body) || !Array.isArray(body.departments)) throw new LifecycleFailure('departments_response_invalid')
  const ids = body.departments.map((department) => isRecord(department) ? department.id : null)
  if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new LifecycleFailure('departments_response_invalid')
  }
  return new Set(ids)
}

function receiptList(body) {
  if (!isRecord(body) || !Array.isArray(body.receipts)) throw new LifecycleFailure('receipts_response_invalid')
  return body.receipts
}

function findNewReceipt(receipts, seenIds, expected) {
  return receipts.find((receipt) => isRecord(receipt)
    && typeof receipt.id === 'string'
    && receipt.id.length > 0
    && !seenIds.has(receipt.id)
    && receipt.action === expected.action
    && receipt.nextState === expected.state
    && receipt.addonKey === ADDON_KEY
    && receipt.outcome === 'pass')
}

export async function runLifecycleCheck(opts, deps = {}) {
  const baseUrl = checkedBaseUrl(opts.baseUrl)
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
  const seenReceiptIds = new Set()
  const httpStatuses = []
  let installSideEffectCount = -1
  let secretsPresent = false
  const failureCodes = []

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
    if (hasSensitiveKey(body)) secretsPresent = true
    return { status: response.status, body }
  }

  const requireStatus = (actual, expected, step) => {
    if (actual !== expected) throw new LifecycleFailure(`${step}_http_status`)
  }

  try {
    const before = await request('departments_before_install', '/api/org/departments')
    requireStatus(before.status, 200, 'departments_before_install')
    const beforeIds = departmentIds(before.body)

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

      if (expected.action === 'install') {
        const after = await request('departments_after_install', '/api/org/departments')
        requireStatus(after.status, 200, 'departments_after_install')
        const afterIds = departmentIds(after.body)
        installSideEffectCount = [...afterIds].filter((id) => !beforeIds.has(id)).length
      }

      const receiptResponse = await request(`${expected.action}_receipts`, `/api/addons/${ADDON_KEY}/receipts`)
      requireStatus(receiptResponse.status, 200, `${expected.action}_receipts`)
      const receipt = findNewReceipt(receiptList(receiptResponse.body), seenReceiptIds, expected)
      if (!receipt) throw new LifecycleFailure(`${expected.action}_receipt_missing`)
      seenReceiptIds.add(receipt.id)
      receiptIds.push(receipt.id)
    }

    const rejected = await request(
      'archived_reactivation',
      `/api/addons/${ADDON_KEY}/activate`,
      'POST',
    )
    requireStatus(rejected.status, 409, 'archived_reactivation')
    if (!isRecord(rejected.body) || rejected.body.error !== 'invalid_state') {
      throw new LifecycleFailure('archived_reactivation_response_invalid')
    }

    const finalReceipts = await request('archived_receipts', `/api/addons/${ADDON_KEY}/receipts`)
    requireStatus(finalReceipts.status, 200, 'archived_receipts')
    const finalIds = receiptList(finalReceipts.body)
      .filter(isRecord)
      .map((receipt) => receipt.id)
      .filter((id) => typeof id === 'string')
    if (finalIds.some((id) => !seenReceiptIds.has(id))) {
      throw new LifecycleFailure('archived_reactivation_created_receipt')
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
    manifest_sha256: FIXTURE_MANIFEST_SHA256,
    secrets_present: secretsPresent,
    http_statuses: httpStatuses,
    receipt_ids: receiptIds,
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
