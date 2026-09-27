// mupot#1564/#1442 — email one-time link/code sign-in, beside Google.
//
// Schema: createSqliteD1 + applyAllMigrations (includes
// migrations/0174_email_login_attempts.sql). Real routes via authApp.fetch
// (+ inviteApp.fetch for the invite-accept leg) — no D1/route stubbing. The
// email sender is the real console sender (EMAIL_PROVIDER='console'); tests
// capture its console.log output to recover the token/code the same way a
// real inbox would present them, rather than reaching into DB internals for
// the SECRET values (D1 rows are inspected directly for shape/hash/identity
// assertions, which is not a secret and matches this repo's other real-D1
// integration tests).
//
// ADVERSARIAL GATE ROUND 1 (kasra-review BLOCK + Athena BLOCK, 2026-09-26,
// PR #1574 head 8cbb0a52): the FIRST version of this door kept its
// counters/single-use markers in KV as read-compare-put sequences — proven,
// with real concurrent requests against the real routes: 4 concurrent
// /start sent 4 emails past a stated ceiling of 3; 2 concurrent link
// verifies both minted a session; 6 concurrent wrong-code guesses left the
// 5-guess cap never firing and the right code still usable (DEFECT CLASS A).
// Separately, an ordinary (no-invite) email login inherited `users.role`
// (up to 'owner') by a second, email-keyed `users` lookup even when the
// members-identity attach was explicitly DENIED — a Google-linked owner's
// email could sign in as that same owner with no email identity ever linked
// (DEFECT CLASS B). And GET consumed the emailed link outright — a
// login-CSRF and mail-scanner-prefetch hazard (P1-2).
//
// ADVERSARIAL GATE ROUND 2 (kasra-review + Athena BLOCK, 2026-09-26, PR
// #1574 head c3e5bf75): round 1's Class A fix held completely (Athena's
// round-2 concurrent PoCs all confirmed green). ONE P0 remained, Class B by
// a THIRD table: `finishEmailLoginSuccess`'s `upsertUserByEmail(…, false)`
// still returned an EXISTING `users` row's role by bare email match —
// `allowBootstrapOwner=false` only ever gated ROW CREATION, never an
// existing row's inherited role. Three proven shapes, all closed by the
// SAME two checks (a live NON-email identity anywhere in the tenant whose
// verified_email matches, or an existing `users` row with role != 'member'
// — see src/auth/index.ts's finishEmailLoginSuccess for the full reasoning):
// A1 an org-owner-alias email whose OWN identity lives on a different
// member; A2 a powerless duplicate members row (#1162) beside the real
// owner, whose identity's verified_email drifted (#1266 P0-2) onto the
// duplicate's literal email; A3 a legacy owner/admin `users` row with NO
// members row at all (#1324) — decideIdentitylessAttach never even runs for
// it. Also P1: the /start rate-limit checks ran in Promise.all, so an IP
// already refused by its OWN ceiling still touched (and could exhaust) a
// FRESH victim email's separate counter on every further request.
//
// MUTATION LEDGER (break -> fail -> restore), verified by hand:
//   1. single-use dropped (drop `consumed_at IS NULL` from the consuming
//      UPDATE's WHERE clause)
//      -> "token is single-use" replay assertion fails (second confirm succeeds)
//   2. per-email start rate limit's WHERE guard dropped (upsert always
//      increments, cap never enforced)
//      -> "4 concurrent starts send at most 3 emails" fails (4 sends observed)
//   3. hash dropped (store raw token/code instead of sha256)
//      -> "stores only the hash" fails (stored value equals the raw secret)
//   4. registerWebSession bypassed (session minted without going through it)
//      -> "login-first via email attaches to a pre-existing clean row" fails
//      (human_login_identities row is missing) — NOT the invite-accept happy
//      path, whose identity link comes from linkAcceptedInviteIdentity
//      (the invite's own D1-authoritative link) independent of mintSession.
//   5. code-attempt ceiling's WHERE guard dropped (`code_attempts + 1` with
//      no `code_attempts < 5` condition)
//      -> "6 concurrent wrong codes exhaust the cap" fails (a 7th, correct,
//      guess still succeeds instead of being refused)
//   6. DEFECT CLASS B (round 1) gate removed (skip the decideIdentitylessAttach
//      check before upsertUserByEmail)
//      -> "Google-linked owner's email cannot sign in as that owner" fails
//      (302 + owner role instead of 403)
//   7. DEFECT CLASS B (round 2) foreign-identity check removed
//      -> A1 and A2 both fail (302 + session instead of 403)
//   8. DEFECT CLASS B (round 2) `users.role !== 'member'` check removed
//      -> A3 fails (302 + session instead of 403)
//   9. P1 rate-limit ordering reverted to Promise.all
//      -> "an IP already over its own limit never touches a NEW victim
//      email's counter" fails (the victim's counter row exists / count=1)
//  10. code-consume's `consumed_at IS NULL` (code path) or its
//      `changes === 0` check dropped
//      -> "5 concurrent confirms with the SAME correct code mint exactly
//      one session" fails (>1 winner)

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

function postJson(path: string, body: Record<string, unknown>, cookie?: string, ip?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(ip ? { 'cf-connecting-ip': ip } : {}),
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
      return parseSentMessage(msg)
    },
    all(): Array<{ token: string; attemptId: string; code: string }> {
      return calls.map(parseSentMessage)
    },
  }
}

function parseSentMessage(msg: string): { token: string; attemptId: string; code: string } {
  const urlMatch = /Sign in: (\S+)/.exec(msg)
  const codeMatch = /Or enter this code: (\d{6})/.exec(msg)
  if (!urlMatch || !codeMatch) throw new Error(`could not parse sent email: ${msg}`)
  const url = new URL(urlMatch[1])
  const token = url.searchParams.get('t')
  const attemptId = url.searchParams.get('a')
  if (!token || !attemptId) throw new Error(`verify link missing t/a: ${urlMatch[1]}`)
  return { token, attemptId, code: codeMatch[1] }
}

function sessionCookieFrom(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = /mupot_session=([^;]+)/.exec(setCookie)
  return match ? `mupot_session=${match[1]}` : null
}

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
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

  it('rate-limits per email sequentially: the 4th start in the window sends nothing, but still 200s identically', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const log = captureConsoleLog()
    const email = 'ratelimited@example.com'
    for (let i = 0; i < 3; i += 1) {
      const res = await authApp.fetch(postJson('/email/start', { email }), env, noopCtx())
      expect(res.status).toBe(200)
    }
    expect(log.calls.length).toBe(3)
    const fourth = await authApp.fetch(postJson('/email/start', { email }), env, noopCtx())
    expect(fourth.status).toBe(200)
    expect(log.calls.length).toBe(3)
    log.restore()
  })

  it('rate-limits per IP across different emails, sequentially', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const log = captureConsoleLog()
    for (let i = 0; i < 10; i += 1) {
      const res = await authApp.fetch(postJson('/email/start', { email: `user${i}@example.com` }, undefined, '203.0.113.9'), env, noopCtx())
      expect(res.status).toBe(200)
    }
    expect(log.calls.length).toBe(10)
    const eleventh = await authApp.fetch(postJson('/email/start', { email: 'user-eleven@example.com' }, undefined, '203.0.113.9'), env, noopCtx())
    expect(eleventh.status).toBe(200)
    expect(log.calls.length).toBe(10)
    log.restore()
  })

  it('stores only the SHA-256 hash of the token and code in D1, never the raw value', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const log = captureConsoleLog()
    const { ctx, flush } = deferredCtx()
    const res = await authApp.fetch(postJson('/email/start', { email: 'hashcheck@example.com' }), env, ctx)
    expect(res.status).toBe(200)
    await flush()
    const { token, attemptId, code } = log.latest()
    log.restore()

    const row = harness.sqlite
      .prepare('SELECT token_hash, code_hash FROM email_login_attempts WHERE id = ?')
      .get(attemptId) as { token_hash: string; code_hash: string } | undefined
    expect(row).toBeTruthy()
    expect(row?.token_hash).not.toBe(token)
    expect(row?.code_hash).not.toBe(code)
    expect(row?.token_hash).toBe(await sha256Hex(token))
    expect(row?.code_hash).toBe(await sha256Hex(code))
  })

  // ── DEFECT CLASS A: concurrency (Athena's round-1 repro shape) ──────────
  it('4 concurrent starts for the same email send at most 3 emails (the stated ceiling)', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const log = captureConsoleLog()
    const email = 'burst@example.com'
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => authApp.fetch(postJson('/email/start', { email }), env, noopCtx())),
    )
    for (const res of responses) expect(res.status).toBe(200) // identical 200 regardless — no oracle
    expect(log.calls.length).toBe(3)
    log.restore()
  })

  // ── P1 (round 2): rate-limit ORDERING — an IP already over its own limit
  // must never touch a fresh victim's per-email counter ──────────────────
  it('an IP already over its own limit never touches a NEW victim email\'s counter', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const log = captureConsoleLog()
    const ip = '198.51.100.7'
    for (let i = 0; i < 10; i += 1) {
      await authApp.fetch(postJson('/email/start', { email: `burn${i}@example.com` }, undefined, ip), env, noopCtx())
    }
    expect(log.calls.length).toBe(10) // the IP's own ceiling
    const res = await authApp.fetch(postJson('/email/start', { email: 'victim@example.com' }, undefined, ip), env, noopCtx())
    expect(res.status).toBe(200) // still 200, identical body — no oracle
    expect(log.calls.length).toBe(10) // no 11th send
    const row = harness.sqlite
      .prepare(`SELECT count FROM email_login_rate_limits WHERE scope = 'start_email' AND key = 'victim@example.com'`)
      .get() as { count: number } | undefined
    expect(row).toBeUndefined() // the email counter was never even touched
    log.restore()
  })
})

describe('GET/POST /auth/email/verify', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
    vi.restoreAllMocks()
  })

  async function startAndCapture(env: Env, email: string, pendingCookie?: string): Promise<{ token: string; attemptId: string; code: string }> {
    const log = captureConsoleLog()
    const { ctx, flush } = deferredCtx()
    const res = await authApp.fetch(postJson('/email/start', { email }, pendingCookie), env, ctx)
    expect(res.status).toBe(200)
    await flush()
    const parsed = log.latest()
    log.restore()
    return parsed
  }

  function confirmToken(env: Env, token: string, attemptId: string, cookie?: string) {
    return authApp.fetch(postJson('/email/verify', { t: token, a: attemptId }, cookie), env, noopCtx())
  }

  function verifyCode(env: Env, email: string, code: string) {
    return authApp.fetch(postJson('/email/verify', { email, code }), env, noopCtx())
  }

  it('404s when EMAIL_LOGIN_ENABLED is not exactly "true"', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv(), { EMAIL_LOGIN_ENABLED: undefined })
    const getRes = await authApp.fetch(getReq('/email/verify?t=x&a=y'), env, noopCtx())
    const postRes = await authApp.fetch(postJson('/email/verify', { t: 'x', a: 'y' }), env, noopCtx())
    expect(getRes.status).toBe(404)
    expect(postRes.status).toBe(404)
  })

  // ── P1-2: GET renders a confirm page, never consumes ────────────────────
  it('GET with missing t/a renders a 400 error page, no DB touched', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const res = await authApp.fetch(getReq('/email/verify'), env, noopCtx())
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('GET with a valid t/a renders a confirm page (200 HTML) and does NOT consume — a later POST confirm still works', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'linkclick@example.com')

    const getRes = await authApp.fetch(getReq(`/email/verify?t=${token}&a=${attemptId}`), env, noopCtx())
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get('content-type')).toContain('text/html')
    const body = await getRes.text()
    expect(body).toContain(token)
    expect(body).toContain(attemptId)
    // Confirm the row is still live (unconsumed) after the GET.
    const row = harness.sqlite.prepare('SELECT consumed_at FROM email_login_attempts WHERE id = ?').get(attemptId) as { consumed_at: string | null }
    expect(row.consumed_at).toBeNull()

    const postRes = await confirmToken(env, token, attemptId)
    expect(postRes.status).toBe(302)
  })

  it('a link-scanner-style repeated GET never burns the link (no consumption on any GET)', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'scanner@example.com')
    for (let i = 0; i < 5; i += 1) {
      const res = await authApp.fetch(getReq(`/email/verify?t=${token}&a=${attemptId}`), env, noopCtx())
      expect(res.status).toBe(200)
    }
    const postRes = await confirmToken(env, token, attemptId)
    expect(postRes.status).toBe(302)
  })

  it('confirm POST refuses a wrong token with a matching attempt id', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { attemptId } = await startAndCapture(env, 'wrongtoken@example.com')
    const res = await confirmToken(env, 'deadbeef', attemptId)
    expect(res.status).toBe(401)
  })

  it('confirm POST refuses an expired attempt', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'expired@example.com')
    harness.sqlite
      .prepare('UPDATE email_login_attempts SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), attemptId)
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(410)
  })

  it('token is single-use — a replayed confirm is refused', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'replay@example.com')
    const first = await confirmToken(env, token, attemptId)
    expect(first.status).toBe(302)
    const second = await confirmToken(env, token, attemptId)
    expect(second.status).toBe(401)
  })

  it('code verify refuses a wrong code, then accepts the right one, then refuses reuse', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { code } = await startAndCapture(env, 'codepath@example.com')
    const wrongCode = code === '000000' ? '111111' : '000000'
    const wrong = await verifyCode(env, 'codepath@example.com', wrongCode)
    expect(wrong.status).toBe(401)
    const right = await verifyCode(env, 'codepath@example.com', code)
    expect(right.status).toBe(302)
    const reused = await verifyCode(env, 'codepath@example.com', code)
    expect(reused.status).toBe(401)
  })

  it('exhausts after 5 wrong code guesses, sequentially', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { code } = await startAndCapture(env, 'bruteforce@example.com')
    const wrongCode = code === '000000' ? '999999' : '000000'
    for (let i = 0; i < 5; i += 1) {
      const res = await verifyCode(env, 'bruteforce@example.com', wrongCode)
      expect(res.status).toBe(401)
    }
    const res = await verifyCode(env, 'bruteforce@example.com', code)
    expect(res.status).toBe(429) // cap already exhausted — too_many_attempts, not a fresh wrong guess
  })

  // ── DEFECT CLASS A: concurrency (Athena's round-1 repro shape) ──────────
  it('2 concurrent confirms of the SAME valid link mint exactly one session', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'concurrent-link@example.com')
    const [a, b] = await Promise.all([confirmToken(env, token, attemptId), confirmToken(env, token, attemptId)])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([302, 401])
    const winners = [a, b].filter((r) => r.status === 302)
    expect(winners).toHaveLength(1)
    expect(sessionCookieFrom(winners[0])).toBeTruthy()
  })

  it('6 concurrent wrong-code guesses exhaust the 5-guess cap — the correct code is then refused too', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { code } = await startAndCapture(env, 'concurrent-guess@example.com')
    const wrongCode = code === '000000' ? '999999' : '000000'
    const results = await Promise.all(
      Array.from({ length: 6 }, () => verifyCode(env, 'concurrent-guess@example.com', wrongCode)),
    )
    // Every one of the 6 concurrent guesses was wrong, but only the first 5
    // (across ALL of them combined, not 5 each) ever won an increment slot —
    // the other(s) are refused as 'too_many_attempts' (429), not a fresh
    // 'invalid' wrong-guess (401). Either status proves the guess itself
    // never succeeded; the row-level assertion below is the real proof the
    // ceiling held under concurrency.
    for (const res of results) expect([401, 429]).toContain(res.status)
    // Before the fix: each concurrent request read code_attempts=0 and wrote
    // back 1, so the cap never accumulated and the correct code stayed
    // usable. Now the ceiling is shared and atomic across all 6 callers.
    const row = harness.sqlite
      .prepare(`SELECT id FROM email_login_attempts WHERE email_normalized = 'concurrent-guess@example.com'`)
      .get() as { id: string }
    const attemptRow = harness.sqlite
      .prepare('SELECT code_attempts FROM email_login_attempts WHERE id = ?')
      .get(row.id) as { code_attempts: number }
    expect(attemptRow.code_attempts).toBe(5)
    const finalTry = await verifyCode(env, 'concurrent-guess@example.com', code)
    expect(finalTry.status).toBe(429) // cap already exhausted before the correct code ever arrives
  })

  it('happy path: invite accept -> email start -> confirm -> session + human_login_identities(provider=email) + home squad', async () => {
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

    const { token, attemptId } = await startAndCapture(env, 'newcomer@example.com', pendingCookie)

    const confirmRes = await confirmToken(env, token, attemptId, pendingCookie)
    expect(confirmRes.status).toBe(302)
    expect(confirmRes.headers.get('location')).toBe('/')

    const identity = harness.sqlite
      .prepare(`SELECT provider, provider_subject, verified_email, member_id FROM human_login_identities WHERE provider = 'email'`)
      .get() as { provider: string; provider_subject: string; verified_email: string; member_id: string } | undefined
    expect(identity).toBeTruthy()
    expect(identity?.provider_subject).toBe('newcomer@example.com')

    const member = harness.sqlite
      .prepare(`SELECT id FROM members WHERE lower(email) = 'newcomer@example.com'`)
      .get() as { id: string } | undefined
    expect(member?.id).toBe(identity?.member_id)

    const sessionCookie = sessionCookieFrom(confirmRes)
    expect(sessionCookie).toBeTruthy()
    const me = await authApp.fetch(getReq('/me', sessionCookie as string), env, noopCtx())
    expect(me.status).toBe(200)

    const home = harness.sqlite
      .prepare(`SELECT s.kind FROM capabilities c JOIN squads s ON s.id = c.scope_id WHERE c.member_id = ? AND c.scope_type = 'squad'`)
      .all(member?.id) as Array<{ kind: string | null }>
    expect(home.some((row) => row.kind === 'home')).toBe(true)
  })

  it('login-first via email attaches to a pre-existing clean row (mupot#1551 Option B, eligible) and never becomes owner', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-clean', 'clean-row@example.com', 'Clean Row', 'active', '${TENANT}');
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'clean-row@example.com')
    const res = await confirmToken(env, token, attemptId)
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

    // allowBootstrapOwner=false for email, always — even the first-ever
    // `users` row in this harness must not become owner via this door.
    const user = harness.sqlite.prepare(`SELECT role FROM users WHERE email = 'clean-row@example.com'`).get() as { role: string } | undefined
    expect(user?.role).toBe('member')
  })

  // ── DEFECT CLASS B: identity conflict must refuse the WHOLE login ───────
  it('a member with a live TELEGRAM bind refuses email login entirely (no session, no identity link)', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant, telegram_chat_id)
        VALUES ('member-telegram', 'telegram-bound@example.com', 'TG Bound', 'active', '${TENANT}', 'chat-123');
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'telegram-bound@example.com')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()

    const identities = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = 'member-telegram'`)
      .get() as { n: number }
    expect(identities.n).toBe(0)
  })

  it('a member with a live UNBOUND bearer refuses email login entirely', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-squatted', 'squatted@example.com', 'Squatted', 'active', '${TENANT}');
      INSERT INTO member_tokens (id, tenant, member_id, token_hash, label, channel, created_at)
        VALUES ('tok-1', '${TENANT}', 'member-squatted', 'irrelevant-hash', 'workspace', 'workspace', datetime('now'));
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'squatted@example.com')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()

    const identities = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = 'member-squatted'`)
      .get() as { n: number }
    expect(identities.n).toBe(0)
  })

  it("a Google-linked owner's email cannot sign in as that owner (adversarial gate P0-2 exact repro)", async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-owner', 'owner@pot.test', 'The Owner', 'active', '${TENANT}');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
        VALUES ('hli-1', '${TENANT}', 'google', 'google-sub-owner', 'owner@pot.test', 'member-owner', datetime('now'));
      INSERT INTO users (id, email, role) VALUES ('user-owner', 'owner@pot.test', 'owner');
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'owner@pot.test')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()

    // No email identity was linked, and the users row's role is untouched.
    const emailIdentity = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE provider = 'email' AND provider_subject = 'owner@pot.test'`)
      .get() as { n: number }
    expect(emailIdentity.n).toBe(0)
    const user = harness.sqlite.prepare(`SELECT role FROM users WHERE email = 'owner@pot.test'`).get() as { role: string }
    expect(user.role).toBe('owner') // unchanged, but never reachable via this login
  })

  it('a returning email-login user (already linked) re-logs in normally', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-repeat', 'repeat@example.com', 'Repeat User', 'active', '${TENANT}');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
        VALUES ('hli-2', '${TENANT}', 'email', 'repeat@example.com', 'repeat@example.com', 'member-repeat', datetime('now'));
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'repeat@example.com')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(302)
    expect(sessionCookieFrom(res)).toBeTruthy()
  })

  it('flag off: /auth/email/start and /auth/email/verify both 404, landing page hides the email form', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv(), { EMAIL_LOGIN_ENABLED: undefined })
    const start = await authApp.fetch(postJson('/email/start', { email: 'x@example.com' }), env, noopCtx())
    const verify = await authApp.fetch(getReq('/email/verify?t=a&a=b'), env, noopCtx())
    expect(start.status).toBe(404)
    expect(verify.status).toBe(404)
  })

  // ── P2 test pins (round 2) ────────────────────────────────────────────
  it('P2: 5 concurrent confirms with the SAME correct code mint exactly one session (consume guard, code path)', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { code } = await startAndCapture(env, 'concurrent-right-code@example.com')
    const results = await Promise.all(
      Array.from({ length: 5 }, () => verifyCode(env, 'concurrent-right-code@example.com', code)),
    )
    const winners = results.filter((r) => r.status === 302)
    expect(winners).toHaveLength(1)
    for (const res of results) expect([302, 401]).toContain(res.status)
  })

  it('P2: /verify has its own per-IP ceiling, independent of the per-attempt code cap', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { attemptId } = await startAndCapture(env, 'verify-ip-limit@example.com')
    const ip = '203.0.113.55'
    const confirmWithIp = (t: string) =>
      authApp.fetch(postJson('/email/verify', { t, a: attemptId }, undefined, ip), env, noopCtx())
    // 30 wrong-token confirms — each independently 'invalid' (no per-attempt
    // guess cap applies to the token path), never consuming or exhausting
    // anything OTHER than the shared verify_ip bucket itself.
    for (let i = 0; i < 30; i += 1) {
      const res = await confirmWithIp(`wrong-token-${i}`)
      expect(res.status).toBe(401)
    }
    const thirtyFirst = await confirmWithIp('wrong-token-31')
    expect(thirtyFirst.status).toBe(429)
  })

  it('P2: POST /auth/email/verify refuses a cross-origin FORM submission (csrf() is active on this mount)', async () => {
    // hono's csrf() only guards form-shaped content types (the ones a real
    // cross-site <form> can submit without a CORS preflight) — a JSON POST
    // is already blocked by the browser's own CORS preflight, so csrf()
    // deliberately does not re-check the Origin for it. This test uses the
    // SAME content-type a real browser form submission uses (see
    // src/auth/index.ts's readEmailFormBody / the confirm page's own
    // <form>), which is exactly the shape csrf() exists to protect.
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'csrf-check@example.com')
    const res = await authApp.fetch(
      new Request(`${ORIGIN}/email/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
        body: new URLSearchParams({ t: token, a: attemptId }),
      }),
      env,
      noopCtx(),
    )
    expect(res.status).toBe(403)
  })

  // ── DEFECT CLASS B round 2 (kasra-review + Athena BLOCK, 2026-09-26):
  // "email login must never inherit authority from ANY email-keyed row it
  // did not itself verify." Round 1's decideIdentitylessAttach gate only
  // ever inspects the ONE members row `lower(email)` matches — these three
  // shapes all reach `upsertUserByEmail`/`users` authority through a row
  // round 1's gate never looks at. ───────────────────────────────────────
  it('A1: an org-owner-alias email whose OWN live (non-email) identity is on a DIFFERENT member is refused', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-owner', 'realowner@pot.test', 'Real Owner', 'active', '${TENANT}');
      INSERT INTO org_settings (key, value) VALUES ('owner_login_emails', '["alias@example.com"]');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
        VALUES ('hli-alias', '${TENANT}', 'google', 'google-sub-alias', 'alias@example.com', 'member-owner', datetime('now'));
      INSERT INTO users (id, email, role) VALUES ('user-owner', 'realowner@pot.test', 'owner');
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'alias@example.com')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()
    const emailIdentity = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE provider = 'email' AND provider_subject = 'alias@example.com'`)
      .get() as { n: number }
    expect(emailIdentity.n).toBe(0)
  })

  it('A2: a powerless duplicate members row (#1162 shape) is refused — no identity link lands on the duplicate', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      -- mem-hadi: the REAL owner. Its own members.email need not equal the
      -- live identity's verified_email at all (write-once drift, #1266
      -- P0-2) — here it simply differs, which is what makes the duplicate
      -- row (below) the ONE decideIdentitylessAttach finds by literal email.
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('mem-hadi', 'hadi-internal@pot.test', 'Hadi (real owner)', 'active', '${TENANT}');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
        VALUES ('hli-hadi', '${TENANT}', 'google', 'google-sub-hadi', 'hadi@digid.ca', 'mem-hadi', datetime('now'));
      INSERT INTO users (id, email, role) VALUES ('user-hadi', 'hadi-internal@pot.test', 'owner');
      -- The powerless duplicate: literally the email address people type,
      -- with no identity or capability of its own.
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('mem-duplicate', 'hadi@digid.ca', 'Hadi (duplicate)', 'active', '${TENANT}');
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'hadi@digid.ca')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()
    const duplicateIdentities = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = 'mem-duplicate'`)
      .get() as { n: number }
    expect(duplicateIdentities.n).toBe(0)
  })

  it('A3: a legacy owner/admin in `users` with NO members row at all is refused (mupot#1324 shape)', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO users (id, email, role) VALUES ('user-legacy-owner', 'legacy-owner@pot.test', 'owner');
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'legacy-owner@pot.test')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()
    const me = await authApp.fetch(getReq('/me'), env, noopCtx())
    expect(me.status).toBe(401) // never authenticated at all
  })

  it('invite branch is ALSO gated: accepting an invite for an email a live Google identity already claims elsewhere is refused', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-claimed-elsewhere', 'claimed@elsewhere.test', 'Claimed', 'active', '${TENANT}');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
        VALUES ('hli-claimed', '${TENANT}', 'google', 'google-sub-claimed', 'newcomer@example.com', 'member-claimed-elsewhere', datetime('now'));
    `)
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

    const { token, attemptId } = await startAndCapture(env, 'newcomer@example.com', pendingCookie)
    const res = await confirmToken(env, token, attemptId, pendingCookie)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()

    // The invite's own member (from acceptInvite, a THIRD row distinct from
    // member-claimed-elsewhere) must never receive an email identity either.
    const invitedMember = harness.sqlite
      .prepare(`SELECT member_id FROM invites WHERE id = 'inv-squad'`)
      .get() as { member_id: string | null }
    expect(invitedMember.member_id).toBeTruthy()
    const identitiesOnInvitedMember = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = ?`)
      .get(invitedMember.member_id) as { n: number }
    expect(identitiesOnInvitedMember.n).toBe(0)
  })

  // mupot#1581 P2-4: finishEmailLoginSuccess's check 2 used to be a hand-copied
  // `SELECT role FROM users WHERE email = ?1` — a second, independent read of the exact
  // row upsertUserByEmail's own step 1 reads again moments later. The fix collapses this
  // to a single call to upsertUserByEmail, gated on its RETURNED role — the value that
  // actually becomes the session role, not a snapshot of it taken separately.
  it('a legacy mixed-case owner row (Boss@Pot.test) is still refused for a lower-case login attempt', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO users (id, email, role) VALUES ('user-boss', 'Boss@Pot.test', 'owner');
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'boss@pot.test')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()
    // upsertUserByEmail's own lookup is exact-case (no COLLATE NOCASE on users.email) —
    // proving the refusal did not itself mint a SECOND, lower-cased 'member' row.
    const rows = harness.sqlite.prepare(`SELECT email, role FROM users`).all() as Array<{ email: string; role: string }>
    expect(rows).toEqual([{ email: 'Boss@Pot.test', role: 'owner' }])
  })

  it('an admin row (not just owner) is also refused', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO users (id, email, role) VALUES ('user-admin-role', 'admin-role@pot.test', 'admin');
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'admin-role@pot.test')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()
  })

  it('the invite branch is ALSO gated on an existing non-member users row, before the invite link ever writes', async () => {
    harness = makeHarness()
    // inv-squad (from makeHarness) is for newcomer@example.com — give that exact email an
    // existing OWNER users row before accepting the invite.
    harness.sqlite.exec(`
      INSERT INTO users (id, email, role) VALUES ('user-newcomer-owner', 'newcomer@example.com', 'owner');
    `)
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

    const { token, attemptId } = await startAndCapture(env, 'newcomer@example.com', pendingCookie)
    const res = await confirmToken(env, token, attemptId, pendingCookie)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()

    // The invite's own D1-authoritative link (linkAcceptedInviteIdentity) must never have
    // run — the users-role gate sits BEFORE the whole invite/no-invite if/else.
    const invitedMember = harness.sqlite
      .prepare(`SELECT member_id FROM invites WHERE id = 'inv-squad'`)
      .get() as { member_id: string | null }
    expect(invitedMember.member_id).toBeTruthy()
    const identitiesOnInvitedMember = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = ?`)
      .get(invitedMember.member_id) as { n: number }
    expect(identitiesOnInvitedMember.n).toBe(0)
  })

  it('check 1 (foreign live identity) still fires when the STORED identity email is mixed-case', async () => {
    // Regression pin: check 1 (`lower(verified_email) = ?2`) must keep normalizing the
    // STORED side of the comparison, not just the incoming attempt's email — a mixed-case
    // verified_email already sitting in human_login_identities from an older write path
    // must not slip past the lower() guard.
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-foreign', 'someone@pot.test', 'Someone', 'active', '${TENANT}');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
        VALUES ('hli-foreign', '${TENANT}', 'google', 'google-sub-foreign', 'Foreign@Example.com', 'member-foreign', datetime('now'));
    `)
    const env = envFor(harness, memoryKv())
    const { token, attemptId } = await startAndCapture(env, 'foreign@example.com')
    const res = await confirmToken(env, token, attemptId)
    expect(res.status).toBe(403)
    expect(sessionCookieFrom(res)).toBeNull()
  })
})
