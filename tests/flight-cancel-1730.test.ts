// #1730 — lead/admin flight_cancel, real schema (applyAllMigrations) + real MCP handler.
import { describe, expect, it } from 'vitest'

import { invokeTool } from '../src/mcp'
import { landGovernedFlight } from '../src/flight/service'
import { cancelFlight } from '../src/flight/watchdog'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'

function meta() {
  const parsed = parseFlightMetaV1({
    schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o',
    squad_ids: ['squad-core'], task_ids: ['t1'], done_when: ['d'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  })
  if (!parsed) throw new Error('meta')
  return parsed
}

function auth(member: string, caps: AuthContext['capabilities'], boundAgentId: string | null = null): AuthContext {
  return { userId: member, memberId: member, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId, capabilities: caps }
}
const lead = () => auth('m-lead', [{ member_id: 'm-lead', scope_type: 'squad', scope_id: 'squad-core', capability: 'lead' }])
const admin = () => auth('m-admin', [{ member_id: 'm-admin', scope_type: 'org', scope_id: null, capability: 'admin' }])
const plain = () => auth('m-plain', [{ member_id: 'm-plain', scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }], 'agent-other')

function fixture(status = 'running', metered = 1) {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a','dept-a','A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core','dept-a','squad-core','Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-1','squad-core','agent-1','One','operator','test','active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-other','squad-core','agent-other','Other','operator','test','active');
    INSERT INTO tasks (id, squad_id, title, status) VALUES ('t1','squad-core','t','done');
  `)
  h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, cost_metered, created_at, started_at)
     VALUES ('f1', ?, 'agent-1', 'g', ?, 100, ?, ?, ?, ?)`,
  ).run(TENANT, status, JSON.stringify(meta()), metered, Date.now(), Date.now())
  const env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  return { h, env }
}
const cancel = (env: Env, who: AuthContext, args: Record<string, unknown> = { flight_id: 'f1', reason: 'Hadi directed close' }) =>
  invokeTool(who, env, 'flight_cancel', args, ORIGIN)
const row = (h: ReturnType<typeof fixture>['h']) =>
  h.sqlite.prepare("SELECT status, gate_reason, cost_micro_usd AS c, cost_metered AS m FROM flights WHERE id='f1'").get()

describe('#1730 flight_cancel', () => {
  it.each(['running', 'waiting', 'sleeping', 'preflight'])('lead cancels a %s flight: terminal + receipt, tasks untouched', async (st) => {
    const { h, env } = fixture(st)
    const r = await cancel(env, lead())
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, result: { cancelled: true, previous_status: st, receipt: true, cost_metered: true } })
    expect(row(h)).toMatchObject({ status: 'failed', gate_reason: 'cancelled_by_lead: Hadi directed close', c: 0 })
    const rc = h.sqlite.prepare("SELECT previous_status, actor_kind, actor_id, cancel_reason, cost_metered FROM flight_cancel_receipts WHERE flight_id='f1'").all()
    expect(rc).toEqual([{ previous_status: st, actor_kind: 'member', actor_id: 'm-lead', cancel_reason: 'Hadi directed close', cost_metered: 1 }])
    expect(h.sqlite.prepare("SELECT status FROM tasks WHERE id='t1'").get()).toEqual({ status: 'done' })
  })

  it('non-lead -> 403, nothing written', async () => {
    const { h, env } = fixture()
    expect(await cancel(env, plain())).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(row(h)).toMatchObject({ status: 'running' })
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM flight_cancel_receipts').get()).toEqual({ n: 0 })
  })

  it.each(['landed', 'failed', 'held'])('terminal %s -> 409 flight_already_terminal', async (st) => {
    const { h, env } = fixture(st)
    expect(await cancel(env, lead())).toMatchObject({ ok: false, status: 409, error: 'flight_already_terminal' })
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM flight_cancel_receipts').get()).toEqual({ n: 0 })
  })

  it('reason bounds: empty and >500 refused', async () => {
    const { env } = fixture()
    expect(await cancel(env, lead(), { flight_id: 'f1', reason: '' })).toMatchObject({ ok: false, status: 400 })
    expect(await cancel(env, lead(), { flight_id: 'f1', reason: 'x'.repeat(501) })).toMatchObject({ ok: false, status: 400 })
  })

  it('unmetered flight stays unmetered, cost untouched, receipt says so', async () => {
    const { h, env } = fixture('running', 0)
    const r = await cancel(env, lead())
    expect(r).toMatchObject({ ok: true, result: { cost_metered: false } })
    expect(row(h)).toMatchObject({ status: 'failed', c: 0, m: 0 })
    expect(h.sqlite.prepare("SELECT cost_metered AS m FROM flight_cancel_receipts").get()).toEqual({ m: 0 })
  })

  it('race: cancel vs land - exactly one wins, loser leaves no trace', async () => {
    const { h, env } = fixture()
    const principal = { actor: { kind: 'member' as const, id: 'm-lead' }, isOrgAdmin: true }
    const [c, l] = await Promise.all([
      cancelFlight(env, 'f1', principal, 'race'),
      landGovernedFlight(env, 'f1', { meta: meta(), expected_agent: 'agent-1', agent_id: 'agent-1', actor: { kind: 'agent', id: 'agent-1' }, cost_micro_usd: 1 }),
    ])
    const status = (row(h) as { status: string }).status
    const receipts = (h.sqlite.prepare('SELECT count(*) AS n FROM flight_cancel_receipts').get() as { n: number }).n
    expect(Number(c.transitioned) + Number(l.transitioned)).toBe(1)
    if (c.transitioned) { expect(status).toBe('failed'); expect(receipts).toBe(1) }
    else { expect(status).toBe('landed'); expect(receipts).toBe(0) }
  })

  it('race: two concurrent cancels - exactly one wins, one receipt', async () => {
    const { h, env } = fixture()
    const principal = { actor: { kind: 'member' as const, id: 'm-lead' }, isOrgAdmin: true }
    const rs = await Promise.all([cancelFlight(env, 'f1', principal, 'a'), cancelFlight(env, 'f1', principal, 'b')])
    expect(rs.filter((x) => x.transitioned)).toHaveLength(1)
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM flight_cancel_receipts').get()).toEqual({ n: 1 })
  })

  it('org admin cancels with the cancelled_by_admin label', async () => {
    const { h, env } = fixture()
    expect(await cancel(env, admin())).toMatchObject({ ok: true, result: { cancelled: true } })
    expect(row(h)).toMatchObject({ status: 'failed', gate_reason: 'cancelled_by_admin: Hadi directed close' })
  })

  it('the flight\'s own flying agent gets 403 (no escape hatch), even holding member on the squad', async () => {
    const { h, env } = fixture()
    const own = auth('m-exec', [{ member_id: 'm-exec', scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }], 'agent-1')
    expect(await cancel(env, own)).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(JSON.stringify(await cancel(env, own))).toContain('squad:lead or org:admin')
    expect(row(h)).toMatchObject({ status: 'running' })
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM flight_cancel_receipts').get()).toEqual({ n: 0 })
  })

  it('the dispatcher agent gets 403', async () => {
    const { h, env } = fixture()
    h.sqlite.exec("UPDATE flights SET dispatched_by_agent_id = 'agent-other' WHERE id = 'f1'")
    expect(await cancel(env, plain())).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(row(h)).toMatchObject({ status: 'running' })
  })

  it('a lead of a DIFFERENT squad gets 403', async () => {
    const { env } = fixture()
    const other = auth('m-x', [{ member_id: 'm-x', scope_type: 'squad', scope_id: 'squad-zzz', capability: 'lead' }])
    expect(await cancel(env, other)).toMatchObject({ ok: false, status: 403 })
  })

  function routineFixture(h: ReturnType<typeof fixture>['h']) {
    const t = '2026-01-01T00:00:00.000Z'
    h.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('project-r','project-r','R','active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-r','squad-core','write');
      INSERT INTO routines (id, tenant, project_id, name, objective, status, trigger_kind, run_once_at,
        cron_expression, timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
        budget_micro_usd, max_attempts, retry_backoff_seconds, max_occurrences, revision, enabled_by,
        enabled_at, created_by, created_at, updated_at)
      VALUES ('routine-r','${TENANT}','project-r','routine-r','o','enabled','cron',NULL,'* * * * *','UTC','${t}',
        'skip','propose','squad-core',100000,3,300,NULL,1,'o','${t}','o','${t}','${t}');
      INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, attempt, flight_id, created_at, updated_at)
      VALUES ('run-r','${TENANT}','project-r','routine-r',1,'{}','manual:run-r','cron','${t}','running',1,'f1','${t}','${t}');
    `)
  }
  const runRow = (h: ReturnType<typeof fixture>['h']) =>
    h.sqlite.prepare("SELECT status, result_summary, finished_at FROM routine_runs WHERE id='run-r'").get() as { status: string; result_summary: string; finished_at: string | null }

  it('cancelling a routine control flight moves its run to cancelled (terminal, not failed)', async () => {
    const { h, env } = fixture()
    routineFixture(h)
    expect(await cancel(env, lead())).toMatchObject({ ok: true })
    const r = runRow(h)
    expect(r.status).toBe('cancelled')
    expect(r.result_summary).toBe('cancelled_by_lead: Hadi directed close')
    expect(r.finished_at).not.toBeNull()
  })

  it('stale read: flight moved after the read -> no transition, no receipt, routine run untouched, no false previous_status', async () => {
    const { h, env } = fixture('running')
    routineFixture(h)
    const principal = { actor: { kind: 'member' as const, id: 'm-lead' }, isOrgAdmin: true }
    const p = cancelFlight(env, 'f1', principal, 'stale')
    h.sqlite.exec("UPDATE flights SET status = 'sleeping' WHERE id = 'f1'")
    const res = await p
    expect(res.transitioned).toBe(false)
    expect(row(h)).toMatchObject({ status: 'sleeping' })
    expect(h.sqlite.prepare('SELECT count(*) AS n FROM flight_cancel_receipts').get()).toEqual({ n: 0 })
    expect(runRow(h).status).toBe('running')
  })
})
