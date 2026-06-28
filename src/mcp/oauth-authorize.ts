// mupot — OAuth 2.1 authorize handler.
//
// Implements the Google IdP leg of the authorization flow (mupot.OAUTH_PROVIDER='google').
// Pattern ported from mumega's workers/mcp-dispatcher/src/oauth-authorize.ts with
// mupot-specific simplifications:
//   - No cross-pot identity call — sovereign per-pot: email → mupot's OWN members row.
//   - No tenant provision endpoint — mupot IS the tenant (TENANT_SLUG from env).
//   - No BYOA identity sync — mupot manages its own member_tokens.
//   - Google only (mupot [vars] OAUTH_PROVIDER='google').
//
// Design: Q1(a) — authorize-mints/resolves a member_tokens row:
//   On consent the flow finds-or-creates a `members` row by email, mints a
//   `member_tokens` row for it (channel='directory', agentId=null), and stores
//   {memberId, tokenId} as `props` in the OAuthProvider's completeAuthorization.
//   At /mcp, resolveExternalToken is called with the OAuth bearer — it reads the
//   props from KV and calls resolveCapabilities(env, memberId) fresh each request
//   (no frozen capabilities in props — C2).
//
// Auto-synthesized by the library: /.well-known/oauth-authorization-server,
//   /.well-known/oauth-protected-resource, /token, /register.
// This file handles: /authorize → Google redirect, /oauth/google-callback → complete.

import type { Env } from '../types'
import { resolveCapabilities } from '../auth/capability'
import { sha256Hex, mintRawToken } from '../members/service'

// ── OAuth props stored via completeAuthorization ─────────────────────────────
// Encrypted by the library; read back via resolveExternalToken.
// Never freeze capabilities into props — C2 requires live re-resolution each request.
export interface OAuthMemberProps {
  memberId: string
  tokenId: string
  email: string | null
}

// ── Google OAuth helpers ──────────────────────────────────────────────────────

function googleAuthorizeUrl(clientId: string, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function googleExchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ id: string; name: string; email: string; emailVerified: boolean }> {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const tokenData = await tokenRes.json() as { access_token?: string; error?: string }
  if (!tokenData.access_token) {
    throw new Error(`Google token exchange failed: ${tokenData.error ?? 'no access_token'}`)
  }

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const user = await userRes.json() as {
    id: string
    name: string
    email: string
    verified_email?: boolean
  }
  if (!user.id) throw new Error('Google userinfo returned no id')
  return {
    id: user.id,
    name: user.name ?? '',
    email: user.email ?? '',
    emailVerified: user.verified_email === true,
  }
}

// ── Member find-or-create (sovereign-per-pot) ─────────────────────────────────
// Maps a verified email to a mupot members row. If no member exists for this
// email, one is created with status='active'. If one exists (suspended), it is
// still returned — the authn middleware blocks suspended principals anyway.
// This does NOT carry cross-pot identity; it is local to this pot's D1.
async function findOrCreateMember(
  env: Env,
  email: string,
  displayName: string,
): Promise<string> { // returns member_id
  const existing = await env.DB.prepare(
    'SELECT id FROM members WHERE email = ?1 LIMIT 1',
  ).bind(email).first<{ id: string }>()
  if (existing) return existing.id

  const memberId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
     VALUES (?1, ?2, ?3, NULL, 'active', datetime('now'), ?4)`,
  ).bind(memberId, email, displayName.trim().slice(0, 128) || email, env.TENANT_SLUG).run()
  return memberId
}

// ── Token mint for OAuth seat ─────────────────────────────────────────────────
// Mints a member_tokens row for the OAuth seat.
// channel='directory' (the OAuth door); agentId=null (human/operator principal).
// Capabilities default = ZERO (C6): no capabilities row is inserted here; the
// member lands with an empty resolveCapabilities result, which means every
// capability check returns false unless an admin subsequently grants something.
// The legacyRoleSatisfies escape in capability.ts grants org-admin for owner/admin
// ROLE only when capabilities is UNDEFINED (not present in AuthContext) — our
// OAuth-minted AuthContext always carries a defined (possibly empty) capabilities
// array, so that escape is unreachable for OAuth principals.
async function mintDirectoryToken(
  env: Env,
  memberId: string,
  label: string,
): Promise<{ tokenId: string; tokenHash: string }> {
  const raw = mintRawToken()
  const tokenHash = await sha256Hex(raw)
  const tokenId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id)
     VALUES (?1, ?2, ?3, ?4, 'directory', datetime('now'), NULL)`,
  ).bind(tokenId, memberId, tokenHash, label).run()
  // Raw is intentionally discarded here — the OAuth access token IS the credential;
  // the member_tokens row exists purely for capability resolution and revocation.
  // The raw token is never returned to the caller (it is not the OAuth access token).
  return { tokenId, tokenHash }
}

// ── resolveExternalToken — called by OAuthProvider for non-owned bearers ──────
// C1: The OAuthProvider calls this when a bearer it doesn't recognize arrives at
// an apiRoute path. For mupot's member API keys (mupot_... prefix) this is
// the secondary door. We authenticate the bearer via the member_tokens hash lookup
// and return {props} on success, null on failure.
//
// NOTE: The primary door (OAuth-minted tokens owned by the provider) is handled
// BEFORE resolveExternalToken and never reaches this function. This function
// only runs for bearers the OAuthProvider's internal KV does NOT recognize.
export async function resolveExternalToken(
  env: Env,
  token: string,
): Promise<{ props: OAuthMemberProps } | null> {
  // Namespace non-overlap assertion (C4): OAuth tokens are issued as
  // "userId:grantId:secret" format (3 colon-separated segments). mupot member
  // keys always start with "mupot_" (64 hex chars after the prefix). These two
  // namespaces are structurally disjoint — an OAuth token will never pass sha256
  // lookup against member_tokens, and a mupot_ key is never stored in OAUTH_KV.
  const tokenHash = await sha256Hex(token)
  const row = await env.DB.prepare(
    `SELECT m.id AS member_id, m.email AS email, m.status AS status, t.id AS token_id
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
      WHERE t.token_hash = ?1 AND t.revoked_at IS NULL
      LIMIT 1`,
  ).bind(tokenHash).first<{
    member_id: string
    email: string | null
    status: string
    token_id: string
  }>()

  if (!row || row.status !== 'active') return null

  return {
    props: {
      memberId: row.member_id,
      tokenId: row.token_id,
      email: row.email,
    } satisfies OAuthMemberProps,
  }
}

// ── buildAuthContext — props → AuthContext (C2: live capability re-resolution) ─
// Called by McpOAuthApiHandler on every request. Capabilities are resolved fresh
// from D1 — never frozen into props (revocation propagates immediately).
// tenant is hardcoded from env.TENANT_SLUG (never from props) — C2.
//
// B1 — directory-channel capability ceiling (C6 hardening):
// The directory door (OAuth / ChatGPT / Claude connector) is a PUBLIC registration
// surface. Any verified Google account can reach it. A member who ALREADY has admin
// or owner grants (set via the workspace/dashboard door) must NOT inherit those grants
// through the public directory door — that would let any attacker who controls the
// member's Google account bypass the intended zero-capability default for OAuth seats.
//
// Fix: for channel='directory', effective capabilities = [] (zero), regardless of
// what resolveCapabilities returns for the underlying memberId.
//
// The member's grants are still resolved and logged (for audit / future ceiling
// configuration), but they are NOT surfaced to the caller. The empty array ensures
// the legacyRoleSatisfies escape in capability.ts remains unreachable (it only fires
// when capabilities is UNDEFINED, never for an empty array).
//
// An operator who wants their full grants uses the member-API-key door (channel=
// 'workspace'), not the public directory door. The directory door is deliberately
// minimal. If a configurable ceiling is introduced in future, replace [] with
// intersect(resolvedGrants, ceilingGrants).
export async function buildAuthContextFromProps(
  env: Env,
  props: OAuthMemberProps,
): Promise<import('../types').AuthContext | null> {
  // Verify the referenced token is still live (not revoked since authorization).
  const tokenRow = await env.DB.prepare(
    `SELECT m.status AS status
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
      WHERE t.id = ?1 AND t.revoked_at IS NULL
      LIMIT 1`,
  ).bind(props.tokenId).first<{ status: string }>()

  if (!tokenRow || tokenRow.status !== 'active') return null

  // Re-resolve capabilities every request (C2: revocation propagates immediately).
  // The resolved grants are NOT used for the directory channel — see B1 comment above.
  // They are resolved here only so this function remains correct if the channel ceiling
  // is ever made configurable (replace [] with intersect(resolvedGrants, ceiling)).
  await resolveCapabilities(env, props.memberId) // B1: resolved but intentionally discarded

  // B1: directory-channel capability ceiling = [] (zero).
  // An OAuth seat NEVER inherits the member's existing standing grants.
  // criterion-6 "byte-identical for same person" reinterpreted as "for a fresh
  // directory seat" — an existing admin gets zero caps through the directory door.
  const capabilities: import('../types').CapabilityGrant[] = []

  return {
    userId: props.memberId,
    email: props.email,
    role: 'member', // coarse org-role; real authz is `capabilities`
    tenant: env.TENANT_SLUG, // environment-derived, never from props (C2)
    memberId: props.memberId,
    channel: 'directory',
    capabilities, // always defined, always empty for directory — prevents legacyRoleSatisfies escape
    boundAgentId: null, // OAuth seats are pure human/operator principals
  }
}

// ── B2: Per-IP rate limiter for the OAuth registration path ───────────────────
// findOrCreateMember is reachable by ANY verified Google account — it writes a
// members row + member_tokens row. Without a guard an attacker can spam the
// callback to exhaust D1 write budget and pollute the member roster.
//
// Strategy: KV counter in SESSIONS namespace, key = `oauth-reg-rl:<ip>`.
// Window: 5 mints per hour per IP. On exceed: 429 + Retry-After: 3600.
// Fail-open on KV errors (network faults must not lock out legitimate users).
const OAUTH_REG_RL_MAX = 5
const OAUTH_REG_RL_TTL = 3600 // seconds (1 hour)

async function checkOAuthRegRateLimit(env: Env, ip: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const key = `oauth-reg-rl:${ip}`
  try {
    const raw = await env.SESSIONS.get(key)
    const count = raw !== null ? parseInt(raw, 10) : 0
    if (count >= OAUTH_REG_RL_MAX) {
      // KV TTL is set to OAUTH_REG_RL_TTL on first write; we conservatively return
      // the full window as Retry-After (no need to track exact expiry in the value).
      return { allowed: false, retryAfter: OAUTH_REG_RL_TTL }
    }
    // Increment; (re-)set TTL on every increment so the window rolls from first use.
    await env.SESSIONS.put(key, String(count + 1), { expirationTtl: OAUTH_REG_RL_TTL })
    return { allowed: true, retryAfter: 0 }
  } catch {
    // Fail-open: KV unavailability must not block legitimate auth flows.
    return { allowed: true, retryAfter: 0 }
  }
}

// ── B3: CSRF nonce cookie name ─────────────────────────────────────────────────
// The nonce is stored in SESSIONS KV (keyed `oauth-req:<nonce>`) AND echoed as a
// Secure;HttpOnly;SameSite=Lax cookie so the callback can verify that the request
// originated from the same browser that triggered /authorize. This prevents the
// classic OAuth login-CSRF attack where an attacker stitches their own Google
// identity to a victim's session by replaying a valid callback URL.
const CSRF_COOKIE_NAME = 'mupot_oauth_nonce'

// ── Main authorize handler ────────────────────────────────────────────────────
// Mounted at /authorize in src/index.ts (before the dashboardApp catch-all).
// Handles: GET /authorize → redirect to Google (sets CSRF nonce cookie)
//          GET /oauth/google-callback → exchange code, verify nonce cookie, find-or-create member
export async function handleOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const redirectBase = `${url.protocol}//${url.host}`

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return new Response(
      JSON.stringify({ error: 'oauth_not_configured', error_description: 'Google client credentials not set. Deploy prerequisites: wrangler secret put GOOGLE_CLIENT_ID; wrangler secret put GOOGLE_CLIENT_SECRET' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }

  // ── /authorize — parse the OAuth request, redirect to Google ──────────────
  if (url.pathname === '/authorize') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oauthProvider = (env as unknown as { OAUTH_PROVIDER: any }).OAUTH_PROVIDER

    let oauthReqInfo: Record<string, unknown>
    try {
      oauthReqInfo = await oauthProvider.parseAuthRequest(request) as Record<string, unknown>
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'invalid_request', error_description: String(err) }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (!oauthReqInfo.clientId) {
      return new Response('Invalid OAuth request: missing client_id', { status: 400 })
    }

    const nonce = crypto.randomUUID()
    await env.SESSIONS.put(
      `oauth-req:${nonce}`,
      JSON.stringify(oauthReqInfo),
      { expirationTtl: 600 },
    )

    // B3: bind the nonce to the initiating browser via a Secure;HttpOnly;SameSite=Lax
    // cookie. The callback verifies this cookie matches the `state` param before
    // accepting the Google response — prevents login-CSRF.
    const redirectResponse = Response.redirect(
      googleAuthorizeUrl(
        env.GOOGLE_CLIENT_ID,
        nonce,
        `${redirectBase}/oauth/google-callback`,
      ),
      302,
    )
    const responseWithCookie = new Response(redirectResponse.body, redirectResponse)
    // The `secure` flag is omitted for localhost (http:) but applied for https:.
    const secure = url.protocol === 'https:'
    responseWithCookie.headers.set(
      'Set-Cookie',
      `${CSRF_COOKIE_NAME}=${nonce}; HttpOnly; SameSite=Lax; Path=/oauth/google-callback; Max-Age=600${secure ? '; Secure' : ''}`,
    )
    return responseWithCookie
  }

  // ── /oauth/google-callback — exchange code, find-or-create member ──────────
  if (url.pathname === '/oauth/google-callback') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    if (error) {
      return new Response('Google auth denied', { status: 403 })
    }
    if (!code || !state) {
      return new Response('Missing code or state', { status: 400 })
    }

    // B3: verify the CSRF nonce cookie matches the `state` param.
    // If the cookie is absent or mismatched, reject with 403 — the callback did
    // not originate from the browser that initiated /authorize.
    const cookieHeader = request.headers.get('Cookie') ?? ''
    const cookieNonce = parseCookieValue(cookieHeader, CSRF_COOKIE_NAME)
    if (!cookieNonce || cookieNonce !== state) {
      return new Response('CSRF check failed: nonce mismatch', { status: 403 })
    }

    const stored = await env.SESSIONS.get(`oauth-req:${state}`, 'json') as Record<string, unknown> | null
    if (!stored) {
      return new Response('OAuth session expired or invalid state', { status: 400 })
    }
    await env.SESSIONS.delete(`oauth-req:${state}`)

    let googleUser: { id: string; name: string; email: string; emailVerified: boolean }
    try {
      googleUser = await googleExchangeCode(
        code,
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        `${redirectBase}/oauth/google-callback`,
      )
    } catch {
      return new Response('Google auth failed', { status: 502 })
    }

    // Only accept a verified Google email (sovereign-per-pot safety: unverified
    // emails could be spoofed across IdPs; mupot has no cross-pot escape to worry
    // about but the verification gate keeps the member surface clean).
    if (!googleUser.emailVerified) {
      return new Response(
        'Google account email is not verified. Please verify your email with Google and try again.',
        { status: 403 },
      )
    }

    // B2: per-IP rate limit on member mint. The CF-Connecting-IP header is set by
    // Cloudflare on every inbound Worker request; fall back to 'unknown' if absent
    // (local dev / test). The rate limiter uses SESSIONS KV (no new binding needed).
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const rl = await checkOAuthRegRateLimit(env, ip)
    if (!rl.allowed) {
      return new Response('Too many OAuth registrations from this IP. Please try again later.', {
        status: 429,
        headers: {
          'Retry-After': String(rl.retryAfter),
          'Content-Type': 'text/plain',
        },
      })
    }

    // Find-or-create the mupot member row for this verified email.
    let memberId: string
    try {
      memberId = await findOrCreateMember(env, googleUser.email, googleUser.name)
    } catch (err) {
      console.error('[oauth-authorize] member find-or-create failed:', err)
      return new Response('Member provisioning failed', { status: 500 })
    }

    // Mint a directory-channel token for this OAuth seat (show-once raw discarded;
    // the OAuth access token is the credential the client holds). The token row
    // exists for capability resolution and revocation only.
    let tokenId: string
    try {
      const minted = await mintDirectoryToken(
        env,
        memberId,
        `oauth:${googleUser.email.split('@')[0].slice(0, 32)}`,
      )
      tokenId = minted.tokenId
    } catch (err) {
      console.error('[oauth-authorize] token mint failed:', err)
      return new Response('Token mint failed', { status: 500 })
    }

    // Complete the OAuth authorization. The `props` are stored encrypted in
    // the OAuthProvider's KV and surfaced to the apiHandler (McpOAuthApiHandler)
    // via ctx.props on every authenticated request.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oauthProvider = (env as unknown as { OAUTH_PROVIDER: any }).OAUTH_PROVIDER
    let redirectTo: string
    try {
      const result = await oauthProvider.completeAuthorization({
        request: stored,
        userId: `google-${googleUser.id}`,
        metadata: {
          google_email: googleUser.email,
          google_email_verified: googleUser.emailVerified,
        },
        scope: (stored.scope as string[]) ?? ['mcp:read', 'mcp:write'],
        props: {
          memberId,
          tokenId,
          email: googleUser.email,
        } satisfies OAuthMemberProps,
      })
      redirectTo = result.redirectTo
    } catch (err) {
      console.error('[oauth-authorize] completeAuthorization failed:', err)
      return new Response('OAuth completion failed', { status: 500 })
    }

    // B3: clear the CSRF nonce cookie after successful use.
    const finalResponse = Response.redirect(redirectTo, 302)
    const finalWithClear = new Response(finalResponse.body, finalResponse)
    finalWithClear.headers.set(
      'Set-Cookie',
      `${CSRF_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/oauth/google-callback; Max-Age=0`,
    )
    return finalWithClear
  }

  return new Response('Not found', { status: 404 })
}

// ── Cookie parser (minimal; no external dep) ─────────────────────────────────
// Parses a single named cookie value from the `Cookie` request header.
// Returns null if the cookie is absent or its value is empty.
function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const k = trimmed.slice(0, eqIdx).trim()
    const v = trimmed.slice(eqIdx + 1).trim()
    if (k === name) return v.length > 0 ? v : null
  }
  return null
}
