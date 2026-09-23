// tests/project-start-gate.test.ts — project lifecycle slice 3 (authorize + provision).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// planned → active seeds >=1 first task onto a write/admin squad AND mints/confirms
// that squad's resource via the existing grant path. Resource failure keeps the
// project planned (blocked-start). Stale planned with no provision attempt escalates
// to org owners (ghost-start alarm).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env, ProjectStatus, Task } from '../src/types'
import { listProjectsDueAtBoundary, runProjectLoopTick } from '../src/projects/loop'
import { getProject, updateProject } from '../src/projects/service'
import { DEFAULT_CYCLE_DAYS, nextCycleBoundary } from '../src/projects/cycle-creation'
import {
  BREAKER_EXEMPT_STATUSES,
  cycleInstanceId,
  proposeProjectRecommit,
  recordRecommitOrKill,
  shouldEvaluateBreaker,
} from '../src/projects/circuit-breaker'
import { writeReceiptToD1 } from '../src/workflows/pipeline'
import {
  BLOCKED_START_SCHEMA,
  BLOCKED_START_STEP,
  DEFAULT_GHOST_START_DAYS,
  GHOST_START_ALARM_SCHEMA,
  GHOST_START_ALARM_STEP,
  START_GATE_ACTIVATION_STEP,
  START_GATE_SCHEMA,
  START_GATE_SEED_MARKER,
  START_GATE_STEP,
  commitSquadResource,
  defaultGhostStartDeps,
  defaultStartGateDeps,
  evaluateGhostStartAlarm,
  ghostCutoffIso,
  ghostInstanceId,
  hasStartProvisionAttempt,
  seedTaskFromGoal,
  startActivationInstanceId,
  startInstanceId,
  startProject,
  type StartGateDeps,
} from '../src/projects/start-gate'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'pot-a'
const NOW = '2026-07-23T12:00:00.000Z'
const STALE_CREATED = '2026-07-01T00:00:00.000Z'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
    VALUES ('owner-1', 'owner@example.com', 'Owner', NULL, 'active', '2026-06-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES ('cap-owner', 'owner-1', 'org', NULL, 'owner');
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

function insertPlannedProject(
  harness: SqliteD1Harness,
  opts: { id?: string; goal?: string; created_at?: string } = {},
): void {
  const id = opts.id ?? 'proj-1'
  const goal = opts.goal ?? 'Ship the start gate'
  const created = opts.created_at ?? '2026-07-20T00:00:00.000Z'
  harness.sqlite.exec(`
    INSERT INTO projects (
      id, slug, name, description, goal, status, parent_project_id, target_date,
      cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by, created_at, updated_at
    ) VALUES (
      '${id}', '${id}', 'Project ${id}', '', '${goal.replace(/'/g, "''")}', 'planned', NULL, NULL,
      NULL, 0, NULL, NULL, '${created}', '${created}'
    );
  `)
}

function grantSquadAccess(harness: SqliteD1Harness, projectId: string, level = 'write'): void {
  harness.sqlite.exec(`
    INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
    VALUES ('${projectId}', 'squad-a', '${level}', '2026-07-20T00:00:00.000Z');
  `)
}

function insertAgent(harness: SqliteD1Harness, id = 'agent-a'): void {
  harness.sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
    VALUES ('${id}', 'squad-a', '${id}', 'Agent ${id}', 'builder', 'test', 'active', '2026-07-20T00:00:00.000Z');
  `)
}

/** Insert a plain, pre-existing task row directly — e.g. history that predates the start gate. */
function insertTask(
  harness: SqliteD1Harness,
  opts: {
    id: string
    project_id: string
    squad_id: string
    body?: string
    assignee_agent_id?: string | null
    created_at?: string
  },
): void {
  const created = opts.created_at ?? '2026-07-15T00:00:00.000Z'
  const body = (opts.body ?? 'Some pre-existing task, not a start-gate seed').replace(/'/g, "''")
  const assignee = opts.assignee_agent_id === undefined ? null : opts.assignee_agent_id
  harness.sqlite.exec(`
    INSERT INTO tasks (
      id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
      github_issue_url, result, completed_at, gate_owner, created_at, updated_at
    ) VALUES (
      '${opts.id}', '${opts.squad_id}', '${opts.project_id}', 'Pre-existing task', '${body}',
      'done_when', 'open', ${assignee ? `'${assignee}'` : 'NULL'},
      NULL, NULL, NULL, NULL, '${created}', '${created}'
    );
  `)
}

/** A createTask dep that actually persists the row (mirrors the happy-path test's inline version). */
function persistingCreateTask() {
  return vi.fn(async (
    taskEnv: Env,
    input: {
      squad_id: string
      project_id: string
      title: string
      body: string
      done_when: string
      assignee_agent_id: string
    },
  ): Promise<Task> => {
    const id = `task-seed-${Math.random().toString(36).slice(2, 10)}`
    await taskEnv.DB.prepare(
      `INSERT INTO tasks (
         id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
         github_issue_url, result, completed_at, gate_owner, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL, NULL, ?, ?)`,
    ).bind(
      id, input.squad_id, input.project_id, input.title, input.body, input.done_when,
      input.assignee_agent_id, new Date().toISOString(), new Date().toISOString(),
    ).run()
    return {
      id,
      squad_id: input.squad_id,
      project_id: input.project_id,
      title: input.title,
      body: input.body,
      done_when: input.done_when,
      status: 'open',
      assignee_agent_id: input.assignee_agent_id,
      github_issue_url: null,
      result: null,
      completed_at: null,
      gate_owner: null,
      created_at: NOW,
      updated_at: NOW,
    }
  })
}

function makeDeps(overrides: Partial<StartGateDeps> = {}): StartGateDeps {
  const base = defaultStartGateDeps()
  return {
    ...base,
    mintAgentBoundToken: vi.fn(async () => ({
      tokenId: 'tok-1',
      memberId: 'mem-agent-1',
    })),
    revokeMemberToken: vi.fn(async () => true),
    resolveActiveAgentMember: vi.fn(async () => 'unminted' as const),
    setAgentSquadAccess: vi.fn(async () => ({ ok: true as const, result: 'created' as const })),
    createTask: vi.fn(async (_env, input) => ({
      id: 'task-seed-1',
      squad_id: input.squad_id,
      project_id: input.project_id,
      title: input.title,
      body: input.body,
      done_when: input.done_when,
      status: 'open',
      assignee_agent_id: input.assignee_agent_id,
      github_issue_url: null,
      result: null,
      completed_at: null,
      gate_owner: null,
      created_at: NOW,
      updated_at: NOW,
    } satisfies Task)),
    ...overrides,
  }
}


const D = 86400000
const at = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
afterEach(() => { vi.useRealTimers() })
function clock(iso: string) { vi.setSystemTime(new Date(iso)) }
function row(h: SqliteD1Harness, id: string) {
  return h.sqlite.prepare(`SELECT status, stalled, cycle_boundary_at FROM projects WHERE id=?`).get(id) as { status: string; stalled: number; cycle_boundary_at: string | null }
}
async function tick(env: Env, iso: string) { clock(iso); return runProjectLoopTick(env, { nowIso: () => iso }) }

async function realKillThenRevive(h: SqliteD1Harness, env: Env, id: string, T0: string) {
  insertPlannedProject(h, { id, goal: 'probe', created_at: T0 })
  grantSquadAccess(h, id, 'admin')
  insertAgent(h, `agent-${id}`)
  clock(T0)
  const s = await startProject(env, id, makeDeps({ createTask: persistingCreateTask(), nowIso: () => T0 }))
  expect(s.ok).toBe(true)
  // tick at T0+1m schedules boundary if needed
  await tick(env, at(T0, 60000))
  // idle: real ticks until killed
  let killed = 0
  for (const d of [8, 15, 16]) { const r = await tick(env, at(T0, d * D)); killed += r.killed }
  expect(killed).toBe(1)
  expect(row(h, id).status).toBe('archived')
  return row(h, id)
}

describe('KR r2 probe A: real kill -> revive -> real ticks', () => {
  it('idle revived project: survives, then killed by default at new boundary/stall (no immunity)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = makeHarness(); const env = envFor(h)
    const T0 = '2026-06-01T00:00:00.000Z'
    const pre = await realKillThenRevive(h, env, 'pA', T0)
    console.log('PRE-REVIVE', JSON.stringify(pre))
    const R = '2026-08-01T00:00:00.000Z'
    clock(R)
    expect((await updateProject(env, 'pA', { status: 'planned' })).ok).toBe(true)
    const tp = await tick(env, at(R, 60000)); expect(tp.killed).toBe(0); expect(row(h,'pA').status).toBe('planned')
    clock(at(R, 120000))
    const rv = await startProject(env, 'pA', makeDeps({ createTask: persistingCreateTask(), nowIso: () => at(R, 120000) }))
    console.log('REVIVE', JSON.stringify(rv.ok ? { ok: true } : rv), JSON.stringify(row(h,'pA')))
    expect(rv.ok).toBe(true)
    const log: string[] = []
    for (const [label, ms] of [['R+5m', 5*60000], ['R+1d', D], ['R+7d', 7*D], ['R+13d', 13*D]] as const) {
      const r = await tick(env, at(R, ms)); log.push(`${label} killed=${r.killed} cleared=${r.stall_cleared} flagged=${r.stall_flagged} ${JSON.stringify(row(h,'pA'))}`)
      expect(r.killed).toBe(0); expect(row(h,'pA').status).toBe('active')
    }
    expect(row(h,'pA').stalled).toBe(0) // cleared by detector
    // past stall threshold AND new boundary from revival, no recommit
    const r2 = await tick(env, at(R, 14*D + 3*3600000))
    log.push(`R+14d3h killed=${r2.killed} ${JSON.stringify(row(h,'pA'))}`)
    console.log(log.join('\n'))
    expect(r2.killed).toBe(1)
    expect(row(h,'pA').status).toBe('archived')
    h.close()
  })

  it('revived project: recommit on new boundary works across the boundary tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = makeHarness(); const env = envFor(h)
    const T0 = '2026-06-01T00:00:00.000Z'
    await realKillThenRevive(h, env, 'pB', T0)
    const R = '2026-08-01T00:00:00.000Z'
    clock(R); expect((await updateProject(env, 'pB', { status: 'planned' })).ok).toBe(true)
    const rv = await startProject(env, 'pB', makeDeps({ createTask: persistingCreateTask(), nowIso: () => R }))
    expect(rv.ok).toBe(true)
    await tick(env, at(R, 60000))
    clock(at(R, 7*D))
    const rc = await proposeProjectRecommit(env, 'pB', 'external-reviewer', 'keep going', writeReceiptToD1)
    expect(rc).toMatchObject({ ok: true })
    const b = row(h,'pB').cycle_boundary_at
    const r = await tick(env, at(R, 14*D + 60000))
    console.log('RECOMMIT tick', JSON.stringify(r), JSON.stringify(row(h,'pB')), 'oldBoundary', b)
    expect(r.killed).toBe(0)
    expect(row(h,'pB').status).toBe('active')
    h.close()
  })
})

describe('KR r2 probe B: launder via repeated revival', () => {
  it('assignee-admin cycles active->archived->planned->active before each boundary; never needs a recommit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = makeHarness(); const env = envFor(h)
    const T0 = '2026-06-01T00:00:00.000Z'
    insertPlannedProject(h, { id: 'pL', goal: 'idle forever', created_at: T0 })
    grantSquadAccess(h, 'pL', 'admin'); insertAgent(h, 'agent-pL')
    clock(T0)
    expect((await startProject(env, 'pL', makeDeps({ createTask: persistingCreateTask(), nowIso: () => T0 }))).ok).toBe(true)
    let t = T0; let kills = 0
    for (let i = 0; i < 6; i++) {
      const r1 = await tick(env, at(t, 60000)); kills += r1.killed
      const r2 = await tick(env, at(t, 13*D)); kills += r2.killed
      const cyc = at(t, 13*D + 3600000); clock(cyc)
      expect((await updateProject(env, 'pL', { status: 'archived' })).ok).toBe(true)
      expect((await updateProject(env, 'pL', { status: 'planned' })).ok).toBe(true)
      const s = await startProject(env, 'pL', makeDeps({ createTask: persistingCreateTask(), nowIso: () => cyc, actorMemberId: 'owner-1' }))
      expect(s.ok).toBe(true)
      t = cyc
    }
    const recs = h.sqlite.prepare(`SELECT detail FROM workflow_receipts WHERE step_name='project_start_activation' ORDER BY created_at`).all() as Array<{detail:string}>
    const recommits = h.sqlite.prepare(`SELECT count(*) n FROM workflow_receipts WHERE step_name='recommit_or_kill'`).get() as {n:number}
    const seeds = h.sqlite.prepare(`SELECT count(*) n FROM tasks WHERE project_id='pL'`).get() as {n:number}
    console.log('LAUNDER days alive', (Date.parse(t)-Date.parse(T0))/D, 'kills', kills, 'activation receipts', recs.length, 'recommit_or_kill rows', recommits.n, 'tasks', seeds.n, '\nlast detail', recs[recs.length-1].detail)
    expect(kills).toBe(0)
    h.close()
  })
})

describe('KR r2 probe D2: activation receipt write fails after the UPDATE', () => {
  it('project active, stalled=1, no evidence -> next real tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = makeHarness(); const env = envFor(h)
    const T0 = '2026-06-01T00:00:00.000Z'
    await realKillThenRevive(h, env, 'pD', T0)
    const R = '2026-08-01T00:00:00.000Z'
    clock(R); expect((await updateProject(env, 'pD', { status: 'planned' })).ok).toBe(true)
    const wr = vi.fn(async (e: Env, r: { instanceId: string; taskId: string; stepName: string; status: string; detail?: string }) => {
      if (r.stepName === START_GATE_ACTIVATION_STEP) throw new Error('D1 transient')
      return writeReceiptToD1(e, r)
    })
    let res: unknown
    try { res = await startProject(env, 'pD', makeDeps({ createTask: persistingCreateTask(), nowIso: () => R, writeReceipt: wr })) } catch (e) { res = `THREW ${(e as Error).message}` }
    console.log('D2 start result', typeof res === 'string' ? res : JSON.stringify(res), JSON.stringify(row(h,'pD')))
    const r = await tick(env, at(R, 60000))
    console.log('D2 tick', JSON.stringify({ killed: r.killed, flagged: r.stall_flagged }), JSON.stringify(row(h,'pD')))
    h.close()
  })
})

describe('KR r2 probe S: stall-scan starvation (>25 active)', () => {
  it('revived project is not in the 25-oldest-updated stall scan -> breaker early-raise', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = makeHarness(); const env = envFor(h)
    const T0 = '2026-06-01T00:00:00.000Z'
    await realKillThenRevive(h, env, 'pS', T0)
    const R = '2026-08-01T00:00:00.000Z'
    // 25 other active, healthy projects with older updated_at and future boundaries
    for (let i = 0; i < 25; i++) {
      h.sqlite.exec(`INSERT INTO projects (id, slug, name, description, goal, status, cycle_boundary_at, stalled, created_at, updated_at)
        VALUES ('bg${i}','bg${i}','bg','','g','active','2026-12-01T00:00:00.000Z',0,'2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z')`)
      h.sqlite.exec(`INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, created_at, updated_at) VALUES ('bgt${i}','squad-a','bg${i}','t','b','d','open','2026-07-30T00:00:00.000Z','2026-07-30T00:00:00.000Z')`)
      h.sqlite.exec(`INSERT INTO workflow_receipts (id, instance_id, task_id, step_name, status, created_at) VALUES ('bgr${i}','bgi${i}','bgt${i}','x','ok','2026-07-31T00:00:00.000Z')`)
    }
    clock(R); expect((await updateProject(env, 'pS', { status: 'planned' })).ok).toBe(true)
    expect((await startProject(env, 'pS', makeDeps({ createTask: persistingCreateTask(), nowIso: () => R }))).ok).toBe(true)
    const r = await tick(env, at(R, 60000))
    console.log('STARVE tick', JSON.stringify({ killed: r.killed, cleared: r.stall_cleared }), JSON.stringify(row(h,'pS')))
    h.close()
  })
})

describe('KR r2 probe C: revived-to-planned, never started', () => {
  it('ghost alarm for a stale revived planned project', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const h = makeHarness(); const env = envFor(h)
    const T0 = '2026-06-01T00:00:00.000Z'
    await realKillThenRevive(h, env, 'pC', T0)
    const R = '2026-08-01T00:00:00.000Z'
    clock(R); expect((await updateProject(env, 'pC', { status: 'planned' })).ok).toBe(true)
    let ghosts = 0, kills = 0
    for (const d of [1, 8, 30, 90]) { const r = await tick(env, at(R, d*D)); ghosts += r.ghost_alarmed; kills += r.killed }
    console.log('PARKED planned: ghosts', ghosts, 'kills', kills, JSON.stringify(row(h,'pC')))
    h.close()
  })
})
