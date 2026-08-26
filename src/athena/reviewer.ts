// src/athena/reviewer.ts — Autonomous PR gate engine (Athena, gate:athena).
//
// Reviews a unified diff (and optional file list / test receipt) against the
// four safety rules the council gate is accountable for:
//   1. no hardcoded secrets
//   2. verified unit tests
//   3. RBAC compliance (capability floors stay in place)
//   4. schema backward-compatibility (never ship a silent ≤0079 migration)
//
// Pure: no I/O. The MCP tool (src/mcp/athena.ts) is the only caller that
// turns this verdict into a council-facing receipt.

export const GATE_VERDICTS = ['APPROVED', 'BLOCKED', 'CHANGES_REQUESTED'] as const
export type GateVerdict = (typeof GATE_VERDICTS)[number]

export const GATE_CHECK_IDS = [
  'no_hardcoded_secrets',
  'verified_unit_tests',
  'rbac_compliance',
  'schema_backward_compatibility',
] as const
export type GateCheckId = (typeof GATE_CHECK_IDS)[number]

export type GateCheckSeverity = 'blocker' | 'warning'

export interface GateCheck {
  id: GateCheckId
  name: string
  passed: boolean
  severity: GateCheckSeverity
  detail: string
}

export interface GateReviewResult {
  verdict: GateVerdict
  checks: GateCheck[]
  summary: string
}

export interface ReviewFile {
  path: string
  patch?: string
  status?: string
}

export interface GateReviewInput {
  title?: string
  body?: string
  diff: string
  files?: ReviewFile[]
  testsPresent?: boolean
  testsPassed?: number
  testsFailed?: number
  prUrl?: string
}

const SECRET_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github_pat', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { id: 'github_fine_grained', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'private_key_pem', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
  { id: 'assignment_literal', re: /\b(?:api[_-]?key|secret(?:_key)?|token|password|passwd|auth_token|private_key)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i },
]

const ENV_REFERENCE = /\b(?:process\.env|env|c\.env|Deno\.env)\b|wrangler secret|secret put/i
const PLACEHOLDER_SECRET = /\b(?:YOUR_|CHANGE_?ME|TODO|xxx+|placeholder|example|dummy|redacted|insert[_-]?here)/i

const TEST_FILE_RE = /(?:^|\/)(?:tests?\/|__tests__\/).*|.*\.(?:test|spec)\.(?:[cm]?[jt]sx?|mjs)$/i

const AUTH_PRIMITIVES = [
  'requireAuth',
  'hasCapability',
  'hasWorkspaceAdmin',
  'holdsCapabilityFloor',
  'requireCapability',
  'canOnSquad',
  'isOrgAdmin',
]

const RBAC_BYPASS_RE = /\b(?:skipAuth|bypassAuth|AUTH_DISABLED|DISABLE_RBAC|skip_auth|bypass_auth)\b\s*[:=]\s*(?:true|1)/i
const ADDITIONAL_PROPERTIES_TRUE = /additionalProperties\s*:\s*true/

const DROP_SCHEMA_RE = /\bDROP\s+(?:TABLE|COLUMN)\b/i
const RENAME_COLUMN_RE = /\b(?:RENAME\s+COLUMN|ALTER\s+TABLE\b[\s\S]{0,80}\bRENAME\s+TO\b)/i
const MIGRATION_PATH_RE = /(?:^|\/)migrations\/(\d{4})_[^/]+\.sql$/i
const PRODUCTION_MIGRATION_HEAD = 79

export function addedLines(patch: string): string[] {
  return patch.split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++'))
}

export function deletedLines(patch: string): string[] {
  return patch.split(/\r?\n/).filter((line) => line.startsWith('-') && !line.startsWith('---'))
}

export function pathsFromDiff(diff: string): string[] {
  const paths = new Set<string>()
  for (const line of diff.split(/\r?\n/)) {
    const plus = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/)
    if (plus && plus[1] !== '/dev/null') paths.add(plus[1])
    const git = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (git) paths.add(git[1])
  }
  return [...paths]
}

function collectPatches(input: GateReviewInput): Array<{ path: string; patch: string }> {
  const fromFiles = (input.files ?? [])
    .filter((file) => typeof file.path === 'string' && file.path.length > 0)
    .map((file) => ({ path: file.path, patch: typeof file.patch === 'string' ? file.patch : '' }))

  if (fromFiles.length > 0) {
    const withPatches = fromFiles.filter((file) => file.patch.length > 0)
    if (withPatches.length > 0) return fromFiles
    return [{ path: fromFiles.map((file) => file.path).join(','), patch: input.diff }]
  }

  const paths = pathsFromDiff(input.diff)
  if (paths.length === 0) return [{ path: '(diff)', patch: input.diff }]
  return paths.map((path) => ({ path, patch: input.diff }))
}

function isTestPath(path: string): boolean {
  return TEST_FILE_RE.test(path)
}

function scanSecrets(patch: string): string[] {
  const hits: string[] = []
  for (const line of addedLines(patch)) {
    const body = line.slice(1)
    if (ENV_REFERENCE.test(body) || PLACEHOLDER_SECRET.test(body)) continue
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(body)) hits.push(pattern.id)
    }
  }
  return [...new Set(hits)]
}

function checkSecrets(patches: Array<{ path: string; patch: string }>): GateCheck {
  const hits: string[] = []
  for (const file of patches) {
    if (isTestPath(file.path) && /fixtures?|testdata/i.test(file.path)) continue
    hits.push(...scanSecrets(file.patch).map((id) => `${file.path}:${id}`))
  }
  const unique = [...new Set(hits)]
  return {
    id: 'no_hardcoded_secrets',
    name: 'No hardcoded secrets',
    passed: unique.length === 0,
    severity: 'blocker',
    detail: unique.length === 0
      ? 'No credential literals in added lines.'
      : `Hardcoded secret patterns in added lines: ${unique.join(', ')}.`,
  }
}

function checkTests(input: GateReviewInput, files: ReviewFile[], paths: string[]): GateCheck {
  const failed = typeof input.testsFailed === 'number' ? input.testsFailed : 0
  if (failed > 0) {
    return {
      id: 'verified_unit_tests',
      name: 'Verified unit tests',
      passed: false,
      severity: 'blocker',
      detail: `Reported ${failed} failing test${failed === 1 ? '' : 's'}; the gate does not approve a red suite.`,
    }
  }

  const testFiles = [...files.map((file) => file.path), ...paths].filter(isTestPath)
  const present = input.testsPresent === true || testFiles.length > 0
  if (!present) {
    return {
      id: 'verified_unit_tests',
      name: 'Verified unit tests',
      passed: false,
      severity: 'warning',
      detail: 'Diff adds no unit-test files and no test receipt was supplied.',
    }
  }

  const passedCount = typeof input.testsPassed === 'number' ? input.testsPassed : null
  return {
    id: 'verified_unit_tests',
    name: 'Verified unit tests',
    passed: true,
    severity: 'warning',
    detail: passedCount !== null
      ? `Test receipt green (${passedCount} passed).`
      : testFiles.length > 0
        ? `Test files present: ${[...new Set(testFiles)].join(', ')}.`
        : 'Caller attested tests_present=true.',
  }
}

function countPrimitive(lines: string[], primitive: string): number {
  const re = new RegExp(`\\b${primitive}\\b`)
  return lines.reduce((n, line) => n + (re.test(line) ? 1 : 0), 0)
}

function checkRbac(patches: Array<{ path: string; patch: string }>): GateCheck {
  const findings: string[] = []

  for (const file of patches) {
    if (isTestPath(file.path)) continue
    const added = addedLines(file.patch).map((line) => line.slice(1))
    const removed = deletedLines(file.patch).map((line) => line.slice(1))

    for (const primitive of AUTH_PRIMITIVES) {
      const lost = countPrimitive(removed, primitive) - countPrimitive(added, primitive)
      if (lost > 0) findings.push(`${file.path}: removed ${primitive}`)
    }

    for (const line of added) {
      if (RBAC_BYPASS_RE.test(line)) findings.push(`${file.path}: auth bypass flag`)
      if (ADDITIONAL_PROPERTIES_TRUE.test(line) && /inputSchema|ToolSpec|properties/.test(file.patch)) {
        findings.push(`${file.path}: additionalProperties:true on a tool schema`)
      }
    }
  }

  const unique = [...new Set(findings)]
  return {
    id: 'rbac_compliance',
    name: 'RBAC compliance',
    passed: unique.length === 0,
    severity: 'blocker',
    detail: unique.length === 0
      ? 'Capability floors and auth primitives remain intact.'
      : unique.join('; '),
  }
}

function migrationNumber(path: string): number | null {
  const match = path.match(MIGRATION_PATH_RE)
  if (!match) return null
  return Number(match[1])
}

function checkSchema(patches: Array<{ path: string; patch: string }>): GateCheck {
  const findings: string[] = []

  for (const file of patches) {
    const number = migrationNumber(file.path)
    const added = addedLines(file.patch).join('\n')
    const inSql = file.path.endsWith('.sql') || number !== null

    if (number !== null && number <= PRODUCTION_MIGRATION_HEAD) {
      findings.push(`${file.path}: migration numbered ≤ 0079 will never run on production`)
    }
    if (inSql && DROP_SCHEMA_RE.test(added)) {
      findings.push(`${file.path}: DROP TABLE/COLUMN is not backward-compatible`)
    }
    if (inSql && RENAME_COLUMN_RE.test(added)) {
      findings.push(`${file.path}: column/table rename without a compatibility window`)
    }
  }

  const unique = [...new Set(findings)]
  return {
    id: 'schema_backward_compatibility',
    name: 'Schema backward-compatibility',
    passed: unique.length === 0,
    severity: 'blocker',
    detail: unique.length === 0
      ? 'No destructive or silently-skipped schema changes in the diff.'
      : unique.join('; '),
  }
}

export function decideVerdict(checks: GateCheck[]): GateVerdict {
  if (checks.some((check) => !check.passed && check.severity === 'blocker')) return 'BLOCKED'
  if (checks.some((check) => !check.passed)) return 'CHANGES_REQUESTED'
  return 'APPROVED'
}

function summarize(verdict: GateVerdict, checks: GateCheck[], input: GateReviewInput): string {
  const failed = checks.filter((check) => !check.passed)
  const title = input.title?.trim() || 'untitled PR'
  if (verdict === 'APPROVED') {
    return `Athena APPROVED ${title}: secrets, tests, RBAC, and schema checks are clean.`
  }
  const bits = failed.map((check) => `${check.id}: ${check.detail}`)
  return `Athena ${verdict} ${title}. ${bits.join(' ')}`
}

export function reviewPullRequest(input: GateReviewInput): GateReviewResult {
  const diff = typeof input.diff === 'string' ? input.diff : ''
  const files = (input.files ?? []).filter((file) => typeof file.path === 'string' && file.path.length > 0)
  const paths = [...new Set([...files.map((file) => file.path), ...pathsFromDiff(diff)])]
  const patches = collectPatches({ ...input, diff, files })

  const checks: GateCheck[] = [
    checkSecrets(patches),
    checkTests(input, files, paths),
    checkRbac(patches),
    checkSchema(patches),
  ]
  const verdict = decideVerdict(checks)
  return {
    verdict,
    checks,
    summary: summarize(verdict, checks, input),
  }
}

export function isGateVerdict(value: unknown): value is GateVerdict {
  return typeof value === 'string' && (GATE_VERDICTS as readonly string[]).includes(value)
}
