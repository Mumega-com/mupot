// mupot — shared secret redaction helpers.
//
// Extracted from src/projects/projections.ts so audit findings can apply them
// to logs and error sites outside projections without cross-importing a
// projection module.

// Matches only through `key[:=]` (not the value) so a leading label such as
// `Note:` / `Label:` cannot swallow a later `key=value` pair (#2119). Lookbehind
// keeps the boundary character available for the next scan.
const ASSIGNMENT_KEY_RE = /(?<![A-Za-z0-9_.-])["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=]\s*/g
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

/** Redact every sensitive `key[:=]value` pair, including those after a label. */
function redactAssignmentPairs(text: string): string {
  const edits: Array<{ start: number; end: number }> = []
  ASSIGNMENT_KEY_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ASSIGNMENT_KEY_RE.exec(text)) !== null) {
    const key = match[1]
    if (!key || !isSensitiveDetailKey(key)) continue
    const start = match.index + match[0].length
    let end = start
    while (end < text.length && !/[,;}&\r\n]/.test(text[end]!)) end += 1
    if (end > start) {
      edits.push({ start, end })
      // Skip the value so overlapping ranges stay consistent when applied.
      ASSIGNMENT_KEY_RE.lastIndex = end
    }
  }
  let out = text
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const { start, end } = edits[i]!
    out = `${out.slice(0, start)}[redacted]${out.slice(end)}`
  }
  return out
}

export function redactSecretPatterns(text: string): string {
  return redactAssignmentPairs(
    text.replace(QUERY_ASSIGNMENT_RE, (match, delimiter: string, key: string, equals: string) => (
      isSensitiveDetailKey(key) ? `${delimiter}${key}${equals}[redacted]` : match
    )),
  )
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
