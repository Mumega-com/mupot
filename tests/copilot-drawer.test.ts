// tests/copilot-drawer.test.ts — global Co-Pilot launcher/drawer + dedicated page.
//
// Schema is the committed migration chain (createSqliteD1 + applyAllMigrations).
// HTTP tests go through dashboardApp so session auth, CSRF, and the capability
// floor are the same ones production uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { html } from 'hono/html'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      get: (key: 'auth') => AuthContext | undefined
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { dashboardApp, shell } = await import('../src/dashboard')
const { copilotPageBody, copilotRoleBadge } = await import('../src/dashboard/copilot')

const TENANT = 'pot-copilot'

let harness: SqliteD1Harness
let env: Env

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'operator-1',
    email: 'operator@mumega.com',
    role: 'admin',
    tenant: TENANT,
    ...overrides,
  }
}

function as(auth: AuthContext | null): void {
  authState.current = auth
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Mupot' } as Env
  as(actor())
})

afterEach(() => {
  authState.current = null
  harness.close()
})

describe('shell() Co-Pilot chrome', () => {
  it('includes the floating launcher and slide-over drawer', async () => {
    const markup = String(await shell(env, 'Overview', html`<p>hi</p>`))
    expect(markup).toContain('id="mupot-copilot-launcher"')
    expect(markup).toContain('id="mupot-copilot-drawer"')
    expect(markup).toContain('title="Co-Pilot"')
    expect(markup).toContain('aria-label="Co-Pilot"')
    expect(markup).toContain('Mupot Co-Pilot')
    expect(markup).toContain('✕')
    expect(markup).toContain('/api/studio/chat')
    expect(markup).toContain('width: 420px')
    expect(markup).toContain('z-index: 9999')
    expect(markup).toContain('transition: transform 0.25s ease')
    expect(markup).toContain('href="/copilot"')
    expect(markup).toContain('<span class="nav-label">Co-Pilot</span>')
    expect(markup).toContain('[data-copilot-open]')
    expect(markup).toContain('window.mupotOpenCopilot')
  })

  it('renders the member role badge by default in the drawer', async () => {
    const markup = String(await shell(env, 'Overview', html`<p>hi</p>`))
    expect(markup).toContain('[ 👤 Member ]')
  })
})

describe('copilot render helpers', () => {
  it('labels admin and member roles', () => {
    expect(copilotRoleBadge('admin')).toBe('[ 🛡️ Admin ]')
    expect(copilotRoleBadge('owner')).toBe('[ 🛡️ Admin ]')
    expect(copilotRoleBadge('member')).toBe('[ 👤 Member ]')
  })

  it('renders the dedicated page interface', async () => {
    const markup = String(await copilotPageBody(actor({ role: 'admin' })))
    expect(markup).toContain('id="mupot-copilot-page"')
    expect(markup).toContain('Mupot Co-Pilot')
    expect(markup).toContain('[ 🛡️ Admin ]')
    expect(markup).toContain('/api/studio/chat')
    expect(markup).toContain('id="mupot-copilot-page-input"')
    expect(markup).toContain('id="mupot-copilot-page-send"')
  })
})

describe('GET /copilot', () => {
  it('renders HTTP 200 with the full co-pilot interface', async () => {
    const res = await dashboardApp.fetch(new Request('https://pot.test/copilot'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Mupot Co-Pilot')
    expect(body).toContain('id="mupot-copilot-page"')
    expect(body).toContain('id="mupot-copilot-launcher"')
    expect(body).toContain('id="mupot-copilot-drawer"')
    expect(body).toContain('id="mupot-copilot-page-input"')
    expect(body).toContain('data-copilot-send')
    expect(body).toContain('/api/studio/chat')
    expect(body).toContain('[ 🛡️ Admin ]')
  })

  it('redirects unauthenticated browsers to login', async () => {
    as(null)
    const res = await dashboardApp.fetch(new Request('https://pot.test/copilot'), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })
})

describe('GET /chat', () => {
  it('renders HTTP 200 with the same dedicated co-pilot interface', async () => {
    const res = await dashboardApp.fetch(new Request('https://pot.test/chat'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="mupot-copilot-page"')
    expect(body).toContain('Mupot Co-Pilot')
    expect(body).toContain('/api/studio/chat')
  })
})
