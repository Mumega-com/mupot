// runtime-truth — ONE read-time derivation of "what harness and model is this agent running
// right now" (mupot task fca29748). Design: agents/kasra/docs/runtime-truth-single-writer-20261104.md.
//
// Three stores used to answer this independently (presence, fleet_agents, agents.model) and
// disagreed. Readers now ask HERE. Read-only: nothing is written, no column changes meaning.
//
// Per field (harness, model) independently:
//   1. the newest presence row INSIDE the active window that STATES the field (non-empty, not
//      'unknown', passes the charset gate). A heartbeat row that states nothing (touchPresence:
//      label '', harness 'unknown', model NULL) is never a candidate for a field it did not state.
//   2. else the newest of {older presence rows that state it, the fleet_agents row}; ties to fleet.
//   3. else agents.model (model only), trust 'profile'.
// Other seats / the registry that DISAGREE are listed in `conflicts`; the winner never is.
//
// FRESHNESS IS ROW LIVENESS, NOT ASSERTION TIME. presence.last_seen_at and
// fleet_agents.last_reported_at slide on heartbeats that re-state nothing, and there is no
// per-field "stated at" column yet (phase 2, additive). So `freshness: 'live_row'` means "a row
// seen inside the active window carries this value", never "this value was stated recently".
// `stale` is true when ANY returned field lacks even that, or is a profile fallback.
//
// TRUST: a check_in value is typed by the caller: trust 'self_reported', attested false. A fleet
// value is attested only when the agent holds a registered signing key (its fleet row then moves
// by signature only: bearer attach, boot report and the daemon all refuse it).

import type { Env } from '../types'
import { classify } from '../dashboard/fleet'
import { sqliteUtcToMs } from './presence'
import { MODEL_RE } from './boot-self-report'

export type RuntimeSource = 'check_in' | 'fleet_attach' | 'identity_profile'
export type RuntimeTrust = 'self_reported' | 'attested' | 'profile'

export interface RuntimeField {
  value: string
  source: RuntimeSource
  trust: RuntimeTrust
  attested: boolean
  /** Newest row-liveness time (SQLite UTC) of the winning row, clamped to now. NOT an assertion time. */
  as_of: string | null
  freshness: 'live_row' | 'stale'
}

export interface RuntimeConflict {
  field: 'harness' | 'model'
  source: RuntimeSource
  seat: string | null
  value: string
  as_of: string | null
}

export interface RuntimeTruth {
  harness: RuntimeField | null
  model: RuntimeField | null
  stale: boolean
  /** True when a read failed and this answer may be missing evidence. Never silent. */
  degraded: boolean
  conflicts: RuntimeConflict[]
}

export interface RuntimeTruthAgent {
  id: string
  slug: string
  /** agents.model: the operator-declared profile value, never live evidence. */
  model: string | null
}

export interface PresenceObservation { label: string | null; harness: unknown; model: unknown; last_seen_at: string | null }
export interface FleetObservation { runtime: unknown; model: unknown; last_reported_at: string | null }

const MAX_CONFLICTS = 10
const FUTURE_SKEW_MS = 60_000

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  // 'unknown' is the presence default for "stated nothing". The charset gate stops free text
  // (a caller-typed sentence) from ever being echoed as a runtime value.
  return t === '' || t === 'unknown' || !MODEL_RE.test(t) ? null : t
}

interface Candidate {
  source: 'check_in' | 'fleet_attach'
  seat: string | null
  value: string
  atMs: number
  at: string | null
  active: boolean
}

type Field = 'harness' | 'model'

/** Pure derivation. Future-dated times are clamped to `nowMs`. */
export function deriveRuntimeTruth(
  agent: Pick<RuntimeTruthAgent, 'model'>,
  presence: ReadonlyArray<PresenceObservation>,
  fleet: FleetObservation | null,
  keyed: boolean,
  nowMs: number,
  degraded = false,
): RuntimeTruth {
  const stamp = (raw: string | null): { ms: number; at: string | null; future: boolean } => {
    const ms = sqliteUtcToMs(raw)
    if (ms === null) return { ms: 0, at: null, future: false }
    // A row dated beyond a small clock-skew allowance is not evidence of liveness: clamp its time, never call it active.
    const future = ms > nowMs + FUTURE_SKEW_MS
    return { ms: Math.min(ms, nowMs), at: ms > nowMs ? new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ') : raw, future }
  }
  const candidatesFor = (field: Field): Candidate[] => {
    const out: Candidate[] = []
    for (const p of presence) {
      const value = clean(p[field])
      if (value === null) continue
      const t = stamp(p.last_seen_at)
      out.push({ source: 'check_in', seat: p.label ?? null, value, atMs: t.ms, at: t.at, active: !t.future && classify(t.ms || null, nowMs) === 'active' })
    }
    if (fleet) {
      const value = clean(field === 'harness' ? fleet.runtime : fleet.model)
      if (value !== null) {
        const t = stamp(fleet.last_reported_at)
        out.push({ source: 'fleet_attach', seat: null, value, atMs: t.ms, at: t.at, active: !t.future && classify(t.ms || null, nowMs) === 'active' })
      }
    }
    return out
  }
  const rank = (a: Candidate, b: Candidate): number => {
    // A KEYED agent's fleet value is signature-only (attested); a bearer check_in must not outrank it on display.
    const top = (c: Candidate): boolean => (keyed ? c.source === 'fleet_attach' : c.source === 'check_in' && c.active)
    const aTop = top(a)
    const bTop = top(b)
    if (aTop !== bTop) return aTop ? -1 : 1
    if (b.atMs !== a.atMs) return b.atMs - a.atMs
    if (a.source !== b.source) return a.source === 'fleet_attach' ? -1 : 1
    return 0
  }

  const conflicts: RuntimeConflict[] = []
  const seen = new Set<string>()
  const resolve = (field: Field, profile: string | null): RuntimeField | null => {
    const ranked = candidatesFor(field).sort(rank)
    const win = ranked[0]
    if (win) {
      for (const c of ranked.slice(1)) {
        // Only LIVE disagreement is a conflict; an old row from a retired seat is history, not news.
        if (c.value === win.value || !c.active) continue
        const key = `${field}|${c.source}|${c.seat ?? ''}|${c.value}`
        if (seen.has(key)) continue
        seen.add(key)
        conflicts.push({ field, source: c.source, seat: c.seat, value: c.value, as_of: c.at })
      }
      const attested = win.source === 'fleet_attach' && keyed
      return {
        value: win.value,
        source: win.source,
        trust: attested ? 'attested' : 'self_reported',
        attested,
        as_of: win.at,
        freshness: win.active ? 'live_row' : 'stale',
      }
    }
    const p = field === 'model' ? clean(profile) : null
    return p === null ? null : { value: p, source: 'identity_profile', trust: 'profile', attested: false, as_of: null, freshness: 'stale' }
  }

  const harness = resolve('harness', null)
  const model = resolve('model', agent.model)
  const fields = [harness, model].filter((f): f is RuntimeField => f !== null)
  return {
    harness,
    model,
    stale: fields.length === 0 || fields.some((f) => f.freshness === 'stale'),
    degraded,
    conflicts: conflicts.slice(0, MAX_CONFLICTS),
  }
}

interface PresenceRow extends PresenceObservation { agent_id: string }
interface FleetRow extends FleetObservation { agent_id: string }

const PRESENCE_WINDOW_MS = 24 * 60 * 60 * 1000
const PRESENCE_ROW_CAP = 2000

function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Batch loader: three queries for the whole roster, ids passed as ONE json parameter
 * (`IN (SELECT value FROM json_each(?))`) so D1's 100-bound-parameter limit never applies.
 * A failed read sets `degraded: true` on every answer; it never throws and never hides.
 * Fleet rows match agents.id first, a slug-keyed row only when no id-keyed row exists.
 */
export async function loadRuntimeTruth(
  env: Env,
  agents: ReadonlyArray<RuntimeTruthAgent>,
  nowMs = Date.now(),
): Promise<Map<string, RuntimeTruth>> {
  const out = new Map<string, RuntimeTruth>()
  if (agents.length === 0) return out
  let degraded = false
  let presence: PresenceRow[] = []
  let fleet: FleetRow[] = []
  let keyedIds = new Set<string>()
  // Slug-keyed fleet rows are usable only for a slug that is unique across agents AND not itself
  // some agent's id: the same rule as registry.ts readFleetAgentRow (mupot#1494 class).
  let slugOk = new Set<string>()
  const idsJson = JSON.stringify(agents.map((a) => a.id))
  const keysJson = JSON.stringify([...new Set([...agents.map((a) => a.id), ...agents.map((a) => a.slug)])])
  try {
    const p = await env.DB.prepare(
      `SELECT agent_id, label, harness, model, last_seen_at FROM presence
        WHERE tenant = ?1 AND last_seen_at >= ?3
          AND agent_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))
        ORDER BY last_seen_at DESC, rowid DESC LIMIT ${PRESENCE_ROW_CAP}`,
    ).bind(env.TENANT_SLUG, idsJson, sqliteUtc(nowMs - PRESENCE_WINDOW_MS)).all<PresenceRow>()
    presence = p.results ?? []
  } catch {
    degraded = true
  }
  try {
    const f = await env.DB.prepare(
      `SELECT agent_id, runtime, model, last_reported_at FROM fleet_agents
        WHERE tenant = ?1 AND agent_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))`,
    ).bind(env.TENANT_SLUG, keysJson).all<FleetRow>()
    fleet = f.results ?? []
  } catch {
    degraded = true
  }
  try {
    const k = await env.DB.prepare(
      `SELECT agent_id FROM agent_keys
        WHERE tenant = ?1 AND agent_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))`,
    ).bind(env.TENANT_SLUG, keysJson).all<{ agent_id: string }>()
    keyedIds = new Set((k.results ?? []).map((r) => r.agent_id))
  } catch {
    degraded = true
  }
  try {
    const slugsJson = JSON.stringify([...new Set(agents.map((a) => a.slug))])
    const c = await env.DB.prepare(
      `SELECT slug, COUNT(*) AS n FROM agents
        WHERE slug IN (SELECT CAST(value AS TEXT) FROM json_each(?1)) GROUP BY slug`,
    ).bind(slugsJson).all<{ slug: string; n: number }>()
    const clash = await env.DB.prepare(
      `SELECT id FROM agents WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))`,
    ).bind(slugsJson).all<{ id: string }>()
    const ids = new Set((clash.results ?? []).map((r) => r.id))
    slugOk = new Set((c.results ?? []).filter((r) => Number(r.n) === 1 && !ids.has(r.slug)).map((r) => r.slug))
  } catch {
    degraded = true
  }
  const presenceBy = new Map<string, PresenceRow[]>()
  for (const r of presence) presenceBy.set(r.agent_id, [...(presenceBy.get(r.agent_id) ?? []), r])
  const fleetByKey = new Map(fleet.map((r) => [r.agent_id, r]))
  for (const a of agents) {
    const row = fleetByKey.get(a.id) ?? (slugOk.has(a.slug) ? fleetByKey.get(a.slug) : undefined) ?? null
    // A fleet value is attested only when the key is registered under the SAME id as the row that
    // supplied it. A uuid row written over a bearer (keys held under the slug) stays self_reported.
    const keyed = row !== null && keyedIds.has(row.agent_id)
    out.set(a.id, deriveRuntimeTruth(a, presenceBy.get(a.id) ?? [], row, keyed, nowMs, degraded))
  }
  return out
}
