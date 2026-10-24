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
  const stmt = {
    bind: (..._a: unknown[]) => stmt,
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
  }
  return {
    stmt,
    env: {
      TENANT_SLUG: 't',
      BRAND: 'Test',
      GITHUB_APP_CLIENT_ID: 'cid',
      GITHUB_APP_CLIENT_SECRET: 'csecret',
      DB: { prepare: vi.fn(() => stmt) },
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
    const { env, kv } = connectEnv('admin')
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

  function ghFetch(installs: Array<{ id: number; account?: { login: string } }>, opts?: { exchangeOk?: boolean; lookupOk?: boolean }) {
    return vi.fn(async (input: string | URL | Request) => {
      const u = String(input)
      if (u.includes('/login/oauth/access_token')) {
        return opts?.exchangeOk === false
          ? new Response(JSON.stringify({ access_token: 'utok' }), { status: 500 })
          : new Response(JSON.stringify({ access_token: 'utok' }), { status: 200 })
      }
      if (u.includes('/user/installations')) {
        return opts?.lookupOk === false
          ? new Response(JSON.stringify({ installations: installs }), { status: 502 })
          : new Response(JSON.stringify({ installations: installs }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
  }
  const CB = '/connect/github/callback?installation_id=139955064&setup_action=install&state=good&code=abc'

  it('valid state + owned install → stores id (login from GitHub), redirects to status', async () => {
    const { env, kv, stmt } = connectEnv('admin')
    kv.set('ghstate:good', 't') // pre-seed a tenant-bound state
    vi.stubGlobal('fetch', ghFetch([{ id: 139955064, account: { login: 'real-org' } }]))
    const res = await dashboardApp.fetch(getReq(CB + '&account_login=spoofed'), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin/github/status')
    expect(kv.has('ghstate:good')).toBe(false) // single-use: consumed
    expect(stmt.run).toHaveBeenCalledTimes(1)
  })

  it('installation_id the user does not have → 403, no row written', async () => {
    const { env, kv, stmt } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    vi.stubGlobal('fetch', ghFetch([{ id: 777 }]))
    const res = await dashboardApp.fetch(getReq(CB), env)
    expect(res.status).toBe(403)
    expect(stmt.run).not.toHaveBeenCalled()
  })

  it('missing code → refused, no row written', async () => {
    const { env, kv, stmt } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    vi.stubGlobal('fetch', ghFetch([{ id: 139955064 }]))
    const res = await dashboardApp.fetch(getReq(CB.replace('&code=abc', '')), env)
    expect(res.status).toBe(400)
    expect(stmt.run).not.toHaveBeenCalled()
  })

  it('app credentials not configured → refused (fail closed), no row written', async () => {
    const { env, kv, stmt } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    delete (env as { GITHUB_APP_CLIENT_SECRET?: string }).GITHUB_APP_CLIENT_SECRET
    vi.stubGlobal('fetch', ghFetch([{ id: 139955064 }]))
    const res = await dashboardApp.fetch(getReq(CB), env)
    expect(res.status).toBe(400)
    expect(stmt.run).not.toHaveBeenCalled()
  })

  it('GitHub API error on exchange or lookup → refused, no row written', async () => {
    for (const o of [{ exchangeOk: false }, { lookupOk: false }]) {
      const { env, kv, stmt } = connectEnv('admin')
      kv.set('ghstate:good', 't')
      vi.stubGlobal('fetch', ghFetch([{ id: 139955064 }], o))
      const res = await dashboardApp.fetch(getReq(CB), env)
      expect(res.status).toBe(400)
      expect(stmt.run).not.toHaveBeenCalled()
    }
  })

  it('state minted for another tenant, or replayed → refused, no row written', async () => {
    const { env, kv, stmt } = connectEnv('admin')
    kv.set('ghstate:good', 'other-tenant')
    vi.stubGlobal('fetch', ghFetch([{ id: 139955064 }]))
    expect((await dashboardApp.fetch(getReq(CB), env)).status).toBe(400)
    kv.set('ghstate:good', 't')
    expect((await dashboardApp.fetch(getReq(CB), env)).status).toBe(302)
    expect((await dashboardApp.fetch(getReq(CB), env)).status).toBe(400) // replay
    expect(stmt.run).toHaveBeenCalledTimes(1)
  })

  it('valid state but bad install params → 400', async () => {
    const { env, kv } = connectEnv('admin')
    kv.set('ghstate:good', 't')
    const res = await dashboardApp.fetch(
      getReq('/connect/github/callback?installation_id=notnum&setup_action=install&state=good'),
      env,
    )
    expect(res.status).toBe(400)
  })
})

describe('verifyInstallationOwnership', () => {
  const env = { GITHUB_APP_CLIENT_ID: 'c', GITHUB_APP_CLIENT_SECRET: 's' } as unknown as Env
  it('finds the id on a later page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1000 }))
    const f = vi.fn(async (input: string | URL | Request) => {
      const u = String(input)
      if (u.includes('access_token')) return new Response(JSON.stringify({ access_token: 't' }))
      return new Response(JSON.stringify({ installations: u.includes('page=2') ? [{ id: 5, account: { login: 'x' } }] : page1 }))
    })
    expect(await verifyInstallationOwnership(env, 'c', '5', { fetchImpl: f as unknown as typeof fetch })).toEqual({ ok: true, accountLogin: 'x' })
  })
  it('malformed lookup body → refused', async () => {
    const f = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('access_token') ? new Response(JSON.stringify({ access_token: 't' })) : new Response('{"x":1}'))
    const r = await verifyInstallationOwnership(env, 'c', '5', { fetchImpl: f as unknown as typeof fetch })
    expect(r.ok).toBe(false)
  })
})
