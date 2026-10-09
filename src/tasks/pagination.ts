// src/tasks/pagination.ts — opaque keyset cursor pagination for the task list readers
// (MCP task_list and GET /api/tasks; mupot#1784).
//
// DEFECT CLASS this module exists to avoid: a truncated read presented as complete, and a
// pager that skips or duplicates rows on ties. So:
//   - every ORDER BY ends in `id ASC` (a strict total order — created_at collides at
//     one-second granularity, `datetime('now')` is TEXT seconds);
//   - the keyset predicate expands the SAME key tuple the ORDER BY uses, built from the
//     SAME SQL expressions (priorityOrderSql / actionableStatusOrderSql), with the cursor
//     row's values BOUND (never interpolated);
//   - the fetch asks for limit+1 rows, so `next_cursor` is non-null exactly when a further
//     row exists. A page that ends exactly on the last row reports next_cursor = null.
//
// The cursor carries POSITION only. It confers no authority: the caller's visibility
// predicate (`baseWhere`, composed by the caller from the shared chokepoint in
// ./visibility) is applied to every page, so a forged cursor can never reveal a row.
//
// Honest limit: the sort key includes MUTABLE columns (status band, priority). A row whose
// status/priority changes between two page fetches can be skipped or seen twice (the
// standard keyset caveat). created_at + id never change, so the tiebreak itself is stable.

import type { Env, Task } from '../types'
import {
  ACTIONABLE_STATUSES,
  TASK_SELECT_COLUMNS,
  actionableStatusInSql,
  actionableStatusOrderSql,
  excludeFromRanking,
  priorityOrderSql,
  terminalStatusInSql,
} from './ranking'

/** k: 's' = explicit status filter, 'a' = actionable phase, 't' = terminal phase. */
export interface TaskCursor {
  readonly v: 1
  readonly k: 's' | 'a' | 't'
  /** Squad tag ('*' = the caller's whole visible scope). A cursor replayed on another squad is refused. */
  readonly sq: string
  /** Filter fingerprint (status|project|assignee). A cursor replayed under other filters is refused. */
  readonly f: string
  /** The last returned row's sort-key columns. */
  readonly s: string
  readonly p: string | null
  readonly c: string
  readonly i: string
}

export interface TaskPageContext {
  /** Squad tag baked into / checked against the cursor. */
  readonly squadTag: string
  /** Filter fingerprint baked into / checked against the cursor. */
  readonly filterTag: string
  /** Explicit status filter, if any. */
  readonly status?: string
}

export function filterFingerprint(parts: { status?: string | null; projectId?: string | null; assignee?: string | null }): string {
  return [parts.status ?? '', parts.projectId ?? '', parts.assignee ?? ''].join('|')
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return null
  }
}

export function encodeTaskCursor(cursor: TaskCursor): string {
  return toBase64Url(JSON.stringify(cursor))
}

/** Parse + validate. Returns null for anything malformed; the caller maps null to 400 invalid_args. */
export function decodeTaskCursor(raw: unknown): TaskCursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) return null
  const json = fromBase64Url(raw)
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown> // narrowed from unknown above; every field is re-checked below
  if (o.v !== 1) return null
  if (o.k !== 's' && o.k !== 'a' && o.k !== 't') return null
  if (typeof o.sq !== 'string' || typeof o.f !== 'string') return null
  if (typeof o.s !== 'string' || o.s.length === 0) return null
  if (o.p !== null && typeof o.p !== 'string') return null
  if (typeof o.c !== 'string' || o.c.length === 0) return null
  if (typeof o.i !== 'string' || o.i.length === 0) return null
  // An actionable-phase cursor must name an actionable status, else the band CASE is NULL,
  // every comparison is NULL, and the page would come back empty ("complete") by accident.
  if (o.k === 'a' && !(ACTIONABLE_STATUSES as readonly string[]).includes(o.s)) return null
  if (o.k === 't' && !excludeFromRanking(o.s as Task['status'])) return null // o.s is a string; excludeFromRanking only does a key lookup
  return { v: 1, k: o.k, sq: o.sq, f: o.f, s: o.s, p: o.p, c: o.c, i: o.i }
}

/** Does this (decoded) cursor belong to the request it is being replayed on? */
export function cursorMatchesRequest(cursor: TaskCursor, ctx: TaskPageContext): boolean {
  if (cursor.sq !== ctx.squadTag || cursor.f !== ctx.filterTag) return false
  return ctx.status !== undefined ? cursor.k === 's' : cursor.k !== 's'
}

export interface TaskPage {
  /** At most `limit` rows, in the SQL sort order. */
  readonly rows: Task[]
  /** Opaque; null when this page is the last. */
  readonly nextCursor: string | null
}

interface Query {
  where: string
  binds: unknown[]
}

// Keyset predicates. `n` = index of the first cursor placeholder; the cursor binds are, in
// order: ?n status, ?n+1 priority, ?n+2 created_at, ?n+3 id.
function actionableKeyset(n: number): string {
  const bandC = actionableStatusOrderSql(`?${n}`)
  const prioC = priorityOrderSql(`?${n + 1}`)
  const bandR = actionableStatusOrderSql('status')
  const prioR = priorityOrderSql('priority')
  return (
    `(${bandR} > ${bandC} OR (${bandR} = ${bandC} AND (${prioR} > ${prioC} OR (${prioR} = ${prioC} AND ` +
    `(created_at > ?${n + 2} OR (created_at = ?${n + 2} AND id > ?${n + 3}))))))`
  )
}

function singleStatusKeyset(n: number, ascending: boolean): string {
  const prioC = priorityOrderSql(`?${n + 1}`)
  const prioR = priorityOrderSql('priority')
  const cmp = ascending ? '>' : '<'
  return (
    `(${prioR} > ${prioC} OR (${prioR} = ${prioC} AND ` +
    `(created_at ${cmp} ?${n + 2} OR (created_at = ?${n + 2} AND id > ?${n + 3}))))`
  )
}

function cursorBinds(c: TaskCursor): unknown[] {
  return [c.s, c.p, c.c, c.i]
}

function cursorFor(row: Task, kind: TaskCursor['k'], ctx: TaskPageContext): TaskCursor {
  return { v: 1, k: kind, sq: ctx.squadTag, f: ctx.filterTag, s: row.status, p: row.priority ?? null, c: row.created_at, i: row.id }
}

/**
 * Fetch one page. `baseWhere`/`baseBinds` are the caller's already-composed visibility +
 * filter predicate (numbered placeholders ?1..?baseBinds.length). `cursor` must already have
 * passed decodeTaskCursor + cursorMatchesRequest.
 */
export async function fetchTaskPage(
  env: Env,
  args: { baseWhere: string; baseBinds: readonly unknown[]; limit: number; cursor: TaskCursor | null; ctx: TaskPageContext },
): Promise<TaskPage> {
  const { baseWhere, baseBinds, limit, cursor, ctx } = args
  const want = limit + 1 // one lookahead row: next_cursor != null  <=>  a further row exists
  const n = baseBinds.length + 1
  const rows: Task[] = []

  const run = async (q: Query, order: string, take: number): Promise<Task[]> => {
    const res = await env.DB.prepare(
      `SELECT ${TASK_SELECT_COLUMNS}
         FROM tasks
        WHERE ${q.where}
        ORDER BY ${order}
        LIMIT ${take}`,
    )
      .bind(...q.binds)
      .all<Task>()
    return res.results ?? []
  }

  if (ctx.status !== undefined) {
    const ascending = !excludeFromRanking(ctx.status as Task['status']) // ctx.status was validated by isTaskStatus upstream
    const statusIdx = n
    const clauses = [baseWhere, `status = ?${statusIdx}`]
    const binds: unknown[] = [...baseBinds, ctx.status]
    if (cursor) {
      clauses.push(singleStatusKeyset(statusIdx + 1, ascending))
      binds.push(...cursorBinds(cursor))
    }
    rows.push(
      ...(await run(
        { where: clauses.join(' AND '), binds },
        `${priorityOrderSql()}, created_at ${ascending ? 'ASC' : 'DESC'}, id ASC`,
        want,
      )),
    )
  } else {
    if (!cursor || cursor.k === 'a') {
      const clauses = [baseWhere, actionableStatusInSql()]
      const binds: unknown[] = [...baseBinds]
      if (cursor) {
        clauses.push(actionableKeyset(n))
        binds.push(...cursorBinds(cursor))
      }
      rows.push(
        ...(await run(
          { where: clauses.join(' AND '), binds },
          `${actionableStatusOrderSql()}, ${priorityOrderSql()}, created_at ASC, id ASC`,
          want,
        )),
      )
    }
    if (rows.length < want) {
      const clauses = [baseWhere, terminalStatusInSql()]
      const binds: unknown[] = [...baseBinds]
      if (cursor && cursor.k === 't') {
        clauses.push(singleStatusKeyset(n, false))
        binds.push(...cursorBinds(cursor))
      }
      rows.push(
        ...(await run(
          { where: clauses.join(' AND '), binds },
          `${priorityOrderSql()}, created_at DESC, id ASC`,
          want - rows.length,
        )),
      )
    }
  }

  if (rows.length <= limit) return { rows, nextCursor: null }
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const kind: TaskCursor['k'] = ctx.status !== undefined ? 's' : excludeFromRanking(last.status) ? 't' : 'a'
  return { rows: page, nextCursor: encodeTaskCursor(cursorFor(last, kind, ctx)) }
}
