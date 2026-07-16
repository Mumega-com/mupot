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
const BOOTSTRAP_OWNER_TOKEN_MIN_LENGTH = 32
const BOOTSTRAP_FORM_MAX_BYTES = 4096

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

// ── presence (pot check-in marker, #162 B2 Option P) ──────────────────────────
// An email-keyed marker so the Control Tower's SIGNED presence probe can answer
// "is owner X checked in to this pot?" without scanning sessions. Written on every
// session mint, cleared on logout.
const PRESENCE_PREFIX = 'presence:'

/** Full SHA-256 hex of the lowercased email — the presence marker key suffix. */
async function emailHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()))
  let s = ''
  for (const b of new Uint8Array(digest)) s += b.toString(16).padStart(2, '0')
  return s
}

async function presenceKey(email: string): Promise<string> {
  return `${PRESENCE_PREFIX}${await emailHash(email)}`
}

/**
 * Mark the owner present in THIS pot. Single marker per email + TTL backstop: in the
 * rare multi-session case, logging out of one session clears the marker while another
 * is still live (a LOW-impact false "available"). Presence is a hint, not authz — the
 * tradeoff avoids a KV list-scan on every probe.
 */
async function writePresence(env: Env, email: string | null, userId: string): Promise<void> {
  if (!email) return
  await env.SESSIONS.put(
    await presenceKey(email),
    JSON.stringify({ since: Date.now(), userId }),
    { expirationTtl: SESSION_TTL_SECONDS },
  )
}

async function clearPresence(env: Env, email: string | null): Promise<void> {
  if (!email) return
  await env.SESSIONS.delete(await presenceKey(email))
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

function bootstrapOwnerEnabled(env: Env): boolean {
  const token = env.BOOTSTRAP_OWNER_TOKEN
  // OAuth and bootstrap are intentionally mutually exclusive. Once an OAuth
  // door is configured, first-owner identity must come from that provider.
  return typeof token === 'string'
    && token.length >= BOOTSTRAP_OWNER_TOKEN_MIN_LENGTH
    && !env.OAUTH_CLIENT_ID
    && !env.OAUTH_CLIENT_SECRET
}

function constantTimeEqual(actual: string, expected: string): boolean {
  let mismatch = actual.length ^ expected.length
  const length = Math.max(actual.length, expected.length)
  for (let index = 0; index < length; index += 1) {
    mismatch |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0)
  }
  return mismatch === 0
}

type BootstrapForm = { token: string; email: string }

async function readBootstrapForm(c: Context<AppEnv>): Promise<BootstrapForm | null> {
  const declaredLength = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > BOOTSTRAP_FORM_MAX_BYTES) return null
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null

  const raw = await c.req.arrayBuffer()
  if (raw.byteLength === 0 || raw.byteLength > BOOTSTRAP_FORM_MAX_BYTES) return null

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)
  } catch {
    return null
  }

  const fields = new URLSearchParams(text)
  const tokens = fields.getAll('token')
  const emails = fields.getAll('email')
  if (tokens.length !== 1 || emails.length !== 1) return null
  return { token: tokens[0], email: emails[0].trim().toLowerCase() }
}

function isBootstrapEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

async function mintSession(
  c: Context<AppEnv>,
  userId: string,
  email: string | null,
  role: OrgRole,
  opts: { secure?: boolean } = {},
): Promise<void> {
  const sessionId = randomId(32)
  const record: SessionRecord = {
    userId,
    email,
    role,
    createdAt: new Date().toISOString(),
  }
  await c.env.SESSIONS.put(sessionKey(sessionId), JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  })
  await writePresence(c.env, email, userId)
  setSessionCookie(c, sessionId, opts)
}

type BootstrapOwnerResult = { id: string; role: 'owner'; state: 'claimed' | 'resumed' }

async function loadClaimedBootstrapOwner(env: Env, email: string): Promise<BootstrapOwnerResult | null> {
  const claim = await env.DB.prepare('SELECT user_id FROM owner_bootstrap_claim WHERE singleton = 1')
    .first<{ user_id: string }>()
  if (!claim) return null

  const user = await env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?1')
    .bind(claim.user_id)
    .first<{ id: string; email: string | null; role: OrgRole }>()
  if (!user || user.role !== 'owner' || user.email !== email) return null
  return { id: user.id, role: 'owner', state: 'resumed' }
}

async function claimBootstrapOwner(env: Env, email: string): Promise<BootstrapOwnerResult | null> {
  const claimed = await loadClaimedBootstrapOwner(env, email)
  if (claimed) return claimed

  const existingClaim = await env.DB.prepare('SELECT 1 AS present FROM owner_bootstrap_claim WHERE singleton = 1')
    .first<{ present: number }>()
  if (existingClaim) return null

  const existingOwner = await env.DB.prepare("SELECT 1 AS present FROM users WHERE role = 'owner' LIMIT 1")
    .first<{ present: number }>()
  if (existingOwner) return null

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?1')
    .bind(email)
    .first<{ id: string }>()
  const userId = existing?.id ?? await deriveUserId('bootstrap', email)

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, email, role) VALUES (?1, ?2, 'owner') ON CONFLICT(email) DO UPDATE SET role = 'owner'",
      ).bind(userId, email),
      env.DB.prepare(
        'INSERT INTO owner_bootstrap_claim (singleton, user_id, claimed_at) VALUES (1, ?1, datetime(\'now\'))',
      ).bind(userId),
    ])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/UNIQUE constraint failed|constraint failed/i.test(message)) return loadClaimedBootstrapOwner(env, email)
    throw err
  }

  return { id: userId, role: 'owner', state: 'claimed' }
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

// GET/POST /auth/bootstrap — one-time self-hosted owner setup.
// This is deliberately unavailable as soon as dashboard OAuth is configured. The
// operator supplies a high-entropy Worker secret in a same-origin form; D1's
// singleton claim makes owner selection one-time while allowing that same owner
// to resume their session until the operator deletes the secret.
authApp.get('/bootstrap', async (c) => {
  if (!bootstrapOwnerEnabled(c.env)) return c.json({ error: 'not_found' }, 404)
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bootstrap Mupot owner</title></head><body><main><h1>Bootstrap owner</h1><form method="post" action="/auth/bootstrap"><label>Email <input name="email" type="email" autocomplete="email" required></label><label>Bootstrap token <input name="token" type="password" autocomplete="off" required></label><button type="submit">Create owner session</button></form></main></body></html>`)
})

authApp.post('/bootstrap', async (c) => {
  if (!bootstrapOwnerEnabled(c.env)) return c.json({ error: 'not_found' }, 404)
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')

  const form = await readBootstrapForm(c)
  if (!form || !isBootstrapEmail(form.email)) return c.json({ error: 'bad_request' }, 400)
  if (!constantTimeEqual(form.token, c.env.BOOTSTRAP_OWNER_TOKEN as string)) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const owner = await claimBootstrapOwner(c.env, form.email)
  if (!owner) return c.json({ error: 'bootstrap_already_claimed' }, 409)

  await mintSession(c, owner.id, form.email, owner.role)
  return c.redirect('/')
})

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

// GET /auth/dev-login → local-only session mint for browser smoke tests.
// Enabled only with LOCAL_TEST_AUTH=1, so production deploys keep OAuth/handoff as
// the only login doors. The cookie is deliberately non-Secure because wrangler dev
// serves http://localhost; production sessions still use Secure below.
authApp.get('/dev-login', async (c) => {
  const env = c.env
  if (env.LOCAL_TEST_AUTH !== '1') {
    return c.json({ error: 'not_found' }, 404)
  }
  // Second, independent gate: even a misconfigured LOCAL_TEST_AUTH=1 in a real
  // deployment must not mint an owner session for a REMOTE caller — only requests
  // that actually reached this Worker via localhost/127.0.0.1 (wrangler dev) may
  // use this door. One env var alone should not be able to mint prod owner access.
  const hostname = new URL(c.req.url).hostname
  // .test is a reserved TLD (RFC 2606) — never real-world routable, so allowing it
  // here doesn't reopen the real attack surface; it's what the unit-test harness
  // uses for synthetic in-process requests (e.g. https://pot.test/...).
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.endsWith('.test')) {
    return c.json({ error: 'not_found' }, 404)
  }

  const email = (env.LOCAL_TEST_AUTH_EMAIL ?? 'local-owner@mupot.test').trim().toLowerCase()
  const preferredId = await deriveUserId('local-test', email)
  const { id: userId, role } = await upsertUserByEmail(env, preferredId, email, true)

  await mintSession(c, userId, email, role, { secure: false })
  return c.redirect('/')
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
  await mintSession(c, userId, email, role)
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
  // aud: mumega mints the claim with aud = THIS pot's dashboard_url hostname
  // (#yp-aud-gap), so we verify against our own MUPOT_HANDOFF_AUD. Passing undefined
  // (var unset) falls through to the HANDOFF_AUD default — correct for mumega#0 only.
  // iss: same shape via MUPOT_HANDOFF_ISS — unset falls through to HANDOFF_ISS.
  const res = await verifyHandoffClaim(
    env.MUPOT_HANDOFF_PUBLIC_KEY,
    token,
    undefined,
    env.MUPOT_HANDOFF_AUD,
    env.MUPOT_HANDOFF_ISS,
  )
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
  await mintSession(c, userId, res.claim.email, role)
  return c.redirect('/')
})

// GET /auth/logout → clear server-side session + cookie (= check out of this pot).
authApp.get('/logout', async (c) => {
  const sessionId = getCookie(c, COOKIE_NAME)
  if (sessionId) {
    // Read the record first so we can clear the email-keyed presence marker too.
    const raw = await c.env.SESSIONS.get(sessionKey(sessionId))
    await c.env.SESSIONS.delete(sessionKey(sessionId))
    if (raw) {
      try {
        await clearPresence(c.env, (JSON.parse(raw) as SessionRecord).email)
      } catch {
        /* malformed record — presence marker lapses at TTL */
      }
    }
  }
  deleteCookie(c, COOKIE_NAME, { path: '/' })
  return c.redirect('/')
})

// GET /auth/presence?token= → signed, read-only presence probe (#162 B2, Option P).
// The Control Tower (mumega) mints a SHORT-LIVED claim with aud='presence:<slug>',
// DISTINCT from the login-handoff aud — so a leaked presence claim can NEVER be
// replayed at /auth/handoff to mint a session, nor probe a different pot. We verify
// with mumega's PUBLIC key only and answer ONLY for the email the signature binds
// (no enumeration). Read-only: no session mutation, no jti consumption (replaying a
// read is harmless).
authApp.get('/presence', async (c) => {
  // Keep the token-bearing URL out of Referer (follow-on nav/resource loads) and
  // out of shared/browser caches — same protection /auth/handoff applies, since a
  // leaked presence claim is a replayable read-oracle until exp.
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')
  const token = c.req.query('token')
  if (!token) return c.json({ ok: false }, 401)
  const expectedAud = `presence:${c.env.TENANT_SLUG}`
  const res = await verifyHandoffClaim(
    c.env.MUPOT_HANDOFF_PUBLIC_KEY,
    token,
    undefined,
    expectedAud,
    c.env.MUPOT_HANDOFF_ISS,
  )
  if (!res.ok || !res.claim) return c.json({ ok: false }, 401)
  const raw = await c.env.SESSIONS.get(await presenceKey(res.claim.email))
  let since: number | null = null
  if (raw) {
    try {
      since = (JSON.parse(raw) as { since?: number }).since ?? null
    } catch {
      since = null
    }
  }
  return c.json({ ok: true, checked_in: raw !== null, since })
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

function setSessionCookie(
  c: Context<AppEnv>,
  sessionId: string,
  opts: { secure?: boolean } = {},
): void {
  // HttpOnly (no JS access) + Secure (HTTPS only) + SameSite=Lax (survives the
  // OAuth redirect back, blocks cross-site POST CSRF) + Path=/ + bounded Max-Age.
  setCookie(c, COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: opts.secure ?? true,
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
