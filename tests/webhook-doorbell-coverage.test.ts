// Doorbell coverage: no-ctx delivery, coalescing, slug addressing, hold-lift ring, router auto-assign ring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendAgentMessage } from '../src/agents/messages'
import {
  COALESCE_WINDOW_MS,
  WAKE_BURST_LIMIT,
  fireWebhookDoorbell,
  scheduleWebhookDoorbell,
  setAgentWebhookDoorbell,
} from '../src/agents/webhook-doorbell'
import { runRouterTick } from '../src/router/engine'
import type { BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-cov'
const BEARER = 'coverage-bearer-key-0001'
const AUTHZ = { system: true, reason: 'test' } as const
let h: SqliteD1Harness
let env: Env
let calls: Array<{ url: string; body: Record<string, unknown> }>
const realFetch = globalThis.fetch

const receipts = () =>
  h.sqlite.prepare('SELECT event_type, outcome, http_status, reason FROM agent_webhook_doorbell_receipts ORDER BY attempted_at, rowid').all() as Array<Record<string, unknown>>

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = {
    DB: h.db, TENANT_SLUG: TENANT, BUS: { send: async (_e: BusEvent) => undefined },
    CONNECTOR_MASTER_KEY: 'e'.repeat(64), WEBHOOK_DOORBELL: '1',
  } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq', 'd1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-1', 'sq', 'grokbot-ceo', 'CEO', 'active'), ('ag-2', 'sq', 'sender', 'S', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('m1', 'M', 'active', '${TENANT}');
  `)
  await setAgentWebhookDoorbell(env, { agentId: 'ag-1', webhookUrl: 'https://hook.example/ceo', bearer: BEARER, createdByMemberId: 'm1' })
  calls = []
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    calls.push({ url: String(u), body: JSON.parse(String(init?.body)) })
    return new Response('ok', { status: 200 })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch; h.close(); vi.useRealTimers() })

const send = (rid: string, opts: Record<string, unknown> = {}) => sendAgentMessage(env, {
  fromAgent: 'ag-2', fromMember: 'm1', toAgent: 'ag-1', body: `hi ${rid}`, kind: 'message', requestId: rid,
}, AUTHZ, opts)

describe('delivery without a waitUntil (cron, queue consumer, routine actions...)', () => {
  it('the POST and its receipt have happened by the time send returns', async () => {
    const res = await send('r-noctx')
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toMatchObject({ type: 'mupot.inbox.wake', agent_id: 'ag-1' })
    expect(receipts()).toEqual([{ event_type: 'mupot.inbox.wake', outcome: 'posted', http_status: 200, reason: null }])
  })

  it('a hung webhook cannot hold the caller past the bounded ceiling; send still succeeds', async () => {
    globalThis.fetch = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })) as typeof fetch
    const started = Date.now()
    const res = await send('r-hang')
    expect(Date.now() - started).toBeLessThan(4500)
    expect(res.ok).toBe(true)
    expect(receipts()).toEqual([{ event_type: 'mupot.inbox.wake', outcome: 'failed', http_status: null, reason: 'timeout' }])
  })

  it('with a waitUntil the caller does not wait: the promise is handed over', async () => {
    const pending: Promise<unknown>[] = []
    await send('r-ctx', { waitUntil: (p: Promise<unknown>) => pending.push(p) })
    expect(pending).toHaveLength(1)
    await Promise.all(pending)
    expect(calls).toHaveLength(1)
  })
})

describe('response handling', () => {
  it('releases the response body without reading it', async () => {
    let cancelled = 0
    globalThis.fetch = (async () => ({ ok: true, status: 200, body: { cancel: async () => { cancelled += 1 } } })) as unknown as typeof fetch
    await send('body-1')
    expect(cancelled).toBe(1)
    expect(receipts()).toEqual([{ event_type: 'mupot.inbox.wake', outcome: 'posted', http_status: 200, reason: null }])
  })
})

describe('coalescing (one POST per agent per 10s window)', () => {
  it('every DISTINCT message rings (no stranded follow-ups); only a burst above the cap is skipped, then it rings again', async () => {
    for (const rid of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']) await send(rid)
    expect(calls).toHaveLength(WAKE_BURST_LIMIT)
    expect(receipts().at(-1)).toMatchObject({ outcome: 'skipped', reason: 'coalesced' })
    h.sqlite.prepare('UPDATE agent_webhook_doorbell_receipts SET attempted_at = ?').run(new Date(Date.now() - COALESCE_WINDOW_MS - 1000).toISOString())
    await send('c8')
    expect(calls).toHaveLength(WAKE_BURST_LIMIT + 1)
  })

  it('a task assigned right after a message wake still rings (gate r2: no stranded task)', async () => {
    await send('m1')
    const { scheduleTaskAssignedDoorbell } = await import('../src/agents/webhook-doorbell')
    await scheduleTaskAssignedDoorbell(env, 'ag-1', 'task-1')
    expect(calls.map((c) => c.body.type)).toEqual(['mupot.inbox.wake', 'mupot.task.assigned'])
  })

  it('the SAME event ref twice in the window is one POST', async () => {
    const wake = { type: 'mupot.task.assigned' as const, agent_id: 'ag-1', task_id: 'task-same' }
    await fireWebhookDoorbell(env, wake)
    await fireWebhookDoorbell(env, wake)
    expect(calls).toHaveLength(1)
  })

  it('a failed POST does not block the next distinct wake, but failures count toward the burst cap', async () => {
    globalThis.fetch = (async () => { throw new Error('down') }) as typeof fetch
    for (let i = 0; i < WAKE_BURST_LIMIT + 1; i++) await send(`f${i}`)
    const outcomes = receipts().map((r) => r.outcome)
    expect(outcomes.slice(0, WAKE_BURST_LIMIT)).toEqual(Array(WAKE_BURST_LIMIT).fill('failed'))
    expect(outcomes.at(-1)).toBe('skipped')
  })

  it('old receipts of the same agent are pruned when it rings (14-day retention)', async () => {
    h.sqlite.prepare(
      "INSERT INTO agent_webhook_doorbell_receipts (id, tenant, agent_id, event_type, ref_id, outcome, attempted_at) VALUES ('old', ?, 'ag-1', 'mupot.inbox.wake', 'x', 'posted', ?)",
    ).run(TENANT, new Date(Date.now() - 15 * 24 * 3600_000).toISOString())
    await send('p1')
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM agent_webhook_doorbell_receipts WHERE id = 'old'").get()).toEqual({ n: 0 })
  })
})

describe('agent addressed by slug (dispatch bridge uses the fleet row id)', () => {
  it('a wake for the slug rings the doorbell of the one agent with that slug, with the canonical id in the payload', async () => {
    await fireWebhookDoorbell(env, { type: 'mupot.task.assigned', agent_id: 'grokbot-ceo', task_id: 't-9' })
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ type: 'mupot.task.assigned', agent_id: 'ag-1', task_id: 't-9' })
  })

  it('an AMBIGUOUS slug rings nothing', async () => {
    h.sqlite.exec("INSERT INTO squads (id, department_id, slug, name) VALUES ('sq2', 'd1', 'sq2', 'Sq2'); INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-3', 'sq2', 'grokbot-ceo', 'CEO2', 'active')")
    await fireWebhookDoorbell(env, { type: 'mupot.task.assigned', agent_id: 'grokbot-ceo', task_id: 't-9' })
    expect(calls).toHaveLength(0)
  })

  it('an agent whose SLUG equals another agent\'s id never receives that agent\'s wakes (gate r2 on #1890)', async () => {
    // ag-2 has no doorbell. ag-evil's slug is shaped like ag-2's id and has its own doorbell.
    h.sqlite.exec("INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-evil', 'sq', 'ag-2', 'Evil', 'active')")
    await setAgentWebhookDoorbell(env, { agentId: 'ag-evil', webhookUrl: 'https://attacker.example/x', bearer: BEARER, createdByMemberId: 'm1' })
    await fireWebhookDoorbell(env, { type: 'mupot.task.assigned', agent_id: 'ag-2', task_id: 't-x' })
    expect(calls).toHaveLength(0)
  })

  it('an exact id wins over a colliding slug when both have doorbells', async () => {
    h.sqlite.exec("INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-evil', 'sq', 'ag-1', 'Evil', 'active')")
    await setAgentWebhookDoorbell(env, { agentId: 'ag-evil', webhookUrl: 'https://attacker.example/x', bearer: BEARER, createdByMemberId: 'm1' })
    await fireWebhookDoorbell(env, { type: 'mupot.task.assigned', agent_id: 'ag-1', task_id: 't-y' })
    expect(calls.map((c) => c.url)).toEqual(['https://hook.example/ceo'])
  })

  it('schedule is a no-op with the flag off', async () => {
    await scheduleWebhookDoorbell({ ...env, WEBHOOK_DOORBELL: undefined } as unknown as Env, { type: 'mupot.task.assigned', agent_id: 'ag-1', task_id: 't' })
    expect(calls).toHaveLength(0)
  })
})

describe('router_tick auto-assign rings the assignee (mupot#1882)', () => {
  it('assigning an open task to a live agent with a doorbell posts mupot.task.assigned', async () => {
    h.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-op', 'm1', 'squad', 'sq', 'lead');
      INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
        VALUES ('${TENANT}', 'seat-1', 'W', 'test', 'seat-1', 'ag-1', datetime('now'), datetime('now'));
      INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, gate_owner, created_at, updated_at)
        VALUES ('task-r', 'sq', 't', 'b', 'done', 'open', NULL, NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    `)
    const r = await runRouterTick(
      env,
      { ok: true, tenant: TENANT, squadId: 'sq', agentId: null, source: 'principal' },
      { squadId: 'sq', dryRun: false },
      { memberId: 'm1' },
    )
    expect(r.assigned).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ type: 'mupot.task.assigned', agent_id: 'ag-1', task_id: 'task-r' })
  })
})

describe('test ping rate limit is atomic (gate r2 on #1890)', () => {
  it('12 parallel test pings send at most 5', async () => {
    const { sendDoorbellTestPing } = await import('../src/agents/webhook-doorbell')
    const results = await Promise.all(Array.from({ length: 12 }, () => sendDoorbellTestPing(env, 'ag-1')))
    expect(calls.length).toBeLessThanOrEqual(5)
    expect(results.filter((r) => r.outcome === 'rate_limited').length).toBeGreaterThanOrEqual(7)
  })
})
