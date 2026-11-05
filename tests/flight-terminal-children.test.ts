// Coherence wave 1 item 4: a flight that ends as failed (cancel or reap) must give every
// meta.task_ids child a fenced disposition in the same batch as the flight transition.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cancelFlight, reapStalledFlight } from '../src/flight/watchdog'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const T0 = 1_000_000
const NOW = T0 + 70 * 60_000
const NOW_ISO = new Date(NOW).toISOString()
const WATCHDOG = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }
const LEAD = { actor: { kind: 'member' as const, id: 'm-lead' }, isOrgAdmin: true }

let h: SqliteD1Harness
let env: Env

const CHILDREN: Record<string, string> = {
  c_open: 'open', c_prog_free: 'in_progress', c_prog_live: 'in_progress', c_prog_recv: 'in_progress',
  c_prog_disp: 'in_progress', c_prog_expired: 'in_progress', c_done: 'done', c_review: 'review', c_approved: 'approved',
  c_rejected: 'rejected', c_blocked: 'blocked', c_archived: 'open',
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept','dept','D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad','dept','squad','S');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent','squad','agent','A','active');
  `)
  for (const [id, status] of Object.entries(CHILDREN)) {
    h.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
       VALUES (?, 'squad', ?, 'b', 'd', ?, 'agent', ?, ?)`,
    ).run(id, id, status, NOW_ISO, NOW_ISO)
  }
  // live claim; receipt with no expiry (unaccounted runtime); unsettled dispatch only
  h.sqlite.prepare("UPDATE tasks SET execution_claim_expires_at = ? WHERE id = 'c_prog_live'").run(NOW + 60_000)
  h.sqlite.prepare("UPDATE tasks SET execution_receipt_id = 'r3', execution_claim_expires_at = ? WHERE id = 'c_prog_expired'").run(NOW - 1)
  h.sqlite.prepare("UPDATE tasks SET execution_receipt_id = 'r2' WHERE id = 'c_prog_recv'").run()
  h.sqlite.prepare(
    `INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, consumed_at)
     VALUES ('d1', ?, 'c_prog_disp', 'squad', 'agent', 'agent', 'agent', ?, NULL)`,
  ).run(TENANT, NOW_ISO)
  h.sqlite.exec("INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m1', 'm1@x.test', 'M', 'active', 'mumega')")
  h.sqlite.prepare("INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status) VALUES ('c_archived', ?, 'x', 'm1', 'open')").run(NOW_ISO)
  h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, cost_micro_usd, cost_metered, created_at, started_at, meta)
     VALUES ('f1', ?, 'agent', 'g', 'running', 100, 0, 1, ?, ?, ?)`,
  ).run(TENANT, T0, T0, JSON.stringify({
    schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: ['squad'],
    task_ids: [...Object.keys(CHILDREN), 'not_a_task'], done_when: ['d'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  }))
  h.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
     VALUES ('outsider', 'squad', 'o', 'b', 'd', 'open', 'agent', ?, ?)`,
  ).run(NOW_ISO, NOW_ISO)
})
afterEach(() => h.close())

const task = (id: string) => h.sqlite.prepare('SELECT status, result, assignee_agent_id AS a FROM tasks WHERE id = ?').get(id) as
  { status: string; result: string | null; a: string | null }
const flightStatus = () => (h.sqlite.prepare("SELECT status FROM flights WHERE id='f1'").get() as { status: string }).status
const audit = () => h.sqlite.prepare(
  "SELECT operation, task_id, evidence_json FROM mutation_audit_entries WHERE flight_id = 'f1' AND operation LIKE 'flight_child_task_%' ORDER BY task_id",
).all() as { operation: string; task_id: string; evidence_json: string }[]

function expectDispositions(reason: string) {
  const blocked = ['c_open', 'c_prog_free', 'c_prog_expired']
  for (const id of blocked) {
    expect(task(id), id).toMatchObject({ status: 'blocked', a: 'agent' })
    expect(task(id).result).toContain(reason)
    expect(task(id).result).toContain('f1')
  }
  for (const id of ['c_prog_live', 'c_prog_recv', 'c_prog_disp']) expect(task(id), id).toMatchObject({ status: 'in_progress', result: null })
  for (const [id, s] of [['c_done', 'done'], ['c_review', 'review'], ['c_approved', 'approved'], ['c_rejected', 'rejected'], ['c_blocked', 'blocked'], ['c_archived', 'open'], ['outsider', 'open']]) {
    expect(task(id), id).toMatchObject({ status: s, result: null })
  }
  const rows = audit()
  expect(rows.map((r) => [r.task_id, r.operation])).toEqual([
    ['c_open', 'flight_child_task_blocked'],
    ['c_prog_disp', 'flight_child_task_left_running'],
    ['c_prog_expired', 'flight_child_task_blocked'],
    ['c_prog_free', 'flight_child_task_blocked'],
    ['c_prog_live', 'flight_child_task_left_running'],
    ['c_prog_recv', 'flight_child_task_left_running'],
  ])
  expect(JSON.parse(rows[0]!.evidence_json)).toMatchObject({ from_status: 'open', disposition: 'blocked', reason })
  expect(JSON.parse(rows[3]!.evidence_json)).toMatchObject({ from_status: 'in_progress', disposition: 'blocked' })
}

describe('cancelFlight child tasks', () => {
  it('fences each disposition and records it in the receipt payload', async () => {
    const res = await cancelFlight(env, 'f1', LEAD, 'stop', NOW)
    expect(res).toMatchObject({ transitioned: true, receipt: true, child_tasks_blocked: 3 })
    expect(flightStatus()).toBe('failed')
    expectDispositions('flight_cancelled')
    const payload = JSON.parse((h.sqlite.prepare("SELECT payload FROM flight_cancel_receipts WHERE flight_id='f1'").get() as { payload: string }).payload)
    expect(payload.child_tasks).toHaveLength(6)
    expect(payload.child_tasks.filter((c: { disposition: string }) => c.disposition === 'left_running').map((c: { task_id: string }) => c.task_id).sort())
      .toEqual(['c_prog_disp', 'c_prog_live', 'c_prog_recv'])
  })

  it('a concurrent status change after the read is not overwritten', async () => {
    const p = cancelFlight(env, 'f1', LEAD, 'race', NOW)
    h.sqlite.exec("UPDATE tasks SET status = 'in_progress', execution_receipt_id = 'rx', execution_claim_expires_at = " + (NOW + 60_000) + " WHERE id = 'c_open'")
    h.sqlite.exec("UPDATE tasks SET status = 'review' WHERE id = 'c_prog_free'")
    await p
    expect(task('c_open')).toMatchObject({ status: 'in_progress', result: null })
    expect(task('c_prog_free')).toMatchObject({ status: 'review', result: null })
    expect(audit().map((r) => r.task_id)).not.toContain('c_prog_free')
    expect(audit().find((r) => r.task_id === 'c_open')?.operation).toBe('flight_child_task_left_running')
  })

  it('appends the reason to an existing result instead of replacing it', async () => {
    h.sqlite.exec("UPDATE tasks SET result = 'Artifact: x SHA256: abc' WHERE id = 'c_open'")
    await cancelFlight(env, 'f1', LEAD, 'stop', NOW)
    const r = task('c_open').result ?? ''
    expect(r.startsWith('Artifact: x SHA256: abc\n')).toBe(true)
    expect(r).toContain('flight_cancelled')
  })

  it('a lost flight race leaves every child untouched', async () => {
    const p = cancelFlight(env, 'f1', LEAD, 'race', NOW)
    h.sqlite.exec("UPDATE flights SET status = 'landed' WHERE id = 'f1'")
    expect(await p).toMatchObject({ transitioned: false })
    expect(task('c_open').status).toBe('open')
    expect(task('c_prog_free').status).toBe('in_progress')
    expect(audit()).toEqual([])
  })

  it('is atomic with the receipt: a failing child write rolls back the flight and receipt', async () => {
    h.sqlite.exec(`CREATE TRIGGER boom BEFORE UPDATE OF status ON tasks WHEN NEW.status = 'blocked' AND NEW.id = 'c_prog_free'
      BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    await expect(cancelFlight(env, 'f1', LEAD, 'x', NOW)).rejects.toThrow()
    expect(flightStatus()).toBe('running')
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM flight_cancel_receipts").get()).toEqual({ n: 0 })
    expect(task('c_open').status).toBe('open')
    expect(audit()).toEqual([])
  })
})

describe('reapStalledFlight child tasks', () => {
  it('fences each disposition and folds it into the reap receipt', async () => {
    const res = await reapStalledFlight(env, 'f1', WATCHDOG, 'executor timed out', NOW)
    expect(res).toMatchObject({ transitioned: true, receipt: true })
    expect(flightStatus()).toBe('failed')
    expectDispositions('flight_reaped')
    const payload = JSON.parse((h.sqlite.prepare("SELECT payload FROM flight_reap_receipts WHERE flight_id='f1'").get() as { payload: string }).payload)
    expect(payload.child_tasks).toHaveLength(6)
  })

  it('a concurrent status change after the read is not overwritten', async () => {
    const p = reapStalledFlight(env, 'f1', WATCHDOG, 'race', NOW)
    h.sqlite.exec("UPDATE tasks SET status = 'in_progress', execution_receipt_id = 'rx', execution_claim_expires_at = " + (NOW + 60_000) + " WHERE id = 'c_open'")
    h.sqlite.exec("UPDATE tasks SET status = 'done' WHERE id = 'c_prog_free'")
    await p
    expect(task('c_open').status).toBe('in_progress')
    expect(task('c_prog_free').status).toBe('done')
  })

  it('a lost flight race leaves every child untouched', async () => {
    const p = reapStalledFlight(env, 'f1', WATCHDOG, 'race', NOW)
    h.sqlite.exec("UPDATE flights SET status = 'landed' WHERE id = 'f1'")
    expect(await p).toMatchObject({ transitioned: false })
    expect(task('c_open').status).toBe('open')
    expect(task('c_prog_free').status).toBe('in_progress')
    expect(audit()).toEqual([])
  })
})
