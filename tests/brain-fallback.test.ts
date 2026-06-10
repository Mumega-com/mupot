// tests/brain-fallback.test.ts — the fallback brain tick: the pot-side coherence loop.
//
// Drives runFallbackBrainTick against an in-memory pot (agents + tasks + flights +
// agent_field + meter) and asserts the loop's behaviors: opt-in gating, deferral to a
// fresh mind, measure → mirror (provenance-guarded), defect → ONE gated dispatch with
// a real goal, the per-tick cap, and the sweep that lands a finished correction with
// POT-METERED cost.

import { describe, it, expect } from 'vitest'
import { runFallbackBrainTick, MIND_FRESH_MS, FLIGHT_BUDGET_MICRO_USD } from '../src/brain/fallback'
import type { FlightRow } from '../src/flight/service'
import type { Env } from '../src/types'

interface AgentSeed {
  id: string
  slug: string
  budget_cap_cents?: number | null
}
interface TaskSeed {
  id: string
  assignee_agent_id: string
  status: string
  title: string
  created_at: string // ISO
  updated_at: string // ISO
}
interface FieldRow {
  agent_id: string
  coherence: number | null
  regime: string | null
  field_updated_at: number
  source: string
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString()
}

const DAY = 24 * 60 * 60 * 1000

function makePot(seed: {
  agents?: AgentSeed[]
  tasks?: TaskSeed[]
  flights?: Partial<FlightRow>[]
  field?: FieldRow[]
  meterCost?: number // today's metered cost for any agent
  vars?: Partial<Env>
}) {
  const agents = seed.agents ?? []
  const tasks = new Map((seed.tasks ?? []).map((t) => [t.id, { ...t }]))
  const flights = new Map<string, FlightRow>()
  const field = new Map((seed.field ?? []).map((f) => [f.agent_id, { ...f }]))
  let meterCost = seed.meterCost ?? 0
  let createSeq = 0
  for (const [i, f] of (seed.flights ?? []).entries()) {
    const row: FlightRow = {
      id: f.id ?? `seed-${i}`,
      tenant: 'digid',
      agent: f.agent ?? 'a1',
      goal: f.goal ?? 'seed',
      status: f.status ?? 'landed',
      trigger_source: 'cron',
      gate_verdict: null,
      gate_reason: '',
      score: null,
      budget_micro_usd: null,
      cost_micro_usd: f.cost_micro_usd ?? 0,
      next_run_at: null,
      created_at: f.created_at ?? Date.now() - 1000,
      started_at: f.started_at ?? null,
      ended_at: f.ended_at ?? Date.now() - 1000,
      meta: f.meta ?? '{}',
    }
    flights.set(row.id, row)
  }

  const guarded = (id: string, t: string, from: string[], apply: (r: FlightRow) => void) => {
    const r = flights.get(id)
    if (r && r.tenant === t && from.includes(r.status)) apply(r)
  }

  const env = {
    TENANT_SLUG: 'digid',
    BRAIN_FALLBACK: 'on',
    ...(seed.vars ?? {}),
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
                } else if (sql.includes('INSERT INTO agent_field')) {
                  // mirrorField upsert with the provenance guard
                  const [_t, agentId, coherence, regime, updatedAt, freshBar] = a as [string, string, number, string, number, number]
                  const existing = field.get(agentId)
                  if (!existing) {
                    field.set(agentId, { agent_id: agentId, coherence, regime, field_updated_at: updatedAt, source: 'pot_fallback' })
                  } else if (existing.source !== 'mind' || existing.field_updated_at < freshBar) {
                    field.set(agentId, { agent_id: agentId, coherence, regime, field_updated_at: updatedAt, source: 'pot_fallback' })
                  }
                }
                return { success: true }
              },
              async first<T>(): Promise<T | null> {
                if (sql.includes('FROM agent_field')) {
                  const [, since] = a as [string, number]
                  let n = 0
                  for (const f of field.values()) if (f.source === 'mind' && f.field_updated_at >= since) n++
                  return { n } as unknown as T
                }
                if (sql.includes('SUM(cost_micro_usd)')) {
                  return { c: meterCost } as unknown as T
                }
                if (sql.includes('MAX(updated_at) AS last FROM tasks')) {
                  const [agentId] = a as [string]
                  const mine = [...tasks.values()].filter(
                    (t) => t.assignee_agent_id === agentId && ['open', 'in_progress', 'blocked'].includes(t.status),
                  )
                  const last = mine.map((t) => t.updated_at).sort().pop() ?? null
                  return { n: mine.length, last } as unknown as T
                }
                if (sql.includes("status='open' ORDER BY created_at")) {
                  const [agentId] = a as [string]
                  const open = [...tasks.values()]
                    .filter((t) => t.assignee_agent_id === agentId && t.status === 'open')
                    .sort((x, y) => x.created_at.localeCompare(y.created_at))
                  return (open[0] ? ({ id: open[0].id, title: open[0].title } as unknown as T) : null)
                }
                if (sql.includes('SELECT status FROM tasks WHERE id')) {
                  const [id] = a as [string]
                  const t = tasks.get(id)
                  return (t ? ({ status: t.status } as unknown as T) : null)
                }
                if (sql.includes("status IN ('preflight','running','waiting','sleeping')")) {
                  const [t, agent] = a as [string, string]
                  let n = 0
                  for (const f of flights.values()) {
                    if (f.tenant === t && f.agent === agent && ['preflight', 'running', 'waiting', 'sleeping'].includes(f.status)) n++
                  }
                  return { n } as unknown as T
                }
                return null
              },
              async all<T>() {
                if (sql.includes("FROM agents WHERE status='active'")) {
                  return { results: agents.map((x) => ({ budget_cap_cents: null, ...x })) as unknown as T[] }
                }
                if (sql.includes("IN ('landed','failed')")) {
                  const [t, agent] = a as [string, string]
                  const out = [...flights.values()]
                    .filter((f) => f.tenant === t && f.agent === agent && (f.status === 'landed' || f.status === 'failed'))
                    .sort((x, y) => (y.ended_at ?? 0) - (x.ended_at ?? 0))
                    .slice(0, 10)
                    .map((f) => ({ status: f.status, ended_at: f.ended_at }))
                  return { results: out as unknown as T[] }
                }
                if (sql.includes('FROM flights WHERE tenant')) {
                  const [t] = a as [string]
                  const out = [...flights.values()].filter((f) => f.tenant === t).sort((x, y) => y.created_at - x.created_at)
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

  return { env, flights, field, tasks, setMeter: (v: number) => { meterCost = v } }
}

// An agent with a stalled backlog: one open task, untouched for two days, no flights.
const stalledAgent = () => ({
  agents: [{ id: 'a1', slug: 'kasra' }],
  tasks: [
    { id: 't1', assignee_agent_id: 'a1', status: 'open', title: 'write the digest', created_at: iso(3 * DAY), updated_at: iso(2 * DAY) },
  ],
})

describe('runFallbackBrainTick — gating', () => {
  it('does nothing unless BRAIN_FALLBACK="on" (it tees up spend)', async () => {
    const pot = makePot({ ...stalledAgent(), vars: { BRAIN_FALLBACK: undefined } })
    const r = await runFallbackBrainTick(pot.env)
    expect(r).toMatchObject({ ran: false, reason: 'disabled' })
    expect(pot.flights.size).toBe(0)
  })
  it('defers to a fresh mind push — the real brain flies this pot', async () => {
    const pot = makePot({
      ...stalledAgent(),
      field: [{ agent_id: 'a1', coherence: 0.9, regime: 'flow', field_updated_at: Date.now() - 1000, source: 'mind' }],
    })
    const r = await runFallbackBrainTick(pot.env)
    expect(r).toMatchObject({ ran: false, reason: 'mind_awake' })
    expect(pot.flights.size).toBe(0)
  })
  it('a STALE mind push does not block — the fallback takes over', async () => {
    const pot = makePot({
      ...stalledAgent(),
      field: [{ agent_id: 'a1', coherence: 0.9, regime: 'flow', field_updated_at: Date.now() - MIND_FRESH_MS - 1000, source: 'mind' }],
    })
    const r = await runFallbackBrainTick(pot.env)
    expect(r.ran).toBe(true)
  })
})

describe('runFallbackBrainTick — measure → mirror → correct', () => {
  it('stalled backlog → stall measured into agent_field (pot_fallback) → ONE gated flight on the oldest open task', async () => {
    const pot = makePot(stalledAgent())
    const r = await runFallbackBrainTick(pot.env)
    expect(r.ran).toBe(true)
    expect(r.measured).toBe(1)
    expect(r.dispatched).toHaveLength(1)

    const mirrored = pot.field.get('a1')!
    expect(mirrored.source).toBe('pot_fallback')
    expect(mirrored.regime).toBe('stall')

    const flight = pot.flights.get(r.dispatched[0])!
    expect(flight.status).toBe('running') // the gate said GO
    expect(flight.agent).toBe('a1') // agents.id = the meter identity
    expect(flight.goal).toBe('[fallback stall] write the digest')
    expect(flight.budget_micro_usd).toBe(FLIGHT_BUDGET_MICRO_USD)
    const meta = JSON.parse(flight.meta)
    expect(meta.brain).toBe('pot_fallback')
    expect(meta.work_task_id).toBe('t1')
  })

  it('an agent in flow is measured but never corrected', async () => {
    const pot = makePot({
      agents: [{ id: 'a1', slug: 'kasra' }],
      tasks: [{ id: 't1', assignee_agent_id: 'a1', status: 'open', title: 'x', created_at: iso(DAY), updated_at: iso(60_000) }], // touched a minute ago
    })
    const r = await runFallbackBrainTick(pot.env)
    expect(r.measured).toBe(1)
    expect(r.dispatched).toHaveLength(0)
    expect(pot.field.get('a1')!.regime).toBe('flow')
  })

  it('a defect with no open task is skipped — a correction needs a goal', async () => {
    const pot = makePot({
      agents: [{ id: 'a1', slug: 'kasra' }],
      tasks: [{ id: 't1', assignee_agent_id: 'a1', status: 'in_progress', title: 'x', created_at: iso(3 * DAY), updated_at: iso(2 * DAY) }],
    })
    const r = await runFallbackBrainTick(pot.env)
    expect(r.dispatched).toHaveLength(0)
    expect(r.skipped).toContainEqual({ agent: 'a1', reason: 'no_goal' })
  })

  it('one correction in the air per agent — no pile-ups', async () => {
    const pot = makePot({
      ...stalledAgent(),
      flights: [{ id: 'f-air', agent: 'a1', status: 'running', meta: '{"brain":"pot_fallback","work_task_id":"t-other"}', created_at: Date.now() - 1000, ended_at: null }],
    })
    // keep the in-air flight from being swept: its task is still in_progress
    // (updated well past the stall bar so the agent still reads as stalled)
    pot.tasks.set('t-other', { id: 't-other', assignee_agent_id: 'a1', status: 'in_progress', title: 'y', created_at: iso(2 * DAY), updated_at: iso(2 * DAY) })
    const r = await runFallbackBrainTick(pot.env)
    expect(r.dispatched).toHaveLength(0)
    expect(r.skipped).toContainEqual({ agent: 'a1', reason: 'already_flying' })
  })

  it('chaos (crashing history) → the trust friction HOLDS the flight; the hold is the verdict', async () => {
    const ended = Array.from({ length: 5 }, (_, i) => ({
      id: `f${i}`, agent: 'a1', status: 'failed' as const, ended_at: Date.now() - (i + 1) * 60_000, created_at: Date.now() - (i + 2) * 60_000,
    }))
    const pot = makePot({ ...stalledAgent(), flights: ended })
    const r = await runFallbackBrainTick(pot.env)
    expect(pot.field.get('a1')!.regime).toBe('chaos')
    expect(r.dispatched).toHaveLength(0)
    const skip = r.skipped.find((s) => s.agent === 'a1')!
    expect(skip.reason).toContain('held:')
    expect(skip.reason).toContain('agent_unreliable')
    // the held flight is durably on the books — the board shows the grounding
    const held = [...pot.flights.values()].find((f) => f.status === 'held')
    expect(held).toBeDefined()
  })

  it('the per-tick dispatch cap holds at 3', async () => {
    const agents = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, slug: `s${i}` }))
    const tasks = agents.map((a, i) => ({
      id: `t${i}`, assignee_agent_id: a.id, status: 'open', title: `goal ${i}`, created_at: iso(3 * DAY), updated_at: iso(2 * DAY),
    }))
    const pot = makePot({ agents, tasks })
    const r = await runFallbackBrainTick(pot.env)
    expect(r.dispatched).toHaveLength(3)
    expect(r.skipped.filter((s) => s.reason === 'tick_dispatch_cap')).toHaveLength(2)
  })
})

describe('runFallbackBrainTick — the sweep (landing with pot-metered cost)', () => {
  const inAirFlight = (taskStatus: string, opts: Partial<FlightRow> = {}) => {
    const takeoffMeta = JSON.stringify({ brain: 'pot_fallback', work_task_id: 'tw', meter_takeoff: { at: Date.now() - 3_600_000, cost_micro_usd: 100_000 } })
    return makePot({
      agents: [], // nothing to measure — isolate the sweep
      tasks: [{ id: 'tw', assignee_agent_id: 'a1', status: taskStatus, title: 'work', created_at: iso(DAY), updated_at: iso(60_000) }],
      flights: [{ id: 'f-air', agent: 'a1', status: 'running', meta: takeoffMeta, created_at: Date.now() - 3_600_000, ended_at: null, ...opts }],
      meterCost: 100_000 + 250_000, // 250k µUSD metered since takeoff
    })
  }

  it('task done → landed, cost = the METERED delta (no self-report anywhere)', async () => {
    const pot = inAirFlight('done')
    const r = await runFallbackBrainTick(pot.env)
    expect(r.swept.landed).toBe(1)
    const f = pot.flights.get('f-air')!
    expect(f.status).toBe('landed')
    expect(f.cost_micro_usd).toBe(250_000)
  })
  it('task blocked → failed (task_blocked)', async () => {
    const pot = inAirFlight('blocked')
    const r = await runFallbackBrainTick(pot.env)
    expect(r.swept.failed).toBe(1)
    expect(pot.flights.get('f-air')!.gate_reason).toBe('task_blocked')
  })
  it('still open within the window → left flying', async () => {
    const pot = inAirFlight('in_progress')
    const r = await runFallbackBrainTick(pot.env)
    expect(r.swept).toEqual({ landed: 0, failed: 0 })
    expect(pot.flights.get('f-air')!.status).toBe('running')
  })
  it('open past the overdue window → failed (overdue)', async () => {
    const pot = inAirFlight('in_progress', { created_at: Date.now() - 25 * 60 * 60 * 1000 })
    const r = await runFallbackBrainTick(pot.env)
    expect(r.swept.failed).toBe(1)
    expect(pot.flights.get('f-air')!.gate_reason).toBe('overdue')
  })
  it('linked task vanished → failed (task_missing)', async () => {
    const pot = inAirFlight('done')
    pot.tasks.delete('tw')
    const r = await runFallbackBrainTick(pot.env)
    expect(r.swept.failed).toBe(1)
    expect(pot.flights.get('f-air')!.gate_reason).toBe('task_missing')
  })
})
