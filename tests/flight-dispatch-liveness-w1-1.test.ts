// tests/flight-dispatch-liveness-w1-1.test.ts — W1-1: flight_dispatch applies the SAME receiver-liveness
// fence task_dispatch uses (mupot#1729). The flight.dispatch/v1 message lands in the EXECUTOR's inbox, so a
// STOPPED executor seat is refused before any flight row or inbox message exists; a stale poll seat is NOT
// refused (store-and-forward mailbox) and the dispatcher gets a receiver_stale warning, exactly as
// task_dispatch does. A live (or fleet-less) executor flies as before.
// Real-schema harness (applyAllMigrations); assertions are on the executor's inbox, not just the return value.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const SQUAD = 'squad-1'
const MEMBER = 'member-1'
const CALLER = 'agent-caller'
const EXEC = 'agent-exec'
const T0 = '2026-09-01T00:00:00.000Z'
const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
const STALE = stamp(Date.now() - 999_999_000)
const FRESH = () => stamp(Date.now())

let h: SqliteD1Harness
let env: Env

const auth = (): AuthContext => ({
  userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  boundAgentId: CALLER,
  capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'lead' }],
})

const meta = {
  schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: [SQUAD], task_ids: ['task-1'],
  done_when: ['done'], artifact_refs: [], receipt_refs: [], confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
}
const signals = {
  contextComplete: true, toolsReachable: true, budgetRemainingMicroUsd: 999_000_000, budgetEstimateMicroUsd: 1,
  recentProgress: 0.9, progressPerStep: 0.8, wastePerStep: 0.1, stepSeconds: 10,
}
const dispatch = (extra: Record<string, unknown> = {}) =>
  invokeTool(auth(), env, 'flight_dispatch', {
    squad_id: SQUAD, goal: 'ship it', meta_json: JSON.stringify(meta), signals_json: JSON.stringify(signals), budget_micro_usd: 0, ...extra,
  }, 'https://pot.example')

function fleet(agentId: string, o: { status?: string; mode?: string; at: string }) {
  h.sqlite.prepare(
    `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
     VALUES (?, ?, 'T', '', '[]', 'on_demand', ?, ?, 'generic', ?, ?, ?, ?)`,
  ).run(agentId, TENANT, o.status ?? 'running', agentId, o.mode ?? '', o.mode === 'poll' ? 300 : null, o.at, o.at)
}
const detach = (agentId: string) => h.sqlite.prepare(
  `UPDATE fleet_agents SET status='stopped', presence_mode='', presence_ttl_sec=NULL, last_reported_at=datetime('now') WHERE agent_id=?`).run(agentId)

const inbox = (agentId: string) => h.sqlite.prepare('SELECT * FROM agent_messages WHERE to_agent = ?').all(agentId)
const flights = () => h.sqlite.prepare('SELECT * FROM flights').all()

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.example' } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('${CALLER}', '${SQUAD}', 'caller', 'C', 'active', '${T0}');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('${EXEC}', '${SQUAD}', 'exec', 'E', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER}', 'M', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c1', '${MEMBER}', 'squad', '${SQUAD}', 'lead');
    INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, created_at, updated_at)
      VALUES ('task-1', '${SQUAD}', 't', 'b', 'in_progress', '${CALLER}', '${T0}', '${T0}');
  `)
})
afterEach(() => h.close())

describe('flight_dispatch executor liveness (W1-1)', () => {
  it('baseline: a live delegated executor flies, and the flight.dispatch/v1 message lands in its inbox', async () => {
    fleet(EXEC, { mode: 'poll', at: FRESH() })
    const r = await dispatch({ executor_agent_id: EXEC })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.ok && r.result).toMatchObject({ delivered: true })
    expect(r.ok && r.result).not.toHaveProperty('warning')
    expect(inbox(EXEC)).toHaveLength(1)
  })

  it('STOPPED delegated executor -> 409 receiver_not_live with reason, no flight row, NO inbox message', async () => {
    fleet(EXEC, { mode: 'poll', at: FRESH() })
    detach(EXEC)
    const r = await dispatch({ executor_agent_id: EXEC })
    expect(r).toMatchObject({ ok: false, status: 409, error: 'receiver_not_live' })
    expect(r.ok === false && r.detail).toMatchObject({ agent_id: EXEC, status: 'stopped', live: false, reason: 'stopped' })
    expect(inbox(EXEC)).toHaveLength(0)
    expect(flights()).toHaveLength(0)
  })

  it('the refusal carries a next_step through the MCP envelope (refusal-next-step rule)', async () => {
    const { refusalGuidance } = await import('../src/mcp/refusal-next-step')
    fleet(EXEC, { mode: 'poll', at: FRESH() })
    detach(EXEC)
    const r = await dispatch({ executor_agent_id: EXEC })
    expect(r.ok).toBe(false)
    if (r.ok) return
    const g = refusalGuidance(r.error, r.status, r.detail, 'flight_dispatch')
    expect(g.next_step).toMatch(/executor_agent_id/)
    expect(g.next_tool).toBe('fleet_agent_get')
  })

  it('STOPPED self-dispatch (executor is the caller) is refused the same way, no inbox message', async () => {
    fleet(CALLER, { mode: 'poll', at: FRESH() })
    detach(CALLER)
    const r = await dispatch()
    expect(r).toMatchObject({ ok: false, status: 409, error: 'receiver_not_live' })
    expect(inbox(CALLER)).toHaveLength(0)
    expect(flights()).toHaveLength(0)
  })

  it('STALE poll executor is NOT refused (task_dispatch precedent): dispatches, delivers, and surfaces a receiver_stale warning', async () => {
    fleet(EXEC, { mode: 'poll', at: STALE })
    const r = await dispatch({ executor_agent_id: EXEC })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.ok && r.result).toMatchObject({
      delivered: true,
      warning: { code: 'receiver_stale', agent_id: EXEC, last_reported_at: STALE, presence_ttl_sec: 300 },
      warnings: [{ code: 'receiver_stale', agent_id: EXEC }],
    })
    expect(inbox(EXEC)).toHaveLength(1)
  })

  it('existing self-dispatch path still works: no fleet row for the caller -> flies, delivered, no warning', async () => {
    const r = await dispatch()
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.ok && r.result).toMatchObject({ delivered: true })
    expect(r.ok && r.result).not.toHaveProperty('warning')
    expect(inbox(CALLER)).toHaveLength(1)
  })

  it('live self-dispatch (caller has a live fleet row) flies as before', async () => {
    fleet(CALLER, { mode: 'poll', at: FRESH() })
    const r = await dispatch()
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(inbox(CALLER)).toHaveLength(1)
  })
})
