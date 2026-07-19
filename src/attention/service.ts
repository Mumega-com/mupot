import type { Env } from '../types'
import { hasCapability } from '../auth/capability'
import { CONTENT_GATE_OWNER } from '../agents/execute'
import { projectVisibilityClause } from '../projects/access'
import type { RoutinePrincipal } from '../routines/access'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const SOURCE_SCAN_CAP = 100
const CURSOR_TTL_SECONDS = 600

export type NeedsYouKind =
  | 'approval'
  | 'routine_agent'
  | 'routine_answer'
  | 'routine_review'
  | 'routine_approval'
  | 'routine_budget'
  | 'blocked_task'
  | 'publishable_output'

export type NeedsYouAction =
  | 'view'
  | 'approve'
  | 'reject'
  | 'assign_agent'
  | 'answer'
  | 'change_budget'
  | 'cancel'
  | 'publish'

export interface NeedsYouItem {
  kind: NeedsYouKind
  source_type: 'task' | 'routine_run'
  source_id: string
  project_id: string
  project_name: string
  title: string
  reason: string
  urgency: 'urgent' | 'high' | 'normal' | 'low'
  responsible: string | null
  requested_by: string | null
  created_at: string
  deadline_at: string | null
  safe_url: string
  allowed_actions: NeedsYouAction[]
}

export interface NeedsYouOptions {
  project_id?: string
  limit?: number
  after?: string
}

export interface NeedsYouPage {
  items: NeedsYouItem[]
  next_cursor: string | null
  truncated: boolean
  truncated_sources: string[]
}

interface SourceRow {
  kind: NeedsYouKind
  source_type: NeedsYouItem['source_type']
  source_id: string
  project_id: string
  project_name: string
  title: string
  reason: string
  urgency_rank: number
  responsible: string | null
  requested_by: string | null
  created_at: string
  deadline_at: string | null
  squad_id: string | null
  squad_department_id: string | null
  project_access_level: 'read' | 'write' | 'admin' | null
  assignee_agent_id: string | null
  gate_owner: string | null
  has_gate_grant: number
  has_surface_grant: number
  sort_deadline: string
  sort_timestamp: string
}

interface NeedsYouCursor {
  tenant: string
  actor_type: RoutinePrincipal['actor_type']
  actor_id: string
  project_id: string | null
  urgency_rank: number
  deadline: string
  timestamp: string
  type: NeedsYouItem['source_type']
  id: string
}

interface SourceResult {
  name: string
  rows: SourceRow[]
  truncated: boolean
}

const DEADLINE_SENTINEL = '9999-12-31T23:59:59.999Z'

function safePath(segment: string): string {
  return encodeURIComponent(segment)
}

function urgency(rank: number): NeedsYouItem['urgency'] {
  if (rank === 0) return 'urgent'
  if (rank === 1) return 'high'
  if (rank === 2) return 'normal'
  return 'low'
}

function principalCanActOnSquad(row: SourceRow, principal: RoutinePrincipal): boolean {
  return principal.legacy_owner_admin === true
    || (row.squad_id !== null && hasCapability(
      principal.grants,
      'squad',
      row.squad_id,
      'member',
      row.squad_department_id,
    ))
}

function principalCanAnswerRoutine(row: SourceRow, principal: RoutinePrincipal): boolean {
  if (principal.workspace_admin) return true
  return (row.project_access_level === 'write' || row.project_access_level === 'admin')
    && principalCanActOnSquad(row, principal)
}

function actionsFor(row: SourceRow, principal: RoutinePrincipal): NeedsYouAction[] {
  if (row.source_type === 'task') {
    if (row.kind === 'approval') {
      if (
        row.assignee_agent_id === principal.actor_id
        || !principalCanActOnSquad(row, principal)
        || !(principal.legacy_owner_admin || row.has_gate_grant)
      ) return ['view']
      if (row.gate_owner === 'gate:loops' && !(principal.legacy_owner_admin || row.has_surface_grant)) {
        return ['view', 'reject']
      }
      return ['view', 'approve', 'reject']
    }
    if (row.kind === 'publishable_output') {
      return principal.actor_type === 'member' && principal.workspace_admin ? ['view', 'publish'] : ['view']
    }
    return ['view']
  }

  const actions: NeedsYouAction[] = ['view']
  const human = principal.actor_type === 'member'
  if (row.kind === 'routine_answer' && human && principalCanAnswerRoutine(row, principal)) {
    actions.push('answer')
  }
  if (!human || !principal.workspace_admin || !principalCanActOnSquad(row, principal)) return actions

  switch (row.kind) {
    case 'routine_agent': actions.push('assign_agent', 'cancel'); break
    case 'routine_budget': actions.push('change_budget', 'cancel'); break
    case 'routine_answer':
    case 'routine_review':
    case 'routine_approval': actions.push('cancel'); break
  }
  return actions
}

function itemFrom(row: SourceRow, principal: RoutinePrincipal): NeedsYouItem {
  return {
    kind: row.kind,
    source_type: row.source_type,
    source_id: row.source_id,
    project_id: row.project_id,
    project_name: row.project_name,
    title: row.title,
    reason: row.reason,
    urgency: urgency(row.urgency_rank),
    responsible: row.responsible,
    requested_by: row.requested_by,
    created_at: row.created_at,
    deadline_at: row.deadline_at,
    safe_url: row.source_type === 'task'
      ? `/projects/${safePath(row.project_id)}#work`
      : `/projects/${safePath(row.project_id)}/routines?run_id=${safePath(row.source_id)}`,
    allowed_actions: actionsFor(row, principal),
  }
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT
}

function cursorPredicate(cursor: NeedsYouCursor | null): { sql: string; binds: unknown[] } {
  if (!cursor) return { sql: '', binds: [] }
  return {
    sql: `WHERE (
      urgency_rank > ?
      OR (urgency_rank = ? AND (
        sort_deadline > ?
        OR (sort_deadline = ? AND (
          sort_timestamp < ?
          OR (sort_timestamp = ? AND (
            source_type > ?
            OR (source_type = ? AND source_id > ?)
          ))
        ))
      ))
    )`,
    binds: [
      cursor.urgency_rank, cursor.urgency_rank,
      cursor.deadline, cursor.deadline,
      cursor.timestamp, cursor.timestamp,
      cursor.type, cursor.type, cursor.id,
    ],
  }
}

function orderedSourceQuery(inner: string, cursor: NeedsYouCursor | null): { sql: string; binds: unknown[] } {
  const after = cursorPredicate(cursor)
  return {
    sql: `SELECT * FROM (${inner}) attention ${after.sql}
      ORDER BY urgency_rank ASC, sort_deadline ASC, sort_timestamp DESC, source_type ASC, source_id ASC
      LIMIT ?`,
    binds: [...after.binds, SOURCE_SCAN_CAP + 1],
  }
}

async function querySource(
  env: Env,
  name: string,
  inner: string,
  binds: unknown[],
  cursor: NeedsYouCursor | null,
): Promise<SourceResult> {
  const query = orderedSourceQuery(inner, cursor)
  const result = await env.DB.prepare(query.sql).bind(...binds, ...query.binds).all<SourceRow>()
  const rows = result.results ?? []
  return { name, rows: rows.slice(0, SOURCE_SCAN_CAP), truncated: rows.length > SOURCE_SCAN_CAP }
}

function principalGateBinds(principal: RoutinePrincipal): unknown[] {
  return [principal.actor_type, principal.actor_id, principal.actor_type, principal.actor_id]
}

async function sourceRows(
  env: Env,
  principal: RoutinePrincipal,
  options: NeedsYouOptions,
  cursor: NeedsYouCursor | null,
): Promise<SourceResult[]> {
  const visibility = projectVisibilityClause(principal.project_read)
  const projectClause = options.project_id ? ' AND p.id = ?' : ''
  const projectBinds = options.project_id ? [options.project_id] : []
  const gateBinds = principalGateBinds(principal)
  const projectScope = [...projectBinds, ...visibility.binds]

  const approvals = querySource(env, 'approvals', `
    SELECT
      'approval' AS kind, 'task' AS source_type, t.id AS source_id,
      p.id AS project_id, p.name AS project_name, t.title,
      'Approval required by ' || t.gate_owner AS reason,
      0 AS urgency_rank, t.gate_owner AS responsible, t.assignee_agent_id AS requested_by,
      t.created_at, p.target_date AS deadline_at,
      t.squad_id, s.department_id AS squad_department_id, NULL AS project_access_level,
      t.assignee_agent_id, t.gate_owner,
      CASE WHEN EXISTS (
        SELECT 1 FROM gate_grants g
         WHERE g.capability = t.gate_owner
           AND g.principal_type = ?
           AND g.principal_id = ?
      ) THEN 1 ELSE 0 END AS has_gate_grant,
      CASE WHEN EXISTS (
        SELECT 1 FROM gate_grants g
         WHERE g.capability = 'outreach:send-gated'
           AND g.principal_type = ?
           AND g.principal_id = ?
      ) THEN 1 ELSE 0 END AS has_surface_grant,
      COALESCE(p.target_date, '${DEADLINE_SENTINEL}') AS sort_deadline,
      t.created_at AS sort_timestamp
    FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN squads s ON s.id = t.squad_id
    WHERE t.status = 'review' AND t.gate_owner IS NOT NULL${projectClause}
      AND ${visibility.sql}
  `, [...gateBinds, ...projectScope], cursor)

  const routineWaits = querySource(env, 'routine_waits', `
    SELECT
      CASE rr.waiting_reason
        WHEN 'agent' THEN 'routine_agent'
        WHEN 'answer' THEN 'routine_answer'
        WHEN 'review' THEN 'routine_review'
        WHEN 'approval' THEN 'routine_approval'
        ELSE 'routine_budget'
      END AS kind,
      'routine_run' AS source_type, rr.id AS source_id,
      p.id AS project_id, p.name AS project_name, r.name AS title,
      'Routine is waiting for ' || rr.waiting_reason AS reason,
      CASE WHEN rr.waiting_reason IN ('approval', 'review', 'budget') THEN 0 ELSE 1 END AS urgency_rank,
      r.responsible_squad_id AS responsible, r.created_by AS requested_by,
      rr.created_at, rr.scheduled_for AS deadline_at,
      r.responsible_squad_id AS squad_id, s.department_id AS squad_department_id,
      psa.access_level AS project_access_level,
      NULL AS assignee_agent_id, NULL AS gate_owner, 0 AS has_gate_grant, 0 AS has_surface_grant,
      COALESCE(rr.scheduled_for, '${DEADLINE_SENTINEL}') AS sort_deadline,
      rr.created_at AS sort_timestamp
    FROM routine_runs rr
    JOIN routines r ON r.id = rr.routine_id AND r.tenant = rr.tenant
    JOIN projects p ON p.id = rr.project_id
    JOIN squads s ON s.id = r.responsible_squad_id
    JOIN project_squad_access psa
      ON psa.project_id = rr.project_id AND psa.squad_id = r.responsible_squad_id
    WHERE rr.tenant = ? AND rr.status = 'waiting' AND rr.waiting_reason IS NOT NULL
      AND NOT (rr.waiting_reason = 'review' AND rr.task_id IS NOT NULL)${projectClause}
      AND ${visibility.sql}
  `, [env.TENANT_SLUG, ...projectScope], cursor)

  const blockedTasks = querySource(env, 'blocked_tasks', `
    SELECT
      'blocked_task' AS kind, 'task' AS source_type, t.id AS source_id,
      p.id AS project_id, p.name AS project_name, t.title,
      'Blocked work requires ' || t.gate_owner AS reason,
      2 AS urgency_rank, t.gate_owner AS responsible, NULL AS requested_by,
      t.created_at, p.target_date AS deadline_at,
      t.squad_id, s.department_id AS squad_department_id, NULL AS project_access_level,
      NULL AS assignee_agent_id, t.gate_owner, 0 AS has_gate_grant, 0 AS has_surface_grant,
      COALESCE(p.target_date, '${DEADLINE_SENTINEL}') AS sort_deadline,
      t.created_at AS sort_timestamp
    FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN squads s ON s.id = t.squad_id
    WHERE t.status = 'blocked' AND t.assignee_agent_id IS NULL AND t.gate_owner IS NOT NULL${projectClause}
      AND ${visibility.sql}
  `, projectScope, cursor)

  const publishableOutputs = querySource(env, 'publishable_outputs', `
    SELECT
      'publishable_output' AS kind, 'task' AS source_type, t.id AS source_id,
      p.id AS project_id, p.name AS project_name, t.title,
      'Approved output awaits publication' AS reason,
      3 AS urgency_rank, 'workspace_admin' AS responsible, t.assignee_agent_id AS requested_by,
      t.created_at, p.target_date AS deadline_at,
      t.squad_id, s.department_id AS squad_department_id, NULL AS project_access_level,
      t.assignee_agent_id, t.gate_owner, 0 AS has_gate_grant, 0 AS has_surface_grant,
      COALESCE(p.target_date, '${DEADLINE_SENTINEL}') AS sort_deadline,
      t.created_at AS sort_timestamp
    FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN squads s ON s.id = t.squad_id
    WHERE t.status = 'approved' AND t.gate_owner = ? AND t.result IS NOT NULL${projectClause}
      AND ${visibility.sql}
  `, [CONTENT_GATE_OWNER, ...projectScope], cursor)

  return Promise.all([approvals, routineWaits, blockedTasks, publishableOutputs])
}

function validateCursor(cursor: unknown): cursor is NeedsYouCursor {
  if (!cursor || typeof cursor !== 'object') return false
  const value = cursor as Record<string, unknown>
  return typeof value.tenant === 'string'
    && (value.actor_type === 'member' || value.actor_type === 'agent')
    && typeof value.actor_id === 'string'
    && (value.project_id === null || typeof value.project_id === 'string')
    && Number.isSafeInteger(value.urgency_rank)
    && typeof value.deadline === 'string'
    && typeof value.timestamp === 'string'
    && (value.type === 'task' || value.type === 'routine_run')
    && typeof value.id === 'string'
}

async function digestToken(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function resolveCursor(
  env: Env,
  principal: RoutinePrincipal,
  options: NeedsYouOptions,
): Promise<NeedsYouCursor | null> {
  if (!options.after) return null
  if (!/^[0-9a-f-]{36}$/i.test(options.after)) throw new Error('invalid_needs_you_cursor')
  const digest = await digestToken(options.after)
  const cursor = await env.SESSIONS.get<NeedsYouCursor>(`needs-you-cursor:${digest}`, 'json')
  if (!validateCursor(cursor)
    || cursor.tenant !== env.TENANT_SLUG
    || cursor.actor_type !== principal.actor_type
    || cursor.actor_id !== principal.actor_id
    || cursor.project_id !== (options.project_id ?? null)) {
    throw new Error('invalid_needs_you_cursor')
  }
  return cursor
}

async function issueCursor(
  env: Env,
  principal: RoutinePrincipal,
  projectId: string | undefined,
  row: SourceRow,
): Promise<string> {
  const token = crypto.randomUUID()
  const digest = await digestToken(token)
  const cursor: NeedsYouCursor = {
    tenant: env.TENANT_SLUG,
    actor_type: principal.actor_type,
    actor_id: principal.actor_id,
    project_id: projectId ?? null,
    urgency_rank: row.urgency_rank,
    deadline: row.sort_deadline,
    timestamp: row.sort_timestamp,
    type: row.source_type,
    id: row.source_id,
  }
  await env.SESSIONS.put(`needs-you-cursor:${digest}`, JSON.stringify(cursor), { expirationTtl: CURSOR_TTL_SECONDS })
  return token
}

/**
 * Read-only bounded projection over authoritative Task and RoutineRun records.
 * Cursor state is held server-side; no Need You row is persisted or resolved here.
 */
export async function listNeedsYou(
  env: Env,
  principal: RoutinePrincipal,
  options: NeedsYouOptions = {},
): Promise<NeedsYouPage> {
  if (principal.tenant !== env.TENANT_SLUG) {
    return { items: [], next_cursor: null, truncated: false, truncated_sources: [] }
  }
  const limit = options.limit ?? DEFAULT_LIMIT
  if (!validLimit(limit)) throw new Error('invalid_needs_you_pagination')
  const cursor = await resolveCursor(env, principal, options)
  const sources = await sourceRows(env, principal, options, cursor)
  const rows = sources.flatMap(source => source.rows).sort((left, right) => (
    left.urgency_rank - right.urgency_rank
    || left.sort_deadline.localeCompare(right.sort_deadline)
    || right.sort_timestamp.localeCompare(left.sort_timestamp)
    || left.source_type.localeCompare(right.source_type)
    || left.source_id.localeCompare(right.source_id)
  ))
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  const truncatedSources = sources.filter(source => source.truncated).map(source => source.name)
  const hasMore = rows.length > limit || truncatedSources.length > 0
  return {
    items: items.map(row => itemFrom(row, principal)),
    next_cursor: hasMore && last ? await issueCursor(env, principal, options.project_id, last) : null,
    truncated: truncatedSources.length > 0,
    truncated_sources: truncatedSources,
  }
}
