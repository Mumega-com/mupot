// Behavioural archive proofs for every reader that swallows SQL errors
// (safeAll / try-catch): each test asserts the task is PRESENT before archive,
// ABSENT after, and PRESENT again after unarchive -- the PRESENT leg is what
// distinguishes a working filter from a swallowed SQL error returning nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
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

const { loadOpsHealth } = await import('../src/dashboard/health')
const { loadListMetrics, loadProjectDetail } = await import('../src/dashboard/projects')
const { loadAllAgents } = await import('../src/dashboard/agents-admin')
const { loadWorkPanel } = await import('../src/dashboard/agent-profile')
const { loadAgentStats } = await import('../src/dashboard/observatory')
const { projectsApp } = await import('../src/projects')
const { buildOrient } = await import('../src/orient/service')
const { listOfficePendingApprovals } = await import('../src/addons/office/service')
const { OFFICE_GATE_OWNER } = await import('../src/addons/office/service')

const TENANT = 'pot-a'
const owner = { userId: 'u1', email: null, role: 'owner', tenant: TENANT, memberId: 'm-op',
  capabilities: [{ member_id: 'm-op', scope_type: 'org', scope_id: null, capability: 'admin' }] } as unknown as AuthContext

let h: SqliteD1Harness
let env: Env
const archive = (id: string) =>
  h.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
    VALUES ('${id}', datetime('now'), 'test', 'm-op', 'open', datetime('now'))`)
const unarchive = (id: string) => h.sqlite.exec(`DELETE FROM tasks_archive_state WHERE task_id = '${id}'`)

/** present -> archive -> absent -> unarchive -> present */
async function cycle(taskId: string, read: () => Promise<boolean>): Promise<void> {
  expect(await read()).toBe(true)
  archive(taskId)
  expect(await read()).toBe(false)
  unarchive(taskId)
  expect(await read()).toBe(true)
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Mupot' } as unknown as Env
  authState.current = owner
  h.sqlite.exec(`
    INSERT INTO members (id, tenant, email, display_name, status) VALUES ('m-op', '${TENANT}', 'op@example.com', 'Op', 'active');
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 'sq-one', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('a1', 's1', 'ag1', 'Agent', 'active');
    INSERT INTO memberships (agent_id, squad_id) VALUES ('a1', 's1');
    INSERT INTO projects (id, slug, name, status) VALUES ('p1', 'proj', 'Proj', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p1', 's1', 'admin');
    INSERT INTO tasks (id, squad_id, project_id, title, status, done_when, assignee_agent_id, github_issue_url, result)
      VALUES ('t-blocked', 's1', 'p1', 'Blocked work', 'blocked', 'x', 'a1', 'https://github.com/o/r/issues/1', 'boom');
    INSERT INTO tasks (id, squad_id, project_id, title, status, done_when, assignee_agent_id, gate_owner)
      VALUES ('t-office', 's1', 'p1', 'Office review', 'review', 'x', 'a1', '${OFFICE_GATE_OWNER}');
  `)
})
afterEach(() => h.close())

describe('archive honored by error-swallowing dashboard readers (behavioural)', () => {
  it('health recentFailures', async () => {
    await cycle('t-blocked', async () => (await loadOpsHealth(env, owner)).recentFailures.some((f) => f.id === 't-blocked'))
  })

  it('projects list open_work metric', async () => {
    const access = { readableSquadIds: null, taskableSquadIds: null } as unknown as Parameters<typeof loadListMetrics>[2]
    await cycle('t-blocked', async () => ((await loadListMetrics(env, ['p1'], access)).get('p1')?.openWork ?? 0) >= 2)
    archive('t-blocked')
    expect((await loadListMetrics(env, ['p1'], access)).get('p1')?.openWork).toBe(1)
  })

  it('loadProjectDetail: task list', async () => {
    await cycle('t-blocked', async () => {
      const d = await loadProjectDetail(env, owner, 'p1')
      return !!d && d.tasks.some((t) => t.id === 't-blocked')
    })
  })

  it('loadProjectDetail: directTasks aggregate', async () => {
    const n = async () => (await loadProjectDetail(env, owner, 'p1'))?.aggregates.directTasks
    expect(await n()).toBe(2)
    archive('t-blocked')
    expect(await n()).toBe(1)
    unarchive('t-blocked')
    expect(await n()).toBe(2)
  })

  it('GET /projects/:id direct_tasks (src/projects projectAggregates, unrestricted)', async () => {
    const read = async () => {
      const r = await projectsApp.fetch(new Request('https://pot.test/p1'), env)
      const j = (await r.json()) as { aggregates: { direct_tasks: number } }
      return j.aggregates.direct_tasks
    }
    expect(await read()).toBe(2)
    archive('t-blocked')
    expect(await read()).toBe(1)
    unarchive('t-blocked')
    expect(await read()).toBe(2)
  })

  it('GET /projects/:id direct_tasks (restricted-member branch)', async () => {
    authState.current = {
      userId: 'u2', email: null, role: 'member', tenant: TENANT, memberId: 'm-op',
      capabilities: [{ member_id: 'm-op', scope_type: 'department', scope_id: 'd1', capability: 'member' }],
    } as unknown as AuthContext
    const read = async () => {
      const r = await projectsApp.fetch(new Request('https://pot.test/p1'), env)
      return ((await r.json()) as { aggregates: { direct_tasks: number } }).aggregates.direct_tasks
    }
    expect(await read()).toBe(2)
    archive('t-blocked')
    expect(await read()).toBe(1)
    unarchive('t-blocked')
    expect(await read()).toBe(2)
  })

  it('agents-admin loadAllAgents: task_count and in-flight counts', async () => {
    h.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id) VALUES ('t-open', 's1', 'Open work', 'open', 'x', 'a1')`)
    const row = async () => (await loadAllAgents(env, owner)).find((a) => a.id === 'a1')
    expect((await row())?.task_count).toBe(3)
    expect((await row())?.current_task_title).toBe('Open work')
    archive('t-open')
    expect((await row())?.task_count).toBe(2)
    expect((await row())?.current_task_title).toBeNull()
    unarchive('t-open')
    expect((await row())?.current_task_title).toBe('Open work')
    h.sqlite.exec(`UPDATE tasks SET status='review' WHERE id='t-office'`)
    await cycle('t-office', async () => (await row())?.review_task_title === 'Office review')
  })

  it('agent-profile loadWorkPanel (total + tracked)', async () => {
    await cycle('t-blocked', async () => {
      const p = await loadWorkPanel(env, 'a1')
      return p.state === 'ready' && p.data.recent.some((t) => t.id === 't-blocked') && p.data.tracked === 1
    })
  })

  it('observatory loadAgentStats (in_flight / task_count)', async () => {
    h.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id) VALUES ('t-open', 's1', 'Open work', 'open', 'x', 'a1')`)
    const stat = async () => (await loadAgentStats(env)).get('a1')
    expect((await stat())?.in_flight).toBe(1)
    archive('t-open')
    expect((await stat())?.in_flight).toBe(0)
    expect((await stat())?.task_count).toBe(2)
    unarchive('t-open')
    expect((await stat())?.in_flight).toBe(1)
  })

  it('orient work list (buildOrient tasks)', async () => {
    h.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, status, done_when, assignee_agent_id) VALUES ('t-open', 's1', 'Open work', 'open', 'x', 'a1')`)
    await cycle('t-open', async () => {
      const r = await buildOrient(env, 'a1', 'member', 'https://pot.test/mcp', false, Date.now(), { recordInduction: false })
      return !!r.data && r.data.tasks.some((t) => t.id === 't-open')
    })
  })

  it('office list_pending_approvals', async () => {
    await cycle('t-office', async () => {
      const r = await listOfficePendingApprovals(env, owner)
      return r.ok && r.value.some((a) => a.id === 't-office')
    })
  })
})
