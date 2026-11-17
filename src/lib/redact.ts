// mupot — shared secret redaction helpers.
//
// Extracted from src/projects/projections.ts so audit findings can apply them
// to logs and error sites outside projections without cross-importing a
// projection module.

// Matches only the `key =` / `key :` HEAD of a pair. The value is consumed separately, and only when the
// key is sensitive: a head that is NOT sensitive (`Error: ...`, `status: 401 ...`) must leave its value
// in place to be scanned, or a later `secret=...` inside it would be swallowed and never redacted.
// The delimiter is a lookbehind so a head's trailing whitespace never eats the delimiter of the next pair.
const ASSIGNMENT_HEAD_RE = /(?<=^|[\s,;{?&])(["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=]\s*)/g
const ASSIGNMENT_VALUE_RE = /^[^,;}&\r\n]+/
// A literal flag is not a secret: `has_token=true`.
const LITERAL_FLAG_RE = /^\s*["']?(?:true|false|null|undefined)["']?\s*$/i
const QUERY_ASSIGNMENT_RE = /([?&])([A-Za-z][A-Za-z0-9_.-]*)(=)[^&#\s]*/g

export function isSensitiveDetailKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized.endsWith('apikey')
    || normalized === 'authorization'
    || normalized === 'bearer'
    || normalized.endsWith('token')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('clientsecret')
    || normalized.endsWith('accountkey')
    || normalized.endsWith('accesskey')
    || normalized.endsWith('secretkey')
    || normalized.endsWith('signingkey')
    || normalized.endsWith('connectionstring')
    || normalized.endsWith('sharedaccesssignature')
    || normalized.endsWith('password')
    || normalized === 'passwd'
    || normalized.endsWith('secret')
    || normalized.endsWith('cookie')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials')
}

// Display mode (notification text shown to a person). Credential keys ALWAYS redact their value, whatever its shape.
// The one relaxation: the bare key `token`/`tokens` followed by plain prose (letters and spaces, two or more words), so
// "Update token: rotation runbook" survives. Anything else after `token:` / `token=` is redacted.
const EXTRA_DISPLAY_KEYS: ReadonlySet<string> = new Set(['auth', 'pwd'])
const PROSE_VALUE_RE = /^[A-Za-z]+(?: +[A-Za-z]+)+$/
const AUTH_SCHEME_RE = /\b(Basic|Bearer|Token|Bot|Digest|ApiKey)(\s+)(?!\[redacted\])[^\s"']+/gi

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function isDisplayCredentialKey(key: string): boolean {
  return isSensitiveDetailKey(key) || EXTRA_DISPLAY_KEYS.has(normalizeKey(key))
}

function isBareTokenKey(key: string): boolean {
  const n = normalizeKey(key)
  return n === 'token' || n === 'tokens'
}

function redactAssignments(text: string, display = false): string {
  let out = ''
  let cursor = 0
  ASSIGNMENT_HEAD_RE.lastIndex = 0
  for (let m = ASSIGNMENT_HEAD_RE.exec(text); m !== null; m = ASSIGNMENT_HEAD_RE.exec(text)) {
    const head = m[1] ?? ''
    const key = m[2] ?? ''
    const valueStart = m.index + head.length
    if (!(display ? isDisplayCredentialKey(key) : isSensitiveDetailKey(key))) continue // lastIndex is already at the value start: keep scanning inside it
    const valueMatch = ASSIGNMENT_VALUE_RE.exec(text.slice(valueStart))
    if (valueMatch === null || LITERAL_FLAG_RE.test(valueMatch[0])) continue
    if (display && isBareTokenKey(key) && PROSE_VALUE_RE.test(valueMatch[0].trim())) continue
    out += text.slice(cursor, valueStart) + '[redacted]'
    cursor = valueStart + valueMatch[0].length
    ASSIGNMENT_HEAD_RE.lastIndex = cursor
  }
  return out + text.slice(cursor)
}

/**
 * For prose shown to a person (notification titles). Same as redactSecretPatterns, plus: the word after an auth scheme
 * (Basic, Bearer, Token, Bot, Digest, ApiKey) is always redacted, and the prose relaxation for the bare key `token`
 * described above. The strict redactSecretPatterns (logs, audit, projections) does NOT use this rule.
 */
export function redactSecretPatternsForDisplay(text: string): string {
  return redactWith(text, true)
}

export function redactSecretPatterns(text: string): string {
  return redactWith(text, false)
}

function redactWith(text: string, display: boolean): string {
  const staged = text
    .replace(QUERY_ASSIGNMENT_RE, (match, delimiter: string, key: string, equals: string) => (
      isSensitiveDetailKey(key) ? `${delimiter}${key}${equals}[redacted]` : match
    ))
    .replace(/^[\s\S]*$/, (t) => redactAssignments(t, display))
  return (display ? staged.replace(AUTH_SCHEME_RE, '$1$2[redacted]') : staged)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi, '[redacted]')
    .replace(/\bmupot_[A-Za-z0-9_-]+\b/g, '[redacted]')
    // Cloudflare API tokens — live on this host as ~/.fleet/agents/*.token and passed to
    // the CF API. Added 2026-09-03 after an adversarial pass found them absent while a
    // hand-rolled copy of this function was being written elsewhere (mupot#1287).
    .replace(/\bcfat_[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    // Pot admin / lead-agent credentials minted by provisionSovereignPot.
    .replace(/\bpot_(?:adm|agt)_[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[redacted]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted]')
}

export function redactStructuredDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredDetail)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveDetailKey(key) ? '[redacted]' : redactStructuredDetail(item),
    ]))
  }
  return typeof value === 'string' ? redactSecretPatterns(value) : value
}
