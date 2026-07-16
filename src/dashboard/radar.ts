// dashboard/radar — the brain's RADAR (#23): fleet + squad awareness, assembled
// PURELY from signals that already exist. The brain (ATC tower, src/flight/clearance.ts)
// cannot prioritize / clear-flights / route-messages without knowing which agents are
// on, each agent's situation, which squads are active, and where the stale signals are
// — that is the "sane linearity" that lets distributed squads communicate without
// colliding (vs stale peers + spam, mupot #353).
//
// Zero new data, zero migration: every field below is derived from loaders that
// already exist elsewhere (cited per-field in comments). This module owns ONLY the
// assembly. buildFleetRadar is pure (no I/O) so it is fully unit-testable; the thin
// loadFleetRadar wires it to D1 via the existing accessors — no new SQL invented
// beyond a plain `agents`/`squads` SELECT (same column sets already used by
// dashboard/observatory.ts and org/index.ts; there is no narrower exported lister).
//
// Liveness: this module does NOT invent a second notion of "live". Per-agent
// runtime_state reuses dashboard/observatory.ts's deriveAgentRuntimeState (the
// 4-state key+heartbeat classifier: live/stale/offline/unattached) — the same
// classifier the Observatory home renders. "stale" in the fleet summary below is
// defined as runtime_state !== 'live' (stale OR offline OR unattached all count as
// NOT flying-blind-safe), except 'offline' is excluded from stale_signals specifically
// (see below) because it is an intentional detach, not a decayed heartbeat.

import type { Env, Agent, Squad } from '../types'
import {
  loadAgentStats,
  loadAgentRuntimeStates,
  loadRecentTasks,
  type AgentStat,
  type AgentRuntimeState,
  type RecentTask,
} from './observatory'
import { listPresence, sqliteUtcToMs, type PresenceView } from '../fleet/presence'
import {
  listFleetAgentRuntimeView,
  presenceTtlSec,
  DEFAULT_PRESENCE_TTL_SEC,
  type FleetAgentRuntimeView,
} from '../fleet/registry'
import { listFlights, type FlightRow, type FlightStatus } from '../flight/service'
import { buildBoard, type FlightCard } from '../flight/board'

// ── shapes ───────────────────────────────────────────────────────────────────

export interface RadarFlightRef {
  id: string
  goal: string
  status: FlightStatus
}

export interface AgentCardRecentActivity {
  tasks_done: number // AgentStat.done_count — loadAgentStats (24h window)
  tasks_in_progress: number // AgentStat.in_flight — loadAgentStats (24h window)
  // Best-effort: the most recent of THIS agent's tasks among loadRecentTasks' global
  // top-10 feed (dashboard/observatory.ts loadRecentTasks). null when the agent has
  // no task in that top-10 window — NOT the same as "never had a task" (follow-up:
  // a per-agent "last task" query would remove this approximation).
  last_task_at: string | null
}

export interface AgentAirworthiness {
  // 1 - success_pct/100 over the 24h stats window (loadAgentStats). null when the
  // agent has zero tasks in the window (no rate to report, not a 0% rate).
  error_rate: number | null
  // agent.budget_cap_cents (org/service.ts Agent row) converted to micro-USD, minus
  // AgentStat.spend_micro_usd (24h window). APPROXIMATE: budget_cap_cents is scoped by
  // agent.budget_window (day/week/etc, org/service.ts) while spend_micro_usd is always
  // a fixed 24h window — the two windows only line up exactly for budget_window='day'.
  // null when the agent has no budget_cap_cents configured.
  budget_remaining_micro_usd: number | null
  // The single honest "don't trust this card" bit: true whenever runtime_state is
  // anything but 'live'. Mirrors the fleet summary's stale/offline/unattached split
  // without inventing a second liveness definition.
  stale: boolean
}

export interface AgentCard {
  agent_id: string
  display: string
  runtime_state: AgentRuntimeState // deriveAgentRuntimeState via loadAgentRuntimeStates (dashboard/observatory.ts)
  last_seen_ms: number | null // fleet_agents.last_reported_at via listFleetAgentRuntimeView (fleet/registry.ts)
  current_flight: RadarFlightRef | null // buildBoard(...).live flight for this agent (flight/board.ts)
  recent_activity: AgentCardRecentActivity
  airworthiness: AgentAirworthiness
  // Self-reported physical-machine signal (#21 slice 2) — fleet_agents.host via
  // listFleetAgentRuntimeView (fleet/registry.ts). UNTRUSTED, agent-controlled,
  // display-only. '' when unknown (no fleet_agents row, or the row's host is unreported —
  // both mean "we were never told", not "definitely no host").
  host: string
}

export interface SquadRadarView {
  squad_id: string
  name: string
  member_agent_ids: string[] // agents.squad_id === squad.id (org/service.ts createAgent's FK)
  active_flight_count: number // live flights (flight/board.ts) whose agent is a member
  live_member_count: number // members whose runtime_state === 'live'
}

export type StaleSignalKind = 'agent_presence_stale' | 'agent_unattached' | 'flight_stalled'

export interface StaleSignal {
  kind: StaleSignalKind
  id: string // agent_id (agent_* kinds) or flight_id (flight_stalled)
  detail: string
}

export interface FleetSummary {
  agents_total: number
  live: number
  stale: number
  offline: number
  unattached: number
  active_flights: number
  stale_signals: StaleSignal[]
  // 0 until the flight-clearance branch's collision detector lands on main — see
  // collisionFlightIds on FleetRadarInputs. Kept as a first-class field now so the
  // wiring is a one-line change later, not a reshape of this contract.
  open_collisions_count: number
}

export interface FleetRadar {
  generated_at_ms: number
  agents: AgentCard[]
  squads: SquadRadarView[]
  summary: FleetSummary
}

// ── tuning ───────────────────────────────────────────────────────────────────

// A "live" flight (flight/board.ts LIVE_PHASES) stuck in running/waiting this long
// since it started (or was created, if never started) with no lifecycle transition
// is flagged as stalled. This is a SEPARATE clock from presenceTtlSec on purpose —
// heartbeats and flights are different signals with different natural cadences; see
// the module header for why we don't collapse liveness definitions, and the same
// discipline applies here: a flight staleness window is its own concern, not a
// heartbeat TTL reused out of convenience.
export const DEFAULT_STALE_FLIGHT_AGE_MS = 2 * 60 * 60 * 1000 // 2h

// ── pure builder ─────────────────────────────────────────────────────────────

export interface FleetRadarInputs {
  nowMs: number
  agents: Agent[]
  squads: Pick<Squad, 'id' | 'name'>[]
  stats: Map<string, AgentStat>
  runtimeStates: Map<string, AgentRuntimeState>
  fleetRuntimeRows: FleetAgentRuntimeView[]
  presence: PresenceView[]
  recentTasks: RecentTask[]
  flights: FlightRow[]
  staleFlightAgeMs?: number
  // Heartbeat TTL (seconds), for the stale-signal detail string only — the actual
  // stale/live classification already happened upstream in loadAgentRuntimeStates
  // (fleet/registry.ts derivePresence). Defaults to the same DEFAULT_PRESENCE_TTL_SEC
  // that classifier falls back to when env.FLEET_PRESENCE_TTL_SEC is unset.
  presenceTtlSec?: number
  // Follow-up input (see FleetSummary.open_collisions_count): flight ids the
  // flight/clearance collision detector currently considers colliding. Undefined
  // when that detector isn't wired yet (it isn't, on plain main as of #23) — the
  // radar still surfaces both flights as active; it just can't yet say WHY they
  // might collide. Wire this from src/flight/clearance.ts's deriveActiveCollisions
  // once that branch merges.
  collisionFlightIds?: ReadonlySet<string> | null
}

export function buildFleetRadar(inputs: FleetRadarInputs): FleetRadar {
  const {
    nowMs,
    agents,
    squads,
    stats,
    runtimeStates,
    fleetRuntimeRows,
    presence,
    recentTasks,
    flights,
    staleFlightAgeMs = DEFAULT_STALE_FLIGHT_AGE_MS,
    presenceTtlSec: ttlSec = DEFAULT_PRESENCE_TTL_SEC,
    collisionFlightIds,
  } = inputs

  // last_seen_ms per agent_id, from the fleet_agents heartbeat row (registry.ts).
  const lastSeenByAgent = new Map<string, number | null>()
  // host per agent_id, from the SAME fleet_agents row (#21 slice 2) — no second SQL query,
  // just widening the projection off data already fetched for last_seen_ms.
  const hostByAgent = new Map<string, string>()
  for (const row of fleetRuntimeRows) {
    lastSeenByAgent.set(row.agent_id, sqliteUtcToMs(row.last_seen || null))
    hostByAgent.set(row.agent_id, row.host || '')
  }

  // presence (flock check-in) keyed by bound agent_id. Rows arrive last_seen_at DESC
  // (fleet/presence.ts listPresence ORDER BY) so the first hit per agent is the most
  // recent check-in; skip unbound (operator) rows.
  const presenceByAgent = new Map<string, PresenceView>()
  for (const row of presence) {
    if (!row.agent_id) continue
    if (!presenceByAgent.has(row.agent_id)) presenceByAgent.set(row.agent_id, row)
  }

  // Flight board cards, in the SAME order as `flights` (buildBoard maps 1:1) — so we
  // can zip a card back to its raw FlightRow (for started_at) by index.
  const cards: FlightCard[] = buildBoard(flights, nowMs)

  // Most-recent live flight per agent. `flights` is listFlights order (created_at
  // DESC), so the first live card seen for an agent is its current one.
  const currentFlightByAgent = new Map<string, RadarFlightRef>()
  // Live flight count per squad, resolved via FlightMetaV1.squad_ids when present
  // (the authoritative squad linkage — flight/meta.ts), else via the flight's agent's
  // own squad_id (fallback for flights dispatched without governed meta).
  const squadIdByAgentId = new Map<string, string>()
  for (const a of agents) squadIdByAgentId.set(a.id, a.squad_id)
  const activeFlightCountBySquad = new Map<string, number>()
  const staleFlightSignals: StaleSignal[] = []

  cards.forEach((card, i) => {
    if (!card.live) return
    if (!currentFlightByAgent.has(card.agent)) {
      currentFlightByAgent.set(card.agent, { id: card.id, goal: card.goal, status: card.status })
    }

    const squadIds = flightSquadIds(flights[i]) ?? (
      squadIdByAgentId.has(card.agent) ? [squadIdByAgentId.get(card.agent) as string] : []
    )
    for (const sid of squadIds) {
      activeFlightCountBySquad.set(sid, (activeFlightCountBySquad.get(sid) ?? 0) + 1)
    }

    // Stalled-flight detection: still running/waiting (not merely sleeping between
    // legs — that's healthy) this long since launch.
    const row = flights[i]
    if ((card.status === 'running' || card.status === 'waiting') && row) {
      const since = row.started_at ?? row.created_at
      const ageMs = nowMs - since
      if (ageMs > staleFlightAgeMs) {
        staleFlightSignals.push({
          kind: 'flight_stalled',
          id: card.id,
          detail: `${card.agent} — ${card.status} for ${Math.round(ageMs / 60_000)}m (goal: ${card.goal})`,
        })
      }
    }
  })

  // last_task_at (best-effort, top-10 recentTasks feed) per agent.
  const lastTaskAtByAgent = new Map<string, string>()
  for (const t of recentTasks) {
    if (!t.agent_id) continue
    const stamp = t.completed_at ?? t.created_at
    const prior = lastTaskAtByAgent.get(t.agent_id)
    if (!prior || stamp > prior) lastTaskAtByAgent.set(t.agent_id, stamp)
  }

  let live = 0
  let stale = 0
  let offline = 0
  let unattached = 0
  const agentStaleSignals: StaleSignal[] = []

  const cardsOut: AgentCard[] = agents.map((a) => {
    const runtime_state: AgentRuntimeState = runtimeStates.get(a.id) ?? 'unattached'
    switch (runtime_state) {
      case 'live': live++; break
      case 'stale': stale++; break
      case 'offline': offline++; break
      case 'unattached': unattached++; break
    }
    // 'offline' is an intentional detach (registry.ts derivePresence comment) — not
    // flagged as a stale SIGNAL (nothing decayed; someone turned it off on purpose).
    // 'stale' and 'unattached' are the "who's a ghost" collision-precursor cases #23
    // asks the radar to surface explicitly.
    if (runtime_state === 'stale') {
      agentStaleSignals.push({
        kind: 'agent_presence_stale',
        id: a.id,
        detail: `${a.name} — no heartbeat within ${ttlSec}s TTL`,
      })
    } else if (runtime_state === 'unattached') {
      agentStaleSignals.push({
        kind: 'agent_unattached',
        id: a.id,
        detail: `${a.name} — no signing key bound; catalog entry only`,
      })
    }

    const stat = stats.get(a.id)
    const error_rate = stat && stat.task_count > 0 ? 1 - stat.success_pct / 100 : null
    const budget_remaining_micro_usd =
      a.budget_cap_cents == null ? null : a.budget_cap_cents * 10_000 - (stat?.spend_micro_usd ?? 0)

    return {
      agent_id: a.id,
      display: a.name,
      runtime_state,
      last_seen_ms: lastSeenByAgent.get(a.id) ?? sqliteUtcToMs(presenceByAgent.get(a.id)?.last_seen_at ?? null),
      current_flight: currentFlightByAgent.get(a.id) ?? null,
      recent_activity: {
        tasks_done: stat?.done_count ?? 0,
        tasks_in_progress: stat?.in_flight ?? 0,
        last_task_at: lastTaskAtByAgent.get(a.id) ?? null,
      },
      airworthiness: {
        error_rate,
        budget_remaining_micro_usd,
        stale: runtime_state !== 'live',
      },
      host: hostByAgent.get(a.id) ?? '',
    }
  })

  const squadsOut: SquadRadarView[] = squads.map((s) => {
    const memberIds = agents.filter((a) => a.squad_id === s.id).map((a) => a.id)
    const liveMembers = memberIds.filter((id) => runtimeStates.get(id) === 'live').length
    return {
      squad_id: s.id,
      name: s.name,
      member_agent_ids: memberIds,
      active_flight_count: activeFlightCountBySquad.get(s.id) ?? 0,
      live_member_count: liveMembers,
    }
  })

  const stale_signals = [...agentStaleSignals, ...staleFlightSignals]

  return {
    generated_at_ms: nowMs,
    agents: cardsOut,
    squads: squadsOut,
    summary: {
      agents_total: agents.length,
      live,
      stale,
      offline,
      unattached,
      active_flights: cards.filter((c) => c.live).length,
      stale_signals,
      open_collisions_count: collisionFlightIds?.size ?? 0,
    },
  }
}

// FlightMetaV1.squad_ids, parsed defensively — flight/meta.ts owns validation on the
// WRITE path; here we only need a best-effort read for squad linkage, so a malformed
// or absent meta blob degrades to `null` (falls back to the agent's own squad_id
// upstream) rather than throwing.
function flightSquadIds(row: FlightRow | undefined): string[] | null {
  if (!row?.meta) return null
  try {
    const parsed = JSON.parse(row.meta) as { squad_ids?: unknown }
    if (Array.isArray(parsed.squad_ids) && parsed.squad_ids.every((s) => typeof s === 'string')) {
      return parsed.squad_ids as string[]
    }
    return null
  } catch {
    return null
  }
}

// ── thin D1 wiring ───────────────────────────────────────────────────────────
//
// All logic lives in buildFleetRadar above; this just calls the EXISTING loaders
// (dashboard/observatory.ts, fleet/presence.ts, fleet/registry.ts, flight/service.ts)
// plus one plain `agents`/`squads` SELECT (same columns loadObservatory / org/index.ts
// already use — there is no narrower exported lister for either table) and feeds them
// in. No writes, no new tables, no second liveness definition.

export async function loadFleetRadar(env: Env, nowMs = Date.now()): Promise<FleetRadar> {
  const [agentRows, squadRows, stats, runtimeStates, fleetRuntimeRows, presence, recentTasks, flights] =
    await Promise.all([
      env.DB.prepare(
        'SELECT id, squad_id, slug, name, role, model, status, okr, kpi_target, kpi_progress, effort, autonomy, budget_cap_cents, budget_window, created_at FROM agents ORDER BY created_at ASC, name ASC',
      ).all<Agent>(),
      env.DB.prepare('SELECT id, department_id, slug, name FROM squads ORDER BY created_at ASC, name ASC').all<
        Pick<Squad, 'id' | 'department_id' | 'name'>
      >(),
      loadAgentStats(env),
      loadAgentRuntimeStates(env, nowMs),
      listFleetAgentRuntimeView(env, nowMs),
      listPresence(env, nowMs),
      loadRecentTasks(env),
      listFlights(env, 500),
    ])

  return buildFleetRadar({
    nowMs,
    agents: agentRows.results ?? [],
    squads: squadRows.results ?? [],
    stats,
    runtimeStates,
    fleetRuntimeRows,
    presence,
    recentTasks,
    flights,
    presenceTtlSec: presenceTtlSec(env),
  })
}
