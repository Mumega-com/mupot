// The Access panel over HTTP: GET /agents/:id renders it for org admins only,
// POST /agents/:id/access writes through the guarded service, and the dashboard's
// csrf() Origin check applies. Auth is injected (same mock shape as
// tests/dashboard-projects.test.ts); the schema is the full committed chain.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { PRESENCE_ENV, seedPasskey, throughGate } from './helpers/presence'

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

// The move control reaches move_agent_squad through a registry that provision.ts fills at load (via src/mcp, the worker's own entry order).
await import('../src/mcp')
const { dashboardApp } = await import('../src/dashboard')
const { applyMoveOutOfHome } = await import('../src/dashboard/agent-access-panel')

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
    ...PRESENCE_ENV, PUBLIC_ORIGIN: ORIGIN,
  } as unknown as Env
  // Raising an agent's access needs the acting member's passkey; this suite tests the OTHER behaviour, so members have a passkey row
  // and the gate is passed through the DB shortcut (the real ceremony: tests/human-presence.test.ts).
  for (const m of harness.sqlite.prepare('SELECT id FROM members WHERE tenant = ?').all(TENANT) as Array<{ id: string }>) seedPasskey(harness.sqlite, TENANT, m.id)
  return { harness, env }
}

const g = (memberId: string, capability: CapabilityGrant['capability']): CapabilityGrant =>
  ({ member_id: memberId, scope_type: 'org', scope_id: null, capability }) as CapabilityGrant

const asHadi = (): AuthContext =>
  ({ userId: 'm-hadi', email: null, role: 'member', tenant: TENANT, memberId: 'm-hadi', capabilities: [g('m-hadi', 'admin')] })

function post(env: Env, path: string, values: Record<string, string>, origin: string = ORIGIN): Promise<Response> {
  return throughGate(open?.sqlite as never, TENANT, (qs) => Promise.resolve(dashboardApp.request(`${ORIGIN}${path}${qs ? `?${qs}` : ''}`, { // as: throughGate takes the minimal Sqlite shape the harness satisfies
    method: 'POST',
    headers: { Origin: origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  }, env)))
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
    expect(body).toContain('name="expected_capability" value="observer"')
    expect(body).toContain('name="expected_membership" value="observer"')
    expect(body).toContain('value="revoke"')
    expect(body).toContain('name="reason"')
    // home squad is listed but not editable
    expect(body).toMatch(/Rava Home[\s\S]*home squad, only its owner can change this level/)
    // only OTHER work squads are offered for enrollment; the level select has no owner
    expect(body).toContain('<option value="sq-ops">Ops Desk (department Engineering)</option>')
    expect(body).not.toContain('value="owner"')
    // never a token
    expect(body).not.toMatch(/mupot_[A-Za-z0-9]/)
  })

  it("shows both rows and a plain note when they disagree (Rava's real shape: capability observer, membership member)", async () => {
    const { harness, env } = setup()
    harness.sqlite.exec("UPDATE memberships SET capability = 'member' WHERE id = 'ms-core'")
    authState.current = asHadi()
    const body = await (await dashboardApp.request(`${ORIGIN}/agents/rava`, {}, env)).text()
    expect(body).toContain('name="expected_capability" value="observer"')
    expect(body).toContain('name="expected_membership" value="member"')
    expect(body).toContain('Rows disagree')
    expect(body).toContain('saving will set both to the level you choose')
    const res = await post(env, '/agents/rava/access', {
      squad_id: 'sq-core', capability: 'lead', expected_capability: 'observer', expected_membership: 'member', action: 'set',
    })
    expect(await res.text()).toContain('Rava is now lead on Core Platform. Effective on its next request.')
    expect(harness.sqlite.prepare('SELECT prior_capability, prior_membership, new_capability FROM agent_access_receipts').all())
      .toEqual([{ prior_capability: 'observer', prior_membership: 'member', new_capability: 'lead' }])
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
    expect(body).not.toContain('name="expected_capability"')
  })
})

describe('POST /agents/:id/access', () => {
  it('raises Rava from observer to lead and says so in plain language', async () => {
    const { harness, env } = setup()
    authState.current = asHadi()
    const res = await post(env, '/agents/rava/access', {
      squad_id: 'sq-core', capability: 'lead', expected_capability: 'observer', expected_membership: 'observer', action: 'set', reason: 'Hadi asked',
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
    expect((await post(env, '/agents/rava/access', { squad_id: 'sq-ops', capability: 'member', expected_capability: 'none', expected_membership: 'none', action: 'set' })).status).toBe(200)
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-ops', expected_capability: 'member', expected_membership: 'member', action: 'revoke' })
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
    seedPasskey(harness.sqlite, TENANT, 'm-own')
    authState.current = { userId: 'm-own', email: null, role: 'member', tenant: TENANT, memberId: 'm-own', capabilities: [g('m-own', 'owner')] }
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'lead', expected_capability: 'observer', expected_membership: 'observer', action: 'set' })
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
      { squad_id: 'sq-core', capability: 'admin', expected_capability: 'observer', expected_membership: 'observer', action: 'set' }, 'https://evil.test')
    expect(res.status).toBe(403)
    expect(rows(harness)).toHaveLength(0)
    expect((harness.sqlite.prepare("SELECT capability FROM capabilities WHERE id = 'c-core'").get() as { capability: string }).capability).toBe('observer')
  })

  it('refuses an agent-bound session, before it can learn whether the agent exists', async () => {
    const { harness, env } = setup()
    authState.current = { ...asHadi(), boundAgentId: 'rava' }
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'admin', expected_capability: 'observer', expected_membership: 'observer', action: 'set' })
    expect(res.status).toBe(403)
    expect((await post(env, '/agents/ghost/access', { squad_id: 'sq-core' })).status).toBe(403)
    expect(rows(harness)).toHaveLength(0)
  })

  it('refuses a non-admin with 403 for an existing and a missing agent alike', async () => {
    const { harness, env } = setup()
    authState.current = { userId: 'm-obs', email: null, role: 'member', tenant: TENANT, memberId: 'm-obs', capabilities: [g('m-obs', 'observer')] }
    expect((await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'admin', expected_capability: 'observer', expected_membership: 'observer', action: 'set' })).status).toBe(403)
    expect((await post(env, '/agents/ghost/access', { squad_id: 'sq-core' })).status).toBe(403)
    expect(rows(harness)).toHaveLength(0)
  })

  it('maps refusals to statuses with a plain message and no change', async () => {
    const { harness, env } = setup()
    authState.current = asHadi()
    const owner = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'owner', expected_capability: 'observer', expected_membership: 'observer', action: 'set' })
    expect(owner.status).toBe(400)
    const home = await post(env, '/agents/rava/access', { squad_id: 'sq-home', capability: 'lead', expected_capability: 'member', expected_membership: 'member', action: 'set' })
    // an org admin without the grant on that home is refused as not-the-owner
    expect(home.status).toBe(403)
    expect(await home.text()).toContain('Only the member who owns this home squad can change access on it.')
    const homeRevoke = await post(env, '/agents/rava/access', { squad_id: 'sq-home', expected_capability: 'member', expected_membership: 'member', action: 'revoke' })
    expect(homeRevoke.status).toBe(409)
    expect(await homeRevoke.text()).toContain('A home squad cannot be changed here')
    const stale = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'lead', expected_capability: 'admin', expected_membership: 'admin', action: 'set' })
    expect(stale.status).toBe(409)
    expect(rows(harness)).toHaveLength(0)
  })

  it('escapes a hostile reason and squad text on the way back out', async () => {
    const { harness, env } = setup()
    harness.sqlite.exec("UPDATE squads SET name = 'Core <img src=x onerror=alert(1)>' WHERE id = 'sq-core'")
    authState.current = asHadi()
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-core', capability: 'lead', expected_capability: 'observer', expected_membership: 'observer', action: 'set', reason: '<script>1</script>' })
    const body = await res.text()
    expect(body).not.toContain('<img src=x')
    expect(body).not.toContain('<script>1')
    expect((rows(harness) as unknown[]).length).toBe(1)
  })
})

// The <li> of the home squad inside the Access panel (rows sort by department then name).
const homeRow = (body: string): string => {
  const panel = body.slice(body.indexOf('<h2>Access</h2>'))
  const at = panel.indexOf('Rava Home')
  return panel.slice(at, panel.indexOf('</li>', at))
}

describe('the home squad row for its owner', () => {
  const ownerAuth = (): AuthContext => ({
    userId: 'm-hadi', email: null, role: 'member', tenant: TENANT, memberId: 'm-hadi',
    capabilities: [g('m-hadi', 'admin'), { member_id: 'm-hadi', scope_type: 'squad', scope_id: 'sq-home', capability: 'admin' } as CapabilityGrant],
  })
  const grantHome = (h: SqliteD1Harness): void => {
    h.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-hadi-home', 'm-hadi', 'squad', 'sq-home', 'admin')")
  }

  it('shows the owner a Change level form on the home row, without Revoke', async () => {
    const { harness, env } = setup()
    grantHome(harness)
    authState.current = ownerAuth()
    const body = await (await dashboardApp.request(`${ORIGIN}/agents/rava`, {}, env)).text()
    const home = homeRow(body)
    expect(home).toContain('name="squad_id" value="sq-home"')
    expect(home).toContain('Change level')
    expect(home).not.toContain('value="revoke"')
    expect(home).not.toContain('only its owner can change')
  })

  it('does not show those controls to an org admin who does not own the home', async () => {
    const { env } = setup()
    authState.current = asHadi()
    const body = await (await dashboardApp.request(`${ORIGIN}/agents/rava`, {}, env)).text()
    expect(homeRow(body)).not.toContain('name="squad_id" value="sq-home"')
  })

  it('the owner changes the level over HTTP', async () => {
    const { harness, env } = setup()
    grantHome(harness)
    authState.current = ownerAuth()
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-home', capability: 'lead', expected_capability: 'member', expected_membership: 'member', action: 'set' })
    expect(await res.text()).toContain('Rava is now lead on Rava Home.')
    expect(rows(harness)).toEqual([{ action: 'change', prior_capability: 'member', new_capability: 'lead', actor_member_id: 'm-hadi' }])
  })
})

describe('leaving the lobby: moving an agent out of its home squad', () => {
  const ownerAuth = (): AuthContext => ({
    userId: 'm-hadi', email: null, role: 'member', tenant: TENANT, memberId: 'm-hadi',
    capabilities: [g('m-hadi', 'admin'), { member_id: 'm-hadi', scope_type: 'squad', scope_id: 'sq-home', capability: 'admin' } as CapabilityGrant],
  })
  const grantHome = (h: SqliteD1Harness): void => {
    h.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-hadi-home', 'm-hadi', 'squad', 'sq-home', 'admin')")
  }
  const move = (env: Env, to: string, capability = 'member') =>
    post(env, '/agents/rava/access', { action: 'move', from_squad_id: 'sq-home', to_squad_id: to, capability })
  const bindingSquad = (h: SqliteD1Harness) => (h.sqlite.prepare("SELECT squad_id FROM agents WHERE id = 'rava'").get() as { squad_id: string }).squad_id
  const audits = (h: SqliteD1Harness) => h.sqlite.prepare("SELECT action, actor_id FROM agent_audit WHERE agent_id = 'rava'").all()

  it('the home owner moves the agent to a work squad: binding changes, receipt written, level as chosen', async () => {
    const { harness, env } = setup()
    grantHome(harness)
    authState.current = ownerAuth()
    const res = await move(env, 'sq-core', 'lead')
    expect(await res.text()).toContain('moved out of its home squad')
    expect(bindingSquad(harness)).toBe('sq-core')
    expect(audits(harness)).toEqual([{ action: 'move_agent_squad', actor_id: 'm-hadi' }])
    expect(harness.sqlite.prepare("SELECT capability FROM capabilities WHERE member_id = 'm-rava' AND scope_id = 'sq-core'").get()).toEqual({ capability: 'lead' })
    expect(harness.sqlite.prepare("SELECT 1 AS x FROM capabilities WHERE member_id = 'm-rava' AND scope_id = 'sq-home'").get()).toBeUndefined()
  })

  it('the agent can be enrolled in a work squad while it is still bound to the home', async () => {
    const { harness, env } = setup()
    grantHome(harness)
    authState.current = ownerAuth()
    const res = await post(env, '/agents/rava/access', { squad_id: 'sq-ops', capability: 'member', expected_capability: 'none', expected_membership: 'none', action: 'set' })
    expect(await res.text()).toContain('Rava is now member on Ops Desk')
    expect(bindingSquad(harness)).toBe('sq-home')
  })

  it('an org admin who does not own the home is refused; nothing moves', async () => {
    const { harness, env } = setup()
    authState.current = asHadi()
    const res = await move(env, 'sq-core')
    expect(res.status).toBe(403)
    expect(bindingSquad(harness)).toBe('sq-home')
    expect(audits(harness)).toEqual([])
  })

  it('a member without org admin (even holding home admin) is refused', async () => {
    const { harness, env } = setup()
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-obs-home', 'm-obs', 'squad', 'sq-home', 'admin')")
    authState.current = { userId: 'm-obs', email: null, role: 'member', tenant: TENANT, memberId: 'm-obs', capabilities: [g('m-obs', 'observer'), { member_id: 'm-obs', scope_type: 'squad', scope_id: 'sq-home', capability: 'admin' } as CapabilityGrant] }
    expect((await move(env, 'sq-core')).status).toBe(403)
    expect(bindingSquad(harness)).toBe('sq-home')
  })

  it('refuses a move into another home, an archived squad, and a move of an agent that is not in a home', async () => {
    const { harness, env } = setup()
    grantHome(harness)
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('sq-home2', 'dept-eng', 'other-home', 'Other Home', 'home');
      INSERT INTO squads (id, department_id, slug, name, kind, status) VALUES ('sq-old', 'dept-eng', 'old-desk', 'Old Desk', 'work', 'archived');`)
    authState.current = ownerAuth()
    expect((await move(env, 'sq-home2')).status).toBe(409)
    expect((await move(env, 'sq-old')).status).toBe(409)
    expect(bindingSquad(harness)).toBe('sq-home')
    harness.sqlite.exec("UPDATE agents SET squad_id = 'sq-core' WHERE id = 'rava'")
    expect((await move(env, 'sq-ops')).status).toBe(409)
    expect(bindingSquad(harness)).toBe('sq-core')
  })

  it('shows the Move to squad control only to the home owner', async () => {
    const { harness, env } = setup()
    grantHome(harness)
    authState.current = ownerAuth()
    expect(await (await dashboardApp.request(`${ORIGIN}/agents/rava`, {}, env)).text()).toContain('data-move-out-of-home')
    authState.current = asHadi()
    expect(await (await dashboardApp.request(`${ORIGIN}/agents/rava`, {}, env)).text()).not.toContain('data-move-out-of-home')
  })

  it('the wrapper itself refuses a home admin who is not org admin, and an agent session', async () => {
    const { harness, env } = setup()
    grantHome(harness)
    const nonAdmin: AuthContext = { userId: 'm-hadi', email: null, role: 'member', tenant: TENANT, memberId: 'm-hadi', capabilities: [{ member_id: 'm-hadi', scope_type: 'squad', scope_id: 'sq-home', capability: 'admin' } as CapabilityGrant] }
    expect(await applyMoveOutOfHome(env, nonAdmin, { agentRef: 'rava', toSquadId: 'sq-core', capability: 'member', reason: '' })).toMatchObject({ ok: false, status: 403 })
    expect(await applyMoveOutOfHome(env, { ...ownerAuth(), boundAgentId: 'rava' }, { agentRef: 'rava', toSquadId: 'sq-core', capability: 'member', reason: '' })).toMatchObject({ ok: false, status: 403 })
    expect(bindingSquad(harness)).toBe('sq-home')
  })
})
