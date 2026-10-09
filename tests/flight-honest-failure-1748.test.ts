// tests/flight-honest-failure-1748.test.ts — mupot#1748 / #1762: a flight's terminal status must reflect what
// happened to its work, and every failure counter must count only REAL failures.
//
// REAL SQL: whole migration chain via applyAllMigrations (the only sanctioned schema source, mupot#684 ratchet).
// Three behaviours:
//   1. a running flight whose tasks are ALL done (a task that skipped review/approved never parks the flight, so
//      the 0172 trigger leaves it 'running') is LANDED by the watchdog, not failed;
//   2. a bookkeeping flight (deploy/studio) is closed as bookkeeping_closed (status stays failed, relabelled by readers);
//   3. isRealFailure / realFailureSql (failed AND not cancelled AND not bookkeeping) is the one predicate every
//      flight failure counter uses: agent-profile, flights-deck (board phase), outcome feed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { reapStalledFlight, sweepStalledFlights, resolveReapDisposition } from '../src/flight/watchdog'
import { buildBoard } from '../src/flight/board'
import { getFlight, listFlightOutcomes, listFlights } from '../src/flight/service'
import { flightOutcome, isRealFailure, realFailureSql } from '../src/flight/cancelled'
import { deriveFlightDeckKpis, flightFilterGroup } from '../src/dashboard/flights-deck'
import { loadFlightPanel } from '../src/dashboard/agent-profile'
import { findFinishedWorkConflict } from '../src/flight/rebooking'
import type { Env } from '../src/types'

const TENANT = 'digid'
const T0 = 1_000_000
const MINUTE = 60_000
const STALLED_NOW = T0 + 70 * MINUTE
const SQUAD = 'squad-a'
const AGENT = 'agent-1111'
const WATCHDOG = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }

let h: SqliteD1Harness
let env: Env

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT}', '${SQUAD}', 'exec', 'Exec', 'active');
  `)
})
afterEach(() => h.close())

function seedTask(id: string, status = 'in_progress'): void {
  h.sqlite
    .prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
       VALUES (?, ?, 'T', 'body', 'done', ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, SQUAD, status, AGENT)
}

function seedFlight(
  id: string,
  o: { status?: string; taskIds?: string[]; bookkeeping?: number; startedAt?: number; budget?: number | null; cost?: number; schema?: string } = {},
): void {
  const meta = JSON.stringify({ schema: o.schema ?? 'mupot.flight.meta/v1', squad_ids: [SQUAD], ...(o.taskIds ? { task_ids: o.taskIds } : {}) })
  h.sqlite
    .prepare(
      `INSERT INTO flights (id, tenant, agent, dispatched_by_agent_id, goal, status, trigger_source, gate_verdict, gate_reason,
         score, budget_micro_usd, cost_micro_usd, created_at, started_at, meta, bookkeeping)
       VALUES (?, ?, ?, 'agent-2222', 'g', ?, 'api', 'go', '', 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, TENANT, AGENT, o.status ?? 'running', o.budget === undefined ? 0 : o.budget, o.cost ?? 0, T0, o.startedAt ?? T0, meta, o.bookkeeping ?? 0)
}

function row(id: string): Record<string, unknown> {
  return h.sqlite.prepare('SELECT * FROM flights WHERE id = ?').get(id) as Record<string, unknown>
}

describe('1. a flight whose tasks are all done lands, it is not failed by the stall clock', () => {
  it('DEFECT PROOF: a task going straight to done does not park or land the running flight (0172 trigger needs review/approved)', () => {
    seedTask('t1')
    seedFlight('fl-done', { taskIds: ['t1'] })
    h.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run()
    expect(row('fl-done').status).toBe('running') // nothing landed it: this is how 60/72 prod flights ended up failed
  })

  it('watchdog LANDS a stalled running flight whose every task is done, with an honest gate_reason and a receipt', async () => {
    seedTask('t1')
    seedTask('t2')
    seedFlight('fl-done', { taskIds: ['t1', 't2'] })
    h.sqlite.prepare("UPDATE tasks SET status = 'done'").run()

    const res = await reapStalledFlight(env, 'fl-done', WATCHDOG, 'running_exceeded_timeout', STALLED_NOW)
    expect(res).toMatchObject({ transitioned: true, target_status: 'landed', disposition: 'tasks_done' })
    const r = row('fl-done')
    expect(r.status).toBe('landed')
    expect(String(r.gate_reason)).toContain('watchdog_tasks_done')
    expect(r.ended_at).toBe(STALLED_NOW)
    expect(r.score).toBeNull() // seeded score is 1: a watchdog land must never read as throughput
    const receipt = h.sqlite.prepare('SELECT payload FROM flight_reap_receipts WHERE flight_id = ?').get('fl-done') as { payload: string }
    expect(JSON.parse(receipt.payload)).toMatchObject({ target_status: 'landed', disposition: 'tasks_done' })
  })

  it('the sweep counts it as closed_without_failure, never as reaped', async () => {
    seedTask('t1')
    seedFlight('fl-done', { taskIds: ['t1'] })
    seedTask('t2', 'in_progress')
    seedFlight('fl-undone', { taskIds: ['t2'] })
    h.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run()

    const sweep = await sweepStalledFlights(env, { nowMs: STALLED_NOW })
    expect(sweep.closed_without_failure).toBe(1)
    expect(sweep.closed_without_failure_flight_ids).toEqual(['fl-done'])
    expect(sweep.reaped).toBe(1)
    expect(row('fl-done').status).toBe('landed')
    expect(row('fl-undone').status).toBe('failed')
  })

  it('still FAILS a stalled flight when any task is not done, a task id is missing, or there are no task ids', async () => {
    seedTask('a')
    seedTask('b')
    seedFlight('fl-partial', { taskIds: ['a', 'b'] })
    h.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = 'a'").run()
    seedFlight('fl-missing', { taskIds: ['a', 'ghost'] })
    seedFlight('fl-notasks')
    for (const id of ['fl-partial', 'fl-missing', 'fl-notasks']) {
      expect(await resolveReapDisposition(env, (await getFlight(env, id))!)).toBe('failed')
      const res = await reapStalledFlight(env, id, WATCHDOG, 'running_exceeded_timeout', STALLED_NOW)
      expect(res).toMatchObject({ transitioned: true, target_status: 'failed' })
      expect(row(id).status).toBe('failed')
    }
  })

  it('a routine-bound flight with all tasks done is NOT landed here (its run owns closure): it still fails', async () => {
    const T = '2026-10-09T00:00:00.000Z'
    h.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('project-r','project-r','R','active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-r','${SQUAD}','write');
      INSERT INTO routines (id, tenant, project_id, name, objective, status, trigger_kind, run_once_at,
        cron_expression, timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
        budget_micro_usd, max_attempts, retry_backoff_seconds, max_occurrences, revision, enabled_by,
        enabled_at, created_by, created_at, updated_at)
      VALUES ('routine-r','${TENANT}','project-r','routine-r','o','enabled','cron',NULL,'* * * * *','UTC','${T}',
        'skip','propose','${SQUAD}',100000,3,300,NULL,1,'o','${T}','o','${T}','${T}');
    `)
    seedTask('t1')
    seedFlight('fl-routine', { taskIds: ['t1'] })
    h.sqlite.exec(`
      INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, attempt, flight_id, created_at, updated_at)
      VALUES ('run-r','${TENANT}','project-r','routine-r',1,'{}','manual:run-r','cron','${T}','running',1,'fl-routine','${T}','${T}');
    `)
    h.sqlite.prepare("UPDATE tasks SET status = 'done'").run()
    const res = await reapStalledFlight(env, 'fl-routine', WATCHDOG, 'x', STALLED_NOW)
    expect(res).toMatchObject({ transitioned: true, target_status: 'failed' })
    expect(row('fl-routine').status).toBe('failed')
  })

  it('never lands a flight that is not past its stall timeout (the rule runs only inside the reap)', async () => {
    seedTask('t1')
    seedFlight('fl-young', { taskIds: ['t1'] })
    h.sqlite.prepare("UPDATE tasks SET status = 'done'").run()
    const res = await reapStalledFlight(env, 'fl-young', WATCHDOG, 'x', T0 + 5 * MINUTE)
    expect(res.error).toBe('flight_not_stalled')
    expect(row('fl-young').status).toBe('running')
  })

  it('the guarded UPDATE re-asserts the predicate: a task reopened between the read and the write cannot be landed', async () => {
    seedTask('t1')
    seedFlight('fl-race', { taskIds: ['t1'] })
    h.sqlite.prepare("UPDATE tasks SET status = 'done'").run()
    // Simulate the race: the disposition read said tasks_done, then the task moves before the UPDATE runs.
    const realPrepare = env.DB.prepare.bind(env.DB)
    let flipped = false
    env.DB.prepare = ((sql: string) => {
      if (!flipped && sql.includes('UPDATE flights') && sql.includes('?5')) {
        flipped = true
        h.sqlite.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 't1'").run()
      }
      return realPrepare(sql)
    }) as typeof env.DB.prepare
    const res = await reapStalledFlight(env, 'fl-race', WATCHDOG, 'x', STALLED_NOW)
    expect(res.transitioned).toBe(false)
    expect(row('fl-race').status).toBe('running')
  })
})

describe('1b. the watchdog done-land is the governed-land predicate, not a weaker copy (P1)', () => {
  function gatedTask(id: string): void {
    seedTask(id)
    h.sqlite.prepare("UPDATE tasks SET gate_owner = 'gate:hadi' WHERE id = ?").run(id)
  }
  function verdict(id: string, v: 'approved' | 'rejected', at: string): void {
    h.sqlite
      .prepare("INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES (?, ?, ?, 'someone', ?)")
      .run(`v-${id}-${at}`, id, v, at)
  }
  async function reap(id: string) {
    return reapStalledFlight(env, id, WATCHDOG, 'running_exceeded_timeout', STALLED_NOW)
  }

  it('gated task rejected then abandoned to done (latest verdict rejected) -> failed', async () => {
    gatedTask('g1')
    verdict('g1', 'rejected', '2026-10-09T00:00:00.000Z')
    seedFlight('fl-g', { taskIds: ['g1'] })
    h.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = 'g1'").run()
    expect(await reap('fl-g')).toMatchObject({ transitioned: true, target_status: 'failed' })
    expect(row('fl-g').status).toBe('failed')
  })

  it('gated task done with no verdict at all -> failed', async () => {
    gatedTask('g1')
    seedFlight('fl-g', { taskIds: ['g1'] })
    h.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = 'g1'").run()
    expect(await reap('fl-g')).toMatchObject({ target_status: 'failed' })
  })

  it('gated task whose LATEST verdict is approved (earlier rejected) and within budget -> landed', async () => {
    gatedTask('g1')
    verdict('g1', 'rejected', '2026-10-09T00:00:00.000Z')
    verdict('g1', 'approved', '2026-10-09T01:00:00.000Z')
    seedFlight('fl-g', { taskIds: ['g1'], budget: 100, cost: 100 })
    h.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = 'g1'").run()
    expect(await reap('fl-g')).toMatchObject({ target_status: 'landed', disposition: 'tasks_done' })
    expect(row('fl-g').status).toBe('landed')
  })

  it('over budget (metered) -> failed; null budget -> failed; wrong meta schema -> failed', async () => {
    seedTask('t1')
    seedFlight('fl-over', { taskIds: ['t1'], budget: 5, cost: 10 })
    seedFlight('fl-null', { taskIds: ['t1'], budget: null })
    seedFlight('fl-schema', { taskIds: ['t1'], schema: 'other/v9' })
    h.sqlite.prepare("UPDATE tasks SET status = 'done'").run()
    for (const id of ['fl-over', 'fl-null', 'fl-schema']) {
      expect(await reap(id)).toMatchObject({ transitioned: true, target_status: 'failed' })
      expect(row(id).status).toBe('failed')
    }
  })

  it('an unmetered flight (cost_metered=0) skips the budget comparison but still needs a budget policy', async () => {
    seedTask('t1')
    seedFlight('fl-unm', { taskIds: ['t1'], budget: 5, cost: 10 })
    h.sqlite.prepare("UPDATE flights SET cost_metered = 0 WHERE id = 'fl-unm'").run()
    h.sqlite.prepare("UPDATE tasks SET status = 'done'").run()
    expect(await reap('fl-unm')).toMatchObject({ target_status: 'landed' })
  })

  it('an unmetered flight with a NULL budget policy is still failed (budget policy required even when unmetered)', async () => {
    seedTask('t1')
    seedFlight('fl-unm-null', { taskIds: ['t1'], budget: null })
    h.sqlite.prepare("UPDATE flights SET cost_metered = 0 WHERE id = 'fl-unm-null'").run()
    h.sqlite.prepare("UPDATE tasks SET status = 'done'").run()
    expect(await reap('fl-unm-null')).toMatchObject({ target_status: 'failed' })
  })
})

describe('2. bookkeeping flights are closed with bookkeeping_closed, stay status failed, and never block the task', () => {
  it('a stalled bookkeeping preflight flight is closed (still status failed) with gate_reason bookkeeping_closed', async () => {
    seedFlight('fl-bk', { status: 'preflight', bookkeeping: 1 })
    const res = await reapStalledFlight(env, 'fl-bk', WATCHDOG, 'preflight_exceeded_timeout', STALLED_NOW)
    expect(res).toMatchObject({ transitioned: true, target_status: 'failed', disposition: 'bookkeeping_closed' })
    expect(row('fl-bk').status).toBe('failed')
    expect(String(row('fl-bk').gate_reason)).toMatch(/^bookkeeping_closed:/)
    expect(isRealFailure({ status: 'failed', cancelled: 0, bookkeeping: row('fl-bk').bookkeeping as number })).toBe(false)
  })

  it('the sweep counts it as closed_without_failure, not reaped; a non-bookkeeping preflight flight still fails', async () => {
    seedFlight('fl-bk', { status: 'preflight', bookkeeping: 1 })
    seedFlight('fl-real', { status: 'preflight', bookkeeping: 0 })
    const sweep = await sweepStalledFlights(env, { nowMs: STALLED_NOW })
    expect(sweep.closed_without_failure_flight_ids).toEqual(['fl-bk'])
    expect(sweep.reaped).toBe(1)
    expect(row('fl-real').status).toBe('failed')
  })

  it('P1-B: a reaped bookkeeping flight carrying task_ids does not make the task 409 on dispatch', async () => {
    seedTask('t-deploy')
    seedFlight('fl-bk', { status: 'preflight', bookkeeping: 1, taskIds: ['t-deploy'] })
    await reapStalledFlight(env, 'fl-bk', WATCHDOG, 'x', STALLED_NOW)
    expect(await findFinishedWorkConflict(env, ['t-deploy'])).toBeNull()
  })

  it('belt and braces: even a LANDED bookkeeping row (legacy) is ignored by the landed-task conflict check', async () => {
    seedTask('t-deploy')
    seedFlight('fl-bk-landed', { status: 'landed', bookkeeping: 1, taskIds: ['t-deploy'] })
    expect(await findFinishedWorkConflict(env, ['t-deploy'])).toBeNull()
    seedFlight('fl-real-landed', { status: 'landed', bookkeeping: 0, taskIds: ['t-deploy'] })
    expect(await findFinishedWorkConflict(env, ['t-deploy'])).toMatchObject({ error: 'flight_task_already_landed' })
  })
})

describe('3. one real-failure predicate for every counter', () => {
  function seedMix(): void {
    seedFlight('f-real', { status: 'failed', bookkeeping: 0 })
    seedFlight('f-book', { status: 'failed', bookkeeping: 1 }) // a pre-fix watchdog reap of a deploy/studio flight
    seedFlight('f-cancel', { status: 'failed', bookkeeping: 0 })
    h.sqlite
      .prepare(
        `INSERT INTO flight_cancel_receipts (id, tenant, flight_id, previous_status, actor_kind, actor_id, cancel_reason, cost_metered, payload, created_at)
         VALUES ('r1', ?, 'f-cancel', 'running', 'member', 'm1', 'why', 0, '{"self_cancel":false}', datetime('now'))`,
      )
      .run(TENANT)
  }

  it('JS predicate', () => {
    expect(isRealFailure({ status: 'failed', cancelled: 0, bookkeeping: 0 })).toBe(true)
    expect(isRealFailure({ status: 'failed', cancelled: 1, bookkeeping: 0 })).toBe(false)
    expect(isRealFailure({ status: 'failed', cancelled: 0, bookkeeping: 1 })).toBe(false)
    expect(isRealFailure({ status: 'landed', cancelled: 0, bookkeeping: 0 })).toBe(false)
    expect(flightOutcome({ status: 'failed', cancelled: 0, bookkeeping: 1 })).toBe('bookkeeping')
  })

  it('SQL predicate selects exactly the real failure', () => {
    seedMix()
    const ids = h.sqlite.prepare(`SELECT f.id FROM flights f WHERE ${realFailureSql('f')}`).all() as Array<{ id: string }>
    expect(ids.map((r) => r.id)).toEqual(['f-real'])
  })

  it('agent-profile counts one failure, one cancel, one bookkeeping', async () => {
    seedMix()
    const panel = await loadFlightPanel(env, AGENT)
    if (panel.state !== 'ready') throw new Error(`panel not ready: ${panel.state}`)
    expect(panel.data).toMatchObject({ failed: 1, cancelled: 1, bookkeeping: 1 })
  })

  it('flights-deck: only the real failure is in the failed phase/KPI; the bookkeeping row is its own group', async () => {
    seedMix()
    const cards = buildBoard(await listFlights(env, 50), STALLED_NOW)
    const phases = Object.fromEntries(cards.map((c) => [c.id, c.phase]))
    expect(phases).toMatchObject({ 'f-real': 'failed', 'f-cancel': 'cancelled', 'f-book': 'bookkeeping' })
    expect(flightFilterGroup('bookkeeping')).toBe('bookkeeping')
    expect(deriveFlightDeckKpis(cards).failed).toBe(1)
  })

  it('P2-a: a LANDED bookkeeping row is bookkeeping in every reader, never landed', async () => {
    seedFlight('f-bk-landed', { status: 'landed', bookkeeping: 1 })
    seedFlight('f-real-landed', { status: 'landed', bookkeeping: 0 })
    expect(flightOutcome({ status: 'landed', cancelled: 0, bookkeeping: 1 })).toBe('bookkeeping')
    const panel = await loadFlightPanel(env, AGENT)
    if (panel.state !== 'ready') throw new Error('panel not ready')
    expect(panel.data).toMatchObject({ landed: 1, bookkeeping: 1, failed: 0 })
    const cards = buildBoard(await listFlights(env, 50), STALLED_NOW)
    expect(Object.fromEntries(cards.map((c) => [c.id, c.phase]))).toMatchObject({ 'f-bk-landed': 'bookkeeping', 'f-real-landed': 'landed' })
    expect(deriveFlightDeckKpis(cards).landed).toBe(1)
    const bk = await listFlightOutcomes(env, { limit: 50, outcomes: ['bookkeeping'] })
    expect(bk.rows.map((r) => r.id)).toEqual(['f-bk-landed'])
    const landed = await listFlightOutcomes(env, { limit: 50, outcomes: ['landed'] })
    expect(landed.rows.map((r) => r.id)).toEqual(['f-real-landed'])
  })

  it('outcome feed: ?failed returns only the real failure; ?bookkeeping returns the closure', async () => {
    seedMix()
    const failed = await listFlightOutcomes(env, { limit: 50, outcomes: ['failed'] })
    expect(failed.rows.map((r) => r.id)).toEqual(['f-real'])
    const bk = await listFlightOutcomes(env, { limit: 50, outcomes: ['bookkeeping'] })
    expect(bk.rows.map((r) => r.id)).toEqual(['f-book'])
  })
})
