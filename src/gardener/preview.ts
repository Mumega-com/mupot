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

export const GARDENER_SCHEMA = 'mupot.gardener_preview/v1'
export const ARCHIVE_AFTER_DAYS = 30
export const RECENT_ACTIVITY_DAYS = 14
export const REVIEW_WAIT_HOURS = 72
export const MIN_WINDOW_DAYS = 30
export const MAX_WINDOW_DAYS = 90
export const DEFAULT_WINDOW_DAYS = 30
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
  open_assignments: { count: number; stale_count: number; listed: { task_id: string; status: string; age_days: number; priority: string | null }[] }
  waits: Wait[]
  cost: { micro_usd: number | 'unknown'; tokens: number | 'unknown'; source: 'execution_meter'; window_keys: string[]; gap: string | null }
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

async function selectChunked<T>(
  env: Env,
  ids: readonly string[],
  build: (placeholders: string) => string,
  extraBinds: readonly unknown[] = [],
): Promise<T[]> {
  // Placeholders are numbered after the fixed binds so the same fixed params serve every chunk.
  const out: T[] = []
  for (const chunk of chunkForD1InList(ids, undefined, extraBinds.length)) {
    const placeholders = chunk.map((_, i) => `?${extraBinds.length + i + 1}`).join(',')
    const res = await env.DB.prepare(build(placeholders)).bind(...extraBinds, ...chunk).all<T>()
    out.push(...(res.results ?? []))
  }
  return out
}

export interface PreviewInput { squadId: string; tenant: string; nowMs: number; windowDays: number }

export async function buildGardenerPreview(env: Env, input: PreviewInput): Promise<GardenerPreview> {
  const { squadId, tenant, nowMs, windowDays } = input
  const windowFrom = iso(nowMs - windowDays * DAY_MS)
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

  // ── meaningful activity (all SELECT, chunked by agent) ──────────────────────────────────────
  const activity = new Map<string, Activity[]>()
  const addActivity = (agentId: string, a: Activity): void => {
    const list = activity.get(agentId) ?? []
    list.push(a)
    activity.set(agentId, list)
  }
  let eventsTruncated = false
  const capRows = <T>(rows: T[]): T[] => {
    if (rows.length > MAX_EVENT_ROWS) { eventsTruncated = true; return rows.slice(0, MAX_EVENT_ROWS) }
    return rows
  }

  const subs = capRows((await env.DB.prepare(
    `SELECT id, submitted_by_agent_id AS agent_id, created_at AS at
       FROM task_result_submissions
      WHERE squad_id = ?1 AND datetime(created_at) >= datetime(?2)
      ORDER BY created_at DESC, id LIMIT ?3`,
  ).bind(squadId, windowFrom, MAX_EVENT_ROWS + 1).all<{ id: string; agent_id: string; at: string }>()).results ?? [])
  const agentIdSet = new Set(agentIds)
  for (const r of subs) {
    if (agentIdSet.has(r.agent_id)) addActivity(r.agent_id, { at: r.at, kind: 'result_submission', evidence: { table: 'task_result_submissions', id: r.id } })
  }

  const verdicts = capRows(await selectChunked<{ id: string; agent_id: string; at: string }>(
    env, agentIds,
    (ph) => `SELECT id, decided_by AS agent_id, decided_at AS at FROM task_verdicts
              WHERE decided_by IN (${ph}) AND reversed_at IS NULL AND datetime(decided_at) >= datetime(?1)
              ORDER BY decided_at DESC, id LIMIT ${MAX_EVENT_ROWS + 1}`,
    [windowFrom],
  ))
  for (const r of verdicts) addActivity(r.agent_id, { at: r.at, kind: 'verdict', evidence: { table: 'task_verdicts', id: r.id } })

  const deploys = capRows(await selectChunked<{ id: string; agent_id: string; at: string }>(
    env, agentIds,
    (ph) => `SELECT id, dispatched_by AS agent_id, created_at AS at FROM project_deployments
              WHERE dispatched_by IN (${ph}) AND status = 'healthy' AND datetime(created_at) >= datetime(?1)
              ORDER BY created_at DESC, id LIMIT ${MAX_EVENT_ROWS + 1}`,
    [windowFrom],
  ))
  for (const r of deploys) addActivity(r.agent_id, { at: r.at, kind: 'deployment_healthy', evidence: { table: 'project_deployments', id: r.id } })

  const receipts = capRows(await selectChunked<{ id: string; agent_id: string; at: string }>(
    env, agentIds,
    (ph) => `SELECT id, actor_id AS agent_id, server_timestamp AS at FROM execution_receipts
              WHERE tenant = ?1 AND actor_kind = 'agent' AND type IN ${MEANINGFUL_RECEIPT_TYPES_SQL}
                AND actor_id IN (${ph}) AND datetime(server_timestamp) >= datetime(?2)
              ORDER BY server_timestamp DESC, id LIMIT ${MAX_EVENT_ROWS + 1}`,
    [tenant, windowFrom],
  ))
  for (const r of receipts) addActivity(r.agent_id, { at: r.at, kind: 'execution_receipt', evidence: { table: 'execution_receipts', id: r.id } })
  if (eventsTruncated) gaps.add('activity_events_truncated')
  // No bounded, agent-attributed read exists for these; reported, never guessed.
  gaps.add('substantive_task_note_activity')
  gaps.add('merge_receipt_agent_attribution')
  gaps.add('cross_squad_assignments_not_read')

  // ── waits ───────────────────────────────────────────────────────────────────────────────────
  const liveFlights = await selectChunked<{ id: string; agent: string; status: string; waiting_since: number | null }>(
    env, agentIds,
    (ph) => `SELECT id, agent, status, waiting_since FROM flights
              WHERE agent IN (${ph}) AND status IN ${LIVE_FLIGHT_SQL} ORDER BY id`,
  )
  const waitingRuns = await selectChunked<{ id: string; assigned_agent_id: string; waiting_reason: string | null; updated_at: string }>(
    env, agentIds,
    (ph) => `SELECT id, assigned_agent_id, waiting_reason, updated_at FROM routine_runs
              WHERE assigned_agent_id IN (${ph}) AND status = 'waiting' ORDER BY id`,
  )

  // ── measured cost: execution_meter keys are '<tenant>:<agent_id>:<YYYY-MM-DD>' ───────────────
  const days: string[] = []
  for (let d = 0; d < windowDays; d += 1) days.push(iso(nowMs - d * DAY_MS).slice(0, 10))
  const meterRows: { window_key: string; cost_micro_usd: number; tokens: number }[] = []
  for (const chunk of chunkForD1InList(agentIds, undefined, 2)) {
    const res = await env.DB.prepare(
      `SELECT window_key, cost_micro_usd, tokens FROM execution_meter
        WHERE window_key IN (SELECT ?1 || ':' || a.value || ':' || d.value
                               FROM json_each(?2) a, json_each(?3) d)
        ORDER BY window_key`,
    ).bind(tenant, JSON.stringify(chunk), JSON.stringify(days)).all<{ window_key: string; cost_micro_usd: number; tokens: number }>()
    meterRows.push(...(res.results ?? []))
  }

  // ── sole gate holders ───────────────────────────────────────────────────────────────────────
  const gateRows = await selectChunked<{ id: string; capability: string; principal_type: string; principal_id: string }>(
    env, agentIds,
    (ph) => `SELECT g.id, g.capability, g.principal_type, g.principal_id
               FROM gate_grants g
              WHERE g.capability IN (SELECT capability FROM gate_grants
                                      WHERE principal_type = 'agent' AND principal_id IN (${ph}))
              ORDER BY g.capability, g.principal_type, g.principal_id`,
  )
  const holdersByCap = new Map<string, Set<string>>()
  for (const g of gateRows) {
    const key = g.capability
    const set = holdersByCap.get(key) ?? new Set<string>()
    set.add(`${g.principal_type}:${g.principal_id}`)
    holdersByCap.set(key, set)
  }
  const soleCaps = new Map<string, string[]>() // agent id -> capabilities it alone holds
  for (const [cap, set] of holdersByCap) {
    if (set.size !== 1) continue
    const only = [...set][0]
    if (!only.startsWith('agent:')) continue
    const id = only.slice('agent:'.length)
    soleCaps.set(id, [...(soleCaps.get(id) ?? []), cap])
  }

  // ── agent-level unresolved approvals ────────────────────────────────────────────────────────
  const agentApprovals = await selectChunked<{ id: string; requested_by_principal_id: string }>(
    env, agentIds,
    (ph) => `SELECT id, requested_by_principal_id FROM decision_requests
              WHERE status = 'open' AND requested_by_principal_kind = 'agent'
                AND requested_by_principal_id IN (${ph}) ORDER BY id`,
  )

  // ── per-task exemption facts for archive candidates, chunked by task ─────────────────────────
  const staleTasks = tasks.filter((t) => {
    const ts = parseTs(t.updated_at)
    return ts !== null && ts < nowMs - ARCHIVE_AFTER_DAYS * DAY_MS
  })
  const staleIds = staleTasks.map((t) => t.id)
  const taskFlights = await selectChunked<{ task_id: string; flight_id: string }>(
    env, staleIds,
    (ph) => `SELECT DISTINCT a.task_id, f.id AS flight_id
               FROM flight_task_assignments a JOIN flights f ON f.id = a.flight_id
              WHERE a.task_id IN (${ph}) AND f.status IN ${LIVE_FLIGHT_SQL} ORDER BY a.task_id, f.id`,
  )
  const taskHolds = await selectChunked<{ task_id: string }>(
    env, staleIds,
    (ph) => `SELECT task_id FROM execution_holds WHERE task_id IN (${ph}) AND released_at IS NULL ORDER BY task_id`,
  )
  const taskApprovals = await selectChunked<{ id: string; task_id: string }>(
    env, staleIds,
    (ph) => `SELECT id, task_id FROM decision_requests WHERE task_id IN (${ph}) AND status = 'open' ORDER BY id`,
  )
  const openChildren = await selectChunked<{ id: string; parent_task_id: string }>(
    env, staleIds,
    (ph) => `SELECT id, parent_task_id FROM tasks
              WHERE parent_task_id IN (${ph}) AND status IN ${NONTERMINAL_SQL} AND ${TASK_NOT_ARCHIVED_SQL()} ORDER BY id`,
  )
  const unsettledDispatch = await selectChunked<{ id: string; task_id: string }>(
    env, staleIds,
    (ph) => `SELECT id, task_id FROM task_dispatch_receipts
              WHERE task_id IN (${ph}) AND consumed_at IS NULL AND settled_at IS NULL ORDER BY id`,
  )

  const group = <T>(rows: T[], key: (r: T) => string): Map<string, T[]> => {
    const m = new Map<string, T[]>()
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r])
    return m
  }
  const flightsByTask = group(taskFlights, (r) => r.task_id)
  const holdsByTask = group(taskHolds, (r) => r.task_id)
  const approvalsByTask = group(taskApprovals, (r) => r.task_id)
  const childrenByParent = group(openChildren, (r) => r.parent_task_id)
  const dispatchByTask = group(unsettledDispatch, (r) => r.task_id)

  // ── agent cards ─────────────────────────────────────────────────────────────────────────────
  const tasksByAgent = group(tasks.filter((t) => t.assignee_agent_id !== null), (t) => t.assignee_agent_id as string) // as: filtered non-null just above
  const flightsByAgent = group(liveFlights, (f) => f.agent)
  const runsByAgent = group(waitingRuns, (r) => r.assigned_agent_id)
  const approvalsByAgent = group(agentApprovals, (r) => r.requested_by_principal_id)
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
    const cost: AgentCard['cost'] = meter
      ? { micro_usd: meter.cost, tokens: meter.tokens, source: 'execution_meter', window_keys: meter.keys.sort(), gap: null }
      : { micro_usd: 'unknown', tokens: 'unknown', source: 'execution_meter', window_keys: [], gap: 'execution_meter_no_rows_in_window' }

    // ── recommendation: first matching rule wins; the rule is named ───────────────────────────
    let rec: AgentCard['recommendation']
    if (a.status !== 'active') {
      rec = { action: 'rest', rule: 'agent_not_active', evidence: [{ table: 'agents', id: a.id }] }
    } else if (waits.length > 0) {
      rec = { action: 'ask', rule: 'blocked_on_wait', evidence: waits.map((w) => ({ table: w.kind === 'flight_waiting' ? 'flights' : w.kind === 'routine_run_waiting' ? 'routine_runs' : 'tasks', id: w.id })) }
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
      open_assignments: {
        count: active.length,
        stale_count: staleActive.length,
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
    const liveClaims = mine.filter((t) => (t.execution_claim_expires_at ?? 0) > nowMs)
    if (liveClaims.length) ex.push({ reason: 'live_claim', evidence: liveClaims.map((t) => ({ table: 'tasks', id: t.id })) })
    const live = flightsByAgent.get(a.id) ?? []
    if (live.length) ex.push({ reason: 'live_flight', evidence: live.map((f) => ({ table: 'flights', id: f.id })) })
    const appr = approvalsByAgent.get(a.id) ?? []
    if (appr.length || inReview.length) {
      ex.push({ reason: 'unresolved_approval', evidence: [...appr.map((r) => ({ table: 'decision_requests', id: r.id })), ...inReview.map((t) => ({ table: 'tasks', id: t.id }))] })
    }
    if (a.kind === 'home') ex.push({ reason: 'standing_record', evidence: [{ table: 'agents', id: a.id }] })
    const sole = soleCaps.get(a.id) ?? []
    if (sole.length) ex.push({ reason: 'sole_gate_holder', evidence: sole.sort().map((c) => ({ table: 'gate_grants', id: c })) })
    if (a.attach_designated_member_id) ex.push({ reason: 'designated_owner', evidence: [{ table: 'members', id: a.attach_designated_member_id }] })
    if (active.length) ex.push({ reason: 'owns_open_tasks', evidence: active.map((t) => ({ table: 'tasks', id: t.id })) })
    agentCandidates.push({
      agent_id: a.id,
      days_without_meaningful_activity: lastMs === null ? 'unknown' : ageDays(nowMs, lastMs),
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
    const disp = dispatchByTask.get(t.id) ?? []
    if (disp.length) ex.push({ reason: 'live_dispatch', evidence: disp.map((d) => ({ table: 'task_dispatch_receipts', id: d.id })) })
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
    truncated: { agents: agentsTruncated, tasks: tasksTruncated, events: eventsTruncated },
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
    lines.push(`| ${a.slug} | ${a.recommendation.action} | ${a.recommendation.rule} | ${last} | ${a.open_assignments.count} (${a.open_assignments.stale_count} stale) | ${a.waits.length} | ${a.cost.micro_usd} |`)
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
