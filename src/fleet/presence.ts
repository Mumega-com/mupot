// presence — pot-native flock check-in storage (Flock #45 + 7-axis seats).
//
// Agents check IN to the pot; we record last_seen so the Fleet shows a live
// inventory (who has access + who is in now). Tenant-scoped. Liveness is derived
// at read time, reusing the dashboard/fleet classifier — one liveness definition.
// Distinct seats persist independently on (tenant, member_id, label).

import type { Env } from '../types'
import { classify, humanAge, type FleetLiveness } from '../dashboard/fleet'
import type { AgentIdentity } from '../auth/member-bearer'
import { listFlights } from '../flight/service'
import { scheduleStates, attachSchedule, type ScheduleStatus } from './schedule-state'

// Allowed runtime sources — an unknown/invalid value normalizes to 'unknown'
// (never trusts the client's raw string into storage unbounded).
const SOURCES = new Set([
  'claude-code',
  'codex',
  'hermes',
  'openclaw',
  'tmux',
  'cowork',
  'unknown',
  'cursor-cloud',
  'cursor-ide',
])

export const SEVEN_AXIS_HARNESSES = [
  'cursor-ide',
  'cursor-cloud',
  'antigravity-cli',
  'claude-code',
  'prime',
  'hermes',
  'grok-cli',
  'unknown',
] as const

export type SevenAxisHarness = (typeof SEVEN_AXIS_HARNESSES)[number]

export const SEVEN_AXIS_EFFORTS = ['low', 'medium', 'high', 'extended-thinking-64k'] as const

export type SevenAxisEffort = (typeof SEVEN_AXIS_EFFORTS)[number]

const HARNESSES = new Set<string>(SEVEN_AXIS_HARNESSES)
const EFFORTS = new Set<string>(SEVEN_AXIS_EFFORTS)

export function normalizeSource(s: unknown): string {
  return typeof s === 'string' && SOURCES.has(s) ? s : 'unknown'
}

export function normalizeHarness(s: unknown): SevenAxisHarness {
  return typeof s === 'string' && HARNESSES.has(s) ? (s as SevenAxisHarness) : 'unknown'
}

export function normalizeEffort(s: unknown): SevenAxisEffort | null {
  return typeof s === 'string' && EFFORTS.has(s) ? (s as SevenAxisEffort) : null
}

export function sanitizeAxisString(s: unknown, max = 120): string | null {
  if (typeof s !== 'string') return null
  const trimmed = s.trim().slice(0, max)
  return trimmed.length > 0 ? trimmed : null
}

export interface SevenAxisDeclaration {
  seat: string
  harness: SevenAxisHarness
  machine: string | null
  model: string | null
  provider: string | null
  effort: SevenAxisEffort | null
  flight_id: string | null
}

export interface CheckinOpts {
  source?: unknown
  label?: unknown
  seat?: unknown
  harness?: unknown
  machine?: unknown
  model?: unknown
  provider?: unknown
  effort?: unknown
  flight_id?: unknown
}

export function resolveSeatLabel(opts: CheckinOpts): string {
  const seat = sanitizeAxisString(opts.seat)
  if (seat) return seat
  const label = typeof opts.label === 'string' ? opts.label.trim().slice(0, 120) : ''
  return label
}

export function normalizeSevenAxis(opts: CheckinOpts): SevenAxisDeclaration {
  return {
    seat: resolveSeatLabel(opts),
    harness: opts.harness === undefined || opts.harness === null ? 'unknown' : normalizeHarness(opts.harness),
    machine: sanitizeAxisString(opts.machine),
    model: sanitizeAxisString(opts.model),
    provider: sanitizeAxisString(opts.provider),
    effort: normalizeEffort(opts.effort),
    flight_id: sanitizeAxisString(opts.flight_id, 64),
  }
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
  harness?: string | null
  machine?: string | null
  model?: string | null
  provider?: string | null
  effort?: string | null
  flight_id?: string | null
}

export interface PresenceView extends PresenceRow {
  liveness: FleetLiveness
  last_seen_human: string
  // The second axis (#62): schedule-state for session agents that have flights.
  // null = a cheap always-on agent — read its heartbeat `liveness` instead.
  schedule: ScheduleStatus | null
}

export interface SeatAxisView {
  seat: string
  agent: string
  agent_id: string | null
  harness: string
  machine: string | null
  model: string | null
  provider: string | null
  effort: string | null
  flight_id: string | null
  source: string
  liveness: FleetLiveness
  last_seen_human: string
}

export function seatAxisFromPresence(row: PresenceView): SeatAxisView {
  return {
    seat: row.label || row.display_name || '—',
    agent: row.display_name,
    agent_id: row.agent_id,
    harness: row.harness || 'unknown',
    machine: row.machine ?? null,
    model: row.model ?? null,
    provider: row.provider ?? null,
    effort: row.effort ?? null,
    flight_id: row.flight_id ?? null,
    source: row.source,
    liveness: row.liveness,
    last_seen_human: row.last_seen_human,
  }
}

export function activeSeatRoster(rows: PresenceView[]): SeatAxisView[] {
  return rows.filter((r) => r.liveness === 'active').map(seatAxisFromPresence)
}

type PresenceIdentity = Pick<
  AgentIdentity,
  'memberId' | 'displayName' | 'email' | 'boundAgentId'
>

// SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC, no tz). Convert to epoch ms.
export function sqliteUtcToMs(s: string | null): number | null {
  if (!s) return null
  const ms = Date.parse(s.replace(' ', 'T') + 'Z')
  return Number.isNaN(ms) ? null : ms
}

function bindSevenAxis(opts: CheckinOpts): {
  harness: SevenAxisHarness | null
  machine: string | null
  model: string | null
  provider: string | null
  effort: SevenAxisEffort | null
  flight_id: string | null
} {
  // Omitted axes bind NULL so ON CONFLICT COALESCE keeps a previously declared value.
  // An explicit empty / unknown-invalid harness still stores 'unknown'.
  return {
    harness: opts.harness === undefined || opts.harness === null ? null : normalizeHarness(opts.harness),
    machine: sanitizeAxisString(opts.machine),
    model: sanitizeAxisString(opts.model),
    provider: sanitizeAxisString(opts.provider),
    effort: normalizeEffort(opts.effort),
    flight_id: sanitizeAxisString(opts.flight_id, 64),
  }
}

// Record (upsert) a check-in for the authenticated agent. source/label/axes are
// sanitized; identity comes from the token, never the body.
export async function recordCheckin(
  env: Env,
  id: PresenceIdentity,
  opts: CheckinOpts = {},
): Promise<SevenAxisDeclaration> {
  const source = normalizeSource(opts.source)
  const label = resolveSeatLabel(opts)
  const axis = bindSevenAxis(opts)
  await env.DB.prepare(
    `INSERT INTO presence (
        tenant, member_id, display_name, source, label, seat, agent_id,
        harness, machine, model, provider, effort, flight_id,
        first_seen_at, last_seen_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, COALESCE(?7, 'unknown'), ?8, ?9, ?10, ?11, ?12, datetime('now'), datetime('now'))
      ON CONFLICT(tenant, member_id, label) DO UPDATE SET
        display_name = excluded.display_name,
        source       = excluded.source,
        seat         = excluded.seat,
        agent_id     = excluded.agent_id,
        harness      = CASE WHEN ?7 IS NULL THEN presence.harness ELSE excluded.harness END,
        machine      = COALESCE(?8, presence.machine),
        model        = COALESCE(?9, presence.model),
        provider     = COALESCE(?10, presence.provider),
        effort       = COALESCE(?11, presence.effort),
        flight_id    = COALESCE(?12, presence.flight_id),
        last_seen_at = datetime('now')`,
  )
    .bind(
      env.TENANT_SLUG,
      id.memberId,
      id.displayName,
      source,
      label,
      id.boundAgentId,
      axis.harness,
      axis.machine,
      axis.model,
      axis.provider,
      axis.effort,
      axis.flight_id,
    )
    .run()
  return {
    seat: label,
    harness: axis.harness ?? 'unknown',
    machine: axis.machine,
    model: axis.model,
    provider: axis.provider,
    effort: axis.effort,
    flight_id: axis.flight_id,
  }
}

/**
 * touchPresence — lightweight zero-touch presence heartbeat for active MCP/API requests.
 * Debounced per (tenant, memberId, seatLabel) with a 60s KV TTL so high-frequency tool
 * calls do not execute redundant D1 writes while keeping presence fresh (active <= 10m).
 * Optional 7-axis fields ride the same write; omitted axes do not wipe stored values.
 */
export async function touchPresence(
  env: Env,
  id: PresenceIdentity,
  opts: CheckinOpts = {},
): Promise<boolean> {
  const source = normalizeSource(opts.source)
  const label = resolveSeatLabel(opts)

  const dkey = label
    ? `presence:touch:${env.TENANT_SLUG}:${id.memberId}:${label}`
    : `presence:touch:${env.TENANT_SLUG}:${id.memberId}`

  try {
    if (env.SESSIONS && (await env.SESSIONS.get(dkey))) {
      return false // Debounced, already fresh (within 60s)
    }
    if (env.SESSIONS) {
      await env.SESSIONS.put(dkey, '1', { expirationTtl: 60 })
    }
  } catch {
    // Fail-soft: KV error should not prevent DB touch
  }

  try {
    await recordCheckin(env, id, { ...opts, source, label })
    return true
  } catch {
    // Fail-soft: presence touch is a non-blocking liveness marker
    return false
  }
}

const PRESENCE_SELECT = `SELECT member_id, display_name, source, label, agent_id, last_seen_at, first_seen_at,
       harness, machine, model, provider, effort, flight_id
       FROM presence WHERE tenant = ?1`

/**
 * listPresence — the pot's flock/check-in roster.
 *
 * `squadIds` (FLIGHT-001 #797): the caller's OWN accessible squad ids
 * (resolveAccessibleSquadIds). `undefined` (the default, and every
 * pre-existing caller — radar.ts, registry/presence-routes.ts, mcp/presence.ts,
 * concierge/service.ts, etc.) is UNRESTRICTED, so those callers' behavior is
 * unchanged; only the /fleet dashboard route passes this explicitly. `null` is
 * also unrestricted (an org-scope grant or legacy owner/admin). `[]` scopes to
 * nothing.
 *
 * `presence` rows have no squad column (a member check-in isn't squad-typed),
 * so scoping is derived two ways, matching either makes a row visible:
 *   1. the row's BOUND agent (member_tokens.agent_id, when set) belongs to
 *      one of the caller's squads (agents.squad_id).
 *   2. the CHECKING-IN member themself holds a capability grant (squad or
 *      department) that resolves into one of the caller's squads — i.e. a
 *      squadmate's presence is visible, a stranger's is not.
 * Filtered at the QUERY (WHERE), never post-fetch in JS.
 */
export async function listPresence(env: Env, nowMs: number, squadIds?: string[] | null): Promise<PresenceView[]> {
  let scopeClause = ''
  let idsJson: string | null = null
  if (squadIds !== undefined && squadIds !== null) {
    if (squadIds.length === 0) return []
    idsJson = JSON.stringify(squadIds)
    scopeClause = `
      AND (
        (agent_id IS NOT NULL AND agent_id IN (
          SELECT id FROM agents WHERE squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))
        ))
        OR member_id IN (
          SELECT member_id FROM capabilities
          WHERE (scope_type = 'squad' AND scope_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2)))
             OR (scope_type = 'department' AND scope_id IN (
                  SELECT department_id FROM squads WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))
                ))
        )
      )`
  }
  const statement = env.DB.prepare(`${PRESENCE_SELECT}${scopeClause} ORDER BY last_seen_at DESC LIMIT 200`)
  const bound = idsJson === null ? statement.bind(env.TENANT_SLUG) : statement.bind(env.TENANT_SLUG, idsJson)
  const res = await bound.all<PresenceRow>()
  const rows = (res.results ?? []).map((r) => {
    const ms = sqliteUtcToMs(r.last_seen_at)
    return {
      ...r,
      harness: r.harness || 'unknown',
      machine: r.machine ?? null,
      model: r.model ?? null,
      provider: r.provider ?? null,
      effort: r.effort ?? null,
      flight_id: r.flight_id ?? null,
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
