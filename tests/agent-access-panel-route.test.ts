// The Access panel over HTTP: GET /agents/:id renders it for org admins only,
// POST /agents/:id/access writes through the guarded service, and the dashboard's
// csrf() Origin check applies. Auth is injected (same mock shape as
// tests/dashboard-projects.test.ts); the schema is the full committed chain.
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
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('sq-home', 'dept-eng', 'rava-home', 'Rava Home', 'home'),
      ('sq-core', 'dept-eng', 'squad-core', 'Core Platform', 'work'),
      ('sq-ops',  'dept-eng', 'ops-desk',   'Ops Desk',      'work');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('m-hadi', 'Hadi', 'active', '${TENANT}'),
      ('m-rava', 'Rava', 'active', '${TENANT}'),
      ('m-obs',  'Observer Human', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('rava', 'sq-home', 'rava', 'Rava', 'member', 'test', 'active'),
      ('nobind', 'sq-home', 'nobind', 'No Bind', 'member', 'test', 'active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'rava', 'm-rava', '2026-09-01T00:00:00.000Z');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('ms-home', 'rava', 'sq-home', 'member'), ('ms-core', 'rava', 'sq-core', 'observer');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c-home', 'm-rava', 'squad', 'sq-home', 'member'),
      ('c-core', 'm-rava', 'squad', 'sq-core', 'observer'),
      ('c-hadi', 'm-hadi', 'org', NULL, 'admin'),
      ('c-obs',  'm-obs',  'org', NULL, 'observer');
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

const asHadi = (): AuthContext =>
  ({ userId: 'm-hadi', email: null, role: 'member', tenant: TENANT, memberId: 'm-hadi', capabilities: [g('m-hadi', 'admin')] })

function post(env: Env, path: string, values: Record<string, string>, origin: string = ORIGIN): Promise<Response> {
  return Promise.resolve(dashboardApp.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  }, env))
}

const rows = (h: SqliteD1Harness) =>
  h.sqlite.prepare('SELECT action, prior_capability, new_capability, actor_member_id FROM agent_access_receipts').all()

describe('GET /agents/:id — the Access panel', () => {
  it('shows an org admin the current rows, the department, the selects and Revoke', async () => {
    const { env } = setup()
    authState.current = asHadi()
    const res = await dashboardApp.request(`${ORIGIN}/agents/rava`, {}, env)
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('<h2>Access</h2>')
    expect(body).toContain('Core Platform')
    expect(body).toContain('department Engineering')
    expect(body).toContain('name="expected_prior" value="observer"')
    expect(body).toContain('value="revoke"')
    expect(body).toContain('name="reason"')
    // home squad is listed but not editable
    expect(body).toMatch(/Rava Home[\s\S]*home squad, not editable here/)
    // only OTHER work squads are offered for enrollment; the level select has no owner
    expect(body).toContain('<option value="sq-ops">Ops Desk (department Engineering)</option>')
    expect(body).not.toContain('value="owner"')
    // never a token
    expect(body).not.toMatch(/mupot_[A-Za-z0-9]/)
  })

  it('does not render the panel for a non-admin who can still read the agent', async () => {
    const { env } = setup()
    authState.current = { userId: 'm-obs', email: null, role: 'member', tenant: TENANT, memberId: 'm-obs', capabilities: [g('m-obs', 'observer')] }
    const res = await dashboardApp.request(`${ORIGIN}/agents/rava`, {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('<h2>Access</h2>')
  })

  it('does not render the panel for an agent-bound session', async () => {
    const { env } = setup()
    authState.current = { ...asHadi(), boundAgentId: 'rava' }
    const res = await dashboardApp.request(`${ORIGIN}/agents/rava`, {}, env)
    expect(await res.text()).not.toContain('<h2>Access</h2>')
  })

  it('explains an unminted agent instead of offering a form', async () => {
    const { env } = setup()
    authState.current = asHadi()
    const body = await (await dashboardApp.request(`${ORIGIN}/agents/nobind`, {}, env)).text()
    expect(body).toContain('no welded identity')
    expect(body).not.toContain('name="expected_prior"')
  })
})

describe('POST /agents/:id/access', () => {
  it('raises Rava from observer to lead and says so in plain language', async () => {
    const { harness, env } = setup()
    authState.current = asHadi()
    const res = await post(env, '/agents/rava/access', {
      squad_id: 'sq-core', capability: 'lead', expected_prior: 'observer', action: 'set', reason: 'Hadi asked',
    })
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('Rava is now lead on Core Platform. Effective on its next request.')
    expect(rows(harness)).toEqual([{ action: 'change', prior_capability: 'observer', new_capability: 'lead', actor_member_id: 'm-hadi' }])
    expect(body).not.toMatch(/mupot_[A-Za-z0-9]/)
  })

  it('enrolls on another squad and revokes', async () => {
    const { harness, env } = setup()
    authState.current = asHadi()
    expect((await post(env, '/agents/rava/access', { squad_id: 'sq-ops', capability: 'member', expected_prior: 'none', action: 'set' })).status).toBe(200)
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-ops', expected_prior: 'member', action: 'revoke' })
    expect(await res.text()).toContain('Rava no longer has access to Ops Desk.')
    expect(rows(harness).map((r) => (r as { action: string }).action)).toEqual(['enroll', 'revoke'])
  })

  it('tells an org owner plainly when the agent holds owner elsewhere, not "changed underneath you"', async () => {
    const { harness, env } = setup()
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant) VALUES ('m-own', 'Owner', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('c-own', 'm-own', 'org', NULL, 'owner'),
        ('c-rava-owner', 'm-rava', 'squad', 'sq-ops', 'owner');
    `)
    authState.current = { userId: 'm-own', email: null, role: 'member', tenant: TENANT, memberId: 'm-own', capabilities: [g('m-own', 'owner')] }
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'lead', expected_prior: 'observer', action: 'set' })
    const body = await res.text()
    expect(res.status).toBe(403)
    expect(body).toContain('owner standing on another scope')
    expect(body).not.toContain('changed underneath you')
    expect(rows(harness)).toHaveLength(0)
  })

  it('refuses a cross-origin POST (csrf) and changes nothing', async () => {
    const { harness, env } = setup()
    authState.current = asHadi()
    const res = await post(env, '/agents/rava/access',
      { squad_id: 'sq-core', capability: 'admin', expected_prior: 'observer', action: 'set' }, 'https://evil.test')
    expect(res.status).toBe(403)
    expect(rows(harness)).toHaveLength(0)
    expect((harness.sqlite.prepare("SELECT capability FROM capabilities WHERE id = 'c-core'").get() as { capability: string }).capability).toBe('observer')
  })

  it('refuses an agent-bound session, before it can learn whether the agent exists', async () => {
    const { harness, env } = setup()
    authState.current = { ...asHadi(), boundAgentId: 'rava' }
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'admin', expected_prior: 'observer', action: 'set' })
    expect(res.status).toBe(403)
    expect((await post(env, '/agents/ghost/access', { squad_id: 'sq-core' })).status).toBe(403)
    expect(rows(harness)).toHaveLength(0)
  })

  it('refuses a non-admin with 403 for an existing and a missing agent alike', async () => {
    const { harness, env } = setup()
    authState.current = { userId: 'm-obs', email: null, role: 'member', tenant: TENANT, memberId: 'm-obs', capabilities: [g('m-obs', 'observer')] }
    expect((await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'admin', expected_prior: 'observer', action: 'set' })).status).toBe(403)
    expect((await post(env, '/agents/ghost/access', { squad_id: 'sq-core' })).status).toBe(403)
    expect(rows(harness)).toHaveLength(0)
  })

  it('maps refusals to statuses with a plain message and no change', async () => {
    const { harness, env } = setup()
    authState.current = asHadi()
    const owner = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'owner', expected_prior: 'observer', action: 'set' })
    expect(owner.status).toBe(400)
    const home = await post(env, '/agents/rava/access', { squad_id: 'sq-home', capability: 'lead', expected_prior: 'member', action: 'set' })
    expect(home.status).toBe(409)
    expect(await home.text()).toContain('A home squad cannot be changed here.')
    const stale = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'lead', expected_prior: 'admin', action: 'set' })
    expect(stale.status).toBe(409)
    expect(rows(harness)).toHaveLength(0)
  })

  it('escapes a hostile reason and squad text on the way back out', async () => {
    const { harness, env } = setup()
    harness.sqlite.exec("UPDATE squads SET name = 'Core <img src=x onerror=alert(1)>' WHERE id = 'sq-core'")
    authState.current = asHadi()
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'lead', expected_prior: 'observer', action: 'set', reason: '<script>1</script>' })
    const body = await res.text()
    expect(body).not.toContain('<img src=x')
    expect(body).not.toContain('<script>1')
    expect((rows(harness) as unknown[]).length).toBe(1)
  })
})
