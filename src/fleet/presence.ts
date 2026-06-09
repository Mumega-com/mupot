// presence — pot-native flock check-in storage (Flock #45).
//
// Agents check IN to the pot; we record last_seen so the Fleet shows a live
// inventory (who has access + who is in now). Tenant-scoped. Liveness is derived
// at read time, reusing the dashboard/fleet classifier — one liveness definition.

import type { Env } from '../types'
import { classify, humanAge, type FleetLiveness } from '../dashboard/fleet'
import type { AgentIdentity } from '../auth/member-bearer'
import { listFlights } from '../flight/service'
import { scheduleStates, attachSchedule, type ScheduleStatus } from './schedule-state'

// Allowed runtime sources — an unknown/invalid value normalizes to 'unknown'
// (never trusts the client's raw string into storage unbounded).
const SOURCES = new Set(['claude-code', 'codex', 'hermes', 'openclaw', 'tmux', 'cowork', 'unknown'])

export function normalizeSource(s: unknown): string {
  return typeof s === 'string' && SOURCES.has(s) ? s : 'unknown'
}

export interface PresenceRow {
  member_id: string
  display_name: string
  source: string
  label: string
  last_seen_at: string
  first_seen_at: string
  // The bound agent (member_tokens.agent_id), when the checking-in token is agent-scoped.
  // The weld: this is the REAL agent identity, not a name guess. null = operator principal.
  agent_id: string | null
}

export interface PresenceView extends PresenceRow {
  liveness: FleetLiveness
  last_seen_human: string
  // The second axis (#62): schedule-state for session agents that have flights.
  // null = a cheap always-on agent — read its heartbeat `liveness` instead.
  schedule: ScheduleStatus | null
}

// SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC, no tz). Convert to epoch ms.
export function sqliteUtcToMs(s: string | null): number | null {
  if (!s) return null
  const ms = Date.parse(s.replace(' ', 'T') + 'Z')
  return Number.isNaN(ms) ? null : ms
}

// Record (upsert) a check-in for the authenticated agent. source/label are
// sanitized; identity comes from the token, never the body.
export async function recordCheckin(
  env: Env,
  id: AgentIdentity,
  opts: { source?: unknown; label?: unknown } = {},
): Promise<void> {
  const source = normalizeSource(opts.source)
  const label = typeof opts.label === 'string' ? opts.label.slice(0, 120) : ''
  await env.DB.prepare(
    `INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now'))
     ON CONFLICT(tenant, member_id) DO UPDATE SET
       display_name = excluded.display_name,
       source       = excluded.source,
       label        = excluded.label,
       agent_id     = excluded.agent_id,
       last_seen_at = datetime('now')`,
  )
    .bind(env.TENANT_SLUG, id.memberId, id.displayName, source, label, id.boundAgentId)
    .run()
}

// List the flock for this tenant with derived liveness. Tenant-scoped.
export async function listPresence(env: Env, nowMs: number): Promise<PresenceView[]> {
  const res = await env.DB.prepare(
    `SELECT member_id, display_name, source, label, agent_id, last_seen_at, first_seen_at
       FROM presence WHERE tenant = ?1 ORDER BY last_seen_at DESC LIMIT 200`,
  )
    .bind(env.TENANT_SLUG)
    .all<PresenceRow>()
  const rows = (res.results ?? []).map((r) => {
    const ms = sqliteUtcToMs(r.last_seen_at)
    return {
      ...r,
      liveness: classify(ms, nowMs),
      last_seen_human: humanAge(ms, nowMs),
    }
  })
  // Second axis (#62): overlay schedule-state from this tenant's flights so a
  // resting session agent reads "sleeping · next 14:00" instead of a false "dead".
  const states = scheduleStates(await listFlights(env))
  return attachSchedule(rows, states)
}

// Count currently-present agents (active within the stale window) for a quick stat.
export function countActive(rows: PresenceView[]): number {
  return rows.filter((r) => r.liveness === 'active').length
}
