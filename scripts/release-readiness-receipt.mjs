#!/usr/bin/env node
// Mupot v0.23 aggregate release-readiness checker.
//
// This is the final completion-audit receipt. It does not create evidence; it
// verifies that every objective-specific receipt and exported GitHub state is
// present before v0.23.0 is treated as shippable.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECK_RECEIPT_TYPE = 'mupot-v023-release-readiness/v1'

const DEFAULT_VERSION = 'v0.23.0'
const DEFAULT_REPO = 'Mumega-com/mupot'

export const REQUIRED_RECEIPTS = [
  { objective: 1, issue: 282, file: 'fresh-install-check.json', receipt_type: 'mupot-fresh-install/v1' },
  { objective: 2, issue: 274, file: 'host-go/manifest.json', receipt_type: 'mupot-fleet-receipt-bundle/v1' },
  { objective: 2, issue: 274, file: 'host-go/cutover-gate.json', receipt_type: 'mupot-sos-cutover-gate/v1' },
  { objective: 2, issue: 274, file: 'host-go/export-receipt.json', receipt_type: 'mupot-fleet-receipt-bundle-export/v1' },
  { objective: 2, issue: 274, file: 'host-go/manifest-check.json', receipt_type: 'mupot-fleet-receipt-bundle-check/v1' },
  { objective: 4, issue: 283, file: 'work-lifecycle-check.json', receipt_type: 'mupot-work-lifecycle/v1' },
  { objective: 5, issue: 150, file: 'external-pr-cycle-check.json', receipt_type: 'mupot-external-pr-cycle/v1' },
  { objective: 7, issue: 279, file: 'staging-recovery-check.json', receipt_type: 'mupot-staging-recovery-rehearsal/v1' },
  { objective: 10, issue: 280, file: 'production-soak-check.json', receipt_type: 'mupot-production-soak/v1' },
  { objective: 9, issue: 281, file: 'release-integrity-check.json', receipt_type: 'mupot-release-integrity/v1' },
]

export const REQUIRED_ISSUES = [150, 151, 274, 277, 279, 280, 281, 282, 283]

export const REQUIRED_APP_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  organization_projects: 'read',
}

export const REQUIRED_CHECKS = [
  'build',
  'plugin',
  'no-secrets',
  'local-evidence',
  'CodeQL',
  'Analyze (actions)',
  'Analyze (javascript-typescript)',
  'Analyze (python)',
]

const SECRET_VALUE_PATTERNS = [
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i],
  ['mupot_token', /\bmupot_[A-Za-z0-9._-]{12,}\b/],
  ['openai_api_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
]

export function parseArgs(argv) {
  const opts = {
    outDir: '',
    version: DEFAULT_VERSION,
    repo: DEFAULT_REPO,
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
    else if (arg === '--version') opts.version = normalizeTag(next())
    else if (arg === '--repo') opts.repo = next()
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
    'Usage: node scripts/release-readiness-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan              print the final release-readiness evidence plan',
    '  --check             check the completed aggregate evidence directory',
    '  --summary           with --check, print a compact text summary',
    '  --out-dir <path>    aggregate evidence directory',
    '  --version <version> expected version; default v0.23.0',
    '  --repo <owner/repo> GitHub repo; default Mumega-com/mupot',
    '  -h, --help          show this help',
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

function normalizeTag(version) {
  const raw = String(version || '').trim()
  const semver = raw.replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+$/.test(semver)) throw new Error(`expected semver release like v0.23.0, got ${version}`)
  return `v${semver}`
}

function defaultOutDir(opts) {
  const tag = normalizeTag(opts.version || DEFAULT_VERSION)
  return opts.outDir || `tmp/release-readiness/${tag}`
}

export function formatPlan(opts = {}) {
  const version = normalizeTag(opts.version || DEFAULT_VERSION)
  const repo = opts.repo || DEFAULT_REPO
  const outDir = defaultOutDir({ ...opts, version })
  const lines = []

  lines.push('Mupot v0.23 final release-readiness evidence plan')
  lines.push('')
  lines.push(`Goal: prove every v0.23.0 Trusted Runtime objective has passing evidence before publishing ${version}.`)
  lines.push('')
  lines.push(commandLine(['mkdir', '-p', join(outDir, 'host-go')]))
  lines.push('')
  lines.push('Copy or attach these passing receipt files into the aggregate directory:')
  for (const receipt of REQUIRED_RECEIPTS) {
    lines.push(`- ${receipt.file} (${receipt.receipt_type}, issue #${receipt.issue}, objective ${receipt.objective})`)
  }
  lines.push('')
  lines.push('Export GitHub issue state and checks:')
  lines.push(commandLine([
    'gh',
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--json',
    'number,title,state,labels,url',
    '--limit',
    '300',
  ], ` > ${shellQuote(join(outDir, 'github-issues.json'))}`))
  lines.push(commandLine([
    'gh',
    'pr',
    'checks',
    '--repo',
    repo,
    '278',
    '--json',
    'name,state,link,bucket',
  ], ` > ${shellQuote(join(outDir, 'github-checks.json'))}`))
  lines.push('')
  lines.push('Export the live GitHub App definition after #151 is remediated (GET /app):')
  lines.push(commandLine([
    'curl',
    '-fsSL',
    '-H',
    'Authorization: Bearer <github-app-jwt>',
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
    'https://api.github.com/app',
  ], ` > ${shellQuote(join(outDir, 'github-app.json'))}`))
  lines.push('')
  lines.push('Check the aggregate evidence:')
  lines.push(commandLine([
    'node',
    'scripts/release-readiness-receipt.mjs',
    '--check',
    '--version',
    version,
    '--repo',
    repo,
    '--out-dir',
    outDir,
  ], ` > ${shellQuote(join(outDir, 'release-readiness-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/release-readiness-receipt.mjs',
    '--check',
    '--summary',
    '--version',
    version,
    '--repo',
    repo,
    '--out-dir',
    outDir,
  ]))
  return `${lines.join('\n')}\n`
}

function pushCheck(checks, ok, check, detail = {}) {
  checks.push({ ok: Boolean(ok), check, ...detail })
}

function scanSecretText(text, path) {
  const findings = []
  for (const [kind, re] of SECRET_VALUE_PATTERNS) {
    if (re.test(text)) findings.push({ path, kind })
  }
  return findings
}

function readJson(checks, path, label) {
  if (!existsSync(path)) {
    pushCheck(checks, false, 'file_present', { label, path })
    return null
  }
  pushCheck(checks, true, 'file_present', { label, path })
  const text = readFileSync(path, 'utf8')
  const secretFindings = scanSecretText(text, path)
  pushCheck(checks, secretFindings.length === 0, 'file_has_no_secret_material', { label, path, findings: secretFindings })
  try {
    const parsed = JSON.parse(text)
    pushCheck(checks, true, 'file_json_parseable', { label, path })
    return parsed
  } catch (err) {
    pushCheck(checks, false, 'file_json_parseable', { label, path, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function artifactMeta(path, parsed) {
  if (!existsSync(path)) return { path, exists: false }
  const text = readFileSync(path)
  return {
    path,
    exists: true,
    bytes: text.byteLength,
    sha256: createHash('sha256').update(text).digest('hex'),
    receipt_type: parsed?.receipt_type ?? null,
    status: parsed?.status ?? null,
  }
}

function issueEntries(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed?.issues)) return parsed.issues
  return []
}

function checkEntries(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed?.checks)) return parsed.checks
  if (Array.isArray(parsed?.statusCheckRollup)) return parsed.statusCheckRollup
  return []
}

function checkSucceeded(entry) {
  const conclusion = String(entry?.conclusion ?? '').toUpperCase()
  const state = String(entry?.state ?? entry?.status ?? '').toUpperCase()
  const bucket = String(entry?.bucket ?? '').toLowerCase()
  return conclusion === 'SUCCESS' || state === 'SUCCESS' || state === 'COMPLETED' && conclusion === 'SUCCESS' || bucket === 'pass'
}

function permissionLevel(value) {
  const normalized = String(value ?? 'none').toLowerCase()
  if (normalized === 'read' || normalized === 'write') return normalized
  return 'none'
}

function appPermissions(parsed) {
  if (parsed?.permissions && typeof parsed.permissions === 'object' && !Array.isArray(parsed.permissions)) {
    return parsed.permissions
  }
  return {}
}

export function checkBundle(opts = {}) {
  const version = normalizeTag(opts.version || DEFAULT_VERSION)
  const outDir = resolve(defaultOutDir({ ...opts, version }))
  const checks = []
  const artifacts = {}

  pushCheck(checks, existsSync(outDir), 'evidence_directory_present', { out_dir: outDir })

  for (const required of REQUIRED_RECEIPTS) {
    const path = join(outDir, required.file)
    const receipt = readJson(checks, path, required.file)
    artifacts[required.file] = artifactMeta(path, receipt)
    pushCheck(checks, receipt?.receipt_type === required.receipt_type, 'receipt_type_matches', {
      path,
      expected: required.receipt_type,
      actual: receipt?.receipt_type ?? null,
      objective: required.objective,
      issue: required.issue,
    })
    pushCheck(checks, receipt?.status === 'pass', 'receipt_status_pass', {
      path,
      actual: receipt?.status ?? null,
      objective: required.objective,
      issue: required.issue,
    })
  }

  const issuesPath = join(outDir, 'github-issues.json')
  const issuesJson = readJson(checks, issuesPath, 'github_issues')
  artifacts['github-issues.json'] = artifactMeta(issuesPath, issuesJson)
  const issues = issueEntries(issuesJson)
  for (const issueNumber of REQUIRED_ISSUES) {
    const issue = issues.find((entry) => Number(entry?.number) === issueNumber)
    pushCheck(checks, Boolean(issue), 'required_issue_exported', { issue: issueNumber })
    pushCheck(checks, String(issue?.state ?? '').toUpperCase() === 'CLOSED', 'required_issue_closed', {
      issue: issueNumber,
      actual: issue?.state ?? null,
    })
  }

  const checksPath = join(outDir, 'github-checks.json')
  const checksJson = readJson(checks, checksPath, 'github_checks')
  artifacts['github-checks.json'] = artifactMeta(checksPath, checksJson)
  const exportedChecks = checkEntries(checksJson)
  for (const requiredName of REQUIRED_CHECKS) {
    const matching = exportedChecks.filter((entry) => String(entry?.name ?? '') === requiredName)
    pushCheck(checks, matching.length > 0, 'required_ci_check_exported', { check_name: requiredName })
    pushCheck(checks, matching.some(checkSucceeded), 'required_ci_check_passed', {
      check_name: requiredName,
      observed: matching.map((entry) => ({
        name: entry?.name ?? null,
        conclusion: entry?.conclusion ?? null,
        state: entry?.state ?? entry?.status ?? null,
        bucket: entry?.bucket ?? null,
      })),
    })
  }

  const appPath = join(outDir, 'github-app.json')
  const appJson = readJson(checks, appPath, 'github_app')
  artifacts['github-app.json'] = artifactMeta(appPath, appJson)
  const permissions = appPermissions(appJson)
  for (const [permission, expected] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
    const actual = permissionLevel(permissions[permission])
    pushCheck(checks, actual === expected, 'github_app_permission_matches', {
      permission,
      expected,
      actual,
    })
  }
  const extras = Object.entries(permissions)
    .filter(([permission, value]) => !(permission in REQUIRED_APP_PERMISSIONS) && permissionLevel(value) !== 'none')
    .map(([permission, value]) => ({ permission, actual: permissionLevel(value) }))
  pushCheck(checks, permissionLevel(permissions.workflows) === 'none', 'github_app_workflows_disabled', {
    actual: permissionLevel(permissions.workflows),
  })
  pushCheck(checks, extras.length === 0, 'github_app_has_no_extra_permissions', { extras })

  const failed = checks.filter((check) => check.ok === false)
  const passed = checks.filter((check) => check.ok === true)
  return {
    receipt_type: CHECK_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : 'fail',
    checked_at: new Date().toISOString(),
    version,
    repo: opts.repo || DEFAULT_REPO,
    out_dir: outDir,
    summary: {
      passed: passed.length,
      failed: failed.length,
      total: checks.length,
      required_receipts: REQUIRED_RECEIPTS.length,
      required_issues: REQUIRED_ISSUES.length,
      required_ci_checks: REQUIRED_CHECKS.length,
      required_app_permissions: Object.keys(REQUIRED_APP_PERMISSIONS).length,
    },
    required: {
      receipts: REQUIRED_RECEIPTS,
      issues: REQUIRED_ISSUES,
      ci_checks: REQUIRED_CHECKS,
      app_permissions: REQUIRED_APP_PERMISSIONS,
    },
    artifacts,
    checks,
    next_steps: failed.length === 0
      ? ['publish v0.23.0 only after attaching this aggregate release-readiness receipt to the release tracker']
      : ['collect or fix the failing objective evidence, export fresh GitHub state, then rerun release-readiness-receipt --check'],
  }
}

export function formatSummary(receipt) {
  const lines = []
  lines.push(`${receipt.receipt_type}: ${receipt.status}`)
  lines.push(`checks: ${receipt.summary.passed}/${receipt.summary.total} passed`)
  lines.push(`version: ${receipt.version}`)
  if (receipt.status !== 'pass') {
    for (const check of receipt.checks.filter((entry) => entry.ok === false).slice(0, 14)) {
      lines.push(`FAIL ${check.check}${check.path ? ` ${basename(check.path)}` : ''}${check.issue ? ` #${check.issue}` : ''}${check.check_name ? ` ${check.check_name}` : ''}`)
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
    console.error(`release-readiness-receipt: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
