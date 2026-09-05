// #1330 F1 — Kasra-review BLOCK: a session that IS registered
// (record.webSessionRegistered === true) must still be rejected once its
// member is suspended, even when the tables loadWebSession depends on
// (web_sessions, human_login_identities) become unreadable. Before this fix,
// the members-status check at src/auth/index.ts was gated on
// `!record.webSessionRegistered`, on the assumption a registered session is
// always covered by loadWebSession's own member_status join. That assumption
// broke because loadWebSession collapses "table missing" to the SAME
// `reason: 'not_found'` as "session was never registered", and the caller
// treats 'not_found' as benign fall-through — so neither guard ran.
//
// Proven pre-fix: log in, suspend the member, DROP TABLE web_sessions,
// GET /auth/me → 200 as the stale role. This file pins the fix at the real
// authApp route boundary with the real D1/migration chain, per Kasra-review's
// exact repro (drop web_sessions, then drop human_login_identities too).
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

async function seedMember(env: Env, id: string, email: string, status = 'active') {
  await env.DB.prepare(
    `INSERT INTO members (id, tenant, email, display_name, status, created_at)
     VALUES (?1, ?2, ?3, ?3, ?4, datetime('now'))`,
  )
    .bind(id, TENANT, email, status)
    .run()
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = /mupot_session=([^;]+)/.exec(setCookie)
  if (!match) throw new Error('no session cookie in response')
  return match[1]
}

async function devLogin(env: Env): Promise<string> {
  const res = await authApp.request('/dev-login', {}, env)
  expect(res.status).toBe(302)
  return cookieFrom(res)
}

async function me(env: Env, cookie: string) {
  return authApp.request('/me', { headers: { cookie: `mupot_session=${cookie}` } }, env)
}

describe('registered web session + degraded schema — fails closed on suspension (#1330 F1)', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  afterEach(() => harness.close())

  it('DROP TABLE web_sessions after login+suspension → 401, not 200', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')

    const cookie = await devLogin(env)
    // Confirm the session really did register (webSessionRegistered === true path).
    const preRes = await me(env, cookie)
    expect(preRes.status).toBe(200)
    const preBody = (await preRes.json()) as Record<string, unknown>
    expect(typeof preBody.webSessionIdHash).toBe('string')

    await env.DB.prepare("UPDATE members SET status = 'suspended' WHERE id = 'm1'").run()
    harness.sqlite.exec('DROP TABLE web_sessions')

    const res = await me(env, cookie)
    expect(res.status).toBe(401)
  })

  it('DROP TABLE human_login_identities after login+suspension → 401, not 200', async () => {
    const env = makeEnv('owner2@x.test')
    env.DB = harness.db
    await seedMember(env, 'm2', 'owner2@x.test')

    const cookie = await devLogin(env)
    const preRes = await me(env, cookie)
    expect(preRes.status).toBe(200)

    await env.DB.prepare("UPDATE members SET status = 'suspended' WHERE id = 'm2'").run()
    harness.sqlite.exec('DROP TABLE human_login_identities')

    const res = await me(env, cookie)
    expect(res.status).toBe(401)
  })

  it('control: a registered session for a still-ACTIVE member survives the same table drop', async () => {
    const env = makeEnv('owner3@x.test')
    env.DB = harness.db
    await seedMember(env, 'm3', 'owner3@x.test')

    const cookie = await devLogin(env)
    expect((await me(env, cookie)).status).toBe(200)

    harness.sqlite.exec('DROP TABLE web_sessions')

    // Member is still active — must not be locked out just because the
    // registry table degraded (this is the "not_found = benign fall-through"
    // behaviour the PR is explicitly preserving for the unregistered/owner
    // case; only a REAL suspension must fail closed).
    expect((await me(env, cookie)).status).toBe(200)
  })
})
