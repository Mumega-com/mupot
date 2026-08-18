// tests/flight-watchdog.test.ts — Flight watchdog liveness predicate + governed reaper.
//
// REAL SQL, no mock D1. Every row here is INSERTed into a database built by
// `applyAllMigrations()` — the whole committed migration chain, exactly as production
// applies it — and every flight the predicate judges is read back out through the real
// `getFlight()`. That is the only sanctioned schema source in this repo
// (scripts/check-test-schema-source.mjs, the mupot#684 ratchet).
//
// WHY THIS FILE ESPECIALLY. The watchdog's job is to MARK WORK FAILED: its predicate picks
// which live flights get force-failed, and its reaper writes a terminal status. A
// hand-written object supplying `prepare()` is a SQL engine you invented — it string-matches
// the query and answers what the test expects, so a query naming a column that does not
// exist, or an INSERT the real schema REJECTS, cannot be contradicted. The first version of
// this file did exactly that, and it hid a live defect: see the `flight_event_outbox`
// characterization test at the bottom, which the mock reported as a passing audit receipt.
//
// COVERAGE CAVEAT, deliberately recorded. Production currently holds NO flights in the
// `waiting` or `sleeping` states, so neither branch has a live instance behind it — the
// predicate was validated read-only against the 45 real flights (REAP=10, ignore=35, zero
// false positives, youngest flagged 47.0h against a 60-minute timeout). These fixtures are
// therefore the ONLY coverage those two branches will get. They are written to be exhaustive
// on purpose: every boundary, both sides.
//
// THE HARD INVARIANT, stated once so it is not lost in the noise:
//   status='waiting' is the HUMAN REVIEW GATE. A human being slow is not a stalled flight.
//   A waiting flight is NEVER reaped — only escalated, and only after 24h.
// It is defended in two independent places (the predicate returns 'escalate'; the reaper
// refuses outright), and both are pinned below, including an end-to-end sweep test that only
// goes red when BOTH defences are removed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  canReapFlight,
  evaluateFlightLiveness,
  listStalledFlights,
  scanStalledFlights,
  sweepStalledFlights,
  reapStalledFlight,
  DEFAULT_RUNNING_STALL_TIMEOUT_MS,
  DEFAULT_SLEEPING_STALL_TIMEOUT_MS,
  DEFAULT_WAITING_GATE_ESCALATION_TIMEOUT_MS,
  MAX_CONFIGURED_TIMEOUT_MS,
  MIN_CONFIGURED_TIMEOUT_MS,
} from '../src/flight/watchdog'
import { getFlight } from '../src/flight/service'
import type { FlightRow, FlightStatus } from '../src/flight/service'
import type { Env } from '../src/types'

const TENANT = 'digid'
const T0 = 1_000_000
const HOUR = 3_600_000
const MINUTE = 60_000

interface FlightSeed {
  id: string
  agent?: string
  dispatched_by_agent_id?: string
  goal?: string
  status?: FlightStatus
  trigger_source?: string
  gate_verdict?: string | null
  gate_reason?: string
  next_run_at?: number | null
  created_at?: number
  started_at?: number | null
  ended_at?: number | null
  meta?: string
}

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  // `as unknown as Env`: Env carries the full Worker binding surface (KV, DOs, queues,
  // secrets). The watchdog reaches for exactly two of them, and supplying the rest would be
  // inventing bindings this code never touches.
  env = { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
})

afterEach(() => {
  harness.close()
})

/** INSERT a flight through the real schema. Every CHECK and trigger on `flights` applies. */
function seedFlight(seed: FlightSeed): void {
  harness.sqlite
    .prepare(
      `INSERT INTO flights
         (id, tenant, agent, dispatched_by_agent_id, goal, status, trigger_source,
          gate_verdict, gate_reason, score, budget_micro_usd, cost_micro_usd,
          next_run_at, created_at, started_at, ended_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.id,
      TENANT,
      seed.agent ?? 'agent-1111',
      seed.dispatched_by_agent_id ?? 'agent-2222',
      seed.goal ?? 'Test flight execution',
      seed.status ?? 'running',
      seed.trigger_source ?? 'api',
      seed.gate_verdict ?? 'go',
      seed.gate_reason ?? '',
      1,
      0,
      0,
      seed.next_run_at ?? null,
      seed.created_at ?? T0,
      seed.started_at === undefined ? T0 : seed.started_at,
      seed.ended_at ?? null,
      seed.meta ?? JSON.stringify({ schema: 'mupot.flight.meta/v1', squad_ids: ['squad-alpha'] }),
    )
}

/** Read the flight back out through the SAME function production reads it with. */
async function loadFlight(id: string): Promise<FlightRow> {
  const flight = await getFlight(env, id)
  if (flight === null) throw new Error(`seeded flight ${id} did not read back — check the seed`)
  return flight
}

/** Seed then read: the row the predicate judges always comes from the real schema. */
async function seedAndLoad(seed: FlightSeed): Promise<FlightRow> {
  seedFlight(seed)
  return loadFlight(seed.id)
}

function rawFlightRow(id: string): Record<string, unknown> | undefined {
  return harness.sqlite.prepare(`SELECT * FROM flights WHERE id = ?`).get(id)
}

function outboxRows(flightId: string): Record<string, unknown>[] {
  return harness.sqlite.prepare(`SELECT * FROM flight_event_outbox WHERE flight_id = ?`).all(flightId)
}

function reapReceiptRows(flightId: string): Record<string, unknown>[] {
  return harness.sqlite.prepare(`SELECT * FROM flight_reap_receipts WHERE flight_id = ?`).all(flightId)
}

const WATCHDOG = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }

// ───────────────────────────────────────────────────────────────────────────────
describe('evaluateFlightLiveness — predicate, judged on rows read from the real schema', () => {
  it('marks a running flight under the default 60m timeout healthy', async () => {
    const flight = await seedAndLoad({ id: 'fl-run-young', started_at: T0 })
    const res = evaluateFlightLiveness(flight, T0 + 15 * MINUTE)
    expect(res.action).toBe('healthy')
    expect(res.reason).toBe('running_in_progress')
    expect(res.ageMs).toBe(15 * MINUTE)
    expect(res.timeoutMs).toBe(DEFAULT_RUNNING_STALL_TIMEOUT_MS)
  })

  it('holds the 60m boundary: exactly at the timeout is still healthy, one ms past is a reap', async () => {
    const flight = await seedAndLoad({ id: 'fl-run-boundary', started_at: T0 })
    expect(evaluateFlightLiveness(flight, T0 + DEFAULT_RUNNING_STALL_TIMEOUT_MS).action).toBe('healthy')
    expect(evaluateFlightLiveness(flight, T0 + DEFAULT_RUNNING_STALL_TIMEOUT_MS + 1).action).toBe('reap')
  })

  it('marks a running flight past the default 60m timeout as reap', async () => {
    const flight = await seedAndLoad({ id: 'fl-run-stalled', started_at: T0 })
    const res = evaluateFlightLiveness(flight, T0 + 61 * MINUTE)
    expect(res.action).toBe('reap')
    expect(res.reason).toBe('running_exceeded_timeout')
    expect(res.ageMs).toBe(61 * MINUTE)
    expect(res.timeoutMs).toBe(DEFAULT_RUNNING_STALL_TIMEOUT_MS)
    expect(res.stalledAt).toBe(T0 + DEFAULT_RUNNING_STALL_TIMEOUT_MS)
  })

  it('distinguishes preflight from running in the stall reason', async () => {
    const flight = await seedAndLoad({ id: 'fl-preflight', status: 'preflight', started_at: null })
    // started_at is NULL for a preflight row, so the predicate must fall back to created_at.
    expect(flight.started_at).toBeNull()
    expect(evaluateFlightLiveness(flight, T0 + 10 * MINUTE).reason).toBe('preflight_in_progress')
    const res = evaluateFlightLiveness(flight, T0 + 61 * MINUTE)
    expect(res.action).toBe('reap')
    expect(res.reason).toBe('preflight_exceeded_timeout')
    expect(res.ageMs).toBe(61 * MINUTE)
  })

  it('honours a custom meta.timeout_ms', async () => {
    const flight = await seedAndLoad({
      id: 'fl-custom-timeout',
      started_at: T0,
      meta: JSON.stringify({ timeout_ms: 10 * MINUTE }),
    })
    expect(evaluateFlightLiveness(flight, T0 + 8 * MINUTE).action).toBe('healthy')
    const res = evaluateFlightLiveness(flight, T0 + 11 * MINUTE)
    expect(res.action).toBe('reap')
    expect(res.timeoutMs).toBe(10 * MINUTE)
  })

  it('clamps meta.timeout_ms to the 5m..24h band rather than trusting it', async () => {
    const tooSmall = await seedAndLoad({
      id: 'fl-timeout-tiny',
      started_at: T0,
      meta: JSON.stringify({ timeout_ms: 1000 }),
    })
    expect(evaluateFlightLiveness(tooSmall, T0 + 2000).timeoutMs).toBe(MIN_CONFIGURED_TIMEOUT_MS)

    const tooLarge = await seedAndLoad({
      id: 'fl-timeout-huge',
      started_at: T0,
      meta: JSON.stringify({ timeout_ms: 365 * 24 * HOUR }),
    })
    const res = evaluateFlightLiveness(tooLarge, T0 + 25 * HOUR)
    expect(res.timeoutMs).toBe(MAX_CONFIGURED_TIMEOUT_MS)
    expect(res.action).toBe('reap')
  })

  it('falls back to the default timeout when meta is not usable JSON', async () => {
    // `meta` is TEXT with no json_valid() CHECK on this table, so a malformed value is a
    // shape the real schema genuinely permits — not a hypothetical.
    const flight = await seedAndLoad({ id: 'fl-meta-broken', started_at: T0, meta: '{not json' })
    const res = evaluateFlightLiveness(flight, T0 + 61 * MINUTE)
    expect(res.action).toBe('reap')
    expect(res.timeoutMs).toBe(DEFAULT_RUNNING_STALL_TIMEOUT_MS)
  })

  it('treats a sleeping flight before its wake deadline as healthy', async () => {
    const flight = await seedAndLoad({
      id: 'fl-sleep-ok',
      status: 'sleeping',
      next_run_at: T0 + 30 * MINUTE,
    })
    const res = evaluateFlightLiveness(flight, T0 + 10 * MINUTE)
    expect(res.action).toBe('healthy')
    expect(res.reason).toBe('sleeping_in_window')
  })

  it('reaps a sleeping flight more than 30m past its wake deadline', async () => {
    const wakeAt = T0 + 10 * MINUTE
    const flight = await seedAndLoad({ id: 'fl-sleep-missed', status: 'sleeping', next_run_at: wakeAt })
    // Inside the grace window: still healthy.
    expect(evaluateFlightLiveness(flight, wakeAt + DEFAULT_SLEEPING_STALL_TIMEOUT_MS).action).toBe('healthy')
    const res = evaluateFlightLiveness(flight, wakeAt + 31 * MINUTE)
    expect(res.action).toBe('reap')
    expect(res.reason).toBe('sleeping_missed_wake_deadline')
    expect(res.stalledAt).toBe(wakeAt + DEFAULT_SLEEPING_STALL_TIMEOUT_MS)
  })

  it('reaps a sleeping flight that carries no wake deadline at all', async () => {
    // next_run_at is a nullable INTEGER in the real schema, so 'sleeping with no wake time'
    // is a storable state — the predicate treats it as unrecoverable rather than immortal.
    const flight = await seedAndLoad({ id: 'fl-sleep-nowake', status: 'sleeping', next_run_at: null })
    expect(flight.next_run_at).toBeNull()
    const res = evaluateFlightLiveness(flight, T0 + MINUTE)
    expect(res.action).toBe('reap')
    expect(res.reason).toBe('sleeping_without_next_run_at')
  })

  it('treats a waiting gate flight under 24h as healthy', async () => {
    const flight = await seedAndLoad({ id: 'fl-wait-young', status: 'waiting', started_at: T0 })
    const res = evaluateFlightLiveness(flight, T0 + 4 * HOUR)
    expect(res.action).toBe('healthy')
    expect(res.reason).toBe('waiting_gate_active')
    expect(res.timeoutMs).toBe(DEFAULT_WAITING_GATE_ESCALATION_TIMEOUT_MS)
  })

  it('HARD INVARIANT: a waiting gate flight past 24h ESCALATES and is never a reap', async () => {
    const flight = await seedAndLoad({ id: 'fl-wait-old', status: 'waiting', started_at: T0 })
    const res = evaluateFlightLiveness(flight, T0 + 25 * HOUR)
    expect(res.action).toBe('escalate')
    expect(res.action).not.toBe('reap')
    expect(res.reason).toBe('waiting_gate_exceeded_24h')
    expect(res.stalledAt).toBe(T0 + DEFAULT_WAITING_GATE_ESCALATION_TIMEOUT_MS)
  })

  it('HARD INVARIANT: no waiting flight of ANY age is ever a reap', async () => {
    // A slow human is not a stalled flight. Sweep the whole age range, including ages far
    // past every other timeout in the module, and assert the action is never 'reap'.
    const flight = await seedAndLoad({ id: 'fl-wait-sweep', status: 'waiting', started_at: T0 })
    for (const ageHours of [0, 1, 23, 24, 25, 48, 169, 720, 8760]) {
      const res = evaluateFlightLiveness(flight, T0 + ageHours * HOUR)
      expect(res.action, `waiting flight at ${ageHours}h must never be reaped`).not.toBe('reap')
      expect(['healthy', 'escalate']).toContain(res.action)
    }
  })

  it('treats terminal states (landed, failed, held) as healthy at any age', async () => {
    for (const status of ['landed', 'failed', 'held'] as FlightStatus[]) {
      const flight = await seedAndLoad({ id: `fl-term-${status}`, status, started_at: T0, ended_at: T0 })
      const res = evaluateFlightLiveness(flight, T0 + 100 * HOUR)
      expect(res.action).toBe('healthy')
      expect(res.reason).toBe('flight_terminal')
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('listStalledFlights — the scan query, executed against the real schema', () => {
  // This query LEFT JOINs `agents` and `squads` and selects `a.squad_id`. A mock D1 answers
  // it by string-matching; only a real database can contradict a column that has moved.
  async function seedAgentAndSquad(): Promise<void> {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'dept-core', 'Core');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-alpha', 'dept-core', 'squad-alpha', 'Alpha');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status)
        VALUES ('agent-1111', 'squad-alpha', 'flyer', 'Flyer', 'builder', 'sonnet', 'active');
    `)
  }

  it('returns only reap/escalate candidates and joins the canonical agent and squad names', async () => {
    await seedAgentAndSquad()
    seedFlight({ id: 'fl-scan-healthy', status: 'running', started_at: T0 })
    seedFlight({ id: 'fl-scan-stalled', status: 'running', started_at: T0 - 10 * HOUR })
    seedFlight({ id: 'fl-scan-landed', status: 'landed', started_at: T0 - 500 * HOUR, ended_at: T0 })

    const stalled = await listStalledFlights(env, { nowMs: T0 + 30 * MINUTE })
    expect(stalled.map((s) => s.flight.id)).toEqual(['fl-scan-stalled'])
    expect(stalled[0].evaluation.action).toBe('reap')
    // The JOIN is real: these columns are populated from `agents`/`squads`, not from `flights`.
    expect(stalled[0].flight.agent_name).toBe('Flyer')
    expect(stalled[0].flight.squad_name).toBe('Alpha')
  })

  it('never returns a terminal flight, however old', async () => {
    for (const status of ['landed', 'failed', 'held'] as FlightStatus[]) {
      seedFlight({ id: `fl-scan-term-${status}`, status, started_at: T0 - 400 * HOUR, ended_at: T0 })
    }
    const stalled = await listStalledFlights(env, { nowMs: T0 + 1000 * HOUR })
    expect(stalled).toEqual([])
  })

  it('does not leak flights belonging to another tenant', async () => {
    seedFlight({ id: 'fl-scan-mine', status: 'running', started_at: T0 - 10 * HOUR })
    harness.sqlite.exec(
      `INSERT INTO flights (id, tenant, agent, goal, status, created_at, started_at, meta)
       VALUES ('fl-scan-theirs', 'other-tenant', 'agent-x', 'g', 'running', ${T0 - 400 * HOUR}, ${T0 - 400 * HOUR}, '{}')`,
    )
    const stalled = await listStalledFlights(env, { nowMs: T0 })
    expect(stalled.map((s) => s.flight.id)).toEqual(['fl-scan-mine'])
  })

  it('HARD INVARIANT: an over-24h waiting flight surfaces as ESCALATE, never as a reap candidate', async () => {
    seedFlight({ id: 'fl-scan-waiting', status: 'waiting', started_at: T0 })
    const stalled = await listStalledFlights(env, { nowMs: T0 + 48 * HOUR })
    expect(stalled).toHaveLength(1)
    expect(stalled[0].flight.id).toBe('fl-scan-waiting')
    expect(stalled[0].evaluation.action).toBe('escalate')
    expect(stalled[0].evaluation.action).not.toBe('reap')
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('canReapFlight — authorization, on a row read from the real schema', () => {
  async function subject(): Promise<FlightRow> {
    return seedAndLoad({
      id: 'fl-authz',
      agent: 'agent-flying',
      dispatched_by_agent_id: 'agent-dispatcher',
      meta: JSON.stringify({ squad_ids: ['squad-leadsquad'] }),
    })
  }

  it('allows the system watchdog principal', async () => {
    expect(canReapFlight(await subject(), WATCHDOG)).toBe(true)
  })

  it('allows an org admin', async () => {
    expect(canReapFlight(await subject(), { actor: { kind: 'member', id: 'some-user' }, isOrgAdmin: true })).toBe(true)
  })

  it('allows the dispatching agent', async () => {
    expect(canReapFlight(await subject(), { actor: { kind: 'agent', id: 'agent-dispatcher' } })).toBe(true)
  })

  it('allows the flying agent to declare its own deadlock', async () => {
    expect(canReapFlight(await subject(), { actor: { kind: 'agent', id: 'agent-flying' } })).toBe(true)
  })

  it('allows the lead of a squad the flight belongs to', async () => {
    expect(
      canReapFlight(await subject(), { actor: { kind: 'agent', id: 'agent-lead' }, leadSquadIds: ['squad-leadsquad'] }),
    ).toBe(true)
  })

  it('denies an unrelated caller, and denies a lead of some OTHER squad', async () => {
    const flight = await subject()
    expect(canReapFlight(flight, { actor: { kind: 'agent', id: 'agent-stranger' } })).toBe(false)
    expect(
      canReapFlight(flight, { actor: { kind: 'agent', id: 'agent-stranger' }, leadSquadIds: ['squad-other'] }),
    ).toBe(false)
  })

  it('denies a caller whose id matches an EMPTY dispatched_by_agent_id', async () => {
    // 0094 added dispatched_by_agent_id as NOT NULL DEFAULT '' — so every pre-0094 flight
    // carries '' here, and '' is non-NULL in SQL but falsy in JS. A caller presenting an
    // empty id must not inherit dispatcher authority over every historical flight.
    const flight = await seedAndLoad({ id: 'fl-authz-empty', dispatched_by_agent_id: '' })
    expect(flight.dispatched_by_agent_id).toBe('')
    expect(canReapFlight(flight, { actor: { kind: 'agent', id: '' } })).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('reapStalledFlight — governed terminal transition, real UPDATE against real rows', () => {
  const STALLED_NOW = T0 + 70 * MINUTE

  it('transitions a stalled running flight to failed and the change is durable in D1', async () => {
    seedFlight({ id: 'fl-reap-1', started_at: T0 })

    const res = await reapStalledFlight(env, 'fl-reap-1', WATCHDOG, 'Exceeded 60m deadline', STALLED_NOW)
    expect(res.transitioned).toBe(true)
    expect(res.previous_status).toBe('running')
    expect(res.age_ms).toBe(70 * MINUTE)

    // Read the row back out of the database, not out of the return value.
    const row = rawFlightRow('fl-reap-1')
    expect(row?.status).toBe('failed')
    expect(String(row?.gate_reason)).toContain('watchdog_reap')
    expect(String(row?.gate_reason)).toContain('Exceeded 60m deadline')
    expect(row?.ended_at).toBe(STALLED_NOW)
  })

  it('reaps a sleeping flight that missed its wake deadline', async () => {
    // 'sleeping' is one of the three statuses the UPDATE's WHERE clause admits. Production
    // has no sleeping flight today, so this fixture is the only proof that branch works.
    const wakeAt = T0 + 10 * MINUTE
    seedFlight({ id: 'fl-reap-sleep', status: 'sleeping', next_run_at: wakeAt })
    const res = await reapStalledFlight(env, 'fl-reap-sleep', WATCHDOG, 'Missed wake', wakeAt + 31 * MINUTE)
    expect(res.transitioned).toBe(true)
    expect(res.previous_status).toBe('sleeping')
    expect(rawFlightRow('fl-reap-sleep')?.status).toBe('failed')
  })

  it('HARD INVARIANT: refuses to reap a waiting human review gate and leaves the row untouched', async () => {
    seedFlight({ id: 'fl-reap-waiting', status: 'waiting', started_at: T0 })

    const res = await reapStalledFlight(env, 'fl-reap-waiting', WATCHDOG, 'Stalled human', T0 + 48 * HOUR)
    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('cannot_reap_waiting_gate_must_escalate')

    // The refusal is only worth anything if the row really did not move.
    const row = rawFlightRow('fl-reap-waiting')
    expect(row?.status).toBe('waiting')
    expect(row?.ended_at).toBeNull()
    expect(row?.gate_reason).toBe('')
    expect(outboxRows('fl-reap-waiting')).toHaveLength(0)
  })

  it('HARD INVARIANT: a waiting flight survives a full watchdog sweep — scan, then reap everything the scan flagged', async () => {
    // The end-to-end shape. This is what the daemon actually does: list, then reap. It stays
    // green if EITHER defence (predicate returns 'escalate', reaper refuses 'waiting') is
    // removed, and goes red only when both are gone — which is the point of having two.
    seedFlight({ id: 'fl-sweep-waiting', status: 'waiting', started_at: T0 })
    seedFlight({ id: 'fl-sweep-running', status: 'running', started_at: T0 })
    const nowMs = T0 + 48 * HOUR

    const stalled = await listStalledFlights(env, { nowMs })
    for (const candidate of stalled) {
      if (candidate.evaluation.action === 'reap') {
        await reapStalledFlight(env, candidate.flight.id, WATCHDOG, candidate.evaluation.reason, nowMs)
      }
    }

    const waiting = rawFlightRow('fl-sweep-waiting')
    expect(waiting?.status, 'the human review gate must survive the sweep').toBe('waiting')
    expect(waiting?.ended_at).toBeNull()
    expect(outboxRows('fl-sweep-waiting')).toHaveLength(0)

    // …while the genuinely stalled flight beside it WAS reaped, so the sweep is not a no-op.
    expect(rawFlightRow('fl-sweep-running')?.status).toBe('failed')
  })

  it('refuses to reap a healthy running flight under its timeout', async () => {
    seedFlight({ id: 'fl-reap-healthy', started_at: T0 })
    const res = await reapStalledFlight(env, 'fl-reap-healthy', WATCHDOG, 'Premature kill', T0 + 10 * MINUTE)
    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('flight_not_stalled')
    expect(rawFlightRow('fl-reap-healthy')?.status).toBe('running')
  })

  it('refuses an unauthorized caller and does not touch the row', async () => {
    seedFlight({ id: 'fl-reap-authz', started_at: T0 })
    const res = await reapStalledFlight(
      env,
      'fl-reap-authz',
      { actor: { kind: 'agent', id: 'stranger' } },
      'Unauthorized reap',
      STALLED_NOW,
    )
    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('forbidden_insufficient_reap_capability')
    expect(rawFlightRow('fl-reap-authz')?.status).toBe('running')
  })

  it('refuses an already terminal flight', async () => {
    seedFlight({ id: 'fl-reap-landed', status: 'landed', ended_at: T0 })
    const res = await reapStalledFlight(env, 'fl-reap-landed', WATCHDOG, 'Double reap', STALLED_NOW)
    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('flight_already_terminal')
    expect(res.previous_status).toBe('landed')
  })

  it('reports flight_not_found for an id that is not in the table', async () => {
    const res = await reapStalledFlight(env, 'fl-does-not-exist', WATCHDOG, 'Ghost', STALLED_NOW)
    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('flight_not_found')
  })

  it('is idempotent: the second reap of the same flight finds it already terminal', async () => {
    seedFlight({ id: 'fl-reap-twice', started_at: T0 })
    const first = await reapStalledFlight(env, 'fl-reap-twice', WATCHDOG, 'first', STALLED_NOW)
    expect(first.transitioned).toBe(true)
    const second = await reapStalledFlight(env, 'fl-reap-twice', WATCHDOG, 'second', STALLED_NOW)
    expect(second.transitioned).toBe(false)
    expect(second.error).toBe('flight_already_terminal')
    // The first reap's reason survives; the second did not overwrite it.
    expect(String(rawFlightRow('fl-reap-twice')?.gate_reason)).toContain('first')
  })

  it('does not reap another tenant\'s flight even when the id is known', async () => {
    harness.sqlite.exec(
      `INSERT INTO flights (id, tenant, agent, goal, status, created_at, started_at, meta)
       VALUES ('fl-other-tenant', 'other-tenant', 'agent-x', 'g', 'running', ${T0}, ${T0}, '{}')`,
    )
    const res = await reapStalledFlight(env, 'fl-other-tenant', WATCHDOG, 'Cross tenant', STALLED_NOW)
    expect(res.transitioned).toBe(false)
    expect(res.error).toBe('flight_not_found')
    expect(rawFlightRow('fl-other-tenant')?.status).toBe('running')
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('reap audit receipt — flight_reap_receipts', () => {
  it('FIXED: a reap now writes a real audit receipt, with the evidence the decision rested on', async () => {
    // FLIPPED from the characterization test this replaces, exactly as that test demanded:
    // "the moment anyone widens the CHECK this test goes RED and must be flipped to assert a
    // real receipt — which is exactly the forcing function wanted."
    //
    // The CHECK was NOT widened. That test also named the reason, and it was right: widening
    // requires "scoping three consumers that today assume every outbox row is a landing
    // (deliverFlightLandedEvent + flushFlightEventOutbox, projections landing feed)" — otherwise
    // "a reaped flight is re-emitted on the bus as flight.landed". Independently re-traced and
    // confirmed: deliverFlightLandedEvent SELECTs with no event_type filter, emits a HARDCODED
    // type:'flight.landed', and UPDATEs delivered_at with no filter. So widening would have
    // broadcast a reap as a successful landing. A false receipt is worse than a missing one.
    //
    // The receipt got its own home instead (migrations/0109_flight_reap_receipts.sql). A reap is
    // not a landing: the system gave up, and the consumer is an auditor, not the delivery
    // pipeline. The outbox CHECK is untouched — proven by the root-cause test below, which still
    // passes UNCHANGED, so the landing path is demonstrably undisturbed by this change.
    seedFlight({ id: 'fl-receipt', started_at: T0 })

    const res = await reapStalledFlight(env, 'fl-receipt', WATCHDOG, 'Exceeded 60m deadline', T0 + 70 * MINUTE)

    expect(res.transitioned).toBe(true)
    expect(rawFlightRow('fl-receipt')?.status).toBe('failed')

    // The audit trail now exists.
    expect(res.receipt, 'reap must produce a real audit receipt').toBe(true)
    const receipts = reapReceiptRows('fl-receipt')
    expect(receipts, 'exactly one receipt per reap').toHaveLength(1)

    const row = receipts[0]
    // actor_kind='system' is the watchdog. The 0046 outbox CHECK admitted only member|agent,
    // which was the SECOND reason it rejected these writes — not just the event_type.
    expect(row.actor_kind).toBe('system')
    expect(row.actor_id).toBe('mupot-watchdog')
    expect(row.previous_status).toBe('running')
    expect(row.reap_reason).toBe('Exceeded 60m deadline')

    // The evidence the decision rested on, so a WRONG reap is diagnosable without re-deriving
    // the predicate from scratch.
    expect(row.predicate_reason, 'the machine reason, distinct from the operator reason').toBeTruthy()
    expect(Number(row.age_ms), 'age at reap').toBe(70 * MINUTE)
    expect(Number(row.timeout_ms), 'threshold applied').toBeGreaterThan(0)
    expect(() => JSON.parse(String(row.payload))).not.toThrow()

    // And nothing leaked into the landing pipeline — the reap is invisible to the outbox, which
    // is the whole point of separating the surfaces.
    expect(outboxRows('fl-receipt'), 'a reap must NOT appear in the landing outbox').toHaveLength(0)
  })

  it('receipt is idempotent: a refused second reap cannot add a duplicate audit row', async () => {
    // UNIQUE (tenant, flight_id) + ON CONFLICT DO NOTHING. A flight can only be reaped once (the
    // transition is guarded on a non-terminal status), so a duplicate here would mean a
    // double-reap recorded as two independent events.
    seedFlight({ id: 'fl-once', started_at: T0 })

    const first = await reapStalledFlight(env, 'fl-once', WATCHDOG, 'first', T0 + 70 * MINUTE)
    expect(first.transitioned).toBe(true)
    expect(first.receipt).toBe(true)

    const second = await reapStalledFlight(env, 'fl-once', WATCHDOG, 'second', T0 + 80 * MINUTE)
    // The flight is already terminal, so the transition itself must refuse.
    expect(second.transitioned).toBe(false)
    expect(reapReceiptRows('fl-once'), 'still exactly one receipt').toHaveLength(1)
    expect(reapReceiptRows('fl-once')[0].reap_reason, 'the FIRST reason survives').toBe('first')
  })

  it('pins the root cause: flight_event_outbox rejects flight.reaped and accepts flight.landed', () => {
    // Direct proof, so the test above cannot be "fixed" by editing an expectation. When this
    // assertion changes, the schema changed, and the defect test above must change with it.
    seedFlight({ id: 'fl-cause', started_at: T0 })
    const insert = (eventType: string, actorKind: string, id: string) =>
      harness.sqlite
        .prepare(
          `INSERT INTO flight_event_outbox (id, tenant, flight_id, event_type, actor_kind, actor_id, payload, created_at)
           VALUES (?, ?, 'fl-cause', ?, ?, 'actor', '{}', '2026-01-01T00:00:00.000Z')`,
        )
        .run(id, TENANT, eventType, actorKind)

    expect(() => insert('flight.reaped', 'agent', 'ev-reaped')).toThrow(/CHECK constraint failed/)
    expect(() => insert('flight.landed', 'system', 'ev-system')).toThrow(/CHECK constraint failed/)
    expect(() => insert('flight.landed', 'agent', 'ev-ok')).not.toThrow()
    expect(outboxRows('fl-cause')).toHaveLength(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
describe('sweepStalledFlights — the scheduled pass (mupot#1138)', () => {
  it('reaps the stalled flights and writes one receipt each', async () => {
    seedFlight({ id: 'fl-sweep-a', started_at: T0 })
    seedFlight({ id: 'fl-sweep-b', started_at: T0 })
    seedFlight({ id: 'fl-sweep-healthy', started_at: T0 })

    const nowMs = T0 + 70 * MINUTE
    const res = await sweepStalledFlights(env, { nowMs })

    expect(res.reaped).toBe(3)
    expect(res.failed).toBe(0)
    expect(res.escalated).toBe(0)
    expect((await loadFlight('fl-sweep-a')).status).toBe('failed')
    expect(reapReceiptRows('fl-sweep-a'), 'one receipt per reaped flight').toHaveLength(1)
    expect(reapReceiptRows('fl-sweep-b')).toHaveLength(1)
  })

  it('a healthy flight is left alone and gets no receipt', async () => {
    seedFlight({ id: 'fl-sweep-young', started_at: T0 })

    const res = await sweepStalledFlights(env, { nowMs: T0 + 15 * MINUTE })

    expect(res.candidates).toBe(0)
    expect(res.reaped).toBe(0)
    expect((await loadFlight('fl-sweep-young')).status).toBe('running')
    expect(reapReceiptRows('fl-sweep-young')).toHaveLength(0)
  })

  it('NEVER reaps an escalate — the human review gate survives the sweep', async () => {
    // The hard invariant, asserted at the SWEEP level rather than the reaper level.
    // reapStalledFlight already refuses a 'waiting' flight, but that makes the guarantee a
    // downstream accident. This pins it locally: the sweep must not even attempt the reap.
    seedFlight({ id: 'fl-sweep-waiting', status: 'waiting', started_at: T0 })

    const res = await sweepStalledFlights(env, { nowMs: T0 + 48 * HOUR })

    expect(res.escalated, 'the 24h-exceeded waiting gate is escalated').toBe(1)
    expect(res.reaped).toBe(0)
    expect(res.failed, 'escalate must not be counted as a failed reap attempt').toBe(0)
    expect((await loadFlight('fl-sweep-waiting')).status).toBe('waiting')
    expect(reapReceiptRows('fl-sweep-waiting'), 'no receipt — nothing was reaped').toHaveLength(0)
  })

  it('mixes reap and escalate in one pass without either contaminating the other', async () => {
    seedFlight({ id: 'fl-mix-stalled', started_at: T0 })
    seedFlight({ id: 'fl-mix-waiting', status: 'waiting', started_at: T0 })

    const res = await sweepStalledFlights(env, { nowMs: T0 + 48 * HOUR })

    expect(res.reaped).toBe(1)
    expect(res.escalated).toBe(1)
    expect((await loadFlight('fl-mix-stalled')).status).toBe('failed')
    expect((await loadFlight('fl-mix-waiting')).status).toBe('waiting')
  })

  it('is idempotent — a second pass reaps nothing and adds no duplicate receipt', async () => {
    seedFlight({ id: 'fl-sweep-twice', started_at: T0 })
    const nowMs = T0 + 70 * MINUTE

    const first = await sweepStalledFlights(env, { nowMs })
    const second = await sweepStalledFlights(env, { nowMs })

    expect(first.reaped).toBe(1)
    expect(second.reaped, 'already failed — no longer a candidate').toBe(0)
    expect(reapReceiptRows('fl-sweep-twice')).toHaveLength(1)
  })

  it('reports a CAPPED scan instead of passing a partial sweep off as a complete one', async () => {
    // The silent-cap finding. Under-reaping is the safe direction, but a truncated pass
    // otherwise reports identically to a clean one, so 'reaped 2' reads as 'that was all of
    // them'. `capped` is the only thing that distinguishes the two.
    // Distinct created_at: the candidate query is ORDER BY created_at ASC, so identical
    // timestamps leave the tie-break unspecified and "which two got scanned" arbitrary.
    seedFlight({ id: 'fl-cap-1', started_at: T0, created_at: T0 })
    seedFlight({ id: 'fl-cap-2', started_at: T0, created_at: T0 + 1 })
    seedFlight({ id: 'fl-cap-3', started_at: T0, created_at: T0 + 2 })

    const capped = await sweepStalledFlights(env, { nowMs: T0 + 70 * MINUTE, limit: 2 })
    expect(capped.capped, 'scanned === limit, so more may exist unseen').toBe(true)
    expect(capped.scanned).toBe(2)
    expect(capped.reaped).toBe(2)
    expect(await loadFlight('fl-cap-3').then((f) => f.status), 'unseen, so untouched').toBe('running')

    const complete = await sweepStalledFlights(env, { nowMs: T0 + 70 * MINUTE, limit: 50 })
    expect(complete.capped, 'room to spare — this pass really did see everything').toBe(false)
    expect(complete.reaped).toBe(1)
  })

  it('scanStalledFlights reports the window; listStalledFlights stays the plain array', async () => {
    seedFlight({ id: 'fl-scan-1', started_at: T0 })
    const nowMs = T0 + 70 * MINUTE

    const scan = await scanStalledFlights(env, { nowMs })
    const list = await listStalledFlights(env, { nowMs })

    expect(scan.items).toHaveLength(1)
    expect(scan.capped).toBe(false)
    expect(list, 'the wrapper must stay behaviourally identical').toEqual(scan.items)
  })
})
