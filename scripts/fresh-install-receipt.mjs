#!/usr/bin/env node
// Mupot v0.23 fresh self-host install evidence checker.
//
// The real install runs in a fresh Cloudflare account/pot. This checker validates
// the redacted receipt bundle proving that an operator deployed the pot, finished
// owner setup, and did not manually edit production data.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STEP_RECEIPT_TYPE = 'mupot-fresh-install-step/v1'
export const CHECK_RECEIPT_TYPE = 'mupot-fresh-install/v1'

export const REQUIRED_STEPS = [
  {
    step: 'provision_resources',
    file: 'provision-resources.json',
    evidence: [
      'wrangler_authenticated',
      'd1_created_or_found',
      'vectorize_created_or_found',
      'queue_created_or_found',
      'dlq_created_or_found',
      'sessions_kv_created_or_found',
      'oauth_kv_created_or_found',
      'r2_created_or_found',
      'config_written',
    ],
  },
  {
    step: 'secrets_configured',
    file: 'secrets-configured.json',
    evidence: ['worker_secrets_set', 'secret_names_only', 'no_secret_values'],
  },
  {
    step: 'migrations_applied',
    file: 'migrations-applied.json',
    evidence: ['remote_migrations_applied', 'no_pending_migrations'],
  },
  {
    step: 'worker_deployed',
    file: 'worker-deployed.json',
    evidence: ['dry_run_passed', 'deploy_succeeded', 'deployed_url'],
  },
  {
    step: 'owner_setup',
    file: 'owner-setup.json',
    evidence: ['owner_login_succeeded', 'first_login_became_owner', 'setup_wizard_completed', 'no_manual_db_edits'],
  },
  {
    step: 'post_setup_validation',
    file: 'post-setup-validation.json',
    evidence: ['health_ok', 'mcp_health_ok', 'dashboard_owner_login_ok', 'setup_complete_visible', 'no_manual_db_edits'],
  },
]

const SECRET_VALUE_PATTERNS = [
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i],
  ['mupot_token', /\bmupot_[A-Za-z0-9._-]{12,}\b/],
  ['openai_api_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['cloudflare_api_token', /\bCF-[A-Za-z0-9_-]{20,}\b/],
]

const SECRET_FIELD_RE = /(?:^|[_-])(authorization|bearer|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|api[_-]?key|private[_-]?key|client[_-]?secret|cookie)(?:$|[_-])/i
const SAFE_REFERENCE_FIELD_RE = /(?:^|[_-])(env|name|names|ref|path|file|id|ids|binding|bindings|configured|set)$/i

const MANUAL_DB_COMMAND_RE = /\b(wrangler\s+d1\s+execute|sqlite3\b|INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE)\b/i
const SAFE_DB_COMMAND_RE = /\bwrangler\s+d1\s+migrations\s+apply\b/i

export function parseArgs(argv) {
  const opts = {
    outDir: '',
    pot: '',
    baseUrl: '',
    operator: '',
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
    else if (arg === '--operator') opts.operator = next()
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
    'Usage: node scripts/fresh-install-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                 print the fresh self-host install evidence plan',
    '  --check                check a completed install evidence directory',
    '  --summary              with --check, print a compact text summary',
    '  --out-dir <path>       evidence directory',
    '  --pot <slug>           expected pot slug',
    '  --base-url <url>       expected deployed pot URL',
    '  --operator <id-email>  expected fresh operator identity',
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
  return opts.outDir || `tmp/fresh-install/${opts.pot || '<pot>'}`
}

export function formatPlan(opts = {}) {
  const pot = opts.pot || '<pot>'
  const baseUrl = opts.baseUrl || 'https://<pot-host>'
  const operator = opts.operator || '<operator-email-or-id>'
  const outDir = defaultOutDir(opts)
  const lines = []

  lines.push('Mupot v0.23 fresh self-host install evidence plan')
  lines.push('')
  lines.push('Goal: prove a fresh operator can deploy a pot to Cloudflare and finish owner setup without manual database edits.')
  lines.push('')
  lines.push('Before running:')
  lines.push('- Use a fresh or throwaway Cloudflare pot/account path, not an already-loved production pot.')
  lines.push('- Keep token values, cookies, private keys, OAuth client secrets, and provider credentials out of receipts.')
  lines.push('- Record command ids, command names, secret names, binding names, URLs, and redacted artifact paths only.')
  lines.push('- Do not repair setup by editing D1 rows manually. If manual DB edits are needed, the receipt must fail.')
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
      operator,
      cloudflare_account: '<redacted account id or account label>',
      worker: `mupot-${pot}`,
      db: `mupot-${pot}`,
      config: `wrangler.${pot}.toml`,
    },
    commands: [
      { command: '<redacted command or command id>', ok: true, exit_code: 0 },
    ],
    evidence: {
      '<required_key>': true,
      no_manual_db_edits: true,
    },
    artifacts: [
      { label: '<artifact label>', path: '<redacted path or attachable artifact name>' },
    ],
  }, null, 2))
  lines.push('')
  lines.push('After all files are present:')
  lines.push(commandLine([
    'node',
    'scripts/fresh-install-receipt.mjs',
    '--check',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
    '--operator',
    operator,
  ], ` > ${shellQuote(join(outDir, 'fresh-install-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/fresh-install-receipt.mjs',
    '--check',
    '--summary',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
    '--operator',
    operator,
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

function receiptTargetValue(receipt, field) {
  const target = receipt?.target && typeof receipt.target === 'object' ? receipt.target : {}
  const value = target[field]
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

function commandText(command) {
  if (typeof command === 'string') return command
  if (command && typeof command === 'object') return String(command.command ?? command.cmd ?? command.name ?? '')
  return ''
}

function commandOk(command) {
  if (typeof command === 'string') return true
  if (!command || typeof command !== 'object') return false
  if ('ok' in command) return command.ok === true
  if ('exit_code' in command) return command.exit_code === 0
  return true
}

function commandShowsManualDbEdit(command) {
  const text = commandText(command)
  if (!text) return false
  return MANUAL_DB_COMMAND_RE.test(text) && !SAFE_DB_COMMAND_RE.test(text)
}

export function checkBundle(opts = {}) {
  const outDir = resolve(defaultOutDir(opts))
  const checks = []
  const artifacts = {}

  pushCheck(checks, existsSync(outDir), 'evidence_directory_present', { out_dir: outDir })
  if (existsSync(outDir)) {
    const expected = new Set([...REQUIRED_STEPS.map((step) => step.file), 'fresh-install-check.json'])
    const extraFiles = readdirSync(outDir).filter((name) => name.endsWith('.json') && !expected.has(name))
    pushCheck(checks, extraFiles.length === 0, 'bundle_only_expected_json_files', { extra_files: extraFiles })
  }

  const receipts = []
  for (const spec of REQUIRED_STEPS) {
    const path = join(outDir, spec.file)
    const receipt = readReceiptFile(checks, path, spec.step)
    artifacts[spec.step] = artifactMeta(path, receipt)
    if (!receipt) continue
    receipts.push({ spec, path, receipt })
    checkReceiptBasics(checks, receipt, path, spec.step)

    for (const key of spec.evidence) {
      const value = receipt?.evidence?.[key]
      pushCheck(checks, evidenceValuePass(value), 'required_evidence_present', {
        path,
        step: spec.step,
        evidence: key,
        value: value ?? null,
      })
    }

    const commands = Array.isArray(receipt.commands) ? receipt.commands : []
    pushCheck(checks, commands.length > 0, 'receipt_records_commands', { path, step: spec.step, count: commands.length })
    const failedCommands = commands.filter((command) => !commandOk(command)).map(commandText)
    pushCheck(checks, failedCommands.length === 0, 'receipt_commands_succeeded', { path, step: spec.step, failed_commands: failedCommands })
    const manualDbCommands = commands.filter(commandShowsManualDbEdit).map(commandText)
    pushCheck(checks, manualDbCommands.length === 0, 'receipt_has_no_manual_db_edit_commands', {
      path,
      step: spec.step,
      manual_db_commands: manualDbCommands,
    })
  }

  const targetFields = ['pot', 'base_url', 'operator', 'cloudflare_account']
  const target = {}
  for (const field of targetFields) {
    const values = [...new Set(receipts.map(({ receipt }) => receiptTargetValue(receipt, field)).filter(Boolean))]
    pushCheck(checks, values.length === (receipts.length > 0 ? 1 : 0), 'target_field_consistent_across_receipts', {
      field,
      values,
    })
    target[field] = values.length === 1 ? values[0] : null
  }

  for (const { spec, path, receipt } of receipts) {
    const noManual = receipt?.evidence?.no_manual_db_edits
    if (spec.step === 'owner_setup' || spec.step === 'post_setup_validation' || noManual !== undefined) {
      pushCheck(checks, noManual === true, 'no_manual_db_edits_attested', {
        path,
        step: spec.step,
        value: noManual ?? null,
      })
    }
  }

  if (opts.pot) pushCheck(checks, target.pot === opts.pot, 'target_pot_matches_expected', { expected: opts.pot, actual: target.pot })
  if (opts.baseUrl) pushCheck(checks, target.base_url === stripTrailingSlash(opts.baseUrl), 'target_base_url_matches_expected', { expected: stripTrailingSlash(opts.baseUrl), actual: target.base_url })
  if (opts.operator) pushCheck(checks, target.operator === opts.operator, 'target_operator_matches_expected', { expected: opts.operator, actual: target.operator })

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
      step_receipts: receipts.length,
    },
    required: {
      steps: REQUIRED_STEPS,
    },
    artifacts,
    checks,
    next_steps: failed.length === 0
      ? ['attach the fresh-install evidence directory and this check receipt to the v0.23 release issue']
      : ['fix failing fresh-install evidence or rerun the install without manual database edits, then rerun fresh-install-receipt --check'],
  }
}

export function formatSummary(receipt) {
  const lines = []
  lines.push(`${receipt.receipt_type}: ${receipt.status}`)
  lines.push(`checks: ${receipt.summary.passed}/${receipt.summary.total} passed`)
  lines.push(`steps: ${receipt.summary.step_receipts}/${REQUIRED_STEPS.length}`)
  lines.push(`pot: ${receipt.target.pot ?? 'unknown'}`)
  lines.push(`base_url: ${receipt.target.base_url ?? 'unknown'}`)
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
    console.error(`fresh-install-receipt: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
