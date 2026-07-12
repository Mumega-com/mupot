import { describe, it, expect } from 'vitest'
import {
  createFlight,
  applyPreflight,
  landFlight,
  failFlight,
  sleepFlight,
  getFlight,
  listFlights,
} from '../src/flight/service'
import * as flightService from '../src/flight/service'
import type { FlightRow, FlightStatus } from '../src/flight/service'
import { dispatchFlight } from '../src/flight/dispatch'
import type { Env } from '../src/types'
import type { PreflightResult } from '../src/flight/preflight'
import type { FlightSignals } from '../src/flight/preflight'

// ── tiny in-memory D1 mock that understands the flight lifecycle ──────────────
// Recognizes each service query by a unique substring and applies the known
// transition guard. Arg order matches the service binds (we own both sides).
function makeEnv(tenant = 'digid'): { env: Env; rows: Map<string, FlightRow> } {
  const rows = new Map<string, FlightRow>()
  const guarded = (id: string, t: string, from: FlightStatus[], apply: (r: FlightRow) => void) => {
    const r = rows.get(id)
    if (r && r.tenant === t && from.includes(r.status)) apply(r)
  }
  const env = {
    TENANT_SLUG: tenant,
    DB: {
      prepare(sql: string) {
        return {
          bind(...a: unknown[]) {
            return {
              async run() {
                if (sql.includes('INSERT INTO flights')) {
                  const [id, t, agent, goal, trig, budget, meta] = a as [
                    string, string, string, string, string, number | null, string,
                  ]
                  rows.set(id, {
                    id, tenant: t, agent, goal, status: 'preflight', trigger_source: trig as FlightRow['trigger_source'],
                    gate_verdict: null, gate_reason: '', score: null, budget_micro_usd: budget,
                    cost_micro_usd: 0, next_run_at: null, created_at: rows.size + 1, started_at: null,
                    ended_at: null, meta,
                  })
                } else if (sql.includes("status='running', gate_verdict='go'")) {
                  const [id, t, score, started] = a as [string, string, number, number]
                  guarded(id, t, ['preflight'], (r) => { r.status = 'running'; r.gate_verdict = 'go'; r.score = score; r.started_at = started })
                } else if (sql.includes("status='held'")) {
                  const [id, t, reason, score, ended] = a as [string, string, string, number, number]
                  guarded(id, t, ['preflight'], (r) => { r.status = 'held'; r.gate_verdict = 'no_go'; r.gate_reason = reason; r.score = score; r.ended_at = ended })
                } else if (sql.includes("status='landed'")) {
                  const [id, t, cost, score, ended] = a as [string, string, number, number | null, number]
                  guarded(id, t, ['running', 'waiting', 'sleeping'], (r) => { r.status = 'landed'; r.cost_micro_usd = cost; if (score != null) r.score = score; r.ended_at = ended })
                } else if (sql.includes("status='failed'")) {
                  const [id, t, reason, ended] = a as [string, string, string, number]
                  guarded(id, t, ['preflight', 'running', 'waiting', 'sleeping'], (r) => { r.status = 'failed'; r.gate_reason = reason; r.ended_at = ended })
                } else if (sql.includes("status='sleeping'")) {
                  const [id, t, next] = a as [string, string, number]
                  guarded(id, t, ['running', 'waiting'], (r) => { r.status = 'sleeping'; r.next_run_at = next })
                }
                return { success: true }
              },
              async first<T>() {
                const [id, t] = a as [string, string]
                const r = rows.get(id)
                return (r && r.tenant === t ? (r as unknown as T) : null)
              },
              async all<T>() {
                const [t] = a as [string]
                let out = [...rows.values()].filter((r) => r.tenant === t).sort((x, y) => y.created_at - x.created_at)
                if (sql.includes('json_each')) {
                  const squadId = a[1] as string
                  const beforeAt = a[2] as number
                  const beforeId = a[4] as string
                  const limit = a[5] as number
                  out = out.filter((r) => {
                    try {
                      const parsed = JSON.parse(r.meta) as { squad_ids?: string[] }
                      return parsed.squad_ids?.includes(squadId) ?? false
                    } catch {
                      return false
                    }
                  }).filter((r) => r.created_at < beforeAt || (r.created_at === beforeAt && r.id < beforeId))
                    .sort((x, y) => y.created_at - x.created_at || y.id.localeCompare(x.id))
                    .slice(0, limit)
                }
                return { results: out as unknown as T[] }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
  return { env, rows }
}

const GO: PreflightResult = { go: true, score: 0.82, checks: {} as never, reasons: [] }
const NOGO: PreflightResult = { go: false, score: 0.2, checks: {} as never, reasons: ['would_wander', 'cache_would_cool'] }

describe('createFlight', () => {
  it('creates a flight in preflight', async () => {
    const { env } = makeEnv()
    const id = await createFlight(env, { agent: 'kasra', goal: 'ship X', budget_micro_usd: 1_000_000 })
    const f = await getFlight(env, id)
    expect(f?.status).toBe('preflight')
    expect(f?.agent).toBe('kasra')
    expect(f?.budget_micro_usd).toBe(1_000_000)
  })
})

describe('listFlightsForSquad', () => {
  it('filters by squad before applying the result limit', async () => {
    const listForSquad = (flightService as Record<string, unknown>).listFlightsForSquad as
      | ((env: Env, squadId: string, limit?: number, before?: { createdAt: number; id: string }) => Promise<FlightRow[]>)
      | undefined
    expect(typeof listForSquad).toBe('function')
    if (!listForSquad) return

    const { env } = makeEnv()
    const flightMeta = (squadId: string) => ({
      schema: 'mupot.flight.meta/v1' as const,
      goal_id: 'goal', objective_id: 'objective', squad_ids: [squadId], task_ids: ['task'],
      done_when: ['verified'], artifact_refs: [], receipt_refs: [], confidentiality: 'internal' as const,
      publication_target: 'none' as const, parent_flight_id: null,
    })
    const targetId = await createFlight(env, { agent: 'target', goal: 'target', meta: flightMeta('squad-target') })
    for (let i = 0; i < 501; i += 1) {
      await createFlight(env, { agent: `other-${i}`, goal: 'other', meta: flightMeta('squad-other') })
    }

    const result = await listForSquad(env, 'squad-target', 10)
    expect(result.map((flight) => flight.id)).toEqual([targetId])
  })

  it('continues before a stable created-at and id cursor', async () => {
    const listForSquad = (flightService as Record<string, unknown>).listFlightsForSquad as
      | ((env: Env, squadId: string, limit?: number, before?: { createdAt: number; id: string }) => Promise<FlightRow[]>)
      | undefined
    expect(typeof listForSquad).toBe('function')
    if (!listForSquad) return
    const { env } = makeEnv()
    const flightMeta = {
      schema: 'mupot.flight.meta/v1' as const, goal_id: 'goal', objective_id: 'objective',
      squad_ids: ['squad-target'], task_ids: ['task'], done_when: ['verified'], artifact_refs: [],
      receipt_refs: [], confidentiality: 'internal' as const, publication_target: 'none' as const,
      parent_flight_id: null,
    }
    const oldest = await createFlight(env, { agent: 'a', goal: 'oldest', meta: flightMeta })
    await createFlight(env, { agent: 'a', goal: 'middle', meta: flightMeta })
    await createFlight(env, { agent: 'a', goal: 'newest', meta: flightMeta })

    const first = await listForSquad(env, 'squad-target', 2)
    const second = await listForSquad(env, 'squad-target', 2, {
      createdAt: first[1].created_at,
      id: first[1].id,
    })
    expect(second.map((flight) => flight.id)).toEqual([oldest])
  })
})

describe('applyPreflight', () => {
  it('GO → running, verdict go, score set', async () => {
    const { env } = makeEnv()
    const id = await createFlight(env, { agent: 'kasra', goal: 'g' })
    expect(await applyPreflight(env, id, GO)).toBe('running')
    const f = await getFlight(env, id)
    expect(f?.status).toBe('running')
    expect(f?.gate_verdict).toBe('go')
    expect(f?.started_at).toBeGreaterThan(0)
  })
  it('NO-GO → held, reasons joined, no spend', async () => {
    const { env } = makeEnv()
    const id = await createFlight(env, { agent: 'kasra', goal: 'g' })
    expect(await applyPreflight(env, id, NOGO)).toBe('held')
    const f = await getFlight(env, id)
    expect(f?.status).toBe('held')
    expect(f?.gate_reason).toBe('would_wander,cache_would_cool')
  })
})

describe('land / fail / sleep + terminal guards', () => {
  it('lands a running flight with cost', async () => {
    const { env } = makeEnv()
    const id = await createFlight(env, { agent: 'kasra', goal: 'g' })
    await applyPreflight(env, id, GO)
    await landFlight(env, id, { cost_micro_usd: 42_000, score: 0.9 })
    const f = await getFlight(env, id)
    expect(f?.status).toBe('landed')
    expect(f?.cost_micro_usd).toBe(42_000)
    expect(f?.score).toBe(0.9)
  })
  it('cannot land a held flight (terminal guard)', async () => {
    const { env } = makeEnv()
    const id = await createFlight(env, { agent: 'kasra', goal: 'g' })
    await applyPreflight(env, id, NOGO) // held
    await landFlight(env, id, { cost_micro_usd: 1 })
    expect((await getFlight(env, id))?.status).toBe('held') // unchanged
  })
  it('sleep then land', async () => {
    const { env } = makeEnv()
    const id = await createFlight(env, { agent: 'kasra', goal: 'g' })
    await applyPreflight(env, id, GO)
    await sleepFlight(env, id, 1_780_000_000_000)
    let f = await getFlight(env, id)
    expect(f?.status).toBe('sleeping')
    expect(f?.next_run_at).toBe(1_780_000_000_000)
    await landFlight(env, id, { cost_micro_usd: 10 })
    f = await getFlight(env, id)
    expect(f?.status).toBe('landed')
  })
  it('fails a running flight', async () => {
    const { env } = makeEnv()
    const id = await createFlight(env, { agent: 'kasra', goal: 'g' })
    await applyPreflight(env, id, GO)
    await failFlight(env, id, 'tool exploded')
    expect((await getFlight(env, id))?.status).toBe('failed')
  })
})

describe('tenant scoping', () => {
  it('another tenant cannot read or mutate the flight', async () => {
    const { env } = makeEnv('digid')
    const id = await createFlight(env, { agent: 'kasra', goal: 'g' })
    const other = { ...env, TENANT_SLUG: 'viamar' } as Env
    expect(await getFlight(other, id)).toBeNull()
    await applyPreflight(other, id, GO) // wrong tenant → no-op
    expect((await getFlight(env, id))?.status).toBe('preflight')
  })
  it('listFlights is tenant-scoped + newest-first', async () => {
    const { env } = makeEnv('digid')
    await createFlight(env, { agent: 'a', goal: 'one' })
    await createFlight(env, { agent: 'b', goal: 'two' })
    const list = await listFlights(env)
    expect(list).toHaveLength(2)
    expect(list[0].goal).toBe('two') // newest first
  })
})

describe('dispatchFlight (end to end)', () => {
  const healthy: FlightSignals = {
    contextComplete: true, toolsReachable: true,
    budgetRemainingMicroUsd: 5_000_000, budgetEstimateMicroUsd: 1_000_000,
    recentProgress: 0.8, progressPerStep: 0.7, wastePerStep: 0.2, stepSeconds: 60,
  }
  it('healthy signals → GO + running flight recorded', async () => {
    const { env } = makeEnv()
    const r = await dispatchFlight(env, { agent: 'kasra', goal: 'g' }, healthy)
    expect(r.go).toBe(true)
    expect(r.status).toBe('running')
    expect((await getFlight(env, r.id))?.status).toBe('running')
  })
  it('would-wander signals → NO-GO + held flight, no spend', async () => {
    const { env } = makeEnv()
    const r = await dispatchFlight(env, { agent: 'kasra', goal: 'g' }, { ...healthy, progressPerStep: 0.1, wastePerStep: 0.7 })
    expect(r.go).toBe(false)
    expect(r.status).toBe('held')
    expect(r.reasons).toContain('would_wander')
    expect((await getFlight(env, r.id))?.status).toBe('held')
  })
})
