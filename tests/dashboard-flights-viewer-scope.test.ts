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
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('squad-home-a', 'dept-a', 'home-a', 'HomeA', 'home'), ('squad-home-b', 'dept-b', 'home-b', 'HomeB', 'home');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-a', 'a@example.test', 'Member A', 'active', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', 'member-a', 'squad', 'squad-a', 'member');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-a', 'squad-a', 'ag-a', 'AGENTA', 'inactive'), ('ag-b', 'squad-b', 'ag-b', 'HIDDENAGENT', 'inactive');
    INSERT INTO projects (id, slug, name, status) VALUES ('proj-a', 'proj-a', 'PROJA', 'active'), ('proj-b', 'hidden-slug-b', 'HIDDENPROJNAME', 'active');
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

  const orgObserverWithHome = (): AuthContext => ({
    ...member(),
    capabilities: [
      { member_id: 'member-a', scope_type: 'org', scope_id: null, capability: 'observer' },
      { member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-home-a', capability: 'owner' as never },
    ],
  })

  it('an org observer keeps flights of their EXACT home-squad grant (no false "All clear")', async () => {
    h = makeHarness()
    addFlight(h, 'fl-home', 'ag-a', 'OWNHOMEGOAL', ['squad-home-a'], 1000)
    addFlight(h, 'fl-otherhome', 'ag-a', 'OTHERHOMEGOAL', ['squad-home-b'], 2000)
    for (const path of ['/status', '/flights']) {
      const { body } = await get(path, orgObserverWithHome())
      expect(body).toContain('OWNHOMEGOAL')
      expect(body).not.toContain('OTHERHOMEGOAL')
    }
  })

  it('a NON-admin org grant is not treated as workspace admin (another member\'s home squad stays hidden)', async () => {
    h = makeHarness(); seedFlights(h)
    addFlight(h, 'fl-otherhome', 'ag-a', 'OTHERHOMEGOAL', ['squad-home-b'], 2000)
    const orgObserver: AuthContext = { ...member(), capabilities: [{ member_id: 'member-a', scope_type: 'org', scope_id: null, capability: 'observer' }] }
    const { body } = await get('/flights', orgObserver)
    expect(body).toContain('VISIBLEGOAL')
    expect(body).not.toContain('OTHERHOMEGOAL')
  })

  it('visibleFlight stays the final word: a flight the SQL stage passes but visibleFlight rejects is dropped', async () => {
    h = makeHarness()
    addFlight(h, 'fl-ok', 'ag-a', 'KEEPGOAL', ['squad-a'], 1000)
    addFlight(h, 'fl-veto', 'ag-a', 'VETOGOAL', ['squad-a'], 2000)
    const real = flightSpine.visibleFlight
    vi.spyOn(flightSpine, 'visibleFlight').mockImplementation(async (e, a, id) => (id === 'fl-veto' ? null : real(e, a, id)))
    const res = await visibleFlightsMod.visibleFlights(envFor(h), member())
    expect(res.rows.map((r) => r.id)).toEqual(['fl-ok'])
  })

  it('scanLimited is exactly "more matched than limit AND fewer than limit survived"', async () => {
    h = makeHarness()
    for (let i = 0; i < 4; i++) addFlight(h, `fl-s${i}`, 'ag-a', `S${i}`, ['squad-a'], 1000 + i)
    const env = envFor(h)
    const full = await visibleFlightsMod.visibleFlights(env, member(), { limit: 2 })
    expect(full).toMatchObject({ more: true, scanLimited: false }) // page is full: more is not a loss
    const real = flightSpine.visibleFlight
    vi.spyOn(flightSpine, 'visibleFlight').mockImplementation(async (e, a, id) => (id === 'fl-s3' ? null : real(e, a, id)))
    const short = await visibleFlightsMod.visibleFlights(env, member(), { limit: 3 })
    expect(short.rows).toHaveLength(2)
    expect(short).toMatchObject({ more: true, scanLimited: true })
    const exact = await visibleFlightsMod.visibleFlights(env, member(), { limit: 10 })
    expect(exact).toMatchObject({ more: false, scanLimited: false })
  })

  it('/flights reports a partial list when more flights matched than shown', async () => {
    h = makeHarness()
    for (let i = 0; i < 101; i++) addFlight(h, `fl-p${i}`, 'ag-a', `P${i}`, ['squad-a'], 1000 + i)
    const { body } = await get('/flights')
    expect(body).toContain('Flight history is partial')
  })

  it('names of an agent/squad the viewer cannot observe are not shown on a visible flight', async () => {
    h = makeHarness()
    addFlight(h, 'fl-x', 'ag-b', 'CROSSAGENTGOAL', ['squad-a'], 1000)
    for (const path of ['/flights', '/status']) {
      const { body } = await get(path)
      expect(body).toContain('CROSSAGENTGOAL')
      expect(body).not.toContain('HIDDENAGENT')
      expect(body).not.toContain('>Beta<')
    }
  })

  it('/flights?project_id= applies the same squad and home-squad checks', async () => {
    h = makeHarness()
    // org observer reads every project (readableSquadIds === null): home/mixed-squad flights must still be dropped
    addFlight(h, 'fl-pa', 'ag-a', 'PROJVISIBLE', ['squad-a'], 1000, { project: 'proj-a' })
    addFlight(h, 'fl-pa-mixed', 'ag-a', 'PROJMIXED', ['squad-a', 'squad-home-b'], 2000, { project: 'proj-a' })
    addFlight(h, 'fl-pa-home', 'ag-a', 'PROJOTHERHOME', ['squad-home-b'], 3000, { project: 'proj-a' })
    const orgObserver: AuthContext = { ...member(), capabilities: [{ member_id: 'member-a', scope_type: 'org', scope_id: null, capability: 'observer' }] }
    const { res, body } = await get('/flights?project_id=proj-a', orgObserver)
    expect(res.status).toBe(200)
    expect(body).toContain('PROJVISIBLE')
    expect(body).not.toContain('PROJMIXED')
    expect(body).not.toContain('PROJOTHERHOME')
  })

  it('/studio lists only flights the viewer may see', async () => {
    h = makeHarness(); seedFlights(h)
    const { loadStudioData } = await import('../src/dashboard/studio')
    const data = await loadStudioData(envFor(h), member())
    const goals = data.flights.map((f) => f.goal)
    expect(goals).toContain('VISIBLEGOAL')
    for (const g of ['HIDDENSQUADGOAL', 'HIDDENPROJGOAL', 'MIXEDSQUADGOAL']) expect(goals).not.toContain(g)
  })

  it('/studio shows no flights when the visibility check throws', async () => {
    h = makeHarness(); seedFlights(h)
    vi.spyOn(flightSpine, 'visibleFlight').mockRejectedValue(new Error('boom'))
    const { loadStudioData } = await import('../src/dashboard/studio')
    expect((await loadStudioData(envFor(h), member())).flights).toEqual([])
  })

  it('radar requires EVERY squad of a flight and a readable project', async () => {
    h = makeHarness(); seedFlights(h)
    addFlight(h, 'fl-ok2', 'ag-a', 'RADARVISIBLE', ['squad-a'], 500) // oldest: radar shows each agent's newest flight, so unfiltered hidden ones would shadow it
    const { loadFleetRadar } = await import('../src/dashboard/radar')
    const radar = JSON.stringify(await loadFleetRadar(envFor(h), 10_000, ['squad-a'], member()))
    expect(radar).toContain('VISIBLEGOAL') // the agent's newest VISIBLE flight (hidden newer ones must not shadow it)
    expect(radar).toContain('"active_flight_count":2')
    expect(radar).not.toContain('MIXEDSQUADGOAL')
    expect(radar).not.toContain('HIDDENPROJGOAL')
    expect(radar).not.toContain('HIDDENSQUADGOAL')
  })

  it('loadAsks hides the project name of an unreadable project', async () => {
    h = makeHarness()
    h.sqlite.exec(`UPDATE tasks SET status = 'review', gate_owner = 'gate:content', assignee_member_id = 'member-a' WHERE id = 't-cross'`)
    const { loadAsks } = await import('../src/dashboard/approvals')
    const asks = await loadAsks(envFor(h), member())
    expect(asks.map((a) => a.id)).toContain('t-cross')
    expect(JSON.stringify(asks)).not.toContain('HIDDENPROJNAME')
  })

  it('kanban: no project_slug beside a nulled name, and a hidden project is not returned by slug or id', async () => {
    h = makeHarness()
    const { loadKanbanData } = await import('../src/dashboard/kanban-routes')
    const env = envFor(h)
    for (const data of [await loadKanbanData(env, member(), { view: 'matrix' }), await loadKanbanData(env, member(), { squadIdOrSlug: 'squad-a' })]) {
      expect(JSON.stringify(data)).not.toContain('hidden-slug-b')
      expect(JSON.stringify(data)).toContain('proj-a') // a readable project's slug still ships
    }
    for (const ref of ['hidden-slug-b', 'proj-b']) {
      const data = await loadKanbanData(env, member(), { projectIdOrSlug: ref })
      expect(data.project).toBeNull()
      expect(JSON.stringify(data)).not.toContain('HIDDENPROJNAME')
    }
    const ok = await loadKanbanData(env, member(), { projectIdOrSlug: 'proj-a' })
    expect(ok.project?.id).toBe('proj-a')
  })
})
