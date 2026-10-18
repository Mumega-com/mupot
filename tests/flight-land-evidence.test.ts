// #2025 — a landing requires evidence: a result submission from the flight's own agent (text == tasks.result) and an
// INDEPENDENT approved verdict, on every task. Real SQL via the migration chain. One predicate covers flight_land
// (service), REST land and the watchdog's tasks_done path; each failing conjunct has its own refusal reason.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { landGovernedFlight, landEvidenceRefusal } from '../src/flight/service'
import { reapStalledFlight, sweepStalledFlights } from '../src/flight/watchdog'
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
    expect(await landEvidenceRefusal(env, 'f1', ['t1'])).toEqual({ error: 'land_requires_result_submission', task_ids: ['t1'] })
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
    expect(await landEvidenceRefusal(env, 'f1', ['t1', 't2'])).toEqual({
      error: 'land_requires_result_submission', task_ids: ['t1', 't2'],
    })
  })

  it('refuses when only the assignee approved (decided_by = the task assignee / flight agent)', async () => {
    seedTask('t1')
    seedSubmission('t1')
    seedVerdict('t1', 'approved', AGENT)
    seedFlight('f1', ['t1'])
    expect((await land('f1', ['t1'])).transitioned).toBe(false)
    expect(await landEvidenceRefusal(env, 'f1', ['t1'])).toEqual({ error: 'land_requires_independent_verdict', task_ids: ['t1'] })
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
    expect(await landEvidenceRefusal(env, 'f1', ['t1', 't2'])).toEqual({
      error: 'land_requires_independent_verdict', task_ids: ['t1', 't2'],
    })
  })

  it('refuses gate:agent-self-completion even with an approved verdict from another id', async () => {
    seedTask('t1', 'gate:agent-self-completion')
    seedSubmission('t1')
    seedVerdict('t1', 'approved', OTHER)
    seedFlight('f1', ['t1'])
    expect((await land('f1', ['t1'])).transitioned).toBe(false)
    expect(await landEvidenceRefusal(env, 'f1', ['t1'])).toEqual({ error: 'land_requires_independent_verdict', task_ids: ['t1'] })
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
    expect(await landEvidenceRefusal(env, 'f1', ['t1', 't2'])).toEqual({
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

  it('counts a verdict decided via agent_attested_origin by the agent\'s owner member (a human decided)', async () => {
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
    const res = await reapStalledFlight(env, 'f1', WATCHDOG, 'running_exceeded_timeout', STALLED_NOW)
    expect(res).toMatchObject({ transitioned: false, error: 'watchdog_tasks_done_unverified' })
    expect(flightRow('f1')).toMatchObject({ status: 'running', gate_reason: 'watchdog_tasks_done_unverified' })

    // The sweep surfaces it (neither reaped nor counted as a failure) and stays idempotent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sweep = await sweepStalledFlights(env, { nowMs: STALLED_NOW })
    expect(sweep).toMatchObject({ reaped: 0, closed_without_failure: 0, failed: 0 })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('no landing evidence') && String(c[0]).includes('f1'))).toBe(true)
    warn.mockRestore()
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
