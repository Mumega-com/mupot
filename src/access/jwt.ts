// mupot — Cloudflare Access JWT verification (RS256) for the approve page.
//
// A request that carries `Cf-Access-Jwt-Assertion` is trusted ONLY after this verifies it:
//   - header alg is exactly RS256 (no `none`, no HS*), a `kid` is present, no `crit`;
//   - the signature verifies against the team JWKS (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs);
//   - iss === https://<team>.cloudflareaccess.com, aud contains the configured AUD EXACTLY;
//   - exp is in the future, nbf (if any) is not, and iat is within `maxAgeSeconds` of now (freshness:
//     the Worker, not Access, enforces that this is a just-completed login — Access exposes no auth_time);
//   - the token names a human: `email` and `sub` are non-empty strings (service-token JWTs have neither).
// The JWKS is cached (1h) and refetched when an unknown `kid` shows up (key rotation), at most once per
// 30s so a stream of forged kids cannot turn this into a fetch amplifier. Every clock read takes `nowMs`.

export type AccessJwtFailure =
  | 'missing' | 'malformed' | 'unsupported_alg' | 'unknown_key' | 'bad_signature'
  | 'bad_issuer' | 'bad_audience' | 'expired' | 'not_yet_valid' | 'stale'
  | 'missing_claims' | 'jwks_unavailable'

export interface AccessClaims { email: string; sub: string; iat: number; exp: number }
export type AccessJwtResult = { ok: true; claims: AccessClaims } | { ok: false; reason: AccessJwtFailure }

export interface AccessJwtConfig { teamHost: string; aud: string; maxAgeSeconds: number }
export interface AccessJwtDeps {
  nowMs?: number
  /** Test seam; production uses global fetch. */
  fetchImpl?: (url: string) => Promise<Response>
}

const JWKS_TTL_MS = 60 * 60 * 1000
const JWKS_REFETCH_MIN_MS = 30 * 1000
const CLOCK_SKEW_S = 5

interface JwksEntry { keys: Map<string, CryptoKey>; fetchedAt: number; lastAttemptAt: number }
const jwksCache = new Map<string, JwksEntry>()

export function resetAccessJwksCache(): void { jwksCache.clear() }

function b64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function parseJsonPart(part: string): Record<string, unknown> | null {
  const bytes = b64urlToBytes(part)
  if (!bytes) return null
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null // as: narrowed to a plain object above
  } catch {
    return null
  }
}

async function importRsaJwk(jwk: Record<string, unknown>): Promise<CryptoKey | null> {
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null
  if (jwk.use !== undefined && jwk.use !== 'sig') return null
  try {
    return await crypto.subtle.importKey(
      'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    )
  } catch {
    return null
  }
}

async function fetchJwks(cfg: AccessJwtConfig, deps: AccessJwtDeps, nowMs: number): Promise<JwksEntry | null> {
  const doFetch = deps.fetchImpl ?? ((u: string) => fetch(u, { cf: { cacheTtl: 300 } }))
  try {
    const res = await doFetch(`https://${cfg.teamHost}/cdn-cgi/access/certs`)
    if (!res.ok) return null
    const body: unknown = await res.json()
    const list = body !== null && typeof body === 'object' ? (body as { keys?: unknown }).keys : undefined // as: shape-checked on the next line
    if (!Array.isArray(list)) return null
    const keys = new Map<string, CryptoKey>()
    for (const k of list) {
      if (k === null || typeof k !== 'object') continue
      const jwk = k as Record<string, unknown> // as: object-checked above
      if (typeof jwk.kid !== 'string') continue
      const key = await importRsaJwk(jwk)
      if (key) keys.set(jwk.kid, key)
    }
    return { keys, fetchedAt: nowMs, lastAttemptAt: nowMs }
  } catch {
    return null
  }
}

async function keyFor(kid: string, cfg: AccessJwtConfig, deps: AccessJwtDeps, nowMs: number): Promise<CryptoKey | 'unknown' | 'unavailable'> {
  let entry = jwksCache.get(cfg.teamHost)
  const fresh = entry !== undefined && nowMs - entry.fetchedAt < JWKS_TTL_MS
  if (entry && fresh) {
    const hit = entry.keys.get(kid)
    if (hit) return hit
  }
  // Unknown kid (rotation) or expired cache: refetch, rate limited.
  if (!entry || !fresh || nowMs - entry.lastAttemptAt >= JWKS_REFETCH_MIN_MS) {
    const next = await fetchJwks(cfg, deps, nowMs)
    if (next) {
      jwksCache.set(cfg.teamHost, next)
      entry = next
    } else if (entry) {
      entry.lastAttemptAt = nowMs
    }
  }
  if (!entry) return 'unavailable'
  return entry.keys.get(kid) ?? (entry.keys.size === 0 ? 'unavailable' : 'unknown')
}

export async function verifyAccessJwt(
  token: string | null | undefined,
  cfg: AccessJwtConfig,
  deps: AccessJwtDeps = {},
): Promise<AccessJwtResult> {
  const nowMs = deps.nowMs ?? Date.now()
  if (!token) return { ok: false, reason: 'missing' }
  const parts = token.split('.')
  if (parts.length !== 3 || token.length > 8192) return { ok: false, reason: 'malformed' }
  const header = parseJsonPart(parts[0])
  const payload = parseJsonPart(parts[1])
  const sig = b64urlToBytes(parts[2])
  if (!header || !payload || !sig) return { ok: false, reason: 'malformed' }
  if (header.alg !== 'RS256' || header.crit !== undefined) return { ok: false, reason: 'unsupported_alg' }
  if (typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 200) return { ok: false, reason: 'malformed' }

  const key = await keyFor(header.kid, cfg, deps, nowMs)
  if (key === 'unavailable') return { ok: false, reason: 'jwks_unavailable' }
  if (key === 'unknown') return { ok: false, reason: 'unknown_key' }
  const valid = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  if (!valid) return { ok: false, reason: 'bad_signature' }

  // Signature holds: claims are the issuer's. Still check every one.
  if (payload.iss !== `https://${cfg.teamHost}`) return { ok: false, reason: 'bad_issuer' }
  const aud = payload.aud
  const audOk = typeof aud === 'string' ? aud === cfg.aud : Array.isArray(aud) && aud.some((a) => a === cfg.aud)
  if (!audOk) return { ok: false, reason: 'bad_audience' }

  const nowS = Math.floor(nowMs / 1000)
  const { exp, iat, nbf } = payload
  if (typeof exp !== 'number' || typeof iat !== 'number' || !Number.isFinite(exp) || !Number.isFinite(iat)) {
    return { ok: false, reason: 'missing_claims' }
  }
  if (exp <= nowS) return { ok: false, reason: 'expired' }
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf > nowS + CLOCK_SKEW_S)) return { ok: false, reason: 'not_yet_valid' }
  if (iat > nowS + CLOCK_SKEW_S) return { ok: false, reason: 'not_yet_valid' }
  if (nowS - iat > cfg.maxAgeSeconds) return { ok: false, reason: 'stale' }

  const { email, sub } = payload
  if (typeof email !== 'string' || email.length === 0 || email.length > 254 || typeof sub !== 'string' || sub.length === 0 || sub.length > 200) {
    return { ok: false, reason: 'missing_claims' }
  }
  return { ok: true, claims: { email, sub, iat, exp } }
}
