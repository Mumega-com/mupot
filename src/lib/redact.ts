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

function redactAssignments(text: string): string {
  let out = ''
  let cursor = 0
  ASSIGNMENT_HEAD_RE.lastIndex = 0
  for (let m = ASSIGNMENT_HEAD_RE.exec(text); m !== null; m = ASSIGNMENT_HEAD_RE.exec(text)) {
    const head = m[1] ?? ''
    const key = m[2] ?? ''
    const valueStart = m.index + head.length
    if (!isSensitiveDetailKey(key)) continue // lastIndex is already at the value start: keep scanning inside it
    const valueMatch = ASSIGNMENT_VALUE_RE.exec(text.slice(valueStart))
    if (valueMatch === null || LITERAL_FLAG_RE.test(valueMatch[0])) continue
    out += text.slice(cursor, valueStart) + '[redacted]'
    cursor = valueStart + valueMatch[0].length
    ASSIGNMENT_HEAD_RE.lastIndex = cursor
  }
  return out + text.slice(cursor)
}

export function redactSecretPatterns(text: string): string {
  return text
    .replace(QUERY_ASSIGNMENT_RE, (match, delimiter: string, key: string, equals: string) => (
      isSensitiveDetailKey(key) ? `${delimiter}${key}${equals}[redacted]` : match
    ))
    .replace(/^[\s\S]*$/, redactAssignments)
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
