// runtime-truth — ONE read-time derivation of "what harness and model is this agent running
// right now" (mupot task fca29748). Design: agents/kasra/docs/runtime-truth-single-writer-20261104.md.
//
// Three stores used to answer this independently (presence, fleet_agents, agents.model) and
// disagreed (check_in said claude-code while fleet_agents said codex). Readers now ask HERE.
//
// Precedence, per field (harness, model), never a write:
//   1. the agent's newest check_in row (presence) while it is ACTIVE (<=10 min, the one shared
//      liveness window) and it states that field -> source 'check_in'.
//   2. otherwise the newer of {stale check_in, fleet_agents row} -> 'check_in' | 'fleet_attach'.
//   3. otherwise agents.model (model only) -> 'identity_profile'.
// `stale` is true unless the winning value is from an active check_in or a fleet report inside
// the same window. Disagreeing lower-precedence values are listed in `conflicts`, never hidden.
// Read-only: no column changes meaning, nothing is written.

import type { Env } from '../types'
import { classify } from '../dashboard/fleet'
import { sqliteUtcToMs } from './presence'

export type RuntimeSource = 'check_in' | 'fleet_attach' | 'identity_profile'

export interface RuntimeConflict {
  source: RuntimeSource
  harness: string | null
  model: string | null
}

export interface RuntimeTruth {
  harness: string | null
  model: string | null
  harness_source: RuntimeSource | null
  model_source: RuntimeSource | null
  /** The timestamp (SQLite UTC) of the newest observation that supplied harness or model. */
  as_of: string | null
  /** True when the answer is not backed by an observation inside the active window. */
  stale: boolean
  conflicts: RuntimeConflict[]
}

export interface RuntimeTruthAgent {
  id: string
  slug: string
  /** agents.model: the operator-declared profile value, never live evidence. */
  model: string | null
}

interface Observation {
  source: RuntimeSource
  harness: string | null
  model: string | null
  asOf: string | null
}

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  // 'unknown' is the presence default for "no harness stated", not a claim.
  return t === '' || t === 'unknown' ? null : t
}

/** Pure derivation. `check` is the agent's newest presence row, `fleet` its fleet_agents row. */
export function deriveRuntimeTruth(
  agent: Pick<RuntimeTruthAgent, 'model'>,
  check: { harness: unknown; model: unknown; last_seen_at: string | null } | null,
  fleet: { runtime: unknown; model: unknown; last_reported_at: string | null } | null,
  nowMs: number,
): RuntimeTruth {
  const obs: Observation[] = []
  if (check) obs.push({ source: 'check_in', harness: clean(check.harness), model: clean(check.model), asOf: check.last_seen_at })
  if (fleet) obs.push({ source: 'fleet_attach', harness: clean(fleet.runtime), model: clean(fleet.model), asOf: fleet.last_reported_at })

  const active = (o: Observation): boolean => classify(sqliteUtcToMs(o.asOf), nowMs) === 'active'
  // Active check_in first; then newest timestamp (ties go to the fleet row, which is the older
  // and richer evidence). Sorting once gives one ordering for BOTH fields.
  const ordered = [...obs].sort((a, b) => {
    const aTop = a.source === 'check_in' && active(a)
    const bTop = b.source === 'check_in' && active(b)
    if (aTop !== bTop) return aTop ? -1 : 1
    const d = (sqliteUtcToMs(b.asOf) ?? 0) - (sqliteUtcToMs(a.asOf) ?? 0)
    if (d !== 0) return d
    return a.source === 'fleet_attach' ? -1 : 1
  })

  const pick = (field: 'harness' | 'model'): Observation | null => ordered.find((o) => o[field] !== null) ?? null
  const h = pick('harness')
  const m = pick('model')
  const profileModel = clean(agent.model)

  const model = m ? m.model : profileModel
  const modelSource: RuntimeSource | null = m ? m.source : profileModel ? 'identity_profile' : null

  const winners = [h, m].filter((o): o is Observation => o !== null)
  const stale = winners.length === 0 ? model !== null : winners.some((o) => !active(o))
  const asOf = winners.reduce<string | null>((best, o) => {
    if (!o.asOf) return best
    return best === null || (sqliteUtcToMs(o.asOf) ?? 0) > (sqliteUtcToMs(best) ?? 0) ? o.asOf : best
  }, null)

  const conflicts: RuntimeConflict[] = ordered
    .filter((o) => {
      const hDiffers = o.harness !== null && h !== null && o.harness !== h.harness
      const mDiffers = o.model !== null && model !== null && o.model !== model
      return hDiffers || mDiffers
    })
    .map((o) => ({ source: o.source, harness: o.harness, model: o.model }))

  return {
    harness: h ? h.harness : null,
    model,
    harness_source: h ? h.source : null,
    model_source: modelSource,
    as_of: asOf,
    stale,
    conflicts,
  }
}

interface PresenceRow { agent_id: string; harness: string | null; model: string | null; last_seen_at: string | null }
interface FleetRow { agent_id: string; runtime: string | null; model: string | null; last_reported_at: string | null }

/**
 * Batch loader: one presence query and one fleet query for the whole roster. Fleet rows are
 * matched by agents.id first; a slug-keyed row is used only when no id-keyed row exists (the
 * identifier-space bridge documented in registry.ts). Fail-soft: a read error degrades to the
 * stored-profile answer, because an annotation must never break the tool it decorates.
 */
export async function loadRuntimeTruth(
  env: Env,
  agents: ReadonlyArray<RuntimeTruthAgent>,
  nowMs = Date.now(),
): Promise<Map<string, RuntimeTruth>> {
  const out = new Map<string, RuntimeTruth>()
  if (agents.length === 0) return out
  let presence: PresenceRow[] = []
  let fleet: FleetRow[] = []
  try {
    const ids = agents.map((a) => a.id)
    const keys = [...new Set([...ids, ...agents.map((a) => a.slug)])]
    const idMarks = ids.map((_, i) => `?${i + 2}`).join(',')
    const p = await env.DB.prepare(
      `SELECT agent_id, harness, model, last_seen_at FROM presence
        WHERE tenant = ?1 AND agent_id IN (${idMarks})
        ORDER BY last_seen_at DESC, rowid DESC`,
    ).bind(env.TENANT_SLUG, ...ids).all<PresenceRow>()
    presence = p.results ?? []
    const keyMarks = keys.map((_, i) => `?${i + 2}`).join(',')
    const f = await env.DB.prepare(
      `SELECT agent_id, runtime, model, last_reported_at FROM fleet_agents
        WHERE tenant = ?1 AND agent_id IN (${keyMarks})`,
    ).bind(env.TENANT_SLUG, ...keys).all<FleetRow>()
    fleet = f.results ?? []
  } catch {
    // fall through with whatever loaded; the derivation handles absence
  }
  const newestPresence = new Map<string, PresenceRow>()
  for (const r of presence) if (!newestPresence.has(r.agent_id)) newestPresence.set(r.agent_id, r)
  const fleetByKey = new Map(fleet.map((r) => [r.agent_id, r]))
  for (const a of agents) {
    out.set(a.id, deriveRuntimeTruth(a, newestPresence.get(a.id) ?? null, fleetByKey.get(a.id) ?? fleetByKey.get(a.slug) ?? null, nowMs))
  }
  return out
}
