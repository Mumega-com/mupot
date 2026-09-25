// tests/flight-waiting-and-rebooking-1540.test.ts — mupot#1540.
//
// Real SQLite, the WHOLE committed migration chain (applyAllMigrations — including
// 0172's tasks.status triggers), and the REAL MCP tool handlers (invokeTool:
// flight_dispatch, task_update, task_verdict, flight_land, flight_reap_stalled) plus the
// real scheduled sweep (sweepStalledFlights) driven by an injected clock. Nothing here
// hand-writes the flight transition: every running⇄waiting move is produced by the
// production task write path firing the production trigger.
//
//   A. running → waiting when every task is parked at a gate; the watchdog does not reap
//      it at 60m, escalates at 24h (from waiting_since), and flight_land accepts it; a
//      reject sends it back to running with the stall clock restarted.
//   B. meta.timeout_ms is accepted, bounded, and honoured by the watchdog.
//   C. a landed task cannot be re-booked without a receipted, lead-gated override;
//      client_request_id makes a retried dispatch return the original flight.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import type { FlightRow } from '../src/flight/service'
import { sweepStalledFlights } from '../src/flight/watchdog'
import { canonicalFlightMetaSql } from '../src/flight/meta-sql'
import { createFlight, FlightIdempotencyConflictError } from '../src/flight/service'
import { runRoutineScheduler } from '../src/routines/scheduler'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'pot-1540'
const SQUAD_ID = 'squad-a'
const EXEC_AGENT = 'agent-exec'
const OTHER_AGENT = 'agent-other'
const EXEC_MEMBER = 'member-exec'
const GATE_MEMBER = 'member-gate'
const LEAD_MEMBER = 'member-lead'
const GATE = 'gate:review-a'
const ORIGIN = 'https://pot.test'
const MIN = 60 * 1000
const HOUR = 60 * MIN

const signals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 100,
  budgetEstimateMicroUsd: 0,
  recentProgress: 0.9,
  progressPerStep: 0.8,
  wastePerStep: 0.1,
  stepSeconds: 5,
}

function meta(taskIds: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'mupot.flight.meta/v1',
    goal_id: 'goal-1540',
    objective_id: 'objective-1540',
    squad_ids: [SQUAD_ID],
    task_ids: taskIds,
    done_when: ['done'],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
    ...extra,
  }
}

function execAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: EXEC_MEMBER,
    memberId: EXEC_MEMBER,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: EXEC_AGENT,
    capabilities: [{ member_id: EXEC_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
    ...overrides,
  }
}

function leadAuth(): AuthContext {
  return execAuth({
    userId: LEAD_MEMBER,
    memberId: LEAD_MEMBER,
    capabilities: [{ member_id: LEAD_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
  })
}

function otherAgentAuth(): AuthContext {
  return execAuth({ boundAgentId: OTHER_AGENT })
}

/** The gate reviewer: a different principal from the executor, holding the gate grant. */
function gateAuth(): AuthContext {
  return {
    userId: GATE_MEMBER,
    memberId: GATE_MEMBER,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: GATE_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
}

function envFor(harness: SqliteD1Harness): Env {
  const sessions = new Map<string, string>()
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: vi.fn(async () => undefined) },
    SESSIONS: {
      async get(key: string, type?: string) {
        const value = sessions.get(key) ?? null
        return type === 'json' && value ? JSON.parse(value) : value
      },
      async put(key: string, value: string) {
        sessions.set(key, value)
      },
    },
  } as unknown as Env
}

function seed(harness: SqliteD1Harness, taskIds: string[]): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${EXEC_AGENT}', '${SQUAD_ID}', 'exec', 'Exec', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${OTHER_AGENT}', '${SQUAD_ID}', 'other', 'Other', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${GATE_MEMBER}', 'gate@test', 'Gate', 'active', '${TENANT}');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
    VALUES ('grant-gate', '${GATE}', 'member', '${GATE_MEMBER}', 'test', datetime('now'));
  `)
  for (const id of taskIds) {
    harness.sqlite
      .prepare(
        `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
         VALUES (?, ?, 'T', 'body', 'done', 'in_progress', ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      // Server-side artifact verification is shape-only (src/tasks/artifact-verification.ts).
      .run(id, SQUAD_ID, GATE, EXEC_AGENT, `Work done.\nArtifact: /tmp/${id}.txt\nSHA256: ${'a'.repeat(64)}`)
  }
}

function flightRow(harness: SqliteD1Harness, id: string): FlightRow {
  return harness.sqlite.prepare('SELECT * FROM flights WHERE id = ?').get(id) as unknown as FlightRow
}

function transitions(harness: SqliteD1Harness, flightId: string): Array<Record<string, unknown>> {
  return harness.sqlite
    .prepare('SELECT * FROM flight_status_transitions WHERE flight_id = ? ORDER BY rowid')
    .all(flightId) as Array<Record<string, unknown>>
}

function count(harness: SqliteD1Harness, sql: string, ...params: unknown[]): number {
  const row = harness.sqlite.prepare(sql).get(...(params as never[])) as { n: number }
  return Number(row.n)
}

async function dispatch(env: Env, taskIds: string[], extra: Record<string, unknown> = {}, who = execAuth()) {
  const { meta_extra: metaExtra, ...rest } = extra as { meta_extra?: Record<string, unknown> }
  return invokeTool(who, env, 'flight_dispatch', {
    squad_id: SQUAD_ID,
    goal: 'Ship the 1540 fix',
    budget_micro_usd: 0,
    meta_json: JSON.stringify(meta(taskIds, metaExtra ?? {})),
    signals_json: JSON.stringify(signals),
    ...rest,
  }, ORIGIN)
}

async function dispatchedId(env: Env, taskIds: string[], extra: Record<string, unknown> = {}, who = execAuth()): Promise<string> {
  const res = await dispatch(env, taskIds, extra, who)
  expect(res.ok, JSON.stringify(res)).toBe(true)
  const result = (res as { ok: true; result: { flight: FlightRow } }).result
  expect(result.flight.status).toBe('running')
  return result.flight.id
}

async function toReview(env: Env, taskId: string): Promise<void> {
  const res = await invokeTool(execAuth(), env, 'task_update', { task_id: taskId, status: 'review' }, ORIGIN)
  expect(res.ok, JSON.stringify(res)).toBe(true)
}

async function verdict(env: Env, taskId: string, v: 'approved' | 'rejected'): Promise<void> {
  const res = await invokeTool(gateAuth(), env, 'task_verdict', { task_id: taskId, verdict: v, note: 'gate' }, ORIGIN)
  expect(res.ok, JSON.stringify(res)).toBe(true)
}

async function close(env: Env, taskId: string): Promise<void> {
  const res = await invokeTool(gateAuth(), env, 'task_update', { task_id: taskId, status: 'done' }, ORIGIN)
  expect(res.ok, JSON.stringify(res)).toBe(true)
}

async function land(env: Env, flightId: string) {
  return invokeTool(execAuth(), env, 'flight_land', { flight_id: flightId, cost_micro_usd: 0, score: 0.9 }, ORIGIN)
}

/** Land a flight through the real gated path: review → approve → done (→ system land). */
async function flyToLanded(env: Env, taskIds: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const id = await dispatchedId(env, taskIds, extra)
  for (const t of taskIds) await toReview(env, t)
  for (const t of taskIds) await verdict(env, t, 'approved')
  for (const t of taskIds) await close(env, t)
  expect(flightRow(harness, id).status).toBe('landed')
  return id
}

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness, ['task-1', 'task-2', 'task-3', 'task-4'])
  env = envFor(harness)
})

afterEach(() => {
  harness.close()
})

describe('A. running → waiting at the gate (mupot#1540)', () => {
  it('parks a flight at waiting only when EVERY task is at the gate, and receipts the transition', async () => {
    const id = await dispatchedId(env, ['task-1', 'task-2'])

    await toReview(env, 'task-1')
    expect(flightRow(harness, id).status).toBe('running') // task-2 still being worked
    expect(transitions(harness, id)).toHaveLength(0)

    await toReview(env, 'task-2')
    const parked = flightRow(harness, id)
    expect(parked.status).toBe('waiting')
    expect(parked.waiting_since).toEqual(expect.any(Number))
    expect(transitions(harness, id)).toEqual([
      expect.objectContaining({
        tenant: TENANT, from_status: 'running', to_status: 'waiting', cause: 'task_status',
        cause_task_id: 'task-2', cause_task_from_status: 'in_progress', cause_task_to_status: 'review',
      }),
    ])
  })

  it('the watchdog does not reap a waiting flight at 60m but DOES reap a running sibling (control)', async () => {
    const parkedId = await dispatchedId(env, ['task-1'])
    const workingId = await dispatchedId(env, ['task-2'])
    await toReview(env, 'task-1')
    expect(flightRow(harness, parkedId).status).toBe('waiting')

    const startedAt = flightRow(harness, parkedId).started_at as number
    const sweep = await sweepStalledFlights(env, { nowMs: startedAt + 62 * MIN })

    expect(sweep.reaped).toBe(1)
    expect(flightRow(harness, workingId).status).toBe('failed')
    expect(flightRow(harness, parkedId).status).toBe('waiting')
    expect(sweep.escalated).toBe(0)

    // And the governed manual reap refuses it too.
    const manual = await invokeTool(execAuth(), env, 'flight_reap_stalled', { flight_id: parkedId, reason: 'stuck?' }, ORIGIN)
    expect(manual).toMatchObject({ ok: false, status: 409, error: 'cannot_reap_waiting_gate_must_escalate' })
  })

  it('escalates at 24h measured from waiting_since (not launch), and never reaps', async () => {
    const id = await dispatchedId(env, ['task-1'])
    // The flight ran 23h before parking. Launch-based accounting would escalate 2h later.
    harness.sqlite.prepare('UPDATE flights SET started_at = started_at - ? WHERE id = ?').run(23 * HOUR, id)
    await toReview(env, 'task-1')
    const waitingSince = flightRow(harness, id).waiting_since as number

    const early = await sweepStalledFlights(env, { nowMs: waitingSince + 2 * HOUR })
    expect(early).toMatchObject({ reaped: 0, escalated: 0 })

    const late = await sweepStalledFlights(env, { nowMs: waitingSince + 24 * HOUR + MIN })
    expect(late).toMatchObject({ reaped: 0, escalated: 1, escalated_flight_ids: [id] })
    expect(flightRow(harness, id).status).toBe('waiting')
  })

  it('flight_land accepts a waiting flight (it refuses on the tasks, not on the status)', async () => {
    const id = await dispatchedId(env, ['task-1'])
    await toReview(env, 'task-1')
    await verdict(env, 'task-1', 'approved')
    expect(flightRow(harness, id).status).toBe('waiting')
    const early = await land(env, id)
    expect(early).toMatchObject({ ok: false, status: 409, error: 'flight_tasks_incomplete' })
  })

  it('P0: approve + done SYSTEM-LANDS the waiting flight: score NULL, receipted, cost as recorded', async () => {
    const id = await dispatchedId(env, ['task-1', 'task-2'])
    await toReview(env, 'task-1')
    await toReview(env, 'task-2')
    await verdict(env, 'task-1', 'approved')
    await close(env, 'task-1')
    expect(flightRow(harness, id).status).toBe('waiting') // task-2 still at the gate
    await verdict(env, 'task-2', 'approved')
    await close(env, 'task-2')

    const landed = flightRow(harness, id)
    expect(landed).toMatchObject({ status: 'landed', score: null, gate_reason: 'auto_landed_all_tasks_done', cost_micro_usd: 0 })
    expect(landed.ended_at).toEqual(expect.any(Number))
    expect(transitions(harness, id).at(-1)).toMatchObject({
      from_status: 'waiting', to_status: 'landed', cause: 'auto_landed_all_tasks_done',
      cause_task_id: 'task-2', cause_task_from_status: 'approved', cause_task_to_status: 'done',
    })
    // No forged flight.landed actor: a system land writes no outbox row.
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flight_event_outbox WHERE flight_id = ?', id)).toBe(0)
    // The executor's own land now finds nothing in the air.
    expect(await land(env, id)).toMatchObject({ ok: false, status: 409, error: 'flight_not_in_air' })
  })

  it('P0: no system land unless the gate APPROVED — a done task whose latest verdict is not approved blocks it', async () => {
    const id = await dispatchedId(env, ['task-1', 'task-2'])
    await toReview(env, 'task-1')
    await toReview(env, 'task-2')
    await verdict(env, 'task-2', 'approved')
    // Forge the shape the predicate must refuse: task-1 'done' with no approved verdict.
    harness.sqlite.prepare(`UPDATE tasks SET status = 'done' WHERE id = 'task-1'`).run()
    expect(flightRow(harness, id).status).toBe('waiting')
    await close(env, 'task-2') // last task done — but task-1 was never approved
    expect(flightRow(harness, id).status).toBe('waiting')
    expect(transitions(harness, id).some((row) => row.to_status === 'landed')).toBe(false)
  })

  it('P0 (4): a routine skip-overlap pin on a gated flight releases once its work is approved and closed', async () => {
    const id = await dispatchedId(env, ['task-1'])
    const due = new Date().toISOString()
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('project-r', 'project-r', 'R', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-r', '${SQUAD_ID}', 'write');
    `)
    harness.sqlite.prepare(`
      INSERT INTO routines (
        id, tenant, project_id, name, objective, status, trigger_kind, run_once_at,
        cron_expression, timezone, next_run_at, overlap_policy, execution_mode,
        responsible_squad_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
        max_occurrences, revision, enabled_by, enabled_at, created_by, created_at, updated_at
      ) VALUES ('routine-r', ?, 'project-r', 'routine-r', 'Advance', 'enabled', 'cron', NULL,
        '* * * * *', 'UTC', ?, 'skip', 'propose', ?, 100000, 3, 300,
        NULL, 1, 'owner-1', ?, 'owner-1', ?, ?)
    `).run(TENANT, due, SQUAD_ID, due, due, due)
    harness.sqlite.prepare(`
      INSERT INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, waiting_reason, lease_owner, lease_expires_at,
        attempt, retry_at, flight_id, created_at, updated_at
      ) VALUES ('run-r', ?, 'project-r', 'routine-r', 1, ?, 'manual:run-r', 'cron', ?, 'running',
        NULL, NULL, NULL, 1, NULL, ?, ?, ?)
    `).run(TENANT, JSON.stringify({
      execution_mode: 'propose', overlap_policy: 'skip', responsible_squad_id: SQUAD_ID,
      preferred_agent_id: null, budget_micro_usd: 100000, max_attempts: 3, retry_backoff_seconds: 300,
    }), due, id, due, due)

    await toReview(env, 'task-1')
    await verdict(env, 'task-1', 'approved')
    await close(env, 'task-1')
    expect(flightRow(harness, id).status).toBe('landed')

    const summary = await runRoutineScheduler(env, new Date(), 'worker-1540')
    expect(summary.occurrences_created).toBe(1)
    const next = harness.sqlite
      .prepare(`SELECT status, result_summary FROM routine_runs WHERE routine_id = 'routine-r' AND id <> 'run-r'`)
      .get() as { status: string; result_summary: string | null }
    expect(next.status).toBe('queued')
  })

  it('a reject sends it back to running and RESTARTS the stall clock; resubmission parks it again', async () => {
    const id = await dispatchedId(env, ['task-1'])
    await toReview(env, 'task-1')
    expect(flightRow(harness, id).status).toBe('waiting')
    // Simulate a 5h gate wait: launch was long ago.
    harness.sqlite.prepare('UPDATE flights SET started_at = started_at - ? WHERE id = ?').run(5 * HOUR, id)
    harness.sqlite.prepare('UPDATE flights SET escalated_at = 1 WHERE id = ?').run(id)

    await verdict(env, 'task-1', 'rejected')
    const resumed = flightRow(harness, id)
    expect(resumed.status).toBe('running')
    expect(resumed.waiting_since).toBeNull()
    expect(resumed.escalated_at).toBeNull() // a later wait escalates afresh
    expect(resumed.resumed_at).toEqual(expect.any(Number))
    expect(transitions(harness, id).map((row) => [row.from_status, row.to_status, row.cause_task_to_status])).toEqual([
      ['running', 'waiting', 'review'],
      ['waiting', 'running', 'rejected'],
    ])

    // 30 minutes after resumption: healthy (from launch it would be 5.5h → reap).
    const sweep = await sweepStalledFlights(env, { nowMs: (resumed.resumed_at as number) + 30 * MIN })
    expect(sweep.reaped).toBe(0)
    expect(flightRow(harness, id).status).toBe('running')

    // Rework and resubmit → waiting again.
    const reopen = await invokeTool(execAuth(), env, 'task_update', { task_id: 'task-1', status: 'in_progress' }, ORIGIN)
    expect(reopen.ok, JSON.stringify(reopen)).toBe(true)
    expect(flightRow(harness, id).status).toBe('running')
    await toReview(env, 'task-1')
    expect(flightRow(harness, id).status).toBe('waiting')
  })

  it('a flight whose tasks all went straight to done (no gate hop) is NOT parked', async () => {
    harness.sqlite.prepare(`UPDATE tasks SET gate_owner = NULL WHERE id = 'task-3'`).run()
    const id = await dispatchedId(env, ['task-3'])
    await close(env, 'task-3')
    expect(flightRow(harness, id).status).toBe('running')
    expect(transitions(harness, id)).toHaveLength(0)
  })

  it('P2-1: a task leaving the parked set does NOT touch a flight that is already running', async () => {
    const id = await dispatchedId(env, ['task-1', 'task-2'])
    await toReview(env, 'task-1') // flight still running (task-2 in progress)
    const blocked = await invokeTool(execAuth(), env, 'task_update', { task_id: 'task-2', status: 'blocked' }, ORIGIN)
    expect(blocked.ok, JSON.stringify(blocked)).toBe(true)
    const row = flightRow(harness, id)
    expect(row.status).toBe('running')
    expect(row.resumed_at).toBeNull()
    expect(transitions(harness, id)).toHaveLength(0)
  })

  it('P3: the leave trigger ignores a waiting flight whose task_ids is not an array (parity guard)', async () => {
    harness.sqlite.exec(`
      INSERT INTO flights (id, tenant, agent, goal, status, meta)
      VALUES ('f-scalar', '${TENANT}', '${EXEC_AGENT}', 'g', 'waiting', '{"schema":"mupot.flight.meta/v1","task_ids":"task-1"}');
    `)
    await toReview(env, 'task-1')
    await verdict(env, 'task-1', 'rejected')
    expect(flightRow(harness, 'f-scalar').status).toBe('waiting')
    expect(transitions(harness, 'f-scalar')).toHaveLength(0)
  })

  it('never aborts a task write because some other flight has malformed meta', async () => {
    harness.sqlite.exec(`
      INSERT INTO flights (id, tenant, agent, goal, status, meta)
      VALUES ('f-broken', '${TENANT}', '${EXEC_AGENT}', 'g', 'running', '{not json');
      INSERT INTO flights (id, tenant, agent, goal, status, meta)
      VALUES ('f-waiting-broken', '${TENANT}', '${EXEC_AGENT}', 'g', 'waiting', '{"schema":"mupot.flight.meta/v1","task_ids":"task-1"');
    `)
    await toReview(env, 'task-1')
    await verdict(env, 'task-1', 'rejected')
    expect(flightRow(harness, 'f-broken').status).toBe('running')
    expect(flightRow(harness, 'f-waiting-broken').status).toBe('waiting')
  })
})

describe('A. round 2 — the watchdog window and escalation (gate P0)', () => {
  function seedWaiting(n: number, waitingSince: number): void {
    const stmt = harness.sqlite.prepare(`
      INSERT INTO flights (id, tenant, agent, dispatched_by_agent_id, goal, status, created_at, started_at, waiting_since, meta)
      VALUES (?, '${TENANT}', '${EXEC_AGENT}', '${EXEC_AGENT}', 'parked', 'waiting', ?, ?, ?, ?)`)
    for (let i = 0; i < n; i += 1) {
      stmt.run(`w-${String(i).padStart(3, '0')}`, 1000 + i, 1000 + i, waitingSince, JSON.stringify(meta(['task-4'])))
    }
  }

  it('100 parked flights no longer fill the window: a stale running flight behind them is reaped', async () => {
    const now = Date.now()
    seedWaiting(100, now) // oldest rows in the table, not yet due for escalation
    const stale = await dispatchedId(env, ['task-1'])
    const sweep = await sweepStalledFlights(env, { nowMs: now + 3 * HOUR })
    expect(sweep.reaped).toBe(1)
    expect(flightRow(harness, stale).status).toBe('failed')
    expect(sweep.escalated).toBe(0)
    expect(sweep.scanned).toBe(1) // the not-yet-due waits are not even read
  })

  it('escalates each wait ONCE: the next sweep neither re-escalates nor re-reads it', async () => {
    const now = Date.now()
    seedWaiting(100, now - 25 * HOUR)
    const first = await sweepStalledFlights(env, { nowMs: now })
    expect(first).toMatchObject({ escalated: 100, reaped: 0 })
    expect(count(harness, `SELECT COUNT(*) AS n FROM flights WHERE status = 'waiting' AND escalated_at = ?`, now)).toBe(100)

    const stale = await dispatchedId(env, ['task-1'])
    const second = await sweepStalledFlights(env, { nowMs: now + 3 * HOUR })
    expect(second).toMatchObject({ escalated: 0, reaped: 1, escalated_flight_ids: [], scanned: 1 })
    expect(flightRow(harness, stale).status).toBe('failed')
    expect(count(harness, `SELECT COUNT(*) AS n FROM flights WHERE status = 'waiting'`)).toBe(100)
  })
})

describe('A. round 2 — concurrency and index (gate P0 (3), P1-1)', () => {
  it('two overlapping sweeps escalate each due wait exactly once between them', async () => {
    const now = Date.now()
    const stmt = harness.sqlite.prepare(`
      INSERT INTO flights (id, tenant, agent, dispatched_by_agent_id, goal, status, created_at, started_at, waiting_since, meta)
      VALUES (?, '${TENANT}', '${EXEC_AGENT}', '${EXEC_AGENT}', 'parked', 'waiting', 1, 1, ?, '{}')`)
    for (let i = 0; i < 20; i += 1) stmt.run(`c-${i}`, now - 25 * HOUR)
    const [a, b] = await Promise.all([
      sweepStalledFlights(env, { nowMs: now }),
      sweepStalledFlights(env, { nowMs: now }),
    ])
    expect(a.escalated + b.escalated).toBe(20)
  })

  it('the trigger lookup of in-air flights uses idx_flights_status, not a scan of every flight', () => {
    const plan = harness.sqlite
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM flights f WHERE f.status = 'running'`)
      .all() as Array<{ detail: string }>
    expect(plan.map((row) => row.detail).join(' | ')).toMatch(/USING (COVERING )?INDEX idx_flights_status/)
  })
})

describe('B. meta.timeout_ms is a live, bounded knob (mupot#1540)', () => {
  it('is accepted and honoured by the watchdog', async () => {
    const id = await dispatchedId(env, ['task-1'], { meta_extra: { timeout_ms: 10 * MIN } })
    const row = flightRow(harness, id)
    expect(JSON.parse(row.meta)).toMatchObject({ timeout_ms: 10 * MIN })
    const startedAt = row.started_at as number

    expect(await sweepStalledFlights(env, { nowMs: startedAt + 9 * MIN })).toMatchObject({ reaped: 0 })
    expect(flightRow(harness, id).status).toBe('running')
    expect(await sweepStalledFlights(env, { nowMs: startedAt + 11 * MIN })).toMatchObject({ reaped: 1 })
    expect(flightRow(harness, id).status).toBe('failed')
  })

  it('a longer timeout_ms keeps a flight alive past the 60m default', async () => {
    const id = await dispatchedId(env, ['task-1'], { meta_extra: { timeout_ms: 3 * HOUR } })
    const startedAt = flightRow(harness, id).started_at as number
    expect(await sweepStalledFlights(env, { nowMs: startedAt + 2 * HOUR })).toMatchObject({ reaped: 0 })
    expect(flightRow(harness, id).status).toBe('running')
  })

  it.each([
    ['below the 5m floor', 4 * MIN],
    ['above the 24h ceiling', 24 * HOUR + 1],
    ['non-integer', 10 * MIN + 0.5],
    ['a string', '600000'],
    ['zero', 0],
  ])('is refused when %s', async (_label, value) => {
    const res = await dispatch(env, ['task-1'], { meta_extra: { timeout_ms: value } })
    expect(res).toMatchObject({ ok: false, status: 400, error: 'invalid_flight_meta' })
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flights')).toBe(0)
  })

  it('accepts both bounds exactly', async () => {
    await dispatchedId(env, ['task-1'], { meta_extra: { timeout_ms: 5 * MIN } })
    await dispatchedId(env, ['task-2'], { meta_extra: { timeout_ms: 24 * HOUR } })
  })

  it('a flight carrying timeout_ms stays visible to the canonical-meta SQL projections', async () => {
    const id = await dispatchedId(env, ['task-1'], { meta_extra: { timeout_ms: 10 * MIN } })
    const visible = harness.sqlite
      .prepare(`SELECT f.id FROM flights f WHERE f.id = ? ${canonicalFlightMetaSql('f')}`)
      .all(id)
    expect(visible).toHaveLength(1)
    // …and an out-of-range value written around the tool is NOT canonical.
    harness.sqlite
      .prepare(`UPDATE flights SET meta = json_set(meta, '$.timeout_ms', 1) WHERE id = ?`)
      .run(id)
    expect(
      harness.sqlite.prepare(`SELECT f.id FROM flights f WHERE f.id = ? ${canonicalFlightMetaSql('f')}`).all(id),
    ).toHaveLength(0)
  })
})

describe('C. duplicate booking (mupot#1540)', () => {
  it('refuses re-dispatching a task that already LANDED, naming the landed flight', async () => {
    const landedId = await flyToLanded(env, ['task-1'])
    const before = count(harness, 'SELECT COUNT(*) AS n FROM flights')

    const again = await dispatch(env, ['task-1', 'task-2'])
    expect(again).toMatchObject({
      ok: false,
      status: 409,
      error: 'flight_task_already_landed',
      detail: { landed_flight_ids: [landedId], task_ids: ['task-1'] },
    })
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flights')).toBe(before)
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flight_redispatch_receipts')).toBe(0)
  })

  it('does not refuse a task whose earlier flight is merely held/failed (not landed)', async () => {
    const id = await dispatchedId(env, ['task-1'])
    harness.sqlite.prepare(`UPDATE flights SET status = 'failed' WHERE id = ?`).run(id)
    await dispatchedId(env, ['task-1'])
  })

  it('P1-2: the #1540 VICTIM shape — reaped flight, task later approved+done — is refused', async () => {
    const reaped = await dispatchedId(env, ['task-1'])
    const startedAt = flightRow(harness, reaped).started_at as number
    // The real watchdog reaps it while the executor is still working (pre-fix prod shape).
    expect(await sweepStalledFlights(env, { nowMs: startedAt + 62 * MIN })).toMatchObject({ reaped: 1 })
    expect(flightRow(harness, reaped).status).toBe('failed')
    await toReview(env, 'task-1')
    await verdict(env, 'task-1', 'approved')

    const whileApproved = await dispatch(env, ['task-1'])
    expect(whileApproved).toMatchObject({ ok: false, status: 409, error: 'flight_task_already_done', detail: { task_ids: ['task-1'] } })

    await close(env, 'task-1')
    const whileDone = await dispatch(env, ['task-1', 'task-2'])
    expect(whileDone).toMatchObject({
      ok: false, status: 409, error: 'flight_task_already_done', detail: { landed_flight_ids: [], task_ids: ['task-1'] },
    })
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flights')).toBe(1)

    const override = await dispatch(env, ['task-1'], { redispatch_landed_reason: 'redo reaped work' }, leadAuth())
    expect(override.ok, JSON.stringify(override)).toBe(true)
    const receipt = harness.sqlite.prepare('SELECT * FROM flight_redispatch_receipts').get() as Record<string, unknown>
    expect(JSON.parse(receipt.task_ids as string)).toEqual(['task-1'])
    expect(JSON.parse(receipt.landed_flight_ids as string)).toEqual([])
  })

  it('P2-2: a landed flight in ANOTHER tenant does not refuse this tenant\'s dispatch', async () => {
    harness.sqlite.exec(`
      INSERT INTO flights (id, tenant, agent, goal, status, meta)
      VALUES ('f-other-tenant', 'some-other-tenant', '${EXEC_AGENT}', 'g', 'landed',
              '${JSON.stringify(meta(['task-2']))}');
    `)
    await dispatchedId(env, ['task-2'])
  })

  it('P3: the override receipt commits with its flight or not at all (same batch)', async () => {
    harness.sqlite.exec(`
      INSERT INTO flights (id, tenant, agent, dispatched_by_agent_id, goal, meta, client_request_id)
      VALUES ('f-holds-key', '${TENANT}', '${EXEC_AGENT}', '${EXEC_AGENT}', 'g', '{}', 'k-batch');
    `)
    await expect(createFlight(env, {
      agent: EXEC_AGENT, goal: 'g', meta: meta(['task-1']) as never, client_request_id: 'k-batch',
    }, {
      redispatchReceipt: { actor: { kind: 'agent', id: EXEC_AGENT }, reason: 'r', landedFlightIds: [], taskIds: ['task-1'] },
    })).rejects.toBeInstanceOf(FlightIdempotencyConflictError)
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flight_redispatch_receipts')).toBe(0)

    // …and when the flight commits, the receipt is bound to it.
    await flyToLanded(env, ['task-1'])
    const res = await dispatch(env, ['task-1'], { redispatch_landed_reason: 'again' }, leadAuth())
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(count(harness, `SELECT COUNT(*) AS n FROM flight_redispatch_receipts r JOIN flights f ON f.id = r.flight_id`)).toBe(1)
  })

  it('the override needs lead, and is refused for a member without writing a receipt', async () => {
    await flyToLanded(env, ['task-1'])
    const denied = await dispatch(env, ['task-1'], { redispatch_landed_reason: 'redo it' })
    expect(denied).toMatchObject({ ok: false, status: 403, error: 'flight_redispatch_forbidden' })
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flight_redispatch_receipts')).toBe(0)
  })

  it('a lead override is allowed and RECEIPTED against the new flight', async () => {
    const landedId = await flyToLanded(env, ['task-1'])
    const res = await dispatch(env, ['task-1'], { redispatch_landed_reason: 'gate asked for a re-run' }, leadAuth())
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const newId = (res as { ok: true; result: { flight: FlightRow } }).result.flight.id
    expect(newId).not.toBe(landedId)

    const receipts = harness.sqlite.prepare('SELECT * FROM flight_redispatch_receipts').all() as Array<Record<string, unknown>>
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      tenant: TENANT,
      flight_id: newId,
      actor_kind: 'agent',
      actor_id: EXEC_AGENT,
      reason: 'gate asked for a re-run',
    })
    expect(JSON.parse(receipts[0]?.landed_flight_ids as string)).toEqual([landedId])
    expect(JSON.parse(receipts[0]?.task_ids as string)).toEqual(['task-1'])
    // Append-only.
    expect(() => harness.sqlite.exec('DELETE FROM flight_redispatch_receipts')).toThrow(/append-only/)
  })

  it('the same client_request_id twice returns the ORIGINAL flight: one row, one envelope', async () => {
    const first = await dispatch(env, ['task-1'], { client_request_id: 'booker-turn-42' })
    expect(first.ok, JSON.stringify(first)).toBe(true)
    const firstId = (first as { ok: true; result: { flight: FlightRow } }).result.flight.id

    const retry = await dispatch(env, ['task-1'], { client_request_id: 'booker-turn-42' })
    expect(retry).toMatchObject({ ok: true, result: { idempotent_replay: true, flight: { id: firstId } } })
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flights')).toBe(1)
    expect(count(harness, `SELECT COUNT(*) AS n FROM agent_messages WHERE request_id = ?`, `flight.${firstId}`)).toBe(1)
  })

  it('a retry with the key AFTER the original landed still returns the original (the prod redelivery shape)', async () => {
    const id = await flyToLanded(env, ['task-1'], { client_request_id: 'booker-turn-7' })
    const retry = await dispatch(env, ['task-1'], { client_request_id: 'booker-turn-7' })
    expect(retry).toMatchObject({ ok: true, result: { idempotent_replay: true, flight: { id, status: 'landed' } } })
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flights')).toBe(1)
  })

  it('the same key with a DIFFERENT request is a conflict, not a silent replay', async () => {
    const first = await dispatch(env, ['task-1'], { client_request_id: 'k1' })
    const firstId = (first as { ok: true; result: { flight: FlightRow } }).result.flight.id
    const different = await dispatch(env, ['task-2'], { client_request_id: 'k1' })
    expect(different).toMatchObject({ ok: false, status: 409, error: 'client_request_id_conflict', detail: { flight_id: firstId } })
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flights')).toBe(1)
  })

  it('keys are scoped to the dispatching agent: another agent reusing a key gets its own flight', async () => {
    const mine = await dispatch(env, ['task-1'], { client_request_id: 'shared-key' })
    const theirs = await dispatch(env, ['task-2'], { client_request_id: 'shared-key' }, otherAgentAuth())
    expect(theirs.ok, JSON.stringify(theirs)).toBe(true)
    const mineId = (mine as { ok: true; result: { flight: FlightRow } }).result.flight.id
    const theirsId = (theirs as { ok: true; result: { flight: FlightRow } }).result.flight.id
    expect(theirsId).not.toBe(mineId)
  })

  it('two CONCURRENT dispatches with one key produce one row (the unique index closes the race)', async () => {
    const [a, b] = await Promise.all([
      dispatch(env, ['task-1'], { client_request_id: 'race' }),
      dispatch(env, ['task-1'], { client_request_id: 'race' }),
    ])
    expect(a.ok && b.ok, JSON.stringify([a, b])).toBe(true)
    const ids = [a, b].map((r) => (r as { ok: true; result: { flight: FlightRow } }).result.flight.id)
    expect(ids[0]).toBe(ids[1])
    expect(count(harness, 'SELECT COUNT(*) AS n FROM flights')).toBe(1)
  })

  it('the unique index refuses a second row for one (tenant, dispatcher, key) at the database', () => {
    const insert = `INSERT INTO flights (id, tenant, agent, dispatched_by_agent_id, goal, meta, client_request_id)
                    VALUES (?, '${TENANT}', '${EXEC_AGENT}', '${EXEC_AGENT}', 'g', '{}', 'dup')`
    harness.sqlite.prepare(insert).run('f-a')
    expect(() => harness.sqlite.prepare(insert).run('f-b')).toThrow(/UNIQUE/)
  })

  it.each([
    ['blank', '   '],
    ['too long', 'x'.repeat(201)],
    ['a control character', 'a\nb'],
  ])('refuses a client_request_id that is %s', async (_label, value) => {
    const res = await dispatch(env, ['task-1'], { client_request_id: value })
    expect(res).toMatchObject({ ok: false, status: 400, error: 'invalid_client_request_id' })
  })
})
