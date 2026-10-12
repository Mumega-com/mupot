// mupot secure-drop browser sealer: HPKE RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM.
// Exposes window.MupotHpke = { seal, fingerprint, b64uDecode, b64uEncode }. No network, no storage, no globals but this one.
import { CipherSuite, HkdfSha256, Aes128Gcm } from '@hpke/core'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() })

export function b64uEncode(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function b64uDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad_b64u')
  const p = str.replace(/-/g, '+').replace(/_/g, '/')
  const b = atob(p + '='.repeat((4 - (p.length % 4)) % 4))
  const u = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i)
  return u
}
const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')

/** sha256(raw 32-byte public key), lowercase hex (64 chars). */
export async function fingerprint(pubB64u) {
  const raw = b64uDecode(pubB64u)
  if (raw.length !== 32) throw new Error('bad_public_key')
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
}

/** One sender context per secret, sealed once. info/aad are strings (UTF-8). Returns base64url {enc, ct}. */
export async function seal(pubB64u, info, aad, plaintext) {
  const raw = b64uDecode(pubB64u)
  if (raw.length !== 32) throw new Error('bad_public_key')
  const te = new TextEncoder()
  const recipientPublicKey = await suite.kem.deserializePublicKey(raw.buffer)
  const sender = await suite.createSenderContext({ recipientPublicKey, info: te.encode(info) })
  const ct = new Uint8Array(await sender.seal(plaintext, te.encode(aad)))
  return { enc: b64uEncode(new Uint8Array(sender.enc)), ct: b64uEncode(ct) }
}
