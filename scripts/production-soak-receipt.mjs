#!/usr/bin/env node
// Mupot v0.23 production soak evidence checker.
//
// The soak itself runs on a real release candidate with a real agent. This
// checker validates the redacted receipt bundle after the seven-day window.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const START_RECEIPT_TYPE = 'mupot-production-soak-start/v1'
export const DAY_RECEIPT_TYPE = 'mupot-production-soak-day/v1'
export const CYCLE_RECEIPT_TYPE = 'mupot-production-soak-cycle/v1'
export const END_RECEIPT_TYPE = 'mupot-production-soak-end/v1'
export const CHECK_RECEIPT_TYPE = 'mupot-production-soak/v1'

export const REQUIRED_DAY_EVIDENCE = [
  'health',
  'mcp_health',
  'agent_presence',
  'runtime_control_ok',
  'no_lost_work',
  'no_duplicate_effects',
  'no_unauthorized_actions',
  'no_critical_failures',
]

export const REQUIRED_CYCLE_EVIDENCE = [
  'task_created',
  'agent_received_work',
  'agent_executed_work',
  'approval_or_gate_recorded',
  'task_completed',
  'audit_record',
]

const MIN_SOAK_DAYS = 7
const MIN_TASK_CYCLES = 3
const DAY_MS = 24 * 60 * 60 * 1000

const SECRET_VALUE_PATTERNS = [
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i],
  ['mupot_token', /\bmupot_[A-Za-z0-9._-]{12,}\b/],
  ['openai_api_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
]

const SECRET_FIELD_RE = /(?:^|[_-])(authorization|bearer|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|private[_-]?key|client[_-]?secret|cookie)(?:$|[_-])/i
const SAFE_REFERENCE_FIELD_RE = /(?:^|[_-])(env|name|names|ref|path|file|id)$/i

export function parseArgs(argv) {
  const opts = {
    outDir: '',
    pot: '',
    baseUrl: '',
    rcVersion: 'v0.23.0-rc.1',
    agent: '',
    plan: false,
    check: false,
    summary: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }

    if (arg === '--out-dir') opts.outDir = resolve(next())
    else if (arg === '--pot') opts.pot = next()
    else if (arg === '--base-url') opts.baseUrl = stripTrailingSlash(next())
    else if (arg === '--rc-version') opts.rcVersion = next()
    else if (arg === '--agent') opts.agent = next()
    else if (arg === '--plan') opts.plan = true
    else if (arg === '--check') opts.check = true
    else if (arg === '--summary') opts.summary = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }

  return opts
}

export function usage() {
  return [
    'Usage: node scripts/production-soak-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                 print the v0.23 RC soak evidence plan',
    '  --check                check a completed soak evidence directory',
    '  --summary              with --check, print a compact text summary',
    '  --out-dir <path>       evidence directory',
    '  --pot <slug>           expected pot slug',
    '  --base-url <url>       expected pot URL',
    '  --rc-version <version> expected release candidate; default v0.23.0-rc.1',
    '  --agent <id-or-slug>   expected real agent identity',
    '  -h, --help             show this help',
  ].join('\n')
}

function shellQuote(value) {
  const raw = String(value)
  if (/^[A-Za-z0-9_./:=@%+~,#-]+$/.test(raw)) return raw
  return `'${raw.replace(/'/g, `'\\''`)}'`
}

function commandLine(parts, suffix = '') {
  return `${parts.map(shellQuote).join(' ')}${suffix}`
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function defaultOutDir(opts) {
  return opts.outDir || `tmp/production-soak/${opts.rcVersion || 'v0.23.0-rc.1'}`
}

export function formatPlan(opts = {}) {
  const rcVersion = opts.rcVersion || 'v0.23.0-rc.1'
  const pot = opts.pot || '<pot>'
  const baseUrl = opts.baseUrl || 'https://<pot-host>'
  const agent = opts.agent || '<agent-id-or-slug>'
  const outDir = defaultOutDir({ ...opts, rcVersion })
  const lines = []

  lines.push('Mupot v0.23 production soak evidence plan')
  lines.push('')
  lines.push('Goal: prove v0.23.0-rc.1 ran for seven days with a real agent and several complete task cycles, with no lost work, duplicate effects, unauthorized actions, or critical failures.')
  lines.push('')
  lines.push('Before running:')
  lines.push('- Start only after #274, #150, and #279 have passing evidence.')
  lines.push('- Use the real release-candidate deployment and a real signed runtime agent.')
  lines.push('- Keep tokens, cookies, private keys, webhook secrets, and provider credentials out of receipts.')
  lines.push('')
  lines.push(commandLine(['mkdir', '-p', outDir]))
  lines.push('')
  lines.push('Required files:')
  lines.push(`- soak-start.json (${START_RECEIPT_TYPE})`)
  lines.push(`- day-1.json through day-7.json (${DAY_RECEIPT_TYPE})`)
  lines.push(`- cycle-*.json, at least ${MIN_TASK_CYCLES} complete task cycles (${CYCLE_RECEIPT_TYPE})`)
  lines.push(`- soak-end.json (${END_RECEIPT_TYPE})`)
  lines.push('')
  lines.push('Minimum start/end target:')
  lines.push(JSON.stringify({
    target: {
      pot,
      base_url: baseUrl,
      rc_version: rcVersion,
      agent,
    },
  }, null, 2))
  lines.push('')
  lines.push('Each day receipt must include evidence keys:')
  lines.push(REQUIRED_DAY_EVIDENCE.join(', '))
  lines.push('')
  lines.push('Each task-cycle receipt must include evidence keys:')
  lines.push(REQUIRED_CYCLE_EVIDENCE.join(', '))
  lines.push('')
  lines.push('Check the completed bundle:')
  lines.push(commandLine([
    'node',
    'scripts/production-soak-receipt.mjs',
    '--check',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
    '--rc-version',
    rcVersion,
    '--agent',
    agent,
  ], ` > ${shellQuote(join(outDir, 'production-soak-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/production-soak-receipt.mjs',
    '--check',
    '--summary',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
    '--rc-version',
    rcVersion,
    '--agent',
    agent,
  ]))
  lines.push('')
  lines.push('Attach production-soak-check.json and the redacted evidence directory only when the aggregate receipt reports status "pass".')

  return `${lines.join('\n')}\n`
}

function pushCheck(checks, ok, check, extra = {}) {
  checks.push({ ok, component: 'production-soak-check', check, ...extra })
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) }
  }
}

function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function normalizeFieldName(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
}

function isSafeReferenceField(key) {
  const normalized = normalizeFieldName(key)
  return normalized.split('_').some((part) => SAFE_REFERENCE_FIELD_RE.test(part)) &&
    /(token|secret|private_key|api_key|password|authorization|bearer|cookie)/i.test(normalized)
}

function isSafeReferenceValue(value) {
  const raw = String(value).trim()
  return raw.length === 0 ||
    /^<[^>]+>$/.test(raw) ||
    /^\$\{[A-Z0-9_]+\}$/.test(raw) ||
    /^(redacted|\[redacted\]|placeholder|changeme|change-me)$/i.test(raw) ||
    (/^[A-Z][A-Z0-9_]{2,}$/.test(raw) && /(TOKEN|SECRET|KEY|AUTH|PASS|COOKIE)/.test(raw))
}

function jsonPath(parent, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key))) return `${parent}.${key}`
  return `${parent}[${JSON.stringify(String(key))}]`
}

function findSecretMaterial(value, path = '$', findings = []) {
  if (typeof value === 'string') {
    for (const [reason, pattern] of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) findings.push({ path, reason })
    }
    return findings
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretMaterial(item, `${path}[${index}]`, findings))
    return findings
  }
  if (!value || typeof value !== 'object') return findings

  for (const [key, item] of Object.entries(value)) {
    const childPath = jsonPath(path, key)
    if (
      typeof item === 'string' &&
      SECRET_FIELD_RE.test(normalizeFieldName(key)) &&
      !isSafeReferenceField(key) &&
      !isSafeReferenceValue(item)
    ) {
      findings.push({ path: childPath, reason: 'secret_named_field', field: key })
    }
    findSecretMaterial(item, childPath, findings)
  }
  return findings
}

function evidenceValuePass(value) {
  if (value === true) return true
  if (typeof value === 'string') return value.trim().length > 0 && !/^<[^>]+>$/.test(value.trim())
  if (typeof value === 'number') return Number.isFinite(value)
  return false
}

function targetValue(receipt, key) {
  const value = receipt?.target?.[key]
  return typeof value === 'string' ? stripTrailingSlash(value) : ''
}

function parseTime(value) {
  const ts = Date.parse(String(value || ''))
  return Number.isFinite(ts) ? ts : null
}

function receiptObservedAt(receipt) {
  return parseTime(receipt?.observed_at ?? receipt?.completed_at ?? receipt?.started_at)
}

function artifactMeta(path, receipt) {
  return {
    path,
    sha256: path ? sha256(path) : null,
    receipt_type: receipt?.receipt_type ?? null,
    status: receipt?.status ?? null,
  }
}

function checkReceiptBasics(checks, receipt, path, expectedType, label) {
  pushCheck(checks, receipt?.receipt_type === expectedType, `${label}_receipt_type`, {
    path,
    expected: expectedType,
    actual: receipt?.receipt_type ?? null,
  })
  pushCheck(checks, receipt?.status === 'pass', `${label}_receipt_status_pass`, {
    path,
    actual: receipt?.status ?? null,
  })
  const observedAt = receiptObservedAt(receipt)
  pushCheck(checks, observedAt !== null, `${label}_observed_at_present`, {
    path,
    value: receipt?.observed_at ?? receipt?.completed_at ?? receipt?.started_at ?? null,
  })
  const secretFindings = findSecretMaterial(receipt)
  pushCheck(checks, secretFindings.length === 0, `${label}_no_secret_material`, {
    path,
    findings: secretFindings.slice(0, 20),
  })
}

function listJsonFiles(outDir, prefix) {
  if (!outDir || !existsSync(outDir)) return []
  return readdirSync(outDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b))
}

function readReceiptFile(checks, path, label) {
  const exists = Boolean(path && existsSync(path))
  pushCheck(checks, exists, `${label}_receipt_exists`, { path })
  if (!exists) return null
  const parsed = readJson(path)
  pushCheck(checks, parsed.ok, `${label}_receipt_json_read`, { path, ...(parsed.ok ? {} : { reason: parsed.reason }) })
  return parsed.ok ? parsed.value : null
}

export function checkBundle(opts = {}) {
  const outDir = opts.outDir ? resolve(opts.outDir) : ''
  const checks = []
  const artifacts = {
    days: [],
    cycles: [],
  }

  pushCheck(checks, Boolean(outDir), 'out_dir_arg_present', { out_dir: outDir })
  pushCheck(checks, Boolean(outDir && existsSync(outDir)), 'out_dir_exists', { out_dir: outDir })

  if (outDir && existsSync(outDir)) {
    const allowedFixed = new Set(['soak-start.json', 'soak-end.json'])
    const extraFiles = readdirSync(outDir).filter((name) =>
      name.endsWith('.json') &&
      !allowedFixed.has(name) &&
      !/^day-\d+\.json$/.test(name) &&
      !/^cycle-[A-Za-z0-9_.-]+\.json$/.test(name)
    )
    pushCheck(checks, extraFiles.length === 0, 'bundle_only_expected_json_files', { extra_files: extraFiles })
  }

  const startPath = outDir ? join(outDir, 'soak-start.json') : 'soak-start.json'
  const endPath = outDir ? join(outDir, 'soak-end.json') : 'soak-end.json'
  const startReceipt = readReceiptFile(checks, startPath, 'start')
  const endReceipt = readReceiptFile(checks, endPath, 'end')

  artifacts.start = artifactMeta(startPath, startReceipt)
  artifacts.end = artifactMeta(endPath, endReceipt)

  if (startReceipt) checkReceiptBasics(checks, startReceipt, startPath, START_RECEIPT_TYPE, 'start')
  if (endReceipt) checkReceiptBasics(checks, endReceipt, endPath, END_RECEIPT_TYPE, 'end')

  const dayReceipts = []
  const dayFiles = listJsonFiles(outDir, 'day-')
  pushCheck(checks, dayFiles.length >= MIN_SOAK_DAYS, 'minimum_day_receipts_present', {
    count: dayFiles.length,
    minimum: MIN_SOAK_DAYS,
  })
  for (const name of dayFiles) {
    const path = join(outDir, name)
    const receipt = readReceiptFile(checks, path, 'day')
    artifacts.days.push(artifactMeta(path, receipt))
    if (!receipt) continue
    dayReceipts.push({ name, path, receipt })
    checkReceiptBasics(checks, receipt, path, DAY_RECEIPT_TYPE, 'day')
    const dayIndex = Number(receipt.day_index ?? name.match(/^day-(\d+)\.json$/)?.[1])
    pushCheck(checks, Number.isInteger(dayIndex) && dayIndex >= 1, 'day_index_valid', { path, day_index: receipt.day_index ?? null })
    for (const key of REQUIRED_DAY_EVIDENCE) {
      const value = receipt?.evidence?.[key]
      pushCheck(checks, evidenceValuePass(value), 'day_required_evidence_present', {
        path,
        day_index: dayIndex,
        evidence: key,
        value: value ?? null,
      })
    }
  }

  const dayIndexes = [...new Set(dayReceipts.map(({ name, receipt }) => Number(receipt.day_index ?? name.match(/^day-(\d+)\.json$/)?.[1])).filter(Number.isInteger))]
  for (let i = 1; i <= MIN_SOAK_DAYS; i += 1) {
    pushCheck(checks, dayIndexes.includes(i), 'required_day_index_present', { day_index: i, observed_day_indexes: dayIndexes })
  }

  const cycleReceipts = []
  const cycleFiles = listJsonFiles(outDir, 'cycle-')
  pushCheck(checks, cycleFiles.length >= MIN_TASK_CYCLES, 'minimum_task_cycle_receipts_present', {
    count: cycleFiles.length,
    minimum: MIN_TASK_CYCLES,
  })
  for (const name of cycleFiles) {
    const path = join(outDir, name)
    const receipt = readReceiptFile(checks, path, 'cycle')
    artifacts.cycles.push(artifactMeta(path, receipt))
    if (!receipt) continue
    cycleReceipts.push({ name, path, receipt })
    checkReceiptBasics(checks, receipt, path, CYCLE_RECEIPT_TYPE, 'cycle')
    pushCheck(checks, targetValue(receipt, 'task_id').length > 0, 'cycle_task_id_present', {
      path,
      task_id: targetValue(receipt, 'task_id') || null,
    })
    for (const key of REQUIRED_CYCLE_EVIDENCE) {
      const value = receipt?.evidence?.[key]
      pushCheck(checks, evidenceValuePass(value), 'cycle_required_evidence_present', {
        path,
        evidence: key,
        value: value ?? null,
      })
    }
  }

  const allReceipts = [
    ...(startReceipt ? [{ label: 'start', receipt: startReceipt }] : []),
    ...dayReceipts.map(({ receipt }) => ({ label: 'day', receipt })),
    ...cycleReceipts.map(({ receipt }) => ({ label: 'cycle', receipt })),
    ...(endReceipt ? [{ label: 'end', receipt: endReceipt }] : []),
  ]

  const targetFields = ['pot', 'base_url', 'rc_version', 'agent']
  const target = {}
  for (const field of targetFields) {
    const values = [...new Set(allReceipts.map(({ receipt }) => targetValue(receipt, field)).filter(Boolean))]
    pushCheck(checks, values.length === (allReceipts.length > 0 ? 1 : 0), 'target_field_consistent_across_receipts', {
      field,
      values,
    })
    target[field] = values.length === 1 ? values[0] : null
  }

  const startAt = parseTime(startReceipt?.started_at ?? startReceipt?.observed_at)
  const endAt = parseTime(endReceipt?.completed_at ?? endReceipt?.observed_at)
  pushCheck(checks, startAt !== null, 'soak_start_time_present', { value: startReceipt?.started_at ?? startReceipt?.observed_at ?? null })
  pushCheck(checks, endAt !== null, 'soak_end_time_present', { value: endReceipt?.completed_at ?? endReceipt?.observed_at ?? null })
  const durationMs = startAt !== null && endAt !== null ? endAt - startAt : null
  pushCheck(checks, durationMs !== null && durationMs >= MIN_SOAK_DAYS * DAY_MS, 'soak_duration_at_least_seven_days', {
    duration_ms: durationMs,
    minimum_ms: MIN_SOAK_DAYS * DAY_MS,
  })

  const taskIds = [...new Set(cycleReceipts.map(({ receipt }) => targetValue(receipt, 'task_id')).filter(Boolean))]
  pushCheck(checks, taskIds.length >= MIN_TASK_CYCLES, 'minimum_distinct_task_cycles_present', {
    task_ids: taskIds,
    minimum: MIN_TASK_CYCLES,
  })

  const endEvidence = endReceipt?.evidence ?? {}
  for (const key of ['no_lost_work', 'no_duplicate_effects', 'no_unauthorized_actions', 'no_critical_failures']) {
    pushCheck(checks, evidenceValuePass(endEvidence[key]), 'end_required_evidence_present', {
      evidence: key,
      value: endEvidence[key] ?? null,
    })
  }

  if (opts.pot) pushCheck(checks, target.pot === opts.pot, 'target_pot_matches_expected', { expected: opts.pot, actual: target.pot })
  if (opts.baseUrl) pushCheck(checks, target.base_url === stripTrailingSlash(opts.baseUrl), 'target_base_url_matches_expected', { expected: stripTrailingSlash(opts.baseUrl), actual: target.base_url })
  if (opts.rcVersion) pushCheck(checks, target.rc_version === opts.rcVersion, 'target_rc_version_matches_expected', { expected: opts.rcVersion, actual: target.rc_version })
  if (opts.agent) pushCheck(checks, target.agent === opts.agent, 'target_agent_matches_expected', { expected: opts.agent, actual: target.agent })

  const failed = checks.filter((check) => check.ok === false)
  const passed = checks.filter((check) => check.ok === true)
  return {
    receipt_type: CHECK_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : 'fail',
    checked_at: new Date().toISOString(),
    out_dir: outDir,
    target,
    summary: {
      passed: passed.length,
      failed: failed.length,
      total: checks.length,
      day_receipts: dayReceipts.length,
      task_cycles: taskIds.length,
      duration_ms: durationMs,
    },
    required: {
      minimum_days: MIN_SOAK_DAYS,
      minimum_task_cycles: MIN_TASK_CYCLES,
      day_evidence: REQUIRED_DAY_EVIDENCE,
      cycle_evidence: REQUIRED_CYCLE_EVIDENCE,
    },
    artifacts,
    checks,
    next_steps: failed.length === 0
      ? ['attach the production soak evidence directory and this check receipt to the v0.23 release issue']
      : ['fix failing production soak evidence, extend or rerun the soak if needed, then rerun production-soak-receipt --check'],
  }
}

export function formatSummary(receipt) {
  const lines = []
  lines.push(`${receipt.receipt_type}: ${receipt.status}`)
  lines.push(`checks: ${receipt.summary.passed}/${receipt.summary.total} passed`)
  lines.push(`days: ${receipt.summary.day_receipts}`)
  lines.push(`task cycles: ${receipt.summary.task_cycles}`)
  lines.push(`duration_ms: ${receipt.summary.duration_ms ?? 'unknown'}`)
  if (receipt.status !== 'pass') {
    for (const check of receipt.checks.filter((entry) => entry.ok === false).slice(0, 12)) {
      lines.push(`FAIL ${check.check}${check.path ? ` ${basename(check.path)}` : ''}${check.reason ? `: ${check.reason}` : ''}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || (!opts.plan && !opts.check)) {
    console.log(usage())
    return
  }
  if (opts.plan) {
    process.stdout.write(formatPlan(opts))
    return
  }
  const receipt = checkBundle(opts)
  if (opts.summary) process.stdout.write(formatSummary(receipt))
  else process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (receipt.status !== 'pass') process.exitCode = 1
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && entry === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(`production-soak-receipt: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}

