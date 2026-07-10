#!/usr/bin/env node
// Mupot release-candidate deployment evidence checker.
//
// The production soak needs a falsifiable start point: this validates that a
// tagged prerelease and the live health response identify the same build.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECK_RECEIPT_TYPE = 'mupot-release-candidate/v1'
export const DEPLOYMENT_RECEIPT_TYPE = 'mupot-release-candidate-deployment/v1'

const DEFAULT_VERSION = 'v0.23.0-rc.1'
const DEFAULT_REPO = 'Mumega-com/mupot'
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /\bmupot_[A-Za-z0-9._-]{12,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

export function normalizeVersion(version) {
  const semver = String(version || '').trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(semver)) throw new Error(`expected a release candidate like v0.23.0-rc.1, got ${version}`)
  return { semver, tag: `v${semver}` }
}

export function parseArgs(argv) {
  const opts = { version: DEFAULT_VERSION, repo: DEFAULT_REPO, repoRoot: process.cwd(), outDir: '', deploymentJson: '', releaseJson: '', plan: false, check: false, summary: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--version') opts.version = next()
    else if (arg === '--repo') opts.repo = next()
    else if (arg === '--repo-root') opts.repoRoot = resolve(next())
    else if (arg === '--out-dir') opts.outDir = resolve(next())
    else if (arg === '--deployment-json') opts.deploymentJson = resolve(next())
    else if (arg === '--release-json') opts.releaseJson = resolve(next())
    else if (arg === '--plan') opts.plan = true
    else if (arg === '--check') opts.check = true
    else if (arg === '--summary') opts.summary = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function defaultOutDir(opts) {
  return opts.outDir || `tmp/release-candidate/${normalizeVersion(opts.version || DEFAULT_VERSION).tag}`
}

function command(parts, suffix = '') {
  const quote = (value) => /^[A-Za-z0-9_./:=@%+~,#-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
  return `${parts.map((part) => quote(String(part))).join(' ')}${suffix}`
}

export function formatPlan(opts = {}) {
  const { semver, tag } = normalizeVersion(opts.version || DEFAULT_VERSION)
  const outDir = defaultOutDir({ ...opts, version: tag })
  const repo = opts.repo || DEFAULT_REPO
  return [
    'Mupot release-candidate deployment evidence plan',
    '',
    `Goal: prove ${tag} is tagged, published as a GitHub prerelease, and deployed with the same public API version.`,
    '',
    command(['mkdir', '-p', outDir]),
    '',
    'Capture a redacted live deployment observation:',
    command(['curl', '-fsS', '<base-url>/health'], ` > ${outDir}/health.json`),
    'Write deployment.json with receipt_type "mupot-release-candidate-deployment/v1", observed_at, target { base_url, rc_version, commit, tag }, and health from the public response.',
    command(['gh', 'release', 'view', tag, '--repo', repo, '--json', 'tagName,name,isDraft,isPrerelease,targetCommitish,url,publishedAt'], ` > ${outDir}/github-release.json`),
    '',
    command(['node', 'scripts/release-candidate-receipt.mjs', '--check', '--version', tag, '--repo', repo, '--out-dir', outDir], ` > ${outDir}/release-candidate-check.json`),
    '',
    `The checked candidate version is ${semver}; use its observed_at as the authoritative lower bound for the production soak.`,
    '',
  ].join('\n')
}

function push(checks, ok, check, detail = {}) {
  checks.push({ ok: Boolean(ok), check, ...detail })
}

function readJson(checks, path, label) {
  const exists = existsSync(path)
  push(checks, exists, 'artifact_present', { label, path })
  if (!exists) return null
  const text = readFileSync(path, 'utf8')
  const secret = SECRET_PATTERNS.find((pattern) => pattern.test(text))
  push(checks, !secret, 'artifact_has_no_secret_material', { label, path })
  try {
    const value = JSON.parse(text)
    push(checks, true, 'artifact_json_parseable', { label, path })
    return { value, sha256: createHash('sha256').update(text).digest('hex') }
  } catch (error) {
    push(checks, false, 'artifact_json_parseable', { label, path, reason: String(error?.message ?? error) })
    return null
  }
}

function git(args, root) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}

function publicApiVersion(text) {
  return text.match(/MUPOT_PUBLIC_API_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? ''
}

export function checkBundle(opts = {}) {
  const { semver, tag } = normalizeVersion(opts.version || DEFAULT_VERSION)
  const root = resolve(opts.repoRoot || process.cwd())
  const outDir = resolve(defaultOutDir({ ...opts, version: tag }))
  const checks = []
  const packageJson = readJson(checks, join(root, 'package.json'), 'package')
  const versionPath = join(root, 'src/version.ts')
  const versionText = existsSync(versionPath) ? readFileSync(versionPath, 'utf8') : ''
  push(checks, Boolean(versionText), 'public_api_version_source_present', { path: versionPath })
  const deployment = readJson(checks, opts.deploymentJson || join(outDir, 'deployment.json'), 'deployment')
  const release = readJson(checks, opts.releaseJson || join(outDir, 'github-release.json'), 'github_release')
  const head = git(['rev-parse', 'HEAD'], root)
  const tagCommit = git(['rev-list', '-n', '1', tag], root)
  const observedAt = deployment?.value?.observed_at ?? ''
  const target = deployment?.value?.target ?? {}
  const health = deployment?.value?.health ?? {}
  const githubRelease = release?.value ?? {}

  push(checks, packageJson?.value?.version === semver, 'package_version_matches_expected', { expected: semver, actual: packageJson?.value?.version ?? null })
  push(checks, publicApiVersion(versionText) === semver, 'public_api_version_matches_expected', { expected: semver, actual: publicApiVersion(versionText) || null })
  push(checks, Boolean(head), 'git_head_resolved', { commit: head || null })
  push(checks, tagCommit === head && Boolean(tagCommit), 'git_tag_points_to_candidate_commit', { tag, tag_commit: tagCommit || null, head_commit: head || null })
  push(checks, deployment?.value?.receipt_type === DEPLOYMENT_RECEIPT_TYPE, 'deployment_receipt_type', { expected: DEPLOYMENT_RECEIPT_TYPE, actual: deployment?.value?.receipt_type ?? null })
  push(checks, Number.isFinite(Date.parse(observedAt)), 'deployment_observed_at_iso', { observed_at: observedAt || null })
  push(checks, target.rc_version === tag && target.tag === tag, 'deployment_target_version_matches', { expected: tag, actual_version: target.rc_version ?? null, actual_tag: target.tag ?? null })
  push(checks, target.commit === head && Boolean(target.commit), 'deployment_target_commit_matches', { expected: head || null, actual: target.commit ?? null })
  push(checks, /^https:\/\/[^\s]+$/.test(String(target.base_url ?? '')), 'deployment_base_url_valid', { base_url: target.base_url ?? null })
  push(checks, health.ok === true && health.service === 'mupot', 'deployment_health_ok', { ok: health.ok ?? null, service: health.service ?? null })
  push(checks, health.version === semver, 'deployment_health_version_matches', { expected: semver, actual: health.version ?? null })
  push(checks, githubRelease.tagName === tag, 'github_prerelease_tag_matches', { expected: tag, actual: githubRelease.tagName ?? null })
  push(checks, githubRelease.isPrerelease === true && githubRelease.isDraft === false, 'github_release_is_published_prerelease', { is_prerelease: githubRelease.isPrerelease ?? null, is_draft: githubRelease.isDraft ?? null })

  const failed = checks.filter((check) => !check.ok)
  return {
    receipt_type: CHECK_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : 'fail',
    checked_at: new Date().toISOString(),
    target: { repo: opts.repo || DEFAULT_REPO, rc_version: tag, commit: head || null, base_url: target.base_url ?? null },
    artifacts: {
      package: packageJson ? { path: join(root, 'package.json'), sha256: packageJson.sha256 } : null,
      deployment: deployment ? { path: opts.deploymentJson || join(outDir, 'deployment.json'), sha256: deployment.sha256 } : null,
      github_release: release ? { path: opts.releaseJson || join(outDir, 'github-release.json'), sha256: release.sha256 } : null,
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
    console.log('Usage: node scripts/release-candidate-receipt.mjs --plan|--check [options]')
    return
  }
  if (opts.plan) process.stdout.write(formatPlan(opts))
  else {
    const receipt = checkBundle(opts)
    process.stdout.write(opts.summary ? formatSummary(receipt) : `${JSON.stringify(receipt, null, 2)}\n`)
    if (receipt.status !== 'pass') process.exitCode = 1
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main()
