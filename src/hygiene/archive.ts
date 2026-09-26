// src/hygiene/archive.ts — receipted archive/unarchive substrate (mupot#1496).
//
// One core pair, archiveRow/unarchiveRow, covers the five tables the data-
// hygiene audit (mupot#1496, PR #1556's classifier) found accumulating
// build-time debris: members, agents, squads, projects, tasks. "Mark and
// archive, never delete" (the issue's own words): every call writes a
// conditional UPDATE (or, for tasks, an INSERT into a side table — see
// migrations/0173_archive_columns.sql's header for why tasks is a side table
// and why members.status is untouched rather than widened) PLUS one
// immutable receipt row in `archive_receipts`.
//
// IDEMPOTENCY IS DECIDED BY THE GUARDED WRITE'S OWN ROW COUNT, not by a
// separate pre-read. For the four direct-column tables (members/agents/
// squads/projects) the state-flip UPDATE carries `WHERE <not already
// archived>` and runs FIRST, on its own; the receipt is written only if that
// UPDATE actually changed a row. This is deliberately NOT one D1 batch for
// these two statements — batching them would run the receipt INSERT
// unconditionally regardless of whether the UPDATE matched anything, which
// would make the WHERE guard cosmetic (a second archive_row call would still
// mint a receipt even though nothing changed) and untestable by mutation. The
// same "receipt is a second, best-effort step" split already exists elsewhere
// in this codebase (src/members/service.ts's provisionHomeForMember: "a
// failed receipt write was not just a bare catch{}" is the same tradeoff,
// documented there for the identical reason). `tasks` doesn't need this
// split: its guard is tasks_archive_state's own PRIMARY KEY (task_id) — a
// second archiveRow call would throw a constraint error if the pre-check
// SELECT were removed, which is exactly as mutation-provable.
//
// Refusals are dependent-safety checks, not authorization (the MCP tool
// wrapper in src/mcp/archive.ts owns the org-admin gate) — this module never
// reads `auth`.

import type { Env } from '../types'
import { assertWritten, rowsWritten } from '../lib/receipt'
import { revokeAllWebSessions } from '../auth/web-sessions'

export const ARCHIVABLE_TABLES = ['members', 'agents', 'squads', 'projects', 'tasks'] as const
export type ArchivableTable = (typeof ARCHIVABLE_TABLES)[number]

export function isArchivableTable(value: unknown): value is ArchivableTable {
  return typeof value === 'string' && (ARCHIVABLE_TABLES as readonly string[]).includes(value)
}

export interface ArchiveInput {
  table: ArchivableTable
  id: string
  reason: string
  actorMemberId: string
  /** members/agents only: also revoke live tokens (and, for members, live web
   *  sessions) as part of this call instead of refusing. Never implied. */
  revoke?: boolean
}

export interface UnarchiveInput {
  table: ArchivableTable
  id: string
  reason: string
  actorMemberId: string
}

export type ArchiveOutcome =
  | { ok: true; status: 'archived'; receiptId: string; revoked?: { tokens: number; sessions: number } }
  | { ok: true; status: 'already_archived' }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'invalid_reason' }
  | { ok: false; error: 'live_credentials'; tokens: number; sessions: number }
  | { ok: false; error: 'active_dependents'; counts: Record<string, number> }
  | { ok: false; error: 'live_execution_claim' }
  | { ok: false; error: 'in_air_flight' }

export type UnarchiveOutcome =
  | { ok: true; status: 'unarchived'; receiptId: string }
  | { ok: true; status: 'not_archived' }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'invalid_reason' }

function validReason(reason: string): boolean {
  const trimmed = reason.trim()
  return trimmed.length > 0 && trimmed.length <= 2000
}

function nowIso(): string {
  return new Date().toISOString()
}

/** archiveRow — the single entry point for marking any of the five tables archived. */
export async function archiveRow(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  if (!validReason(input.reason)) return { ok: false, error: 'invalid_reason' }

  switch (input.table) {
    case 'members':
      return archiveMember(env, input)
    case 'agents':
      return archiveAgent(env, input)
    case 'squads':
      return archiveSquad(env, input)
    case 'projects':
      return archiveProject(env, input)
    case 'tasks':
      return archiveTask(env, input)
  }
}

export async function unarchiveRow(env: Env, input: UnarchiveInput): Promise<UnarchiveOutcome> {
  if (!validReason(input.reason)) return { ok: false, error: 'invalid_reason' }

  switch (input.table) {
    case 'members':
      return unarchiveSimple(env, 'members', input, { statusColumn: null })
    case 'agents':
      return unarchiveSimple(env, 'agents', input, { statusColumn: null })
    case 'squads':
      return unarchiveSimple(env, 'squads', input, { statusColumn: 'status', restoreStatus: 'active' })
    case 'projects':
      return unarchiveProject(env, input)
    case 'tasks':
      return unarchiveTask(env, input)
  }
}

async function insertReceipt(
  env: Env,
  table: ArchivableTable,
  id: string,
  action: 'archive' | 'unarchive',
  reason: string,
  actorMemberId: string,
  priorStatus: string | null,
): Promise<string> {
  const receiptId = crypto.randomUUID()
  const result = await env.DB.prepare(
    `INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(receiptId, env.TENANT_SLUG, table, id, action, reason, actorMemberId, priorStatus, nowIso())
    .run()
  assertWritten(result, `${action}_row.receipt`, 1)
  return receiptId
}

// ── members ──────────────────────────────────────────────────────────────────

async function archiveMember(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  const row = await env.DB.prepare('SELECT id FROM members WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string }>()
  if (!row) return { ok: false, error: 'not_found' }

  const [{ n: liveTokens }, { n: liveSessions }] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?1 AND revoked_at IS NULL`,
    ).bind(input.id).first<{ n: number }>() as Promise<{ n: number }>,
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM web_sessions WHERE member_id = ?1 AND revoked_at IS NULL`,
    ).bind(input.id).first<{ n: number }>() as Promise<{ n: number }>,
  ])

  if ((liveTokens > 0 || liveSessions > 0) && !input.revoke) {
    return { ok: false, error: 'live_credentials', tokens: liveTokens, sessions: liveSessions }
  }

  let revokedSessions = 0
  if (input.revoke && liveSessions > 0) {
    const { revokedCount } = await revokeAllWebSessions(env, env.TENANT_SLUG, input.id, 'archived')
    revokedSessions = revokedCount
  }

  const now = nowIso()
  const updateStmts = [
    env.DB.prepare(
      `UPDATE members SET archived_at = ?1, archived_reason = ?2, archived_by_member_id = ?3
        WHERE id = ?4 AND archived_at IS NULL`,
    ).bind(now, input.reason, input.actorMemberId, input.id),
    ...(input.revoke && liveTokens > 0
      ? [
          env.DB.prepare(
            `UPDATE member_tokens SET revoked_at = ?1 WHERE tenant = ?2 AND member_id = ?3 AND revoked_at IS NULL`,
          ).bind(now, env.TENANT_SLUG, input.id),
        ]
      : []),
  ]
  const results = await env.DB.batch(updateStmts)
  if (rowsWritten(results[0]) === 0) return { ok: true, status: 'already_archived' }

  const revokedTokens = input.revoke && liveTokens > 0 ? rowsWritten(results[1]) : 0
  const receiptId = await insertReceipt(env, 'members', input.id, 'archive', input.reason, input.actorMemberId, null)

  return {
    ok: true,
    status: 'archived',
    receiptId,
    revoked: input.revoke ? { tokens: revokedTokens, sessions: revokedSessions } : undefined,
  }
}

// ── agents ───────────────────────────────────────────────────────────────────

async function archiveAgent(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  const row = await env.DB.prepare('SELECT id FROM agents WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string }>()
  if (!row) return { ok: false, error: 'not_found' }

  const liveTokensRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id = ?1 AND revoked_at IS NULL`,
  ).bind(input.id).first<{ n: number }>()
  const liveTokens = liveTokensRow?.n ?? 0

  if (liveTokens > 0 && !input.revoke) {
    return { ok: false, error: 'live_credentials', tokens: liveTokens, sessions: 0 }
  }

  const now = nowIso()
  const updateStmts = [
    env.DB.prepare(
      `UPDATE agents SET archived_at = ?1, archived_reason = ?2, archived_by_member_id = ?3
        WHERE id = ?4 AND archived_at IS NULL`,
    ).bind(now, input.reason, input.actorMemberId, input.id),
    ...(input.revoke && liveTokens > 0
      ? [
          env.DB.prepare(
            `UPDATE member_tokens SET revoked_at = ?1 WHERE tenant = ?2 AND agent_id = ?3 AND revoked_at IS NULL`,
          ).bind(now, env.TENANT_SLUG, input.id),
        ]
      : []),
  ]
  const results = await env.DB.batch(updateStmts)
  if (rowsWritten(results[0]) === 0) return { ok: true, status: 'already_archived' }

  const revokedTokens = input.revoke && liveTokens > 0 ? rowsWritten(results[1]) : 0
  const receiptId = await insertReceipt(env, 'agents', input.id, 'archive', input.reason, input.actorMemberId, null)

  return {
    ok: true,
    status: 'archived',
    receiptId,
    revoked: input.revoke ? { tokens: revokedTokens, sessions: 0 } : undefined,
  }
}

// ── squads ───────────────────────────────────────────────────────────────────

async function archiveSquad(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  const row = await env.DB.prepare('SELECT id FROM squads WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string }>()
  if (!row) return { ok: false, error: 'not_found' }

  const [{ n: activeAgents }, { n: activeMembers }, { n: activeTasks }] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM agents WHERE squad_id = ?1 AND status = 'active'`)
      .bind(input.id).first<{ n: number }>() as Promise<{ n: number }>,
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM capabilities c
        JOIN members m ON m.id = c.member_id
        WHERE c.scope_type = 'squad' AND c.scope_id = ?1 AND m.archived_at IS NULL`,
    ).bind(input.id).first<{ n: number }>() as Promise<{ n: number }>,
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE squad_id = ?1 AND status IN ('open','in_progress','review')`,
    ).bind(input.id).first<{ n: number }>() as Promise<{ n: number }>,
  ])

  if (activeAgents > 0 || activeMembers > 0 || activeTasks > 0) {
    return {
      ok: false,
      error: 'active_dependents',
      counts: { agents: activeAgents, members: activeMembers, tasks: activeTasks },
    }
  }

  const now = nowIso()
  const result = await env.DB.prepare(
    `UPDATE squads SET status = 'archived', archived_at = ?1, archived_reason = ?2, archived_by_member_id = ?3
      WHERE id = ?4 AND status != 'archived'`,
  ).bind(now, input.reason, input.actorMemberId, input.id).run()
  if (rowsWritten(result) === 0) return { ok: true, status: 'already_archived' }

  const receiptId = await insertReceipt(env, 'squads', input.id, 'archive', input.reason, input.actorMemberId, 'active')
  return { ok: true, status: 'archived', receiptId }
}

// ── projects ─────────────────────────────────────────────────────────────────

async function archiveProject(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  const row = await env.DB.prepare('SELECT id, status FROM projects WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string; status: string }>()
  if (!row) return { ok: false, error: 'not_found' }

  const activeTasksRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?1 AND status IN ('open','in_progress','review')`,
  ).bind(input.id).first<{ n: number }>()
  const activeTasks = activeTasksRow?.n ?? 0
  if (activeTasks > 0) {
    return { ok: false, error: 'active_dependents', counts: { tasks: activeTasks } }
  }

  const now = nowIso()
  // prior status must be captured from a row that is NOT already archived —
  // guard the capture with the same WHERE clause as the write, in one
  // statement, so a concurrent double-archive can't record 'archived' as its
  // own prior_status.
  const priorStatus = row.status === 'archived' ? null : row.status
  const result = await env.DB.prepare(
    `UPDATE projects SET status = 'archived', archived_at = ?1, archived_reason = ?2,
            archived_by_member_id = ?3, archived_prior_status = ?4
      WHERE id = ?5 AND status != 'archived'`,
  ).bind(now, input.reason, input.actorMemberId, priorStatus, input.id).run()
  if (rowsWritten(result) === 0) return { ok: true, status: 'already_archived' }

  const receiptId = await insertReceipt(env, 'projects', input.id, 'archive', input.reason, input.actorMemberId, priorStatus)
  return { ok: true, status: 'archived', receiptId }
}

// ── tasks (side table — tasks.status is NEVER written) ──────────────────────

async function archiveTask(env: Env, input: ArchiveInput): Promise<ArchiveOutcome> {
  const row = await env.DB.prepare('SELECT id, status, execution_claim_expires_at FROM tasks WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string; status: string; execution_claim_expires_at: number | null }>()
  if (!row) return { ok: false, error: 'not_found' }

  const existing = await env.DB.prepare('SELECT task_id FROM tasks_archive_state WHERE task_id = ?1')
    .bind(input.id)
    .first<{ task_id: string }>()
  if (existing) return { ok: true, status: 'already_archived' }

  if (
    row.status === 'in_progress' &&
    row.execution_claim_expires_at !== null &&
    row.execution_claim_expires_at > Date.now()
  ) {
    return { ok: false, error: 'live_execution_claim' }
  }

  const inAirRow = await env.DB.prepare(
    `SELECT 1 FROM flights f
      WHERE f.status IN ('running','waiting')
        AND (
          EXISTS (SELECT 1 FROM flight_lanes fl WHERE fl.flight_id = f.id AND fl.task_id = ?1)
          OR EXISTS (SELECT 1 FROM flight_task_assignments fta WHERE fta.flight_id = f.id AND fta.task_id = ?1)
          OR (
            json_valid(f.meta)
            AND EXISTS (SELECT 1 FROM json_each(f.meta, '$.task_ids') WHERE value = ?1)
          )
        )
      LIMIT 1`,
  ).bind(input.id).first()
  if (inAirRow) return { ok: false, error: 'in_air_flight' }

  const now = nowIso()
  const result = await env.DB.prepare(
    `INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?2)`,
  ).bind(input.id, now, input.reason, input.actorMemberId, row.status).run()
  assertWritten(result, 'archive_row.tasks_archive_state', 1)

  const receiptId = await insertReceipt(env, 'tasks', input.id, 'archive', input.reason, input.actorMemberId, row.status)
  return { ok: true, status: 'archived', receiptId }
}

// ── unarchive: members / agents / squads ────────────────────────────────────

async function unarchiveSimple(
  env: Env,
  table: 'members' | 'agents' | 'squads',
  input: UnarchiveInput,
  opts: { statusColumn: 'status' | null; restoreStatus?: string },
): Promise<UnarchiveOutcome> {
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?1`)
    .bind(input.id)
    .first<{ id: string }>()
  if (!row) return { ok: false, error: 'not_found' }

  const setClause = opts.statusColumn
    ? `status = ?1, archived_at = NULL, archived_reason = NULL, archived_by_member_id = NULL`
    : `archived_at = NULL, archived_reason = NULL, archived_by_member_id = NULL`
  const bindArgs = opts.statusColumn ? [opts.restoreStatus, input.id] : [input.id]
  const whereClause = opts.statusColumn ? `id = ?2 AND status = 'archived'` : `id = ?1 AND archived_at IS NOT NULL`

  const result = await env.DB.prepare(`UPDATE ${table} SET ${setClause} WHERE ${whereClause}`)
    .bind(...bindArgs)
    .run()
  if (rowsWritten(result) === 0) return { ok: true, status: 'not_archived' }

  const receiptId = await insertReceipt(
    env,
    table,
    input.id,
    'unarchive',
    input.reason,
    input.actorMemberId,
    opts.statusColumn ? 'archived' : null,
  )
  return { ok: true, status: 'unarchived', receiptId }
}

async function unarchiveProject(env: Env, input: UnarchiveInput): Promise<UnarchiveOutcome> {
  const row = await env.DB.prepare('SELECT id, status, archived_prior_status FROM projects WHERE id = ?1')
    .bind(input.id)
    .first<{ id: string; status: string; archived_prior_status: string | null }>()
  if (!row) return { ok: false, error: 'not_found' }
  if (row.status !== 'archived') return { ok: true, status: 'not_archived' }

  const restoreStatus = row.archived_prior_status ?? 'active'
  const result = await env.DB.prepare(
    `UPDATE projects SET status = ?1, archived_at = NULL, archived_reason = NULL,
            archived_by_member_id = NULL, archived_prior_status = NULL
      WHERE id = ?2 AND status = 'archived'`,
  ).bind(restoreStatus, input.id).run()
  if (rowsWritten(result) === 0) return { ok: true, status: 'not_archived' }

  const receiptId = await insertReceipt(env, 'projects', input.id, 'unarchive', input.reason, input.actorMemberId, 'archived')
  return { ok: true, status: 'unarchived', receiptId }
}

async function unarchiveTask(env: Env, input: UnarchiveInput): Promise<UnarchiveOutcome> {
  const existing = await env.DB.prepare(
    'SELECT task_id, prior_status FROM tasks_archive_state WHERE task_id = ?1',
  ).bind(input.id).first<{ task_id: string; prior_status: string }>()
  if (!existing) {
    const taskRow = await env.DB.prepare('SELECT id FROM tasks WHERE id = ?1').bind(input.id).first<{ id: string }>()
    if (!taskRow) return { ok: false, error: 'not_found' }
    return { ok: true, status: 'not_archived' }
  }

  const result = await env.DB.prepare('DELETE FROM tasks_archive_state WHERE task_id = ?1').bind(input.id).run()
  if (rowsWritten(result) === 0) return { ok: true, status: 'not_archived' }

  // tasks.status was never written by archiveTask, so unarchive is purely
  // removing the side-table row + receipting the event — no restore write
  // needed on tasks itself (see migrations/0173's header).
  const receiptId = await insertReceipt(env, 'tasks', input.id, 'unarchive', input.reason, input.actorMemberId, existing.prior_status)
  return { ok: true, status: 'unarchived', receiptId }
}
