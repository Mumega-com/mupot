// mupot — seed accept token. Binds an apply to a dry run: the dry run returns a token that is an
// HMAC over (seed digest, member id, issue time); apply refuses without a fresh token for the SAME
// member and the SAME digest. Request keys are a deterministic hash of the seed text, so on their own
// they could be precomputed by an author; the token cannot be (it needs the server secret).
//
// Secret: CONNECTOR_MASTER_KEY (64 hex chars), the existing server-only master key (already a deploy
// prerequisite for connectors). The HMAC key is NOT the master key: it is derived with HKDF-SHA256,
// info 'mupot_seed_accept_v1', empty salt (src/connectors/crypto.ts shares only the HKDF-SHA256
// construction; it salts per connector id). Absent or
// malformed => no token is issued and apply fails closed (503 accept_token_unavailable). Rotating the
// master key invalidates outstanding tokens (15 minute lifetime: harmless). No tokens exist in
// production yet, so moving off the earlier direct-key scheme invalidates nothing.
import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'

export const ACCEPT_TOKEN_TTL_MS = 15 * 60 * 1000
export type AcceptTokenCheck = 'ok' | 'invalid' | 'unavailable'

const HKDF_INFO = 'mupot_seed_accept_v1'

function hexKey(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function deriveMacKey(masterHex: string): Promise<CryptoKey | null> {
  const raw = hexKey(masterHex)
  if (!raw) return null
  const master = await crypto.subtle.importKey('raw', raw, { name: 'HKDF' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    master, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
  )
}

async function mac(key: CryptoKey, memberId: string, seedSha256: string, issuedMs: number): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`mupot:seed-accept:v1|${seedSha256}|${memberId}|${issuedMs}`))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function issueAcceptToken(env: Pick<Env, 'CONNECTOR_MASTER_KEY'>, memberId: string, seedSha256: string, nowMs: number = Date.now()): Promise<string | null> {
  const key = env.CONNECTOR_MASTER_KEY ? await deriveMacKey(env.CONNECTOR_MASTER_KEY) : null
  if (!key) return null
  return `${nowMs}.${await mac(key, memberId, seedSha256, nowMs)}`
}

export async function verifyAcceptToken(
  env: Pick<Env, 'CONNECTOR_MASTER_KEY'>, memberId: string, seedSha256: string, token: unknown, nowMs: number = Date.now(),
): Promise<AcceptTokenCheck> {
  const key = env.CONNECTOR_MASTER_KEY ? await deriveMacKey(env.CONNECTOR_MASTER_KEY) : null
  if (!key) return 'unavailable'
  if (typeof token !== 'string') return 'invalid'
  const m = /^([1-9]\d{9,15})\.([0-9a-f]{64})$/.exec(token)
  if (!m) return 'invalid'
  const issued = Number(m[1])
  if (!Number.isSafeInteger(issued) || issued > nowMs + 60_000 || nowMs - issued > ACCEPT_TOKEN_TTL_MS) return 'invalid'
  return timingSafeEqual(m[2], await mac(key, memberId, seedSha256, issued)) ? 'ok' : 'invalid'
}
