// #1762 — unexecuted deploy/studio bookkeeping flights must never HOLD flight clearance. Real schema + real engine.
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createProject } from '../src/projects/service'
import { deployProject } from '../src/projects/deploy'
import { dispatchStudioFlight } from '../src/dashboard/studio'
import { clearFlightMeta, dispatchFlight } from '../src/flight/dispatch'
import { createFlight, listIntersectingLiveFlights } from '../src/flight/service'
import { parseFlightMetaV1, type FlightMetaV1 } from '../src/flight/meta'
import type { FlightSignals } from '../src/flight/preflight'

const REPO = 'https://github.com/Mumega-com/mupot'
const auth: AuthContext = { userId: 'user-1', email: 'o@pot.test', role: 'owner', tenant: 'pot-a', memberId: 'member-a' }
const SIGNALS: FlightSignals = {
  contextComplete: true, toolsReachable: true, budgetRemainingMicroUsd: 1_000_000, budgetEstimateMicroUsd: 1000,
  recentProgress: 0.9, progressPerStep: 0.9, wastePerStep: 0.1, stepSeconds: 30,
}

function meta(over: Partial<FlightMetaV1> = {}): FlightMetaV1 {
  return {
    schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o', squad_ids: ['squad-x'],
    task_ids: ['t'], done_when: ['d'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null, ...over,
  }
}

let harness: SqliteD1Harness | undefined
afterEach(() => { harness?.close(); harness = undefined })

function podHarness(): { h: SqliteD1Harness; env: Env } {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
  `)
  harness = h
  return { h, env: { DB: h.db, TENANT_SLUG: 'pot-a', RELEASE_SHA: 'a'.repeat(40) } as unknown as Env }
}

function seed(h: SqliteD1Harness, n: number, prefix: string, make: (i: number) => FlightMetaV1, status = 'running', bookkeeping = 0): void {
  const ins = h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta, bookkeeping) VALUES (?, 'pot-a', 'agent-a', 'g', ?, '', 100, ?, ?)`,
  )
  h.sqlite.exec('BEGIN')
  for (let i = 0; i < n; i += 1) ins.run(`${prefix}-${i}`, status, JSON.stringify(make(i)), bookkeeping)
  h.sqlite.exec('COMMIT')
}

async function projectOn(h: SqliteD1Harness, env: Env): Promise<string> {
  const created = await createProject(env, { slug: 'ship', name: 'Ship', repo_url: REPO, live_url: 'https://mupot.mumega.com', worker_name: 'worker-beta', assigned_squad_id: 'squad-a' })
  if (!created.ok) throw new Error('project')
  h.sqlite.prepare("INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES (?, 'squad-a', 'write')").run(created.value.id)
  return created.value.id
}

const real = meta({ task_ids: ['t-real'], artifact_refs: [REPO], goal_id: 'gr', objective_id: 'or', squad_ids: ['sr'] })

describe('#1762 bookkeeping flights never HOLD clearance', () => {
  it('(1) a Deploy flight on repo R does not hold a real dispatch on R (deploy writer, end to end)', async () => {
    const { h, env } = podHarness()
    const pid = await projectOn(h, env)
    const d = await deployProject(env, pid, auth, { prompt: 'first' })
    expect(d.ok).toBe(true)
    const row = h.sqlite.prepare('SELECT bookkeeping, status FROM flights').get() as { bookkeeping: number; status: string }
    expect(row).toEqual({ bookkeeping: 1, status: 'preflight' })
    const r = await clearFlightMeta(env, real)
    expect(r).toMatchObject({ cleared: true, truncated: false, reasons: [] })
    const dispatched = await dispatchFlight(env, { agent: 'agent-a', goal: 'real', meta: real, trigger_source: 'manual', budget_micro_usd: 1000 }, SIGNALS)
    expect(dispatched.go).toBe(true)
    expect(dispatched.reasons).not.toContain('flight_clearance_hold')
    expect(dispatched.clearance?.cleared).toBe(true)
  })

  it('(1b) a Studio flight with a member-supplied repoUrl does not hold a real dispatch, even repeated', async () => {
    const { h, env } = podHarness()
    for (let i = 0; i < 5; i += 1) {
      const s = await dispatchStudioFlight(env, auth, { prompt: `plant ${i}`, repoUrl: REPO })
      expect(s.ok).toBe(true)
    }
    expect((h.sqlite.prepare('SELECT COUNT(*) AS n FROM flights WHERE bookkeeping = 1').get() as { n: number }).n).toBe(5)
    expect((await clearFlightMeta(env, real)).cleared).toBe(true)
  })

  it('bookkeeping flights still WARN (shared squad/goal), never HOLD, and never count toward truncation', async () => {
    const { h, env } = podHarness()
    seed(h, 2100, 'bk', (i) => meta({ task_ids: [`b-${i}`], artifact_refs: [REPO], squad_ids: ['sr'] }), 'preflight', 1)
    const r = await clearFlightMeta(env, real)
    expect(r.truncated).toBe(false)
    expect(r.cleared).toBe(true)
    expect(r.clearance.holds).toHaveLength(0)
    expect(r.clearance.warns.length).toBeGreaterThan(0)
  })

  it('JS comparator agrees with the SQL predicate: a bookkeeping row handed to checkFlightClearance never holds', async () => {
    const { h, env } = podHarness()
    seed(h, 1, 'bk', () => meta({ task_ids: ['t-real'], artifact_refs: [REPO], squad_ids: ['sr'] }), 'preflight', 1)
    const { checkFlightClearance } = await import('../src/flight/clearance')
    const rows = (h.sqlite.prepare('SELECT * FROM flights').all() as unknown) as Parameters<typeof checkFlightClearance>[1]
    const c = checkFlightClearance(real, rows, { tenant: 'pot-a' })
    expect(c.cleared).toBe(true)
    expect(c.holds).toHaveLength(0)
    expect(c.warns).toHaveLength(1)
    void env
  })

  it('(2) a real live flight on R still HOLDs (artifact_ref and task_id)', async () => {
    const { h, env } = podHarness()
    seed(h, 1, 'live', () => meta({ task_ids: ['other'], artifact_refs: [REPO] }), 'running')
    const r = await clearFlightMeta(env, real)
    expect(r.cleared).toBe(false)
    expect(r.reasons).toEqual(['clearance_shared_artifact_ref:live-0'])
    seed(h, 1, 'tk', () => meta({ task_ids: ['t-real'] }), 'waiting')
    expect((await clearFlightMeta(env, real)).reasons.some((x) => x.startsWith('clearance_shared_task_id'))).toBe(true)
  })

  it('a real flight HOLDs even when bookkeeping flights share the same repo (bookkeeping does not mask it)', async () => {
    const { h, env } = podHarness()
    seed(h, 3, 'bk', () => meta({ task_ids: ['b'], artifact_refs: [REPO] }), 'preflight', 1)
    seed(h, 1, 'live', () => meta({ task_ids: ['other'], artifact_refs: [REPO] }), 'running')
    const r = await clearFlightMeta(env, real)
    expect(r.cleared).toBe(false)
    expect(r.reasons).toEqual(['clearance_shared_artifact_ref:live-0'])
  })

  it('(3) a member cannot forge the marker via flight_dispatch input (NewFlight field, meta key)', async () => {
    const { h, env } = podHarness()
    const hostileMeta = { ...real, bookkeeping: 1, __bookkeeping: true }
    // The strict REST/MCP meta validator rejects unknown keys outright, so the marker cannot ride in on meta.
    expect(parseFlightMetaV1(hostileMeta)).toBeNull()
    // Even if a caller-shaped object smuggles the field straight into dispatchFlight/createFlight, it is ignored.
    const hostile = { agent: 'agent-a', goal: 'forge', meta: real, trigger_source: 'api', bookkeeping: 1, budget_micro_usd: 1000 }
    const forged = await dispatchFlight(env, hostile as unknown as Parameters<typeof dispatchFlight>[1], SIGNALS)
    expect(forged.go).toBe(true)
    const id = forged.id
    expect((h.sqlite.prepare('SELECT bookkeeping FROM flights WHERE id = ?').get(id) as { bookkeeping: number }).bookkeeping).toBe(0)
    // And it still HOLDs a later real dispatch on the same repo: the forged flight is a normal live flight.
    const second = await clearFlightMeta(env, meta({ task_ids: ['t-2'], artifact_refs: [REPO] }))
    expect(second.cleared).toBe(false)
    // createFlight directly with a hostile object likewise writes 0.
    const direct = await createFlight(env, { ...hostile, meta: hostileMeta } as unknown as Parameters<typeof createFlight>[1])
    expect((h.sqlite.prepare('SELECT bookkeeping FROM flights WHERE id = ?').get(direct) as { bookkeeping: number }).bookkeeping).toBe(0)
  })

  it('the column rejects values other than 0/1', () => {
    const { h } = podHarness()
    expect(() => h.sqlite.exec(`INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, meta, bookkeeping) VALUES ('x','pot-a','agent-a','g','preflight','','{}',2)`)).toThrow()
  })

  it('(4) Deploy -> Studio flow on one repo still works; both flights are bookkeeping and the dashboards still list them', async () => {
    const { h, env } = podHarness()
    const pid = await projectOn(h, env)
    const d = await deployProject(env, pid, auth, { prompt: 'first' })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.flight_id).toBeTruthy()
    const s = await dispatchStudioFlight(env, auth, { prompt: 'Design a hero', repoUrl: REPO })
    expect(s.ok).toBe(true)
    expect((h.sqlite.prepare('SELECT COUNT(*) AS n FROM flights WHERE bookkeeping = 1').get() as { n: number }).n).toBe(2)
    const { listLiveFlights } = await import('../src/flight/service')
    expect((await listLiveFlights(env)).rows).toHaveLength(2)
  })
})

describe('#1762 / #1761 P3: read cap boundaries', () => {
  const proposed = meta({ task_ids: ['t-new'], artifact_refs: [REPO] })
  it('>2000 LANDED intersecting flights + 1 live collision -> truncated:false and held', async () => {
    const { h, env } = podHarness()
    seed(h, 2001, 'done', (i) => meta({ task_ids: [`d-${i}`], artifact_refs: [REPO] }), 'landed')
    seed(h, 1, 'hit', () => meta({ task_ids: ['z'], artifact_refs: [REPO] }), 'running')
    const r = await clearFlightMeta(env, proposed)
    expect(r.truncated).toBe(false)
    expect(r.cleared).toBe(false)
    expect(r.reasons).toEqual(['clearance_shared_artifact_ref:hit-0'])
  })

  it('exactly 2000 intersecting live flights -> not truncated (held by collision); 2001 -> truncated', async () => {
    const { h, env } = podHarness()
    seed(h, 2000, 'e', (i) => meta({ task_ids: [`e-${i}`], artifact_refs: [REPO] }))
    const at = await listIntersectingLiveFlights(env, proposed)
    expect(at.rows).toHaveLength(2000)
    expect(at.truncated).toBe(false)
    const held = await clearFlightMeta(env, proposed)
    expect(held.cleared).toBe(false)
    expect(held.truncated).toBe(false)
    seed(h, 1, 'e-extra', () => meta({ task_ids: ['x'], artifact_refs: [REPO] }))
    const over = await listIntersectingLiveFlights(env, proposed)
    expect(over.rows).toHaveLength(2000)
    expect(over.truncated).toBe(true)
  })
})
