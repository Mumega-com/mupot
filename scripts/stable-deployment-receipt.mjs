#!/usr/bin/env node
// Redacted verifier for the final stable Mupot deployment.
// Local source, immutable release identity, deployment target, and live health
// must all identify the same final build.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECK_RECEIPT_TYPE = 'mupot-stable-deployment/v1'
const DEFAULT_VERSION = 'v0.23.0'
const DEFAULT_REPO = 'Mumega-com/mupot'
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /\bmupot_[A-Za-z0-9._-]{12,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
]

export function normalizeVersion(version) {
  const semver = String(version || '').trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+$/.test(semver)) {
    throw new Error(`expected a final semver release like v0.23.0, got ${version}`)
  }
  return { semver, tag: `v${semver}` }
}

export function parseArgs(argv) {
  const opts = {
    version: DEFAULT_VERSION,
    releaseSha: '',
    repo: DEFAULT_REPO,
    repoRoot: process.cwd(),
    outDir: '',
    deploymentJson: '',
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

    if (arg === '--version') opts.version = next()
    else if (arg === '--release-sha') opts.releaseSha = next()
    else if (arg === '--repo') opts.repo = next()
    else if (arg === '--repo-root') opts.repoRoot = resolve(next())
    else if (arg === '--out-dir') opts.outDir = resolve(next())
    else if (arg === '--deployment-json') opts.deploymentJson = resolve(next())
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
    'Usage: node scripts/stable-deployment-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                  print the stable deployment evidence plan',
    '  --check                 verify stable deployment evidence',
    '  --summary               with --check, print a compact text summary',
    '  --version <version>     expected final version; default v0.23.0',
    '  --release-sha <sha>     expected 40-character release commit SHA',
    '  --repo <owner/name>     repository identity',
    '  --repo-root <path>      local repository root',
    '  --out-dir <path>        evidence directory',
    '  --deployment-json <path> deployment evidence override',
    '  -h, --help              show this help',
  ].join('\n')
}

function defaultOutDir(opts) {
  return opts.outDir || `tmp/stable-deployment/${normalizeVersion(opts.version || DEFAULT_VERSION).tag}`
}

function shellQuote(value) {
  const raw = String(value)
  if (/^[A-Za-z0-9_./:=@%+~,#<>-]+$/.test(raw)) return raw
  return `'${raw.replace(/'/g, `'\''`)}'`
}

function command(parts, suffix = '') {
  return `${parts.map(shellQuote).join(' ')}${suffix}`
}

export function formatPlan(opts = {}) {
  const { semver, tag } = normalizeVersion(opts.version || DEFAULT_VERSION)
  const outDir = defaultOutDir({ ...opts, version: tag })
  const releaseSha = opts.releaseSha || '<40-char-release-sha>'
  const repo = opts.repo || DEFAULT_REPO
  const checkCommand = [
    'node',
    'scripts/stable-deployment-receipt.mjs',
    '--check',
    '--version',
    tag,
    '--release-sha',
    releaseSha,
    '--repo',
    repo,
    '--out-dir',
    outDir,
  ]

  return [
    'Mupot stable deployment evidence plan',
    '',
    `Goal: prove final release ${tag} at ${releaseSha} is the build serving the live public API.`,
    '',
    'Keep tokens, cookies, private keys, and provider credentials out of receipts.',
    command(['mkdir', '-p', outDir]),
    '',
    'Capture a redacted live deployment observation:',
    command(['curl', '-fsS', '<base-url>/health'], ` > ${outDir}/health.json`),
    `Write deployment.json with receipt_type "${CHECK_RECEIPT_TYPE}", observed_at, target { base_url, version: "${tag}", tag: "${tag}", commit: "${releaseSha}" }, and health from the public response ({ version: "${semver}", commit: "${releaseSha}" }).`,
    '',
    command(checkCommand, ` > ${join(outDir, 'stable-deployment-check.json')}`),
    command([...checkCommand, '--summary']),
    '',
  ].join('\n')
}

function git(args, root) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function push(checks, ok, check, detail = {}) {
  checks.push({ ok: Boolean(ok), check, ...detail })
}

function publicApiVersion(text) {
  return text.match(/MUPOT_PUBLIC_API_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? ''
}

function hasSecretMaterial(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

export function checkBundle(opts = {}) {
  const { semver, tag } = normalizeVersion(opts.version || DEFAULT_VERSION)
  const root = resolve(opts.repoRoot || process.cwd())
  const outDir = resolve(defaultOutDir({ ...opts, version: tag }))
  const head = git(['rev-parse', 'HEAD'], root)
  const packagePath = join(root, 'package.json')
  const versionPath = join(root, 'src', 'version.ts')
  const deploymentPath = opts.deploymentJson || join(outDir, 'deployment.json')
  const checks = []
  const releaseSha = String(opts.releaseSha || '').trim().toLowerCase()
  let packageVersion = ''
  let deployment = null
  let packageText = ''
  let deploymentText = ''

  try {
    packageText = readFileSync(packagePath, 'utf8')
    packageVersion = JSON.parse(packageText).version || ''
  } catch {}
  try {
    deploymentText = readFileSync(deploymentPath, 'utf8')
    deployment = JSON.parse(deploymentText)
  } catch {}
  const versionText = existsSync(versionPath) ? readFileSync(versionPath, 'utf8') : ''
  const apiVersion = publicApiVersion(versionText)
  const target = deployment?.target ?? {}
  const health = deployment?.health ?? {}

  push(checks, packageVersion === semver, 'package_version_matches_expected', { expected: semver, actual: packageVersion || null })
  push(checks, apiVersion === semver, 'public_api_version_matches_expected', { expected: semver, actual: apiVersion || null })
  push(checks, Boolean(packageText) && !hasSecretMaterial(packageText), 'artifact_has_no_secret_material', { label: 'package', path: packagePath })
  push(checks, /^[0-9a-f]{40}$/.test(releaseSha), 'expected_release_sha_is_40_hex', { release_sha: releaseSha || null })
  push(checks, Boolean(head), 'git_head_resolved', { head_commit: head || null })
  push(checks, Boolean(releaseSha) && releaseSha === head, 'expected_release_sha_matches_local_head', { expected: releaseSha || null, actual: head || null })
  push(checks, Boolean(deployment), 'deployment_json_parseable', { path: deploymentPath })
  push(checks, Boolean(deploymentText) && !hasSecretMaterial(deploymentText), 'artifact_has_no_secret_material', { label: 'deployment', path: deploymentPath })
  push(checks, deployment?.receipt_type === CHECK_RECEIPT_TYPE, 'deployment_receipt_type', { expected: CHECK_RECEIPT_TYPE, actual: deployment?.receipt_type ?? null })
  push(checks, Number.isFinite(Date.parse(deployment?.observed_at ?? '')), 'deployment_observed_at_iso', { observed_at: deployment?.observed_at ?? null })
  push(checks, target.version === tag && target.tag === tag, 'deployment_target_version_matches', { expected: tag, actual_version: target.version ?? null, actual_tag: target.tag ?? null })
  push(checks, target.commit === releaseSha && Boolean(target.commit), 'deployment_target_commit_matches_release_sha', { expected: releaseSha || null, actual: target.commit ?? null })
  push(checks, /^https:\/\/[^\s]+$/.test(String(target.base_url ?? '')), 'deployment_base_url_valid', { base_url: target.base_url ?? null })
  push(checks, health.ok === true && health.service === 'mupot', 'deployment_health_ok', { ok: health.ok ?? null, service: health.service ?? null })
  push(checks, health.version === semver, 'deployment_health_version_matches', { expected: semver, actual: health.version ?? null })
  push(checks, health.commit === releaseSha && Boolean(health.commit), 'deployment_health_commit_matches_release_sha', { expected: releaseSha || null, actual: health.commit ?? null })

  const failed = checks.filter((check) => !check.ok)

  return {
    receipt_type: CHECK_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : 'fail',
    checked_at: new Date().toISOString(),
    target: {
      repo: opts.repo || DEFAULT_REPO,
      version: tag,
      release_sha: releaseSha || null,
      head_commit: head || null,
      base_url: target.base_url ?? null,
    },
    artifacts: {
      package: existsSync(packagePath) ? { path: packagePath } : null,
      public_api_version: versionText ? { path: versionPath } : null,
      deployment: deployment ? { path: deploymentPath } : null,
    },
    summary: { passed: checks.length - failed.length, failed: failed.length, total: checks.length },
    checks,
  }
}

export function formatSummary(receipt) {
  return `${receipt.receipt_type}: ${receipt.status}\nchecks: ${receipt.summary.passed}/${receipt.summary.total} passed\n`
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || (!opts.plan && !opts.check)) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  if (opts.plan) {
    process.stdout.write(formatPlan(opts))
    return
  }

  const receipt = checkBundle(opts)
  process.stdout.write(opts.summary ? formatSummary(receipt) : `${JSON.stringify(receipt, null, 2)}\n`)
  if (receipt.status !== 'pass') process.exitCode = 1
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main()
