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

import type { Env } from '../types'
import { sha256Hex } from '../members/service'
import { timingSafeEqual } from '../lib/crypto'
import { normalizeInviteEmail } from './pending-invite-link'
import { resolveEmailSender } from './email-sender'

const ATTEMPT_TTL_SECONDS = 600 // 10 minutes — link + code share one expiry
const RATE_LIMIT_WINDOW_SECONDS = 600 // 10 minutes
const RATE_LIMIT_EMAIL_MAX = 3
const RATE_LIMIT_IP_MAX = 10
const CODE_MAX_ATTEMPTS = 5 // guards the 6-digit code's small (1e6) search space
// Response-time floor for POST /email/start: the rate-limited branch (a few
// KV reads) and the send branch (KV writes + a backgrounded fetch that never
// blocks the response — see below) must take the same wall time from the
// caller's perspective, or the elapsed time itself becomes an oracle for
// "was this email/IP already at its ceiling."
const START_RESPONSE_FLOOR_MS = 200

const ATTEMPT_KV_PREFIX = 'email_otp:'
const ATTEMPT_BY_EMAIL_KV_PREFIX = 'email_otp_by_email:'
const RATE_LIMIT_EMAIL_KV_PREFIX = 'email_otp_rl_email:'
const RATE_LIMIT_IP_KV_PREFIX = 'email_otp_rl_ip:'

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

interface EmailLoginAttemptRecord {
  attemptId: string
  emailNormalized: string
  tokenHash: string
  codeHash: string
  expiresAt: string // ISO
  pendingInviteId: string | null
  codeAttempts: number
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fail CLOSED on KV trouble, same posture as the enroll-mint limiter
 * (Athena, PR #1254): "a credential-minting surface must refuse on KV
 * trouble ... fail-open turns the brake off during an outage." Sending a
 * login secret is exactly that kind of surface.
 */
async function underRateLimit(env: Env, key: string, max: number): Promise<boolean> {
  try {
    const raw = await env.SESSIONS.get(key)
    const count = raw !== null ? parseInt(raw, 10) : 0
    if (Number.isFinite(count) && count >= max) return false
    await env.SESSIONS.put(key, String((Number.isFinite(count) ? count : 0) + 1), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    })
    return true
  } catch {
    return false
  }
}

export interface StartEmailLoginInput {
  env: Env
  email: string
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

  const emailOk = await underRateLimit(env, `${RATE_LIMIT_EMAIL_KV_PREFIX}${emailNormalized}`, RATE_LIMIT_EMAIL_MAX)
  const ipOk = input.ip === 'unknown'
    ? true
    : await underRateLimit(env, `${RATE_LIMIT_IP_KV_PREFIX}${input.ip}`, RATE_LIMIT_IP_MAX)

  if (emailOk && ipOk) {
    const attemptId = randomHex(16)
    const token = randomHex(32)
    const code = randomSixDigitCode()
    const [tokenHash, codeHash] = await Promise.all([sha256Hex(token), sha256Hex(code)])
    const expiresAt = new Date(Date.now() + ATTEMPT_TTL_SECONDS * 1000).toISOString()

    const record: EmailLoginAttemptRecord = {
      attemptId,
      emailNormalized,
      tokenHash,
      codeHash,
      expiresAt,
      pendingInviteId: input.pendingInviteId,
      codeAttempts: 0,
    }

    await Promise.all([
      env.SESSIONS.put(`${ATTEMPT_KV_PREFIX}${attemptId}`, JSON.stringify(record), {
        expirationTtl: ATTEMPT_TTL_SECONDS,
      }),
      env.SESSIONS.put(`${ATTEMPT_BY_EMAIL_KV_PREFIX}${emailNormalized}`, attemptId, {
        expirationTtl: ATTEMPT_TTL_SECONDS,
      }),
    ])

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
  }

  await sleepMs(START_RESPONSE_FLOOR_MS - (Date.now() - startedAt))
}

export type VerifyEmailLoginResult =
  | { kind: 'ok'; emailNormalized: string; pendingInviteId: string | null }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'too_many_attempts' }

async function loadAttempt(env: Env, attemptId: string): Promise<EmailLoginAttemptRecord | null> {
  const raw = await env.SESSIONS.get(`${ATTEMPT_KV_PREFIX}${attemptId}`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<EmailLoginAttemptRecord>
    if (
      typeof parsed.attemptId !== 'string'
      || typeof parsed.emailNormalized !== 'string'
      || typeof parsed.tokenHash !== 'string'
      || typeof parsed.codeHash !== 'string'
      || typeof parsed.expiresAt !== 'string'
      || typeof parsed.codeAttempts !== 'number'
    ) {
      return null
    }
    return {
      attemptId: parsed.attemptId,
      emailNormalized: parsed.emailNormalized,
      tokenHash: parsed.tokenHash,
      codeHash: parsed.codeHash,
      expiresAt: parsed.expiresAt,
      pendingInviteId: typeof parsed.pendingInviteId === 'string' ? parsed.pendingInviteId : null,
      codeAttempts: parsed.codeAttempts,
    }
  } catch {
    return null
  }
}

/**
 * Single-use, delete-before-honoring — same discipline as
 * consumePendingInviteMarker (src/auth/pending-invite-link.ts). The
 * email→attempt pointer is only cleared when it STILL points at this exact
 * attempt: a newer /start call's pointer must survive an older attempt's own
 * cleanup (KV has no CAS, so this is best-effort, not atomic — the worst case
 * is a stale pointer that resolves to a dead attempt and reads as 'invalid').
 */
async function deleteAttempt(env: Env, attemptId: string, emailNormalized: string): Promise<void> {
  await env.SESSIONS.delete(`${ATTEMPT_KV_PREFIX}${attemptId}`)
  const pointer = await env.SESSIONS.get(`${ATTEMPT_BY_EMAIL_KV_PREFIX}${emailNormalized}`)
  if (pointer === attemptId) {
    await env.SESSIONS.delete(`${ATTEMPT_BY_EMAIL_KV_PREFIX}${emailNormalized}`)
  }
}

function isExpired(record: EmailLoginAttemptRecord): boolean {
  return new Date(record.expiresAt).getTime() <= Date.now()
}

/** GET /auth/email/verify?t=&a= — the emailed link. */
export async function verifyEmailLoginByToken(
  env: Env,
  attemptId: string,
  token: string,
): Promise<VerifyEmailLoginResult> {
  if (!attemptId || !token) return { kind: 'invalid' }
  const record = await loadAttempt(env, attemptId)
  if (!record) return { kind: 'invalid' }
  if (isExpired(record)) {
    await deleteAttempt(env, attemptId, record.emailNormalized)
    return { kind: 'expired' }
  }
  const tokenHash = await sha256Hex(token)
  if (!timingSafeEqual(tokenHash, record.tokenHash)) return { kind: 'invalid' }
  await deleteAttempt(env, attemptId, record.emailNormalized)
  return { kind: 'ok', emailNormalized: record.emailNormalized, pendingInviteId: record.pendingInviteId }
}

/** POST /auth/email/verify {email, code} — the typed-in code, cross-device. */
export async function verifyEmailLoginByCode(
  env: Env,
  email: string,
  code: string,
): Promise<VerifyEmailLoginResult> {
  const emailNormalized = normalizeInviteEmail(email)
  if (!emailNormalized || !code) return { kind: 'invalid' }
  const attemptId = await env.SESSIONS.get(`${ATTEMPT_BY_EMAIL_KV_PREFIX}${emailNormalized}`)
  if (!attemptId) return { kind: 'invalid' }
  const record = await loadAttempt(env, attemptId)
  if (!record) return { kind: 'invalid' }
  if (isExpired(record)) {
    await deleteAttempt(env, attemptId, emailNormalized)
    return { kind: 'expired' }
  }
  if (record.codeAttempts >= CODE_MAX_ATTEMPTS) {
    await deleteAttempt(env, attemptId, emailNormalized)
    return { kind: 'too_many_attempts' }
  }
  const codeHash = await sha256Hex(code)
  if (!timingSafeEqual(codeHash, record.codeHash)) {
    const updated: EmailLoginAttemptRecord = { ...record, codeAttempts: record.codeAttempts + 1 }
    await env.SESSIONS.put(`${ATTEMPT_KV_PREFIX}${attemptId}`, JSON.stringify(updated), {
      expirationTtl: ATTEMPT_TTL_SECONDS,
    })
    return { kind: 'invalid' }
  }
  await deleteAttempt(env, attemptId, emailNormalized)
  return { kind: 'ok', emailNormalized, pendingInviteId: record.pendingInviteId }
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

/** Failure page for a bad/expired/exhausted link or code. */
export function emailVerifyFailureBody(brand: string, kind: 'invalid' | 'expired' | 'too_many_attempts'): string {
  const message = kind === 'expired'
    ? 'This link or code has expired.'
    : kind === 'too_many_attempts'
      ? 'Too many incorrect codes — this sign-in attempt is no longer valid.'
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
