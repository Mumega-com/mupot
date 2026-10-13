// REST doors of the task-assignment doorbell (mupot#1882): POST /tasks and PATCH /tasks/:id ring the assignee's
// webhook doorbell. No executionCtx exists under vitest, so the POST runs unawaited and the test polls the receipt.
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
import { setAgentWebhookDoorbell } from '../src/agents/webhook-doorbell'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const T0 = '2026-09-01T00:00:00.000Z'
let h: SqliteD1Harness
let env: Env
let bodies: unknown[]
const realFetch = globalThis.fetch

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = {
    DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Mupot', BUS: { send: async () => undefined },
    CONNECTOR_MASTER_KEY: 'b'.repeat(64), WEBHOOK_DOORBELL: '1',
  } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('ag', 'sq', 'ag', 'Ag', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('m-sqadmin', 'S', 'active', '${TENANT}');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('t1', 'sq', 't', 'b', 'done', 'open', NULL, '${T0}', '${T0}');
  `)
  await setAgentWebhookDoorbell(env, { agentId: 'ag', webhookUrl: 'https://hook.example/ag', bearer: 'bearer-secret-1234', createdByMemberId: 'm-sqadmin' })
  bodies = []
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('ok', { status: 200 })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch; h.close() })

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
async function receipts(n: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const c = (h.sqlite.prepare('SELECT count(*) AS n FROM agent_webhook_doorbell_receipts').get() as { n: number }).n
    if (c >= n) return c
    await new Promise((r) => setTimeout(r, 20))
  }
  return (h.sqlite.prepare('SELECT count(*) AS n FROM agent_webhook_doorbell_receipts').get() as { n: number }).n
}

describe('REST task assignment doorbell', () => {
  it('PATCH reassigning to an agent with a doorbell rings once; re-assigning the same agent does not ring again', async () => {
    const r1 = await call('PATCH', '/t1', { assignee_agent_id: 'ag' })
    expect(r1.status, await r1.clone().text()).toBe(200)
    expect(await receipts(1)).toBe(1)
    const r2 = await call('PATCH', '/t1', { assignee_agent_id: 'ag' })
    expect(r2.status).toBe(200)
    await new Promise((r) => setTimeout(r, 150))
    expect(bodies).toEqual([{ type: 'mupot.task.assigned', agent_id: 'ag', task_id: 't1' }])
  })

  it('POST create with an assignee rings; dispatch:false does not', async () => {
    const quiet = await call('POST', '/', { squad_id: 'sq', title: 'quiet one', done_when: 'the check passes cleanly', assignee_agent_id: 'ag', dispatch: false })
    expect(quiet.status, await quiet.clone().text()).toBe(201)
    await new Promise((r) => setTimeout(r, 150))
    expect(bodies).toEqual([])
    const loud = await call('POST', '/', { squad_id: 'sq', title: 'loud one', done_when: 'the check passes cleanly', assignee_agent_id: 'ag' })
    expect(loud.status, await loud.clone().text()).toBe(201)
    expect(await receipts(1)).toBe(1)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ type: 'mupot.task.assigned', agent_id: 'ag' })
  })

  it('a same-agent reassignment that lifts an execution hold rings; the same PATCH with no hold does not', async () => {
    h.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
        VALUES ('t-held', 'sq', 't', 'b', 'done', 'blocked', 'ag', '${T0}', '${T0}'),
               ('t-free', 'sq', 't', 'b', 'done', 'open', 'ag', '${T0}', '${T0}');
      INSERT INTO execution_holds (task_id, escalation_id, agent_id, refused_count, reason, held_at)
        VALUES ('t-held', 'esc', 'ag', 3, 'x', '${T0}');
      INSERT INTO task_execution_attempts (task_id, refused_count, last_agent_id, first_at, last_at) VALUES ('t-held', 3, 'ag', '${T0}', '${T0}');
    `)
    const free = await call('PATCH', '/t-free', { assignee_agent_id: 'ag' })
    expect(free.status, await free.clone().text()).toBe(200)
    await new Promise((r) => setTimeout(r, 150))
    expect(bodies).toEqual([])
    const held = await call('PATCH', '/t-held', { assignee_agent_id: 'ag' })
    expect(held.status, await held.clone().text()).toBe(200)
    expect(await receipts(1)).toBe(1)
    expect(bodies).toEqual([{ type: 'mupot.task.assigned', agent_id: 'ag', task_id: 't-held' }])
  })
})
