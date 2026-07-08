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

// Runtime control-surface view: the host row fields needed by /fleet and #agent-bus
// style surfaces. It intentionally excludes member/capability details.
export interface FleetAgentRuntimeView {
  agent_id: string
  display: string
  runtime: string
  squads: string[]
  status: string                         // stored INTENT: running | stopped (set by attach/detach)
  presence: Presence                     // DERIVED liveness from last_seen age vs TTL (live|stale|offline)
  lifecycle: string
  last_seen: string                      // last_reported_at
}

// Unified admin/API view: runtime row + identity (member) + capabilities.
// Returned by getAgentView — the rich data feed for admin roster/API consumers.
export interface AgentView extends FleetAgentRuntimeView {
  type: string                           // agent_type
  member: { id: string; email: string | null; display_name: string } | null
  capabilities: Array<{ scope_type: string; scope_id: string | null; capability: string }>
}

// Liveness derived from heartbeat recency — distinct from the stored `status` INTENT.
//   live    = status=running AND last_seen within TTL (a heartbeat arrived recently)
//   stale   = status=running BUT last_seen older than TTL (claims running, no recent ping)
//   offline = status=stopped (explicitly detached — intent wins over recency)
// Honest by construction: with no daemon emitting heartbeats yet, a one-shot attach goes
// `live` then decays to `stale` after the TTL — it never fakes liveness.
export type Presence = 'live' | 'stale' | 'offline'

/** Heartbeat freshness window (seconds). The fleet daemon re-attaches on a cadence; an agent
 *  is `live` only if its last attach/heartbeat landed within this window. Env-overridable. */
export const DEFAULT_PRESENCE_TTL_SEC = 180

export function presenceTtlSec(env: Env): number {
  const raw = Number((env as { FLEET_PRESENCE_TTL_SEC?: string }).FLEET_PRESENCE_TTL_SEC)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRESENCE_TTL_SEC
}

/** Pure liveness derivation. `lastReportedAt` is the SQLite UTC stamp 'YYYY-MM-DD HH:MM:SS'
 *  (written via datetime('now')). An unparseable/empty stamp is treated as NOT live (fail to
 *  stale, never to live). A future-dated stamp (clock skew) is still within TTL → live. */
export function derivePresence(
  status: string,
  lastReportedAt: string,
  ttlSec: number,
  nowMs: number,
): Presence {
  if (status === 'stopped') return 'offline'
  if (!lastReportedAt) return 'stale'
  const t = Date.parse(lastReportedAt.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return 'stale'
  const ageSec = (nowMs - t) / 1000
  return ageSec <= ttlSec ? 'live' : 'stale'
}

export type ReportResult =
  | { ok: true; count: number; skipped?: number }
  | { ok: false; reason: string }

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

/** Backfill tenant on any members row whose tenant is NULL. Idempotent — WHERE tenant IS NULL
 *  ensures only untagged rows are updated; subsequent calls are cheap no-ops. Run lazily before
 *  any tenant-scoped member check or join so pre-migration rows (Hadi + squad seed members) pick
 *  up env.TENANT_SLUG before the scoped query executes. Sterile-pot safe: the slug comes from
 *  the runtime env, never a hardcoded literal. */
async function backfillMemberTenant(env: Env): Promise<void> {
  await env.DB.prepare('UPDATE members SET tenant = ?1 WHERE tenant IS NULL')
    .bind(env.TENANT_SLUG)
    .run()
}

/** Upsert the reported agents. Rejects a malformed batch wholesale (all-or-nothing on validation),
 *  caps the count, and records which agent reported. Returns the number upserted.
 *
 *  member_id validation (fail-closed, tenant-scoped): if a report sets member_id, the referenced
 *  member MUST exist in THIS TENANT's members. An unknown or other-tenant member_id rejects the
 *  entire batch (BLOCK-1: prevents cross-tenant identity links from landing in the registry). The
 *  lazy backfill runs first so pre-migration NULL-tenant rows are scoped before the check. */
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
  // Signed-attach sovereignty (gate fix, P2): an agent that has a registered signing key
  // asserts its OWN identity by signature via /api/fleet/attach-signed. The daemon /report
  // path is an unsigned, observation-based bulk write — it must NOT be able to forge a keyed
  // agent's presence or rebind its member_id/agent_type/runtime. Keyed agents are FILTERED OUT
  // here, BEFORE any validation or write; their row is owned exclusively by the signed path
  // (and signed detach). Filtering first also closes a DoS lever: a keyed agent carrying a bad
  // member_id must not be able to fail the whole batch and suppress legit agents' reports.
  // Trades daemon-observed liveness for keyed agents (handled by their own attach/detach + a
  // future presence TTL) against the downgrade hole — same principle as the bearer /attach block.
  const keyed = new Set<string>()
  const keyRows = await env.DB.prepare('SELECT agent_id FROM agent_keys WHERE tenant = ?1')
    .bind(env.TENANT_SLUG)
    .all<{ agent_id: string }>()
  for (const k of keyRows.results ?? []) keyed.add(k.agent_id)

  const toWrite = valid.filter((v) => !keyed.has(v.agent_id))
  const skipped = valid.length - toWrite.length

  // Lazy backfill: stamp any NULL-tenant member rows before the tenant-scoped existence check.
  if (toWrite.some((v) => v.member_id)) {
    await backfillMemberTenant(env)
  }
  // member_id existence check: TENANT-SCOPED (fail-closed). Unknown or other-tenant → reject batch.
  for (const v of toWrite) {
    if (v.member_id) {
      const exists = await env.DB.prepare('SELECT 1 FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1')
        .bind(v.member_id, env.TENANT_SLUG)
        .first<{ 1: number }>()
      if (!exists) return { ok: false, reason: `member_id not found: ${v.member_id}` }
    }
  }

  let written = 0
  for (const v of toWrite) {
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
    written++
  }
  return skipped > 0 ? { ok: true, count: written, skipped } : { ok: true, count: written }
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

export async function listFleetAgentRuntimeView(env: Env, nowMs = Date.now()): Promise<FleetAgentRuntimeView[]> {
  const rows = await env.DB.prepare(
    `SELECT agent_id, display, runtime, squads, lifecycle, status, last_reported_at
       FROM fleet_agents WHERE tenant = ?1 ORDER BY agent_id ASC`,
  )
    .bind(env.TENANT_SLUG)
    .all<Record<string, unknown>>()

  const ttlSec = presenceTtlSec(env)
  return (rows.results ?? []).map((r) => {
    const status = String(r.status ?? 'unknown')
    const lastSeen = String(r.last_reported_at ?? '')
    return {
      agent_id: String(r.agent_id),
      display: String(r.display ?? ''),
      runtime: String(r.runtime ?? ''),
      squads: parseSquads(r.squads),
      status,
      presence: derivePresence(status, lastSeen, ttlSec, nowMs),
      lifecycle: String(r.lifecycle ?? ''),
      last_seen: lastSeen,
    }
  })
}

/**
 * getAgentView — unified read: LEFT JOIN fleet_agents ↔ members on member_id,
 * then resolve capabilities per linked member. Returns the canonical agent record
 * for the dashboard and #agent-bus feed (admin-gated; tenant-scoped).
 *
 * The JOIN is TENANT-BOUND (BLOCK-1 fix): `m.tenant = fa.tenant` ensures that in a
 * future shared-DB fork, a fleet row can only expose the member that belongs to the
 * SAME tenant, never a cross-tenant identity. The lazy backfill stamps pre-migration
 * NULL-tenant rows before the JOIN so existing members are visible immediately.
 *
 * SQL shape:
 *   SELECT fa.agent_id, fa.display, fa.agent_type, fa.runtime, fa.squads, fa.status, fa.lifecycle,
 *          fa.last_reported_at, fa.member_id,
 *          m.id AS m_id, m.email AS m_email, m.display_name AS m_display
 *   FROM fleet_agents fa
 *   LEFT JOIN members m ON m.id = fa.member_id AND m.tenant = fa.tenant
 *   WHERE fa.tenant = ?1
 *   ORDER BY fa.agent_id ASC
 */
export async function getAgentView(env: Env): Promise<AgentView[]> {
  // Lazy backfill: stamp any NULL-tenant member rows before the tenant-bound JOIN runs.
  await backfillMemberTenant(env)

  const rows = await env.DB.prepare(
    `SELECT fa.agent_id, fa.display, fa.agent_type, fa.runtime, fa.squads, fa.status, fa.lifecycle,
            fa.last_reported_at, fa.member_id,
            m.id AS m_id, m.email AS m_email, m.display_name AS m_display
       FROM fleet_agents fa
       LEFT JOIN members m ON m.id = fa.member_id AND m.tenant = fa.tenant
      WHERE fa.tenant = ?1
      ORDER BY fa.agent_id ASC`,
  )
    .bind(env.TENANT_SLUG)
    .all<Record<string, unknown>>()

  const out: AgentView[] = []
  const ttlSec = presenceTtlSec(env)
  const nowMs = Date.now()
  for (const r of rows.results ?? []) {
    // BLOCK-2 fix: derive everything from the JOINED column (m_id), not the raw fleet row's
    // member_id. The JOIN is tenant-bound (AND m.tenant = fa.tenant), so m_id is null when
    // the linked member belongs to a different tenant or doesn't exist. Using r.member_id here
    // bypasses that filter — a cross-tenant fa.member_id would still reach resolveCapabilities
    // and expose the foreign member's capabilities even though member is correctly null.
    // Only the tenant-matched joined identity may produce output (member + capabilities).
    const joinedId = r.m_id == null ? null : String(r.m_id)
    const capabilities = joinedId ? (await resolveCapabilities(env, joinedId)).map((g) => ({
      scope_type: g.scope_type,
      scope_id: g.scope_id,
      capability: g.capability,
    })) : []
    const status = String(r.status ?? 'unknown')
    const lastSeen = String(r.last_reported_at ?? '')
    out.push({
      agent_id: String(r.agent_id),
      display: String(r.display ?? ''),
      type: String(r.agent_type ?? 'generic'),
      runtime: String(r.runtime ?? ''),
      squads: parseSquads(r.squads),
      status,
      presence: derivePresence(status, lastSeen, ttlSec, nowMs),
      lifecycle: String(r.lifecycle ?? ''),
      last_seen: lastSeen,
      member: joinedId == null ? null : {
        id: joinedId,
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
