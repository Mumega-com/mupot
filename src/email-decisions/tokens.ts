// Email decision token. Pure apart from crypto.subtle. Fail closed when the secret is absent.
// token = <decisionId>.<expEpochSec>.<b64url(HMAC-SHA256(secret, tenant|decisionId|task|member|emailHash|exp|reviewEnteredAt))>
// The server-side row (email_decision_tokens) is the single-use source of truth; the HMAC only lets the Worker
// reject forged or stale tokens before touching D1. Binding to review_entered_at makes a re-submitted task stale.

export const EMAIL_DECISION_TTL_SECONDS = 24 * 60 * 60

export interface TokenBinding {
  readonly tenant: string
  readonly taskId: string
  readonly memberId: string
  readonly emailNormalized: string
  readonly reviewEnteredAt: string
}

export type TokenFailure = 'no_secret' | 'malformed' | 'expired' | 'bad_signature'
export type VerifyResult = { readonly ok: true; readonly decisionId: string; readonly expiresAt: number } | { readonly ok: false; readonly reason: TokenFailure }

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  try {
    return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

async function sha256Hex(input: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

async function signedMessage(binding: TokenBinding, decisionId: string, exp: number): Promise<Uint8Array> {
  const emailHash = await sha256Hex(binding.emailNormalized)
  // JSON array, not a delimiter join: no field can smuggle a separator into a neighbour.
  return enc.encode(JSON.stringify([binding.tenant, decisionId, binding.taskId, binding.memberId, emailHash, exp, binding.reviewEnteredAt]))
}

export function newDecisionId(): string {
  return crypto.randomUUID()
}

/** Returns null when the secret is absent or empty: callers must treat that as "email decisions unavailable". */
export async function mintDecisionToken(
  secret: string | undefined,
  binding: TokenBinding,
  nowMs: number,
  decisionId: string = newDecisionId(),
): Promise<{ token: string; decisionId: string; expiresAt: number } | null> {
  if (!secret) return null
  const exp = Math.floor(nowMs / 1000) + EMAIL_DECISION_TTL_SECONDS
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), await signedMessage(binding, decisionId, exp)))
  return { token: `${decisionId}.${exp}.${b64url(mac)}`, decisionId, expiresAt: exp }
}

export async function verifyDecisionToken(secret: string | undefined, token: string, expected: TokenBinding, nowMs: number): Promise<VerifyResult> {
  if (!secret) return { ok: false, reason: 'no_secret' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [decisionId, expRaw, macRaw] = parts
  if (!/^[0-9a-f-]{36}$/.test(decisionId) || !/^\d{1,12}$/.test(expRaw)) return { ok: false, reason: 'malformed' }
  const mac = fromB64url(macRaw)
  if (!mac) return { ok: false, reason: 'malformed' }
  const exp = Number(expRaw)
  // Signature first so an attacker cannot probe expiry of forged tokens; subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), mac, await signedMessage(expected, decisionId, exp))
  if (!valid) return { ok: false, reason: 'bad_signature' }
  if (exp <= Math.floor(nowMs / 1000)) return { ok: false, reason: 'expired' }
  return { ok: true, decisionId, expiresAt: exp }
}
