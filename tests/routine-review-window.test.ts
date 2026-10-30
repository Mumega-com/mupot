import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { sweepStalledFlights, reapStalledFlight } from '../src/flight/watchdog'
import { getRoutineRun } from '../src/routines/service'
import { publicRoutineRun } from '../src/routines/public'
import type { RoutinePrincipal } from '../src/routines/access'
import type { Env } from '../src/types'
import { readTaskForAuth } from '../src/tasks/index'
import { listNeedsYou } from '../src/attention/service'
import { makeReadyRoutineFixture } from './helpers/routine-actions'
import { submitRoutineProposal, executeRoutineAction } from '../src/routines/actions'
import { routineReviewDeadline, withRoutineReviewDeadlines } from '../src/routines/review-window'
import { runRoutineScheduler } from '../src/routines/scheduler'
import { invokeTool } from '../src/mcp/index'
import { routineControlId } from '../src/routines/identity'

const TENANT = 'review-test'
const principal: RoutinePrincipal = { tenant: TENANT, actor_type: 'member', actor_id: 'owner',
  workspace_admin: true, legacy_owner_admin: true, org_owner: true, grants: [],
  project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] } }
const T0 = Date.parse('2026-10-30T00:00:00.000Z')
const HOUR = 3_600_000
const REQUESTED = T0 + 50 * 60_000
const DEADLINE = REQUESTED + 24 * HOUR
const ACTOR = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }
let h: ReturnType<typeof createSqliteD1>
let env: Env
let controlTaskId: string
beforeEach(async () => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  controlTaskId = await routineControlId('task', 'run:1')
  env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id,slug,name) VALUES ('d','d','D');
    INSERT INTO squads (id,department_id,slug,name) VALUES ('s','d','s','S');
    INSERT INTO agents (id,squad_id,slug,name,status) VALUES ('agent','s','agent','Agent','active');
    INSERT INTO projects (id,slug,name,status) VALUES ('p','p','Project','active');
    INSERT INTO project_squad_access (project_id,squad_id,access_level) VALUES ('p','s','write');
    INSERT INTO routines (id,tenant,project_id,name,objective,status,trigger_kind,timezone,
      overlap_policy,execution_mode,responsible_squad_id,budget_micro_usd,max_attempts,
      retry_backoff_seconds,revision,enabled_by,enabled_at,created_by,created_at,updated_at)
      VALUES ('routine','${TENANT}','p','Routine','Review','enabled','manual','UTC',
      'skip','propose','s',100,3,300,1,'owner','2026-10-30T00:00:00.000Z','owner','2026-10-30T00:00:00.000Z','2026-10-30T00:00:00.000Z');
  `)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); h.close() })

function seed(opts: { review?: boolean; event?: boolean; eventTenant?: string; eventActor?: string; eventActorId?: string; metadata?: string } = {}) {
  const review = opts.review !== false
  h.sqlite.prepare(`INSERT INTO tasks (id,squad_id,project_id,title,status,gate_owner,assignee_agent_id)
    VALUES (?,'s','p','Review proposal',?,'gate:routines','agent')`).run(controlTaskId, review ? 'review' : 'in_progress')
  h.sqlite.prepare(`INSERT INTO flights (id,tenant,agent,project_id,goal,status,trigger_source,
    gate_verdict,budget_micro_usd,cost_micro_usd,created_at,started_at,meta)
    VALUES ('flight',?,'agent','p','Routine','running','cron','go',100,0,?,?,?)`).run(TENANT, T0, T0,
    JSON.stringify({ schema: 'mupot.flight.meta/v1', goal_id: 'routine', objective_id: 'run',
      squad_ids: ['s'], task_ids: [controlTaskId], done_when: ['proposal'], artifact_refs: [], receipt_refs: [],
      confidentiality: 'internal', publication_target: 'none', parent_flight_id: null }))
  h.sqlite.prepare(`INSERT INTO routine_runs (id,tenant,project_id,routine_id,routine_revision,policy_json,
    occurrence_key,trigger_kind,status,waiting_reason,attempt,assigned_agent_id,task_id,flight_id,
    proposal_json,created_at,updated_at) VALUES ('run',?,'p','routine',1,?,'once','manual',?,?,1,
    'agent',?,'flight',?,?,?)`).run(TENANT, JSON.stringify({ responsible_squad_id: 's' }),
    review ? 'waiting' : 'running', review ? 'review' : null,
    controlTaskId,
    JSON.stringify({ version: 'routine.proposal/v1', action: { key: 'a', kind: 'no_action' } }),
    new Date(T0).toISOString(), new Date(REQUESTED).toISOString())
  h.sqlite.prepare(`INSERT INTO routine_run_actions (id,tenant,project_id,run_id,action_key,kind,input_json,
    validation_status,gate_status,status,source_type,source_id,created_at,updated_at)
    VALUES ('action',?,'p','run','a','no_action','{}','accepted',?,?,'task',?,?,?)`).run(TENANT,
    review ? 'pending' : 'not_required', review ? 'waiting' : 'running',
    controlTaskId,
    new Date(REQUESTED - 1000).toISOString(), new Date(REQUESTED).toISOString())
  if (opts.event !== false) h.sqlite.prepare(`INSERT INTO routine_run_events
    (id,tenant,project_id,run_id,kind,actor_type,actor_id,occurred_at,metadata_json,correlation_id)
    VALUES ('review-event',?,'p','run','approval_requested',?,?,?,?, 'run')`)
    .run(opts.eventTenant ?? TENANT, opts.eventActor ?? 'system', opts.eventActorId ?? 'mupot-routines', new Date(REQUESTED).toISOString(),
      opts.metadata ?? JSON.stringify({ action_key: 'a', reason: 'review' }))
}
const flight = () => h.sqlite.prepare("SELECT status,gate_reason FROM flights WHERE id='flight'").get()
const run = () => h.sqlite.prepare("SELECT status,result_summary FROM routine_runs WHERE id='run'").get()

describe('routine review has its own bounded watchdog clock', () => {
  it('survives the 60-minute running timeout while a genuine review request is pending', async () => {
    seed()
    const result = await sweepStalledFlights(env, { nowMs: T0 + 70 * 60_000 })
    expect(result.reaped).toBe(0)
    expect(flight()?.status).toBe('running')
    expect(run()?.status).toBe('waiting')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM flight_reap_receipts').get()?.n).toBe(0)
  })

  it('keeps the same 60-minute timeout for genuinely stuck running routine flights', async () => {
    seed({ review: false })
    expect((await sweepStalledFlights(env, { nowMs: T0 + 70 * 60_000 })).reaped).toBe(1)
    expect(flight()?.status).toBe('failed')
    expect(run()?.status).toBe('failed')
    expect(String(run()?.result_summary)).toContain('running_exceeded_timeout')
  })

  it('keeps non-routine flights on the same running timeout', async () => {
    seed({ review: false })
    h.sqlite.exec("UPDATE routine_runs SET flight_id=NULL WHERE id='run'")
    expect((await sweepStalledFlights(env, { nowMs: T0 + 70 * 60_000 })).reaped).toBe(1)
    expect(String(flight()?.gate_reason)).toContain('running_exceeded_timeout')
  })

  it.each(['preflight', 'sleeping'])('does not shelter a stuck %s flight behind a review record', async status => {
    seed()
    h.sqlite.prepare("UPDATE flights SET status=? WHERE id='flight'").run(status)
    expect((await sweepStalledFlights(env, { nowMs: T0 + 2 * HOUR })).reaped).toBe(1)
  })

  it('survives until the review deadline, then expires with a distinct reason at the boundary', async () => {
    seed()
    expect((await sweepStalledFlights(env, { nowMs: DEADLINE - 1 })).reaped).toBe(0)
    expect((await sweepStalledFlights(env, { nowMs: DEADLINE })).reaped).toBe(1)
    expect(String(run()?.result_summary)).toBe('watchdog_reap: review_window_expired')
    expect(h.sqlite.prepare('SELECT predicate_reason, reap_reason FROM flight_reap_receipts').get())
      .toMatchObject({ predicate_reason: 'review_window_expired', reap_reason: 'review_window_expired' })
    expect(h.sqlite.prepare('SELECT status FROM tasks WHERE id=?').get(controlTaskId)?.status).toBe('blocked')
  })

  it('cannot bypass review protection by calling the reaper directly', async () => {
    seed()
    expect((await reapStalledFlight(env, 'flight', ACTOR, 'manual running timeout', T0 + 2 * HOUR)).transitioned).toBe(false)
    expect(flight()?.status).toBe('running')
  })

  it('pending reviews cannot fill the candidate cap and starve a genuinely stuck flight', async () => {
    seed()
    h.sqlite.prepare(`INSERT INTO flights (id,tenant,agent,project_id,goal,status,trigger_source,
      gate_verdict,budget_micro_usd,cost_micro_usd,created_at,started_at,meta)
      VALUES ('stuck',?,'agent','p','Stuck','running','cron','go',100,0,?,?,'{}')`).run(TENANT, T0 + 1, T0)
    expect((await sweepStalledFlights(env, { nowMs: T0 + 70 * 60_000, limit: 1 })).reaped).toBe(1)
    expect(flight()?.status).toBe('running')
    expect(h.sqlite.prepare("SELECT status FROM flights WHERE id='stuck'").get()?.status).toBe('failed')
  })

  it('review expiry releases the routine overlap pin for the next occurrence', async () => {
    seed()
    h.sqlite.prepare("UPDATE routines SET trigger_kind='cron',cron_expression='* * * * *',next_run_at=? WHERE id='routine'")
      .run(new Date(DEADLINE).toISOString())
    await sweepStalledFlights(env, { nowMs: DEADLINE })
    await runRoutineScheduler(env, new Date(DEADLINE), 'test-scheduler')
    expect(h.sqlite.prepare("SELECT status FROM routine_runs WHERE id<>'run'").get()?.status).toBe('queued')
  })

  it.each([
    { event: false }, { metadata: JSON.stringify({ action_key: 'a', review_deadline_at: 'invalid' }) },
    { metadata: JSON.stringify({ action_key: 'wrong', reason: 'review' }) },
    { metadata: JSON.stringify({ action_key: 'a', attempt: 2 }) },
    { metadata: JSON.stringify({ action_key: 'a', review_deadline_at: new Date(REQUESTED + 8 * 24 * HOUR).toISOString() }) },
    { metadata: JSON.stringify({ action_key: 'a', review_deadline_at: new Date(REQUESTED + HOUR).toISOString() }) },
    { eventActor: 'agent' }, { eventActorId: 'another-component' },
  ])('does not grant an indefinite exemption to an unproven review binding: %j', async opts => {
    seed(opts)
    expect((await sweepStalledFlights(env, { nowMs: T0 + 2 * HOUR })).reaped).toBe(1)
    expect(String(run()?.result_summary)).toContain('running_exceeded_timeout')
  })

  it.each(['answer', 'approval', 'budget', 'agent'])('does not shelter a run waiting for %s as human review', async reason => {
    seed()
    h.sqlite.prepare("UPDATE routine_runs SET waiting_reason=? WHERE id='run'").run(reason)
    expect((await sweepStalledFlights(env, { nowMs: T0 + 2 * HOUR })).reaped).toBe(1)
    expect(String(run()?.result_summary)).toContain('running_exceeded_timeout')
  })

  it('does not shelter an already-running effect under the old review clock', async () => {
    seed()
    h.sqlite.exec("UPDATE routine_run_actions SET status='running',gate_status='approved'")
    h.sqlite.prepare("UPDATE flights SET resumed_at=? WHERE id='flight'").run(REQUESTED)
    expect((await sweepStalledFlights(env, { nowMs: REQUESTED + 2 * HOUR })).reaped).toBe(1)
    expect(String(run()?.result_summary)).toContain('running_exceeded_timeout')
  })

  it('uses the canonical expiry reason even if a direct caller supplies a running-timeout label', async () => {
    seed()
    await reapStalledFlight(env, 'flight', ACTOR, 'running_exceeded_timeout', DEADLINE)
    expect(String(run()?.result_summary)).toBe('watchdog_reap: review_window_expired')
  })

  it('shows a stable review deadline on the authorized public run read, independent of updated_at', async () => {
    seed()
    h.sqlite.prepare("UPDATE routine_runs SET updated_at=? WHERE id='run'").run(new Date(DEADLINE - 1000).toISOString())
    const row = await getRoutineRun(env, principal, 'run')
    expect(row).not.toBeNull()
    expect(publicRoutineRun(row!)).toMatchObject({
      review_requested_at: new Date(REQUESTED).toISOString(), review_deadline_at: new Date(DEADLINE).toISOString(),
    })
  })

  it('shows the same review deadline on the control task read', async () => {
    seed()
    const res = await readTaskForAuth(env, { tenant: TENANT, role: 'owner', userId: 'owner', email: null }, controlTaskId)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ task: { routine_review_deadline_at: new Date(DEADLINE).toISOString() } })
  })

  it('keeps the approver deadline in the MCP task_get serializer', async () => {
    seed()
    const result = await invokeTool({ tenant: TENANT, role: 'owner', userId: 'owner', email: null,
      channel: 'workspace' }, env, 'task_get', { task_id: controlTaskId }, 'test-origin')
    expect(result).toMatchObject({ ok: true, result: { task: { routine_review_deadline_at: new Date(DEADLINE).toISOString() } } })
  })

  it('task enrichment rechecks the already-authorized project context', async () => {
    seed()
    const [task] = await withRoutineReviewDeadlines(env, [{ id: controlTaskId, project_id: 'another-project' }])
    expect(task.routine_review_deadline_at ?? null).toBeNull()
  })

  it('exposes the actual human review deadline on the existing Needs You approval item', async () => {
    seed()
    h.sqlite.prepare("INSERT INTO members (id,tenant,display_name,status) VALUES ('owner',?,'Owner','active')").run(TENANT)
    h.sqlite.exec(`INSERT INTO capabilities (id,member_id,scope_type,scope_id,capability) VALUES ('c','owner','org',NULL,'admin');
      INSERT INTO gate_grants (id,capability,principal_type,principal_id,granted_by,created_at)
      VALUES ('g','gate:routines','member','owner','system','2026-10-30T00:00:00.000Z');`)
    const page = await listNeedsYou(env, principal, {}, new Date(REQUESTED + 1).toISOString())
    expect(page.items.find(item => item.source_id === controlTaskId)).toMatchObject({ deadline_at: new Date(DEADLINE).toISOString() })
  })

  it('snapshots configured review time on the server receipt and preserves it on a duplicate', async () => {
    const f = await makeReadyRoutineFixture('propose')
    try {
      f.env.ROUTINE_REVIEW_WINDOW_MS = String(48 * HOUR)
      const proposal = f.proposal({ key: 'review', kind: 'create_task', input: { title: 'Next task', description: 'Human decision' } })
      expect(await submitRoutineProposal(f.env, f.principal, proposal)).toMatchObject({ ok: true, status: 'waiting', reason: 'review' })
      const event = f.harness.sqlite.prepare("SELECT occurred_at, metadata_json FROM routine_run_events WHERE kind='approval_requested'").get()!
      const deadline = new Date(Date.parse(String(event.occurred_at)) + 48 * HOUR).toISOString()
      expect(JSON.parse(String(event.metadata_json)).review_deadline_at).toBe(deadline)
      f.env.ROUTINE_REVIEW_WINDOW_MS = String(72 * HOUR)
      await submitRoutineProposal(f.env, f.principal, proposal)
      const reader: RoutinePrincipal = { ...f.principal, workspace_admin: true,
        project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] } }
      expect(publicRoutineRun((await getRoutineRun(f.env, reader, 'run-1'))!)).toMatchObject({ review_deadline_at: deadline })
      expect(f.harness.sqlite.prepare("SELECT COUNT(*) AS n FROM routine_run_events WHERE kind='approval_requested'").get()?.n).toBe(1)
    } finally { f.harness.close() }
  })

  it.each(['0', '-1', 'NaN', '999999999999', '3600000', String(8 * 24 * HOUR)])('bounds invalid review config %s to the 24h default', config => {
    expect(routineReviewDeadline({ ...env, ROUTINE_REVIEW_WINDOW_MS: config }, new Date(REQUESTED).toISOString()))
      .toBe(new Date(DEADLINE).toISOString())
  })

  it('a review entered between evaluation and UPDATE cannot be reaped as running', async () => {
    seed({ review: false, event: false })
    const batch = h.db.batch.bind(h.db)
    vi.spyOn(h.db, 'batch').mockImplementationOnce(async statements => {
      h.sqlite.exec("UPDATE routine_runs SET status='waiting', waiting_reason='review'; UPDATE routine_run_actions SET status='waiting',gate_status='pending';")
      h.sqlite.prepare(`INSERT INTO routine_run_events (id,tenant,project_id,run_id,kind,actor_type,actor_id,occurred_at,metadata_json,correlation_id)
        VALUES ('race',?,'p','run','approval_requested','system','mupot-routines',?,?,'run')`)
        .run(TENANT, new Date(REQUESTED).toISOString(), JSON.stringify({ action_key: 'a' }))
      return batch(statements)
    })
    expect((await reapStalledFlight(env, 'flight', ACTOR, 'running_exceeded_timeout', T0 + 2 * HOUR)).transitioned).toBe(false)
    expect(flight()?.status).toBe('running')
    expect(run()?.status).toBe('waiting')
  })

  it('approved work resumes the execution clock when action execution starts', async () => {
    const f = await makeReadyRoutineFixture('propose')
    try {
      const p = f.proposal({ key: 'resume', kind: 'create_task', input: { title: 'Next', description: 'Approved' } })
      expect((await submitRoutineProposal(f.env, f.principal, p)).ok).toBe(true)
      f.harness.sqlite.prepare(`INSERT INTO task_verdicts (id,task_id,verdict,note,decided_by,decided_at)
        VALUES ('v','control-task','approved','Approved','independent',?)`).run(new Date().toISOString())
      expect((await executeRoutineAction(f.env, 'run-1', 'resume')).ok).toBe(true)
      const resumed = f.harness.sqlite.prepare("SELECT resumed_at FROM flights WHERE id='control-flight'").get()?.resumed_at
      expect(typeof resumed).toBe('number')
      expect(Number(resumed)).toBeGreaterThan(1752940800000)
    } finally { f.harness.close() }
  })

  it('cannot start approved effects at the review deadline before the watchdog ticks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(REQUESTED))
    const f = await makeReadyRoutineFixture('propose')
    try {
      const p = f.proposal({ key: 'expire', kind: 'create_task', input: { title: 'Must not execute', description: 'Late' } })
      expect((await submitRoutineProposal(f.env, f.principal, p)).ok).toBe(true)
      f.harness.sqlite.prepare(`INSERT INTO task_verdicts (id,task_id,verdict,note,decided_by,decided_at)
        VALUES ('late','control-task','approved','Approved','independent',?)`).run(new Date().toISOString())
      vi.setSystemTime(new Date(DEADLINE))
      expect(await executeRoutineAction(f.env, 'run-1', 'expire')).toMatchObject({ ok: false, error: 'approval_required' })
      expect(f.harness.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title='Must not execute'").get()?.n).toBe(0)
      expect(f.harness.sqlite.prepare("SELECT status FROM routine_runs WHERE id='run-1'").get()?.status).toBe('waiting')
      expect((await sweepStalledFlights(f.env, { nowMs: DEADLINE })).reaped).toBe(1)
      expect(f.harness.sqlite.prepare("SELECT result_summary FROM routine_runs WHERE id='run-1'").get()?.result_summary)
        .toBe('watchdog_reap: review_window_expired')
    } finally { f.harness.close() }
  })

  it('re-observation after a long human review resumes an execution budget rather than inheriting the wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(REQUESTED))
    const f = await makeReadyRoutineFixture('propose')
    try {
      const p = f.proposal({ key: 'reobserve', kind: 'create_task', input: { title: 'Next', description: 'Observe first' } })
      expect((await submitRoutineProposal(f.env, f.principal, p)).ok).toBe(true)
      vi.setSystemTime(new Date(REQUESTED + 2 * HOUR))
      f.harness.sqlite.exec(`INSERT INTO tasks (id,squad_id,project_id,title,status)
        VALUES ('new-fact','squad-1','project-1','Changed backlog requires observation','open')`)
      await executeRoutineAction(f.env, 'run-1', 'reobserve')
      expect(f.harness.sqlite.prepare("SELECT status,result_summary FROM routine_runs WHERE id='run-1'").get())
        .toMatchObject({ status: 'queued', result_summary: 'stale_situation' })
      expect(f.harness.sqlite.prepare("SELECT resumed_at FROM flights WHERE id='control-flight'").get()?.resumed_at)
        .toBe(REQUESTED + 2 * HOUR)
      expect((await sweepStalledFlights(f.env, { nowMs: REQUESTED + 2 * HOUR + 1 })).reaped).toBe(0)
    } finally { f.harness.close() }
  })
})
