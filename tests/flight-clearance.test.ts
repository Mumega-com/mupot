// flight/clearance tests — the ATC tower's collision detection (S196 follow-on).
//
// Dogfood scenario: reproduces the REAL incident that motivated this module — two
// agent teams (Kasra squad + a Codex-desktop team) worked the same dispatch/runtime
// seam blind to each other. Flight K built a dispatch→inbox bridge touching
// src/bus/consumer.ts + src/mcp/index.ts (task_dispatch), referencing #254. Flight C
// owned the #254 runtime-inbox cutover, touching an overlapping file. Neither flight
// knew about the other; only a manual branch grep surfaced the collision after both
// had already committed work. This suite asserts detectFlightCollisions/
// checkFlightClearance would have caught it before either flight departed.

import { describe, it, expect } from 'vitest'
import { detectFlightCollisions, checkFlightClearance } from '../src/flight/clearance'
import { deriveActiveCollisions } from '../src/flight/board'
import type { FlightRow, FlightStatus } from '../src/flight/service'
import type { FlightMetaV1 } from '../src/flight/meta'

const NOW = 1_900_000_000_000

function meta(p: Partial<FlightMetaV1> & { objective_id: string; task_ids: string[] }): FlightMetaV1 {
  return {
    schema: 'mupot.flight.meta/v1',
    goal_id: p.goal_id ?? 'goal-shared',
    objective_id: p.objective_id,
    squad_ids: p.squad_ids ?? ['squad-kasra'],
    task_ids: p.task_ids,
    done_when: p.done_when ?? ['verified'],
    artifact_refs: p.artifact_refs ?? [],
    receipt_refs: p.receipt_refs ?? [],
    confidentiality: p.confidentiality ?? 'internal',
    publication_target: p.publication_target ?? 'none',
    parent_flight_id: p.parent_flight_id ?? null,
  }
}

function row(p: Partial<FlightRow> & { agent: string; status: FlightStatus; meta: FlightMetaV1 }): FlightRow {
  return {
    id: p.id ?? crypto.randomUUID(),
    tenant: p.tenant ?? 'mumega',
    agent: p.agent,
    goal: p.goal ?? 'do the thing',
    status: p.status,
    trigger_source: p.trigger_source ?? 'manual',
    gate_verdict: p.gate_verdict ?? null,
    gate_reason: p.gate_reason ?? '',
    score: p.score ?? null,
    budget_micro_usd: p.budget_micro_usd ?? null,
    cost_micro_usd: p.cost_micro_usd ?? 0,
    next_run_at: p.next_run_at ?? null,
    created_at: p.created_at ?? NOW,
    started_at: p.started_at ?? null,
    ended_at: p.ended_at ?? null,
    meta: JSON.stringify(p.meta),
  }
}

// The real incident, reconstructed.
const flightKMeta = meta({
  goal_id: 'goal-s196',
  objective_id: 'obj-254-runtime-inbox',
  squad_ids: ['squad-kasra'],
  task_ids: ['task-dispatch-bridge'],
  artifact_refs: ['src/bus/consumer.ts', 'src/mcp/index.ts#task_dispatch', 'issue:#254'],
})
const flightCMeta = meta({
  goal_id: 'goal-runtime-cutover',
  objective_id: 'obj-254-runtime-inbox',
  squad_ids: ['squad-codex'],
  task_ids: ['task-runtime-cutover'],
  artifact_refs: ['src/bus/consumer.ts', 'issue:#254'],
})

describe('detectFlightCollisions — the real incident', () => {
  it('flags a HOLD between Flight K and Flight C on shared artifact_refs', () => {
    const flightK = row({ agent: 'kasra', status: 'running', meta: flightKMeta })
    const flightC = row({ agent: 'codex', status: 'running', meta: flightCMeta })

    const collisions = detectFlightCollisions([flightK, flightC])
    expect(collisions).toHaveLength(1)
    const [collision] = collisions
    expect(collision.severity).toBe('hold')
    expect(collision.reasons).toContain('shared_artifact_ref')
    expect(collision.shared_artifact_refs).toContain('src/bus/consumer.ts')
    expect([collision.flight_a_id, collision.flight_b_id]).toEqual(
      expect.arrayContaining([flightK.id, flightC.id]),
    )
  })

  it('flags a HOLD purely on shared task_ids even with disjoint artifact_refs', () => {
    const a = row({ agent: 'kasra', status: 'running', meta: meta({ objective_id: 'obj-1', task_ids: ['task-x'], artifact_refs: ['a.ts'] }) })
    const b = row({ agent: 'codex', status: 'running', meta: meta({ objective_id: 'obj-2', task_ids: ['task-x'], artifact_refs: ['b.ts'] }) })
    const collisions = detectFlightCollisions([a, b])
    expect(collisions).toHaveLength(1)
    expect(collisions[0].severity).toBe('hold')
    expect(collisions[0].reasons).toEqual(['shared_task_id'])
    expect(collisions[0].shared_task_ids).toEqual(['task-x'])
  })
})

describe('checkFlightClearance — the real incident, from the proposed side', () => {
  it('Flight K proposed after Flight C is already flying → NOT cleared, names Flight C', () => {
    const flightC = row({ agent: 'codex', status: 'running', meta: flightCMeta })
    const result = checkFlightClearance(flightKMeta, [flightC])
    expect(result.cleared).toBe(false)
    expect(result.holds).toHaveLength(1)
    expect(result.holds[0].flight_b_id).toBe(flightC.id)
    expect(result.holds[0].reasons).toContain('shared_artifact_ref')
    expect(result.warns).toHaveLength(0)
  })
})

describe('checkFlightClearance / detectFlightCollisions — severity + edge cases', () => {
  it('no task/artifact/objective/goal/squad overlap → cleared, no collision at all', () => {
    const other = row({
      agent: 'someone-else',
      status: 'running',
      meta: meta({ goal_id: 'goal-z', objective_id: 'obj-z', squad_ids: ['squad-z'], task_ids: ['task-z'], artifact_refs: ['z.ts'] }),
    })
    const proposed = meta({ goal_id: 'goal-a', objective_id: 'obj-a', squad_ids: ['squad-a'], task_ids: ['task-a'], artifact_refs: ['a.ts'] })
    const result = checkFlightClearance(proposed, [other])
    expect(result.cleared).toBe(true)
    expect(result.holds).toHaveLength(0)
    expect(result.warns).toHaveLength(0)
    expect(detectFlightCollisions([other, row({ agent: 'x', status: 'running', meta: proposed })])).toHaveLength(0)
  })

  it('same objective_id only, no task/artifact overlap → WARN, not HOLD, and clearance still cleared', () => {
    const other = row({
      agent: 'kasra',
      status: 'running',
      meta: meta({ goal_id: 'goal-a', objective_id: 'obj-shared', squad_ids: ['squad-a'], task_ids: ['task-a-1'], artifact_refs: ['a1.ts'] }),
    })
    const proposed = meta({ goal_id: 'goal-b', objective_id: 'obj-shared', squad_ids: ['squad-b'], task_ids: ['task-b-1'], artifact_refs: ['b1.ts'] })

    const result = checkFlightClearance(proposed, [other])
    expect(result.cleared).toBe(true)
    expect(result.holds).toHaveLength(0)
    expect(result.warns).toHaveLength(1)
    expect(result.warns[0].reasons).toEqual(['shared_objective'])

    const pairwise = detectFlightCollisions([other, row({ agent: 'y', status: 'running', meta: proposed })])
    expect(pairwise).toHaveLength(1)
    expect(pairwise[0].severity).toBe('warn')
  })

  it('same squad_ids only → WARN', () => {
    const a = row({ agent: 'a', status: 'waiting', meta: meta({ goal_id: 'goal-1', objective_id: 'obj-1', squad_ids: ['squad-shared'], task_ids: ['task-1'] }) })
    const b = row({ agent: 'b', status: 'preflight', meta: meta({ goal_id: 'goal-2', objective_id: 'obj-2', squad_ids: ['squad-shared'], task_ids: ['task-2'] }) })
    const collisions = detectFlightCollisions([a, b])
    expect(collisions).toHaveLength(1)
    expect(collisions[0].severity).toBe('warn')
    expect(collisions[0].reasons).toEqual(['shared_squad'])
  })

  it('terminal flights (landed/failed/held) are excluded from collision detection', () => {
    const landed = row({ agent: 'kasra', status: 'landed', meta: flightKMeta })
    const failed = row({ agent: 'kasra', status: 'failed', meta: flightKMeta })
    const held = row({ agent: 'kasra', status: 'held', meta: flightKMeta })
    const liveC = row({ agent: 'codex', status: 'running', meta: flightCMeta })

    // Same meta as flightKMeta (would HOLD if live) but every K-side row is terminal.
    expect(detectFlightCollisions([landed, liveC])).toHaveLength(0)
    expect(detectFlightCollisions([failed, liveC])).toHaveLength(0)
    expect(detectFlightCollisions([held, liveC])).toHaveLength(0)
    expect(detectFlightCollisions([landed, failed, held, liveC])).toHaveLength(0)

    // checkFlightClearance: a terminal row in activeFlights must not generate a HOLD.
    const result = checkFlightClearance(flightKMeta, [landed, failed, held])
    expect(result.cleared).toBe(true)
    expect(result.holds).toHaveLength(0)
  })

  it('preflight/waiting/sleeping all count as live (collide), landed/failed/held do not', () => {
    const liveStatuses: FlightStatus[] = ['preflight', 'running', 'waiting', 'sleeping']
    for (const status of liveStatuses) {
      const a = row({ agent: 'a', status, meta: flightKMeta })
      const b = row({ agent: 'b', status: 'running', meta: flightCMeta })
      expect(detectFlightCollisions([a, b]), `status=${status} should collide`).toHaveLength(1)
    }
  })

  it('tenant isolation — a flight in another tenant never collides (detectFlightCollisions)', () => {
    const a = row({ agent: 'kasra', status: 'running', meta: flightKMeta, tenant: 'mumega' })
    const b = row({ agent: 'codex', status: 'running', meta: flightCMeta, tenant: 'viamar' })
    expect(detectFlightCollisions([a, b])).toHaveLength(0)
  })

  it('tenant isolation — checkFlightClearance with an explicit tenant skips other-tenant rows', () => {
    const otherTenantFlight = row({ agent: 'codex', status: 'running', meta: flightCMeta, tenant: 'viamar' })
    const result = checkFlightClearance(flightKMeta, [otherTenantFlight], { tenant: 'mumega' })
    expect(result.cleared).toBe(true)
    expect(result.holds).toHaveLength(0)
  })

  it('unparseable meta is opaque — skipped, never manufactures a false HOLD', () => {
    const malformed: FlightRow = row({ agent: 'legacy', status: 'running', meta: flightCMeta })
    malformed.meta = '{not json'
    const result = checkFlightClearance(flightKMeta, [malformed])
    expect(result.cleared).toBe(true)
    expect(result.holds).toHaveLength(0)

    const emptyMetaRow: FlightRow = row({ agent: 'legacy2', status: 'running', meta: flightCMeta })
    emptyMetaRow.meta = '{}' // valid JSON, fails FlightMetaV1 schema
    const legacyPairwise = detectFlightCollisions([
      row({ agent: 'kasra', status: 'running', meta: flightKMeta }),
      emptyMetaRow,
    ])
    expect(legacyPairwise).toHaveLength(0)
  })

  it('the override (ignoreFlightIds) lets an intentional co-work flight bypass a named HOLD', () => {
    const flightC = row({ agent: 'codex', status: 'running', meta: flightCMeta })
    const blocked = checkFlightClearance(flightKMeta, [flightC])
    expect(blocked.cleared).toBe(false)

    const overridden = checkFlightClearance(flightKMeta, [flightC], { ignoreFlightIds: [flightC.id] })
    expect(overridden.cleared).toBe(true)
    expect(overridden.holds).toHaveLength(0)
  })

  it('a flight never collides with itself (same id)', () => {
    const a = row({ id: 'flight-self', agent: 'kasra', status: 'running', meta: flightKMeta })
    expect(detectFlightCollisions([a])).toHaveLength(0)
  })
})

describe('deriveActiveCollisions (board.ts) — the presentation split', () => {
  it('splits the real incident into holds vs warns for the board', () => {
    const flightK = row({ agent: 'kasra', status: 'running', meta: flightKMeta })
    const flightC = row({ agent: 'codex', status: 'running', meta: flightCMeta })
    const unrelatedWarn = row({
      agent: 'someone',
      status: 'waiting',
      meta: meta({ goal_id: 'goal-x', objective_id: 'obj-254-runtime-inbox', squad_ids: ['squad-x'], task_ids: ['task-x'], artifact_refs: ['x.ts'] }),
    })

    const { holds, warns } = deriveActiveCollisions([flightK, flightC, unrelatedWarn])
    expect(holds).toHaveLength(1)
    // unrelatedWarn shares obj-254 with BOTH K and C → 2 warn pairs.
    expect(warns).toHaveLength(2)
    expect(warns.every((w) => w.severity === 'warn')).toBe(true)
  })

  it('no live flights → no collisions', () => {
    expect(deriveActiveCollisions([])).toEqual({ holds: [], warns: [] })
  })
})
