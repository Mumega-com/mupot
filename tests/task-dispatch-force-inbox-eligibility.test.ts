// tests/task-dispatch-force-inbox-eligibility.test.ts — mupot#1494 round 2 adversarial gate
// (P1-e). task_dispatch({ delivery: 'inbox' }) runs a SYNCHRONOUS eligibility check
// (hasRegisteredDeliverySurface, src/bus/consumer.ts) against the REAL fleet_agents row for
// the task's assignee before deciding whether to thread `delivery:'inbox'` onto the emitted
// event — round 1 let force win unconditionally, which could strand a task in an inbox nobody
// is known to poll. Exercised against real SQLite + the full migration chain (a hand-rolled
// fleet_agents mock is exactly what let that finding through the first gate).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env, BusEvent } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const DEPT_ID = 'dept-1'
const SQUAD_ID = 'squad-1'
const MEMBER_ID = 'member-1'
const AGENT_ID = 'agent-uuid-target'
const TASK_ID = 'task-1'
const T0 = '2026-09-01T00:00:00.000Z'

function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function auth(): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
}

let harness: SqliteD1Harness
let env: Env
let events: BusEvent[]

function seedBase(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'squad-one', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at)
      VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'target-agent', 'Target Agent', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER_ID}', 'Dispatcher', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-1', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
    INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, created_at, updated_at)
      VALUES ('${TASK_ID}', '${SQUAD_ID}', 'Force-inbox test task', 'work', 'open', '${AGENT_ID}', '${T0}', '${T0}');
  `)
}

function makeEnv(): Env {
  events = []
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: async (event: BusEvent) => { events.push(event) } },
  } as unknown as Env
}

describe('task_dispatch({ delivery: "inbox" }) synchronous eligibility (mupot#1494 round 2, P1-e)', () => {
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
    env = makeEnv()
  })

  afterEach(() => harness.close())

  it('is IGNORED against a target with NO fleet_agents row at all — dispatched normally, note returned', async () => {
    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: TASK_ID, delivery: 'inbox' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ dispatched: true, delivery_forced_predicted: 'no_delivery_mode' })
    expect(events).toHaveLength(1)
    expect(Object.prototype.hasOwnProperty.call(events[0].payload as object, 'delivery')).toBe(false)
  })

  it('IS honored against a STALE-but-registered resident (runtime declared, heartbeat long stale)', async () => {
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, last_reported_at, updated_at)
      VALUES ('${AGENT_ID}', '${TENANT}', 'Target', 'claude-code', '[]', 'on_demand', 'running', '${AGENT_ID}', 'generic',
              '${sqliteStamp(Date.now() - 999_999_000)}', '${sqliteStamp(Date.now() - 999_999_000)}');
    `)

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: TASK_ID, delivery: 'inbox' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(res.result).not.toHaveProperty('delivery_forced_predicted')
    expect(events).toHaveLength(1)
    expect((events[0].payload as { delivery?: string }).delivery).toBe('inbox')
  })

  it('IS honored against a poll-registered agent (presence_mode=poll), regardless of its own TTL state', async () => {
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
      VALUES ('${AGENT_ID}', '${TENANT}', 'Target', '', '[]', 'on_demand', 'running', '${AGENT_ID}', 'generic', 'poll', 300,
              '${sqliteStamp(Date.now() - 999_999_000)}', '${sqliteStamp(Date.now() - 999_999_000)}');
    `)

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: TASK_ID, delivery: 'inbox' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(res.result).not.toHaveProperty('delivery_forced_predicted')
    expect((events[0].payload as { delivery?: string }).delivery).toBe('inbox')
  })

  it('is IGNORED against a presence_mode=resident row with no runtime (cleared/de-registered)', async () => {
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
      VALUES ('${AGENT_ID}', '${TENANT}', 'Target', '', '[]', 'on_demand', 'running', '${AGENT_ID}', 'generic', '', NULL,
              '${sqliteStamp(Date.now())}', '${sqliteStamp(Date.now())}');
    `)

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: TASK_ID, delivery: 'inbox' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ delivery_forced_predicted: 'no_delivery_mode' })
  })

  it('WITHOUT delivery, never adds delivery_forced_predicted regardless of fleet state', async () => {
    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: TASK_ID }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(res.result).not.toHaveProperty('delivery_forced_predicted')
  })
})
