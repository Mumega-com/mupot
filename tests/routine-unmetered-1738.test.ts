// mupot#1738 — writers must honour the unmetered flag. Real schema (all migrations).
import { afterEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { landGovernedFlight } from '../src/flight/service'
import { parseFlightMetaV1 } from '../src/flight/meta'
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

function receipt(f: ReadyRoutineFixture): Record<string, unknown> {
  const r = f.harness.sqlite.prepare("SELECT payload FROM flight_event_outbox WHERE flight_id='control-flight' AND event_type='flight.landed'").get() as { payload: string } | undefined
  if (!r) throw new Error('no landing receipt')
  return JSON.parse(r.payload) as Record<string, unknown>
}

const usage = { run_id: 'run-1', model: 'deepseek-v4-flash', input: 1_000_000, output: 1_000_000 }

describe('#1738 unmetered writers', () => {
  let fixture: ReadyRoutineFixture | undefined
  afterEach(() => { fixture?.harness.close(); fixture = undefined })

  it('report_run_usage on an unmetered flight flips it to metered and fixes the outbox payload', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    fixture.harness.sqlite.exec(`
      UPDATE flights SET cost_metered = 0 WHERE id = 'control-flight';
      INSERT INTO flight_event_outbox (id, tenant, flight_id, event_type, actor_kind, actor_id, payload, created_at)
      VALUES ('ob-1', 'tenant-a', 'control-flight', 'flight.landed', 'agent', 'agent-1',
              '{"cost_micro_usd":null,"cost_metered":false,"budget_compliance":"unknown"}', '2026-07-19T16:00:00.000Z');
    `)
    const out = await invokeTool(agentPrincipal(), fixture.env, 'report_run_usage', usage, 'https://pot.test')
    expect(out).toMatchObject({ ok: true, result: { cost_micro_usd: 420_000 } })
    expect(row(fixture, "SELECT cost_micro_usd AS c, cost_metered AS m FROM flights WHERE id='control-flight'"))
      .toEqual({ c: 420_000, m: 1 })
    const payload = JSON.parse((row(fixture, "SELECT payload FROM flight_event_outbox WHERE id='ob-1'") as { payload: string }).payload)
    expect(payload).toMatchObject({ cost_micro_usd: 420_000, cost_metered: true })
  })

  it('landing with no cost claim does not erase usage already reported by report_run_usage', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    await invokeTool(agentPrincipal(), fixture.env, 'report_run_usage', usage, 'https://pot.test')
    // Drop the routine witness so this exercises the plain (REST/MCP-style) landing path.
    fixture.harness.sqlite.exec("UPDATE flights SET meta = json_remove(meta, '$.routine_run_id', '$.routine_revision') WHERE id='control-flight'")
    const meta = parseFlightMetaV1(JSON.parse((row(fixture, "SELECT meta FROM flights WHERE id='control-flight'") as { meta: string }).meta))
    if (!meta) throw new Error('meta')
    fixture.harness.sqlite.exec("UPDATE tasks SET status = 'done' WHERE id = 'control-task'")
    const landed = await landGovernedFlight(fixture.env, 'control-flight', {
      cost_micro_usd: 0, expected_agent: 'agent-1', agent_id: 'agent-1', meta,
      actor: { kind: 'agent', id: 'agent-1' },
    })
    expect(landed.transitioned).toBe(true)
    expect(row(fixture, "SELECT status, cost_micro_usd AS c, cost_metered AS m FROM flights WHERE id='control-flight'"))
      .toEqual({ status: 'landed', c: 420_000, m: 1 })
    // #1738 gate: the receipt states the stored row, not the 0 the caller claimed.
    expect(receipt(fixture)).toMatchObject({ cost_micro_usd: 420_000, cost_metered: true, budget_compliance: 'over_budget' })
  })

  it('an unmetered landing claim does not mark an already-reported (metered) cost unmetered', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    await invokeTool(agentPrincipal(), fixture.env, 'report_run_usage', usage, 'https://pot.test')
    fixture.harness.sqlite.exec("UPDATE flights SET meta = json_remove(meta, '$.routine_run_id', '$.routine_revision') WHERE id='control-flight'")
    const meta = parseFlightMetaV1(JSON.parse((row(fixture, "SELECT meta FROM flights WHERE id='control-flight'") as { meta: string }).meta))
    if (!meta) throw new Error('meta')
    fixture.harness.sqlite.exec("UPDATE tasks SET status = 'done' WHERE id = 'control-task'")
    await landGovernedFlight(fixture.env, 'control-flight', {
      cost_micro_usd: 0, cost_metered: false, expected_agent: 'agent-1', agent_id: 'agent-1', meta,
      actor: { kind: 'agent', id: 'agent-1' },
    })
    expect(row(fixture, "SELECT cost_micro_usd AS c, cost_metered AS m FROM flights WHERE id='control-flight'"))
      .toEqual({ c: 420_000, m: 1 })
    // #1738 gate: an unmetered CLAIM over a metered row must not produce an "unmetered/unknown" receipt.
    expect(receipt(fixture)).toMatchObject({ cost_micro_usd: 420_000, cost_metered: true, budget_compliance: 'over_budget' })
  })

  it('a preserved reported cost above budget is receipted over_budget, not within_budget', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    await invokeTool(agentPrincipal(), fixture.env, 'report_run_usage', usage, 'https://pot.test')
    fixture.harness.sqlite.exec("UPDATE flights SET budget_micro_usd = 100000, meta = json_remove(meta, '$.routine_run_id', '$.routine_revision') WHERE id='control-flight'")
    const meta = parseFlightMetaV1(JSON.parse((row(fixture, "SELECT meta FROM flights WHERE id='control-flight'") as { meta: string }).meta))
    if (!meta) throw new Error('meta')
    fixture.harness.sqlite.exec("UPDATE tasks SET status = 'done' WHERE id = 'control-task'")
    const landed = await landGovernedFlight(fixture.env, 'control-flight', {
      cost_micro_usd: 0, expected_agent: 'agent-1', agent_id: 'agent-1', meta,
      actor: { kind: 'agent', id: 'agent-1' },
    })
    expect(landed.transitioned).toBe(true)
    expect(receipt(fixture)).toMatchObject({ cost_micro_usd: 420_000, cost_metered: true, budget_compliance: 'over_budget' })
  })

  it('an explicit non-zero landing cost still wins (metered landings are unchanged)', async () => {
    fixture = await makeReadyRoutineFixture('execute_internal')
    await invokeTool(agentPrincipal(), fixture.env, 'report_run_usage', usage, 'https://pot.test')
    // Drop the routine witness so this exercises the plain (REST/MCP-style) landing path.
    fixture.harness.sqlite.exec("UPDATE flights SET meta = json_remove(meta, '$.routine_run_id', '$.routine_revision') WHERE id='control-flight'")
    const meta = parseFlightMetaV1(JSON.parse((row(fixture, "SELECT meta FROM flights WHERE id='control-flight'") as { meta: string }).meta))
    if (!meta) throw new Error('meta')
    fixture.harness.sqlite.exec("UPDATE tasks SET status = 'done' WHERE id = 'control-task'")
    await landGovernedFlight(fixture.env, 'control-flight', {
      cost_micro_usd: 500, expected_agent: 'agent-1', agent_id: 'agent-1', meta,
      actor: { kind: 'agent', id: 'agent-1' },
    })
    expect(row(fixture, "SELECT cost_micro_usd AS c, cost_metered AS m FROM flights WHERE id='control-flight'"))
      .toEqual({ c: 500, m: 1 })
  })
})
