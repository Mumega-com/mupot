// fleet/schedule-state — the second presence axis (Flight #62).
//
// Heartbeat liveness (classify: active/idle/dead) answers "did a cheap always-on
// agent ping recently?". That is the WRONG question for an expensive session agent:
// it sleeps between flights on purpose (to protect cache + cost), so no recent ping
// is HEALTHY, not dead. This module derives the right axis for those agents from the
// flights table — flying / sleeping (next departure) / done — so a resting Opus reads
// "sleeping · next 14:00", never "dead". See docs/flight-operations.md.
//
// Cheap vs expensive needs no config: an agent that has flight records IS the session
// kind, so it gets schedule-state; an agent with no flights keeps heartbeat liveness.
// Pure functions — no I/O, no Hono — so the dashboard renders them and tests cover them.

import type { FlightRow, FlightStatus } from '../flight/service'

export type ScheduleState = 'flying' | 'sleeping' | 'done'

export interface ScheduleStatus {
  state: ScheduleState
  next_at: number | null // earliest next departure (Unix ms), sleeping only
  next_label: string | null // "next 14:00" (UTC), sleeping only
}

// In the air: actively committed to a flight (about to launch, running, or held at a
// human gate). Terminal flights (landed/failed/held) are not in-air; sleeping is its
// own state handled below.
const IN_AIR: ReadonlySet<FlightStatus> = new Set<FlightStatus>(['preflight', 'running', 'waiting'])

// Unix ms → "HH:MM" (UTC). Honest + compact; the Fleet header says times are UTC.
export function formatHm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/**
 * Reduce all flights to one schedule-state per agent. Priority: in-air → flying;
 * else any sleeping flight with a known next_run_at → sleeping (earliest departure);
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
    if (fs.some((f) => IN_AIR.has(f.status))) {
      out.set(agent, { state: 'flying', next_at: null, next_label: null })
      continue
    }
    const sleeping = fs.filter((f) => f.status === 'sleeping' && f.next_run_at != null)
    if (sleeping.length > 0) {
      const next = sleeping.reduce((min, f) => Math.min(min, f.next_run_at as number), sleeping[0]!.next_run_at as number)
      out.set(agent, { state: 'sleeping', next_at: next, next_label: `next ${formatHm(next)}` })
      continue
    }
    out.set(agent, { state: 'done', next_at: null, next_label: null })
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
