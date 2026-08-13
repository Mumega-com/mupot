// Attack-path tests for the 11 P0 lifecycle fixes on the integration branch.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import {
  evaluateProjectCircuitBreaker,
  defaultCircuitBreakerDeps,
  isAtCycleBoundary,
  isSelfRecommit,
  proposeProjectRecommit,
  recommitPrincipalFromAuth,
  recordRecommitOrKill,
} from '../src/projects/circuit-breaker'
import { writeReceiptToD1 } from '../src/workflows/pipeline'
import { listProjectsDueAtBoundary, runProjectLoopTick } from '../src/projects/loop'
import { getProject, updateProject } from '../src/projects/service'
import {
  START_GATE_SEED_MARKER,
  defaultStartGateDeps,
  startProject,
  type StartGateDeps,
} from '../src/projects/start-gate'
import {
  defaultStallDetectorDeps,
  evaluateProjectStall,
  loadProjectIdleSignals,
} from '../src/projects/stall-detector'
import { loadProjectSituation } from '../src/projects/situation'
import { stripExternalLifecycleFields } from '../src/projects/lifecycle-input'
import {
  nextCycleBoundary,
  scheduleCycleBoundary,
  processProjectCycleCreation,
} from '../src/projects/cycle-creation'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      get: (key: 'auth') => AuthContext | undefined
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { projectsApp } = await import('../src/projects')

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
    INSERT INTO agents (id, squad_id, slug, name, status, created_at)
    VALUES ('agent-worker', 'squad-a', 'agent-worker', 'Worker', 'active', '2026-06-01T00:00:00.000Z');
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
  opts: { id: string; status?: string; boundary?: string | null; stalled?: number; createdAt?: string },
): void {
  const status = opts.status ?? 'active'
  const boundary = opts.boundary === undefined ? BOUNDARY : opts.boundary
  const boundarySql = boundary === null ? 'NULL' : `'${boundary}'`
  const created = opts.createdAt ?? '2026-06-01T00:00:00.000Z'
  harness.sqlite.exec(`
    INSERT INTO projects (
      id, slug, name, description, goal, status, parent_project_id, target_date,
      cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by, created_at, updated_at
    ) VALUES (
      '${opts.id}', '${opts.id}', 'Project ${opts.id}', '', 'Ship', '${status}', NULL, NULL,
      ${boundarySql}, ${opts.stalled ?? 0}, 7, NULL, '${created}', '${created}'
    );
    INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
    VALUES ('${opts.id}', 'squad-a', 'write', '${created}');
  `)
}

describe('P0-a REST via_* injection', () => {
  afterEach(() => {
    authState.current = null
  })

  it('admin PATCH with via_completion_gate:true cannot force review', async () => {
    const harness = makeHarness()
    try {
      insertProject(harness, { id: 'proj-inject', status: 'active', boundary: null })
      authState.current = {
        userId: 'user-1',
        email: null,
        role: 'owner',
        tenant: TENANT,
      }
      const response = await projectsApp.fetch(
        new Request('https://pot.test/proj-inject', {
          method: 'PATCH',
          headers: { Origin: 'https://pot.test', 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'review', via_completion_gate: true }),
        }),
        envFor(harness),
      )
      expect(response.status).toBe(409)
      const body = await response.json() as { error: string }
      expect(body.error).toBe('completion_gate_required')
      expect((await getProject(envFor(harness), 'proj-inject'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })

  it('stripExternalLifecycleFields removes the whole internal class', () => {
    const stripped = stripExternalLifecycleFields({
      status: 'review',
      via_completion_gate: true,
      via_start_gate: true,
      lifecycle_principal: 'forged',
      completion_proposed_by: 'forged',
      name: 'Keep me',
    })
    expect(stripped).toEqual({ status: 'review', name: 'Keep me' })
  })
})

describe('P0-d/e self-recommit + forged principal', () => {
  it('assignee cannot recommit their own project; different principal can', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-recommit', status: 'active' })
      harness.sqlite.exec(`
        INSERT INTO tasks (
          id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
          github_issue_url, result, completed_at, gate_owner, created_at, updated_at
        ) VALUES (
          't-own', 'squad-a', 'proj-recommit', 'Work', '', 'done', 'in_progress', 'agent-worker',
          NULL, NULL, NULL, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
        );
      `)

      expect(isSelfRecommit('agent-worker', ['agent-worker'])).toBe(true)
      expect(isSelfRecommit('member:owner', ['agent-worker'])).toBe(false)

      const self = await proposeProjectRecommit(
        env,
        'proj-recommit',
        'agent-worker',
        'keep going',
        writeReceiptToD1,
      )
      expect(self).toEqual({ ok: false, error: 'self_recommit' })

      const other = await proposeProjectRecommit(
        env,
        'proj-recommit',
        'member:owner',
        'operator continues',
        writeReceiptToD1,
      )
      expect(other.ok).toBe(true)

      // Body-supplied principal is ignored — authority comes from auth binding.
      expect(recommitPrincipalFromAuth({
        userId: 'u1',
        memberId: 'member:owner',
        boundAgentId: null,
      })).toBe('member:owner')
      expect(recommitPrincipalFromAuth({
        userId: 'u1',
        memberId: 'mem-agent',
        boundAgentId: 'agent-worker',
      })).toBe('agent-worker')
    } finally {
      harness.close()
    }
  })
})

describe('P0-f atomic circuit-breaker decision', () => {
  it('concurrent recommit wins unique key; kill does not archive', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-atomic', status: 'active' })
      await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-atomic',
          boundaryAt: BOUNDARY,
          decision: 'recommit',
          principal: 'member:owner',
          reason: 'beat the kill',
        },
        writeReceiptToD1,
      )

      const outcome = await evaluateProjectCircuitBreaker(
        env,
        {
          id: 'proj-atomic',
          status: 'active',
          cycle_boundary_at: BOUNDARY,
          stalled: 0,
        },
        NOW,
        defaultCircuitBreakerDeps(),
      )
      expect(outcome).toBe('recommitted')
      expect((await getProject(env, 'proj-atomic'))?.status).toBe('active')
    } finally {
      harness.close()
    }
  })
})

describe('P0-g timezone UTC boundary math', () => {
  it('offset boundary due in UTC is selected (cross-tz)', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      // 14:00+03:00 == 11:00Z — already due at 12:00Z.
      insertProject(harness, {
        id: 'proj-tz',
        status: 'active',
        boundary: '2026-07-23T14:00:00+03:00',
      })
      expect(isAtCycleBoundary('2026-07-23T14:00:00+03:00', '2026-07-23T12:00:00.000Z')).toBe(true)
      const due = await listProjectsDueAtBoundary(env, '2026-07-23T12:00:00.000Z')
      expect(due.map((p) => p.id)).toContain('proj-tz')
    } finally {
      harness.close()
    }
  })
})

describe('P0-h/i start-gate compensation + seed provenance', () => {
  it('activate failure rolls back minted token and created task before blocked_start', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-ghost', status: 'planned', boundary: null })
      const revoke = vi.fn(async () => true)
      const deps: StartGateDeps = {
        ...defaultStartGateDeps(),
        mintAgentBoundToken: vi.fn(async () => ({ tokenId: 'tok-ghost', memberId: 'mem-ghost' })),
        revokeMemberToken: revoke,
        resolveActiveAgentMember: vi.fn(async () => 'unminted' as const),
        createTask: vi.fn(async (taskEnv, input) => {
          const id = 'task-ghost-1'
          await taskEnv.DB.prepare(
            `INSERT INTO tasks (
               id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
               github_issue_url, result, completed_at, gate_owner, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL, NULL, ?, ?)`,
          ).bind(
            id, input.squad_id, input.project_id, input.title, input.body, input.done_when,
            input.assignee_agent_id, NOW, NOW,
          ).run()
          return {
            id,
            squad_id: input.squad_id,
            project_id: input.project_id,
            title: input.title,
            body: input.body,
            done_when: input.done_when,
            status: 'open' as const,
            assignee_agent_id: input.assignee_agent_id,
            github_issue_url: null,
            result: null,
            completed_at: null,
            gate_owner: null,
            created_at: NOW,
            updated_at: NOW,
          }
        }),
        updateProject: vi.fn(async () => ({ ok: false as const, error: 'receipt_failed' as const })),
      }

      const result = await startProject(env, 'proj-ghost', deps)
      expect(result).toMatchObject({ ok: false, error: 'activate_failed' })
      expect((await getProject(env, 'proj-ghost'))?.status).toBe('planned')
      expect(revoke).toHaveBeenCalledWith(env, 'mem-ghost', 'tok-ghost')
      const orphan = harness.sqlite.prepare('SELECT id FROM tasks WHERE id = ?').get('task-ghost-1')
      expect(orphan).toBeUndefined()
    } finally {
      harness.close()
    }
  })

  it('rejects pre-existing non-start-gate seed tasks', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-seed', status: 'planned', boundary: null })
      harness.sqlite.exec(`
        INSERT INTO tasks (
          id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
          github_issue_url, result, completed_at, gate_owner, created_at, updated_at
        ) VALUES (
          'foreign-task', 'squad-a', 'proj-seed', 'Foreign', 'no marker', 'done', 'open', 'agent-worker',
          NULL, NULL, NULL, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
        );
      `)
      const deps: StartGateDeps = {
        ...defaultStartGateDeps(),
        mintAgentBoundToken: vi.fn(async () => ({ tokenId: 'tok', memberId: 'mem' })),
        revokeMemberToken: vi.fn(async () => true),
        resolveActiveAgentMember: vi.fn(async () => 'unminted' as const),
        createTask: vi.fn(async () => {
          throw new Error('should not create when foreign tasks exist without marker')
        }),
      }
      const result = await startProject(env, 'proj-seed', deps)
      expect(result).toMatchObject({ ok: false, error: 'task_seed_failed' })
      expect((await getProject(env, 'proj-seed'))?.status).toBe('planned')
      expect(START_GATE_SEED_MARKER.length).toBeGreaterThan(0)
    } finally {
      harness.close()
    }
  })
})

describe('P0-j stall from authoritative timestamps', () => {
  it('agent-writable task.updated_at / result filler do not clear stall', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, {
        id: 'proj-stall',
        status: 'active',
        stalled: 1,
        createdAt: '2026-06-01T00:00:00.000Z',
      })
      // Forge recent activity via agent-writable fields.
      harness.sqlite.exec(`
        INSERT INTO tasks (
          id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
          github_issue_url, result, completed_at, gate_owner, created_at, updated_at
        ) VALUES (
          't-forge', 'squad-a', 'proj-stall', 'Forge', '', 'done', 'done', 'agent-worker',
          NULL, 'llm filler pretending to be evidence', '2026-07-23T11:00:00.000Z', NULL,
          '2026-06-01T00:00:00.000Z', '2026-07-23T11:59:00.000Z'
        );
      `)
      const signals = await loadProjectIdleSignals(env, 'proj-stall')
      expect(signals.newest_task_activity_at).toBeNull()
      expect(signals.newest_evidence_at).toBeNull()

      const outcome = await evaluateProjectStall(
        env,
        {
          id: 'proj-stall',
          status: 'active',
          created_at: '2026-06-01T00:00:00.000Z',
          stalled: 1,
          stall_threshold_days: 7,
        },
        NOW,
        defaultStallDetectorDeps(),
      )
      // Still idle past threshold — forged filler must not clear the flag.
      expect(outcome).toBe('unchanged')
      expect(
        harness.sqlite.prepare('SELECT stalled FROM projects WHERE id = ?').get('proj-stall'),
      ).toMatchObject({ stalled: 1 })
    } finally {
      harness.close()
    }
  })
})

describe('P0-k terminal/paused absorbing', () => {
  it('paused/completed/archived never auto-continue work', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      for (const [id, status, action] of [
        ['proj-paused', 'paused', 'resume_project'],
        ['proj-done', 'completed', 'verify_completion'],
        ['proj-arch', 'archived', 'reopen_project'],
      ] as const) {
        insertProject(harness, { id, status: 'active', boundary: null })
        harness.sqlite.exec(`
          INSERT INTO tasks (
            id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
            github_issue_url, result, completed_at, gate_owner, created_at, updated_at
          ) VALUES (
            'work-${id}', 'squad-a', '${id}', 'Still open', '', 'done', 'in_progress', 'agent-worker',
            NULL, NULL, NULL, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
          );
        `)
        harness.sqlite.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, id)
        const project = await getProject(env, id)
        expect(project).not.toBeNull()
        const situation = await loadProjectSituation(env, project!, null)
        expect(situation.next_action?.type).toBe(action)
      }
    } finally {
      harness.close()
    }
  })
})

describe('bare updateProject still requires internal via flags', () => {
  it('cannot mark review/completed without via_completion_gate', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-bare', status: 'active', boundary: null })
      await expect(updateProject(env, 'proj-bare', { status: 'review' }))
        .resolves.toEqual({ ok: false, error: 'completion_gate_required' })
    } finally {
      harness.close()
    }
  })
})

describe('Slice 5 ORDERING: cycle creation must run AFTER the circuit breaker', () => {
  // THE DEFECT THIS PINS
  //
  // Slice 5 originally ran as the FIRST step of runProjectLoopTick. Every unit test of
  // scheduleCycleBoundary passed, because the module is correct in isolation — the defect
  // lived entirely in WHERE it was placed in the sequence, and nothing drove the tick.
  //
  // listProjectsDueAtBoundary selects projects whose boundary has ELAPSED. scheduleCycleBoundary
  // advances an elapsed boundary to +14d, a future timestamp. Run first, it pushes the boundary
  // out of range before the breaker is given the chance to evaluate it, and recommit-or-kill
  // becomes unreachable for every non-stalled project — no error, no changed counter, no signal.
  //
  // These tests drive the REAL tick with the REAL listDue, and spy only on the breaker, so the
  // ordering itself is the thing under test.

  it('an elapsed boundary REACHES the breaker in the same tick', async () => {
    const harness = makeHarness()
    try {
      // Boundary elapsed only ONE DAY ago — deliberately, and this is the whole test.
      // A boundary far in the past survives the pre-fix ordering by accident: advancing it by
      // one 14-day interval leaves it STILL elapsed, so the breaker sees it regardless and the
      // mutation probe passes. Only a recently-elapsed boundary distinguishes the two orders,
      // because +14d lands it in the future and listProjectsDueAtBoundary then drops it.
      // Which is also the real case — boundaries elapse by minutes, not months.
      insertProject(harness, { id: 'ord-1', status: 'active', boundary: '2026-07-22T00:00:00.000Z' })
      const seen: string[] = []
      const result = await runProjectLoopTick(envFor(harness), {
        nowIso: () => NOW,
        evaluate: async (_env, project) => {
          seen.push(project.id)
          return 'skipped'
        },
        listActiveForCompletion: async () => [],
        listActiveForStall: async () => [],
        listStalePlanned: async () => [],
      })
      expect(seen).toContain('ord-1')
      // And the advance still happened this tick — it is deferred, not skipped.
      expect(result.cycles_advanced).toBeGreaterThanOrEqual(1)
    } finally {
      harness.close()
    }
  })

  it('the boundary is advanced only AFTER the breaker has seen it', async () => {
    const harness = makeHarness()
    try {
      insertProject(harness, { id: 'ord-2', status: 'active', boundary: '2026-07-01T00:00:00.000Z' })
      let boundaryAtBreakerTime: string | null | undefined
      await runProjectLoopTick(envFor(harness), {
        nowIso: () => NOW,
        evaluate: async (_env, project) => {
          boundaryAtBreakerTime = project.cycle_boundary_at
          return 'skipped'
        },
        listActiveForCompletion: async () => [],
        listActiveForStall: async () => [],
        listStalePlanned: async () => [],
      })
      // The breaker must have been handed the ORIGINAL elapsed boundary, not the advanced one.
      expect(boundaryAtBreakerTime).toBe('2026-07-01T00:00:00.000Z')

      // ...and the row IS advanced by the time the tick returns — by exactly ONE interval
      // from the original, not to the next future boundary. That matters: a boundary long
      // elapsed catches up one cycle per tick, so the breaker gets to evaluate EACH missed
      // boundary rather than skipping straight past them. Asserting "now in the future" here
      // would have been wrong and would have pinned the wrong behaviour.
      const row = harness.sqlite
        .prepare("SELECT cycle_boundary_at FROM projects WHERE id = 'ord-2'")
        .all() as Array<{ cycle_boundary_at: string }>
      const advancedMs = Date.parse(row[0].cycle_boundary_at)
      const originalMs = Date.parse('2026-07-01T00:00:00.000Z')
      expect(advancedMs - originalMs).toBe(14 * 24 * 60 * 60 * 1000)
    } finally {
      harness.close()
    }
  })
})

describe('Slice 5: cycle creation (rollover only, NO auto-carry)', () => {
  it('nextCycleBoundary: schedules first boundary when none exists', () => {
    const boundary = nextCycleBoundary(NOW, null, 14)
    expect(boundary).toBeTruthy()
    const ms = Date.parse(boundary!)
    const nowMs = Date.parse(NOW)
    const diff = ms - nowMs
    const days = diff / (24 * 60 * 60 * 1000)
    expect(days).toBeCloseTo(14, 0)
  })

  it('nextCycleBoundary: advances past boundary by interval', () => {
    const oldBoundary = '2026-07-01T00:00:00.000Z'
    const boundary = nextCycleBoundary(NOW, oldBoundary, 14)
    expect(boundary).toBeTruthy()
    const ms = Date.parse(boundary!)
    const oldMs = Date.parse(oldBoundary)
    const diff = ms - oldMs
    const days = diff / (24 * 60 * 60 * 1000)
    expect(days).toBeCloseTo(14, 0)
  })

  it('nextCycleBoundary: does not change future boundary', () => {
    const futureBoundary = '2026-08-23T00:00:00.000Z'
    const boundary = nextCycleBoundary(NOW, futureBoundary, 14)
    expect(boundary).toBeNull()
  })

  it('scheduleCycleBoundary: schedules first boundary for active projects', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-cycle-1', status: 'active', boundary: null })
      const outcome = await scheduleCycleBoundary(env, 'proj-cycle-1', NOW, 14)
      expect(outcome).toBe('scheduled')
      const project = await getProject(env, 'proj-cycle-1')
      expect(project?.cycle_boundary_at).toBeTruthy()
      const ms = Date.parse(project!.cycle_boundary_at!)
      const nowMs = Date.parse(NOW)
      expect(ms - nowMs).toBeCloseTo(14 * 24 * 60 * 60 * 1000, -2)
    } finally {
      harness.close()
    }
  })

  it('scheduleCycleBoundary: advances past boundaries', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-cycle-2', status: 'active', boundary: BOUNDARY })
      const outcome = await scheduleCycleBoundary(env, 'proj-cycle-2', NOW, 14)
      expect(outcome).toBe('advanced')
      const project = await getProject(env, 'proj-cycle-2')
      const newBoundaryMs = Date.parse(project!.cycle_boundary_at!)
      const oldBoundaryMs = Date.parse(BOUNDARY)
      const diff = newBoundaryMs - oldBoundaryMs
      expect(diff / (24 * 60 * 60 * 1000)).toBeCloseTo(14, 0)
    } finally {
      harness.close()
    }
  })

  it('scheduleCycleBoundary: skips future boundaries', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      const futureBoundary = '2026-08-23T00:00:00.000Z'
      insertProject(harness, { id: 'proj-cycle-3', status: 'active', boundary: futureBoundary })
      const outcome = await scheduleCycleBoundary(env, 'proj-cycle-3', NOW, 14)
      expect(outcome).toBe('skipped')
      const project = await getProject(env, 'proj-cycle-3')
      expect(project?.cycle_boundary_at).toBe(futureBoundary)
    } finally {
      harness.close()
    }
  })

  it('scheduleCycleBoundary: skips non-active projects', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-cycle-4', status: 'planned', boundary: null })
      const outcome = await scheduleCycleBoundary(env, 'proj-cycle-4', NOW, 14)
      expect(outcome).toBe('skipped')
      const project = await getProject(env, 'proj-cycle-4')
      expect(project?.cycle_boundary_at).toBeNull()
    } finally {
      harness.close()
    }
  })

  it('processProjectCycleCreation: schedules boundaries for multiple projects', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-cycle-5', status: 'active', boundary: null })
      insertProject(harness, { id: 'proj-cycle-6', status: 'active', boundary: null })
      insertProject(harness, { id: 'proj-cycle-7', status: 'active', boundary: BOUNDARY })
      const result = await processProjectCycleCreation(env, NOW, 14)
      expect(result.scanned).toBe(3)
      expect(result.scheduled).toBe(2)
      expect(result.advanced).toBe(1)
      expect(result.errors).toBe(0)
    } finally {
      harness.close()
    }
  })

  it('NO auto-carry: updating boundary does not move tasks', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertProject(harness, { id: 'proj-no-carry', status: 'active', boundary: BOUNDARY })
      harness.sqlite.exec(`
        INSERT INTO tasks (
          id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
          github_issue_url, result, completed_at, gate_owner, created_at, updated_at
        ) VALUES (
          'task-incomplete', 'squad-a', 'proj-no-carry', 'Incomplete work', '', 'done',
          'open', 'agent-worker', NULL, NULL, NULL, NULL,
          '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
        );
      `)
      const outcome = await scheduleCycleBoundary(env, 'proj-no-carry', NOW, 14)
      expect(outcome).toBe('advanced')
      const taskAfter = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1')
        .bind('task-incomplete')
        .first<{ status: string }>()
      expect(taskAfter?.status).toBe('open')
    } finally {
      harness.close()
    }
  })
})
