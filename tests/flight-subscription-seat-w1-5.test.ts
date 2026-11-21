// tests/flight-subscription-seat-w1-5.test.ts — W1-5 (first slice of bd21b349 "budget by plan type").
//
// A subscription (CLI) seat has no per-call dollar meter. It dispatches with cost_metered:false
// and budget 0; the flight is recorded unmetered and lands with no cost and no cost check.
// Metered seats (the default) keep the dollar budget exactly as before.
//
// Real SQLite, the whole migration chain, the real MCP handlers (flight_dispatch, task_update,
// task_verdict, flight_land).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import type { FlightRow } from '../src/flight/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'pot-w1-5'
const SQUAD_ID = 'squad-a'
const EXEC_AGENT = 'agent-exec'
const EXEC_MEMBER = 'member-exec'
const GATE_MEMBER = 'member-gate'
const GATE = 'gate:review-a'
const ORIGIN = 'https://pot.test'

const signals = {
  contextComplete: true, toolsReachable: true, budgetRemainingMicroUsd: 0, budgetEstimateMicroUsd: 0,
  recentProgress: 0.9, progressPerStep: 0.8, wastePerStep: 0.1, stepSeconds: 5,
}

function meta(taskIds: string[]): Record<string, unknown> {
  return {
    schema: 'mupot.flight.meta/v1', goal_id: 'goal-w1-5', objective_id: 'objective-w1-5',
    squad_ids: [SQUAD_ID], task_ids: taskIds, done_when: ['done'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  }
}

function execAuth(capability: 'member' | 'lead' = 'member'): AuthContext {
  return {
    userId: EXEC_MEMBER, memberId: EXEC_MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: EXEC_AGENT,
    capabilities: [{ member_id: EXEC_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability }],
  }
}

function gateAuth(): AuthContext {
  return {
    userId: GATE_MEMBER, memberId: GATE_MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: GATE_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
}

function envFor(h: SqliteD1Harness): Env {
  const sessions = new Map<string, string>()
  return {
    DB: h.db, TENANT_SLUG: TENANT, LAND_REQUIRES_EVIDENCE: '0',
    BUS: { send: vi.fn(async () => undefined) },
    SESSIONS: {
      async get(key: string, type?: string) {
        const value = sessions.get(key) ?? null
        return type === 'json' && value ? JSON.parse(value) : value
      },
      async put(key: string, value: string) { sessions.set(key, value) },
    },
  } as unknown as Env
}

function seed(h: SqliteD1Harness, taskIds: string[]): void {
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${EXEC_AGENT}', '${SQUAD_ID}', 'exec', 'Exec', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${GATE_MEMBER}', 'gate@test', 'Gate', 'active', '${TENANT}');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
    VALUES ('grant-gate', '${GATE}', 'member', '${GATE_MEMBER}', 'test', datetime('now'));
  `)
  for (const id of taskIds) {
    h.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
       VALUES (?, ?, 'T', 'body', 'done', 'in_progress', ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(id, SQUAD_ID, GATE, EXEC_AGENT, `Work done.\nArtifact: /tmp/${id}.txt\nSHA256: 46409ea69826a6733ced5dd67fc0a9080601cbaaacd7a02192732356d25c0c88`)
  }
}

function row(h: SqliteD1Harness, id: string): FlightRow {
  return h.sqlite.prepare('SELECT * FROM flights WHERE id = ?').get(id) as unknown as FlightRow
}

let h: SqliteD1Harness
let env: Env

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seed(h, ['task-1'])
  env = envFor(h)
})
afterEach(() => h.close())

function dispatch(extra: Record<string, unknown> = {}, who = execAuth()) {
  return invokeTool(who, env, 'flight_dispatch', {
    squad_id: SQUAD_ID, goal: 'W1-5', meta_json: JSON.stringify(meta(['task-1'])), signals_json: JSON.stringify(signals), ...extra,
  }, ORIGIN)
}

async function dispatchedId(extra: Record<string, unknown> = {}, who = execAuth()): Promise<string> {
  const res = await dispatch(extra, who)
  expect(res.ok, JSON.stringify(res)).toBe(true)
  return (res as { ok: true; result: { flight: FlightRow } }).result.flight.id
}

/** Gate the flight's task through the real path: review -> approve -> done. */
async function finishTask(): Promise<void> {
  for (const [who, args] of [
    [execAuth(), { task_id: 'task-1', status: 'review' }],
  ] as const) expect((await invokeTool(who, env, 'task_update', args, ORIGIN)).ok).toBe(true)
  expect((await invokeTool(gateAuth(), env, 'task_verdict', { task_id: 'task-1', verdict: 'approved', note: 'gate' }, ORIGIN)).ok).toBe(true)
  expect((await invokeTool(gateAuth(), env, 'task_update', { task_id: 'task-1', status: 'done' }, ORIGIN)).ok).toBe(true)
}

const land = (args: Record<string, unknown>) => invokeTool(execAuth(), env, 'flight_land', args, ORIGIN)

describe('W1-5 subscription (CLI) seat: no dollar budget on the flight path', () => {
  it('FENCE: dispatch cost_metered:false records the flight unmetered, and it lands with no cost and no cost check', async () => {
    const res = await dispatch({ cost_metered: false })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const dispatched = (res as { ok: true; result: { flight: Record<string, unknown> } }).result.flight
    expect(dispatched).toMatchObject({ budget_micro_usd: 0, cost_metered: false, cost_micro_usd: null })
    const id = dispatched.id as string
    expect(row(h, id).cost_metered).toBe(0)

    await finishTask()
    const landed = await land({ flight_id: id, score: 0.9 })
    expect(landed.ok, JSON.stringify(landed)).toBe(true)
    expect((landed as { ok: true; result: { flight: Record<string, unknown> } }).result.flight)
      .toMatchObject({ status: 'landed', cost_metered: false, cost_micro_usd: null })
    expect(row(h, id)).toMatchObject({ status: 'landed', cost_metered: 0, cost_micro_usd: 0 })
    const payload = JSON.parse((h.sqlite.prepare('SELECT payload FROM flight_event_outbox WHERE flight_id = ?').get(id) as { payload: string }).payload)
    expect(payload).toMatchObject({ cost_micro_usd: null, cost_metered: false, budget_compliance: 'unknown' })
  })

  it('a subscription flight still refuses an unfinished task (only the cost check is dropped)', async () => {
    const id = await dispatchedId({ cost_metered: false })
    const early = await land({ flight_id: id })
    expect(early).toMatchObject({ ok: false, status: 409, error: 'flight_tasks_incomplete' })
    expect(row(h, id).status).toBe('running')
  })

  it('GUARD: a subscription flight cannot carry a dollar budget', async () => {
    const out = await dispatch({ cost_metered: false, budget_micro_usd: 5 }, execAuth('lead'))
    expect(out).toMatchObject({ ok: false, status: 400, error: 'invalid_flight_budget' })
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM flights').get()).toEqual({ n: 0 })
  })

  it('a non-boolean cost_metered on dispatch is refused (input schema)', async () => {
    const out = await dispatch({ cost_metered: 'no' })
    expect(out).toMatchObject({ ok: false, status: 400 })
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM flights').get()).toEqual({ n: 0 })
  })
})

describe('W1-5 metered seats behave exactly as before', () => {
  it('default dispatch is metered: budget 0, cost_metered true', async () => {
    const res = await dispatch()
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect((res as { ok: true; result: { flight: Record<string, unknown> } }).result.flight)
      .toMatchObject({ budget_micro_usd: 0, cost_metered: true, cost_micro_usd: 0 })
  })

  it('GUARD: a metered flight landed with no cost is still refused (no fabricated metered 0)', async () => {
    const id = await dispatchedId()
    await finishTask()
    expect(await land({ flight_id: id })).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    expect(row(h, id).status).toBe('waiting')
  })

  it('a metered budget breach is still refused at budget 0', async () => {
    const id = await dispatchedId()
    await finishTask()
    expect(await land({ flight_id: id, cost_micro_usd: 1 }))
      .toMatchObject({ ok: false, status: 409, error: 'flight_budget_exceeded', detail: { budget_micro_usd: 0 } })
    expect(row(h, id).status).toBe('waiting')
  })

  it('a metered budget breach is still refused with a lead-set budget, and within budget lands metered', async () => {
    const over = await dispatchedId({ budget_micro_usd: 100 }, execAuth('lead'))
    await finishTask()
    expect(await land({ flight_id: over, cost_micro_usd: 101 }))
      .toMatchObject({ ok: false, status: 409, error: 'flight_budget_exceeded', detail: { budget_micro_usd: 100 } })
    const ok = await land({ flight_id: over, cost_micro_usd: 100 })
    expect(ok.ok, JSON.stringify(ok)).toBe(true)
    expect(row(h, over)).toMatchObject({ status: 'landed', cost_metered: 1, cost_micro_usd: 100 })
  })

  it('a subscription flight that explicitly reports a cost is judged as metered (budget 0 is enforced)', async () => {
    const id = await dispatchedId({ cost_metered: false })
    await finishTask()
    expect(await land({ flight_id: id, cost_micro_usd: 1 }))
      .toMatchObject({ ok: false, status: 409, error: 'flight_budget_exceeded' })
    expect(row(h, id).status).toBe('waiting')
  })
})
