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
// Host is UNTRUSTED, agent-controlled, DISPLAY-ONLY (#21 slice 2) — a short cap keeps a
// hostile/garbage value from bloating the row or the rendered radar; truncate, never reject
// the batch over it (host is cosmetic, not a correctness gate).
const MAX_HOST = 64

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
  // Optional physical-machine signal — Step 2 of "agent running on mupot" (#21 slice 2).
  // UNTRUSTED, agent-controlled (os.hostname() on the runtime host): display-only, never
  // used for auth/routing. Absent (old runtimes) → '' (backward compatible).
  host?: string
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
  // Self-reported physical-machine signal (#21 slice 2). UNTRUSTED, agent-controlled,
  // display-only — '' means unknown/not yet reported (old runtime, or never attached).
  host: string
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
  // host: UNTRUSTED, agent-controlled (#21 slice 2). Trim + cap — never reject the batch
  // over it (cosmetic, not a correctness gate). Absent/non-string (old runtimes, or a
  // hostile non-string value) → '' — backward compatible, fail-open to "unknown", not
  // fail-closed on the whole report.
  const host = typeof r.host === 'string' ? r.host.trim().slice(0, MAX_HOST) : ''
  return { agent_id: r.agent_id, display: cleanStr(r.display), runtime, squads, lifecycle, provider_contract: pc, status: r.status, agent_type, member_id, host }
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
      `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, provider_contract, status, reported_by, agent_type, member_id, host, last_reported_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, datetime('now'), datetime('now'))
       ON CONFLICT(tenant, agent_id) DO UPDATE SET
            display=excluded.display, runtime=excluded.runtime, squads=excluded.squads,
            lifecycle=excluded.lifecycle, provider_contract=excluded.provider_contract,
            status=excluded.status, reported_by=excluded.reported_by,
            agent_type=excluded.agent_type, member_id=excluded.member_id,
            host=excluded.host,
            last_reported_at=excluded.last_reported_at, updated_at=excluded.updated_at`,
    )
      .bind(v.agent_id, env.TENANT_SLUG, v.display, v.runtime, JSON.stringify(v.squads), v.lifecycle, v.provider_contract, v.status, reportedBy, v.agent_type ?? 'generic', v.member_id ?? null, v.host ?? '')
      .run()
    written++
  }
  return skipped > 0 ? { ok: true, count: written, skipped } : { ok: true, count: written }
}

// ── agents.id ↔ fleet_agents.agent_id identifier-space bridge ──────────────────────────────
//
// `task.assignee_agent_id` (and therefore the `event.agent_id` a task_dispatch wake carries) is
// ALWAYS `agents.id` — the UUID primary key that also names the AgentDO (resolveTaskAssignee,
// src/tasks/assignee.ts, resolves and stores exactly that column). But the fleet-attach surface
// (fleetAttachApp /attach + /attach-signed, src/fleet/attach-routes.ts) and the signed-inbox
// read path (agent_keys.agent_id, src/fleet/signed-attach.ts / signed-inbox.ts) are both keyed
// by the human-readable SLUG — confirmed against the live mumega tenant DB (2026-07-14): kasra's
// `agents.id` is a uuid, `agents.slug='kasra'`, and its `fleet_agents.agent_id` /
// `agent_keys.agent_id` are BOTH `'kasra'`, never the uuid. A fleet-row read keyed directly on
// `event.agent_id` would therefore NEVER match a real external runtime's row — the route
// decision would be silently dead code in production.
//
// BLOCK (v2 re-gate, 2026-07-14): a first attempt bridged this with a single `LEFT JOIN
// fleet_agents ON fa.agent_id = a.id OR fa.agent_id = a.slug` + `ORDER BY last_reported_at DESC`.
// That is UNSAFE: `agents.slug` is `UNIQUE(squad_id, slug)` (migration 0001_init.sql) — unique
// PER SQUAD, not tenant-wide. Two different agents in two different squads can share a slug (the
// repro: agent A in squad S1 with slug 'kasra' has a live fleet_agents row; agent B in squad S2
// ALSO has slug 'kasra'; a dispatch to B resolves `fa.agent_id = a.slug` against B's OWN slug
// ('kasra') and matches A's row — B's task gets delivered into A's inbox: wrong executor, B's
// task content disclosed to A, B's dispatch wrongly marked delivered/stranded). Worse, the
// `ORDER BY last_reported_at DESC` let a slug match outrank an EXACT id match purely on recency.
//
// Fix: two sequential, ordered lookups, mirroring the established ambiguity-refusal pattern this
// codebase already uses for exactly this class of problem (src/org/resolve.ts
// resolveByIdThenSlug: "resolve by id first; on a slug, COUNT matches and REFUSE an ambiguous
// one"):
//   1. Exact match on `fleet_agents.agent_id = agentId` (the PK column). fleet_agents' PK is
//      (tenant, agent_id), so this is UNAMBIGUOUS by construction — it ALWAYS wins, unconditional
//      on recency, and no slug lookup is attempted at all when it hits.
//   2. Only when (1) finds nothing: resolve `agentId`'s OWN slug, then COUNT how many agents
//      TENANT-WIDE share that slug (this tenant's `agents` table has no explicit tenant column —
//      the deployment model is one D1 per tenant, so a plain COUNT is already tenant-scoped).
//      Exactly 1 (only the caller's own agent) → safe to match `fleet_agents.agent_id = slug`,
//      because no other real agent could be the one that row's attach call meant. More than 1 (a
//      same-slug agent exists in a different squad) → the slug cannot be safely attributed to
//      THIS agent → refuse the fallback entirely (return null, same as "no fleet row" → the
//      caller falls back to the in-Worker route, which is always a safe default). This has the
//      same effect as scoping the slug match to the agent's own squad — agents.slug's actual
//      invariant is UNIQUE(squad_id, slug), so "unique tenant-wide" is the necessary and
//      sufficient condition for a bare slug to unambiguously identify one specific agent.
async function readFleetAgentRow(
  env: Env,
  agentId: string,
): Promise<{ agent_id: string; runtime: string | null; status: string | null; last_reported_at: string | null } | null> {
  type Row = { agent_id: string; runtime: string | null; status: string | null; last_reported_at: string | null }

  // 1. Exact id match — unambiguous (fleet_agents PK is (tenant, agent_id)), always wins.
  const byId = await env.DB.prepare(
    `SELECT agent_id, runtime, status, last_reported_at FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, agentId)
    .first<Row>()
  if (byId) return byId

  // 2. Slug fallback — ONLY when no id-keyed row exists, and ONLY when the slug is unique
  // tenant-wide (ambiguity-refusal, mirroring resolveByIdThenSlug).
  const self = await env.DB.prepare(`SELECT slug FROM agents WHERE id = ?1 LIMIT 1`)
    .bind(agentId)
    .first<{ slug: string | null }>()
  if (!self?.slug) return null // no such agent, or no slug on record — nothing to fall back to

  const dupes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agents WHERE slug = ?1`)
    .bind(self.slug)
    .first<{ n: number }>()
  if (Number(dupes?.n ?? 0) !== 1) return null // 0 is impossible (self counts), >1 is ambiguous — refuse either way

  return await env.DB.prepare(
    `SELECT agent_id, runtime, status, last_reported_at FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, self.slug)
    .first<Row>()
}

/**
 * getFleetAgentRuntime — single-row, tenant-scoped runtime lookup keyed on `agents.id` (the
 * identifier task_dispatch always carries), resolved through `agents.slug` to find the matching
 * `fleet_agents` row (see readFleetAgentRow). Returns '' when the agent has no fleet_agents row,
 * or its runtime column is empty — BOTH mean "no external runtime; the in-Worker AgentDO is the
 * only delivery path for this agent." The runtime value itself was already validated against
 * RUNTIMES/VALID_RUNTIMES at write time (reportFleetAgents / upsertRunning), so a non-empty read
 * here is sufficient proof of "externally hosted" without re-validating the set.
 */
export async function getFleetAgentRuntime(env: Env, agentId: string): Promise<string> {
  const row = await readFleetAgentRow(env, agentId)
  return row?.runtime ? String(row.runtime) : ''
}

export interface FleetAgentRouteInfo {
  /** Non-empty runtime slug, or '' when no fleet row / no runtime is reported. */
  runtime: string
  /** True iff `runtime` is non-empty AND the row's derived Presence (see `derivePresence`,
   *  the SAME classifier the dashboard/#agent-bus feed already uses) is 'live'. A 'stale' or
   *  'offline' runtime is deliberately NOT live — a dead/unreachable external runtime must not
   *  be handed a dispatch it will never pick up (that would strand the task). */
  live: boolean
  /**
   * The IDENTITY the matched fleet_agents row is actually keyed under (its own `agent_id`
   * column — a uuid or a slug, whichever that runtime's own attach/report call declared), or ''
   * when no row matched. THIS, not the caller's input `agentId`, is what an inbox delivery must
   * address: it is the one identity guaranteed to be the identity that runtime's own signed-
   * inbox / bearer-inbox poll queries by, because the row's own attach call is what wrote it.
   * Using the caller's `agentId` (agents.id, uuid) instead would silently misaddress delivery
   * for any runtime — like kasra's live signed-attach today — that reports under its slug.
   */
  agentId: string
}

/**
 * getFleetAgentLiveness — the single read the dispatch-bridge route decision needs: is this
 * agent's runtime EXTERNAL (fleet_agents.runtime non-empty), and is it LIVE right now (recent
 * heartbeat within `presenceTtlSec`)? Reuses the EXISTING `derivePresence` / `presenceTtlSec`
 * classifiers verbatim (S353 v2 gate note: do not invent a second liveness notion — this is the
 * same presence definition `listFleetAgentRuntimeView`/`getAgentView` already use for the
 * dashboard/#agent-bus feed), read through the agents.id → fleet_agents.agent_id bridge above.
 */
export async function getFleetAgentLiveness(
  env: Env,
  agentId: string,
  nowMs = Date.now(),
): Promise<FleetAgentRouteInfo> {
  const row = await readFleetAgentRow(env, agentId)
  const runtime = row?.runtime ? String(row.runtime) : ''
  if (!runtime) return { runtime: '', live: false, agentId: '' }
  const ttlSec = presenceTtlSec(env)
  const status = String(row?.status ?? 'unknown')
  const lastReportedAt = String(row?.last_reported_at ?? '')
  const live = derivePresence(status, lastReportedAt, ttlSec, nowMs) === 'live'
  return { runtime, live, agentId: String(row?.agent_id ?? '') }
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
    `SELECT agent_id, display, runtime, squads, lifecycle, status, last_reported_at, host
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
      host: String(r.host ?? ''),
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
 *          fa.last_reported_at, fa.member_id, fa.host,
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
            fa.last_reported_at, fa.member_id, fa.host,
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
      host: String(r.host ?? ''),
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
