// #1330 F3 — Kasra-review P2: src/auth/index.ts uses
// `typeof member?.status === 'string' && member.status !== 'active'`, so a
// MISSING member row (no match on email) ALLOWS the session through, rather
// than being treated as "non-active or missing" as the PR's stated intent
// once implied. DECISION (explicit, per Kasra-review's request): this is
// deliberate. Owner/admin dashboard logins routinely have no members row at
// all (#1324 — the bootstrap owner has none), and members is only ever an
// ADDITIVE grants bridge for role='member' — it must never become a second,
// accidental gate on legacy owner/admin logins that never had a members row
// to begin with. So: missing row → allow (status quo preserved); a REAL
// non-active row → deny. This test pins that decision so it cannot silently
// flip in either direction without a red test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

function makeEnv(email: string): Env {
  return {
    TENANT_SLUG: TENANT,
    LOCAL_TEST_AUTH: '1',
    LOCAL_TEST_AUTH_EMAIL: email,
    SESSIONS: kv(),
  } as unknown as Env
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = /mupot_session=([^;]+)/.exec(setCookie)
  if (!match) throw new Error('no session cookie in response')
  return match[1]
}

describe('missing members row does not lock out a session (#1330 F3, explicit decision)', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  afterEach(() => harness.close())

  it('a bootstrap owner login with NO members row is allowed (missing != suspended)', async () => {
    const env = makeEnv('bootstrap-owner@x.test')
    env.DB = harness.db
    // Deliberately no members row for this email at all.

    const loginRes = await authApp.request('/dev-login', {}, env)
    expect(loginRes.status).toBe(302)
    const cookie = cookieFrom(loginRes)

    const res = await authApp.request(
      '/me',
      { headers: { cookie: `mupot_session=${cookie}` } },
      env,
    )
    expect(res.status).toBe(200)
  })

  it('control: a REAL suspended members row for the same email still denies', async () => {
    const env = makeEnv('suspended-owner@x.test')
    env.DB = harness.db
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('m-suspended', ?1, ?2, ?2, 'suspended', datetime('now'))`,
    ).bind(TENANT, 'suspended-owner@x.test').run()

    const loginRes = await authApp.request('/dev-login', {}, env)
    expect(loginRes.status).toBe(302)
    const cookie = cookieFrom(loginRes)

    const res = await authApp.request(
      '/me',
      { headers: { cookie: `mupot_session=${cookie}` } },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('a REAL suspended members row with tenant IS NULL (legacy, unbackfilled) still denies (#1330 F-A)', async () => {
    // F3's "missing row allows" absorbed this shape silently: the status
    // check bound `AND tenant = ?2`, which never matches a NULL column, so a
    // suspended legacy row with tenant IS NULL looked exactly like "no row at
    // all" and was allowed through — a fail-open on the very defect #1318
    // exists to close. This pins that a tenant=NULL row is treated as a REAL
    // row (denied), not as absence (allowed).
    const env = makeEnv('suspended-legacy@x.test')
    env.DB = harness.db
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('m-suspended-legacy', NULL, ?1, ?1, 'suspended', datetime('now'))`,
    ).bind('suspended-legacy@x.test').run()

    const loginRes = await authApp.request('/dev-login', {}, env)
    expect(loginRes.status).toBe(302)
    const cookie = cookieFrom(loginRes)

    const res = await authApp.request(
      '/me',
      { headers: { cookie: `mupot_session=${cookie}` } },
      env,
    )
    expect(res.status).toBe(401)
  })
})
