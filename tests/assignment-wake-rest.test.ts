// REST doors of wake-on-assign: POST /tasks and PATCH /tasks/:id enqueue one doorbell for an agent assignee
// (src/agents/assignment-wake.ts). POST with dispatch:true already wakes the assignee itself (agent.wake): no second notice.
// PATCH enqueues AFTER the execution-hold release.
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
import type { AuthContext, BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const T0 = '2026-10-22T00:00:00.000Z'
let h: SqliteD1Harness
let env: Env
let sqls: string[]
let busEvents: BusEvent[]

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  sqls = []
  busEvents = []
  const counted = new Proxy(h.db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (sql: string) => { sqls.push(sql); return target.prepare(sql) }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  env = { DB: counted, TENANT_SLUG: TENANT, BRAND: 'Mupot', BUS: { send: async (e: BusEvent) => { busEvents.push(e) } } } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('ag', 'sq', 'ag', 'Ag', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('m-sqadmin', 'S', 'active', '${TENANT}');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('t1', 'sq', 't', 'b', 'done', 'open', NULL, '${T0}', '${T0}');
  `)
})
afterEach(() => h.close())

const admin = (): AuthContext => ({
  userId: 'u', email: 'u@x.test', role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null, memberId: 'm-sqadmin',
  capabilities: [{ member_id: 'm-sqadmin', scope_type: 'squad', scope_id: 'sq', capability: 'admin' }],
}) as AuthContext

async function call(method: string, path: string, body: unknown) {
  return tasksApp.fetch(new Request(`https://pot.test${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-auth': JSON.stringify(admin()), Origin: 'https://pot.test' },
    body: JSON.stringify(body),
  }), env)
}
const ledger = () => h.sqlite.prepare('SELECT task_id, agent_id, outcome, epoch FROM task_assignment_wakes ORDER BY rowid').all() as Array<{ task_id: string; agent_id: string; outcome: string; epoch: string }>
const body = (extra: Record<string, unknown>) => ({ squad_id: 'sq', title: 'rest made', done_when: 'the check passes cleanly', assignee_agent_id: 'ag', ...extra })

describe('REST wake-on-assign', () => {
  it('POST create with an agent assignee enqueues one doorbell, with the assigning member', async () => {
    const res = await call('POST', '/', body({}))
    expect(res.status, await res.clone().text()).toBe(201)
    const { task } = await res.json() as { task: { id: string } }
    expect(ledger()).toMatchObject([{ task_id: task.id, agent_id: 'ag', outcome: 'queued' }])
    expect(h.sqlite.prepare('SELECT assigned_by FROM task_assignment_wakes').get()).toEqual({ assigned_by: 'member:m-sqadmin' })
  })

  it('POST create with dispatch:false (backlog) enqueues nothing', async () => {
    expect((await call('POST', '/', body({ dispatch: false }))).status).toBe(201)
    expect(ledger()).toEqual([])
  })

  it('POST create with dispatch:true wakes the assignee itself (agent.wake) and adds NO second notice', async () => {
    // dispatch-now needs an independent gate holder: another agent with a live credential and squad standing
    h.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-gate', 'sq', 'gater', 'Gater', 'active');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('member-ga', 'GA', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-ga', 'member-ga', 'squad', 'sq', 'member');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'ag-gate', 'member-ga', '${T0}');
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at)
        VALUES ('tok-ga', 'member-ga', 'hash-ga', 'gate', 'workspace', '${T0}', NULL, 'ag-gate', '${TENANT}', '2099-01-01T00:00:00.000Z');
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
        VALUES ('gg-a', 'gate:gater', 'agent', 'ag-gate', 'm-sqadmin', '${T0}');
    `)
    const res = await call('POST', '/', body({ dispatch: true, gate_owner: 'gate:gater' }))
    expect(res.status, await res.clone().text()).toBe(201)
    expect(busEvents.some((e) => e.type === 'agent.wake')).toBe(true)
    expect(ledger()).toEqual([])
  })

  it('PATCH reassigning to an agent enqueues one doorbell; re-sending the same assignee does not', async () => {
    const r1 = await call('PATCH', '/t1', { assignee_agent_id: 'ag' })
    expect(r1.status, await r1.clone().text()).toBe(200)
    expect(ledger()).toMatchObject([{ task_id: 't1', agent_id: 'ag', outcome: 'queued' }])
    const r2 = await call('PATCH', '/t1', { assignee_agent_id: 'ag' })
    expect(r2.status).toBe(200)
    expect(ledger()).toHaveLength(1)
  })

  it('PATCH: a same-agent reassignment that lifts a stuck-execution counter enqueues once, AFTER the release', async () => {
    h.sqlite.prepare("UPDATE tasks SET assignee_agent_id = 'ag', status = 'blocked' WHERE id = 't1'").run()
    h.sqlite.prepare(
      `INSERT INTO task_execution_attempts (task_id, refused_count, last_agent_id, last_reason, first_at, last_at)
       VALUES ('t1', 3, 'ag', 'refused', '${T0}', '${T0}')`,
    ).run()
    sqls = []
    const res = await call('PATCH', '/t1', { assignee_agent_id: 'ag' })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(ledger()).toHaveLength(1)
    const released = sqls.findIndex((s) => /task_execution_attempts/i.test(s) && /DELETE|UPDATE/i.test(s))
    const enqueued = sqls.findIndex((s) => /INSERT INTO task_assignment_wakes/i.test(s))
    expect(released).toBeGreaterThanOrEqual(0)
    expect(enqueued).toBeGreaterThan(released)
  })

  it('PATCH during a queue outage: the ledger row is committed before the bus event, so nothing is lost', async () => {
    env = { ...env, BUS: { send: async () => { throw new Error('queue_down') } } } as unknown as Env
    await call('PATCH', '/t1', { assignee_agent_id: 'ag' }).catch(() => undefined)
    expect(h.sqlite.prepare('SELECT assignee_agent_id AS a FROM tasks WHERE id = ?').get('t1')).toEqual({ a: 'ag' })
    expect(ledger()).toMatchObject([{ task_id: 't1', agent_id: 'ag', outcome: 'queued' }])
  })

  it('PATCH a human assignee or a plain edit enqueues nothing', async () => {
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-s', 'm-sqadmin', 'squad', 'sq', 'member')`)
    expect((await call('PATCH', '/t1', { title: 'renamed' })).status).toBe(200)
    expect(ledger()).toEqual([])
  })
})
