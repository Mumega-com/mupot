// #916 — a governed landing must write its receipt, and must never report a landed
// flight as a failed landing.
//
// The production defect: landGovernedFlight put the transition and the outbox INSERT in
// one env.DB.batch(), and the INSERT read back the row the transition had just written
// (`SELECT ... FROM flights WHERE status='landed' AND ended_at=?`). On D1 that read does
// not observe the preceding statement, so the insert matched zero rows on EVERY land —
// the flight transitioned, no receipt was written, and the function returned false.
// Callers translated that false into 409 flight_transition_conflict, i.e. they told the
// agent a successful landing had failed.
//
// This could not be caught by the existing suite: tests/helpers/sqlite-d1.ts implements
// batch() as BEGIN IMMEDIATE + sequential execute + COMMIT, and real SQLite DOES read its
// own writes inside a transaction. The helper is more transactional than the platform it
// stands in for. The first test below therefore models the platform explicitly rather
// than trusting the helper.
import { describe, expect, it } from 'vitest'

import { landGovernedFlight } from '../src/flight/service'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const FLIGHT = 'flight-916'
const TASK = 'task-916'

function meta() {
  const parsed = parseFlightMetaV1({
    schema: 'mupot.flight.meta/v1',
    goal_id: 'g', objective_id: 'o',
    squad_ids: ['squad-core'], task_ids: [TASK],
    done_when: ['done'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  })
  if (!parsed) throw new Error('fixture meta must parse as v1')
  return parsed
}

function fixture() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  // Real FKs are ON in this harness, so the squad/agent/task rows the flight references
  // have to actually exist.
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Dept A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-a', 'squad-core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-1', 'squad-core', 'agent-1', 'Agent One', 'operator', 'test', 'active');
  `)
  const env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
  harness.sqlite.exec(`
    INSERT INTO tasks (id, squad_id, title, status) VALUES ('${TASK}', 'squad-core', 'task', 'done');
  `)
  harness.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, cost_micro_usd, meta, created_at, started_at)
     VALUES (?, ?, 'agent-1', 'goal', 'running', 100000, 0, ?, ?, ?)`,
  ).run(FLIGHT, TENANT, JSON.stringify(meta()), Date.now(), Date.now())
  return { harness, env }
}

describe('#916 governed landing writes its receipt', () => {
  it('lands and writes exactly one flight.landed receipt', async () => {
    const { env } = fixture()
    const result = await landGovernedFlight(env, FLIGHT, {
      cost_micro_usd: 4200, score: 0.9,
      expected_agent: 'agent-1', agent_id: 'agent-1',
      meta: meta(), actor: { kind: 'agent', id: 'agent-1' },
    })

    expect(result).toEqual({ transitioned: true, receipt: true })

    const receipt = await env.DB.prepare(
      `SELECT payload FROM flight_event_outbox WHERE tenant=?1 AND flight_id=?2 AND event_type='flight.landed'`,
    ).bind(TENANT, FLIGHT).first<{ payload: string }>()
    expect(receipt).not.toBeNull()

    // The receipt must carry the landed numbers, not the pre-landing ones — that payload
    // is the audit record, and a receipt that says cost 0 for a 4200 flight is worse than
    // no receipt at all.
    const payload = JSON.parse(receipt!.payload) as { cost_micro_usd: number; score: number }
    expect(payload.cost_micro_usd).toBe(4200)
    expect(payload.score).toBe(0.9)
  })

  it('REGRESSION: the receipt write must not read back its own transition', async () => {
    // Model the platform, not the helper. This D1 wrapper makes any statement inside a
    // batch() observe only the state as it was BEFORE the batch began — which is what
    // production D1 did to the original implementation. Under the old batched code the
    // outbox SELECT finds nothing here and the receipt is silently lost; under the fix
    // there is nothing to lose, because the insert no longer reads back its own write.
    const { env } = fixture()
    const real = env.DB
    let batchCalls = 0
    const blindBatch = {
      prepare: (sql: string) => real.prepare(sql),
      batch: async (statements: unknown[]) => {
        batchCalls += 1
        throw new Error(
          `landGovernedFlight must not batch its transition with a read-back (#916); ` +
          `got a batch of ${statements.length} statements`,
        )
      },
    } as unknown as typeof real
    const blindEnv = { ...env, DB: blindBatch } as unknown as Env

    const result = await landGovernedFlight(blindEnv, FLIGHT, {
      cost_micro_usd: 1, score: 0.5,
      expected_agent: 'agent-1', agent_id: 'agent-1',
      meta: meta(), actor: { kind: 'agent', id: 'agent-1' },
    })

    expect(batchCalls).toBe(0)
    expect(result).toEqual({ transitioned: true, receipt: true })
  })

  it('is idempotent: a second landing attempt does not duplicate the receipt', async () => {
    const { env } = fixture()
    await landGovernedFlight(env, FLIGHT, {
      cost_micro_usd: 10, score: 1,
      expected_agent: 'agent-1', agent_id: 'agent-1',
      meta: meta(), actor: { kind: 'agent', id: 'agent-1' },
    })
    // Second attempt: the flight is no longer 'running', so the transition is refused.
    const again = await landGovernedFlight(env, FLIGHT, {
      cost_micro_usd: 10, score: 1,
      expected_agent: 'agent-1', agent_id: 'agent-1',
      meta: meta(), actor: { kind: 'agent', id: 'agent-1' },
    })
    expect(again.transitioned).toBe(false)

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM flight_event_outbox WHERE tenant=?1 AND flight_id=?2`,
    ).bind(TENANT, FLIGHT).first<{ n: number }>()
    expect(count?.n).toBe(1)
  })

  it('refuses to land while a referenced task is not done, and writes no receipt', async () => {
    const { env } = fixture()
    await env.DB.prepare(`UPDATE tasks SET status='in_progress' WHERE id=?1`).bind(TASK).run()

    const result = await landGovernedFlight(env, FLIGHT, {
      cost_micro_usd: 1, score: 1,
      expected_agent: 'agent-1', agent_id: 'agent-1',
      meta: meta(), actor: { kind: 'agent', id: 'agent-1' },
    })

    expect(result).toEqual({ transitioned: false, receipt: false })
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM flight_event_outbox WHERE tenant=?1 AND flight_id=?2`,
    ).bind(TENANT, FLIGHT).first<{ n: number }>()
    expect(count?.n).toBe(0)
    const row = await env.DB.prepare(`SELECT status FROM flights WHERE id=?1`).bind(FLIGHT).first<{ status: string }>()
    expect(row?.status).toBe('running')
  })

  it('reports receipt=false when the receipt write is lost, and still reports the landing', async () => {
    // The defect this whole issue is about was a LIE about state, not a lost row per se:
    // the code reported an outcome that did not match the database. So the fix has to be
    // honest in the failing direction too — if the receipt does not get written, the
    // caller must be told receipt=false while still being told the flight landed.
    // Without this test, "receipt = true" hard-coded passes the entire suite.
    const { harness, env } = fixture()
    const real = env.DB
    const sabotaged = {
      prepare: (sql: string) => {
        if (sql.includes('INSERT INTO flight_event_outbox')) {
          return { bind: () => ({ run: async () => { throw new Error('simulated receipt write failure') } }) } as never
        }
        return real.prepare(sql)
      },
      batch: real.batch.bind(real),
    } as unknown as typeof real

    const result = await landGovernedFlight(
      { ...env, DB: sabotaged } as unknown as Env,
      FLIGHT,
      {
        cost_micro_usd: 7, score: 0.4,
        expected_agent: 'agent-1', agent_id: 'agent-1',
        meta: meta(), actor: { kind: 'agent', id: 'agent-1' },
      },
    )

    expect(result.transitioned).toBe(true)
    expect(result.receipt).toBe(false)

    // And the flight really did land — a receipt failure must never un-land it.
    const row = harness.sqlite.prepare(`SELECT status FROM flights WHERE id = ?`).get(FLIGHT) as { status: string }
    expect(row.status).toBe('landed')
  })
})
