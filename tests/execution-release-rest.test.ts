// REST door of the ONE execution-hold release policy (mupot#1809): PATCH /tasks/:id used to persist a
// reassign of a HELD task and answer 200 with the hold still active (the task fell out of needs_you and
// every wake settled task_held). It now uses the same policy as MCP task_update / execution_release.
// requireAuth (cookie sessions) is replaced by a header-supplied AuthContext; the real handler, the
// real policy and the real migrated schema run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/auth', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/auth')>()
  return {
    ...orig,
    requireAuth: async (c: { req: { header: (n: string) => string | undefined }; set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', JSON.parse(c.req.header('x-test-auth') ?? '{}'))
      await next()
    },
  }
})

import { tasksApp } from '../src/tasks'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const T0 = '2026-09-01T00:00:00.000Z'
let h: SqliteD1Harness
let env: Env

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Mupot', BUS: { send: async () => undefined } } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('ag', 'sq', 'ag', 'Ag', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('m-owner', 'O', 'active', '${TENANT}'), ('m-low', 'L', 'active', '${TENANT}'), ('m-sqadmin', 'S', 'active', '${TENANT}');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('t1', 'sq', 't', 'b', 'done', 'blocked', NULL, '${T0}', '${T0}');
    INSERT INTO execution_holds (task_id, escalation_id, agent_id, refused_count, reason, held_at)
      VALUES ('t1', 'esc', 'ag', 3, 'x', '${T0}');
    INSERT INTO task_execution_attempts (task_id, refused_count, last_agent_id, first_at, last_at) VALUES ('t1', 3, 'ag', '${T0}', '${T0}');
  `)
})
afterEach(() => h.close())

const auth = (over: Partial<AuthContext>): AuthContext => ({
  userId: 'u', email: 'u@x.test', role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null, ...over,
}) as AuthContext

async function patch(a: AuthContext, body: unknown) {
  return tasksApp.fetch(new Request('https://pot.test/t1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-auth': JSON.stringify(a), Origin: 'https://pot.test' },
    body: JSON.stringify(body),
  }), env)
}
const hold = () => h.sqlite.prepare('SELECT released_at, released_by_member_id FROM execution_holds WHERE task_id = ?').get('t1') as { released_at: string | null; released_by_member_id: string | null }
const task = () => h.sqlite.prepare('SELECT assignee_agent_id a, status FROM tasks WHERE id = ?').get('t1') as { a: string | null; status: string }

describe('PATCH /tasks/:id on a HELD task', () => {
  it('a registered org-owner web session assigning an agent releases the hold (was 200 with the hold still active)', async () => {
    const res = await patch(auth({ role: 'owner', webSessionMemberId: 'm-owner' }), { assignee_agent_id: 'ag' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(hold().released_at).not.toBeNull()
    expect(hold().released_by_member_id).toBe('m-owner')
    expect(task().a).toBe('ag')
    expect(h.sqlite.prepare('SELECT 1 FROM task_execution_attempts WHERE task_id = ?').get('t1')).toBeUndefined()
  })

  it('a squad-admin (capabilities) releases through REST: the same bar as execution_release', async () => {
    const res = await patch(auth({ memberId: 'm-sqadmin', capabilities: [{ member_id: 'm-sqadmin', scope_type: 'squad', scope_id: 'sq', capability: 'admin' }] }), { assignee_agent_id: 'ag' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(hold().released_at).not.toBeNull()
  })

  it('a below-bar member (squad member) is refused 409 task_held; task unchanged, hold stays', async () => {
    const res = await patch(auth({ memberId: 'm-low', capabilities: [{ member_id: 'm-low', scope_type: 'squad', scope_id: 'sq', capability: 'member' }] }), { assignee_agent_id: 'ag' })
    expect(res.status, await res.clone().text()).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'task_held' })
    expect(task()).toEqual({ a: null, status: 'blocked' })
    expect(hold().released_at).toBeNull()
  })

  it('an owner web session with NO recordable member identity cannot release: refused task_held (never assigned-but-stalled)', async () => {
    const res = await patch(auth({ role: 'owner' }), { assignee_agent_id: 'ag' })
    expect(res.status, await res.clone().text()).toBe(409)
    expect(task().a).toBeNull()
    expect(hold().released_at).toBeNull()
  })

  it('a non-assigning PATCH by a below-bar member still works and the hold stays', async () => {
    const res = await patch(auth({ memberId: 'm-low', capabilities: [{ member_id: 'm-low', scope_type: 'squad', scope_id: 'sq', capability: 'member' }] }), { title: 'renamed' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(hold().released_at).toBeNull()
  })
})
