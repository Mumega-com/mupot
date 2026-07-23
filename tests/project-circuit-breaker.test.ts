// tests/project-circuit-breaker.test.ts — project lifecycle slice 1 (kill default).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// At cycle_boundary_at with status ≠ completed and no receipted recommit → archive.
// A recommit_or_kill receipt (via existing workflow_receipts / writeReceiptToD1)
// keeps the project active. Covers both paths + migration columns.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Env, Project } from '../src/types'
import {
  KILL_REASON_NO_RECOMMIT,
  RECOMMIT_OR_KILL_SCHEMA,
  RECOMMIT_OR_KILL_STEP,
  cycleInstanceId,
  defaultCircuitBreakerDeps,
  evaluateProjectCircuitBreaker,
  hasReceiptedRecommit,
  parseRecommitOrKillDetail,
  recordRecommitOrKill,
} from '../src/projects/circuit-breaker'
import { runProjectLoopTick } from '../src/projects/loop'
import { getProject } from '../src/projects/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'pot-a'
const BOUNDARY = '2026-07-01T00:00:00.000Z'
const NOW = '2026-07-23T12:00:00.000Z'

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
  },
): void {
  const id = overrides.id ?? 'proj-1'
  const status = overrides.status ?? 'active'
  const boundary =
    overrides.cycle_boundary_at === undefined ? BOUNDARY : overrides.cycle_boundary_at
  const boundarySql = boundary === null ? 'NULL' : `'${boundary}'`
  harness.sqlite.exec(`
    INSERT INTO projects (
      id, slug, name, description, goal, status, parent_project_id, target_date,
      cycle_boundary_at, stalled, stall_threshold_days, created_at, updated_at
    ) VALUES (
      '${id}', '${id}', 'Project ${id}', '', 'Ship it', '${status}', NULL, NULL,
      ${boundarySql}, 0, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
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

describe('0068_project_cycle_boundary migration', () => {
  it('adds cycle_boundary_at, stalled, and stall_threshold_days on projects', () => {
    const harness = makeHarness()
    try {
      const columns = harness.sqlite
        .prepare("SELECT name FROM pragma_table_info('projects') ORDER BY cid")
        .all() as Array<{ name: string }>
      const names = columns.map((row) => row.name)
      expect(names).toContain('cycle_boundary_at')
      expect(names).toContain('stalled')
      expect(names).toContain('stall_threshold_days')
      const stalled = harness.sqlite
        .prepare("SELECT \"notnull\", dflt_value FROM pragma_table_info('projects') WHERE name = 'stalled'")
        .get() as { notnull: number; dflt_value: string }
      expect(stalled.notnull).toBe(1)
      expect(String(stalled.dflt_value)).toContain('0')
    } finally {
      harness.close()
    }
  })
})

describe('recommit_or_kill receipt path (workflow_receipts)', () => {
  it('records a recommit_or_kill decision through writeReceiptToD1', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, {})
      const detail = await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-1',
          boundaryAt: BOUNDARY,
          decision: 'recommit',
          principal: 'agent:owner',
          reason: 'continue_betting_table',
        },
        defaultCircuitBreakerDeps().writeReceipt,
      )
      expect(detail.schema).toBe(RECOMMIT_OR_KILL_SCHEMA)
      expect(detail.decision).toBe('recommit')

      const row = harness.sqlite
        .prepare(
          `SELECT instance_id, step_name, status, detail FROM workflow_receipts
            WHERE instance_id = ? AND step_name = ?`,
        )
        .get(cycleInstanceId('proj-1', BOUNDARY), RECOMMIT_OR_KILL_STEP) as {
        instance_id: string
        step_name: string
        status: string
        detail: string
      }
      expect(row.step_name).toBe(RECOMMIT_OR_KILL_STEP)
      expect(row.status).toBe('ok')
      const parsed = parseRecommitOrKillDetail(row.detail)
      expect(parsed).toEqual(detail)
      expect(await hasReceiptedRecommit(env, 'proj-1', BOUNDARY)).toBe(true)
    } finally {
      harness.close()
    }
  })
})

describe('project circuit breaker', () => {
  it('recommit-keeps-active: receipted recommit leaves status active', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { status: 'active', cycle_boundary_at: BOUNDARY })
      await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-1',
          boundaryAt: BOUNDARY,
          decision: 'recommit',
          principal: 'member:hadi',
          reason: 'reshape_and_rebet',
        },
        defaultCircuitBreakerDeps().writeReceipt,
      )

      const outcome = await evaluateProjectCircuitBreaker(
        env,
        loadProjectRow(harness, 'proj-1'),
        NOW,
        defaultCircuitBreakerDeps(),
      )
      expect(outcome).toBe('recommitted')
      const project = await getProject(env, 'proj-1')
      expect(project?.status).toBe('active')
    } finally {
      harness.close()
    }
  })

  it('no-recommit-kills: absent recommit archives with kill receipt + reason', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { status: 'active', cycle_boundary_at: BOUNDARY })

      const outcome = await evaluateProjectCircuitBreaker(
        env,
        loadProjectRow(harness, 'proj-1'),
        NOW,
        defaultCircuitBreakerDeps(),
      )
      expect(outcome).toBe('killed')

      const project = await getProject(env, 'proj-1')
      expect(project?.status).toBe('archived')

      const row = harness.sqlite
        .prepare(
          `SELECT detail FROM workflow_receipts
            WHERE instance_id = ? AND step_name = ?`,
        )
        .get(cycleInstanceId('proj-1', BOUNDARY), RECOMMIT_OR_KILL_STEP) as { detail: string }
      const detail = parseRecommitOrKillDetail(row.detail)
      expect(detail?.decision).toBe('kill')
      expect(detail?.reason).toBe(KILL_REASON_NO_RECOMMIT)
      expect(detail?.principal).toBe('system:project-loop')
      expect(await hasReceiptedRecommit(env, 'proj-1', BOUNDARY)).toBe(false)
    } finally {
      harness.close()
    }
  })

  it('runProjectLoopTick applies kill default across due projects', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-kill', status: 'active', cycle_boundary_at: BOUNDARY })
      insertProject(harness, { id: 'proj-keep', status: 'active', cycle_boundary_at: BOUNDARY })
      await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-keep',
          boundaryAt: BOUNDARY,
          decision: 'recommit',
          principal: 'agent:owner',
          reason: 'continue',
        },
        defaultCircuitBreakerDeps().writeReceipt,
      )

      const tick = await runProjectLoopTick(env, {
        nowIso: () => NOW,
      })
      expect(tick.ok).toBe(true)
      expect(tick.killed).toBe(1)
      expect(tick.recommitted).toBe(1)

      expect((await getProject(env, 'proj-kill'))?.status).toBe('archived')
      expect((await getProject(env, 'proj-keep'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })
})
