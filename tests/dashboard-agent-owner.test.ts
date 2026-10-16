// mupot#1987: the Owner row + POST /agents/:id/owner. Authorization is the shared
// authorizeOwnerMemberChange predicate that MCP update_agent also calls.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

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

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'

let open: SqliteD1Harness | undefined
afterEach(() => {
  open?.close()
  open = undefined
  authState.current = null
})

function setup(): { harness: SqliteD1Harness; env: Env } {
  const harness = createSqliteD1()
  open = harness
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name, kind) VALUES ('dept-eng', 'eng', 'Engineering', 'work');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('sq-core', 'dept-eng', 'squad-core', 'Core', 'work');
    INSERT INTO members (id, display_name, email, status, tenant) VALUES
      ('m-admin', 'Ada Admin', 'ada@x.test', 'active', '${TENANT}'),
      ('m-boss', 'Boss Owner', 'boss@x.test', 'active', '${TENANT}'),
      ('m-peer', 'Peer Member', 'peer@x.test', 'active', '${TENANT}'),
      ('m-evil', '<script>alert(1)</script>', 'evil@x.test', 'active', '${TENANT}'),
      ('m-other', 'Other Tenant', 'o@x.test', 'active', 'someone-else');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('ag1', 'sq-core', 'ag1', 'Agent One', 'member', 'test', 'active');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c1', 'm-admin', 'org', NULL, 'admin'),
      ('c2', 'm-boss', 'org', NULL, 'owner'),
      ('c3', 'm-peer', 'org', NULL, 'member');
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

const g = (memberId: string, capability: CapabilityGrant['capability']): CapabilityGrant =>
  ({ member_id: memberId, scope_type: 'org', scope_id: null, capability }) as CapabilityGrant
const as = (id: string, cap: CapabilityGrant['capability']): AuthContext =>
  ({ userId: id, email: null, role: 'member', tenant: TENANT, memberId: id, capabilities: [g(id, cap)] })

function post(env: Env, values: Record<string, string>, origin: string | null = ORIGIN): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (origin) headers.Origin = origin
  return Promise.resolve(dashboardApp.request(`${ORIGIN}/agents/ag1/owner`, { method: 'POST', headers, body: new URLSearchParams(values) }, env))
}
const owner = (h: SqliteD1Harness) =>
  (h.sqlite.prepare("SELECT owner_member_id AS o FROM agents WHERE id = 'ag1'").get() as { o: string | null }).o

describe('agent Owner row + POST /agents/:id/owner', () => {
  it('shows No owner, then the owner name; admin sees the control', async () => {
    const { harness, env } = setup()
    authState.current = as('m-admin', 'admin')
    let body = await (await dashboardApp.request(`${ORIGIN}/agents/ag1`, {}, env)).text()
    expect(body).toContain('<dt>Owner</dt><dd>No owner</dd>')
    expect(body).toContain('Make me the owner')
    expect(body).toContain('value="m-peer"')
    expect(body).not.toContain('value="m-boss"') // outranks the admin
    expect(body).not.toContain('value="m-other"') // other tenant
    harness.sqlite.exec("UPDATE agents SET owner_member_id = 'm-peer' WHERE id = 'ag1'")
    body = await (await dashboardApp.request(`${ORIGIN}/agents/ag1`, {}, env)).text()
    expect(body).toContain('Peer Member · peer@x.test')
  })

  it('renders the owner name escaped', async () => {
    const { harness, env } = setup()
    harness.sqlite.exec("UPDATE agents SET owner_member_id = 'm-evil' WHERE id = 'ag1'")
    authState.current = as('m-admin', 'admin')
    const body = await (await dashboardApp.request(`${ORIGIN}/agents/ag1`, {}, env)).text()
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('an org admin sets an owner and the write is audited', async () => {
    const { harness, env } = setup()
    authState.current = as('m-admin', 'admin')
    const res = await post(env, { action: 'set', owner_member_id: 'm-peer' })
    expect(res.status).toBe(303)
    expect(owner(harness)).toBe('m-peer')
    const audit = harness.sqlite.prepare("SELECT actor_id, actor_type FROM agent_audit WHERE agent_id = 'ag1' ORDER BY rowid DESC LIMIT 1").get()
    expect(audit).toEqual({ actor_id: 'm-admin', actor_type: 'user' })
  })

  it('Make me the owner succeeds', async () => {
    const { harness, env } = setup()
    authState.current = as('m-admin', 'admin')
    expect((await post(env, { action: 'me' })).status).toBe(303)
    expect(owner(harness)).toBe('m-admin')
  })

  it('clearing follows update_agent (null allowed)', async () => {
    const { harness, env } = setup()
    harness.sqlite.exec("UPDATE agents SET owner_member_id = 'm-peer' WHERE id = 'ag1'")
    authState.current = as('m-admin', 'admin')
    expect((await post(env, { action: 'clear' })).status).toBe(303)
    expect(owner(harness)).toBeNull()
  })

  it('a non-admin is refused, no write, no control rendered', async () => {
    const { harness, env } = setup()
    authState.current = as('m-peer', 'member')
    expect((await post(env, { action: 'me' })).status).toBe(403)
    expect(owner(harness)).toBeNull()
    const body = await (await dashboardApp.request(`${ORIGIN}/agents/ag1`, {}, env)).text()
    expect(body).not.toContain('Make me the owner')
  })

  it('a member who outranks the caller is refused', async () => {
    const { harness, env } = setup()
    authState.current = as('m-admin', 'admin')
    const res = await post(env, { action: 'set', owner_member_id: 'm-boss' })
    expect(res.status).toBe(403)
    expect(owner(harness)).toBeNull()
  })

  it('an unknown member gives owner_member_not_found', async () => {
    const { harness, env } = setup()
    authState.current = as('m-admin', 'admin')
    const res = await post(env, { action: 'set', owner_member_id: 'm-nobody' })
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('owner_member_not_found')
    expect(owner(harness)).toBeNull()
  })

  it('a cross-tenant member id is refused', async () => {
    const { harness, env } = setup()
    authState.current = as('m-admin', 'admin')
    const res = await post(env, { action: 'set', owner_member_id: 'm-other' })
    expect(res.status).toBe(404)
    expect(owner(harness)).toBeNull()
  })

  it('a cross-origin / missing-Origin post is refused by csrf', async () => {
    const { harness, env } = setup()
    authState.current = as('m-admin', 'admin')
    expect((await post(env, { action: 'me' }, 'https://evil.test')).status).toBe(403)
    expect((await post(env, { action: 'me' }, null)).status).toBe(403)
    expect(owner(harness)).toBeNull()
  })
})
