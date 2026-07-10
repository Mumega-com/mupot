#!/usr/bin/env node
// Mupot v0.23 GitHub App least-privilege evidence checker.
//
// This checker turns #151 into a falsifiable release receipt: after the live
// GitHub App definition is remediated and the installation is re-accepted, a
// redacted GET /app export must show only the permissions v0.23 needs.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECK_RECEIPT_TYPE = 'mupot-github-app-permissions/v1'

export const REQUIRED_APP_PERMISSIONS = {
  metadata: 'read',
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  organization_projects: 'read',
}

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
    app: '',
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
    else if (arg === '--app') opts.app = next()
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
    'Usage: node scripts/github-app-permissions-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan              print the GitHub App least-privilege evidence plan',
    '  --check             check a completed GitHub App evidence directory',
    '  --summary           with --check, print a compact text summary',
    '  --out-dir <path>    evidence directory',
    '  --app <slug>        expected GitHub App slug, for example mupot',
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

function defaultOutDir(opts) {
  return opts.outDir || `tmp/github-app-permissions/${opts.app || '<app-slug>'}`
}

export function formatPlan(opts = {}) {
  const app = opts.app || '<app-slug>'
  const outDir = defaultOutDir(opts)
  const lines = []

  lines.push('Mupot v0.23 GitHub App least-privilege evidence plan')
  lines.push('')
  lines.push('Goal: prove #151 is fixed by checking the live GitHub App definition after permissions are reduced and the installation is re-accepted.')
  lines.push('')
  lines.push('Required live App permissions:')
  for (const [permission, level] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
    lines.push(`- ${permission}: ${level}`)
  }
  lines.push('- workflows: none')
  lines.push('- every other repository or organization permission: none')
  lines.push('')
  lines.push(commandLine(['mkdir', '-p', outDir]))
  lines.push('')
  lines.push('Export the live GitHub App definition with GET /app and an App-authentication JWT, then remove unrelated non-permission metadata if desired:')
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
  lines.push('Check the evidence:')
  lines.push(commandLine([
    'node',
    'scripts/github-app-permissions-receipt.mjs',
    '--check',
    '--out-dir',
    outDir,
    '--app',
    app,
  ], ` > ${shellQuote(join(outDir, 'github-app-permissions-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/github-app-permissions-receipt.mjs',
    '--check',
    '--summary',
    '--out-dir',
    outDir,
    '--app',
    app,
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
    app_slug: parsed?.slug ?? null,
  }
}

function appPermissions(parsed) {
  if (parsed?.permissions && typeof parsed.permissions === 'object' && !Array.isArray(parsed.permissions)) {
    return parsed.permissions
  }
  return {}
}

function permissionLevel(value) {
  const normalized = String(value ?? 'none').toLowerCase()
  if (normalized === 'read' || normalized === 'write') return normalized
  return 'none'
}

export function checkBundle(opts = {}) {
  const outDir = resolve(defaultOutDir(opts))
  const checks = []
  const appPath = join(outDir, 'github-app.json')
  const appJson = readJson(checks, appPath, 'github_app')
  const permissions = appPermissions(appJson)
  const permissionEntries = Object.entries(permissions)

  pushCheck(checks, existsSync(outDir), 'evidence_directory_present', { out_dir: outDir })
  pushCheck(checks, permissionEntries.length > 0, 'github_app_permissions_exported', { count: permissionEntries.length })
  if (opts.app) {
    pushCheck(checks, appJson?.slug === opts.app, 'github_app_slug_matches', {
      expected: opts.app,
      actual: appJson?.slug ?? null,
    })
  }

  for (const [permission, expected] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
    const actual = permissionLevel(permissions[permission])
    pushCheck(checks, actual === expected, 'github_app_permission_matches', {
      permission,
      expected,
      actual,
    })
  }

  const extras = permissionEntries
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
    out_dir: outDir,
    app: {
      expected_slug: opts.app || null,
      slug: appJson?.slug ?? null,
      id: appJson?.id ?? null,
      html_url: appJson?.html_url ?? null,
    },
    summary: {
      passed: passed.length,
      failed: failed.length,
      total: checks.length,
      required_app_permissions: Object.keys(REQUIRED_APP_PERMISSIONS).length,
    },
    required: {
      app_permissions: REQUIRED_APP_PERMISSIONS,
      forbidden: ['workflows', 'members', 'organization_secrets', 'organization_personal_access_tokens', 'organization_self_hosted_runners', 'organization_custom_org_roles', 'actions', 'hooks', 'organization_plan'],
    },
    artifacts: {
      'github-app.json': artifactMeta(appPath, appJson),
    },
    checks,
    next_steps: failed.length === 0
      ? ['attach github-app-permissions-check.json and github-app.json to #151, then close #151']
      : ['fix the live GitHub App permissions, re-accept the installation, export GET /app again, then rerun this check'],
  }
}

export function formatSummary(receipt) {
  const lines = []
  lines.push(`${receipt.receipt_type}: ${receipt.status}`)
  lines.push(`checks: ${receipt.summary.passed}/${receipt.summary.total} passed`)
  if (receipt.app.slug) lines.push(`app: ${receipt.app.slug}`)
  if (receipt.status !== 'pass') {
    for (const check of receipt.checks.filter((entry) => entry.ok === false).slice(0, 12)) {
      lines.push(`FAIL ${check.check}${check.path ? ` ${basename(check.path)}` : ''}${check.permission ? ` ${check.permission}` : ''}`)
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
    console.error(`github-app-permissions-receipt: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
