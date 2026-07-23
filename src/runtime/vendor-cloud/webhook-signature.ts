// Cursor Background Agents webhook HMAC verification.
// Docs: https://cursor.com/docs/cloud-agent/api/webhooks
// Header: X-Webhook-Signature: sha256=<hex_digest> over the raw body.

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

async function hmacSha256Hex(secret: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Verify Cursor webhook signature.
 * Returns 'not_configured' | 'invalid' | 'ok' — same fail-closed shape as GHL.
 */
export async function verifyCursorWebhookSignature(
  secret: string | null,
  rawBody: string,
  signatureHeader: string | null,
): Promise<'not_configured' | 'invalid' | 'ok'> {
  if (secret === null || secret.length === 0) return 'not_configured'
  if (signatureHeader === null || signatureHeader.length === 0) return 'invalid'
  const prefix = 'sha256='
  if (!signatureHeader.startsWith(prefix)) return 'invalid'
  const provided = signatureHeader.slice(prefix.length)
  const expected = await hmacSha256Hex(secret, rawBody)
  if (!timingSafeEqual(expected, provided)) return 'invalid'
  return 'ok'
}

/** Build the documented header value for tests / outbound fixtures. */
export async function cursorWebhookSignatureHeader(
  secret: string,
  rawBody: string,
): Promise<string> {
  const hex = await hmacSha256Hex(secret, rawBody)
  return `sha256=${hex}`
}
