import type { Env } from '../types'
import { canonicalFlightMetaSql } from '../flight/meta-sql'
import { DISPATCH_BRIDGE_SENDER, DISPATCH_INBOX_PREFIX } from '../bus/fleet-bridge'

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
  nextCursor: ProjectProjectionCursor | null
}

export interface ProjectProjectionCursor {
  occurred_at: string
  source_type: string
  source_id: string
}

export interface ProjectProjectionInput {
  projectId: string
  readableSquadIds: string[] | null
  limit?: number
  offset?: number
  after?: ProjectProjectionCursor
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 100
const MAX_DETAIL_CHARS = 4000
const RECEIPT_KEYSET_INDEXES = [
  'idx_task_verdicts_evidence_keyset',
  'idx_workflow_receipts_evidence_keyset',
  'idx_task_dispatch_receipts_evidence_keyset',
  'idx_flight_event_outbox_evidence_keyset',
] as const
const receiptKeysetReady = new WeakSet<object>()
const ASSIGNMENT_RE = /((?:^|[\s,;{?&])["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=]\s*)[^,;}&\r\n]+/g
const QUERY_ASSIGNMENT_RE = /([?&])([A-Za-z][A-Za-z0-9_.-]*)(=)[^&#\s]*/g

function redactSecretPatterns(text: string): string {
  return text
    .replace(QUERY_ASSIGNMENT_RE, (match, delimiter: string, key: string, equals: string) => (
      isSensitiveDetailKey(key) ? `${delimiter}${key}${equals}[redacted]` : match
    ))
    .replace(ASSIGNMENT_RE, (match, prefix: string, key: string) => (
      isSensitiveDetailKey(key) ? `${prefix}[redacted]` : match
    ))
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi, '[redacted]')
    .replace(/\bmupot_[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[redacted]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted]')
}

function isSensitiveDetailKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized.endsWith('apikey')
    || normalized === 'authorization'
    || normalized === 'bearer'
    || normalized.endsWith('token')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('clientsecret')
    || normalized.endsWith('accountkey')
    || normalized.endsWith('accesskey')
    || normalized.endsWith('secretkey')
    || normalized.endsWith('signingkey')
    || normalized.endsWith('connectionstring')
    || normalized.endsWith('sharedaccesssignature')
    || normalized.endsWith('password')
    || normalized === 'passwd'
    || normalized.endsWith('secret')
    || normalized.endsWith('cookie')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials')
}

function redactStructuredDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredDetail)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveDetailKey(key) ? '[redacted]' : redactStructuredDetail(item),
    ]))
  }
  return typeof value === 'string' ? redactSecretPatterns(value) : value
}

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

async function receiptKeysetHintsReady(env: Env): Promise<boolean> {
  const database = env.DB as unknown as object
  if (receiptKeysetReady.has(database)) return true
  const placeholders = RECEIPT_KEYSET_INDEXES.map((_, index) => `?${index + 1}`).join(', ')
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`,
  ).bind(...RECEIPT_KEYSET_INDEXES).all<{ name: string }>()
  const names = new Set((result.results ?? []).map((row) => row.name))
  const ready = RECEIPT_KEYSET_INDEXES.every((name) => names.has(name))
  if (ready) receiptKeysetReady.add(database)
  return ready
}

function epochMs(expression: string): string {
  return `CAST(ROUND((julianday(${expression}) - 2440587.5) * 86400000) AS INTEGER)`
}

function afterClause(
  input: ProjectProjectionInput,
  timeExpression: string,
  idExpression: string,
  sourceType: string,
  startParam: number,
): { sql: string; binds: unknown[]; nextParam: number } {
  if (!input.after) return { sql: '', binds: [], nextParam: startParam }
  const occurredMs = Date.parse(input.after.occurred_at)
  return {
    sql: `AND (
      ${timeExpression} < ?${startParam}
      OR (${timeExpression} = ?${startParam + 1} AND (
        '${sourceType}' > ?${startParam + 2}
        OR ('${sourceType}' = ?${startParam + 3} AND ${idExpression} > ?${startParam + 4})
      ))
    )`,
    binds: [occurredMs, occurredMs, input.after.source_type, input.after.source_type, input.after.source_id],
    nextParam: startParam + 5,
  }
}

function projectionPage<T extends string>(
  rows: ProjectProjectionRow<T>[],
  offset: number,
  limit: number,
): ProjectProjectionPage<T> {
  const visible = rows.slice(offset, offset + limit)
  const hasMore = rows.length > offset + limit
  const last = visible.at(-1)
  return {
    rows: visible,
    hasMore,
    nextCursor: hasMore && last
      ? { occurred_at: last.occurred_at, source_type: last.source_type, source_id: last.source_id }
      : null,
  }
}

function iso(value: unknown): string {
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value === 'string' && Number.isFinite(Number(value)) && value.trim() !== '') {
    return new Date(Number(value)).toISOString()
  }
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = typeof normalized === 'string' ? Date.parse(normalized) : Number.NaN
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString()
}

export function sanitizeProjectDetail(value: unknown): string {
  if (value == null) return ''

  let structured: unknown = value
  if (typeof value === 'string') {
    try {
      structured = JSON.parse(value)
    } catch {
      return redactSecretPatterns(value).slice(0, MAX_DETAIL_CHARS)
    }
    if (!structured || typeof structured !== 'object') {
      return redactSecretPatterns(value).slice(0, MAX_DETAIL_CHARS)
    }
  }

  try {
    return JSON.stringify(redactStructuredDetail(structured)).slice(0, MAX_DETAIL_CHARS)
  } catch {
    return redactSecretPatterns(String(value)).slice(0, MAX_DETAIL_CHARS)
  }
}

function newest<T extends string>(rows: ProjectProjectionRow<T>[]): ProjectProjectionRow<T>[] {
  return rows.sort((a, b) => {
    const time = Date.parse(b.occurred_at) - Date.parse(a.occurred_at)
    if (time !== 0) return time
    const source = sqliteBinaryCompare(a.source_type, b.source_type)
    return source !== 0 ? source : sqliteBinaryCompare(a.source_id, b.source_id)
  })
}

function sqliteBinaryCompare(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  const sharedLength = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
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

function dispatchMessageReadableSql(
  alias: string,
  idsParam: string,
  adminParam: string,
  senderParam: string,
  requestPrefixParam: string,
): string {
  return `(
    ${alias}.from_agent = ${senderParam}
    AND ${alias}.kind = 'request'
    AND ${alias}.request_id IS NOT NULL
    AND json_valid(${alias}.body)
    AND json_type(${alias}.body) = 'object'
    AND EXISTS (
      SELECT 1
        FROM task_dispatch_receipts dispatch_receipt
        JOIN tasks dispatched_task ON dispatched_task.id = dispatch_receipt.task_id
        JOIN agents dispatch_recipient ON dispatch_recipient.id = dispatch_receipt.agent_id
       WHERE dispatch_receipt.tenant = ${alias}.tenant
         AND ${alias}.request_id = ${requestPrefixParam} || dispatch_receipt.id
         AND dispatch_receipt.agent_id = ${alias}.to_agent
         AND dispatch_receipt.actor_id = ${alias}.from_member
         AND dispatch_receipt.squad_id = dispatch_recipient.squad_id
         AND dispatched_task.project_id = ${alias}.project_id
         AND json_extract(${alias}.body, '$.type') = 'task_dispatch'
         AND json_extract(${alias}.body, '$.task_id') = dispatch_receipt.task_id
         AND json_extract(${alias}.body, '$.dispatch_receipt_id') = dispatch_receipt.id
         AND json_extract(${alias}.body, '$.squad_id') = dispatch_receipt.squad_id
         AND (
           ${adminParam} = 1
           OR dispatch_recipient.squad_id IN (
             SELECT CAST(value AS TEXT) FROM json_each(${idsParam})
           )
         )
    )
  )`
}

export async function listProjectActivity(
  env: Env,
  input: ProjectProjectionInput,
): Promise<ProjectProjectionPage<ProjectActivitySource>> {
  const limit = limitOf(input.limit)
  const offset = input.after ? 0 : offsetOf(input.offset)
  const sourceLimit = offset + limit + 1
  const ids = readableIds(input)
  const isAdmin = adminFlag(input)
  const taskAfter = afterClause(input, epochMs('t.created_at'), 't.id', 'task', 4)
  const messageAfter = afterClause(input, epochMs('m.created_at'), 'm.id', 'message', 7)
  const flightAfter = afterClause(input, 'f.created_at', 'f.id', 'flight', 5)
  const linkOccurredAt = 'COALESCE(last_success_at, last_failure_at, revoked_at, created_at)'
  const linkAfter = afterClause(input, epochMs(linkOccurredAt), 'id', 'project_link', 5)

  const [taskRows, messageRows, flightRows, linkRows] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.title, t.status, t.assignee_agent_id, t.created_at, s.name AS squad_name
         FROM tasks t JOIN squads s ON s.id = t.squad_id
        WHERE t.project_id = ?1
          AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ${taskAfter.sql}
        ORDER BY ${epochMs('t.created_at')} DESC, t.id ASC LIMIT ?${taskAfter.nextParam}`,
    ).bind(input.projectId, isAdmin, ids, ...taskAfter.binds, sourceLimit).all<{
      id: string; title: string; status: string; assignee_agent_id: string | null; created_at: string; squad_name: string
    }>(),
    env.DB.prepare(
      `SELECT m.id, m.from_agent, m.to_agent, m.kind, m.body, m.request_id, m.in_reply_to, m.created_at
        FROM agent_messages m
       WHERE m.tenant = ?1 AND m.project_id = ?2
          AND (
            ${messageReadableSql('m', '?4', '?3')}
            OR ${dispatchMessageReadableSql('m', '?4', '?3', '?5', '?6')}
          )
          ${messageAfter.sql}
        ORDER BY ${epochMs('m.created_at')} DESC, m.id ASC LIMIT ?${messageAfter.nextParam}`,
    ).bind(
      env.TENANT_SLUG,
      input.projectId,
      isAdmin,
      ids,
      DISPATCH_BRIDGE_SENDER,
      DISPATCH_INBOX_PREFIX,
      ...messageAfter.binds,
      sourceLimit,
    ).all<{
      id: string; from_agent: string; to_agent: string; kind: string; body: string
      request_id: string | null; in_reply_to: string | null; created_at: string
    }>(),
    env.DB.prepare(
      `SELECT f.id, f.agent, f.goal, f.status, f.created_at
         FROM flights f
        WHERE f.tenant = ?1 AND f.project_id = ?2
          AND (?3 = 1 OR ${flightReadableSql('f', '?4')})
          ${flightAfter.sql}
        ORDER BY f.created_at DESC, f.id ASC LIMIT ?${flightAfter.nextParam}`,
    ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, ...flightAfter.binds, sourceLimit).all<{
      id: string; agent: string; goal: string; status: string; created_at: number
    }>(),
    env.DB.prepare(
      `SELECT id, remote_pot, remote_project_id, remote_agent_id, state,
              last_success_at, last_failure_at, last_error, stale_after_seconds,
              created_at, revoked_at
         FROM project_links
        WHERE tenant = ?1 AND local_project_id = ?2
          AND (?3 = 1 OR local_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
          ${linkAfter.sql}
        ORDER BY ${epochMs(linkOccurredAt)} DESC, id ASC LIMIT ?${linkAfter.nextParam}`,
    ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, ...linkAfter.binds, sourceLimit).all<{
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
      title: sanitizeProjectDetail(row.title),
      detail: sanitizeProjectDetail(row.squad_name),
      status: row.status,
      actor: row.assignee_agent_id,
      correlation_id: null,
    })),
    ...(messageRows.results ?? []).map((row) => ({
      source_type: 'message' as const,
      source_id: row.id,
      occurred_at: iso(row.created_at),
      title: sanitizeProjectDetail(`${row.from_agent} -> ${row.to_agent}`),
      detail: sanitizeProjectDetail(row.body),
      status: row.kind,
      actor: row.from_agent,
      correlation_id: row.request_id ?? row.in_reply_to,
    })),
    ...(flightRows.results ?? []).map((row) => ({
      source_type: 'flight' as const,
      source_id: row.id,
      occurred_at: iso(Number(row.created_at)),
      title: sanitizeProjectDetail(row.goal),
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
        title: sanitizeProjectDetail(`Linked project: ${row.remote_pot} / ${row.remote_project_id}`),
        detail: sanitizeProjectDetail(row.last_error ?? `source=${row.remote_pot}; last_sync=${row.last_success_at ?? 'unknown'}`),
        status,
        actor: row.remote_agent_id,
        correlation_id: null,
      }
    }),
  ]
  const ordered = newest(rows)
  return projectionPage(ordered, offset, limit)
}

export async function listProjectEvidence(
  env: Env,
  input: ProjectProjectionInput,
): Promise<ProjectProjectionPage<ProjectEvidenceSource>> {
  const limit = limitOf(input.limit)
  const offset = input.after ? 0 : offsetOf(input.offset)
  const sourceLimit = offset + limit + 1
  const ids = readableIds(input)
  const isAdmin = adminFlag(input)
  const taskFilter = `t.project_id = ?1 AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))`
  const resultTime = epochMs('COALESCE(t.completed_at, t.updated_at)')
  const resultAfter = afterClause(input, resultTime, 't.id', 'task_result', 4)
  const verdictAfter = afterClause(input, epochMs('v.decided_at'), 'v.id', 'task_verdict', 4)
  const workflowAfter = afterClause(input, epochMs('w.created_at'), 'w.id', 'workflow_receipt', 4)
  const dispatchAfter = afterClause(input, epochMs('d.created_at'), 'd.id', 'dispatch_receipt', 5)
  const landingAfter = afterClause(input, epochMs('o.created_at'), 'o.id', 'flight_receipt', 5)
  const acknowledgementAfter = afterClause(input, epochMs('m.created_at'), 'm.id', 'message_ack', 5)
  const linkReceiptAfter = afterClause(input, epochMs('r.created_at'), 'r.id', 'project_link_receipt', 5)
  const useReceiptKeysetHints = await receiptKeysetHintsReady(env)
  const verdictIndex = useReceiptKeysetHints ? 'INDEXED BY idx_task_verdicts_evidence_keyset' : ''
  const workflowIndex = useReceiptKeysetHints ? 'INDEXED BY idx_workflow_receipts_evidence_keyset' : ''
  const dispatchIndex = useReceiptKeysetHints ? 'INDEXED BY idx_task_dispatch_receipts_evidence_keyset' : ''
  const landingIndex = useReceiptKeysetHints ? 'INDEXED BY idx_flight_event_outbox_evidence_keyset' : ''
  const verdictProjectScope = useReceiptKeysetHints ? 'v.project_id = ?1 AND' : ''
  const workflowProjectScope = useReceiptKeysetHints ? 'w.project_id = ?1 AND' : ''
  const dispatchProjectScope = useReceiptKeysetHints ? 'd.project_id = ?1 AND' : ''
  const landingProjectScope = useReceiptKeysetHints ? 'o.project_id = ?2 AND' : ''

  const [results, verdicts, workflows, dispatches, landings, acknowledgements] = await Promise.all([
    env.DB.prepare(
      `SELECT t.id, t.title, t.status, t.result, t.completed_at, t.updated_at,
              t.assignee_agent_id, t.execution_receipt_id
        FROM tasks t
        WHERE ${taskFilter} AND t.result IS NOT NULL AND length(trim(t.result)) > 0
          ${resultAfter.sql}
        ORDER BY ${resultTime} DESC, t.id ASC LIMIT ?${resultAfter.nextParam}`,
    ).bind(input.projectId, isAdmin, ids, ...resultAfter.binds, sourceLimit).all<{
      id: string; title: string; status: string; result: string; completed_at: string | null
      updated_at: string; assignee_agent_id: string | null; execution_receipt_id: string | null
    }>(),
    env.DB.prepare(
      `SELECT v.id, v.task_id, t.title, v.verdict, v.note, v.decided_by, v.decided_at
         FROM task_verdicts v ${verdictIndex}
         CROSS JOIN tasks t ON t.id = v.task_id
        WHERE ${verdictProjectScope} ${taskFilter}
          ${verdictAfter.sql}
        ORDER BY ${epochMs('v.decided_at')} DESC, v.id ASC LIMIT ?${verdictAfter.nextParam}`,
    ).bind(input.projectId, isAdmin, ids, ...verdictAfter.binds, sourceLimit).all<{
      id: string; task_id: string; title: string; verdict: string; note: string | null; decided_by: string; decided_at: string
    }>(),
    env.DB.prepare(
      `SELECT w.id, w.instance_id, w.task_id, t.title, w.step_name, w.status, w.detail, w.created_at
         FROM workflow_receipts w ${workflowIndex}
         CROSS JOIN tasks t ON t.id = w.task_id
        WHERE ${workflowProjectScope} ${taskFilter}
          ${workflowAfter.sql}
        ORDER BY ${epochMs('w.created_at')} DESC, w.id ASC LIMIT ?${workflowAfter.nextParam}`,
    ).bind(input.projectId, isAdmin, ids, ...workflowAfter.binds, sourceLimit).all<{
      id: string; instance_id: string; task_id: string; title: string; step_name: string; status: string; detail: string | null; created_at: string
    }>(),
    env.DB.prepare(
      `SELECT d.id, d.task_id, t.title, d.agent_id, d.actor_id, d.created_at,
              d.claimed_at, d.consumed_at, d.last_error
         FROM task_dispatch_receipts d ${dispatchIndex}
         CROSS JOIN tasks t ON t.id = d.task_id
        WHERE d.tenant = ?4 AND ${dispatchProjectScope} ${taskFilter}
          ${dispatchAfter.sql}
        ORDER BY ${epochMs('d.created_at')} DESC, d.id ASC LIMIT ?${dispatchAfter.nextParam}`,
    ).bind(input.projectId, isAdmin, ids, env.TENANT_SLUG, ...dispatchAfter.binds, sourceLimit).all<{
      id: string; task_id: string; title: string; agent_id: string; actor_id: string; created_at: string
      claimed_at: string | null; consumed_at: string | null; last_error: string | null
    }>(),
    env.DB.prepare(
      `SELECT o.id, o.flight_id, f.goal, o.actor_id, o.payload, o.created_at,
              o.delivered_at, o.consumed_at, o.last_error
         FROM flight_event_outbox o ${landingIndex}
         CROSS JOIN flights f ON f.id = o.flight_id
        WHERE o.tenant = ?1 AND ${landingProjectScope} f.project_id = ?2
          AND (?3 = 1 OR ${flightReadableSql('f', '?4')})
          ${landingAfter.sql}
        ORDER BY ${epochMs('o.created_at')} DESC, o.id ASC LIMIT ?${landingAfter.nextParam}`,
    ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, ...landingAfter.binds, sourceLimit).all<{
      id: string; flight_id: string; goal: string; actor_id: string; payload: string; created_at: string
      delivered_at: string | null; consumed_at: string | null; last_error: string | null
    }>(),
    env.DB.prepare(
      `SELECT m.id, m.from_agent, m.to_agent, m.body, m.in_reply_to, m.created_at
        FROM agent_messages m
       WHERE m.tenant = ?1 AND m.project_id = ?2 AND m.kind = 'ack'
          AND ${messageReadableSql('m', '?4', '?3')}
          ${acknowledgementAfter.sql}
        ORDER BY ${epochMs('m.created_at')} DESC, m.id ASC LIMIT ?${acknowledgementAfter.nextParam}`,
    ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, ...acknowledgementAfter.binds, sourceLimit).all<{
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
        ${linkReceiptAfter.sql}
      ORDER BY ${epochMs('r.created_at')} DESC, r.id ASC LIMIT ?${linkReceiptAfter.nextParam}`,
  ).bind(env.TENANT_SLUG, input.projectId, isAdmin, ids, ...linkReceiptAfter.binds, sourceLimit).all<{
    id: string; direction: string; correlation_id: string; shared_receipt_sha256: string
    envelope_sha256: string; evidence_sha256: string | null; remote_pot: string
    remote_project_id: string; source_agent_id: string; action_type: string
    action_id: string; receipt_key_id: string; receipt_signature: string; status: string; created_at: string
  }>()

  const rows: ProjectProjectionRow<ProjectEvidenceSource>[] = [
    ...(results.results ?? []).map((row) => ({
      source_type: 'task_result' as const, source_id: row.id,
      occurred_at: iso(row.completed_at ?? row.updated_at), title: sanitizeProjectDetail(row.title),
      detail: sanitizeProjectDetail(row.result), status: row.status,
      actor: row.assignee_agent_id, correlation_id: row.execution_receipt_id,
    })),
    ...(verdicts.results ?? []).map((row) => ({
      source_type: 'task_verdict' as const, source_id: row.id,
      occurred_at: iso(row.decided_at), title: sanitizeProjectDetail(row.title),
      detail: sanitizeProjectDetail(row.note), status: row.verdict,
      actor: row.decided_by, correlation_id: row.task_id,
    })),
    ...(workflows.results ?? []).map((row) => ({
      source_type: 'workflow_receipt' as const, source_id: row.id,
      occurred_at: iso(row.created_at), title: sanitizeProjectDetail(`${row.title}: ${row.step_name}`),
      detail: sanitizeProjectDetail(row.detail), status: row.status,
      actor: null, correlation_id: row.instance_id,
    })),
    ...(dispatches.results ?? []).map((row) => ({
      source_type: 'dispatch_receipt' as const, source_id: row.id,
      occurred_at: iso(row.created_at), title: sanitizeProjectDetail(row.title),
      detail: sanitizeProjectDetail(row.last_error),
      status: row.consumed_at ? 'consumed' : row.last_error ? 'failed' : row.claimed_at ? 'claimed' : 'pending',
      actor: row.actor_id, correlation_id: row.task_id,
    })),
    ...(landings.results ?? []).map((row) => ({
      source_type: 'flight_receipt' as const, source_id: row.id,
      occurred_at: iso(row.created_at), title: sanitizeProjectDetail(row.goal),
      detail: sanitizeProjectDetail(row.last_error ?? row.payload),
      status: row.consumed_at ? 'consumed' : row.delivered_at ? 'delivered' : row.last_error ? 'failed' : 'pending',
      actor: row.actor_id, correlation_id: row.flight_id,
    })),
    ...(acknowledgements.results ?? []).map((row) => ({
      source_type: 'message_ack' as const, source_id: row.id,
      occurred_at: iso(row.created_at), title: sanitizeProjectDetail(`${row.from_agent} -> ${row.to_agent}`),
      detail: sanitizeProjectDetail(row.body), status: 'ack',
      actor: row.from_agent, correlation_id: row.in_reply_to,
    })),
    ...(linkReceipts.results ?? []).map((row) => ({
      source_type: 'project_link_receipt' as const,
      source_id: row.id,
      occurred_at: iso(row.created_at),
      title: sanitizeProjectDetail(`${row.direction} ${row.action_type}: ${row.remote_pot} / ${row.remote_project_id}`),
      detail: `receipt=${row.shared_receipt_sha256}; envelope=${row.envelope_sha256}${row.evidence_sha256 ? `; evidence=${row.evidence_sha256}` : ''}; key=${row.receipt_key_id}; signature=${row.receipt_signature}`,
      status: row.status,
      actor: row.source_agent_id,
      correlation_id: row.correlation_id,
    })),
  ]
  const ordered = newest(rows)
  return projectionPage(ordered, offset, limit)
}
