// SSO handoff claim verifier — POT SIDE (#262). The pot is a relying party: it
// accepts a verified-email claim signed by mumega (the issuer) and mints its OWN
// session. We hold ONLY mumega's Ed25519 PUBLIC key — never a shared secret. This
// file is the pot's OWN copy (it must NOT import from mumega — that would re-couple
// the repos; sovereignty). It is stateless: signature/alg/aud/exp/email_verified
// only. One-time jti consumption is the caller's job (pot KV), so the same human
// can't replay a claim.

const HANDOFF_ALG = 'EdDSA' // Ed25519
export const HANDOFF_AUD = 'mupot.mumega.com'
export const HANDOFF_ISS = 'https://mumega.com'

export interface HandoffClaim {
  iss: string
  aud: string
  sub: string
  email: string
  email_verified: boolean
  channel: string
  iat: number
  exp: number
  jti: string
}

export interface VerifyResult {
  ok: boolean
  reason?: string
  claim?: HandoffClaim
}

function b64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importPublicKey(jwkJson: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkJson) as JsonWebKey
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || (jwk as { d?: string }).d) {
    // Must be a PUBLIC Ed25519 key — reject anything with a private scalar.
    throw new Error('handoff: MUPOT_HANDOFF_PUBLIC_KEY must be a public Ed25519 OKP JWK')
  }
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
}

/**
 * Verify a compact JWS handoff claim with the issuer's PUBLIC key. Stateless —
 * checks signature, alg, aud, email_verified, exp. The caller MUST additionally
 * consume `claim.jti` once in KV (replay defense) before trusting it.
 * `nowSeconds` injectable for tests.
 */
export async function verifyHandoffClaim(
  publicKeyJwkJson: string | undefined,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (!publicKeyJwkJson) return { ok: false, reason: 'unconfigured' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [h, p, s] = parts
  let header: { alg?: string }
  let claim: HandoffClaim
  try {
    header = JSON.parse(new TextDecoder().decode(b64UrlToBytes(h)))
    claim = JSON.parse(new TextDecoder().decode(b64UrlToBytes(p)))
  } catch {
    return { ok: false, reason: 'undecodable' }
  }
  if (header.alg !== HANDOFF_ALG) return { ok: false, reason: 'wrong_alg' }
  let key: CryptoKey
  try {
    key = await importPublicKey(publicKeyJwkJson)
  } catch {
    return { ok: false, reason: 'bad_public_key' }
  }
  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    b64UrlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  )
  if (!valid) return { ok: false, reason: 'bad_signature' }
  if (claim.aud !== HANDOFF_AUD) return { ok: false, reason: 'wrong_aud' }
  // Defense in depth: pin the issuer. Signature already binds the key, but checking
  // iss guards against keypair reuse / a two-pot misconfig accepting a foreign issuer.
  if (claim.iss !== HANDOFF_ISS) return { ok: false, reason: 'wrong_iss' }
  if (claim.email_verified !== true) return { ok: false, reason: 'email_not_verified' }
  if (typeof claim.exp !== 'number' || claim.exp <= nowSeconds) return { ok: false, reason: 'expired' }
  const email = (claim.email ?? '').trim().toLowerCase()
  if (!email || !email.includes('@')) return { ok: false, reason: 'no_email' }
  if (!claim.jti) return { ok: false, reason: 'no_jti' }
  return { ok: true, claim: { ...claim, email } }
}
