// src/mcp/events-webhook.ts — MCP Events (mupot#1618, PR 2): the OUTBOUND-request primitives.
//
// Everything here is either a pure function or a `fetch` wrapper; nothing reads D1. Three jobs:
//   1. validate a callback URL against an operator-configured EXACT-hostname allowlist
//      (EVENTS_CALLBACK_HOSTS, default empty => every URL refused),
//   2. sign a body per the Standard Webhooks scheme (HMAC-SHA256, crypto.subtle only),
//   3. POST a signed body with the invariants every outbound events request shares:
//      redirect:'manual' (a 3xx is a failure, never followed), a hard timeout, a bounded
//      response read.
//
// DNS REBINDING cannot be pinned on Workers (there is no way to fix the resolved IP for a
// fetch), so the mitigation is the layered one: HTTPS only + exact hostname allowlist chosen by
// the operator (not the agent) + no IP literals + no redirects + no ports. This is documented in
// docs/architecture/mcp-events.md as a limit, not a solved problem.

import type { Env } from '../types'

export const CALLBACK_TIMEOUT_MS = 10_000
/** Spec: maximum delivery payload. */
export const MAX_EVENT_BODY_BYTES = 262_144
const MAX_CALLBACK_URL_LENGTH = 2048
const MAX_RESPONSE_READ_BYTES = 8192

export type CallbackRefusalReason =
  | 'callback_url_invalid'
  | 'callback_scheme_not_https'
  | 'callback_credentials_not_allowed'
  | 'callback_port_not_allowed'
  | 'callback_host_ip_literal'
  | 'callback_host_not_allowed'

export type CallbackUrlCheck =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: CallbackRefusalReason }

/** Parse EVENTS_CALLBACK_HOSTS: comma list, trimmed + lowercased. Entries that are not plain
 *  hostnames (IP literals, wildcards, anything with a scheme/path/port) are DROPPED, never
 *  interpreted — the list is exact-match only. Unset/empty => empty set => refuse everything. */
export function parseCallbackHostAllowlist(raw: string | undefined): ReadonlySet<string> {
  const out = new Set<string>()
  if (!raw) return out
  for (const part of raw.split(',')) {
    const host = part.trim().toLowerCase()
    if (host === '') continue
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) continue
    if (/^[0-9.]+$/.test(host)) continue // an all-numeric name is an IPv4 literal, not a host
    out.add(host)
  }
  return out
}

/** Validate a callback URL. Pure: never resolves DNS, never fetches. */
export function validateCallbackUrl(raw: unknown, env: Pick<Env, 'EVENTS_CALLBACK_HOSTS'>): CallbackUrlCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CALLBACK_URL_LENGTH) {
    return { ok: false, reason: 'callback_url_invalid' }
  }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'callback_url_invalid' }
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'callback_scheme_not_https' }
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'callback_credentials_not_allowed' }
  // `new URL` normalises an explicit :443 to '' — so any non-empty port is a non-default one.
  if (u.port !== '') return { ok: false, reason: 'callback_port_not_allowed' }
  if (u.hash !== '') return { ok: false, reason: 'callback_url_invalid' }
  const host = u.hostname.toLowerCase()
  // IP literals: bracketed IPv6, or anything the URL parser normalised to dotted-quad
  // (it converts decimal/hex/octal forms such as 2130706433 or 0x7f.1 to 127.0.0.1).
  if (host.startsWith('[') || host.includes(':') || /^[0-9.]+$/.test(host)) {
    return { ok: false, reason: 'callback_host_ip_literal' }
  }
  if (host.endsWith('.')) return { ok: false, reason: 'callback_host_not_allowed' }
  const allowed = parseCallbackHostAllowlist(env.EVENTS_CALLBACK_HOSTS)
  if (!allowed.has(host)) return { ok: false, reason: 'callback_host_not_allowed' }
  return { ok: true, url: u.href, host }
}

// ── secrets ──────────────────────────────────────────────────────────────────────

const SECRET_PREFIX = 'whsec_'

function b64ToBytes(b64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return null
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** `whsec_` + base64 decoding to 24..64 bytes (spec). Returns the raw key bytes, or null. */
export function parseWebhookSecret(secret: unknown): Uint8Array | null {
  if (typeof secret !== 'string' || !secret.startsWith(SECRET_PREFIX)) return null
  const key = b64ToBytes(secret.slice(SECRET_PREFIX.length))
  if (!key || key.length < 24 || key.length > 64) return null
  return key
}

/** First 8 hex chars of sha256(secret): a non-secret label (rotation detection, cache scope). */
export async function secretFingerprint(secret: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8)
}

// ── Standard Webhooks signing ─────────────────────────────────────────────────────

async function hmacSha256B64(key: Uint8Array, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer, // ArrayBuffer view -> BufferSource
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)))
  return bytesToB64(sig)
}

/**
 * Standard Webhooks signature header value: `v1,<base64 HMAC-SHA256(key, "<id>.<ts>.<body>")>`.
 * `secrets` are the `whsec_` strings to sign with — during a rotation, old AND new, and the
 * result is the space-separated list the scheme defines.
 */
export async function standardWebhooksSignature(
  secrets: readonly string[],
  webhookId: string,
  timestampSec: number,
  body: string,
): Promise<string> {
  const signed = `${webhookId}.${timestampSec}.${body}`
  const parts: string[] = []
  for (const s of secrets) {
    const key = parseWebhookSecret(s)
    if (!key) throw new Error('events-webhook: invalid signing secret')
    parts.push(`v1,${await hmacSha256B64(key, signed)}`)
  }
  if (parts.length === 0) throw new Error('events-webhook: no signing secret')
  return parts.join(' ')
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  // Length is compared without early exit on content: pad the shorter to the longer.
  const len = Math.max(ea.length, eb.length)
  let diff = ea.length ^ eb.length
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  return diff === 0
}

// ── outbound POST ─────────────────────────────────────────────────────────────────

export type PostOutcome =
  | { kind: 'response'; status: number; text: string }
  | { kind: 'redirect'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network_error' }

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < MAX_RESPONSE_READ_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      // Cap per BYTE, not per chunk: never buffer more than the cap, however big one chunk is.
      const take = value.subarray(0, MAX_RESPONSE_READ_BYTES - total)
      chunks.push(take)
      total += take.byteLength
    }
    if (total >= MAX_RESPONSE_READ_BYTES) await reader.cancel()
  } catch {
    // A truncated/aborted body is treated as what was read so far; the caller decides by status.
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(buf)
}

/**
 * POST `body` (the EXACT bytes that were signed) to `url`. `redirect: 'manual'`: a 3xx (or an
 * opaque redirect) is reported as `redirect` and NEVER followed. Aborts after `timeoutMs` via a
 * plain AbortController + setTimeout (so the timeout is controllable in tests).
 */
export async function postSigned(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number = CALLBACK_TIMEOUT_MS,
): Promise<PostOutcome> {
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: ctl.signal,
    })
    if (res.status >= 300 && res.status < 400) {
      return { kind: 'redirect', status: res.status }
    }
    const text = await readBounded(res)
    return { kind: 'response', status: res.status, text }
  } catch {
    return timedOut ? { kind: 'timeout' } : { kind: 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

/** Standard Webhooks request headers for one attempt (fresh timestamp + signature each call). */
export async function signedHeaders(
  secrets: readonly string[],
  webhookId: string,
  subscriptionId: string,
  body: string,
  nowMs: number = Date.now(),
): Promise<{ headers: Record<string, string>; signedAtIso: string }> {
  const ts = Math.floor(nowMs / 1000)
  return {
    headers: {
      'content-type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': String(ts),
      'webhook-signature': await standardWebhooksSignature(secrets, webhookId, ts, body),
      'X-MCP-Subscription-Id': subscriptionId,
    },
    signedAtIso: new Date(ts * 1000).toISOString(),
  }
}

export type VerificationResult =
  | { ok: true }
  | { ok: false; reason: 'challenge_failed' | 'timeout' | 'callback_redirect' | 'callback_http_error' | 'callback_unreachable' }

/**
 * Callback verification (spec): POST a signed single-use `{type:'verification',challenge}`;
 * require a 2xx and the challenge echoed back as `{"challenge": ...}`, compared in constant time.
 */
export async function verifyCallback(
  url: string,
  secret: string,
  subscriptionId: string,
  timeoutMs: number = CALLBACK_TIMEOUT_MS,
): Promise<VerificationResult> {
  const challenge = bytesToB64(crypto.getRandomValues(new Uint8Array(24)))
  const body = JSON.stringify({ type: 'verification', challenge })
  const webhookId = `msg_verification_${crypto.randomUUID()}`
  const { headers } = await signedHeaders([secret], webhookId, subscriptionId, body)
  const out = await postSigned(url, headers, body, timeoutMs)
  if (out.kind === 'timeout') return { ok: false, reason: 'timeout' }
  if (out.kind === 'network_error') return { ok: false, reason: 'callback_unreachable' }
  if (out.kind === 'redirect') return { ok: false, reason: 'callback_redirect' }
  if (out.status < 200 || out.status >= 300) return { ok: false, reason: 'callback_http_error' }
  let echoed: unknown
  try {
    echoed = (JSON.parse(out.text) as { challenge?: unknown }).challenge
  } catch {
    return { ok: false, reason: 'challenge_failed' }
  }
  if (typeof echoed !== 'string' || !timingSafeEqualStr(echoed, challenge)) {
    return { ok: false, reason: 'challenge_failed' }
  }
  return { ok: true }
}
