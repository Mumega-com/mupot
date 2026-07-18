import type { Env } from '../types'
import { canonicalFlightMetaSql } from '../flight/meta-sql'

export type ProjectActivitySource = 'task' | 'message' | 'flight' | 'project_link'
export type ProjectEvidenceSource =
  | 'task_result'
  | 'task_verdict'
  | 'workflow_receipt'
  | 'dispatch_receipt'
  | 'flight_receipt'
  | 'message_ack'
  | 'project_link_receipt'

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

function messageReadableSql(alias: string, idsParam: string, adminParam: string): string {
  const endpointIsReadable = (endpointAlias: string, field: 'from_agent' | 'to_agent') => `EXISTS (
    SELECT 1 FROM agents ${endpointAlias}
     WHERE ${endpointAlias}.id = ${alias}.${field}
       AND (
         ${adminParam} = 1
         OR ${endpointAlias}.squad_id IN (
           SELECT CAST(value AS TEXT) FROM json_each(${idsParam})
         )
       )
  )`
  return `(
    ${endpointIsReadable('readable_sender', 'from_agent')}
    AND ${endpointIsReadable('readable_recipient', 'to_agent')}
  )`
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

  const [taskRows, messageRows, flightRows, linkRows] = await Promise.all([
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
      `SELECT m.id, m.from_agent, m.to_agent, m.kind, m.body, m.request_id, m.in_reply_to, m.created_at
        FROM agent_messages m
       WHERE m.tenant = ?1 AND m.project_id = ?2
          AND ${messageReadableSql('m', '?4', '?3')}
        ORDER BY m.created_at DESC, m.seq DESC LIMIT ?5`,
    ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, sourceLimit).all<{
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
    env.DB.prepare(
      `SELECT id, remote_pot, remote_project_id, remote_agent_id, state,
              last_success_at, last_failure_at, last_error, stale_after_seconds,
              created_at, revoked_at
         FROM project_links
        WHERE tenant = ?1 AND local_project_id = ?2
          AND (?3 = 1 OR local_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
        ORDER BY COALESCE(last_success_at, last_failure_at, revoked_at, created_at) DESC, id DESC LIMIT ?5`,
    ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, sourceLimit).all<{
      id: string; remote_pot: string; remote_project_id: string; remote_agent_id: string
      state: 'active' | 'revoked'; last_success_at: string | null; last_failure_at: string | null
      last_error: string | null; stale_after_seconds: number; created_at: string; revoked_at: string | null
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
    ...(linkRows.results ?? []).map((row) => {
      const occurredAt = row.last_success_at ?? row.last_failure_at ?? row.revoked_at ?? row.created_at
      const status = row.state === 'revoked'
        ? 'revoked'
        : row.last_failure_at && (!row.last_success_at || Date.parse(row.last_failure_at) > Date.parse(row.last_success_at))
          ? 'failed'
          : !row.last_success_at
            ? 'unknown'
            : Date.now() - Date.parse(row.last_success_at) > row.stale_after_seconds * 1000
              ? 'stale'
              : 'healthy'
      return {
        source_type: 'project_link' as const,
        source_id: row.id,
        occurred_at: iso(occurredAt),
        title: `Linked project: ${row.remote_pot} / ${row.remote_project_id}`,
        detail: sanitizeProjectDetail(row.last_error ?? `source=${row.remote_pot}; last_sync=${row.last_success_at ?? 'unknown'}`),
        status,
        actor: row.remote_agent_id,
        correlation_id: null,
      }
    }),
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
      `SELECT m.id, m.from_agent, m.to_agent, m.body, m.in_reply_to, m.created_at
        FROM agent_messages m
       WHERE m.tenant = ?1 AND m.project_id = ?2 AND m.kind = 'ack'
          AND ${messageReadableSql('m', '?4', '?3')}
        ORDER BY m.created_at DESC, m.seq DESC LIMIT ?5`,
    ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, sourceLimit).all<{
      id: string; from_agent: string; to_agent: string; body: string; in_reply_to: string | null; created_at: string
    }>(),
  ])
  const linkReceipts = await env.DB.prepare(
    `SELECT r.id, r.direction, r.correlation_id, r.shared_receipt_sha256,
            r.envelope_sha256, r.evidence_sha256, r.remote_pot,
            r.remote_project_id, r.source_agent_id, r.action_type,
            r.action_id, r.receipt_key_id, r.receipt_signature, r.status, r.created_at
       FROM project_link_receipts r
       JOIN project_links l ON l.id = r.link_id AND l.tenant = r.tenant
      WHERE r.tenant = ?1 AND r.local_project_id = ?2
        AND (?3 = 1 OR l.local_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?5`,
  ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, sourceLimit).all<{
    id: string; direction: string; correlation_id: string; shared_receipt_sha256: string
    envelope_sha256: string; evidence_sha256: string | null; remote_pot: string
    remote_project_id: string; source_agent_id: string; action_type: string
    action_id: string; receipt_key_id: string; receipt_signature: string; status: string; created_at: string
  }>()

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
    ...(linkReceipts.results ?? []).map((row) => ({
      source_type: 'project_link_receipt' as const,
      source_id: row.id,
      occurred_at: iso(row.created_at),
      title: `${row.direction} ${row.action_type}: ${row.remote_pot} / ${row.remote_project_id}`,
      detail: `receipt=${row.shared_receipt_sha256}; envelope=${row.envelope_sha256}${row.evidence_sha256 ? `; evidence=${row.evidence_sha256}` : ''}; key=${row.receipt_key_id}; signature=${row.receipt_signature}`,
      status: row.status,
      actor: row.source_agent_id,
      correlation_id: row.correlation_id,
    })),
  ]
  const ordered = newest(rows)
  return { rows: ordered.slice(offset, offset + limit), hasMore: ordered.length > offset + limit }
}
