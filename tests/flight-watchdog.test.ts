// tests/flight-watchdog.test.ts — Unit & Mutation Tests for Flight Watchdog & Governed Reaper

import { describe, it, expect } from 'vitest'
import {
  evaluateFlightLiveness,
  canReapFlight,
  reapStalledFlight,
  DEFAULT_RUNNING_STALL_TIMEOUT_MS,
  DEFAULT_SLEEPING_STALL_TIMEOUT_MS,
  DEFAULT_WAITING_GATE_ESCALATION_TIMEOUT_MS,
} from '../src/flight/watchdog'
import type { FlightActor } from '../src/flight/watchdog'
import type { FlightRow, FlightStatus } from '../src/flight/service'
import type { Env } from '../src/types'

function makeMockFlight(overrides: Partial<FlightRow> = {}): FlightRow {
  return {
    id: 'fl-mock-12345678',
    tenant: 'digid',
    project_id: null,
    agent: 'agent-1111',
    dispatched_by_agent_id: 'agent-2222',
    goal: 'Test flight execution',
    status: 'running',
    trigger_source: 'api',
    gate_verdict: 'go',
    gate_reason: '',
    score: 1,
    budget_micro_usd: 0,
    cost_micro_usd: 0,
    next_run_at: null,
    created_at: 1_000_000,
    started_at: 1_000_000,
    ended_at: null,
    meta: JSON.stringify({
      schema: 'mupot.flight.meta/v1',
      squad_ids: ['squad-alpha'],
    }),
    ...overrides,
  }
}

function makeMockEnv(initialFlights: FlightRow[] = []) {
  const flights = new Map<string, FlightRow>()
  for (const f of initialFlights) flights.set(f.id, { ...f })
  const outbox: Array<Record<string, unknown>> = []

  const env: Env = {
    TENANT_SLUG: 'digid',
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (sql.includes('SELECT * FROM flights WHERE id=?1')) {
                  const [id, tenant] = args as [string, string]
                  const f = flights.get(id)
                  if (f && f.tenant === tenant) return { ...f } as unknown as T
                  return null
                }
                return null
              },
              async all<T>(): Promise<{ results: T[] }> {
                if (sql.includes('UPDATE flights')) {
                  const [id, tenant, gateReason, endedAt] = args as [string, string, string, number]
                  const f = flights.get(id)
                  if (f && f.tenant === tenant && ['preflight', 'running', 'sleeping'].includes(f.status)) {
                    f.status = 'failed'
                    f.gate_reason = gateReason
                    f.ended_at = endedAt
                    return { results: [{ id: f.id, status: f.status }] as unknown as T[] }
                  }
                  return { results: [] }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO flight_event_outbox')) {
                  const [id, tenant, flightId, actorKind, actorId, payload, createdAt] = args
                  outbox.push({ id, tenant, flightId, eventType: 'flight.reaped', actorKind, actorId, payload, createdAt })
                }
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    } as unknown as Env['DB'],
  } as Env

  return { env, flights, outbox }
}

describe('evaluateFlightLiveness Predicate', () => {
  const t0 = 1_000_000

  it('marks running flight under default 60m timeout as healthy', () => {
    const flight = makeMockFlight({ started_at: t0 })
    const nowMs = t0 + 15 * 60 * 1000 // 15 min
    const res = evaluateFlightLiveness(flight, nowMs)
    expect(res.action).toBe('healthy')
    expect(res.reason).toBe('running_in_progress')
    expect(res.ageMs).toBe(15 * 60 * 1000)
  })

  it('marks running flight exceeding default 60m timeout as reap', () => {
    const flight = makeMockFlight({ started_at: t0 })
    const nowMs = t0 + 61 * 60 * 1000 // 61 min
    const res = evaluateFlightLiveness(flight, nowMs)
    expect(res.action).toBe('reap')
    expect(res.reason).toBe('running_exceeded_timeout')
    expect(res.ageMs).toBe(61 * 60 * 1000)
    expect(res.timeoutMs).toBe(DEFAULT_RUNNING_STALL_TIMEOUT_MS)
  })

  it('honors custom meta.timeout_ms (e.g. 10 min)', () => {
    const flight = makeMockFlight({
      started_at: t0,
      meta: JSON.stringify({ timeout_ms: 10 * 60 * 1000 }),
    })
    // 8 min -> healthy
    expect(evaluateFlightLiveness(flight, t0 + 8 * 60 * 1000).action).toBe('healthy')
    // 11 min -> reap
    const res = evaluateFlightLiveness(flight, t0 + 11 * 60 * 1000)
    expect(res.action).toBe('reap')
    expect(res.timeoutMs).toBe(10 * 60 * 1000)
  })

  it('evaluates sleeping flight before wake deadline as healthy', () => {
    const flight = makeMockFlight({
      status: 'sleeping',
      next_run_at: t0 + 30 * 60 * 1000,
    })
    const res = evaluateFlightLiveness(flight, t0 + 10 * 60 * 1000)
    expect(res.action).toBe('healthy')
    expect(res.reason).toBe('sleeping_in_window')
  })

  it('evaluates sleeping flight >30m past wake deadline as reap', () => {
    const flight = makeMockFlight({
      status: 'sleeping',
      next_run_at: t0 + 10 * 60 * 1000,
    })
    const nowMs = t0 + 10 * 60 * 1000 + 31 * 60 * 1000 // 31 min past deadline
    const res = evaluateFlightLiveness(flight, nowMs)
    expect(res.action).toBe('reap')
    expect(res.reason).toBe('sleeping_missed_wake_deadline')
  })

  it('evaluates waiting gate flight under 24h as healthy', () => {
    const flight = makeMockFlight({ status: 'waiting', started_at: t0 })
    const res = evaluateFlightLiveness(flight, t0 + 4 * 3600 * 1000) // 4h
    expect(res.action).toBe('healthy')
    expect(res.reason).toBe('waiting_gate_active')
  })

  it('HARD INVARIANT: waiting gate flight over 24h marks ESCALATE, NEVER REAP', () => {
    const flight = makeMockFlight({ status: 'waiting', started_at: t0 })
    const nowMs = t0 + 25 * 3600 * 1000 // 25 hours
    const res = evaluateFlightLiveness(flight, nowMs)
    expect(res.action).toBe('escalate')
    expect(res.action).not.toBe('reap')
    expect(res.reason).toBe('waiting_gate_exceeded_24h')
  })

  it('treats terminal states (landed, failed, held) as healthy', () => {
    for (const status of ['landed', 'failed', 'held'] as FlightStatus[]) {
      const flight = makeMockFlight({ status, started_at: t0 })
      const res = evaluateFlightLiveness(flight, t0 + 100 * 3600 * 1000)
      expect(res.action).toBe('healthy')
      expect(res.reason).toBe('flight_terminal')
    }
  })
})

describe('canReapFlight Authorization', () => {
  const flight = makeMockFlight({
    agent: 'agent-flying',
    dispatched_by_agent_id: 'agent-dispatcher',
    meta: JSON.stringify({ squad_ids: ['squad-leadsquad'] }),
  })

  it('allows system watchdog principal', () => {
    expect(canReapFlight(flight, { actor: { kind: 'system', id: 'mupot-watchdog' } })).toBe(true)
  })

  it('allows org admin', () => {
    expect(canReapFlight(flight, { actor: { kind: 'member', id: 'some-user' }, isOrgAdmin: true })).toBe(true)
  })

  it('allows flight dispatcher', () => {
    expect(canReapFlight(flight, { actor: { kind: 'agent', id: 'agent-dispatcher' } })).toBe(true)
  })

  it('allows flying agent (self-deadlock report)', () => {
    expect(canReapFlight(flight, { actor: { kind: 'agent', id: 'agent-flying' } })).toBe(true)
  })

  it('allows squad lead of the flight squad', () => {
    expect(canReapFlight(flight, { actor: { kind: 'agent', id: 'agent-lead' }, leadSquadIds: ['squad-leadsquad'] })).toBe(true)
  })

  it('denies unrelated unprivileged caller', () => {
    expect(canReapFlight(flight, { actor: { kind: 'agent', id: 'agent-stranger' }, leadSquadIds: ['squad-other'] })).toBe(false)
  })
})

describe('reapStalledFlight Governed Terminal Transition', () => {
  const t0 = 1_000_000
  const nowMs = t0 + 70 * 60 * 1000 // 70 min (stalled)

  it('successfully transitions stalled running flight and writes outbox receipt', async () => {
    const flight = makeMockFlight({ id: 'fl-stalled-1', started_at: t0 })
    const { env, flights, outbox } = makeMockEnv([flight])

    const principal = {
      actor: { kind: 'system' as const, id: 'mupot-watchdog' },
    }

    const res = await reapStalledFlight(env, 'fl-stalled-1', principal, 'Exceeded 60m deadline', nowMs)
    expect(res.transitioned).toBe(true)
    expect(res.previous_status).toBe('running')
    expect(res.receipt).toBe(true)

    // Verify D1 state updated
    const updated = flights.get('fl-stalled-1')
    expect(updated?.status).toBe('failed')
    expect(updated?.gate_reason).toContain('watchdog_reap')
    expect(updated?.ended_at).toBe(nowMs)

    // Verify flight_event_outbox receipt
    expect(outbox.length).toBe(1)
    expect(outbox[0].eventType).toBe('flight.reaped')
    const payload = JSON.parse(outbox[0].payload as string)
    expect(payload.flight_id).toBe('fl-stalled-1')
    expect(payload.previous_status).toBe('running')
    expect(payload.target_status).toBe('failed')
    expect(payload.reap_reason).toBe('Exceeded 60m deadline')
  })

  it('HARD INVARIANT: refuses to reap waiting human review gate', async () => {
    const flight = makeMockFlight({ id: 'fl-waiting-1', status: 'waiting', started_at: t0 })
    const { env } = makeMockEnv([flight])

    const principal = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }
    const res = await reapStalledFlight(env, 'fl-waiting-1', principal, 'Stalled human', nowMs + 48 * 3600 * 1000)

    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('cannot_reap_waiting_gate_must_escalate')
  })

  it('refuses to reap healthy running flight under timeout', async () => {
    const flight = makeMockFlight({ id: 'fl-healthy-1', started_at: t0 })
    const { env } = makeMockEnv([flight])

    const principal = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }
    const res = await reapStalledFlight(env, 'fl-healthy-1', principal, 'Premature kill', t0 + 10 * 60 * 1000) // 10 min

    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('flight_not_stalled')
  })

  it('refuses unauthorized caller with permission error', async () => {
    const flight = makeMockFlight({ id: 'fl-stalled-2', started_at: t0 })
    const { env } = makeMockEnv([flight])

    const principal = { actor: { kind: 'agent' as const, id: 'stranger' } }
    const res = await reapStalledFlight(env, 'fl-stalled-2', principal, 'Unauthorized reap', nowMs)

    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('forbidden_insufficient_reap_capability')
  })

  it('refuses already terminal flight', async () => {
    const flight = makeMockFlight({ id: 'fl-landed-1', status: 'landed' })
    const { env } = makeMockEnv([flight])

    const principal = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }
    const res = await reapStalledFlight(env, 'fl-landed-1', principal, 'Double reap', nowMs)

    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('flight_already_terminal')
  })
})
