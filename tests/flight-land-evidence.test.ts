// #2025 — a landing requires evidence: a result submission from the flight's own agent (text == tasks.result) and an
// INDEPENDENT approved verdict, on every task. Real SQL via the migration chain. One predicate covers flight_land
// (service), REST land and the watchdog's tasks_done path; each failing conjunct has its own refusal reason.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { landGovernedFlight, landEvidenceRefusal } from '../src/flight/service'
import { reapStalledFlight, scanStalledFlights, sweepStalledFlights } from '../src/flight/watchdog'
import { syncCiResultToTask } from '../src/tasks/service'
import { listNeedsYou } from '../src/attention/service'
import type { RoutinePrincipal } from '../src/routines/access'
import { refusalGuidance } from '../src/mcp/refusal-next-step'
import { parseFlightMetaV1 } from '../src/flight/meta'
import type { Env } from '../src/types'

vi.mock('../src/auth/member-bearer', () => ({
  resolveOrgAdmin: vi.fn(async () => ({ ok: true, id: { memberId: 'admin-1' } })),
}))
const { flightsApp } = await import('../src/flight/routes')

const TENANT = 'mumega'
const SQUAD = 'squad-core'
const AGENT = 'agent-1'
const OTHER = 'agent-2'
const T0 = 1_000_000
const STALLED_NOW = T0 + 70 * 60_000
const SHA = 'a'.repeat(64)

let h: SqliteD1Harness
let env: Env

function metaFor(taskIds: string[]) {
  const parsed = parseFlightMetaV1({
    schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: [SQUAD], task_ids: taskIds,
    done_when: ['done'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  })
  if (!parsed) throw new Error('fixture meta must parse as v1')
  return parsed
}

function seedTask(id: string, gateOwner: string | null = 'gate:athena', result: string | null = `result-${id}`): void {
  h.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, status, assignee_agent_id, gate_owner, result)
     VALUES (?, ?, 't', 'done', ?, ?, ?)`,
  ).run(id, SQUAD, AGENT, gateOwner, result)
}

function seedSubmission(taskId: string, by = AGENT, text: string | null = `result-${taskId}`): string {
  const id = `sub-${taskId}-${by}-${Math.random().toString(36).slice(2, 8)}`
  h.sqlite.prepare(
    `INSERT INTO task_result_submissions
       (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text)
     VALUES (?, ?, ?, ?, ?, 'a/b.md', ?, ?, ?)`,
  ).run(id, TENANT, taskId, SQUAD, by, SHA, SHA, text)
  return id
}

let verdictSeq = 0
function seedVerdict(taskId: string, verdict: 'approved' | 'rejected', decidedBy: string, via: 'agent_attested_origin' | null = null): void {
  verdictSeq += 1
  h.sqlite.prepare(
    `INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at, decided_via, origin_agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`v-${verdictSeq}`, taskId, verdict, decidedBy, `2026-10-18T00:00:${String(verdictSeq % 60).padStart(2, '0')}.000Z`, via, via ? AGENT : null)
}

function seedFlight(id: string, taskIds: string[]): void {
  h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, cost_micro_usd, meta, created_at, started_at)
     VALUES (?, ?, ?, 'goal', 'running', 100000, 0, ?, ?, ?)`,
  ).run(id, TENANT, AGENT, JSON.stringify(metaFor(taskIds)), T0, T0)
}

/** A fully evidenced task: submission by the flight agent + independent approval by agent-2. */
function seedEvidenced(taskId: string): string {
  seedTask(taskId)
  const sub = seedSubmission(taskId)
  seedVerdict(taskId, 'approved', OTHER)
  return sub
}

async function land(flightId: string, taskIds: string[]) {
  return landGovernedFlight(env, flightId, {
    cost_micro_usd: 10, score: 1, expected_agent: AGENT, agent_id: AGENT,
    meta: metaFor(taskIds), actor: { kind: 'agent', id: AGENT },
  })
}

function flightRow(id: string): { status: string; gate_reason: string | null; meta: string } {
  return h.sqlite.prepare('SELECT status, gate_reason, meta FROM flights WHERE id = ?').get(id) as {
    status: string; gate_reason: string | null; meta: string
  }
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Dept A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-a', 'squad-core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${AGENT}', '${SQUAD}', 'agent-1', 'A1', 'operator', 'test', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${OTHER}', '${SQUAD}', 'agent-2', 'A2', 'operator', 'test', 'active');
  `)
  env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
})
afterEach(() => h.close())

describe('#2025 landGovernedFlight requires evidence', () => {
  it('refuses a land with no result submission; the refusal names that conjunct', async () => {
    seedTask('t1')
    seedVerdict('t1', 'approved', OTHER)
    seedFlight('f1', ['t1'])
    expect(await land('f1', ['t1'])).toEqual({ transitioned: false, receipt: false })
    expect(flightRow('f1').status).toBe('running')
    expect(await landEvidenceRefusal(env, 'f1', ['t1'])).toMatchObject({ error: 'land_requires_result_submission', task_ids: ['t1'] })
  })

  it('refuses a submission by another agent, and a submission whose text is no longer the task result', async () => {
    seedTask('t1')
    seedSubmission('t1', OTHER)
    seedVerdict('t1', 'approved', OTHER)
    seedTask('t2')
    seedSubmission('t2', AGENT, 'stale text')
    seedVerdict('t2', 'approved', OTHER)
    seedFlight('f1', ['t1', 't2'])
    expect((await land('f1', ['t1', 't2'])).transitioned).toBe(false)
    expect(await landEvidenceRefusal(env, 'f1', ['t1', 't2'])).toMatchObject({
      error: 'land_requires_result_submission', task_ids: ['t1', 't2'],
    })
  })

  it('refuses when only the assignee approved (decided_by = the task assignee / flight agent)', async () => {
    seedTask('t1')
    seedSubmission('t1')
    seedVerdict('t1', 'approved', AGENT)
    seedFlight('f1', ['t1'])
    expect((await land('f1', ['t1'])).transitioned).toBe(false)
    expect(await landEvidenceRefusal(env, 'f1', ['t1'])).toMatchObject({ error: 'land_requires_independent_verdict', task_ids: ['t1'] })
  })

  it('refuses when the TASK ASSIGNEE (a different agent than the flight agent) approved its own task, and when the flight agent approved a task assigned to someone else', async () => {
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-3', '${SQUAD}', 'agent-3', 'A3', 'operator', 'test', 'active')`)
    seedTask('t1')
    seedSubmission('t1')
    h.sqlite.prepare("UPDATE tasks SET assignee_agent_id = 'agent-3' WHERE id = 't1'").run()
    seedVerdict('t1', 'approved', 'agent-3')
    seedTask('t2')
    seedSubmission('t2')
    h.sqlite.prepare("UPDATE tasks SET assignee_agent_id = 'agent-3' WHERE id = 't2'").run()
    seedVerdict('t2', 'approved', AGENT)
    seedFlight('f1', ['t1', 't2'])
    expect((await land('f1', ['t1', 't2'])).transitioned).toBe(false)
    expect(await landEvidenceRefusal(env, 'f1', ['t1', 't2'])).toMatchObject({
      error: 'land_requires_independent_verdict', task_ids: ['t1', 't2'],
    })
  })

  it('refuses gate:agent-self-completion even with an approved verdict from another id', async () => {
    seedTask('t1', 'gate:agent-self-completion')
    seedSubmission('t1')
    seedVerdict('t1', 'approved', OTHER)
    seedFlight('f1', ['t1'])
    expect((await land('f1', ['t1'])).transitioned).toBe(false)
    expect(await landEvidenceRefusal(env, 'f1', ['t1'])).toMatchObject({ error: 'land_requires_independent_verdict', task_ids: ['t1'] })
  })

  it('refuses an ungated task with a submission but no verdict, and a latest verdict that is rejected', async () => {
    seedTask('t1', null)
    seedSubmission('t1')
    seedTask('t2')
    seedSubmission('t2')
    seedVerdict('t2', 'approved', OTHER)
    seedVerdict('t2', 'rejected', OTHER)
    seedFlight('f1', ['t1', 't2'])
    expect((await land('f1', ['t1', 't2'])).transitioned).toBe(false)
    expect(await landEvidenceRefusal(env, 'f1', ['t1', 't2'])).toMatchObject({
      error: 'land_requires_independent_verdict', task_ids: ['t1', 't2'],
    })
  })

  it('lands with an independent verdict and a matching submission; receipt_refs carry the submission once, also in the outbox', async () => {
    const sub1 = seedEvidenced('t1')
    const sub2 = seedEvidenced('t2')
    seedFlight('f1', ['t1', 't2'])
    expect(await land('f1', ['t1', 't2'])).toEqual({ transitioned: true, receipt: true })
    const row = flightRow('f1')
    expect(row.status).toBe('landed')
    const refs = (JSON.parse(row.meta) as { receipt_refs: string[] }).receipt_refs
    expect(refs).toEqual([`task-result-submission:${sub1}`, `task-result-submission:${sub2}`])
    const outbox = h.sqlite.prepare(
      `SELECT payload FROM flight_event_outbox WHERE flight_id = 'f1' AND event_type = 'flight.landed'`,
    ).get() as { payload: string }
    expect((JSON.parse(outbox.payload) as { receipt_refs: string[] }).receipt_refs).toEqual(refs)

    // A re-land attempt is refused (not in the air) and does not touch or duplicate the refs.
    expect((await land('f1', ['t1', 't2'])).transitioned).toBe(false)
    expect((JSON.parse(flightRow('f1').meta) as { receipt_refs: string[] }).receipt_refs).toEqual(refs)
  })

  it('does not duplicate a ref already present on the flight, and picks the latest matching submission', async () => {
    seedTask('t1')
    seedSubmission('t1')
    const latest = seedSubmission('t1')
    seedVerdict('t1', 'approved', OTHER)
    seedFlight('f1', ['t1'])
    h.sqlite.prepare(`UPDATE flights SET meta = json_set(meta, '$.receipt_refs', json_array('task-result-submission:${latest}'))`).run()
    expect((await land('f1', ['t1'])).transitioned).toBe(true)
    expect((JSON.parse(flightRow('f1').meta) as { receipt_refs: string[] }).receipt_refs).toEqual([`task-result-submission:${latest}`])
  })

  // NOT an owner test: the fixture agent has no agents.owner_member_id, so this only pins that a verdict whose
  // decided_by is a MEMBER id (which is what agent_attested_origin stores) is independent of the agents. Policy
  // (verdict-independence.ts:136, deliberate): a second agent with the same owner DOES count as independent, and an
  // attested verdict by the owner of the assignee is refused at write time (origin-verdict.ts assignee_conflict).
  it('counts a verdict whose decided_by is a member id (the shape agent_attested_origin stores) as independent of the agents', async () => {
    seedTask('t1')
    seedSubmission('t1')
    seedVerdict('t1', 'approved', 'mem-owner', 'agent_attested_origin')
    seedFlight('f1', ['t1'])
    expect((await land('f1', ['t1'])).transitioned).toBe(true)
  })

  it('LAND_REQUIRES_EVIDENCE=0 is the rollback: the old predicate applies and no refs are written', async () => {
    seedTask('t1', null)
    seedFlight('f1', ['t1'])
    const off = { ...env, LAND_REQUIRES_EVIDENCE: '0' } as Env
    expect(await landEvidenceRefusal(off, 'f1', ['t1'])).toBeNull()
    const res = await landGovernedFlight(off, 'f1', {
      cost_micro_usd: 1, expected_agent: AGENT, agent_id: AGENT, meta: metaFor(['t1']), actor: { kind: 'agent', id: AGENT },
    })
    expect(res.transitioned).toBe(true)
    expect((JSON.parse(flightRow('f1').meta) as { receipt_refs: string[] }).receipt_refs).toEqual([])
  })

  it('the refusals carry who_acts + next_step + next_tool in the envelope table', () => {
    const sub = refusalGuidance('land_requires_result_submission', 409, { task_ids: ['t1'] }, 'flight_land')
    expect(sub).toMatchObject({ who_acts: 'self', next_tool: 'task_submit_result' })
    expect(sub.next_step).toBeTruthy()
    const ver = refusalGuidance('land_requires_independent_verdict', 409, { task_ids: ['t1'] }, 'flight_land')
    expect(ver).toMatchObject({ who_acts: 'admin', next_tool: 'task_verdict' })
    expect(refusalGuidance('watchdog_tasks_done_unverified', 409, undefined, 'flight_reap_stalled').who_acts).toBe('admin')
  })
})

describe('#2025 REST land uses the same predicate', () => {
  async function rest(id: string) {
    return flightsApp.request(`https://pot.test/${id}/land`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ cost_micro_usd: 1 }),
    }, env)
  }

  it('refuses with the distinct reasons, then lands once evidence exists', async () => {
    seedTask('t1', null)
    seedFlight('f1', ['t1'])
    let res = await rest('f1')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'land_requires_result_submission', task_ids: ['t1'] })

    seedSubmission('t1')
    res = await rest('f1')
    expect(await res.json()).toMatchObject({ error: 'land_requires_independent_verdict', task_ids: ['t1'] })
    expect(flightRow('f1').status).toBe('running')

    seedVerdict('t1', 'approved', OTHER)
    res = await rest('f1')
    expect(res.status).toBe(200)
    expect(flightRow('f1').status).toBe('landed')
    expect((JSON.parse(flightRow('f1').meta) as { receipt_refs: string[] }).receipt_refs).toHaveLength(1)
  })
})

describe('#2025 watchdog tasks_done requires the same evidence', () => {
  const WATCHDOG = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }

  it('does NOT land a stalled flight whose tasks are done but unverified (incl. a self-approved self-completion task); records the unverified reason, status stays running', async () => {
    seedTask('t1', 'gate:agent-self-completion')
    seedVerdict('t1', 'approved', AGENT)
    seedFlight('f1', ['t1'])
    // The sweep marks it (first time) and logs the HELD line; neither reaped nor counted as a failure.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sweep = await sweepStalledFlights(env, { nowMs: STALLED_NOW })
    expect(sweep).toMatchObject({ reaped: 0, closed_without_failure: 0, failed: 0 })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('no landing evidence') && String(c[0]).includes('f1'))).toBe(true)
    warn.mockRestore()
    expect(flightRow('f1')).toMatchObject({ status: 'running', gate_reason: 'watchdog_tasks_done_unverified' })

    // A direct reap is refused the same way, and a later sweep leaves it alone (out of the window, no state change).
    const res = await reapStalledFlight(env, 'f1', WATCHDOG, 'running_exceeded_timeout', STALLED_NOW)
    expect(res).toMatchObject({ transitioned: false, error: 'watchdog_tasks_done_unverified' })
    await sweepStalledFlights(env, { nowMs: STALLED_NOW })
    expect(flightRow('f1').status).toBe('running')
  })

  it('lands a stalled flight whose tasks are done AND evidenced, and still fails one with an undone task', async () => {
    seedEvidenced('t1')
    seedFlight('f1', ['t1'])
    expect(await reapStalledFlight(env, 'f1', WATCHDOG, 'running_exceeded_timeout', STALLED_NOW))
      .toMatchObject({ transitioned: true, target_status: 'landed', disposition: 'tasks_done' })

    h.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, status, assignee_agent_id) VALUES ('t2', '${SQUAD}', 't', 'in_progress', '${AGENT}')`,
    ).run()
    seedFlight('f2', ['t2'])
    expect(await reapStalledFlight(env, 'f2', WATCHDOG, 'running_exceeded_timeout', STALLED_NOW))
      .toMatchObject({ transitioned: true, target_status: 'failed' })
  })

  it('with the flag off the watchdog keeps the old behavior (lands done tasks without evidence)', async () => {
    seedTask('t1', null)
    seedFlight('f1', ['t1'])
    const off = { ...env, LAND_REQUIRES_EVIDENCE: '0' } as Env
    expect(await reapStalledFlight(off, 'f1', WATCHDOG, 'running_exceeded_timeout', STALLED_NOW))
      .toMatchObject({ transitioned: true, target_status: 'landed' })
  })
})

describe('#2025 CI sync does not strand a landing (P1-3)', () => {
  it('a PR-linked review task whose result the CI sync overwrote with "CI: success" still lands when the flight agent submitted', async () => {
    seedTask('t1')
    h.sqlite.prepare(
      `UPDATE tasks SET status = 'review', result = 'agent work text', github_issue_url = 'https://github.com/o/r/pull/77' WHERE id = 't1'`,
    ).run()
    const sub = seedSubmission('t1', AGENT, 'agent work text')
    expect((await syncCiResultToTask(env, 77, 'success')).updated).toBe(true)
    expect((h.sqlite.prepare("SELECT result FROM tasks WHERE id = 't1'").get() as { result: string }).result).toBe('CI: success')
    h.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run()
    seedVerdict('t1', 'approved', OTHER)
    seedFlight('f1', ['t1'])
    expect(await land('f1', ['t1'])).toEqual({ transitioned: true, receipt: true })
    expect((JSON.parse(flightRow('f1').meta) as { receipt_refs: string[] }).receipt_refs).toEqual([`task-result-submission:${sub}`])
  })

  it('the CI relaxation never waives the submitter: "CI: success" with NO submission from the flight agent is still refused', async () => {
    seedTask('t1', 'gate:athena', 'CI: success')
    seedSubmission('t1', OTHER, 'whatever')
    seedVerdict('t1', 'approved', OTHER)
    seedFlight('f1', ['t1'])
    expect((await land('f1', ['t1'])).transitioned).toBe(false)
    expect(await landEvidenceRefusal(env, 'f1', ['t1'])).toMatchObject({ error: 'land_requires_result_submission' })
  })
})

describe('#2025 routine flights (M2, M7)', () => {
  const T = '2026-10-09T00:00:00.000Z'
  function routineMeta(taskIds: string[], runId: string, refs: string[] = []) {
    const parsed = parseFlightMetaV1({
      schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: [SQUAD], task_ids: taskIds,
      done_when: ['done'], artifact_refs: [], receipt_refs: refs,
      confidentiality: 'internal', publication_target: 'none', parent_flight_id: null, routine_run_id: runId,
    })
    if (!parsed) throw new Error('routine meta must parse')
    return parsed
  }

  it('M7: a CHILD flight that merely carries routine_run_id is NOT exempt from evidence', async () => {
    seedTask('t1', null)
    seedFlight('child', ['t1'])
    const meta = routineMeta(['t1'], 'run-nonexistent')
    h.sqlite.prepare("UPDATE flights SET meta = ? WHERE id = 'child'").run(JSON.stringify(meta))
    const res = await landGovernedFlight(env, 'child', {
      cost_micro_usd: 1, expected_agent: AGENT, agent_id: AGENT, meta, actor: { kind: 'agent', id: AGENT },
    })
    expect(res.transitioned).toBe(false)
    expect(flightRow('child').status).toBe('running')
  })

  it('M2: a routine CONTROL flight lands without evidence and gets NO null/bare submission ref', async () => {
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
    seedTask('t1', null)
    seedFlight('control', ['t1'])
    h.sqlite.exec(`
      INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, attempt, flight_id, proposal_json, created_at, updated_at)
      VALUES ('run-r','${TENANT}','project-r','routine-r',1,'{}','manual:run-r','cron','${T}','running',1,'control',
        '{"version":"routine.proposal/v1"}','${T}','${T}');
    `)
    const ref = 'routine.proposal:run-r'
    const meta = routineMeta(['t1'], 'run-r', [ref])
    h.sqlite.prepare("UPDATE flights SET meta = ? WHERE id = 'control'").run(JSON.stringify(meta))
    const res = await landGovernedFlight(env, 'control', {
      cost_micro_usd: 0, expected_agent: AGENT, agent_id: AGENT, meta, actor: { kind: 'agent', id: AGENT },
    })
    expect(res.transitioned).toBe(true)
    expect((JSON.parse(flightRow('control').meta) as { receipt_refs: string[] }).receipt_refs).toEqual([ref])
  })
})

describe('#2025 watchdog guarded UPDATE re-asserts the evidence (M6)', () => {
  it('evidence lost between the disposition read and the guarded UPDATE cannot be landed', async () => {
    seedEvidenced('t1')
    seedFlight('f1', ['t1'])
    const realPrepare = env.DB.prepare.bind(env.DB)
    let flipped = false
    env.DB.prepare = ((sql: string) => {
      if (!flipped && sql.includes('UPDATE flights') && sql.includes('?5')) {
        flipped = true
        h.sqlite.prepare("UPDATE tasks SET result = 'rewritten after the read' WHERE id = 't1'").run()
      }
      return realPrepare(sql)
    }) as typeof env.DB.prepare
    const res = await reapStalledFlight(env, 'f1', { actor: { kind: 'system', id: 'mupot-watchdog' } }, 'running_exceeded_timeout', STALLED_NOW)
    env.DB.prepare = realPrepare as typeof env.DB.prepare
    expect(flipped).toBe(true)
    expect(res.transitioned).toBe(false)
    expect(flightRow('f1').status).toBe('running')
  })
})

describe('#2025 held-unverified flights: window exclusion, expiry, surfacing (P1-2)', () => {
  function hold(id: string, createdAt: number, startedAt = T0): void {
    seedTask(`task-${id}`)
    seedFlight(id, [`task-${id}`])
    h.sqlite.prepare(
      `UPDATE flights SET gate_reason = 'watchdog_tasks_done_unverified', created_at = ?, started_at = ? WHERE id = ?`,
    ).run(createdAt, startedAt, id)
  }

  it('held flights do not fill the reapable window: a stalled plain flight behind them is still scanned', async () => {
    hold('h1', T0 - 3)
    hold('h2', T0 - 2)
    hold('h3', T0 - 1)
    seedTask('tp')
    seedFlight('plain', ['tp'])
    h.sqlite.prepare("UPDATE flights SET created_at = ? WHERE id = 'plain'").run(T0 + 5)
    const scan = await scanStalledFlights(env, { nowMs: STALLED_NOW, limit: 2 })
    expect(scan.items.map((i) => i.flight.id)).toEqual(['plain'])
  })

  it('a held flight stays running until 7 days after it started, then expires to failed with unverified_expired and a reap receipt', async () => {
    hold('h1', T0)
    await sweepStalledFlights(env, { nowMs: T0 + 3 * 24 * 3600_000 })
    expect(flightRow('h1')).toMatchObject({ status: 'running', gate_reason: 'watchdog_tasks_done_unverified' })
    await sweepStalledFlights(env, { nowMs: T0 + 8 * 24 * 3600_000 })
    const row = flightRow('h1')
    expect(row.status).toBe('failed')
    expect(row.gate_reason).toContain('unverified_expired')
    const receipt = h.sqlite.prepare("SELECT reap_reason FROM flight_reap_receipts WHERE flight_id = 'h1'").get() as { reap_reason: string }
    expect(receipt.reap_reason).toBe('unverified_expired')
  })

  it('needs_you stuck view lists a held flight (admin only) with the task ids and both exits', async () => {
    h.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('project-a','project-a','Project A','active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a','${SQUAD}','write');
    `)
    hold('h1', T0)
    h.sqlite.prepare("UPDATE tasks SET project_id = 'project-a' WHERE id = 'task-h1'").run()
    h.sqlite.prepare("UPDATE flights SET project_id = 'project-a' WHERE id = 'h1'").run()
    const admin: RoutinePrincipal = {
      tenant: TENANT, actor_type: 'member', actor_id: 'owner-a', workspace_admin: true,
      grants: [], project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
      legacy_owner_admin: true,
    }
    const page = await listNeedsYou(env, admin, { view: 'stuck' })
    const item = page.items.find((i) => i.source_id === 'h1')
    expect(item).toMatchObject({ kind: 'flight_unverified', source_type: 'flight', allowed_actions: ['view'] })
    expect(item?.reason).toContain('task-h1')
    expect(item?.reason).toContain('task_verdict')
    expect(item?.reason).toContain('flight_land')
    expect(item?.reason).toContain('flight_cancel')
    const member: RoutinePrincipal = { ...admin, actor_id: 'member-a', workspace_admin: false, legacy_owner_admin: false }
    expect((await listNeedsYou(env, member, { view: 'stuck' })).items).toEqual([])
    expect((await listNeedsYou(env, admin, {})).items.find((i) => i.source_id === 'h1')).toBeUndefined()
  })

  it('landing a held flight clears the held gate_reason', async () => {
    seedEvidenced('t1')
    seedFlight('f1', ['t1'])
    h.sqlite.prepare("UPDATE flights SET gate_reason = 'watchdog_tasks_done_unverified' WHERE id = 'f1'").run()
    expect((await land('f1', ['t1'])).transitioned).toBe(true)
    expect(flightRow('f1').gate_reason).toBe('')
  })
})
