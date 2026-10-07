// #1758 — clearance read is scoped in SQL to flights intersecting the proposed meta (unrelated live flights cannot
// truncate it), and deploy -> studio on one repo is NOT self-blocked (those writers are exempt). Real engine.
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createProject } from '../src/projects/service'
import { deployProject } from '../src/projects/deploy'
import { dispatchStudioFlight } from '../src/dashboard/studio'
import { clearFlightMeta } from '../src/flight/dispatch'
import type { FlightMetaV1 } from '../src/flight/meta'

const REPO = 'https://github.com/Mumega-com/mupot'
const auth: AuthContext = { userId: 'user-1', email: 'o@pot.test', role: 'owner', tenant: 'pot-a', memberId: 'member-a' }

function meta(over: Partial<FlightMetaV1>): FlightMetaV1 {
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

function seed(h: SqliteD1Harness, n: number, prefix: string, make: (i: number) => FlightMetaV1, status = 'running'): void {
  const ins = h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta) VALUES (?, 'pot-a', 'agent-a', 'g', ?, '', 100, ?)`,
  )
  h.sqlite.exec('BEGIN')
  for (let i = 0; i < n; i += 1) ins.run(`${prefix}-${i}`, status, JSON.stringify(make(i)))
  h.sqlite.exec('COMMIT')
}

describe('#1758 clearance read is scoped to intersecting flights', () => {
  const proposed = meta({ task_ids: ['t-new'], artifact_refs: [REPO], goal_id: 'gp', objective_id: 'op', squad_ids: ['sp'] })
  const unrelated = (i: number): FlightMetaV1 => meta({ task_ids: [`u-${i}`], artifact_refs: [`https://x/${i}`], goal_id: `ug-${i}`, objective_id: `uo-${i}`, squad_ids: [`us-${i}`] })

  it('(a) 2001 unrelated live flights + 1 colliding flight -> HOLD, no truncation hold', async () => {
    const { h, env } = podHarness()
    seed(h, 2001, 'u', unrelated)
    seed(h, 1, 'hit', () => meta({ artifact_refs: [REPO], task_ids: ['z'] }))
    const r = await clearFlightMeta(env, proposed)
    expect(r.truncated).toBe(false)
    expect(r.cleared).toBe(false)
    expect(r.reasons).toEqual(['clearance_shared_artifact_ref:hit-0'])
  })

  it('(b) 2001 unrelated live flights + no collision -> cleared', async () => {
    const { h, env } = podHarness()
    seed(h, 2001, 'u', unrelated)
    const r = await clearFlightMeta(env, proposed)
    expect(r).toMatchObject({ cleared: true, truncated: false, reasons: [] })
  })

  it('(c) 2001 INTERSECTING live flights -> truncation hold (fail closed)', async () => {
    const { h, env } = podHarness()
    seed(h, 2001, 'i', (i) => meta({ task_ids: [`k-${i}`], artifact_refs: [REPO] }))
    const r = await clearFlightMeta(env, proposed)
    expect(r.truncated).toBe(true)
    expect(r.cleared).toBe(false)
    expect(r.reasons).toContain('flight_clearance_live_set_truncated')
  })

  it('shared task_id holds; shared goal only warns and does not block; squad overlap alone never truncates', async () => {
    const { h, env } = podHarness()
    seed(h, 2100, 'sq', (i) => meta({ task_ids: [`s-${i}`], squad_ids: ['sp'], goal_id: `x-${i}`, objective_id: `y-${i}` }))
    const warnOnly = await clearFlightMeta(env, proposed)
    expect(warnOnly.truncated).toBe(false)
    expect(warnOnly.cleared).toBe(true)
    expect(warnOnly.clearance.warns.length).toBeGreaterThan(0)
    seed(h, 1, 'tk', () => meta({ task_ids: ['t-new'] }))
    expect((await clearFlightMeta(env, proposed)).cleared).toBe(false)
  })

  it('terminal flights and other tenants never collide', async () => {
    const { h, env } = podHarness()
    seed(h, 1, 'done', () => meta({ artifact_refs: [REPO] }), 'landed')
    h.sqlite.prepare(`INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta) VALUES ('other', 'tenant-b', 'agent-a', 'g', 'running', '', 100, ?)`).run(JSON.stringify(meta({ artifact_refs: [REPO] })))
    expect((await clearFlightMeta(env, proposed)).cleared).toBe(true)
  })

  it('a proposed meta with no comparable HOLD keys still evaluates warn keys without error', async () => {
    const { env } = podHarness()
    const r = await clearFlightMeta(env, meta({ task_ids: [], artifact_refs: [] }))
    expect(r.cleared).toBe(true)
  })

  it('a live row with unparseable meta is skipped, not an error', async () => {
    const { h, env } = podHarness()
    h.sqlite.prepare(`INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta) VALUES ('bad', 'pot-a', 'agent-a', 'g', 'running', '', 100, '{}')`).run()
    expect((await clearFlightMeta(env, proposed)).cleared).toBe(true)
  })
})

describe('#1758 deploy -> studio regression (writers stay exempt)', () => {
  it('(d) deploy then studio dispatch on the same repo both succeed', async () => {
    const { h, env } = podHarness()
    const created = await createProject(env, { slug: 'ship', name: 'Ship', repo_url: REPO, live_url: 'https://mupot.mumega.com', worker_name: 'worker-beta', assigned_squad_id: 'squad-a' })
    if (!created.ok) throw new Error('project')
    h.sqlite.prepare("INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES (?, 'squad-a', 'write')").run(created.value.id)
    const d = await deployProject(env, created.value.id, auth, { prompt: 'first' })
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.flight_id).toBeTruthy()
    const s = await dispatchStudioFlight(env, auth, { prompt: 'Design a hero', repoUrl: REPO })
    expect(s.ok).toBe(true)
    expect((h.sqlite.prepare('SELECT COUNT(*) AS n FROM flights').get() as { n: number }).n).toBe(2)
  })
})
