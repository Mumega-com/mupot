import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (c: { get: (key: 'auth') => AuthContext | undefined; set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response }, next: () => Promise<void>) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { projectsApp } = await import('../src/projects')

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(options: { includeRoutineMigrations?: boolean } = {}): SqliteD1Harness {
  const includeRoutineMigrations = options.includeRoutineMigrations !== false
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    if (
      !includeRoutineMigrations
      // 0158 rebuilds routine_run_actions (FP-01 Slice 2, mupot#1443: widens
      // its kind CHECK to admit 'project_access') and depends on 0073's table
      // existing, so it belongs in the SAME "routine tables absent" exclusion
      // group as 0073/0074, or this rolling-deploy simulation breaks with
      // "no such table: routine_run_actions" instead of exercising the
      // degrade-to-empty path this test is actually about.
      // 0172 (mupot#1540) likewise references routine_runs (its tasks.status triggers and
      // backfill leave routine control flights to their routine), so it joins this group.
      && (file.startsWith('0073_') || file.startsWith('0074_') || file.startsWith('0158_') || file.startsWith('0172_'))
    ) {
      continue
    }
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO departments (id, slug, name) VALUES ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-b', 'squad-b', 'Squad B');
  `)
  return harness
}

let bindBudget: number | undefined

function bindBudgetDb(db: D1Database, maximum: number): D1Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver)
      return (sql: string): D1PreparedStatement => {
        const statement = target.prepare(sql)
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== 'bind') return Reflect.get(statementTarget, statementProperty, statementReceiver)
            return (...values: unknown[]): D1PreparedStatement => {
              if (values.length > maximum) {
                throw new Error(`D1 bind budget exceeded: ${values.length} > ${maximum}`)
              }
              return statementTarget.bind(...values)
            }
          },
        })
      }
    },
  })
}

function envFor(harness: SqliteD1Harness): Env {
  const db = bindBudget === undefined ? harness.db : bindBudgetDb(harness.db, bindBudget)
  return { DB: db, TENANT_SLUG: 'pot-a' } as Env
}

function as(auth: AuthContext | null): void {
  authState.current = auth
}

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    email: null,
    role: 'member',
    tenant: 'pot-a',
    ...overrides,
  }
}

function request(path: string, method = 'GET', body?: unknown, origin = 'https://pot.test'): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { Origin: origin }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function fetch(harness: SqliteD1Harness, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return projectsApp.fetch(request(path, method, body), envFor(harness))
}

function seedProjects(harness: SqliteD1Harness): void {
  harness.sqlite.exec(`
    INSERT INTO projects (id, slug, name, status) VALUES ('parent', 'parent', 'Parent', 'active');
    INSERT INTO projects (id, slug, name, status, parent_project_id) VALUES ('visible-child', 'visible-child', 'Visible child', 'active', 'parent');
    INSERT INTO projects (id, slug, name, status, parent_project_id) VALUES ('hidden-child', 'hidden-child', 'Hidden child', 'active', 'parent');
    INSERT INTO projects (id, slug, name, status) VALUES ('other-root', 'other-root', 'Other root', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('visible-child', 'squad-a', 'write');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('hidden-child', 'squad-b', 'write');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('other-root', 'squad-b', 'read');
    INSERT INTO tasks (id, squad_id, title, status, project_id) VALUES ('visible-task', 'squad-a', 'Visible work', 'open', 'visible-child');
    INSERT INTO tasks (id, squad_id, title, status, project_id) VALUES ('hidden-task', 'squad-b', 'Hidden work', 'open', 'hidden-child');
  `)
  const insertFlight = harness.sqlite.prepare(
    "INSERT INTO flights (id, tenant, agent, goal, status, project_id, meta) VALUES (?, 'pot-a', ?, ?, 'running', ?, ?)",
  )
  insertFlight.run('visible-flight', 'agent-a', 'Visible flight', 'visible-child', flightMeta(['squad-a']))
  insertFlight.run('hidden-flight', 'agent-b', 'Hidden flight', 'hidden-child', flightMeta(['squad-b'], ['hidden-task']))
  harness.sqlite.exec(`
    UPDATE project_squad_access SET access_level = 'read'
     WHERE project_id IN ('visible-child', 'hidden-child');
  `)
}

function flightMeta(squadIds: string[], taskIds = ['visible-task']): string {
  return JSON.stringify({
    schema: 'mupot.flight.meta/v1',
    goal_id: 'goal-1',
    objective_id: 'objective-1',
    squad_ids: squadIds,
    task_ids: taskIds,
    done_when: ['Done'],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
  })
}

describe('projectsApp', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    bindBudget = undefined
    harness?.close()
    harness = undefined
  })

  it('keeps ordinary Project REST reads healthy when migration 0073 tables are absent', async () => {
    harness = makeHarness({ includeRoutineMigrations: false })
    seedProjects(harness)
    as(actor({
      memberId: 'member-a',
      capabilities: [{ member_id: 'member-a', scope_type: 'department', scope_id: 'dept-a', capability: 'member' }],
    }))

    const detail = await fetch(harness, '/visible-child')
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      project: { id: 'visible-child' },
      situation: {
        health: 'active',
        routines: {
          enabled_count: 0,
          paused_count: 0,
          next: null,
          active_run: null,
          latest_terminal_run: null,
        },
        active_work_count: 1,
        next_action: { type: 'start_task', task: { id: 'visible-task' } },
      },
    })
  })

  it('rejects unauthenticated and cross-tenant requests before project access', async () => {
    harness = makeHarness()
    expect((await fetch(harness, '/')).status).toBe(401)
    expect((await fetch(harness, '/health')).status).toBe(401)

    as(actor({ tenant: 'other-pot', role: 'owner' }))
    const response = await fetch(harness, '/')
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden', reason: 'tenant_scope' })
    expect((await fetch(harness, '/health')).status).toBe(403)
  })

  it('rejects cross-origin project mutations', async () => {
    harness = makeHarness()
    as(actor({ role: 'owner' }))
    const response = await projectsApp.fetch(
      request('/', 'POST', { slug: 'blocked-origin', name: 'Blocked origin' }, 'https://attacker.test'),
      envFor(harness),
    )
    expect(response.status).toBe(403)
  })

  it('lets an owner list, create, update, and administer explicit squad edges', async () => {
    harness = makeHarness()
    as(actor({ role: 'owner' }))

    const created = await fetch(harness, '/', 'POST', { slug: 'launch', name: 'Launch' })
    expect(created.status).toBe(201)
    const project = (await created.json() as { project: { id: string; slug: string } }).project

    expect((await fetch(harness, `/${project.id}/squads/squad-a`, 'PUT', { access_level: 'write' })).status).toBe(200)
    await expect((await fetch(harness, `/${project.id}/squads`)).json()).resolves.toMatchObject({ squads: [{ squad_id: 'squad-a', access_level: 'write' }] })
    expect((await fetch(harness, `/${project.id}`, 'PATCH', { name: 'Launch now' })).status).toBe(200)
    expect((await fetch(harness, `/${project.id}/squads/squad-a`, 'DELETE')).status).toBe(204)
    await expect((await fetch(harness, '/')).json()).resolves.toMatchObject({ projects: [{ id: project.id, slug: 'launch', name: 'Launch now' }] })
  })

  it('maps invalid transitions to conflict and restores archived projects to planned through the shared service', async () => {
    harness = makeHarness()
    harness.sqlite.exec(
      "INSERT INTO projects (id, slug, name, status) VALUES ('archived', 'archived', 'Archived', 'archived')",
    )
    as(actor({ role: 'owner' }))

    const invalid = await fetch(harness, '/archived', 'PATCH', { status: 'active' })
    expect(invalid.status).toBe(409)
    await expect(invalid.json()).resolves.toEqual({ error: 'invalid_status_transition' })

    const response = await fetch(harness, '/archived', 'PATCH', { status: 'planned' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ project: { id: 'archived', status: 'planned' } })
  })

  it('only gives a member the explicitly readable project and its needed parent context', async () => {
    harness = makeHarness()
    seedProjects(harness)
    as(actor({
      memberId: 'member-a',
      capabilities: [{ member_id: 'member-a', scope_type: 'department', scope_id: 'dept-a', capability: 'member' }],
    }))

    const list = await fetch(harness, '/')
    expect(list.status).toBe(200)
    const listed = await list.json() as { projects: Array<{ id: string; parent_context?: boolean }> }
    expect(listed.projects.map((project) => project.id)).toEqual(['parent', 'visible-child'])
    expect(listed.projects.find((project) => project.id === 'parent')).toMatchObject({ parent_context: true })
    expect(listed.projects.find((project) => project.id === 'parent')).not.toHaveProperty('description')
    expect(listed.projects.find((project) => project.id === 'parent')).not.toHaveProperty('goal')
    expect(listed.projects.find((project) => project.id === 'parent')).not.toHaveProperty('target_date')

    const detail = await fetch(harness, '/visible-child')
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      project: { id: 'visible-child', parent_project_id: 'parent' },
      aggregates: { direct_tasks: 1, direct_squads: 1, direct_flights: 1 },
      situation: {
        health: 'active',
        blockers: [],
        pending_reviews: [],
        active_work_count: 1,
        active_flight_count: 1,
        next_action: { type: 'start_task', task: { id: 'visible-task' } },
      },
      parent: { id: 'parent' },
    })
    const detailBody = await (await fetch(harness, '/visible-child')).json() as { parent: Record<string, unknown> }
    expect(detailBody.parent).toEqual({ id: 'parent', slug: 'parent', name: 'Parent', status: 'active', parent_project_id: null })
    expect((await fetch(harness, '/hidden-child')).status).toBe(404)
    expect((await fetch(harness, '/other-root')).status).toBe(404)
    expect((await fetch(harness, '/hidden-child/squads')).status).toBe(404)
  })

  it('keeps REST visibility below the D1 bind budget with more than 150 squad and department grants', async () => {
    harness = makeHarness()
    seedProjects(harness)
    bindBudget = 100
    const capabilities = [
      ...Array.from({ length: 160 }, (_, index) => ({
        member_id: 'member-many',
        scope_type: 'squad' as const,
        scope_id: index === 159 ? 'squad-a' : `unused-squad-${index}`,
        capability: 'member' as const,
      })),
      ...Array.from({ length: 160 }, (_, index) => ({
        member_id: 'member-many',
        scope_type: 'department' as const,
        scope_id: index === 159 ? 'dept-a' : `unused-department-${index}`,
        capability: 'member' as const,
      })),
    ]
    as(actor({ memberId: 'member-many', capabilities }))

    const list = await fetch(harness, '/')
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      projects: [{ id: 'parent', parent_context: true }, { id: 'visible-child' }],
    })
    expect((await fetch(harness, '/visible-child')).status).toBe(200)
    await expect((await fetch(harness, '/visible-child/squads')).json()).resolves.toMatchObject({
      squads: [{ squad_id: 'squad-a' }],
    })
  })

  it('keeps the last department-granted squad readable beyond 1000 squads', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('bulk-dept', 'bulk-dept', 'Bulk Department');
      WITH RECURSIVE seq(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 1000
      )
      INSERT INTO squads (id, department_id, slug, name)
      SELECT 'bulk-' || printf('%04d', n), 'bulk-dept', 'bulk-' || printf('%04d', n), 'Bulk ' || n FROM seq;
      INSERT INTO projects (id, slug, name, status) VALUES ('bulk-project', 'bulk-project', 'Bulk Project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('bulk-project', 'bulk-1000', 'write');
      INSERT INTO tasks (id, squad_id, title, status, project_id)
      VALUES ('bulk-last-task', 'bulk-1000', 'Last readable task', 'open', 'bulk-project');
    `)
    as(actor({
      memberId: 'bulk-reader',
      capabilities: [
        { member_id: 'bulk-reader', scope_type: 'department', scope_id: 'bulk-dept', capability: 'member' },
      ],
    }))

    await expect((await fetch(harness, '/bulk-project')).json()).resolves.toMatchObject({
      project: { id: 'bulk-project' },
      situation: {
        health: 'active',
        active_work_count: 1,
        next_action: { type: 'start_task', task: { id: 'bulk-last-task' } },
      },
    })
  })

  it('scopes member aggregates to readable squads and canonical all-readable flights', async () => {
    harness = makeHarness()
    seedProjects(harness)
    harness.sqlite.exec(`
      UPDATE project_squad_access SET access_level = 'write'
       WHERE project_id = 'visible-child' AND squad_id = 'squad-a';
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('visible-child', 'squad-b', 'write');
      INSERT INTO tasks (id, squad_id, title, status, project_id)
      VALUES ('private-task', 'squad-b', 'Private work', 'open', 'visible-child');
    `)
    harness.sqlite.prepare(
      "UPDATE flights SET meta = ? WHERE id = 'visible-flight'",
    ).run(flightMeta(['squad-a']))
    const insertFlight = harness.sqlite.prepare(
      "INSERT INTO flights (id, tenant, agent, goal, status, project_id, meta) VALUES (?, 'pot-a', 'agent-a', 'Aggregate test', 'running', 'visible-child', ?)",
    )
    insertFlight.run('private-flight', flightMeta(['squad-b'], ['private-task']))
    insertFlight.run('mixed-flight', flightMeta(['squad-a', 'squad-b'], ['visible-task', 'private-task']))
    insertFlight.run('malformed-flight', JSON.stringify({ schema: 'mupot.flight.meta/v0', squad_ids: ['squad-a'] }))
    insertFlight.run('legacy-flight', JSON.stringify({ squad_ids: ['squad-a'] }))
    insertFlight.run('js-whitespace-flight', JSON.stringify({
      ...JSON.parse(flightMeta(['squad-a'])),
      goal_id: '\u00a0',
    }))
    harness.sqlite.exec(`
      UPDATE project_squad_access SET access_level = 'read'
       WHERE project_id = 'visible-child';
    `)

    as(actor({
      memberId: 'member-a',
      capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    }))
    await expect((await fetch(harness, '/visible-child')).json()).resolves.toMatchObject({
      aggregates: { direct_tasks: 1, direct_squads: 1, direct_flights: 1 },
      situation: {
        health: 'active',
        blockers: [],
        active_work_count: 1,
        active_flight_count: 1,
      },
    })

    as(actor({ role: 'admin' }))
    await expect((await fetch(harness, '/visible-child')).json()).resolves.toMatchObject({
      aggregates: { direct_tasks: 2, direct_squads: 2, direct_flights: 6 },
    })

    as(actor({
      memberId: 'org-reader',
      capabilities: [{ member_id: 'org-reader', scope_type: 'org', scope_id: null, capability: 'observer' }],
    }))
    await expect((await fetch(harness, '/visible-child')).json()).resolves.toMatchObject({
      aggregates: { direct_tasks: 2, direct_squads: 2, direct_flights: 6 },
    })
  })

  it('mupot#1583 round 1 (P0): a bare authenticated email, with no memberId already resolved, grants NOTHING — see the dedicated describe block below', async () => {
    // This test used to assert the OPPOSITE: that a plain `auth.email` (no memberId) would
    // resolve to whatever `members` row matched it and inherit that row's capabilities. That
    // was mupot#1578/#1583's own defect class — a request-time handler re-deriving identity
    // from bare email instead of trusting only what the cookie loader (loadAuthFromCookie,
    // src/auth/index.ts) already resolved under guard. `sessionMemberId` (src/auth/capability.ts)
    // now reads ONLY `auth.memberId ?? auth.webSessionMemberId` — an email with neither set
    // gets an empty list, full stop, regardless of what any `members` row says. See
    // "grantsFor never re-derives identity from bare email" below for the full regression
    // suite (squatted row, owner_login_emails alias, and the two ways a legitimately
    // identified session — memberId or webSessionMemberId — stays unaffected).
    harness = makeHarness()
    seedProjects(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, tenant) VALUES ('member-a', 'member-a@pot.test', 'Member A', 'pot-a');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('member-a-observer', 'member-a', 'squad', 'squad-a', 'observer');
    `)
    as(actor({ email: 'member-a@pot.test' }))

    const response = await fetch(harness, '/')
    await expect(response.json()).resolves.toMatchObject({ projects: [] })
  })

  it('honors exact squad edges plus org capability administration without trusting request identity', async () => {
    harness = makeHarness()
    seedProjects(harness)
    as(actor({
      memberId: 'member-admin',
      capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }))

    expect((await fetch(harness, '/visible-child', 'PATCH', { goal: 'Only auth identity', member_id: 'someone-else' })).status).toBe(200)
    expect((await fetch(harness, '/visible-child/squads/squad-b', 'PUT', { access_level: 'admin', member_id: 'someone-else' })).status).toBe(200)
    expect((await fetch(harness, '/hidden-child')).status).toBe(200)
  })

  it('lets an authenticated org admin see all projects, including projects without squad edges', async () => {
    harness = makeHarness()
    seedProjects(harness)
    harness.sqlite.exec("INSERT INTO projects (id, slug, name, status) VALUES ('ungoverned', 'ungoverned', 'Ungoverned', 'active')")
    as(actor({
      memberId: 'member-admin',
      capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }))

    const body = await (await fetch(harness, '/')).json() as { projects: Array<{ id: string }> }
    expect(body.projects.map((project) => project.id)).toContain('ungoverned')
  })

  it('does not let a coarse owner role override an explicit restricted capability set', async () => {
    harness = makeHarness()
    as(actor({ role: 'owner', capabilities: [] }))

    const restricted = await fetch(harness, '/', 'POST', { slug: 'restricted-owner', name: 'Restricted owner' })
    expect(restricted.status).toBe(403)
    await expect(restricted.json()).resolves.toEqual({ error: 'forbidden', need: 'admin' })

    as(actor({ role: 'owner', capabilities: undefined }))
    expect((await fetch(harness, '/', 'POST', { slug: 'legacy-owner', name: 'Legacy owner' })).status).toBe(201)
  })

  it('returns only readable squad edges to non-admins and all edges to workspace admins', async () => {
    harness = makeHarness()
    seedProjects(harness)
    harness.sqlite.exec("INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('visible-child', 'squad-b', 'admin')")
    as(actor({
      memberId: 'member-a',
      capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'observer' }],
    }))
    await expect((await fetch(harness, '/visible-child/squads')).json()).resolves.toMatchObject({
      squads: [{ squad_id: 'squad-a', access_level: 'read' }],
    })

    as(actor({ role: 'admin' }))
    const adminEdges = await (await fetch(harness, '/visible-child/squads')).json() as { squads: Array<{ squad_id: string }> }
    expect(adminEdges.squads.map((edge) => edge.squad_id)).toEqual(['squad-a', 'squad-b'])
  })

  it('bounds list pagination with a capped cursor and stable next cursor', async () => {
    harness = makeHarness()
    seedProjects(harness)
    as(actor({ role: 'owner' }))

    const first = await fetch(harness, '/?limit=1')
    const firstBody = await first.json() as { projects: Array<{ id: string }>; next_cursor: string | null }
    expect(firstBody.projects).toHaveLength(1)
    expect(firstBody.next_cursor).toBe('1')
    expect((await fetch(harness, `/?limit=1&cursor=${firstBody.next_cursor}`)).status).toBe(200)
    expect((await fetch(harness, '/?limit=101')).status).toBe(400)
    expect((await fetch(harness, '/?cursor=10001')).status).toBe(400)
    expect((await fetch(harness, '/?cursor=1e2')).status).toBe(400)
  })

  it('does not emit cursors beyond the maximum offset for project and squad pages', async () => {
    harness = makeHarness()
    seedProjects(harness)
    harness.sqlite.exec(`
      WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x + 1 FROM n WHERE x < 10100)
      INSERT INTO projects (id, slug, name, status)
      SELECT printf('page-%05d', x), printf('page-%05d', x), printf('Page %05d', x), 'active' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x + 1 FROM n WHERE x < 10100)
      INSERT INTO squads (id, department_id, slug, name)
      SELECT printf('page-squad-%05d', x), 'dept-a', printf('page-squad-%05d', x), printf('Page squad %05d', x) FROM n;
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      SELECT 'visible-child', id, 'read' FROM squads WHERE id LIKE 'page-squad-%';
    `)
    as(actor({ role: 'owner' }))

    const projects = await (await fetch(harness, '/?cursor=10000&limit=100')).json() as { next_cursor: string | null }
    const squads = await (await fetch(harness, '/visible-child/squads?cursor=10000&limit=100')).json() as { next_cursor: string | null }
    expect(projects.next_cursor).toBeNull()
    expect(squads.next_cursor).toBeNull()
  })

  it('continues Activity and Evidence beyond the legacy maximum offset', async () => {
    harness = makeHarness()
    seedProjects(harness)
    harness.sqlite.exec(`
      UPDATE project_squad_access SET access_level = 'write'
       WHERE project_id = 'visible-child' AND squad_id = 'squad-a';
      WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x + 1 FROM n WHERE x < 10100)
      INSERT INTO tasks (id, squad_id, title, status, project_id, result, completed_at)
      SELECT printf('history-%05d', x), 'squad-a', printf('History %05d', x), 'done',
             'visible-child', printf('Result %05d', x), datetime('now')
        FROM n;
      UPDATE project_squad_access SET access_level = 'read'
       WHERE project_id = 'visible-child' AND squad_id = 'squad-a';
    `)
    as(actor({ role: 'owner' }))

    const activity = await (await fetch(
      harness,
      '/visible-child/activity?cursor=10000&limit=100',
    )).json() as { rows: Array<{ source_id: string }>; next_cursor: string | null }
    const evidence = await (await fetch(
      harness,
      '/visible-child/evidence?cursor=10000&limit=100',
    )).json() as { rows: Array<{ source_id: string }>; next_cursor: string | null }

    expect(activity.next_cursor).not.toBeNull()
    expect(evidence.next_cursor).not.toBeNull()
    expect(activity.next_cursor).not.toMatch(/^\d+$/)
    expect(evidence.next_cursor).not.toMatch(/^\d+$/)

    const nextActivity = await (await fetch(
      harness,
      `/visible-child/activity?cursor=${encodeURIComponent(activity.next_cursor!)}&limit=100`,
    )).json() as { rows: Array<{ source_id: string }> }
    const nextEvidence = await (await fetch(
      harness,
      `/visible-child/evidence?cursor=${encodeURIComponent(evidence.next_cursor!)}&limit=100`,
    )).json() as { rows: Array<{ source_id: string }> }
    expect(nextActivity.rows.length).toBeGreaterThan(0)
    expect(nextEvidence.rows.length).toBeGreaterThan(0)
    expect(nextActivity.rows.some((row) => activity.rows.some((seen) => seen.source_id === row.source_id))).toBe(false)
    expect(nextEvidence.rows.some((row) => evidence.rows.some((seen) => seen.source_id === row.source_id))).toBe(false)
  })

  it('paginates Activity and Evidence through their returned cursors', async () => {
    harness = makeHarness()
    seedProjects(harness)
    harness.sqlite.exec(`
      UPDATE project_squad_access SET access_level = 'write'
       WHERE project_id = 'visible-child' AND squad_id = 'squad-a';
      INSERT INTO tasks (id, squad_id, title, status, project_id, result, completed_at, created_at, updated_at)
      VALUES
        ('history-new', 'squad-a', 'New history', 'done', 'visible-child', 'New result', '2026-07-18T21:00:00Z', '2026-07-18T21:00:00Z', '2026-07-18T21:00:00Z'),
        ('history-old', 'squad-a', 'Old history', 'done', 'visible-child', 'Old result', '2026-07-18T20:00:00Z', '2026-07-18T20:00:00Z', '2026-07-18T20:00:00Z');
      UPDATE project_squad_access SET access_level = 'read'
       WHERE project_id = 'visible-child' AND squad_id = 'squad-a';
    `)
    as(actor({ role: 'owner' }))

    for (const projection of ['activity', 'evidence']) {
      const first = await (await fetch(
        harness,
        `/visible-child/${projection}?limit=1`,
      )).json() as { rows: Array<{ source_id: string }>; next_cursor: string | null }
      expect(first.rows).toHaveLength(1)
      expect(first.next_cursor).not.toBeNull()
      expect(first.next_cursor).not.toMatch(/^\d+$/)

      const second = await (await fetch(
        harness,
        `/visible-child/${projection}?limit=1&cursor=${first.next_cursor}`,
      )).json() as { rows: Array<{ source_id: string }> }
      expect(second.rows).toHaveLength(1)
      expect(second.rows[0]?.source_id).not.toBe(first.rows[0]?.source_id)
    }
  })

  it('rejects malformed and cross-projection opaque cursors', async () => {
    harness = makeHarness()
    seedProjects(harness)
    as(actor({ role: 'owner' }))

    const activity = await (await fetch(
      harness,
      '/visible-child/activity?limit=1',
    )).json() as { next_cursor: string | null }
    expect(activity.next_cursor).not.toBeNull()
    expect((await fetch(
      harness,
      `/visible-child/evidence?limit=1&cursor=${encodeURIComponent(activity.next_cursor!)}`,
    )).status).toBe(400)
    expect((await fetch(harness, '/visible-child/activity?cursor=not-a-valid-cursor')).status).toBe(400)
  })

  it('mounts projects before the dashboard catch-all', () => {
    const root = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(root.indexOf('app.route(ROUTES.projects, projectsApp)')).toBeGreaterThan(-1)
    expect(root.indexOf('app.route(ROUTES.projects, projectsApp)')).toBeLessThan(root.indexOf('app.route(ROUTES.dashboard, dashboardApp)'))
  })

  it('returns stable validation, forbidden, hidden, missing, and conflict responses', async () => {
    harness = makeHarness()
    seedProjects(harness)
    as(actor({ memberId: 'member-a', capabilities: [{ member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'observer' }] }))
    expect((await fetch(harness, '/', 'POST', { slug: 'nope', name: 'Nope' })).status).toBe(403)
    expect((await fetch(harness, '/?status=not-a-status')).status).toBe(400)
    expect((await fetch(harness, '/?parent_id=')).status).toBe(400)
    expect((await fetch(harness, '/missing')).status).toBe(404)

    as(actor({ role: 'admin' }))
    expect((await fetch(harness, '/', 'POST', { slug: 'Bad Slug', name: 'Invalid' })).status).toBe(400)
    expect((await fetch(harness, '/', 'POST', { slug: 'parent', name: 'Duplicate' })).status).toBe(409)
    expect((await fetch(harness, '/missing', 'PATCH', { name: 'Missing' })).status).toBe(404)
    expect((await fetch(harness, '/visible-child/squads/missing', 'PUT', { access_level: 'write' })).status).toBe(404)
    expect((await fetch(harness, '/visible-child/squads/squad-b', 'DELETE')).status).toBe(404)
  })

  describe('grantsFor never re-derives identity from bare email (mupot#1578, mupot#1583 round 1 P0)', () => {
    // mupot#1583 round 1: routing memberIdFor through resolveHumanMemberId(email-only)
    // (this PR's OWN #1578 fix, one round earlier) opened a WORSE hole than it closed —
    // the resolver's email-only branch walked all the way to its step 4
    // (owner_login_emails -> the unique org owner), so a plain member logging in via an
    // email address the org happens to register as an owner alias inherited the owner's
    // private project access, with no join key (no OAuth identity) ever checked for that
    // request. The fix is not a better email check — it is deleting the email path from
    // grantsFor entirely: `sessionMemberId(auth)` (src/auth/capability.ts) reads ONLY
    // `auth.memberId ?? auth.webSessionMemberId`, exactly what the cookie loader
    // (loadAuthFromCookie, src/auth/index.ts) already resolved under guard at
    // session-load time. A session that carries `auth.email` but neither field set — an
    // identity attach that was refused, denied, or simply never ran — gets NOTHING here,
    // regardless of what any DB row keyed by that email says.
    function seedMemberRow(
      harness: SqliteD1Harness,
      id: string,
      email: string,
      opts: { withLiveBearer?: boolean } = {},
    ): void {
      harness.sqlite
        .prepare(
          `INSERT INTO members (id, tenant, email, display_name, status, created_at)
           VALUES (?, 'pot-a', ?, ?, 'active', datetime('now'))`,
        )
        .run(id, email, id)
      harness.sqlite
        .prepare(
          `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
           VALUES (?, ?, 'org', NULL, 'admin')`,
        )
        .run(crypto.randomUUID(), id)
      if (opts.withLiveBearer) {
        harness.sqlite
          .prepare(
            `INSERT INTO member_tokens
               (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at, revoked_at)
             VALUES (?, ?, ?, 'workspace', 'workspace', datetime('now'), NULL, 'pot-a', NULL, NULL)`,
          )
          .run(crypto.randomUUID(), id, crypto.randomUUID())
      }
    }

    it('a squatted row (live bearer + org-admin grant) grants nothing to an email-only session — GET empty, PATCH 403', async () => {
      harness = makeHarness()
      seedProjects(harness)
      seedMemberRow(harness, 'squatter', 'victim@pot.test', { withLiveBearer: true })
      // Identity attach for this login was already refused elsewhere (decideIdentitylessAttach
      // denied the live bearer) — auth carries the verified email but NO memberId/capabilities,
      // exactly what loadAuthFromCookie leaves on a denial.
      as(actor({ email: 'victim@pot.test' }))

      const list = await fetch(harness, '/')
      expect(list.status).toBe(200)
      await expect(list.json()).resolves.toMatchObject({ projects: [] })

      const patch = await fetch(harness, '/visible-child', 'PATCH', { name: 'Pwned' })
      expect(patch.status).toBe(403)
      await expect(patch.json()).resolves.toMatchObject({ error: 'forbidden', need: 'admin' })
    })

    it('mupot#1583 P0: an owner_login_emails alias session (no members row for the alias at all) gets nothing — GET empty, PATCH 403', async () => {
      harness = makeHarness()
      seedProjects(harness)
      // The REAL org owner: a distinct member row/email, holding org-owner capability and
      // a private project of their own.
      seedMemberRow(harness, 'real-owner', 'owner@pot.test', { withLiveBearer: false })
      harness.sqlite.exec(`
        INSERT INTO org_settings (key, value) VALUES ('owner_login_emails', '["alias@pot.test"]');
      `)
      // The session: an email login as the ALIAS address. No members row exists for
      // 'alias@pot.test' at all — the only way this could ever resolve to the owner is via
      // the resolver's (now-deleted) step 4. auth.memberId/webSessionMemberId are unset,
      // exactly what a real cookie-loaded session for this login would carry.
      as(actor({ email: 'alias@pot.test' }))

      const list = await fetch(harness, '/')
      expect(list.status).toBe(200)
      await expect(list.json()).resolves.toMatchObject({ projects: [] })

      const patch = await fetch(harness, '/visible-child', 'PATCH', { name: 'Pwned' })
      expect(patch.status).toBe(403)
      await expect(patch.json()).resolves.toMatchObject({ error: 'forbidden', need: 'admin' })
    })

    it('an identified member (auth.memberId already resolved by the cookie loader) is unaffected', async () => {
      harness = makeHarness()
      seedProjects(harness)
      seedMemberRow(harness, 'real-member', 'member@pot.test', { withLiveBearer: false })
      harness.sqlite.exec(`
        UPDATE capabilities SET scope_type = 'squad', scope_id = 'squad-a' WHERE member_id = 'real-member';
      `)
      // A legitimate session carries the ALREADY-RESOLVED memberId (what loadAuthFromCookie
      // sets after a real, guarded attach) — never a bare email the route would have to
      // re-resolve itself.
      as(actor({ memberId: 'real-member', email: 'member@pot.test' }))

      const detail = await fetch(harness, '/visible-child')
      expect(detail.status).toBe(200)
    })

    it('an identified member via webSessionMemberId (email-login/no-loginIdentity bridge) is unaffected', async () => {
      harness = makeHarness()
      seedProjects(harness)
      seedMemberRow(harness, 'real-member-2', 'member2@pot.test', { withLiveBearer: false })
      harness.sqlite.exec(`
        UPDATE capabilities SET scope_type = 'squad', scope_id = 'squad-a' WHERE member_id = 'real-member-2';
      `)
      as(actor({ webSessionMemberId: 'real-member-2', email: 'member2@pot.test' }))

      const detail = await fetch(harness, '/visible-child')
      expect(detail.status).toBe(200)
    })
  })
})
