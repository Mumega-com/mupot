// The agent page shows observed runtime facts, read-only and apart from declared fields.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))
vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: { get: (k: 'auth') => AuthContext | undefined; set: (k: 'auth', v: AuthContext) => void; json: (b: unknown, s: 401) => Response },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))
const { dashboardApp } = await import('../src/dashboard')

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'
let open: SqliteD1Harness | undefined
afterEach(() => { open?.close(); open = undefined; authState.current = null })

function setup(): { harness: SqliteD1Harness; env: Env } {
  const harness = createSqliteD1()
  open = harness
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name, kind) VALUES ('dept-eng', 'eng', 'Engineering', 'work');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('sq-core', 'dept-eng', 'squad-core', 'Core', 'work');
    INSERT INTO members (id, display_name, email, status, tenant) VALUES ('m-admin', 'Ada', 'ada@x.test', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag1', 'sq-core', 'ag1', 'Agent One', 'member', 'test', 'active');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c1', 'm-admin', 'org', NULL, 'admin');
  `)
  const env = {
    DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    VEC: { query: async () => ({ matches: [] }) }, BUS: { send: async () => {} },
    BLOBS: {}, AI: {}, AGENT: {}, SQUAD: {},
  } as unknown as Env
  return { harness, env }
}
const admin = (): AuthContext => ({
  userId: 'm-admin', email: null, role: 'member', tenant: TENANT, memberId: 'm-admin',
  capabilities: [{ member_id: 'm-admin', scope_type: 'org', scope_id: null, capability: 'admin' } as CapabilityGrant],
})
const page = async (env: Env) => (await dashboardApp.request(`${ORIGIN}/agents/ag1`, {}, env)).text()

describe('GET /agents/:id Live runtime block', () => {
  it('shows "not reported" before any boot', async () => {
    const { env } = setup()
    authState.current = admin()
    const body = await page(env)
    expect(body).toContain('Live runtime')
    expect(body).toContain('not reported')
  })

  it('renders observed facts escaped, with no form or write path in the block', async () => {
    const { harness, env } = setup()
    harness.sqlite.exec(`INSERT INTO fleet_agents (agent_id, tenant, runtime, runtime_canonical, model, host, connection_kind, last_boot_at, status, reported_by)
      VALUES ('ag1', '${TENANT}', 'codex-cli', 'codex-cli', 'gpt-5.6', '<b>muvps</b>', 'agent_bound', '2026-10-16 23:00:00', 'running', 'ag1')`)
    authState.current = admin()
    const body = await page(env)
    const block = body.slice(body.indexOf('data-live-runtime'), body.indexOf('data-live-runtime') + 900)
    expect(block).toContain('codex-cli')
    expect(block).toContain('gpt-5.6')
    expect(block).toContain('agent_bound')
    expect(block).toContain('2026-10-16 23:00:00')
    expect(block).toContain('&lt;b&gt;muvps&lt;/b&gt;')
    expect(block).not.toContain('<b>muvps</b>')
    expect(block).not.toContain('<form')
  })
})
