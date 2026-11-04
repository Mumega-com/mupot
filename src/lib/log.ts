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

// Bounded quantifiers keep this linear: every start position scans at most 64 characters, so a long
// run with no '@' (the unbounded form was quadratic: 16 KB took ~600 ms) costs O(64 * n).
// The final label must be alphabetic and 2+ long, so short agent refs like `x@y.z` are not emails.
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,7}\.[A-Za-z]{2,24}\b/g
// Strings longer than this are cut before ANY regex runs, so no pattern can be driven into
// super-linear work by a long attacker-controlled log argument.
const MAX_STRING_CHARS = 8 * 1024
const TRUNCATED_MARK = '…[truncated]'
const EXTRA_TOKEN_RES: RegExp[] = [
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g, // Stripe secret / restricted keys
  /\bwhsec_[A-Za-z0-9]{8,}\b/g, // Stripe webhook signing secret
  /\bre_[A-Za-z0-9_]{16,}\b/g, // Resend API key
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API key
  /https:\/\/hooks\.slack\.com\/[^\s"']+/g,
  /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[^\s"']+/g,
]
// Bare 64-hex values (HMAC / SHA-256 secrets) are only redacted next to a secret-ish word, so
// content hashes and ids in ordinary log lines survive.
const SECRET_HEX_RE = /\b((?:key|secret|token|signature|sig|password|passwd|hmac)\W{0,6})[0-9a-fA-F]{64}\b/gi
const URL_SECRET_PARAM_RE = /([?&])(code|key|sig|signature|state|x-amz-signature|x-amz-credential|x-amz-security-token|access_token|id_token|refresh_token|api_key|apikey)=[^&#\s"']*/gi
const URL_USERINFO_RE = /(\/\/)[^\s/@:"']+:[^\s/@"']+@/g
// Phone numbers need a plausible format: an international number with a leading + and 10-15 digits,
// or a North-American 3-3-4 with a parenthesised area code or a consistent '-' / '.' separator.
// A bare run of digit groups is NOT a phone ("processed 400 200 3000 rows").
const INTL_PHONE_RE = /(?<![\w+])\+[1-9]\d{0,2}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,3}(?![\w-])/g
const NANP_PAREN_PHONE_RE = /\(\d{3}\)\s?\d{3}[\s.-]\d{4}\b/g
const NANP_SEP_PHONE_RE = /(?<![\w-])[2-9]\d{2}([.-])\d{3}\1\d{4}(?![\w-])/g
const TELEGRAM_URL_TOKEN_RE = /bot\d{6,}:[A-Za-z0-9_-]+/g
const TELEGRAM_BARE_TOKEN_RE = /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g

// Keys whose value IS the user's words or contact data: replaced wholesale, never printed.
const FREE_TEXT_KEYS = new Set([
  'title', 'tasktitle', 'body', 'text', 'content', 'result', 'subject', 'prompt',
  'description', 'email', 'emailaddress', 'phone', 'phonenumber',
  'summary', 'goal', 'note', 'notes', 'details', 'question', 'reply',
])
// Keys an operator needs to correlate and triage. Their string values are pattern-scrubbed
// but not length-capped. Every OTHER key's string value is scrubbed AND capped.
const OPS_KEY_EXACT = new Set([
  'id', 'ids', 'tenant', 'slug', 'status', 'code', 'count', 'ms', 'kind', 'type', 'seq', 'attempt',
  'attempts', 'ts', 'at', 'metric', 'route', 'stage', 'outcome', 'state', 'level', 'size', 'bytes',
  'total', 'version', 'sha', 'method', 'path', 'event', 'platform', 'provider', 'channel',
])
const OPS_KEY_SUFFIXES = ['id', 'ids', 'at', 'ms', 'count', 'status', 'code', 'seq', 'kind', 'type', 'attempt', 'attempts', 'ts', 'slug', 'metric', 'route', 'stage', 'outcome', 'state', 'sha', 'bytes', 'total']
const UNKNOWN_STRING_CAP = 120

function isOpsKey(normalized: string): boolean {
  return OPS_KEY_EXACT.has(normalized) || OPS_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

function capUnknown(text: string): string {
  return text.length > UNKNOWN_STRING_CAP ? text.slice(0, UNKNOWN_STRING_CAP) + '…' : text
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

// An international number is 10-15 digits in total; shorter runs are counters or sequence numbers.
function isPlausiblePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '').length
  return digits >= 10 && digits <= 15 && !/\d{4}-\d{2}-\d{2}/.test(candidate)
}

export function redactLogString(input: string): string {
  const text = input.length > MAX_STRING_CHARS ? input.slice(0, MAX_STRING_CHARS) + TRUNCATED_MARK : input
  let out = redactSecretPatterns(text)
  for (const re of EXTRA_TOKEN_RES) out = out.replace(re, REDACTED)
  return out
    .replace(SECRET_HEX_RE, (_m, lead: string) => `${lead}${REDACTED}`)
    .replace(URL_SECRET_PARAM_RE, (_m, d: string, k: string) => `${d}${k}=${REDACTED}`)
    .replace(URL_USERINFO_RE, '$1[redacted]@')
    .replace(TELEGRAM_URL_TOKEN_RE, 'bot<REDACTED>')
    .replace(TELEGRAM_BARE_TOKEN_RE, REDACTED)
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(INTL_PHONE_RE, (m) => (isPlausiblePhone(m) ? '[redacted-phone]' : m))
    .replace(NANP_PAREN_PHONE_RE, '[redacted-phone]')
    .replace(NANP_SEP_PHONE_RE, '[redacted-phone]')
}

function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = isSensitiveDetailKey(key) ? REDACTED : redactLogString(value)
  })
  return out
}

function redactError(err: Error, depth: number, seen: WeakSet<object>): Error {
  // ALWAYS rebuilt: a clean message/stack says nothing about own properties such as
  // err.headers.authorization or err.token, which console inspection can print.
  const copy = err instanceof AggregateError
    ? new AggregateError(
        (err.errors as unknown[]).map((inner) => walk(inner, depth + 1, seen)), // errors is unknown[] in the lib typing
        redactLogString(err.message),
      )
    : new Error(redactLogString(err.message))
  copy.name = err.name
  if (typeof err.stack === 'string') copy.stack = redactLogString(err.stack)
  const cause: unknown = (err as { cause?: unknown }).cause // Error.cause is ES2022 and not in the TS lib target
  if (cause !== undefined) (copy as { cause?: unknown }).cause = walk(cause, depth + 1, seen) // same reason as above
  for (const [key, value] of Object.entries(err)) {
    if (key === 'errors' || key === 'cause') continue
    ;(copy as unknown as Record<string, unknown>)[key] = walkEntry(key, value, depth, seen) // copying own enumerable props (code, status ...) onto the clone
  }
  return copy
}

function walkEntry(key: string, item: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (isSensitiveDetailKey(key)) {
    // A literal flag such as has_token: true carries no secret.
    return item === null || item === undefined || typeof item === 'boolean' ? item : REDACTED
  }
  const normalized = normalizeKey(key)
  if (FREE_TEXT_KEYS.has(normalized)) return REDACTED
  return walk(item, depth + 1, seen, !isOpsKey(normalized))
}

function walk(value: unknown, depth: number, seen: WeakSet<object>, capped = false): unknown {
  if (typeof value === 'string') {
    const scrubbed = redactLogString(value)
    return capped ? capUnknown(scrubbed) : scrubbed
  }
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
    if (value instanceof URL) return redactLogString(value.href)
    if (value instanceof Map) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of value) {
        const key = String(k)
        out[key] = walkEntry(key, v, depth, seen)
      }
      return out
    }
    if (value instanceof Set) return Array.from(value, (item) => walk(item, depth + 1, seen, capped))
    const tag = Object.prototype.toString.call(value)
    if (Array.isArray(value)) {
      let changed = false
      const mapped = value.map((item) => {
        const next = walk(item, depth + 1, seen, capped)
        if (next !== item) changed = true
        return next
      })
      return changed ? mapped : value
    }
    if (tag !== '[object Object]') return value
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const next = walkEntry(key, item, depth, seen)
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
