import type { Env } from '../types'
import { canonicalFlightMetaSql } from '../flight/meta-sql'

export type ProjectActivitySource = 'task' | 'message' | 'flight'
export type ProjectEvidenceSource =
  | 'task_result'
  | 'task_verdict'
  | 'workflow_receipt'
  | 'dispatch_receipt'
  | 'flight_receipt'
  | 'message_ack'

export interface ProjectProjectionRow<T extends string = string> {
  source_type: T
  source_id: string
  occurred_at: string
  title: string
  detail: string
  status: string
  actor: string | null
  correlation_id: string | null
}

export interface ProjectProjectionPage<T extends string> {
  rows: ProjectProjectionRow<T>[]
  hasMore: boolean
}

export interface ProjectProjectionInput {
  projectId: string
  readableSquadIds: string[] | null
  limit?: number
  offset?: number
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 100
const MAX_DETAIL_CHARS = 4000

function limitOf(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value as number)))
}

function offsetOf(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(10_000, Math.floor(value as number)))
}

function readableIds(input: ProjectProjectionInput): string {
  return JSON.stringify([...new Set(input.readableSquadIds ?? [])])
}

function adminFlag(input: ProjectProjectionInput): number {
  return input.readableSquadIds === null ? 1 : 0
}

function iso(value: unknown): string {
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value === 'string' && Number.isFinite(Number(value)) && value.trim() !== '') {
    return new Date(Number(value)).toISOString()
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString()
}

export function sanitizeProjectDetail(value: unknown): string {
  let text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
  text = text
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bmupot_[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/(["']?(?:authorization|token|private_key|secret)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, '$1[redacted]$2')
  return text.slice(0, MAX_DETAIL_CHARS)
}

function newest<T extends string>(rows: ProjectProjectionRow<T>[]): ProjectProjectionRow<T>[] {
  return rows.sort((a, b) => {
    const time = Date.parse(b.occurred_at) - Date.parse(a.occurred_at)
    if (time !== 0) return time
    const source = a.source_type.localeCompare(b.source_type)
    return source !== 0 ? source : a.source_id.localeCompare(b.source_id)
  })
}

function flightReadableSql(alias: string, idsParam: string): string {
  const safeMeta = `CASE WHEN json_valid(${alias}.meta) THEN ${alias}.meta ELSE '{}' END`
  return `(1 = 1 ${canonicalFlightMetaSql(alias)}
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${safeMeta}, '$.squad_ids') squad_ref
       WHERE NOT EXISTS (
         SELECT 1 FROM json_each(${idsParam}) readable
          WHERE CAST(readable.value AS TEXT) = CAST(squad_ref.value AS TEXT)
       )
    ))`
}

export async function listProjectActivity(
  env: Env,
  input: ProjectProjectionInput,
): Promise<ProjectProjectionPage<ProjectActivitySource>> {
  const limit = limitOf(input.limit)
  const offset = offsetOf(input.offset)
  const sourceLimit = offset + limit + 1
  const ids = readableIds(input)
  const isAdmin = adminFlag(input)

  const [taskRows, messageRows, flightRows] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.title, t.status, t.assignee_agent_id, t.created_at, s.name AS squad_name
         FROM tasks t JOIN squads s ON s.id = t.squad_id
        WHERE t.project_id = ?1
          AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
        ORDER BY t.created_at DESC, t.id DESC LIMIT ?4`,
    ).bind(input.projectId, isAdmin, ids, sourceLimit).all<{
      id: string; title: string; status: string; assignee_agent_id: string | null; created_at: string; squad_name: string
    }>(),
    env.DB.prepare(
      `SELECT id, from_agent, to_agent, kind, body, request_id, in_reply_to, created_at
         FROM agent_messages
        WHERE tenant = ?1 AND project_id = ?2
        ORDER BY created_at DESC, seq DESC LIMIT ?3`,
    ).bind(env.TENANT_SLUG, input.projectId, sourceLimit).all<{
      id: string; from_agent: string; to_agent: string; kind: string; body: string
      request_id: string | null; in_reply_to: string | null; created_at: string
    }>(),
    env.DB.prepare(
      `SELECT f.id, f.agent, f.goal, f.status, f.created_at
         FROM flights f
        WHERE f.tenant = ?1 AND f.project_id = ?2
          AND (?3 = 1 OR ${flightReadableSql('f', '?4')})
        ORDER BY f.created_at DESC, f.id DESC LIMIT ?5`,
    ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, sourceLimit).all<{
      id: string; agent: string; goal: string; status: string; created_at: number
    }>(),
  ])

  const rows: ProjectProjectionRow<ProjectActivitySource>[] = [
    ...(taskRows.results ?? []).map((row) => ({
      source_type: 'task' as const,
      source_id: row.id,
      occurred_at: iso(row.created_at),
      title: row.title,
      detail: row.squad_name,
      status: row.status,
      actor: row.assignee_agent_id,
      correlation_id: null,
    })),
    ...(messageRows.results ?? []).map((row) => ({
      source_type: 'message' as const,
      source_id: row.id,
      occurred_at: iso(row.created_at),
      title: `${row.from_agent} -> ${row.to_agent}`,
      detail: sanitizeProjectDetail(row.body),
      status: row.kind,
      actor: row.from_agent,
      correlation_id: row.request_id ?? row.in_reply_to,
    })),
    ...(flightRows.results ?? []).map((row) => ({
      source_type: 'flight' as const,
      source_id: row.id,
      occurred_at: iso(Number(row.created_at)),
      title: row.goal,
      detail: '',
      status: row.status,
      actor: row.agent,
      correlation_id: null,
    })),
  ]
  const ordered = newest(rows)
  return { rows: ordered.slice(offset, offset + limit), hasMore: ordered.length > offset + limit }
}

export async function listProjectEvidence(
  env: Env,
  input: ProjectProjectionInput,
): Promise<ProjectProjectionPage<ProjectEvidenceSource>> {
  const limit = limitOf(input.limit)
  const offset = offsetOf(input.offset)
  const sourceLimit = offset + limit + 1
  const ids = readableIds(input)
  const isAdmin = adminFlag(input)
  const taskFilter = `t.project_id = ?1 AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))`

  const [results, verdicts, workflows, dispatches, landings, acknowledgements] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.title, t.status, t.result, t.completed_at, t.updated_at,
              t.assignee_agent_id, t.execution_receipt_id
         FROM tasks t
        WHERE ${taskFilter} AND t.result IS NOT NULL AND length(trim(t.result)) > 0
        ORDER BY COALESCE(t.completed_at, t.updated_at) DESC, t.id DESC LIMIT ?4`,
    ).bind(input.projectId, isAdmin, ids, sourceLimit).all<{
      id: string; title: string; status: string; result: string; completed_at: string | null
      updated_at: string; assignee_agent_id: string | null; execution_receipt_id: string | null
    }>(),
    env.DB.prepare(
      `SELECT v.id, v.task_id, t.title, v.verdict, v.note, v.decided_by, v.decided_at
         FROM task_verdicts v JOIN tasks t ON t.id = v.task_id
        WHERE ${taskFilter}
        ORDER BY v.decided_at DESC, v.id DESC LIMIT ?4`,
    ).bind(input.projectId, isAdmin, ids, sourceLimit).all<{
      id: string; task_id: string; title: string; verdict: string; note: string | null; decided_by: string; decided_at: string
    }>(),
    env.DB.prepare(
      `SELECT w.id, w.instance_id, w.task_id, t.title, w.step_name, w.status, w.detail, w.created_at
         FROM workflow_receipts w JOIN tasks t ON t.id = w.task_id
        WHERE ${taskFilter}
        ORDER BY w.created_at DESC, w.id DESC LIMIT ?4`,
    ).bind(input.projectId, isAdmin, ids, sourceLimit).all<{
      id: string; instance_id: string; task_id: string; title: string; step_name: string; status: string; detail: string | null; created_at: string
    }>(),
    env.DB.prepare(
      `SELECT d.id, d.task_id, t.title, d.agent_id, d.actor_id, d.created_at,
              d.claimed_at, d.consumed_at, d.last_error
         FROM task_dispatch_receipts d JOIN tasks t ON t.id = d.task_id
        WHERE d.tenant = ?4 AND ${taskFilter}
        ORDER BY d.created_at DESC, d.id DESC LIMIT ?5`,
    ).bind(input.projectId, isAdmin, ids, env.TENANT_SLUG, sourceLimit).all<{
      id: string; task_id: string; title: string; agent_id: string; actor_id: string; created_at: string
      claimed_at: string | null; consumed_at: string | null; last_error: string | null
    }>(),
    env.DB.prepare(
      `SELECT o.id, o.flight_id, f.goal, o.actor_id, o.payload, o.created_at,
              o.delivered_at, o.consumed_at, o.last_error
         FROM flight_event_outbox o JOIN flights f ON f.id = o.flight_id
        WHERE o.tenant = ?1 AND f.project_id = ?2
          AND (?3 = 1 OR ${flightReadableSql('f', '?4')})
        ORDER BY o.created_at DESC, o.id DESC LIMIT ?5`,
    ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, sourceLimit).all<{
      id: string; flight_id: string; goal: string; actor_id: string; payload: string; created_at: string
      delivered_at: string | null; consumed_at: string | null; last_error: string | null
    }>(),
    env.DB.prepare(
      `SELECT id, from_agent, to_agent, body, in_reply_to, created_at
         FROM agent_messages
        WHERE tenant = ?1 AND project_id = ?2 AND kind = 'ack'
        ORDER BY created_at DESC, seq DESC LIMIT ?3`,
    ).bind(env.TENANT_SLUG, input.projectId, sourceLimit).all<{
      id: string; from_agent: string; to_agent: string; body: string; in_reply_to: string | null; created_at: string
    }>(),
  ])

  const rows: ProjectProjectionRow<ProjectEvidenceSource>[] = [
    ...(results.results ?? []).map((row) => ({
      source_type: 'task_result' as const, source_id: row.id,
      occurred_at: iso(row.completed_at ?? row.updated_at), title: row.title,
      detail: sanitizeProjectDetail(row.result), status: row.status,
      actor: row.assignee_agent_id, correlation_id: row.execution_receipt_id,
    })),
    ...(verdicts.results ?? []).map((row) => ({
      source_type: 'task_verdict' as const, source_id: row.id,
      occurred_at: iso(row.decided_at), title: row.title,
      detail: sanitizeProjectDetail(row.note), status: row.verdict,
      actor: row.decided_by, correlation_id: row.task_id,
    })),
    ...(workflows.results ?? []).map((row) => ({
      source_type: 'workflow_receipt' as const, source_id: row.id,
      occurred_at: iso(row.created_at), title: `${row.title}: ${row.step_name}`,
      detail: sanitizeProjectDetail(row.detail), status: row.status,
      actor: null, correlation_id: row.instance_id,
    })),
    ...(dispatches.results ?? []).map((row) => ({
      source_type: 'dispatch_receipt' as const, source_id: row.id,
      occurred_at: iso(row.created_at), title: row.title,
      detail: sanitizeProjectDetail(row.last_error),
      status: row.consumed_at ? 'consumed' : row.last_error ? 'failed' : row.claimed_at ? 'claimed' : 'pending',
      actor: row.actor_id, correlation_id: row.task_id,
    })),
    ...(landings.results ?? []).map((row) => ({
      source_type: 'flight_receipt' as const, source_id: row.id,
      occurred_at: iso(row.created_at), title: row.goal,
      detail: sanitizeProjectDetail(row.last_error ?? row.payload),
      status: row.consumed_at ? 'consumed' : row.delivered_at ? 'delivered' : row.last_error ? 'failed' : 'pending',
      actor: row.actor_id, correlation_id: row.flight_id,
    })),
    ...(acknowledgements.results ?? []).map((row) => ({
      source_type: 'message_ack' as const, source_id: row.id,
      occurred_at: iso(row.created_at), title: `${row.from_agent} -> ${row.to_agent}`,
      detail: sanitizeProjectDetail(row.body), status: 'ack',
      actor: row.from_agent, correlation_id: row.in_reply_to,
    })),
  ]
  const ordered = newest(rows)
  return { rows: ordered.slice(offset, offset + limit), hasMore: ordered.length > offset + limit }
}
