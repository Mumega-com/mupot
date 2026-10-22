// mupot — ProjectOffice core: everything about the office that does not need the Agents SDK
// or workerd, so it is tested under the default Node pool. The Durable Object class
// (./project-office.ts) is a thin shell over this file, the same split as
// SeatEventsDO / SeatEventsHub.
//
// STATUS: Phase 0 skeleton. INERT. Gated by env.PROJECT_OFFICE (default off); nothing in the
// production request path calls into this file, and no cron consults it.
//
// What lives here:
//   - the flag and the naming rule (a ProjectOffice is keyed `<tenant>:<project id>`)
//   - verifyOfficeBinding: project → tenant re-verified from D1 (the authority) on every wake
//   - the working-set schema and rebuildWorkingSet: the office holds NO authority, so its whole
//     SQLite state must be reconstructible from D1 (the destroy-and-rebuild test)
//   - the seven function names (stubs live on the class)

import type { Env } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'

export const PROJECT_OFFICE_FLAG = '1'

/** The seven functions of the back office, in order (plan: "Seven functions"). */
export const OFFICE_FUNCTIONS = ['notice', 'prepare', 'dispatch', 'followUp', 'gate', 'remember', 'report'] as const
export type OfficeFunction = (typeof OFFICE_FUNCTIONS)[number]

export type OfficeBindingFailure =
  | 'flag_off'
  | 'bad_name'
  | 'tenant_mismatch'
  | 'project_not_found'
  | 'project_archived'
  // D1 could not be read. Fail closed: an office that cannot confirm its project serves nothing.
  | 'verify_unavailable'

/**
 * Result of a function call in Phase 0. None of the seven is implemented; a call either
 * is refused because the binding no longer verifies, or answers not_implemented.
 */
export type OfficeStubResult =
  | { ok: false; error: 'not_implemented'; fn: OfficeFunction }
  | { ok: false; error: 'unbound'; reason: OfficeBindingFailure }

export function isProjectOfficeEnabled(env: Pick<Env, 'PROJECT_OFFICE' | 'PROJECT_OFFICE_DO'>): boolean {
  return env.PROJECT_OFFICE === PROJECT_OFFICE_FLAG && env.PROJECT_OFFICE_DO !== undefined
}

/** idFromName key. Tenant-scoped so two pots can never share an office. */
export function projectOfficeName(tenant: string, projectId: string): string {
  const t = tenant.trim()
  const p = projectId.trim()
  if (!t || t.includes(':')) throw new Error('project_office_tenant_invalid')
  if (!p) throw new Error('project_office_project_required')
  return `${t}:${p}`
}

export function parseProjectOfficeName(name: string): { tenant: string; projectId: string } | null {
  const i = name.indexOf(':')
  if (i <= 0 || i === name.length - 1) return null
  return { tenant: name.slice(0, i), projectId: name.slice(i + 1) }
}

export type OfficeBinding =
  | { ok: true; tenant: string; projectId: string }
  | { ok: false; reason: OfficeBindingFailure }

interface ProjectGateRow {
  id: string
  status: string
  archived_at: string | null
}

/**
 * Re-verify, from D1, that this office's name denotes a live project of THIS pot.
 * The name is untrusted input to the DO (anyone able to mint a stub can pick any name); D1 and
 * the pot's own TENANT_SLUG are the authority. Called on every wake and before every function,
 * so a project archived or removed after the office woke stops being served within one TTL.
 */
export async function verifyOfficeBinding(
  env: Pick<Env, 'DB' | 'TENANT_SLUG' | 'PROJECT_OFFICE' | 'PROJECT_OFFICE_DO'>,
  name: string,
): Promise<OfficeBinding> {
  if (!isProjectOfficeEnabled(env)) return { ok: false, reason: 'flag_off' }
  const parsed = parseProjectOfficeName(name)
  if (!parsed) return { ok: false, reason: 'bad_name' }
  if (parsed.tenant !== env.TENANT_SLUG) return { ok: false, reason: 'tenant_mismatch' }
  const row = await env.DB
    .prepare('SELECT id, status, archived_at FROM projects WHERE id = ?')
    .bind(parsed.projectId)
    .first<ProjectGateRow>()
  if (!row) return { ok: false, reason: 'project_not_found' }
  if (row.archived_at !== null || row.status === 'archived') return { ok: false, reason: 'project_archived' }
  return { ok: true, tenant: parsed.tenant, projectId: row.id }
}

// ── working set ──────────────────────────────────────────────────────────────

/** Minimal synchronous SQL surface both the Agents SDK `sql` tag and a test double can satisfy. */
export interface OfficeSql {
  exec(query: string, ...binds: (string | number | null)[]): void
  all(query: string, ...binds: (string | number | null)[]): Record<string, unknown>[]
}

export const OFFICE_SCHEMA = [
  // Compact project view: a projection of D1, rebuilt, never authoritative.
  `CREATE TABLE IF NOT EXISTS office_project_view (
     project_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, goal TEXT NOT NULL, synced_at TEXT NOT NULL)`,
  // Live work the office is tracking. Projection of D1 tasks, rebuilt.
  `CREATE TABLE IF NOT EXISTS office_tasks (
     task_id TEXT PRIMARY KEY, status TEXT NOT NULL, assignee_agent_id TEXT, gate_owner TEXT, updated_at TEXT NOT NULL)`,
  // Dedup of delivery ids and per-connection source cursors. NOT rebuilt from D1: these are
  // re-derived from the source tool by adapter.reconcile(). Losing them costs a re-scan, and
  // handlers are idempotent, so a lost row can only cause a harmless re-delivery.
  `CREATE TABLE IF NOT EXISTS office_seen (event_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS office_cursor (connection TEXT PRIMARY KEY, cursor TEXT NOT NULL)`,
] as const

export function ensureOfficeSchema(sql: OfficeSql): void {
  for (const ddl of OFFICE_SCHEMA) sql.exec(ddl)
}

interface ProjectViewRow {
  id: string
  name: string
  status: string
  goal: string
}

interface TaskViewRow {
  id: string
  status: string
  assignee_agent_id: string | null
  gate_owner: string | null
  updated_at: string
}

export interface RebuildResult {
  tasks: number
}

/**
 * Rebuild the D1-derived part of the working set. Idempotent and replace-semantics: the office's
 * view is wiped and re-read, so a stale row can never outlive the D1 row it mirrored.
 * Requires a verified binding: callers pass the result of verifyOfficeBinding.
 */
export async function rebuildWorkingSet(
  env: Pick<Env, 'DB'>,
  sql: OfficeSql,
  binding: Extract<OfficeBinding, { ok: true }>,
  nowIso: string,
): Promise<RebuildResult> {
  const project = await env.DB
    .prepare('SELECT id, name, status, goal FROM projects WHERE id = ?')
    .bind(binding.projectId)
    .first<ProjectViewRow>()
  if (!project) throw new Error('project_office_project_vanished')
  const tasks = await env.DB
    .prepare(
      `SELECT id, status, assignee_agent_id, gate_owner, updated_at FROM tasks
        WHERE project_id = ? AND status NOT IN ('done', 'approved', 'rejected') AND ${TASK_NOT_ARCHIVED_SQL('tasks')}
        ORDER BY id`,
    )
    .bind(binding.projectId)
    .all<TaskViewRow>()

  ensureOfficeSchema(sql)
  sql.exec('DELETE FROM office_project_view')
  sql.exec('DELETE FROM office_tasks')
  sql.exec(
    'INSERT INTO office_project_view (project_id, name, status, goal, synced_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    project.name,
    project.status,
    project.goal,
    nowIso,
  )
  const rows = tasks.results ?? []
  for (const t of rows) {
    sql.exec(
      'INSERT INTO office_tasks (task_id, status, assignee_agent_id, gate_owner, updated_at) VALUES (?, ?, ?, ?, ?)',
      t.id,
      t.status,
      t.assignee_agent_id,
      t.gate_owner,
      t.updated_at,
    )
  }
  return { tasks: rows.length }
}
