// Fleet agent registry (Deliverable 2 panel data layer).
//
// The host consumer daemon reports its controllable agents + live status; the dashboard reads them
// to render the roster + control buttons. This is a DISPLAY cache, never authority — control is
// separately owner-gated + signature-verified, so a stale/forged status row can only mislead the
// panel, never authorize a host action. Reports are accepted ONLY from the configured consumer agent.

import type { Env } from '../types'
import { resolveCapabilities } from '../auth/capability'
import { isValidRuntimeOrUnset } from './runtimes'

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const STATUSES = new Set(['running', 'stopped', 'unknown'])
// Runtime vocabulary lives in ./runtimes — ONE list. This path also accepts '',
// which is why it uses isValidRuntimeOrUnset: declining to claim a runtime is not the
// same as claiming a wrong one.
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
/**
 * Parse either timestamp format this database stores, because it stores TWO.
 *
 *   fleet_agents.last_reported_at   'YYYY-MM-DD HH:MM:SS'      (SQLite datetime('now'))
 *   module_registry.last_heartbeat  '2026-08-06T03:51:26.358Z' (ISO-8601, JS toISOString)
 *
 * The original did `Date.parse(s.replace(' ', 'T') + 'Z')`, which is correct for the SQLite
 * shape and produces `...358ZZ` → NaN for the ISO one. NaN meant 'stale', so EVERY
 * module_registry row read as stale — which silently defeated the whole either-surface fix in
 * #734: it was merged, deployed, and changed nothing in production.
 *
 * It was invisible because the tests INVENTED the module timestamps in SQLite format. Real
 * SQL against the real schema was not enough — the fixture made up the DATA shape, so the
 * suite proved the code agreed with my belief rather than with production.
 */
export function parseStamp(stamp: string): number {
  // Already ISO (has 'T', or an explicit zone) — parse as-is.
  if (stamp.includes('T') || /[Zz]$|[+-]\d{2}:?\d{2}$/.test(stamp)) return Date.parse(stamp)
  // SQLite 'YYYY-MM-DD HH:MM:SS' is UTC by convention here.
  return Date.parse(stamp.replace(' ', 'T') + 'Z')
}

export function derivePresence(
  status: string,
  lastReportedAt: string,
  ttlSec: number,
  nowMs = Date.now(),
): Presence {
  if (status === 'stopped') return 'offline'
  if (!lastReportedAt) return 'stale'
  const t = parseStamp(lastReportedAt)
  if (Number.isNaN(t)) return 'stale'
  const ageSec = (nowMs - t) / 1000
  return ageSec <= ttlSec ? 'live' : 'stale'
}

// ── Poll-mode presence (mupot#1494) ─────────────────────────────────────────────────────────
//
// A resident runtime keeps `fleet_agents` fresh via a continuous heartbeat daemon (attach-signed
// / /api/fleet/attach) and is judged live against the ONE global `presenceTtlSec(env)` window.
// A polling runner (cron, an external orchestrator, a laptop that wakes every N minutes) has no
// such daemon — it only ever touches mupot when it actually polls. Forcing it into the same
// 180s-default window would mean it can never be "live" between polls, so `task_dispatch` would
// never route it an inbox envelope and it can never receive dispatched work (#1494's bug).
//
// The fix is a PER-ROW TTL derived from the runner's own declared cadence, set once via
// check_in(presence_mode:'poll', poll_interval_sec), and a last_reported_at that keeps sliding
// forward on every subsequent authenticated call that agent makes (touchPollFleetPresence) —
// so a runner that is faithfully polling on its own declared cadence reads as live continuously,
// and one that stops (crashes, is retired) correctly decays to stale/dead like any other agent.
export const POLL_INTERVAL_MIN_SEC = 60
export const POLL_INTERVAL_MAX_SEC = 3600
export const DEFAULT_POLL_INTERVAL_SEC = 300
export const POLL_PRESENCE_MODE = 'poll'
export const RESIDENT_PRESENCE_MODE = 'resident'

/** Bound a caller-declared poll cadence to [POLL_INTERVAL_MIN_SEC, POLL_INTERVAL_MAX_SEC].
 *  A missing/non-finite/non-numeric value falls back to DEFAULT_POLL_INTERVAL_SEC — never NaN,
 *  never unbounded (an unbounded value could either starve dispatch routing at the low end, by
 *  producing a near-zero TTL that a normal poll cadence can't stay inside, or hide a genuinely
 *  dead runner for hours at the high end). */
export function clampPollIntervalSec(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_POLL_INTERVAL_SEC
  return Math.min(POLL_INTERVAL_MAX_SEC, Math.max(POLL_INTERVAL_MIN_SEC, Math.round(n)))
}

/**
 * fleet_agents.squads has TWO independent writers — `reportFleetAgents` (the daemon's bulk
 * self-report, which sees a runtime's real multi-squad membership) and
 * `upsertPollFleetPresence` (check_in(presence_mode:'poll'), which resolves only its own home-
 * squad slug). Round 2 had each ON CONFLICT plainly OVERWRITE the column with its own writer's
 * view — so whichever writer landed LAST silently erased the other's membership (a resident
 * daemon reporting `["a","b"]` then a single poll check-in collapsed the row to `["home"]`,
 * dropping the agent out of every OTHER squad's fleet view).
 *
 * mupot#1494 round 3 (P2-a) — a NAIVE union of the two sides is not enough: poll's own
 * re-resolution on a LATER squad reassignment (P1-c, round 2) must REPLACE what poll itself
 * previously contributed, not accumulate every home squad it has ever had. So the row tracks
 * poll's own last contribution separately, in `poll_home_squad_slug` (migration 0163) —
 * each writer's ON CONFLICT then REPLACES only its own portion and UNIONs in the other
 * writer's current contribution, never accumulating stale values from either side.
 */

/** The POLL upsert's own SET expression: existing squads MINUS the row's OWN previous poll
 *  contribution (if any), UNION the new poll squads (the new home slug). A daemon-reported
 *  squad the poll writer never touched survives untouched; poll's own prior home squad does
 *  NOT survive a reassignment. */
function pollSquadsMergeSql(): string {
  return `(SELECT json_group_array(value) FROM (
             SELECT value FROM json_each(fleet_agents.squads)
              WHERE fleet_agents.poll_home_squad_slug IS NULL
                 OR value <> fleet_agents.poll_home_squad_slug
             UNION
             SELECT value FROM json_each(excluded.squads)
             ORDER BY value ASC
           ))`
}

/** The DAEMON report's own SET expression: `excluded.squads` (the report's full, authoritative
 *  view) REPLACES the daemon's own prior contribution entirely (a daemon report can shrink its
 *  own list — that's a real membership change, not a bug), UNION the row's separately-tracked
 *  poll contribution, if any, so a daemon report can never silently erase a poll-mode
 *  registration on the same row. */
function daemonSquadsMergeSql(): string {
  return `(SELECT json_group_array(value) FROM (
             SELECT value FROM json_each(excluded.squads)
             UNION
             SELECT fleet_agents.poll_home_squad_slug AS value
              WHERE fleet_agents.poll_home_squad_slug IS NOT NULL
             ORDER BY value ASC
           ))`
}

/** The per-row presence TTL for a poll-mode agent: 2x its own declared cadence (room for one
 *  missed/late poll before it reads as stale), floored at DEFAULT_PRESENCE_TTL_SEC so a very
 *  fast poller (near POLL_INTERVAL_MIN_SEC) doesn't get an unrealistically tight window. */
export function pollPresenceTtlSec(pollIntervalSec: number): number {
  return Math.max(DEFAULT_PRESENCE_TTL_SEC, 2 * pollIntervalSec)
}

/**
 * upsertPollFleetPresence — the check_in(presence_mode:'poll') write. Keyed by the CALLER'S OWN
 * `agents.id` (auth.boundAgentId, a uuid) — never a slug — so this is an exact-id match on
 * `readFleetAgentRow`'s first (unambiguous) lookup and never touches the slug-fallback ambiguity
 * path a daemon-report or signed-attach row might occupy. Self-scoped by construction: a caller
 * can only ever address ITS OWN row (there is no `agent_id` argument on check_in), the same
 * "identity from authentication, never request text" invariant every other self-lane tool in
 * this file already holds.
 */
export interface UpsertPollFleetPresenceResult {
  /** True iff an operator (or the agent's own prior self-detach) had set this row's status
   *  to 'stopped' and this call correctly left it stopped rather than resurrecting it — see
   *  the doc comment below (P2-f). The caller (check_in) surfaces this as a typed
   *  `presence_stopped_by_operator` note rather than silently reporting success. */
  stoppedByOperator: boolean
}

export async function upsertPollFleetPresence(
  env: Env,
  input: { agentId: string; display: string; memberId: string | null; ttlSec: number },
): Promise<UpsertPollFleetPresenceResult> {
  // mupot#1494 round 2 (P1-c) — populate `squads` from the agent's ACTUAL home squad, not a
  // permanent '[]'. A poll-mode agent has no resident daemon ever calling reportFleetAgents()
  // to self-report which squads it's in (the ONLY other writer of this column), so without
  // this a poll-mode row would NEVER appear in a squad-scoped fleet view no matter how long it
  // polls. Re-resolved on EVERY upsert (not just the first), so a later squad reassignment is
  // reflected the next time the agent checks in — never a one-time snapshot.
  const squadRow = await env.DB.prepare(
    `SELECT s.slug AS slug FROM agents a JOIN squads s ON s.id = a.squad_id WHERE a.id = ?1`,
  ).bind(input.agentId).first<{ slug: string }>()
  const squadsJson = JSON.stringify(squadRow?.slug ? [squadRow.slug] : [])

  // mupot#1494 round 2 (P2-h) — runtime stays '' (unset), NOT 'poll'. `runtime` names a
  // harness/engine (codex, claude-code, systemd-user, …) — the ONE closed vocabulary in
  // src/fleet/runtimes.ts — and 'poll' is not a harness, it is a DELIVERY CADENCE
  // (presence_mode already carries that fact). Writing 'poll' there would have been a category
  // error, and would have required teaching every daemon/attach validator a vocabulary entry
  // that means something different from every other entry. A poll-mode agent that ALSO knows
  // its own real harness can report it later via the normal daemon-report path
  // (reportFleetAgents) without conflict — this column is deliberately left for that, not
  // claimed here. hasRegisteredDeliverySurface/resolveDispatchDeliveryMode both already treat
  // `presence_mode==='poll'` as sufficient on its own, independent of `runtime` — an empty
  // runtime here does not weaken poll-mode dispatch routing (see getFleetAgentLiveness's early
  // return, corrected in the same round to stop treating empty-runtime-plus-poll-mode as "no
  // row at all").
  // mupot#1494 round 3 (P2-a) — this call's OWN contribution to `squads` (its current home
  // slug, or NULL if it has none) is tracked separately so a LATER re-resolution can replace
  // exactly what THIS writer contributed without touching the daemon's. See
  // pollSquadsMergeSql's doc comment.
  const pollHomeSquadSlug = squadRow?.slug ?? null
  const row = await env.DB.prepare(
    `INSERT INTO fleet_agents
        (agent_id, tenant, display, runtime, squads, lifecycle, provider_contract, status,
         reported_by, agent_type, member_id, host, presence_mode, presence_ttl_sec,
         poll_home_squad_slug, last_reported_at, updated_at)
      VALUES (?1, ?2, ?3, '', ?6, 'on_demand', NULL, 'running',
              ?1, 'generic', ?4, '', 'poll', ?5,
              ?7, datetime('now'), datetime('now'))
      ON CONFLICT(tenant, agent_id) DO UPDATE SET
        display           = excluded.display,
        -- mupot#1494 round 3 (P2-a) — replace ONLY this writer's own prior contribution
        -- (poll_home_squad_slug), union in the daemon's. See pollSquadsMergeSql's doc comment.
        squads            = ${pollSquadsMergeSql()},
        poll_home_squad_slug = excluded.poll_home_squad_slug,
        -- mupot#1494 round 2 (P2-f) — operator detach wins. A row an operator (or the agent's
        -- own prior self-detach — /api/fleet/detach requires the SAME token.boundAgentId as
        -- the target agent_id, which for a poll row IS the agent's own uuid, so self-detach is
        -- a real reachable path here, not hypothetical) explicitly stopped must not be
        -- silently resurrected just because the agent keeps polling. No refresh at all for a
        -- stopped row — last_reported_at/updated_at stay exactly as the detach left them.
        status            = CASE WHEN fleet_agents.status = 'stopped' THEN fleet_agents.status ELSE 'running' END,
        member_id         = excluded.member_id,
        presence_mode     = 'poll',
        presence_ttl_sec  = excluded.presence_ttl_sec,
        last_reported_at  = CASE WHEN fleet_agents.status = 'stopped' THEN fleet_agents.last_reported_at ELSE datetime('now') END,
        updated_at        = CASE WHEN fleet_agents.status = 'stopped' THEN fleet_agents.updated_at ELSE datetime('now') END
      RETURNING status`,
  )
    .bind(input.agentId, env.TENANT_SLUG, input.display, input.memberId, input.ttlSec, squadsJson, pollHomeSquadSlug)
    .first<{ status: string }>()

  return { stoppedByOperator: row?.status === 'stopped' }
}

/**
 * touchPollFleetPresence — the cheap per-call heartbeat for an already-poll-registered agent.
 * A single indexed UPDATE gated on `presence_mode = 'poll'`, so it is a no-op (0 rows changed)
 * for every OTHER caller: no fleet row at all, or a resident/signed-attach-owned row (resident
 * semantics are untouched — this statement never matches one). Fail-soft by design: a presence
 * touch must never break the real tool call it rides along with.
 */
export async function touchPollFleetPresence(env: Env, agentId: string | null | undefined): Promise<void> {
  if (!agentId) return
  try {
    await env.DB.prepare(
      // mupot#1494 round 2 (P2-f) — `status != 'stopped'` alongside the existing
      // presence_mode='poll' gate: an operator-stopped row gets NO refresh from a poll-mode
      // agent's ordinary tool calls either, matching upsertPollFleetPresence's own guard.
      `UPDATE fleet_agents SET last_reported_at = datetime('now'), updated_at = datetime('now')
        WHERE tenant = ?1 AND agent_id = ?2 AND presence_mode = 'poll' AND status != 'stopped'`,
    ).bind(env.TENANT_SLUG, agentId).run()
  } catch {
    // best-effort — never fail the caller's real request over a presence touch
  }
}

/**
 * clearPollFleetPresence — mupot#1494 round 2 (P2-g). `check_in({ presence_mode: 'resident' })`
 * is the explicit de-registration path: an agent that was poll-registered and is now switching
 * to a resident daemon (or simply wants to stop being treated as poll-mode) clears its OWN
 * `presence_mode`/`presence_ttl_sec` back to the unregistered default. After this call,
 * getFleetAgentLiveness/resolveDispatchDeliveryMode fall back to ordinary resident rules for
 * this row (global TTL, `runtime && live`) — exactly as if it had never poll-registered.
 * Scoped to `presence_mode = 'poll'` so it is a safe no-op against a resident/signed-attach row
 * this agent does not own the poll-registration of (there should never be one, since a poll
 * row is keyed by the caller's own uuid, but the guard costs nothing and documents the
 * invariant). Does NOT touch `status`/`squads`/`runtime` — de-registering presence mode is not
 * the same act as detaching.
 */
export async function clearPollFleetPresence(env: Env, agentId: string | null | undefined): Promise<void> {
  if (!agentId) return
  await env.DB.prepare(
    `UPDATE fleet_agents
        SET presence_mode = '', presence_ttl_sec = NULL, updated_at = datetime('now')
      WHERE tenant = ?1 AND agent_id = ?2 AND presence_mode = 'poll'`,
  ).bind(env.TENANT_SLUG, agentId).run()
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
  const runtime = isValidRuntimeOrUnset(r.runtime) ? r.runtime : ''
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
            display=excluded.display, runtime=excluded.runtime,
            -- mupot#1494 round 3 (P2-a) — the daemon's own contribution is fully REPLACED by
            -- this report (authoritative), union in whatever a poll check-in separately
            -- tracked. See daemonSquadsMergeSql's doc comment.
            squads=${daemonSquadsMergeSql()},
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
export interface FleetAgentRowIdentity {
  agent_id: string
  runtime: string | null
  status: string | null
  last_reported_at: string | null
  /** '' (legacy rows, migration default) | 'poll' | 'resident'. See "Poll-mode presence" above. */
  presence_mode?: string | null
  /** Per-row TTL override (seconds), set by check_in(presence_mode:'poll'). null means "use the
   *  global presenceTtlSec(env) window" — the pre-#1494, resident-daemon behavior, unchanged. */
  presence_ttl_sec?: number | null
}

/**
 * resolveFleetPresenceTtlSec — mupot#1494 round 2 (P1-b). THE single per-row TTL resolution,
 * called by EVERY fleet_agents-presence reader in this codebase (getFleetAgentLiveness,
 * getFleetAgentRuntimeStates, listFleetAgentRuntimeView, getAgentView,
 * src/dashboard/observatory.ts's loadAgentRuntimeStates, and the fleet_agent_get MCP tool) —
 * never re-derived as a local ternary per call site. Round 1 fixed this ONLY in
 * getFleetAgentLiveness (the dispatch-routing reader); every OTHER reader kept computing a
 * single batch-level `presenceTtlSec(env)` and applying it to every row, so a poll-mode agent
 * with a real per-row TTL could read `live` for dispatch but `stale`/`offline` on the
 * dashboard, in a routine's `selectAgent`, and on its own agent-view row — six readers of ONE
 * fact, disagreeing. A row without its own override (`presence_ttl_sec` NULL/non-positive —
 * every resident/legacy row) resolves to the exact same global window as before; this is a
 * refactor of WHERE the ternary lives, not a behavior change for anyone but a poll-mode row.
 */
export function resolveFleetPresenceTtlSec(
  env: Env,
  // `unknown` deliberately, not `number | null`: several callers read this straight out of a
  // `Record<string, unknown>` D1 row (r.presence_ttl_sec) and this function's own runtime
  // `typeof` check is the real validation — accepting `unknown` here means no caller needs an
  // `as` cast just to call it.
  row: { presence_ttl_sec?: unknown } | null | undefined,
): number {
  return typeof row?.presence_ttl_sec === 'number' && row.presence_ttl_sec > 0
    ? row.presence_ttl_sec
    : presenceTtlSec(env)
}

export async function readFleetAgentRow(
  env: Env,
  agentId: string,
): Promise<FleetAgentRowIdentity | null> {
  type Row = FleetAgentRowIdentity

  // 1. Exact id match — unambiguous (fleet_agents PK is (tenant, agent_id)), always wins.
  const byId = await env.DB.prepare(
    `SELECT agent_id, runtime, status, last_reported_at, presence_mode, presence_ttl_sec
       FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, agentId)
    .first<Row>()
  if (byId) return byId

  // 2. Slug fallback — ONLY when no id-keyed row exists, the slug is unique tenant-wide,
  // and no canonical agents.id reserves that same fleet identity.
  const self = await env.DB.prepare(`SELECT slug FROM agents WHERE id = ?1 LIMIT 1`)
    .bind(agentId)
    .first<{ slug: string | null }>()
  if (!self?.slug) return null // no such agent, or no slug on record — nothing to fall back to

  const dupes = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agents WHERE slug = ?1
      AND NOT EXISTS (SELECT 1 FROM agents canonical WHERE canonical.id = ?1)`,
  )
    .bind(self.slug)
    .first<{ n: number }>()
  if (Number(dupes?.n ?? 0) !== 1) return null // 0 means an ID collision; >1 means an ambiguous slug.

  return await env.DB.prepare(
    `SELECT agent_id, runtime, status, last_reported_at, presence_mode, presence_ttl_sec
       FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1`,
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
  /** '' | 'poll' | 'resident' — the matched row's declared presence_mode (mupot#1494). A
   *  'poll'-mode agent HAS a registered delivery mode (its inbox) regardless of the moment-to-
   *  moment `live` reading — see resolveDispatchDeliveryMode in src/bus/consumer.ts, which is
   *  what actually decides task_dispatch routing. '' means no row, or a legacy/daemon row that
   *  never declared a mode — resident semantics for that case are unchanged from pre-#1494. */
  presenceMode: string
}

export interface FleetAgentIdentity {
  agent_id: string
  slug: string
}

export interface FleetAgentRuntimeState {
  agent_id: string
  runtime: string
  status: string
  presence: Presence
  host: string
  last_seen: string
}

export const MAX_RUNTIME_STATE_BATCH = 100

/**
 * Resolve a bounded set of canonical agent IDs to fleet rows without per-agent reads.
 * Exact fleet IDs always win and reserve that identity globally. Slug-keyed rows are used
 * only when that slug belongs to exactly one agent tenant-wide and collides with no agents.id,
 * matching readFleetAgentRow's ambiguity refusal.
 */
export async function getFleetAgentRuntimeStates(
  env: Env,
  agents: FleetAgentIdentity[],
  nowMs = Date.now(),
): Promise<Map<string, FleetAgentRuntimeState>> {
  const unique = new Map<string, FleetAgentIdentity>()
  for (const agent of agents) {
    if (!unique.has(agent.agent_id)) unique.set(agent.agent_id, agent)
  }
  if (unique.size > MAX_RUNTIME_STATE_BATCH) {
    throw new RangeError(`fleet runtime state batch exceeds ${MAX_RUNTIME_STATE_BATCH} agents`)
  }
  if (!unique.size) return new Map()

  type FleetRow = {
    agent_id: string
    runtime: string | null
    status: string | null
    host: string | null
    last_reported_at: string | null
    // mupot#1494 round 2 (P1-b) — per-row TTL override, resolved via resolveFleetPresenceTtlSec.
    presence_ttl_sec: number | null
  }
  const identities = [...new Set([...unique.values()].flatMap((agent) => (
    agent.slug ? [agent.agent_id, agent.slug] : [agent.agent_id]
  )))]
  const slugs = [...new Set([...unique.values()].map((agent) => agent.slug).filter(Boolean))]
  // Both presence surfaces in ONE statement (see the budget note below), tagged by `src` and
  // partitioned in memory. `host` exists only on fleet_agents, so module rows carry ''.
  type UnionRow = FleetRow & { src: 'fleet' | 'module' }
  const presenceRowsPromise = env.DB.prepare(
    `SELECT 'fleet' AS src, agent_id, runtime, status, host, last_reported_at, presence_ttl_sec
       FROM fleet_agents
      WHERE tenant = ?1
        AND agent_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))
     UNION ALL
     SELECT 'module' AS src, identity AS agent_id, adapter AS runtime, status, '' AS host,
            last_heartbeat AS last_reported_at, NULL AS presence_ttl_sec
       FROM module_registry
      WHERE tenant = ?1
        AND identity IN (SELECT CAST(value AS TEXT) FROM json_each(?2))`,
  ).bind(env.TENANT_SLUG, JSON.stringify(identities)).all<UnionRow>()
  const slugCountsPromise = slugs.length
    ? env.DB.prepare(
        `SELECT slug_owner.slug, COUNT(*) AS n
           FROM agents slug_owner
          WHERE slug_owner.slug IN (SELECT CAST(value AS TEXT) FROM json_each(?1))
            AND NOT EXISTS (
              SELECT 1 FROM agents canonical WHERE canonical.id = slug_owner.slug
            )
          GROUP BY slug_owner.slug`,
      ).bind(JSON.stringify(slugs)).all<{ slug: string; n: number }>()
    : Promise.resolve({ results: [] as { slug: string; n: number }[] })
  // mupot#732 — SECOND LIVENESS SURFACE.
  //
  // "Is this agent reachable right now" is ONE fact with TWO writers in this codebase:
  //   fleet_agents   <- POST /api/fleet/attach
  //   module_registry <- presence_register / presence_heartbeat
  //
  // Only fleet_agents was read here, so an agent that faithfully heartbeats the other one is
  // invisible to dispatch. Measured on production 2026-08-06: every fleet_agents row had been
  // stale since 07-30, so `selectAgent` returned `offline` for everything and NO routine could
  // dispatch — silently, indefinitely, with no alert. Registering presence returned 200 and
  // changed nothing, which is what made it so expensive to diagnose.
  //
  // This is deliberately ADDITIVE, not a rewrite: an agent is live if EITHER surface has a
  // fresh heartbeat. Accepting either signal is strictly MORE correct than accepting only the
  // one nothing writes, and it needs no migration, so it can ship as an urgent fix. Collapsing
  // to a single surface is the real repair and is tracked separately — this must not be read
  // as an endorsement of keeping two.
  //
  // It does NOT invent a liveness notion: `derivePresence` and `presenceTtlSec` are reused
  // verbatim, per the existing note on getFleetAgentLiveness below.
  // ONE statement, not two. D1 caps statements per invocation and the scheduler path is
  // already close to it — `tests/routine-dispatch.test.ts` pins the budget and caught an
  // earlier draft of this change adding a 32nd statement against a ceiling of 31. Raising the
  // ceiling would trade a real platform limit for implementation convenience, so both
  // surfaces are read in a single UNION ALL above. Statement count is unchanged from before.
  const [presenceRows, slugCounts] = await Promise.all([presenceRowsPromise, slugCountsPromise])
  const allRows = presenceRows.results ?? []
  const byIdentity = new Map(
    allRows.filter((r) => r.src === 'fleet').map((row) => [row.agent_id, row]),
  )
  const moduleRows = { results: allRows.filter((r) => r.src === 'module').map((r) => ({
    identity: r.agent_id, adapter: r.runtime, status: r.status, last_heartbeat: r.last_reported_at,
  })) }
  const cardinality = new Map((slugCounts.results ?? []).map((row) => [row.slug, Number(row.n)]))

  // Keep only the FRESHEST module row per identity — an agent may register several times
  // (project-scoped and unscoped rows both exist in production), and a stale duplicate must
  // not mask a live one.
  const freshestModule = new Map<string, { adapter: string; status: string; lastSeen: string }>()
  for (const row of moduleRows.results ?? []) {
    const lastSeen = String(row.last_heartbeat ?? '')
    const prev = freshestModule.get(row.identity)
    if (prev && prev.lastSeen >= lastSeen) continue
    freshestModule.set(row.identity, {
      adapter: String(row.adapter ?? ''), status: String(row.status ?? 'unknown'), lastSeen,
    })
  }

  // module_registry rows carry no per-row TTL concept (that surface is a wholly separate
  // presence store, mupot#732) — the global window is the correct one for it. The FLEET
  // surface uses resolveFleetPresenceTtlSec PER ROW below (round 2 P1-b: this used to be one
  // batch-level ttlSec applied to every row, which is exactly what silently disagreed with
  // getFleetAgentLiveness for a poll-mode agent's own per-row TTL — `selectAgent`, the routine
  // dispatcher's read of THIS function, is one of the six readers that must now agree).
  const moduleTtlSec = presenceTtlSec(env)
  const resolved = new Map<string, FleetAgentRuntimeState>()

  for (const agent of unique.values()) {
    const exact = byIdentity.get(agent.agent_id)
    const row = exact ?? (cardinality.get(agent.slug) === 1 ? byIdentity.get(agent.slug) : undefined)
    const mod = freshestModule.get(agent.agent_id)
      ?? (cardinality.get(agent.slug) === 1 ? freshestModule.get(agent.slug) : undefined)

    const fleetPresence = row
      ? derivePresence(String(row.status ?? 'unknown'), String(row.last_reported_at ?? ''), resolveFleetPresenceTtlSec(env, row), nowMs)
      : undefined
    const modulePresence = mod
      ? derivePresence(mod.status, mod.lastSeen, moduleTtlSec, nowMs)
      : undefined

    // Neither surface knows this agent — unchanged behaviour, it is simply absent.
    if (!row && !mod) continue

    const live = fleetPresence === 'live' || modulePresence === 'live'
    // `selectAgent` requires a non-empty runtime as well as live presence, so a module-only
    // agent must carry one or the fix would be inert. The adapter IS the runtime kind
    // ('claude-code', 'codex', …) — the same vocabulary fleet_agents.runtime uses.
    const runtime = String(row?.runtime ?? '') || (mod?.adapter ?? '')
    // Compare by PARSED TIME, not by string. The two columns use different formats, and
    // ' ' (0x20) sorts before 'T' (0x54), so a lexical compare reports an ISO stamp as newer
    // than a SQLite stamp on the same date — even when it is a full day older:
    //   '2026-08-06T00:00:01.000Z' > '2026-08-06 23:59:59'  ->  true, and wrong.
    // Display-only today, but a wrong "last seen" is exactly what sends the next person
    // looking in the wrong place. (Athena, residual on #735.)
    const fleetLastSeen = String(row?.last_reported_at ?? '')
    const modIsNewer = mod
      ? (!fleetLastSeen || (parseStamp(mod.lastSeen) || 0) > (parseStamp(fleetLastSeen) || 0))
      : false
    const lastSeen = modIsNewer && mod ? mod.lastSeen : fleetLastSeen

    resolved.set(agent.agent_id, {
      agent_id: row?.agent_id ?? agent.agent_id,
      runtime,
      status: String(row?.status ?? mod?.status ?? 'unknown'),
      // Derived so that `presence === 'live'` and `live` can NEVER disagree.
      //
      // The first draft was `live ? 'live' : (fleetPresence ?? modulePresence ?? 'offline')`,
      // whose fallback could return 'live' while `live` was false — a self-contradictory
      // state. Mutation testing found it: reverting `live` to fleet-only still left the
      // module-only test green, because the fallback leaked 'live' through. The test was
      // passing for the wrong reason AND the code could report a liveness it had just denied.
      //
      // Now: live if either surface says so; stale if either merely knows of it recently
      // enough to be classified stale; otherwise offline. No path can contradict `live`.
      presence: live
        ? 'live'
        : (fleetPresence === 'stale' || modulePresence === 'stale' ? 'stale' : 'offline'),
      host: String(row?.host ?? ''),
      last_seen: lastSeen,
    })
  }
  return resolved
}

/**
 * getFleetAgentLiveness — the single read the dispatch-bridge route decision needs: is this
 * agent's runtime EXTERNAL (fleet_agents.runtime non-empty), and is it LIVE right now (recent
 * heartbeat within `presenceTtlSec`)? Reuses the EXISTING `derivePresence` / `presenceTtlSec`
 * classifiers verbatim (S353 v2 gate note: do not invent a second liveness notion — this is the
 * same presence definition `listFleetAgentRuntimeView`/`getAgentView` already use for the
 * dashboard/#agent-bus feed), read through the agents.id → fleet_agents.agent_id bridge above.
 */
/**
 * isActivePollPresenceMode — mupot#1494 round 3 (P1-iii). THE gate for whether a row's poll
 * registration is currently ACTIVE for dispatch-routing purposes: `presence_mode='poll'` AND
 * the row has not been operator-stopped. Round 2's operator-detach fix (P2-f) correctly froze
 * `status`/`last_reported_at` on a stopped row, but left `presence_mode` itself — the ONE
 * field `resolveDispatchDeliveryMode` (src/bus/consumer.ts) actually routes on — unconditionally
 * writable by the agent's own subsequent poll check-ins, so a detached poll row kept routing
 * to inbox forever. Exported so `getFleetAgentLiveness` and any future presence_mode reader
 * share the SAME rule rather than re-deriving it.
 */
export function isActivePollPresenceMode(presenceMode: string, status: string): boolean {
  return presenceMode === 'poll' && status !== 'stopped'
}

export async function getFleetAgentLiveness(
  env: Env,
  agentId: string,
  nowMs = Date.now(),
): Promise<FleetAgentRouteInfo> {
  const row = await readFleetAgentRow(env, agentId)
  const rawPresenceMode = row?.presence_mode ? String(row.presence_mode) : ''
  const runtime = row?.runtime ? String(row.runtime) : ''
  const status = String(row?.status ?? 'unknown')
  // mupot#1494 round 3 (P1-iii) — an operator-stopped row must not route as poll, regardless
  // of what the presence_mode column literally still holds (see isActivePollPresenceMode).
  const presenceMode = isActivePollPresenceMode(rawPresenceMode, status) ? rawPresenceMode : ''
  // mupot#1494 round 2 (P2-h fallout) — an empty `runtime` used to mean "no row / nothing to
  // route to" UNCONDITIONALLY, which was true before poll-mode existed but stopped being true
  // the moment a poll-mode row could legitimately carry an empty runtime (its harness is not
  // this column's business — see upsertPollFleetPresence's doc comment). Bailing out here
  // regardless of `presenceMode` would have silently zeroed OUT the entire poll-mode dispatch
  // fix for every poll agent that never separately reported a runtime. Only bail when NEITHER
  // signal is present.
  if (!runtime && presenceMode !== 'poll') return { runtime: '', live: false, agentId: '', presenceMode: '' }
  // Per-row TTL (poll-mode, mupot#1494) via resolveFleetPresenceTtlSec — THE ONE shared
  // resolution every fleet_agents presence reader now calls (round 2 P1-b).
  const ttlSec = resolveFleetPresenceTtlSec(env, row)
  const lastReportedAt = String(row?.last_reported_at ?? '')
  const live = derivePresence(status, lastReportedAt, ttlSec, nowMs) === 'live'
  return { runtime, live, agentId: String(row?.agent_id ?? ''), presenceMode }
}

/**
 * listSquadMemberIds — sorted, deduped agent_ids currently reporting squadId in their
 * `squads[]` (the SAME self-reported column groupBySquad/squadControlPanel already group by —
 * src/dashboard/fleet-host.ts). This is the SIGNING-TIME input for a squad control-request
 * (src/fleet/control.ts's emitSquadControlRequest): the host's engine.control_squad re-resolves
 * squad membership live from its OWN version-controlled manifest registry (a DIFFERENT source)
 * and REFUSES the whole action if the two disagree (kasra-review, PR #954/#957/#1004 BLOCK gate
 * — the confirm() dialog is bound to nothing that runs unless the confirmed set is itself part
 * of what gets signed). Callers MUST NOT accept a member list from the client/form — always
 * resolve it here, server-side, at emit time, from mupot's own live cache.
 */
export async function listSquadMemberIds(env: Env, squadId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT agent_id FROM fleet_agents
      WHERE tenant = ?1
        AND EXISTS (SELECT 1 FROM json_each(fleet_agents.squads) je WHERE je.value = ?2)
      ORDER BY agent_id ASC`,
  )
    .bind(env.TENANT_SLUG, squadId)
    .all<{ agent_id: string }>()
  return (rows.results ?? []).map((r) => r.agent_id)
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
 * listFleetAgentRuntimeView — the /fleet host-agent roster.
 *
 * `squadIds` (FLIGHT-001 #797): the caller's OWN accessible squad ids
 * (resolveAccessibleSquadIds), for scoping the roster to a squad-scoped
 * dashboard viewer. `undefined` (the default, and every pre-existing caller —
 * radar.ts, im/index.ts, fleet.ts's own callers) is UNRESTRICTED, preserving
 * every non-dashboard consumer's behavior unchanged; only the /fleet route
 * passes this explicitly. `null` is also unrestricted (an org-scope grant or
 * legacy owner/admin, per resolveAccessibleSquadIds' own null contract) — the
 * two are accepted together so a caller can pass its resolveAccessibleSquadIds
 * result straight through without an extra branch. `[]` scopes to nothing.
 *
 * `fleet_agents.squads` is a SELF-REPORTED, agent-controlled JSON array of
 * squad SLUGS (validated against AGENT_ID_RE at write time — see
 * reportFleetAgents above), not squad ids, so scoping requires one extra
 * lookup to translate the caller's granted squad ids to slugs before the
 * membership test. Filtered at the QUERY (WHERE via json_each), never
 * post-fetch in JS — same discipline as loadAllAgents (dashboard/agents-admin.ts).
 */
export async function listFleetAgentRuntimeView(
  env: Env,
  nowMs = Date.now(),
  squadIds?: string[] | null,
): Promise<FleetAgentRuntimeView[]> {
  let scopeClause = ''
  let slugsJson: string | null = null
  if (squadIds !== undefined && squadIds !== null) {
    if (squadIds.length === 0) return []
    const slugRows = await env.DB.prepare(
      `SELECT slug FROM squads WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))`,
    )
      .bind(JSON.stringify(squadIds))
      .all<{ slug: string }>()
    const slugs = (slugRows.results ?? []).map((r) => r.slug)
    if (slugs.length === 0) return []
    slugsJson = JSON.stringify(slugs)
    // mupot#1494 round 3 (P2-b) — the home-squad exclusion belongs ONLY to a squad-SCOPED
    // read. Round 2 (G-FP1b) applied it UNCONDITIONALLY, reasoning that an unrestricted
    // (org-admin) read must not surface an agent whose only squad is someone's home — but
    // that made a home-squad-only agent invisible in EVERY view, including the unrestricted
    // one, which is strictly LESS visible than the round-1 bug it replaced (round 1's
    // squads='[]' shape was at least visible unrestricted). A squad-scoped dashboard viewer
    // should not see that agent as a member of a squad it does not actually share; an
    // unrestricted org-admin view has no such reason to hide it.
    scopeClause =
      ` AND EXISTS (SELECT 1 FROM json_each(fleet_agents.squads) je WHERE je.value IN (SELECT value FROM json_each(?2)))
        AND NOT EXISTS (
          SELECT 1 FROM json_each(fleet_agents.squads) je
           WHERE je.value IN (SELECT slug FROM squads WHERE kind = 'home')
        )`
  }
  const statement = env.DB.prepare(
    `SELECT agent_id, display, runtime, squads, lifecycle, status, last_reported_at, host, presence_ttl_sec
       FROM fleet_agents
      WHERE tenant = ?1${scopeClause}
      ORDER BY agent_id ASC`,
  )
  const bound = slugsJson === null ? statement.bind(env.TENANT_SLUG) : statement.bind(env.TENANT_SLUG, slugsJson)
  const rows = await bound.all<Record<string, unknown>>()

  // mupot#1494 round 2 (P1-b) — per-row TTL, resolved per row via resolveFleetPresenceTtlSec
  // (the same function getFleetAgentLiveness uses), not one batch-level window.
  return (rows.results ?? []).map((r) => {
    const status = String(r.status ?? 'unknown')
    const lastSeen = String(r.last_reported_at ?? '')
    const ttlSec = resolveFleetPresenceTtlSec(env, { presence_ttl_sec: r.presence_ttl_sec })
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
            fa.last_reported_at, fa.member_id, fa.host, fa.presence_ttl_sec,
            m.id AS m_id, m.email AS m_email, m.display_name AS m_display
       FROM fleet_agents fa
       LEFT JOIN members m ON m.id = fa.member_id AND m.tenant = fa.tenant
      WHERE fa.tenant = ?1
      ORDER BY fa.agent_id ASC`,
  )
    .bind(env.TENANT_SLUG)
    .all<Record<string, unknown>>()

  const out: AgentView[] = []
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
    // mupot#1494 round 2 (P1-b) — per-row TTL, resolved the SAME way getFleetAgentLiveness does.
    const ttlSec = resolveFleetPresenceTtlSec(env, { presence_ttl_sec: r.presence_ttl_sec })
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
