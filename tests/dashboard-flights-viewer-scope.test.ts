import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (c: {
    set: (key: 'auth', value: AuthContext) => void
    json: (body: unknown, status: 401) => Response
  }, next: () => Promise<void>) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { dashboardApp } = await import('../src/dashboard')
await import('../src/mcp') // registry first: flight-spine imports it cyclically
const flightSpine = await import('../src/mcp/flight-spine')
const visibleFlightsMod = await import('../src/dashboard/visible-flights')

function meta(squads: string[], taskId = 't'): string {
  return JSON.stringify({
    schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: squads, task_ids: [taskId], done_when: ['d'],
    artifact_refs: [], receipt_refs: [], confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  })
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery'), ('dept-b', 'secret', 'Secret');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Alpha'), ('squad-b', 'dept-b', 'beta', 'Beta');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-a', 'a@example.test', 'Member A', 'active', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', 'member-a', 'squad', 'squad-a', 'member');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-a', 'squad-a', 'ag-a', 'AGENTA', 'inactive'), ('ag-b', 'squad-b', 'ag-b', 'HIDDENAGENT', 'inactive');
    INSERT INTO projects (id, slug, name, status) VALUES ('proj-a', 'proj-a', 'PROJA', 'active'), ('proj-b', 'proj-b', 'HIDDENPROJNAME', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-a', 'squad-a', 'write'), ('proj-b', 'squad-b', 'write');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-b', 'squad-a', 'write');
    INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, priority, created_at, updated_at) VALUES
      ('t-vis', 'squad-a', 'proj-a', 'Visible task', '', 'x', 'in_progress', 'P2', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'),
      ('t-cross', 'squad-a', 'proj-b', 'Cross project task', '', 'x', 'in_progress', 'P2', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
    -- the insert trigger needs the edge; the viewer's squad then loses it, leaving a task in a project it cannot read
    DELETE FROM project_squad_access WHERE project_id = 'proj-b' AND squad_id = 'squad-a';
  `)
  return harness
}

function addFlight(
  h: SqliteD1Harness, id: string, agent: string, goal: string, squads: string[], at: number,
  opts: { project?: string | null; status?: string } = {},
): void {
  const project = opts.project ?? null
  // the flight insert trigger needs the squad->project edge and a task in that project; the edge is removed again after
  const added: string[] = []
  if (project) {
    for (const sq of squads) {
      const had = h.sqlite.prepare('SELECT 1 FROM project_squad_access WHERE project_id = ? AND squad_id = ?').get(project, sq)
      if (!had) {
        h.sqlite.prepare("INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES (?, ?, 'write')").run(project, sq)
        added.push(sq)
      }
    }
  }
  h.sqlite.prepare('INSERT INTO flights (id, tenant, agent, goal, status, meta, project_id, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'tenant-a', agent, goal, opts.status ?? 'running', meta(squads, project === 'proj-a' ? 't-vis' : project === 'proj-b' ? 't-cross' : 't'), project, at, at)
  for (const sq of added) h.sqlite.prepare('DELETE FROM project_squad_access WHERE project_id = ? AND squad_id = ?').run(project, sq)
}

function seedFlights(h: SqliteD1Harness): void {
  addFlight(h, 'fl-vis', 'ag-a', 'VISIBLEGOAL', ['squad-a'], 1000, { project: 'proj-a' })
  addFlight(h, 'fl-hid-squad', 'ag-b', 'HIDDENSQUADGOAL', ['squad-b'], 2000)
  addFlight(h, 'fl-hid-proj', 'ag-a', 'HIDDENPROJGOAL', ['squad-a'], 3000, { project: 'proj-b' })
  addFlight(h, 'fl-mixed', 'ag-a', 'MIXEDSQUADGOAL', ['squad-a', 'squad-b'], 4000)
}

function envFor(h: SqliteD1Harness): Env {
  return { DB: h.db, TENANT_SLUG: 'tenant-a', BRAND: 'Mupot', RELEASE_SHA: 'abcdef0123456789abcdef0123456789abcdef01' } as unknown as Env
}

function member(): AuthContext {
  return {
    userId: 'member-a', memberId: 'member-a', email: null, role: 'member', tenant: 'tenant-a',
    capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
  }
}

describe('flight lists are scoped to the viewer', () => {
  let h: SqliteD1Harness | undefined
  afterEach(() => {
    vi.restoreAllMocks()
    authState.current = null
    h?.close()
    h = undefined
  })

  const get = async (path: string, auth: AuthContext = member()) => {
    authState.current = auth
    const res = await dashboardApp.fetch(new Request(`https://pot.test${path}`), envFor(h!))
    return { res, body: await res.text() }
  }
  const chip = (body: string, label: string) => body.match(new RegExp(`<b>([^<]*)</b> ${label}`))?.[1]

  it('/flights and /status show only flights the viewer may see', async () => {
    h = makeHarness(); seedFlights(h)
    for (const path of ['/flights', '/status']) {
      const { res, body } = await get(path)
      expect(res.status).toBe(200)
      expect(body).toContain('VISIBLEGOAL')
      for (const hidden of ['HIDDENSQUADGOAL', 'HIDDENPROJGOAL', 'MIXEDSQUADGOAL', 'HIDDENAGENT']) {
        expect(body).not.toContain(hidden)
      }
    }
  })

  it('a workspace admin still sees the whole tenant', async () => {
    h = makeHarness(); seedFlights(h)
    const admin: AuthContext = { ...member(), capabilities: [{ member_id: 'member-a', scope_type: 'org', scope_id: null, capability: 'admin' }] }
    const { body } = await get('/flights', admin)
    for (const g of ['VISIBLEGOAL', 'HIDDENSQUADGOAL', 'HIDDENPROJGOAL', 'MIXEDSQUADGOAL']) expect(body).toContain(g)
  })

  it('a viewer with no squad grants sees no flights', async () => {
    h = makeHarness(); seedFlights(h)
    const { body } = await get('/flights', { ...member(), capabilities: [] })
    expect(body).not.toContain('VISIBLEGOAL')
  })

  it('/status: 101 newer flights of other squads cannot crowd out the viewer\'s older flight', async () => {
    h = makeHarness()
    addFlight(h, 'fl-old', 'ag-a', 'OLDVISIBLEGOAL', ['squad-a'], 1)
    for (let i = 0; i < 101; i++) addFlight(h, `fl-other-${i}`, 'ag-b', `OTHERSQUAD${i}`, ['squad-b'], 1000 + i)
    for (let i = 0; i < 101; i++) addFlight(h, `fl-otherproj-${i}`, 'ag-a', `OTHERPROJ${i}`, ['squad-a'], 5000 + i, { project: 'proj-b' })
    const { body } = await get('/status')
    expect(body).toContain('OLDVISIBLEGOAL')
    expect(body).not.toContain('OTHERSQUAD')
    expect(body).not.toContain('OTHERPROJ')
    expect(chip(body, 'flights')).toBe('1')
    expect(body).not.toContain('Scan limited')
  })

  it('/flights: the same crowding does not hide the viewer\'s older flight', async () => {
    h = makeHarness()
    addFlight(h, 'fl-old', 'ag-a', 'OLDVISIBLEGOAL', ['squad-a'], 1)
    for (let i = 0; i < 101; i++) addFlight(h, `fl-other-${i}`, 'ag-b', `OTHERSQUAD${i}`, ['squad-b'], 1000 + i)
    const { body } = await get('/flights')
    expect(body).toContain('OLDVISIBLEGOAL')
    expect(body).not.toContain('OTHERSQUAD')
  })

  it('/status never says "All clear" for flights when the scan was capped: shows N+ and "Scan limited"', async () => {
    h = makeHarness()
    for (let i = 0; i < 105; i++) addFlight(h, `fl-many-${i}`, 'ag-a', `MANY${i}`, ['squad-a'], 1000 + i)
    const { body } = await get('/status')
    expect(chip(body, 'flights')).toBe('100+')
    expect(body).toContain('Running flights <span class="sv-n">100+</span>')
    expect(body).toContain('Scan limited')
  })

  it('a spent verification budget is reported as scan limited, not as an empty list', async () => {
    h = makeHarness()
    for (let i = 0; i < 150; i++) addFlight(h, `fl-b-${i}`, 'ag-a', `BUDGET${i}`, ['squad-a'], 1000 + i)
    const env = envFor(h)
    const spy = vi.spyOn(flightSpine, 'visibleFlight')
    const res = await visibleFlightsMod.visibleFlights(env, member(), { status: 'running', limit: 150 })
    // each flight costs 7 estimated queries; the budget stops the scan before all 150 are checked
    expect(spy.mock.calls.length).toBeLessThanOrEqual(Math.floor(visibleFlightsMod.VERIFY_QUERY_BUDGET / 7))
    expect(res.scanLimited).toBe(true)
  })

  it('per-request D1 statements stay bounded for a full page of flights', async () => {
    h = makeHarness()
    for (let i = 0; i < 100; i++) addFlight(h, `fl-q-${i}`, 'ag-a', `Q${i}`, ['squad-a'], 1000 + i)
    const env = envFor(h)
    let n = 0
    const prep = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, 'prepare').mockImplementation((q: string) => { n++; return prep(q) })
    await visibleFlightsMod.visibleFlights(env, member(), { limit: 100 })
    expect(n).toBeLessThan(900)
  })

  it('fails closed on /flights when visibleFlight throws: no flight rows, 503', async () => {
    h = makeHarness(); seedFlights(h)
    vi.spyOn(flightSpine, 'visibleFlight').mockRejectedValue(new Error('boom'))
    const { res, body } = await get('/flights')
    expect(res.status).toBe(503)
    expect(body).not.toContain('VISIBLEGOAL')
    expect(body).not.toContain('HIDDENSQUADGOAL')
  })

  it('fails closed on /status when visibleFlight throws: flights section unavailable, chip "?", nothing leaked', async () => {
    h = makeHarness(); seedFlights(h)
    vi.spyOn(flightSpine, 'visibleFlight').mockRejectedValue(new Error('boom'))
    const { res, body } = await get('/status')
    expect(res.status).toBe(200)
    expect(chip(body, 'flights')).toBe('?')
    expect(body).toContain('Running flights <span class="sv-n">?</span>')
    expect(body).not.toContain('VISIBLEGOAL')
    expect(body).not.toContain('HIDDENSQUADGOAL')
    expect(body).not.toContain('All clear</')
  })

  it('/status task and needs-you count chips show "?" (not 0) when their reader failed', async () => {
    h = makeHarness(); seedFlights(h)
    const env = envFor(h)
    const realBatch = env.DB.batch.bind(env.DB)
    vi.spyOn(env.DB, 'batch').mockImplementation(async (stmts) => {
      if (stmts.length === 2) throw new Error('boom')
      return realBatch(stmts)
    })
    authState.current = member()
    const body = await (await dashboardApp.fetch(new Request('https://pot.test/status'), env)).text()
    for (const label of ['P0', 'P1', 'in progress', 'blocked', 'in review']) expect(chip(body, label)).toBe('?')
    expect(chip(body, 'flights')).toBe('1')
  })

  it('/status hides the project name of a project the viewer cannot read (task still shows)', async () => {
    h = makeHarness()
    const { body } = await get('/status')
    expect(body).toContain('Visible task')
    expect(body).toContain('PROJA')
    expect(body).toContain('Cross project task')
    expect(body).not.toContain('HIDDENPROJNAME')
  })

  it('/status drops every project name when the project read check itself fails', async () => {
    h = makeHarness()
    const env = envFor(h)
    const prep = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, 'prepare').mockImplementation((q: string) => {
      if (q.includes('FROM projects p') && q.includes('json_each(?)')) throw new Error('boom')
      return prep(q)
    })
    authState.current = member()
    const body = await (await dashboardApp.fetch(new Request('https://pot.test/status'), env)).text()
    expect(body).toContain('Visible task')
    expect(body).not.toContain('PROJA')
    expect(body).not.toContain('HIDDENPROJNAME')
  })

  it('kanban matrix and squad views hide unreadable project names', async () => {
    h = makeHarness()
    const { loadKanbanData } = await import('../src/dashboard/kanban-routes')
    const env = envFor(h)
    const matrix = await loadKanbanData(env, member(), { view: 'matrix' })
    const squad = await loadKanbanData(env, member(), { squadIdOrSlug: 'squad-a' })
    for (const data of [matrix, squad]) {
      const json = JSON.stringify(data)
      expect(json).toContain('Cross project task')
      expect(json).toContain('PROJA')
      expect(json).not.toContain('HIDDENPROJNAME')
    }
  })

  it('approvals queue hides the project name of an unreadable project for a gate holder', async () => {
    h = makeHarness()
    h.sqlite.exec(`
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg-a', 'gate:content', 'member', 'member-a', 'owner', '2026-07-01T00:00:00.000Z');
      UPDATE tasks SET status = 'review', gate_owner = 'gate:content' WHERE id IN ('t-vis', 't-cross');
    `)
    const { loadApprovals } = await import('../src/dashboard/approvals')
    const q = await loadApprovals(envFor(h), member())
    const json = JSON.stringify(q)
    expect(json).toContain('Cross project task')
    expect(json).toContain('PROJA')
    expect(json).not.toContain('HIDDENPROJNAME')
  })
})
