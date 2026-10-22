// mupot — ProjectOffice core: everything about the office that does not need the Agents SDK
// or workerd, so it is tested under the default Node pool and imported by BOTH the main Worker
// (office-handle.ts) and the separate project-office Worker (workers/project-office/).
//
// The Agents SDK deliberately does NOT live in the main Worker: importing it raised non-idle startup
// CPU on every cold isolate for a feature that is off. See workers/project-office/README.md.
//
// STATUS: Phase 0 skeleton. INERT. Gated by env.PROJECT_OFFICE (default off); nothing in the
// production request path calls into this file, and no cron consults it.
//
// What lives here:
//   - the flag and the naming rule (a ProjectOffice is keyed `<tenant>:<project id>`)
//   - verifyOfficeBinding: project -> tenant re-verified from D1 (the authority) on every wake
//   - the working-set schema and rebuildWorkingSet: the office holds NO authority, so its whole
//     SQLite state must be reconstructible from D1 (the destroy-and-rebuild test)
//   - the seven function names (stubs live on the class)

import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { noticeOrder, type Notice } from './office-contract'
import { projectsOwningRepo } from './office-repo-owner'

/**
 * The slice of the Worker environment the office reads. Declared here (not `Env`) because the office runs in
 * its OWN Worker whose bindings are a strict subset of the main Worker's.
 */
export interface OfficeEnv {
  DB: D1Database
  TENANT_SLUG: string
  /** "1" turns the office on. Anything else, or unset, is off. */
  PROJECT_OFFICE?: string
  /** The office's Durable Object namespace. Present only where the office is bound. */
  PROJECT_OFFICE_DO?: DurableObjectNamespace
}

export const PROJECT_OFFICE_FLAG = '1'

/** The seven functions of the back office, in order (plan: "Seven functions"). */
export const OFFICE_FUNCTIONS = ['notice', 'prepare', 'dispatch', 'followUp', 'gate', 'remember', 'report'] as const
export type OfficeFunction = (typeof OFFICE_FUNCTIONS)[number]

/** What happened to a Notice the office accepted as well-formed. None of these is an error: all are idempotent. */
export type NoticeOutcome = 'applied' | 'duplicate' | 'stale' | 'tie_kept'

export type NoticeResult =
  | { ok: true; outcome: NoticeOutcome }
  // The notice was refused at the RPC boundary: wrong shape, bad field, bad hash, future-dated, or another tenant's.
  | { ok: false; error: 'invalid_notice'; problem: string }
  | Extract<OfficeStubResult, { error: 'unbound' }>

export type OfficeBindingFailure =
  | 'flag_off'
  | 'bad_name'
  | 'tenant_mismatch'
  | 'project_not_found'
  | 'project_archived'
  // The object is a sub-agent / facet of another Agent. An office is always top-level.
  | 'sub_agent'
  // D1 could not be read. Fail closed: an office that cannot confirm its project serves nothing.
  | 'verify_unavailable'

/** Refusals that cannot heal by waiting. A transient one (verify_unavailable) must not stop the clock. */
export function isPermanentBindingFailure(reason: OfficeBindingFailure): boolean {
  return reason !== 'verify_unavailable'
}

/**
 * Result of a function call in Phase 0. None of the seven is implemented; a call either
 * is refused because the binding no longer verifies, or answers not_implemented.
 */
export type OfficeStubResult =
  | { ok: false; error: 'not_implemented'; fn: OfficeFunction }
  | { ok: false; error: 'unbound'; reason: OfficeBindingFailure }

export function isProjectOfficeEnabled(env: Pick<OfficeEnv, 'PROJECT_OFFICE' | 'PROJECT_OFFICE_DO'>): boolean {
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

/** The Agents SDK names path-scoped sub-agent (facet) objects `cf-agents:v2:...`. Never an office. */
export const SDK_SUB_AGENT_NAME_PREFIX = 'cf-agents:v2:'

export function parseProjectOfficeName(name: string): { tenant: string; projectId: string } | null {
  if (name.startsWith(SDK_SUB_AGENT_NAME_PREFIX)) return null
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
 * the pot's own TENANT_SLUG are the authority. The caller passes `ctx.id.name`, the platform's name
 * for the object, never a name the SDK derived from a request header.
 * Called on every wake and before every function, so a project archived or removed after the office
 * woke stops being served within one TTL. Never throws: a D1 error is `verify_unavailable`.
 */
export async function verifyOfficeBinding(
  env: Pick<OfficeEnv, 'DB' | 'TENANT_SLUG' | 'PROJECT_OFFICE' | 'PROJECT_OFFICE_DO'>,
  name: string | undefined,
): Promise<OfficeBinding> {
  if (!isProjectOfficeEnabled(env)) return { ok: false, reason: 'flag_off' }
  const parsed = name === undefined ? null : parseProjectOfficeName(name)
  if (!parsed) return { ok: false, reason: 'bad_name' }
  if (parsed.tenant !== env.TENANT_SLUG) return { ok: false, reason: 'tenant_mismatch' }
  let row: ProjectGateRow | null
  try {
    row = await env.DB
      .prepare('SELECT id, status, archived_at FROM projects WHERE id = ?')
      .bind(parsed.projectId)
      .first<ProjectGateRow>()
  } catch {
    return { ok: false, reason: 'verify_unavailable' }
  }
  if (!row) return { ok: false, reason: 'project_not_found' }
  if (row.archived_at !== null || row.status === 'archived') return { ok: false, reason: 'project_archived' }
  return { ok: true, tenant: parsed.tenant, projectId: row.id }
}

// ── working set ──────────────────────────────────────────────────────────────

/** Minimal synchronous SQL surface both the DO's `ctx.storage.sql` and a test double can satisfy. */
export interface OfficeSql {
  exec(query: string, ...binds: (string | number | null)[]): void
  all(query: string, ...binds: (string | number | null)[]): Record<string, unknown>[]
}

export const OFFICE_SCHEMA = [
  // Compact project view: a projection of D1, rebuilt, never authoritative.
  `CREATE TABLE IF NOT EXISTS office_project_view (
     project_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, goal TEXT NOT NULL, synced_at TEXT NOT NULL)`,
  // Live work the office is tracking. Projection of D1 tasks, rebuilt. Both assignee columns are carried:
  // the database makes them mutually exclusive, so a task owned by a person must not look unassigned.
  `CREATE TABLE IF NOT EXISTS office_tasks (
     task_id TEXT PRIMARY KEY, status TEXT NOT NULL, assignee_agent_id TEXT, assignee_member_id TEXT,
     gate_owner TEXT, updated_at TEXT NOT NULL)`,
  // Dedup of delivery ids and per-connection source cursors, scoped by provider: a connection id and a
  // delivery id are unique only within one adapter. NOT rebuilt from D1: re-derived from the source tool
  // by adapter.reconcile(). Losing them costs a re-scan, and handlers are idempotent, so a lost row can
  // only cause a harmless re-delivery. office_cursor is a RECONCILE watermark ("everything up to here was read from
  // the source"): only reconcile or poll moves it (advanceCursor). A webhook never does, because a webhook for one item
  // says nothing about the other items older than it.
  `CREATE TABLE IF NOT EXISTS office_seen (
     provider TEXT NOT NULL, connection TEXT NOT NULL, event_id TEXT NOT NULL, seen_at TEXT NOT NULL,
     PRIMARY KEY (provider, connection, event_id))`,
  `CREATE TABLE IF NOT EXISTS office_cursor (
     provider TEXT NOT NULL, connection TEXT NOT NULL, cursor TEXT NOT NULL,
     PRIMARY KEY (provider, connection))`,
  // Office-local counters (alarm ticks). Not a cursor; kept out of office_cursor so it cannot collide with one.
  `CREATE TABLE IF NOT EXISTS office_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Compact view of the source items the office has been told about: one row per (provider, connection, item),
  // holding the pointer fields of the newest accepted Notice and NO content. Like office_seen it is derived from
  // the SOURCE tool, not from D1, so rebuildWorkingSet leaves it alone and adapter.reconcile() refills it.
  // conflict_version: a same-instant, different-version notice that was held back (see noticeOrder 'tie'); it
  // names a version to refetch from the source, and is never trusted as current.
  // scope: the canonical source scope the item belongs to (a repository key such as 'github:owner/repo'), with
  // `connection` it says WHERE the item came from. D1 is the authority on whether this project still owns that scope:
  // sweepRelinquishedScopes deletes the rows of a scope it no longer owns, and the read path serves only verified scopes.
  `CREATE TABLE IF NOT EXISTS office_items (
     provider TEXT NOT NULL, connection TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
     item_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
     version TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, actor TEXT NOT NULL, updated_at TEXT NOT NULL,
     hash TEXT NOT NULL, last_event_id TEXT NOT NULL, conflict_version TEXT, applied_at TEXT NOT NULL,
     PRIMARY KEY (provider, connection, item_id))`,
  // The prune in applyNotice filters office_seen by age on every notice; without this it scans the whole table.
  `CREATE INDEX IF NOT EXISTS idx_office_seen_seen_at ON office_seen (seen_at)`,
] as const

/** Needs office_items.scope, which a v1 table only gets from migrateOfficeSchema: so it runs after it. The sweep lists distinct scopes and deletes by scope. */
const OFFICE_SCHEMA_AFTER_MIGRATION = [
  `CREATE INDEX IF NOT EXISTS idx_office_items_scope ON office_items (scope)`,
] as const

/**
 * Version of the office's own SQLite layout, kept in office_meta so a later change can detect what it is looking at
 * and migrate instead of guessing. Bump it WITH any change to OFFICE_SCHEMA that CREATE IF NOT EXISTS cannot express,
 * and add the step to `migrateOfficeSchema`.
 *
 *   1  office_items without `scope`
 *   2  office_items.scope (repository scope, #2137 item 2)
 */
export const OFFICE_SCHEMA_VERSION = '2'

/** Thrown when the stored layout is NEWER than this code knows: serving it would mean guessing. Fail closed. */
export const OFFICE_SCHEMA_TOO_NEW = 'office_schema_too_new'

function columnNames(sql: OfficeSql, table: string): string[] {
  return sql.all(`PRAGMA table_info(${table})`).map((r) => String(r.name))
}

/**
 * Bring an office created by an older layout up to date, in place. Decided from the actual columns as well as the
 * stored version, so a layout whose version row is missing is still migrated. Idempotent.
 *
 * v1 -> v2: office_items gains `scope`. A v1 row has no recorded scope; GitHub item links name their repository
 * (https://github.com/<owner>/<repo>/<pull|issues>/N), so the scope is read back from the link and the sweep then
 * re-verifies it against D1 like any other. A row whose link yields no scope is deleted: unverifiable rows are not
 * served, and the source (adapter.reconcile) refills the item. office_items is derived from the source tool, not from
 * D1, so deleting a row loses nothing that cannot be re-read.
 */
function migrateOfficeSchema(sql: OfficeSql): void {
  const stored = sql.all(`SELECT value FROM office_meta WHERE key = 'schema_version'`)[0]?.value
  if (typeof stored === 'string' && Number(stored) > Number(OFFICE_SCHEMA_VERSION)) throw new Error(OFFICE_SCHEMA_TOO_NEW)
  if (!columnNames(sql, 'office_items').includes('scope')) {
    sql.exec(`ALTER TABLE office_items ADD COLUMN scope TEXT NOT NULL DEFAULT ''`)
  }
  const unscoped = sql.all(`SELECT provider, connection, item_id, url FROM office_items WHERE scope = ''`)
  for (const row of unscoped) {
    const scope = row.provider === 'github' ? githubScopeFromItemUrl(String(row.url)) : null
    if (scope !== null) {
      sql.exec(
        'UPDATE office_items SET scope = ? WHERE provider = ? AND connection = ? AND item_id = ?',
        scope, String(row.provider), String(row.connection), String(row.item_id),
      )
    } else {
      sql.exec(
        'DELETE FROM office_items WHERE provider = ? AND connection = ? AND item_id = ?',
        String(row.provider), String(row.connection), String(row.item_id),
      )
    }
  }
  sql.exec(
    `INSERT INTO office_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    OFFICE_SCHEMA_VERSION,
  )
}

/** 'github:owner/repo' for https://github.com/owner/repo/(pull|issues)/N..., else null. Same fold as repoKeyFromUrl. */
function githubScopeFromItemUrl(url: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(?:pull|issues)\/\d+/.exec(url)
  return m ? `github:${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` : null
}

export function ensureOfficeSchema(sql: OfficeSql): void {
  for (const ddl of OFFICE_SCHEMA) sql.exec(ddl)
  migrateOfficeSchema(sql)
  for (const ddl of OFFICE_SCHEMA_AFTER_MIGRATION) sql.exec(ddl)
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
  assignee_member_id: string | null
  gate_owner: string | null
  updated_at: string
}

export interface RebuildResult {
  tasks: number
}

/**
 * Statuses that leave the working set. `approved` is NOT here: it is not terminal, the task becomes `done`
 * only after its post-verdict work succeeds, and an office rebuilt in that window must still find it.
 */
export const WORKING_SET_EXCLUDED_STATUSES = ['done', 'rejected'] as const

/**
 * Rebuild the D1-derived part of the working set. Idempotent and replace-semantics: the office's
 * view is wiped and re-read, so a stale row can never outlive the D1 row it mirrored.
 * Requires a verified binding: callers pass the result of verifyOfficeBinding.
 */
export async function rebuildWorkingSet(
  env: Pick<OfficeEnv, 'DB'>,
  sql: OfficeSql,
  binding: Extract<OfficeBinding, { ok: true }>,
  nowIso: string,
): Promise<RebuildResult> {
  const project = await env.DB
    .prepare('SELECT id, name, status, goal FROM projects WHERE id = ?')
    .bind(binding.projectId)
    .first<ProjectViewRow>()
  if (!project) throw new Error('project_office_project_vanished')
  const excluded = WORKING_SET_EXCLUDED_STATUSES.map((s) => `'${s}'`).join(', ')
  const tasks = await env.DB
    .prepare(
      `SELECT id, status, assignee_agent_id, assignee_member_id, gate_owner, updated_at FROM tasks
        WHERE project_id = ? AND status NOT IN (${excluded}) AND ${TASK_NOT_ARCHIVED_SQL('tasks')}
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
      `INSERT INTO office_tasks (task_id, status, assignee_agent_id, assignee_member_id, gate_owner, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      t.id,
      t.status,
      t.assignee_agent_id,
      t.assignee_member_id,
      t.gate_owner,
      t.updated_at,
    )
  }
  return { tasks: rows.length }
}

// ── notice intake (Phase 1, slice 1) ─────────────────────────────────────────

/** Delivery ids older than this are forgotten. A redelivery that late still hits the version check, so it stays a no-op. */
export const NOTICE_SEEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Most items one office holds. A repository a stranger can open issues on must not be able to fill the office. */
export const OFFICE_ITEM_CAP = 5000

interface HeldItemRow {
  version: string
  updated_at: string
  hash: string
}

function bump(sql: OfficeSql, key: string): void {
  sql.exec(
    `INSERT INTO office_meta (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    key,
  )
}

/**
 * Record one VALIDATED Notice (checkNotice has already run; the tenant matches) in the working set.
 * It does NOT move office_cursor: see advanceCursor. Delivery through the webhook is at-most-once until reconcile
 * lands (a notice that never arrives is not repaired by anything yet), so nothing here may claim completeness.
 * Synchronous on purpose: a Durable Object's SQLite calls with no await between them are atomic, so a delivery is
 * either recorded in full or not at all.
 *
 *   duplicate   the delivery id was seen, or the same item at the same instant, version and content arrived again
 *   stale       an older notice never overwrites a newer one
 *   tie_kept    same instant, different version or different content: the held row stays, the competing version is
 *               noted for refetch
 *   applied     first sight of the item, or strictly newer than what is held
 *
 * Never reads D1, never assigns, dispatches or wakes anything: the office only remembers what it was told.
 */
export function applyNotice(sql: OfficeSql, notice: Notice, nowMs: number): NoticeOutcome {
  const seen = sql.all(
    'SELECT 1 AS hit FROM office_seen WHERE provider = ? AND connection = ? AND event_id = ?',
    notice.provider,
    notice.connection,
    notice.event_id,
  )
  if (seen.length > 0) {
    bump(sql, 'notice_duplicate')
    return 'duplicate'
  }

  const nowIso = new Date(nowMs).toISOString()
  const held = sql.all(
    'SELECT version, updated_at, hash FROM office_items WHERE provider = ? AND connection = ? AND item_id = ?',
    notice.provider,
    notice.connection,
    notice.item_id,
  )[0] as unknown as HeldItemRow | undefined

  let outcome: NoticeOutcome
  if (!held) {
    const n = Number(sql.all('SELECT count(*) AS n FROM office_items')[0]?.n ?? 0)
    if (n >= OFFICE_ITEM_CAP) {
      sql.exec(
        `DELETE FROM office_items WHERE rowid IN (SELECT rowid FROM office_items ORDER BY updated_at ASC LIMIT ?)`,
        n - OFFICE_ITEM_CAP + 1,
      )
    }
    writeItem(sql, notice, nowIso, 'insert')
    outcome = 'applied'
  } else {
    const order = noticeOrder(held, notice)  // held carries its hash: same instant + version but other content is a tie
    if (order === 'newer') {
      writeItem(sql, notice, nowIso, 'replace')
      outcome = 'applied'
    } else if (order === 'tie') {
      sql.exec(
        'UPDATE office_items SET conflict_version = ? WHERE provider = ? AND connection = ? AND item_id = ?',
        notice.version,
        notice.provider,
        notice.connection,
        notice.item_id,
      )
      outcome = 'tie_kept'
    } else if (order === 'same') {
      outcome = 'duplicate'
    } else {
      outcome = 'stale' // 'older', or 'invalid' (an unparseable held row): fail closed, never overwrite
    }
  }

  sql.exec(
    'INSERT INTO office_seen (provider, connection, event_id, seen_at) VALUES (?, ?, ?, ?)',
    notice.provider,
    notice.connection,
    notice.event_id,
    nowIso,
  )
  sql.exec('DELETE FROM office_seen WHERE seen_at < ?', new Date(nowMs - NOTICE_SEEN_RETENTION_MS).toISOString())
  bump(sql, `notice_${outcome}`)
  return outcome
}

/**
 * Move a connection's reconcile watermark forward. For adapter.reconcile() / a poller ONLY: it asserts "every change up
 * to `cursor` was read from the source", which one webhook can never assert (item A at t2 arriving says nothing about
 * item B at t1 that has not arrived yet). Forward-only: a cursor older than the held one is ignored, so a late or
 * replayed reconcile page cannot rewind the watermark. Returns whether it moved.
 */
export function advanceCursor(sql: OfficeSql, provider: string, connection: string, cursor: string): boolean {
  const before = sql.all('SELECT cursor FROM office_cursor WHERE provider = ? AND connection = ?', provider, connection)[0]?.cursor
  sql.exec(
    `INSERT INTO office_cursor (provider, connection, cursor) VALUES (?, ?, ?)
     ON CONFLICT(provider, connection) DO UPDATE SET cursor = excluded.cursor WHERE excluded.cursor > cursor`,
    provider,
    connection,
    cursor,
  )
  const after = sql.all('SELECT cursor FROM office_cursor WHERE provider = ? AND connection = ?', provider, connection)[0]?.cursor
  return after !== before
}

function writeItem(sql: OfficeSql, n: Notice, nowIso: string, mode: 'insert' | 'replace'): void {
  sql.exec(
    `${mode === 'insert' ? 'INSERT' : 'INSERT OR REPLACE'} INTO office_items
       (provider, connection, scope, item_id, kind, state, version, url, title, actor, updated_at, hash, last_event_id, conflict_version, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    n.provider,
    n.connection,
    n.scope,
    n.item_id,
    n.kind,
    n.state,
    n.version,
    n.url,
    n.title,
    n.actor,
    n.updated_at,
    n.hash,
    n.event_id,
    nowIso,
  )
}

// ── repository scope: D1 decides what the office may keep and serve ──────────

/** Scopes that name a repository, i.e. the ones D1 can vouch for (projects.repo_url / project_repos). Others are stored, not verified. */
export function isRepoScope(scope: string): boolean {
  return scope.startsWith('github:') || scope.startsWith('url:')
}

export type ScopeCheck =
  | { ok: true }
  | { ok: false; reason: 'scope_not_owned' | 'scope_unverifiable' }

/**
 * Does D1 say this project owns the repository a Notice is scoped to? Asked before the notice is applied, so an office
 * never takes in an item for a repository it does not own, whatever the caller believed. A scope that is not a
 * repository (Linear team) passes: nothing in D1 can contradict it yet. Ambiguous ownership (another project claims the
 * repository too) still counts as owned here; intake is what refuses to route an ambiguous repository.
 */
export async function verifyNoticeScope(
  env: Pick<OfficeEnv, 'DB'>,
  projectId: string,
  notice: Pick<Notice, 'scope'>,
): Promise<ScopeCheck> {
  if (!isRepoScope(notice.scope)) return { ok: true }
  const found = await projectsOwningRepo(env.DB, notice.scope)
  if (!found.ok) return { ok: false, reason: 'scope_unverifiable' }
  return found.owners.includes(projectId) ? { ok: true } : { ok: false, reason: 'scope_not_owned' }
}

export interface ScopeSweepResult {
  /** Items deleted because D1 says this project no longer owns their repository. */
  purged: number
  /** Repository scopes D1 could not be asked about; their items must not be served until it can. */
  unverifiable: string[]
}

/**
 * Drop every item whose repository this project no longer owns, per D1 (the authority), and report the scopes D1 could
 * not answer for. Called on every wake and before every read, so a project that gave a repository up stops serving its
 * items within one call, and the office rebuilds nothing from its own memory: whatever D1 stops vouching for goes.
 * Only rows applied before the check began are deleted: an item that arrived while D1 was being asked was verified
 * on its own (verifyNoticeScope) and is not this sweep's to remove.
 */
export async function sweepRelinquishedScopes(
  env: Pick<OfficeEnv, 'DB'>,
  sql: OfficeSql,
  projectId: string,
  nowMs: number,
): Promise<ScopeSweepResult> {
  const startIso = new Date(nowMs).toISOString()
  const scopes = sql
    .all(`SELECT DISTINCT scope FROM office_items WHERE scope != ''`)
    .map((r) => String(r.scope))
    .filter(isRepoScope)
  let purged = 0
  const unverifiable: string[] = []
  for (const scope of scopes) {
    const found = await projectsOwningRepo(env.DB, scope)
    if (!found.ok) {
      unverifiable.push(scope)
      continue
    }
    if (found.owners.includes(projectId)) continue
    const n = Number(sql.all('SELECT count(*) AS n FROM office_items WHERE scope = ? AND applied_at <= ?', scope, startIso)[0]?.n ?? 0)
    sql.exec('DELETE FROM office_items WHERE scope = ? AND applied_at <= ?', scope, startIso)
    purged += n
  }
  if (purged > 0) {
    sql.exec(
      `INSERT INTO office_meta (key, value) VALUES ('scope_purged', ?)
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`,
      String(purged),
      purged,
    )
  }
  return { purged, unverifiable }
}
