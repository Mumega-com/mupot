// KayHermes Hermes Sessions API client — pure upstream helper for the owner chat panel.
//
// Pattern: Open WebUI / LobeChat talk to Hermes via the OpenAI-compatible API server.
// We use the Sessions REST surface (`/api/sessions*`) so Mupot can list real Hermes
// chat history and run turns without embedding the Hermes TUI.
//
// Security: KAYHERMES_API_URL is env-sourced and MUST pass assertPublicHttpsUrl
// (Cloudflare Worker cannot reach VPS loopback anyway). The API key never leaves
// the Worker.

import { assertPublicHttpsUrl } from '../lib/ssrf'
import type { Env } from '../types'

export class KayhermesClientError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'KayhermesClientError'
    this.code = code
    this.status = status
  }
}

export interface KayhermesSession {
  id: string
  title: string | null
  source: string | null
  updated_at: string | null
  message_count: number | null
}

export interface KayhermesMessage {
  role: string
  content: string
}

export interface KayhermesConfig {
  baseUrl: string
  apiKey: string
  /** Optional member-scoped Hermes memory key (Open WebUI / IM). Never use owner key as identity. */
  sessionKey: string | null
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_INPUT_CHARS = 8000

export function kayhermesConfigured(env: Env): boolean {
  return Boolean(env.KAYHERMES_API_URL?.trim() && env.KAYHERMES_API_KEY?.trim())
}

/** Resolve + validate env. Throws KayhermesClientError on missing/invalid config. */
export function resolveKayhermesConfig(env: Env): KayhermesConfig {
  const rawUrl = env.KAYHERMES_API_URL?.trim()
  const apiKey = env.KAYHERMES_API_KEY?.trim()
  if (!rawUrl || !apiKey) {
    throw new KayhermesClientError('not_configured', 503, 'KAYHERMES_API_URL and KAYHERMES_API_KEY required')
  }
  let base: URL
  try {
    base = assertPublicHttpsUrl(rawUrl)
  } catch (e) {
    const code = e instanceof Error ? e.message : 'url_invalid'
    throw new KayhermesClientError(code, 503, `invalid KAYHERMES_API_URL: ${code}`)
  }
  return { baseUrl: base.toString().replace(/\/$/, ''), apiKey, sessionKey: null }
}

export function assertSessionId(raw: string): string {
  const id = raw.trim()
  if (!SESSION_ID_RE.test(id)) {
    throw new KayhermesClientError('invalid_session_id', 400, 'session id rejected')
  }
  return id
}

export function assertChatInput(raw: string): string {
  const text = raw.trim()
  if (!text) throw new KayhermesClientError('empty_input', 400, 'input required')
  if (text.length > MAX_INPUT_CHARS) {
    throw new KayhermesClientError('input_too_large', 413, `input exceeds ${MAX_INPUT_CHARS} chars`)
  }
  return text
}

function authHeaders(config: KayhermesConfig): HeadersInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    accept: 'application/json',
  }
  if (config.sessionKey) {
    headers['X-Hermes-Session-Key'] = config.sessionKey
  }
  return headers
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new KayhermesClientError('bad_upstream_json', 502, 'upstream returned non-JSON')
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function pickString(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = rec[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function pickNumber(rec: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const v = rec[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

export function normalizeSession(raw: unknown): KayhermesSession | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const id = pickString(rec, ['id', 'session_id'])
  if (!id || !SESSION_ID_RE.test(id)) return null
  return {
    id,
    title: pickString(rec, ['title', 'name']),
    source: pickString(rec, ['source', 'channel', 'platform']),
    updated_at: pickString(rec, ['updated_at', 'last_active', 'updatedAt']),
    message_count: pickNumber(rec, ['message_count', 'messages', 'messageCount']),
  }
}

export function normalizeSessionsPayload(payload: unknown): KayhermesSession[] {
  const rec = asRecord(payload)
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(rec?.sessions)
      ? rec.sessions
      : Array.isArray(rec?.items)
        ? rec.items
        : Array.isArray(rec?.data)
          ? rec.data
          : []
  const out: KayhermesSession[] = []
  for (const item of list) {
    const session = normalizeSession(item)
    if (session) out.push(session)
  }
  return out
}

export function normalizeMessagesPayload(payload: unknown): KayhermesMessage[] {
  const rec = asRecord(payload)
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(rec?.messages)
      ? rec.messages
      : Array.isArray(rec?.items)
        ? rec.items
        : Array.isArray(rec?.data)
          ? rec.data
          : []
  const out: KayhermesMessage[] = []
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const role = pickString(row, ['role', 'sender', 'type']) ?? 'unknown'
    const contentRaw = row.content ?? row.text ?? row.body
    let content = ''
    if (typeof contentRaw === 'string') content = contentRaw
    else if (Array.isArray(contentRaw)) {
      content = contentRaw
        .map((part) => {
          const p = asRecord(part)
          if (!p) return ''
          const t = pickString(p, ['text', 'content', 'output_text'])
          return t ?? ''
        })
        .filter(Boolean)
        .join('\n')
    }
    if (!content.trim() && role === 'unknown') continue
    out.push({ role, content })
  }
  return out
}

export function extractChatReply(payload: unknown): string {
  const rec = asRecord(payload)
  if (!rec) return ''
  const direct = pickString(rec, ['reply', 'output', 'content', 'text'])
  if (direct) return direct
  const message = asRecord(rec.message)
  if (message) {
    const nested = pickString(message, ['content', 'text'])
    if (nested) return nested
  }
  const choices = rec.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const first = asRecord(choices[0])
    const msg = asRecord(first?.message)
    const nested = msg ? pickString(msg, ['content', 'text']) : null
    if (nested) return nested
  }
  return ''
}

/**
 * Outbound Hermes fetch. Always uses `redirect: 'manual'` and refuses 3xx /
 * opaqueredirect — assertPublicHttpsUrl only validates the configured origin at
 * parse time; default redirect-following would chase Location to an internal
 * target (same class as #528 / cmsFetch).
 */
async function upstream(
  config: KayhermesConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const url = `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  let res: Response
  try {
    res = await fetch(url, { ...init, redirect: 'manual' })
  } catch {
    throw new KayhermesClientError('unreachable', 502, 'kayhermes API unreachable')
  }
  // `as string`: workers-types narrows Response.type to "default"|"error"; vitest/undici
  // mocks may carry 'opaqueredirect'.
  const resType = res.type as string
  if (resType === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new KayhermesClientError('redirect_blocked', 502, 'kayhermes upstream redirect refused')
  }
  return res
}

async function expectOk(res: Response): Promise<unknown> {
  const body = await readJson(res)
  if (res.ok) return body
  const rec = asRecord(body)
  const detail = rec ? pickString(rec, ['error', 'detail', 'message']) : null
  throw new KayhermesClientError(
    'upstream_error',
    res.status >= 400 && res.status < 600 ? res.status : 502,
    detail ?? `upstream HTTP ${res.status}`,
  )
}

export async function listSessions(
  config: KayhermesConfig,
  opts: { limit: number; offset: number },
): Promise<KayhermesSession[]> {
  const qs = new URLSearchParams({
    limit: String(opts.limit),
    offset: String(opts.offset),
  })
  const res = await upstream(config, `/api/sessions?${qs.toString()}`, {
    method: 'GET',
    headers: authHeaders(config),
  })
  const body = await expectOk(res)
  return normalizeSessionsPayload(body)
}

export async function createSession(
  config: KayhermesConfig,
  title: string | null,
): Promise<KayhermesSession> {
  const res = await upstream(config, '/api/sessions', {
    method: 'POST',
    headers: {
      ...authHeaders(config),
      'content-type': 'application/json',
    },
    body: JSON.stringify(title ? { title } : {}),
  })
  const body = await expectOk(res)
  const session = normalizeSession(body) ?? normalizeSession(asRecord(body)?.session)
  if (!session) throw new KayhermesClientError('bad_upstream_session', 502, 'create returned no session id')
  return session
}

export async function listMessages(
  config: KayhermesConfig,
  sessionId: string,
): Promise<KayhermesMessage[]> {
  const id = assertSessionId(sessionId)
  const res = await upstream(config, `/api/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'GET',
    headers: authHeaders(config),
  })
  const body = await expectOk(res)
  return normalizeMessagesPayload(body)
}

export async function chatTurn(
  config: KayhermesConfig,
  sessionId: string,
  input: string,
): Promise<{ session_id: string; reply: string }> {
  const id = assertSessionId(sessionId)
  const text = assertChatInput(input)
  const res = await upstream(config, `/api/sessions/${encodeURIComponent(id)}/chat`, {
    method: 'POST',
    headers: {
      ...authHeaders(config),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ input: text }),
  })
  const body = await expectOk(res)
  return { session_id: id, reply: extractChatReply(body) || '(empty reply)' }
}

export async function probeHealth(config: KayhermesConfig): Promise<{ ok: boolean; detail: string }> {
  const res = await upstream(config, '/health', {
    method: 'GET',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) return { ok: false, detail: `health_${res.status}` }
  return { ok: true, detail: 'ok' }
}
