// fleet/schedule-state — the second presence axis (Flight #62).
//
// Heartbeat liveness (classify: active/idle/dead) answers "did a cheap always-on
// agent ping recently?". That is the WRONG question for an expensive session agent:
// it rests between flights on purpose (to protect cache + cost), so no recent ping
// is HEALTHY, not dead. This module derives the right axis for those agents from the
// flights table — flying / done — so a resting Opus reads "done", never "dead".
// See docs/flight-operations.md.
//
// There used to be a third state, 'sleeping', carrying a "next 14:00" departure read off
// flights.next_run_at. It was removed in mupot#913: nothing ever wrote status='sleeping'
// or next_run_at, so the branch could not be reached and no agent has ever rendered as
// sleeping. This is a labelling change on paper only — a resting agent already fell
// through to 'done' in production, which is accurate (all of its flights have ended).
// The point of the module survives intact: a session agent is still read by its flights
// rather than by a heartbeat it deliberately does not send.
//
// Cheap vs expensive needs no config: an agent that has flight records IS the session
// kind, so it gets schedule-state; an agent with no flights keeps heartbeat liveness.
// Pure functions — no I/O, no Hono — so the dashboard renders them and tests cover them.

import type { FlightRow, FlightStatus } from '../flight/service'

export type ScheduleState = 'flying' | 'done'

export interface ScheduleStatus {
  state: ScheduleState
}

// In the air: actively committed to a flight (about to launch, or running). Terminal
// flights (landed/failed/held) are not in-air.
const IN_AIR: ReadonlySet<FlightStatus> = new Set<FlightStatus>(['preflight', 'running'])

/**
 * Reduce all flights to one schedule-state per agent. Priority: in-air → flying;
 * else (only terminal flights) → done. Keyed by FlightRow.agent.
 */
export function scheduleStates(flights: FlightRow[]): Map<string, ScheduleStatus> {
  const byAgent = new Map<string, FlightRow[]>()
  for (const f of flights) {
    const list = byAgent.get(f.agent) ?? []
    list.push(f)
    byAgent.set(f.agent, list)
  }

  const out = new Map<string, ScheduleStatus>()
  for (const [agent, fs] of byAgent) {
    out.set(agent, { state: fs.some((f) => IN_AIR.has(f.status)) ? 'flying' : 'done' })
  }
  return out
}

/**
 * Overlay schedule-state onto presence rows. Match a row to its flights by the agent
 * NAME (display_name) first, then member_id. A row with no matching flights → schedule
 * null = a cheap always-on agent; the caller keeps its heartbeat liveness for that row.
 */
export function attachSchedule<T extends { member_id: string; display_name: string }>(
  rows: T[],
  states: Map<string, ScheduleStatus>,
): (T & { schedule: ScheduleStatus | null })[] {
  return rows.map((r) => ({
    ...r,
    schedule: states.get(r.display_name) ?? states.get(r.member_id) ?? null,
  }))
}
