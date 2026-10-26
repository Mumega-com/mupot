// src/gardener/preview.ts — READ-ONLY "gardener preview" (first slice of mupot#1544; design:
// agents/athena/receipts/cognitive-layer-20261025/design.md section E).
//
// One explicit squad, one bounded snapshot window, deterministic JSON plus a short Markdown card:
// per agent the last MEANINGFUL activity, open assignments, waits, measured cost (or "unknown"),
// ONE rule-based recommendation (rest | ask | shrink | feed) naming the rule that fired, and
// 30-day archive candidates with exception reasons. Every claim carries evidence ids.
//
// HARD LIMITS (pinned by tests/gardener-preview.test.ts):
//  - SELECT only. No dispatch, identity, money, archive or presence write; no new table or
//    migration; no model call.
//  - Bounded reads. Per-agent facts are fetched with IN lists split by chunkForD1InList, never one
//    statement per agent (no N+1). Row counts carry LIMITs and a `truncated` flag.
//  - A fact with no bounded read is reported as "unknown" plus its gap name in `gaps`.
//  - Pure of wall-clock: callers pass `nowMs`; identical snapshot => identical output.
//
// MEANINGFUL ACTIVITY is an authenticated state change with evidence: a result submission, a
// (non-reversed) verdict, a healthy deployment the agent dispatched, or an execution receipt of
// type result.reported / gate.verdict / task.completed. Heartbeats, check-ins and presence are
// NOT read here at all.

import type { Env } from '../types'
import { chunkForD1InList } from '../lib/d1-in-list'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { archiveBlockingDispatchExistsSql } from '../tasks/runtime-receipts'
import { inAirFlightForTaskSql } from '../hygiene/archive'

export const GARDENER_SCHEMA = 'mupot.gardener_preview/v1'
export const ARCHIVE_AFTER_DAYS = 30
export const RECENT_ACTIVITY_DAYS = 14
export const REVIEW_WAIT_HOURS = 72
export const MIN_WINDOW_DAYS = 30
export const MAX_WINDOW_DAYS = 90
export const DEFAULT_WINDOW_DAYS = 30
/** as_of may not be in the future and may not reach back further than this. */
export const MAX_AS_OF_AGE_DAYS = 365
const MAX_AGENTS = 200
const MAX_TASKS = 500
const MAX_EVENT_ROWS = 500
const MAX_LISTED_ASSIGNMENTS = 20
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

const ACTIVE_STATUSES = ['open', 'in_progress', 'blocked'] as const
const NONTERMINAL_SQL = `('open','in_progress','blocked','review')`
const ARCHIVE_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set(['done', 'approved', 'rejected', 'open'])
const LIVE_FLIGHT_SQL = `('preflight','held','running','waiting','sleeping')`
const MEANINGFUL_RECEIPT_TYPES_SQL = `('result.reported','gate.verdict','task.completed')`

export type Recommendation = 'rest' | 'ask' | 'shrink' | 'feed'
export type ActivityKind = 'result_submission' | 'verdict' | 'deployment_healthy' | 'execution_receipt'

export interface Evidence { table: string; id: string }
export interface Activity { at: string; kind: ActivityKind; evidence: Evidence }
export interface Wait { kind: 'flight_waiting' | 'routine_run_waiting' | 'task_in_review'; id: string; since: string | null; age_hours: number | null; detail: Record<string, string | null> }
export interface Exception { reason: string; evidence: Evidence[] }

export interface AgentCard {
  agent_id: string
  slug: string
  status: string
  last_meaningful_activity: Activity | null
  meaningful_activity_count: number
  open_assignments: { count: number | 'unknown'; stale_count: number | 'unknown'; listed: { task_id: string; status: string; age_days: number; priority: string | null }[] }
  waits: Wait[]
  /** 'restricted' = the caller lacks meter:read on this agent (same authorization as execution_meter_status). */
  cost: 'restricted' | { micro_usd: number | 'unknown'; tokens: number | 'unknown'; source: 'execution_meter'; window_keys: string[]; gap: string | null }
  /** true when this agent has activity/live work in squads outside this preview. Boolean only: no ids, no timestamps. */
  activity_elsewhere: boolean
  /** false when an activity read was truncated: last_meaningful_activity is then unknown, not absent. */
  activity_known: boolean
  recommendation: { action: Recommendation; rule: string; evidence: Evidence[] }
}

export interface TaskCandidate { task_id: string; status: string; age_days: number; eligible: boolean; exceptions: Exception[] }
export interface AgentCandidate { agent_id: string; days_without_meaningful_activity: number | 'unknown'; eligible: boolean; exceptions: Exception[] }

export interface GardenerPreview {
  schema: typeof GARDENER_SCHEMA
  read_only: true
  squad_id: string
  as_of: string
  window: { days: number; from: string }
  archive_cutoff: string
  agents: AgentCard[]
  archive_candidates: { tasks: TaskCandidate[]; agents: AgentCandidate[] }
  gaps: string[]
  truncated: { agents: boolean; tasks: boolean; events: boolean }
}

interface AgentRow {
  id: string; slug: string; status: string; kind: string; created_at: string
  attach_designated_member_id: string | null
}
interface TaskRow {
  id: string; status: string; assignee_agent_id: string | null; gate_owner: string | null
  created_at: string; updated_at: string; review_entered_at: string | null
  execution_claim_expires_at: number | null; priority: string | null
}

/** Parse D1 timestamps in either 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO form, or epoch-ms. */
export function parseTs(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = /^\d{4}-\d{2}-\d{2} /.test(v) ? v.replace(' ', 'T') + 'Z' : v
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

const iso = (ms: number): string => new Date(ms).toISOString()
const ageDays = (nowMs: number, ts: number): number => Math.max(0, Math.floor((nowMs - ts) / DAY_MS))

interface Chunked<T> { rows: T[]; truncated: Set<string> }

/**
 * Run `build(placeholders)` once per chunk of `ids`. Every fixed bind counts against the 100-bind
 * ceiling (chunkForD1InList fixedParams). When `limit` is given the SQL must LIMIT limit+1; a chunk
 * that returns more than `limit` rows is trimmed and its ids are reported in `truncated`.
 */
async function selectChunked<T>(
  env: Env,
  ids: readonly string[],
  build: (placeholders: string) => string,
  extraBinds: readonly unknown[] = [],
  limit?: number,
): Promise<Chunked<T>> {
  const rows: T[] = []
  const truncated = new Set<string>()
  for (const chunk of chunkForD1InList(ids, undefined, extraBinds.length)) {
    const placeholders = chunk.map((_, i) => `?${extraBinds.length + i + 1}`).join(',')
    const res = await env.DB.prepare(build(placeholders)).bind(...extraBinds, ...chunk).all<T>()
    let got = res.results ?? []
    if (limit !== undefined && got.length > limit) {
      got = got.slice(0, limit)
      for (const id of chunk) truncated.add(id)
    }
    rows.push(...got)
  }
  return { rows, truncated }
}

export interface PreviewInput {
  squadId: string
  tenant: string
  nowMs: number
  windowDays: number
  /** Squads the caller may read (resolveVisibleTaskScope). Gate holders are judged against these only. */
  visibleSquadIds: readonly string[]
  /** Result of the execution_meter_status authorization (meter:read), resolved by the tool. */
  costScope: { all: boolean; agentId: string | null }
}

/** Validate a caller-supplied snapshot time: not in the future, not older than MAX_AS_OF_AGE_DAYS. */
export function asOfInRange(asOfMs: number, realNowMs: number): boolean {
  return asOfMs <= realNowMs && asOfMs >= realNowMs - MAX_AS_OF_AGE_DAYS * DAY_MS
}

export async function buildGardenerPreview(env: Env, input: PreviewInput): Promise<GardenerPreview> {
  const { squadId, tenant, nowMs, windowDays, visibleSquadIds, costScope } = input
  const windowFrom = iso(nowMs - windowDays * DAY_MS)
  const asOfIso = iso(nowMs)
  const archiveCutoff = iso(nowMs - ARCHIVE_AFTER_DAYS * DAY_MS)
  const recentFromMs = nowMs - RECENT_ACTIVITY_DAYS * DAY_MS
  const gaps = new Set<string>()

  // ── agents of the squad ────────────────────────────────────────────────────────────────────
  const agentRes = await env.DB.prepare(
    `SELECT id, slug, status, kind, created_at, attach_designated_member_id
       FROM agents WHERE squad_id = ?1 AND archived_at IS NULL ORDER BY id LIMIT ?2`,
  ).bind(squadId, MAX_AGENTS + 1).all<AgentRow>()
  const allAgents = agentRes.results ?? []
  const agentsTruncated = allAgents.length > MAX_AGENTS
  const agents = allAgents.slice(0, MAX_AGENTS)
  const agentIds = agents.map((a) => a.id)
  if (agentsTruncated) gaps.add('agents_truncated')

  // ── squad tasks: every non-terminal row plus anything quiescent past the archive cutoff ────
  const taskRes = await env.DB.prepare(
    `SELECT id, status, assignee_agent_id, gate_owner, created_at, updated_at, review_entered_at,
            execution_claim_expires_at, priority
       FROM tasks
      WHERE squad_id = ?1 AND ${TASK_NOT_ARCHIVED_SQL()}
        AND (status IN ${NONTERMINAL_SQL} OR datetime(updated_at) < datetime(?2))
      ORDER BY id LIMIT ?3`,
  ).bind(squadId, archiveCutoff, MAX_TASKS + 1).all<TaskRow>()
  const allTasks = taskRes.results ?? []
  const tasksTruncated = allTasks.length > MAX_TASKS
  const tasks = allTasks.slice(0, MAX_TASKS)
  if (tasksTruncated) gaps.add('tasks_truncated')

  // ── meaningful activity: ONLY work inside this squad is described. Anything the agent did in
  //    other squads is reduced to a boolean (`activity_elsewhere`): no ids, no timestamps. ───────
  const activity = new Map<string, Activity[]>()
  const addActivity = (agentId: string, a: Activity): void => {
    const list = activity.get(agentId) ?? []
    list.push(a)
    activity.set(agentId, list)
  }
  const activityUnknown = new Set<string>() // agents whose activity read was truncated
  const elsewhere = new Set<string>()
  const agentIdSet = new Set(agentIds)
  const win = (col: string): string => `datetime(${col}) >= datetime(?2) AND datetime(${col}) <= datetime(?3)`

  // Submissions carry squad_id; the squad-wide read is one statement.
  const subs = (await env.DB.prepare(
    `SELECT id, submitted_by_agent_id AS agent_id, created_at AS at
       FROM task_result_submissions
      WHERE tenant = ?1 AND squad_id = ?4 AND ${win('created_at')}
      ORDER BY created_at DESC, id LIMIT ?5`,
  ).bind(tenant, windowFrom, asOfIso, squadId, MAX_EVENT_ROWS + 1).all<{ id: string; agent_id: string; at: string }>()).results ?? []
  if (subs.length > MAX_EVENT_ROWS) for (const id of agentIds) activityUnknown.add(id)
  for (const r of subs.slice(0, MAX_EVENT_ROWS)) {
    if (agentIdSet.has(r.agent_id)) addActivity(r.agent_id, { at: r.at, kind: 'result_submission', evidence: { table: 'task_result_submissions', id: r.id } })
  }
  // fixed binds below: ?1 tenant, ?2 from, ?3 as_of, ?4 squad
  const FIXED = [tenant, windowFrom, asOfIso, squadId]
  const subsElsewhere = await selectChunked<{ agent_id: string }>(
    env, agentIds,
    (ph) => `SELECT DISTINCT submitted_by_agent_id AS agent_id FROM task_result_submissions
              WHERE tenant = ?1 AND squad_id <> ?4 AND ${win('created_at')} AND submitted_by_agent_id IN (${ph})`,
    FIXED,
  )
  for (const r of subsElsewhere.rows) elsewhere.add(r.agent_id)

  const verdicts = await selectChunked<{ id: string; agent_id: string; at: string }>(
    env, agentIds,
    (ph) => `SELECT v.id, v.decided_by AS agent_id, v.decided_at AS at
               FROM task_verdicts v JOIN tasks t ON t.id = v.task_id
              WHERE v.decided_by IN (${ph}) AND v.reversed_at IS NULL AND t.squad_id = ?4
                AND ${win('v.decided_at')}
              ORDER BY v.decided_at DESC, v.id LIMIT ${MAX_EVENT_ROWS + 1}`,
    FIXED, MAX_EVENT_ROWS,
  )
  for (const id of verdicts.truncated) activityUnknown.add(id)
  for (const r of verdicts.rows) addActivity(r.agent_id, { at: r.at, kind: 'verdict', evidence: { table: 'task_verdicts', id: r.id } })
  const verdictsElsewhere = await selectChunked<{ agent_id: string }>(
    env, agentIds,
    (ph) => `SELECT DISTINCT v.decided_by AS agent_id
               FROM task_verdicts v LEFT JOIN tasks t ON t.id = v.task_id
              WHERE v.decided_by IN (${ph}) AND v.reversed_at IS NULL
                AND (t.id IS NULL OR t.squad_id <> ?4) AND ${win('v.decided_at')}`,
    FIXED,
  )
  for (const r of verdictsElsewhere.rows) elsewhere.add(r.agent_id)

  // A deployment belongs to this squad iff its project has a project_squad_access edge to it.
  const deploys = await selectChunked<{ id: string; agent_id: string; at: string }>(
    env, agentIds,
    (ph) => `SELECT d.id, d.dispatched_by AS agent_id, d.created_at AS at
               FROM project_deployments d
              WHERE d.dispatched_by IN (${ph}) AND d.status = 'healthy' AND ${win('d.created_at')}
                AND EXISTS (SELECT 1 FROM project_squad_access psa WHERE psa.project_id = d.project_id AND psa.squad_id = ?4)
              ORDER BY d.created_at DESC, d.id LIMIT ${MAX_EVENT_ROWS + 1}`,
    FIXED, MAX_EVENT_ROWS,
  )
  for (const id of deploys.truncated) activityUnknown.add(id)
  for (const r of deploys.rows) addActivity(r.agent_id, { at: r.at, kind: 'deployment_healthy', evidence: { table: 'project_deployments', id: r.id } })
  const deploysElsewhere = await selectChunked<{ agent_id: string }>(
    env, agentIds,
    (ph) => `SELECT DISTINCT d.dispatched_by AS agent_id
               FROM project_deployments d
              WHERE d.dispatched_by IN (${ph}) AND d.status = 'healthy' AND ${win('d.created_at')}
                AND NOT EXISTS (SELECT 1 FROM project_squad_access psa WHERE psa.project_id = d.project_id AND psa.squad_id = ?4)`,
    FIXED,
  )
  for (const r of deploysElsewhere.rows) elsewhere.add(r.agent_id)

  // A receipt belongs to this squad iff its task does; a receipt with no task is "elsewhere".
  const receipts = await selectChunked<{ id: string; agent_id: string; at: string }>(
    env, agentIds,
    (ph) => `SELECT r.id, r.actor_id AS agent_id, r.server_timestamp AS at
               FROM execution_receipts r JOIN tasks t ON t.id = r.task_id
              WHERE r.tenant = ?1 AND r.actor_kind = 'agent' AND r.type IN ${MEANINGFUL_RECEIPT_TYPES_SQL}
                AND r.actor_id IN (${ph}) AND t.squad_id = ?4 AND ${win('r.server_timestamp')}
              ORDER BY r.server_timestamp DESC, r.id LIMIT ${MAX_EVENT_ROWS + 1}`,
    FIXED, MAX_EVENT_ROWS,
  )
  for (const id of receipts.truncated) activityUnknown.add(id)
  for (const r of receipts.rows) addActivity(r.agent_id, { at: r.at, kind: 'execution_receipt', evidence: { table: 'execution_receipts', id: r.id } })
  const receiptsElsewhere = await selectChunked<{ agent_id: string }>(
    env, agentIds,
    (ph) => `SELECT DISTINCT r.actor_id AS agent_id
               FROM execution_receipts r LEFT JOIN tasks t ON t.id = r.task_id
              WHERE r.tenant = ?1 AND r.actor_kind = 'agent' AND r.type IN ${MEANINGFUL_RECEIPT_TYPES_SQL}
                AND r.actor_id IN (${ph}) AND (t.id IS NULL OR t.squad_id <> ?4) AND ${win('r.server_timestamp')}`,
    FIXED,
  )
  for (const r of receiptsElsewhere.rows) elsewhere.add(r.agent_id)
  if (activityUnknown.size) gaps.add('activity_events_truncated')
  // No bounded, agent-attributed read exists for these; reported, never guessed.
  gaps.add('substantive_task_note_activity')
  gaps.add('merge_receipt_agent_attribution')

  // Open work assigned to a squad agent in ANOTHER squad: boolean only (no ids), it exempts archival.
  const workElsewhereRows = await selectChunked<{ agent_id: string }>(
    env, agentIds,
    (ph) => `SELECT DISTINCT assignee_agent_id AS agent_id FROM tasks
              WHERE assignee_agent_id IN (${ph}) AND (squad_id IS NULL OR squad_id <> ?1)
                AND status IN ${NONTERMINAL_SQL} AND ${TASK_NOT_ARCHIVED_SQL()}`,
    [squadId],
  )
  const workElsewhere = new Set(workElsewhereRows.rows.map((r) => r.agent_id))

  // ── waits and live work. In-squad scope: flight via project edge, routine run via the routine's
  //    responsible squad, approval via its task. Everything else is `elsewhere` (boolean). ────────
  const LIVE_FIXED = [tenant, squadId]
  const liveFlights = await selectChunked<{ id: string; agent: string; status: string; waiting_since: number | null }>(
    env, agentIds,
    (ph) => `SELECT f.id, f.agent, f.status, f.waiting_since FROM flights f
              WHERE f.tenant = ?1 AND f.agent IN (${ph}) AND f.status IN ${LIVE_FLIGHT_SQL}
                AND EXISTS (SELECT 1 FROM project_squad_access psa WHERE psa.project_id = f.project_id AND psa.squad_id = ?2)
              ORDER BY f.id`,
    LIVE_FIXED,
  )
  const flightsElsewhere = await selectChunked<{ agent: string }>(
    env, agentIds,
    (ph) => `SELECT DISTINCT f.agent FROM flights f
              WHERE f.tenant = ?1 AND f.agent IN (${ph}) AND f.status IN ${LIVE_FLIGHT_SQL}
                AND NOT EXISTS (SELECT 1 FROM project_squad_access psa WHERE psa.project_id = f.project_id AND psa.squad_id = ?2)`,
    LIVE_FIXED,
  )
  for (const r of flightsElsewhere.rows) elsewhere.add(r.agent)

  const waitingRuns = await selectChunked<{ id: string; assigned_agent_id: string; waiting_reason: string | null; updated_at: string }>(
    env, agentIds,
    (ph) => `SELECT rr.id, rr.assigned_agent_id, rr.waiting_reason, rr.updated_at
               FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id
              WHERE rr.tenant = ?1 AND rr.assigned_agent_id IN (${ph}) AND rr.status = 'waiting'
                AND r.responsible_squad_id = ?2
              ORDER BY rr.id`,
    LIVE_FIXED,
  )
  const runsElsewhere = await selectChunked<{ agent_id: string }>(
    env, agentIds,
    (ph) => `SELECT DISTINCT rr.assigned_agent_id AS agent_id
               FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id
              WHERE rr.tenant = ?1 AND rr.assigned_agent_id IN (${ph}) AND rr.status = 'waiting'
                AND r.responsible_squad_id <> ?2`,
    LIVE_FIXED,
  )
  for (const r of runsElsewhere.rows) elsewhere.add(r.agent_id)

  // ── measured cost: execution_meter keys are '<tenant>:<agent_id>:<YYYY-MM-DD>'. Only agents the
  //    caller is authorized to meter-read (same authorization as execution_meter_status). ────────
  const costIds = agentIds.filter((id) => costScope.all || (costScope.agentId !== null && id === costScope.agentId))
  // Meter rows are whole-UTC-day counters that keep growing after the snapshot, so the as_of day
  // itself is excluded: only the windowDays full days BEFORE it are summed (gap named below).
  const days: string[] = []
  for (let d = 1; d <= windowDays; d += 1) days.push(iso(nowMs - d * DAY_MS).slice(0, 10))
  gaps.add('cost_excludes_as_of_utc_day')
  const meterRows: { window_key: string; cost_micro_usd: number; tokens: number }[] = []
  // ONE statement, 3 binds (tenant, agent-id JSON, day JSON): the ids ride inside a JSON bind,
  // so there is no per-id bind count to chunk (agents are capped at MAX_AGENTS).
  if (costIds.length > 0) {
    const chunk = costIds
    const res = await env.DB.prepare(
      `SELECT window_key, cost_micro_usd, tokens FROM execution_meter
        WHERE window_key IN (SELECT ?1 || ':' || a.value || ':' || d.value
                               FROM json_each(?2) a, json_each(?3) d)
        ORDER BY window_key`,
    ).bind(tenant, JSON.stringify(chunk), JSON.stringify(days)).all<{ window_key: string; cost_micro_usd: number; tokens: number }>()
    meterRows.push(...(res.results ?? []))
  }

  // ── sole gate holders: judged over LIVE principals the caller can see (active, non-archived
  //    agents in readable squads; active, non-archived members). A holder the caller cannot see,
  //    or one that is not live, never changes the answer. ──────────────────────────────────────
  const gateRows = (await selectChunked<{ capability: string; principal_type: string; principal_id: string }>(
    env, agentIds,
    (ph) => `SELECT g.capability, g.principal_type, g.principal_id
               FROM gate_grants g
               LEFT JOIN agents a ON g.principal_type = 'agent' AND a.id = g.principal_id
               LEFT JOIN members m ON g.principal_type = 'member' AND m.id = g.principal_id
              WHERE g.capability IN (SELECT capability FROM gate_grants
                                      WHERE principal_type = 'agent' AND principal_id IN (${ph}))
                AND (
                  (g.principal_type = 'agent' AND a.status = 'active' AND a.archived_at IS NULL
                     AND a.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?1)))
                  OR (g.principal_type = 'member' AND m.status = 'active' AND m.archived_at IS NULL)
                )
              ORDER BY g.capability, g.principal_type, g.principal_id`,
    [JSON.stringify([...visibleSquadIds, squadId])],
  )).rows
  const holdersByCap = new Map<string, Set<string>>()
  for (const g of gateRows) {
    const set = holdersByCap.get(g.capability) ?? new Set<string>()
    set.add(`${g.principal_type}:${g.principal_id}`)
    holdersByCap.set(g.capability, set)
  }
  const soleCaps = new Map<string, string[]>() // agent id -> capabilities it alone holds
  for (const [cap, set] of holdersByCap) {
    if (set.size !== 1) continue
    const only = [...set][0]
    if (!only.startsWith('agent:')) continue
    const id = only.slice('agent:'.length)
    soleCaps.set(id, [...(soleCaps.get(id) ?? []), cap])
  }

  // ── agent-level unresolved approvals: in-squad (via task) are described; the rest is boolean ──
  const agentApprovals = await selectChunked<{ id: string; requested_by_principal_id: string }>(
    env, agentIds,
    (ph) => `SELECT d.id, d.requested_by_principal_id FROM decision_requests d
               JOIN tasks t ON t.id = d.task_id
              WHERE d.tenant = ?1 AND d.status = 'open' AND d.requested_by_principal_kind = 'agent'
                AND d.requested_by_principal_id IN (${ph}) AND t.squad_id = ?2 ORDER BY d.id`,
    LIVE_FIXED,
  )
  const approvalsElsewhere = await selectChunked<{ requested_by_principal_id: string }>(
    env, agentIds,
    (ph) => `SELECT DISTINCT d.requested_by_principal_id FROM decision_requests d
               LEFT JOIN tasks t ON t.id = d.task_id
              WHERE d.tenant = ?1 AND d.status = 'open' AND d.requested_by_principal_kind = 'agent'
                AND d.requested_by_principal_id IN (${ph}) AND (t.id IS NULL OR t.squad_id <> ?2)`,
    LIVE_FIXED,
  )
  for (const r of approvalsElsewhere.rows) elsewhere.add(r.requested_by_principal_id)

  // ── per-task exemption facts for archive candidates, chunked by task ─────────────────────────
  const staleTasks = tasks.filter((t) => {
    const ts = parseTs(t.updated_at)
    return ts !== null && ts < nowMs - ARCHIVE_AFTER_DAYS * DAY_MS
  })
  const staleIds = staleTasks.map((t) => t.id)
  const taskFlights = (await selectChunked<{ task_id: string; flight_id: string }>(
    env, staleIds,
    // Canonical in-air linkage (lane OR assignment OR meta.task_ids), shared with archiveRow.
    (ph) => `SELECT DISTINCT t.id AS task_id, f.id AS flight_id
               FROM tasks t JOIN flights f ON ${inAirFlightForTaskSql('t.id')}
              WHERE t.id IN (${ph}) ORDER BY t.id, f.id`,
  )).rows
  const taskHolds = (await selectChunked<{ task_id: string }>(
    env, staleIds,
    (ph) => `SELECT task_id FROM execution_holds WHERE task_id IN (${ph}) AND released_at IS NULL ORDER BY task_id`,
  )).rows
  const taskApprovals = (await selectChunked<{ id: string; task_id: string }>(
    env, staleIds,
    (ph) => `SELECT id, task_id FROM decision_requests WHERE tenant = ?1 AND task_id IN (${ph}) AND status = 'open' ORDER BY id`,
    [tenant],
  )).rows
  const openChildren = (await selectChunked<{ id: string; parent_task_id: string }>(
    env, staleIds,
    (ph) => `SELECT id, parent_task_id FROM tasks
              WHERE parent_task_id IN (${ph}) AND status IN ${NONTERMINAL_SQL} AND ${TASK_NOT_ARCHIVED_SQL()} ORDER BY id`,
  )).rows
  // The canonical archive-blocking dispatch predicate (src/tasks/runtime-receipts.ts), the one
  // archiveRow consults via hasArchiveBlockingDispatch. Not re-implemented here.
  const blockedByDispatch = (await selectChunked<{ task_id: string }>(
    env, staleIds,
    (ph) => `SELECT t.id AS task_id FROM tasks t
              WHERE t.id IN (${ph}) AND ${archiveBlockingDispatchExistsSql({ tenantParam: '?1', taskIdExpr: 't.id' })}
              ORDER BY t.id`,
    [tenant],
  )).rows

  const group = <T>(rows: T[], key: (r: T) => string): Map<string, T[]> => {
    const m = new Map<string, T[]>()
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r])
    return m
  }
  const flightsByTask = group(taskFlights, (r) => r.task_id)
  const holdsByTask = group(taskHolds, (r) => r.task_id)
  const approvalsByTask = group(taskApprovals, (r) => r.task_id)
  const childrenByParent = group(openChildren, (r) => r.parent_task_id)
  const dispatchBlocked = new Set(blockedByDispatch.map((r) => r.task_id))

  // ── agent cards ─────────────────────────────────────────────────────────────────────────────
  const tasksByAgent = group(tasks.filter((t) => t.assignee_agent_id !== null), (t) => t.assignee_agent_id as string) // as: filtered non-null just above
  const flightsByAgent = group(liveFlights.rows, (f) => f.agent)
  const runsByAgent = group(waitingRuns.rows, (r) => r.assigned_agent_id)
  const approvalsByAgent = group(agentApprovals.rows, (r) => r.requested_by_principal_id)
  const meterByAgent = new Map<string, { cost: number; tokens: number; keys: string[] }>()
  for (const m of meterRows) {
    const agentId = m.window_key.slice(tenant.length + 1, m.window_key.lastIndexOf(':'))
    const cur = meterByAgent.get(agentId) ?? { cost: 0, tokens: 0, keys: [] }
    cur.cost += Number(m.cost_micro_usd) || 0
    cur.tokens += Number(m.tokens) || 0
    cur.keys.push(m.window_key)
    meterByAgent.set(agentId, cur)
  }

  const cards: AgentCard[] = []
  const agentCandidates: AgentCandidate[] = []
  for (const a of agents) {
    const acts = (activity.get(a.id) ?? []).slice().sort((x, y) => {
      const dx = (parseTs(y.at) ?? 0) - (parseTs(x.at) ?? 0)
      return dx !== 0 ? dx : x.evidence.id.localeCompare(y.evidence.id)
    })
    const last = acts[0] ?? null
    const lastMs = last ? parseTs(last.at) : null

    const mine = tasksByAgent.get(a.id) ?? []
    const active = mine.filter((t) => (ACTIVE_STATUSES as readonly string[]).includes(t.status))
    const staleActive = active.filter((t) => {
      const ts = parseTs(t.updated_at)
      return ts !== null && ts < nowMs - ARCHIVE_AFTER_DAYS * DAY_MS
    })
    const inReview = mine.filter((t) => t.status === 'review')

    const waits: Wait[] = []
    for (const f of flightsByAgent.get(a.id) ?? []) {
      if (f.status !== 'waiting') continue
      waits.push({ kind: 'flight_waiting', id: f.id, since: f.waiting_since === null ? null : iso(f.waiting_since), age_hours: f.waiting_since === null ? null : Math.floor((nowMs - f.waiting_since) / HOUR_MS), detail: {} })
    }
    for (const r of runsByAgent.get(a.id) ?? []) {
      const since = parseTs(r.updated_at)
      waits.push({ kind: 'routine_run_waiting', id: r.id, since: since === null ? null : iso(since), age_hours: since === null ? null : Math.floor((nowMs - since) / HOUR_MS), detail: { waiting_reason: r.waiting_reason } })
    }
    for (const t of inReview) {
      const since = parseTs(t.review_entered_at ?? t.updated_at)
      const hours = since === null ? null : Math.floor((nowMs - since) / HOUR_MS)
      if (hours !== null && hours < REVIEW_WAIT_HOURS) continue
      waits.push({ kind: 'task_in_review', id: t.id, since: since === null ? null : iso(since), age_hours: hours, detail: { gate_owner: t.gate_owner } })
    }
    waits.sort((x, y) => (x.kind + x.id).localeCompare(y.kind + y.id))

    const meter = meterByAgent.get(a.id)
    const costAllowed = costScope.all || (costScope.agentId !== null && costScope.agentId === a.id)
    const cost: AgentCard['cost'] = !costAllowed
      ? 'restricted'
      : meter
      ? { micro_usd: meter.cost, tokens: meter.tokens, source: 'execution_meter', window_keys: meter.keys.sort(), gap: null }
      : { micro_usd: 'unknown', tokens: 'unknown', source: 'execution_meter', window_keys: [], gap: 'execution_meter_no_rows_in_window' }

    const activityKnown = !activityUnknown.has(a.id)
    const assignmentsKnown = !tasksTruncated

    // ── recommendation: first matching rule wins; the rule is named ───────────────────────────
    let rec: AgentCard['recommendation']
    if (a.status !== 'active') {
      rec = { action: 'rest', rule: 'agent_not_active', evidence: [{ table: 'agents', id: a.id }] }
    } else if (waits.length > 0) {
      rec = { action: 'ask', rule: 'blocked_on_wait', evidence: waits.map((w) => ({ table: w.kind === 'flight_waiting' ? 'flights' : w.kind === 'routine_run_waiting' ? 'routine_runs' : 'tasks', id: w.id })) }
    } else if (!activityKnown || !assignmentsKnown) {
      rec = { action: 'ask', rule: 'unknown_due_to_truncation', evidence: [{ table: 'agents', id: a.id }] }
    } else if (staleActive.length > 0 && (lastMs === null || lastMs < nowMs - ARCHIVE_AFTER_DAYS * DAY_MS)) {
      rec = { action: 'shrink', rule: 'stale_backlog_no_recent_output', evidence: staleActive.map((t) => ({ table: 'tasks', id: t.id })) }
    } else if (active.length === 0 && lastMs !== null && lastMs >= recentFromMs) {
      rec = { action: 'feed', rule: 'productive_empty_queue', evidence: last ? [last.evidence] : [] }
    } else if (active.length > 0 && (lastMs === null || lastMs < recentFromMs)) {
      rec = { action: 'ask', rule: 'silent_with_assignments', evidence: active.map((t) => ({ table: 'tasks', id: t.id })) }
    } else if (active.length > 0) {
      rec = { action: 'rest', rule: 'active_on_track', evidence: last ? [last.evidence] : [] }
    } else {
      rec = { action: 'rest', rule: 'dormant_no_demand', evidence: [{ table: 'agents', id: a.id }] }
    }

    cards.push({
      agent_id: a.id,
      slug: a.slug,
      status: a.status,
      last_meaningful_activity: last,
      meaningful_activity_count: acts.length,
      activity_known: activityKnown,
      activity_elsewhere: elsewhere.has(a.id),
      open_assignments: {
        count: assignmentsKnown ? active.length : 'unknown',
        stale_count: assignmentsKnown ? staleActive.length : 'unknown',
        listed: active
          .slice().sort((x, y) => x.id.localeCompare(y.id)).slice(0, MAX_LISTED_ASSIGNMENTS)
          .map((t) => ({ task_id: t.id, status: t.status, age_days: ageDays(nowMs, parseTs(t.updated_at) ?? nowMs), priority: t.priority })),
      },
      waits,
      cost,
      recommendation: rec,
    })

    // ── agent archive candidate (30 UTC days with no meaningful activity) ─────────────────────
    const createdMs = parseTs(a.created_at)
    const newerThanCutoff = createdMs !== null && createdMs >= nowMs - ARCHIVE_AFTER_DAYS * DAY_MS
    const quiet = lastMs === null || lastMs < nowMs - ARCHIVE_AFTER_DAYS * DAY_MS
    if (!quiet || newerThanCutoff || createdMs === null) continue
    const ex: Exception[] = []
    if (!activityKnown || !assignmentsKnown) ex.push({ reason: 'unknown_due_to_truncation', evidence: [{ table: 'agents', id: a.id }] })
    if (elsewhere.has(a.id)) ex.push({ reason: 'activity_elsewhere', evidence: [] })
    if (workElsewhere.has(a.id)) ex.push({ reason: 'open_work_elsewhere', evidence: [] })
    const liveClaims = mine.filter((t) => (t.execution_claim_expires_at ?? 0) > nowMs)
    if (liveClaims.length) ex.push({ reason: 'live_claim', evidence: liveClaims.map((t) => ({ table: 'tasks', id: t.id })) })
    const live = flightsByAgent.get(a.id) ?? []
    if (live.length) ex.push({ reason: 'live_flight', evidence: live.map((f) => ({ table: 'flights', id: f.id })) })
    const appr = approvalsByAgent.get(a.id) ?? []
    if (appr.length || inReview.length) {
      ex.push({ reason: 'unresolved_approval', evidence: [...appr.map((r) => ({ table: 'decision_requests', id: r.id })), ...inReview.map((t) => ({ table: 'tasks', id: t.id }))] })
    }
    const waitingRuns2 = runsByAgent.get(a.id) ?? []
    if (waitingRuns2.length) ex.push({ reason: 'waiting_routine_run', evidence: waitingRuns2.map((r) => ({ table: 'routine_runs', id: r.id })) })
    if (a.kind === 'home') ex.push({ reason: 'standing_record', evidence: [{ table: 'agents', id: a.id }] })
    const sole = soleCaps.get(a.id) ?? []
    if (sole.length) ex.push({ reason: 'sole_gate_holder', evidence: sole.sort().map((c) => ({ table: 'gate_grants', id: c })) })
    if (a.attach_designated_member_id) ex.push({ reason: 'designated_owner', evidence: [{ table: 'members', id: a.attach_designated_member_id }] })
    if (active.length) ex.push({ reason: 'owns_open_tasks', evidence: active.map((t) => ({ table: 'tasks', id: t.id })) })
    agentCandidates.push({
      agent_id: a.id,
      days_without_meaningful_activity: !activityKnown || lastMs === null ? 'unknown' : ageDays(nowMs, lastMs),
      eligible: ex.length === 0,
      exceptions: ex,
    })
  }

  // ── task archive candidates ─────────────────────────────────────────────────────────────────
  const taskCandidates: TaskCandidate[] = staleTasks.map((t) => {
    const ex: Exception[] = []
    const claimed = (t.execution_claim_expires_at ?? 0) > nowMs
    if (claimed) ex.push({ reason: 'live_claim', evidence: [{ table: 'tasks', id: t.id }] })
    const fl = flightsByTask.get(t.id) ?? []
    if (fl.length) ex.push({ reason: 'live_flight', evidence: fl.map((f) => ({ table: 'flights', id: f.flight_id })) })
    if (holdsByTask.has(t.id)) ex.push({ reason: 'execution_hold', evidence: [{ table: 'execution_holds', id: t.id }] })
    if (dispatchBlocked.has(t.id)) ex.push({ reason: 'live_dispatch', evidence: [{ table: 'tasks', id: t.id }] })
    if (tasksTruncated) ex.push({ reason: 'unknown_due_to_truncation', evidence: [{ table: 'tasks', id: t.id }] })
    const ap = approvalsByTask.get(t.id) ?? []
    if (ap.length || t.status === 'review') {
      ex.push({ reason: 'unresolved_approval', evidence: [...ap.map((r) => ({ table: 'decision_requests', id: r.id })), ...(t.status === 'review' ? [{ table: 'tasks', id: t.id }] : [])] })
    }
    const kids = childrenByParent.get(t.id) ?? []
    if (kids.length) ex.push({ reason: 'standing_record', evidence: kids.map((k) => ({ table: 'tasks', id: k.id })) })
    if (!ARCHIVE_ELIGIBLE_STATUSES.has(t.status) && t.status !== 'review') {
      ex.push({ reason: `active_status_${t.status}`, evidence: [{ table: 'tasks', id: t.id }] })
    }
    const ts = parseTs(t.updated_at) ?? nowMs
    return { task_id: t.id, status: t.status, age_days: ageDays(nowMs, ts), eligible: ex.length === 0, exceptions: ex }
  })

  return {
    schema: GARDENER_SCHEMA,
    read_only: true,
    squad_id: squadId,
    as_of: iso(nowMs),
    window: { days: windowDays, from: windowFrom },
    archive_cutoff: archiveCutoff,
    agents: cards,
    archive_candidates: {
      tasks: taskCandidates.sort((x, y) => x.task_id.localeCompare(y.task_id)),
      agents: agentCandidates.sort((x, y) => x.agent_id.localeCompare(y.agent_id)),
    },
    gaps: [...gaps].sort(),
    truncated: { agents: agentsTruncated, tasks: tasksTruncated, events: activityUnknown.size > 0 },
  }
}

/** Short Markdown card rendered from the JSON (pure; same snapshot => same text). */
export function renderGardenerCard(p: GardenerPreview): string {
  const lines: string[] = [
    `# Gardener preview — squad ${p.squad_id}`,
    `as_of ${p.as_of} · window ${p.window.days}d · read-only`,
    '',
    '| agent | rec | rule | last meaningful | open | waits | cost µUSD |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const a of p.agents) {
    const last = a.last_meaningful_activity ? `${a.last_meaningful_activity.kind} ${a.last_meaningful_activity.at}` : 'none in window'
    lines.push(`| ${a.slug} | ${a.recommendation.action} | ${a.recommendation.rule} | ${last} | ${a.open_assignments.count} (${a.open_assignments.stale_count} stale) | ${a.waits.length} | ${a.cost === 'restricted' ? 'restricted' : a.cost.micro_usd} |`)
  }
  const eligT = p.archive_candidates.tasks.filter((t) => t.eligible).length
  const exT = p.archive_candidates.tasks.length - eligT
  lines.push('', `Archive candidates (>${ARCHIVE_AFTER_DAYS}d): tasks ${eligT} eligible, ${exT} exempt; agents ${p.archive_candidates.agents.filter((x) => x.eligible).length} eligible, ${p.archive_candidates.agents.filter((x) => !x.eligible).length} exempt.`)
  for (const t of p.archive_candidates.tasks) {
    if (!t.eligible) lines.push(`- task ${t.task_id} (${t.status}, ${t.age_days}d) exempt: ${t.exceptions.map((e) => e.reason).join(', ')}`)
  }
  for (const g of p.archive_candidates.agents) {
    if (!g.eligible) lines.push(`- agent ${g.agent_id} exempt: ${g.exceptions.map((e) => e.reason).join(', ')}`)
  }
  if (p.gaps.length) lines.push('', `Unknown / gaps: ${p.gaps.join(', ')}`)
  return lines.join('\n')
}
