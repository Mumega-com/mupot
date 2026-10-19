// tests/doorbell-followups.test.ts — #1892 and the #1890 review threads, on the real migration chain:
//   P1-a broadcast fan-out statement budget      P1-b /doorbells batching + flag-off no-op
//   P2-1 occurrence-keyed task wakes (A->B->A, redispatch)   P2-2 dispatch rings once (shared correlation)
//   P2-3 counter-only release rings (MCP + REST + execution_release)
//   P2-4 test-ping retention + receipts removed on clear     P2-5 waitUntil threaded (no awaited 4s fallback)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendAgentMessage } from '../src/agents/messages'
import {
  RECEIPT_RETENTION_MS,
  clearAgentWebhookDoorbell,
  dispatchDoorbellCorrelation,
  resolveDoorbellRecipients,
  scheduleTaskAssignedDoorbell,
  sendDoorbellTestPing,
  setAgentWebhookDoorbell,
} from '../src/agents/webhook-doorbell'
import { deliverDispatchToInbox } from '../src/bus/fleet-bridge'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { wakeFleetAgent } from '../src/dashboard/fleet'
import { invokeTool } from '../src/mcp'
import type { AuthContext, BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'local'
const BEARER = 'followups-bearer-key-0001'
const AUTHZ = { system: true, reason: 'test' } as const
const T0 = '2026-09-01T00:00:00.000Z'
const MEMBER = 'm-admin'
const CEILING_AT = 3 // EXECUTION_RETRY_CEILING (asserted against the source constant below)

let h: SqliteD1Harness
let env: Env
let sqls: string[]
let posts: Array<{ url: string; body: Record<string, unknown> }>
const realFetch = globalThis.fetch

function countedDb(db: Env['DB']): Env['DB'] {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => { sqls.push(sql); return target.prepare(sql) }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

function makeEnv(flag: string | null = '1'): Env {
  return {
    DB: countedDb(h.db), TENANT_SLUG: TENANT, BRAND: 'Pot', BUS: { send: async (_e: BusEvent) => undefined },
    CONNECTOR_MASTER_KEY: 'f'.repeat(64), WEBHOOK_DOORBELL: flag ?? undefined,
  } as unknown as Env
}

const bellSqls = () => sqls.filter((s) => s.includes('agent_webhook_doorbell'))

function orgAdmin(): AuthContext {
  return {
    userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    capabilities: [{ member_id: MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' }],
  }
}

function agentAuth(agentId: string): AuthContext {
  return {
    userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: agentId,
    capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: 'sq', capability: 'member' }],
  }
}

async function bell(agentId: string): Promise<void> {
  await setAgentWebhookDoorbell(env, { agentId, webhookUrl: `https://hook.example/${agentId}`, bearer: BEARER, createdByMemberId: MEMBER })
}

const receipts = (agent?: string) =>
  h.sqlite.prepare(
    `SELECT agent_id, event_type, ref_id, outcome FROM agent_webhook_doorbell_receipts
      ${agent ? `WHERE agent_id = '${agent}'` : ''} ORDER BY attempted_at, rowid`,
  ).all() as Array<{ agent_id: string; event_type: string; ref_id: string; outcome: string }>

beforeEach(() => {
  sqls = []
  posts = []
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = makeEnv()
  h.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq', 'd1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('ag-a', 'sq', 'agent-a', 'A', 'active'), ('ag-b', 'sq', 'agent-b', 'B', 'active'), ('sender', 'sq', 'sender', 'S', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${MEMBER}', 'admin@x.test', 'Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', '${MEMBER}', 'org', NULL, 'admin');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('t1', 'sq', 't', 'b', 'done', 'open', NULL, '${T0}', '${T0}');
  `)
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    posts.push({ url: String(u), body: JSON.parse(String(init?.body)) })
    return new Response('ok', { status: 200 })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch; h.close(); vi.useRealTimers() })

describe('P1-a broadcast fan-out budget', () => {
  function seedRecipients(n: number): void {
    const rows = Array.from({ length: n }, (_, i) => `('rcpt-${i}', 'sq', 'rcpt-${i}', 'R${i}', 'active')`).join(',')
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ${rows}`)
  }
  async function broadcast(e: Env) {
    const pending: Promise<unknown>[] = []
    const out = await invokeTool(agentAuth('sender'), e, 'broadcast', { body: 'hello all', limit: 100 },
      { origin: 'https://pot.example', transport: 'mcp', waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
    await Promise.all(pending)
    return out
  }

  it('50 recipients, 1 doorbell: a bounded number of doorbell statements and exactly one POST', async () => {
    seedRecipients(50)
    await bell('rcpt-7')
    sqls = []; posts = []
    const out = await broadcast(env)
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect((out.result as { delivered: number }).delivered).toBeGreaterThanOrEqual(50)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toMatchObject({ type: 'mupot.inbox.wake', agent_id: 'rcpt-7' })
    // 2 directory queries (52 candidates / chunks of 40) + the one doorbelled recipient's resolve/claim/prune/finalize (4).
    expect(bellSqls().length).toBeLessThanOrEqual(6)
  })

  it('total D1 statements with the flag on exceed flag-off by a small constant, not by the recipient count', async () => {
    seedRecipients(50)
    await bell('rcpt-7')
    sqls = []
    await broadcast(makeEnv(null))
    const off = sqls.length
    sqls = []
    await broadcast(makeEnv('1'))
    const on = sqls.length
    expect(on - off).toBeLessThanOrEqual(8)
  })

  it('flag off: zero doorbell statements for the whole broadcast', async () => {
    seedRecipients(10)
    sqls = []
    await broadcast(makeEnv(null))
    expect(bellSqls()).toEqual([])
  })

  it('a single send to an agent WITHOUT a doorbell costs exactly one doorbell statement', async () => {
    sqls = []
    const res = await sendAgentMessage(env, { fromAgent: 'sender', fromMember: MEMBER, toAgent: 'ag-b', body: 'x', kind: 'message', requestId: 'r1' }, AUTHZ)
    expect(res.ok).toBe(true)
    expect(bellSqls()).toHaveLength(1)
    expect(posts).toEqual([])
  })

  it('resolveDoorbellRecipients answers by id and by fleet slug, in chunks, with no statement when the flag is off', async () => {
    await bell('ag-a')
    sqls = []
    const set = await resolveDoorbellRecipients(env, ['ag-a', 'ag-b', 'agent-a'])
    expect([...set].sort()).toEqual(['ag-a', 'agent-a'])
    expect(sqls).toHaveLength(1)
    sqls = []
    expect((await resolveDoorbellRecipients(makeEnv(null), ['ag-a'])).size).toBe(0)
    expect(sqls).toEqual([])
  })
})

describe('P1-b /doorbells page', () => {
  async function login(e: Env): Promise<string> {
    const kvStore = new Map<string, string>()
    const withKv = Object.assign(e, {
      LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: 'admin@x.test',
      SESSIONS: { get: async (k: string) => kvStore.get(k) ?? null, put: async (k: string, v: string) => void kvStore.set(k, v), delete: async (k: string) => void kvStore.delete(k) },
    })
    const res = await authApp.request('/dev-login', {}, withKv)
    const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
    if (!m) throw new Error('no session cookie')
    return `mupot_session=${m[1]}`
  }
  function seedMany(squads: number, perSquad: number): void {
    const sq = Array.from({ length: squads }, (_, i) => `('pg-sq-${i}', 'd1', 'pg-sq-${i}', 'PS${i}')`).join(',')
    h.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ${sq}`)
    for (let s = 0; s < squads; s++) {
      const rows = Array.from({ length: perSquad }, (_, i) => `('pg-${s}-${i}', 'pg-sq-${s}', 'pg-${s}-${i}', 'P${s}-${i}', 'active')`).join(',')
      h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ${rows}`)
    }
  }

  it('flag on: ONE doorbell query for 60 agents, and squad authz runs once per squad', async () => {
    seedMany(3, 20)
    await bell('pg-1-3')
    const cookie = await login(env)
    sqls = []
    const res = await dashboardApp.request('/doorbells', { headers: { cookie } }, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('pg-1-3')
    expect(bellSqls()).toHaveLength(1)
    // authz reads the squad scope; with the cache that is one read per distinct squad (4 squads incl. 'sq'), not per agent.
    const scopeReads = sqls.filter((s) => /FROM squads/i.test(s) && /kind/i.test(s) && !/FROM agents/i.test(s))
    expect(scopeReads.length).toBeLessThanOrEqual(6)
  })

  it('flag off and no doorbell rows: the page runs no agent load and no authz loop', async () => {
    seedMany(3, 20)
    const off = makeEnv(null)
    const cookie = await login(off)
    sqls = []
    const res = await dashboardApp.request('/doorbells', { headers: { cookie } }, off)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Doorbells are disabled')
    expect(bellSqls()).toHaveLength(1) // the single list query, nothing else
    expect(sqls.some((s) => /FROM agents/i.test(s))).toBe(false)
  })
})

describe('P2-1 task wakes are keyed by assignment occurrence', () => {
  it('A -> B -> A inside the coalescing window rings A twice and B once', async () => {
    await bell('ag-a'); await bell('ag-b')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-13T10:00:00.000Z'))
    const pending: Promise<unknown>[] = []
    const ctx = { origin: 'https://pot.example', transport: 'mcp' as const, waitUntil: (p: Promise<unknown>) => { pending.push(p) } }
    for (const agent of ['ag-a', 'ag-b', 'ag-a']) {
      vi.setSystemTime(new Date(Date.now() + 50))
      const out = await invokeTool(orgAdmin(), env, 'task_update', { task_id: 't1', assignee_agent_id: agent }, ctx)
      expect(out.ok, JSON.stringify(out)).toBe(true)
      // Deliveries are fire-and-forget (waitUntil) and each one awaits crypto.subtle (real thread pool) before its
      // POST, so under CPU load three in-flight deliveries can finish in any order (#2083). Settle each ring before
      // the next assignment: the A, B, A order the assertion pins is then the delivery order, not a race.
      await Promise.all(pending.splice(0))
    }
    expect(posts.map((p) => p.body.agent_id)).toEqual(['ag-a', 'ag-b', 'ag-a'])
  })

  it('the SAME occurrence reported twice still coalesces', async () => {
    await bell('ag-a')
    await scheduleTaskAssignedDoorbell(env, 'ag-a', 't1', { assignment: 'occ-1' })
    await scheduleTaskAssignedDoorbell(env, 'ag-a', 't1', { assignment: 'occ-1' })
    expect(posts).toHaveLength(1)
    await scheduleTaskAssignedDoorbell(env, 'ag-a', 't1', { assignment: 'occ-2' })
    expect(posts).toHaveLength(2)
  })

  it('the POST body keeps the wire contract (no assignment field)', async () => {
    await bell('ag-a')
    await scheduleTaskAssignedDoorbell(env, 'ag-a', 't1', { assignment: 'occ-1' })
    expect(posts[0].body).toEqual({ type: 'mupot.task.assigned', agent_id: 'ag-a', task_id: 't1' })
  })
})

describe('P2-2 task_dispatch rings an inbox-backed receiver once', () => {
  async function dispatch(ctxPending: Promise<unknown>[]) {
    return invokeTool(orgAdmin(), env, 'task_dispatch', { task_id: 't1' },
      { origin: 'https://pot.example', transport: 'mcp', waitUntil: (p: Promise<unknown>) => { ctxPending.push(p) } })
  }

  it('task_dispatch rings task.assigned keyed by its receipt', async () => {
    await bell('ag-a')
    h.sqlite.prepare("UPDATE tasks SET assignee_agent_id = 'ag-a' WHERE id = 't1'").run()
    const pending: Promise<unknown>[] = []
    const out = await dispatch(pending)
    expect(out.ok, JSON.stringify(out)).toBe(true)
    await Promise.all(pending)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ type: 'mupot.task.assigned', agent_id: 'ag-a', task_id: 't1' })
    const receipt = h.sqlite.prepare('SELECT id FROM task_dispatch_receipts WHERE task_id = ?').get('t1') as { id: string }
    expect(receipts('ag-a')[0].ref_id).toBe(dispatchDoorbellCorrelation(receipt.id))
  })

  it('the inbox.wake of the SAME dispatch receipt is coalesced with it: one POST, not two', async () => {
    await bell('ag-a')
    h.sqlite.prepare("UPDATE tasks SET assignee_agent_id = 'ag-a' WHERE id = 't1'").run()
    const pending: Promise<unknown>[] = []
    await dispatch(pending)
    await Promise.all(pending)
    const receipt = h.sqlite.prepare('SELECT id FROM task_dispatch_receipts WHERE task_id = ?').get('t1') as { id: string }
    await deliverDispatchToInbox(env, {
      agentId: 'ag-a', squadId: 'sq', taskId: 't1', receiptId: receipt.id, dispatchedByMemberId: MEMBER, projectId: null,
    })
    expect(posts).toHaveLength(1)
    expect(receipts('ag-a').map((r) => r.outcome).sort()).toEqual(['posted', 'skipped'])
  })

  it('an explicit redispatch (new receipt) inside the window rings again', async () => {
    await bell('ag-a')
    h.sqlite.prepare("UPDATE tasks SET assignee_agent_id = 'ag-a' WHERE id = 't1'").run()
    const pending: Promise<unknown>[] = []
    expect((await dispatch(pending)).ok).toBe(true)
    h.sqlite.prepare("UPDATE task_dispatch_receipts SET consumed_at = ?, settled_at = ?, settled_stage = 'failed' WHERE task_id = 't1'").run(Date.now(), new Date().toISOString())
    const second = await dispatch(pending)
    expect(second.ok, JSON.stringify(second)).toBe(true)
    await Promise.all(pending)
    expect(posts).toHaveLength(2)
  })
})

describe('P2-3 a counter-only release is wake-worthy', () => {
  beforeEach(async () => {
    await bell('ag-a')
    h.sqlite.prepare("UPDATE tasks SET assignee_agent_id = 'ag-a', status = 'blocked' WHERE id = 't1'").run()
    h.sqlite.prepare(
      `INSERT INTO task_execution_attempts (task_id, refused_count, last_agent_id, last_reason, first_at, last_at)
       VALUES ('t1', ${CEILING_AT}, 'ag-a', 'refused', '${T0}', '${T0}')`,
    ).run()
  })
  const ctxWith = (pending: Promise<unknown>[]) => ({ origin: 'https://pot.example', transport: 'mcp' as const, waitUntil: (p: Promise<unknown>) => { pending.push(p) } })

  it('MCP task_update re-assigning the same agent after a counter-only release rings', async () => {
    const pending: Promise<unknown>[] = []
    const out = await invokeTool(orgAdmin(), env, 'task_update', { task_id: 't1', assignee_agent_id: 'ag-a' }, ctxWith(pending))
    expect(out.ok, JSON.stringify(out)).toBe(true)
    await Promise.all(pending)
    expect(h.sqlite.prepare("SELECT 1 FROM task_execution_attempts WHERE task_id = 't1'").get()).toBeUndefined()
    expect(posts).toHaveLength(1)
  })

  it('without a stuck counter the same no-op reassignment does not ring', async () => {
    h.sqlite.prepare("DELETE FROM task_execution_attempts WHERE task_id = 't1'").run()
    const pending: Promise<unknown>[] = []
    await invokeTool(orgAdmin(), env, 'task_update', { task_id: 't1', assignee_agent_id: 'ag-a' }, ctxWith(pending))
    await Promise.all(pending)
    expect(posts).toHaveLength(0)
  })

  it('MCP execution_release of a stuck counter rings the assignee', async () => {
    const pending: Promise<unknown>[] = []
    const out = await invokeTool(orgAdmin(), env, 'execution_release', { task_id: 't1', reason: 'unstick' }, ctxWith(pending))
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(out.result).toMatchObject({ status: 'not_held' })
    await Promise.all(pending)
    expect(posts).toHaveLength(1)
  })

  it('the stuck counter is reported by releaseExecutionHoldDetailed', async () => {
    const { releaseExecutionHoldDetailed } = await import('../src/agents/execution-brakes')
    const r = await releaseExecutionHoldDetailed(env, { taskId: 't1', memberId: MEMBER, reason: 'x', via: 'execution_release' })
    expect(r).toEqual({ outcome: 'not_held', clearedCounter: true, liftedAnything: true })
    const again = await releaseExecutionHoldDetailed(env, { taskId: 't1', memberId: MEMBER, reason: 'x', via: 'execution_release' })
    expect(again).toEqual({ outcome: 'not_held', clearedCounter: false, liftedAnything: false })
  })
})

describe('P2-4 receipt retention', () => {
  const old = () => new Date(Date.now() - RECEIPT_RETENTION_MS - 60_000).toISOString()
  const insertOld = (agent: string, type: string) =>
    h.sqlite.prepare(
      `INSERT INTO agent_webhook_doorbell_receipts (id, tenant, agent_id, event_type, ref_id, outcome, attempted_at)
       VALUES (?, ?, ?, ?, 'old', 'posted', ?)`,
    ).run(crypto.randomUUID(), TENANT, agent, type, old())

  it('a test ping prunes that agent\'s expired receipts', async () => {
    await bell('ag-a'); await bell('ag-b')
    insertOld('ag-a', 'mupot.doorbell.test'); insertOld('ag-a', 'mupot.inbox.wake'); insertOld('ag-b', 'mupot.doorbell.test')
    const d = await sendDoorbellTestPing(env, 'ag-a')
    expect(d.outcome).toBe('posted')
    const left = receipts().map((r) => `${r.agent_id}:${r.ref_id}`)
    expect(left).not.toContain('ag-a:old')
    expect(left).toContain('ag-b:old') // other agents untouched
  })

  it('clearing a doorbell deletes that agent\'s receipts only', async () => {
    await bell('ag-a'); await bell('ag-b')
    await sendDoorbellTestPing(env, 'ag-a'); await sendDoorbellTestPing(env, 'ag-b')
    expect(receipts().length).toBe(2)
    expect(await clearAgentWebhookDoorbell(env, 'ag-a')).toBe(true)
    expect(receipts().map((r) => r.agent_id)).toEqual(['ag-b'])
    expect(await clearAgentWebhookDoorbell(env, 'ag-a')).toBe(false)
  })
})

describe('P2-5 waitUntil is threaded (the POST outlives the response; nothing is awaited)', () => {
  function hangFetch(): void {
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch
  }

  it('wake_agent hands the doorbell POST to ctx.waitUntil', async () => {
    await bell('ag-a')
    // the in-Worker route refuses, so the wake falls through to the durable inbox send (which rings the doorbell)
    Object.assign(env, { AGENT: { idFromName: () => 'do', get: () => ({ fetch: async () => new Response('no', { status: 500 }) }) } })
    hangFetch()
    const pending: Promise<unknown>[] = []
    const t0 = Date.now()
    const out = await invokeTool(orgAdmin(), env, 'wake_agent', { agent_id: 'ag-a' },
      { origin: 'https://pot.example', transport: 'mcp', waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(pending.length).toBeGreaterThan(0)
    expect(Date.now() - t0).toBeLessThan(2500) // a hung Bot must not hold the response for the 4s await ceiling
  })

  it('wakeFleetAgent hands the doorbell POST to the waitUntil it is given', async () => {
    const fleetEnv = makeEnv()
    await bell('ag-a')
    hangFetch()
    const pending: Promise<unknown>[] = []
    const t0 = Date.now()
    const ok = await wakeFleetAgent(fleetEnv, 'ag-a', { memberId: MEMBER, boundAgentId: 'sender', label: 'admin' }, (p) => { pending.push(p) })
    expect(ok).toBe(true)
    expect(pending.length).toBeGreaterThan(0)
    expect(Date.now() - t0).toBeLessThan(2500)
  })
})
