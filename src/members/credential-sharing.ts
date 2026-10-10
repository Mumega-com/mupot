// mupot#1794 W4 — shared-credential detection. READ-ONLY OBSERVABILITY: nothing here is consulted by
// authentication, authorization, rate limits or any write path other than its own table.
//
// THE DEFECT CLASS: an identity derived from a credential, where the credential is shared by many
// actors (one token in a Codex cloud env secret / CI / a shared .env / one MCP config inside Cursor or
// Grok bots). Every thread behind it collapses into one agent. This module notices the shape and lets
// boot_context say so in plain words; the cure is a harness token or the harness OAuth option plus
// seat_select (src/members/harness-token.ts, src/members/seat-select.ts).
//
// WHAT IS RECORDED (per credential, per session fingerprint):
//   fp   32-hex hash of {credential id, Mcp-Session-Id, client thread hints (Codex threadId,
//        openai/session), user-agent FAMILY}. It is a COUNTER KEY, never an identity: it is not used to
//        select or authorise anything (spec 2026-07-28 removes Mcp-Session-Id; a server must not use
//        sessions for authn). The raw inputs are never stored.
//   labels: clientInfo name/version (only when the request's _meta carries them) and the UA family,
//        all sanitised and length-capped. No IP, no raw user-agent, no raw session id.
//
// FLAG DECISION: this is behind its OWN default-off flag SHARED_CREDENTIAL_DETECT === '1', not riding
// SEAT_AUTO_ENROLL. It adds a (throttled) D1 write to the request path for EVERY credential, agent-bound
// tokens included, so flag-off must mean "no extra query, no extra write, no new response field"
// (byte-identical for existing clients). Tying it to SEAT_AUTO_ENROLL would make turning on seat
// enrolment silently change the write profile of every legacy credential. The two flags compose: the
// hint names seat_select only when seat enrolment is actually on.
//
// WRITE: ONE atomic upsert per fingerprint (hits = hits + 1, no KV and no read-compare-put), batched
// with a prune of this credential's rows older than an hour. At most CRED_FP_MAX_ROWS rows per
// credential, enforced inside the statement. An isolate-local memo only REDUCES write volume (a
// fingerprint already written in the last 30s is skipped); it is not a correctness mechanism.

import type { Env } from '../types'
import { sanitizeLabel } from './harness'

export const CRED_FP_WINDOW_MS = 15 * 60 * 1000 // "concurrent" = seen within this window
export const CRED_FP_PRUNE_AFTER_MS = 60 * 60 * 1000
export const CRED_FP_MAX_ROWS = 64
export const CRED_FP_THRESHOLD_DEFAULT = 3
const CRED_FP_MEMO_MS = 30 * 1000
const CRED_FP_MEMO_MAX = 4000

export function sharedCredentialDetectEnabled(env: Pick<Env, 'SHARED_CREDENTIAL_DETECT'>): boolean {
  return env.SHARED_CREDENTIAL_DETECT === '1'
}

/** SHARED_CREDENTIAL_MAX_SESSIONS: more than this many distinct fingerprints in the window marks the
 *  credential shared_suspected. Garbage / <2 -> default 3, clamped to 64. */
export function sharedCredentialThreshold(env: Pick<Env, 'SHARED_CREDENTIAL_MAX_SESSIONS'>): number {
  const raw = env.SHARED_CREDENTIAL_MAX_SESSIONS
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw.trim())) return CRED_FP_THRESHOLD_DEFAULT
  const n = parseInt(raw.trim(), 10)
  if (n < 2) return CRED_FP_THRESHOLD_DEFAULT
  return Math.min(n, CRED_FP_MAX_ROWS)
}

// Bounded vocabulary: the raw user-agent string is never stored, only which family it looks like.
const UA_FAMILIES: ReadonlyArray<readonly [string, RegExp]> = [
  ['claude-code', /claude-code|claude code/i],
  ['claude', /claude|anthropic/i],
  ['cursor', /cursor/i],
  ['codex', /codex/i],
  ['openai', /openai|chatgpt/i],
  ['grok', /grok|xai/i],
  ['vscode', /vscode|visual studio code/i],
  ['node', /^node|undici/i],
  ['python', /python|httpx|aiohttp|requests/i],
  ['go', /^go-http/i],
  ['curl', /^curl/i],
  ['browser', /^mozilla/i],
]

export function uaFamily(ua: string | null | undefined): string {
  if (typeof ua !== 'string' || ua.length === 0) return 'none'
  for (const [family, re] of UA_FAMILIES) if (re.test(ua)) return family
  return 'other'
}

export interface SessionFingerprintInputs {
  mcpSessionId?: string | null
  codexThreadId?: string | null
  openaiSession?: string | null
  userAgent?: string | null
  clientName?: string | null
  clientVersion?: string | null
}

async function sha256Hex32(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

/** Pull clientInfo name/version out of a `_meta` object when the client sends them there. */
export function clientInfoFromMeta(meta: unknown): { name: string | null; version: string | null } {
  const m = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? meta as Record<string, unknown> : {}
  const raw = m['clientInfo'] ?? m['io.modelcontextprotocol/clientInfo']
  const ci = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
  return { name: ci ? s(ci['name']) : null, version: ci ? s(ci['version']) : null }
}

export interface FingerprintRow {
  tokenId: string
  fp: string
  clientName: string
  clientVersion: string
  uaFamily: string
}

export async function buildFingerprint(tokenId: string, i: SessionFingerprintInputs): Promise<FingerprintRow> {
  const family = uaFamily(i.userAgent)
  const fp = await sha256Hex32(
    ['mupot:cred-fp:v1', tokenId, i.mcpSessionId ?? '', i.codexThreadId ?? '', i.openaiSession ?? '', family].join('\u001f'),
  )
  return {
    tokenId,
    fp,
    clientName: sanitizeLabel(i.clientName ?? '', 40),
    clientVersion: sanitizeLabel(i.clientVersion ?? '', 24),
    uaFamily: family,
  }
}

/**
 * The atomic write. One batch, two statements: prune this credential's stale rows, then ONE upsert.
 * The upsert inserts a new fingerprint only while the credential holds fewer than CRED_FP_MAX_ROWS rows
 * (an existing fingerprint always updates), and bumps `hits` in SQL — never read-then-write.
 * Exported without the memo so tests can hammer it; request code uses recordCredentialSession.
 */
export async function upsertCredentialFingerprint(env: Env, row: FingerprintRow, nowMs: number): Promise<void> {
  const now = new Date(nowMs).toISOString()
  const pruneBefore = new Date(nowMs - CRED_FP_PRUNE_AFTER_MS).toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM credential_session_fingerprints WHERE tenant = ?1 AND token_id = ?2 AND last_seen < ?3`,
    ).bind(env.TENANT_SLUG, row.tokenId, pruneBefore),
    env.DB.prepare(
      `INSERT INTO credential_session_fingerprints
         (tenant, token_id, fp, client_name, client_version, ua_family, first_seen, last_seen, hits)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 1
        WHERE (SELECT COUNT(*) FROM credential_session_fingerprints WHERE tenant = ?1 AND token_id = ?2) < ?8
           OR EXISTS (SELECT 1 FROM credential_session_fingerprints WHERE tenant = ?1 AND token_id = ?2 AND fp = ?3)
       ON CONFLICT (tenant, token_id, fp) DO UPDATE SET
         last_seen = excluded.last_seen,
         hits = credential_session_fingerprints.hits + 1,
         client_name = CASE WHEN excluded.client_name <> '' THEN excluded.client_name ELSE credential_session_fingerprints.client_name END,
         client_version = CASE WHEN excluded.client_version <> '' THEN excluded.client_version ELSE credential_session_fingerprints.client_version END`,
    ).bind(env.TENANT_SLUG, row.tokenId, row.fp, row.clientName, row.clientVersion, row.uaFamily, now, CRED_FP_MAX_ROWS),
  ])
}

const memo = new Map<string, number>()

/** Test seam: forget the write-reduction memo. */
export function resetCredentialSessionMemo(): void {
  memo.clear()
}

/**
 * Record one request's session fingerprint against its credential. Flag off => returns before any
 * read or write. NEVER throws and never alters the request: observability only.
 */
export async function recordCredentialSession(
  env: Env,
  tokenId: string | null | undefined,
  inputs: SessionFingerprintInputs,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!sharedCredentialDetectEnabled(env)) return
  if (typeof tokenId !== 'string' || tokenId.length === 0 || tokenId.length > 128) return
  try {
    const row = await buildFingerprint(tokenId, inputs)
    const key = `${row.tokenId}:${row.fp}`
    const last = memo.get(key)
    if (last !== undefined && nowMs - last < CRED_FP_MEMO_MS) return
    if (memo.size >= CRED_FP_MEMO_MAX) memo.clear()
    memo.set(key, nowMs)
    await upsertCredentialFingerprint(env, row, nowMs)
  } catch {
    // Observability must never fail a request.
  }
}

export interface CredentialSharing {
  sessions: number
  threshold: number
  window_minutes: number
  shared_suspected: boolean
}

/** Read-only: how many distinct session fingerprints this credential showed inside the window. */
export async function readCredentialSharing(
  env: Env,
  tokenId: string,
  nowMs: number = Date.now(),
): Promise<CredentialSharing | null> {
  if (!sharedCredentialDetectEnabled(env)) return null
  try {
    const since = new Date(nowMs - CRED_FP_WINDOW_MS).toISOString()
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM credential_session_fingerprints WHERE tenant = ?1 AND token_id = ?2 AND last_seen >= ?3`,
    ).bind(env.TENANT_SLUG, tokenId, since).first<{ n: number }>()
    const sessions = r?.n ?? 0
    const threshold = sharedCredentialThreshold(env)
    return { sessions, threshold, window_minutes: CRED_FP_WINDOW_MS / 60000, shared_suspected: sessions > threshold }
  } catch {
    return null
  }
}

export function sharedCredentialHint(sessions: number, seatEnrollOn: boolean): string {
  const base = `this credential is used by ${sessions} sessions`
  return seatEnrollOn
    ? `${base}; connect via a harness token or the harness OAuth option and call seat_select so each thread gets its own agent`
    : `${base}; ask an org admin to give each thread or environment its own credential so each gets its own agent`
}
