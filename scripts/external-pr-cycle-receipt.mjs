#!/usr/bin/env node
// Mupot external board -> task -> agent -> GitHub PR evidence checker.
//
// This is the #150 release proof gate. The real cycle runs against GitHub and a
// live pot; this script validates the redacted evidence bundle afterward.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STEP_RECEIPT_TYPE = 'mupot-external-pr-cycle-step/v1'
export const CHECK_RECEIPT_TYPE = 'mupot-external-pr-cycle/v1'

export const REQUIRED_STEPS = [
  {
    step: 'board_item',
    file: 'board-item.json',
    evidence: ['project_item_id', 'issue_url', 'agent_field'],
    links: ['issue_url'],
  },
  {
    step: 'task_import',
    file: 'task-import.json',
    evidence: ['task_id', 'assigned_agent_id', 'board_item_linked'],
    links: ['task_url'],
  },
  {
    step: 'agent_execution',
    file: 'agent-execution.json',
    evidence: ['runtime_identity', 'inbox_work_received', 'execution_started'],
    links: [],
  },
  {
    step: 'pull_request',
    file: 'pull-request.json',
    evidence: ['pr_url', 'pr_number', 'author', 'task_linked'],
    links: ['pr_url'],
  },
  {
    step: 'task_linkback',
    file: 'task-linkback.json',
    evidence: ['task_result_links_pr', 'audit_record'],
    links: ['task_url', 'pr_url'],
  },
  {
    step: 'ci_feedback',
    file: 'ci-feedback.json',
    evidence: ['checks_observed', 'status_synced_to_task_or_board'],
    links: ['pr_url'],
  },
  {
    step: 'final_verification',
    file: 'final-verification.json',
    evidence: ['issue_to_pr_trace', 'task_to_pr_trace', 'agent_author_trace'],
    links: ['issue_url', 'task_url', 'pr_url'],
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
    repo: '',
    agent: '',
    taskId: '',
    issueUrl: '',
    prUrl: '',
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
    else if (arg === '--repo') opts.repo = next()
    else if (arg === '--agent') opts.agent = next()
    else if (arg === '--task-id') opts.taskId = next()
    else if (arg === '--issue-url') opts.issueUrl = stripTrailingSlash(next())
    else if (arg === '--pr-url') opts.prUrl = stripTrailingSlash(next())
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
    'Usage: node scripts/external-pr-cycle-receipt.mjs --plan|--check [options]',
    '',
    'Options:',
    '  --plan                 print the #150 evidence plan',
    '  --check                check a completed evidence directory',
    '  --summary              with --check, print a compact text summary',
    '  --out-dir <path>       evidence directory',
    '  --pot <slug>           expected pot slug',
    '  --repo <owner/name>    expected GitHub repo',
    '  --agent <id-or-slug>   expected agent identity',
    '  --task-id <id>         expected Mupot task id',
    '  --issue-url <url>      expected GitHub board issue URL',
    '  --pr-url <url>         expected GitHub PR URL',
    '  --base-url <url>       expected Mupot base URL',
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
  if (opts.outDir) return opts.outDir
  const name = opts.taskId || '<task-id>'
  return `tmp/external-pr-cycle/${name}`
}

export function formatPlan(opts = {}) {
  const outDir = defaultOutDir(opts)
  const pot = opts.pot || '<pot>'
  const repo = opts.repo || '<owner/repo>'
  const agent = opts.agent || '<agent-id-or-slug>'
  const taskId = opts.taskId || '<task-id>'
  const issueUrl = opts.issueUrl || 'https://github.com/<owner>/<repo>/issues/<number>'
  const prUrl = opts.prUrl || 'https://github.com/<owner>/<repo>/pull/<number>'
  const baseUrl = opts.baseUrl || 'https://<pot-host>'
  const lines = []

  lines.push('Mupot #150 external PR-cycle evidence plan')
  lines.push('')
  lines.push('Goal: prove one real GitHub board item became a Mupot task, reached a named runtime agent, produced a GitHub PR, linked back to the task, and surfaced CI/status feedback.')
  lines.push('')
  lines.push('Before running:')
  lines.push('- Use the real GitHub Project board and a real agent provisioned in the pot.')
  lines.push('- Keep GitHub tokens, Mupot member tokens, webhook secrets, cookies, and private keys out of receipts.')
  lines.push('- Each step receipt must use receipt_type "mupot-external-pr-cycle-step/v1" and status "pass".')
  lines.push('- Each step receipt must include a parseable ISO-8601 observed_at value, and observed_at values must follow the board -> task -> agent -> PR -> linkback -> CI -> final verification order below.')
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
      repo,
      agent,
      task_id: taskId,
      issue_url: issueUrl,
      pr_url: prUrl,
    },
    evidence: {
      '<required_key>': true,
    },
    links: {
      issue_url: issueUrl,
      task_url: `${baseUrl}/tasks/${taskId}`,
      pr_url: prUrl,
    },
    artifacts: [
      { label: '<screenshot, gh output, task JSON, or check run>', path: '<redacted path or durable URL>' },
    ],
  }, null, 2))
  lines.push('')
  lines.push('After all files are present:')
  lines.push(commandLine([
    'node',
    'scripts/external-pr-cycle-receipt.mjs',
    '--check',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--repo',
    repo,
    '--agent',
    agent,
    '--task-id',
    taskId,
    '--issue-url',
    issueUrl,
    '--pr-url',
    prUrl,
    '--base-url',
    baseUrl,
  ], ` > ${shellQuote(join(outDir, 'external-pr-cycle-check.json'))}`))
  lines.push(commandLine([
    'node',
    'scripts/external-pr-cycle-receipt.mjs',
    '--check',
    '--summary',
    '--out-dir',
    outDir,
    '--pot',
    pot,
    '--repo',
    repo,
    '--agent',
    agent,
    '--task-id',
    taskId,
    '--issue-url',
    issueUrl,
    '--pr-url',
    prUrl,
    '--base-url',
    baseUrl,
  ]))
  lines.push('')
  lines.push('Attach the evidence directory plus external-pr-cycle-check.json to #150 only when the aggregate receipt reports status "pass".')

  return `${lines.join('\n')}\n`
}

function pushCheck(checks, ok, check, extra = {}) {
  checks.push({ ok, component: 'external-pr-cycle-check', check, ...extra })
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

function linkValue(receipt, key) {
  const value = receipt?.links?.[key] ?? receipt?.target?.[key]
  return typeof value === 'string' ? stripTrailingSlash(value) : ''
}

function isHttpUrl(value) {
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(String(value))
}

function githubIssueOrPrRepo(url) {
  const match = String(url).match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/\d+$/i)
  return match ? match[1] : ''
}

function normalizeRepo(repo) {
  return String(repo || '').trim().toLowerCase()
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
  const outDir = opts.outDir ? resolve(opts.outDir) : ''
  const checks = []
  const artifacts = {}
  const receipts = []
  const timeline = []

  pushCheck(checks, Boolean(outDir), 'out_dir_arg_present', { out_dir: outDir })
  pushCheck(checks, Boolean(outDir && existsSync(outDir)), 'out_dir_exists', { out_dir: outDir })

  if (outDir && existsSync(outDir)) {
    const allowed = new Set([...REQUIRED_STEPS.map((step) => step.file), 'external-pr-cycle-check.json'])
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

    const observed = observedAtMs(receipt)
    pushCheck(checks, observed.ok, 'step_observed_at_iso', { step: step.step, path, value: observed.raw || null })
    if (observed.ok) timeline.push({ step: step.step, path, observed_at: observed.raw, observed_ms: observed.ms })

    const evidence = receipt?.evidence && typeof receipt.evidence === 'object' ? receipt.evidence : {}
    for (const key of step.evidence) {
      pushCheck(checks, evidenceValuePass(evidence[key]), 'required_evidence_present', {
        step: step.step,
        path,
        evidence: key,
        value: evidence[key] ?? null,
      })
    }

    for (const key of ['pot', 'base_url', 'repo', 'agent', 'task_id', 'issue_url', 'pr_url']) {
      pushCheck(checks, targetValue(receipt, key).length > 0, 'step_target_field_present', {
        step: step.step,
        path,
        field: key,
        value: targetValue(receipt, key) || null,
      })
    }

    for (const key of step.links) {
      const value = linkValue(receipt, key)
      pushCheck(checks, isHttpUrl(value), 'step_link_url_valid', {
        step: step.step,
        path,
        link: key,
        value: value || null,
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
    pushCheck(checks, current.observed_ms >= previous.observed_ms, 'external_pr_cycle_steps_observed_in_order', {
      previous_step: previous.step,
      previous_observed_at: previous.observed_at,
      step: current.step,
      observed_at: current.observed_at,
    })
  }

  const targetFields = ['pot', 'base_url', 'repo', 'agent', 'task_id', 'issue_url', 'pr_url']
  const target = {}
  for (const field of targetFields) {
    const values = [...new Set(receipts.map(({ receipt }) => targetValue(receipt, field)).filter(Boolean))]
    pushCheck(checks, values.length === (receipts.length > 0 ? 1 : 0), 'target_field_consistent_across_steps', {
      field,
      values,
    })
    target[field] = values.length === 1 ? values[0] : null
  }

  const repoFromIssue = githubIssueOrPrRepo(target.issue_url)
  const repoFromPr = githubIssueOrPrRepo(target.pr_url)
  pushCheck(checks, repoFromIssue.length > 0, 'issue_url_is_github_issue', { issue_url: target.issue_url })
  pushCheck(checks, repoFromPr.length > 0, 'pr_url_is_github_pr', { pr_url: target.pr_url })
  pushCheck(checks, repoFromIssue.length > 0 && repoFromIssue === repoFromPr, 'issue_and_pr_same_repo', {
    issue_repo: repoFromIssue || null,
    pr_repo: repoFromPr || null,
  })
  pushCheck(checks, normalizeRepo(target.repo) === normalizeRepo(repoFromPr), 'target_repo_matches_pr_repo', {
    target_repo: target.repo,
    pr_repo: repoFromPr || null,
  })

  if (opts.pot) pushCheck(checks, target.pot === opts.pot, 'target_pot_matches_expected', { expected: opts.pot, actual: target.pot })
  if (opts.repo) pushCheck(checks, normalizeRepo(target.repo) === normalizeRepo(opts.repo), 'target_repo_matches_expected', { expected: opts.repo, actual: target.repo })
  if (opts.agent) pushCheck(checks, target.agent === opts.agent, 'target_agent_matches_expected', { expected: opts.agent, actual: target.agent })
  if (opts.taskId) pushCheck(checks, target.task_id === opts.taskId, 'target_task_matches_expected', { expected: opts.taskId, actual: target.task_id })
  if (opts.issueUrl) pushCheck(checks, target.issue_url === stripTrailingSlash(opts.issueUrl), 'target_issue_matches_expected', { expected: stripTrailingSlash(opts.issueUrl), actual: target.issue_url })
  if (opts.prUrl) pushCheck(checks, target.pr_url === stripTrailingSlash(opts.prUrl), 'target_pr_matches_expected', { expected: stripTrailingSlash(opts.prUrl), actual: target.pr_url })
  if (opts.baseUrl) pushCheck(checks, target.base_url === stripTrailingSlash(opts.baseUrl), 'target_base_url_matches_expected', { expected: stripTrailingSlash(opts.baseUrl), actual: target.base_url })

  const failed = checks.filter((check) => check.ok === false)
  const passed = checks.filter((check) => check.ok === true)
  return {
    receipt_type: CHECK_RECEIPT_TYPE,
    status: failed.length === 0 ? 'pass' : 'fail',
    checked_at: new Date().toISOString(),
    out_dir: outDir,
    target,
    timeline: timeline.map(({ step, observed_at }) => ({ step, observed_at })),
    required_steps: REQUIRED_STEPS.map(({ step, file, evidence, links }) => ({ step, file, evidence, links })),
    artifacts,
    summary: {
      passed: passed.length,
      failed: failed.length,
      total: checks.length,
    },
    checks,
    next_steps: failed.length === 0
      ? ['attach the external PR-cycle evidence directory and this check receipt to #150']
      : ['fix failing external PR-cycle evidence, rerun the real step if needed, then rerun external-pr-cycle-receipt --check'],
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
    console.error(`external-pr-cycle-receipt: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
