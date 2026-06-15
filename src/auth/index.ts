// mupot — auth + login (SENSITIVE).
//
// Sovereign core principle: AuthN (proving who you are) is delegated to the
// perimeter OAuth provider; AuthZ (what you may do) is OURS — app-layer RBAC
// that runs on any cloud. We NEVER trust a client-supplied identity: the only
// thing the client carries is an opaque, random session id in an HttpOnly
// Secure cookie. The session record (user id, email, role) lives server-side
// in KV and is re-loaded on every request.
//
// Exports:
//   - authApp      : Hono sub-app mounted at ROUTES.auth ('/auth')
//   - requireAuth  : Hono middleware → sets c.get('auth') = AuthContext | 401
//   - requireRole  : factory → middleware enforcing a minimum org role | 403

import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context, MiddlewareHandler } from 'hono'
import type { Env, AuthContext } from '../types'
import { verifyHandoffClaim } from './handoff-verify'

// ── tunables ──
const COOKIE_NAME = 'mupot_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days
const STATE_TTL_SECONDS = 60 * 10 // OAuth state/PKCE lifetime
const SESSION_PREFIX = 'sess:'
const STATE_PREFIX = 'oauthstate:'

type OrgRole = AuthContext['role']

// Server-side session record. The cookie carries ONLY the random id.
interface SessionRecord {
  userId: string
  email: string | null
  role: OrgRole
  createdAt: string
}

// Role precedence for the minimum-role gate: owner > admin > member.
const ROLE_RANK: Record<OrgRole, number> = {
  member: 1,
  admin: 2,
  owner: 3,
}

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

// ── helpers ─────────────────────────────────────────────────────────────────

/** Cryptographically-random opaque id (URL-safe, no padding). */
function randomId(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return s
}

/** Stable user id derived from provider identity — deterministic, not secret. */
async function deriveUserId(provider: string, subject: string): Promise<string> {
  const data = new TextEncoder().encode(`${provider}:${subject}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s.slice(0, 32)
}

function sessionKey(id: string): string {
  return `${SESSION_PREFIX}${id}`
}

function stateKey(state: string): string {
  return `${STATE_PREFIX}${state}`
}

/** Resolve the OAuth provider; default google. */
function provider(env: Env): 'google' | 'telegram' {
  return env.OAUTH_PROVIDER ?? 'google'
}

/** Absolute redirect URI back to /auth/callback for this request's origin. */
function callbackUrl(reqUrl: string): string {
  const u = new URL(reqUrl)
  return `${u.origin}/auth/callback`
}

// ── OAuth: Google (Authorization Code) ───────────────────────────────────────
// Only Google's web flow is implemented here. Telegram's Login Widget is a
// different (signed-payload) flow handled at the perimeter; for that provider we
// fail closed rather than pretend to support a code exchange.

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'

interface GoogleToken {
  access_token: string
  expires_in: number
  token_type: string
}

interface GoogleUserInfo {
  sub: string
  email?: string
  email_verified?: boolean
}

// ── routes ────────────────────────────────────────────────────────────────

export const authApp = new Hono<AppEnv>()

// GET /auth/login → redirect to the provider's consent screen.
authApp.get('/login', async (c) => {
  const env = c.env
  if (provider(env) !== 'google') {
    return c.json({ error: 'unsupported_provider', provider: provider(env) }, 400)
  }
  if (!env.OAUTH_CLIENT_ID) {
    return c.json({ error: 'oauth_not_configured' }, 500)
  }

  // CSRF state — random, single-use, stored server-side (KV) with short TTL.
  const state = randomId(24)
  await env.SESSIONS.put(stateKey(state), '1', { expirationTtl: STATE_TTL_SECONDS })

  const params = new URLSearchParams({
    client_id: env.OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl(c.req.url),
    response_type: 'code',
    scope: 'openid email',
    state,
    access_type: 'online',
    prompt: 'select_account',
  })
  return c.redirect(`${GOOGLE_AUTH}?${params.toString()}`)
})

// GET /auth/callback → exchange code, upsert user, mint session, set cookie.
authApp.get('/callback', async (c) => {
  const env = c.env
  if (provider(env) !== 'google') {
    return c.json({ error: 'unsupported_provider' }, 400)
  }
  if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET) {
    return c.json({ error: 'oauth_not_configured' }, 500)
  }

  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) {
    return c.json({ error: 'missing_code_or_state' }, 400)
  }

  // Validate + consume the CSRF state (single-use).
  const seen = await env.SESSIONS.get(stateKey(state))
  if (!seen) {
    return c.json({ error: 'invalid_state' }, 400)
  }
  await env.SESSIONS.delete(stateKey(state))

  // Exchange the authorization code for an access token.
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.OAUTH_CLIENT_ID,
      client_secret: env.OAUTH_CLIENT_SECRET,
      redirect_uri: callbackUrl(c.req.url),
      grant_type: 'authorization_code',
    }).toString(),
  })
  if (!tokenRes.ok) {
    return c.json({ error: 'token_exchange_failed' }, 401)
  }
  const token = (await tokenRes.json()) as GoogleToken

  // Fetch the verified identity from the provider.
  const infoRes = await fetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${token.access_token}` },
  })
  if (!infoRes.ok) {
    return c.json({ error: 'userinfo_failed' }, 401)
  }
  const info = (await infoRes.json()) as GoogleUserInfo
  if (!info.sub) {
    return c.json({ error: 'no_subject' }, 401)
  }
  // Require a verified email — unverified emails are not a trustworthy identity.
  // Strict !== true: an omitted/undefined email_verified (some Workspace configs /
  // partial userinfo) must NOT pass. A verified email is the cross-path dedup key
  // (#262) — an unverified-email row here would poison a handoff claim's dedup match.
  if (info.email && info.email_verified !== true) {
    return c.json({ error: 'email_unverified' }, 403)
  }

  const derivedId = await deriveUserId('google', info.sub)
  const email = info.email ?? null

  // Dedup on verified email (#262): a prior mumega SSO handoff may have already
  // created this user — reuse that row so one human = one mupot user. `userId` is
  // canonical (may differ from derivedId if email-matched). allowBootstrapOwner=true:
  // the pot's own Google login is the legitimate first-owner path.
  const { id: userId, role } = await upsertUserByEmail(env, derivedId, email, true)

  // Mint the session: random opaque id → server-side record in KV.
  const sessionId = randomId(32)
  const record: SessionRecord = {
    userId,
    email,
    role,
    createdAt: new Date().toISOString(),
  }
  await env.SESSIONS.put(sessionKey(sessionId), JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  })

  setSessionCookie(c, sessionId)
  return c.redirect('/')
})

// GET /auth/handoff?token= → accept a mumega-signed verified-email claim (#262).
// The SSO seam: mumega (issuer) verified the email; we (relying party) verify its
// signature with mumega's PUBLIC key only, then mint our OWN session. Additive — the
// pot keeps its own Google OAuth (/login, /callback). Any failure falls back to our
// own login (never strands the user, never trusts an unverified/replayed claim).
authApp.get('/handoff', async (c) => {
  const env = c.env
  // Keep the token-bearing URL out of the Referer sent to any resource the landing
  // page loads, and out of shared/browser caches. (#262 P2-a; CF edge-log residual is
  // internal + acceptable given the 60s one-time claim.)
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')

  const token = c.req.query('token')
  if (!token) return c.redirect('/auth/login')

  // Verify signature + alg + aud + iss + email_verified + exp with the PUBLIC key only.
  const res = await verifyHandoffClaim(env.MUPOT_HANDOFF_PUBLIC_KEY, token)
  if (!res.ok || !res.claim) return c.redirect('/auth/login')

  // One-time: consume the jti so a captured claim can't be replayed. KV get-then-put
  // is NON-ATOMIC (CF KV has no CAS) → a concurrent same-token replay within the 60s
  // window can race. Accepted (River μ5 proportionality, #262): the residual is
  // duplicate sessions for the SAME already-verified identity (no escalation — the
  // bootstrap-owner teeth are removed by allowBootstrapOwner=false), and a D1-atomic
  // fix would cost a new table = D1-drift risk, disproportionate to a LOW impact.
  const jtiKey = `handoffjti:${res.claim.jti}`
  if (await env.SESSIONS.get(jtiKey)) return c.redirect('/auth/login')
  await env.SESSIONS.put(jtiKey, '1', { expirationTtl: 120 }) // > claim TTL

  // Resolve/create the user BY VERIFIED EMAIL — dedup both directions (a prior
  // own-Google login OR this handoff = one user). preferredId for a handoff-first
  // user is hash(mumega:email); email-match reconciles it to any existing row.
  // allowBootstrapOwner defaults FALSE here — a handoff never mints the first owner.
  const preferredId = await deriveUserId('mumega', res.claim.email)
  const { id: userId, role } = await upsertUserByEmail(env, preferredId, res.claim.email)

  // Mint the pot's OWN session (mirror /callback). We never trust mumega's session —
  // we issue our own opaque server-side session.
  const sessionId = randomId(32)
  const record: SessionRecord = {
    userId,
    email: res.claim.email,
    role,
    createdAt: new Date().toISOString(),
  }
  await env.SESSIONS.put(sessionKey(sessionId), JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  })
  setSessionCookie(c, sessionId)
  return c.redirect('/')
})

// GET /auth/logout → clear server-side session + cookie.
authApp.get('/logout', async (c) => {
  const sessionId = getCookie(c, COOKIE_NAME)
  if (sessionId) {
    await c.env.SESSIONS.delete(sessionKey(sessionId))
  }
  deleteCookie(c, COOKIE_NAME, { path: '/' })
  return c.redirect('/')
})

// GET /auth/me → echo the current AuthContext (debug / dashboard bootstrap).
authApp.get('/me', requireAuthMw(), (c) => {
  return c.json(c.get('auth'))
})

// ── user upsert (AuthZ side) ─────────────────────────────────────────────────

/**
 * Upsert the user row and return their CANONICAL id + org role. First user EVER to
 * log in becomes 'owner' (bootstrap); everyone after defaults to 'member'. An
 * existing user's role is preserved — never demoted/escalated by a login.
 *
 * VERIFIED EMAIL is the cross-path dedup key (#262). `users.email` is UNIQUE, so a
 * given verified email maps to exactly ONE user whether they arrive via this pot's
 * own Google OAuth OR a mumega SSO handoff — one human, one mupot user, BOTH
 * directions. The returned `id` is canonical: callers must use it for the session
 * (it may differ from `preferredId` if an email-matched row already exists).
 *
 * `preferredId` is the id to create if no row exists yet (e.g. hash(google:sub) for
 * a Google login, or hash(mumega:email) for a handoff-first user).
 *
 * `allowBootstrapOwner` DEFAULTS FALSE (fail-safe): only the pot's own Google
 * /callback — the legitimate first-owner path — passes true. Any other auth path
 * (the SSO handoff, or a future one) can NEVER auto-mint the first-ever owner; the
 * worst case for a virgin-pot handoff is a member, and the owner comes from
 * provisioning. (#262 P2-c.)
 */
export async function upsertUserByEmail(
  env: Env,
  preferredId: string,
  email: string | null,
  allowBootstrapOwner = false,
): Promise<{ id: string; role: OrgRole }> {
  const normEmail = email ? email.trim().toLowerCase() : null

  // 1. Email match wins (the dedup key). Reuse the existing user regardless of which
  //    AuthN path created them. Never clobber their id or role.
  if (normEmail) {
    const byEmail = await env.DB.prepare('SELECT id, role FROM users WHERE email = ?1')
      .bind(normEmail)
      .first<{ id: string; role: OrgRole }>()
    if (byEmail) return { id: byEmail.id, role: byEmail.role }
  }

  // 2. No email match → id match (emailless legacy users, idempotent re-runs).
  const byId = await env.DB.prepare('SELECT role FROM users WHERE id = ?1')
    .bind(preferredId)
    .first<{ role: OrgRole }>()
  if (byId) return { id: preferredId, role: byId.role }

  // 3. New user → bootstrap-owner only if the caller allows it (own-Google path).
  const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  const isFirst = (countRow?.n ?? 0) === 0
  const role: OrgRole = isFirst && allowBootstrapOwner ? 'owner' : 'member'

  // INSERT … ON CONFLICT(id) suppresses an id race, but NOT a UNIQUE(email) violation
  // — two concurrent first-logins for the same email both pass step 1, both INSERT,
  // and the second hits `UNIQUE constraint failed: users.email`. Catch it and fall
  // back to the email lookup (the winner's row now exists) so neither caller 500s.
  // (#262 P2 concurrent-first-login.)
  try {
    await env.DB.prepare(
      'INSERT INTO users (id, email, role) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING',
    )
      .bind(preferredId, normEmail, role)
      .run()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/UNIQUE constraint failed: users\.email/i.test(msg)) throw err
    // Lost the email race → the winning row exists; resolve it below.
  }

  // Re-resolve (email-first) to return the canonical row after the insert/race.
  if (normEmail) {
    const row = await env.DB.prepare('SELECT id, role FROM users WHERE email = ?1')
      .bind(normEmail)
      .first<{ id: string; role: OrgRole }>()
    if (row) return { id: row.id, role: row.role }
  }
  const row2 = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?1')
    .bind(preferredId)
    .first<{ id: string; role: OrgRole }>()
  return { id: row2?.id ?? preferredId, role: row2?.role ?? role }
}

// ── cookie ───────────────────────────────────────────────────────────────────

function setSessionCookie(c: Context<AppEnv>, sessionId: string): void {
  // HttpOnly (no JS access) + Secure (HTTPS only) + SameSite=Lax (survives the
  // OAuth redirect back, blocks cross-site POST CSRF) + Path=/ + bounded Max-Age.
  setCookie(c, COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

// ── middleware ───────────────────────────────────────────────────────────────

/**
 * requireAuth — load the session from KV via the cookie and populate
 * c.set('auth', AuthContext) scoped to THIS tenant (env.TENANT_SLUG). 401 if the
 * cookie is absent or the session is missing/expired. The tenant is taken from
 * the environment, NEVER from the client.
 */
function requireAuthMw(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sessionId = getCookie(c, COOKIE_NAME)
    if (!sessionId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const raw = await c.env.SESSIONS.get(sessionKey(sessionId))
    if (!raw) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    let record: SessionRecord
    try {
      record = JSON.parse(raw) as SessionRecord
    } catch {
      // Corrupt session — treat as invalid, clear it.
      await c.env.SESSIONS.delete(sessionKey(sessionId))
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const auth: AuthContext = {
      userId: record.userId,
      email: record.email,
      role: record.role,
      tenant: c.env.TENANT_SLUG, // tenant is environment-derived, not client-supplied
    }
    c.set('auth', auth)
    await next()
  }
}

export const requireAuth: MiddlewareHandler<AppEnv> = requireAuthMw()

/**
 * requireRole(min) — gate a route on a minimum org role (owner>admin>member).
 * Runs requireAuth first (so it can stand alone), then 403s if under-ranked.
 */
export function requireRole(min: OrgRole): MiddlewareHandler<AppEnv> {
  const guard = requireAuthMw()
  return async (c, next) => {
    // Ensure auth is populated. If requireAuth already ran upstream, this is a
    // no-op; otherwise we run the guard, which 401s on its own if unauthed.
    if (!c.get('auth')) {
      let authed = false
      await guard(c, async () => {
        authed = true
      })
      if (!authed) return c.res // guard wrote a 401 — propagate it
    }
    const auth = c.get('auth')
    if (!auth || ROLE_RANK[auth.role] < ROLE_RANK[min]) {
      return c.json({ error: 'forbidden', required: min }, 403)
    }
    await next()
  }
}
