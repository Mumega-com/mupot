// Deterministic canonical form + digest for a validated seed. The digest is the
// idempotency key the (later) apply step uses; it must not depend on key order,
// YAML-vs-JSON source form, comments or whitespace.

// The one text normalization: NFC, trailing whitespace trimmed (leading is NOT trimmed).
export function canonicalText(value: string): string {
  return value.normalize('NFC').trimEnd()
}

function sortValue(value: unknown): unknown {
  // NFC + no trailing whitespace: visually identical text must hash identically.
  if (typeof value === 'string') return canonicalText(value)
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>) // as: plain parsed-data object, narrowed by typeof above
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sortValue(child)]),
    )
  }
  return value
}

// Array ORDER is preserved on purpose: it is part of the author's declaration.
export function canonicalSeedJson(seed: unknown): string {
  return JSON.stringify(sortValue(seed))
}

export async function seedSha256(seed: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSeedJson(seed))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
