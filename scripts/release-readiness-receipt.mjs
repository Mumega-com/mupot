#!/usr/bin/env node
// Mupot aggregate release-readiness checker.
//
// This is the final completion-audit receipt. It does not create evidence; it
// verifies that every objective-specific receipt and exported GitHub state is
// present before a release is treated as shippable.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBundleManifest } from '../fleet-runtime/receipt-bundle.mjs'
import {
  APP_FILE,
  CHECK_RECEIPT_TYPE as GITHUB_APP_PERMISSIONS_RECEIPT_TYPE,
  INSTALLATION_FILE,
  REQUIRED_APP_PERMISSIONS,
  inspectPermissionSet,
} from './github-app-permissions-receipt.mjs'

export { REQUIRED_APP_PERMISSIONS } from './github-app-permissions-receipt.mjs'

export const CHECK_RECEIPT_TYPE = 'mupot-v023-release-readiness/v1'
export const PREPUBLICATION_CHECK_RECEIPT_TYPE = 'mupot-v023-prepublication-readiness/v1'

const DEFAULT_VERSION = `v${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`
const DEFAULT_REPO = 'Mumega-com/mupot'
const LEGACY_VERSION = 'v0.23.0'
const RELEASE_PHASES = new Set(['prepublication', 'final'])

export const REQUIRED_RECEIPTS = [
  { objective: 1, issue: 282, file: 'fresh-install-check.json', receipt_type: 'mupot-fresh-install/v1' },
  { objective: 2, issue: 274, file: 'host-go/manifest.json', receipt_type: 'mupot-fleet-receipt-bundle/v1' },
  { objective: 2, issue: 274, file: 'host-go/cutover-gate.json', receipt_type: 'mupot-sos-cutover-gate/v1' },
  { objective: 2, issue: 274, file: 'host-go/export-receipt.json', receipt_type: 'mupot-fleet-receipt-bundle-export/v1' },
  { objective: 2, issue: 274, file: 'host-go/manifest-check.json', receipt_type: 'mupot-fleet-receipt-bundle-check/v1' },
  { objective: 3, issue: 151, file: 'github-app-permissions-check.json', receipt_type: GITHUB_APP_PERMISSIONS_RECEIPT_TYPE },
  { objective: 4, issue: 283, file: 'work-lifecycle-check.json', receipt_type: 'mupot-work-lifecycle/v1' },
  { objective: 5, issue: 150, file: 'external-pr-cycle-check.json', receipt_type: 'mupot-external-pr-cycle/v1' },
  { objective: 7, issue: 279, file: 'staging-recovery-check.json', receipt_type: 'mupot-staging-recovery-rehearsal/v1' },
  { objective: 10, issue: 323, file: 'release-candidate-check.json', receipt_type: 'mupot-release-candidate/v1' },
  { objective: 9, issue: 281, file: 'release-integrity-check.json', receipt_type: 'mupot-release-integrity/v1' },
]

export const PREPUBLICATION_REQUIRED_RECEIPTS = [
  ...REQUIRED_RECEIPTS.filter((receipt) => receipt.issue !== 281),
  { objective: 11, issue: 345, file: 'stable-deployment-check.json', receipt_type: 'mupot-stable-deployment/v1' },
]

// #319 closes the live board/task-mirror/PR repository divergence found while
// collecting #150 evidence. Keep it in the final release audit so that proof
// cannot be treated as complete if its fail-closed guard is reopened.
export const REQUIRED_ISSUES = [150, 151, 274, 277, 279, 281, 282, 283, 319, 323]
export const PREPUBLICATION_REQUIRED_ISSUES = REQUIRED_ISSUES.filter((issue) => issue !== 281)

export const REQUIRED_PR_CHECKS = [
  'build',
  'plugin',
  'no-secrets',
  'design-status-policy',
  'local-evidence',
  'CodeQL',
  'Analyze (actions)',
  'Analyze (javascript-typescript)',
  'Analyze (python)',
]

// GitHub's default CodeQL setup emits the aggregate `CodeQL` check only for
// pull requests. Pushes still run the three named analyses, so exact-commit
// evidence requires those real push checks without inventing an aggregate.
export const REQUIRED_COMMIT_CHECKS = REQUIRED_PR_CHECKS.filter((name) => name !== 'CodeQL')

// Backward-compatible name for callers and receipts that mean PR/CI checks.
export const REQUIRED_CHECKS = REQUIRED_PR_CHECKS

const GITHUB_PR_FILE = 'github-pr.json'

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
    checksPr: '',
    releaseSha: '',
    phase: 'final',
    contractPath: '',
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
    else if (arg === '--checks-pr') opts.checksPr = next()
    else if (arg === '--release-sha') opts.releaseSha = next()
    else if (arg === '--phase') opts.phase = normalizePhase(next())
    else if (arg === '--contract') opts.contractPath = next()
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
    '  --version <version> expected version; default current package version',
    '  --contract <path>    versioned release contract JSON; required outside legacy v0.23.0',
    '  --repo <owner/repo> GitHub repo; default Mumega-com/mupot',
    '  --checks-pr <number> PR number whose required checks prove this release candidate',
    '  --release-sha <sha>  exact merged release commit whose checks must pass',
    '  --phase <phase>       prepublication or final; default final',
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

function normalizePhase(phase) {
  const value = String(phase || 'final').trim().toLowerCase()
  if (value !== 'prepublication' && value !== 'final') {
    throw new Error(`expected phase prepublication or final, got ${phase}`)
  }
  return value
}

function legacyContract(version) {
  const receipts = new Map()
  const addReceipt = (receipt, phase) => {
    const prior = receipts.get(receipt.file) ?? { ...receipt, phases: [] }
    if (!prior.phases.includes(phase)) prior.phases.push(phase)
    receipts.set(receipt.file, prior)
  }
  for (const receipt of REQUIRED_RECEIPTS) addReceipt(receipt, 'final')
  for (const receipt of PREPUBLICATION_REQUIRED_RECEIPTS) addReceipt(receipt, 'prepublication')

  const issues = new Map()
  const addIssue = (number, phase) => {
    const prior = issues.get(number) ?? { number, phases: [] }
    if (!prior.phases.includes(phase)) prior.phases.push(phase)
    issues.set(number, prior)
  }
  for (const number of REQUIRED_ISSUES) addIssue(number, 'final')
  for (const number of PREPUBLICATION_REQUIRED_ISSUES) addIssue(number, 'prepublication')

  return {
    schema_version: 0,
    version,
    name: 'Trusted Runtime legacy contract',
    receipt_types: {
      prepublication: PREPUBLICATION_CHECK_RECEIPT_TYPE,
      final: CHECK_RECEIPT_TYPE,
    },
    receipts: [...receipts.values()],
    issues: [...issues.values()],
    source: 'legacy-v0.23.0',
    source_path: null,
  }
}

function rejectUnknownContractFields(value, allowed, source, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`invalid release contract ${source}: ${label} unknown field ${key}`)
  }
}

function validateContract(raw, expectedVersion, source = 'inline') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid release contract ${source}: expected object`)
  }
  rejectUnknownContractFields(
    raw,
    new Set(['schema_version', 'version', 'name', 'receipt_types', 'receipts', 'issues']),
    source,
    'contract',
  )
  if (raw.schema_version !== 1) {
    throw new Error(`invalid release contract ${source}: schema_version must be 1`)
  }
  const version = normalizeTag(raw.version)
  if (version !== expectedVersion) {
    throw new Error(`invalid release contract ${source}: version ${version} does not match ${expectedVersion}`)
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    throw new Error(`invalid release contract ${source}: name required`)
  }
  const receiptTypes = raw.receipt_types
  if (!receiptTypes || typeof receiptTypes !== 'object' || Array.isArray(receiptTypes)) {
    throw new Error(`invalid release contract ${source}: receipt_types must be an object`)
  }
  rejectUnknownContractFields(receiptTypes, RELEASE_PHASES, source, 'receipt_types')
  for (const phase of RELEASE_PHASES) {
    if (typeof receiptTypes?.[phase] !== 'string' || !/^[a-z0-9-]+\/v\d+$/.test(receiptTypes[phase])) {
      throw new Error(`invalid release contract ${source}: receipt_types.${phase} invalid`)
    }
  }
  if (!Array.isArray(raw.receipts) || raw.receipts.length === 0) {
    throw new Error(`invalid release contract ${source}: receipts required`)
  }
  const seenFiles = new Set()
  const receipts = raw.receipts.map((receipt, index) => {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw new Error(`invalid release contract ${source}: receipts[${index}] must be an object`)
    }
    rejectUnknownContractFields(
      receipt,
      new Set(['objective', 'file', 'receipt_type', 'phases', 'issue']),
      source,
      `receipts[${index}]`,
    )
    const file = String(receipt.file ?? '')
    if (!file || file.startsWith('/') || file.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/.test(file)) {
      throw new Error(`invalid release contract ${source}: receipts[${index}].file invalid`)
    }
    if (seenFiles.has(file)) throw new Error(`invalid release contract ${source}: duplicate receipt file ${file}`)
    seenFiles.add(file)
    const objective = receipt.objective
    if (!((Number.isInteger(objective) && objective > 0)
      || (typeof objective === 'string' && objective.trim().length > 0))) {
      throw new Error(`invalid release contract ${source}: receipts[${index}].objective invalid`)
    }
    if (receipt.issue !== undefined && (!Number.isInteger(receipt.issue) || receipt.issue <= 0)) {
      throw new Error(`invalid release contract ${source}: receipts[${index}].issue invalid`)
    }
    const receiptType = String(receipt.receipt_type ?? '')
    if (!/^[A-Za-z0-9._-]+\/v\d+$/.test(receiptType)) {
      throw new Error(`invalid release contract ${source}: receipts[${index}].receipt_type invalid`)
    }
    if (!Array.isArray(receipt.phases) || receipt.phases.length === 0
      || receipt.phases.some((phase) => !RELEASE_PHASES.has(phase))) {
      throw new Error(`invalid release contract ${source}: receipts[${index}].phases invalid`)
    }
    return {
      objective,
      file,
      receipt_type: receiptType,
      phases: [...new Set(receipt.phases)],
      ...(Number.isInteger(receipt.issue) && receipt.issue > 0 ? { issue: receipt.issue } : {}),
    }
  })

  if (!Array.isArray(raw.issues)) throw new Error(`invalid release contract ${source}: issues must be an array`)
  const seenIssues = new Set()
  const issues = raw.issues.map((issue, index) => {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
      throw new Error(`invalid release contract ${source}: issues[${index}] must be an object`)
    }
    rejectUnknownContractFields(issue, new Set(['number', 'phases']), source, `issues[${index}]`)
    const number = Number(issue?.number)
    if (!Number.isInteger(number) || number <= 0 || seenIssues.has(number)) {
      throw new Error(`invalid release contract ${source}: issues[${index}].number invalid`)
    }
    seenIssues.add(number)
    if (!Array.isArray(issue.phases) || issue.phases.length === 0
      || issue.phases.some((phase) => !RELEASE_PHASES.has(phase))) {
      throw new Error(`invalid release contract ${source}: issues[${index}].phases invalid`)
    }
    return { number, phases: [...new Set(issue.phases)] }
  })

  return {
    schema_version: 1,
    version,
    name: raw.name.trim(),
    receipt_types: {
      prepublication: receiptTypes.prepublication,
      final: receiptTypes.final,
    },
    receipts,
    issues,
    source,
    source_path: null,
    source_sha256: source === 'inline'
      ? createHash('sha256').update(JSON.stringify(raw)).digest('hex')
      : null,
  }
}

function resolveContract(opts, version) {
  if (opts.contract !== undefined) return validateContract(opts.contract, version)
  const defaultArg = `docs/releases/${version}-contract.json`
  const defaultPath = resolve(process.cwd(), defaultArg)
  const pathArg = opts.contractPath || (existsSync(defaultPath) ? defaultArg : '')
  const path = pathArg ? resolve(pathArg) : ''
  if (path) {
    let parsed
    let text
    try {
      text = readFileSync(path, 'utf8')
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`invalid release contract ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return {
      ...validateContract(parsed, version, path),
      source: path,
      source_path: path,
      source_arg: pathArg,
      source_sha256: createHash('sha256').update(text).digest('hex'),
    }
  }
  if (version === LEGACY_VERSION) return legacyContract(version)
  throw new Error(`release contract required for ${version}; pass --contract docs/releases/${version}-contract.json`)
}

function contractPhase(contract, phase) {
  return {
    receiptType: contract.receipt_types[phase],
    receipts: contract.receipts.filter((receipt) => receipt.phases.includes(phase)),
    issues: contract.issues.filter((issue) => issue.phases.includes(phase)).map((issue) => issue.number),
  }
}

function defaultOutDir(opts) {
  const tag = normalizeTag(opts.version || DEFAULT_VERSION)
  return opts.outDir || `tmp/release-readiness/${tag}`
}

export function formatPlan(opts = {}) {
  const version = normalizeTag(opts.version || DEFAULT_VERSION)
  const contract = resolveContract(opts, version)
  const repo = opts.repo || DEFAULT_REPO
  const checksPr = opts.checksPr || '<release-pr-number>'
  const releaseSha = opts.releaseSha || '<release-commit-sha>'
  const phase = normalizePhase(opts.phase)
  const phaseContract = contractPhase(contract, phase)
  const requiredReceipts = phaseContract.receipts
  const requiredIssues = phaseContract.issues
  const outputFile = phase === 'prepublication' ? 'prepublication-readiness-check.json' : 'release-readiness-check.json'
  const outDir = defaultOutDir({ ...opts, version })
  const lines = []

  lines.push(phase === 'prepublication'
    ? `Mupot ${version} prepublication-readiness evidence plan`
    : `Mupot ${version} final release-readiness evidence plan`)
  lines.push('')
  lines.push(phase === 'prepublication'
    ? `Goal: prove the exact merged and deployed ${version} commit is safe to publish.`
    : `Goal: prove every ${version} ${contract.name} objective has passing postpublication evidence.`)
  lines.push('')
  lines.push(commandLine(['mkdir', '-p', join(outDir, 'host-go')]))
  lines.push('')
  lines.push(`Copy the complete exported host attachment directory into ${join(outDir, 'host-go')}; include every manifest artifact and both sidecars, not only the files listed below.`)
  lines.push('The final checker reruns the read-only fleet manifest verifier against that copied directory.')
  lines.push('')
  lines.push('Copy or attach these passing receipt files into the aggregate directory:')
  for (const receipt of requiredReceipts) {
    const issue = receipt.issue ? `, issue #${receipt.issue}` : ''
    lines.push(`- ${receipt.file} (${receipt.receipt_type}${issue}, objective ${receipt.objective})`)
  }
  lines.push('')
  lines.push('Export the release PR and checks from the exact merged release commit:')
  if (requiredIssues.length > 0) {
    lines.push('Export GitHub issue state required by this release contract:')
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
  }
  lines.push(commandLine([
    'gh',
    'pr',
    'view',
    checksPr,
    '--repo',
    repo,
    '--json',
    'number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,mergeCommit,statusCheckRollup',
  ], ` > ${shellQuote(join(outDir, GITHUB_PR_FILE))}`))
  lines.push(commandLine([
    'gh',
    'pr',
    'checks',
    '--repo',
    repo,
    checksPr,
    '--json',
    'name,state,link,bucket',
  ], ` > ${shellQuote(join(outDir, 'github-checks.json'))}`))
  lines.push(commandLine([
    'gh',
    'api',
    `repos/${repo}/commits/${releaseSha}`,
    '--jq',
    '{sha: .sha, html_url: .html_url}',
  ], ` > ${shellQuote(join(outDir, 'github-commit.json'))}`))
  lines.push(commandLine([
    'gh',
    'api',
    `repos/${repo}/commits/${releaseSha}/check-runs?per_page=100`,
  ], ` > ${shellQuote(join(outDir, 'github-commit-checks.json'))}`))
  lines.push('')
  lines.push('Export the live GitHub App definition and re-accepted installation after least-privilege remediation is verified with the authenticated GitHub CLI. The final release plan deliberately does not read, copy, print, or rotate the Worker-confined App private key:')
  lines.push(`The export command writes ${join(outDir, APP_FILE)} and ${join(outDir, INSTALLATION_FILE)}.`)
  lines.push(commandLine([
    'npm',
    'run',
    'receipt:github-app-permissions:plan',
    '--',
    '--app',
    'mupot',
    '--out-dir',
    outDir,
  ]))
  lines.push(commandLine([
    'node',
    'scripts/github-app-permissions-receipt.mjs',
    '--export-gh',
    '--out-dir',
    outDir,
    '--app',
    'mupot',
    '--organization',
    '<organization-login>',
    '--installation-id',
    '<github-app-installation-id>',
  ]))
  lines.push(commandLine([
    'node',
    'scripts/github-app-permissions-receipt.mjs',
    '--check',
    '--out-dir',
    outDir,
    '--app',
    'mupot',
    '--installation-id',
    '<github-app-installation-id>',
  ], ` > ${shellQuote(join(outDir, 'github-app-permissions-check.json'))}`))
  lines.push('')
  lines.push('Check the aggregate evidence:')
  const contractArgs = contract.source_arg ? ['--contract', contract.source_arg] : []
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
    '--checks-pr',
    checksPr,
    '--release-sha',
    releaseSha,
    '--phase',
    phase,
    ...contractArgs,
  ], ` > ${shellQuote(join(outDir, outputFile))}`))
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
    '--checks-pr',
    checksPr,
    '--release-sha',
    releaseSha,
    '--phase',
    phase,
    ...contractArgs,
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
  if (Array.isArray(parsed?.check_runs)) return parsed.check_runs
  if (Array.isArray(parsed?.statusCheckRollup)) return parsed.statusCheckRollup
  return []
}

function expectedPrNumber(checksPr) {
  const raw = String(checksPr ?? '').trim()
  if (!raw) return null
  const number = Number(raw)
  return Number.isInteger(number) && number > 0 ? number : null
}

function expectedReleaseSha(releaseSha) {
  const raw = String(releaseSha ?? '').trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(raw) ? raw : null
}

function checkSucceeded(entry) {
  const conclusion = String(entry?.conclusion ?? '').toUpperCase()
  const state = String(entry?.state ?? entry?.status ?? '').toUpperCase()
  const bucket = String(entry?.bucket ?? '').toLowerCase()
  return conclusion === 'SUCCESS' || state === 'SUCCESS' || state === 'COMPLETED' && conclusion === 'SUCCESS' || bucket === 'pass'
}

function permissionDisplay(value) {
  if (value === undefined) return 'none'
  return typeof value === 'string' ? value.toLowerCase() : String(value)
}

function pushPermissionChecks(checks, parsed, prefix) {
  const inspected = inspectPermissionSet(parsed)
  pushCheck(checks, inspected.entries.length > 0, `${prefix}_permissions_exported`, { count: inspected.entries.length })
  pushCheck(checks, inspected.invalid.length === 0, `${prefix}_permission_values_valid`, { invalid: inspected.invalid })
  for (const [permission, expected] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
    const actual = permissionDisplay(inspected.permissions[permission])
    pushCheck(checks, actual === expected, `${prefix}_permission_matches`, {
      permission,
      expected,
      actual,
    })
  }
  pushCheck(checks, !inspected.workflows_present, `${prefix}_workflows_disabled`, {
    actual: inspected.workflows_actual,
  })
  pushCheck(checks, inspected.extras.length === 0, `${prefix}_has_no_extra_permissions`, { extras: inspected.extras })
}

export function checkBundle(opts = {}) {
  const version = normalizeTag(opts.version || DEFAULT_VERSION)
  const phase = normalizePhase(opts.phase)
  const contract = resolveContract(opts, version)
  const phaseContract = contractPhase(contract, phase)
  const outDir = resolve(defaultOutDir({ ...opts, version }))
  const checksPr = expectedPrNumber(opts.checksPr)
  const releaseSha = expectedReleaseSha(opts.releaseSha)
  const checks = []
  const artifacts = {}
  const receiptValues = new Map()
  const requiredReceipts = phaseContract.receipts
  const requiredIssues = phaseContract.issues

  pushCheck(checks, existsSync(outDir), 'evidence_directory_present', { out_dir: outDir })
  pushCheck(checks, checksPr !== null, 'checks_pr_specified', { actual: opts.checksPr ?? null })
  pushCheck(checks, releaseSha !== null, 'release_sha_specified', { actual: opts.releaseSha ?? null })

  for (const required of requiredReceipts) {
    const path = join(outDir, required.file)
    const receipt = readJson(checks, path, required.file)
    receiptValues.set(required.file, receipt)
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

  if (requiredReceipts.some((receipt) => receipt.file === 'stable-deployment-check.json')) {
    const stableDeployment = receiptValues.get('stable-deployment-check.json')
    const stableCommit = String(stableDeployment?.target?.commit ?? stableDeployment?.target?.release_sha ?? '').toLowerCase()
    const stableVersion = String(stableDeployment?.target?.version ?? stableDeployment?.target?.tag ?? '')
    pushCheck(checks, Boolean(releaseSha && stableCommit === releaseSha), 'stable_deployment_commit_matches_release_sha', {
      expected: releaseSha,
      actual: stableCommit || null,
    })
    pushCheck(checks, stableVersion === version, 'stable_deployment_version_matches_release', {
      expected: version,
      actual: stableVersion || null,
    })
  }

  const hostGoDir = join(outDir, 'host-go')
  const hostGoVerification = checkBundleManifest({ outDir: hostGoDir })
  const hostGoFailures = Array.isArray(hostGoVerification?.checks)
    ? hostGoVerification.checks.filter((check) => check?.ok === false).slice(0, 20)
    : []
  pushCheck(checks, hostGoVerification?.status === 'pass', 'host_go_exported_bundle_reverified', {
    directory: hostGoDir,
    receipt_type: hostGoVerification?.receipt_type ?? null,
    status: hostGoVerification?.status ?? null,
    manifest_sha256: hostGoVerification?.manifest?.sha256 ?? null,
    failures: hostGoFailures,
  })

  if (requiredIssues.length > 0) {
    const issuesPath = join(outDir, 'github-issues.json')
    const issuesJson = readJson(checks, issuesPath, 'github_issues')
    artifacts['github-issues.json'] = artifactMeta(issuesPath, issuesJson)
    const issues = issueEntries(issuesJson)
    for (const issueNumber of requiredIssues) {
      const issue = issues.find((entry) => Number(entry?.number) === issueNumber)
      pushCheck(checks, Boolean(issue), 'required_issue_exported', { issue: issueNumber })
      pushCheck(checks, String(issue?.state ?? '').toUpperCase() === 'CLOSED', 'required_issue_closed', {
        issue: issueNumber,
        actual: issue?.state ?? null,
      })
    }
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

  const prPath = join(outDir, GITHUB_PR_FILE)
  const prJson = readJson(checks, prPath, 'github_pr')
  artifacts[GITHUB_PR_FILE] = artifactMeta(prPath, prJson)
  pushCheck(checks, Number(prJson?.number) === checksPr, 'checks_pr_number_matches_export', {
    expected: checksPr,
    actual: prJson?.number ?? null,
  })
  pushCheck(checks, String(prJson?.state ?? '').toUpperCase() === 'MERGED', 'release_pr_is_merged', {
    actual: prJson?.state ?? null,
  })
  pushCheck(checks, prJson?.isDraft === false, 'release_pr_is_not_draft', {
    actual: prJson?.isDraft ?? null,
  })
  pushCheck(checks, prJson?.baseRefName === 'main', 'release_pr_targets_main', {
    expected: 'main',
    actual: prJson?.baseRefName ?? null,
  })
  const mergeCommitSha = String(prJson?.mergeCommit?.oid ?? '').toLowerCase()
  pushCheck(checks, Boolean(releaseSha && mergeCommitSha === releaseSha), 'release_pr_merge_commit_matches_release_sha', {
    expected: releaseSha,
    actual: mergeCommitSha || null,
  })
  const prChecks = checkEntries(prJson)
  for (const requiredName of REQUIRED_CHECKS) {
    const matching = prChecks.filter((entry) => String(entry?.name ?? '') === requiredName)
    pushCheck(checks, matching.length > 0, 'required_pr_rollup_check_exported', { check_name: requiredName })
    pushCheck(checks, matching.some(checkSucceeded), 'required_pr_rollup_check_passed', {
      check_name: requiredName,
      observed: matching.map((entry) => ({
        name: entry?.name ?? null,
        conclusion: entry?.conclusion ?? null,
        state: entry?.state ?? entry?.status ?? null,
        bucket: entry?.bucket ?? null,
      })),
    })
  }

  const commitPath = join(outDir, 'github-commit.json')
  const commitJson = readJson(checks, commitPath, 'github_commit')
  artifacts['github-commit.json'] = artifactMeta(commitPath, commitJson)
  const exportedCommitSha = String(commitJson?.sha ?? '').toLowerCase()
  pushCheck(checks, Boolean(releaseSha && exportedCommitSha === releaseSha), 'github_commit_matches_release_sha', {
    expected: releaseSha,
    actual: exportedCommitSha || null,
  })

  const commitChecksPath = join(outDir, 'github-commit-checks.json')
  const commitChecksJson = readJson(checks, commitChecksPath, 'github_commit_checks')
  artifacts['github-commit-checks.json'] = artifactMeta(commitChecksPath, commitChecksJson)
  const releaseCommitChecks = checkEntries(commitChecksJson)
  for (const requiredName of REQUIRED_COMMIT_CHECKS) {
    const matching = releaseCommitChecks.filter((entry) => String(entry?.name ?? '') === requiredName)
    pushCheck(checks, matching.length > 0, 'required_release_commit_check_exported', { check_name: requiredName })
    pushCheck(checks, matching.some(checkSucceeded), 'required_release_commit_check_passed', {
      check_name: requiredName,
      observed: matching.map((entry) => ({
        name: entry?.name ?? null,
        conclusion: entry?.conclusion ?? null,
        state: entry?.state ?? entry?.status ?? null,
      })),
    })
  }

  const appPath = join(outDir, APP_FILE)
  const appJson = readJson(checks, appPath, 'github_app')
  artifacts[APP_FILE] = artifactMeta(appPath, appJson)
  const installationPath = join(outDir, INSTALLATION_FILE)
  const installationJson = readJson(checks, installationPath, 'github_installation')
  artifacts[INSTALLATION_FILE] = artifactMeta(installationPath, installationJson)
  const permissionReceipt = receiptValues.get('github-app-permissions-check.json')
  for (const file of [APP_FILE, INSTALLATION_FILE]) {
    const expectedSha = permissionReceipt?.artifacts?.[file]?.sha256 ?? null
    const actualSha = artifacts[file]?.sha256 ?? null
    pushCheck(checks, Boolean(expectedSha && actualSha && expectedSha === actualSha), 'github_permission_artifact_matches_receipt', {
      file,
      expected_sha256: expectedSha,
      actual_sha256: actualSha,
    })
  }
  pushCheck(checks, String(installationJson?.app_id ?? '') === String(appJson?.id ?? ''), 'github_installation_app_id_matches', {
    expected: appJson?.id ?? null,
    actual: installationJson?.app_id ?? null,
  })
  pushCheck(checks, Boolean(appJson?.slug) && installationJson?.app_slug === appJson?.slug, 'github_installation_app_slug_matches', {
    expected: appJson?.slug ?? null,
    actual: installationJson?.app_slug ?? null,
  })
  pushCheck(checks, Boolean(installationJson?.id && installationJson?.account?.login && installationJson?.account?.id), 'github_installation_identity_present', {
    installation_id: installationJson?.id ?? null,
    account: installationJson?.account ?? null,
  })
  pushCheck(checks, installationJson?.suspended_at === null, 'github_installation_active', {
    suspended_at: installationJson?.suspended_at ?? null,
  })
  pushPermissionChecks(checks, appJson, 'github_app')
  pushPermissionChecks(checks, installationJson, 'github_installation')

  const failed = checks.filter((check) => check.ok === false)
  const passed = checks.filter((check) => check.ok === true)
  return {
    receipt_type: phaseContract.receiptType,
    status: failed.length === 0 ? 'pass' : 'fail',
    phase,
    checked_at: new Date().toISOString(),
    version,
    repo: opts.repo || DEFAULT_REPO,
    checks_pr: checksPr,
    release_sha: releaseSha,
    out_dir: outDir,
    contract: {
      schema_version: contract.schema_version,
      version: contract.version,
      name: contract.name,
      source: contract.source,
      sha256: contract.source_sha256,
    },
    summary: {
      passed: passed.length,
      failed: failed.length,
      total: checks.length,
      required_receipts: requiredReceipts.length,
      required_issues: requiredIssues.length,
      required_ci_checks: REQUIRED_CHECKS.length,
      required_commit_checks: REQUIRED_COMMIT_CHECKS.length,
      required_app_permissions: Object.keys(REQUIRED_APP_PERMISSIONS).length,
    },
    required: {
      receipts: requiredReceipts,
      issues: requiredIssues,
      ci_checks: REQUIRED_CHECKS,
      commit_checks: REQUIRED_COMMIT_CHECKS,
      checks_pr: checksPr,
      release_sha: releaseSha,
      app_permissions: REQUIRED_APP_PERMISSIONS,
    },
    artifacts,
    checks,
    next_steps: failed.length === 0
      ? [phase === 'prepublication'
          ? 'publish only this exact release SHA, then run postpublication integrity and final readiness'
          : 'attach this final aggregate release-readiness receipt to the release tracker']
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
