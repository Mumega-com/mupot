#!/usr/bin/env node
// Mupot staging recovery rehearsal evidence checker.
//
// The real rehearsal runs against a staging Cloudflare pot. This script keeps
// the evidence falsifiable: each operation writes a redacted step receipt, and
// this checker emits one aggregate release-gate receipt.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STEP_RECEIPT_TYPE = 'mupot-staging-recovery-step/v1'
export const CHECK_RECEIPT_TYPE = 'mupot-staging-recovery-rehearsal/v1'

export const REQUIRED_STEPS = [
  {
    step: 'backup',
    file: 'backup.json',
    evidence: ['d1_export', 'config_inventory', 'secret_names_export', 'source_git_sha'],
  },
  {
    step: 'upgrade',
    file: 'upgrade.json',
    evidence: ['previous_git_sha', 'migrations_applied', 'deployed_sha'],
  },
  {
    step: 'restore',
    file: 'restore.json',
    evidence: ['restored_to_new_db', 'restore_validation'],
  },
  {
    step: 'rollback',
    file: 'rollback.json',
    evidence: ['worker_rollback', 'rolled_back_to_sha', 'rollback_validation', 'recovered_to_sha'],
  },
  {
    step: 'queue_dlq',
    file: 'queue-dlq.json',
    evidence: ['queue_delivery', 'dlq_capture', 'idempotency_verified'],
  },
  {
    step: 'failure_reporting',
    file: 'failure-reporting.json',
    evidence: ['ops_failure_visible', 'tail_or_log_reference'],
  },
  {
    step: 'final_validation',
    file: 'final-validation.json',
    evidence: ['health', 'mcp_health', 'owner_login', 'agent_presence'],
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
const SAFE_REFERENCE_FIELD_RE = /(?:^|[_-])(env|name|names|ref|path|file|id)$/i

export function parseArgs(argv) {
  const opts = {
    outDir: '',
    pot: '',
    baseUrl: '',
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
    'Usage: node scripts/staging-recovery-rehearsal.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                 print the staging rehearsal evidence plan',
    '  --check                check a completed staging evidence directory',
    '  --out-dir <path>       evidence directory; default shown in --plan',
    '  --pot <slug>           expected pot slug for target consistency checks',
    '  --base-url <url>       expected staging base URL for target consistency checks',
    '  --summary              with --check, print a compact text summary',
    '  -h, --help             show this help',
  ].join('\n')
}

function shellQuote(value) {
  const raw = String(value)
  if (/^[A-Za-z0-9_./:=@%+~,-]+$/.test(raw)) return raw
  return `'${raw.replace(/'/g, `'\\''`)}'`
}

function commandLine(parts, suffix = '') {
  return `${parts.map(shellQuote).join(' ')}${suffix}`
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '')
}

function defaultOutDir(opts) {
  return opts.outDir || `tmp/staging-recovery/${opts.pot || '<pot>'}`
}

export function formatPlan(opts = {}) {
  const pot = opts.pot || '<pot>'
  const baseUrl = opts.baseUrl || 'https://<staging-pot-host>'
  const outDir = defaultOutDir(opts)
  const lines = []

  lines.push('Mupot v0.23 staging recovery rehearsal')
  lines.push('')
  lines.push('Goal: prove backup, upgrade, restore, rollback, Queue/DLQ behavior, failure reporting, and final health on a staging pot.')
  lines.push('')
  lines.push('Before running:')
  lines.push('- Use a staging pot, not production.')
  lines.push('- Keep secret values out of receipts. Record secret names, key names, command references, or redacted placeholders only.')
  lines.push('- Each step receipt must use receipt_type "mupot-staging-recovery-step/v1" and status "pass".')
  lines.push('- Run each step in the printed order without overlap; every step must start at or after the previous step completed.')
  lines.push('- Record the older source SHA in backup/upgrade evidence and both rollback and recovered SHAs in rollback evidence.')
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
    started_at: '<ISO-8601>',
    completed_at: '<ISO-8601>',
    target: {
      pot,
      base_url: baseUrl,
      worker: `mupot-${pot}`,
      db: `mupot-${pot}`,
      git_sha: '<deployed git sha>',
    },
    commands: [
      { command: '<redacted command or command id>', ok: true, exit_code: 0 },
    ],
    evidence: {
      '<required_key>': true,
    },
    artifacts: [
      { label: '<artifact label>', path: '<redacted path or attachable artifact name>' },
    ],
  }, null, 2))
  lines.push('')
  lines.push('After all files are present:')
  lines.push(commandLine([
    'node',
    'scripts/staging-recovery-rehearsal.mjs',
    '--check',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
  ], ` > ${shellQuote(join(outDir, 'staging-recovery-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/staging-recovery-rehearsal.mjs',
    '--check',
    '--summary',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
  ]))
  lines.push('')
  lines.push('Attach the evidence directory plus staging-recovery-check.json only when the aggregate receipt reports status "pass".')

  return `${lines.join('\n')}\n`
}

function pushCheck(checks, ok, check, extra = {}) {
  checks.push({ ok, component: 'staging-recovery-check', check, ...extra })
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

function evidenceString(receipt, key) {
  const value = receipt?.evidence?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function isGitSha(value) {
  return /^[0-9a-f]{40}$/i.test(value)
}

export function checkBundle(opts = {}) {
  const outDir = opts.outDir ? resolve(opts.outDir) : ''
  const checks = []
  const artifacts = {}
  const receipts = []
  const timeline = []

  pushCheck(checks, Boolean(outDir), 'out_dir_arg_present', { out_dir: outDir })
  pushCheck(checks, Boolean(outDir && existsSync(outDir)), 'out_dir_exists', { out_dir: outDir })

  if (outDir && existsSync(outDir)) {
    const allowed = new Set([...REQUIRED_STEPS.map((step) => step.file), 'staging-recovery-check.json'])
    const extraFiles = readdirSync(outDir).filter((name) => name.endsWith('.json') && !allowed.has(name))
    pushCheck(checks, extraFiles.length === 0, 'bundle_only_required_json_files', { extra_files: extraFiles })
  }

  for (const step of REQUIRED_STEPS) {
    const path = outDir ? join(outDir, step.file) : step.file
    const exists = Boolean(outDir && existsSync(path))
    pushCheck(checks, exists, 'step_receipt_exists', { step: step.step, path })

    if (!exists) {
      artifacts[step.step] = { path, sha256: null, receipt_type: null, status: null }
      continue
    }

    const parsed = readJson(path)
    pushCheck(checks, parsed.ok, 'step_receipt_json_read', { step: step.step, path, ...(parsed.ok ? {} : { reason: parsed.reason }) })
    if (!parsed.ok) {
      artifacts[step.step] = { path, sha256: sha256(path), receipt_type: null, status: null }
      continue
    }

    const receipt = parsed.value
    receipts.push({ step: step.step, path, receipt })
    artifacts[step.step] = {
      path,
      sha256: sha256(path),
      receipt_type: receipt?.receipt_type ?? null,
      status: receipt?.status ?? null,
    }

    pushCheck(checks, receipt?.receipt_type === STEP_RECEIPT_TYPE, 'step_receipt_type', {
      step: step.step,
      path,
      expected: STEP_RECEIPT_TYPE,
      actual: receipt?.receipt_type ?? null,
    })
    pushCheck(checks, receipt?.step === step.step, 'step_receipt_name', {
      step: step.step,
      path,
      actual: receipt?.step ?? null,
    })
    pushCheck(checks, receipt?.status === 'pass', 'step_receipt_status_pass', {
      step: step.step,
      path,
      actual: receipt?.status ?? null,
    })

    const started = Date.parse(String(receipt?.started_at ?? ''))
    const completed = Date.parse(String(receipt?.completed_at ?? ''))
    pushCheck(checks, Number.isFinite(started), 'step_started_at_iso', { step: step.step, path, value: receipt?.started_at ?? null })
    pushCheck(checks, Number.isFinite(completed), 'step_completed_at_iso', { step: step.step, path, value: receipt?.completed_at ?? null })
    pushCheck(checks, Number.isFinite(started) && Number.isFinite(completed) && completed >= started, 'step_time_order', { step: step.step, path })
    if (Number.isFinite(started) && Number.isFinite(completed)) {
      timeline.push({
        step: step.step,
        started_at: receipt.started_at,
        completed_at: receipt.completed_at,
        started_ms: started,
        completed_ms: completed,
      })
    }

    const commands = Array.isArray(receipt?.commands) ? receipt.commands : []
    pushCheck(checks, commands.length > 0, 'step_commands_recorded', { step: step.step, path, count: commands.length })
    commands.forEach((command, index) => {
      pushCheck(checks, typeof command?.command === 'string' && command.command.trim().length > 0, 'step_command_named', { step: step.step, path, index })
      pushCheck(checks, command?.ok === true, 'step_command_ok', { step: step.step, path, index, exit_code: command?.exit_code ?? null })
    })

    const evidence = receipt?.evidence && typeof receipt.evidence === 'object' ? receipt.evidence : {}
    for (const key of step.evidence) {
      pushCheck(checks, evidenceValuePass(evidence[key]), 'required_evidence_present', {
        step: step.step,
        path,
        evidence: key,
        value: evidence[key] ?? null,
      })
    }

    for (const key of ['pot', 'base_url', 'worker', 'db', 'git_sha']) {
      pushCheck(checks, targetValue(receipt, key).length > 0, 'step_target_field_present', {
        step: step.step,
        path,
        field: key,
        value: targetValue(receipt, key) || null,
      })
    }

    const secretFindings = findSecretMaterial(receipt)
    pushCheck(checks, secretFindings.length === 0, 'step_receipt_no_secret_material', {
      step: step.step,
      path,
      findings: secretFindings.slice(0, 20),
    })
  }

  for (let index = 1; index < timeline.length; index += 1) {
    const previous = timeline[index - 1]
    const current = timeline[index]
    pushCheck(checks, current.started_ms >= previous.completed_ms, 'rehearsal_steps_run_in_order_without_overlap', {
      previous_step: previous.step,
      previous_completed_at: previous.completed_at,
      step: current.step,
      started_at: current.started_at,
    })
  }

  const targetFields = ['pot', 'base_url', 'worker', 'db', 'git_sha']
  const target = {}
  for (const field of targetFields) {
    const values = [...new Set(receipts.map(({ receipt }) => targetValue(receipt, field)).filter(Boolean))]
    pushCheck(checks, values.length === (receipts.length > 0 ? 1 : 0), 'target_field_consistent_across_steps', {
      field,
      values,
    })
    target[field] = values.length === 1 ? values[0] : null
  }

  if (opts.pot) {
    pushCheck(checks, target.pot === opts.pot, 'target_pot_matches_expected', {
      expected: opts.pot,
      actual: target.pot,
    })
  }
  if (opts.baseUrl) {
    pushCheck(checks, target.base_url === stripTrailingSlash(opts.baseUrl), 'target_base_url_matches_expected', {
      expected: stripTrailingSlash(opts.baseUrl),
      actual: target.base_url,
    })
  }

  const receiptByStep = new Map(receipts.map(({ step, receipt }) => [step, receipt]))
  const backupSourceSha = evidenceString(receiptByStep.get('backup'), 'source_git_sha')
  const upgradePreviousSha = evidenceString(receiptByStep.get('upgrade'), 'previous_git_sha')
  const upgradeDeployedSha = evidenceString(receiptByStep.get('upgrade'), 'deployed_sha')
  const rolledBackToSha = evidenceString(receiptByStep.get('rollback'), 'rolled_back_to_sha')
  const recoveredToSha = evidenceString(receiptByStep.get('rollback'), 'recovered_to_sha')

  for (const [field, value] of [
    ['backup.source_git_sha', backupSourceSha],
    ['upgrade.previous_git_sha', upgradePreviousSha],
    ['upgrade.deployed_sha', upgradeDeployedSha],
    ['rollback.rolled_back_to_sha', rolledBackToSha],
    ['rollback.recovered_to_sha', recoveredToSha],
  ]) {
    pushCheck(checks, isGitSha(value), 'recovery_git_sha_valid', {
      field,
      value: value || null,
    })
  }

  pushCheck(checks, Boolean(backupSourceSha && upgradePreviousSha && backupSourceSha === upgradePreviousSha), 'backup_source_matches_upgrade_previous_sha', {
    backup_source_git_sha: backupSourceSha || null,
    upgrade_previous_git_sha: upgradePreviousSha || null,
  })
  pushCheck(checks, Boolean(upgradePreviousSha && upgradeDeployedSha && upgradePreviousSha !== upgradeDeployedSha), 'upgrade_changes_git_sha', {
    previous_git_sha: upgradePreviousSha || null,
    deployed_sha: upgradeDeployedSha || null,
  })
  pushCheck(checks, Boolean(upgradeDeployedSha && target.git_sha && upgradeDeployedSha === target.git_sha), 'upgrade_deploys_target_git_sha', {
    deployed_sha: upgradeDeployedSha || null,
    target_git_sha: target.git_sha,
  })
  pushCheck(checks, Boolean(rolledBackToSha && upgradePreviousSha && rolledBackToSha === upgradePreviousSha), 'rollback_returns_to_previous_git_sha', {
    rolled_back_to_sha: rolledBackToSha || null,
    previous_git_sha: upgradePreviousSha || null,
  })
  pushCheck(checks, Boolean(recoveredToSha && upgradeDeployedSha && recoveredToSha === upgradeDeployedSha), 'rollback_recovery_returns_to_target_git_sha', {
    recovered_to_sha: recoveredToSha || null,
    target_git_sha: upgradeDeployedSha || null,
  })

  const failed = checks.filter((check) => check.ok === false)
  const passed = checks.filter((check) => check.ok === true)
  return {
    receipt_type: CHECK_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : 'fail',
    checked_at: new Date().toISOString(),
    out_dir: outDir,
    target,
    timeline: timeline.map(({ step, started_at, completed_at }) => ({ step, started_at, completed_at })),
    required_steps: REQUIRED_STEPS.map(({ step, file, evidence }) => ({ step, file, evidence })),
    artifacts,
    summary: {
      passed: passed.length,
      failed: failed.length,
      total: checks.length,
    },
    checks,
    next_steps: failed.length === 0
      ? ['attach the staging recovery evidence directory and this check receipt to the v0.23 release issue']
      : ['fix failing staging evidence, rerun the rehearsal step if needed, then rerun staging-recovery-rehearsal --check'],
  }
}

export function formatSummary(receipt) {
  const lines = []
  lines.push(`${receipt.receipt_type}: ${receipt.status}`)
  lines.push(`checks: ${receipt.summary.passed}/${receipt.summary.total} passed`)
  for (const step of REQUIRED_STEPS) {
    const artifact = receipt.artifacts[step.step]
    lines.push(`${step.step}: ${artifact?.status ?? 'missing'} ${artifact?.path ? basename(artifact.path) : step.file}`)
  }
  if (receipt.status !== 'pass') {
    for (const check of receipt.checks.filter((entry) => entry.ok === false).slice(0, 12)) {
      lines.push(`FAIL ${check.check}${check.step ? ` ${check.step}` : ''}${check.reason ? `: ${check.reason}` : ''}`)
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
    console.error(`staging-recovery-rehearsal: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
