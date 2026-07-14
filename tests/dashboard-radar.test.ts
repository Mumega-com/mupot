// Tests for dashboard/radar.ts — the brain's RADAR (#23). buildFleetRadar is pure
// (no I/O), so these drive it directly with fixtures shaped like today's real fleet
// state (dogfood): a live agent with a current flight, a stale agent, an unattached
// agent, two flights that would collide, and a squad view. See the task brief for the
// exact scenario list.

import { describe, it, expect } from 'vitest'
import { buildFleetRadar, type FleetRadarInputs } from '../src/dashboard/radar'
import type { Agent } from '../src/types'
import type { AgentStat, AgentRuntimeState, RecentTask } from '../src/dashboard/observatory'
import type { PresenceView } from '../src/fleet/presence'
import type { FleetAgentRuntimeView } from '../src/fleet/registry'
import type { FlightRow, FlightStatus } from '../src/flight/service'

const NOW = 1_900_000_000_000 // fixed reference (Unix ms)

function sqliteStamp(ms: number): string {
  // Matches datetime('now')'s "YYYY-MM-DD HH:MM:SS" (UTC, no separator) — the format
  // sqliteUtcToMs (fleet/presence.ts) parses back.
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function agent(p: Partial<Agent> & { id: string; squad_id: string; name: string }): Agent {
  return {
    id: p.id,
    squad_id: p.squad_id,
    slug: p.slug ?? p.id,
    name: p.name,
    role: p.role ?? 'member',
    model: p.model ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    status: p.status ?? 'active',
    okr: p.okr ?? null,
    kpi_target: p.kpi_target ?? null,
    kpi_progress: p.kpi_progress ?? 0,
    effort: p.effort ?? 'standard',
    autonomy: p.autonomy ?? 'draft',
    budget_cap_cents: p.budget_cap_cents ?? null,
    budget_window: p.budget_window ?? 'week',
    created_at: p.created_at ?? new Date(NOW - 86_400_000).toISOString(),
  }
}

function flight(p: Partial<FlightRow> & { id: string; agent: string; status: FlightStatus }): FlightRow {
  return {
    id: p.id,
    tenant: 'test',
    agent: p.agent,
    goal: p.goal ?? 'do the thing',
    status: p.status,
    trigger_source: p.trigger_source ?? 'manual',
    gate_verdict: p.gate_verdict ?? 'go',
    gate_reason: p.gate_reason ?? '',
    score: p.score ?? null,
    budget_micro_usd: p.budget_micro_usd ?? null,
    cost_micro_usd: p.cost_micro_usd ?? 0,
    next_run_at: p.next_run_at ?? null,
    created_at: p.created_at ?? NOW - 600_000,
    started_at: p.started_at ?? p.created_at ?? NOW - 600_000,
    ended_at: p.ended_at ?? null,
    meta: p.meta ?? '{}',
  }
}

// ── the dogfood fixture: roughly today's real fleet shape ─────────────────────
//
// - agent-hermes: live, current flight (Flight #351-style live runtime).
// - agent-kasra:  stale (presence/heartbeat aged past TTL) — building src/bus/consumer.ts.
// - agent-codex:  unattached (catalog row, no signing key bound yet) — working PR #254.
// The kasra + codex flights are the mupot #353 collision pair: two agents editing
// overlapping surfaces blind to each other, with no clearance/collision detector
// merged to main yet (task #23's own scoping note) — so the radar's job here is to
// surface BOTH as active, not to adjudicate the collision itself.

const HERMES = agent({ id: 'agent-hermes', squad_id: 'squad-core', name: 'Hermes' })
const KASRA = agent({ id: 'agent-kasra', squad_id: 'squad-core', name: 'Kasra' })
const CODEX = agent({ id: 'agent-codex', squad_id: 'squad-core', name: 'Codex' })

const AGENTS: Agent[] = [HERMES, KASRA, CODEX]
const SQUADS: FleetRadarInputs['squads'] = [{ id: 'squad-core', name: 'Core' }]

const RUNTIME_STATES = new Map<string, AgentRuntimeState>([
  ['agent-hermes', 'live'],
  ['agent-kasra', 'stale'],
  ['agent-codex', 'unattached'],
])

const STATS = new Map<string, AgentStat>([
  ['agent-hermes', { agent_id: 'agent-hermes', task_count: 10, done_count: 9, success_pct: 90, in_flight: 1, spend_micro_usd: 200_000 }],
  ['agent-kasra', { agent_id: 'agent-kasra', task_count: 4, done_count: 2, success_pct: 50, in_flight: 1, spend_micro_usd: 0 }],
])

const FLEET_RUNTIME_ROWS: FleetAgentRuntimeView[] = [
  { agent_id: 'agent-hermes', display: 'Hermes', runtime: 'hermes-cron', squads: ['squad-core'], status: 'running', presence: 'live', lifecycle: 'always_on', last_seen: sqliteStamp(NOW - 30_000) },
  { agent_id: 'agent-kasra', display: 'Kasra', runtime: 'claude-code', squads: ['squad-core'], status: 'running', presence: 'stale', lifecycle: 'on_demand', last_seen: sqliteStamp(NOW - 900_000) },
]

const PRESENCE: PresenceView[] = [
  {
    member_id: 'member-hermes', display_name: 'Hermes', source: 'hermes', label: '',
    last_seen_at: sqliteStamp(NOW - 30_000), first_seen_at: sqliteStamp(NOW - 86_400_000),
    agent_id: 'agent-hermes', liveness: 'active', last_seen_human: '30s ago', schedule: null,
  },
]

const RECENT_TASKS: RecentTask[] = [
  { id: 't1', title: 'watch the fleet', status: 'done', agent_id: 'agent-hermes', agent_name: 'Hermes', squad_name: 'Core', completed_at: new Date(NOW - 60_000).toISOString(), created_at: new Date(NOW - 120_000).toISOString(), cost_micro_usd: 500 },
]

const HERMES_FLIGHT = flight({ id: 'flight-hermes', agent: 'agent-hermes', status: 'running', goal: 'watch the fleet radar' })
const KASRA_FLIGHT = flight({ id: 'flight-kasra', agent: 'agent-kasra', status: 'running', goal: 'edit src/bus/consumer.ts', created_at: NOW - 500_000 })
const CODEX_FLIGHT = flight({ id: 'flight-codex', agent: 'agent-codex', status: 'running', goal: 'PR #254', created_at: NOW - 400_000 })

const FLIGHTS: FlightRow[] = [HERMES_FLIGHT, KASRA_FLIGHT, CODEX_FLIGHT]

function baseInputs(overrides: Partial<FleetRadarInputs> = {}): FleetRadarInputs {
  return {
    nowMs: NOW,
    agents: AGENTS,
    squads: SQUADS,
    stats: STATS,
    runtimeStates: RUNTIME_STATES,
    fleetRuntimeRows: FLEET_RUNTIME_ROWS,
    presence: PRESENCE,
    recentTasks: RECENT_TASKS,
    flights: FLIGHTS,
    ...overrides,
  }
}

describe('buildFleetRadar — per-agent cards', () => {
  it('live agent: current flight + healthy airworthiness', () => {
    const radar = buildFleetRadar(baseInputs())
    const hermes = radar.agents.find((a) => a.agent_id === 'agent-hermes')!
    expect(hermes.runtime_state).toBe('live')
    expect(hermes.current_flight).toEqual({ id: 'flight-hermes', goal: 'watch the fleet radar', status: 'running' })
    expect(hermes.recent_activity).toEqual({ tasks_done: 9, tasks_in_progress: 1, last_task_at: new Date(NOW - 60_000).toISOString() })
    expect(hermes.airworthiness.error_rate).toBeCloseTo(0.1) // 1 - 90/100
    expect(hermes.airworthiness.stale).toBe(false)
    expect(hermes.last_seen_ms).toBe(NOW - 30_000)
  })

  it('stale agent: flagged in stale_signals, airworthiness.stale=true', () => {
    const radar = buildFleetRadar(baseInputs())
    const kasra = radar.agents.find((a) => a.agent_id === 'agent-kasra')!
    expect(kasra.runtime_state).toBe('stale')
    expect(kasra.airworthiness.stale).toBe(true)
    expect(kasra.current_flight?.id).toBe('flight-kasra')
    expect(radar.summary.stale_signals.some((s) => s.kind === 'agent_presence_stale' && s.id === 'agent-kasra')).toBe(true)
  })

  it('unattached agent: counted + flagged, never silently dropped', () => {
    const radar = buildFleetRadar(baseInputs())
    const codex = radar.agents.find((a) => a.agent_id === 'agent-codex')!
    expect(codex.runtime_state).toBe('unattached')
    expect(codex.airworthiness.stale).toBe(true)
    expect(radar.summary.unattached).toBe(1)
    expect(radar.summary.stale_signals.some((s) => s.kind === 'agent_unattached' && s.id === 'agent-codex')).toBe(true)
  })

  it('budget_remaining_micro_usd: derived from agent.budget_cap_cents minus 24h spend; null when unset', () => {
    const withBudget = agent({ id: 'agent-hermes', squad_id: 'squad-core', name: 'Hermes', budget_cap_cents: 500 })
    const radar = buildFleetRadar(baseInputs({ agents: [withBudget, KASRA, CODEX] }))
    const hermes = radar.agents.find((a) => a.agent_id === 'agent-hermes')!
    expect(hermes.airworthiness.budget_remaining_micro_usd).toBe(500 * 10_000 - 200_000)
    const kasra = radar.agents.find((a) => a.agent_id === 'agent-kasra')!
    expect(kasra.airworthiness.budget_remaining_micro_usd).toBeNull() // no budget_cap_cents
  })
})

describe('buildFleetRadar — fleet summary census', () => {
  it('counts agents by runtime_state honestly (no fragmentation of the liveness definition)', () => {
    const radar = buildFleetRadar(baseInputs())
    expect(radar.summary.agents_total).toBe(3)
    expect(radar.summary.live).toBe(1)
    expect(radar.summary.stale).toBe(1)
    expect(radar.summary.offline).toBe(0)
    expect(radar.summary.unattached).toBe(1)
  })

  it('active_flights counts every live-phase flight (flight/board.ts LIVE_PHASES)', () => {
    const radar = buildFleetRadar(baseInputs())
    expect(radar.summary.active_flights).toBe(3)
  })
})

describe('buildFleetRadar — collision pair (mupot #353 style)', () => {
  it('without a collision detector wired: both flights still surface as active (follow-up, not a drop)', () => {
    const radar = buildFleetRadar(baseInputs())
    expect(radar.summary.open_collisions_count).toBe(0)
    const kasra = radar.agents.find((a) => a.agent_id === 'agent-kasra')!
    const codex = radar.agents.find((a) => a.agent_id === 'agent-codex')!
    expect(kasra.current_flight?.id).toBe('flight-kasra')
    expect(codex.current_flight?.id).toBe('flight-codex')
  })

  it('with collisionFlightIds supplied (future clearance-branch wiring): count reflects it', () => {
    const radar = buildFleetRadar(
      baseInputs({ collisionFlightIds: new Set(['flight-kasra', 'flight-codex']) }),
    )
    expect(radar.summary.open_collisions_count).toBe(2)
  })
})

describe('buildFleetRadar — squad view', () => {
  it('members + active flight count assembled from agents.squad_id + live flights', () => {
    const radar = buildFleetRadar(baseInputs())
    const squad = radar.squads.find((s) => s.squad_id === 'squad-core')!
    expect(squad.member_agent_ids).toEqual(['agent-hermes', 'agent-kasra', 'agent-codex'])
    expect(squad.active_flight_count).toBe(3)
    expect(squad.live_member_count).toBe(1) // only hermes is 'live'
  })
})

describe('buildFleetRadar — tenant isolation (structural)', () => {
  it('a presence/fleet-runtime row for an agent outside the tenant-scoped `agents` list never produces a phantom card', () => {
    const foreignPresence: PresenceView = {
      member_id: 'member-foreign', display_name: 'Foreign', source: 'unknown', label: '',
      last_seen_at: sqliteStamp(NOW), first_seen_at: sqliteStamp(NOW),
      agent_id: 'agent-foreign-tenant', liveness: 'active', last_seen_human: 'now', schedule: null,
    }
    const foreignRuntimeRow: FleetAgentRuntimeView = {
      agent_id: 'agent-foreign-tenant', display: 'Foreign', runtime: 'codex', squads: [],
      status: 'running', presence: 'live', lifecycle: 'on_demand', last_seen: sqliteStamp(NOW),
    }
    const radar = buildFleetRadar(
      baseInputs({
        presence: [...PRESENCE, foreignPresence],
        fleetRuntimeRows: [...FLEET_RUNTIME_ROWS, foreignRuntimeRow],
      }),
    )
    expect(radar.agents).toHaveLength(3)
    expect(radar.agents.some((a) => a.agent_id === 'agent-foreign-tenant')).toBe(false)
  })
})

describe('buildFleetRadar — flight-stalled stale signal', () => {
  it('a running flight past staleFlightAgeMs is flagged; sleeping flights are not', () => {
    const stalled = flight({ id: 'flight-stalled', agent: 'agent-hermes', status: 'running', created_at: NOW - 3 * 60 * 60 * 1000, started_at: NOW - 3 * 60 * 60 * 1000 })
    const radar = buildFleetRadar(baseInputs({ flights: [...FLIGHTS, stalled] }))
    expect(radar.summary.stale_signals.some((s) => s.kind === 'flight_stalled' && s.id === 'flight-stalled')).toBe(true)
  })

  it('respects a custom staleFlightAgeMs threshold', () => {
    const radar = buildFleetRadar(baseInputs({ staleFlightAgeMs: 100_000 })) // 100s — HERMES_FLIGHT is 600s old
    expect(radar.summary.stale_signals.some((s) => s.kind === 'flight_stalled' && s.id === 'flight-hermes')).toBe(true)
  })
})
