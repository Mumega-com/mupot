// Cursor Cloud Agents API client (v1).
//
// Base: https://api.cursor.com/v1
// Auth: Authorization: Bearer <user or service-account API key>
// Docs: https://cursor.com/docs/cloud-agent/api/endpoints
//
// This module is a typed HTTP client only — it does not create mupot tasks or
// flights. Orchestration lives in ./dispatch.ts and the MCP/studio surfaces.

export const CURSOR_API_BASE = 'https://api.cursor.com/v1'
export const CURSOR_AGENT_DASHBOARD_BASE = 'https://cursor.com/agents'

export type CursorAgentStatus = 'ACTIVE' | 'IDLE' | 'ARCHIVED' | string
export type CursorRunStatus =
  | 'CREATING'
  | 'RUNNING'
  | 'FINISHED'
  | 'ERROR'
  | 'CANCELLED'
  | 'EXPIRED'
  | string

export interface CursorRepoRef {
  url: string
  startingRef?: string
  prUrl?: string
}

export interface CursorGitBranch {
  repoUrl: string
  branch?: string
  prUrl?: string
}

export interface CursorAgent {
  id: string
  name: string
  status: CursorAgentStatus
  url: string
  createdAt: string
  updatedAt: string
  latestRunId?: string
  repos?: CursorRepoRef[]
  workOnCurrentBranch?: boolean
  autoCreatePR?: boolean
  env?: { type?: string; name?: string }
}

export interface CursorRun {
  id: string
  agentId: string
  status: CursorRunStatus
  createdAt: string
  updatedAt: string
  durationMs?: number
  result?: string
  git?: { branches?: CursorGitBranch[] }
}

export interface CursorAgentResult {
  agent: CursorAgent
  run: CursorRun
}

export interface CursorRunResult {
  run: CursorRun
}

export interface CreateCursorAgentOptions {
  name: string
  repoUrl: string
  prompt: string
  model?: string
}

export class CursorApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail?: unknown

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'CursorApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export function cursorAgentUrl(agentId: string): string {
  return `${CURSOR_AGENT_DASHBOARD_BASE}/${encodeURIComponent(agentId)}`
}

function requireToken(token: string): string {
  const trimmed = token.trim()
  if (!trimmed) {
    throw new CursorApiError(401, 'missing_token', 'Cursor API token is required')
  }
  return trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseErrorBody(body: unknown, fallbackStatus: number): CursorApiError {
  if (typeof body === 'string' && body.trim()) {
    return new CursorApiError(fallbackStatus, 'cursor_api_error', body.slice(0, 500))
  }
  if (!isRecord(body)) {
    return new CursorApiError(fallbackStatus, 'cursor_api_error', `Cursor API request failed (${fallbackStatus})`)
  }
  const code = asString(body.error) ?? asString(body.code) ?? asString(body.type) ?? 'cursor_api_error'
  const message = asString(body.message) ?? asString(body.error) ?? `Cursor API request failed (${fallbackStatus})`
  return new CursorApiError(fallbackStatus, code, message, body)
}

function parseRepo(value: unknown): CursorRepoRef | null {
  if (!isRecord(value)) return null
  const url = asString(value.url)
  if (!url) return null
  const repo: CursorRepoRef = { url }
  const startingRef = asString(value.startingRef)
  const prUrl = asString(value.prUrl)
  if (startingRef) repo.startingRef = startingRef
  if (prUrl) repo.prUrl = prUrl
  return repo
}

function parseGit(value: unknown): CursorRun['git'] | undefined {
  if (!isRecord(value) || !Array.isArray(value.branches)) return undefined
  const branches: CursorGitBranch[] = []
  for (const entry of value.branches) {
    if (!isRecord(entry)) continue
    const repoUrl = asString(entry.repoUrl)
    if (!repoUrl) continue
    const branch: CursorGitBranch = { repoUrl }
    const name = asString(entry.branch)
    const prUrl = asString(entry.prUrl)
    if (name) branch.branch = name
    if (prUrl) branch.prUrl = prUrl
    branches.push(branch)
  }
  return { branches }
}

export function parseCursorAgent(value: unknown): CursorAgent {
  if (!isRecord(value)) {
    throw new CursorApiError(502, 'invalid_cursor_agent', 'Cursor agent response was not an object')
  }
  const id = asString(value.id)
  const name = asString(value.name)
  const status = asString(value.status)
  if (!id || !name || !status) {
    throw new CursorApiError(502, 'invalid_cursor_agent', 'Cursor agent response missing id, name, or status', value)
  }
  const repos = Array.isArray(value.repos)
    ? value.repos.map(parseRepo).filter((repo): repo is CursorRepoRef => repo !== null)
    : undefined
  return {
    id,
    name,
    status,
    url: asString(value.url) ?? cursorAgentUrl(id),
    createdAt: asString(value.createdAt) ?? '',
    updatedAt: asString(value.updatedAt) ?? '',
    latestRunId: asString(value.latestRunId),
    repos,
    workOnCurrentBranch: typeof value.workOnCurrentBranch === 'boolean' ? value.workOnCurrentBranch : undefined,
    autoCreatePR: typeof value.autoCreatePR === 'boolean' ? value.autoCreatePR : undefined,
    env: isRecord(value.env) ? { type: asString(value.env.type), name: asString(value.env.name) } : undefined,
  }
}

export function parseCursorRun(value: unknown, fallbackAgentId?: string): CursorRun {
  if (!isRecord(value)) {
    throw new CursorApiError(502, 'invalid_cursor_run', 'Cursor run response was not an object')
  }
  const id = asString(value.id)
  const status = asString(value.status)
  const agentId = asString(value.agentId) ?? fallbackAgentId
  if (!id || !status || !agentId) {
    throw new CursorApiError(502, 'invalid_cursor_run', 'Cursor run response missing id, agentId, or status', value)
  }
  return {
    id,
    agentId,
    status,
    createdAt: asString(value.createdAt) ?? '',
    updatedAt: asString(value.updatedAt) ?? '',
    durationMs: asNumber(value.durationMs),
    result: asString(value.result),
    git: parseGit(value.git),
  }
}

function parseAgentResult(value: unknown): CursorAgentResult {
  if (!isRecord(value)) {
    throw new CursorApiError(502, 'invalid_cursor_agent_result', 'Cursor create-agent response was not an object')
  }
  const agent = parseCursorAgent(value.agent ?? value)
  const runSource = isRecord(value.run) ? value.run : value
  const run = parseCursorRun(runSource, agent.id)
  return { agent, run }
}

function parseRunResult(value: unknown, fallbackAgentId: string): CursorRunResult {
  if (!isRecord(value)) {
    throw new CursorApiError(502, 'invalid_cursor_run_result', 'Cursor run response was not an object')
  }
  const run = parseCursorRun(isRecord(value.run) ? value.run : value, fallbackAgentId)
  return { run }
}

async function cursorRequest(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const secret = requireToken(token)
  const url = `${CURSOR_API_BASE}${path.startsWith('/') ? path : `/${path}`}`
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${secret}`)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(url, { ...init, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network_error'
    throw new CursorApiError(503, 'cursor_unreachable', message)
  }

  const text = await response.text()
  let body: unknown = null
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    throw parseErrorBody(body, response.status)
  }
  return body
}

export async function createCursorAgent(
  token: string,
  options: CreateCursorAgentOptions,
): Promise<CursorAgentResult> {
  const name = options.name.trim()
  const repoUrl = options.repoUrl.trim()
  const prompt = options.prompt.trim()
  if (!name) throw new CursorApiError(400, 'invalid_args', 'name is required')
  if (!repoUrl) throw new CursorApiError(400, 'invalid_args', 'repoUrl is required')
  if (!prompt) throw new CursorApiError(400, 'invalid_args', 'prompt is required')

  const payload: Record<string, unknown> = {
    name: name.slice(0, 100),
    prompt: { text: prompt },
    repos: [{ url: repoUrl }],
  }
  const model = options.model?.trim()
  if (model) payload.model = { id: model }

  const body = await cursorRequest(token, '/agents', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseAgentResult(body)
}

export async function dispatchCursorRun(
  token: string,
  agentId: string,
  prompt: string,
): Promise<CursorRunResult> {
  const id = agentId.trim()
  const text = prompt.trim()
  if (!id) throw new CursorApiError(400, 'invalid_args', 'agentId is required')
  if (!text) throw new CursorApiError(400, 'invalid_args', 'prompt is required')

  const body = await cursorRequest(token, `/agents/${encodeURIComponent(id)}/runs`, {
    method: 'POST',
    body: JSON.stringify({ prompt: { text } }),
  })
  return parseRunResult(body, id)
}

export async function getCursorAgent(token: string, agentId: string): Promise<CursorAgent> {
  const id = agentId.trim()
  if (!id) throw new CursorApiError(400, 'invalid_args', 'agentId is required')
  const body = await cursorRequest(token, `/agents/${encodeURIComponent(id)}`)
  return parseCursorAgent(body)
}

export async function getCursorRun(
  token: string,
  agentId: string,
  runId: string,
): Promise<CursorRun> {
  const id = agentId.trim()
  const run = runId.trim()
  if (!id) throw new CursorApiError(400, 'invalid_args', 'agentId is required')
  if (!run) throw new CursorApiError(400, 'invalid_args', 'runId is required')
  const body = await cursorRequest(token, `/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(run)}`)
  return parseCursorRun(body, id)
}

export function resolveCursorApiToken(env: {
  CURSOR_API_TOKEN?: string
  CURSOR_API_KEY?: string
}): string | null {
  const token = env.CURSOR_API_TOKEN?.trim() || env.CURSOR_API_KEY?.trim()
  return token || null
}
