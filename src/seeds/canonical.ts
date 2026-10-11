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

// Stable key for one request: kind + a short digest of its structured fields. The dry run shows it;
// apply requires the human to list it in `accept`. Same request -> same key on every call.
export async function requestKey(request: { kind: string; fields: Record<string, string> }): Promise<string> {
  const digest = await seedSha256({ kind: request.kind, fields: request.fields })
  return `${request.kind}:${digest.slice(0, 12)}`
}
