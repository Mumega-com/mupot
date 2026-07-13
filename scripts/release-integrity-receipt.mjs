#!/usr/bin/env node
// Mupot v0.23 release-integrity evidence checker.
//
// This runs after the real release blockers pass. It keeps the final publish
// step falsifiable by checking local release metadata plus exported GitHub
// milestone/release JSON before the stable tag is treated as shippable.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECK_RECEIPT_TYPE = 'mupot-release-integrity/v1'

const DEFAULT_VERSION = 'v0.23.0'
const DEFAULT_REPO = 'Mumega-com/mupot'

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
    version: DEFAULT_VERSION,
    repo: DEFAULT_REPO,
    repoRoot: process.cwd(),
    outDir: '',
    milestoneJson: '',
    releaseJson: '',
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

    if (arg === '--version' || arg === '--expected-version') opts.version = next()
    else if (arg === '--repo') opts.repo = next()
    else if (arg === '--repo-root') opts.repoRoot = resolve(next())
    else if (arg === '--out-dir') opts.outDir = resolve(next())
    else if (arg === '--milestone-json') opts.milestoneJson = resolve(next())
    else if (arg === '--release-json') opts.releaseJson = resolve(next())
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
    'Usage: node scripts/release-integrity-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                    print the final release-integrity evidence plan',
    '  --check                   check local metadata plus GitHub evidence JSON',
    '  --summary                 with --check, print a compact text summary',
    '  --version <version>       expected final version; default v0.23.0',
    '  --repo <owner/repo>       GitHub repo; default Mumega-com/mupot',
    '  --repo-root <path>        local repo root; default cwd',
    '  --out-dir <path>          evidence directory',
    '  --milestone-json <path>   exported GitHub milestone JSON',
    '  --release-json <path>     exported GitHub release JSON',
    '  -h, --help                show this help',
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
  const { tag } = normalizeVersion(opts.version || DEFAULT_VERSION)
  return opts.outDir || `tmp/release-integrity/${tag}`
}

export function normalizeVersion(version) {
  const raw = String(version || '').trim()
  const semver = raw.replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+$/.test(semver)) {
    throw new Error(`expected a final semver release like v0.23.0, got ${version}`)
  }
  return { semver, tag: `v${semver}` }
}

export function formatPlan(opts = {}) {
  const repo = opts.repo || DEFAULT_REPO
  const { semver, tag } = normalizeVersion(opts.version || DEFAULT_VERSION)
  const outDir = defaultOutDir({ ...opts, version: tag })
  const milestonePath = join(outDir, 'github-milestone.json')
  const releasePath = join(outDir, 'github-release.json')
  const tagPath = join(outDir, 'github-tag.json')
  const lines = []

  lines.push('Mupot v0.23 release-integrity evidence plan')
  lines.push('')
  lines.push(`Goal: prove package version, public API version, changelog, roadmap, Git tag, milestone, and GitHub Release all agree on ${tag}.`)
  lines.push('')
  lines.push('Run only after the prepublication readiness receipt passes and the exact release commit is tagged and published.')
  lines.push('Remove release-control trackers #281, #284, and #345 from the product milestone, then close that milestone only after its product-objective issue count reaches zero.')
  lines.push('')
  lines.push(commandLine(['mkdir', '-p', outDir]))
  lines.push('')
  lines.push('Export GitHub evidence:')
  lines.push(commandLine([
    'gh',
    'api',
    `repos/${repo}/milestones`,
    '--jq',
    `map(select(.title | contains("${tag}") or contains("${semver}")))[0]`,
  ], ` > ${shellQuote(milestonePath)}`))
  lines.push(commandLine([
    'gh',
    'release',
    'view',
    tag,
    '--repo',
    repo,
    '--json',
    'tagName,name,isDraft,isPrerelease,url,targetCommitish,createdAt,publishedAt,body',
  ], ` > ${shellQuote(releasePath)}`))
  lines.push(commandLine([
    'gh',
    'api',
    `repos/${repo}/commits/${tag}`,
    '--jq',
    '{sha: .sha, html_url: .html_url}',
  ], ` > ${shellQuote(tagPath)}`))
  lines.push('')
  lines.push('Check the release metadata:')
  lines.push(commandLine([
    'node',
    'scripts/release-integrity-receipt.mjs',
    '--check',
    '--version',
    tag,
    '--repo',
    repo,
    '--out-dir',
    outDir,
  ], ` > ${shellQuote(join(outDir, 'release-integrity-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/release-integrity-receipt.mjs',
    '--check',
    '--summary',
    '--version',
    tag,
    '--repo',
    repo,
    '--out-dir',
    outDir,
  ]))
  return `${lines.join('\n')}\n`
}

function pushCheck(checks, ok, check, detail = {}) {
  checks.push({
    ok: Boolean(ok),
    check,
    ...detail,
  })
}

function readText(checks, path, label) {
  if (!existsSync(path)) {
    pushCheck(checks, false, 'file_present', { label, path })
    return null
  }
  pushCheck(checks, true, 'file_present', { label, path })
  return readFileSync(path, 'utf8')
}

function parseJsonFile(checks, path, label) {
  const text = readText(checks, path, label)
  if (text === null) return null
  for (const [kind, re] of SECRET_VALUE_PATTERNS) {
    if (re.test(text)) {
      pushCheck(checks, false, 'no_secret_material_in_evidence', { label, path, kind })
      return null
    }
  }
  pushCheck(checks, true, 'no_secret_material_in_evidence', { label, path })
  try {
    const parsed = JSON.parse(text)
    pushCheck(checks, true, 'json_parseable', { label, path })
    return parsed
  } catch (err) {
    pushCheck(checks, false, 'json_parseable', { label, path, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function artifactMeta(path, text) {
  if (text === null || text === undefined) return { path, exists: false }
  return {
    path,
    exists: true,
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  }
}

function repoPath(repoRoot, path) {
  return join(repoRoot, path)
}

function extractPublicApiVersion(versionSource) {
  const match = versionSource.match(/MUPOT_PUBLIC_API_VERSION\s*=\s*['"]([^'"]+)['"]/)
  return match ? match[1] : ''
}

function git(args, repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function chooseMilestone(parsed, tag, semver) {
  if (!parsed) return null
  if (Array.isArray(parsed)) {
    return parsed.find((entry) => {
      const title = String(entry?.title ?? '')
      return title.includes(tag) || title.includes(semver)
    }) ?? null
  }
  return parsed
}

function field(obj, snake, camel = snake) {
  if (!obj || typeof obj !== 'object') return undefined
  return obj[snake] ?? obj[camel]
}

export function checkBundle(opts = {}) {
  const { semver, tag } = normalizeVersion(opts.version || DEFAULT_VERSION)
  const repoRoot = resolve(opts.repoRoot || process.cwd())
  const outDir = defaultOutDir({ ...opts, version: tag })
  const milestonePath = opts.milestoneJson || join(outDir, 'github-milestone.json')
  const releasePath = opts.releaseJson || join(outDir, 'github-release.json')
  const githubTagPath = join(outDir, 'github-tag.json')
  const checks = []
  const artifacts = {}

  const packagePath = repoPath(repoRoot, 'package.json')
  const packageLockPath = repoPath(repoRoot, 'package-lock.json')
  const versionPath = repoPath(repoRoot, 'src/version.ts')
  const mcpPath = repoPath(repoRoot, 'src/mcp/index.ts')
  const changelogPath = repoPath(repoRoot, 'CHANGELOG.md')
  const roadmapPath = repoPath(repoRoot, 'ROADMAP.md')
  const releaseDocPath = repoPath(repoRoot, 'docs/releases/v0.23.0-trusted-runtime.md')

  const packageText = readText(checks, packagePath, 'package')
  const packageLockText = readText(checks, packageLockPath, 'package_lock')
  const versionSource = readText(checks, versionPath, 'public_api_version')
  const mcpSource = readText(checks, mcpPath, 'mcp_public_api_surface')
  const changelog = readText(checks, changelogPath, 'changelog')
  const roadmap = readText(checks, roadmapPath, 'roadmap')
  const releaseDoc = readText(checks, releaseDocPath, 'release_doc')

  artifacts.package = artifactMeta(packagePath, packageText)
  artifacts.package_lock = artifactMeta(packageLockPath, packageLockText)
  artifacts.public_api_version = artifactMeta(versionPath, versionSource)
  artifacts.mcp_public_api_surface = artifactMeta(mcpPath, mcpSource)
  artifacts.changelog = artifactMeta(changelogPath, changelog)
  artifacts.roadmap = artifactMeta(roadmapPath, roadmap)
  artifacts.release_doc = artifactMeta(releaseDocPath, releaseDoc)

  let packageVersion = ''
  if (packageText) {
    try {
      packageVersion = JSON.parse(packageText).version || ''
      pushCheck(checks, true, 'package_json_parseable', { path: packagePath })
    } catch (err) {
      pushCheck(checks, false, 'package_json_parseable', { path: packagePath, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  pushCheck(checks, packageVersion === semver, 'package_version_matches_expected', { expected: semver, actual: packageVersion || null })

  let packageLockVersion = ''
  let packageLockRootVersion = ''
  if (packageLockText) {
    try {
      const packageLock = JSON.parse(packageLockText)
      packageLockVersion = packageLock?.version || ''
      packageLockRootVersion = packageLock?.packages?.['']?.version || ''
      pushCheck(checks, true, 'package_lock_json_parseable', { path: packageLockPath })
    } catch (err) {
      pushCheck(checks, false, 'package_lock_json_parseable', {
        path: packageLockPath,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  pushCheck(checks, packageLockVersion === semver, 'package_lock_version_matches_expected', {
    expected: semver,
    actual: packageLockVersion || null,
  })
  pushCheck(checks, packageLockRootVersion === semver, 'package_lock_root_version_matches_expected', {
    expected: semver,
    actual: packageLockRootVersion || null,
  })

  const publicApiVersion = versionSource ? extractPublicApiVersion(versionSource) : ''
  pushCheck(checks, publicApiVersion === semver, 'public_api_version_matches_expected', { expected: semver, actual: publicApiVersion || null })
  pushCheck(checks, Boolean(mcpSource && mcpSource.includes('MUPOT_PUBLIC_API_VERSION')), 'mcp_surface_uses_public_api_version_constant', { path: mcpPath })

  pushCheck(checks, Boolean(changelog && changelog.includes(`## [${semver}]`)), 'changelog_has_final_version_entry', { expected: `## [${semver}]` })
  pushCheck(checks, Boolean(roadmap && roadmap.includes(`## ${tag} `)), 'roadmap_has_final_version_section', { expected: `## ${tag}` })
  pushCheck(checks, Boolean(releaseDoc && releaseDoc.includes(`Mupot ${tag}`)), 'release_doc_names_final_version', { expected: tag })
  pushCheck(checks, Boolean(releaseDoc && releaseDoc.includes('Release integrity')), 'release_doc_keeps_release_integrity_gate', { path: releaseDocPath })

  const tagSha = git(['rev-list', '-n', '1', tag], repoRoot)
  const headSha = git(['rev-parse', 'HEAD'], repoRoot)
  pushCheck(checks, Boolean(tagSha), 'git_tag_exists', { tag })
  pushCheck(checks, Boolean(tagSha && headSha && tagSha === headSha), 'git_tag_points_to_head', { tag, tag_sha: tagSha || null, head_sha: headSha || null })

  // targetCommitish describes how GitHub would create a missing tag and may be
  // a moving branch name. Resolve the published tag through GitHub instead.
  const githubTag = parseJsonFile(checks, githubTagPath, 'github_tag')
  artifacts.github_tag = artifactMeta(githubTagPath, githubTag ? JSON.stringify(githubTag) : null)
  const githubTagSha = String(field(githubTag, 'sha') ?? '')
  pushCheck(checks, /^[0-9a-f]{40}$/i.test(githubTagSha), 'github_tag_commit_sha_present', {
    path: githubTagPath,
    actual: githubTagSha || null,
  })
  pushCheck(checks, Boolean(tagSha && githubTagSha && githubTagSha === tagSha), 'github_tag_commit_matches_local_tag', {
    expected: tagSha || null,
    actual: githubTagSha || null,
  })

  const milestoneJson = parseJsonFile(checks, milestonePath, 'github_milestone')
  artifacts.github_milestone = artifactMeta(milestonePath, milestoneJson ? JSON.stringify(milestoneJson) : null)
  const milestone = chooseMilestone(milestoneJson, tag, semver)
  const milestoneTitle = String(field(milestone, 'title') ?? '')
  const milestoneState = String(field(milestone, 'state') ?? '')
  const milestoneOpenIssues = Number(field(milestone, 'open_issues', 'openIssues') ?? NaN)
  pushCheck(checks, Boolean(milestone), 'github_milestone_present_for_version', { path: milestonePath })
  pushCheck(checks, milestoneTitle.includes(tag) || milestoneTitle.includes(semver), 'github_milestone_title_matches_version', { expected: tag, actual: milestoneTitle || null })
  pushCheck(checks, milestoneState === 'closed', 'github_milestone_closed', { actual: milestoneState || null })
  pushCheck(checks, milestoneOpenIssues === 0, 'github_milestone_has_no_open_issues', { actual: Number.isFinite(milestoneOpenIssues) ? milestoneOpenIssues : null })

  const release = parseJsonFile(checks, releasePath, 'github_release')
  artifacts.github_release = artifactMeta(releasePath, release ? JSON.stringify(release) : null)
  const releaseTag = String(field(release, 'tag_name', 'tagName') ?? '')
  const releaseName = String(field(release, 'name') ?? '')
  const releaseDraft = Boolean(field(release, 'draft', 'isDraft'))
  const releasePrerelease = Boolean(field(release, 'prerelease', 'isPrerelease'))
  const releaseTarget = String(field(release, 'target_commitish', 'targetCommitish') ?? '')
  const releasePublishedAt = String(field(release, 'published_at', 'publishedAt') ?? '')
  pushCheck(checks, Boolean(release), 'github_release_present_for_version', { path: releasePath })
  pushCheck(checks, releaseTag === tag, 'github_release_tag_matches_expected', { expected: tag, actual: releaseTag || null })
  pushCheck(checks, releaseName.includes(tag) || releaseName.includes(semver), 'github_release_name_matches_version', { expected: tag, actual: releaseName || null })
  pushCheck(checks, releaseDraft === false, 'github_release_is_not_draft', { actual: releaseDraft })
  pushCheck(checks, releasePrerelease === false, 'github_release_is_not_prerelease', { actual: releasePrerelease })
  pushCheck(checks, Boolean(tagSha && releaseTarget === tagSha), 'github_release_target_matches_tag_commit', {
    expected: tagSha || null,
    actual: releaseTarget || null,
  })
  pushCheck(checks, Boolean(releasePublishedAt && !Number.isNaN(Date.parse(releasePublishedAt))), 'github_release_published_at_present', {
    actual: releasePublishedAt || null,
  })

  const failed = checks.filter((check) => check.ok === false)
  const passed = checks.filter((check) => check.ok === true)
  return {
    receipt_type: CHECK_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : 'fail',
    checked_at: new Date().toISOString(),
    repo: opts.repo || DEFAULT_REPO,
    repo_root: repoRoot,
    out_dir: outDir,
    target: {
      version: semver,
      tag,
      package_version: packageVersion || null,
      package_lock_version: packageLockVersion || null,
      package_lock_root_version: packageLockRootVersion || null,
      public_api_version: publicApiVersion || null,
      git_tag_sha: tagSha || null,
      github_tag_sha: githubTagSha || null,
      git_head_sha: headSha || null,
      milestone_title: milestoneTitle || null,
      release_tag: releaseTag || null,
    },
    summary: {
      passed: passed.length,
      failed: failed.length,
      total: checks.length,
    },
    artifacts,
    checks,
    next_steps: failed.length === 0
      ? ['attach release-integrity-check.json to #281, close #281, then run final release readiness']
      : milestoneState !== 'closed' || milestoneOpenIssues !== 0
        ? ['remove release-control trackers #281, #284, and #345 from the product milestone, close the zero-open product milestone, then rerun']
        : ['align failing release metadata, export fresh GitHub milestone/release JSON, then rerun release-integrity-receipt --check'],
  }
}

export function formatSummary(receipt) {
  const lines = []
  lines.push(`${receipt.receipt_type}: ${receipt.status}`)
  lines.push(`checks: ${receipt.summary.passed}/${receipt.summary.total} passed`)
  lines.push(`version: ${receipt.target.tag}`)
  lines.push(`package: ${receipt.target.package_version ?? 'missing'}`)
  lines.push(`public API: ${receipt.target.public_api_version ?? 'missing'}`)
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
    console.error(`release-integrity-receipt: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
