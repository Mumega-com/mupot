// mupot — redacting console wrapper (mupot#985 / #986).
//
// Worker console output lands in Cloudflare Logs / Tail, which any account member can read
// without the capability checks the pot enforces on D1. Every `console.*` call in src/ goes
// through `safeConsole` instead, so the arguments are scrubbed before they are written:
//
//   - token-shaped values (mupot_*, gh*_, sk-*, xox*, cfat_*, pot_adm_*, JWTs, Bearer, AWS ids,
//     Telegram bot tokens, private-key blocks) via the shared `redactSecretPatterns`
//   - email addresses and phone numbers anywhere in a string
//   - object keys that name a credential (authorization, cookie, *token, *secret, *api_key ...)
//   - object keys that carry free text or contact data (title, body, text, content, result,
//     subject, prompt, email, phone ...), which are replaced wholesale: an operator needs the
//     correlation ids (task_id, tenant, status), not the customer's words
//   - Error messages and stacks, and Request/Response/Headers objects (method, url, status only)
//
// Ops-relevant logs are kept, not removed: structure, ids, counts and statuses pass through
// unchanged, and a value with nothing to redact is returned as the SAME reference.
//
// This module is the only place in src/ allowed to call console.* directly;
// tests/log-redaction.test.ts fails if another file does.

import { isSensitiveDetailKey, redactSecretPatterns } from './redact'

const REDACTED = '[redacted]'
const MAX_DEPTH = 8

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
// Phone numbers need a shape that cannot match ids, ISO timestamps or counters:
// an international number with a leading +, or a North-American 3-3-4 grouping.
const INTL_PHONE_RE = /\+\d[\d\s().-]{7,}\d/g
const NANP_PHONE_RE = /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g
const TELEGRAM_URL_TOKEN_RE = /bot\d{6,}:[A-Za-z0-9_-]+/g
const TELEGRAM_BARE_TOKEN_RE = /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g

const FREE_TEXT_KEYS = new Set([
  'title', 'tasktitle', 'body', 'text', 'content', 'result', 'subject', 'prompt',
  'description', 'email', 'emailaddress', 'phone', 'phonenumber',
])

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

export function redactLogString(text: string): string {
  return redactSecretPatterns(text)
    .replace(TELEGRAM_URL_TOKEN_RE, 'bot<REDACTED>')
    .replace(TELEGRAM_BARE_TOKEN_RE, REDACTED)
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(INTL_PHONE_RE, '[redacted-phone]')
    .replace(NANP_PHONE_RE, '[redacted-phone]')
}

function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = isSensitiveDetailKey(key) ? REDACTED : redactLogString(value)
  })
  return out
}

function redactError(err: Error, depth: number, seen: WeakSet<object>): Error {
  const message = redactLogString(err.message)
  const stack = typeof err.stack === 'string' ? redactLogString(err.stack) : undefined
  const cause: unknown = (err as { cause?: unknown }).cause // Error.cause is ES2022 and not in the TS lib target
  const redactedCause = cause === undefined ? undefined : walk(cause, depth + 1, seen)
  if (message === err.message && stack === err.stack && redactedCause === cause) return err
  const copy = new Error(message)
  copy.name = err.name
  if (stack !== undefined) copy.stack = stack
  if (cause !== undefined) (copy as { cause?: unknown }).cause = redactedCause // same reason as above
  for (const [key, value] of Object.entries(err)) {
    ;(copy as unknown as Record<string, unknown>)[key] = isSensitiveDetailKey(key) ? REDACTED : walk(value, depth + 1, seen) // copying own enumerable props (code, status ...) onto the clone
  }
  return copy
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactLogString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_DEPTH) return '[truncated]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (value instanceof Error) return redactError(value, depth, seen)
    if (typeof Request !== 'undefined' && value instanceof Request) {
      return { method: value.method, url: redactLogString(value.url) }
    }
    if (typeof Response !== 'undefined' && value instanceof Response) {
      return { status: value.status, statusText: value.statusText, url: redactLogString(value.url) }
    }
    if (typeof Headers !== 'undefined' && value instanceof Headers) return redactHeaders(value)
    const tag = Object.prototype.toString.call(value)
    if (Array.isArray(value)) {
      let changed = false
      const mapped = value.map((item) => {
        const next = walk(item, depth + 1, seen)
        if (next !== item) changed = true
        return next
      })
      return changed ? mapped : value
    }
    if (tag !== '[object Object]') return value
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const next = isSensitiveDetailKey(key) || FREE_TEXT_KEYS.has(normalizeKey(key))
        ? REDACTED
        : walk(item, depth + 1, seen)
      if (next !== item) changed = true
      out[key] = next
    }
    return changed ? out : value
  } finally {
    seen.delete(value)
  }
}

/** Return `value` with secrets, contact data and free-text fields removed. Never throws. */
export function redactForLog(value: unknown): unknown {
  try {
    return walk(value, 0, new WeakSet())
  } catch {
    return '[unredactable]'
  }
}

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug'

function emit(level: Level, args: unknown[]): void {
  let safe: unknown[]
  try {
    safe = args.map((arg) => redactForLog(arg))
  } catch {
    safe = ['[log redaction failed]']
  }
  console[level](...safe)
}

/** Drop-in for `console` whose arguments are redacted first. */
export const safeConsole = {
  log: (...args: unknown[]): void => emit('log', args),
  info: (...args: unknown[]): void => emit('info', args),
  warn: (...args: unknown[]): void => emit('warn', args),
  error: (...args: unknown[]): void => emit('error', args),
  debug: (...args: unknown[]): void => emit('debug', args),
}
