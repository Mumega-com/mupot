// #1732 — real-schema (applyAllMigrations) coverage of unmetered landing + readers.
import { describe, expect, it } from 'vitest'

import { landGovernedFlight, listFlights, withCostSemantics } from '../src/flight/service'
import { buildBoard } from '../src/flight/board'
import { summariseFlights } from '../src/dashboard/agent-profile'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const TENANT = 'mumega'

function meta() {
  const parsed = parseFlightMetaV1({
    schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o',
    squad_ids: ['squad-core'], task_ids: ['t1'], done_when: ['d'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  })
  if (!parsed) throw new Error('meta')
  return parsed
}

function fixture(budget: number | null = 100) {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a','dept-a','A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core','dept-a','squad-core','Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-1','squad-core','agent-1','One','operator','test','active');
    INSERT INTO tasks (id, squad_id, title, status) VALUES ('t1','squad-core','t','done');
  `)
  h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, created_at, started_at)
     VALUES ('f1', ?, 'agent-1', 'g', 'running', ?, ?, ?, ?)`,
  ).run(TENANT, budget, JSON.stringify(meta()), Date.now(), Date.now())
  return { h, env: { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env }
}

const base = { expected_agent: 'agent-1', agent_id: 'agent-1', actor: { kind: 'agent' as const, id: 'agent-1' } }

describe('#1732 unmetered flights (real schema)', () => {
  it('migration default: new flights are metered', () => {
    const { h } = fixture()
    expect(h.sqlite.prepare("SELECT cost_metered AS m FROM flights WHERE id='f1'").get()).toEqual({ m: 1 })
  })

  it('unmetered land stores cost 0 + cost_metered 0, bypasses budget compare, receipt says unknown', async () => {
    const { h, env } = fixture(0)
    const r = await landGovernedFlight(env, 'f1', { ...base, meta: meta(), cost_micro_usd: 0, cost_metered: false })
    expect(r).toEqual({ transitioned: true, receipt: true })
    expect(h.sqlite.prepare("SELECT status, cost_micro_usd AS c, cost_metered AS m FROM flights WHERE id='f1'").get())
      .toEqual({ status: 'landed', c: 0, m: 0 })
    const p = JSON.parse((h.sqlite.prepare("SELECT payload FROM flight_event_outbox WHERE flight_id='f1'").get() as { payload: string }).payload)
    expect(p).toMatchObject({ cost_micro_usd: null, cost_metered: false, budget_compliance: 'unknown' })
  })

  it('metered default: over-budget still refused at the SQL guard; within budget lands cost_metered 1', async () => {
    const a = fixture(100)
    expect(await landGovernedFlight(a.env, 'f1', { ...base, meta: meta(), cost_micro_usd: 101 }))
      .toEqual({ transitioned: false, receipt: false })
    const b = fixture(100)
    expect((await landGovernedFlight(b.env, 'f1', { ...base, meta: meta(), cost_micro_usd: 50 })).transitioned).toBe(true)
    expect(b.h.sqlite.prepare("SELECT cost_metered AS m FROM flights WHERE id='f1'").get()).toEqual({ m: 1 })
  })

  it('unmetered still refuses: incomplete task, wrong agent, not in air', async () => {
    const a = fixture()
    a.h.sqlite.exec("UPDATE tasks SET status='in_progress'")
    expect((await landGovernedFlight(a.env, 'f1', { ...base, meta: meta(), cost_micro_usd: 0, cost_metered: false })).transitioned).toBe(false)
    const b = fixture()
    expect((await landGovernedFlight(b.env, 'f1', { ...base, expected_agent: 'x', meta: meta(), cost_micro_usd: 0, cost_metered: false })).transitioned).toBe(false)
    const c = fixture()
    c.h.sqlite.exec("UPDATE flights SET status='failed'")
    expect((await landGovernedFlight(c.env, 'f1', { ...base, meta: meta(), cost_micro_usd: 0, cost_metered: false })).transitioned).toBe(false)
  })

  it('readers exclude unmetered: withCostSemantics, board, agent-profile summary', async () => {
    const { h, env } = fixture(0)
    await landGovernedFlight(env, 'f1', { ...base, meta: meta(), cost_micro_usd: 0, cost_metered: false })
    const [row] = await listFlights(env, 10)
    expect(withCostSemantics(row)).toMatchObject({ cost_micro_usd: null, cost_metered: false })
    const [card] = buildBoard([{ ...row, budget_micro_usd: 0, cost_micro_usd: 7 }], Date.now())
    expect(card.cost_usd).toBe('unmetered')
    expect(card.over_budget).toBe(false)
    const sum = summariseFlights([
      { id: 'a', goal: 'g', status: 'landed', cost_micro_usd: 7, cost_metered: 0, created_at: '1' },
      { id: 'b', goal: 'g', status: 'landed', cost_micro_usd: 40, cost_metered: 1, created_at: '2' },
    ])
    expect(sum.costMicroUsd).toBe(40)
    void h
  })
})
