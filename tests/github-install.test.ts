// Tests for the GitHub install store + connect-flow helpers (src/integrations/github-install.ts)
// and the /admin/github/connect + /connect/github/callback routes.

import { describe, it, expect, vi } from 'vitest'
import {
  installUrl,
  parseInstallCallback,
  storeInstallation,
  getInstallationId,
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
    env: {
      TENANT_SLUG: 't',
      BRAND: 'Test',
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

  it('valid state + install → stores id, redirects to status', async () => {
    const { env, kv } = connectEnv('admin')
    kv.set('ghstate:good', 't') // pre-seed a tenant-bound state
    const res = await dashboardApp.fetch(
      getReq('/connect/github/callback?installation_id=139955064&setup_action=install&state=good'),
      env,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin/github/status')
    expect(kv.has('ghstate:good')).toBe(false) // single-use: consumed
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
