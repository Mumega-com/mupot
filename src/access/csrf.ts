// mupot — CSRF token for the approve page. Stateless: HMAC-SHA256 over
// (kind, request id, Access subject, JWT iat), key = HKDF-SHA256(CONNECTOR_MASTER_KEY,
// info 'mupot_access_approve_csrf_v1'). Bound to the Access login that rendered the form, so a token
// from another login, another request or another page is worthless. No master key => no token => POST
// fails closed (503). The POST also requires a same-origin Origin header (routes.ts).
import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'

const HKDF_INFO = 'mupot_access_approve_csrf_v1'

function hexKey(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function deriveKey(masterHex: string | undefined): Promise<CryptoKey | null> {
  const raw = masterHex ? hexKey(masterHex) : null
  if (!raw) return null
  const master = await crypto.subtle.importKey('raw', raw, { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    master, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
  )
}

async function mac(key: CryptoKey, kind: string, id: string, sub: string, iat: number): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`mupot:access-approve:v1|${kind}|${id}|${sub}|${iat}`))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function issueCsrfToken(env: Pick<Env, 'CONNECTOR_MASTER_KEY'>, kind: string, id: string, sub: string, iat: number): Promise<string | null> {
  const key = await deriveKey(env.CONNECTOR_MASTER_KEY)
  return key ? mac(key, kind, id, sub, iat) : null
}

export async function verifyCsrfToken(
  env: Pick<Env, 'CONNECTOR_MASTER_KEY'>, kind: string, id: string, sub: string, iat: number, token: unknown,
): Promise<'ok' | 'invalid' | 'unavailable'> {
  const key = await deriveKey(env.CONNECTOR_MASTER_KEY)
  if (!key) return 'unavailable'
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return 'invalid'
  return timingSafeEqual(token, await mac(key, kind, id, sub, iat)) ? 'ok' : 'invalid'
}
