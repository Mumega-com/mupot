// tests/auth-dev-login.test.ts — /auth/dev-login (local-only smoke-test session mint).
//
// mupot#1583 round 2 (Athena BLOCK): the previous version of this file drove authApp
// against a HAND-ROLLED D1 mock whose `prepare()` had no `.all()` implementation at all.
// registerWebSession (src/auth/index.ts) calls resolveHumanMemberId, which reaches
// decideIdentitylessAttach's `.all<CandidateRow>()` call — that threw
// "TypeError: ... .all is not a function" on every run, logged via
// `console.error('registerWebSession failed (login still succeeded via KV session)', err)`
// (registerWebSession is deliberately best-effort — a D1 registry failure must never fail
// the login itself, see its own doc comment). Both tests still passed, because the
// assertions only ever checked the KV session + cookie, which mintSession writes
// regardless of whether the D1 registration succeeded. The mock's gap was invisible
// because production's own resilience design papered over it.
//
// Fixed by driving the REAL SQLite schema (createSqliteD1 + applyAllMigrations, the one
// sanctioned way — see tests/helpers/migrations.ts) instead of widening the mock, and by
// asserting the registration path's OWN write (a `web_sessions` row) actually landed, not
// just that the KV/cookie session did.

import { afterEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const LOCAL_OWNER_EMAIL = 'local-owner@mupot.test'

interface KvStore {
  get: (key: string) => Promise<string | null>
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>
  delete: (key: string) => Promise<void>
  store: Map<string, string>
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
  return harness
}

// The identity-less bootstrap row registerWebSession's guarded attach requires: a CLEAN
// members row (no live identity, no unbound bearer, no Telegram bind) matching the login
// email — decideIdentitylessAttach only ever ATTACHES to an existing row, it never mints
// one. Without this, /dev-login's very first login on a virgin pot legitimately gets
// `registered: false` (decideIdentitylessAttach: not_found) — that is correct behavior,
// not a gap this test needs to paper over, but it means a fixture that wants to see the
// registration path SUCCEED must seed this row first, the same way
// tests/email-login.test.ts's own "attaches to a pre-existing clean row" tests do.
function seedCleanMemberRow(harness: SqliteD1Harness, email: string): void {
  harness.sqlite.exec(`
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('mem-local-owner', '${email}', 'Local Owner', 'active', '${TENANT}');
  `)
}

function envFor(harness: SqliteD1Harness, kv: KvStore, overrides: Partial<Env> = {}): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    SESSIONS: kv,
    LOCAL_TEST_AUTH: '1',
    LOCAL_TEST_AUTH_EMAIL: LOCAL_OWNER_EMAIL,
    ...overrides,
  } as unknown as Env
}

describe('/auth/dev-login', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('is disabled unless LOCAL_TEST_AUTH=1', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv(), { LOCAL_TEST_AUTH: undefined })
    const res = await authApp.request('/dev-login', {}, env)
    expect(res.status).toBe(404)
  })

  it('mints a local owner session with a non-Secure localhost cookie, and the guarded web-session registration actually runs', async () => {
    harness = makeHarness()
    seedCleanMemberRow(harness, LOCAL_OWNER_EMAIL)
    const kv = memoryKv()
    const env = envFor(harness, kv)

    const res = await authApp.request('/dev-login', {}, env)

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('mupot_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).not.toContain('Secure')
    expect(kv.store.size).toBeGreaterThanOrEqual(2) // session + presence marker

    const user = harness.sqlite
      .prepare(`SELECT email, role FROM users LIMIT 1`)
      .get() as { email: string; role: string } | undefined
    expect(user).toMatchObject({ email: LOCAL_OWNER_EMAIL, role: 'owner' })

    // The guarded registration path (registerWebSession -> resolveHumanMemberId ->
    // decideIdentitylessAttach -> linkLoginIdentity -> createWebSession) actually ran end
    // to end: a real `web_sessions` row and a `human_login_identities` row exist, bound to
    // the seeded member — not just the KV/cookie session mintSession always writes
    // regardless of whether D1 registration succeeded.
    const webSession = harness.sqlite
      .prepare(`SELECT member_id FROM web_sessions LIMIT 1`)
      .get() as { member_id: string } | undefined
    expect(webSession?.member_id).toBe('mem-local-owner')

    const identity = harness.sqlite
      .prepare(`SELECT provider, provider_subject, member_id FROM human_login_identities LIMIT 1`)
      .get() as { provider: string; provider_subject: string; member_id: string } | undefined
    expect(identity).toMatchObject({
      provider: 'local-test',
      provider_subject: LOCAL_OWNER_EMAIL,
      member_id: 'mem-local-owner',
    })
  })

  it('still mints the KV/cookie session even when no members row exists to attach to (registration best-effort, never blocks login)', async () => {
    // No seedCleanMemberRow here — decideIdentitylessAttach correctly reports `not_found`
    // (nothing to attach to), registerWebSession returns `{ registered: false }`, and the
    // login must still succeed via the KV/cookie session alone, exactly like today's
    // documented "best-effort" contract.
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)

    const res = await authApp.request('/dev-login', {}, env)

    expect(res.status).toBe(302)
    expect(kv.store.size).toBeGreaterThanOrEqual(2)
    const webSessionCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM web_sessions`)
      .get() as { n: number }
    expect(webSessionCount.n).toBe(0)
  })

  // mupot#1299 pins this here, next to the code that sets the cookie.
  //
  // The WFP dispatch branch forwards the incoming request to a tenant's User Worker with
  // its headers intact, INCLUDING Cookie. That is only safe because this cookie is
  // host-only: with no `Domain=` attribute a browser sends it to mupot.mumega.com and
  // nowhere else, so it never reaches `<tenant>.mupot.mumega.com`. Adding `Domain=` here
  // to "share the session across subdomains" would hand every tenant Worker in the
  // dispatch namespace a valid colony session cookie, and the dispatcher comment claiming
  // stripping is unnecessary would silently become false.
  //
  // If this test fails, do NOT relax it — go re-read src/dispatcher.ts and strip
  // credentials on the dispatch branch first.
  it('scopes the session cookie to the host — no Domain= (guards the dispatch branch)', async () => {
    harness = makeHarness()
    const env = envFor(harness, memoryKv())
    const res = await authApp.request('/dev-login', {}, env)
    const setCookie = res.headers.get('set-cookie') ?? ''

    expect(setCookie).toContain('mupot_session=')
    expect(setCookie.toLowerCase()).not.toContain('domain=')
  })
})
