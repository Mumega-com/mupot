// tests/coherence-loop.test.ts — the brain↔pot circuit, end to end over HTTP.
//
// Plays the BRAIN against the real flightsApp (no route logic mocked): an org-admin
// service principal dispatches flights, the gate verdicts them, the executor lands or
// fails them, the brain pulls the outcome feed and advances its cursor. This is the
// v0.20 wire exercised as ONE LOOP — the thing every endpoint test covers only in
// pieces. The only fakes are the bindings: an in-memory D1 that understands the
// member-token auth path, the flights lifecycle, and the execution-meter sums.

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { flightsApp } from '../src/flight/routes'
import type { FlightRow } from '../src/flight/service'
import type { Env } from '../src/types'

// ── the pot-in-a-box: in-memory D1 for auth + flights + meter ─────────────────

interface PotBox {
  env: Env
  flights: Map<string, FlightRow>
  meter: Map<string, number> // window_key → cost_micro_usd
  app: Hono<{ Bindings: Env }>
}

const BRAIN_TOKEN = 'brain-token-raw'
const PEON_TOKEN = 'peon-token-raw'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function isoDayUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

async function makePot(tenant = 'digid', vars: Partial<Env> = {}): Promise<PotBox> {
  const flights = new Map<string, FlightRow>()
  const meter = new Map<string, number>()
  const brainHash = await sha256Hex(BRAIN_TOKEN)
  const peonHash = await sha256Hex(PEON_TOKEN)
  let createSeq = 0

  const guarded = (id: string, t: string, from: string[], apply: (r: FlightRow) => void) => {
    const r = flights.get(id)
    if (r && r.tenant === t && from.includes(r.status)) apply(r)
  }

  const env = {
    TENANT_SLUG: tenant,
    ...vars,
    DB: {
      prepare(sql: string) {
        return {
          bind(...a: unknown[]) {
            return {
              async run() {
                if (sql.includes('INSERT INTO flights')) {
                  const [id, t, agent, goal, trig, budget, meta] = a as [string, string, string, string, string, number | null, string]
                  flights.set(id, {
                    id, tenant: t, agent, goal, status: 'preflight',
                    trigger_source: trig as FlightRow['trigger_source'],
                    gate_verdict: null, gate_reason: '', score: null, budget_micro_usd: budget,
                    cost_micro_usd: 0, next_run_at: null, created_at: Date.now() + createSeq++,
                    started_at: null, ended_at: null, meta,
                  })
                } else if (sql.includes("status='running', gate_verdict='go'")) {
                  const [id, t, score, started] = a as [string, string, number, number]
                  guarded(id, t, ['preflight'], (r) => { r.status = 'running'; r.gate_verdict = 'go'; r.score = score; r.started_at = started })
                } else if (sql.includes("status='held'")) {
                  const [id, t, reason, score, ended] = a as [string, string, string, number, number]
                  guarded(id, t, ['preflight'], (r) => { r.status = 'held'; r.gate_verdict = 'no_go'; r.gate_reason = reason; r.score = score; r.ended_at = ended })
                } else if (sql.includes("status='landed'")) {
                  const [id, t, cost, score, ended, meta] = a as [string, string, number, number | null, number, string | null]
                  guarded(id, t, ['running', 'waiting', 'sleeping'], (r) => { r.status = 'landed'; r.cost_micro_usd = cost; if (score != null) r.score = score; r.ended_at = ended; if (meta != null) r.meta = meta })
                } else if (sql.includes("status='failed'")) {
                  const [id, t, reason, ended] = a as [string, string, string, number]
                  guarded(id, t, ['preflight', 'running', 'waiting', 'sleeping'], (r) => { r.status = 'failed'; r.gate_reason = reason; r.ended_at = ended })
                }
                return { success: true }
              },
              async first<T>(): Promise<T | null> {
                // member-token auth (resolveMemberByToken)
                if (sql.includes('FROM member_tokens')) {
                  const [hash] = a as [string]
                  if (hash === brainHash) {
                    return { member_id: 'brain', display_name: 'The Brain', email: null, status: 'active', bound_agent_id: null } as unknown as T
                  }
                  if (hash === peonHash) {
                    return { member_id: 'peon', display_name: 'Peon', email: null, status: 'active', bound_agent_id: null } as unknown as T
                  }
                  return null
                }
                // meter sum (sumCostMicroUsdSince) — lexical day-range over window keys
                if (sql.includes('SUM(cost_micro_usd)')) {
                  const [lo, hi] = a as [string, string]
                  let c = 0
                  for (const [k, v] of meter) if (k >= lo && k <= hi) c += v
                  return { c } as unknown as T
                }
                // dispatch throttle (countFlightsCreatedSince)
                if (sql.includes('COUNT(*) AS n FROM flights')) {
                  const [t, since] = a as [string, number]
                  let n = 0
                  for (const f of flights.values()) if (f.tenant === t && f.created_at >= since) n++
                  return { n } as unknown as T
                }
                // getFlight
                if (sql.includes('FROM flights WHERE id')) {
                  const [id, t] = a as [string, string]
                  const r = flights.get(id)
                  return (r && r.tenant === t ? (r as unknown as T) : null)
                }
                return null
              },
              async all<T>() {
                // resolveCapabilities — the brain is org-admin, the peon has nothing
                if (sql.includes('FROM capabilities')) {
                  const [memberId] = a as [string]
                  const rows = memberId === 'brain'
                    ? [{ member_id: 'brain', scope_type: 'org', scope_id: null, capability: 'admin' }]
                    : []
                  return { results: rows as unknown as T[] }
                }
                // listFlights
                if (sql.includes('FROM flights WHERE tenant')) {
                  const [t] = a as [string]
                  const out = [...flights.values()].filter((r) => r.tenant === t).sort((x, y) => y.created_at - x.created_at)
                  return { results: out as unknown as T[] }
                }
                return { results: [] as T[] }
              },
            }
          },
        }
      },
    },
  } as unknown as Env

  const app = new Hono<{ Bindings: Env }>()
  app.route('/api/flights', flightsApp)
  return { env, flights, meter, app }
}

const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

const healthySignals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 5_000_000,
  budgetEstimateMicroUsd: 1_000_000,
  recentProgress: 0.8,
  progressPerStep: 0.7,
  wastePerStep: 0.2,
  stepSeconds: 60,
}

function dispatchBody(goal: string, signals: Record<string, unknown> = healthySignals) {
  return JSON.stringify({ agent: 'kasra', goal, signals })
}

async function post(pot: PotBox, path: string, body: string, token = BRAIN_TOKEN) {
  return pot.app.request(path, { method: 'POST', headers: auth(token), body }, pot.env)
}

// ── the circuit ────────────────────────────────────────────────────────────────

describe('the brain↔pot circuit (mock brain, real routes)', () => {
  it('refuses a missing token (401) and a non-admin principal (403)', async () => {
    const pot = await makePot()
    const noAuth = await pot.app.request('/api/flights', { method: 'POST', body: dispatchBody('g') }, pot.env)
    expect(noAuth.status).toBe(401)
    const peon = await post(pot, '/api/flights', dispatchBody('g'), PEON_TOKEN)
    expect(peon.status).toBe(403)
  })

  it('flies the full loop: dispatch GO → land (cost reconciled) → outcome feed → cursor drains', async () => {
    const pot = await makePot()
    const day = isoDayUtc(new Date())

    // ── the brain detects a defect and dispatches; gate says GO ──
    const r1 = await post(pot, '/api/flights', dispatchBody('close issue #62'))
    expect(r1.status).toBe(201)
    const d1 = (await r1.json()) as { id: string; go: boolean; status: string }
    expect(d1.go).toBe(true)
    expect(d1.status).toBe('running')

    // ── the flight flies: the pot meters real spend while it works ──
    pot.meter.set(`digid:kasra:${day}`, 300_000) // $0.30 metered during the flight

    // ── the executor lands it, reporting cost honestly ──
    const r2 = await post(pot, `/api/flights/${d1.id}/land`, JSON.stringify({ cost_micro_usd: 290_000, score: 0.9 }))
    expect(r2.status).toBe(200)
    const landed = (await r2.json()) as { status: string; cost_reconciliation: { flagged: boolean; metered_micro_usd: number } }
    expect(landed.status).toBe('landed')
    expect(landed.cost_reconciliation.flagged).toBe(false) // 290k vs 300k metered: agrees
    expect(landed.cost_reconciliation.metered_micro_usd).toBe(300_000)
    // the reconciliation is durably on the flight record, not just the response
    expect(JSON.parse(pot.flights.get(d1.id)!.meta).cost_reconciliation.note).toBe('ok')

    // ── the brain pulls outcomes and re-measures; cursor advances ──
    const feed1 = await pot.app.request('/api/flights?status=landed,failed', { headers: auth(BRAIN_TOKEN) }, pot.env)
    const body1 = (await feed1.json()) as { flights: Array<{ id: string }>; cursor: number }
    expect(body1.flights.map((f) => f.id)).toEqual([d1.id])
    expect(body1.cursor).toBeGreaterThan(0)

    // re-poll FROM the cursor → drained (no double-measure)
    const feed2 = await pot.app.request(`/api/flights?status=landed,failed&since=${body1.cursor}`, { headers: auth(BRAIN_TOKEN) }, pot.env)
    const body2 = (await feed2.json()) as { flights: unknown[] }
    expect(body2.flights).toEqual([])
  })

  it('flags a dishonest landing: caller reports a fraction of what the pot metered', async () => {
    const pot = await makePot()
    const day = isoDayUtc(new Date())
    const r1 = await post(pot, '/api/flights', dispatchBody('g'))
    const d1 = (await r1.json()) as { id: string }
    pot.meter.set(`digid:kasra:${day}`, 1_000_000) // pot metered $1.00
    const r2 = await post(pot, `/api/flights/${d1.id}/land`, JSON.stringify({ cost_micro_usd: 100_000 })) // claims $0.10
    const landed = (await r2.json()) as { cost_reconciliation: { flagged: boolean; note: string } }
    expect(landed.cost_reconciliation.flagged).toBe(true)
    expect(landed.cost_reconciliation.note).toBe('under_reported_vs_meter')
  })

  it('holds a wandering flight (NO-GO recorded, zero spend) and feeds it back', async () => {
    const pot = await makePot()
    const r = await post(pot, '/api/flights', dispatchBody('g', { ...healthySignals, progressPerStep: 0.1, wastePerStep: 0.7 }))
    expect(r.status).toBe(200) // recorded hold, not an error
    const d = (await r.json()) as { id: string; go: boolean; reasons: string[] }
    expect(d.go).toBe(false)
    expect(d.reasons).toContain('would_wander')
    expect(pot.flights.get(d.id)!.status).toBe('held')
  })

  it('fails a flight and the failure reaches the outcome feed', async () => {
    const pot = await makePot()
    const d = (await (await post(pot, '/api/flights', dispatchBody('g'))).json()) as { id: string }
    const r = await post(pot, `/api/flights/${d.id}/fail`, JSON.stringify({ reason: 'tool exploded' }))
    expect(((await r.json()) as { status: string }).status).toBe('failed')
    const feed = await pot.app.request('/api/flights?status=failed', { headers: auth(BRAIN_TOKEN) }, pot.env)
    const body = (await feed.json()) as { flights: Array<{ id: string }> }
    expect(body.flights.map((f) => f.id)).toEqual([d.id])
  })

  it('rejects an incomplete signal set at the door (absent ≠ zero)', async () => {
    const pot = await makePot()
    const { recentProgress: _drop, ...partial } = healthySignals
    const r = await post(pot, '/api/flights', JSON.stringify({ agent: 'kasra', goal: 'g', signals: partial }))
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('signals_incomplete:recentProgress')
  })

  it('blows the dispatch fuse: creation past the hourly cap → 429, no row written', async () => {
    const pot = await makePot('digid', { FLIGHT_MAX_DISPATCH_HOUR: '2' } as Partial<Env>)
    expect((await post(pot, '/api/flights', dispatchBody('one'))).status).toBe(201)
    expect((await post(pot, '/api/flights', dispatchBody('two'))).status).toBe(201)
    const r3 = await post(pot, '/api/flights', dispatchBody('three'))
    expect(r3.status).toBe(429)
    expect(r3.headers.get('retry-after')).toBe('3600')
    expect(pot.flights.size).toBe(2) // the fuse fired before any row was written
  })
})

describe('trust friction: the pot grounds an agent that keeps crashing', () => {
  it('three failed flights on the books → next dispatch is held with agent_unreliable, despite glowing caller signals', async () => {
    const pot = await makePot('digid', { FLIGHT_MAX_DISPATCH_HOUR: '100' } as Partial<Env>)
    for (let i = 0; i < 3; i++) {
      const d = (await (await post(pot, '/api/flights', dispatchBody(`try ${i}`))).json()) as { id: string }
      await post(pot, `/api/flights/${d.id}/fail`, JSON.stringify({ reason: 'crashed' }))
    }
    // The caller (brain) sends perfect signals — the pot's own books override them.
    const r = await post(pot, '/api/flights', dispatchBody('try again'))
    expect(r.status).toBe(200) // recorded hold
    const d = (await r.json()) as { go: boolean; reasons: string[] }
    expect(d.go).toBe(false)
    expect(d.reasons).toContain('agent_unreliable')
  })

  it('a clean record keeps flying: landings do not ground the agent', async () => {
    const pot = await makePot('digid', { FLIGHT_MAX_DISPATCH_HOUR: '100' } as Partial<Env>)
    for (let i = 0; i < 3; i++) {
      const d = (await (await post(pot, '/api/flights', dispatchBody(`ok ${i}`))).json()) as { id: string }
      await post(pot, `/api/flights/${d.id}/land`, JSON.stringify({ cost_micro_usd: 0 }))
    }
    const r = await post(pot, '/api/flights', dispatchBody('next'))
    expect(r.status).toBe(201)
  })
})
