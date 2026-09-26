// mupot — email one-time link/code sign-in, beside Google (mupot#1564,
// #1442; alongside #1551's exclusive-control work).
//
// Hadi, 2026-09-26: "we only have Google login — a big stone in front of
// onboarding." This is the normal-login door: an email address, a one-time
// link OR a 6-digit code, no Google account required.
//
// IDENTITY, NOT A SECOND RESOLVER: verifying control of the mailbox here IS
// the IdP proof for mupot#1551's exclusive-control predicate — a human who
// can read a fresh, single-use, hashed-at-rest secret sent to an inbox has
// proven control of it, the same property Google's OAuth proves for a Google
// account. This module NEVER calls findOrCreateHumanMember / resolveHumanMemberId
// itself — verifyEmailLogin's caller (src/auth/index.ts) feeds the verified
// (provider: 'email', subject: <normalized email>) pair through the EXACT
// SAME registerWebSession → resolveHumanMemberId → decideIdentitylessAttach
// path Google's callback uses. One resolver, one attach predicate, one more
// caller — never a forked copy (see src/members/resolve-human-member.ts's own
// header: "One resolver. Five call sites.").
//
// Gated by EMAIL_LOGIN_ENABLED === 'true' (isEmailLoginEnabled), off by
// default — same posture as POT_SELF_SERVE_CHECKOUT_ENABLED
// (src/pots/checkout-flag.ts).
//
// No account-existence oracle: startEmailLogin's caller (POST /auth/email/start)
// returns the IDENTICAL 200 body whether the email is registered, unregistered,
// malformed, or rate-limited. Every early-return in this module is void —
// nothing it returns lets the route branch observably on WHY nothing was sent.
//
// mupot#1564 adversarial gate round 1 (kasra-review BLOCK + Athena BLOCK,
// 2026-09-26, PR #1574, head 8cbb0a52): the FIRST version of this module kept
// its counters/single-use markers in KV as read-compare-put sequences. KV has
// no compare-and-set — proven live: 4 concurrent /start sent 4 emails past a
// stated ceiling of 3, 2 concurrent link verifies both minted a session, and
// 6 concurrent wrong-code guesses left the 5-guess cap never firing and the
// right code still usable. Every gating decision now lives in D1
// (migrations/0174_email_login_attempts.sql) as ONE atomic statement per
// decision — see decrementRateLimit/consumeAttempt/incrementCodeAttempts
// below, each proven against real concurrent D1 calls in
// tests/email-login.test.ts's "concurrency" describe block.

import type { Env } from '../types'
import { sha256Hex } from '../members/service'
import { timingSafeEqual } from '../lib/crypto'
import { normalizeInviteEmail } from './pending-invite-link'
import { resolveEmailSender } from './email-sender'

const ATTEMPT_TTL_SECONDS = 600 // 10 minutes — link + code share one expiry
const RATE_LIMIT_WINDOW_SECONDS = 600 // 10-minute fixed buckets
const RATE_LIMIT_EMAIL_MAX = 3
const RATE_LIMIT_IP_START_MAX = 10
// New this round (adversarial gate P0-1): /verify had no per-IP ceiling at
// all — a distributed brute-force could spread guesses/link-consumes across
// attempt ids without ever touching the per-attempt 5-guess cap on any ONE
// row. Deliberately more generous than the start ceiling: a legitimate human
// mistyping a 6-digit code a few times, or a slow email client retrying the
// link, must not be punished as hard as a bulk /start abuser.
const RATE_LIMIT_IP_VERIFY_MAX = 30
const CODE_MAX_ATTEMPTS = 5 // guards the 6-digit code's small (1e6) search space
// Response-time floor for POST /email/start: the rate-limited branch (a
// couple of D1 upserts) and the send branch (an INSERT + a backgrounded fetch
// that never blocks the response — see below) must take the same wall time
// from the caller's perspective, or the elapsed time itself becomes an oracle
// for "was this email/IP already at its ceiling."
const START_RESPONSE_FLOOR_MS = 200

const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export { normalizeInviteEmail as normalizeLoginEmail }

/** Enabled ONLY when EMAIL_LOGIN_ENABLED is exactly the string "true". */
export function isEmailLoginEnabled(env: Pick<Env, 'EMAIL_LOGIN_ENABLED'>): boolean {
  return env.EMAIL_LOGIN_ENABLED === 'true'
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return s
}

/** Uniform in [0, 999999] via rejection sampling — no modulo bias. */
function randomSixDigitCode(): string {
  const buf = new Uint32Array(1)
  const ceiling = Math.floor(0x100000000 / 1_000_000) * 1_000_000
  let value: number
  do {
    crypto.getRandomValues(buf)
    value = buf[0]
  } while (value >= ceiling)
  return String(value % 1_000_000).padStart(6, '0')
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

type RateLimitScope = 'start_email' | 'start_ip' | 'verify_ip'

/**
 * ONE atomic check-and-increment, not read-then-write. SQLite's upsert
 * `DO UPDATE ... WHERE <cond>` skips the UPDATE (0 rows changed, no error,
 * no exception) when <cond> is false — so "was this key already at its
 * ceiling" and "record this call against it" happen in the SAME statement.
 * No second caller can ever observe the pre-increment count and act on it;
 * there is no window between a read and a write for a concurrent request to
 * land in. Verified directly against node:sqlite before relying on it here
 * (5 concurrent calls with max=3 → exactly 3 succeed, 2 no-op, final count=3).
 *
 * Fixed 10-minute buckets, not a sliding window — see the migration's own
 * header for why that's an accepted simplification, not a gap in THIS fix
 * (the property being guaranteed here is atomicity under concurrency).
 *
 * Fail CLOSED on D1 trouble, same posture as the enroll-mint limiter
 * (Athena, PR #1254): "a credential-minting surface must refuse on KV
 * trouble ... fail-open turns the brake off during an outage." Sending a
 * login secret, or accepting a login guess, is exactly that kind of surface.
 */
async function underRateLimit(
  env: Env,
  tenant: string,
  scope: RateLimitScope,
  key: string,
  max: number,
  nowMs: number,
): Promise<boolean> {
  const windowStart = new Date(Math.floor(nowMs / (RATE_LIMIT_WINDOW_SECONDS * 1000)) * RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString()
  try {
    const result = await env.DB.prepare(
      `INSERT INTO email_login_rate_limits (tenant, scope, key, window_start, count)
       VALUES (?1, ?2, ?3, ?4, 1)
       ON CONFLICT (tenant, scope, key, window_start) DO UPDATE SET count = count + 1
        WHERE count < ?5`,
    )
      .bind(tenant, scope, key, windowStart, max)
      .run()
    return Number(result.meta?.changes ?? 0) > 0
  } catch (err) {
    console.error('[email-login] rate-limit check failed (refusing, fail-closed):', err instanceof Error ? err.message : err)
    return false
  }
}

export interface StartEmailLoginInput {
  env: Env
  tenant: string
  email: string
  /** cf-connecting-ip ONLY — never X-Forwarded-For (client-controllable,
   *  and NOT authoritative the way Cloudflare's own edge-set header is). See
   *  src/auth/index.ts's resolveClientIp. 'unknown' when genuinely absent
   *  (local dev / a test harness) — still rate-limited under that literal
   *  key, never skipped (adversarial gate: "don't skip when ip==='unknown'"). */
  ip: string
  /** The mupot_pending_invite cookie value, if the browser is carrying one
   *  (invite-accept → email-login flow). Bound into the attempt record so
   *  verify-time can re-run the SAME state↔cookie binding check /auth/login
   *  applies for OAuth state — never trusted from the cookie alone at
   *  verify time either. */
  pendingInviteId: string | null
  /** This request's own origin (scheme+host), used to build the verify link.
   *  Never client-suppliable beyond what Hono's URL parsing already trusts
   *  for every other absolute-link builder in this file (callbackUrl in
   *  src/auth/index.ts does the same). */
  origin: string
  /** Defers email delivery off the response's critical path — mirrors
   *  workers/inkwell-api's own request-code route (c.executionCtx.waitUntil),
   *  so a slow/failed Resend call never adds latency or a distinguishable
   *  failure mode to the caller's response. */
  waitUntil: (promise: Promise<unknown>) => void
}

/**
 * startEmailLogin — generate + store a fresh token/code and best-effort
 * deliver it. Returns nothing observable: the ROUTE returns the identical
 * 200 body regardless of which internal branch ran (malformed email,
 * rate-limited, sender unconfigured, or a real send) — see this module's
 * header for why.
 */
export async function startEmailLogin(input: StartEmailLoginInput): Promise<void> {
  const startedAt = Date.now()
  const env = input.env
  const emailNormalized = normalizeInviteEmail(input.email)

  if (!emailNormalized || !EMAIL_SHAPE_RE.test(emailNormalized)) {
    await sleepMs(START_RESPONSE_FLOOR_MS - (Date.now() - startedAt))
    return
  }

  // Both checks ALWAYS run — no ip==='unknown' bypass (adversarial gate: a
  // request with no resolvable IP must land in its own shared 'unknown'
  // bucket and still be capped, never skip the ceiling outright).
  const [emailOk, ipOk] = await Promise.all([
    underRateLimit(env, input.tenant, 'start_email', emailNormalized, RATE_LIMIT_EMAIL_MAX, startedAt),
    underRateLimit(env, input.tenant, 'start_ip', input.ip, RATE_LIMIT_IP_START_MAX, startedAt),
  ])

  if (emailOk && ipOk) {
    const attemptId = randomHex(16)
    const token = randomHex(32)
    const code = randomSixDigitCode()
    const [tokenHash, codeHash] = await Promise.all([sha256Hex(token), sha256Hex(code)])
    const nowIso = new Date(startedAt).toISOString()
    const expiresAt = new Date(startedAt + ATTEMPT_TTL_SECONDS * 1000).toISOString()

    try {
      await env.DB.prepare(
        `INSERT INTO email_login_attempts
           (id, tenant, email_normalized, token_hash, code_hash, pending_invite_id, code_attempts, consumed_at, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, ?8)`,
      )
        .bind(attemptId, input.tenant, emailNormalized, tokenHash, codeHash, input.pendingInviteId, expiresAt, nowIso)
        .run()

      const sender = resolveEmailSender(env)
      if (!sender) {
        // Prod misconfiguration (no RESEND_API_KEY/RESEND_FROM_EMAIL, and not
        // console/dev): one structured log line, never a different response —
        // same "log it, never change the caller's outcome" posture as an
        // absent IM_WEBHOOK_SECRET elsewhere in this codebase, except THIS
        // route has no safe closed state to fall into (it must still 200, or
        // its status code alone becomes the oracle).
        console.error('[email-login] no sender configured — set RESEND_API_KEY + RESEND_FROM_EMAIL, or EMAIL_PROVIDER=console for dev')
      } else {
        const verifyUrl = `${input.origin}/auth/email/verify?t=${token}&a=${attemptId}`
        input.waitUntil(
          sender
            .send({
              to: emailNormalized,
              subject: 'Your sign-in link and code',
              text: `Sign in: ${verifyUrl}\n\nOr enter this code: ${code}\n\nThis link and code expire in 10 minutes. If you did not request this, ignore this email.`,
              html: `<p><a href="${verifyUrl}">Sign in</a></p><p>Or enter this code: <strong>${code}</strong></p><p>This link and code expire in 10 minutes. If you did not request this, ignore this email.</p>`,
            })
            .catch((err: unknown) => {
              console.error('[email-login] send failed:', err instanceof Error ? err.message : err)
            }),
        )
      }
    } catch (err) {
      console.error('[email-login] failed to persist attempt (nothing sent):', err instanceof Error ? err.message : err)
    }
  }

  await sleepMs(START_RESPONSE_FLOOR_MS - (Date.now() - startedAt))
}

export type VerifyEmailLoginResult =
  | { kind: 'ok'; emailNormalized: string; pendingInviteId: string | null }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'too_many_attempts' }
  | { kind: 'rate_limited' }

interface AttemptClassifyRow {
  consumed_at: string | null
  expires_at: string
  code_attempts: number
}

/**
 * Read-only classification used ONLY to pick a friendlier error kind after
 * the atomic guard already refused (changes===0). Never decision-bearing —
 * the atomic UPDATE it follows is the sole authority for whether the call
 * succeeded; this can only ever downgrade "no" into a more specific "no".
 */
async function classifyAttemptFailure(env: Env, tenant: string, attemptId: string, nowMs: number): Promise<'invalid' | 'expired' | 'too_many_attempts'> {
  const row = await env.DB.prepare(
    `SELECT consumed_at, expires_at, code_attempts FROM email_login_attempts WHERE id = ?1 AND tenant = ?2`,
  )
    .bind(attemptId, tenant)
    .first<AttemptClassifyRow>()
  if (!row) return 'invalid'
  if (row.consumed_at !== null) return 'invalid'
  if (new Date(row.expires_at).getTime() <= nowMs) return 'expired'
  if (row.code_attempts >= CODE_MAX_ATTEMPTS) return 'too_many_attempts'
  return 'invalid'
}

/**
 * GET /auth/email/verify?t=&a= (P1-2, adversarial gate): the emailed link
 * used to be consumed on GET — a plain navigation, which mail-scanner
 * prefetchers (M365 Safe Links etc.) and a login-CSRF (`<img
 * src="…/verify?t=…&a=…">` embedded on a page the victim's browser loads,
 * signing the victim into the ATTACKER's session) can both trigger with zero
 * user intent. GET now does NOTHING to the database — src/auth/index.ts
 * renders a static confirm page with the token/attempt id in hidden fields;
 * ONLY this function, called from the confirm page's csrf()-protected POST,
 * ever touches email_login_attempts. Consuming and comparing the token
 * happen in ONE atomic UPDATE — no read-then-write window for a second
 * concurrent POST (a double form submit, or two devices with the same
 * emailed link) to also succeed.
 */
export async function verifyEmailLoginByToken(
  env: Env,
  tenant: string,
  attemptId: string,
  token: string,
  ip: string,
): Promise<VerifyEmailLoginResult> {
  const nowMs = Date.now()
  if (!(await underRateLimit(env, tenant, 'verify_ip', ip, RATE_LIMIT_IP_VERIFY_MAX, nowMs))) {
    return { kind: 'rate_limited' }
  }
  if (!attemptId || !token) return { kind: 'invalid' }
  const tokenHash = await sha256Hex(token)
  const nowIso = new Date(nowMs).toISOString()

  interface ConsumeRow { email_normalized: string; pending_invite_id: string | null }
  const result = await env.DB.prepare(
    `UPDATE email_login_attempts
        SET consumed_at = ?1
      WHERE id = ?2 AND tenant = ?3 AND token_hash = ?4
        AND consumed_at IS NULL AND expires_at > ?1
     RETURNING email_normalized, pending_invite_id`,
  )
    .bind(nowIso, attemptId, tenant, tokenHash)
    .first<ConsumeRow>()

  if (result) {
    return { kind: 'ok', emailNormalized: result.email_normalized, pendingInviteId: result.pending_invite_id }
  }
  return { kind: await classifyAttemptFailure(env, tenant, attemptId, nowMs) }
}

interface CodeCandidateRow {
  id: string
}

interface CodeHashRow {
  code_hash: string
  email_normalized: string
  pending_invite_id: string | null
}

/**
 * POST /auth/email/verify {email, code} — the typed-in code, cross-device.
 *
 * Two atomic steps, neither a read-then-write for the DECISION they gate:
 *   1. `code_attempts = code_attempts + 1 WHERE code_attempts < 5 AND …` —
 *      EVERY guess (right or wrong) contends for the row's shared ceiling;
 *      under N concurrent guesses only the first 5 across ALL of them ever
 *      get a slot, not 5 PER caller. This is what closes the adversarial
 *      finding ("6 concurrent wrong codes leave the right code usable") —
 *      before, each concurrent request read code_attempts=0 and wrote back
 *      1, so the cap never accumulated.
 *   2. `consumed_at = ? WHERE consumed_at IS NULL` — even among the (at
 *      most 5) callers that won a slot, only ONE can ever win the final
 *      consume if more than one somehow guessed the right code.
 */
export async function verifyEmailLoginByCode(
  env: Env,
  tenant: string,
  email: string,
  code: string,
  ip: string,
): Promise<VerifyEmailLoginResult> {
  const nowMs = Date.now()
  if (!(await underRateLimit(env, tenant, 'verify_ip', ip, RATE_LIMIT_IP_VERIFY_MAX, nowMs))) {
    return { kind: 'rate_limited' }
  }
  const emailNormalized = normalizeInviteEmail(email)
  if (!emailNormalized || !code) return { kind: 'invalid' }
  const nowIso = new Date(nowMs).toISOString()

  // Read-only lookup for "which attempt is current for this email" — NOT the
  // decision. A concurrent /start for the same email creates a SEPARATE row
  // (its own independent ceiling/consumed_at), so this ordering choice is a
  // UX nicety (pick the newest), never a security boundary.
  const candidate = await env.DB.prepare(
    `SELECT id FROM email_login_attempts
      WHERE tenant = ?1 AND email_normalized = ?2 AND consumed_at IS NULL AND expires_at > ?3
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(tenant, emailNormalized, nowIso)
    .first<CodeCandidateRow>()
  if (!candidate) return { kind: 'invalid' }

  const incremented = await env.DB.prepare(
    `UPDATE email_login_attempts
        SET code_attempts = code_attempts + 1
      WHERE id = ?1 AND tenant = ?2 AND code_attempts < ?3 AND consumed_at IS NULL AND expires_at > ?4`,
  )
    .bind(candidate.id, tenant, CODE_MAX_ATTEMPTS, nowIso)
    .run()
  if (Number(incremented.meta?.changes ?? 0) === 0) {
    return { kind: await classifyAttemptFailure(env, tenant, candidate.id, nowMs) }
  }

  // This call WON one of the (at most 5) slots — safe to read the immutable
  // fields (code_hash/email/pending-invite never change after INSERT).
  const row = await env.DB.prepare(
    `SELECT code_hash, email_normalized, pending_invite_id FROM email_login_attempts WHERE id = ?1 AND tenant = ?2`,
  )
    .bind(candidate.id, tenant)
    .first<CodeHashRow>()
  if (!row) return { kind: 'invalid' }

  const codeHash = await sha256Hex(code)
  if (!timingSafeEqual(codeHash, row.code_hash)) return { kind: 'invalid' }

  const consumed = await env.DB.prepare(
    `UPDATE email_login_attempts SET consumed_at = ?1 WHERE id = ?2 AND tenant = ?3 AND consumed_at IS NULL`,
  )
    .bind(nowIso, candidate.id, tenant)
    .run()
  if (Number(consumed.meta?.changes ?? 0) === 0) {
    // Lost the race to consume — another concurrent guess with the SAME
    // right code (or the confirm-page token path) won it first.
    return { kind: 'invalid' }
  }
  return { kind: 'ok', emailNormalized: row.email_normalized, pendingInviteId: row.pending_invite_id }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The "check your inbox, or type the code" page after a successful /start
 *  (rendered only for an HTML-navigating browser POST — see src/auth/index.ts).
 *  No PII beyond the email the person themselves just typed into this same
 *  browser (round-tripped so the code form doesn't need it retyped). */
export function emailSentBody(brand: string, email: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Check your inbox · ${esc(brand)}</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f6;color:#171b19;font-family:system-ui,-apple-system,sans-serif;padding:24px; }
      @media (prefers-color-scheme: dark) { body { background:#0e1116;color:#e6edf3; } }
      .card { max-width:420px;width:100%;background:#fff;border:1px solid #e7e9e7;border-radius:12px;padding:28px 32px; }
      @media (prefers-color-scheme: dark) { .card { background:#161b22;border-color:#2a3140; } }
      h1 { font-size:20px;margin:0 0 14px; }
      p.muted { color:#7a827d;font-size:13px; }
      input { width:100%;box-sizing:border-box;padding:10px 12px;font-size:16px;margin:6px 0 14px;border-radius:8px;border:1px solid #cfd3d0; }
      button { width:100%;padding:10px 12px;font-size:15px;border-radius:8px;border:none;background:#171b19;color:#fff;cursor:pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Check your inbox</h1>
      <p class="muted">We sent a sign-in link and a 6-digit code to <strong>${esc(email)}</strong>. Click the link, or enter the code below.</p>
      <form method="post" action="/auth/email/verify">
        <input type="hidden" name="email" value="${esc(email)}" />
        <label for="code">Code</label>
        <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required />
        <button type="submit">Sign in</button>
      </form>
      <p class="muted">Didn't get it? <a href="/">Start over</a>.</p>
    </div>
  </body>
</html>`
}

/**
 * GET /auth/email/verify's page (P1-2). Deliberately does NOT reveal the
 * target email (GET performs zero database work — see verifyEmailLoginByToken's
 * own doc comment) and deliberately requires a real click: the confirm POST
 * inherits authApp's csrf() Origin check, so an attacker's `<img>`/prefetch
 * GET can no longer sign anyone into anything, and the SAME click also
 * defeats a mail-scanner (M365 Safe Links etc.) that only ever issues GETs.
 */
export function emailConfirmBody(brand: string, token: string, attemptId: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Confirm sign-in · ${esc(brand)}</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f6;color:#171b19;font-family:system-ui,-apple-system,sans-serif;padding:24px; }
      @media (prefers-color-scheme: dark) { body { background:#0e1116;color:#e6edf3; } }
      .card { max-width:420px;width:100%;background:#fff;border:1px solid #e7e9e7;border-radius:12px;padding:28px 32px; }
      @media (prefers-color-scheme: dark) { .card { background:#161b22;border-color:#2a3140; } }
      h1 { font-size:20px;margin:0 0 14px; }
      p.muted { color:#7a827d;font-size:13px; }
      button { width:100%;padding:10px 12px;font-size:15px;border-radius:8px;border:none;background:#171b19;color:#fff;cursor:pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Confirm sign-in</h1>
      <p class="muted">Click below to finish signing in. This confirms it was really you, not an automatic link check.</p>
      <form method="post" action="/auth/email/verify">
        <input type="hidden" name="t" value="${esc(token)}" />
        <input type="hidden" name="a" value="${esc(attemptId)}" />
        <button type="submit">Confirm sign-in</button>
      </form>
    </div>
  </body>
</html>`
}

/** GET /auth/email/verify with a missing/malformed t or a. */
export function emailConfirmMissingBody(brand: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Sign-in link invalid · ${esc(brand)}</title>
  </head>
  <body>
    <h1>This sign-in link is incomplete</h1>
    <p><a href="/">Request a new sign-in link →</a></p>
  </body>
</html>`
}

/** Failure page for a bad/expired/exhausted/rate-limited link or code. */
export function emailVerifyFailureBody(brand: string, kind: 'invalid' | 'expired' | 'too_many_attempts' | 'rate_limited'): string {
  const message = kind === 'expired'
    ? 'This link or code has expired.'
    : kind === 'too_many_attempts'
      ? 'Too many incorrect codes — this sign-in attempt is no longer valid.'
      : kind === 'rate_limited'
        ? 'Too many attempts from this connection — try again in a few minutes.'
        : 'This link or code is invalid.'
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Sign-in link invalid · ${esc(brand)}</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f6;color:#171b19;font-family:system-ui,-apple-system,sans-serif;padding:24px; }
      @media (prefers-color-scheme: dark) { body { background:#0e1116;color:#e6edf3; } }
      .card { max-width:420px;width:100%;background:#fff;border:1px solid #e7e9e7;border-radius:12px;padding:28px 32px; }
      @media (prefers-color-scheme: dark) { .card { background:#161b22;border-color:#2a3140; } }
      h1 { font-size:20px;margin:0 0 14px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${esc(message)}</h1>
      <p><a href="/">Request a new sign-in link →</a></p>
    </div>
  </body>
</html>`
}

/** Refusal page for DEFECT CLASS B (mupot#1551 exclusive-control denial at
 *  the email-login door). Deliberately generic — the person already proved
 *  they control the mailbox (a valid token/code got them here), so refusing
 *  now carries no account-existence oracle, but it must not name the OTHER
 *  method/provider bound to the row (that would leak more than "linked
 *  elsewhere"). */
export function emailIdentityConflictBody(brand: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Already linked elsewhere · ${esc(brand)}</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f6;color:#171b19;font-family:system-ui,-apple-system,sans-serif;padding:24px; }
      @media (prefers-color-scheme: dark) { body { background:#0e1116;color:#e6edf3; } }
      .card { max-width:420px;width:100%;background:#fff;border:1px solid #e7e9e7;border-radius:12px;padding:28px 32px; }
      @media (prefers-color-scheme: dark) { .card { background:#161b22;border-color:#2a3140; } }
      h1 { font-size:20px;margin:0 0 14px; }
      p.muted { color:#7a827d;font-size:13px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>This email is already linked to a different sign-in method</h1>
      <p class="muted">Use the method already linked to this account, or ask an admin for help.</p>
      <p><a href="/auth/login">Sign in with Google →</a></p>
    </div>
  </body>
</html>`
}
