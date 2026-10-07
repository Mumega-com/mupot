// src/harness/capacity.ts — mupot#1765 (epic #1590): read-only harness capacity snapshots.
//
// Counts only. Stale = unknown, never zero load. Saturation is ADVISORY (never refuses dispatch).

import type { Env } from '../types'

export const HARNESSES = ['orca', 'herdr'] as const
export type Harness = (typeof HARNESSES)[number]

/** A snapshot received longer ago than this is UNKNOWN load, not zero load. */
export const CAPACITY_FRESH_MS = 5 * 60 * 1000
export const SUMMARY_MAX_BYTES = 4096
const MAX_COUNT = 1_000_000
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000
const HOST_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/
const SUMMARY_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/
const MAX_SUMMARY_KEYS = 24

export const COUNT_FIELDS = [
  'live_terminals',
  'agent_sessions',
  'busy_recent',
  'orphaned_terminals',
  'workers_active',
  'workers_release_unknown',
  'worktrees_with_live',
] as const
export type CountField = (typeof COUNT_FIELDS)[number]

export interface CapacityInput {
  harness: Harness
  host_key: string
  observed_at: number
  counts: Record<CountField, number>
  max_agents: number | null | undefined
  summary: Record<string, number>
}

export type ParseResult = { ok: true; value: CapacityInput } | { ok: false; error: string }

function isCount(v: unknown, max = MAX_COUNT): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
}

/** Strict validation. Anything resembling free text (non-number summary values) is rejected. */
export function parseCapacityArgs(args: Record<string, unknown>, now: number): ParseResult {
  // Defense in depth with the tool schema's additionalProperties:false — reporter identity and any
  // other unknown field can never ride along, even if the schema layer were relaxed.
  const allowed = new Set<string>(['harness', 'host_key', 'observed_at', 'max_agents', 'summary', ...COUNT_FIELDS])
  for (const k of Object.keys(args)) if (!allowed.has(k)) return { ok: false, error: 'unknown_field' }
  const harness = args.harness
  if (harness !== 'orca' && harness !== 'herdr') return { ok: false, error: 'invalid_harness' }
  const hostKey = args.host_key
  if (typeof hostKey !== 'string' || !HOST_KEY_RE.test(hostKey)) return { ok: false, error: 'invalid_host_key' }
  const observed = args.observed_at
  if (!isCount(observed, Number.MAX_SAFE_INTEGER) || observed > now + MAX_FUTURE_SKEW_MS) {
    return { ok: false, error: 'invalid_observed_at' }
  }
  const counts = {} as Record<CountField, number>
  for (const f of COUNT_FIELDS) {
    const v = args[f]
    if (!isCount(v)) return { ok: false, error: `invalid_${f}` }
    counts[f] = v
  }
  let maxAgents: number | null | undefined
  if (args.max_agents !== undefined) {
    if (!isCount(args.max_agents, 100_000)) return { ok: false, error: 'invalid_max_agents' }
    maxAgents = args.max_agents
  }
  const summary: Record<string, number> = {}
  if (args.summary !== undefined) {
    const s = args.summary
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return { ok: false, error: 'invalid_summary' }
    const entries = Object.entries(s)
    if (entries.length > MAX_SUMMARY_KEYS) return { ok: false, error: 'invalid_summary' }
    for (const [k, v] of entries) {
      if (!SUMMARY_KEY_RE.test(k) || !isCount(v)) return { ok: false, error: 'invalid_summary' }
      summary[k] = v
    }
    if (JSON.stringify(summary).length > SUMMARY_MAX_BYTES) return { ok: false, error: 'summary_too_large' }
  }
  return { ok: true, value: { harness, host_key: hostKey, observed_at: observed, counts, max_agents: maxAgents, summary } }
}

export interface CapacityRow {
  id: string
  tenant: string
  harness: Harness
  host_key: string
  reporter_agent_id: string
  observed_at: number
  received_at: number
  live_terminals: number
  agent_sessions: number
  busy_recent: number
  orphaned_terminals: number
  workers_active: number
  workers_release_unknown: number
  worktrees_with_live: number
  max_agents: number | null
  summary_json: string
}

export function isFresh(receivedAt: number, now: number): boolean {
  return now - receivedAt <= CAPACITY_FRESH_MS
}

/** saturated = policy ceiling set AND sessions at/over it. Only meaningful when fresh. */
export function isSaturated(row: Pick<CapacityRow, 'max_agents' | 'agent_sessions'>): boolean {
  return row.max_agents !== null && row.agent_sessions >= row.max_agents
}

export interface CapacityView extends CapacityRow {
  fresh: boolean
  /** Stale snapshots are never reported saturated: stale = unknown, not a verdict. */
  saturated: boolean
  age_ms: number
}

export function toView(row: CapacityRow, now: number): CapacityView {
  const fresh = isFresh(row.received_at, now)
  return { ...row, fresh, saturated: fresh && isSaturated(row), age_ms: Math.max(0, now - row.received_at) }
}

export async function upsertCapacity(
  env: Env,
  reporterAgentId: string,
  input: CapacityInput,
  now: number,
): Promise<CapacityRow | null> {
  const tenant = env.TENANT_SLUG || 'mumega'
  await env.DB.prepare(
    `INSERT INTO harness_capacity_snapshots
       (id, tenant, harness, host_key, reporter_agent_id, observed_at, received_at,
        live_terminals, agent_sessions, busy_recent, orphaned_terminals, workers_active,
        workers_release_unknown, worktrees_with_live, max_agents, summary_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
     ON CONFLICT(tenant, harness, host_key, reporter_agent_id) DO UPDATE SET
       observed_at = excluded.observed_at,
       received_at = excluded.received_at,
       live_terminals = excluded.live_terminals,
       agent_sessions = excluded.agent_sessions,
       busy_recent = excluded.busy_recent,
       orphaned_terminals = excluded.orphaned_terminals,
       workers_active = excluded.workers_active,
       workers_release_unknown = excluded.workers_release_unknown,
       worktrees_with_live = excluded.worktrees_with_live,
       max_agents = COALESCE(excluded.max_agents, harness_capacity_snapshots.max_agents),
       summary_json = excluded.summary_json
     WHERE excluded.observed_at >= harness_capacity_snapshots.observed_at`,
  )
    .bind(
      crypto.randomUUID(), tenant, input.harness, input.host_key, reporterAgentId, input.observed_at, now,
      input.counts.live_terminals, input.counts.agent_sessions, input.counts.busy_recent,
      input.counts.orphaned_terminals, input.counts.workers_active, input.counts.workers_release_unknown,
      input.counts.worktrees_with_live, input.max_agents ?? null, JSON.stringify(input.summary),
    )
    .run()
  return env.DB.prepare(
    'SELECT * FROM harness_capacity_snapshots WHERE tenant = ?1 AND harness = ?2 AND host_key = ?3 AND reporter_agent_id = ?4',
  )
    .bind(tenant, input.harness, input.host_key, reporterAgentId)
    .first<CapacityRow>()
}

export async function listCapacity(env: Env, now: number, harness?: Harness, limit = 100): Promise<CapacityView[]> {
  const tenant = env.TENANT_SLUG || 'mumega'
  const cap = Math.min(Math.max(1, Math.trunc(limit)), 200)
  const res = harness
    ? await env.DB.prepare(
        'SELECT * FROM harness_capacity_snapshots WHERE tenant = ?1 AND harness = ?2 ORDER BY received_at DESC LIMIT ?3',
      ).bind(tenant, harness, cap).all<CapacityRow>()
    : await env.DB.prepare(
        'SELECT * FROM harness_capacity_snapshots WHERE tenant = ?1 ORDER BY received_at DESC LIMIT ?2',
      ).bind(tenant, cap).all<CapacityRow>()
  return (res.results ?? []).map((r) => toView(r, now))
}

/**
 * Dispatch advisory: tags for FRESH saturated snapshots. One bounded D1 read. Never throws —
 * an advisory must not be able to break dispatch (e.g. older DB without the table).
 */
export async function saturatedHarnessAdvisories(env: Env, now: number = Date.now()): Promise<string[]> {
  try {
    const tenant = env.TENANT_SLUG || 'mumega'
    const res = await env.DB.prepare(
      `SELECT harness, host_key FROM harness_capacity_snapshots
        WHERE tenant = ?1 AND received_at >= ?2 AND max_agents IS NOT NULL AND agent_sessions >= max_agents
        ORDER BY harness, host_key LIMIT 10`,
    )
      .bind(tenant, now - CAPACITY_FRESH_MS)
      .all<{ harness: string; host_key: string }>()
    return (res.results ?? []).map((r) => `harness_capacity_saturated:${r.harness}:${r.host_key}`)
  } catch {
    return []
  }
}
