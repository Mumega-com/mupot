// Address handling for email decisions. Pure. Default is EXACT matching: no Gmail dot-folding, no plus-stripping
// unless the caller asks (design §3.2 step 5). Only the domain is case-folded by RFC; we also fold the local part
// because every mainstream mailbox is case-insensitive and a case-sensitive binding would be a self-lockout.

export interface ParsedAddress {
  readonly local: string
  readonly domain: string
  readonly normalized: string
}

/** Extract exactly one addr-spec from `a@b` or `Name <a@b>`. Anything ambiguous (several mailboxes, no @) is null. */
export function parseAddress(input: string): ParsedAddress | null {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > 320) return null
  let spec = trimmed
  const angle = /<([^<>]*)>\s*$/.exec(trimmed)
  if (angle) {
    spec = angle[1].trim()
    if (/[<>]/.test(trimmed.slice(0, angle.index))) return null
  } else if (/[<>,;\s]/.test(trimmed)) {
    return null
  }
  if (/[<>,;\s"()\\]/.test(spec)) return null
  const at = spec.lastIndexOf('@')
  if (at < 1 || at === spec.length - 1 || spec.indexOf('@') !== at) return null
  const local = spec.slice(0, at).toLowerCase()
  const domain = spec.slice(at + 1).toLowerCase().replace(/\.$/, '')
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) || !domain.includes('.') || domain.includes('..')) return null
  return { local, domain, normalized: `${local}@${domain}` }
}

export function normalizeAddress(input: string): string | null {
  return parseAddress(input)?.normalized ?? null
}

/** Split `approve+TOKEN@decide.example.com` into base local, tag and domain. Tag is null when absent or empty. */
export function splitPlusTag(input: string): { base: string; tag: string | null; domain: string } | null {
  const parsed = parseAddress(input)
  if (!parsed) return null
  const plus = parsed.local.indexOf('+')
  if (plus < 0) return { base: parsed.local, tag: null, domain: parsed.domain }
  const tag = parsed.local.slice(plus + 1)
  return { base: parsed.local.slice(0, plus), tag: tag === '' ? null : tag, domain: parsed.domain }
}
