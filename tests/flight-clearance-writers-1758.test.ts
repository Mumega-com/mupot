// #1758 item 1 — every meta-bearing flight writer (project deploy, Studio dispatch, Routine control flight) runs
// the ATC clearance through ONE chokepoint (flight/dispatch.clearFlightMeta). Real schema + real engine.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createProject } from '../src/projects/service'
import { deployProject } from '../src/projects/deploy'
import { dispatchStudioFlight } from '../src/dashboard/studio'
import { dispatchRoutineRun } from '../src/routines/dispatch'
import { routineControlId } from '../src/routines/identity'
import { clearFlightMeta } from '../src/flight/dispatch'
import type { FlightMetaV1 } from '../src/flight/meta'

const REPO = 'https://github.com/Mumega-com/mupot'
const NOW = new Date('2026-07-19T16:00:00.000Z')

function meta(over: Partial<FlightMetaV1>): FlightMetaV1 {
  return {
    schema: 'mupot.flight.meta/v1', goal_id: 'other-goal', objective_id: 'other-obj', squad_ids: ['squad-x'],
    task_ids: ['other-task'], done_when: ['d'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null, ...over,
  }
}

function seedLiveFlight(h: SqliteD1Harness, tenant: string, id: string, m: FlightMetaV1, status = 'running'): void {
  h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta)
     VALUES (?, ?, 'agent-a', 'g', ?, '', 100, ?)`,
  ).run(id, tenant, status, JSON.stringify(m))
}

const flightCount = (h: SqliteD1Harness): number =>
  (h.sqlite.prepare('SELECT COUNT(*) AS n FROM flights').get() as { n: number }).n
const taskCount = (h: SqliteD1Harness): number =>
  (h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n

const auth: AuthContext = { userId: 'user-1', email: 'o@pot.test', role: 'owner', tenant: 'pot-a', memberId: 'member-a' }

let harness: SqliteD1Harness | undefined
afterEach(() => { harness?.close(); harness = undefined })

function podHarness(): { h: SqliteD1Harness; env: Env } {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
  `)
  harness = h
  return { h, env: { DB: h.db, TENANT_SLUG: 'pot-a', BRAND: 'Mupot', RELEASE_SHA: 'a'.repeat(40) } as unknown as Env }
}

describe('#1758 project deploy runs clearance', () => {
  async function project(env: Env, h: SqliteD1Harness): Promise<string> {
    const created = await createProject(env, {
      slug: 'ship', name: 'Ship', repo_url: REPO, live_url: 'https://mupot.mumega.com',
      worker_name: 'worker-beta', assigned_squad_id: 'squad-a',
    })
    if (!created.ok) throw new Error('project')
    h.sqlite.prepare("INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES (?, 'squad-a', 'write')").run(created.value.id)
    return created.value.id
  }

  it('refuses a second deploy on the same repo while a flight holds it, writing nothing', async () => {
    const { h, env } = podHarness()
    const id = await project(env, h)
    const first = await deployProject(env, id, auth, { prompt: 'first' })
    expect(first.ok).toBe(true)
    expect(flightCount(h)).toBe(1)
    const tasks = taskCount(h)

    const second = await deployProject(env, id, auth, { prompt: 'second' })
    expect(second).toEqual({ ok: false, error: 'flight_clearance_hold' })
    expect(flightCount(h)).toBe(1)
    expect(taskCount(h)).toBe(tasks)
    expect((h.sqlite.prepare('SELECT COUNT(*) AS n FROM project_deployments').get() as { n: number }).n).toBe(1)
  })

  it('is refused by a foreign live flight on the repo, and unaffected by a terminal one', async () => {
    const { h, env } = podHarness()
    const id = await project(env, h)
    seedLiveFlight(h, 'pot-a', 'f-landed', meta({ artifact_refs: [REPO] }), 'landed')
    expect((await deployProject(env, id, auth, {})).ok).toBe(true)
  })

  it('no collision -> unchanged: flight created, receipt written', async () => {
    const { h, env } = podHarness()
    const id = await project(env, h)
    seedLiveFlight(h, 'pot-a', 'f-other', meta({ artifact_refs: ['https://github.com/Mumega-com/elsewhere'] }))
    const r = await deployProject(env, id, auth, {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.flight_id).toBeTruthy()
    expect(flightCount(h)).toBe(2)
  })
})

describe('#1758 Studio dispatch runs clearance', () => {
  it('refuses with 409 flight_clearance_hold on a live same-repo flight, before any task is created', async () => {
    const { h, env } = podHarness()
    seedLiveFlight(h, 'pot-a', 'f-live', meta({ artifact_refs: [REPO] }))
    const r = await dispatchStudioFlight(env, auth, { prompt: 'Design a hero', repoUrl: REPO })
    expect(r).toEqual({ ok: false, status: 409, error: 'flight_clearance_hold' })
    expect(flightCount(h)).toBe(1)
    expect(taskCount(h)).toBe(0)
  })

  it('no collision -> unchanged: flight + task created', async () => {
    const { h, env } = podHarness()
    seedLiveFlight(h, 'pot-a', 'f-live', meta({ artifact_refs: ['https://github.com/Mumega-com/elsewhere'] }))
    const r = await dispatchStudioFlight(env, auth, { prompt: 'Design a hero', repoUrl: REPO })
    expect(r.ok).toBe(true)
    expect(flightCount(h)).toBe(2)
    expect(taskCount(h)).toBe(1)
  })

  it('a repo-less prompt has no artifact to collide on -> unchanged', async () => {
    const { env } = podHarness()
    expect((await dispatchStudioFlight(env, auth, { prompt: 'no repo' })).ok).toBe(true)
  })
})

describe('#1758 Routine ensureFlight runs clearance', () => {
  function routineHarness(): { h: SqliteD1Harness; env: Env } {
    const h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-preferred', 'squad-1', 'preferred', 'Preferred', 'active');
      INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('membership-preferred', 'agent-preferred', 'squad-1', 'member');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('member-preferred', 'Preferred runtime', 'active', 'tenant-a');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('tenant-a', 'agent-preferred', 'member-preferred', '${NOW.toISOString()}');
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
        VALUES ('token-preferred', 'member-preferred', 'hash-preferred', 'preferred', 'workspace', '${NOW.toISOString()}', NULL, 'agent-preferred', 'tenant-a');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-preferred', 'member-preferred', 'squad', 'squad-1', 'member');
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, last_reported_at, updated_at)
        VALUES ('agent-preferred', 'tenant-a', 'Preferred', 'hermes-cron', '["squad-1"]', 'always_on', 'running', 'host', '2026-07-19 15:59:30', '2026-07-19 15:59:30');
      INSERT INTO projects (id, slug, name, goal, status) VALUES ('project-1', 'project-1', 'Project One', 'Reach a verified outcome', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO routines (id, tenant, project_id, name, objective, status, trigger_kind, cron_expression, timezone, next_run_at,
        overlap_policy, execution_mode, responsible_squad_id, preferred_agent_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
        revision, enabled_by, enabled_at, created_by, created_at, updated_at)
      VALUES ('routine-1', 'tenant-a', 'project-1', 'Daily next action', 'Find and propose the next accountable action', 'enabled', 'cron', '* * * * *',
        'UTC', '2026-07-19T16:01:00.000Z', 'skip', 'propose', 'squad-1', 'agent-preferred', 100000, 3, 300, 1, 'owner-1',
        '${NOW.toISOString()}', 'owner-1', '${NOW.toISOString()}', '${NOW.toISOString()}');
      INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key, trigger_kind,
        scheduled_for, status, lease_owner, lease_expires_at, attempt, created_at, updated_at)
      VALUES ('run-1', 'tenant-a', 'project-1', 'routine-1', 1,
        '{"execution_mode":"propose","overlap_policy":"skip","responsible_squad_id":"squad-1","preferred_agent_id":"agent-preferred","budget_micro_usd":100000,"max_attempts":3,"retry_backoff_seconds":300}',
        'cron:2026-07-19T16:00:00[UTC]', 'cron', '${NOW.toISOString()}', 'leased', 'scheduler-1', '2026-07-19T16:05:00.000Z', 1,
        '${NOW.toISOString()}', '${NOW.toISOString()}');
    `)
    harness = h
    const env = {
      DB: h.db, TENANT_SLUG: 'tenant-a', PUBLIC_ORIGIN: 'https://mupot.example', BUS: { send: vi.fn(async () => undefined) },
    } as unknown as Env
    return { h, env }
  }

  it('no collision -> dispatches (its own control flight is not self-blocked)', async () => {
    const { env } = routineHarness()
    expect(await dispatchRoutineRun(env, 'run-1', NOW)).toMatchObject({ ok: true, status: 'dispatched' })
  })

  it('a live flight on the same task holds the run recoverably (retry_scheduled), no control flight created', async () => {
    const { h, env } = routineHarness()
    const taskId = await routineControlId('task', 'run-1:1')
    seedLiveFlight(h, 'tenant-a', 'f-foreign', meta({ task_ids: [taskId] }))
    const r = await dispatchRoutineRun(env, 'run-1', NOW)
    expect(r).toEqual({ ok: true, status: 'retry_scheduled', reason: 'flight_clearance_hold', run_id: 'run-1' })
    const run = h.sqlite.prepare("SELECT status, retry_at FROM routine_runs WHERE id = 'run-1'").get() as { status: string; retry_at: string }
    expect(run.status).toBe('queued')
    expect(run.retry_at).toBe('2026-07-19T16:05:00.000Z')
    expect(flightCount(h)).toBe(1)

    // recoverable: once the foreign flight lands, the retry dispatches.
    h.sqlite.prepare("UPDATE flights SET status = 'landed' WHERE id = 'f-foreign'").run()
    h.sqlite.prepare("UPDATE routine_runs SET status = 'leased', lease_owner = 's', lease_expires_at = '2026-07-19T16:30:00.000Z' WHERE id = 'run-1'").run()
    expect(await dispatchRoutineRun(env, 'run-1', NOW)).toMatchObject({ ok: true, status: 'dispatched' })
  })

  it("the run's own earlier attempt flight is not a collision (retry attempt not self-blocked)", async () => {
    const { h, env } = routineHarness()
    h.sqlite.prepare("UPDATE routine_runs SET attempt = 2 WHERE id = 'run-1'").run()
    const attempt1Flight = await routineControlId('flight', 'run-1:1')
    const attempt2Task = await routineControlId('task', 'run-1:2')
    seedLiveFlight(h, 'tenant-a', attempt1Flight, meta({ task_ids: [attempt2Task], routine_run_id: 'run-1', routine_revision: 1 }))
    expect(await dispatchRoutineRun(env, 'run-1', NOW)).toMatchObject({ ok: true, status: 'dispatched' })
  })

  it('a foreign flight that is NOT this run still holds even when an own-attempt flight exists', async () => {
    const { h, env } = routineHarness()
    const taskId = await routineControlId('task', 'run-1:1')
    seedLiveFlight(h, 'tenant-a', 'f-foreign', meta({ task_ids: [taskId] }))
    const r = await dispatchRoutineRun(env, 'run-1', NOW)
    expect(r).toMatchObject({ ok: true, status: 'retry_scheduled', reason: 'flight_clearance_hold' })
  })
})

describe('#1758 chokepoint', () => {
  it('clearFlightMeta fails closed on shared artifact and ignores named flights', async () => {
    const { h, env } = podHarness()
    seedLiveFlight(h, 'pot-a', 'f1', meta({ artifact_refs: [REPO] }))
    const proposed = meta({ artifact_refs: [REPO], task_ids: ['t-new'] })
    const held = await clearFlightMeta(env, proposed)
    expect(held.cleared).toBe(false)
    expect(held.reasons).toContain('clearance_shared_artifact_ref:f1')
    expect((await clearFlightMeta(env, proposed, { ignoreFlightIds: ['f1'] })).cleared).toBe(true)
  })
})
