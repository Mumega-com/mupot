// tests/dashboard-doorbells.test.ts — the human "Doorbells" dashboard page (src/dashboard/doorbells.ts): set / clear /
// test ping through the REAL dashboardApp, real web sessions and the real migration chain. The key is write-only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const ORIGIN = 'http://localhost'
const KEY = 'sender-key-SECRET-9876'
const URL_OK = 'https://hook.example/routine/abc?sig=should-not-leak'

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

let harness: SqliteD1Harness
let flag: string | undefined
const realFetch = globalThis.fetch
let fetched: Array<{ url: string; init: RequestInit }>

function makeEnv(email: string): Env {
  return {
    TENANT_SLUG: TENANT, BRAND: 'Test Pot', LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: email,
    SESSIONS: kv(), DB: harness.db, CONNECTOR_MASTER_KEY: 'c'.repeat(64), WEBHOOK_DOORBELL: flag,
  } as unknown as Env
}

async function login(email: string): Promise<{ env: Env; cookie: string }> {
  const env = makeEnv(email)
  const res = await authApp.request('/dev-login', {}, env)
  expect(res.status).toBe(302)
  const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  return { env, cookie: `mupot_session=${m[1]}` }
}

const setReauth = (memberId: string, at: string | null) =>
  harness.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ? WHERE member_id = ?').run(at, memberId)
const freshNow = () => new Date().toISOString()
const stale = () => new Date(Date.now() - 10 * 60 * 1000).toISOString()

function post(env: Env, cookie: string, path: string, body?: unknown, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' }
  if (origin) headers.origin = origin
  return dashboardApp.request(path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}
const SET = { agent_id: 'agent-A', webhook_url: URL_OK, bearer: KEY }
const stored = () => harness.sqlite.prepare('SELECT * FROM agent_webhook_doorbells').all() as Array<Record<string, unknown>>

beforeEach(() => {
  flag = '1'
  fetched = []
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    fetched.push({ url: String(u), init: init ?? {} })
    return new Response('ok', { status: 202 })
  }) as typeof fetch
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('S1', 'D1', 's1-sqd', 'Squad One'), ('S2', 'D1', 's2-sqd', 'Squad Two');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-A', 'S1', 'agent-a', 'Agent A', 'member', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin', 'admin@x.test', 'Org Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-s1', 's1@x.test', 'S1 Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-s1', 'mem-s1', 'squad', 'S1', 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-s2', 's2@x.test', 'S2 Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-s2', 'mem-s2', 'squad', 'S2', 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-plain', 'plain@x.test', 'Plain', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-plain', 'mem-plain', 'squad', 'S1', 'member');
  `)
})
afterEach(() => { globalThis.fetch = realFetch; harness.close() })

describe('Doorbells page', () => {
  it('redirects an unauthenticated caller to login', async () => {
    const res = await dashboardApp.request('/doorbells', {}, makeEnv('admin@x.test'))
    expect(res.status).toBe(302)
  })

  it('squad admin sees the form for their agent; the key is never rendered, only the last four', async () => {
    const { env, cookie } = await login('s1@x.test')
    setReauth('mem-s1', freshNow())
    expect((await post(env, cookie, '/doorbells/set', SET)).status).toBe(200)
    const body = await (await dashboardApp.request('/doorbells', { headers: { cookie } }, env)).text()
    expect(body).toContain('id="db-save"')
    expect(body).toContain('Agent A')
    expect(body).toContain('https://hook.example/routine/abc')
    expect(body).toContain('9876')
    expect(body).not.toContain('SECRET')
    expect(body).not.toContain('should-not-leak')
    expect(body).toContain('data-db-test=')
    expect(body).toContain('data-db-clear=')
  })

  it('a plain member has no form and no agent rows', async () => {
    const { env, cookie } = await login('plain@x.test')
    const body = await (await dashboardApp.request('/doorbells', { headers: { cookie } }, env)).text()
    expect(body).not.toContain('id="db-save"')
    expect(body).toContain('No agent you can manage')
  })

  it('flag off: says disabled, no form', async () => {
    flag = undefined
    const { env, cookie } = await login('admin@x.test')
    const body = await (await dashboardApp.request('/doorbells', { headers: { cookie } }, env)).text()
    expect(body).toContain('Doorbells are disabled')
    expect(body).not.toContain('id="db-save"')
  })
})

describe('POST /doorbells/set', () => {
  it('stores ciphertext (not the key) and returns the redacted view', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const res = await post(env, cookie, '/doorbells/set', SET)
    expect(res.status, await res.clone().text()).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('should-not-leak')
    const r = stored()
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ agent_id: 'agent-A', auth_last4: '9876', created_by_member_id: 'mem-admin' })
    expect(String(r[0].auth_ciphertext)).not.toContain('SECRET')
  })

  it('refuses a stale session: reauth_required, nothing stored', async () => {
    const { env, cookie } = await login('admin@x.test')
    for (const at of [stale(), null]) {
      setReauth('mem-admin', at)
      const res = await post(env, cookie, '/doorbells/set', SET)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'reauth_required' })
    }
    expect(stored()).toHaveLength(0)
  })

  it('refuses cross-origin and missing Origin', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    for (const origin of ['https://evil.example', null]) {
      expect((await post(env, cookie, '/doorbells/set', SET, origin)).status).toBe(403)
    }
    expect(stored()).toHaveLength(0)
  })

  it('refuses a plain member and an admin of ANOTHER squad', async () => {
    for (const [email, mid] of [['plain@x.test', 'mem-plain'], ['s2@x.test', 'mem-s2']] as const) {
      const { env, cookie } = await login(email)
      setReauth(mid, freshNow())
      const res = await post(env, cookie, '/doorbells/set', SET)
      expect(res.status, email).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden' })
    }
    expect(stored()).toHaveLength(0)
  })

  it('refuses private hosts and flag off', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const priv = await post(env, cookie, '/doorbells/set', { ...SET, webhook_url: 'https://169.254.169.254/x' })
    expect(priv.status).toBe(400)
    expect(await priv.json()).toMatchObject({ error: 'invalid_webhook_url' })
    const off = await post({ ...env, WEBHOOK_DOORBELL: undefined } as Env, cookie, '/doorbells/set', SET)
    expect(off.status).toBe(403)
    expect(await off.json()).toMatchObject({ error: 'webhook_doorbell_disabled' })
    expect(stored()).toHaveLength(0)
  })
})

describe('test ping and clear', () => {
  async function seeded() {
    const l = await login('s1@x.test')
    setReauth('mem-s1', freshNow())
    expect((await post(l.env, l.cookie, '/doorbells/set', SET)).status).toBe(200)
    return l
  }

  it('Send test ping POSTs mupot.doorbell.test with the bearer, shows the status, writes a receipt', async () => {
    const { env, cookie } = await seeded()
    setReauth('mem-s1', stale()) // test needs only a real session, not a fresh one
    const res = await post(env, cookie, '/doorbells/agent-A/test')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ agent_id: 'agent-A', outcome: 'posted', http_status: 202, message: expect.stringContaining('Delivered') })
    expect(fetched).toHaveLength(1)
    expect(JSON.parse(String(fetched[0].init.body))).toEqual({ type: 'mupot.doorbell.test', agent_id: 'agent-A' })
    expect((fetched[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(fetched[0].init.redirect).toBe('manual')
    expect(harness.sqlite.prepare('SELECT event_type, outcome, http_status, ref_id FROM agent_webhook_doorbell_receipts').all()).toEqual([
      { event_type: 'mupot.doorbell.test', outcome: 'posted', http_status: 202, ref_id: 'test' },
    ])
  })

  it('test ping is refused for another squad admin, a plain member and cross-origin, and sends nothing', async () => {
    await seeded()
    for (const [email, mid] of [['s2@x.test', 'mem-s2'], ['plain@x.test', 'mem-plain']] as const) {
      const l = await login(email)
      setReauth(mid, freshNow())
      expect((await post(l.env, l.cookie, '/doorbells/agent-A/test')).status).toBe(403)
    }
    const l = await login('s1@x.test')
    expect((await post(l.env, l.cookie, '/doorbells/agent-A/test', undefined, 'https://evil.example')).status).toBe(403)
    expect(fetched).toHaveLength(0)
  })

  it('test ping with no doorbell reports no_doorbell; failure status is shown, not hidden', async () => {
    const { env, cookie } = await login('admin@x.test')
    const none = await post(env, cookie, '/doorbells/agent-A/test')
    expect(await none.json()).toMatchObject({ outcome: 'no_doorbell' })
    setReauth('mem-admin', freshNow())
    await post(env, cookie, '/doorbells/set', SET)
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
    const bad = await post(env, cookie, '/doorbells/agent-A/test')
    expect(await bad.json()).toMatchObject({ agent_id: 'agent-A', outcome: 'failed', http_status: 500 })
  })

  it('clear removes the row with a real (even stale) session; another squad admin cannot', async () => {
    const { env, cookie } = await seeded()
    const other = await login('s2@x.test')
    expect((await post(other.env, other.cookie, '/doorbells/agent-A/clear')).status).toBe(403)
    expect(stored()).toHaveLength(1)
    setReauth('mem-s1', stale())
    expect((await post(env, cookie, '/doorbells/agent-A/clear')).status).toBe(200)
    expect(stored()).toHaveLength(0)
  })
})

describe('home (personal) squad agents are not manageable by an org admin', () => {
  beforeEach(() => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('S-home', 'D1', 'home-hadi', 'Hadi home', 'home');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-H', 'S-home', 'agent-h', 'Personal H', 'member', 'test', 'active');
    `)
  })

  it('set / clear / test by an org admin on a home-squad agent are all 403, nothing stored or sent', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const set = await post(env, cookie, '/doorbells/set', { ...SET, agent_id: 'agent-H' })
    expect(set.status).toBe(403)
    expect(await set.json()).toEqual({ error: 'forbidden' })
    harness.sqlite.prepare(
      "INSERT INTO agent_webhook_doorbells (tenant, agent_id, webhook_url, auth_ciphertext, auth_last4, created_by_member_id, updated_at) VALUES (?, 'agent-H', 'https://hook.example/h', 'x', '0000', 'someone', '2026-10-13T00:00:00.000Z')",
    ).run(TENANT)
    expect((await post(env, cookie, '/doorbells/agent-H/test')).status).toBe(403)
    expect((await post(env, cookie, '/doorbells/agent-H/clear')).status).toBe(403)
    expect(fetched).toHaveLength(0)
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM agent_webhook_doorbells WHERE agent_id = 'agent-H'").get()).toEqual({ n: 1 })
  })

  it('the page does not list the personal agent for an org admin', async () => {
    const { env, cookie } = await login('admin@x.test')
    const body = await (await dashboardApp.request('/doorbells', { headers: { cookie } }, env)).text()
    expect(body).toContain('Agent A')
    expect(body).not.toContain('Personal H')
  })
})

describe('messages, nudge, limits', () => {
  it('maps outcomes to plain language', async () => {
    const { doorbellMessage } = await import('../src/dashboard/doorbells')
    expect(doorbellMessage({ outcome: 'failed', http_status: 401 })).toContain('Grok rejected the key')
    expect(doorbellMessage({ outcome: 'failed', http_status: 403 })).toContain('Grok rejected the key')
    expect(doorbellMessage({ outcome: 'failed', http_status: 404 })).toContain('Copy it again from the routine panel')
    expect(doorbellMessage({ outcome: 'failed', http_status: 302 })).toContain('Paste the final URL')
    expect(doorbellMessage({ outcome: 'failed', reason: 'timeout' })).toBe('No answer within 3s.')
    expect(doorbellMessage({ outcome: 'posted', http_status: 200 })).toContain('Delivered')
  })

  it('after Save the page nudges to send a test ping', async () => {
    const { env, cookie } = await login('s1@x.test')
    const body = await (await dashboardApp.request('/doorbells?saved=agent-A', { headers: { cookie } }, env)).text()
    expect(body).toContain('Send test ping')
    expect(body).toContain('Saved. Now press')
  })

  it('a 404 from the routine URL is reported as such on the test ping', async () => {
    const { env, cookie } = await login('s1@x.test')
    setReauth('mem-s1', freshNow())
    await post(env, cookie, '/doorbells/set', SET)
    globalThis.fetch = (async () => new Response('x', { status: 404 })) as typeof fetch
    const res = await post(env, cookie, '/doorbells/agent-A/test')
    expect((await res.json() as { message: string }).message).toContain('URL not found')
  })

  it('test pings are limited to 5 per 10 minutes per agent; the 6th sends nothing', async () => {
    const { env, cookie } = await login('s1@x.test')
    setReauth('mem-s1', freshNow())
    await post(env, cookie, '/doorbells/set', SET)
    for (let i = 0; i < 5; i++) expect(await (await post(env, cookie, '/doorbells/agent-A/test')).json()).toMatchObject({ outcome: 'posted' })
    const sixth = await (await post(env, cookie, '/doorbells/agent-A/test')).json()
    expect(sixth).toMatchObject({ outcome: 'rate_limited' })
    expect(fetched).toHaveLength(5)
  })

  it('refuses a short key through the dashboard too', async () => {
    const { env, cookie } = await login('s1@x.test')
    setReauth('mem-s1', freshNow())
    const res = await post(env, cookie, '/doorbells/set', { ...SET, bearer: 'tooshort' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_bearer' })
  })
})
