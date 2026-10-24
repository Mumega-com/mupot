// Tests for the GitHub install store + connect-flow helpers (src/integrations/github-install.ts)
// and the /admin/github/connect + /connect/github/callback routes.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  installUrl,
  parseInstallCallback,
  storeInstallation,
  getInstallationId,
  verifyInstallationOwnership,
} from '../src/integrations/github-install'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'

describe('parseInstallCallback', () => {
  it('accepts a digit installation_id with setup_action=install', () => {
    const u = new URL('https://pot.test/connect/github/callback?installation_id=139955064&setup_action=install')
    expect(parseInstallCallback(u)).toEqual({ installationId: '139955064', setupAction: 'install' })
  })
  it('accepts setup_action=update', () => {
    const u = new URL('https://pot.test/cb?installation_id=5&setup_action=update')
    expect(parseInstallCallback(u)?.setupAction).toBe('update')
  })
  it('rejects a non-numeric installation_id', () => {
    const u = new URL('https://pot.test/cb?installation_id=abc&setup_action=install')
    expect(parseInstallCallback(u)).toBeNull()
  })
  it('rejects an unexpected setup_action', () => {
    const u = new URL('https://pot.test/cb?installation_id=5&setup_action=delete')
    expect(parseInstallCallback(u)).toBeNull()
  })
  it('rejects a missing installation_id', () => {
    expect(parseInstallCallback(new URL('https://pot.test/cb?setup_action=install'))).toBeNull()
  })
})

describe('installUrl', () => {
  it('builds the App install URL with the state param', () => {
    const url = installUrl('csrf-123')
    expect(url).toBe('https://github.com/apps/mupot/installations/new?state=csrf-123')
  })
})

describe('store / get installation', () => {
  function dbEnv() {
    const rows = new Map<string, { installation_id: string }>()
    const stmt = (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes('INSERT')) rows.set(String(args[0]), { installation_id: String(args[1]) })
          if (sql.includes('DELETE')) rows.delete(String(args[0]))
          return { meta: { changes: 1 } }
        },
        first: async () => rows.get(String(args[0])) ?? null,
      }),
    })
    return { TENANT_SLUG: 'storepot', DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env
  }

  it('stores then reads back the installation id', async () => {
    const env = dbEnv()
    expect(await getInstallationId(env)).toBeNull()
    await storeInstallation(env, '999', 'Mumega-com')
    expect(await getInstallationId(env)).toBe('999')
  })
})

// ── connect routes ─────────────────────────────────────────────────────────────────

function connectEnv(role: 'admin' | 'member' = 'admin') {
  const kv = new Map<string, string>()
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const rows = () =>
    harness.sqlite.prepare('SELECT tenant, installation_id, account_login FROM github_installations').all() as Array<{
      tenant: string
      installation_id: string
      account_login: string | null
    }>
  return {
    rows,
    sqlite: harness.sqlite,
    env: {
      TENANT_SLUG: 't',
      BRAND: 'Test',
      GITHUB_APP_CLIENT_ID: 'cid',
      GITHUB_APP_CLIENT_SECRET: 'csecret',
      DB: harness.db,
      SESSIONS: {
        get: vi.fn(async (k: string) =>
          k.startsWith('ghstate:')
            ? (kv.get(k) ?? null)
            : JSON.stringify({ userId: 'u1', email: 'a@b.com', role, createdAt: '2026-01-01T00:00:00Z' }),
        ),
        put: vi.fn(async (k: string, v: string) => void kv.set(k, v)),
        delete: vi.fn(async (k: string) => void kv.delete(k)),
      },
      OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    } as unknown as Env,
    kv,
  }
}

function getReq(path: string): Request {
  return new Request(`https://pot.test${path}`, { headers: { Cookie: 'mupot_session=sess1' } })
}

describe('GET /admin/github/connect', () => {
  it('non-admin → 403', async () => {
    const { env } = connectEnv('member')
    const res = await dashboardApp.fetch(getReq('/admin/github/connect'), env)
    expect(res.status).toBe(403)
  })
  it('admin → 302 redirect to the App install URL, state stored', async () => {
    const { env, kv, rows } = connectEnv('admin')
    const res = await dashboardApp.fetch(getReq('/admin/github/connect'), env)
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toContain('https://github.com/apps/mupot/installations/new?state=')
    expect([...kv.keys()].some((k) => k.startsWith('ghstate:'))).toBe(true)
  })
})

describe('GET /connect/github/callback', () => {
  it('rejects an unknown/forged state (CSRF) → 400', async () => {
    const { env } = connectEnv('admin')
    const res = await dashboardApp.fetch(
      getReq('/connect/github/callback?installation_id=5&setup_action=install&state=forged'),
      env,
    )
    expect(res.status).toBe(400)
  })

  afterEach(() => vi.unstubAllGlobals())

  interface GhOpts {
    exchangeOk?: boolean
    exchangeBody?: unknown
    lookupOk?: boolean
    lookupThrows?: boolean
    lookupRaw?: string
    userId?: number
    membership?: { status: number; role?: string; state?: string }
    revokeThrows?: boolean
  }
  function ghFetch(installs: Array<{ id: number; account?: { login: string; type?: string; id?: number } }>, opts: GhOpts = {}) {
    const calls: string[] = []
    const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input)
      calls.push(`${init?.method ?? 'GET'} ${u}`)
      if (u.includes('/login/oauth/access_token')) {
        const body = JSON.parse(String(init?.body)) as { code?: string; client_id?: string; client_secret?: string }
        if (body.code !== 'abc' || body.client_id !== 'cid' || body.client_secret !== 'csecret') {
          return new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 })
        }
        if (opts.exchangeBody !== undefined) return new Response(JSON.stringify(opts.exchangeBody), { status: 200 })
        return opts.exchangeOk === false
          ? new Response(JSON.stringify({ access_token: 'utok' }), { status: 500 })
          : new Response(JSON.stringify({ access_token: 'utok' }), { status: 200 })
      }
      if (u.includes('/applications/') && init?.method === 'DELETE') {
        if (opts.revokeThrows) throw new Error('boom')
        return new Response(null, { status: 204 })
      }
      if (u.endsWith('/user')) return new Response(JSON.stringify({ id: opts.userId ?? 42 }), { status: 200 })
      if (u.includes('/user/memberships/orgs/')) {
        const m = opts.membership ?? { status: 200, role: 'admin', state: 'active' }
        return new Response(JSON.stringify({ role: m.role, state: m.state }), { status: m.status })
      }
      if (u.includes('/user/installations')) {
        if (opts.lookupThrows) throw new Error('network')
        if (opts.lookupRaw !== undefined) return new Response(opts.lookupRaw, { status: 200 })
        return opts.lookupOk === false
          ? new Response(JSON.stringify({ installations: installs }), { status: 502 })
          : new Response(JSON.stringify({ installations: installs }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    return Object.assign(f, { calls })
  }
  const ORG = { id: 139955064, account: { login: 'real-org', type: 'Organization', id: 9 } }
  const USER = { id: 139955064, account: { login: 'real-user', type: 'User', id: 42 } }
  const CB = '/connect/github/callback?installation_id=139955064&setup_action=install&state=good&code=abc'

  it('valid state + owned install → stores id (login from GitHub), redirects to status', async () => {
    const { env, kv, rows, sqlite } = connectEnv('admin')
    kv.set('ghstate:good', 't') // pre-seed a tenant-bound state
    const f = ghFetch([ORG])
    vi.stubGlobal('fetch', f)
    const res = await dashboardApp.fetch(getReq(CB + '&account_login=spoofed'), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin/github/status')
    expect(kv.has('ghstate:good')).toBe(false) // single-use: consumed
    // stored row: this tenant, this id, GitHub's login (not the spoofed query param)
    expect(rows()).toEqual([{ tenant: 't', installation_id: '139955064', account_login: 'real-org' }])
    expect(f.calls.some((c) => c.startsWith('DELETE ') && c.includes('/applications/cid/token'))).toBe(true) // revoked
  })

  it('installation_id the user does not have → 403, no row written', async () => {
    const { env, kv, rows, sqlite } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    vi.stubGlobal('fetch', ghFetch([{ id: 777 }]))
    const res = await dashboardApp.fetch(getReq(CB), env)
    expect(res.status).toBe(403)
    expect(rows()).toEqual([])
  })

  it('missing code → refused, no row written', async () => {
    const { env, kv, rows, sqlite } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    vi.stubGlobal('fetch', ghFetch([ORG]))
    const res = await dashboardApp.fetch(getReq(CB.replace('&code=abc', '')), env)
    expect(res.status).toBe(400)
    expect(rows()).toEqual([])
  })

  it('app credentials not configured → refused (fail closed), no row written', async () => {
    const { env, kv, rows, sqlite } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    delete (env as { GITHUB_APP_CLIENT_SECRET?: string }).GITHUB_APP_CLIENT_SECRET
    vi.stubGlobal('fetch', ghFetch([ORG]))
    const res = await dashboardApp.fetch(getReq(CB), env)
    expect(res.status).toBe(400)
    expect(rows()).toEqual([])
  })

  it('GitHub API error on exchange or lookup → refused, no row written', async () => {
    for (const o of [{ exchangeOk: false }, { lookupOk: false }]) {
      const { env, kv, rows, sqlite } = connectEnv('admin')
      kv.set('ghstate:good', 't')
      vi.stubGlobal('fetch', ghFetch([ORG], o))
      const res = await dashboardApp.fetch(getReq(CB), env)
      expect(res.status).toBe(400)
      expect(rows()).toEqual([])
    }
  })

  it('state minted for another tenant, or replayed → refused, no row written', async () => {
    const { env, kv, rows, sqlite } = connectEnv('admin')
    kv.set('ghstate:good', 'other-tenant')
    vi.stubGlobal('fetch', ghFetch([ORG]))
    expect((await dashboardApp.fetch(getReq(CB), env)).status).toBe(400)
    kv.set('ghstate:good', 't')
    expect((await dashboardApp.fetch(getReq(CB), env)).status).toBe(302)
    expect((await dashboardApp.fetch(getReq(CB), env)).status).toBe(400) // replay
    expect(rows().length).toBe(1)
  })

  it('account.type=User must match GET /user id; org needs admin+active', async () => {
    const cases: Array<[string, Parameters<typeof ghFetch>, number]> = [
      ['user owner ok', [[USER]], 302],
      ['user other (mere reader)', [[USER], { userId: 7 }], 403],
      ['org admin ok', [[ORG]], 302],
      ['org member only', [[ORG], { membership: { status: 200, role: 'member', state: 'active' } }], 403],
      ['org admin pending', [[ORG], { membership: { status: 200, role: 'admin', state: 'pending' } }], 403],
      ['org 403 unverifiable', [[ORG], { membership: { status: 403 } }], 400],
      ['org 404 unverifiable', [[ORG], { membership: { status: 404 } }], 400],
      ['org 500', [[ORG], { membership: { status: 500 } }], 400],
      ['unknown account type', [[{ id: 139955064, account: { login: 'x', type: 'Bot', id: 1 } }]], 400],
      ['missing account', [[{ id: 139955064 }]], 400],
    ]
    for (const [name, args, status] of cases) {
      const { env, kv, rows, sqlite } = connectEnv('admin')
      kv.set('ghstate:good', 't')
      vi.stubGlobal('fetch', ghFetch(...args))
      const res = await dashboardApp.fetch(getReq(CB), env)
      expect(res.status, name).toBe(status)
      expect(rows().length, name).toBe(status === 302 ? 1 : 0)
    }
  })

  it('setup_action=update: no code on the already-bound id is a no-op; other ids refused', async () => {
    const { env, kv, rows, sqlite } = connectEnv('admin')
    sqlite.exec("INSERT INTO github_installations (tenant, installation_id, account_login, installed_at, updated_at) VALUES ('t','139955064','real-org','x','x')")
    kv.set('ghstate:good', 't')
    vi.stubGlobal('fetch', ghFetch([ORG]))
    const same = await dashboardApp.fetch(getReq('/connect/github/callback?installation_id=139955064&setup_action=update&state=good'), env)
    expect(same.status).toBe(302)
    expect(rows().length).toBe(1)
    kv.set('ghstate:good', 't')
    const other = await dashboardApp.fetch(getReq('/connect/github/callback?installation_id=555&setup_action=update&state=good'), env)
    expect(other.status).toBe(400)
    expect(rows()).toEqual([{ tenant: 't', installation_id: '139955064', account_login: 'real-org' }])
  })

  it('UNIQUE violation on store → 409, no crash', async () => {
    const { env, kv, rows, sqlite } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    sqlite.exec("INSERT INTO github_installations (tenant, installation_id, account_login, installed_at, updated_at) VALUES ('other','139955064','y','x','x')")
    vi.stubGlobal('fetch', ghFetch([ORG]))
    expect((await dashboardApp.fetch(getReq(CB), env)).status).toBe(409)
    expect(rows().map((r) => r.tenant)).toEqual(['other']) // victim's binding untouched
  })

  it('revocation failure does not block the bind', async () => {
    const { env, kv, rows, sqlite } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    vi.stubGlobal('fetch', ghFetch([ORG], { revokeThrows: true }))
    expect((await dashboardApp.fetch(getReq(CB), env)).status).toBe(302)
    expect(rows().length).toBe(1)
  })

  it('valid state but bad install params → 400', async () => {
    const { env, kv, rows } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    const res = await dashboardApp.fetch(
      getReq('/connect/github/callback?installation_id=notnum&setup_action=install&state=good'),
      env,
    )
    expect(res.status).toBe(400)
  })
})

describe('verifyInstallationOwnership reasons', () => {
  const env = { GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_CLIENT_SECRET: 'csecret' } as unknown as Env
  const mk = (lookup: () => Response | Promise<Response>, exchange?: () => Response) =>
    vi.fn(async (input: string | URL | Request) => {
      const u = String(input)
      if (u.includes('access_token')) return exchange ? exchange() : new Response(JSON.stringify({ access_token: 't' }))
      if (u.includes('/applications/')) return new Response(null, { status: 204 })
      return lookup()
    }) as unknown as typeof fetch
  it('lookup throws → lookup_failed', async () => {
    const r = await verifyInstallationOwnership(env, 'c', '5', { fetchImpl: mk(() => { throw new Error('timeout') }) })
    expect(r).toEqual({ ok: false, reason: 'lookup_failed' })
  })
  it('lookup bad JSON → lookup_failed', async () => {
    const r = await verifyInstallationOwnership(env, 'c', '5', { fetchImpl: mk(() => new Response('not json{')) })
    expect(r).toEqual({ ok: false, reason: 'lookup_failed' })
  })
  it('lookup wrong shape → lookup_failed', async () => {
    const r = await verifyInstallationOwnership(env, 'c', '5', { fetchImpl: mk(() => new Response('{"x":1}')) })
    expect(r).toEqual({ ok: false, reason: 'lookup_failed' })
  })
  it('exchange 200 + error body → bad_verification_code', async () => {
    const r = await verifyInstallationOwnership(env, 'c', '5', {
      fetchImpl: mk(() => new Response('{}'), () => new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 })),
    })
    expect(r).toEqual({ ok: false, reason: 'bad_verification_code' })
  })
  it('exchange throws → exchange_failed', async () => {
    const r = await verifyInstallationOwnership(env, 'c', '5', { fetchImpl: mk(() => new Response('{}'), () => { throw new Error('x') }) })
    expect(r).toEqual({ ok: false, reason: 'exchange_failed' })
  })
})

describe('verifyInstallationOwnership config/code/status guards', () => {
  const cfg = { GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_CLIENT_SECRET: 'csecret' } as unknown as Env
  const never = () => vi.fn(async () => new Response('{}')) as unknown as typeof fetch
  it('unconfigured → not_configured, no network', async () => {
    const f = never()
    expect(await verifyInstallationOwnership({} as Env, 'c', '5', { fetchImpl: f })).toEqual({ ok: false, reason: 'not_configured' })
    expect(await verifyInstallationOwnership({ GITHUB_APP_CLIENT_ID: 'x' } as unknown as Env, 'c', '5', { fetchImpl: f })).toEqual({ ok: false, reason: 'not_configured' })
    expect(f).not.toHaveBeenCalled()
  })
  it('no code → missing_code, no network', async () => {
    const f = never()
    expect(await verifyInstallationOwnership(cfg, null, '5', { fetchImpl: f })).toEqual({ ok: false, reason: 'missing_code' })
    expect(f).not.toHaveBeenCalled()
  })
  it('exchange HTTP 500 with a valid-looking token body → exchange_failed', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: 't' }), { status: 500 })) as unknown as typeof fetch
    expect(await verifyInstallationOwnership(cfg, 'c', '5', { fetchImpl: f })).toEqual({ ok: false, reason: 'exchange_failed' })
  })
  it('lookup HTTP 502 with a matching installation body → lookup_failed', async () => {
    const f = vi.fn(async (i: string | URL | Request) =>
      String(i).includes('access_token')
        ? new Response(JSON.stringify({ access_token: 't' }))
        : String(i).includes('/applications/') ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ installations: [{ id: 5, account: { login: 'x', type: 'Organization', id: 1 } }] }), { status: 502 })) as unknown as typeof fetch
    expect(await verifyInstallationOwnership(cfg, 'c', '5', { fetchImpl: f })).toEqual({ ok: false, reason: 'lookup_failed' })
  })
})

describe('verifyInstallationOwnership strict guards', () => {
  const env = { GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_CLIENT_SECRET: 'csecret' } as unknown as Env
  const org = (id: number) => ({ id, account: { login: 'x', type: 'Organization', id: 1 } })
  function fake(o: { pages?: number; target?: number; exchange?: unknown; throwOn?: string; seen?: string[] }) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input)
      const h = new Headers(init?.headers)
      if (o.throwOn && u.includes(o.throwOn)) throw new Error('boom')
      if (u.includes('access_token')) {
        const body = JSON.parse(String(init?.body)) as { code?: string }
        expect(body.code).toBe('thecode')
        return new Response(JSON.stringify('exchange' in o ? o.exchange : { access_token: 'tok' }))
      }
      if (u.includes('/applications/')) {
        expect(h.get('authorization')).toBe(`Basic ${btoa('cid:csecret')}`)
        return new Response(null, { status: 204 })
      }
      // every user-token API call must carry the bearer token
      expect(h.get('authorization')).toBe('Bearer tok')
      o.seen?.push(u)
      if (u.includes('/user/memberships/')) return new Response(JSON.stringify({ role: 'admin', state: 'active' }))
      if (u.endsWith('/user')) return new Response(JSON.stringify({ id: 1 }))
      const page = Number(new URL(u).searchParams.get('page'))
      const pages = o.pages ?? 1
      const list = Array.from({ length: 100 }, (_, k) => org(page * 1000 + k))
      if (page === pages && o.target !== undefined) list[0] = org(o.target)
      return new Response(JSON.stringify({ installations: list }))
    }) as unknown as typeof fetch
  }
  const run = (f: typeof fetch, id = '5') => verifyInstallationOwnership(env, 'thecode', id, { fetchImpl: f })

  it('page cap: an id beyond page 10 is not found; one on page 10 is', async () => {
    const seen: string[] = []
    expect(await run(fake({ pages: 11, target: 5, seen }))).toEqual({ ok: false, reason: 'not_owned' })
    expect(seen.filter((u) => u.includes('/user/installations')).length).toBe(10)
    expect(await run(fake({ pages: 10, target: 5 }))).toEqual({ ok: true, accountLogin: 'x' })
  })
  it.each([[{}], [{ access_token: 123 }], [{ access_token: '' }], [null], ['str']])('bad exchange body %j → exchange_failed', async (body) => {
    expect(await run(fake({ exchange: body }))).toEqual({ ok: false, reason: 'exchange_failed' })
  })
  it.each([['/user/installations'], ['/user/memberships/']])('thrown fetch at %s → refused', async (where) => {
    const f = fake({ pages: 1, target: 5, throwOn: where })
    const r = await run(f)
    expect(r).toEqual({ ok: false, reason: 'lookup_failed' })
  })
  it('thrown /user for a User account → lookup_failed', async () => {
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = String(input)
      if (u.includes('access_token')) return new Response(JSON.stringify({ access_token: 'tok' }))
      if (u.includes('/applications/')) return new Response(null, { status: 204 })
      if (u.endsWith('/user')) throw new Error('boom')
      return new Response(JSON.stringify({ installations: [{ id: 5, account: { login: 'u', type: 'User', id: 1 } }] }))
    }) as unknown as typeof fetch
    expect(await run(f)).toEqual({ ok: false, reason: 'lookup_failed' })
  })
})

describe('verifyInstallationOwnership pagination', () => {
  const env = { GITHUB_APP_CLIENT_ID: 'c', GITHUB_APP_CLIENT_SECRET: 's' } as unknown as Env
  it('finds the id on a later page (org admin)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1000 }))
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = String(input)
      if (u.includes('access_token')) return new Response(JSON.stringify({ access_token: 't' }))
      if (u.includes('/applications/')) return new Response(null, { status: 204 })
      if (u.includes('/user/memberships/orgs/x')) return new Response(JSON.stringify({ role: 'admin', state: 'active' }))
      return new Response(JSON.stringify({ installations: u.includes('page=2') ? [{ id: 5, account: { login: 'x', type: 'Organization', id: 1 } }] : page1 }))
    }) as unknown as typeof fetch
    expect(await verifyInstallationOwnership(env, 'c', '5', { fetchImpl: f })).toEqual({ ok: true, accountLogin: 'x' })
  })
})
