// #1755 — flight clearance must read the FULL live set, not the newest 500. Real schema + real engine.
import { describe, expect, it } from 'vitest'

import { dispatchFlight } from '../src/flight/dispatch'
import { checkFlightClearance } from '../src/flight/clearance'
import { listLiveFlights, LIVE_SET_CAP } from '../src/flight/service'
import { flightsApp } from '../src/flight/routes'
import { parseFlightMetaV1, type FlightMetaV1 } from '../src/flight/meta'
import { hashMemberToken } from '../src/auth/member-bearer'
import type { FlightSignals } from '../src/flight/preflight'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const NOW = Date.now()

function metaFor(taskId: string): FlightMetaV1 {
  const parsed = parseFlightMetaV1({
    schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o',
    squad_ids: ['squad-core'], task_ids: [taskId], done_when: ['d'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  })
  if (!parsed) throw new Error('meta')
  return parsed
}
const SIGNALS: FlightSignals = {
  goal_defined: true, budget_micro_usd: 1000, agent_active: true, no_other_flight_running: true,
  tasks_ready: true, inputs_ready: true, contract_present: true,
} as unknown as FlightSignals // shape only matters to preflight; clearance is what is under test

function fixture(oldStatus: string, newerLanded = 520) {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a','dept-a','A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core','dept-a','squad-core','Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-1','squad-core','agent-1','One','operator','test','active');
    INSERT INTO tasks (id, squad_id, title, status) VALUES ('T','squad-core','t','in_progress');
  `)
  const ins = h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta, created_at)
     VALUES (?, ?, 'agent-1', 'g', ?, '', 100, ?, ?)`,
  )
  ins.run('f-old-live', TENANT, oldStatus, JSON.stringify(metaFor('T')), NOW - 10_000_000)
  for (let i = 0; i < newerLanded; i += 1) {
    ins.run(`f-landed-${i}`, TENANT, 'landed', JSON.stringify(metaFor(`other-${i}`)), NOW - 5_000_000 + i)
  }
  return { h, env: { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env }
}

const flight = (taskId: string) => ({
  agent: 'agent-1', goal: 'dispatch', meta: metaFor(taskId), trigger_source: 'manual', budget_micro_usd: 1000,
}) as unknown as Parameters<typeof dispatchFlight>[1]

describe('#1755 clearance reads the full live set', () => {
  it.each(['waiting', 'sleeping'])('holds a colliding dispatch against an old %s flight buried under 520 newer flights', async (status) => {
    const { env } = fixture(status)
    const r = await dispatchFlight(env, flight('T'), SIGNALS)
    expect(r.go).toBe(false)
    expect(r.status).toBe('held')
    expect(r.clearance?.cleared).toBe(false)
    expect(r.reasons).toContain('flight_clearance_hold')
    expect(r.reasons).toContain('clearance_shared_task_id:f-old-live')
  })

  it('passes clearance when no live flight collides', async () => {
    const { env } = fixture('waiting')
    const r = await dispatchFlight(env, flight('unrelated-task'), SIGNALS)
    expect(r.clearance?.cleared).toBe(true)
    expect(r.clearance?.live_set_truncated).toBeUndefined()
  })

  it('listLiveFlights returns only live flights of this tenant, flags truncation at the cap', async () => {
    const { env, h } = fixture('waiting', 5)
    h.sqlite.exec(`INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta, created_at)
      VALUES ('other-tenant-live','elsewhere','agent-1','g','running','',1,'{}',${NOW})`)
    const all = await listLiveFlights(env)
    expect(all.rows.map((r) => r.id)).toEqual(['f-old-live'])
    expect(all.truncated).toBe(false)
    h.sqlite.exec(`INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta, created_at)
      VALUES ('l2','${TENANT}','agent-1','g','running','',1,'{}',${NOW}), ('l3','${TENANT}','agent-1','g','sleeping','',1,'{}',${NOW})`)
    const capped = await listLiveFlights(env, 2)
    expect(capped.rows).toHaveLength(2)
    expect(capped.truncated).toBe(true)
  })

  it('fails CLOSED when the live-set read hits its cap, even with no visible collision', async () => {
    const { env, h } = fixture('waiting', 0)
    h.sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ${LIVE_SET_CAP + 1})
      INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta, created_at)
      SELECT 'bulk-' || i, '${TENANT}', 'agent-1', 'g', 'running', '', 1, '{}', ${NOW} + i FROM n`)
    const r = await dispatchFlight(env, flight('unrelated-task'), SIGNALS)
    expect(r.go).toBe(false)
    expect(r.status).toBe('held')
    expect(r.clearance?.cleared).toBe(false)
    expect(r.clearance?.live_set_truncated).toBe(true)
    expect(r.reasons).toContain('flight_clearance_live_set_truncated')
  })

  it('checkFlightClearance with liveSetTruncated is not cleared; without it, it is', () => {
    expect(checkFlightClearance(metaFor('x'), [], { liveSetTruncated: true }).cleared).toBe(false)
    expect(checkFlightClearance(metaFor('x'), []).cleared).toBe(true)
  })

  it('/flights/collisions sees a live collision buried under 520 newer flights', async () => {
    const { env, h } = fixture('waiting')
    h.sqlite.exec(`INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta, created_at)
      VALUES ('f-old-live-2','${TENANT}','agent-1','g','sleeping','',1,'${JSON.stringify(metaFor('T'))}',${NOW - 9_000_000})`)
    const hash = await hashMemberToken('adm')
    h.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant) VALUES ('admin-1','Admin','active','${TENANT}');
      INSERT INTO member_tokens (id, member_id, token_hash, revoked_at, agent_id, tenant) VALUES ('tok-1','admin-1','${hash}',NULL,NULL,'${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-1','admin-1','org',NULL,'admin');`)
    const res = await flightsApp.request('https://pot.example/collisions', { headers: { authorization: 'Bearer adm' } }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { holds: unknown[]; live_set_truncated: boolean }
    expect(body.holds).toHaveLength(1)
    expect(body.live_set_truncated).toBe(false)
  })
})
