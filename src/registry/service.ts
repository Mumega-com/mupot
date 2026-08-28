// mupot — module_registry service (Module Kernel, Port 1: presence).
//
// Design: docs/architecture/mupot-module-kernel.md. Every module (agent-system /
// workflow / surface) registers here, heartbeats, and can vanish at any time WITHOUT
// the kernel losing durability — a dead module just reads 'offline'; nothing blocks
// on it. This file owns the ONE durable primitive (`module_registry`, migration 0066)
// and mirrors src/loops/service.ts's shape (result convention, tenant-scoped queries,
// a validated read-model separate from the raw storage row).
//
// DURABILITY (the non-negotiable): stale heartbeat -> offline is QUERY-TIME derived —
// listPresence computes it from `last_heartbeat` vs `now`, never from a cron/sweep.
// `now` is an explicit parameter (mirrors src/fleet/presence.ts#listPresence(env,
// nowMs)) so tests can drive staleness deterministically without waiting real time.
//
// Tenant scope: every write/read is scoped to env.TENANT_SLUG — never client-supplied.
// Identity: callers pass IN a caller-derived identity string; this module never
// resolves auth itself (that's the MCP tool / HTTP route boundary's job — see
// src/mcp/presence.ts and src/registry/presence-routes.ts). This file only enforces
// the DATA invariants (upsert, staleness, tenant scope).

import type { Env } from '../types'

export type ModuleKind = 'agent_system' | 'workflow' | 'surface'
export type ModuleStatus = 'online' | 'offline'

const MODULE_KINDS: readonly ModuleKind[] = ['agent_system', 'workflow', 'surface']

export function isModuleKind(v: unknown): v is ModuleKind {
  return typeof v === 'string' && (MODULE_KINDS as readonly string[]).includes(v)
}

// A module is only counted 'online' if its heartbeat is fresher than this window.
// Named const per the design doc's "make it a named const" requirement — the single
// place that defines what "stale" means for presence. 120s: comfortably wider than a
// typical heartbeat cadence (the design doc's "every N seconds") without letting a
// dead module linger "online" for long.
export const PRESENCE_STALE_SECONDS = 120

/**
 * What a seat reports it is DOING (mupot#1117) — orthogonal to `status`, which is
 * whether we can REACH it. Wire shape adopted verbatim from prime-agent's built-in
 * reporter so existing seats report with no new integration.
 *
 * `done` is not in prime-agent's set (it releases the pane instead of reporting a
 * terminal state); it is included because a seat that finished and exited cleanly is
 * a different fact than one resting between turns, and the release path has to land
 * somewhere honest.
 */
export const ACTIVITY_STATES = ['working', 'idle', 'blocked', 'done'] as const
export type ActivityState = (typeof ACTIVITY_STATES)[number]

/** Caller-facing activity, including the two states a seat can never report itself. */
export type EffectiveActivity = ActivityState | 'unknown'

export function isActivityState(value: unknown): value is ActivityState {
  return typeof value === 'string' && (ACTIVITY_STATES as readonly string[]).includes(value)
}

/**
 * How long an activity may go unchanged before a READER should treat it as suspect.
 *
 * Deliberately much wider than PRESENCE_STALE_SECONDS (heartbeat cadence) because these
 * measure different things: a heartbeat is expected every few seconds, whereas a single
 * 'working' turn legitimately runs for many minutes. 15 minutes is long enough that a
 * real turn does not trip it and short enough that a genuinely wedged seat surfaces
 * within one working session.
 *
 * THE FLAG ITSELF NOW ENCODES WHICH ACTIVITIES IT APPLIES TO. It is raised only for
 * 'working'/'blocked' on a reachable seat — states that CLAIM PROGRESS, where age means a
 * wedge. It is never raised for 'idle'/'done' (resting; age carries no alarm) or 'unknown'
 * (no live claim to have gone quiet).
 *
 * This comment previously explained that distinction and left the caller to apply it,
 * while the code flagged on age alone. Loom caught it on the #1118 gate: a healthy idle
 * seat came back stale after 15 minutes, so any triage view filtering on the flag would
 * alert on every resting seat. Documenting a caveat is not the same as implementing it.
 */
export const ACTIVITY_STALE_SECONDS = 900

export type RegistryResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** An activity report from a seat. `seq` must be monotonic per seat; see the migration. */
export interface ActivityReport {
  state: ActivityState
  message?: string | null
  seq: number
}

/** Cap on activity_message, so a runaway error string cannot bloat the row. */
export const ACTIVITY_MESSAGE_MAX = 500

interface ModuleRegistryRow {
  id: string
  tenant: string
  kind: string
  adapter: string
  project_id: string | null
  identity: string
  status: string
  capabilities: string
  model?: string | null
  last_heartbeat: string
  registered_at: string
  session_epoch?: number | null
  lease_ttl_sec?: number | null
  activity?: string | null
  activity_message?: string | null
  activity_seq?: number | null
  activity_at?: string | null
  activity_report_at?: string | null
}

// The read-model returned to callers. `status` here is the caller-facing EFFECTIVE
// status (post query-time staleness derivation) — see effectiveStatus() below. This is
// deliberately a different shape than ModuleRegistryRow (the raw stored row) so a
// caller can never mistake the derived value for the stored one.
export interface ModulePresence {
  id: string
  kind: ModuleKind
  adapter: string
  project_id: string | null
  identity: string
  status: ModuleStatus
  capabilities: string[]
  model?: string | null
  last_heartbeat: string
  registered_at: string
  session_epoch?: number
  lease_ttl_sec?: number
  /**
   * EFFECTIVE activity — what a reader may act on.
   *
   * 'unknown' whenever the seat is unreachable (effective status 'offline') or has never
   * reported. THIS IS THE POINT OF THE FIELD: an unreachable seat's last word is a
   * last-KNOWN value, not a current one, and reading the two as the same thing is the
   * exact defect mupot#1117 exists to kill. A crashed seat whose final report was
   * 'working' must not keep reading as working.
   *
   * The raw stored value remains visible as `activity_reported` for anyone who needs
   * the last word rather than the current one — the same derived-vs-stored separation
   * `status` already uses.
   */
  activity: EffectiveActivity
  /** Last value the seat actually reported, regardless of reachability. NEVER act on this alone. */
  activity_reported: ActivityState | null
  /** Why it is blocked / what it is doing, as reported. */
  activity_message: string | null
  /** When `activity_reported` last CHANGED (not last re-asserted). */
  activity_at: string | null
  /** Seconds since that change, or null if it has never reported. */
  activity_age_seconds: number | null
  /**
   * When an activity report was last ACCEPTED. Distinct from activity_at (last CHANGE) and
   * from last_heartbeat (which advances even when a report is REJECTED by the seq guard).
   * Fresh heartbeat + stale activity_report_at = reports are arriving and losing the seq
   * comparison, i.e. a zombie reporter. Loom's #1118 BLOCKER 2.
   */
  activity_report_at: string | null
  /** Highest accepted sequence. Exposed so a reporter can see whether its seq is winning. */
  activity_seq: number
  /**
   * True when the activity has gone unchanged longer than ACTIVITY_STALE_SECONDS.
   * Evidence, not a verdict — read it together with `activity` (see that const's docs).
   */
  activity_stale: boolean
}

const SELECT_COLUMNS = `id, tenant, kind, adapter, project_id, identity, status, capabilities, model, last_heartbeat, registered_at, session_epoch, lease_ttl_sec, activity, activity_message, activity_seq, activity_at, activity_report_at`

function parseCapabilities(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/**
 * effectiveStatus — the query-time durability guarantee. A row explicitly deregistered
 * (stored status = 'offline') stays offline. Otherwise a row is online only while its
 * last_heartbeat is within PRESENCE_STALE_SECONDS of `nowMs` — past that window it reads
 * offline WITHOUT any write, cron, or sweep ever running. This is what lets the kernel
 * never hang on a dead module: staleness is a property of a READ, not a background job.
 */
function effectiveStatus(row: Pick<ModuleRegistryRow, 'status' | 'last_heartbeat'>, nowMs: number): ModuleStatus {
  if (row.status === 'offline') return 'offline'
  const heartbeatMs = Date.parse(row.last_heartbeat)
  if (Number.isNaN(heartbeatMs)) return 'offline' // corrupt/unparseable timestamp fails closed
  const ageSeconds = (nowMs - heartbeatMs) / 1000
  return ageSeconds <= PRESENCE_STALE_SECONDS ? 'online' : 'offline'
}

/**
 * effectiveActivity — the activity counterpart of effectiveStatus, and the reason
 * mupot#1117 exists.
 *
 * Returns 'unknown' when the seat is UNREACHABLE, no matter what it last reported.
 * A seat that reported 'working' and then died still reads 'working' in the raw row
 * forever; surfacing that as current is precisely how a dead agent looks busy. The
 * stored value is not lost — it stays on `activity_reported` — but the field a reader
 * is meant to act on refuses to speak for a seat that cannot answer.
 *
 * Also 'unknown' when the seat has never reported: an unreported seat is NOT an idle
 * one, and defaulting to idle would invent a healthy reading out of missing data.
 */
function effectiveActivity(
  stored: ActivityState | null,
  status: ModuleStatus,
  ageSeconds: number | null,
): EffectiveActivity {
  if (status === 'offline') return 'unknown'
  if (stored === null) return 'unknown'
  // BLOCKER 1 from Loom's #1118 gate, and he was right that the first version was
  // self-defeating. This field is documented as the value a reader may ACT ON, yet it
  // only expired on REACHABILITY. So: the activity reporter dies at 00:00 while a plain
  // heartbeat keeps the row online, and at 00:20 the roster still answers 'working'. A
  // consumer using the advertised field gets exactly the false-green #1117 exists to
  // remove — and the old test suite PROVED that behaviour rather than catching it.
  //
  // A claim of progress has a shelf life. Past ACTIVITY_STALE_SECONDS, 'working' and
  // 'blocked' stop being current and become last-known, so the effective field says
  // 'unknown' and refuses to speak for a reporter that has gone quiet.
  //
  // Nothing is lost: activity_reported still carries the last word, activity_stale still
  // flags it, and activity_age_seconds still says how long — so the WEDGE SIGNAL survives
  // intact (reported='working' + stale=true + online). What changes is that the field
  // labelled "act on this" no longer hands you a stale claim.
  //
  // 'idle'/'done' do not expire: they are resting states, and a resting seat that has had
  // nothing to do is still accurately idle.
  if ((stored === 'working' || stored === 'blocked') && ageSeconds !== null && ageSeconds > ACTIVITY_STALE_SECONDS) {
    return 'unknown'
  }
  return stored
}

function hydrate(row: ModuleRegistryRow, nowMs: number): ModulePresence | null {
  if (!isModuleKind(row.kind)) return null // defensive: re-validate stored data on read
  const status = effectiveStatus(row, nowMs)
  // Re-validate on read, same defensive posture as kind: the column carries no CHECK
  // constraint (SQLite ALTER TABLE limitation, see migration 0108), so an unexpected
  // value must degrade to "never reported" rather than escape as a bogus state.
  const storedActivity = isActivityState(row.activity) ? row.activity : null
  const activityAt = typeof row.activity_at === 'string' ? row.activity_at : null
  const activityAtMs = activityAt ? Date.parse(activityAt) : Number.NaN
  const ageSeconds = Number.isNaN(activityAtMs) ? null : Math.max(0, (nowMs - activityAtMs) / 1000)
  return {
    id: row.id,
    kind: row.kind,
    adapter: row.adapter,
    project_id: row.project_id,
    identity: row.identity,
    status,
    capabilities: parseCapabilities(row.capabilities),
    model: row.model ?? null,
    last_heartbeat: row.last_heartbeat,
    registered_at: row.registered_at,
    session_epoch: typeof row.session_epoch === 'number' ? row.session_epoch : 1,
    lease_ttl_sec: typeof row.lease_ttl_sec === 'number' ? row.lease_ttl_sec : PRESENCE_STALE_SECONDS,
    activity: effectiveActivity(storedActivity, status, ageSeconds),
    activity_reported: storedActivity,
    activity_message: typeof row.activity_message === 'string' ? row.activity_message : null,
    activity_at: activityAt,
    activity_age_seconds: ageSeconds,
    activity_report_at: typeof row.activity_report_at === 'string' ? row.activity_report_at : null,
    activity_seq: typeof row.activity_seq === 'number' ? row.activity_seq : 0,
    // STALE ONLY MEANS SOMETHING FOR A SEAT THAT CLAIMS TO BE BUSY.
    //
    // Found by Loom (Gemini) on the #1118 gate. The first version flagged ANY activity
    // older than the window, so a seat that reported 'idle' and then sat healthy and
    // heartbeating for 20 minutes — the normal state of a fleet with nothing queued —
    // came back activity_stale: true. Any triage view filtering on that flag would alert
    // on healthy idle seats, i.e. cry wolf until nobody reads it.
    //
    // The original code even documented this ("stale + 'idle' is simply a seat that has
    // had nothing to do, which is not a defect") and then set the flag anyway, leaving the
    // reader to apply a caveat the data should have encoded. Writing the caveat down is
    // not the same as implementing it.
    //
    // 'working'/'blocked' are CLAIMS OF PROGRESS: unchanged for too long, they are the
    // wedge signal. 'idle'/'done' are resting states where age carries no alarm, and
    // 'unknown' has nothing to be stale about.
    activity_stale:
      ageSeconds !== null &&
      ageSeconds > ACTIVITY_STALE_SECONDS &&
      (storedActivity === 'working' || storedActivity === 'blocked') &&
      status === 'online',
  }
}

export interface RegisterModuleInput {
  identity: string // server-derived by the caller (auth), never attacker-supplied here
  kind: ModuleKind
  adapter: string
  projectId: string | null
  capabilities?: string[]
  model?: string | null
  sessionEpoch?: number | null
  leaseTtlSec?: number | null
}

/**
 * registerModule — idempotent upsert. Re-registering the SAME identity under the SAME
 * (tenant, project_id) updates the existing row in place (kind/adapter/capabilities/model may
 * change; status resets to 'online'; last_heartbeat bumps to now) — it never inserts a
 * duplicate. This targets the migration 0066 unique index on
 * (tenant, identity, project_key) where project_key normalizes NULL project_id to ''.
 * `registered_at` is preserved across re-registration (only set on first insert) —
 * mirrors src/fleet/presence.ts#recordCheckin's first_seen_at convention.
 */
export async function registerModule(
  env: Env,
  input: RegisterModuleInput,
  now: Date = new Date(),
): Promise<RegistryResult<ModulePresence>> {
  const identity = input.identity.trim()
  if (!identity) return { ok: false, error: 'identity_required' }
  if (!isModuleKind(input.kind)) return { ok: false, error: 'invalid_kind' }
  const adapter = input.adapter.trim()
  if (!adapter) return { ok: false, error: 'adapter_required' }

  const tenant = env.TENANT_SLUG
  const id = crypto.randomUUID()
  const nowIso = now.toISOString()
  const capabilitiesJson = JSON.stringify(input.capabilities ?? [])
  const model = input.model?.trim() || null
  const sessionEpoch = typeof input.sessionEpoch === 'number' && Number.isInteger(input.sessionEpoch) && input.sessionEpoch > 0 ? input.sessionEpoch : 1
  const leaseTtlSec = typeof input.leaseTtlSec === 'number' && Number.isInteger(input.leaseTtlSec) && input.leaseTtlSec > 0 ? input.leaseTtlSec : PRESENCE_STALE_SECONDS

  await env.DB.prepare(
    `INSERT INTO module_registry
       (id, tenant, kind, adapter, project_id, identity, status, capabilities, model, session_epoch, lease_ttl_sec, last_heartbeat, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'online', ?7, ?8, ?10, ?11, ?9, ?9)
     ON CONFLICT (tenant, identity, project_key) DO UPDATE SET
       kind           = excluded.kind,
       adapter        = excluded.adapter,
       status         = 'online',
       capabilities   = excluded.capabilities,
       model          = excluded.model,
       session_epoch  = excluded.session_epoch,
       lease_ttl_sec  = excluded.lease_ttl_sec,
       last_heartbeat = excluded.last_heartbeat,
       -- REGISTRATION IS THE LIFECYCLE BOUNDARY: reset the activity fields.
       --
       -- Found by Loom (Gemini) on the #1118 gate, and it is the worst defect in this
       -- change. Without this reset: a seat runs up to activity_seq=45 and dies; systemd
       -- restarts it; the fresh process re-registers and starts ITS counter at 1; every
       -- subsequent report fails the 1 > 45 comparison and is silently dropped FOREVER.
       -- (No backticks in this comment: it lives inside a JS template literal, and one
       -- stray backtick terminates the SQL string mid-statement.) The seat then
       -- reads online + 'working' + stale permanently while actually sitting idle.
       --
       -- That is this feature's own failure mode pointed at itself: a healthy agent frozen
       -- as busy, which is exactly the "dead agent looks busy" reading #1117 exists to kill.
       --
       -- A register call means a NEW PROCESS is announcing itself, and a new process has a
       -- new sequence origin. Clearing to the never-reported sentinel is therefore correct
       -- rather than merely convenient: the old process's last activity is not the new
       -- process's current activity, and carrying it over would be another last-known
       -- value read as current.
       activity         = NULL,
       activity_message = NULL,
       activity_at      = NULL,
       activity_report_at = NULL,
       activity_seq     = 0`,
  )
    .bind(id, tenant, input.kind, adapter, input.projectId, identity, capabilitiesJson, model, nowIso, sessionEpoch, leaseTtlSec)
    .run()

  const row = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM module_registry WHERE tenant = ?1 AND identity = ?2 AND project_id IS ?3 LIMIT 1`)
    .bind(tenant, identity, input.projectId)
    .first<ModuleRegistryRow>()
  if (!row) return { ok: false, error: 'register_failed' }
  const hydrated = hydrate(row, now.getTime())
  return hydrated ? { ok: true, value: hydrated } : { ok: false, error: 'register_failed' }
}


/**
 * heartbeatModule — bump last_heartbeat (and flip status back to 'online' if the row
 * had been explicitly deregistered — a heartbeat is an implicit re-announce). Scoped to
 * (tenant, identity): a caller can only heartbeat ITS OWN identity (enforced by the
 * caller passing its own auth-derived identity — see src/mcp/presence.ts). Returns false
 * if no matching row exists (the caller must register() first).
 */
export async function heartbeatModule(
  env: Env,
  identity: string,
  projectId: string | null,
  now: Date = new Date(),
  report?: ActivityReport,
  opts?: { sessionEpoch?: number | null; leaseTtlSec?: number | null },
): Promise<boolean> {
  const nowIso = now.toISOString()
  const sessionEpoch = typeof opts?.sessionEpoch === 'number' && Number.isInteger(opts.sessionEpoch) && opts.sessionEpoch > 0 ? opts.sessionEpoch : null
  const leaseTtlSec = typeof opts?.leaseTtlSec === 'number' && Number.isInteger(opts.leaseTtlSec) && opts.leaseTtlSec > 0 ? opts.leaseTtlSec : null

  if (!report) {
    const res = await env.DB.prepare(
      `UPDATE module_registry
          SET last_heartbeat = ?1,
              status = 'online',
              session_epoch = COALESCE(?5, session_epoch),
              lease_ttl_sec = COALESCE(?6, lease_ttl_sec)
        WHERE tenant = ?2 AND identity = ?3 AND project_id IS ?4`,
    )
      .bind(nowIso, env.TENANT_SLUG, identity, projectId, sessionEpoch, leaseTtlSec)
      .run()
    return (res.meta?.changes ?? 0) > 0
  }

  const message =
    typeof report.message === 'string' ? report.message.slice(0, ACTIVITY_MESSAGE_MAX) || null : null

  const res = await env.DB.prepare(
    `UPDATE module_registry
        SET last_heartbeat   = ?1,
            status           = 'online',
            session_epoch    = COALESCE(?8, session_epoch),
            lease_ttl_sec    = COALESCE(?9, lease_ttl_sec),
            activity         = CASE WHEN ?7 > activity_seq THEN ?5 ELSE activity END,
            activity_message = CASE WHEN ?7 > activity_seq THEN ?6 ELSE activity_message END,
            activity_at      = CASE WHEN ?7 > activity_seq AND activity IS NOT ?5
                                    THEN ?1 ELSE activity_at END,
            activity_seq     = CASE WHEN ?7 > activity_seq THEN ?7 ELSE activity_seq END,
            -- Stamped ONLY when the report is accepted, which is what makes a rejected-seq
            -- storm visible: last_heartbeat keeps advancing, this does not.
            activity_report_at = CASE WHEN ?7 > activity_seq THEN ?1 ELSE activity_report_at END
      WHERE tenant = ?2 AND identity = ?3 AND project_id IS ?4`,
  )
    .bind(nowIso, env.TENANT_SLUG, identity, projectId, report.state, message, report.seq, sessionEpoch, leaseTtlSec)
    .run()
  return (res.meta?.changes ?? 0) > 0
}

/**
 * deregisterModule — explicit offline. This is the ONLY writer that ever sets
 * status='offline' directly (staleness is read-derived, never written) — an explicit
 * deregister communicates "I am intentionally leaving," distinct from "I stopped
 * heartbeating and nobody knows why." Scoped to (tenant, identity): self only.
 */
export async function deregisterModule(
  env: Env,
  identity: string,
  projectId: string | null,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE module_registry
        SET status = 'offline'
      WHERE tenant = ?1 AND identity = ?2 AND project_id IS ?3 AND status <> 'offline'`,
  )
    .bind(env.TENANT_SLUG, identity, projectId)
    .run()
  return (res.meta?.changes ?? 0) > 0
}

/**
 * listPresence — the project-scoped roster. Tenant-scoped always; `opts.projectId`
 * further narrows to one project (undefined = every registration this tenant has,
 * across all projects; pass projectId: null explicitly to see only "no project
 * selected" registrations). `now` is an injected clock (default real time) so callers
 * — and tests — can drive staleness derivation deterministically; see
 * effectiveStatus() for why this needs no cron.
 */
export async function listPresence(
  env: Env,
  opts: { projectId?: string | null } = {},
  now: Date = new Date(),
): Promise<ModulePresence[]> {
  const tenant = env.TENANT_SLUG
  const rows =
    opts.projectId === undefined
      ? await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM module_registry WHERE tenant = ?1 ORDER BY last_heartbeat DESC`)
          .bind(tenant)
          .all<ModuleRegistryRow>()
      : await env.DB.prepare(
          `SELECT ${SELECT_COLUMNS} FROM module_registry WHERE tenant = ?1 AND project_id IS ?2 ORDER BY last_heartbeat DESC`,
        )
          .bind(tenant, opts.projectId)
          .all<ModuleRegistryRow>()

  const nowMs = now.getTime()
  const out: ModulePresence[] = []
  for (const row of rows.results ?? []) {
    const hydrated = hydrate(row, nowMs)
    if (hydrated) out.push(hydrated)
  }
  return out
}

/** getModule — tenant-scoped fetch of ONE caller's own registration (self-lookup). */
export async function getModule(
  env: Env,
  identity: string,
  projectId: string | null,
  now: Date = new Date(),
): Promise<ModulePresence | null> {
  const row = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM module_registry WHERE tenant = ?1 AND identity = ?2 AND project_id IS ?3 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, identity, projectId)
    .first<ModuleRegistryRow>()
  return row ? hydrate(row, now.getTime()) : null
}
