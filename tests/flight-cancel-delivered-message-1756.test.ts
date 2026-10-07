// #1756: flight_cancel vs a DELIVERED inbox message; receipt routine_outcome; readers label unconfirmed.
// Real schema (applyAllMigrations) + real MCP handler; parity-checked against cancelRoutineRun.
import { describe, expect, it } from 'vitest'

import { invokeTool } from '../src/mcp'
import { cancelFlight } from '../src/flight/watchdog'
import { cancelRoutineRun } from '../src/routines/actions'
import { cancelledColumnSql, genuinelyFailedFlightSql, isCancelUnconfirmed, isCancelledFlight } from '../src/flight/cancelled'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'
const T = '2026-01-01T00:00:00.000Z'

function meta() {
  const parsed = parseFlightMetaV1({
    schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o',
    squad_ids: ['squad-core'], task_ids: ['t1'], done_when: ['d'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  })
  if (!parsed) throw new Error('meta')
  return parsed
}

const lead: AuthContext = {
  userId: 'm-lead', memberId: 'm-lead', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  boundAgentId: null, capabilities: [{ member_id: 'm-lead', scope_type: 'squad', scope_id: 'squad-core', capability: 'lead' }],
}

function fixture(actionStatus: string | null) {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a','dept-a','A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core','dept-a','squad-core','Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-1','squad-core','agent-1','One','operator','test','active');
    INSERT INTO tasks (id, squad_id, title, status) VALUES ('t1','squad-core','t','done');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-r','project-r','R','active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-r','squad-core','write');
    INSERT INTO routines (id, tenant, project_id, name, objective, status, trigger_kind, run_once_at,
      cron_expression, timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
      budget_micro_usd, max_attempts, retry_backoff_seconds, max_occurrences, revision, enabled_by,
      enabled_at, created_by, created_at, updated_at)
    VALUES ('routine-r','${TENANT}','project-r','routine-r','o','enabled','cron',NULL,'* * * * *','UTC','${T}',
      'skip','propose','squad-core',100000,3,300,NULL,1,'o','${T}','o','${T}','${T}');
  `)
  h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, cost_metered, created_at, started_at)
     VALUES ('f1', ?, 'agent-1', 'g', 'running', 100, ?, 1, ?, ?)`,
  ).run(TENANT, JSON.stringify(meta()), Date.now(), Date.now())
  h.sqlite.exec(`
    INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
      trigger_kind, scheduled_for, status, attempt, flight_id, created_at, updated_at)
    VALUES ('run-r','${TENANT}','project-r','routine-r',1,'{}','manual:run-r','cron','${T}','running',1,'f1','${T}','${T}');
  `)
  if (actionStatus) addAction(h, actionStatus)
  return { h, env: { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env }
}
function addAction(h: ReturnType<typeof fixture>['h'], status: string) {
  h.sqlite.prepare(
    `INSERT INTO routine_run_actions (id, tenant, project_id, run_id, action_key, kind, input_json, status)
     VALUES ('act-1', ?, 'project-r', 'run-r', 'k1', 'create_task', '{}', ?)`,
  ).run(TENANT, status)
}
const snap = (h: ReturnType<typeof fixture>['h']) => ({
  run: h.sqlite.prepare("SELECT status, result_summary, finished_at IS NOT NULL AS fin FROM routine_runs WHERE id='run-r'").get(),
  action: h.sqlite.prepare("SELECT status FROM routine_run_actions WHERE id='act-1'").get(),
  events: h.sqlite.prepare("SELECT kind FROM routine_run_events WHERE run_id='run-r' AND kind LIKE 'cancellation_%' ORDER BY kind").all(),
})
const cancel = (env: Env) => invokeTool(lead, env, 'flight_cancel', { flight_id: 'f1', reason: 'stop' }, ORIGIN)


function addMessage(h: ReturnType<typeof fixture>['h'], requestId: string, project = 'project-r') {
  h.sqlite.prepare(
    `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, project_id)
     VALUES ('msg-1', ?, 'agent-1', 'mupot-routines', 'system:routines', 'request', 'do it', ?, ?)`,
  ).run(TENANT, requestId, project)
}
const receipt = (h: ReturnType<typeof fixture>['h']) =>
  JSON.parse((h.sqlite.prepare("SELECT payload FROM flight_cancel_receipts WHERE flight_id='f1'").get() as { payload: string }).payload) as Record<string, unknown>

describe('#1756 flight_cancel vs a delivered inbox message', () => {
  for (const rid of ['routine-run:run-r', 'routine-run:run-r:attempt:1']) {
    it(`(a) delivered message (${rid}), no running action: unconfirmed, rows match cancelRoutineRun`, async () => {
      const { h, env } = fixture(null)
      addMessage(h, rid)
      const r = await cancel(env)
      expect(r, JSON.stringify(r)).toMatchObject({
        ok: true,
        result: { cancelled: false, flight_closed: true, cancellation: 'unconfirmed', reason: 'routine_effect_may_be_in_flight', receipt: true },
      })
      const got = snap(h)

      const ref = fixture(null)
      addMessage(ref.h, rid)
      const out = await cancelRoutineRun(ref.env, {
        tenant: TENANT, actor_type: 'member', actor_id: 'm-admin', workspace_admin: true, grants: [],
        project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
      }, 'run-r')
      expect(out).toMatchObject({ ok: true, outcome: 'unconfirmed' })
      const want = snap(ref.h)
      expect(got.run).toMatchObject({ status: 'failed', result_summary: 'cancellation_unconfirmed', fin: 1 })
      expect(got.run).toEqual(want.run)
      expect(got.events).toEqual([{ kind: 'cancellation_unconfirmed' }])
    })
  }

  it('(a2) a message for another run / project / sender does not trip the predicate', async () => {
    const { h, env } = fixture(null)
    addMessage(h, 'routine-run:run-rX')
    h.sqlite.prepare("INSERT INTO projects (id, slug, name, status) VALUES ('project-o','project-o','O','active')").run()
    h.sqlite.prepare(
      `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, project_id)
       VALUES ('msg-2', ?, 'agent-1', 'mupot-routines', 'system:routines', 'request', 'x', 'routine-run:run-r', 'project-o')`,
    ).run(TENANT)
    h.sqlite.prepare(
      `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, project_id)
       VALUES ('msg-3', ?, 'agent-1', 'someone-else', 'm', 'request', 'x', 'routine-run:run-r', 'project-r')`,
    ).run(TENANT)
    const r = await cancel(env)
    expect(r).toMatchObject({ ok: true, result: { cancelled: true, flight_closed: true } })
  })

  it('(b) no message, no running action: confirmed, unchanged', async () => {
    const { h, env } = fixture(null)
    const r = await cancel(env)
    expect(r).toMatchObject({ ok: true, result: { cancelled: true, flight_closed: true, receipt: true } })
    expect(snap(h).run).toMatchObject({ status: 'cancelled' })
  })

  it('(c) receipt payload records routine_outcome for each branch', async () => {
    const a = fixture(null); addMessage(a.h, 'routine-run:run-r'); await cancel(a.env)
    expect(receipt(a.h)).toMatchObject({ routine_outcome: 'unconfirmed', self_cancel: false })
    const b = fixture('running'); await cancel(b.env)
    expect(receipt(b.h)).toMatchObject({ routine_outcome: 'unconfirmed' })
    const c = fixture(null); await cancel(c.env)
    expect(receipt(c.h)).toMatchObject({ routine_outcome: 'confirmed' })
    const d = fixture(null)
    d.h.sqlite.exec("UPDATE routine_runs SET status = 'succeeded' WHERE id = 'run-r'")
    await cancel(d.env)
    expect(receipt(d.h)).toMatchObject({ routine_outcome: 'none' })
  })

  it('(d) reader exposes cancel_unconfirmed, still a cancel and not a failure; missing key = none', async () => {
    const u = fixture(null); addMessage(u.h, 'routine-run:run-r'); await cancel(u.env)
    const c = fixture(null); await cancel(c.env)
    const read = (h: ReturnType<typeof fixture>['h']) =>
      h.sqlite.prepare(`SELECT status, ${cancelledColumnSql('f')} FROM flights f WHERE id = 'f1'`).get() as
        { status: string; cancelled: number; cancel_unconfirmed: number }
    const ru = read(u.h)
    expect(isCancelledFlight(ru)).toBe(true)
    expect(isCancelUnconfirmed(ru)).toBe(true)
    expect(isCancelledFlight(read(c.h))).toBe(true)
    expect(isCancelUnconfirmed(read(c.h))).toBe(false)
    // legacy receipt without the key reads as 'none'
    c.h.sqlite.exec("UPDATE flight_cancel_receipts SET payload = json_remove(payload, '$.routine_outcome')")
    expect(isCancelUnconfirmed(read(c.h))).toBe(false)
    // a self-cancel is a failure, never "cancelled", so it is never labelled cancel-unconfirmed either
    u.h.sqlite.exec("UPDATE flight_cancel_receipts SET payload = json_set(payload, '$.self_cancel', json('true'))")
    expect(isCancelUnconfirmed(read(u.h))).toBe(false)
    u.h.sqlite.exec("UPDATE flight_cancel_receipts SET payload = json_set(payload, '$.self_cancel', json('false'))")
    // not a failure: the genuinely-failed predicate excludes it
    const failed = u.h.sqlite.prepare(`SELECT COUNT(*) AS n FROM flights f WHERE ${genuinelyFailedFlightSql('f')}`).get() as { n: number }
    expect(failed.n).toBe(0)
  })
})
