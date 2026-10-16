// /approvals shows only what the caller can act on right now: pending AND not
// expired AND not archived. Expiry is a LIVE predicate in the read query
// (APPROVAL_LIVE_SQL) — these tests write stale rows with status still 'review'
// and no sweeper, and the reader must still be correct. Real sqlite + all migrations.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadApprovals, loadApprovalsHistory, loadApprovalsSummary,
  APPROVAL_HISTORY_PAGE_SIZE, APPROVAL_LIVE_DAYS, APPROVAL_LIVE_LIST_CAP,
} from '../src/dashboard/approvals'
import { approvalsBody, approvalsHistoryBody } from '../src/dashboard/index'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'
const owner = { userId: 'u', email: null, role: 'owner', tenant: TENANT, capabilities: [] } as unknown as AuthContext

let h: SqliteD1Harness
let env: Env

function addTask(id: string, opts: { ageDays: number; status?: string; gate?: string } = { ageDays: 0 }): void {
  h.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, status, done_when, gate_owner, assignee_agent_id, created_at, updated_at)
     VALUES (?, 's1', ?, ?, 'x', ?, 'a1', datetime('now', ?), datetime('now', ?))`,
  ).run(id, `Task ${id}`, opts.status ?? 'review', opts.gate ?? 'gate:hadi', `-${String(opts.ageDays)} days`, `-${String(opts.ageDays)} days`)
}
const verdict = (taskId: string, ageDays = 0) =>
  h.sqlite.prepare(`INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at) VALUES (?, ?, 'approved', 'm-op', datetime('now', ?))`)
    .run(`v-${taskId}`, taskId, `-${String(ageDays)} days`)

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { TENANT_SLUG: TENANT, DB: h.db } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO members (id, tenant, email, display_name, status) VALUES ('m-op', '${TENANT}', 'op@example.com', 'Op', 'active');
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 'sq-one', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('a1', 's1', 'ag1', 'Agent', 'inactive');
  `)
})
afterEach(() => h.close())

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort()

describe('approvals: live vs expired', () => {
  it('excludes expired review tasks from the count and the list (status still review, no sweeper)', async () => {
    addTask('live', { ageDays: 1 })
    addTask('expired', { ageDays: APPROVAL_LIVE_DAYS + 1 })
    const q = await loadApprovals(env, owner)
    expect(ids(q.items)).toEqual(['live'])
    expect(q.actionableCount).toBe(1)
    expect(h.sqlite.prepare(`SELECT status FROM tasks WHERE id='expired'`).get()).toEqual({ status: 'review' })
  })

  it('fails closed: an unparseable updated_at is expired, not live', async () => {
    addTask('garbage', { ageDays: 0 })
    h.sqlite.exec(`UPDATE tasks SET updated_at = 'not-a-date' WHERE id = 'garbage'`)
    expect((await loadApprovals(env, owner)).items).toEqual([])
    expect(ids((await loadApprovalsHistory(env, owner)).rows)).toEqual(['garbage'])
  })

  it('history shows expired and decided items; the summary counts them', async () => {
    addTask('live', { ageDays: 1 })
    addTask('expired', { ageDays: 30 })
    addTask('done-recent', { ageDays: 2, status: 'approved' })
    verdict('done-recent', 2)
    const hist = await loadApprovalsHistory(env, owner)
    expect(hist.rows.map((r) => `${r.id}:${r.state}`).sort()).toEqual(['done-recent:decided', 'expired:expired'])
    expect(await loadApprovalsSummary(env, owner)).toEqual({ expired: 1, decidedThisWeek: 1 })
  })

  it('an archived item is hidden from live, history and summary', async () => {
    addTask('expired', { ageDays: 30 })
    addTask('live', { ageDays: 1 })
    for (const id of ['expired', 'live']) {
      h.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
        VALUES ('${id}', datetime('now'), 'test', 'm-op', 'review', datetime('now'))`)
    }
    expect((await loadApprovals(env, owner)).items).toEqual([])
    expect((await loadApprovalsHistory(env, owner)).rows).toEqual([])
    expect(await loadApprovalsSummary(env, owner)).toEqual({ expired: 0, decidedThisWeek: 0 })
  })

  it('history paginates at 20', async () => {
    for (let i = 0; i < 45; i += 1) addTask(`old-${String(i).padStart(2, '0')}`, { ageDays: 30 + i })
    const p1 = await loadApprovalsHistory(env, owner, 1)
    const p2 = await loadApprovalsHistory(env, owner, 2)
    const p3 = await loadApprovalsHistory(env, owner, 3)
    expect([p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([APPROVAL_HISTORY_PAGE_SIZE, APPROVAL_HISTORY_PAGE_SIZE, 5])
    expect([p1.hasMore, p2.hasMore, p3.hasMore]).toEqual([true, true, false])
    expect(new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id)).size).toBe(45)
    const html = String(approvalsHistoryBody(p1))
    expect(html).toContain('view=history&amp;page=2')
  })
})

describe('approvals page render', () => {
  it('badge equals the list length; expired is not rendered; one quiet history line', async () => {
    for (let i = 0; i < 5; i += 1) addTask(`l${String(i)}`, { ageDays: 1 })
    addTask('x1', { ageDays: 40 })
    addTask('x2', { ageDays: 41 })
    const q = await loadApprovals(env, owner)
    const summary = await loadApprovalsSummary(env, owner)
    const html = String(approvalsBody(q, [], [], summary))
    expect(html).toContain('5 awaiting your gate')
    expect(html.match(/class="card approval"/g)?.length).toBe(5)
    expect(html).not.toContain('Task x1')
    expect(html).toContain('2 expired, 0 decided this week')
    expect(html).toContain('/approvals?view=history')
  })

  it('caps the default list at 20 with Show more; ?all shows everything', async () => {
    for (let i = 0; i < 25; i += 1) addTask(`l${String(i).padStart(2, '0')}`, { ageDays: 1 })
    const q = await loadApprovals(env, owner)
    const capped = String(approvalsBody(q))
    expect(capped.match(/class="card approval"/g)?.length).toBe(APPROVAL_LIVE_LIST_CAP)
    expect(capped).toContain('Show 5 more')
    expect(capped).toContain('25 awaiting your gate')
    const all = String(approvalsBody(q, [], [], undefined, true))
    expect(all.match(/class="card approval"/g)?.length).toBe(25)
    expect(all).not.toContain('Show 5 more')
  })

  it('renders no history line when there is nothing in history', async () => {
    addTask('l0', { ageDays: 1 })
    const html = String(approvalsBody(await loadApprovals(env, owner), [], [], await loadApprovalsSummary(env, owner)))
    expect(html).not.toContain('view=history')
  })
})
