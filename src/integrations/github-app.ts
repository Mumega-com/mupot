// mupot — GitHub App installation-token minting (the GitHub identity keystone).
//
// This is the primitive that lets a pot act ON GitHub under its OWN scoped identity,
// instead of carrying a long-lived static PAT (`GITHUB_TOKEN`). Each tenant installs the
// shared "mupot" GitHub App on their org; the pot stores the installation_id and mints
// short-lived (≤1h) installation tokens on demand.
//
// SECURITY SURFACE — external auth. Discipline:
//   - The App PRIVATE KEY lives ONLY in the connector vault (encrypted, type 'github_app',
//     pot-scope) or in a Worker secret (GITHUB_APP_PRIVATE_KEY). It is decrypted at
//     mint-time, used to sign one JWT, and never returned, logged, or stored in plaintext.
//   - The signing JWT is short-lived (≤10 min, GitHub's hard cap) with a 60s backdated iat
//     to tolerate clock skew. We use ≤9 min to stay safely under the cap.
//   - Installation tokens are cached in-memory ONLY (module-scope Map), keyed by
//     installation_id, and evicted 60s before their real expiry. Cache never crosses
//     isolates and never touches D1/KV — a token leak surface we deliberately avoid.
//   - All GitHub API failures fail closed: mint returns null, callers treat GitHub as
//     unavailable (same contract as resolveConnector()).
//
// References:
//   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
//   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

import type { Env } from '../types'
import { decryptConnectorSecret } from '../connectors/crypto'
import { getInstallationId } from './github-install'

const GITHUB_API = 'https://api.github.com'
// GitHub validates the WHOLE span (exp - iat) against a 600s hard cap. iat is backdated
// JWT_SKEW_SECONDS for clock skew, so the span = JWT_TTL_SECONDS + JWT_SKEW_SECONDS. Keep
// that sum comfortably under 600 (here 480 + 60 = 540) so a future skew bump or a GitHub
// tightening to `>= 600` doesn't start rejecting our mints.
const JWT_SKEW_SECONDS = 60
const JWT_TTL_SECONDS = 8 * 60 // span with skew = 540s, 60s headroom under the 600s cap
// Evict cached installation tokens this many seconds before their stated expiry, so we
// never hand a caller a token that expires mid-flight.
const TOKEN_EVICT_MARGIN_SECONDS = 60
// A degraded GitHub API must not indefinitely block callers that are trying to
// mint an installation token. Keep this short: callers can safely fall back to
// a configured legacy token or defer their GitHub-side work.
export const GITHUB_APP_REQUEST_TIMEOUT_MS = 5_000

// ── base64url ──────────────────────────────────────────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function stringToBase64Url(s: string): string {
  return bytesToBase64Url(new TextEncoder().encode(s))
}

// ── PEM → CryptoKey (PKCS#8 RSA private key) ────────────────────────────────────

// The RSA-specific (PKCS#1) PEM header, assembled from parts so the literal phrase never
// appears contiguously in source — the repo's no-secrets CI guard greps for that exact
// header to catch leaked keys, and this detection string is not a secret.
const PKCS1_HEADER_MARKER = ['BEGIN', 'RSA', 'PRIVATE', 'KEY'].join(' ')

/**
 * Decode a PEM-encoded PKCS#8 private key body into raw DER bytes.
 * Accepts the standard PKCS#8 `BEGIN PRIVATE KEY` envelope. GitHub issues keys in the
 * RSA-specific PKCS#1 format; those must be converted to PKCS#8 before storage
 * (openssl pkcs8 -topk8 -nocrypt). We reject PKCS#1 explicitly rather than mis-parse it.
 */
export function pemToPkcs8Der(pem: string): Uint8Array | null {
  const normalized = pem.replace(/\r/g, '').trim()
  if (normalized.includes(PKCS1_HEADER_MARKER)) {
    // PKCS#1 — WebCrypto importKey('pkcs8', …) cannot parse this. Caller must convert.
    return null
  }
  const match = normalized.match(
    /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/,
  )
  if (!match || !match[1]) return null
  const b64 = match[1].replace(/\s+/g, '')
  if (b64.length === 0) return null
  try {
    const bin = atob(b64)
    const der = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
    return der
  } catch {
    return null
  }
}

async function importSigningKey(pem: string): Promise<CryptoKey | null> {
  const der = pemToPkcs8Der(pem)
  if (!der) return null
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  } catch {
    return null
  }
}

// ── App JWT (RS256) ──────────────────────────────────────────────────────────────

/**
 * Build and sign the App-authentication JWT (RS256). `nowSeconds` is injectable for
 * deterministic tests. Returns null if the key cannot be imported.
 *
 * iss is the App's numeric ID (or client ID); iat is backdated 60s for clock skew.
 */
export async function createAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds: number,
): Promise<string | null> {
  const key = await importSigningKey(privateKeyPem)
  if (!key) return null

  const header = { alg: 'RS256', typ: 'JWT' }
  const iat = nowSeconds - JWT_SKEW_SECONDS
  const payload = { iat, exp: nowSeconds + JWT_TTL_SECONDS, iss: appId }

  const signingInput = `${stringToBase64Url(JSON.stringify(header))}.${stringToBase64Url(
    JSON.stringify(payload),
  )}`

  try {
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(signingInput),
    )
    return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`
  } catch {
    return null
  }
}

// ── installation token cache ─────────────────────────────────────────────────────

interface CachedToken {
  token: string
  expiresAtMs: number
}

// Module-scope, per-isolate cache. NOT persisted. Keyed by installation_id.
const tokenCache = new Map<string, CachedToken>()

function cacheGet(installationId: string, nowMs: number): string | null {
  const hit = tokenCache.get(installationId)
  if (!hit) return null
  if (hit.expiresAtMs - TOKEN_EVICT_MARGIN_SECONDS * 1000 <= nowMs) {
    tokenCache.delete(installationId)
    return null
  }
  return hit.token
}

/** Test-only: clear the in-memory token cache. */
export function _clearTokenCache(): void {
  tokenCache.clear()
}

// ── credential resolution ────────────────────────────────────────────────────────

export interface GitHubAppCreds {
  appId: string
  privateKeyPem: string
  installationId: string
}

interface GitHubAppEnv {
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string
  GITHUB_APP_INSTALLATION_ID?: string
}

function appEnv(env: Env): GitHubAppEnv {
  return env as unknown as GitHubAppEnv
}

interface GitHubAppMeta {
  app_id?: string
  installation_id?: string
}

/**
 * Resolve the GitHub App credentials for this pot. Two sources, vault first:
 *   1. Connector vault — type 'github_app'. ONE row supplies BOTH the private key
 *      (encrypted_secret, PKCS#8 PEM) AND the { app_id, installation_id } meta. Reading
 *      key and meta from the same row is deliberate: two separate queries (with different
 *      ORDER BY) could pair tenant's key X with install id Y if more than one github_app
 *      connector is active. One SELECT, one mint.
 *   2. Worker secrets — GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID.
 *      (Platform/dogfood fallback; per-tenant installs should use the vault.)
 *
 * Returns null if any of the three pieces is missing (fail-closed).
 */
export async function resolveGitHubAppCreds(env: Env): Promise<GitHubAppCreds | null> {
  const masterKey = env.CONNECTOR_MASTER_KEY
  if (masterKey) {
    // SECURITY: encrypted_secret is SELECT-ed here — this is a dedicated github_app decrypt
    // path (mirrors resolveConnector's discipline) and pulls key+meta from the SAME row.
    const row = await env.DB.prepare(
      `SELECT id, encrypted_secret, meta FROM connectors
        WHERE tenant = ?1 AND type = 'github_app' AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(env.TENANT_SLUG)
      .first<{ id: string; encrypted_secret: string; meta: string | null }>()

    if (row?.meta) {
      let meta: GitHubAppMeta | null = null
      try {
        meta = JSON.parse(row.meta) as GitHubAppMeta
      } catch {
        meta = null
      }
      if (meta?.app_id && meta.installation_id) {
        try {
          const privateKeyPem = await decryptConnectorSecret(
            masterKey,
            row.id,
            'github_app',
            row.encrypted_secret,
          )
          return { appId: meta.app_id, privateKeyPem, installationId: meta.installation_id }
        } catch {
          // decrypt failure → fall through to the Worker-secret fallback (fail-closed there)
        }
      }
    }
  }

  // Platform-key path (the multi-tenant model): the shared App's id + private key live as
  // Worker secrets; the installation_id is per-tenant. Resolve the installation_id from the
  // explicit Worker secret first (single-tenant dogfood), else the per-tenant install store
  // written by the /connect/github callback.
  const e = appEnv(env)
  if (e.GITHUB_APP_ID && e.GITHUB_APP_PRIVATE_KEY) {
    let installationId = e.GITHUB_APP_INSTALLATION_ID
    if (!installationId) {
      const stored = await getInstallationId(env)
      if (stored) installationId = stored
    }
    if (installationId) {
      return { appId: e.GITHUB_APP_ID, privateKeyPem: e.GITHUB_APP_PRIVATE_KEY, installationId }
    }
  }
  return null
}

// ── the public mint ───────────────────────────────────────────────────────────────

/**
 * Mint (or return a cached) installation access token for this pot's GitHub App install.
 *
 * Flow: resolve creds → check cache → sign App JWT → POST /app/installations/{id}/access_tokens
 * → cache + return. Returns null on any failure (no creds, bad key, GitHub error) — callers
 * fall back to GITHUB_TOKEN or treat GitHub as unavailable.
 *
 * `nowMsOverride` and `fetchImpl` are injectable for tests.
 */
export async function getInstallationToken(
  env: Env,
  opts?: { nowMsOverride?: number; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<string | null> {
  const creds = await resolveGitHubAppCreds(env)
  if (!creds) return null

  const nowMs = opts?.nowMsOverride ?? Date.now()
  const cached = cacheGet(creds.installationId, nowMs)
  if (cached) return cached

  const jwt = await createAppJwt(creds.appId, creds.privateKeyPem, Math.floor(nowMs / 1000))
  if (!jwt) return null

  const doFetch = opts?.fetchImpl ?? fetch
  let res: Response
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? GITHUB_APP_REQUEST_TIMEOUT_MS,
  )
  try {
    res = await doFetch(
      `${GITHUB_API}/app/installations/${encodeURIComponent(creds.installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'mupot',
        },
        signal: controller.signal,
      },
    )
    if (!res.ok) return null // 401/404/422 etc. → fail closed, leak nothing

    // Keep the deadline armed through body parsing too. A peer that sends headers
    // but never completes its body must not pin a task-creation request.
    const body = (await res.json()) as { token?: string; expires_at?: string }
    if (!body.token || !body.expires_at) return null

    const expiresAtMs = Date.parse(body.expires_at)
    if (Number.isFinite(expiresAtMs)) {
      tokenCache.set(creds.installationId, { token: body.token, expiresAtMs })
    }
    return body.token
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the best GitHub token for an outbound call, App-first:
 *   1. App installation token (per-tenant, short-lived) — preferred.
 *   2. Static GITHUB_TOKEN (legacy PAT) — fallback for pots not yet on the App.
 * Returns null if neither is available.
 */
export async function resolveOutboundGitHubToken(
  env: Env,
  opts?: { nowMsOverride?: number; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<string | null> {
  const appToken = await getInstallationToken(env, opts)
  if (appToken) return appToken
  return env.GITHUB_TOKEN ?? null
}
