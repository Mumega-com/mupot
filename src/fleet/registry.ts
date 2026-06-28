// Fleet agent registry (Deliverable 2 panel data layer).
//
// The host consumer daemon reports its controllable agents + live status; the dashboard reads them
// to render the roster + control buttons. This is a DISPLAY cache, never authority — control is
// separately owner-gated + signature-verified, so a stale/forged status row can only mislead the
// panel, never authorize a host action. Reports are accepted ONLY from the configured consumer agent.

import type { Env } from '../types'
import { resolveCapabilities } from '../auth/capability'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const STATUSES = new Set(['running', 'stopped', 'unknown'])
const RUNTIMES = new Set(['codex', 'claude-code', 'nous', 'hermes-cron', 'systemd-user', 'tmux', 'python', ''])
const LIFECYCLES = new Set(['on_demand', 'always_on', ''])
// Valid agent type values — what KIND of agent, not the runtime it runs on.
const AGENT_TYPES = new Set(['builder', 'reviewer', 'weaver', 'brain', 'comms', 'generic'])
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
  // Optional identity fields — Step 1 of "agent running on mupot".
  agent_type?: string      // builder|reviewer|weaver|brain|comms|generic; defaults 'generic'
  member_id?: string | null  // mupot members.id; validated to exist if supplied
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
  agent_type: string
  member_id: string | null
}

// Unified view: runtime row + identity (member) + capabilities.
// Returned by getAgentView — the data feed for the dashboard and #agent-bus.
export interface AgentView {
  agent_id: string
  type: string                           // agent_type
  runtime: string
  status: string
  lifecycle: string
  last_seen: string                      // last_reported_at
  member: { id: string; email: string | null; display_name: string } | null
  capabilities: Array<{ scope_type: string; scope_id: string | null; capability: string }>
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
  // agent_type: if provided must be a known value; omitted → 'generic'. Unknown value rejects the batch.
  let agent_type: string
  if (r.agent_type === undefined || r.agent_type === null) {
    agent_type = 'generic'
  } else if (typeof r.agent_type === 'string' && AGENT_TYPES.has(r.agent_type)) {
    agent_type = r.agent_type
  } else {
    return null // unknown agent_type → reject (fail-closed)
  }
  // member_id: if provided must match AGENT_ID_RE format (server-validated existence check happens in reportFleetAgents).
  let member_id: string | null = null
  if (r.member_id != null) {
    if (typeof r.member_id !== 'string' || !AGENT_ID_RE.test(r.member_id)) return null
    member_id = r.member_id
  }
  return { agent_id: r.agent_id, display: cleanStr(r.display), runtime, squads, lifecycle, provider_contract: pc, status: r.status, agent_type, member_id }
}

/** Upsert the reported agents. Rejects a malformed batch wholesale (all-or-nothing on validation),
 *  caps the count, and records which agent reported. Returns the number upserted.
 *
 *  member_id validation (fail-closed): if a report sets member_id, the referenced member MUST
 *  exist in the members table — the entire batch is rejected if any member_id is unknown. This
 *  prevents stale or forged identity links from silently landing in the registry. */
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
  // member_id existence check: validate ALL member_ids before any writes (fail-closed).
  for (const v of valid) {
    if (v.member_id) {
      const exists = await env.DB.prepare('SELECT 1 FROM members WHERE id = ?1 LIMIT 1')
        .bind(v.member_id)
        .first<{ 1: number }>()
      if (!exists) return { ok: false, reason: `member_id not found: ${v.member_id}` }
    }
  }
  for (const v of valid) {
    await env.DB.prepare(
      `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, provider_contract, status, reported_by, agent_type, member_id, last_reported_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'), datetime('now'))
       ON CONFLICT(tenant, agent_id) DO UPDATE SET
            display=excluded.display, runtime=excluded.runtime, squads=excluded.squads,
            lifecycle=excluded.lifecycle, provider_contract=excluded.provider_contract,
            status=excluded.status, reported_by=excluded.reported_by,
            agent_type=excluded.agent_type, member_id=excluded.member_id,
            last_reported_at=excluded.last_reported_at, updated_at=excluded.updated_at`,
    )
      .bind(v.agent_id, env.TENANT_SLUG, v.display, v.runtime, JSON.stringify(v.squads), v.lifecycle, v.provider_contract, v.status, reportedBy, v.agent_type ?? 'generic', v.member_id ?? null)
      .run()
  }
  return { ok: true, count: valid.length }
}

export async function listFleetAgents(env: Env): Promise<FleetAgentRow[]> {
  const rows = await env.DB.prepare(
    `SELECT agent_id, display, runtime, squads, lifecycle, provider_contract, status, reported_by, last_reported_at, agent_type, member_id
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
    agent_type: String(r.agent_type ?? 'generic'),
    member_id: r.member_id == null ? null : String(r.member_id),
  }))
}

/**
 * getAgentView — unified read: LEFT JOIN fleet_agents ↔ members on member_id,
 * then resolve capabilities per linked member. Returns the canonical agent record
 * for the dashboard and #agent-bus feed (admin-gated; tenant-scoped).
 *
 * SQL shape:
 *   SELECT fa.agent_id, fa.agent_type, fa.runtime, fa.status, fa.lifecycle,
 *          fa.last_reported_at, fa.member_id,
 *          m.id AS m_id, m.email AS m_email, m.display_name AS m_display
 *   FROM fleet_agents fa
 *   LEFT JOIN members m ON m.id = fa.member_id
 *   WHERE fa.tenant = ?1
 *   ORDER BY fa.agent_id ASC
 */
export async function getAgentView(env: Env): Promise<AgentView[]> {
  const rows = await env.DB.prepare(
    `SELECT fa.agent_id, fa.agent_type, fa.runtime, fa.status, fa.lifecycle,
            fa.last_reported_at, fa.member_id,
            m.id AS m_id, m.email AS m_email, m.display_name AS m_display
       FROM fleet_agents fa
       LEFT JOIN members m ON m.id = fa.member_id
      WHERE fa.tenant = ?1
      ORDER BY fa.agent_id ASC`,
  )
    .bind(env.TENANT_SLUG)
    .all<Record<string, unknown>>()

  const out: AgentView[] = []
  for (const r of rows.results ?? []) {
    const memberId = r.member_id == null ? null : String(r.member_id)
    const capabilities = memberId ? (await resolveCapabilities(env, memberId)).map((g) => ({
      scope_type: g.scope_type,
      scope_id: g.scope_id,
      capability: g.capability,
    })) : []
    out.push({
      agent_id: String(r.agent_id),
      type: String(r.agent_type ?? 'generic'),
      runtime: String(r.runtime ?? ''),
      status: String(r.status ?? 'unknown'),
      lifecycle: String(r.lifecycle ?? ''),
      last_seen: String(r.last_reported_at ?? ''),
      member: r.m_id == null ? null : {
        id: String(r.m_id),
        email: r.m_email == null ? null : String(r.m_email),
        display_name: String(r.m_display ?? ''),
      },
      capabilities,
    })
  }
  return out
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
