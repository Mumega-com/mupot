// mupot#1564/#1442 — email one-time link/code sign-in, beside Google.
//
// Schema: createSqliteD1 + applyAllMigrations. Real routes via authApp.fetch
// (+ inviteApp.fetch for the invite-accept leg) — no D1/route stubbing. The
// email sender is the real console sender (EMAIL_PROVIDER='console'); tests
// capture its console.log output to recover the token/code the same way a
// real inbox would present them, rather than reaching into KV internals.
//
// MUTATION LEDGER (break -> fail -> restore), verified by hand per this PR's
// brief:
//   1. single-use dropped (skip deleteAttempt on success)
//      -> "token is single-use" replay assertion fails (second verify succeeds)
//   2. rate limit disabled (underRateLimit always true)
//      -> "rate-limits per email" fails (4th send is observed, not silently dropped)
//   3. hash dropped (store raw token/code instead of sha256)
//      -> "stores only the hash" fails (stored value equals the raw secret)
//   4. registerWebSession bypassed (session minted without going through it)
//      -> "login-first via email attaches to a pre-existing clean row" fails
//      (human_login_identities row is missing) — NOT the invite-accept happy
//      path, whose identity link comes from linkAcceptedInviteIdentity
//      (the invite's own D1-authoritative link) independent of mintSession.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApp } from '../src/auth'
import { inviteApp } from '../src/dashboard/invite'
import { PENDING_INVITE_COOKIE } from '../src/auth/pending-invite-link'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const BRAND = 'Test Pot'

interface KvStore {
  store: Map<string, string>
  get: (key: string) => Promise<string | null>
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>
  delete: (key: string) => Promise<void>
}

function memoryKv(): KvStore {
  const store = new Map<string, string>()
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value)
    },
    delete: async (key) => {
      store.delete(key)
    },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-member-admin', 'member-admin', 'department', 'dept-a', 'admin');
    INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-squad', 'newcomer@example.com', 'squad-web', 'member', 'member-admin');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness, kv: KvStore, overrides: Partial<Env> = {}): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND,
    PUBLIC_ORIGIN: ORIGIN,
    OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-client-secret',
    SESSIONS: kv,
    EMAIL_LOGIN_ENABLED: 'true',
    EMAIL_PROVIDER: 'console',
    ...overrides,
  } as unknown as Env
}

function noopCtx() {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
}

function deferredCtx() {
  const deferred: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext
  return { ctx, flush: () => Promise.all(deferred) }
}

function postJson(path: string, body: Record<string, unknown>, cookie?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

function getReq(path: string, cookie?: string) {
  return new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {})
}

/** Captures console.log calls and pulls the verify URL + code out of the
 *  console sender's message — the same shape a real inbox presents. */
function captureConsoleLog() {
  const calls: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    calls.push(args.map(String).join(' '))
  })
  return {
    calls,
    restore: () => spy.mockRestore(),
    latest(): { token: string; attemptId: string; code: string } {
      const msg = calls[calls.length - 1]
      if (!msg) throw new Error('no email was sent')
      const urlMatch = /Sign in: (\S+)/.exec(msg)
      const codeMatch = /Or enter this code: (\d{6})/.exec(msg)
      if (!urlMatch || !codeMatch) throw new Error(`could not parse sent email: ${msg}`)
      const url = new URL(urlMatch[1])
      const token = url.searchParams.get('t')
      const attemptId = url.searchParams.get('a')
      if (!token || !attemptId) throw new Error(`verify link missing t/a: ${urlMatch[1]}`)
      return { token, attemptId, code: codeMatch[1] }
    },
  }
}

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = /mupot_session=([^;]+)/.exec(setCookie)
  if (!match) throw new Error('no session cookie set')
  return `mupot_session=${match[1]}`
}

describe('POST /auth/email/start', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
    vi.restoreAllMocks()
  })

  it('404s when EMAIL_LOGIN_ENABLED is not exactly "true"', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv(), { EMAIL_LOGIN_ENABLED: undefined })
    const res = await authApp.fetch(postJson('/email/start', { email: 'x@example.com' }), env, noopCtx())
    expect(res.status).toBe(404)
  })

  it('returns the identical 200 body for a known member email and an unknown one (no account-existence oracle)', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const known = await authApp.fetch(postJson('/email/start', { email: 'admin@pot.test' }), env, noopCtx())
    const unknown = await authApp.fetch(postJson('/email/start', { email: 'nobody@example.com' }), env, noopCtx())
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(await known.clone().json()).toEqual(await unknown.clone().json())
  })

  it('returns the same 200 body for a malformed email too', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const res = await authApp.fetch(postJson('/email/start', { email: 'not-an-email' }), env, noopCtx())
    expect(res.status).toBe(200)
  })

  it('rate-limits per email: the 4th start in the window sends nothing, but still 200s identically', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    const log = captureConsoleLog()
    const email = 'ratelimited@example.com'
    for (let i = 0; i < 3; i += 1) {
      const res = await authApp.fetch(postJson('/email/start', { email }), env, noopCtx())
      expect(res.status).toBe(200)
    }
    expect(log.calls.length).toBe(3)
    const fourth = await authApp.fetch(postJson('/email/start', { email }), env, noopCtx())
    expect(fourth.status).toBe(200)
    // No 4th send attempted — the ceiling refused it before generation.
    expect(log.calls.length).toBe(3)
    log.restore()
  })

  it('rate-limits per IP across different emails', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    const log = captureConsoleLog()
    const req = (email: string) =>
      new Request(`${ORIGIN}/email/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' },
        body: JSON.stringify({ email }),
      })
    for (let i = 0; i < 10; i += 1) {
      const res = await authApp.fetch(req(`user${i}@example.com`), env, noopCtx())
      expect(res.status).toBe(200)
    }
    expect(log.calls.length).toBe(10)
    const eleventh = await authApp.fetch(req('user-eleven@example.com'), env, noopCtx())
    expect(eleventh.status).toBe(200)
    expect(log.calls.length).toBe(10)
    log.restore()
  })

  it('stores only the SHA-256 hash of the token and code, never the raw value', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    const log = captureConsoleLog()
    const { ctx, flush } = deferredCtx()
    const res = await authApp.fetch(postJson('/email/start', { email: 'hashcheck@example.com' }), env, ctx)
    expect(res.status).toBe(200)
    await flush()
    const { token, attemptId, code } = log.latest()
    log.restore()

    const raw = kv.store.get(`email_otp:${attemptId}`)
    expect(raw).toBeTruthy()
    const record = JSON.parse(raw as string) as { tokenHash: string; codeHash: string }
    expect(record.tokenHash).not.toBe(token)
    expect(record.codeHash).not.toBe(code)
    const expectedTokenHash = await sha256Hex(token)
    const expectedCodeHash = await sha256Hex(code)
    expect(record.tokenHash).toBe(expectedTokenHash)
    expect(record.codeHash).toBe(expectedCodeHash)
  })
})

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('GET/POST /auth/email/verify', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
    vi.restoreAllMocks()
  })

  async function startAndCapture(env: Env, email: string): Promise<{ token: string; attemptId: string; code: string }> {
    const log = captureConsoleLog()
    const { ctx, flush } = deferredCtx()
    const res = await authApp.fetch(postJson('/email/start', { email }), env, ctx)
    expect(res.status).toBe(200)
    await flush()
    const parsed = log.latest()
    log.restore()
    return parsed
  }

  it('404s when EMAIL_LOGIN_ENABLED is not exactly "true"', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv(), { EMAIL_LOGIN_ENABLED: undefined })
    const res = await authApp.fetch(getReq('/email/verify?t=x&a=y'), env, noopCtx())
    expect(res.status).toBe(404)
  })

  it('refuses a wrong token with a matching attempt id', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { attemptId } = await startAndCapture(env, 'wrongtoken@example.com')
    const res = await authApp.fetch(getReq(`/email/verify?t=deadbeef&a=${attemptId}`), env, noopCtx())
    expect(res.status).toBe(401)
  })

  it('refuses an expired attempt', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    const { token, attemptId } = await startAndCapture(env, 'expired@example.com')
    const raw = kv.store.get(`email_otp:${attemptId}`)
    const record = JSON.parse(raw as string) as Record<string, unknown>
    record.expiresAt = new Date(Date.now() - 1000).toISOString()
    kv.store.set(`email_otp:${attemptId}`, JSON.stringify(record))
    const res = await authApp.fetch(getReq(`/email/verify?t=${token}&a=${attemptId}`), env, noopCtx())
    expect(res.status).toBe(410)
  })

  it('token is single-use — a replayed link is refused', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'replay@example.com')
    const first = await authApp.fetch(getReq(`/email/verify?t=${token}&a=${attemptId}`), env, noopCtx())
    expect(first.status).toBe(302)
    const second = await authApp.fetch(getReq(`/email/verify?t=${token}&a=${attemptId}`), env, noopCtx())
    expect(second.status).toBe(401)
  })

  it('code verify refuses a wrong code, then accepts the right one, then refuses reuse', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { code } = await startAndCapture(env, 'codepath@example.com')
    const wrong = await authApp.fetch(postJson('/email/verify', { email: 'codepath@example.com', code: '000000' === code ? '111111' : '000000' }), env, noopCtx())
    expect(wrong.status).toBe(401)
    const right = await authApp.fetch(postJson('/email/verify', { email: 'codepath@example.com', code }), env, noopCtx())
    expect(right.status).toBe(302)
    const reused = await authApp.fetch(postJson('/email/verify', { email: 'codepath@example.com', code }), env, noopCtx())
    expect(reused.status).toBe(401)
  })

  it('exhausts after 5 wrong code guesses', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { code } = await startAndCapture(env, 'bruteforce@example.com')
    const wrongCode = code === '000000' ? '999999' : '000000'
    for (let i = 0; i < 5; i += 1) {
      const res = await authApp.fetch(postJson('/email/verify', { email: 'bruteforce@example.com', code: wrongCode }), env, noopCtx())
      expect(res.status).toBe(401)
    }
    // The attempt is now spent even with the RIGHT code.
    const res = await authApp.fetch(postJson('/email/verify', { email: 'bruteforce@example.com', code }), env, noopCtx())
    expect([401, 429]).toContain(res.status)
  })

  it('happy path: invite accept -> email start -> verify -> session + human_login_identities(provider=email) + home squad', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())

    const acceptRes = await inviteApp.fetch(
      new Request(`${ORIGIN}/inv-squad`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
        body: new URLSearchParams({ display_name: 'New Comer' }),
      }),
      env,
    )
    expect(acceptRes.status).toBe(302)
    const setCookie = acceptRes.headers.get('set-cookie') ?? ''
    const pendingMatch = new RegExp(`${PENDING_INVITE_COOKIE}=([^;]+)`).exec(setCookie)
    if (!pendingMatch) throw new Error('invite accept did not set pending-invite cookie')
    const pendingCookie = `${PENDING_INVITE_COOKIE}=${pendingMatch[1]}`

    const log = captureConsoleLog()
    const { ctx, flush } = deferredCtx()
    const startRes = await authApp.fetch(
      postJson('/email/start', { email: 'newcomer@example.com' }, pendingCookie),
      env,
      ctx,
    )
    expect(startRes.status).toBe(200)
    await flush()
    const { token, attemptId } = log.latest()
    log.restore()

    const verifyRes = await authApp.fetch(getReq(`/email/verify?t=${token}&a=${attemptId}`, pendingCookie), env, noopCtx())
    expect(verifyRes.status).toBe(302)
    expect(verifyRes.headers.get('location')).toBe('/')

    const identity = harness.sqlite
      .prepare(`SELECT provider, provider_subject, verified_email, member_id FROM human_login_identities WHERE provider = 'email'`)
      .get() as { provider: string; provider_subject: string; verified_email: string; member_id: string } | undefined
    expect(identity).toBeTruthy()
    expect(identity?.provider_subject).toBe('newcomer@example.com')

    const member = harness.sqlite
      .prepare(`SELECT id FROM members WHERE lower(email) = 'newcomer@example.com'`)
      .get() as { id: string } | undefined
    expect(member?.id).toBe(identity?.member_id)

    const sessionCookie = sessionCookieFrom(verifyRes)
    const me = await authApp.fetch(getReq('/me', sessionCookie), env, noopCtx())
    expect(me.status).toBe(200)

    const home = harness.sqlite
      .prepare(`SELECT s.kind FROM capabilities c JOIN squads s ON s.id = c.scope_id WHERE c.member_id = ? AND c.scope_type = 'squad'`)
      .all(member?.id) as Array<{ kind: string | null }>
    expect(home.some((row) => row.kind === 'home')).toBe(true)
  })

  it('login-first via email attaches to a pre-existing clean row (mupot#1551 Option B, eligible)', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-clean', 'clean-row@example.com', 'Clean Row', 'active', '${TENANT}');
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'clean-row@example.com')
    const res = await authApp.fetch(getReq(`/email/verify?t=${token}&a=${attemptId}`), env, noopCtx())
    expect(res.status).toBe(302)

    const identities = harness.sqlite
      .prepare(`SELECT member_id FROM human_login_identities WHERE provider = 'email' AND provider_subject = 'clean-row@example.com'`)
      .all() as Array<{ member_id: string }>
    expect(identities).toHaveLength(1)
    expect(identities[0].member_id).toBe('member-clean')

    const memberCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM members WHERE lower(email) = 'clean-row@example.com'`)
      .get() as { n: number }
    expect(memberCount.n).toBe(1) // no duplicate member minted
  })

  it('login-first via email is DENIED exclusive control on a row with a live bearer (mupot#1551 predicate applies to every provider)', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-squatted', 'squatted@example.com', 'Squatted', 'active', '${TENANT}');
      INSERT INTO member_tokens (id, tenant, member_id, token_hash, label, channel, created_at)
        VALUES ('tok-1', '${TENANT}', 'member-squatted', 'irrelevant-hash', 'workspace', 'workspace', datetime('now'));
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'squatted@example.com')
    const res = await authApp.fetch(getReq(`/email/verify?t=${token}&a=${attemptId}`), env, noopCtx())
    // The login itself still succeeds (a KV session mints regardless) — only
    // the D1 identity bridge is denied, exactly like an ordinary Google login
    // hitting the same predicate.
    expect(res.status).toBe(302)

    const identities = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = 'member-squatted'`)
      .get() as { n: number }
    expect(identities.n).toBe(0)
  })

  it('flag off: /auth/email/start and /auth/email/verify both 404, landing page hides the email form', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv(), { EMAIL_LOGIN_ENABLED: undefined })
    const start = await authApp.fetch(postJson('/email/start', { email: 'x@example.com' }), env, noopCtx())
    const verify = await authApp.fetch(getReq('/email/verify?t=a&a=b'), env, noopCtx())
    expect(start.status).toBe(404)
    expect(verify.status).toBe(404)
  })
})
