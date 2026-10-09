// tests/task-pagination-1784.test.ts — mupot#1784: task_list keyset pagination + task_board
// true totals. REAL migration chain on the sqlite D1 double.
//
// DEFECT CLASS: a truncated read presented as complete; a pager that skips/duplicates rows on
// ties. The fixture deliberately has ONLY a handful of distinct created_at values over 250
// rows, so every page boundary lands inside a tie group.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { listTasksForAuth } from '../src/tasks'
import { decodeTaskCursor, encodeTaskCursor } from '../src/tasks/pagination'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'
const ORIGIN = 'https://pot.test'
const OPERATOR = 'member-operator'
const SQUAD_ONLY = 'member-squad-only'

function auth(memberId: string, capabilities: AuthContext['capabilities']): AuthContext {
  return {
    userId: `${memberId}-caller`,
    email: `${memberId}@example.com`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId: null,
  } as AuthContext
}
const ORG_ADMIN = auth(OPERATOR, [{ member_id: OPERATOR, scope_type: 'org', scope_id: null, capability: 'admin' }])
const SQUAD1_ONLY = auth(SQUAD_ONLY, [{ member_id: SQUAD_ONLY, scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }])

const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'review', 'approved', 'rejected'] as const
const PRIOS = ['P0', 'P1', 'P2', 'P3', null] as const
const STAMPS = ['2026-01-01 00:00:00', '2026-01-01 00:00:01', '2026-01-01 00:00:02']

interface Row { id: string }
interface ListResult { tasks: Row[]; next_cursor: string | null; truncated: boolean }
interface BoardResult {
  counts: Record<string, number>
  columns: Record<string, Row[]>
  truncated: boolean
  has_more: Record<string, boolean>
}

describe('mupot#1784 task_list pagination + task_board totals', () => {
  let harness: SqliteD1Harness
  let env: Env
  const invoke = (a: AuthContext, tool: string, args: Record<string, unknown>) => invokeTool(a, env, tool, args, ORIGIN)

  async function list(a: AuthContext, args: Record<string, unknown>): Promise<ListResult> {
    const r = await invoke(a, 'task_list', args)
    if (!r.ok) throw new Error(`task_list failed ${r.status} ${r.error}`)
    return r.result as ListResult
  }
  async function walk(a: AuthContext, args: Record<string, unknown>, limit: number): Promise<string[][]> {
    const pages: string[][] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 500; guard += 1) {
      const res: ListResult = await list(a, { ...args, limit, ...(cursor ? { cursor } : {}) })
      pages.push(res.tasks.map((t) => t.id))
      expect(res.truncated).toBe(res.next_cursor !== null)
      cursor = res.next_cursor
      if (!cursor) return pages
    }
    throw new Error('pagination did not terminate')
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, email, display_name, status) VALUES
        ('${OPERATOR}', '${TENANT}', 'op@example.com', 'Operator', 'active'),
        ('${SQUAD_ONLY}', '${TENANT}', 'sq@example.com', 'SquadOnly', 'active');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-op', '${OPERATOR}', 'org', NULL, 'admin'),
               ('cap-sq', '${SQUAD_ONLY}', 'squad', 'squad-1', 'member');
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('squad-1', 'dept-1', 'sq1-sqd', 'Squad One'),
        ('squad-2', 'dept-1', 'sq2-sqd', 'Squad Two');
      INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj-one', 'Project One', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', 'squad-1', 'admin');
    `)
    const ins = harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, status, done_when, priority, created_at, project_id)
       VALUES (?, ?, ?, ?, 'n/a', ?, ?, ?)`,
    )
    for (let i = 0; i < 250; i += 1) {
      ins.run(
        `t-${String(i).padStart(3, '0')}`,
        'squad-1',
        `Task ${i}`,
        STATUSES[i % STATUSES.length],
        PRIOS[i % PRIOS.length],
        STAMPS[i % STAMPS.length],
        i % 10 === 0 ? 'proj-1' : null,
      )
    }
    // Another squad's tasks and an archived task in squad-1: must never appear.
    for (let i = 0; i < 20; i += 1) ins.run(`other-${i}`, 'squad-2', `Other ${i}`, 'open', 'P0', STAMPS[0], null)
    ins.run('archived-1', 'squad-1', 'Archived', 'open', 'P0', STAMPS[0], null)
    harness.sqlite.exec(`
      INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
        VALUES ('archived-1', datetime('now'), 'test', '${OPERATOR}', 'open', datetime('now'));
    `)
  })
  afterEach(() => harness.close())

  const allIds = Array.from({ length: 250 }, (_, i) => `t-${String(i).padStart(3, '0')}`)

  it('walking pages of 37 yields every task exactly once (ties on created_at, no dupes, no skips)', async () => {
    const pages = await walk(ORG_ADMIN, { squad_id: 'squad-1' }, 37)
    const flat = pages.flat()
    expect(flat.length).toBe(250)
    expect(new Set(flat).size).toBe(250)
    expect([...flat].sort()).toEqual(allIds)
    expect(pages.length).toBe(Math.ceil(250 / 37))
  })

  it('the walk is invariant to the page size (limit 1, 7, 100 all yield the same sequence)', async () => {
    const a = (await walk(ORG_ADMIN, { squad_id: 'squad-1' }, 100)).flat()
    const b = (await walk(ORG_ADMIN, { squad_id: 'squad-1' }, 7)).flat()
    const c = (await walk(ORG_ADMIN, { squad_id: 'squad-1' }, 1)).flat()
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it('a page ending exactly on the last row has next_cursor null (no phantom empty page)', async () => {
    const res = await list(ORG_ADMIN, { squad_id: 'squad-1', limit: 100 })
    expect(res.next_cursor).not.toBeNull()
    const p2 = await list(ORG_ADMIN, { squad_id: 'squad-1', limit: 100, cursor: res.next_cursor })
    const p3 = await list(ORG_ADMIN, { squad_id: 'squad-1', limit: 100, cursor: p2.next_cursor })
    expect(p3.tasks.length).toBe(50)
    expect(p3.next_cursor).toBeNull()
    expect(p3.truncated).toBe(false)
  })

  it('filters are preserved across pages (status, assignee-less project filter)', async () => {
    const wantOpen = allIds.filter((_, i) => STATUSES[i % STATUSES.length] === 'open')
    const open = (await walk(ORG_ADMIN, { squad_id: 'squad-1', status: 'open' }, 5)).flat()
    expect([...open].sort()).toEqual(wantOpen)
    const wantDone = allIds.filter((_, i) => STATUSES[i % STATUSES.length] === 'done')
    const done = (await walk(ORG_ADMIN, { squad_id: 'squad-1', status: 'done' }, 4)).flat()
    expect(new Set(done).size).toBe(done.length)
    expect([...done].sort()).toEqual(wantDone)
    const wantProj = allIds.filter((_, i) => i % 10 === 0)
    const proj = (await walk(ORG_ADMIN, { squad_id: 'squad-1', project_id: 'proj-1' }, 6)).flat()
    expect([...proj].sort()).toEqual(wantProj)
  })

  it('cursor is bound to its filters: replaying it under another status/squad is a 400', async () => {
    const res = await list(ORG_ADMIN, { squad_id: 'squad-1', status: 'open', limit: 5 })
    expect(res.next_cursor).not.toBeNull()
    for (const args of [
      { squad_id: 'squad-1', status: 'done' },
      { squad_id: 'squad-1' },
      { squad_id: 'squad-2', status: 'open' },
      { squad_id: 'squad-1', status: 'open', project_id: 'proj-1' },
    ]) {
      const r = await invoke(ORG_ADMIN, 'task_list', { ...args, limit: 5, cursor: res.next_cursor })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.status).toBe(400)
        expect(r.error).toBe('invalid_args')
      }
    }
  })

  it('malformed cursors are 400 invalid_args', async () => {
    const goodShape = { v: 1, k: 'a', sq: 'squad-1', f: '||', s: 'open', p: 'P0', c: STAMPS[0], i: 't-001' }
    const bad: unknown[] = [
      'not-base64!!',
      'AAAA',
      42,
      '',
      encodeTaskCursor({ ...(goodShape as never), v: 2 } as never),
      encodeTaskCursor({ ...(goodShape as never), s: 'done' } as never), // actionable phase, terminal status
      encodeTaskCursor({ ...(goodShape as never), i: '' } as never),
      encodeTaskCursor({ ...(goodShape as never), k: 'z' } as never),
      btoa(JSON.stringify([1, 2])),
    ]
    for (const cursor of bad) {
      const r = await invoke(ORG_ADMIN, 'task_list', { squad_id: 'squad-1', cursor })
      expect(r.ok, JSON.stringify(cursor)).toBe(false)
      if (!r.ok) {
        expect(r.status).toBe(400)
        expect(r.error).toBe('invalid_args')
      }
    }
    expect(decodeTaskCursor(encodeTaskCursor(goodShape as never))).not.toBeNull()
  })

  it('cursor is bound in SQL, not interpolated: a hostile id/created_at is just a position', async () => {
    const evil = encodeTaskCursor({ v: 1, k: 'a', sq: 'squad-1', f: '||', s: 'open', p: null, c: "x'; DROP TABLE tasks; --", i: "' OR 1=1 --" })
    const r = await list(ORG_ADMIN, { squad_id: 'squad-1', limit: 10, cursor: evil })
    expect(r.tasks.length).toBeLessThanOrEqual(10)
    const still = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
    expect(still.n).toBe(271)
  })

  it('limit is a PAGE size capped at 100 but never a silent total cap', async () => {
    const res = await list(ORG_ADMIN, { squad_id: 'squad-1', limit: 100000 })
    expect(res.tasks.length).toBe(100)
    expect(res.truncated).toBe(true)
    expect(res.next_cursor).not.toBeNull()
  })

  it('visibility: another squad and archived tasks never appear in any page; forged cursor reveals nothing', async () => {
    const flat = (await walk(SQUAD1_ONLY, { squad_id: 'squad-1' }, 40)).flat()
    expect(flat.some((id) => id.startsWith('other-') || id === 'archived-1')).toBe(false)
    expect(flat.length).toBe(250)
    const denied = await invoke(SQUAD1_ONLY, 'task_list', { squad_id: 'squad-2', limit: 5 })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.status).toBe(403)
    // a cursor minted for squad-2 by an admin does not unlock squad-2 for the squad-1 member
    const adminPage = await list(ORG_ADMIN, { squad_id: 'squad-2', limit: 5 })
    const replay = await invoke(SQUAD1_ONLY, 'task_list', { squad_id: 'squad-2', limit: 5, cursor: adminPage.next_cursor })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.status).toBe(403)
  })

  it('REST twin: GET /tasks pages with limit+cursor, same union, and is honest about legacy truncation', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 100; guard += 1) {
      const res = await listTasksForAuth(env, ORG_ADMIN, { squadId: 'squad-1', limit: '60', cursor })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ListResult
      seen.push(...body.tasks.map((t) => t.id))
      if (!body.next_cursor) break
      cursor = body.next_cursor
    }
    expect([...seen].sort()).toEqual(allIds)
    const bad = await listTasksForAuth(env, ORG_ADMIN, { squadId: 'squad-1', cursor: 'garbage!' })
    expect(bad.status).toBe(400)
    const badLimit = await listTasksForAuth(env, ORG_ADMIN, { squadId: 'squad-1', limit: '0' })
    expect(badLimit.status).toBe(400)
    // legacy (no limit/cursor): 4 of 7 statuses are terminal => ~142 terminal rows > the
    // 100-row terminal cap, so the legacy read IS truncated and must say so.
    const legacy = (await (await listTasksForAuth(env, ORG_ADMIN, { squadId: 'squad-1' })).json()) as ListResult
    expect(legacy.tasks.length).toBe(208) // 108 actionable (all) + 100 terminal (capped)
    expect(legacy.tasks.length).toBeLessThan(250)
    expect(legacy.truncated).toBe(true)
    // and a squad small enough to fit under the caps is NOT flagged
    const small = (await (await listTasksForAuth(env, ORG_ADMIN, { squadId: 'squad-2' })).json()) as ListResult
    expect(small.tasks.length).toBe(20)
    expect(small.truncated).toBe(false)
  })

  describe('task_board true totals', () => {
    it('counts are TRUE totals when the row fetch is truncated; truncated + has_more say so', async () => {
      const r = await invoke(ORG_ADMIN, 'task_board', { squad_id: 'squad-1', limit: 20 })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const board = r.result as BoardResult
      const rowsShown = Object.values(board.columns).flat().length
      expect(rowsShown).toBe(20)
      const total = Object.values(board.counts).reduce((a, b) => a + b, 0)
      expect(total).toBe(250) // archived-1 and squad-2 excluded
      for (const status of STATUSES) {
        const want = allIds.filter((_, i) => STATUSES[i % STATUSES.length] === status).length
        expect(board.counts[status]).toBe(want)
        expect(board.has_more[status]).toBe(want > board.columns[status].length)
      }
      expect(board.truncated).toBe(true)
    })

    it('not truncated when the board shows everything', async () => {
      const r = await invoke(ORG_ADMIN, 'task_board', { squad_id: 'squad-1', limit: 250 })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const board = r.result as BoardResult
      expect(Object.values(board.columns).flat().length).toBe(250)
      expect(board.truncated).toBe(false)
      expect(Object.values(board.has_more).every((v) => v === false)).toBe(true)
    })

    it('counts exclude archived tasks (visibility) and other squads', async () => {
      const r = await invoke(ORG_ADMIN, 'task_board', { squad_id: 'squad-1', limit: 250 })
      if (!r.ok) throw new Error('board failed')
      const board = r.result as BoardResult
      const opens = allIds.filter((_, i) => STATUSES[i % STATUSES.length] === 'open').length
      expect(board.counts.open).toBe(opens) // archived-1 (open) not counted
    })
  })
})
