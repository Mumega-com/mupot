// tests/routine-reap-overlap.test.ts — mupot#1369
//
// THE TEST THAT WOULD HAVE CAUGHT THIS. Existing watchdog tests assert the flight
// goes terminal and stop there. That is why flights.running=0 looked like success
// for three weeks while every cron tick wrote skipped/overlap.
//
// Two independent guarantees, two independent tests, plus the composed tick:
//   (a) reapStalledFlight terminalises the linked routine_run in the same sequence
//   (b) a non-terminal run whose flight is already terminal (or that is older than
//       the pin window and has no live flight) must not pin overlap
// Schema is applyAllMigrations() only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { reapStalledFlight } from '../src/flight/watchdog'
import { OVERLAP_PIN_MAX_AGE_MS, runRoutineScheduler } from '../src/routines/scheduler'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

/** Must match the exported scheduler pin window. A flight-less run older than this must not pin. */
const PIN_WINDOW_MS = 24 * 60 * 60 * 1000

const TENANT = 'tenant-a'
const T0 = Date.parse('2026-09-10T00:00:00.000Z')
const HOUR = 3_600_000
const STALL_NOW = T0 + 70 * 60_000
const TICK = new Date(STALL_NOW)
const WATCHDOG = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-1', 'dept-1', 'core', 'Core');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-active', 'active', 'Active', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-active', 'squad-1', 'write');
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
})

afterEach(() => {
  harness.close()
})

function seedRoutine(id: string): void {
  const due = TICK.toISOString()
  harness.sqlite.prepare(`
    INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind, run_once_at,
      cron_expression, timezone, next_run_at, overlap_policy, execution_mode,
      responsible_squad_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
      max_occurrences, revision, enabled_by, enabled_at, created_by, created_at, updated_at
    ) VALUES (?, ?, 'project-active', ?, 'Advance the project', 'enabled', 'cron', NULL,
      '* * * * *', 'UTC', ?, 'skip', 'propose', 'squad-1', 100000, 3, 300,
      NULL, 1, 'owner-1', ?, 'owner-1', ?, ?)
  `).run(id, TENANT, id, due, due, due, due)
}

function seedFlight(id: string, status: string, startedAt: number): void {
  harness.sqlite.prepare(`
    INSERT INTO flights
      (id, tenant, agent, dispatched_by_agent_id, goal, status, trigger_source,
       gate_verdict, gate_reason, score, budget_micro_usd, cost_micro_usd,
       next_run_at, created_at, started_at, ended_at, meta)
    VALUES (?, ?, 'agent-1', 'agent-2', 'Routine flight', ?, 'cron',
            'go', '', 1, 0, 0, NULL, ?, ?, NULL, ?)
  `).run(
    id, TENANT, status, T0, startedAt,
    JSON.stringify({ schema: 'mupot.flight.meta/v1', squad_ids: ['squad-1'] }),
  )
}

function seedRun(opts: {
  id: string
  routineId: string
  status?: string
  flightId?: string | null
  createdAt?: string
  occurrence?: string
}): void {
  const status = opts.status ?? 'running'
  const createdAt = opts.createdAt ?? new Date(T0).toISOString()
  harness.sqlite.prepare(`
    INSERT INTO routine_runs (
      id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
      trigger_kind, scheduled_for, status, waiting_reason, lease_owner, lease_expires_at,
      attempt, retry_at, flight_id, created_at, updated_at
    ) VALUES (?, ?, 'project-active', ?, 1, ?, ?, 'cron', ?, ?, NULL, NULL, NULL, 1, NULL, ?, ?, ?)
  `).run(
    opts.id, TENANT, opts.routineId,
    JSON.stringify({
      execution_mode: 'propose', overlap_policy: 'skip', responsible_squad_id: 'squad-1',
      preferred_agent_id: null, budget_micro_usd: 100000, max_attempts: 3,
      retry_backoff_seconds: 300,
    }),
    opts.occurrence ?? `manual:${opts.id}`,
    createdAt, status, opts.flightId ?? null, createdAt, createdAt,
  )
}

function nextTickRow(routineId: string, orphanId: string): { status: string; result_summary: string | null } | undefined {
  return harness.sqlite.prepare(
    `SELECT status, result_summary FROM routine_runs
      WHERE routine_id = ? AND id <> ?`,
  ).get(routineId, orphanId) as { status: string; result_summary: string | null } | undefined
}

describe('mupot#1369 reap must not leave a permanent overlap pin', () => {
  it('exports the pin window the age-bound tests measure against', () => {
    expect(OVERLAP_PIN_MAX_AGE_MS).toBe(PIN_WINDOW_MS)
  })

  it('after reapStalledFlight, the next scheduler tick queues instead of skipped/overlap', async () => {
    seedRoutine('routine-1')
    seedFlight('fl-orphan', 'running', T0)
    seedRun({ id: 'run-orphan', routineId: 'routine-1', flightId: 'fl-orphan' })

    const reap = await reapStalledFlight(env, 'fl-orphan', WATCHDOG, 'Exceeded 60m deadline', STALL_NOW)
    expect(reap.transitioned).toBe(true)

    const summary = await runRoutineScheduler(env, TICK, 'worker-a')
    expect(summary.occurrences_created).toBe(1)

    const created = nextTickRow('routine-1', 'run-orphan')
    expect(created, 'scheduler wrote a new occurrence').toBeTruthy()
    expect(created?.status).toBe('queued')
    expect(created?.result_summary).not.toBe('overlap')
    expect(created?.status).not.toBe('skipped')
  })

  it('(a) reapStalledFlight terminalises the linked routine_run with a reap-named reason', async () => {
    seedRoutine('routine-1')
    seedFlight('fl-orphan', 'running', T0)
    seedRun({ id: 'run-orphan', routineId: 'routine-1', flightId: 'fl-orphan' })

    const reap = await reapStalledFlight(env, 'fl-orphan', WATCHDOG, 'Exceeded 60m deadline', STALL_NOW)
    expect(reap.transitioned).toBe(true)

    const run = harness.sqlite.prepare(
      `SELECT status, result_summary, finished_at, flight_id FROM routine_runs WHERE id = 'run-orphan'`,
    ).get() as { status: string; result_summary: string; finished_at: string; flight_id: string }
    expect(run.status).toBe('failed')
    expect(run.result_summary).toMatch(/watchdog_reap/)
    expect(run.finished_at).toBeTruthy()
    expect(run.flight_id).toBe('fl-orphan')
  })

  it('(b) a running run whose flight is already terminal does not pin overlap, even if the run was not reaped', async () => {
    seedRoutine('routine-1')
    seedFlight('fl-already-reaped', 'failed', T0)
    harness.sqlite.prepare(
      `UPDATE flights SET ended_at = ? WHERE id = 'fl-already-reaped'`,
    ).run(STALL_NOW)
    seedRun({ id: 'run-orphan', routineId: 'routine-1', flightId: 'fl-already-reaped' })

    await runRoutineScheduler(env, TICK, 'worker-a')

    const created = nextTickRow('routine-1', 'run-orphan')
    expect(created?.status).toBe('queued')
    expect(created?.result_summary).not.toBe('overlap')
  })

  it('(b) a flight-less run older than the pin window does not pin overlap', async () => {
    seedRoutine('routine-1')
    const staleCreated = new Date(STALL_NOW - PIN_WINDOW_MS - HOUR).toISOString()
    seedRun({
      id: 'run-budget-orphan',
      routineId: 'routine-1',
      flightId: null,
      createdAt: staleCreated,
    })

    await runRoutineScheduler(env, TICK, 'worker-a')

    const created = nextTickRow('routine-1', 'run-budget-orphan')
    expect(created?.status).toBe('queued')
    expect(created?.result_summary).not.toBe('overlap')
  })

  it('a young flight-less running run still produces skipped/overlap — the pin is not deleted', async () => {
    seedRoutine('routine-1')
    seedRun({
      id: 'run-live',
      routineId: 'routine-1',
      flightId: null,
      createdAt: new Date(STALL_NOW - HOUR).toISOString(),
    })

    await runRoutineScheduler(env, TICK, 'worker-a')

    expect(nextTickRow('routine-1', 'run-live')).toEqual({
      status: 'skipped',
      result_summary: 'overlap',
    })
  })
})
