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
    `INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at)
     VALUES (?1, ?2, ?3, NULL, 'active', datetime('now'))`,
  ).bind(memberId, email, displayName.trim().slice(0, 128) || email).run()
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

  // Re-resolve capabilities every request (C2: revocation propagates).
  const capabilities = await resolveCapabilities(env, props.memberId)

  return {
    userId: props.memberId,
    email: props.email,
    role: 'member', // coarse org-role; real authz is `capabilities`
    tenant: env.TENANT_SLUG, // environment-derived, never from props (C2)
    memberId: props.memberId,
    channel: 'directory',
    capabilities, // always defined (possibly empty) — prevents legacyRoleSatisfies escape
    boundAgentId: null, // OAuth seats are pure human/operator principals
  }
}

// ── Main authorize handler ────────────────────────────────────────────────────
// Mounted at /authorize in src/index.ts (before the dashboardApp catch-all).
// Handles: GET /authorize → redirect to Google
//          GET /oauth/google-callback → exchange code, find-or-create member, completeAuthorization
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

    return Response.redirect(
      googleAuthorizeUrl(
        env.GOOGLE_CLIENT_ID,
        nonce,
        `${redirectBase}/oauth/google-callback`,
      ),
      302,
    )
  }

  // ── /oauth/google-callback — exchange code, find-or-create member ──────────
  if (url.pathname === '/oauth/google-callback') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    if (error) {
      return new Response(`Google auth denied: ${error}`, { status: 403 })
    }
    if (!code || !state) {
      return new Response('Missing code or state', { status: 400 })
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
    } catch (err) {
      return new Response(`Google auth failed: ${err}`, { status: 502 })
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

    // Find-or-create the mupot member row for this verified email.
    let memberId: string
    try {
      memberId = await findOrCreateMember(env, googleUser.email, googleUser.name)
    } catch (err) {
      console.error('[oauth-authorize] member find-or-create failed:', err)
      return new Response(`Member provisioning failed: ${err}`, { status: 500 })
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
      return new Response(`Token mint failed: ${err}`, { status: 500 })
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
      return new Response(`OAuth completion failed: ${err}`, { status: 500 })
    }

    return Response.redirect(redirectTo, 302)
  }

  return new Response('Not found', { status: 404 })
}
