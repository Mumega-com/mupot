// mupot#1457 — login-first accept through the REAL cookie/web-session path
// (no mocked peekSessionAuth). The session is minted by authApp /dev-login
// (the same mintSession/registerWebSession code /callback uses). dev-login
// is a 'local-test' identity — correctly NOT proof of an email — so the proof
// is a separate verified 'google' identity linked to the same member.
//
// dev-login's first-ever user gets legacy role 'owner', for whom auth.memberId
// is deliberately never populated (only webSessionMemberId is) — so this also
// pins that the door reads webSessionMemberId, not memberId.

import { afterEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { inviteApp } from '../src/dashboard/invite'
import { linkLoginIdentity } from '../src/auth/login-identity'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const ORIGIN = 'https://pot.test'

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  }
}

async function setup(googleProof: boolean) {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Eng');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin', 'member-admin', 'department', 'dept-a', 'admin');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-ceo', 'ceo@corp.test', 'Cee', 'active', '${TENANT}');
    INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES ('inv-ceo', 'ceo@corp.test', 'dept-a', 'member', 'member-admin');
  `)
  const env = {
    DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN,
    LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: 'ceo@corp.test', SESSIONS: kv(),
  } as unknown as Env
  const base = { tenant: TENANT, memberId: 'member-ceo', verifiedEmail: 'ceo@corp.test' }
  expect((await linkLoginIdentity(env, { ...base, provider: 'local-test', providerSubject: 'ceo@corp.test' })).ok).toBe(true)
  if (googleProof) {
    expect((await linkLoginIdentity(env, { ...base, provider: 'google', providerSubject: 'sub-ceo' })).ok).toBe(true)
  }
  const login = await authApp.request('/dev-login', {}, env)
  expect(login.status).toBe(302)
  const cookie = /mupot_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]
  if (!cookie) throw new Error('no session cookie')
  return { h, env, cookie }
}

function post(env: Env, cookie: string | null) {
  return inviteApp.request(`${ORIGIN}/inv-ceo`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      ...(cookie ? { cookie: `mupot_session=${cookie}` } : {}),
    },
    body: new URLSearchParams({ display_name: 'Cee' }).toString(),
  }, env)
}

const deptGrants = (h: SqliteD1Harness) =>
  h.sqlite.prepare(`SELECT capability FROM capabilities WHERE member_id = 'member-ceo' AND scope_type = 'department'`).all()

describe('#1457 login-first accept through a real cookie session', () => {
  let h: SqliteD1Harness | undefined
  afterEach(() => { h?.close(); h = undefined })

  it('real session + verified google identity: grant lands on the existing row', async () => {
    const s = await setup(true); h = s.h
    const me = await authApp.request('/me', { headers: { cookie: `mupot_session=${s.cookie}` } }, s.env)
    const profile = (await me.json()) as { webSessionMemberId?: string; memberId?: string }
    expect(profile.webSessionMemberId).toBe('member-ceo')
    const res = await post(s.env, s.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(deptGrants(h)).toEqual([{ capability: 'member' }])
  })

  it('real session whose only identity is local-test (unverified provider): refused, nothing granted', async () => {
    const s = await setup(false); h = s.h
    const res = await post(s.env, s.cookie)
    expect(res.status).toBe(409)
    expect(deptGrants(h)).toEqual([])
  })

  it('no cookie: refused', async () => {
    const s = await setup(true); h = s.h
    expect((await post(s.env, null)).status).toBe(409)
    expect(deptGrants(h)).toEqual([])
  })
})
