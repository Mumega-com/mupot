// tests/coordination.test.ts — the Control Tower (cross-project departures board).
// Service (board/update/list + board model) + the HTTP routes. Faithful in-memory journeys fake.

import { describe, it, expect, vi } from 'vitest'
import { boardJourney, updateJourney, listJourneys, buildDepartureBoard, type JourneyRow } from '../src/coordination/journeys'
import type { Env } from '../src/types'

vi.mock('../src/auth/member-bearer', () => ({
  bearerToken: (h?: string) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
  resolveMemberByToken: async (_e: unknown, token: string | null) => {
    if (token === 'tok-code') return { memberId: 'm-code', displayName: 'code', email: null, boundAgentId: 'ag-code' }
    if (token === 'tok-rev') return { memberId: 'm-rev', displayName: 'rev', email: null, boundAgentId: 'ag-review' }
    if (token === 'tok-unbound') return { memberId: 'm-h', displayName: 'h', email: null, boundAgentId: null }
    return null
  },
}))
const { coordinationApp } = await import('../src/coordination/routes')

function makeDb() {
  const rows: JourneyRow[] = []
  function runRun(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO journeys')) {
      const [id, tenant, agent, project, goal, gate, eta, ts] = b as [string, string, string, string, string, string, number | null, number]
      rows.push({ id, tenant, agent, project, goal, status: 'boarding', gate, departed_at: null, eta, arrived_at: null, created_at: ts, updated_at: ts })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('UPDATE journeys')) {
      const [id, tenant, agent, status, goal, gate, eta, ts] = b as [string, string, string, string | null, string | null, string | null, number | null, number]
      const r = rows.find((x) => x.id === id && x.tenant === tenant && x.agent === agent)
      if (!r) return { meta: { changes: 0 } }
      if (status != null) r.status = status as JourneyRow['status']
      if (goal != null) r.goal = goal
      if (gate != null) r.gate = gate
      if (eta != null) r.eta = eta
      if (status === 'departed') r.departed_at = r.departed_at ?? ts
      if (status === 'arrived') r.arrived_at = r.arrived_at ?? ts
      r.updated_at = ts
      return { meta: { changes: 1 } }
    }
    throw new Error('unhandled run: ' + sql)
  }
  function runAll(sql: string, b: unknown[]) {
    if (sql.includes('FROM journeys')) {
      const [tenant, limit] = b as [string, number]
      const live = sql.includes("status IN ('boarding','departed','delayed')")
      return rows
        .filter((r) => r.tenant === tenant && (!live || ['boarding', 'departed', 'delayed'].includes(r.status)))
        .sort((x, y) => y.created_at - x.created_at)
        .slice(0, limit)
        .map((r) => ({ ...r }))
    }
    throw new Error('unhandled all: ' + sql)
  }
  return {
    _rows: rows,
    prepare(sql: string) {
      const binds: unknown[] = []
      const api = {
        bind(...a: unknown[]) { binds.push(...a); return api },
        async first<T>() { return null as T },
        async all<T>() { return { results: runAll(sql, binds) as T[] } },
        async run() { return runRun(sql, binds) },
      }
      return api
    },
  }
}
function env(db: ReturnType<typeof makeDb>, tenant = 't'): Env {
  return { TENANT_SLUG: tenant, DB: db } as unknown as Env
}
const clock = { now: () => 1_000_000, idGen: (() => { let n = 0; return () => `j-${++n}` })() }

describe('boardJourney', () => {
  it('boards a flight (boarding), stamps agent/project/tenant', async () => {
    const db = makeDb()
    const r = await boardJourney(env(db), { agent: 'ag-code', project: 'mupot', goal: 'build inbox', gate: 'PR#221', eta: 2_000_000 }, clock)
    expect(r.ok).toBe(true)
    const row = db._rows[0]
    expect(row.status).toBe('boarding')
    expect(row.agent).toBe('ag-code')
    expect(row.project).toBe('mupot')
    expect(row.eta).toBe(2_000_000)
    expect(row.departed_at).toBeNull()
  })
  it.each([
    ['empty project', { project: '' }, 'invalid_project'],
    ['spaced project', { project: 'has space' }, 'invalid_project'],
    ['empty agent', { agent: '' }, 'invalid_agent'],
    ['negative eta', { eta: -5 }, 'invalid_eta'],
    ['NaN eta', { eta: Number.NaN }, 'invalid_eta'],
  ])('rejects %s', async (_l, patch, reason) => {
    const r = await boardJourney(env(makeDb()), { agent: 'ag-code', project: 'mupot', ...(patch as object) }, clock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe(reason)
  })
  it('fail-closed without tenant', async () => {
    const r = await boardJourney({ DB: makeDb() } as unknown as Env, { agent: 'a', project: 'p' }, clock)
    expect(r.ok).toBe(false)
  })
})

describe('updateJourney', () => {
  it('depart then arrive stamps the timestamps once', async () => {
    const db = makeDb()
    const e = env(db)
    const b = await boardJourney(e, { agent: 'ag-code', project: 'mupot' }, clock)
    if (!b.ok) return
    await updateJourney(e, b.id, 'ag-code', { status: 'departed' }, { now: () => 1_500_000 })
    expect(db._rows[0].status).toBe('departed')
    expect(db._rows[0].departed_at).toBe(1_500_000)
    await updateJourney(e, b.id, 'ag-code', { status: 'arrived' }, { now: () => 1_900_000 })
    expect(db._rows[0].arrived_at).toBe(1_900_000)
    expect(db._rows[0].departed_at).toBe(1_500_000) // unchanged
  })
  it('an agent cannot update another agent‘s flight → not_found', async () => {
    const db = makeDb()
    const e = env(db)
    const b = await boardJourney(e, { agent: 'ag-code', project: 'mupot' }, clock)
    if (!b.ok) return
    const r = await updateJourney(e, b.id, 'ag-review', { status: 'arrived' }, clock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('not_found')
    expect(db._rows[0].status).toBe('boarding') // untouched
  })
  it('rejects an invalid status', async () => {
    const db = makeDb()
    const e = env(db)
    const b = await boardJourney(e, { agent: 'ag-code', project: 'mupot' }, clock)
    if (!b.ok) return
    const r = await updateJourney(e, b.id, 'ag-code', { status: 'teleported' as never }, clock)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid_status')
  })
})

describe('listJourneys + buildDepartureBoard', () => {
  it('live scope shows boarding/departed/delayed, not arrived; newest first', async () => {
    const db = makeDb()
    const e = env(db)
    const idgen = (() => { let n = 0; return () => `k-${++n}` })()
    await boardJourney(e, { agent: 'a1', project: 'mupot' }, { now: () => 1, idGen: idgen })
    await boardJourney(e, { agent: 'a2', project: 'viamar' }, { now: () => 2, idGen: idgen })
    const arrived = await boardJourney(e, { agent: 'a3', project: 'digid' }, { now: () => 3, idGen: idgen })
    if (!arrived.ok) return
    await updateJourney(e, arrived.id, 'a3', { status: 'arrived' }, { now: () => 4 })
    const live = await listJourneys(e, { scope: 'live' })
    expect(live.map((r) => r.agent)).toEqual(['a2', 'a1']) // newest first, arrived excluded
    const all = await listJourneys(e, { scope: 'all' })
    expect(all.length).toBe(3)
  })
  it('board model maps phase + eta/departed display', () => {
    const now = 10_000
    const rows: JourneyRow[] = [
      { id: 'x', tenant: 't', agent: 'a1', project: 'mupot', goal: 'g', status: 'departed', gate: 'PR#1', departed_at: now - 60_000, eta: now + 1_200_000, arrived_at: null, created_at: now - 120_000, updated_at: now },
      { id: 'y', tenant: 't', agent: 'a2', project: 'viamar', goal: '', status: 'arrived', gate: '', departed_at: null, eta: null, arrived_at: now, created_at: now - 5000, updated_at: now },
    ]
    const cards = buildDepartureBoard(rows, now)
    expect(cards[0].phase).toBe('IN FLIGHT')
    expect(cards[0].live).toBe(true)
    expect(cards[0].departed).toBe('1m ago')
    expect(cards[0].eta).toBe('in 20m')
    expect(cards[1].phase).toBe('ARRIVED')
    expect(cards[1].live).toBe(false)
    expect(cards[1].eta).toBe('—')
  })
})

// ── routes ──────────────────────────────────────────────────────────────────────
function reqJson(method: string, token: string | undefined, body?: unknown, path = '/'): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('coordination routes', () => {
  it('POST no token → 401; unbound → 403', async () => {
    expect((await coordinationApp.fetch(reqJson('POST', undefined, { project: 'mupot' }), env(makeDb()))).status).toBe(401)
    expect((await coordinationApp.fetch(reqJson('POST', 'tok-unbound', { project: 'mupot' }), env(makeDb()))).status).toBe(403)
  })
  it('POST happy → 201 + persisted with welded agent', async () => {
    const db = makeDb()
    const res = await coordinationApp.fetch(reqJson('POST', 'tok-code', { project: 'mupot', goal: 'x', gate: 'PR#9' }), env(db))
    expect(res.status).toBe(201)
    expect(db._rows[0].agent).toBe('ag-code') // from token weld, not body
    expect(db._rows[0].project).toBe('mupot')
  })
  it('POST invalid project → 400', async () => {
    expect((await coordinationApp.fetch(reqJson('POST', 'tok-code', { project: 'bad space' }), env(makeDb()))).status).toBe(400)
  })
  it('PATCH own flight → 200; another agent → 404', async () => {
    const db = makeDb()
    const e = env(db)
    await coordinationApp.fetch(reqJson('POST', 'tok-code', { project: 'mupot' }), e)
    const id = db._rows[0].id
    const ok = await coordinationApp.fetch(reqJson('PATCH', 'tok-code', { status: 'departed' }, `/${id}`), e)
    expect(ok.status).toBe(200)
    const no = await coordinationApp.fetch(reqJson('PATCH', 'tok-rev', { status: 'arrived' }, `/${id}`), e)
    expect(no.status).toBe(404)
  })
  it('GET board → 200 cards (live by default)', async () => {
    const db = makeDb()
    const e = env(db)
    await coordinationApp.fetch(reqJson('POST', 'tok-code', { project: 'mupot' }), e)
    const res = await coordinationApp.fetch(reqJson('GET', 'tok-code'), e)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { board: Array<{ project: string }>; scope: string }
    expect(j.scope).toBe('live')
    expect(j.board[0].project).toBe('mupot')
  })
  it('GET no token → 401', async () => {
    expect((await coordinationApp.fetch(reqJson('GET', undefined), env(makeDb()))).status).toBe(401)
  })
})
