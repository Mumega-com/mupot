// flight/dispatch clearance-gate wiring tests — verifies dispatchFlight combines
// preflight (single-flight readiness) with clearance (cross-flight collision) per
// flight/dispatch.ts: go = preflight.go && clearance.cleared. Uses the same in-memory
// D1 mock pattern as tests/flight-service.test.ts (recognize each service query by a
// unique substring, apply the known transition guard).

import { describe, it, expect } from 'vitest'
import { createFlight, getFlight, listFlights } from '../src/flight/service'
import type { FlightRow, FlightStatus } from '../src/flight/service'
import { dispatchFlight } from '../src/flight/dispatch'
import type { Env } from '../src/types'
import type { FlightSignals } from '../src/flight/preflight'
import type { FlightMetaV1 } from '../src/flight/meta'

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
                  const [id, t, projectId, agent, goal, trig, budget, meta] = a as [
                    string, string, string | null, string, string, string, number | null, string,
                  ]
                  rows.set(id, {
                    id, tenant: t, project_id: projectId, agent, goal, status: 'preflight', trigger_source: trig as FlightRow['trigger_source'],
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
                const out = [...rows.values()].filter((r) => r.tenant === t).sort((x, y) => y.created_at - x.created_at)
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

const healthy: FlightSignals = {
  contextComplete: true, toolsReachable: true,
  budgetRemainingMicroUsd: 5_000_000, budgetEstimateMicroUsd: 1_000_000,
  recentProgress: 0.8, progressPerStep: 0.7, wastePerStep: 0.2, stepSeconds: 60,
}

function meta(p: Partial<FlightMetaV1> & { objective_id: string; task_ids: string[] }): FlightMetaV1 {
  return {
    schema: 'mupot.flight.meta/v1',
    goal_id: p.goal_id ?? 'goal',
    objective_id: p.objective_id,
    squad_ids: p.squad_ids ?? ['squad-1'],
    task_ids: p.task_ids,
    done_when: p.done_when ?? ['verified'],
    artifact_refs: p.artifact_refs ?? [],
    receipt_refs: p.receipt_refs ?? [],
    confidentiality: p.confidentiality ?? 'internal',
    publication_target: p.publication_target ?? 'none',
    parent_flight_id: p.parent_flight_id ?? null,
  }
}

describe('dispatchFlight — clearance gate combines with preflight', () => {
  it('no meta → clearance skipped entirely (unscoped flight, nothing to check)', async () => {
    const { env } = makeEnv()
    const r = await dispatchFlight(env, { agent: 'kasra', goal: 'g' }, healthy)
    expect(r.go).toBe(true)
    expect(r.status).toBe('running')
    expect(r.clearance).toBeUndefined()
  })

  it('healthy preflight + no active collision → GO, running, clearance.cleared=true', async () => {
    const { env } = makeEnv()
    const flightMeta = meta({ objective_id: 'obj-1', task_ids: ['task-1'], artifact_refs: ['a.ts'] })
    const r = await dispatchFlight(env, { agent: 'kasra', goal: 'g', meta: flightMeta }, healthy)
    expect(r.go).toBe(true)
    expect(r.status).toBe('running')
    expect(r.clearance).toEqual({ cleared: true, holds: [], warns: [] })
  })

  it('healthy preflight BUT active flight shares a task_id → HELD despite preflight GO, reasons name the clearance hold', async () => {
    const { env } = makeEnv()
    // Flight C is already flying, touching task-shared.
    const flightC = await dispatchFlight(
      env,
      { agent: 'codex', goal: 'g-c', meta: meta({ objective_id: 'obj-254', task_ids: ['task-shared'], artifact_refs: ['seam.ts'] }) },
      healthy,
    )
    expect(flightC.status).toBe('running')

    // Flight K is individually healthy (preflight GO) but collides on task-shared.
    const flightK = await dispatchFlight(
      env,
      { agent: 'kasra', goal: 'g-k', meta: meta({ objective_id: 'obj-diff', task_ids: ['task-shared'], artifact_refs: ['other.ts'] }) },
      healthy,
    )
    expect(flightK.go).toBe(false)
    expect(flightK.status).toBe('held')
    expect(flightK.reasons).toContain('flight_clearance_hold')
    expect(flightK.reasons.some((r) => r.startsWith('clearance_shared_task_id:'))).toBe(true)
    expect(flightK.clearance?.cleared).toBe(false)
    expect(flightK.clearance?.holds).toHaveLength(1)
    expect((await getFlight(env, flightK.id))?.status).toBe('held')
    // Flight C is untouched.
    expect((await getFlight(env, flightC.id))?.status).toBe('running')
  })

  it('would-wander preflight AND a clearance hold → held, reasons carry both', async () => {
    const { env } = makeEnv()
    await dispatchFlight(
      env,
      { agent: 'codex', goal: 'g-c', meta: meta({ objective_id: 'obj-254', task_ids: ['task-shared'] }) },
      healthy,
    )
    const wandering: FlightSignals = { ...healthy, progressPerStep: 0.1, wastePerStep: 0.7 }
    const r = await dispatchFlight(
      env,
      { agent: 'kasra', goal: 'g-k', meta: meta({ objective_id: 'obj-diff', task_ids: ['task-shared'] }) },
      wandering,
    )
    expect(r.go).toBe(false)
    expect(r.status).toBe('held')
    expect(r.reasons).toContain('would_wander')
    expect(r.reasons).toContain('flight_clearance_hold')
  })

  it('same objective_id only (no task/artifact/goal/squad overlap) → WARN surfaced but still GO', async () => {
    const { env } = makeEnv()
    await dispatchFlight(
      env,
      { agent: 'codex', goal: 'g-c', meta: meta({ goal_id: 'goal-c', objective_id: 'obj-shared', squad_ids: ['squad-codex'], task_ids: ['task-c'], artifact_refs: ['c.ts'] }) },
      healthy,
    )
    const r = await dispatchFlight(
      env,
      { agent: 'kasra', goal: 'g-k', meta: meta({ goal_id: 'goal-k', objective_id: 'obj-shared', squad_ids: ['squad-kasra'], task_ids: ['task-k'], artifact_refs: ['k.ts'] }) },
      healthy,
    )
    expect(r.go).toBe(true)
    expect(r.status).toBe('running')
    expect(r.clearance?.cleared).toBe(true)
    expect(r.clearance?.warns).toHaveLength(1)
    expect(r.clearance?.warns[0].reasons).toEqual(['shared_objective'])
  })

  it('the flight being dispatched never collides with itself', async () => {
    const { env } = makeEnv()
    // A single dispatch with meta must not self-HOLD (regression guard for computing
    // clearance BEFORE createFlight, so the row does not yet exist in listFlights).
    const r = await dispatchFlight(
      env,
      { agent: 'kasra', goal: 'g', meta: meta({ objective_id: 'obj-1', task_ids: ['task-1'], artifact_refs: ['a.ts'] }) },
      healthy,
    )
    expect(r.go).toBe(true)
    expect(r.clearance?.cleared).toBe(true)
  })

  it('allowCollisionWith overrides a named HOLD to let an intentional co-work flight depart', async () => {
    const { env } = makeEnv()
    const flightC = await dispatchFlight(
      env,
      { agent: 'codex', goal: 'g-c', meta: meta({ objective_id: 'obj-254', task_ids: ['task-shared'] }) },
      healthy,
    )
    expect(flightC.status).toBe('running')

    const blocked = await dispatchFlight(
      env,
      { agent: 'kasra', goal: 'g-k-blocked', meta: meta({ objective_id: 'obj-diff', task_ids: ['task-shared'] }) },
      healthy,
    )
    expect(blocked.status).toBe('held')

    const overridden = await dispatchFlight(
      env,
      { agent: 'kasra', goal: 'g-k-overridden', meta: meta({ objective_id: 'obj-diff', task_ids: ['task-shared'] }) },
      healthy,
      {},
      { allowCollisionWith: [flightC.id] },
    )
    expect(overridden.go).toBe(true)
    expect(overridden.status).toBe('running')
    expect(overridden.clearance?.cleared).toBe(true)
  })

  it('tenant isolation — a same-task flight in another tenant never holds this dispatch', async () => {
    const { env: envA } = makeEnv('digid')
    const { env: envB, rows: rowsB } = makeEnv('viamar')
    // Simulate a flight in tenant viamar sharing task-shared, visible only within its
    // own tenant's listFlights (which is what real D1 does via WHERE tenant=?1).
    const otherTenantFlight = await dispatchFlight(
      envB,
      { agent: 'codex', goal: 'g', meta: meta({ objective_id: 'obj-254', task_ids: ['task-shared'] }) },
      healthy,
    )
    expect(otherTenantFlight.status).toBe('running')
    expect(rowsB.get(otherTenantFlight.id)?.tenant).toBe('viamar')

    const r = await dispatchFlight(
      envA,
      { agent: 'kasra', goal: 'g', meta: meta({ objective_id: 'obj-diff', task_ids: ['task-shared'] }) },
      healthy,
    )
    expect(r.go).toBe(true)
    expect(r.clearance?.cleared).toBe(true)
  })
})

describe('listFlights sanity (used by the clearance thin-DB-read)', () => {
  it('returns tenant-scoped rows the clearance check will compare against', async () => {
    const { env } = makeEnv('digid')
    await createFlight(env, { agent: 'a', goal: 'one' })
    const list = await listFlights(env)
    expect(list).toHaveLength(1)
  })
})
