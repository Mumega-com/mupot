// #1746 P1: flight_cancel must never claim effect cancellation while a routine action is running.
// Real schema (applyAllMigrations) + real MCP handler; parity-checked against cancelRoutineRun.
import { describe, expect, it } from 'vitest'

import { invokeTool } from '../src/mcp'
import { cancelFlight } from '../src/flight/watchdog'
import { cancelRoutineRun } from '../src/routines/actions'
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

describe('#1746 flight_cancel vs a running routine action', () => {
  it('(a) running action: no cancelled:true, run/action/event match cancelRoutineRun unconfirmed outcome', async () => {
    const { h, env } = fixture('running')
    const r = await cancel(env)
    expect(r, JSON.stringify(r)).toMatchObject({
      ok: true,
      result: { cancelled: false, flight_closed: true, cancellation: 'unconfirmed', receipt: true },
    })
    expect(h.sqlite.prepare("SELECT status FROM flights WHERE id='f1'").get()).toEqual({ status: 'failed' })
    const got = snap(h)

    const ref = fixture('running')
    const out = await cancelRoutineRun(ref.env, {
      tenant: TENANT, actor_type: 'member', actor_id: 'm-admin', workspace_admin: true, grants: [],
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    }, 'run-r')
    expect(out).toMatchObject({ ok: true, outcome: 'unconfirmed' })
    const want = snap(ref.h)
    expect(got.run).toMatchObject({ status: 'failed', result_summary: 'cancellation_unconfirmed', fin: 1 })
    expect(got).toEqual({ ...want, events: want.events.filter((e) => (e as { kind: string }).kind === 'cancellation_unconfirmed') })
    expect(got.events).toEqual([{ kind: 'cancellation_unconfirmed' }])
  })

  it('(b) no running action: existing behaviour unchanged (run cancelled, cancelled:true)', async () => {
    for (const a of [null, 'pending', 'succeeded']) {
      const { h, env } = fixture(a)
      const r = await cancel(env)
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true, result: { cancelled: true, flight_closed: true, receipt: true } })
      expect((r as { result: Record<string, unknown> }).result).not.toHaveProperty('cancellation')
      const s = snap(h)
      expect(s.run).toMatchObject({ status: 'cancelled', result_summary: 'cancelled_by_lead: stop' })
      expect(s.events).toEqual([])
      if (a) expect(s.action).toEqual({ status: a })
    }
  })

  it('(c) race: action flips to running between the read and the write -> guard holds', async () => {
    const { h, env } = fixture('pending')
    const p = cancelFlight(env, 'f1', { actor: { kind: 'member', id: 'm-lead' }, isOrgAdmin: true }, 'race')
    h.sqlite.exec("UPDATE routine_run_actions SET status = 'running' WHERE id = 'act-1'")
    const res = await p
    expect(res).toMatchObject({ transitioned: true, routine_outcome: 'unconfirmed' })
    expect(snap(h).run).toMatchObject({ status: 'failed', result_summary: 'cancellation_unconfirmed' })
    expect(snap(h).events).toEqual([{ kind: 'cancellation_unconfirmed' }])
  })
})
