// handoff-verify.test.ts — pot-side SSO handoff claim verifier (#262).
// Self-contained: generates an Ed25519 keypair, signs claims inline (the issuer is
// mumega in prod), and asserts the pot accepts a good claim + rejects every bad path.

import { describe, expect, it, beforeAll } from 'vitest'
import { verifyHandoffClaim, HANDOFF_AUD } from '../src/auth/handoff-verify'

const NOW = 1_800_000_000

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
function utf8b64url(s: string): string {
  return b64url(new TextEncoder().encode(s))
}

async function sign(
  privateKey: CryptoKey,
  claim: Record<string, unknown>,
): Promise<string> {
  const head = utf8b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
  const body = utf8b64url(JSON.stringify(claim))
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(`${head}.${body}`)),
  )
  return `${head}.${body}.${b64url(sig)}`
}

function baseClaim(over: Record<string, unknown> = {}) {
  return {
    iss: 'https://mumega.com',
    aud: HANDOFF_AUD,
    sub: 'op@mumega.com',
    email: 'op@mumega.com',
    email_verified: true,
    channel: 'email',
    iat: NOW,
    exp: NOW + 60,
    jti: 'abc123',
    ...over,
  }
}

describe('pot handoff-verify', () => {
  let priv: CryptoKey
  let pubJwk: string
  let foreignPriv: CryptoKey

  beforeAll(async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    priv = kp.privateKey
    const exported = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey
    pubJwk = JSON.stringify({ kty: exported.kty, crv: exported.crv, x: exported.x })
    const kp2 = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    foreignPriv = kp2.privateKey
  })

  it('accepts a correctly-signed verified-email claim', async () => {
    const t = await sign(priv, baseClaim())
    const r = await verifyHandoffClaim(pubJwk, t, NOW + 1)
    expect(r.ok).toBe(true)
    expect(r.claim?.email).toBe('op@mumega.com')
  })

  it('rejects when unconfigured (no public key)', async () => {
    const t = await sign(priv, baseClaim())
    const r = await verifyHandoffClaim(undefined, t, NOW + 1)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('unconfigured')
  })

  it('rejects a foreign-key signature', async () => {
    const t = await sign(foreignPriv, baseClaim())
    const r = await verifyHandoffClaim(pubJwk, t, NOW + 1)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bad_signature')
  })

  it('rejects a wrong audience', async () => {
    const t = await sign(priv, baseClaim({ aud: 'evil.example.com' }))
    const r = await verifyHandoffClaim(pubJwk, t, NOW + 1)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('wrong_aud')
  })

  it('rejects a wrong issuer (#262 P2-a defense-in-depth)', async () => {
    const t = await sign(priv, baseClaim({ iss: 'https://evil.example.com' }))
    const r = await verifyHandoffClaim(pubJwk, t, NOW + 1)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('wrong_iss')
  })

  it('rejects an expired claim', async () => {
    const t = await sign(priv, baseClaim())
    const r = await verifyHandoffClaim(pubJwk, t, NOW + 61)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('expired')
  })

  it('rejects email_verified !== true (anti-takeover)', async () => {
    const t = await sign(priv, baseClaim({ email_verified: false }))
    const r = await verifyHandoffClaim(pubJwk, t, NOW + 1)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('email_not_verified')
  })

  it('rejects a tampered email (signature mismatch)', async () => {
    const good = await sign(priv, baseClaim())
    const [h, , s] = good.split('.')
    const forged = utf8b64url(JSON.stringify(baseClaim({ email: 'attacker@evil.com' })))
    const r = await verifyHandoffClaim(pubJwk, `${h}.${forged}.${s}`, NOW + 1)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bad_signature')
  })

  it('rejects a public key that carries a private scalar', async () => {
    const t = await sign(priv, baseClaim())
    const bad = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'AAAA', d: 'BBBB' })
    const r = await verifyHandoffClaim(bad, t, NOW + 1)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bad_public_key')
  })

  it('rejects a malformed token', async () => {
    const r = await verifyHandoffClaim(pubJwk, 'nope', NOW)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('malformed')
  })
})
