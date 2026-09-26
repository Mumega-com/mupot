// src/hygiene/filters.ts — shared exclusion fragments and helpers for
// archived rows
// (mupot#1496 Round 2, Athena P0-1 / adversarial P1-3).
//
// Round 1 shipped tasks_archive_state and squads.status='archived' but wired
// NO live reader/writer to honor either — an archived task kept showing up in
// task_list/task_board/needs_you_list/dispatch/routines/kanban, and an
// archived squad could still be resolved, dispatched into, or repopulated
// (create_agent/squad_member_add/an invite onto it). Both gates BLOCKED PR
// #1561 on exactly this: "tasks_archive_state ACCEPTED only once readers
// honor it" / "additive squad status ACCEPTED only with reader/writer
// integration in THIS PR".
//
// Every live-state reader/writer imports ONE of these two fragments instead
// of hand-rolling its own — `tests/task-archive-readers.test.ts`'s seam test
// scans src/ for every `FROM tasks` query and asserts each one that feeds a
// live surface (not an explicit single-id history read) carries
// TASK_NOT_ARCHIVED_SQL, the same discipline
// tests/token-lifecycle-real-schema.test.ts already uses for member_tokens.

import type { Env } from '../types'

/** NOT EXISTS fragment excluding a task with a tasks_archive_state row.
 *  `tasksAlias` must match the alias the query gives the `tasks` table (bare
 *  `tasks` when unaliased). Never applied to a single-id lookup that is
 *  explicitly an archived-inclusive history read (e.g. get_task, the
 *  archive/unarchive tools themselves) — only to LISTING/DISPATCH surfaces. */
export function TASK_NOT_ARCHIVED_SQL(tasksAlias: string = 'tasks'): string {
  return `NOT EXISTS (SELECT 1 FROM tasks_archive_state WHERE tasks_archive_state.task_id = ${tasksAlias}.id)`
}

/** Boolean SQL fragment: this squad row is not archived. `squadsAlias` must
 *  match the alias the query gives the `squads` table. Squads has a plain
 *  status column (unlike tasks' side table), so this is just a column check —
 *  still centralized so every call site reads the SAME literal, and a future
 *  archived-squad signal change (e.g. adding a grace window) has one place
 *  to change. */
export function SQUAD_ACTIVE_SQL(squadsAlias: string = 'squads'): string {
  return `${squadsAlias}.status != 'archived'`
}

/** Direct existence check for a single squad — the write-time gate every
 *  producer onto a squad (create_agent, squad_member_add, an invite) calls
 *  after resolving the squad ref, since the shared `Squad` type/resolver
 *  predate the status column and widening them for one gate is out of scope
 *  here. Returns false (never refuses) when the squad row itself is gone —
 *  the caller's own resolution step already turned that into squad_not_found. */
export async function isSquadArchived(env: Env, squadId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT status FROM squads WHERE id = ?1').bind(squadId).first<{ status: string }>()
  return row?.status === 'archived'
}

/**
 * THE guard helper (mupot#1496 Round 3, Athena P0-1): archive state as an
 * ACTION BOUNDARY, not just a listing filter. Round 2 wired
 * TASK_NOT_ARCHIVED_SQL into every LIVE reader/lister, but every task-
 * MUTATING tool (task_create on an archived squad; task_update/task_verdict/
 * task_dispatch/task_dispatch_runtime_receipt/task_dispatch_lease_reset on an
 * archived task) still happily wrote through — a task's own resolver is an
 * "explicit reference by id" for a mutation exactly as much as loadTask is
 * for dispatch, so it needs the SAME explicit check task_dispatch already
 * added in Round 2, now shared instead of re-inlined per tool.
 *
 * Called at the TOP of each mutating tool's run(), immediately after the
 * task/squad resolves and before any other validation or write —
 * `tests/task-archive-readers.test.ts`'s seam test greps every task-mutating
 * tool's registration in TOOLS for a call to this pair, so a new mutating
 * tool that forgets the guard fails CI rather than shipping silently unguarded.
 */
export async function isTaskArchived(env: Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM tasks_archive_state WHERE task_id = ?1').bind(taskId).first()
  return row !== null
}
