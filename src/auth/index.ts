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
//   - authApp         : Hono sub-app mounted at ROUTES.auth ('/auth')
//   - requireAuth     : Hono middleware → sets c.get('auth') = AuthContext | 401
//   - peekSessionAuth : same cookie/KV read as requireAuth, null instead of 401
//   - requireRole     : factory → middleware enforcing a minimum org role | 403

import { exactCallLine } from './owner-sudo-args'
import { Hono } from 'hono'
import { credentialBase, pinnedBase, parseTenantPrefix, prefixUrlValue } from '../platform/tenant-path'
import { csrf } from 'hono/csrf'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Context, MiddlewareHandler } from 'hono'
import type { CapabilityGrant, CapabilityScopeType, Env, AuthContext } from '../types'
import { verifyHandoffClaim } from './handoff-verify'
import { isOrgAdmin, resolveCapabilities } from './capability'
import {
  linkLoginIdentity,
  listLoginIdentities,
  resolveLoginIdentity,
  revokeLoginIdentity,
} from './login-identity'
import { resolveHumanMemberId } from '../members/resolve-human-member'
import { decideIdentitylessAttach } from '../members/exclusive-control'
import { previewTelegramLoginLink, redeemTelegramLoginLink, telegramLoginTokenHash } from './telegram-login-link'
import { linkSignIn, planLinkSignIn, unlinkSignIn } from './link-signin'
import { checkWebSession } from '../secure-moments/enrol-mint'
import {
  createWebSession,
  evaluateWebSession,
  hashWebSessionId,
  hasRecentReauth,
  listWebSessions,
  loadLiveReauthIdentity,
  loadWebSession,
  loadWebSessionByHash,
  markRecentReauth,
  RECENT_REAUTH_WINDOW_MS,
  revokeAllWebSessions,
  revokeWebSession,
  revokeWebSessionByHash,
  touchWebSession,
} from './web-sessions'
import {
  canDecideElevation,
  canDecideElevationRequest,
  deciderMemberIdOf,
  decideElevationRequest,
  listActiveElevationGrants,
  listElevationUsage,
  elevationUsageOutcomeLabel,
  listPendingElevationRequests,
  loadElevationGrantById,
  revokeElevationGrant,
} from './elevation'
import { ELEVATION_ACTIONS } from './elevation-actions'
import { withAuthTiming } from '../lib/server-timing'
import {
  PENDING_INVITE_COOKIE,
  decidePendingInviteLink,
  inviteLoginMismatchBody,
  linkAcceptedInviteIdentity,
  parsePendingInviteIdFromState,
} from './pending-invite-link'
import {
  emailConfirmBody,
  emailConfirmMissingBody,
  emailIdentityConflictBody,
  emailSentBody,
  emailVerifyFailureBody,
  isEmailLoginEnabled,
  normalizeLoginEmail,
  startEmailLogin,
  verifyEmailLoginByCode,
  verifyEmailLoginByToken,
  type VerifyEmailLoginResult,
} from './email-login'

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
  /**
   * True only when mintSession's registerWebSession call actually created a
   * D1 web_sessions row for this login (Delivery Sequence step 1). Gates
   * whether loadAuthFromCookie performs the D1 cross-check at all: a session
   * minted before this field existed, or one whose login never resolved to a
   * members row, carries no flag, so requireAuth/peekSessionAuth never issue
   * the extra D1 query for it and today's KV-only behaviour is UNCHANGED.
   * Server-set only, at mint time, from mintSession's own write — never
   * settable by a caller, and absence is always treated as false (fail
   * closed toward "no D1 registry entry", never toward "trust it anyway").
   */
  webSessionRegistered?: boolean
  /**
   * The verified (provider, subject) THIS login itself presented, persisted
   * unconditionally at mint time — regardless of whether registerWebSession's
   * D1 attach succeeded. mupot#1551 round 2 (P1-a): without this, a login
   * whose attach was correctly DENIED (a competing bearer/Telegram/identity
   * on the matching-email row) left `webSessionRegistered` unset, and
   * loadAuthFromCookie's own fallback used to re-resolve by EMAIL ALONE on
   * every subsequent request — silently granting the denied row's authority
   * through a second door the login-time denial never touched. Storing the
   * join key here lets that fallback retry the SAME guarded
   * registerWebSession attach (idempotent, safe to repeat) instead of
   * falling back to a lenient email match. Absent on sessions minted before
   * this field existed — those degrade to a read-only eligibility check
   * (decideIdentitylessAttach), never the old unconditional email lookup.
   */
  loginIdentity?: { provider: string; subject: string }
  /**
   * mupot#1579: set ONLY when this login was started from a Telegram login link opened in this very browser (the
   * state carried the link nonce AND the browser held the matching nonce cookie). The Telegram confirm page accepts
   * no session without it, so a session minted before the link was opened, or by any other login, never confirms.
   */
  tgLinkNonce?: string
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

// Browser binding for the OAuth state (login-CSRF). The state alone lives only in server-side KV, so an attacker could
// finish consent in THEIR browser and hand the callback URL to a victim: the victim's browser would then hold the
// attacker's session. Each state therefore also rides in a per-state HttpOnly cookie scoped to the callback path
// (one cookie per state, so two tabs never overwrite each other, same shape as the MCP flow's #1441 nonce cookies);
// the callback demands it and clears it (single use).
const STATE_COOKIE_PREFIX = 'mupot_login_state_'
const STATE_VALUE_RE = /^[0-9a-f]{48}$/

function stateCookieName(state: string): string | null {
  return STATE_VALUE_RE.test(state) ? `${STATE_COOKIE_PREFIX}${state}` : null
}

/**
 * Browser-visible callback path, derived from the SAME URL used as the OAuth redirect_uri (the operator-pinned
 * PUBLIC_ORIGIN, which carries `/t/<slug>` for a path-routed pot). A cookie scoped to a different path is never sent
 * to the callback, which would lock every login out, so the two must come from one source.
 */
function callbackPath(env: Env, req: Request): string {
  return new URL(callbackUrl(env, req)).pathname
}

/** Browser-visible `/auth` base path (for cookies that must reach every /auth route under the tenant prefix). */
function authBasePath(env: Env, req: Request): string {
  return callbackPath(env, req).replace(/\/callback$/, '')
}

/**
 * The state cookie is scoped to the host that served /auth/login, but redirect_uri is the pinned PUBLIC_ORIGIN host.
 * A login started on any other host (workers.dev, an alias) would come back to a host that never received the cookie.
 * So /auth/login and /auth/reauth first move the browser to the pinned host, same path and query. The target host is
 * operator config only, never request input.
 */
function pinnedHostRedirect(c: Context<AppEnv>): Response | null {
  const pinned = c.env.PUBLIC_ORIGIN?.trim()
  const base = pinned ? pinnedBase(pinned) : null
  if (!base) return null
  const want = new URL(base)
  const got = new URL(c.req.url)
  if (want.host === got.host) return null
  const prefix = parseTenantPrefix(want.pathname)
  const path = prefix ? prefixUrlValue(got.pathname, prefix) : got.pathname
  return c.redirect(`${want.origin}${path}${got.search}`)
}

function cookieSecure(reqUrl: string): boolean {
  return new URL(reqUrl).protocol === 'https:'
}

/** Same-origin relative path only: never a scheme, host, protocol-relative or backslash form. */
function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return null
  if (!/^\/[A-Za-z0-9/_.~%?=&-]*$/.test(raw)) return null
  if (raw.startsWith('//') || raw.includes('..')) return null
  return raw
}

// mupot#1579: Telegram login link round trip.
const TG_LINK_COOKIE = 'mupot_tg_link'
const TG_LINK_KV_PREFIX = 'tglink:'
const TG_LINK_NONCE_RE = /^[0-9a-f]{48}$/
const TG_LINK_CONFIRM_PATH = '/auth/telegram-link/confirm'

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

/**
 * Resolve which IdP the human web-login door uses; default google.
 *
 * Reads IDP_PROVIDER, never OAUTH_PROVIDER. The OAuthProvider wrapper reserves the
 * latter and injects its own helpers object there, so reading it returned an object
 * that failed `!== 'google'`, fell into the unsupported_provider branch, and then threw
 * `Converting circular structure to JSON` while serialising the helpers into the error
 * body — a 500 on every /auth/login, for as long as the wrapper has been mounted.
 *
 * Returns the configured value verbatim (defaulting to google) rather than narrowing it
 * to a known provider. Both callers gate on `!== 'google'`, so mapping an unrecognised
 * value onto 'google' would turn a config typo into a silently-enabled Google login —
 * a fail-open introduced while fixing a crash. An unknown value must still reach the
 * unsupported_provider branch. The `String()` is what keeps that branch safe to render.
 */
function provider(env: Env): string {
  const configured = env.IDP_PROVIDER
  return typeof configured === 'string' && configured !== '' ? configured : 'google'
}

/** Absolute redirect URI back to /auth/callback for this request's origin. */
function callbackUrl(env: Env, req: Request): string {
  return `${credentialBase(env, req)}/auth/callback`
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

/**
 * registerWebSession — Delivery Sequence step 1: give this login a listable,
 * revocable, expiring D1 record IF it resolves to a real members row.
 *
 * This is deliberately NOT a requirement for login to succeed. A login whose
 * email matches no `members` row (e.g. a legacy dashboard owner/admin who has
 * never been provisioned as a network member) still gets its existing
 * KV+cookie session exactly as before — it just has no D1 registry entry, so
 * it cannot be listed/remotely-revoked yet. That gap is intentional and
 * documented (design doc "Human login identity": linking is an explicit act,
 * not something a login silently invents by matching two email strings) —
 * closing it for every principal is the "Authorization convergence" step
 * later in the Delivery Sequence, not this one.
 *
 * Best-effort by design: a failure here must never fail the login itself —
 * the caller writes the KV+cookie session (today's actual source of truth
 * for role/access) regardless of what this function returns.
 *
 * Returns `{ registered: true, memberId }` only on an actual new D1 row —
 * the caller stamps `registered` (and ONLY that) onto the KV record's
 * webSessionRegistered flag, which is what gates whether loadAuthFromCookie
 * ever issues the follow-up D1 read on later requests for this session.
 * `memberId` is returned alongside so a caller retrying this SAME guarded
 * attach later (loadAuthFromCookie's own fallback, mupot#1551 round 2 P1-a)
 * can use it directly without a second D1 round trip to re-derive it.
 */
async function registerWebSession(
  env: Env,
  sessionId: string,
  email: string | null,
  loginIdentity: { provider: string; subject: string } | undefined,
  freshCredential: boolean = false,
): Promise<{ registered: boolean; memberId?: string }> {
  if (!loginIdentity || !email || !env.DB) return { registered: false }
  try {
    const tenant = env.TENANT_SLUG
    // Join key first: (tenant, provider, provider_subject) is the authority
    // binding, not display email. An explicit prior link (the one-time owner
    // ceremony, or any previous successful bind) MUST win over "whichever
    // members.email happens to equal this login email" — that email match is
    // the #1162 dual-member defect (hadi@digid.ca is a member row that holds
    // admin on nothing; mem-hadi is the owner). Email is only the bootstrap
    // when no live identity exists yet.
    const existingIdentity = await resolveLoginIdentity(
      env,
      tenant,
      loginIdentity.provider,
      loginIdentity.subject,
    )
    let memberId: string
    let loginIdentityId: string
    if (existingIdentity) {
      memberId = existingIdentity.member_id
      loginIdentityId = existingIdentity.id
      // verified_email is evidence, not the join key — refresh it on a
      // step-1 hit so an IdP email change does not leave the primary
      // address resolving to null (write-once P0-2).
      const nextEmail = email.trim().toLowerCase()
      const prev = existingIdentity.verified_email?.trim().toLowerCase() ?? ''
      if (nextEmail && nextEmail !== prev) {
        await env.DB.prepare(
          `UPDATE human_login_identities SET verified_email = ?1
            WHERE id = ?2 AND tenant = ?3 AND revoked_at IS NULL`,
        ).bind(email, existingIdentity.id, tenant).run()
      }
    } else {
      const resolved = await resolveHumanMemberId(env, {
        tenant,
        provider: loginIdentity.provider,
        providerSubject: loginIdentity.subject,
        email,
      })
      if (!resolved) return { registered: false }

      // mupot#1551 (Athena's ruling, Option B, point 4): `resolved` above can
      // only have come from a fresh identity-less-row bootstrap attach here
      // (this function always supplies both provider and subject, so
      // resolveHumanMemberId's step 2 is always skipped and step 3 always
      // runs the strict decideIdentitylessAttach branch) or the vanishingly
      // rare step-1 race. Either way this INSERT must re-verify exclusive
      // control atomically — a competing bearer/Telegram bind/identity
      // landing between that read and this write must make the link fail,
      // not land.
      const linked = await linkLoginIdentity(env, {
        tenant,
        provider: loginIdentity.provider,
        providerSubject: loginIdentity.subject,
        verifiedEmail: email,
        memberId: resolved,
        requireExclusiveControl: true,
      })
      if (!linked.ok) return { registered: false }
      memberId = resolved
      loginIdentityId = linked.identity.id
    }

    const created = await createWebSession(env, sessionId, {
      tenant,
      memberId,
      loginIdentityId,
    })
    // A sign-in whose provider just proved a fresh credential counts as a recent reauth (no second login for Confirm).
    // Only the Google callback sets freshCredential, and only from a verified-fresh auth_time.
    if (freshCredential) await markRecentReauth(env, created.id_hash)
    return { registered: true, memberId }
  } catch (err) {
    // Best-effort: the D1 registry write failed, but the KV+cookie session
    // is unaffected. Surface for operability; never rethrow. Includes the
    // not-yet-migrated case (migrations 0139/0140 are shipped on this branch
    // but deliberately NOT applied — see this task's boundary) — a pot
    // running without those tables simply mints ordinary KV-only sessions
    // until the migration lands, exactly like before this change.
    console.error('registerWebSession failed (login still succeeded via KV session)', err)
    return { registered: false }
  }
}

async function mintSession(
  c: Context<AppEnv>,
  userId: string,
  email: string | null,
  role: OrgRole,
  opts: { secure?: boolean; loginIdentity?: { provider: string; subject: string }; tgLinkNonce?: string; freshCredential?: boolean } = {},
): Promise<void> {
  const sessionId = randomId(32)
  const registration = await registerWebSession(c.env, sessionId, email, opts.loginIdentity, opts.freshCredential === true)
  const record: SessionRecord = {
    userId,
    email,
    role,
    createdAt: new Date().toISOString(),
    ...(registration.registered ? { webSessionRegistered: true } : {}),
    // Persisted regardless of registration success — see the field's own
    // doc comment (mupot#1551 round 2, P1-a).
    ...(opts.loginIdentity ? { loginIdentity: opts.loginIdentity } : {}),
    ...(opts.tgLinkNonce ? { tgLinkNonce: opts.tgLinkNonce } : {}),
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
  id_token?: string
}

/**
 * auth_time (seconds) from the id_token Google returned on the code exchange, or null when absent/unreadable. The token came
 * straight from Google's token endpoint over TLS in exchange for OUR code, so its payload needs no signature check here; it is
 * only used to REFUSE a link whose Google sign-in was not just performed (shared-browser case).
 */
function googleAuthTime(idToken: string | undefined): number | null {
  if (!idToken) return null
  const part = idToken.split('.')[1]
  if (!part) return null
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const claim = JSON.parse(json) as { auth_time?: unknown }
    return typeof claim.auth_time === 'number' && Number.isFinite(claim.auth_time) ? claim.auth_time : null
  } catch {
    return null
  }
}

/** Largest tolerated clock skew (seconds) for an auth_time that lies in the future; beyond it the claim is invalid. */
export const GOOGLE_AUTH_TIME_FUTURE_SKEW_SECONDS = 60

/**
 * When true, an id_token WITHOUT an auth_time is refused too. It is false because Google only includes auth_time when the
 * request asks for it (the claims parameter) AND the console's session-age claims setting is on, and even then only when the
 * information is available; flip this once the google_auth_time_absent log line shows the claim is reliably present.
 */
export const GOOGLE_AUTH_TIME_REQUIRED = false

/** The claims request that asks Google to include auth_time in the id_token (sent on every authorize request that checks it). */
export const GOOGLE_AUTH_TIME_CLAIMS = JSON.stringify({ id_token: { auth_time: { essential: true } } })

export type GoogleAuthTimeVerdict = 'fresh' | 'stale' | 'absent'

/**
 * The ONE parser/gate for Google's auth_time, shared by the reauth and link callbacks, measured on the server clock.
 * 'absent' = no readable auth_time. A PRESENT auth_time is 'fresh' only if it is no older than GOOGLE_AUTH_MAX_AGE_SECONDS
 * and not further in the future than the skew allowance; anything else present is 'stale'.
 */
export function googleAuthTimeVerdict(authTimeSec: number | null, nowMs: number = Date.now()): GoogleAuthTimeVerdict {
  if (authTimeSec === null || !Number.isFinite(authTimeSec)) return 'absent'
  const ageSec = nowMs / 1000 - authTimeSec
  if (ageSec < -GOOGLE_AUTH_TIME_FUTURE_SKEW_SECONDS) return 'stale'
  return ageSec <= GOOGLE_AUTH_MAX_AGE_SECONDS ? 'fresh' : 'stale'
}

/** Apply the verdict for one flow: true = proceed. 'absent' proceeds (logged once, no PII) unless GOOGLE_AUTH_TIME_REQUIRED. */
export function googleAuthTimeAllows(authTimeSec: number | null, flow: 'reauth' | 'link', nowMs: number = Date.now(), required: boolean = GOOGLE_AUTH_TIME_REQUIRED): boolean {
  const verdict = googleAuthTimeVerdict(authTimeSec, nowMs)
  if (verdict === 'absent') {
    console.warn(JSON.stringify({ evt: 'google_auth_time_absent', flow }))
    return !required
  }
  return verdict === 'fresh'
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

  await mintSession(c, owner.id, form.email, owner.role, {
    loginIdentity: { provider: 'bootstrap', subject: form.email },
  })
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
  const wrongHost = pinnedHostRedirect(c)
  if (wrongHost) return wrongHost

  // CSRF state — random, single-use, stored server-side (KV) with short TTL.
  // A2: if the invite-landing page planted mupot_pending_invite, bind that
  // pointer into THIS state. Callback links at most one invite per state;
  // a foreign/replayed state with a leftover cookie links nothing.
  const state = randomId(24)
  const pendingInviteId = getCookie(c, PENDING_INVITE_COOKIE)
  const returnPath = safeReturnPath(c.req.query('return'))
  // mupot#1579: a login that carries the Telegram link nonce. The nonce must be the one THIS browser holds in its
  // cookie AND still be live server-side; anything else is an ordinary login that carries nothing.
  let tgLinkNonce: string | null = null
  if (c.req.query('tg') === '1') {
    const cookieNonce = getCookie(c, TG_LINK_COOKIE)
    if (cookieNonce && TG_LINK_NONCE_RE.test(cookieNonce) && (await env.SESSIONS.get(`${TG_LINK_KV_PREFIX}${cookieNonce}`))) {
      tgLinkNonce = cookieNonce
    }
  }
  const statePayload = pendingInviteId || returnPath || tgLinkNonce
    ? JSON.stringify({
        ...(pendingInviteId ? { pending_invite: pendingInviteId } : {}),
        ...(returnPath ? { return: returnPath } : {}),
        ...(tgLinkNonce ? { tg_link: tgLinkNonce } : {}),
      })
    : '1'
  await env.SESSIONS.put(stateKey(state), statePayload, { expirationTtl: STATE_TTL_SECONDS })
  const stateCookie = stateCookieName(state)
  if (stateCookie) {
    setCookie(c, stateCookie, '1', {
      httpOnly: true, secure: cookieSecure(c.req.url), sameSite: 'Lax', path: callbackPath(c.env, c.req.raw), maxAge: STATE_TTL_SECONDS,
    })
  }

  const params = new URLSearchParams({
    client_id: env.OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl(c.env, c.req.raw),
    response_type: 'code',
    scope: 'openid email',
    state,
    access_type: 'online',
    prompt: 'select_account',
    // Ask for auth_time so a sign-in that was just performed can count as a recent reauth (verified at the callback).
    claims: GOOGLE_AUTH_TIME_CLAIMS,
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

  await mintSession(c, userId, email, role, {
    secure: false,
    loginIdentity: { provider: 'local-test', subject: email },
  })
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

  // Browser binding first: this browser must hold the cookie /auth/login (or /auth/reauth) set for THIS state, and it
  // is consumed here. A callback URL forwarded to another browser has no such cookie and is refused (login-CSRF).
  const bindingCookie = stateCookieName(state)
  if (!bindingCookie || getCookie(c, bindingCookie) !== '1') {
    return c.json({ error: 'invalid_state' }, 400)
  }
  deleteCookie(c, bindingCookie, { path: callbackPath(c.env, c.req.raw) })

  // Validate + consume the CSRF state (single-use).
  const seen = await env.SESSIONS.get(stateKey(state))
  if (!seen) {
    return c.json({ error: 'invalid_state' }, 400)
  }
  await env.SESSIONS.delete(stateKey(state))

  // GET /auth/reauth (below) encodes a reauth marker into the SAME state
  // value this route already validates above — no new CSRF mechanism, just a
  // richer payload for the one that exists. A plain login's state is the
  // literal string '1' (unchanged), so this parse only ever activates for a
  // request that actually went through /auth/reauth.
  let reauthTarget: { webSessionIdHash: string } | null = null
  if (seen !== '1') {
    try {
      const parsed = JSON.parse(seen) as { reauth?: boolean; webSessionIdHash?: string }
      if (parsed.reauth === true && typeof parsed.webSessionIdHash === 'string') {
        reauthTarget = { webSessionIdHash: parsed.webSessionIdHash }
      }
    } catch {
      // Not a reauth marker — an ordinary (if unrecognised) state value.
      // Falls through to the normal mint path below, same as today.
    }
  }

  // mupot#1022: POST /auth/link-signin/start encodes a link-intent into this same state value, bound to the session
  // that started it. Like the reauth marker it can only come from a state WE wrote (the state is server-side KV behind
  // a per-state browser cookie), and a link-intent state NEVER falls through to the login mint below.
  let linkTarget: { webSessionIdHash: string; memberId: string; reauthProofAt: unknown } | null = null
  if (seen !== '1') {
    try {
      const parsed = JSON.parse(seen) as { link_signin?: boolean; webSessionIdHash?: string; memberId?: string; reauthProofAt?: unknown }
      if (parsed.link_signin === true && typeof parsed.webSessionIdHash === 'string' && typeof parsed.memberId === 'string') {
        linkTarget = { webSessionIdHash: parsed.webSessionIdHash, memberId: parsed.memberId, reauthProofAt: parsed.reauthProofAt }
      }
    } catch {
      // Not a link-intent marker.
    }
  }

  let returnPath: string | null = null
  let tgLinkNonce: string | null = null
  if (seen !== '1') {
    try {
      const parsed = JSON.parse(seen) as { return?: unknown; tg_link?: unknown }
      returnPath = safeReturnPath(parsed.return)
      const claimed = typeof parsed.tg_link === 'string' ? parsed.tg_link : null
      // The nonce only counts when this browser still holds the same cookie and the link record is still live.
      if (claimed && TG_LINK_NONCE_RE.test(claimed) && getCookie(c, TG_LINK_COOKIE) === claimed
        && (await env.SESSIONS.get(`${TG_LINK_KV_PREFIX}${claimed}`))) {
        tgLinkNonce = claimed
      }
    } catch {
      // Not our payload shape: ordinary login.
    }
  }

  // Exchange the authorization code for an access token.
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.OAUTH_CLIENT_ID,
      client_secret: env.OAUTH_CLIENT_SECRET,
      redirect_uri: callbackUrl(c.env, c.req.raw),
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

  if (linkTarget) return finishLinkSignIn(c, linkTarget, info.sub, info.email ?? null, googleAuthTime(token.id_token))

  // Reauth branch (GET /auth/reauth's round trip): this callback is proving
  // freshness for an EXISTING session, not minting a new one. The returned
  // provider identity must be the EXACT identity that session is already
  // bound to — a reauth can only refresh recency for the human already
  // signed in, never silently move recency onto a different human who
  // happens to complete the OAuth dance on the same browser. A missing,
  // revoked, or mismatched target is refused outright — never falls back to
  // an ordinary login for a request that explicitly asked to step up.
  if (reauthTarget) {
    const identity = await loadLiveReauthIdentity(env, env.TENANT_SLUG, reauthTarget.webSessionIdHash)

    if (!identity || identity.provider !== 'google' || identity.provider_subject !== info.sub) {
      return c.json({ error: 'reauth_identity_mismatch' }, 403)
    }
    // A reauth must prove a fresh credential, not a consent click: Google must report an auth_time within the allowed age.
    // Refusal stamps nothing and sends the member back with a clear message (never a 500).
    if (!googleAuthTimeAllows(googleAuthTime(token.id_token), 'reauth')) {
      return c.redirect(`/account?signin=reauth_stale${returnPath ? `&return=${encodeURIComponent(returnPath)}` : ''}`)
    }
    await markRecentReauth(env, reauthTarget.webSessionIdHash)
    return c.redirect(returnPath ?? '/')
  }

  const derivedId = await deriveUserId('google', info.sub)
  const email = info.email ?? null

  // mupot#1436 A2 — LINK-ONLY. When login bound a pending-invite pointer
  // into this state, callback re-verifies D1 (accepted_at + email match)
  // and calls linkLoginIdentity for THAT member. It never falls through
  // to resolveHumanMemberId / findOrCreateHumanMember on this path.
  const inviteDecision = await decidePendingInviteLink({
    env,
    statePendingId: parsePendingInviteIdFromState(seen),
    cookiePendingId: getCookie(c, PENDING_INVITE_COOKIE),
    idpEmail: email,
    orgName: env.BRAND || env.TENANT_SLUG,
  })
  if (inviteDecision.action === 'refuse') {
    deleteCookie(c, PENDING_INVITE_COOKIE, { path: '/' })
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    return c.html(
      inviteLoginMismatchBody(env.BRAND || env.TENANT_SLUG, {
        orgName: inviteDecision.orgName,
        squadName: inviteDecision.squadName,
      }),
      403,
    )
  }
  if (inviteDecision.action === 'link' && email) {
    const linked = await linkAcceptedInviteIdentity(env, {
      tenant: env.TENANT_SLUG,
      provider: 'google',
      providerSubject: info.sub,
      verifiedEmail: email,
      memberId: inviteDecision.memberId,
    })
    deleteCookie(c, PENDING_INVITE_COOKIE, { path: '/' })
    if (!linked.ok) {
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      return c.html(
        inviteLoginMismatchBody(env.BRAND || env.TENANT_SLUG, {
          orgName: env.BRAND || env.TENANT_SLUG,
          squadName: null,
        }),
        403,
      )
    }
  }

  // Dedup on verified email (#262): a prior mumega SSO handoff may have already
  // created this user — reuse that row so one human = one mupot user. `userId` is
  // canonical (may differ from derivedId if email-matched). allowBootstrapOwner=true:
  // the pot's own Google login is the legitimate first-owner path.
  const { id: userId, role } = await upsertUserByEmail(env, derivedId, email, true)

  // Mint the session: random opaque id → server-side record in KV.
  // Fresh only on a PRESENT auth_time inside the reauth window (same verdict fn as reauth). Absent/stale/forged -> not fresh.
  // The claim is read from the id_token returned by Google's token endpoint for OUR code, never from the request.
  const freshCredential = googleAuthTimeVerdict(googleAuthTime(token.id_token)) === 'fresh'
  await mintSession(c, userId, email, role, {
    loginIdentity: { provider: 'google', subject: info.sub },
    ...(tgLinkNonce ? { tgLinkNonce } : {}),
    ...(freshCredential ? { freshCredential: true } : {}),
  })
  return c.redirect(returnPath ?? '/')
})

// GET /auth/reauth → step-up: prove a FRESH round-trip through the identity
// provider for the CURRENT session, without minting a new one. This is the
// primitive the elevation approval flow (Delivery Sequence step 3) will read
// before admitting a sensitive-action approval ("recent reauthentication
// within the step-up window" — design doc, Approval Flow step 5). Requires an
// already-authenticated, D1-registered session: there is nothing to step up
// for a session that was never bridged to a members row.
authApp.get('/reauth', requireAuthMw(), async (c) => {
  const env = c.env
  if (provider(env) !== 'google') {
    return c.json({ error: 'unsupported_provider', provider: provider(env) }, 400)
  }
  if (!env.OAUTH_CLIENT_ID) {
    return c.json({ error: 'oauth_not_configured' }, 500)
  }
  const auth = c.get('auth')
  if (!auth.webSessionIdHash) {
    return c.json({ error: 'session_not_registered' }, 409)
  }
  const wrongHost = pinnedHostRedirect(c)
  if (wrongHost) return wrongHost

  const state = randomId(24)
  await env.SESSIONS.put(
    stateKey(state),
    JSON.stringify({
      reauth: true,
      webSessionIdHash: auth.webSessionIdHash,
      ...(safeReturnPath(c.req.query('return')) ? { return: safeReturnPath(c.req.query('return')) } : {}),
    }),
    { expirationTtl: STATE_TTL_SECONDS },
  )
  const reauthCookie = stateCookieName(state)
  if (reauthCookie) {
    setCookie(c, reauthCookie, '1', {
      httpOnly: true, secure: cookieSecure(c.req.url), sameSite: 'Lax', path: callbackPath(c.env, c.req.raw), maxAge: STATE_TTL_SECONDS,
    })
  }

  const params = new URLSearchParams({
    client_id: env.OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl(c.env, c.req.raw),
    response_type: 'code',
    scope: 'openid email',
    state,
    access_type: 'online',
    // Force a fresh credential prompt — "recent reauth" must reflect a genuine just-now sign-in, not a silently
    // reused provider session or a consent click. max_age=0 + prompt=login make Google re-authenticate; the callback
    // then refuses unless the returned auth_time is fresh.
    prompt: 'login select_account',
    max_age: '0',
    claims: GOOGLE_AUTH_TIME_CLAIMS,
  })
  return c.redirect(`${GOOGLE_AUTH}?${params.toString()}`)
})

// mupot#1579 — Telegram-first member web login by PROOF OF CONTROL (src/auth/telegram-login-link.ts).
//
// Round trip, every hop bound to the browser that opened the link:
//   1. GET  /auth/telegram-link?t=      validates the link, sets the nonce cookie, stores {tokenHash, openedAt} in KV
//                                       under the nonce, and sends the browser through a FRESH /auth/login that carries
//                                       the nonce (the login's own state is bound to this browser by the state cookie).
//   2. GET  /auth/callback              mints a session stamped with the nonce (tgLinkNonce) and returns here:
//   3. GET  /auth/telegram-link/confirm shows the EXACT provider account and the server-known Telegram member.
//   4. POST /auth/telegram-link/confirm consumes the link. Needs the nonce cookie, a session stamped with the SAME
//                                       nonce and minted after the link was opened (an older session is never enough),
//                                       and the session's verified email must equal the member's email (module claim).
// Path note: URLs in responses (Location, href, form action) are re-rooted under /t/<slug> by the Worker entry's
// applyTenantPrefix choke point (#1975), so they stay literal '/auth/...'. COOKIE paths are not rewritten by it, so
// every cookie Path here comes from callbackPath()/authBasePath(), i.e. from the pinned redirect_uri.
authApp.use('/telegram-link/confirm', csrf())

function telegramLinkPage(brand: string, inner: string): string {
  const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connect your sign-in · ${esc(brand)}</title></head><body><main>${inner}</main></body></html>`
}

function htmlEscape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface TgLinkContext {
  tokenHash: string
  provider: string
  email: string | null
  nonce: string
}

/** Everything the confirm step needs, or null: nonce cookie + live KV record + a session stamped with that nonce and minted after the link opened. */
async function loadTgLinkContext(c: Context<AppEnv>): Promise<TgLinkContext | null> {
  const nonce = getCookie(c, TG_LINK_COOKIE)
  if (!nonce || !TG_LINK_NONCE_RE.test(nonce)) return null
  const rawLink = await c.env.SESSIONS.get(`${TG_LINK_KV_PREFIX}${nonce}`)
  const sessionId = getCookie(c, COOKIE_NAME)
  if (!rawLink || !sessionId) return null
  const rawSession = await c.env.SESSIONS.get(sessionKey(sessionId))
  if (!rawSession) return null
  try {
    const link = JSON.parse(rawLink) as { tokenHash?: unknown; openedAt?: unknown }
    const record = JSON.parse(rawSession) as Partial<SessionRecord>
    if (typeof link.tokenHash !== 'string' || typeof link.openedAt !== 'string') return null
    if (record.tgLinkNonce !== nonce || !record.loginIdentity) return null
    const minted = Date.parse(record.createdAt ?? '')
    const opened = Date.parse(link.openedAt)
    if (!Number.isFinite(minted) || !Number.isFinite(opened) || minted < opened) return null
    return { tokenHash: link.tokenHash, provider: record.loginIdentity.provider, email: record.email ?? null, nonce }
  } catch {
    return null
  }
}

authApp.get('/telegram-link', async (c) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const env = c.env
  const brand = env.BRAND || env.TENANT_SLUG
  const tokenHash = await telegramLoginTokenHash(c.req.query('t') ?? '')
  if (!tokenHash || !(await previewTelegramLoginLink(env, tokenHash))) {
    return c.html(telegramLinkPage(brand, '<h1>This link is not valid</h1><p>It may have expired or already been used. Send /login to the bot again for a new one.</p>'), 404)
  }
  if (provider(env) !== 'google' || !env.OAUTH_CLIENT_ID) {
    return c.html(telegramLinkPage(brand, '<h1>Google sign-in is not available</h1><p>Connecting a Telegram account needs Google sign-in on this workspace. Ask an admin.</p>'), 503)
  }
  const wrongHost = pinnedHostRedirect(c)
  if (wrongHost) return wrongHost
  const nonce = randomId(24)
  await env.SESSIONS.put(
    `${TG_LINK_KV_PREFIX}${nonce}`,
    JSON.stringify({ tokenHash, openedAt: new Date().toISOString() }),
    { expirationTtl: STATE_TTL_SECONDS },
  )
  setCookie(c, TG_LINK_COOKIE, nonce, {
    httpOnly: true, secure: cookieSecure(c.req.url), sameSite: 'Lax', path: authBasePath(c.env, c.req.raw), maxAge: STATE_TTL_SECONDS,
  })
  // A FRESH sign-in, never an existing session: the nonce rides through the login's browser-bound state.
  return c.redirect(`/auth/login?tg=1&return=${TG_LINK_CONFIRM_PATH}`)
})

authApp.get('/telegram-link/confirm', async (c) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const brand = c.env.BRAND || c.env.TENANT_SLUG
  const ctx = await loadTgLinkContext(c)
  if (!ctx) {
    return c.html(telegramLinkPage(brand, '<h1>Start again from Telegram</h1><p>Send /login to the bot and open the new link in this browser.</p>'), 403)
  }
  const preview = await previewTelegramLoginLink(c.env, ctx.tokenHash)
  if (!preview) {
    return c.html(telegramLinkPage(brand, '<h1>This link is not valid</h1><p>It may have expired or already been used. Send /login to the bot again for a new one.</p>'), 404)
  }
  const e = htmlEscape
  const member = preview.maskedEmail
    ? `${e(preview.maskedEmail)} (Telegram account ending ${e(preview.chatSuffix)})`
    : `Telegram account ending ${e(preview.chatSuffix)}`
  return c.html(telegramLinkPage(brand, `<h1>Connect this sign-in to your Telegram account</h1>
<p>You are signed in as: <strong>${e(ctx.provider)} account ${ctx.email ? e(ctx.email) : '(no email)'}</strong></p>
<p>This will give that account access to: <strong>${member}</strong></p>
<p><strong>Only continue if you just sent /login to the bot yourself and that account is yours.</strong> If someone sent you this link, do not continue.</p>
<form method="post" action="${TG_LINK_CONFIRM_PATH}"><button type="submit">Connect</button></form>
<p><a href="/auth/logout">Not you? Sign out</a></p>`))
})

authApp.post('/telegram-link/confirm', async (c) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const brand = c.env.BRAND || c.env.TENANT_SLUG
  const refuse = (): Response =>
    c.html(telegramLinkPage(brand, '<h1>This link could not be used</h1><p>It may have expired, been used, or this sign-in cannot be connected. Send /login to the bot for a new link.</p>'), 403)
  const ctx = await loadTgLinkContext(c)
  if (!ctx) return refuse()
  const sessionId = getCookie(c, COOKIE_NAME)
  const raw = sessionId ? await c.env.SESSIONS.get(sessionKey(sessionId)) : null
  const record = raw ? (JSON.parse(raw) as Partial<SessionRecord>) : null
  if (!record?.loginIdentity) return refuse()
  const result = await redeemTelegramLoginLink(c.env, {
    tokenHash: ctx.tokenHash,
    provider: record.loginIdentity.provider,
    subject: record.loginIdentity.subject,
    verifiedEmail: ctx.email,
  })
  if (!result.ok) {
    if (result.error === 'service_error') {
      return c.html(telegramLinkPage(brand, '<h1>Temporarily unavailable</h1><p>Please try again in a moment.</p>'), 503)
    }
    return refuse()
  }
  await c.env.SESSIONS.delete(`${TG_LINK_KV_PREFIX}${ctx.nonce}`)
  deleteCookie(c, TG_LINK_COOKIE, { path: authBasePath(c.env, c.req.raw) })
  return c.redirect('/')
})


// mupot#1022 — Linked sign-ins (src/auth/link-signin.ts). A SIGNED-IN member links another Google account to THIS member.
//   POST /auth/link-signin/start        needs a live web session re-authenticated within the step-up window (RECENT_REAUTH_WINDOW_MS) (else it sends the
//                                       member through /auth/reauth and back to /account). Writes a state bound to THAT
//                                       session, behind the per-state browser cookie, and goes to Google.
//   GET  /auth/callback                 (link-intent branch, finishLinkSignIn) the callback must arrive in the SAME session,
//                                       still fresh. A free subject is linked; a subject that is a separate member's shows
//                                       the confirm page; anything else is refused.
//   POST /auth/link-signin/confirm      the duplicate move, needs its own nonce cookie + KV record + the same session.
//   POST /auth/link-signin/:id/unlink   own identity, never the last live one.
// The identity linked is the one the OAuth callback VERIFIED (subject + verified email). It is never an email match, never an
// unauthenticated login, and never an identity named in a request.
authApp.use('/link-signin/*', csrf())

// Max age of Google's auth_time at the callback. Sized for slow networks (the sign-in round trip must fit); the request itself
// still sends max_age=0, so Google is always asked for a fresh sign-in and this only bounds the callback's arrival.
export const GOOGLE_AUTH_MAX_AGE_SECONDS = 15 * 60
// The link flow is several hops (start -> Google sign-in -> callback -> optional confirm page). Fresh re-auth is PROVEN
// once, at /link-signin/start, and the proof (the session's recent_reauth_at) is carried in the server-side state. The
// later hops do not demand a second step-up-window session re-auth measured at THEIR clock: a slow Google sign-in or a slow
// page made that impossible to finish (re-auth -> link -> slow -> "confirm it is you again" -> re-auth ...). The proof is
// still bounded: capped at the step-up window itself (NOT window + state lifetime: with the old 5 min window that sum was 15 min (5 + 10)), so a link can never complete on a proof a dashboard step-up action would already refuse.
export const LINK_PROOF_MAX_AGE_MS = RECENT_REAUTH_WINDOW_MS // = min(window + state lifetime, window)

/** The start-time proof carried to a later hop: unchanged-or-newer on the live session, and not older than the flow allows. */
export function linkProofHolds(proofAtMs: unknown, session: { recent_reauth_at: string | null }, nowMs: number = Date.now()): boolean {
  if (typeof proofAtMs !== 'number' || !Number.isFinite(proofAtMs)) return false
  const current = session.recent_reauth_at ? Date.parse(session.recent_reauth_at) : Number.NaN
  if (!Number.isFinite(current) || current < proofAtMs) return false
  return nowMs - proofAtMs <= LINK_PROOF_MAX_AGE_MS
}
const LINK_MOVE_COOKIE = 'mupot_link_move'
const LINK_MOVE_KV_PREFIX = 'linkmove:'
const LINK_MOVE_CONFIRM_PATH = '/auth/link-signin/confirm'

function linkSigninRedirect(c: Context<AppEnv>, code: string): Response {
  return c.redirect(`/account?signin=${code}`)
}

authApp.post('/link-signin/start', async (c) => {
  c.header('Cache-Control', 'no-store')
  const env = c.env
  if (provider(env) !== 'google' || !env.OAUTH_CLIENT_ID) return c.json({ error: 'oauth_not_configured' }, 503)
  const auth = await peekSessionAuth(c)
  if (!auth) return c.json({ error: 'unauthenticated' }, 401)
  const session = await checkWebSession(env, auth, { fresh: true })
  if (!session.ok) {
    // Stale: re-authenticate this session, then come back to the account page to start again.
    if (session.error === 'reauth_required') return c.redirect('/auth/reauth?return=/account')
    return c.json({ error: session.error }, session.status)
  }
  if (pinnedHostRedirect(c)) return c.json({ error: 'wrong_host' }, 409)
  const state = randomId(24)
  await env.SESSIONS.put(
    stateKey(state),
    JSON.stringify({
      link_signin: true, webSessionIdHash: session.session.id_hash, memberId: session.memberId, return: '/account',
      // fresh:true above guarantees recent_reauth_at is set and within the window.
      reauthProofAt: Date.parse(session.session.recent_reauth_at ?? ''),
    }),
    { expirationTtl: STATE_TTL_SECONDS },
  )
  const stateCookie = stateCookieName(state)
  if (stateCookie) {
    setCookie(c, stateCookie, '1', {
      httpOnly: true, secure: cookieSecure(c.req.url), sameSite: 'Lax', path: callbackPath(env, c.req.raw), maxAge: STATE_TTL_SECONDS,
    })
  }
  const params = new URLSearchParams({
    client_id: env.OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl(env, c.req.raw),
    response_type: 'code',
    scope: 'openid email',
    state,
    access_type: 'online',
    // Link flow ONLY: demand a fresh Google credential so a still-logged-in account on a shared browser cannot be picked.
    prompt: 'login select_account',
    max_age: '0',
    claims: GOOGLE_AUTH_TIME_CLAIMS,
  })
  return c.redirect(`${GOOGLE_AUTH}?${params.toString()}`)
})

function linkMovePage(brand: string, inner: string): string {
  return telegramLinkPage(brand, inner).replace('Connect your sign-in', 'Link your sign-in')
}

/** The link-intent branch of /auth/callback. Always returns a response; never mints a session. */
async function finishLinkSignIn(
  c: Context<AppEnv>,
  target: { webSessionIdHash: string; memberId: string; reauthProofAt: unknown },
  subject: string,
  email: string | null,
  googleAuthTimeSec: number | null,
): Promise<Response> {
  c.header('Cache-Control', 'no-store')
  const env = c.env
  const auth = await peekSessionAuth(c)
  // The callback must arrive in the session that started the link: a state started by another session, or by nobody still
  // signed in, links nothing.
  if (!auth || auth.webSessionIdHash !== target.webSessionIdHash || auth.memberId !== target.memberId) {
    return c.json({ error: 'link_session_mismatch' }, 403)
  }
  // Live human web session (not revoked, member active) now; freshness is the proof carried from /link-signin/start.
  const session = await checkWebSession(env, auth, { fresh: false })
  if (!session.ok) return linkSigninRedirect(c, 'reauth_required')
  if (!linkProofHolds(target.reauthProofAt, session.session)) return linkSigninRedirect(c, 'reauth_required')
  // The link flow forces a fresh Google sign-in (prompt=login, max_age=0). When Google says when the user last authenticated,
  // a stale auth_time means a still-logged-in Google account was picked, not proven: refuse.
  if (!googleAuthTimeAllows(googleAuthTimeSec, 'link')) {
    return linkSigninRedirect(c, 'stale_google_signin')
  }
  const input = { provider: 'google', subject, verifiedEmail: email }
  const plan = await planLinkSignIn(env, auth, input)
  if (plan.kind === 'move') {
    const nonce = randomId(24)
    await env.SESSIONS.put(
      `${LINK_MOVE_KV_PREFIX}${nonce}`,
      JSON.stringify({
        webSessionIdHash: target.webSessionIdHash,
        memberId: target.memberId,
        subject,
        email,
        identityId: plan.duplicate.identityId,
        oldMemberId: plan.duplicate.memberId,
        reauthProofAt: target.reauthProofAt,
      }),
      { expirationTtl: STATE_TTL_SECONDS },
    )
    setCookie(c, LINK_MOVE_COOKIE, nonce, {
      httpOnly: true, secure: cookieSecure(c.req.url), sameSite: 'Lax', path: authBasePath(env, c.req.raw), maxAge: STATE_TTL_SECONDS,
    })
    const e = htmlEscape
    const created = e(plan.duplicate.createdAt.slice(0, 10))
    return c.html(linkMovePage(env.BRAND || env.TENANT_SLUG, `<h1>This Google account already has its own member</h1>
<p>Google account being moved: <strong>${e(plan.duplicate.identityMaskedEmail ?? 'no email')}</strong>. Its current member: <strong>${e(plan.duplicate.maskedEmail ?? 'no email')}</strong>.</p>
<p>This Google account already has its own member (created ${created}, ${plan.duplicate.permissions} permissions). Linking moves sign-in to this account; the old member is left as-is for an admin to archive. Your old account's connector sessions will be signed out; reconnect them and they will open this account.</p>
<form method="post" action="${LINK_MOVE_CONFIRM_PATH}"><button type="submit">Move this sign-in to my account</button></form>
<p><a href="/account">Cancel</a></p>`))
  }
  const result = await linkSignIn(env, auth, input)
  if (!result.ok) return linkSigninRedirect(c, result.error)
  return linkSigninRedirect(c, result.outcome)
}

authApp.post('/link-signin/confirm', async (c) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const env = c.env
  const nonce = getCookie(c, LINK_MOVE_COOKIE)
  const auth = await peekSessionAuth(c)
  if (!nonce || !TG_LINK_NONCE_RE.test(nonce) || !auth) return linkSigninRedirect(c, 'expired')
  const raw = await env.SESSIONS.get(`${LINK_MOVE_KV_PREFIX}${nonce}`)
  if (!raw) return linkSigninRedirect(c, 'expired')
  // Single use: consumed before it is honoured.
  await env.SESSIONS.delete(`${LINK_MOVE_KV_PREFIX}${nonce}`)
  deleteCookie(c, LINK_MOVE_COOKIE, { path: authBasePath(env, c.req.raw) })
  let pending: { webSessionIdHash?: unknown; memberId?: unknown; subject?: unknown; email?: unknown; identityId?: unknown; oldMemberId?: unknown; reauthProofAt?: unknown }
  try {
    pending = JSON.parse(raw) as typeof pending // as: shape-checked field by field below
  } catch {
    return linkSigninRedirect(c, 'expired')
  }
  if (
    typeof pending.webSessionIdHash !== 'string' || typeof pending.memberId !== 'string' || typeof pending.subject !== 'string'
    || typeof pending.identityId !== 'string' || typeof pending.oldMemberId !== 'string'
    || (pending.email !== null && typeof pending.email !== 'string')
  ) return linkSigninRedirect(c, 'expired')
  if (auth.webSessionIdHash !== pending.webSessionIdHash || auth.memberId !== pending.memberId) {
    return c.json({ error: 'link_session_mismatch' }, 403)
  }
  const session = await checkWebSession(env, auth, { fresh: false })
  if (!session.ok) return linkSigninRedirect(c, 'reauth_required')
  if (!linkProofHolds(pending.reauthProofAt, session.session)) return linkSigninRedirect(c, 'reauth_required')
  const result = await linkSignIn(
    env, auth,
    { provider: 'google', subject: pending.subject, verifiedEmail: pending.email },
    { confirmMove: true, expectedDuplicate: { identityId: pending.identityId, memberId: pending.oldMemberId } },
  )
  return linkSigninRedirect(c, result.ok ? result.outcome : result.error)
})

authApp.post('/link-signin/:id/unlink', async (c) => {
  c.header('Cache-Control', 'no-store')
  const auth = await peekSessionAuth(c)
  if (!auth) return c.json({ error: 'unauthenticated' }, 401)
  // Unlinking only reduces access, so a real web session is enough (the revoke-device bar), no fresh re-auth.
  const session = await checkWebSession(c.env, auth, { fresh: false })
  if (!session.ok) return c.json({ error: session.error }, session.status)
  const result = await unlinkSignIn(c.env, auth, c.req.param('id'))
  return linkSigninRedirect(c, result.ok ? 'unlinked' : result.error)
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
  await mintSession(c, userId, res.claim.email, role, {
    loginIdentity: { provider: 'mumega', subject: res.claim.email },
  })
  return c.redirect('/')
})

// ── email one-time link/code sign-in (mupot#1564/#1442) ──────────────────────
// A normal-login door beside Google. Every mutating route here is a
// same-origin, cookie-relevant POST — csrf() is the SAME middleware
// dashboardApp/inviteApp apply to their own cookie-authenticated mounts (an
// Origin check on top of SameSite=Lax, never the single line of defense).
authApp.use('/email/*', csrf())

function acceptsHtml(c: Context<AppEnv>): boolean {
  const accept = c.req.header('accept') ?? ''
  return accept.includes('text/html')
}

/**
 * cf-connecting-ip ONLY (adversarial gate: "don't trust x-forwarded-for over
 * cf-connecting-ip"). Cloudflare's edge sets this header itself on every
 * request that reaches the Worker — the client cannot forge it. X-Forwarded-For
 * is attacker-controllable (a client can send any value it likes) and must
 * never feed a rate-limit boundary; there is no fallback to it here. Absent
 * (local dev / a test harness with no CF edge in front of it) falls back to
 * the literal string 'unknown', which is itself rate-limited as its own
 * shared bucket — never skipped (see email-login.ts's underRateLimit doc).
 */
function resolveClientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

/** Accepts either a same-origin HTML form POST (the real, no-JS UI) or a JSON
 *  body (tests, or a future API caller) — never guesses at an unknown
 *  content-type; an unparseable body just yields empty fields, which every
 *  caller below already treats as "nothing submitted". */
async function readEmailFormBody(c: Context<AppEnv>): Promise<Record<string, string>> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? ''
  try {
    if (contentType.includes('application/json')) {
      const body = (await c.req.json()) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v
      return out
    }
    const body = await c.req.parseBody()
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/**
 * Common tail for both verify routes on a successful token/code check: apply
 * the SAME pending-invite link contract the Google callback honors
 * (mupot#1436 A2 — re-verified against D1 and the state↔cookie binding, never
 * trusted from the KV attempt record alone), then mint the session through
 * the EXACT SAME upsertUserByEmail/mintSession pair /callback uses, with
 * `loginIdentity: { provider: 'email', subject: emailNormalized }`. This is
 * the one seam that ties email login into #1551's exclusive-control
 * predicate and the ordinary member-identity resolver — never a second copy.
 */
async function finishEmailLoginSuccess(
  c: Context<AppEnv>,
  emailNormalized: string,
  pendingInviteId: string | null,
): Promise<Response> {
  const env = c.env
  const tenant = env.TENANT_SLUG
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')

  // mupot#1564 adversarial gate round 2 (kasra-review + Athena BLOCK,
  // 2026-09-26, PR #1574): "email login must never inherit authority from
  // ANY email-keyed row it did not itself verify." Round 1's gate
  // (decideIdentitylessAttach, below) only ever inspects the ONE members row
  // `lower(email)` happens to match — it says nothing about (a) a LIVE,
  // non-email identity bound to a DIFFERENT member whose OWN verified_email
  // happens to equal this address (an org-owner-alias Google login, or the
  // #1162 dual-member shape: a powerless "hadi@digid.ca" member row sits
  // beside the real owner mem-hadi, whose Google identity's verified_email
  // is 'hadi@digid.ca' by drift — mupot#1266 P0-2 write-once email drift is
  // a FEATURE for that member's own resolution, but a HAZARD here, because
  // decideIdentitylessAttach's row lookup finds the OTHER, powerless row and
  // calls it eligible), or (b) a `users` row for this exact email that
  // already carries owner/admin standing from a STRONGER door (Google,
  // bootstrap, handoff) with NO members row to even gate on (mupot#1324: a
  // legacy owner/admin login has no members bridge at all, so
  // decideIdentitylessAttach never even runs for them — `not_found`, which
  // round 1's gate correctly treats as safe-to-proceed, but that is exactly
  // the hole here). BOTH checks run UNCONDITIONALLY, on BOTH the pending-
  // invite and no-invite branches below, BEFORE either branch's own writes
  // (decidePendingInviteLink is read-only, but linkAcceptedInviteIdentity —
  // and the no-invite branch's eventual mintSession — both write): a token/
  // code already being consumed at verify time is an accepted sunk cost, but
  // no session, cookie, `members`, or identity row may ever be written past
  // this point once either check below fires. (mupot#1581 P2-4: check 2's
  // own write — the `users` row upsertUserByEmail may INSERT when this
  // exact email has never logged in before — is the one exception, and is
  // deliberate: it only ever creates the org's baseline `role='member'`
  // row, the same row this email would get from any successful login
  // anyway, so a later refusal in this function still grants nothing.)
  const foreignIdentity = await env.DB.prepare(
    `SELECT 1 AS present FROM human_login_identities
      WHERE tenant = ?1 AND lower(verified_email) = ?2 AND revoked_at IS NULL AND provider != 'email'
      LIMIT 1`,
  )
    .bind(tenant, emailNormalized)
    .first<{ present: number }>()
  if (foreignIdentity) {
    return c.html(emailIdentityConflictBody(env.BRAND || env.TENANT_SLUG), 403)
  }

  // mupot#1581 P2-4: this used to be a hand-copied `SELECT role FROM users
  // WHERE email = ?1` — a SEPARATE, earlier read of the exact row
  // upsertUserByEmail's own step 1 reads again moments later, purely so
  // this file could gate BEFORE either branch's own write. Two reads of the
  // same row, separated in time, is a check-then-write gap in its own
  // right (a write landing between the two — a role change, a concurrent
  // first login — is exactly what "check, then act on a stale check" means)
  // on top of being a hand-copy of the predicate upsertUserByEmail already
  // owns. Call upsertUserByEmail itself, ONCE, right here — before either
  // branch below performs its own write — and gate on `role`, the value
  // that IS the session role, not a snapshot taken a moment earlier and
  // trusted to still be true. When a `users` row already exists for this
  // email, upsertUserByEmail's step 1 is a pure read (no INSERT), so a
  // refusal here still writes nothing; findUserByEmail is that read,
  // extracted so this is genuinely the SAME query, not a second copy.
  // allowBootstrapOwner=FALSE, always, for email (adversarial gate P0-2,
  // "also pass allowBootstrapOwner=false for email — Google keeps it"):
  // unlike Google's own /callback (the legitimate first-owner ceremony),
  // email login must never auto-mint the pot's first-ever owner on a virgin
  // pot — proving mailbox control is weaker evidence than an IdP-verified
  // identity, and "first owner" is exactly the highest-value grant a
  // "prove you can read an inbox" door should not be trusted to hand out.
  const derivedId = await deriveUserId('email', emailNormalized)
  let userId: string
  let role: OrgRole
  try {
    ;({ id: userId, role } = await upsertUserByEmail(env, derivedId, emailNormalized, false))
  } catch (err) {
    // mupot#1583 round 2: two (or more) `users` rows collide on the same normalized
    // email (a data anomaly, not a live attack by itself) — refuse rather than let
    // upsertUserByEmail's ORDER BY silently pick a winner. No session, cookie, or
    // write past this point, same as every other refusal in this function.
    if (err instanceof AmbiguousUserEmailError) {
      return c.html(emailIdentityConflictBody(env.BRAND || env.TENANT_SLUG), 403)
    }
    throw err
  }
  if (role !== 'member') {
    return c.html(emailIdentityConflictBody(env.BRAND || env.TENANT_SLUG), 403)
  }

  if (pendingInviteId !== null) {
    const cookiePendingId = getCookie(c, PENDING_INVITE_COOKIE)
    const inviteDecision = await decidePendingInviteLink({
      env,
      statePendingId: pendingInviteId,
      cookiePendingId,
      idpEmail: emailNormalized,
      orgName: env.BRAND || env.TENANT_SLUG,
    })
    if (inviteDecision.action === 'refuse') {
      deleteCookie(c, PENDING_INVITE_COOKIE, { path: '/' })
      return c.html(
        inviteLoginMismatchBody(env.BRAND || env.TENANT_SLUG, {
          orgName: inviteDecision.orgName,
          squadName: inviteDecision.squadName,
        }),
        403,
      )
    }
    if (inviteDecision.action === 'link') {
      const linked = await linkAcceptedInviteIdentity(env, {
        tenant,
        provider: 'email',
        providerSubject: emailNormalized,
        verifiedEmail: emailNormalized,
        memberId: inviteDecision.memberId,
      })
      deleteCookie(c, PENDING_INVITE_COOKIE, { path: '/' })
      if (!linked.ok) {
        return c.html(
          inviteLoginMismatchBody(env.BRAND || env.TENANT_SLUG, {
            orgName: env.BRAND || env.TENANT_SLUG,
            squadName: null,
          }),
          403,
        )
      }
    }
    // Invite path carries its OWN D1-authoritative link (the invite row +
    // email match, above) — never re-derived through decideIdentitylessAttach,
    // same as the Google callback's own invite branch. Proceed straight to
    // mint below; the gate that follows is for the NO-invite path only.
  } else {
    // mupot#1564 adversarial gate P0-2 (kasra-review + Athena, PR #1574
    // round 1): the ordinary (no-invite) login used to fall straight through
    // to upsertUserByEmail — a SECOND, email-keyed lookup into `users` that
    // grants `users.role` (up to and including 'owner') regardless of
    // whether THIS request's own members-identity attach would even be
    // allowed. Repro: a `members` row with a LIVE Google identity already
    // bound, and a `users` row with the same email carrying role='owner' —
    // email login inherited the owner session with no email identity ever
    // linked to that member. A `users` row and a `members` row sharing an
    // email are NOT the same authority: the members row can already be
    // under someone else's exclusive control (a live identity, an unbound
    // bearer, a Telegram bind — mupot#1551, decideIdentitylessAttach). Gate
    // on the SAME predicate the identity bridge itself applies:
    //   - a live ('email', subject) identity already exists → returning
    //     user, always safe (idempotent re-login, no attach decision needed).
    //   - no live identity yet, but decideIdentitylessAttach says 'eligible'
    //     or 'not_found' → safe to proceed; registerWebSession (inside
    //     mintSession below) performs the real, atomically-guarded attach.
    //   - 'denied_competing_control' or 'ambiguous' → REFUSE THE WHOLE
    //     LOGIN. No session is minted, no `members`/identity row is ever
    //     touched. mupot#1581 P2-4 moved the `users`-role gate (above,
    //     before this whole if/else) to reuse upsertUserByEmail's own
    //     result instead of a second hand-copied read — the one accepted
    //     side effect of that reuse is that upsertUserByEmail may already
    //     have INSERTed a fresh role='member' `users` row for a genuinely
    //     new email by the time a denial fires here (previously it never
    //     ran at all on this branch's refusal). That row grants nothing
    //     beyond the org's baseline role and is exactly the row a brand new
    //     email would get from a successful login anyway — refusing here
    //     still writes no session, cookie, members row, or identity link,
    //     which is the property that actually matters; it is not a fresh
    //     account-existence oracle either, since the response is identical
    //     whether or not that row already existed.
    const existingEmailIdentity = await resolveLoginIdentity(env, tenant, 'email', emailNormalized)
    if (!existingEmailIdentity) {
      const decision = await decideIdentitylessAttach(env, {
        tenant,
        normalizedEmail: emailNormalized,
        provider: 'email',
        subject: emailNormalized,
      })
      if (decision.kind === 'denied_competing_control' || decision.kind === 'ambiguous') {
        return c.html(emailIdentityConflictBody(env.BRAND || env.TENANT_SLUG), 403)
      }
    }
  }

  // userId/role were already resolved by the upsertUserByEmail call above —
  // before either branch's own write — and are not re-derived here.
  await mintSession(c, userId, emailNormalized, role, {
    loginIdentity: { provider: 'email', subject: emailNormalized },
  })
  return c.redirect('/')
}

function emailVerifyFailureStatus(kind: 'invalid' | 'expired' | 'too_many_attempts' | 'rate_limited'): 401 | 410 | 429 {
  if (kind === 'expired') return 410
  if (kind === 'too_many_attempts' || kind === 'rate_limited') return 429
  return 401
}

async function respondEmailVerifyResult(c: Context<AppEnv>, result: VerifyEmailLoginResult): Promise<Response> {
  if (result.kind === 'ok') return finishEmailLoginSuccess(c, result.emailNormalized, result.pendingInviteId)
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  return c.html(emailVerifyFailureBody(c.env.BRAND || c.env.TENANT_SLUG, result.kind), emailVerifyFailureStatus(result.kind))
}

// POST /auth/email/start {email} → always 200, identical body, whether the
// email is registered, unregistered, malformed, or rate-limited (no
// account-existence oracle — see src/auth/email-login.ts's header).
authApp.post('/email/start', async (c) => {
  const env = c.env
  if (!isEmailLoginEnabled(env)) return c.json({ error: 'not_found' }, 404)
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')

  const form = await readEmailFormBody(c)
  const email = form.email ?? ''
  const pendingInviteId = getCookie(c, PENDING_INVITE_COOKIE) ?? null

  await startEmailLogin({
    env,
    tenant: env.TENANT_SLUG,
    email,
    ip: resolveClientIp(c),
    pendingInviteId,
    origin: credentialBase(c.env, c.req.raw),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  })

  if (acceptsHtml(c)) {
    return c.html(emailSentBody(env.BRAND || env.TENANT_SLUG, normalizeLoginEmail(email) || email))
  }
  return c.json({ ok: true, message: 'If this email can receive mail, a sign-in link and code were sent.' })
})

// GET /auth/email/verify?t=&a= → the emailed link.
//
// mupot#1564 adversarial gate P1-2: this used to CONSUME the token on a bare
// GET — a plain navigation, which both a login-CSRF (`<img
// src="…/verify?t=…&a=…">` embedded on a page the victim's browser loads,
// signing the VICTIM into the ATTACKER's session) and a mail-scanner
// prefetch (M365 Safe Links etc., which issues real GETs against links in
// scanned mail) can trigger with zero human intent — burning the real user's
// link before they ever click it. GET now touches NO database state at all;
// it renders a static confirm page (src/auth/email-login.ts's
// emailConfirmBody) whose own POST — csrf()-protected, same as every other
// cookie-relevant mount here — is the only thing that ever consumes.
authApp.get('/email/verify', async (c) => {
  const env = c.env
  if (!isEmailLoginEnabled(env)) return c.json({ error: 'not_found' }, 404)
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const token = c.req.query('t') ?? ''
  const attemptId = c.req.query('a') ?? ''
  if (!token || !attemptId) {
    return c.html(emailConfirmMissingBody(env.BRAND || env.TENANT_SLUG), 400)
  }
  return c.html(emailConfirmBody(env.BRAND || env.TENANT_SLUG, token, attemptId))
})

// POST /auth/email/verify → either the confirm page's {t, a} (the emailed
// link, consumed here for real — see the GET route's own comment) or the
// typed-in {email, code} form (cross-device: the code was sent alongside the
// link, so it can be typed into the SAME browser/tab the flow started in
// even when the link itself was opened on a different device). One route,
// dispatched on which fields are present, so there is exactly one place that
// mints an email-login session from a verified secret.
authApp.post('/email/verify', async (c) => {
  const env = c.env
  if (!isEmailLoginEnabled(env)) return c.json({ error: 'not_found' }, 404)
  const form = await readEmailFormBody(c)
  const ip = resolveClientIp(c)
  const result = (form.t && form.a)
    ? await verifyEmailLoginByToken(env, env.TENANT_SLUG, form.a, form.t, ip)
    : await verifyEmailLoginByCode(env, env.TENANT_SLUG, form.email ?? '', form.code ?? '', ip)
  return respondEmailVerifyResult(c, result)
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
    // Also revoke the D1-registered web session, if this login ever resolved
    // to a members row. Logout must kill listable/revocable authority
    // immediately — deleting only the KV blob would leave a D1 row that
    // still reads as live to loadWebSession until its own expiry. Design
    // invariant #10: "Human logout/revocation immediately ends grants
    // approved by that web session." Best-effort: a session that was never
    // registered (no D1 row) revokes 0 rows, which is the correct outcome,
    // not a fault — the KV delete above is already this login's source of
    // truth in that case.
    if (c.env.DB) {
      try {
        const idHash = await hashWebSessionId(sessionId)
        await revokeWebSessionByHash(c.env, c.env.TENANT_SLUG, idHash, 'logout')
      } catch (err) {
        console.error('web_sessions revoke-on-logout failed (KV session already cleared)', err)
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

// ── web-session inventory (Delivery Sequence step 1) ────────────────────────
// "The web-session page has current-session logout and sign-out-all-devices
// controls" + "The owner has an Active Elevations page... The web-session
// page has current-session logout and sign-out-all-devices controls." (design
// doc, User Experience). Elevations themselves are a LATER step; this is the
// session inventory + revoke primitives they will sit alongside.

// GET /auth/sessions → list every web session for the caller's OWN member.
//
// Deliberately scoped by webSessionMemberId, NOT memberId: memberId (and
// capabilities) are gated to role === 'member' ONLY by the email→member
// bridge above (never set for a legacy owner/admin login, to avoid ever
// DEFINING auth.capabilities for them). registerWebSession has no such
// restriction — an owner/admin login that resolves to a members row by email
// IS registered — so this route (and the two below) must key off
// webSessionMemberId or an owner's own sessions would be unlistable through
// it, contradicting the design's "the owner has an Active Elevations page...
// current-session logout and sign-out-all-devices controls".
//
// Empty (not an error) for a session that was never registered (documented
// step-1 gap, see registerWebSession) — nothing to list yet.
authApp.get('/sessions', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId) return c.json({ sessions: [] })
  const rows = await listWebSessions(c.env, c.env.TENANT_SLUG, auth.webSessionMemberId)
  return c.json({
    sessions: rows.map((row) => ({
      id: row.id_hash,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      idle_expires_at: row.idle_expires_at,
      absolute_expires_at: row.absolute_expires_at,
      revoked_at: row.revoked_at,
      revoke_reason: row.revoke_reason,
      is_current: row.id_hash === auth.webSessionIdHash,
      live: evaluateWebSession(row).ok,
    })),
  })
})

// POST /auth/sessions/:id/revoke → revoke exactly one of the caller's OWN
// sessions. Ownership-scoped in revokeWebSession itself (tenant +
// webSessionMemberId + id_hash, all server-derived except the target
// id_hash) — a caller can never revoke a session that resolves to a
// different member's rows, regardless of what id it names.
authApp.post('/sessions/:id/revoke', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId) return c.json({ error: 'forbidden' }, 403)
  const idHash = c.req.param('id')
  const { revoked } = await revokeWebSession(c.env, c.env.TENANT_SLUG, auth.webSessionMemberId, idHash, 'human_revoke')
  return c.json({ revoked })
})

// POST /auth/sessions/revoke-all → "sign out all devices". Keeps the CURRENT
// session alive by default (the common "sign out other devices" case); pass
// ?include_current=1 for a full sign-out (the caller's own cookie stays set
// client-side, but its D1 row — and therefore its listable/checkable
// liveness — is dead the instant this returns).
authApp.post('/sessions/revoke-all', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId) return c.json({ error: 'forbidden' }, 403)
  const includeCurrent = new URL(c.req.url).searchParams.get('include_current') === '1'
  const exceptIdHash = includeCurrent ? undefined : auth.webSessionIdHash ?? undefined
  const { revokedCount } = await revokeAllWebSessions(
    c.env,
    c.env.TENANT_SLUG,
    auth.webSessionMemberId,
    'human_revoke_all',
    exceptIdHash,
  )
  return c.json({ revoked_count: revokedCount })
})

// GET /auth/identities → every login identity for the caller's OWN member.
// Same ownership scope as /auth/sessions: webSessionMemberId, never
// cross-member. Empty (not an error) when the session never registered.
authApp.get('/identities', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId) return c.json({ identities: [] })
  const rows = await listLoginIdentities(c.env, c.env.TENANT_SLUG, auth.webSessionMemberId)
  return c.json({
    identities: rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      provider_subject: row.provider_subject,
      verified_email: row.verified_email,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      live: row.revoked_at === null,
    })),
  })
})

// ── elevation approval (Delivery Sequence step 3) ────────────────────────────
//
// mupot task f5fe1222, mumega-com#1173: "Fix the ability that I can make
// agents admin by a safe way and time limited. I will not give you token."
// This is the HUMAN half — approval MUST be created by an operator-
// principal BROWSER session (design doc's Approval Flow: "Mupot returns a
// door... Human opens Mupot"), the exact same web_sessions primitive step 1
// built, not a generic MCP bearer call. requireAuthMw() + webSessionMemberId
// is the identical gate GET/POST /sessions* above already use — an owner or
// admin login that never bridged to a members row (no webSessionMemberId)
// gets `forbidden`, same as those routes.
//
// The agent-facing half (request_elevation / elevation_status) lives in
// src/mcp/index.ts, MCP-tool-gated — an agent has no browser.

// BOTH authority planes, deliberately.
//
// resolveCapabilities is pure SQL over `capabilities` and has no notion of
// auth.role, and the auth bridge leaves auth.capabilities UNDEFINED for an
// owner/admin on purpose (assigning [] is what downgrades them). So
// `auth.capabilities ?? await resolveCapabilities(...)` materializes [] for
// exactly the principal with the most authority in the pot — the org owner,
// who characteristically holds zero capability rows. Before this, that made
// the pending-elevation list return 200 with an empty array for the owner: not
// a visible refusal, just a permanent, silent "nothing pending".
// G-FP1b point 2: isOrgAdmin's bypass must not reach a home squad — an org
// owner/admin with zero grant rows must not be able to decide (or even see)
// an elevation request scoped to another member's home. Made ASYNC (env
// added) so this can resolve the scope's `kind` itself via
// hasCapabilityOnDynamicScope, rather than trusting a caller-supplied
// department id that carries no kind information (the round-2 defect class).
async function scopeAuthorityOk(
  env: Env,
  auth: AuthContext | null | undefined,
  capabilities: CapabilityGrant[] | undefined,
  scopeType: CapabilityScopeType,
  scopeId: string,
): Promise<boolean> {
  // #1673: delegates to the ONE predicate decideElevationRequest uses.
  return canDecideElevation(env, auth, capabilities, scopeType, scopeId)
}

// GET /auth/elevation/requests → pending elevation requests the CALLER has
// admin authority to decide (Security Invariant 12: UI visibility follows
// effective authorization — a request on a scope the operator cannot admin
// is not even listed, not shown-then-403'd).
authApp.get('/elevation/requests', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId) return c.json({ requests: [] })
  const capabilities = auth.capabilities ?? (await resolveCapabilities(c.env, auth.webSessionMemberId))
  const all = await listPendingElevationRequests(c.env, c.env.TENANT_SLUG)
  const visible: Array<Record<string, unknown>> = []
  for (const r of all) {
    if (!(await canDecideElevationRequest(c.env, auth, capabilities, r, deciderMemberIdOf(auth)))) continue
    visible.push({
      id: r.id,
      agent_session_id: r.agent_session_id,
      agent_id: r.agent_id,
      actions: JSON.parse(r.requested_actions_json).map((a: string) => ({
        key: a,
        label: ELEVATION_ACTIONS[a]?.label ?? a,
        effect: ELEVATION_ACTIONS[a]?.effect ?? null,
        effect_note: ELEVATION_ACTIONS[a]?.effectNote ?? null,
      })),
      scope_type: r.requested_scope_type,
      scope_id: r.requested_scope_id,
      duration_minutes: r.requested_duration_minutes,
      reason: r.reason,
      created_at: r.created_at,
      decision_expires_at: r.decision_expires_at,
      // Sudo requests carry the exact call (never an ordinary-looking row); non-sudo requests: null.
      exact_call: await exactCallLine(c.env, r, { strict: false }),
    })
  }
  return c.json({ requests: visible })
})

// POST /auth/elevation/requests/:id/decide → the single-decision transaction.
// Body: { decision: 'approve'|'deny', actions?: string[], duration_minutes?: number, note?: string }.
// `actions`/`duration_minutes` may only NARROW the request (decideElevationRequest
// enforces this — the route never widens what it forwards). Sensitive
// actions (SENSITIVE_STEP_UP_ACTIONS) require the caller's web session to
// have proven a fresh reauth within the step-up window (RECENT_REAUTH_WINDOW_MS) — same primitive
// GET /auth/reauth exists for.
authApp.post('/elevation/requests/:id/decide', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId || !auth.webSessionIdHash) return c.json({ error: 'forbidden' }, 403)

  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const decision = body.decision === 'approve' || body.decision === 'deny' ? body.decision : null
  if (!decision) return c.json({ error: 'invalid_args', detail: 'decision must be approve|deny' }, 400)

  const capabilities = auth.capabilities ?? (await resolveCapabilities(c.env, auth.webSessionMemberId))
  const currentWebSession = await loadWebSessionByHash(c.env, c.env.TENANT_SLUG, auth.webSessionIdHash)
  const recentReauthOk = currentWebSession ? hasRecentReauth(currentWebSession) : false

  const result = await decideElevationRequest(c.env, {
    tenant: c.env.TENANT_SLUG,
    requestId: c.req.param('id'),
    decision,
    selectedActions: Array.isArray(body.actions) ? body.actions.filter((a): a is string => typeof a === 'string') : undefined,
    scopeType: typeof body.scope_type === 'string' ? (body.scope_type as CapabilityScopeType) : undefined,
    scopeId: typeof body.scope_id === 'string' ? body.scope_id : undefined,
    durationMinutes: typeof body.duration_minutes === 'number' ? body.duration_minutes : undefined,
    decidedByMemberId: auth.webSessionMemberId,
    decidedByCapabilities: capabilities,
    decidedByIsOrgAdmin: isOrgAdmin(auth),
    decidedByWebSessionHash: auth.webSessionIdHash,
    recentReauthOk,
    note: typeof body.note === 'string' ? body.note : undefined,
  })

  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'forbidden' ? 403 : 409
    return c.json({ ok: false, reason: result.reason, detail: 'detail' in result ? result.detail : undefined }, status)
  }
  return c.json({
    ok: true,
    request: { id: result.request.id, status: result.request.status },
    grants: result.grants.map((g) => ({
      id: g.id,
      action: g.action,
      scope_type: g.scope_type,
      scope_id: g.scope_id,
      effect: g.effect,
      expires_at: g.expires_at,
    })),
  })
})

// POST /auth/identities/:id/revoke → revoke exactly one of the caller's OWN
// identities. Ownership-scoped in revokeLoginIdentity (tenant +
// webSessionMemberId + id). Also kills every live web_session bound to that
// identity — otherwise the attacker keeps a cookie minted under the stolen
// binding, and reauth would still succeed until hli.revoked_at is checked.
authApp.post('/identities/:id/revoke', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId) return c.json({ error: 'forbidden' }, 403)
  const identityId = c.req.param('id')
  // revokeLoginIdentity is the one chokepoint for the cutoff (identity, then its sessions, then its passkeys), and it
  // re-runs the dependent cutoff on every call for a revoked identity, so a retry after a partial failure completes it.
  const { revoked, sessionsRevoked } = await revokeLoginIdentity(
    c.env,
    c.env.TENANT_SLUG,
    auth.webSessionMemberId,
    identityId,
  )
  return c.json({ revoked, sessions_revoked: sessionsRevoked })
})

// GET /auth/elevation/active → every LIVE grant the caller has admin
// authority over (same visibility scoping as the pending-requests list).
authApp.get('/elevation/active', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId) return c.json({ grants: [] })
  const capabilities = auth.capabilities ?? (await resolveCapabilities(c.env, auth.webSessionMemberId))
  const all = await listActiveElevationGrants(c.env, c.env.TENANT_SLUG)
  const visible: Array<Record<string, unknown>> = []
  for (const g of all) {
    if (!(await scopeAuthorityOk(c.env, auth, capabilities, g.scope_type, g.scope_id))) continue
    visible.push({
      id: g.id,
      agent_session_id: g.agent_session_id,
      action: g.action,
      label: ELEVATION_ACTIONS[g.action]?.label ?? g.action,
      scope_type: g.scope_type,
      scope_id: g.scope_id,
      effect: g.effect,
      approved_by_member_id: g.approved_by_member_id,
      created_at: g.created_at,
      expires_at: g.expires_at,
    })
  }
  return c.json({ grants: visible })
})

// POST /auth/elevation/:id/revoke → explicit human revoke, scoped to the
// caller's own admin authority over the grant's scope (never a bare
// "any admin anywhere can revoke any grant" — matches list_agent_sessions/
// revoke_agent_session's squad-scoped pattern in src/mcp/provision.ts).
authApp.post('/elevation/:id/revoke', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId) return c.json({ error: 'forbidden' }, 403)
  const grant = await loadElevationGrantById(c.env, c.env.TENANT_SLUG, c.req.param('id'))
  if (!grant) return c.json({ error: 'not_found' }, 404)
  const capabilities = auth.capabilities ?? (await resolveCapabilities(c.env, auth.webSessionMemberId))
  if (!(await scopeAuthorityOk(c.env, auth, capabilities, grant.scope_type, grant.scope_id))) {
    return c.json({ error: 'forbidden', need: 'admin', scope: { type: grant.scope_type, id: grant.scope_id } }, 403)
  }
  const { revoked } = await revokeElevationGrant(c.env, c.env.TENANT_SLUG, grant.id, 'human_revoke')
  return c.json({ revoked })
})

// GET /auth/elevation/:id/usage → itemised usage log for one grant —
// queryable after expiry/revocation (constraint 7: "an elevation that
// expires without a list of what it was used for is unauditable exactly
// when it matters"). Same scope-authority gate as revoke.
authApp.get('/elevation/:id/usage', requireAuthMw(), async (c) => {
  const auth = c.get('auth')
  if (!auth.webSessionMemberId) return c.json({ usage: [] })
  const grant = await loadElevationGrantById(c.env, c.env.TENANT_SLUG, c.req.param('id'))
  if (!grant) return c.json({ error: 'not_found' }, 404)
  const capabilities = auth.capabilities ?? (await resolveCapabilities(c.env, auth.webSessionMemberId))
  if (!(await scopeAuthorityOk(c.env, auth, capabilities, grant.scope_type, grant.scope_id))) {
    return c.json({ error: 'forbidden', need: 'admin', scope: { type: grant.scope_type, id: grant.scope_id } }, 403)
  }
  const usage = await listElevationUsage(c.env, c.env.TENANT_SLUG, grant.id)
  return c.json({
    usage: usage.map((u) => ({
      id: u.id,
      action: u.action,
      tool_name: u.tool_name,
      detail: u.detail_json ? JSON.parse(u.detail_json) : null,
      occurred_at: u.occurred_at,
      status: u.status,
      error_code: u.error_code,
      resolved_at: u.resolved_at,
      outcome: elevationUsageOutcomeLabel(u),
    })),
  })
})

// ── user upsert (AuthZ side) ─────────────────────────────────────────────────

/**
 * mupot#1583 round 2 (Athena BLOCK): thrown by findUserByEmail/upsertUserByEmail when
 * MORE THAN ONE `users` row matches the same normalized (lower-cased) email. This
 * function's own doc comment states the invariant — "VERIFIED EMAIL is the cross-path
 * dedup key... a given verified email maps to exactly ONE user" — and an
 * `ORDER BY ... LIMIT 1` pick that silently honors ONE of several colliding rows (an
 * older 'member' row and a newer case-variant 'owner' row, say) is exactly the
 * "silently pick a winner" move that invariant forbids: whichever row the ORDER BY
 * happens to prefer decides the session's role, invisibly to every caller. Every
 * caller either catches this to refuse the specific login attempt
 * (finishEmailLoginSuccess) or lets it propagate — an uncaught throw becomes a 500,
 * never a session minted for the wrong row.
 */
export class AmbiguousUserEmailError extends Error {
  readonly count: number
  constructor(count: number) {
    super(`ambiguous users.email match (${count} rows for one normalized email)`)
    this.name = 'AmbiguousUserEmailError'
    this.count = count
  }
}

/**
 * findUserByEmail — the one `users` email lookup, normalized once here.
 * upsertUserByEmail's own step 1 and step 4 (re-resolve after an
 * insert/UNIQUE race) both call this instead of inlining the query twice,
 * and any caller that needs to GATE on a user's pre-existing role WITHOUT
 * itself deciding to upsert (mupot#1581 P2-4 — finishEmailLoginSuccess used
 * to keep a hand-copied `SELECT role FROM users WHERE email = ?1` for
 * exactly this, a second predicate that could silently drift from this
 * one) should call this directly rather than re-copying the query. Read-
 * only: never inserts. Reads ALL rows for the normalized email (no LIMIT) and
 * throws AmbiguousUserEmailError on more than one — see that class's doc
 * comment for why an ORDER BY + LIMIT 1 pick is exactly the bug this closes.
 */
export async function findUserByEmail(env: Env, email: string | null): Promise<{ id: string; role: OrgRole } | null> {
  const normEmail = email ? email.trim().toLowerCase() : null
  if (!normEmail) return null
  // lower(email) — NOT a plain `email = ?1` — because `users.email`'s UNIQUE constraint
  // (migration 0001) is case-SENSITIVE, the same gap 0146 already closed for
  // `members.email` (idx_members_email_lower). Without this, a legacy mixed-case row
  // (created before every write path consistently lower-cased its input) is invisible to
  // a lower-cased lookup — mupot#1581 P2-4: finishEmailLoginSuccess's `users`-role gate
  // (and upsertUserByEmail's OWN dedup step 1) would both silently miss such a row and
  // mint a SECOND, distinct 'member' row instead of recognizing the existing
  // owner/admin one.
  const rows = await env.DB.prepare(
    'SELECT id, role FROM users WHERE lower(email) = ?1 ORDER BY created_at ASC, id ASC',
  )
    .bind(normEmail)
    .all<{ id: string; role: OrgRole }>()
  const results = rows.results ?? []
  if (results.length === 0) return null
  if (results.length > 1) throw new AmbiguousUserEmailError(results.length)
  return results[0]
}

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
  const byEmail = await findUserByEmail(env, normEmail)
  if (byEmail) return { id: byEmail.id, role: byEmail.role }

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
  const row = await findUserByEmail(env, normEmail)
  if (row) return { id: row.id, role: row.role }
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
 * Load the dashboard session from the cookie + KV. Returns null when the cookie
 * is absent, the session is missing/expired/corrupt, or SESSIONS is unbound.
 * Does not write a response — callers that must refuse use requireAuth.
 */
async function loadAuthFromCookie(c: Context<AppEnv>): Promise<AuthContext | null> {
  return withAuthTiming(c.env, () => loadAuthFromCookieInner(c))
}

async function loadAuthFromCookieInner(c: Context<AppEnv>): Promise<AuthContext | null> {
  const sessionId = getCookie(c, COOKIE_NAME)
  if (!sessionId) return null
  if (!c.env.SESSIONS) return null
  const raw = await c.env.SESSIONS.get(sessionKey(sessionId))
  if (!raw) return null
  let record: SessionRecord
  try {
    record = JSON.parse(raw) as SessionRecord
  } catch {
    // Corrupt session — treat as invalid, clear it.
    await c.env.SESSIONS.delete(sessionKey(sessionId))
    return null
  }
  const auth: AuthContext = {
    userId: record.userId,
    email: record.email,
    role: record.role,
    tenant: c.env.TENANT_SLUG, // tenant is environment-derived, not client-supplied
  }

  // #1330 F1: this check MUST run unconditionally whenever an email is present —
  // it used to be gated on `!record.webSessionRegistered`, on the assumption a
  // registered session is always covered by the status join inside
  // loadWebSession below. That assumption is false: loadWebSession collapses
  // "web_sessions (or human_login_identities) table missing" to the SAME
  // `reason: 'not_found'` as an ordinary unregistered session, and the
  // webSessionRegistered branch below treats 'not_found' as benign fall-through.
  // A registered session whose backing table degrades therefore hit NEITHER
  // guard — fail-open on a suspended member. Running this members lookup
  // unconditionally, independent of loadWebSession/web_sessions entirely,
  // closes that hole regardless of which table is unreadable, and costs
  // nothing extra for the registered+healthy case (loadWebSession's own
  // member_status join still runs and agrees). A missing member row (owner/
  // admin logins with no members row, #1324) is unaffected — the `typeof
  // member?.status === 'string'` check still only fires on a REAL suspended
  // row, never on absence (see F3 below for the missing-member decision).
  // PERF: the registry read below needs only the cookie value, not the members answer, so it is started here and runs in the
  // SAME wave as the members status read (one D1 round trip instead of two in series). It is consumed exactly where it was
  // awaited before, after the suspended-member refusal, so a refusal still returns before any of its result is used.
  const webSessionP = record.webSessionRegistered && c.env.DB
    ? loadWebSession(c.env, c.env.TENANT_SLUG, sessionId)
    : null
  webSessionP?.catch(() => undefined) // consumed below; a throw there still surfaces, never as an unhandled rejection
  if (record.email && c.env.DB) {
    try {
      // #1330 F-A: match legacy tenant IS NULL rows too (0040 adds the column
      // with no backfill) — `AND tenant = ?2` alone made a suspended legacy
      // member's row invisible to this check, so it fell through to the
      // missing-row "allow" path below (F3) instead of being denied.
      const member = await c.env.DB.prepare(
        `SELECT status FROM members
          WHERE lower(email) = ?1 AND (tenant = ?2 OR tenant IS NULL)
          LIMIT 1`,
      ).bind(record.email.trim().toLowerCase(), c.env.TENANT_SLUG).first<{ status: string }>()
      if (typeof member?.status === 'string' && member.status !== 'active') {
        await c.env.SESSIONS.delete(sessionKey(sessionId))
        return null
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/no such (?:table:\s*members|column:\s*email)\b/i.test(message)) throw err
    }
  }

  // Email→member bridge (the DASHBOARD member-resolution the members schema always
  // specified — "workspace, IM, or the dashboard, all resolving to member_id +
  // capabilities" — but which the web-session path never implemented). A plain
  // Google web login is otherwise an org-role-only principal with no memberId and
  // no fine-grained grants, so squad-scoped surfaces show it nothing. Resolve the
  // member by VERIFIED email (the /callback + /handoff paths both reject an
  // unverified email before minting a session) and attach its grants.
  //
  // INVARIANTS (this is a sensitive RBAC surface):
  //  - role === 'member' ONLY. Owners/admins keep the pure legacy-role path; attaching
  //    a lesser member grant to them would DEFINE auth.capabilities and thereby disable
  //    the `capabilities === undefined` legacy-role escape in requireCapability →
  //    downgrading an owner. Scoping is only ever needed for plain members.
  //  - tenant-scoped — never resolve a member from another tenant (cross-tenant leak).
  //  - status='active' — suspended members get nothing.
  //  - fail-closed — no (or non-unique) match leaves memberId unset: identical to
  //    today's behaviour, never an over-grant. members.email is UNIQUE so LIMIT 1 is
  //    deterministic; the bridge is purely ADDITIVE (only grants scope, never removes).
  if (record.webSessionRegistered && c.env.DB) {
    const webSession = await (webSessionP ?? loadWebSession(c.env, c.env.TENANT_SLUG, sessionId))
    if (webSession.ok) {
      auth.webSessionIdHash = webSession.session.id_hash
      auth.webSessionMemberId = webSession.session.member_id
      // loadWebSession just read last_seen_at on this row; hand it over so the coalescing check costs no second SELECT.
      await touchWebSession(c.env, webSession.session.id_hash, Date.now(), webSession.session.last_seen_at)
    } else if (webSession.reason !== 'not_found') {
      await c.env.SESSIONS.delete(sessionKey(sessionId))
      return null
    }
  }

  // mumega-com#1218: IDENTITY is resolved for every role; AUTHORITY still is not.
  //
  // This used to be gated `auth.role === 'member'` in its entirety, which excluded the
  // org OWNER from identity resolution by the very field that marks them as owner —
  // auth.role is written once at account creation (first account ever -> 'owner',
  // everyone later -> 'member') and no supported interface changes it afterwards. The
  // owner therefore reached loadEnrollView with memberId null, and enroll.ts returns
  // `agents: []` on that branch: the empty seat picker. Owners could not enrol ANY
  // agent seat, which is why harnesses ended up welded to the wrong seats by hand.
  //
  // The invariant recorded above is REAL and is preserved — verified, not assumed, at
  // src/auth/capability.ts:181 (holdsCapabilityFloor): when auth.capabilities is
  // undefined it falls back to legacyRoleSatisfies(auth.role, min). A role-only owner
  // has NO grant rows, so resolveCapabilities returns []; assigning [] flips that
  // branch to [].some(...) === false and DOWNGRADES the owner. isOrgAdmin happens to
  // survive it (capability.ts:85 checks role first) so the regression would be PARTIAL
  // and surface later on a different surface — worse than a clean break.
  //
  // So the two concerns are separated, because only one of them was ever the problem:
  //   memberId     = identity  -> attached for EVERY role (unblocks the picker)
  //   capabilities = authority -> assigned ONLY for role === 'member' (invariant held,
  //                               stays undefined for owner/admin so the legacy escape
  //                               keeps firing)
  //
  // FAIL-SAFE, and this is load-bearing. Widening the bridge to every role means
  // owner/admin sessions now execute this lookup on EVERY authenticated request,
  // where before they skipped it entirely. Without the guard below, any throw in
  // identity resolution — a degraded table, a D1 hiccup, a schema drift — would
  // turn every owner request into a 500 on a path that used to be inert for them.
  // Caught in test: a fixture whose D1 stub implements first()/run() but not all()
  // (the owner-alias rung uses .all()) took three task-route tests from green to
  // 500, and the same shape is reachable in production.
  //
  // Degrading to "no memberId" is EXACTLY the pre-existing behaviour for these
  // roles, so this is strictly no worse than main: the picker stays empty, which
  // is the old bug, rather than the request dying, which would be a new one.
  // Identity resolution is an enhancement; it must never be able to take down auth.
  if (c.env.DB) {
    try {
      let memberId: string | null = auth.webSessionMemberId ?? null
      if (!memberId && record.loginIdentity) {
        // mupot#1551 round 2 (P1-a): this session HAS its own verified join
        // key — retry the SAME guarded attach registerWebSession already
        // tried at login time, never the lenient email-only lookup. Safe to
        // repeat every request until it lands: registerWebSession's own
        // resolveLoginIdentity check short-circuits instantly once linked,
        // and requireExclusiveControl makes a still-denied row a no-op read
        // (a failed conditional INSERT), never a silent grant.
        const retry = await registerWebSession(
          c.env,
          sessionId,
          record.email,
          record.loginIdentity,
        )
        if (retry.registered && retry.memberId) {
          // Newly linked on THIS request. mupot#1551 (Athena BLOCK, both
          // gates): registerWebSession's own memberId is NOT re-verified for
          // liveness on the way out — trusting it directly bypassed
          // loadWebSession's status='active' check (the SAME check the
          // record.webSessionRegistered branch above this one already goes
          // through), so a member archived/suspended between the INSERT
          // above and this line would still be handed authority. Re-derive
          // through loadWebSession instead of trusting retry.memberId raw —
          // reuses that one existing predicate rather than adding a fourth
          // copy of "status='active' AND archived_at IS NULL" in this file.
          await c.env.SESSIONS.put(
            sessionKey(sessionId),
            JSON.stringify({ ...record, webSessionRegistered: true }),
            { expirationTtl: SESSION_TTL_SECONDS },
          )
          const webSession = await loadWebSession(c.env, c.env.TENANT_SLUG, sessionId)
          if (webSession.ok) {
            auth.webSessionIdHash = webSession.session.id_hash
            auth.webSessionMemberId = webSession.session.member_id
            memberId = webSession.session.member_id
          }
          // Still not live (e.g. archived/suspended in the instant between
          // the INSERT and this read): memberId stays null, exactly like the
          // denied-at-write-time branch below.
        }
        // Still denied/unresolved: memberId stays null. NEVER fall through to
        // the old lenient email-only resolveHumanMemberId call below — that
        // is exactly the second door a login-time denial must also close.
      } else if (!memberId && !record.loginIdentity) {
        // Legacy session minted before `loginIdentity` was persisted (or a
        // channel that never had one). No join key to retry an attach with —
        // apply the SAME read-only eligibility check the attach path itself
        // would require, rather than the old unconditional email match. A
        // denied/ambiguous/not_found row grants nothing; this never links
        // (no subject to link with), it only decides whether it's safe to
        // ACT as the row for this one request. `ignoreLiveIdentity: true` —
        // same reasoning as SSO's fallback (src/auth/sso.ts): a row that
        // ALREADY has a live identity from a real prior login is not a fresh
        // claim this read would be creating, it is already legitimately
        // claimed — refusing to even READ it would be a false positive, not
        // a fix. This flag ONLY skips the identity check, though — it does
        // NOT exempt a live unbound bearer or a Telegram bind, both still
        // enforced below. An operator holding their own workspace bearer
        // whose CURRENT session carries no `loginIdentity` is still denied
        // here by the bearer check and must complete a real login (which
        // stores `loginIdentity` and takes the retry-attach branch above,
        // never reaching this fallback at all) — that is what actually
        // resolves the operator/legit-member shape in
        // tests/agent-connection-issued-key.test.ts, not this flag.
        const decision = await decideIdentitylessAttach(c.env, {
          tenant: c.env.TENANT_SLUG,
          normalizedEmail: (auth.email ?? '').trim().toLowerCase(),
          ignoreLiveIdentity: true,
        })
        // decideIdentitylessAttach itself never filters by status (its job
        // is exclusive control, not liveness) — a suspended member must
        // still not be handed authority here, the same activeOnly floor
        // resolveHumanMemberForAttach's own wrapper applies for the real
        // attach path.
        if (decision.kind === 'eligible' && decision.status === 'active') {
          memberId = decision.memberId
        }
      }
      if (memberId) {
        auth.memberId = memberId
        auth.channel = 'dashboard'
        if (auth.role === 'member') {
          auth.capabilities = await resolveCapabilities(c.env, memberId)
        }
      }
    } catch {
      // Identity unresolved. auth.memberId stays undefined and auth.capabilities
      // is untouched, so the legacy-role plane still decides authority — no
      // principal is elevated by this failing, and none is downgraded.
    }
  }

  return auth
}

/**
 * requireAuth — load the session from KV via the cookie and populate
 * c.set('auth', AuthContext) scoped to THIS tenant (env.TENANT_SLUG). 401 if the
 * cookie is absent or the session is missing/expired. The tenant is taken from
 * the environment, NEVER from the client.
 */
function requireAuthMw(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = await loadAuthFromCookie(c)
    if (!auth) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', auth)
    await next()
  }
}

export const requireAuth: MiddlewareHandler<AppEnv> = requireAuthMw()

/**
 * Same cookie/KV resolution as requireAuth, but optional: returns null instead
 * of writing 401. Used by surfaces that admit guests (Studio co-pilot chat)
 * while still elevating a live admin/owner session when one is present.
 * If auth is already on the context (dashboard requireAuth ran), that wins.
 */
export async function peekSessionAuth(c: Context<AppEnv>): Promise<AuthContext | null> {
  try {
    const existing = c.get('auth')
    if (existing) return existing
  } catch {
    // Variable not registered on this context — fall through to the cookie.
  }
  const auth = await loadAuthFromCookie(c)
  if (auth) {
    try {
      c.set('auth', auth)
    } catch {
      // Context may not declare the auth variable (public /api/studio mount).
    }
  }
  return auth
}

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
