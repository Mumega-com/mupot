// Fleet agent registry (Deliverable 2 panel data layer).
//
// The host consumer daemon reports its controllable agents + live status; the dashboard reads them
// to render the roster + control buttons. This is a DISPLAY cache, never authority — control is
// separately owner-gated + signature-verified, so a stale/forged status row can only mislead the
// panel, never authorize a host action. Reports are accepted ONLY from the configured consumer agent.

import type { Env } from '../types'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const STATUSES = new Set(['running', 'stopped', 'unknown'])
const RUNTIMES = new Set(['codex', 'claude-code', 'nous', 'hermes-cron', 'systemd-user', 'tmux', 'python', ''])
const LIFECYCLES = new Set(['on_demand', 'always_on', ''])
const MAX_AGENTS = 200
const MAX_SQUADS = 16
const MAX_STR = 200

export interface FleetAgentReport {
  agent_id: string
  display?: string
  runtime?: string
  squads?: string[]
  lifecycle?: string
  provider_contract?: string | null
  status: string
}

export interface FleetAgentRow {
  agent_id: string
  display: string
  runtime: string
  squads: string[]
  lifecycle: string
  provider_contract: string | null
  status: string
  reported_by: string
  last_reported_at: string
}

export type ReportResult = { ok: true; count: number } | { ok: false; reason: string }

function cleanStr(v: unknown, max = MAX_STR): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function validReport(a: unknown): FleetAgentReport | null {
  if (!a || typeof a !== 'object') return null
  const r = a as Record<string, unknown>
  if (typeof r.agent_id !== 'string' || !AGENT_ID_RE.test(r.agent_id)) return null
  if (typeof r.status !== 'string' || !STATUSES.has(r.status)) return null
  const runtime = typeof r.runtime === 'string' && RUNTIMES.has(r.runtime) ? r.runtime : ''
  const lifecycle = typeof r.lifecycle === 'string' && LIFECYCLES.has(r.lifecycle) ? r.lifecycle : ''
  const squads = Array.isArray(r.squads)
    ? r.squads.filter((s): s is string => typeof s === 'string' && AGENT_ID_RE.test(s)).slice(0, MAX_SQUADS)
    : []
  const pc = typeof r.provider_contract === 'string' && AGENT_ID_RE.test(r.provider_contract) ? r.provider_contract : null
  return { agent_id: r.agent_id, display: cleanStr(r.display), runtime, squads, lifecycle, provider_contract: pc, status: r.status }
}

/** Upsert the reported agents. Rejects a malformed batch wholesale (all-or-nothing on validation),
 *  caps the count, and records which agent reported. Returns the number upserted. */
export async function reportFleetAgents(env: Env, reportedBy: string, agents: unknown): Promise<ReportResult> {
  if (!env.TENANT_SLUG) return { ok: false, reason: 'no_tenant' }
  if (!Array.isArray(agents)) return { ok: false, reason: 'agents must be an array' }
  if (agents.length > MAX_AGENTS) return { ok: false, reason: `too many agents (>${MAX_AGENTS})` }
  const valid: FleetAgentReport[] = []
  for (const a of agents) {
    const v = validReport(a)
    if (!v) return { ok: false, reason: 'invalid agent in batch' } // fail the batch, never silently drop
    valid.push(v)
  }
  for (const v of valid) {
    await env.DB.prepare(
      `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, provider_contract, status, reported_by, last_reported_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'))
       ON CONFLICT(tenant, agent_id) DO UPDATE SET
            display=excluded.display, runtime=excluded.runtime, squads=excluded.squads,
            lifecycle=excluded.lifecycle, provider_contract=excluded.provider_contract,
            status=excluded.status, reported_by=excluded.reported_by,
            last_reported_at=excluded.last_reported_at, updated_at=excluded.updated_at`,
    )
      .bind(v.agent_id, env.TENANT_SLUG, v.display, v.runtime, JSON.stringify(v.squads), v.lifecycle, v.provider_contract, v.status, reportedBy)
      .run()
  }
  return { ok: true, count: valid.length }
}

export async function listFleetAgents(env: Env): Promise<FleetAgentRow[]> {
  const rows = await env.DB.prepare(
    `SELECT agent_id, display, runtime, squads, lifecycle, provider_contract, status, reported_by, last_reported_at
       FROM fleet_agents WHERE tenant = ?1 ORDER BY agent_id ASC`,
  )
    .bind(env.TENANT_SLUG)
    .all<Record<string, unknown>>()
  return (rows.results ?? []).map((r) => ({
    agent_id: String(r.agent_id),
    display: String(r.display ?? ''),
    runtime: String(r.runtime ?? ''),
    squads: parseSquads(r.squads),
    lifecycle: String(r.lifecycle ?? ''),
    provider_contract: r.provider_contract == null ? null : String(r.provider_contract),
    status: String(r.status ?? 'unknown'),
    reported_by: String(r.reported_by ?? ''),
    last_reported_at: String(r.last_reported_at ?? ''),
  }))
}

function parseSquads(v: unknown): string[] {
  if (typeof v !== 'string') return []
  try {
    const a = JSON.parse(v)
    return Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}
