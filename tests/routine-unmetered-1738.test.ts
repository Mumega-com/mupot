// mupot#1738 — unknown (unmetered) flight cost must be honoured by every writer and aggregate
// that feeds routine budget enforcement. Real schema (all migrations), no hand-written DDL.
import { afterEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { submitRoutineProposal } from '../src/routines/actions'
import { getRoutineRun } from '../src/routines/service'
import { publicRoutineRun } from '../src/routines/public'
import type { AuthContext, CapabilityGrant } from '../src/types'
import { makeReadyRoutineFixture, type ReadyRoutineFixture } from './helpers/routine-actions'

function row(f: ReadyRoutineFixture, sql: string): unknown {
  return f.harness.sqlite.prepare(sql).get()
}

function agentPrincipal(): AuthContext {
  const grant: CapabilityGrant = { member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }
  return {
    id: { memberId: 'member-1', displayName: 'Agent One', email: null },
    tenant: 'tenant-a', channel: 'workspace', role: 'member', boundAgentId: 'agent-1', capabilities: [grant],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double: only fields invokeTool reads
  } as any
}

const dispatchFlight = (f: ReadyRoutineFixture, key: string) => f.proposal({
  key, kind: 'dispatch_flight',
  input: { goal: 'Go', task_ids: ['control-task'], artifact_refs: [], budget_micro_usd: 1000 },
})

describe('#1738 unmetered aggregates', () => {
  let fixture: ReadyRoutineFixture | undefined
  afterEach(() => { fixture?.harness.close(); fixture = undefined })

  it('metered run: dispatch_flight proposal is accepted as before (budget unchanged)', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    const r = await submitRoutineProposal(fixture.env, fixture.principal, dispatchFlight(fixture, 'f-metered'))
    expect(r).not.toMatchObject({ error: 'budget_unknown_unmetered' })
    expect(r).not.toMatchObject({ error: 'budget_exceeded' })
  })

  it('all-unmetered run: dispatch_flight is refused budget_unknown_unmetered (not treated as 0 spend)', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    fixture.harness.sqlite.exec("UPDATE flights SET cost_metered = 0 WHERE id = 'control-flight'")
    const r = await submitRoutineProposal(fixture.env, fixture.principal, dispatchFlight(fixture, 'f-unmetered'))
    expect(r).toEqual({ ok: false, error: 'budget_unknown_unmetered' })
  })

  it('mixed metered + unmetered: refused (unknown, not the metered partial sum)', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    fixture.harness.sqlite.exec(`
      UPDATE flights SET cost_micro_usd = 5 WHERE id = 'control-flight';
      INSERT INTO flights (id, tenant, project_id, agent, goal, status, budget_micro_usd, cost_micro_usd,
        cost_metered, created_at, started_at, meta)
      VALUES ('extra-unmetered', 'tenant-a', 'project-1', 'agent-1', 'g', 'landed', 1000, 0, 0, 1, 1, '{}');
      INSERT INTO routine_run_refs (id, tenant, project_id, run_id, ref_type, ref_id, relation)
      VALUES ('ref-extra', 'tenant-a', 'project-1', 'run-1', 'flight', 'extra-unmetered', 'action_result');
    `)
    const r = await submitRoutineProposal(fixture.env, fixture.principal, dispatchFlight(fixture, 'f-mixed'))
    expect(r).toEqual({ ok: false, error: 'budget_unknown_unmetered' })
  })

  it('public run DTO shows unknown cost (null + cost_metered:false), never 0, for an unmetered run; metered shows the sum', async () => {
    fixture = await makeReadyRoutineFixture('propose')
    fixture.harness.sqlite.exec("UPDATE routine_runs SET cost_micro_usd = 7 WHERE id = 'run-1'")
    const principal = { ...fixture.principal, workspace_admin: true }
    const metered = await getRoutineRun(fixture.env, principal, 'run-1')
    expect(metered && publicRoutineRun(metered)).toMatchObject({ cost_micro_usd: 7, cost_metered: true })

    fixture.harness.sqlite.exec("UPDATE flights SET cost_metered = 0 WHERE id = 'control-flight'")
    const unknown = await getRoutineRun(fixture.env, principal, 'run-1')
    expect(unknown && publicRoutineRun(unknown)).toMatchObject({ cost_micro_usd: null, cost_metered: false })
  })

  it('report_run_usage on an unmetered flight flips it to metered, fixes the outbox, and readers show the cost', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    fixture.harness.sqlite.exec("UPDATE flights SET cost_metered = 0 WHERE id = 'control-flight'")
    fixture.harness.sqlite.exec(`
      INSERT INTO flight_event_outbox (id, tenant, flight_id, event_type, actor_kind, actor_id, payload, created_at)
      VALUES ('ob-1', 'tenant-a', 'control-flight', 'flight.landed', 'agent', 'agent-1',
              '{"cost_micro_usd":null,"cost_metered":false,"budget_compliance":"unknown"}', '2026-07-19T16:00:00.000Z');
    `)
    const out = await invokeTool(agentPrincipal(), fixture.env, 'report_run_usage',
      { run_id: 'run-1', model: 'deepseek-v4-flash', input: 1_000_000, output: 1_000_000 }, 'https://pot.test')
    expect(out).toMatchObject({ ok: true, result: { cost_micro_usd: 420_000 } })

    expect(row(fixture, "SELECT cost_micro_usd AS c, cost_metered AS m FROM flights WHERE id='control-flight'"))
      .toEqual({ c: 420_000, m: 1 })
    const payload = JSON.parse((row(fixture, "SELECT payload FROM flight_event_outbox WHERE id='ob-1'") as { payload: string }).payload)
    expect(payload).toMatchObject({ cost_micro_usd: 420_000, cost_metered: true })
    const run = await getRoutineRun(fixture.env, { ...fixture.principal, workspace_admin: true }, 'run-1')
    expect(run && publicRoutineRun(run)).toMatchObject({ cost_micro_usd: 420_000, cost_metered: true })
  })

  it('landControlFlight lands the control flight UNMETERED (its 0 was never measured)', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    const r = await submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'none-1', kind: 'no_action', input: { reason: 'No accountable action is currently available.' },
    }))
    expect(r).toMatchObject({ ok: true, status: 'succeeded' })
    expect(row(fixture, "SELECT status, cost_micro_usd AS c, cost_metered AS m FROM flights WHERE id='control-flight'"))
      .toEqual({ status: 'landed', c: 0, m: 0 })
    const payload = JSON.parse((row(fixture, "SELECT payload FROM flight_event_outbox WHERE flight_id='control-flight'") as { payload: string }).payload)
    expect(payload).toMatchObject({ cost_micro_usd: null, cost_metered: false })
    const run = await getRoutineRun(fixture.env, { ...fixture.principal, workspace_admin: true }, 'run-1')
    expect(run && publicRoutineRun(run)).toMatchObject({ cost_micro_usd: null, cost_metered: false })
  })
})
