// tests/project-stall-detector.test.ts — project lifecycle slice 4 (stall → early breaker).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// Idle past stall_threshold_days sets stalled=1; flag does NOT auto-archive.
// Stalled raises the slice-1 circuit breaker early (future cycle_boundary_at).
// Fresh activity clears the flag (resets the counter).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Env, Project } from '../src/types'
import {
  KILL_REASON_NO_RECOMMIT,
  RECOMMIT_OR_KILL_STEP,
  cycleInstanceId,
  defaultCircuitBreakerDeps,
  evaluateProjectCircuitBreaker,
  parseRecommitOrKillDetail,
  shouldEvaluateBreaker,
} from '../src/projects/circuit-breaker'
import { runProjectLoopTick } from '../src/projects/loop'
import {
  DEFAULT_STALL_THRESHOLD_DAYS,
  defaultStallDetectorDeps,
  evaluateProjectStall,
  idleDurationDays,
  isPastStallThreshold,
  lastActivityFromSignals,
  loadProjectIdleSignals,
} from '../src/projects/stall-detector'
import { getProject } from '../src/projects/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'pot-a'
const FUTURE_BOUNDARY = '2026-08-01T00:00:00.000Z'
const NOW = '2026-07-23T12:00:00.000Z'
const CREATED = '2026-06-01T00:00:00.000Z'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function insertProject(
  harness: SqliteD1Harness,
  overrides: {
    id?: string
    status?: string
    cycle_boundary_at?: string | null
    stalled?: number
    stall_threshold_days?: number | null
    created_at?: string
  },
): void {
  const id = overrides.id ?? 'proj-1'
  const status = overrides.status ?? 'active'
  const boundary =
    overrides.cycle_boundary_at === undefined ? FUTURE_BOUNDARY : overrides.cycle_boundary_at
  const boundarySql = boundary === null ? 'NULL' : `'${boundary}'`
  const stalled = overrides.stalled ?? 0
  const threshold =
    overrides.stall_threshold_days === undefined ? 7 : overrides.stall_threshold_days
  const thresholdSql = threshold === null ? 'NULL' : String(threshold)
  const createdAt = overrides.created_at ?? CREATED
  harness.sqlite.exec(`
    INSERT INTO projects (
      id, slug, name, description, goal, status, parent_project_id, target_date,
      cycle_boundary_at, stalled, stall_threshold_days, created_at, updated_at
    ) VALUES (
      '${id}', '${id}', 'Project ${id}', '', 'Ship it', '${status}', NULL, NULL,
      ${boundarySql}, ${stalled}, ${thresholdSql}, '${createdAt}', '${createdAt}'
    );
    INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
    VALUES ('${id}', 'squad-a', 'write', '${createdAt}');
  `)
}

function insertTaskActivity(
  harness: SqliteD1Harness,
  input: { id: string; projectId: string; updatedAt: string; result?: string | null },
): void {
  const resultSql = input.result === undefined || input.result === null
    ? 'NULL'
    : `'${input.result.replace(/'/g, "''")}'`
  harness.sqlite.exec(`
    INSERT INTO tasks (
      id, squad_id, title, body, status, project_id, created_at, updated_at, result
    ) VALUES (
      '${input.id}', 'squad-a', 'Task ${input.id}', '', 'open', '${input.projectId}',
      '${input.updatedAt}', '${input.updatedAt}', ${resultSql}
    );
  `)
}

function insertFlightEvent(
  harness: SqliteD1Harness,
  input: { id: string; projectId: string; createdAt: string },
): void {
  harness.sqlite.exec(`
    INSERT INTO flights (
      id, tenant, agent, goal, status, project_id, created_at
    ) VALUES (
      'flight-${input.id}', '${TENANT}', 'agent-a', 'fly', 'landed', '${input.projectId}',
      ${Date.parse(input.createdAt)}
    );
    INSERT INTO flight_event_outbox (
      id, tenant, flight_id, event_type, actor_kind, actor_id, payload, created_at, project_id
    ) VALUES (
      '${input.id}', '${TENANT}', 'flight-${input.id}', 'flight.landed', 'agent', 'agent-a',
      '{"ok":true}', '${input.createdAt}', '${input.projectId}'
    );
  `)
}

function loadProjectRow(harness: SqliteD1Harness, id: string): Project {
  const row = harness.sqlite
    .prepare(
      `SELECT id, slug, name, description, goal, status, parent_project_id, target_date,
              cycle_boundary_at, stalled, stall_threshold_days, created_at, updated_at
         FROM projects WHERE id = ?`,
    )
    .get(id) as Project
  return row
}

describe('stall idle helpers', () => {
  it('computes idle days and past-threshold from last activity', () => {
    expect(idleDurationDays('2026-07-16T12:00:00.000Z', CREATED, NOW)).toBe(7)
    expect(isPastStallThreshold(7, 7)).toBe(false)
    expect(isPastStallThreshold(7.01, 7)).toBe(true)
    expect(
      lastActivityFromSignals({
        newest_task_activity_at: '2026-07-10T00:00:00.000Z',
        newest_flight_event_at: '2026-07-20T00:00:00.000Z',
        newest_evidence_at: '2026-07-15T00:00:00.000Z',
      }),
    ).toBe('2026-07-20T00:00:00.000Z')
  })
})

describe('stall detector — under / over / reset', () => {
  it('under-threshold: recent activity leaves stalled=0 (no flag)', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { stall_threshold_days: 7 })
      insertTaskActivity(harness, {
        id: 'task-fresh',
        projectId: 'proj-1',
        updatedAt: '2026-07-20T12:00:00.000Z',
      })

      const outcome = await evaluateProjectStall(
        env,
        loadProjectRow(harness, 'proj-1'),
        NOW,
        defaultStallDetectorDeps(),
      )
      expect(outcome).toBe('unchanged')
      expect(loadProjectRow(harness, 'proj-1').stalled).toBe(0)
      expect((await getProject(env, 'proj-1'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })

  it('over-threshold: idle past threshold sets stalled=1 without archiving', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { stall_threshold_days: 7 })
      insertTaskActivity(harness, {
        id: 'task-old',
        projectId: 'proj-1',
        updatedAt: '2026-07-01T12:00:00.000Z',
      })

      const outcome = await evaluateProjectStall(
        env,
        loadProjectRow(harness, 'proj-1'),
        NOW,
        defaultStallDetectorDeps(),
      )
      expect(outcome).toBe('flagged')
      expect(loadProjectRow(harness, 'proj-1').stalled).toBe(1)
      // Detection never auto-fixes / archives.
      expect((await getProject(env, 'proj-1'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })

  it('activity resets the counter: fresh signal clears stalled=1 → 0', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { stalled: 1, stall_threshold_days: 7 })
      insertTaskActivity(harness, {
        id: 'task-reset',
        projectId: 'proj-1',
        updatedAt: '2026-07-22T12:00:00.000Z',
      })

      const outcome = await evaluateProjectStall(
        env,
        loadProjectRow(harness, 'proj-1'),
        NOW,
        defaultStallDetectorDeps(),
      )
      expect(outcome).toBe('cleared')
      expect(loadProjectRow(harness, 'proj-1').stalled).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('idle signals take max of task activity, flight event, and evidence', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, {})
      insertTaskActivity(harness, {
        id: 'task-a',
        projectId: 'proj-1',
        updatedAt: '2026-07-10T00:00:00.000Z',
      })
      insertFlightEvent(harness, {
        id: 'evt-1',
        projectId: 'proj-1',
        createdAt: '2026-07-18T00:00:00.000Z',
      })
      insertTaskActivity(harness, {
        id: 'task-ev',
        projectId: 'proj-1',
        updatedAt: '2026-07-12T00:00:00.000Z',
        result: '{"ok":true}',
      })

      const signals = await loadProjectIdleSignals(env, 'proj-1')
      expect(signals.newest_task_activity_at).toBe('2026-07-12T00:00:00.000Z')
      expect(signals.newest_flight_event_at).toBe('2026-07-18T00:00:00.000Z')
      expect(signals.newest_evidence_at).toBe('2026-07-12T00:00:00.000Z')
      expect(lastActivityFromSignals(signals)).toBe('2026-07-18T00:00:00.000Z')
    } finally {
      harness.close()
    }
  })

  it('NULL stall_threshold_days uses tenant default', () => {
    expect(DEFAULT_STALL_THRESHOLD_DAYS).toBe(14)
    expect(isPastStallThreshold(14, DEFAULT_STALL_THRESHOLD_DAYS)).toBe(false)
    expect(isPastStallThreshold(14.1, DEFAULT_STALL_THRESHOLD_DAYS)).toBe(true)
  })
})

describe('stalled raises circuit breaker early', () => {
  it('shouldEvaluateBreaker is true for stalled + future boundary', () => {
    expect(shouldEvaluateBreaker('active', FUTURE_BOUNDARY, NOW, 0)).toBe(false)
    expect(shouldEvaluateBreaker('active', FUTURE_BOUNDARY, NOW, 1)).toBe(true)
    expect(shouldEvaluateBreaker('active', null, NOW, 1)).toBe(false)
  })

  it('over-threshold flag + early breaker archives when no recommit', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, {
        stall_threshold_days: 7,
        cycle_boundary_at: FUTURE_BOUNDARY,
      })
      insertTaskActivity(harness, {
        id: 'task-stale',
        projectId: 'proj-1',
        updatedAt: '2026-07-01T12:00:00.000Z',
      })

      const tick = await runProjectLoopTick(env, { nowIso: () => NOW })
      expect(tick.ok).toBe(true)
      expect(tick.stall_flagged).toBe(1)
      expect(tick.killed).toBe(1)

      const project = await getProject(env, 'proj-1')
      expect(project?.stalled).toBe(1)
      expect(project?.status).toBe('archived')

      const row = harness.sqlite
        .prepare(
          `SELECT detail FROM workflow_receipts
            WHERE instance_id = ? AND step_name = ?`,
        )
        .get(cycleInstanceId('proj-1', FUTURE_BOUNDARY), RECOMMIT_OR_KILL_STEP) as {
        detail: string
      }
      const detail = parseRecommitOrKillDetail(row.detail)
      expect(detail?.decision).toBe('kill')
      expect(detail?.reason).toBe(KILL_REASON_NO_RECOMMIT)
    } finally {
      harness.close()
    }
  })

  it('stalled alone does not kill when cycle_boundary_at is null', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, {
        stalled: 1,
        cycle_boundary_at: null,
        stall_threshold_days: 7,
      })

      const outcome = await evaluateProjectCircuitBreaker(
        env,
        loadProjectRow(harness, 'proj-1'),
        NOW,
        defaultCircuitBreakerDeps(),
      )
      expect(outcome).toBe('skipped')
      expect((await getProject(env, 'proj-1'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })
})
