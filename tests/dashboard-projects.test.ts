import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
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

const {
  loadProjectDetail,
  loadProjectsPage,
  projectDetailBody,
  projectsPageBody,
} = await import('../src/dashboard/projects')
const { dashboardApp, dashboardBuiltInGetRoutes } = await import('../src/dashboard')
const { projectsApp } = await import('../src/projects')

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('dept-a', 'dept-a', 'Department A'),
      ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha'),
      ('squad-b', 'dept-b', 'squad-b', 'Squad Beta');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'Visible operator', 'test', 'active'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent Beta Secret', 'Hidden operator', 'test', 'active');

    INSERT INTO projects (id, slug, name, description, goal, status, target_date) VALUES
      ('root', 'mumega-products', 'Mumega Products', 'Product portfolio', 'Build durable products', 'active', '2026-12-31'),
      ('other-root', 'other-root', 'Other Root', 'Hidden root detail', 'Hidden root goal', 'active', NULL);
    INSERT INTO projects (id, slug, name, description, goal, status, parent_project_id, target_date) VALUES
      ('visible-child', 'inkwell', 'Inkwell <script>alert(1)</script>', 'Safe <b>description</b>', 'Publish & verify', 'planned', 'root', '2026-09-30'),
      ('hidden-child', 'mirror', 'Hidden sibling secret', 'Hidden sibling detail', 'Hidden sibling goal', 'active', 'root', NULL);

    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('visible-child', 'squad-a', 'write'),
      ('visible-child', 'squad-b', 'write'),
      ('hidden-child', 'squad-b', 'admin'),
      ('other-root', 'squad-b', 'read');

    INSERT INTO tasks (id, squad_id, title, status, project_id) VALUES
      ('visible-task', 'squad-a', 'Visible task <unsafe>', 'open', 'visible-child'),
      ('hidden-task-on-visible-project', 'squad-b', 'Hidden squad task secret', 'open', 'visible-child'),
      ('hidden-sibling-task', 'squad-b', 'Hidden sibling task secret', 'open', 'hidden-child');

    INSERT INTO flights (id, tenant, agent, goal, status, project_id, meta) VALUES
      ('visible-flight', 'pot-a', 'agent-a', 'Ship Inkwell', 'running', 'visible-child', '{"schema":"mupot.flight.meta/v1","goal_id":"visible","objective_id":"ship","squad_ids":["squad-a"],"task_ids":["visible-task"],"done_when":["done"],"artifact_refs":[],"receipt_refs":[],"confidentiality":"internal","publication_target":"none","parent_flight_id":null}'),
      ('hidden-flight-on-visible-project', 'pot-a', 'agent-b', 'Hidden visible-project flight', 'running', 'visible-child', '{"schema":"mupot.flight.meta/v1","goal_id":"hidden","objective_id":"ship","squad_ids":["squad-b"],"task_ids":["hidden-task-on-visible-project"],"done_when":["done"],"artifact_refs":[],"receipt_refs":[],"confidentiality":"internal","publication_target":"none","parent_flight_id":null}'),
      ('mixed-flight', 'pot-a', 'agent-a', 'Mixed squad secret flight', 'running', 'visible-child', '{"schema":"mupot.flight.meta/v1","goal_id":"mixed","objective_id":"ship","squad_ids":["squad-a","squad-b"],"task_ids":["visible-task","hidden-task-on-visible-project"],"done_when":["done"],"artifact_refs":[],"receipt_refs":[],"confidentiality":"internal","publication_target":"none","parent_flight_id":null}'),
      ('legacy-flight', 'pot-a', 'agent-a', 'Legacy project flight', 'running', 'visible-child', '{"squad_ids":["squad-a"]}'),
      ('hidden-flight', 'pot-a', 'agent-b', 'Ship Mirror', 'running', 'hidden-child', '{"schema":"mupot.flight.meta/v1","goal_id":"mirror","objective_id":"ship","squad_ids":["squad-b"],"task_ids":["hidden-sibling-task"],"done_when":["done"],"artifact_refs":[],"receipt_refs":[],"confidentiality":"internal","publication_target":"none","parent_flight_id":null}');

    UPDATE tasks SET result = 'Verified & retained <result>', completed_at = '2026-07-18T20:05:00Z', execution_receipt_id = 'execution-visible'
      WHERE id = 'visible-task';
    INSERT INTO agent_messages
      (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, project_id, created_at)
    VALUES ('project-message', 'pot-a', 'agent-b', 'agent-a', 'member-a', 'request', 'Coordinate <safely>', 'project-request', 'visible-child', '2026-07-18T20:03:00Z');
    INSERT INTO workflow_receipts (id, instance_id, task_id, step_name, status, detail, created_at)
    VALUES ('project-workflow', 'instance-visible', 'visible-task', 'execute', 'ok', '{"proof":"retained"}', '2026-07-18T20:06:00Z');
    INSERT INTO flight_event_outbox
      (id, tenant, flight_id, event_type, actor_kind, actor_id, payload, created_at, delivered_at)
    VALUES ('project-landing', 'pot-a', 'visible-flight', 'flight.landed', 'agent', 'agent-a', '{"status":"landed"}', '2026-07-18T20:07:00Z', '2026-07-18T20:07:01Z');

    UPDATE project_squad_access
       SET access_level = 'read'
     WHERE project_id = 'visible-child' AND squad_id = 'squad-b';
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'pot-a', BRAND: 'Mupot' } as Env
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

function as(auth: AuthContext | null): void {
  authState.current = auth
}

function memberA(): AuthContext {
  return actor({
    memberId: 'member-a',
    capabilities: [
      { member_id: 'member-a', scope_type: 'department', scope_id: 'dept-a', capability: 'member' },
    ],
  })
}

function envWithBindBudget(harness: SqliteD1Harness, observed: number[]): Env {
  const db = new Proxy(harness.db, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver)
      return (sql: string) => {
        const statement = target.prepare(sql)
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== 'bind') {
              const value = Reflect.get(statementTarget, statementProperty, statementReceiver)
              return typeof value === 'function' ? value.bind(statementTarget) : value
            }
            return (...values: unknown[]) => {
              observed.push(values.length)
              if (values.length > 100) throw new Error(`D1 bind budget exceeded: ${values.length}`)
              return statement.bind(...values)
            }
          },
        })
      }
    },
  })
  return { ...envFor(harness), DB: db }
}

async function render(value: unknown): Promise<string> {
  return String(await value)
}

describe('project dashboard renderers', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('renders the root and one child level without exposing hidden sibling content', async () => {
    harness = makeHarness()
    const view = await loadProjectsPage(envFor(harness), memberA())
    const body = await render(projectsPageBody(view))

    expect(body).toContain('Mumega Products')
    expect(body).toContain('Inkwell &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).not.toContain('Hidden sibling secret')
    expect(body).not.toContain('Hidden sibling detail')
    expect(body).not.toContain('Other Root')
    expect(body).not.toContain('href="/projects/root"')
    expect(view.nodes[0]).toMatchObject({
      contextOnly: true,
      metrics: null,
      children: [{
        id: 'visible-child',
        metrics: { directSquads: 1, openWork: 1, activeFlights: 1 },
      }],
    })
  })

  it('keeps every production query within D1 bind limits for large project and capability sets', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 101)
      INSERT INTO projects (id, slug, name, status)
      SELECT printf('budget-%03d', x), printf('budget-%03d', x), printf('Budget %03d', x), 'planned'
        FROM n;
    `)
    const observed: number[] = []
    const env = envWithBindBudget(harness, observed)
    const grants = [{
      member_id: 'member-a',
      scope_type: 'department' as const,
      scope_id: 'dept-a',
      capability: 'member' as const,
    }, ...Array.from({ length: 150 }, (_, index) => ({
      member_id: 'member-a',
      scope_type: 'squad' as const,
      scope_id: `grant-${index}`,
      capability: 'observer' as const,
    }))]
    const auth = actor({ memberId: 'member-a', capabilities: grants })

    await expect(loadProjectsPage(env, auth)).resolves.toBeDefined()
    await expect(loadProjectDetail(env, auth, 'visible-child')).resolves.toBeDefined()
    as(auth)
    await expect(dashboardApp.fetch(new Request('https://pot.test/send?project_id=visible-child'), env)).resolves.toHaveProperty('status', 200)
    await expect(dashboardApp.fetch(new Request('https://pot.test/flights?project_id=visible-child'), env)).resolves.toHaveProperty('status', 200)
    await expect(loadProjectsPage(env, actor({ role: 'owner' }))).resolves.toBeDefined()
    expect(Math.max(...observed)).toBeLessThanOrEqual(100)
  })

  it('shows only readable squad aggregates to members and all aggregates to owners', async () => {
    harness = makeHarness()

    const memberList = await loadProjectsPage(envFor(harness), memberA())
    const memberChild = memberList.nodes[0]?.children[0]
    expect(memberChild?.metrics).toEqual({ directSquads: 1, openWork: 1, activeFlights: 1 })

    const memberDetail = await loadProjectDetail(envFor(harness), memberA(), 'visible-child')
    expect(memberDetail?.aggregates).toEqual({ directTasks: 1, directSquads: 1, directFlights: 1 })

    const ownerDetail = await loadProjectDetail(envFor(harness), actor({ role: 'owner' }), 'visible-child')
    expect(ownerDetail?.aggregates).toEqual({ directTasks: 2, directSquads: 2, directFlights: 4 })
  })

  it('renders bounded per-project squad, open-work, and active-flight metrics', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 101)
      INSERT INTO projects (id, slug, name, status)
      SELECT printf('bounded-%03d', x), printf('bounded-%03d', x), printf('Bounded %03d', x), 'planned'
        FROM n;
    `)
    const body = await render(projectsPageBody(await loadProjectsPage(envFor(harness), actor({ role: 'owner' }))))

    expect(body).toContain('Squads')
    expect(body).toContain('Open work')
    expect(body).toContain('Active flights')
    expect(body).toContain('Showing the first')
  })

  it('bounds the project and edge result sets before rendering', async () => {
    harness = makeHarness()
    const observed: string[] = []
    const trackedDb = new Proxy(harness.db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (sql: string) => {
          if (/\bFROM projects\b|\bFROM project_squad_access\b/i.test(sql)) observed.push(sql)
          return target.prepare(sql)
        }
      },
    })

    await loadProjectsPage({ ...envFor(harness), DB: trackedDb }, memberA())

    expect(observed.some((sql) => (
      /SELECT p\.id, p\.slug[\s\S]*FROM projects p[\s\S]*LIMIT \?/i.test(sql)
    ))).toBe(true)
    expect(observed.some((sql) => (
      /SELECT id, slug[\s\S]*FROM projects[\s\S]*ORDER BY[\s\S]*[^?]\s*$/i.test(sql)
    ))).toBe(false)
    expect(observed.some((sql) => (
      /SELECT psa\.project_id[\s\S]*ORDER BY psa\.project_id, psa\.squad_id\s*$/i.test(sql)
    ))).toBe(false)
  })

  it('renders an honest empty state when no project is readable', async () => {
    harness = makeHarness()
    const body = await render(projectsPageBody(await loadProjectsPage(envFor(harness), actor())))

    expect(body).toContain('No projects available')
    expect(body).toContain('No project data is fabricated')
  })

  it('renders escaped detail, bounded metrics, project work links, and only readable squad edges', async () => {
    harness = makeHarness()
    const view = await loadProjectDetail(envFor(harness), memberA(), 'visible-child')
    expect(view).not.toBeNull()
    const body = await render(projectDetailBody(view!))

    expect(body).toContain('Inkwell &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).toContain('Safe &lt;b&gt;description&lt;/b&gt;')
    expect(body).toContain('Publish &amp; verify')
    expect(body).toContain('planned')
    expect(body).toContain('2026-09-30')
    expect(body).toContain('2')
    expect(body).toContain('1')
    expect(body).toContain('/send?project_id=visible-child')
    expect(body).toContain('/flights?project_id=visible-child')
    expect(body).toContain('Visible task &lt;unsafe&gt;')
    expect(body).not.toContain('Hidden squad task secret')
    expect(body).toContain('Squad Alpha')
    expect(body).not.toContain('Squad Beta')
  })

  it('renders truthful operating situations for review, blocked, active, and empty projects', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES
        ('review-project', 'review-project', 'Review project', 'active'),
        ('blocked-project', 'blocked-project', 'Blocked project', 'active'),
        ('active-project', 'active-project', 'Active project', 'active'),
        ('empty-project', 'empty-project', 'Empty project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
        ('review-project', 'squad-a', 'write'),
        ('blocked-project', 'squad-a', 'write'),
        ('active-project', 'squad-a', 'write'),
        ('empty-project', 'squad-a', 'write');
      INSERT INTO tasks (id, squad_id, title, status, project_id, gate_owner, result, updated_at) VALUES
        ('review-task', 'squad-a', 'Review release', 'review', 'review-project', 'Release manager', NULL, '2026-07-19T01:00:00Z'),
        ('blocked-task', 'squad-a', 'Resolve dependency', 'blocked', 'blocked-project', NULL, 'Waiting on vendor', '2026-07-19T01:00:00Z'),
        ('active-task', 'squad-a', 'Continue delivery', 'in_progress', 'active-project', NULL, NULL, '2026-07-19T01:00:00Z');
    `)

    const review = await loadProjectDetail(envFor(harness), actor({ role: 'owner' }), 'review-project')
    const blocked = await loadProjectDetail(envFor(harness), actor({ role: 'owner' }), 'blocked-project')
    const active = await loadProjectDetail(envFor(harness), actor({ role: 'owner' }), 'active-project')
    const empty = await loadProjectDetail(envFor(harness), actor({ role: 'owner' }), 'empty-project')

    expect(review?.situation).toMatchObject({ health: 'review', summary: '1 task(s) are awaiting review.' })
    expect(blocked?.situation).toMatchObject({ health: 'blocked', summary: '1 blocked task(s) need attention.' })
    expect(active?.situation).toMatchObject({ health: 'active', active_work_count: 1 })
    expect(empty?.situation).toMatchObject({
      health: 'ready',
      summary: 'Project is ready for its next step.',
      blockers: [],
      pending_reviews: [],
      latest_activity: null,
    })

    const reviewBody = await render(projectDetailBody(review!))
    const blockedBody = await render(projectDetailBody(blocked!))
    const activeBody = await render(projectDetailBody(active!))
    const emptyBody = await render(projectDetailBody(empty!))

    expect(reviewBody).toContain('Health')
    expect(reviewBody).toContain('Review release')
    expect(reviewBody).toContain('Release manager')
    expect(blockedBody).toContain('Resolve dependency')
    expect(blockedBody).toContain('Waiting on vendor')
    expect(activeBody).toContain('Active work')
    expect(activeBody).toContain('1')
    expect(emptyBody).toContain('No blockers need attention.')
    expect(emptyBody).toContain('No reviews are pending.')
    expect(emptyBody).toContain('No material activity yet.')
  })

  it('orders project work by operating priority and consistently within each status', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES
        ('ordered-project', 'ordered-project', 'Ordered project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('ordered-project', 'squad-a', 'write');
      INSERT INTO tasks (id, squad_id, title, status, project_id, updated_at) VALUES
        ('open-later', 'squad-a', 'Open later', 'open', 'ordered-project', '2026-07-19T04:00:00Z'),
        ('done-terminal', 'squad-a', 'Done terminal', 'done', 'ordered-project', '2026-07-19T01:00:00Z'),
        ('review-later', 'squad-a', 'Review later', 'review', 'ordered-project', '2026-07-19T02:00:00Z'),
        ('blocked-task', 'squad-a', 'Blocked task', 'blocked', 'ordered-project', '2026-07-19T01:00:00Z'),
        ('review-earlier', 'squad-a', 'Review earlier', 'review', 'ordered-project', '2026-07-19T01:00:00Z'),
        ('progress-task', 'squad-a', 'Progress task', 'in_progress', 'ordered-project', '2026-07-19T01:00:00Z'),
        ('open-earlier', 'squad-a', 'Open earlier', 'open', 'ordered-project', '2026-07-19T01:00:00Z');
    `)

    const view = await loadProjectDetail(envFor(harness), actor({ role: 'owner' }), 'ordered-project')

    expect(view?.tasks.map((task) => task.id)).toEqual([
      'review-earlier',
      'review-later',
      'blocked-task',
      'progress-task',
      'open-earlier',
      'open-later',
      'done-terminal',
    ])
  })

  it('uses semantic anchor tabs and renders authoritative Activity and Evidence projections', async () => {
    harness = makeHarness()
    const view = await loadProjectDetail(envFor(harness), actor({ role: 'owner' }), 'visible-child')
    const body = await render(projectDetailBody(view!))

    expect(body).toMatch(/<nav[^>]+aria-label="Project sections"/)
    expect(body).toContain('href="#overview" aria-current="page"')
    expect(body).toContain('href="#work"')
    expect(body).toContain('href="#squads"')
    expect(body).toContain('href="#activity"')
    expect(body).toContain('href="#evidence"')
    expect(body).toContain('Coordinate &lt;safely&gt;')
    expect(body).toContain('Verified &amp; retained &lt;result&gt;')
    expect(body).toContain('workflow receipt')
    expect(body).not.toContain('No project activity yet')
    expect(body).not.toContain('No project evidence yet')
    expect(body.match(/role="table"/g)).toHaveLength(4)
    expect(body).toContain('role="columnheader"')
    expect(body).toContain('role="cell"')
    expect(body).toContain("window.addEventListener('hashchange', syncProjectTab)")
    expect(body).toContain("link.setAttribute('aria-current', 'page')")
    expect(body).toContain("link.removeAttribute('aria-current')")
  })

  it('filters task authorization before applying the bounded detail sample', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      UPDATE project_squad_access
         SET access_level = 'write'
       WHERE project_id = 'visible-child' AND squad_id = 'squad-b';
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 101)
      INSERT INTO tasks (id, squad_id, title, status, project_id, created_at)
      SELECT printf('zzz-hidden-%03d', x), 'squad-b', printf('Hidden crowd %03d', x), 'open',
             'visible-child', '2030-01-01T00:00:00Z'
        FROM n;
      UPDATE project_squad_access
         SET access_level = 'read'
       WHERE project_id = 'visible-child' AND squad_id = 'squad-b';
    `)

    const view = await loadProjectDetail(envFor(harness), memberA(), 'visible-child')
    expect(view?.tasks.map((task: { id: string }) => task.id)).toContain('visible-task')
    expect(view?.tasks.some((task: { title: string }) => task.title.startsWith('Hidden crowd'))).toBe(false)
  })
})

describe('project dashboard routes', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('registers project routes before the built-in route table is frozen', () => {
    expect(dashboardBuiltInGetRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: '/projects' }),
      expect.objectContaining({ method: 'GET', path: '/projects/:id' }),
    ]))
  })

  it('redirects unauthenticated project pages and renders owner project detail', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    expect((await dashboardApp.fetch(new Request('https://pot.test/projects'), env)).status).toBe(302)

    as(actor({ role: 'owner' }))
    const response = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child'), env)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Mupot')
  })

  it('renders only member-visible projects with safe parent context and returns 404 for hidden detail', async () => {
    harness = makeHarness()
    as(memberA())
    const env = envFor(harness)

    const list = await dashboardApp.fetch(new Request('https://pot.test/projects'), env)
    const body = await list.text()
    expect(list.status).toBe(200)
    expect(body).toContain('Mumega Products')
    expect(body).toContain('Inkwell')
    expect(body).not.toContain('Hidden sibling secret')
    expect(body).not.toContain('Hidden sibling detail')
    expect(body).not.toContain('Hidden sibling task secret')

    const hidden = await dashboardApp.fetch(new Request('https://pot.test/projects/hidden-child'), env)
    expect(hidden.status).toBe(404)
    expect(await hidden.text()).not.toContain('Hidden sibling secret')
  })

  it('exposes project Activity and Evidence through authenticated project APIs without leaking hidden squads', async () => {
    harness = makeHarness()
    as(memberA())
    const env = envFor(harness)

    const activityResponse = await projectsApp.fetch(
      new Request('https://pot.test/visible-child/activity?limit=20'),
      env,
    )
    expect(activityResponse.status).toBe(200)
    const activity = await activityResponse.json() as { rows: Array<{ source_id: string }> }
    expect(activity.rows.some((row) => row.source_id === 'visible-task')).toBe(true)
    // The message has only one squad-scoped endpoint, so exposing its body would
    // leak a partially hidden conversation into this member projection.
    expect(activity.rows.some((row) => row.source_id === 'project-message')).toBe(false)
    expect(activity.rows.some((row) => row.source_id === 'hidden-task-on-visible-project')).toBe(false)
    expect(activity.rows.some((row) => row.source_id === 'hidden-flight-on-visible-project')).toBe(false)

    const evidenceResponse = await projectsApp.fetch(
      new Request('https://pot.test/visible-child/evidence?limit=20'),
      env,
    )
    expect(evidenceResponse.status).toBe(200)
    const evidence = await evidenceResponse.json() as { rows: Array<{ source_id: string }> }
    expect(evidence.rows.some((row) => row.source_id === 'visible-task')).toBe(true)
    expect(evidence.rows.some((row) => row.source_id === 'project-workflow')).toBe(true)

    const hidden = await projectsApp.fetch(new Request('https://pot.test/hidden-child/activity'), env)
    expect(hidden.status).toBe(404)
  })

  it('validates project task context, filters the picker, and includes project_id in the task payload', async () => {
    harness = makeHarness()
    as(memberA())
    const env = envFor(harness)

    const response = await dashboardApp.fetch(new Request('https://pot.test/send?project_id=visible-child'), env)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('Inkwell &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).toContain('Agent Alpha')
    expect(body).not.toContain('Agent Beta Secret')
    expect(body).toContain('var projectId = "visible-child"')
    expect(body).toContain('payload.project_id = projectId')

    const hidden = await dashboardApp.fetch(new Request('https://pot.test/send?project_id=hidden-child'), env)
    expect(hidden.status).toBe(404)
    expect(await hidden.text()).not.toContain('Hidden sibling secret')
  })

  it('excludes read-only project edges even when the member can task the squad', async () => {
    harness = makeHarness()
    as(actor({
      memberId: 'member-b',
      capabilities: [{
        member_id: 'member-b', scope_type: 'department', scope_id: 'dept-b', capability: 'member',
      }],
    }))

    const response = await dashboardApp.fetch(
      new Request('https://pot.test/send?project_id=visible-child'),
      envFor(harness),
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).not.toContain('Agent Beta Secret')
    expect(body).toContain('No active agents yet')
  })

  it('excludes writable project squads when the member is only an observer', async () => {
    harness = makeHarness()
    as(actor({
      memberId: 'member-observer',
      capabilities: [{
        member_id: 'member-observer', scope_type: 'department', scope_id: 'dept-a', capability: 'observer',
      }],
    }))

    const response = await dashboardApp.fetch(
      new Request('https://pot.test/send?project_id=visible-child'),
      envFor(harness),
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).not.toContain('Agent Alpha')
    expect(body).toContain('No active agents yet')
  })

  it('uses a pre-limit authorized project-flight query and excludes hidden or malformed flights', async () => {
    harness = makeHarness()
    as(memberA())
    const observed: string[] = []
    const trackedDb = new Proxy(harness.db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (sql: string) => {
          if (/SELECT \*[\s\S]*FROM\s+flights/i.test(sql)) observed.push(sql)
          return target.prepare(sql)
        }
      },
    })
    const env = { ...envFor(harness), DB: trackedDb }

    const response = await dashboardApp.fetch(new Request('https://pot.test/flights?project_id=visible-child'), env)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('Inkwell &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).toContain('Ship Inkwell')
    expect(body).not.toContain('Hidden visible-project flight')
    expect(body).not.toContain('Mixed squad secret flight')
    expect(body).not.toContain('Legacy project flight')
    expect(body).not.toContain('Ship Mirror')
    expect(observed.some((sql) => (
      /json_valid\(f\.meta\)[\s\S]*json_each\(\?3\)[\s\S]*\?4 IS NULL[\s\S]*f\.created_at < \?4[\s\S]*f\.id < \?5[\s\S]*ORDER BY f\.created_at DESC, f\.id DESC[\s\S]*LIMIT \?6/i
        .test(sql)
    ))).toBe(true)

    const hidden = await dashboardApp.fetch(new Request('https://pot.test/flights?project_id=hidden-child'), env)
    expect(hidden.status).toBe(404)
    expect(await hidden.text()).not.toContain('Hidden sibling secret')
  })

  it('authorizes project flights before ordering and limiting the visible sample', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      UPDATE project_squad_access
         SET access_level = 'write'
       WHERE project_id = 'visible-child' AND squad_id = 'squad-b';
      UPDATE flights SET created_at = 1 WHERE id = 'visible-flight';
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 101)
      INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at, meta)
      SELECT printf('newer-unauthorized-%03d', x), 'pot-a', 'agent-b',
             printf('Newer hidden %03d', x),
             'running', 'visible-child', 2000000000000 + x,
             '{"schema":"mupot.flight.meta/v1","goal_id":"hidden-crowd","objective_id":"ship","squad_ids":["squad-b"],"task_ids":["hidden-task-on-visible-project"],"done_when":["done"],"artifact_refs":[],"receipt_refs":[],"confidentiality":"internal","publication_target":"none","parent_flight_id":null}'
        FROM n;
      UPDATE project_squad_access
         SET access_level = 'read'
       WHERE project_id = 'visible-child' AND squad_id = 'squad-b';
    `)
    as(memberA())

    const response = await dashboardApp.fetch(
      new Request('https://pot.test/flights?project_id=visible-child'),
      envFor(harness),
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('Ship Inkwell')
    expect(body).not.toContain('Newer hidden')
  })

  it('filters JavaScript-invalid whitespace metadata before limiting', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      UPDATE flights SET created_at = 1 WHERE id = 'visible-flight';
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 101)
      INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at, meta)
      SELECT printf('newer-js-invalid-%03d', x), 'pot-a', 'agent-a', printf('SQL-pass JS-fail %03d', x),
             'running', 'visible-child', 3000000000000 + x,
             json_object(
               'schema', 'mupot.flight.meta/v1',
               'goal_id', char(160),
               'objective_id', 'ship',
               'squad_ids', json_array('squad-a'),
               'task_ids', json_array('visible-task'),
               'done_when', json_array('done'),
               'artifact_refs', json_array(),
               'receipt_refs', json_array(),
               'confidentiality', 'internal',
               'publication_target', 'none',
               'parent_flight_id', NULL
             )
        FROM n;
    `)
    as(memberA())
    const observed: string[] = []
    const trackedDb = new Proxy(harness.db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (sql: string) => {
          if (/SELECT \*[\s\S]*FROM\s+flights f/i.test(sql)) observed.push(sql)
          return target.prepare(sql)
        }
      },
    })

    const response = await dashboardApp.fetch(
      new Request('https://pot.test/flights?project_id=visible-child'),
      { ...envFor(harness), DB: trackedDb },
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('Ship Inkwell')
    expect(body).not.toContain('SQL-pass JS-fail')
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatch(/\?4 IS NULL[\s\S]*f\.created_at < \?4[\s\S]*f\.id < \?5/i)
    expect(observed[0]).toMatch(/ORDER BY f\.created_at DESC, f\.id DESC[\s\S]*LIMIT \?6/i)
    expect(observed[0]).not.toMatch(/\bOFFSET\b/i)
  })

  it('bounds defensive canonical scanning when a database adapter returns invalid candidates', async () => {
    harness = makeHarness()
    as(memberA())
    let flightQueries = 0
    const invalidCandidates = Array.from({ length: 100 }, (_, index) => ({
      id: `adapter-invalid-${index}`,
      tenant: 'pot-a',
      project_id: 'visible-child',
      agent: 'agent-a',
      goal: 'Adapter invalid',
      status: 'running',
      created_at: 4000000000000 - index,
      meta: '{}',
    }))
    const boundedDb = new Proxy(harness.db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver)
        return (sql: string) => {
          if (!/SELECT \*[\s\S]*FROM\s+flights f/i.test(sql)) return target.prepare(sql)
          flightQueries += 1
          return {
            bind: () => ({ all: async () => ({ results: invalidCandidates }) }),
          }
        }
      },
    })

    const response = await dashboardApp.fetch(
      new Request('https://pot.test/flights?project_id=visible-child'),
      { ...envFor(harness), DB: boundedDb as unknown as Env['DB'] },
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(flightQueries).toBe(10)
    expect(body).toContain('Flight history is partial because the project scan safety limit was reached.')
    expect(body).not.toContain('Adapter invalid')
  })

  it('lets workspace admins see canonical, mixed, legacy, and malformed project flights', async () => {
    harness = makeHarness()
    as(actor({ role: 'owner' }))

    const response = await dashboardApp.fetch(
      new Request('https://pot.test/flights?project_id=visible-child'),
      envFor(harness),
    )
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('Ship Inkwell')
    expect(body).toContain('Hidden visible-project flight')
    expect(body).toContain('Mixed squad secret flight')
    expect(body).toContain('Legacy project flight')
    expect(body).not.toContain('Ship Mirror')
  })

  it('uses mobile-safe semantic regions without fixed project layout widths', async () => {
    harness = makeHarness()
    as(actor({ role: 'owner' }))
    const response = await dashboardApp.fetch(new Request('https://pot.test/projects/visible-child'), envFor(harness))
    const body = await response.text()
    const list = await loadProjectsPage(envFor(harness), actor({ role: 'owner' }))
    const listFragment = await render(projectsPageBody(list))
    const view = await loadProjectDetail(envFor(harness), actor({ role: 'owner' }), 'visible-child')
    const fragment = await render(projectDetailBody(view!))

    expect(body).toContain('<main>')
    expect(body).toContain('aria-label="Project sections"')
    expect(listFragment.match(/role="region"[^>]+overflow-x:auto/g)).toHaveLength(1)
    expect(listFragment).toContain('overflow-wrap:anywhere')
    expect(listFragment).not.toMatch(/width:\s*\d+px/)
    expect(fragment.match(/role="region"[^>]+overflow-x:auto/g)).toHaveLength(4)
    expect(fragment).toContain('overflow-wrap:anywhere')
    expect(fragment).not.toMatch(/width:\s*\d+px/)
  })
})
