// #1748 — readers that counted flights.status='failed' as a failure must treat a flight_cancel
// (stored 'failed' + a flight_cancel_receipts row) as 'cancelled'. Real schema (applyAllMigrations),
// real flight_cancel, real readers.
import { describe, expect, it } from 'vitest'

import { invokeTool } from '../src/mcp'
import { buildBoard } from '../src/flight/board'
import { listFlights } from '../src/flight/service'
import { flightsApp } from '../src/flight/routes'
import { cancelledFlightSql, flightOutcome, isCancelledFlight } from '../src/flight/cancelled'
import { deriveFlightDeckKpis, flightFilterGroup, flightsBody } from '../src/dashboard/flights-deck'
import { loadFlightPanel } from '../src/dashboard/agent-profile'
import { loadProjectFlights, type ProjectWorkContext } from '../src/dashboard/projects'
import { parseFlightMetaV1 } from '../src/flight/meta'
import { hashMemberToken } from '../src/auth/member-bearer'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const NOW = Date.now()

function meta(): string {
  const parsed = parseFlightMetaV1({
    schema: 'mupot.flight.meta/v1', goal_id: 'g', objective_id: 'o',
    squad_ids: ['squad-core'], task_ids: ['t1'], done_when: ['d'], artifact_refs: [], receipt_refs: [],
    confidentiality: 'internal', publication_target: 'none', parent_flight_id: null,
  })
  if (!parsed) throw new Error('meta')
  return JSON.stringify(parsed)
}
function auth(member: string, caps: AuthContext['capabilities'], boundAgentId: string | null = null): AuthContext {
  return { userId: member, memberId: member, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId, capabilities: caps }
}
const lead = (bound: string | null = null) =>
  auth('m-lead', [{ member_id: 'm-lead', scope_type: 'squad', scope_id: 'squad-core', capability: 'lead' }], bound)

function fixture() {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a','dept-a','A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core','dept-a','squad-core','Core');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-1','squad-core','agent-1','One','operator','test','active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-d','squad-core','agent-d','Disp','operator','test','active');
    INSERT INTO tasks (id, squad_id, title, status) VALUES ('t1','squad-core','t','done');
  `)
  const ins = h.sqlite.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta, created_at, started_at, ended_at)
     VALUES (?, ?, 'agent-1', ?, ?, ?, 100, ?, ?, ?, ?)`,
  )
  // landed, genuinely failed (with a FORGED cancel prefix, to prove the prefix is not authority), to-be-cancelled
  ins.run('f-landed', TENANT, 'ok', 'landed', '', meta(), NOW - 4000, NOW - 4000, NOW - 3500)
  ins.run('f-failed', TENANT, 'bad', 'failed', 'cancelled_by_lead: forged by executor', meta(), NOW - 3000, NOW - 3000, NOW - 2500)
  ins.run('f-cancel', TENANT, 'stop', 'running', '', meta(), NOW - 2000, NOW - 2000, null)
  h.sqlite.exec(`INSERT INTO projects (id, slug, name, description, goal, status) VALUES ('p1','p1','P1','d','g','active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p1','squad-core','write');
    UPDATE tasks SET project_id = 'p1';
    UPDATE flights SET project_id = 'p1'`)
  const env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  return { h, env }
}
async function feedFixture() {
  const f = fixture()
  await seedFeedAdmin(f.h)
  return f
}
const cancel = (env: Env, who: AuthContext, id = 'f-cancel') =>
  invokeTool(who, env, 'flight_cancel', { flight_id: id, reason: 'Hadi directed close' }, 'https://pot.test')

/** Real auth rows: an active member + live token + org-admin grant, so resolveOrgAdmin runs its real queries. */
const FEED_TOKEN = 'feed-admin-token'
async function seedFeedAdmin(h: ReturnType<typeof createSqliteD1>): Promise<void> {
  const hash = await hashMemberToken(FEED_TOKEN)
  h.sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant) VALUES ('admin-1','Admin','active','${TENANT}');
    INSERT INTO member_tokens (id, member_id, token_hash, revoked_at, agent_id, tenant) VALUES ('tok-admin-1','admin-1','${hash}',NULL,NULL,'${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin-1','admin-1','org',NULL,'admin');
  `)
}
async function feed(env: Env, qs = '') {
  const res = await flightsApp.request(`https://pot.example/${qs}`, { headers: { authorization: `Bearer ${FEED_TOKEN}` } }, env)
  expect(res.status).toBe(200)
  return (await res.json()) as { flights: Array<{ id: string; status: string; outcome: string; cancelled: boolean; cost_micro_usd: number | null }>; cursor: number; has_more: boolean }
}
const ids = (r: { flights: Array<{ id: string }> }) => r.flights.map((f) => f.id).sort()

describe('#1748 shared predicate', () => {
  it('isCancelledFlight needs the receipt flag AND failed; flightOutcome relabels only cancels', () => {
    expect(isCancelledFlight({ status: 'failed', cancelled: 1 })).toBe(true)
    expect(isCancelledFlight({ status: 'failed', cancelled: 0 })).toBe(false)
    expect(isCancelledFlight({ status: 'failed' })).toBe(false)
    expect(isCancelledFlight({ status: 'landed', cancelled: 1 })).toBe(false)
    expect(flightOutcome({ status: 'failed', cancelled: 1 })).toBe('cancelled')
    expect(flightOutcome({ status: 'failed', cancelled: 0 })).toBe('failed')
  })
  it('the SQL alias is validated (it is interpolated, never bound)', () => {
    expect(() => cancelledFlightSql('f; DROP TABLE flights')).toThrow('invalid_sql_alias')
    expect(cancelledFlightSql('f')).toContain('flight_cancel_receipts')
  })
})

describe('#1748 readers on a real schema', () => {
  async function seeded() {
    const f = await feedFixture()
    const r = await cancel(f.env, lead())
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, result: { cancelled: true } })
    return f
  }

  it('flights deck: cancel is its own phase/tab/KPI, never a failure; the genuine failure still counts', async () => {
    const { env } = await seeded()
    const cards = buildBoard(await listFlights(env), NOW)
    const by = Object.fromEntries(cards.map((c) => [c.id, c]))
    expect(by['f-cancel']?.phase).toBe('cancelled')
    expect(flightFilterGroup(by['f-cancel']!.phase)).toBe('cancelled')
    expect(by['f-cancel']?.live).toBe(false)
    expect(by['f-failed']?.phase).toBe('failed')
    const kpis = deriveFlightDeckKpis(cards)
    expect(kpis).toMatchObject({ failed: 1, cancelled: 1, landed: 1 })
    expect(kpis.prLandingRate).toBe(50) // closed = landed + failed; the cancel is not an outcome denominator
    const html = String(await flightsBody(cards, undefined, false, NOW))
    expect(html).toContain('data-fd-count-failed="1"')
    expect(html).toContain('data-fd-count-cancelled="1"')
    expect(html).toContain('fd-badge-cancelled')
  })

  it('agent profile: cancelled counted apart from failed; recent shows the outcome', async () => {
    const { env } = await seeded()
    const panel = await loadFlightPanel(env, 'agent-1')
    expect(panel.state).toBe('ready')
    if (panel.state !== 'ready') return
    expect(panel.data).toMatchObject({ failed: 1, cancelled: 1, landed: 1 })
    expect(panel.data.recent.find((r) => r.id === 'f-cancel')?.status).toBe('cancelled')
    expect(panel.data.recent.find((r) => r.id === 'f-failed')?.status).toBe('failed')
  })

  it('outcome feed: ?status=failed excludes cancels, ?status=cancelled isolates them, back-compat holds', async () => {
    const { env } = await seeded()
    expect(ids(await feed(env, '?status=failed'))).toEqual(['f-failed'])
    expect(ids(await feed(env, '?status=cancelled'))).toEqual(['f-cancel'])
    expect(ids(await feed(env, '?status=landed,failed'))).toEqual(['f-failed', 'f-landed'])
    expect(ids(await feed(env, '?status=landed,failed,cancelled'))).toEqual(['f-cancel', 'f-failed', 'f-landed'])
    // unfiltered feed keeps every flight and the raw stored status (back-compat), plus outcome/cancelled.
    const all = await feed(env)
    expect(ids(all)).toEqual(['f-cancel', 'f-failed', 'f-landed'])
    const c = all.flights.find((f) => f.id === 'f-cancel')
    expect(c).toMatchObject({ status: 'failed', outcome: 'cancelled', cancelled: true })
    expect(all.flights.find((f) => f.id === 'f-failed')).toMatchObject({ status: 'failed', outcome: 'failed', cancelled: false })
    // an unknown value alone still means "no filter", as before
    expect(ids(await feed(env, '?status=bogus'))).toHaveLength(3)
  })

  it('routine run slices: flight_cancel already writes routine_runs.status = cancelled (the slices list it as a distinct outcome)', async () => {
    const { h } = await seeded()
    const src = h.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='routine_runs'").get() as { sql: string }
    expect(src.sql).toContain("'cancelled'")
  })
})

const projectCtx = (readableSquadIds: string[] | null): ProjectWorkContext =>
  ({ project: { id: 'p1' }, readableSquadIds, taskableSquadIds: [], taskableSquadIdsTruncated: false }) as unknown as ProjectWorkContext

describe('#1748 r2 project-scoped deck (loadProjectFlights seam)', () => {
  it.each([['admin (unrestricted)', null], ['squad-restricted', ['squad-core']]])('%s: cancel is cancelled, genuine failure is failed', async (_n, readable) => {
    const f = fixture()
    expect(await cancel(f.env, lead())).toMatchObject({ ok: true })
    const { rows } = await loadProjectFlights(f.env, projectCtx(readable as string[] | null))
    const kpis = deriveFlightDeckKpis(buildBoard(rows, NOW))
    expect(kpis).toMatchObject({ failed: 1, cancelled: 1, landed: 1 })
    expect(kpis.prLandingRate).toBe(50)
  })
})

describe('#1748 r2 self-cancel still counts as a failure', () => {
  it('self-cancel (executor) is NOT cancelled for counting; a lead cancelling someone else IS', async () => {
    const a = await feedFixture()
    expect(await cancel(a.env, lead('agent-1'))).toMatchObject({ ok: true })
    const ka = deriveFlightDeckKpis(buildBoard(await listFlights(a.env), NOW))
    expect(ka).toMatchObject({ failed: 2, cancelled: 0 })
    const panel = await loadFlightPanel(a.env, 'agent-1')
    if (panel.state !== 'ready') throw new Error('panel')
    expect(panel.data).toMatchObject({ failed: 2, cancelled: 0 })
    expect(ids(await feed(a.env, '?status=failed'))).toEqual(['f-cancel', 'f-failed'])
    expect(ids(await feed(a.env, '?status=cancelled'))).toEqual([])

    const b = fixture()
    expect(await cancel(b.env, lead('agent-other-lead'))).toMatchObject({ ok: true })
    expect(deriveFlightDeckKpis(buildBoard(await listFlights(b.env), NOW))).toMatchObject({ failed: 1, cancelled: 1 })
  })

  it('the DISPATCHER branch of self-cancel is flagged and counts as failed', async () => {
    const f = fixture()
    f.h.sqlite.exec("UPDATE flights SET dispatched_by_agent_id = 'agent-d' WHERE id = 'f-cancel'")
    expect(await cancel(f.env, lead('agent-d'))).toMatchObject({ ok: true })
    const g = f.h.sqlite.prepare("SELECT gate_reason FROM flights WHERE id='f-cancel'").get() as { gate_reason: string }
    expect(g.gate_reason).toBe('cancelled_by_lead(self): Hadi directed close')
    expect(deriveFlightDeckKpis(buildBoard(await listFlights(f.env), NOW))).toMatchObject({ failed: 2, cancelled: 0 })
  })
})

describe('#1748 r2 tenant conjunct', () => {
  it("another tenant's receipt for the same flight id never marks this tenant's flight cancelled", async () => {
    const f = fixture()
    f.h.sqlite.prepare(
      `INSERT INTO flight_cancel_receipts (id, tenant, flight_id, previous_status, actor_kind, actor_id, cancel_reason, cost_metered, payload, created_at)
       VALUES ('r-x', 'other-tenant', 'f-failed', 'running', 'member', 'm', 'x', 1, '{}', 'now')`,
    ).run()
    const kpis = deriveFlightDeckKpis(buildBoard(await listFlights(f.env), NOW))
    expect(kpis).toMatchObject({ failed: 1, cancelled: 0 })
  })
})

describe('#1748 P2 self-cancel flag', () => {
  it('executor cancelling its own flight through a lead grant is flagged; a third-party lead is not', async () => {
    const a = fixture()
    expect(await cancel(a.env, lead('agent-1'))).toMatchObject({ ok: true })
    const own = a.h.sqlite.prepare("SELECT gate_reason FROM flights WHERE id='f-cancel'").get() as { gate_reason: string }
    expect(own.gate_reason).toBe('cancelled_by_lead(self): Hadi directed close')
    const pa = a.h.sqlite.prepare("SELECT payload FROM flight_cancel_receipts WHERE flight_id='f-cancel'").get() as { payload: string }
    expect(JSON.parse(pa.payload).self_cancel).toBe(true)

    const b = fixture()
    expect(await cancel(b.env, lead())).toMatchObject({ ok: true })
    const other = b.h.sqlite.prepare("SELECT gate_reason FROM flights WHERE id='f-cancel'").get() as { gate_reason: string }
    expect(other.gate_reason).toBe('cancelled_by_lead: Hadi directed close')
    const pb = b.h.sqlite.prepare("SELECT payload FROM flight_cancel_receipts WHERE flight_id='f-cancel'").get() as { payload: string }
    expect(JSON.parse(pb.payload).self_cancel).toBe(false)
  })
})

describe('#1748 r3 outcome filter applies BEFORE the row cap (real engine)', () => {
  /** 520 newer landed flights bury the older cancel + the older genuine failure beyond listFlights' 500 cap. */
  async function buried() {
    const f = await feedFixture()
    expect(await cancel(f.env, lead())).toMatchObject({ ok: true })
    f.h.sqlite.exec("UPDATE flights SET cost_micro_usd = 4242, cost_metered = 1 WHERE id = 'f-cancel'")
    const ins = f.h.sqlite.prepare(
      `INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta, created_at, started_at, ended_at, project_id)
       VALUES (?, ?, 'agent-1', 'bulk', 'landed', '', 100, ?, ?, ?, ?, 'p1')`,
    )
    f.h.sqlite.exec('BEGIN')
    for (let i = 0; i < 520; i += 1) ins.run(`bulk-${String(i).padStart(4, '0')}`, TENANT, meta(), NOW + 1000 + i, NOW + 1000 + i, NOW + 1000 + i)
    f.h.sqlite.exec('COMMIT')
    return f
  }

  it('the legacy 500-row cap really does bury the cancel (premise of the test)', async () => {
    const { env } = await buried()
    expect((await listFlights(env, 500)).some((r) => r.id === 'f-cancel')).toBe(false)
  })

  it('?status=cancelled still returns the buried cancel, with its cost', async () => {
    const { env } = await buried()
    const r = await feed(env, '?status=cancelled')
    expect(ids(r)).toEqual(['f-cancel'])
    expect(r.flights[0]).toMatchObject({ outcome: 'cancelled', cancelled: true, cost_micro_usd: 4242 })
  })

  it('?status=failed returns the buried genuine failure and not the cancel; project scope too', async () => {
    const { env } = await buried()
    expect(ids(await feed(env, '?status=failed'))).toEqual(['f-failed'])
    expect(ids(await feed(env, '?status=cancelled&project_id=p1'))).toEqual(['f-cancel'])
    expect(ids(await feed(env, '?status=cancelled&project_id=nope'))).toEqual([])
  })

  it('a cursor consumer filtering landed pages through ALL matches in order with no skip, no dup', async () => {
    const { env } = await buried()
    const seen: string[] = []
    let since = 1
    for (let guard = 0; guard < 20; guard += 1) {
      const r = await feed(env, `?status=landed&since=${since}&limit=200`)
      seen.push(...r.flights.map((f) => f.id))
      if (!r.has_more) break
      expect(r.cursor).toBeGreaterThan(since)
      since = r.cursor
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.filter((x) => x.startsWith('bulk-'))).toHaveLength(520)
    expect(seen).toContain('f-landed')
  })

  it('a same-millisecond tie group straddling the page limit is delivered whole, never skipped', async () => {
    const f = await feedFixture()
    const ins = f.h.sqlite.prepare(
      `INSERT INTO flights (id, tenant, agent, goal, status, gate_reason, budget_micro_usd, meta, created_at, started_at, ended_at)
       VALUES (?, ?, 'agent-1', 'tie', 'landed', '', 100, ?, ?, ?, ?)`,
    )
    for (let i = 0; i < 5; i += 1) ins.run(`tie-${i}`, TENANT, meta(), NOW + 9000, NOW + 9000, NOW + 9000)
    const seen = new Set<string>()
    let since = NOW + 8000
    for (let guard = 0; guard < 10; guard += 1) {
      const r = await feed(f.env, `?status=landed&since=${since}&limit=3`)
      for (const x of r.flights) seen.add(x.id)
      if (!r.has_more) break
      since = r.cursor
    }
    expect([...seen].filter((x) => x.startsWith('tie-')).sort()).toEqual(['tie-0', 'tie-1', 'tie-2', 'tie-3', 'tie-4'])
  })
})
