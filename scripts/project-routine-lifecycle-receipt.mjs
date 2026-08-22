#!/usr/bin/env node
// Mupot v0.25 Project Routine lifecycle evidence checker.
//
// Validates a redacted local evidence bundle that proves one governed Routine
// path across browser, REST, MCP, scheduler, runtime, restart, and surfaces.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

export const STEP_RECEIPT_TYPE = 'mupot-project-routine-lifecycle-step/v1'
export const CHECK_RECEIPT_TYPE = 'mupot-project-routine-lifecycle/v1'

export const REQUIRED_SURFACES = Object.freeze([
  'browser',
  'rest',
  'mcp',
  'scheduler',
  'runtime',
  'activity',
  'evidence',
  'situation',
])

export const REQUIRED_SCREENSHOTS = Object.freeze([
  'screenshots/desktop-propose-mode.png',
  'screenshots/mobile-propose-mode.png',
])

export const REQUIRED_STEPS = Object.freeze([
  {
    step: 'routine_created',
    file: 'routine-created.json',
    evidence: ['routine_id', 'project_id', 'project_active', 'created_by_operator'],
  },
  {
    step: 'routine_enabled',
    file: 'routine-enabled.json',
    evidence: ['trigger_configured', 'enabled', 'mode'],
  },
  {
    step: 'manual_fire',
    file: 'manual-fire.json',
    evidence: ['routine_run_id', 'run_observed', 'occurrence_id'],
  },
  {
    step: 'runtime_proposal',
    file: 'runtime-proposal.json',
    evidence: ['agent_identity', 'correlated_proposal', 'situation_digest_matched'],
  },
  {
    step: 'needs_you_approval',
    file: 'needs-you-approval.json',
    evidence: [
      'needs_you_item_id',
      'human_approval_recorded',
      'external_action_gated',
      'external_action_executed',
      'external_action_approved',
    ],
  },
  {
    step: 'terminal_outcome',
    file: 'terminal-outcome.json',
    evidence: [
      'terminal_status',
      'cost_recorded',
      'activity_visible',
      'evidence_visible',
      'situation_updated',
      'idempotent_duplicate_noop',
      'unauthorized_rejected',
    ],
  },
  {
    step: 'restart_parity',
    file: 'restart-parity.json',
    evidence: [
      'worker_restarted',
      'durable_state_preserved',
      'surface_parity',
      'commit',
      'version',
    ],
  },
])

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
const COMMIT_RE = /^[a-f0-9]{40}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function parseArgs(argv) {
  const opts = {
    outDir: '',
    pot: '',
    baseUrl: '',
    projectId: '',
    routineId: '',
    routineRunId: '',
    expectedCommit: '',
    expectedVersion: '',
    repoRoot: process.cwd(),
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
    else if (arg === '--project-id') opts.projectId = next()
    else if (arg === '--routine-id') opts.routineId = next()
    else if (arg === '--routine-run-id') opts.routineRunId = next()
    else if (arg === '--expected-commit') opts.expectedCommit = next()
    else if (arg === '--expected-version') opts.expectedVersion = next()
    else if (arg === '--repo-root') opts.repoRoot = resolve(next())
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
    'Usage: node scripts/project-routine-lifecycle-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                      print the Project Routine lifecycle evidence plan',
    '  --check                     check a completed lifecycle evidence directory',
    '  --summary                   with --check, print a compact text summary',
    '  --out-dir <path>            evidence directory',
    '  --pot <slug>                expected pot slug',
    '  --base-url <url>            expected pot URL',
    '  --project-id <id>           expected Project id',
    '  --routine-id <id>           expected Routine id',
    '  --routine-run-id <id>       expected RoutineRun id',
    '  --expected-commit <sha>     expected 40-character commit',
    '  --expected-version <semver> expected public API / package version',
    '  --repo-root <path>          local repo root for HEAD comparison',
    '  -h, --help                  show this help',
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
  return opts.outDir || `tmp/project-routine-lifecycle/${opts.routineRunId || '<routine-run-id>'}`
}

export function formatPlan(opts = {}) {
  const pot = opts.pot || '<pot>'
  const baseUrl = opts.baseUrl || 'http://127.0.0.1:<port>'
  const projectId = opts.projectId || '<project-id>'
  const routineId = opts.routineId || '<routine-id>'
  const routineRunId = opts.routineRunId || '<routine-run-id>'
  const expectedCommit = opts.expectedCommit || '<exact-commit-sha>'
  const expectedVersion = opts.expectedVersion || '<package-version>'
  const outDir = defaultOutDir(opts)
  const lines = []

  lines.push('Mupot v0.25 Project Routine lifecycle evidence plan')
  lines.push('')
  lines.push('Goal: prove one governed propose-mode Routine path with desktop/mobile browser evidence, REST/MCP/scheduler/runtime parity, restart durability, authorization, idempotency, cost, Activity, Evidence, and Situation agreement on an exact commit.')
  lines.push('')
  lines.push('Before running:')
  lines.push('- Do not bump package version, merge, deploy, tag, or activate a customer pot from this receipt.')
  lines.push('- Use wrangler-local-test on an unused port with migrations + local-test-seed applied.')
  lines.push('- Capture desktop and mobile Playwright screenshots under screenshots/.')
  lines.push('- Restart the Worker once and re-read durable RoutineRun plus surface parity.')
  lines.push('- External writes must remain gated; an unapproved external action fails the check.')
  lines.push('- Keep bearer tokens, cookies, private keys, and provider secrets out of receipts.')
  lines.push('')
  lines.push(commandLine(['mkdir', '-p', join(outDir, 'screenshots')]))
  lines.push('')
  for (const step of REQUIRED_STEPS) {
    lines.push(`${step.step}: write ${step.file}`)
    lines.push(`  required evidence keys: ${step.evidence.join(', ')}`)
  }
  lines.push('')
  lines.push('Required screenshots:')
  for (const relative of REQUIRED_SCREENSHOTS) {
    lines.push(`  - ${relative}`)
  }
  lines.push('')
  lines.push('Required surfaces in restart-parity.json evidence.surface_parity:')
  lines.push(`  ${REQUIRED_SURFACES.join(', ')}`)
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
      project_id: projectId,
      routine_id: routineId,
      routine_run_id: routineRunId,
      commit: expectedCommit,
      version: expectedVersion,
    },
    evidence: {
      '<required_key>': true,
    },
    artifacts: [
      { label: '<screenshot or JSON artifact>', path: '<relative path under out-dir>' },
    ],
  }, null, 2))
  lines.push('')
  lines.push('Check the completed bundle:')
  lines.push(commandLine([
    'node',
    'scripts/project-routine-lifecycle-receipt.mjs',
    '--check',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
    '--project-id',
    projectId,
    '--routine-id',
    routineId,
    '--routine-run-id',
    routineRunId,
    '--expected-commit',
    expectedCommit,
    '--expected-version',
    expectedVersion,
  ], ` > ${shellQuote(join(outDir, 'project-routine-lifecycle-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/project-routine-lifecycle-receipt.mjs',
    '--check',
    '--summary',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--base-url',
    baseUrl,
    '--project-id',
    projectId,
    '--routine-id',
    routineId,
    '--routine-run-id',
    routineRunId,
    '--expected-commit',
    expectedCommit,
    '--expected-version',
    expectedVersion,
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
    pushCheck(checks, false, 'receipt_json_parseable', {
      label,
      path,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
  const secretFindings = scanSecrets(parsed)
  pushCheck(checks, secretFindings.length === 0, 'receipt_has_no_secret_material', {
    label,
    path,
    findings: secretFindings,
  })
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

function referencedArtifactMeta(checks, outDir, receiptPath, receipt) {
  const references = receipt?.artifacts
  const validList = Array.isArray(references) && references.length > 0 && references.length <= 50
  pushCheck(checks, validList, 'receipt_artifacts_declared', {
    path: receiptPath,
    count: Array.isArray(references) ? references.length : 0,
  })
  if (!validList) return []

  const root = realpathSync(outDir)
  const receiptRealPath = realpathSync(receiptPath)
  const seen = new Set()
  return references.map((reference, index) => {
    const label = typeof reference?.label === 'string' ? reference.label.trim() : ''
    const artifactPath = typeof reference?.path === 'string' ? reference.path.trim() : ''
    const candidate = artifactPath && !isAbsolute(artifactPath) ? resolve(root, artifactPath) : ''
    const relativePath = candidate ? relative(root, candidate) : ''
    const boundedShape = Boolean(label) && label.length <= 200 && Boolean(artifactPath)
      && artifactPath.length <= 1000 && Boolean(candidate) && Boolean(relativePath)
      && relativePath !== '..' && !relativePath.startsWith('../') && !isAbsolute(relativePath)
      && !seen.has(relativePath)
    if (boundedShape) seen.add(relativePath)
    pushCheck(checks, boundedShape, 'receipt_artifact_reference_valid', {
      path: receiptPath, index, label: label || null, artifact_path: artifactPath || null,
    })
    if (!boundedShape || !existsSync(candidate)) {
      pushCheck(checks, false, 'receipt_artifact_file_present', {
        path: receiptPath, index, artifact_path: artifactPath || null,
      })
      return { label: label || null, path: artifactPath || null, exists: false }
    }

    let realPath
    let realRelative
    let stats
    try {
      realPath = realpathSync(candidate)
      realRelative = relative(root, realPath)
      stats = statSync(realPath)
    } catch {
      pushCheck(checks, false, 'receipt_artifact_file_present', {
        path: receiptPath, index, artifact_path: artifactPath,
      })
      return { label, path: artifactPath, exists: false }
    }
    const safeFile = realRelative !== '..' && !realRelative.startsWith('../') && !isAbsolute(realRelative)
      && realPath !== receiptRealPath && stats.isFile() && stats.size > 0 && stats.size <= 10 * 1024 * 1024
    pushCheck(checks, safeFile, 'receipt_artifact_file_present', {
      path: receiptPath, index, artifact_path: artifactPath, bytes: stats.size,
    })
    if (!safeFile) return { label, path: artifactPath, exists: false }

    const bytes = readFileSync(realPath)
    let secretFindings
    if (extname(realPath).toLowerCase() === '.json') {
      try {
        secretFindings = scanSecrets(JSON.parse(bytes.toString('utf8')))
      } catch {
        secretFindings = scanSecrets(bytes.toString('utf8'))
      }
    } else {
      secretFindings = scanSecrets(bytes.toString('utf8'))
    }
    pushCheck(checks, secretFindings.length === 0, 'receipt_artifact_has_no_secret_material', {
      path: receiptPath, index, artifact_path: artifactPath, findings: secretFindings,
    })
    return {
      label,
      path: artifactPath,
      exists: true,
      bytes: stats.size,
      sha256: fileSha256(realPath),
    }
  })
}

const TRUE_EVIDENCE = new Set([
  'project_active', 'created_by_operator', 'trigger_configured', 'enabled', 'run_observed',
  'correlated_proposal', 'situation_digest_matched', 'human_approval_recorded',
  'external_action_gated', 'external_action_executed', 'external_action_approved',
  'cost_recorded', 'activity_visible', 'evidence_visible', 'situation_updated',
  'idempotent_duplicate_noop', 'unauthorized_rejected', 'worker_restarted',
  'durable_state_preserved',
])

const IDENTIFIER_EVIDENCE = new Set([
  'routine_id', 'project_id', 'routine_run_id', 'occurrence_id', 'agent_identity', 'needs_you_item_id',
])

function evidenceValuePass(key, value) {
  if (TRUE_EVIDENCE.has(key)) return value === true
  if (IDENTIFIER_EVIDENCE.has(key)) return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value)
  if (key === 'mode') return value === 'propose' || value === 'execute_internal'
  if (key === 'terminal_status') return ['succeeded', 'failed', 'skipped', 'cancelled'].includes(value)
  if (key === 'commit') return typeof value === 'string' && COMMIT_RE.test(value)
  if (key === 'version') return typeof value === 'string' && VERSION_RE.test(value)
  if (key === 'surface_parity') return surfaceParityComplete(value)
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

function gitHead(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function isPngScreenshot(path) {
  if (!existsSync(path)) return false
  const stats = statSync(path)
  if (!stats.isFile() || stats.size < 45) return false
  const png = readFileSync(path)
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false
  try {
    let offset = 8
    let width = 0
    let height = 0
    let bitDepth = 0
    let colorType = -1
    let interlace = -1
    let sawHeader = false
    let sawEnd = false
    const data = []
    while (offset + 12 <= png.length) {
      const length = png.readUInt32BE(offset)
      const end = offset + 12 + length
      if (end > png.length) return false
      const type = png.subarray(offset + 4, offset + 8).toString('ascii')
      const chunk = png.subarray(offset + 8, offset + 8 + length)
      const expectedCrc = png.readUInt32BE(offset + 8 + length)
      if (crc32(png.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) return false
      if (!sawHeader && type !== 'IHDR') return false
      if (type === 'IHDR') {
        if (sawHeader || length !== 13) return false
        width = chunk.readUInt32BE(0)
        height = chunk.readUInt32BE(4)
        bitDepth = chunk[8]
        colorType = chunk[9]
        interlace = chunk[12]
        if (chunk[10] !== 0 || chunk[11] !== 0) return false
        sawHeader = true
      } else if (type === 'IDAT') {
        data.push(chunk)
      } else if (type === 'IEND') {
        if (length !== 0) return false
        sawEnd = true
        offset = end
        break
      }
      offset = end
    }
    if (!sawHeader || !sawEnd || offset !== png.length || data.length === 0
      || width < 320 || height < 200 || interlace !== 0 || bitDepth !== 8
      || ![2, 6].includes(colorType)) return false
    const channels = colorType === 2 ? 3 : 4
    const pixels = inflateSync(Buffer.concat(data))
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8)
    if (pixels.length !== height * (rowBytes + 1)) return false
    for (let row = 0; row < height; row += 1) {
      if (pixels[row * (rowBytes + 1)] > 4) return false
    }
    return true
  } catch {
    return false
  }
}

function surfaceParityComplete(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return REQUIRED_SURFACES.every((surface) => value[surface] === true)
}

function checkExternalAction(checks, receipt, path) {
  const evidence = receipt?.evidence && typeof receipt.evidence === 'object' ? receipt.evidence : {}
  const executed = evidence.external_action_executed === true
  const approved = evidence.external_action_approved === true
  const gated = evidence.external_action_gated === true
  const unapprovedFlag = evidence.unapproved_external_action === true

  pushCheck(checks, gated === true, 'external_action_gated', {
    path,
    external_action_gated: evidence.external_action_gated ?? null,
  })
  pushCheck(checks, !unapprovedFlag, 'no_unapproved_external_action_flag', {
    path,
    unapproved_external_action: evidence.unapproved_external_action ?? null,
  })
  pushCheck(checks, !executed || approved, 'external_action_requires_approval', {
    path,
    external_action_executed: evidence.external_action_executed ?? null,
    external_action_approved: evidence.external_action_approved ?? null,
  })
}

function checkSurfaceParity(checks, receipt, path) {
  const parity = receipt?.evidence?.surface_parity
  pushCheck(checks, surfaceParityComplete(parity), 'surface_parity_complete', {
    path,
    required: REQUIRED_SURFACES,
    actual: parity && typeof parity === 'object' ? parity : null,
  })
}

function checkRestartProof(checks, receipt, path) {
  const evidence = receipt?.evidence && typeof receipt.evidence === 'object' ? receipt.evidence : {}
  pushCheck(checks, evidence.worker_restarted === true, 'restart_proof_worker_restarted', {
    path,
    worker_restarted: evidence.worker_restarted ?? null,
  })
  pushCheck(checks, evidence.durable_state_preserved === true, 'restart_proof_durable_state', {
    path,
    durable_state_preserved: evidence.durable_state_preserved ?? null,
  })
}

function checkScreenshots(checks, outDir) {
  for (const relative of REQUIRED_SCREENSHOTS) {
    const path = join(outDir, relative)
    const present = existsSync(path)
    pushCheck(checks, present, 'screenshot_present', { path: relative, absolute_path: path })
    if (!present) continue
    pushCheck(checks, isPngScreenshot(path), 'screenshot_is_png', {
      path: relative,
      absolute_path: path,
    })
  }
}

export function checkBundle(opts = {}) {
  const outDir = resolve(defaultOutDir(opts))
  const repoRoot = resolve(opts.repoRoot || process.cwd())
  const checks = []
  const artifacts = {}

  pushCheck(checks, existsSync(outDir), 'evidence_directory_present', { out_dir: outDir })
  if (existsSync(outDir)) {
    const expected = new Set([
      ...REQUIRED_STEPS.map((step) => step.file),
      'project-routine-lifecycle-check.json',
    ])
    const topLevelJson = readdirSync(outDir).filter((name) => name.endsWith('.json') && !expected.has(name))
    pushCheck(checks, topLevelJson.length === 0, 'bundle_only_expected_json_files', {
      extra_files: topLevelJson,
    })
  }

  checkScreenshots(checks, outDir)

  const receipts = []
  const timeline = []
  for (const spec of REQUIRED_STEPS) {
    const path = join(outDir, spec.file)
    const receipt = readReceiptFile(checks, path, spec.step)
    artifacts[spec.step] = artifactMeta(path, receipt)
    if (!receipt) continue
    artifacts[spec.step].referenced_artifacts = referencedArtifactMeta(checks, outDir, path, receipt)
    receipts.push({ spec, path, receipt })
    checkReceiptBasics(checks, receipt, path, spec.step)
    const observed = observedAtMs(receipt)
    pushCheck(checks, observed.ok, 'observed_at_parseable', {
      path,
      step: spec.step,
      observed_at: observed.raw || null,
    })
    if (observed.ok) {
      timeline.push({
        step: spec.step,
        path,
        observed_at: observed.raw,
        observed_ms: observed.ms,
      })
    }
    for (const key of spec.evidence) {
      const value = receipt?.evidence?.[key]
      pushCheck(checks, evidenceValuePass(key, value), 'required_evidence_present', {
        path,
        step: spec.step,
        evidence: key,
        value: value ?? null,
      })
    }
    if (spec.step === 'needs_you_approval') checkExternalAction(checks, receipt, path)
    if (spec.step === 'restart_parity') {
      checkRestartProof(checks, receipt, path)
      checkSurfaceParity(checks, receipt, path)
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

  const targetFields = [
    'pot',
    'base_url',
    'project_id',
    'routine_id',
    'routine_run_id',
    'commit',
    'version',
  ]
  const target = {}
  for (const field of targetFields) {
    const receiptValues = receipts.map(({ receipt }) => targetValue(receipt, field))
    const values = [...new Set(receiptValues.filter(Boolean))]
    const complete = receipts.length > 0 && receiptValues.every(Boolean)
    pushCheck(checks, complete && values.length === 1, 'target_field_consistent_across_receipts', {
      field,
      values,
      receipts_with_value: receiptValues.filter(Boolean).length,
      receipt_count: receipts.length,
    })
    target[field] = complete && values.length === 1 ? values[0] : null
  }

  pushCheck(checks, Boolean(target.commit) && COMMIT_RE.test(String(target.commit)), 'target_commit_shape', {
    commit: target.commit,
  })
  pushCheck(checks, Boolean(target.version) && VERSION_RE.test(String(target.version)), 'target_version_shape', {
    version: target.version,
  })

  const head = gitHead(repoRoot)
  if (opts.expectedCommit) {
    pushCheck(checks, target.commit === opts.expectedCommit, 'target_commit_matches_expected', {
      expected: opts.expectedCommit,
      actual: target.commit,
    })
  } else if (head) {
    pushCheck(checks, target.commit === head, 'target_commit_matches_git_head', {
      expected: head,
      actual: target.commit,
    })
  }

  if (opts.expectedVersion) {
    pushCheck(checks, target.version === opts.expectedVersion, 'target_version_matches_expected', {
      expected: opts.expectedVersion,
      actual: target.version,
    })
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
  if (opts.projectId) {
    pushCheck(checks, target.project_id === opts.projectId, 'target_project_id_matches_expected', {
      expected: opts.projectId,
      actual: target.project_id,
    })
  }
  if (opts.routineId) {
    pushCheck(checks, target.routine_id === opts.routineId, 'target_routine_id_matches_expected', {
      expected: opts.routineId,
      actual: target.routine_id,
    })
  }
  if (opts.routineRunId) {
    pushCheck(checks, target.routine_run_id === opts.routineRunId, 'target_routine_run_id_matches_expected', {
      expected: opts.routineRunId,
      actual: target.routine_run_id,
    })
  }

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
      screenshots: REQUIRED_SCREENSHOTS.length,
      surfaces: REQUIRED_SURFACES.length,
    },
    required: {
      steps: REQUIRED_STEPS,
      screenshots: REQUIRED_SCREENSHOTS,
      surfaces: REQUIRED_SURFACES,
    },
    artifacts,
    checks,
    next_steps: failed.length === 0
      ? ['attach the project-routine lifecycle evidence directory and this check receipt to the v0.25 release issue']
      : [
        'fix failing project-routine lifecycle evidence (screenshots, commit/version, surface parity, restart proof, or external-action gate), then rerun project-routine-lifecycle-receipt --check',
      ],
  }
}

export function formatSummary(receipt) {
  const lines = []
  lines.push(`${receipt.receipt_type}: ${receipt.status}`)
  lines.push(`checks: ${receipt.summary.passed}/${receipt.summary.total} passed`)
  lines.push(`steps: ${receipt.summary.step_receipts}/${REQUIRED_STEPS.length}`)
  lines.push(`routine_run: ${receipt.target.routine_run_id ?? 'unknown'}`)
  lines.push(`commit: ${receipt.target.commit ?? 'unknown'}`)
  lines.push(`version: ${receipt.target.version ?? 'unknown'}`)
  if (receipt.status !== 'pass') {
    for (const check of receipt.checks.filter((entry) => entry.ok === false).slice(0, 12)) {
      lines.push(`FAIL ${check.check}${check.path ? ` ${basename(String(check.path))}` : ''}${check.reason ? `: ${check.reason}` : ''}`)
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
    console.error(`project-routine-lifecycle-receipt: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
