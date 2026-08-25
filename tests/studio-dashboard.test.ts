// tests/studio-dashboard.test.ts — Mupot Studio canvas + dispatch API.
//
// Schema is the committed migration chain (createSqliteD1 + applyAllMigrations).
// HTTP tests go through dashboardApp so session auth, CSRF, and the capability
// floor are the same ones production uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const { dashboardApp } = await import('../src/dashboard')
const { studioPageHtml, normalizeStudioModel, getAuthContext } = await import('../src/dashboard/studio')

const TENANT = 'pot-studio'

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

function seedOrg(): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-studio', 'studio', 'Studio');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-studio', 'dept-studio', 'studio', 'Studio Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
    VALUES ('agent-studio', 'squad-studio', 'studio-pilot', 'Studio Pilot', 'member', 'cursor-cloud', 'active');
  `)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Mupot' } as Env
  seedOrg()
  as(actor())
})

afterEach(() => {
  authState.current = null
  harness.close()
})

describe('studio render helpers', () => {
  it('normalizes Cursor Cloud / Codex model ids', () => {
    expect(normalizeStudioModel('Cursor Cloud')).toBe('cursor-cloud')
    expect(normalizeStudioModel('codex')).toBe('codex')
    expect(normalizeStudioModel(undefined)).toBe('cursor-cloud')
  })

  it('reads the dashboard session via getAuthContext', () => {
    const auth = actor({ userId: 'from-session' })
    const ctx = { get: (key: 'auth') => (key === 'auth' ? auth : undefined) }
    expect(getAuthContext(ctx as never).userId).toBe('from-session')
  })

  it('renders the split-pane canvas chrome', async () => {
    const markup = String(
      await studioPageHtml({
        brand: 'Mupot',
        tenant: TENANT,
        operator: 'operator@mumega.com',
        branch: 'main',
        flights: [],
      }),
    )
    expect(markup).toContain('studio-split')
    expect(markup).toContain('studio-pane-left')
    expect(markup).toContain('studio-pane-right')
    expect(markup).toContain('id="studio-prompt"')
    expect(markup).toContain('Cursor Cloud')
    expect(markup).toContain('Codex')
    expect(markup).toContain('Interactive Preview Canvas')
    expect(markup).toContain('Desktop')
    expect(markup).toContain('Tablet')
    expect(markup).toContain('Mobile')
    expect(markup).toContain('Live agent execution log stream')
    expect(markup).toContain('Diff viewer')
    expect(markup).toContain('Athena review')
    expect(markup).toContain('Kasra review')
    expect(markup).toContain('Land / Deploy')
    expect(markup).toContain('#0a0a0c')
  })
})

describe('GET /studio', () => {
  it('renders the Studio split-pane canvas with HTTP 200 for authenticated operators', async () => {
    const res = await dashboardApp.fetch(new Request('https://pot.test/studio'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('studio-split')
    expect(body).toContain('studio-pane-left')
    expect(body).toContain('studio-pane-right')
    expect(body).toContain('Prompt directive')
    expect(body).toContain('Agent chat history')
    expect(body).toContain('Recent flights')
    expect(body).toContain('Interactive Preview Canvas')
    expect(body).toContain('Desktop')
    expect(body).toContain('Tablet')
    expect(body).toContain('Mobile')
    expect(body).toContain('Synthetic Council Gate')
    expect(body).toContain('Athena review')
    expect(body).toContain('Kasra review')
    expect(body).toContain('Land / Deploy')
  })

  it('redirects unauthenticated browsers to login', async () => {
    as(null)
    const res = await dashboardApp.fetch(new Request('https://pot.test/studio'), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })
})

describe('POST /api/studio/dispatch', () => {
  it('returns { ok: true, flight_id: string } and persists a flight/task record', async () => {
    const res = await dashboardApp.fetch(
      new Request('https://pot.test/api/studio/dispatch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://pot.test',
        },
        body: JSON.stringify({
          prompt: 'Design a Studio landing hero with neon council badges.',
          repoUrl: 'https://github.com/Mumega-com/mupot',
          model: 'cursor-cloud',
        }),
      }),
      env,
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { ok: boolean; flight_id: string }
    expect(payload.ok).toBe(true)
    expect(typeof payload.flight_id).toBe('string')
    expect(payload.flight_id.length).toBeGreaterThan(8)

    const flight = harness.sqlite
      .prepare('SELECT id, goal, agent, status FROM flights WHERE id = ?')
      .get(payload.flight_id) as { id: string; goal: string; agent: string; status: string } | undefined
    expect(flight?.goal).toContain('Studio landing hero')
    expect(flight?.agent).toBe('agent-studio')
    expect(flight?.status).toBe('preflight')

    const task = harness.sqlite
      .prepare("SELECT id, title FROM tasks WHERE title LIKE '%Studio landing hero%' LIMIT 1")
      .get() as { id: string; title: string } | undefined
    expect(task?.id).toBeTruthy()
  })

  it('rejects an empty prompt', async () => {
    const res = await dashboardApp.fetch(
      new Request('https://pot.test/api/studio/dispatch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://pot.test',
        },
        body: JSON.stringify({ prompt: '   ' }),
      }),
      env,
    )
    expect(res.status).toBe(400)
    const payload = (await res.json()) as { error: string }
    expect(payload.error).toBe('prompt_required')
  })
})
