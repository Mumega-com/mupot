// src/athena/webhook.ts — GitHub pull_request → Athena gate (comment + status + D1).
//
// SECURITY SURFACE — unauthenticated by session; authenticated ONLY by:
//   1. HMAC-SHA256 of the raw body (`x-hub-signature-256: sha256=<hex>`) when
//      `GITHUB_WEBHOOK_SECRET` is configured, or
//   2. fail-safe bearer verification against `GITHUB_TOKEN` when the HMAC secret
//      is unset (manual / test callers). Never process an unsigned payload.
//
// Same fail-closed discipline as src/integrations/github-routes.ts:
//   - neither secret nor token → 503
//   - bad/missing proof → 401, no parse, no D1 write, no GitHub egress
//
// On a verified `pull_request` {opened, synchronize, reopened} the handler:
//   1. extracts PR number / repo / head SHA / author / files
//   2. runs the pure reviewer (src/athena/reviewer.ts)
//   3. appends an immutable D1 receipt (always)
//   4. when `GITHUB_TOKEN` is set, posts the Markdown audit comment and a
//      commit status check (`athena/gate`)

import { timingSafeEqual } from '../lib/crypto'
import { verifyGitHubWebhook } from '../integrations/github-routes'
import {
  isGateVerdict,
  reviewPullRequest,
  type GateCheck,
  type GateReviewResult,
  type GateVerdict,
  type ReviewFile,
} from './reviewer'
import type { Env } from '../types'

export const ATHENA_WEBHOOK_MAX_BODY_BYTES = 256 * 1024
export const ATHENA_GATE_STATUS_CONTEXT = 'athena/gate'
export const ATHENA_PR_ACTIONS = ['opened', 'synchronize', 'reopened'] as const

const GITHUB_API = 'https://api.github.com'
const TITLE_MAX = 200
const SHA_RE = /^[0-9a-f]{7,64}$/i
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const LOGIN_RE = /^[A-Za-z0-9._-]{1,80}$/

export type AthenaPrAction = (typeof ATHENA_PR_ACTIONS)[number]

export interface AthenaWebhookDeps {
  fetchImpl?: typeof fetch
  now?: () => string
  id?: () => string
}

export interface AthenaPullRequestEvent {
  action: AthenaPrAction
  repo: string
  owner: string
  name: string
  prNumber: number
  commitSha: string
  author: string
  title: string
  body: string
  prUrl: string
  files: ReviewFile[]
  diff: string
}

export interface AthenaGateReceipt {
  id: string
  repo: string
  pr_number: number
  commit_sha: string
  verdict: GateVerdict
  checks_json: string
  summary: string
  created_at: string
}

export interface AthenaGateHandleResult {
  status: number
  body: Record<string, unknown>
}

export async function verifyAthenaGitHubWebhook(
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
  authorizationHeader: string | null = null,
): Promise<'not_configured' | 'invalid' | 'ok'> {
  const hmac = await verifyGitHubWebhook(env, rawBody, signatureHeader)
  if (hmac === 'ok' || hmac === 'invalid') return hmac

  // Fail-safe token path: HMAC secret unset. Accept Authorization: Bearer
  // matching GITHUB_TOKEN so a configured outbound token can still prove the
  // caller. GitHub itself always uses HMAC when a webhook secret is set.
  const token = typeof env.GITHUB_TOKEN === 'string' ? env.GITHUB_TOKEN : ''
  if (!token) return 'not_configured'
  const auth = authorizationHeader ?? ''
  const provided = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : ''
  if (!provided || !timingSafeEqual(provided, token)) return 'invalid'
  return 'ok'
}

function safeField(value: unknown, max = 120): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[@#`[\]]/g, ' ').replace(/]\(/g, '] (').slice(0, max).trim()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readFiles(value: unknown): ReviewFile[] {
  if (!Array.isArray(value)) return []
  const files: ReviewFile[] = []
  for (const item of value) {
    const row = asRecord(item)
    if (!row) continue
    const path = typeof row.path === 'string' && row.path
      ? row.path
      : typeof row.filename === 'string' ? row.filename : ''
    if (!path || path.length > 512) continue
    const file: ReviewFile = { path }
    if (typeof row.patch === 'string') file.patch = row.patch
    if (typeof row.status === 'string') file.status = row.status
    files.push(file)
    if (files.length >= 200) break
  }
  return files
}

function isAthenaPrAction(value: string): value is AthenaPrAction {
  return (ATHENA_PR_ACTIONS as readonly string[]).includes(value)
}

export function extractAthenaPullRequest(
  eventType: string,
  payload: Record<string, unknown>,
): AthenaPullRequestEvent | null {
  if (eventType !== 'pull_request') return null
  const action = typeof payload.action === 'string' ? payload.action : ''
  if (!isAthenaPrAction(action)) return null

  const pr = asRecord(payload.pull_request)
  const repoObj = asRecord(payload.repository)
  if (!pr || !repoObj) return null

  const prNumber = pr.number
  if (!Number.isInteger(prNumber) || (prNumber as number) <= 0) return null

  const head = asRecord(pr.head)
  const commitSha = typeof head?.sha === 'string' ? head.sha.trim() : ''
  if (!SHA_RE.test(commitSha)) return null

  const fullName = typeof repoObj.full_name === 'string' ? repoObj.full_name.trim() : ''
  if (!REPO_RE.test(fullName)) return null
  const [owner, name] = fullName.split('/')
  if (!owner || !name) return null

  const user = asRecord(pr.user)
  const login = typeof user?.login === 'string' ? user.login.trim() : ''
  const author = LOGIN_RE.test(login) ? login : 'unknown'

  const files = readFiles(pr.files ?? payload.files)
  const diff = typeof pr.diff === 'string'
    ? pr.diff
    : typeof payload.diff === 'string' ? payload.diff : ''

  return {
    action,
    repo: fullName,
    owner,
    name,
    prNumber: prNumber as number,
    commitSha,
    author,
    title: safeField(pr.title, TITLE_MAX),
    body: typeof pr.body === 'string' ? pr.body.slice(0, 4000) : '',
    prUrl: typeof pr.html_url === 'string' ? pr.html_url.slice(0, 300) : '',
    files,
    diff: diff.slice(0, ATHENA_WEBHOOK_MAX_BODY_BYTES),
  }
}

function checkBadge(check: GateCheck): string {
  if (check.passed) return '✅'
  return check.severity === 'blocker' ? '🚫' : '⚠️'
}

function verdictBadge(verdict: GateVerdict): string {
  if (verdict === 'APPROVED') return '✅'
  if (verdict === 'BLOCKED') return '🚫'
  return '⚠️'
}

export function formatAthenaGateComment(
  review: GateReviewResult,
  meta: Pick<AthenaPullRequestEvent, 'repo' | 'prNumber' | 'commitSha' | 'author' | 'title' | 'files'>,
): string {
  const lines = [
    `### 🛡️ Athena Gate Verdict: [ ${review.verdict} ] ${verdictBadge(review.verdict)}`,
    '',
    `**PR** #${meta.prNumber} · \`${safeField(meta.repo, 80)}\` @ \`${safeField(meta.commitSha, 64)}\` · ${safeField(meta.author, 80)}`,
    meta.title ? `**Title:** ${safeField(meta.title, TITLE_MAX)}` : '',
    '',
    '#### Checklist',
    '',
  ].filter((line) => line !== undefined)

  for (const check of review.checks) {
    lines.push(`- ${checkBadge(check)} **${check.name}** — ${safeField(check.detail, 400)}`)
  }

  const paths = [...new Set(meta.files.map((file) => file.path))].slice(0, 20)
  if (paths.length > 0) {
    lines.push('', `**Files:** ${paths.map((path) => `\`${safeField(path, 120)}\``).join(', ')}`)
  }

  lines.push('', `**Summary:** ${safeField(review.summary, 500)}`)
  lines.push('', `_Immutable receipt logged for \`${safeField(meta.repo, 80)}\`#${meta.prNumber} @ \`${safeField(meta.commitSha, 64)}\`._`)
  return lines.filter((line) => line !== null).join('\n')
}

export function githubStatusForVerdict(verdict: GateVerdict): {
  state: 'success' | 'failure'
  description: string
} {
  if (verdict === 'APPROVED') {
    return { state: 'success', description: 'Athena APPROVED — secrets, tests, RBAC, schema clean.' }
  }
  if (verdict === 'BLOCKED') {
    return { state: 'failure', description: 'Athena BLOCKED — a blocker safety rule failed.' }
  }
  return { state: 'failure', description: 'Athena CHANGES_REQUESTED — fix the warned checks.' }
}

function githubHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mupot-athena-gate',
    ...extra,
  }
}

async function githubJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  if (!response.ok) return null
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('json')) return response.json()
  return response.text()
}

export async function fetchPullRequestReviewMaterial(
  event: AthenaPullRequestEvent,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ files: ReviewFile[]; diff: string }> {
  let files = event.files
  let diff = event.diff

  if (files.length === 0) {
    const listed = await githubJson(
      fetchImpl,
      `${GITHUB_API}/repos/${event.owner}/${event.name}/pulls/${event.prNumber}/files?per_page=100`,
      token,
    )
    files = readFiles(listed)
  }

  if (!diff) {
    const response = await fetchImpl(
      `${GITHUB_API}/repos/${event.owner}/${event.name}/pulls/${event.prNumber}`,
      { headers: githubHeaders(token, { Accept: 'application/vnd.github.diff' }) },
    )
    if (response.ok) {
      const text = await response.text()
      if (typeof text === 'string') diff = text.slice(0, ATHENA_WEBHOOK_MAX_BODY_BYTES)
    }
  }

  return { files, diff }
}

export async function persistAthenaGateReceipt(
  env: Env,
  input: Omit<AthenaGateReceipt, 'created_at'> & { created_at?: string },
): Promise<{ id: string; inserted: boolean }> {
  const createdAt = input.created_at ?? new Date().toISOString()
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO athena_gate_receipts
       (id, repo, pr_number, commit_sha, verdict, checks_json, summary, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      input.id,
      input.repo,
      input.pr_number,
      input.commit_sha,
      input.verdict,
      input.checks_json,
      input.summary,
      createdAt,
    )
    .run()

  const inserted = (result.meta?.changes ?? 0) === 1
  if (inserted) return { id: input.id, inserted: true }

  const existing = await env.DB.prepare(
    `SELECT id FROM athena_gate_receipts
      WHERE repo = ?1 AND pr_number = ?2 AND commit_sha = ?3
      LIMIT 1`,
  )
    .bind(input.repo, input.pr_number, input.commit_sha)
    .first<{ id: string }>()

  return { id: existing?.id ?? input.id, inserted: false }
}

export async function listAthenaGateReceipts(
  env: Env,
  limit = 50,
): Promise<AthenaGateReceipt[]> {
  const capped = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50
  const rs = await env.DB.prepare(
    `SELECT id, repo, pr_number, commit_sha, verdict, checks_json, summary, created_at
       FROM athena_gate_receipts
      ORDER BY created_at DESC, id DESC
      LIMIT ?1`,
  )
    .bind(capped)
    .all<AthenaGateReceipt>()
  return (rs.results ?? []).filter((row) => isGateVerdict(row.verdict))
}

async function postGitHubCommentAndStatus(
  event: AthenaPullRequestEvent,
  review: GateReviewResult,
  comment: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ commented: boolean; statusSet: boolean }> {
  const commentRes = await fetchImpl(
    `${GITHUB_API}/repos/${event.owner}/${event.name}/issues/${event.prNumber}/comments`,
    {
      method: 'POST',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: comment }),
    },
  )

  const status = githubStatusForVerdict(review.verdict)
  const statusRes = await fetchImpl(
    `${GITHUB_API}/repos/${event.owner}/${event.name}/statuses/${event.commitSha}`,
    {
      method: 'POST',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: status.state,
        description: status.description.slice(0, 140),
        context: ATHENA_GATE_STATUS_CONTEXT,
        target_url: event.prUrl || undefined,
      }),
    },
  )

  return { commented: commentRes.ok, statusSet: statusRes.ok }
}

export async function handleAthenaGitHubWebhook(
  env: Env,
  request: Request,
  deps: AthenaWebhookDeps = {},
): Promise<AthenaGateHandleResult> {
  const declaredLen = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > ATHENA_WEBHOOK_MAX_BODY_BYTES) {
    return { status: 413, body: { error: 'payload_too_large' } }
  }

  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return { status: 400, body: { error: 'invalid_body' } }
  }
  if (new TextEncoder().encode(rawBody).byteLength > ATHENA_WEBHOOK_MAX_BODY_BYTES) {
    return { status: 413, body: { error: 'payload_too_large' } }
  }

  const verify = await verifyAthenaGitHubWebhook(
    env,
    rawBody,
    request.headers.get('x-hub-signature-256'),
    request.headers.get('authorization'),
  )
  if (verify === 'not_configured') return { status: 503, body: { error: 'not_configured' } }
  if (verify === 'invalid') return { status: 401, body: { error: 'unauthorized' } }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return { status: 400, body: { error: 'invalid_json' } }
  }

  const eventType = request.headers.get('x-github-event') ?? 'unknown'
  const event = extractAthenaPullRequest(eventType, payload)
  if (!event) {
    return { status: 200, body: { ok: true, ignored: eventType } }
  }

  const token = typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN ? env.GITHUB_TOKEN : ''
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis)

  let files = event.files
  let diff = event.diff
  if (token && (files.length === 0 || !diff)) {
    try {
      const material = await fetchPullRequestReviewMaterial(event, token, fetchImpl)
      files = material.files
      diff = material.diff
    } catch {
      // Review with whatever the payload already carried. Receipt still lands.
    }
  }

  const review = reviewPullRequest({
    title: event.title,
    body: event.body,
    diff,
    files,
    prUrl: event.prUrl,
  })

  const receiptId = deps.id?.() ?? crypto.randomUUID()
  const createdAt = deps.now?.() ?? new Date().toISOString()
  let persisted: { id: string; inserted: boolean }
  try {
    persisted = await persistAthenaGateReceipt(env, {
      id: receiptId,
      repo: event.repo,
      pr_number: event.prNumber,
      commit_sha: event.commitSha,
      verdict: review.verdict,
      checks_json: JSON.stringify(review.checks),
      summary: review.summary,
      created_at: createdAt,
    })
  } catch {
    return { status: 503, body: { error: 'receipt_unavailable' } }
  }

  const comment = formatAthenaGateComment(review, { ...event, files })
  let commented = false
  let statusSet = false
  if (token && persisted.inserted) {
    try {
      const posted = await postGitHubCommentAndStatus(event, review, comment, token, fetchImpl)
      commented = posted.commented
      statusSet = posted.statusSet
    } catch {
      // Receipt is the durable verdict. GitHub egress is best-effort.
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      verdict: review.verdict,
      summary: review.summary,
      checks: review.checks,
      comment,
      receipt_id: persisted.id,
      duplicate: !persisted.inserted,
      commented,
      status_set: statusSet,
      repo: event.repo,
      pr_number: event.prNumber,
      commit_sha: event.commitSha,
      author: event.author,
      files: files.map((file) => file.path),
    },
  }
}
