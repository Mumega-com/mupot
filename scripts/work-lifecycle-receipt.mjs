#!/usr/bin/env node
// Mupot v0.23 real work-lifecycle evidence checker.
//
// This validates one actual product task cycle: task creation, real-agent
// execution, approval, completion, and audit visibility.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STEP_RECEIPT_TYPE = 'mupot-work-lifecycle-step/v1'
export const CHECK_RECEIPT_TYPE = 'mupot-work-lifecycle/v1'

export const REQUIRED_STEPS = [
  {
    step: 'task_created',
    file: 'task-created.json',
    evidence: ['task_id', 'done_when', 'visible_in_product', 'created_by_operator'],
  },
  {
    step: 'agent_execution',
    file: 'agent-execution.json',
    evidence: ['real_agent_identity', 'agent_received_work', 'agent_executed_work', 'result_recorded'],
  },
  {
    step: 'approval_recorded',
    file: 'approval-recorded.json',
    evidence: ['review_state_entered', 'human_approval_recorded', 'approval_actor_attributed'],
  },
  {
    step: 'task_completed',
    file: 'task-completed.json',
    evidence: ['task_completed', 'done_when_satisfied', 'result_visible_in_product'],
  },
  {
    step: 'audit_verified',
    file: 'audit-verified.json',
    evidence: ['task_event_record', 'verdict_or_gate_record', 'actor_attribution', 'timeline_visible'],
  },
]

const SECRET_VALUE_PATTERNS = [
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i],
  ['mupot_token', /\bmupot_[A-Za-z0-9._-]{12,}\b/],
  ['openai_api_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
]

const SECRET_FIELD_RE = /(?:^|[_-])(authorization|bearer|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|private[_-]?key|client[_-]?secret|cookie)(?:$|[_-])/i
const SAFE_REFERENCE_FIELD_RE = /(?:^|[_-])(env|name|names|ref|path|file|id|ids|label|labels)$/i

export function parseArgs(argv) {
  const opts = {
    outDir: '',
    pot: '',
    baseUrl: '',
    agent: '',
    taskId: '',
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
    else if (arg === '--agent') opts.agent = next()
    else if (arg === '--task-id') opts.taskId = next()
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
    'Usage: node scripts/work-lifecycle-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                 print the real task lifecycle evidence plan',
    '  --check                check a completed lifecycle evidence directory',
    '  --summary              with --check, print a compact text summary',
    '  --out-dir <path>       evidence directory',
    '  --pot <slug>           expected pot slug',
    '  --base-url <url>       expected pot URL',
    '  --agent <id-or-slug>   expected real agent identity',
    '  --task-id <id>         expected task id',
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
  return opts.outDir || `tmp/work-lifecycle/${opts.taskId || '<task-id>'}`
}

export function formatPlan(opts = {}) {
  const pot = opts.pot || '<pot>'
  const baseUrl = opts.baseUrl || 'https://<pot-host>'
  const agent = opts.agent || '<agent-id-or-slug>'
  const taskId = opts.taskId || '<task-id>'
  const outDir = defaultOutDir(opts)
  const lines = []

  lines.push('Mupot v0.23 real work-lifecycle evidence plan')
  lines.push('')
  lines.push('Goal: prove one actual product task moves from creation to real-agent execution, approval, completion, and audit visibility.')
  lines.push('')
  lines.push('Before running:')
  lines.push('- Use a real deployed pot and a real signed runtime agent.')
  lines.push('- The task must be created and completed through product surfaces, not direct SQL.')
  lines.push('- Each step receipt must include a parseable ISO-8601 observed_at value, and observed_at values must follow the lifecycle order below.')
  lines.push('- Keep token values, cookies, private keys, provider credentials, and raw webhook payload secrets out of receipts.')
  lines.push('')
  lines.push(commandLine(['mkdir', '-p', outDir]))
  lines.push('')
  for (const step of REQUIRED_STEPS) {
    lines.push(`${step.step}: write ${step.file}`)
    lines.push(`  required evidence keys: ${step.evidence.join(', ')}`)
  }
  lines.push('')
  lines.push('Minimum step receipt shape:')
  lines.push(JSON.stringify({
    receipt_type: STEP_RECEIPT_TYPE,
    step: '<required-step>',
    status: 'pass',
    observed_at: '<ISO-8601>',
    target: {
      pot,
      base_url: baseUrl,
      agent,
      task_id: taskId,
    },
    evidence: {
      '<required_key>': true,
    },
    artifacts: [
      { label: '<screenshot, API response, audit row, or receipt label>', path: '<redacted attachable artifact path>' },
    ],
  }, null, 2))
  lines.push('')
  lines.push('Check the completed bundle:')
  lines.push(commandLine([
    'node',
    'scripts/work-lifecycle-receipt.mjs',
    '--check',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
    '--agent',
    agent,
    '--task-id',
    taskId,
  ], ` > ${shellQuote(join(outDir, 'work-lifecycle-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/work-lifecycle-receipt.mjs',
    '--check',
    '--summary',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
    '--agent',
    agent,
    '--task-id',
    taskId,
  ]))
  return `${lines.join('\n')}\n`
}

function pushCheck(checks, ok, check, detail = {}) {
  checks.push({ ok: Boolean(ok), check, ...detail })
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function scanSecrets(value, path = '$', findings = []) {
  if (typeof value === 'string') {
    for (const [kind, re] of SECRET_VALUE_PATTERNS) {
      if (re.test(value)) findings.push({ path, kind })
    }
    return findings
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSecrets(entry, `${path}[${index}]`, findings))
    return findings
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const nextPath = `${path}.${key}`
      if (SECRET_FIELD_RE.test(key) && !SAFE_REFERENCE_FIELD_RE.test(key)) {
        if (typeof entry === 'string' && entry && !/^<[^>]+>$/.test(entry) && !/redacted|masked|hidden|name only|names only/i.test(entry)) {
          findings.push({ path: nextPath, kind: 'sensitive_field_value' })
        }
      }
      scanSecrets(entry, nextPath, findings)
    }
  }
  return findings
}

function readReceiptFile(checks, path, label) {
  if (!existsSync(path)) {
    pushCheck(checks, false, 'receipt_file_present', { label, path })
    return null
  }
  pushCheck(checks, true, 'receipt_file_present', { label, path })
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
    pushCheck(checks, true, 'receipt_json_parseable', { label, path })
  } catch (err) {
    pushCheck(checks, false, 'receipt_json_parseable', { label, path, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
  const secretFindings = scanSecrets(parsed)
  pushCheck(checks, secretFindings.length === 0, 'receipt_has_no_secret_material', { label, path, findings: secretFindings })
  return parsed
}

function artifactMeta(path, receipt) {
  if (!existsSync(path)) return { path, exists: false }
  return {
    path,
    exists: true,
    bytes: readFileSync(path).byteLength,
    sha256: fileSha256(path),
    receipt_type: receipt?.receipt_type ?? null,
    status: receipt?.status ?? null,
  }
}

function evidenceValuePass(value) {
  if (value === true) return true
  if (typeof value === 'string') return value.trim().length > 0 && !/^false|fail|missing|todo|n\/a$/i.test(value.trim())
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return true
  return false
}

function targetValue(receipt, field) {
  const target = receipt?.target && typeof receipt.target === 'object' ? receipt.target : {}
  const value = target[field] ?? receipt?.evidence?.[field]
  return typeof value === 'string' ? stripTrailingSlash(value.trim()) : ''
}

function checkReceiptBasics(checks, receipt, path, step) {
  pushCheck(checks, receipt.receipt_type === STEP_RECEIPT_TYPE, 'receipt_type_matches', {
    path,
    expected: STEP_RECEIPT_TYPE,
    actual: receipt.receipt_type ?? null,
  })
  pushCheck(checks, receipt.status === 'pass', 'receipt_status_pass', {
    path,
    actual: receipt.status ?? null,
  })
  pushCheck(checks, receipt.step === step, 'receipt_step_matches', {
    path,
    expected: step,
    actual: receipt.step ?? null,
  })
}

function observedAtMs(receipt) {
  const raw = typeof receipt?.observed_at === 'string' ? receipt.observed_at.trim() : ''
  const ms = raw ? Date.parse(raw) : NaN
  return {
    raw,
    ms,
    ok: Boolean(raw) && Number.isFinite(ms),
  }
}

export function checkBundle(opts = {}) {
  const outDir = resolve(defaultOutDir(opts))
  const checks = []
  const artifacts = {}

  pushCheck(checks, existsSync(outDir), 'evidence_directory_present', { out_dir: outDir })
  if (existsSync(outDir)) {
    const expected = new Set([...REQUIRED_STEPS.map((step) => step.file), 'work-lifecycle-check.json'])
    const extraFiles = readdirSync(outDir).filter((name) => name.endsWith('.json') && !expected.has(name))
    pushCheck(checks, extraFiles.length === 0, 'bundle_only_expected_json_files', { extra_files: extraFiles })
  }

  const receipts = []
  const timeline = []
  for (const spec of REQUIRED_STEPS) {
    const path = join(outDir, spec.file)
    const receipt = readReceiptFile(checks, path, spec.step)
    artifacts[spec.step] = artifactMeta(path, receipt)
    if (!receipt) continue
    receipts.push({ spec, path, receipt })
    checkReceiptBasics(checks, receipt, path, spec.step)
    const observed = observedAtMs(receipt)
    pushCheck(checks, observed.ok, 'observed_at_parseable', {
      path,
      step: spec.step,
      observed_at: observed.raw || null,
    })
    if (observed.ok) timeline.push({ step: spec.step, path, observed_at: observed.raw, observed_ms: observed.ms })
    for (const key of spec.evidence) {
      const value = receipt?.evidence?.[key]
      pushCheck(checks, evidenceValuePass(value), 'required_evidence_present', {
        path,
        step: spec.step,
        evidence: key,
        value: value ?? null,
      })
    }
  }

  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1]
    const current = timeline[index]
    pushCheck(checks, current.observed_ms >= previous.observed_ms, 'lifecycle_steps_observed_in_order', {
      previous_step: previous.step,
      previous_observed_at: previous.observed_at,
      step: current.step,
      observed_at: current.observed_at,
    })
  }

  const targetFields = ['pot', 'base_url', 'agent', 'task_id']
  const target = {}
  for (const field of targetFields) {
    const values = [...new Set(receipts.map(({ receipt }) => targetValue(receipt, field)).filter(Boolean))]
    pushCheck(checks, values.length === (receipts.length > 0 ? 1 : 0), 'target_field_consistent_across_receipts', {
      field,
      values,
    })
    target[field] = values.length === 1 ? values[0] : null
  }

  if (opts.pot) pushCheck(checks, target.pot === opts.pot, 'target_pot_matches_expected', { expected: opts.pot, actual: target.pot })
  if (opts.baseUrl) pushCheck(checks, target.base_url === stripTrailingSlash(opts.baseUrl), 'target_base_url_matches_expected', { expected: stripTrailingSlash(opts.baseUrl), actual: target.base_url })
  if (opts.agent) pushCheck(checks, target.agent === opts.agent, 'target_agent_matches_expected', { expected: opts.agent, actual: target.agent })
  if (opts.taskId) pushCheck(checks, target.task_id === opts.taskId, 'target_task_id_matches_expected', { expected: opts.taskId, actual: target.task_id })

  const failed = checks.filter((check) => check.ok === false)
  const passed = checks.filter((check) => check.ok === true)
  return {
    receipt_type: CHECK_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : 'fail',
    checked_at: new Date().toISOString(),
    out_dir: outDir,
    target,
    timeline: timeline.map(({ step, observed_at }) => ({ step, observed_at })),
    summary: {
      passed: passed.length,
      failed: failed.length,
      total: checks.length,
      step_receipts: receipts.length,
    },
    required: {
      steps: REQUIRED_STEPS,
    },
    artifacts,
    checks,
    next_steps: failed.length === 0
      ? ['attach the work-lifecycle evidence directory and this check receipt to the v0.23 release issue']
      : ['fix failing work-lifecycle evidence, rerun the product task cycle if needed, then rerun work-lifecycle-receipt --check'],
  }
}

export function formatSummary(receipt) {
  const lines = []
  lines.push(`${receipt.receipt_type}: ${receipt.status}`)
  lines.push(`checks: ${receipt.summary.passed}/${receipt.summary.total} passed`)
  lines.push(`steps: ${receipt.summary.step_receipts}/${REQUIRED_STEPS.length}`)
  lines.push(`task: ${receipt.target.task_id ?? 'unknown'}`)
  lines.push(`agent: ${receipt.target.agent ?? 'unknown'}`)
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
    console.error(`work-lifecycle-receipt: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
