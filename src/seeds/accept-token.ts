// mupot — seed accept token. Binds an apply to a dry run: the dry run returns a token that is an
// HMAC over (seed digest, member id, issue time); apply refuses without a fresh token for the SAME
// member and the SAME digest. Request keys are a deterministic hash of the seed text, so on their own
// they could be precomputed by an author; the token cannot be (it needs the server secret).
//
// Secret: CONNECTOR_MASTER_KEY, the existing server-only master key (already a deploy prerequisite for
// connectors, same domain-separated HMAC use as the harness identity probe). No new secret is added.
// Absent => no token is issued and apply fails closed (503 accept_token_unavailable).
import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'

export const ACCEPT_TOKEN_TTL_MS = 15 * 60 * 1000
export type AcceptTokenCheck = 'ok' | 'invalid' | 'unavailable'

async function mac(secret: string, memberId: string, seedSha256: string, issuedMs: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`mupot:seed-accept:v1|${seedSha256}|${memberId}|${issuedMs}`))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function issueAcceptToken(env: Pick<Env, 'CONNECTOR_MASTER_KEY'>, memberId: string, seedSha256: string, nowMs: number = Date.now()): Promise<string | null> {
  const secret = env.CONNECTOR_MASTER_KEY
  if (!secret) return null
  return `${nowMs}.${await mac(secret, memberId, seedSha256, nowMs)}`
}

export async function verifyAcceptToken(
  env: Pick<Env, 'CONNECTOR_MASTER_KEY'>, memberId: string, seedSha256: string, token: unknown, nowMs: number = Date.now(),
): Promise<AcceptTokenCheck> {
  const secret = env.CONNECTOR_MASTER_KEY
  if (!secret) return 'unavailable'
  if (typeof token !== 'string') return 'invalid'
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(token)
  if (!m) return 'invalid'
  const issued = Number(m[1])
  if (!Number.isSafeInteger(issued) || issued > nowMs + 60_000 || nowMs - issued > ACCEPT_TOKEN_TTL_MS) return 'invalid'
  return timingSafeEqual(m[2], await mac(secret, memberId, seedSha256, issued)) ? 'ok' : 'invalid'
}
