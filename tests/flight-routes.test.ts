import { describe, it, expect } from 'vitest'
import { flightsApp, parseDispatchBody, parseOutcomeQuery } from '../src/flight/routes'
import type { Env } from '../src/types'
import type { FlightRow } from '../src/flight/service'

const goodSignals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 1_000_000,
  budgetEstimateMicroUsd: 200_000,
  recentProgress: 0.8,
  progressPerStep: 0.5,
  wastePerStep: 0.1,
  stepSeconds: 20,
}

const goodMeta = {
  schema: 'mupot.flight.meta/v1',
  goal_id: 'mumega-tenant-zero',
  objective_id: 'm000-constitution-census',
  squad_ids: ['squad-mmhq'],
  task_ids: ['task-m000'],
  done_when: ['the census hash verifies'],
  artifact_refs: [],
  receipt_refs: [],
  confidentiality: 'internal',
  publication_target: 'none',
  parent_flight_id: null,
}

describe('parseDispatchBody', () => {
  it('accepts a full body + defaults trigger to api', () => {
    const r = parseDispatchBody({ agent: 'opus', goal: 'fix the loop', signals: goodSignals })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.flight.agent).toBe('opus')
    expect(r.value.flight.trigger_source).toBe('api')
    expect(r.value.signals.budgetRemainingMicroUsd).toBe(1_000_000)
  })

  it('rejects a non-object body', () => {
    expect(parseDispatchBody(null)).toEqual({ ok: false, error: 'body_required' })
    expect(parseDispatchBody('x')).toEqual({ ok: false, error: 'body_required' })
  })

  it('requires agent + goal', () => {
    expect(parseDispatchBody({ goal: 'g', signals: goodSignals })).toEqual({ ok: false, error: 'agent_required' })
    expect(parseDispatchBody({ agent: 'a', signals: goodSignals })).toEqual({ ok: false, error: 'goal_required' })
  })

  it('rejects a missing signal block (never defaults to a launch)', () => {
    expect(parseDispatchBody({ agent: 'a', goal: 'g' })).toEqual({ ok: false, error: 'signals_required' })
  })

  it('coerces bad signal types safely (NaN/string → fail-closed numbers, non-true → false)', () => {
    const r = parseDispatchBody({
      agent: 'a',
      goal: 'g',
      signals: { ...goodSignals, contextComplete: 'yes', budgetRemainingMicroUsd: 'lots', recentProgress: 5 },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.signals.contextComplete).toBe(false) // only literal true counts
    expect(r.value.signals.budgetRemainingMicroUsd).toBe(0) // string → fallback
    expect(r.value.signals.recentProgress).toBe(1) // clamped 0..1
  })

  it('keeps a known trigger_source + clamps negative budget to 0', () => {
    const r = parseDispatchBody({ agent: 'a', goal: 'g', trigger_source: 'cron', budget_micro_usd: -50, signals: goodSignals })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.flight.trigger_source).toBe('cron')
    expect(r.value.flight.budget_micro_usd).toBe(0)
  })

  it('passes through opts only when present + clamps them', () => {
    const r = parseDispatchBody({ agent: 'a', goal: 'g', signals: goodSignals, opts: { scoreThreshold: 2, cacheWindowSeconds: 120 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.opts.scoreThreshold).toBe(1) // clamped 0..1
    expect(r.value.opts.cacheWindowSeconds).toBe(120)
    expect(r.value.opts.minProgressRatio).toBeUndefined()
  })

  it('preserves valid v1 metadata on the flight record', () => {
    const r = parseDispatchBody({ agent: 'a', goal: 'g', signals: goodSignals, meta: goodMeta })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.flight.meta).toEqual(goodMeta)
  })

  it('rejects malformed or unknown flight metadata', () => {
    expect(parseDispatchBody({ agent: 'a', goal: 'g', signals: goodSignals, meta: { ...goodMeta, task_ids: [] } }))
      .toEqual({ ok: false, error: 'invalid_flight_meta' })
    expect(parseDispatchBody({ agent: 'a', goal: 'g', signals: goodSignals, meta: { ...goodMeta, hidden: 'data' } }))
      .toEqual({ ok: false, error: 'invalid_flight_meta' })
    expect(parseDispatchBody({
      agent: 'a', goal: 'g', signals: goodSignals,
      meta: { ...goodMeta, squad_ids: Array.from({ length: 9 }, (_, index) => `squad-${index}`) },
    })).toEqual({ ok: false, error: 'invalid_flight_meta' })
  })
})

describe('parseOutcomeQuery', () => {
  it('parses a status csv, dropping unknown statuses', () => {
    const q = parseOutcomeQuery(new URLSearchParams('status=landed,failed,bogus'))
    expect(q.statuses).toEqual(['landed', 'failed'])
  })
  it('null statuses when none valid → all', () => {
    expect(parseOutcomeQuery(new URLSearchParams('status=bogus')).statuses).toBeNull()
    expect(parseOutcomeQuery(new URLSearchParams('')).statuses).toBeNull()
  })
  it('parses since cursor + clamps limit', () => {
    const q = parseOutcomeQuery(new URLSearchParams('since=1700000000000&limit=9999'))
    expect(q.sinceMs).toBe(1_700_000_000_000)
    expect(q.limit).toBe(500)
  })
  it('ignores a non-positive/garbage since, defaults limit', () => {
    const q = parseOutcomeQuery(new URLSearchParams('since=-5'))
    expect(q.sinceMs).toBeNull()
    expect(q.limit).toBe(200)
  })
})

describe('REST flight dispatch reference integrity', () => {
  it('rejects missing metadata references before inserting a flight', async () => {
    const env = {
      TENANT_SLUG: 'test',
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                async first() {
                  if (sql.includes('FROM member_tokens')) {
                    return { member_id: 'admin-1', display_name: 'Admin', email: null, status: 'active', bound_agent_id: null }
                  }
                  if (sql.includes('SELECT id FROM squads')) return null
                  throw new Error(`unexpected first query: ${sql}`)
                },
                async all() {
                  if (sql.includes('FROM capabilities')) {
                    return { results: [{ member_id: 'admin-1', scope_type: 'org', scope_id: null, capability: 'admin' }] }
                  }
                  if (sql.includes('FROM squads WHERE id IN')) return { results: [] }
                  throw new Error(`unexpected all query: ${sql}`)
                },
                async run() {
                  throw new Error('flight insert must not run for invalid references')
                },
              }
            },
          }
        },
      },
    } as unknown as Env

    const response = await flightsApp.request('https://pot.example/', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'brain', goal: 'g', signals: goodSignals, meta: goodMeta }),
    }, env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'flight_squad_not_found' })
  })
})

function makeGovernedLandEnv(taskStatus: 'done' | 'review', verdict: 'approved' | 'rejected') {
  const flight: FlightRow = {
    id: 'flight-m000', tenant: 'test', agent: 'agent-product', goal: 'M000', status: 'running',
    trigger_source: 'api', gate_verdict: 'go', gate_reason: '', score: 0.9,
    budget_micro_usd: 0, cost_micro_usd: 0, next_run_at: null, created_at: 1,
    started_at: 1, ended_at: null, meta: JSON.stringify(goodMeta),
  }
  const events: unknown[] = []
  let outbox: {
    id: string; tenant: string; flight_id: string; event_type: 'flight.landed'; actor_kind: 'member' | 'agent';
    actor_id: string; payload: string; created_at: string; delivered_at: string | null; attempts: number; last_error: string | null
  } | null = null
  const env = {
    TENANT_SLUG: 'test',
    BUS: { async send(event: unknown) { events.push(event) } },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('FROM member_tokens')) {
                  return { member_id: 'admin-1', display_name: 'Admin', email: null, status: 'active', bound_agent_id: null } as T
                }
                if (sql.includes('SELECT * FROM flights WHERE id=')) {
                  return (flight.id === args[0] && flight.tenant === args[1] ? flight : null) as T | null
                }
                if (sql.includes('FROM flight_event_outbox')) return outbox as T | null
                return null
              },
              async all<T>() {
                if (sql.includes('FROM capabilities')) {
                  return { results: [{ member_id: 'admin-1', scope_type: 'org', scope_id: null, capability: 'admin' }] as T[] }
                }
                if (sql.includes('SELECT id, status') && sql.includes('FROM tasks WHERE id IN')) {
                  return { results: [{
                    id: 'task-m000', status: taskStatus, gate_owner: 'gate:m0-census', latest_verdict: verdict,
                  }] as T[] }
                }
                return { results: [] as T[] }
              },
              async run() {
                let changes = 0
                if (sql.includes('INSERT INTO flight_event_outbox')) {
                  const [id, tenant, flightId, actorKind, actorId, payload, createdAt, endedAt] = args as [
                    string, string, string, 'member' | 'agent', string, string, string, number,
                  ]
                  if (flight.id === flightId && flight.status === 'landed' && flight.ended_at === endedAt) {
                    outbox = {
                      id, tenant, flight_id: flightId, event_type: 'flight.landed', actor_kind: actorKind,
                      actor_id: actorId, payload, created_at: createdAt, delivered_at: null, attempts: 0, last_error: null,
                    }
                    changes = 1
                  }
                } else if (sql.includes('delivered_at = ?3') && outbox) {
                  outbox.delivered_at = args[2] as string
                  outbox.attempts += 1
                  changes = 1
                } else if (
                  sql.includes('json_each(flights.meta')
                  && flight.status === 'running'
                  && taskStatus === 'done'
                  && verdict === 'approved'
                  && (args[3] as number) <= (flight.budget_micro_usd ?? -1)
                ) {
                  flight.status = 'landed'
                  flight.cost_micro_usd = args[3] as number
                  flight.score = (args[4] as number | null) ?? flight.score
                  flight.ended_at = args[5] as number
                  changes = 1
                }
                return { meta: { changes } }
              },
            }
          },
        }
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()))
      },
    },
  } as unknown as Env
  return { env, flight, events }
}

describe('REST governed flight landing parity', () => {
  it('lands approved completed work and emits an attributed terminal event', async () => {
    const { env, flight, events } = makeGovernedLandEnv('done', 'approved')
    const response = await flightsApp.request('https://pot.example/flight-m000/land', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ score: 0.97 }),
    }, env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, id: 'flight-m000', status: 'landed' })
    expect(flight.cost_micro_usd).toBe(0)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'flight.landed', actor: { kind: 'member', id: 'admin-1' }, agent_id: 'agent-product',
    }))
  })

  it('refuses rejected gated work even when the task is marked done', async () => {
    const { env, flight } = makeGovernedLandEnv('done', 'rejected')
    const response = await flightsApp.request('https://pot.example/flight-m000/land', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ cost_micro_usd: 0 }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: 'flight_tasks_incomplete', task_ids: ['task-m000'] })
    expect(flight.status).toBe('running')
  })

  it('refuses reported cost above the declared budget', async () => {
    const { env, flight } = makeGovernedLandEnv('done', 'approved')
    const response = await flightsApp.request('https://pot.example/flight-m000/land', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ cost_micro_usd: 1 }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'flight_budget_exceeded', budget_micro_usd: 0 })
    expect(flight.status).toBe('running')
  })
})
