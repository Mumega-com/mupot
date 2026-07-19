import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import {
  claimRoutineRun,
  MAX_CLAIMS_PER_TICK,
  MAX_DUE_ROUTINES_PER_TICK,
  MAX_SCHEDULER_DB_STATEMENTS,
  recoverExpiredRoutineLeases,
  runRoutineScheduler,
  shouldRunMaintenanceHeartbeat,
} from '../src/routines/scheduler'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const NOW = new Date('2026-07-19T16:00:00.000Z')
const DISPATCH_NOW = new Date('2026-07-19T16:01:00.000Z')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-1', 'dept-1', 'core', 'Core');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-active', 'active', 'Active', 'active'),
      ('project-paused', 'paused', 'Paused', 'paused');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('project-active', 'squad-1', 'write'),
      ('project-paused', 'squad-1', 'write');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'tenant-a' } as Env
}

interface RoutineSeed {
  id: string
  projectId?: string
  trigger?: 'once' | 'cron'
  dueAt?: string | null
  status?: 'enabled' | 'paused'
  revision?: number
  overlap?: 'skip' | 'queue'
  maxOccurrences?: number | null
}

function seedRoutine(harness: SqliteD1Harness, seed: RoutineSeed): void {
  const projectId = seed.projectId ?? 'project-active'
  const trigger = seed.trigger ?? 'cron'
  const dueAt = seed.dueAt === undefined ? NOW.toISOString() : seed.dueAt
  const status = seed.status ?? 'enabled'
  const revision = seed.revision ?? 1
  const onceAt = trigger === 'once' ? dueAt : null
  const cron = trigger === 'cron' ? '* * * * *' : null
  harness.sqlite.prepare(`
    INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind, run_once_at,
      cron_expression, timezone, next_run_at, overlap_policy, execution_mode,
      responsible_squad_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
      max_occurrences, revision, enabled_by, enabled_at, created_by, created_at, updated_at
    ) VALUES (?, 'tenant-a', ?, ?, 'Advance the project', ?, ?, ?, ?, 'UTC', ?, ?,
      'propose', 'squad-1', 100000, 3, 300, ?, ?, ?, ?, 'owner-1', ?, ?)
  `).run(
    seed.id, projectId, seed.id, status, trigger, onceAt, cron, dueAt,
    seed.overlap ?? 'skip', seed.maxOccurrences ?? null, revision,
    status === 'enabled' ? 'owner-1' : null,
    status === 'enabled' ? NOW.toISOString() : null,
    NOW.toISOString(), NOW.toISOString(),
  )
}

interface RunSeed {
  id: string
  routineId: string
  projectId?: string
  status?: 'queued' | 'leased' | 'observing' | 'waiting' | 'running' | 'succeeded'
  occurrence?: string
  revision?: number
  leaseOwner?: string | null
  leaseExpiresAt?: string | null
  attempt?: number
  retryAt?: string | null
  createdAt?: string
}

function seedRun(harness: SqliteD1Harness, seed: RunSeed): void {
  const status = seed.status ?? 'queued'
  const projectId = seed.projectId ?? 'project-active'
  const leaseOwner = seed.leaseOwner ?? (status === 'leased' ? 'old-worker' : null)
  const leaseExpiresAt = seed.leaseExpiresAt ?? (status === 'leased' ? '2026-07-19T15:55:00.000Z' : null)
  const createdAt = seed.createdAt ?? '2026-07-19T15:00:00.000Z'
  harness.sqlite.prepare(`
    INSERT INTO routine_runs (
      id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
      trigger_kind, scheduled_for, status, waiting_reason, lease_owner, lease_expires_at,
      attempt, retry_at, created_at, updated_at
    ) VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, 'cron', ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    seed.id, projectId, seed.routineId, seed.revision ?? 1,
    JSON.stringify({
      execution_mode: 'propose', overlap_policy: 'skip', responsible_squad_id: 'squad-1',
      preferred_agent_id: null, budget_micro_usd: 100000, max_attempts: 3,
      retry_backoff_seconds: 300,
    }),
    seed.occurrence ?? `manual:${seed.id}`, createdAt, status, leaseOwner, leaseExpiresAt,
    seed.attempt ?? 0, seed.retryAt ?? null, createdAt, createdAt,
  )
}

function count(harness: SqliteD1Harness, sql: string, ...binds: unknown[]): number {
  return Number(harness.sqlite.prepare(sql).get(...binds)?.count ?? 0)
}

describe('routine scheduler', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('keeps existing maintenance work in canonical fifteen-minute buckets', () => {
    expect(shouldRunMaintenanceHeartbeat(new Date('2026-07-19T16:00:00.000Z'))).toBe(true)
    expect(shouldRunMaintenanceHeartbeat(new Date('2026-07-19T16:15:00.000Z'))).toBe(true)
    expect(shouldRunMaintenanceHeartbeat(new Date('2026-07-19T16:14:00.000Z'))).toBe(false)
    expect(shouldRunMaintenanceHeartbeat(new Date('invalid'))).toBe(false)
  })

  it('tracks the one-minute Worker cron needed by the scheduler', () => {
    const config = readFileSync(join(import.meta.dirname, '..', 'wrangler.example.toml'), 'utf8')
    expect(config).toContain('crons = ["* * * * *"]')
    expect(config).not.toContain('crons = ["*/15 * * * *"]')
  })

  it('leaves capacity under the D1 free-tier statement ceiling for dispatch', () => {
    expect(MAX_SCHEDULER_DB_STATEMENTS).toBeLessThanOrEqual(25)
    expect(MAX_SCHEDULER_DB_STATEMENTS).toBeLessThan(50)
  })

  it('deduplicates concurrent scheduler ticks and advances from the saved occurrence', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1' })
    const env = envFor(harness)

    const summaries = await Promise.all([
      runRoutineScheduler(env, NOW, 'worker-a'),
      runRoutineScheduler(env, NOW, 'worker-b'),
    ])

    expect(count(harness, 'SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = ?', 'routine-1')).toBe(1)
    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE kind = 'created'")).toBe(1)
    expect(harness.sqlite.prepare('SELECT next_run_at FROM routines WHERE id = ?').get('routine-1')).toEqual({
      next_run_at: '2026-07-19T16:01:00.000Z',
    })
    expect(summaries.reduce((total, summary) => total + summary.occurrences_created, 0)).toBe(1)
  })

  it('deduplicates a concurrent final occurrence without tripping the stop trigger', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', maxOccurrences: 1 })
    const env = envFor(harness)

    await expect(Promise.all([
      runRoutineScheduler(env, NOW, 'worker-a'),
      runRoutineScheduler(env, NOW, 'worker-b'),
    ])).resolves.toHaveLength(2)

    expect(count(harness, 'SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = ?', 'routine-1')).toBe(1)
    expect(harness.sqlite.prepare('SELECT next_run_at FROM routines WHERE id = ?').get('routine-1')).toEqual({ next_run_at: null })
  })

  it('processes at most 100 due routines per heartbeat', async () => {
    harness = makeHarness()
    for (let index = 0; index < 101; index++) seedRoutine(harness, { id: `routine-${String(index).padStart(3, '0')}` })

    const summary = await runRoutineScheduler(envFor(harness), NOW, 'worker-a')

    expect(summary.scanned).toBe(MAX_DUE_ROUTINES_PER_TICK)
    expect(summary.scanned).toBeLessThanOrEqual(100)
    expect(count(harness, 'SELECT COUNT(*) AS count FROM routine_runs')).toBe(MAX_DUE_ROUTINES_PER_TICK)
    expect(count(harness, 'SELECT COUNT(*) AS count FROM routines WHERE next_run_at = ?', NOW.toISOString())).toBe(
      101 - MAX_DUE_ROUTINES_PER_TICK,
    )
  })

  it('allows only one owner to claim a queued run', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1' })
    const env = envFor(harness)

    const claims = await Promise.all([
      claimRoutineRun(env, 'run-1', 'worker-a', NOW),
      claimRoutineRun(env, 'run-1', 'worker-b', NOW),
    ])

    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'leased'")).toBe(1)
    expect(harness.sqlite.prepare('SELECT status, attempt FROM routine_runs WHERE id = ?').get('run-1')).toEqual({
      status: 'leased', attempt: 1,
    })
  })

  it('does not append another lease event when the same claim is replayed', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1' })
    const env = envFor(harness)

    expect(await claimRoutineRun(env, 'run-1', 'worker-a', NOW)).toBe(true)
    expect(await claimRoutineRun(env, 'run-1', 'worker-a', NOW)).toBe(false)

    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'leased'")).toBe(1)
  })

  it('records a new lease event for a later retry attempt', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1' })
    const env = envFor(harness)

    expect(await claimRoutineRun(env, 'run-1', 'worker-a', NOW)).toBe(true)
    harness.sqlite.prepare(
      "UPDATE routine_runs SET lease_expires_at = '2026-07-19T15:59:00.000Z' WHERE id = 'run-1'",
    ).run()
    expect(await recoverExpiredRoutineLeases(env, NOW)).toBe(1)
    expect(await claimRoutineRun(env, 'run-1', 'worker-b', new Date('2026-07-19T16:05:00.000Z'))).toBe(true)

    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'leased'")).toBe(2)
    expect(harness.sqlite.prepare('SELECT attempt FROM routine_runs WHERE id = ?').get('run-1')).toEqual({ attempt: 2 })
  })

  it('recovers expired pre-dispatch leases onto the same run', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1', status: 'leased', attempt: 1 })

    expect(await recoverExpiredRoutineLeases(envFor(harness), NOW)).toBe(1)
    expect(harness.sqlite.prepare(
      'SELECT status, lease_owner, lease_expires_at FROM routine_runs WHERE id = ?',
    ).get('run-1')).toEqual({ status: 'queued', lease_owner: null, lease_expires_at: null })
    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'retry_scheduled'")).toBe(1)
  })

  it('deduplicates concurrent recovery evidence', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1', status: 'leased', attempt: 1 })
    const env = envFor(harness)

    const recovered = await Promise.all([
      recoverExpiredRoutineLeases(env, NOW),
      recoverExpiredRoutineLeases(env, NOW),
    ])

    expect(recovered.reduce((total, value) => total + value, 0)).toBe(1)
    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'retry_scheduled'")).toBe(1)
  })

  it('fails an expired lease after the snapshotted attempt ceiling', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1', status: 'leased', attempt: 3 })

    expect(await recoverExpiredRoutineLeases(envFor(harness), NOW)).toBe(1)
    expect(harness.sqlite.prepare(
      'SELECT status, result_summary, finished_at FROM routine_runs WHERE id = ?',
    ).get('run-1')).toEqual({
      status: 'failed', result_summary: 'retry_exhausted', finished_at: NOW.toISOString(),
    })
    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-1' AND kind = 'failed'")).toBe(1)
  })

  it('records a terminal skip when the Project is not active', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', projectId: 'project-paused' })

    await runRoutineScheduler(envFor(harness), NOW, 'worker-a')

    expect(harness.sqlite.prepare(
      'SELECT status, result_summary FROM routine_runs WHERE routine_id = ?',
    ).get('routine-1')).toEqual({ status: 'skipped', result_summary: 'project_not_active' })
    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE kind = 'skipped'")).toBe(1)
  })

  it('skips a queued occurrence if policy was disabled or revised before claim', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1' })
    harness.sqlite.prepare(
      "UPDATE routines SET status = 'paused', revision = 2, enabled_by = NULL, enabled_at = NULL WHERE id = 'routine-1'",
    ).run()

    expect(await claimRoutineRun(envFor(harness), 'run-1', 'worker-a', NOW)).toBe(false)
    expect(harness.sqlite.prepare('SELECT status, result_summary FROM routine_runs WHERE id = ?').get('run-1')).toEqual({
      status: 'skipped', result_summary: 'routine_policy_changed',
    })
  })

  it('records the Project lifecycle reason if a Project pauses before claim', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1' })
    harness.sqlite.prepare("UPDATE projects SET status = 'paused' WHERE id = 'project-active'").run()

    expect(await claimRoutineRun(envFor(harness), 'run-1', 'worker-a', NOW)).toBe(false)
    expect(harness.sqlite.prepare('SELECT status, result_summary FROM routine_runs WHERE id = ?').get('run-1')).toEqual({
      status: 'skipped', result_summary: 'project_not_active',
    })
  })

  it('exhausts a once schedule after creating its one occurrence', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', trigger: 'once' })
    const env = envFor(harness)

    await runRoutineScheduler(env, NOW, 'worker-a')
    await runRoutineScheduler(env, new Date(NOW.getTime() + 60_000), 'worker-b')

    expect(count(harness, 'SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = ?', 'routine-1')).toBe(1)
    expect(harness.sqlite.prepare('SELECT next_run_at FROM routines WHERE id = ?').get('routine-1')).toEqual({ next_run_at: null })
  })

  it('creates a terminal overlap skip when an earlier run is active', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', overlap: 'skip' })
    seedRun(harness, { id: 'run-active', routineId: 'routine-1', status: 'running' })

    await runRoutineScheduler(envFor(harness), NOW, 'worker-a')

    expect(harness.sqlite.prepare(
      "SELECT status, result_summary FROM routine_runs WHERE routine_id = 'routine-1' AND id <> 'run-active'",
    ).get()).toEqual({ status: 'skipped', result_summary: 'overlap' })
  })

  it('queues overlap in occurrence order and does not claim behind an active run', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', overlap: 'queue' })
    seedRun(harness, { id: 'run-active', routineId: 'routine-1', status: 'running' })

    const summary = await runRoutineScheduler(envFor(harness), NOW, 'worker-a')

    const queued = harness.sqlite.prepare(
      "SELECT id, status FROM routine_runs WHERE routine_id = 'routine-1' AND id <> 'run-active'",
    ).get() as { id: string; status: string }
    expect(queued.status).toBe('queued')
    expect(summary.claimed).toBe(0)
    expect(await claimRoutineRun(envFor(harness), queued.id, 'worker-b', NOW)).toBe(false)
  })

  it('turns the eleventh queued occurrence into a queue-cap skip', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', overlap: 'queue' })
    seedRun(harness, { id: 'run-active', routineId: 'routine-1', status: 'running' })
    for (let index = 0; index < 10; index++) {
      seedRun(harness, {
        id: `run-${index}`, routineId: 'routine-1', occurrence: `manual:queued-${index}`,
        createdAt: `2026-07-19T15:${String(index).padStart(2, '0')}:00.000Z`,
      })
    }

    await runRoutineScheduler(envFor(harness), NOW, 'worker-a')

    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_runs WHERE status = 'queued' AND routine_id = 'routine-1'")).toBe(10)
    expect(harness.sqlite.prepare(
      "SELECT result_summary FROM routine_runs WHERE status = 'skipped' AND routine_id = 'routine-1'",
    ).get()).toEqual({ result_summary: 'queue_cap' })
  })

  it('claims only retries whose retry_at is due', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z', overlap: 'queue' })
    seedRoutine(harness, { id: 'routine-2', dueAt: '2026-07-19T17:00:00.000Z', overlap: 'queue' })
    seedRun(harness, {
      id: 'run-future', routineId: 'routine-1', attempt: 1, retryAt: '2026-07-19T16:05:00.000Z',
    })
    seedRun(harness, {
      id: 'run-due', routineId: 'routine-2', attempt: 1, retryAt: '2026-07-19T15:59:00.000Z',
    })

    const summary = await runRoutineScheduler(envFor(harness), DISPATCH_NOW, 'worker-a', async () => undefined)

    expect(summary.claimed).toBe(1)
    expect(harness.sqlite.prepare('SELECT status FROM routine_runs WHERE id = ?').get('run-future')).toEqual({ status: 'queued' })
    expect(harness.sqlite.prepare('SELECT status FROM routine_runs WHERE id = ?').get('run-due')).toEqual({ status: 'leased' })
  })

  it('fails a queued retry that has already reached its attempt ceiling', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, {
      id: 'run-exhausted', routineId: 'routine-1', attempt: 3,
      retryAt: '2026-07-19T15:59:00.000Z',
    })

    const summary = await runRoutineScheduler(envFor(harness), DISPATCH_NOW, 'worker-a', async () => undefined)

    expect(summary.claimed).toBe(0)
    expect(harness.sqlite.prepare(
      'SELECT status, result_summary FROM routine_runs WHERE id = ?',
    ).get('run-exhausted')).toEqual({ status: 'failed', result_summary: 'retry_exhausted' })
    expect(count(harness, "SELECT COUNT(*) AS count FROM routine_run_events WHERE run_id = 'run-exhausted' AND kind = 'failed'")).toBe(1)
  })

  it('does not lease queued work without a dispatch processor', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1' })

    const summary = await runRoutineScheduler(envFor(harness), NOW, 'worker-a')

    expect(summary.queued_scanned).toBe(0)
    expect(summary.claimed).toBe(0)
    expect(harness.sqlite.prepare('SELECT status, attempt FROM routine_runs WHERE id = ?').get('run-1')).toEqual({
      status: 'queued', attempt: 0,
    })
  })

  it('reserves canonical maintenance heartbeats by leaving queued work unclaimed', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, { id: 'run-1', routineId: 'routine-1' })
    const processed: string[] = []

    const summary = await runRoutineScheduler(envFor(harness), NOW, 'worker-a', async runId => {
      processed.push(runId)
    })

    expect(summary.queued_scanned).toBe(0)
    expect(summary.claimed).toBe(0)
    expect(processed).toEqual([])
    expect(harness.sqlite.prepare('SELECT status FROM routine_runs WHERE id = ?').get('run-1')).toEqual({ status: 'queued' })
  })

  it('keeps a newer queued occurrence behind an earlier run in backoff', async () => {
    harness = makeHarness()
    seedRoutine(harness, { id: 'routine-1', dueAt: '2026-07-19T17:00:00.000Z', overlap: 'queue' })
    seedRun(harness, {
      id: 'run-earlier', routineId: 'routine-1', createdAt: '2026-07-19T15:00:00.000Z',
      retryAt: '2026-07-19T16:05:00.000Z',
    })
    seedRun(harness, {
      id: 'run-newer', routineId: 'routine-1', createdAt: '2026-07-19T15:01:00.000Z',
      retryAt: '2026-07-19T15:59:00.000Z',
    })

    expect(await claimRoutineRun(envFor(harness), 'run-newer', 'worker-a', NOW)).toBe(false)
    expect(harness.sqlite.prepare('SELECT status FROM routine_runs WHERE id = ?').get('run-newer')).toEqual({ status: 'queued' })
  })

  it('selects eligible queue heads past routines blocked by active work', async () => {
    harness = makeHarness()
    for (let index = 0; index < MAX_CLAIMS_PER_TICK; index++) {
      const routineId = `routine-blocked-${index}`
      seedRoutine(harness, { id: routineId, dueAt: '2026-07-19T17:00:00.000Z', overlap: 'queue' })
      seedRun(harness, { id: `active-${index}`, routineId, status: 'running' })
      seedRun(harness, {
        id: `queued-${index}`, routineId, createdAt: `2026-07-19T14:0${index}:00.000Z`,
      })
    }
    seedRoutine(harness, { id: 'routine-eligible', dueAt: '2026-07-19T17:00:00.000Z' })
    seedRun(harness, {
      id: 'run-eligible', routineId: 'routine-eligible', createdAt: '2026-07-19T15:00:00.000Z',
    })
    const processed: string[] = []

    const summary = await runRoutineScheduler(envFor(harness), DISPATCH_NOW, 'worker-a', async runId => {
      processed.push(runId)
    })

    expect(summary.claimed).toBe(1)
    expect(processed).toEqual(['run-eligible'])
  })
})
