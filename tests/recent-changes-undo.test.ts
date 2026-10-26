// tests/recent-changes-undo.test.ts: /changes, Recent changes with a one-tap Undo.
// Real dashboardApp, real web sessions, real migration chain; the originals are made through the real writers
// (archiveRow, the task_verdict tool) so the records read back are the ones production writes.
//
// Mutations (see PR body): flipping the "changed since" guards (classifyArchive / classifyVerdict) turns the
// "changed target is refused" tests red; loosening mayRunUnarchive / mayReverseVerdict turns the "no button for a
// viewer without the authority" tests red.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { RECENT_REAUTH_WINDOW_MS } from '../src/auth/web-sessions'
import { archiveRow } from '../src/hygiene/archive'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const ORIGIN = 'http://localhost'

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

let harness: SqliteD1Harness

function makeEnv(email: string): Env {
  return {
    TENANT_SLUG: TENANT, BRAND: 'Test Pot', LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: email,
    SESSIONS: kv(), DB: harness.db, TASK_ARCHIVE_ENABLED: '1',
  } as unknown as Env
}

async function login(email: string): Promise<{ env: Env; cookie: string }> {
  const env = makeEnv(email)
  const res = await authApp.request('/dev-login', {}, env)
  expect(res.status).toBe(302)
  const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  return { env, cookie: `mupot_session=${m[1]}` }
}

function setReauth(memberId: string, at: string | null): void {
  harness.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ? WHERE member_id = ?').run(at, memberId)
}
const freshNow = () => new Date().toISOString()
const stale = () => new Date(Date.now() - (RECENT_REAUTH_WINDOW_MS + 60 * 1000)).toISOString()

function adminToolAuth(): AuthContext {
  return {
    userId: 'u', email: 'admin@x.test', role: 'owner', tenant: TENANT, channel: 'workspace', memberId: 'mem-admin',
    capabilities: [{ member_id: 'mem-admin', scope_type: 'org', scope_id: null, capability: 'admin' }], boundAgentId: null,
  } as AuthContext
}

const rows = (sql: string) => harness.sqlite.prepare(sql).all() as Array<Record<string, unknown>>
const get = (env: Env, cookie: string, path = '/changes') => dashboardApp.request(path, { headers: { cookie } }, env)
function undo(env: Env, cookie: string, change: string, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/x-www-form-urlencoded' }
  if (origin) headers.origin = origin
  return dashboardApp.request('/changes/undo', { method: 'POST', headers, body: new URLSearchParams({ change }).toString() }, env)
}
/** The change id behind a rendered row: 'archive:<receipt>' for the n-th archive receipt of a table. */
function archiveChangeId(table: string, action = 'archive'): string {
  const r = rows(`SELECT id FROM archive_receipts WHERE entity_table='${table}' AND action='${action}' ORDER BY created_at DESC LIMIT 1`)[0]
  if (!r) throw new Error(`no ${action} receipt for ${table}`)
  return `archive:${String(r.id)}`
}
function verdictChangeId(taskId: string): string {
  const r = rows(`SELECT id FROM task_verdicts WHERE task_id='${taskId}' ORDER BY decided_at DESC, id DESC LIMIT 1`)[0]
  if (!r) throw new Error(`no verdict for ${taskId}`)
  return `verdict:${String(r.id)}`
}
const taskArchived = (id: string) => rows(`SELECT 1 FROM tasks_archive_state WHERE task_id='${id}'`).length === 1
const countReceipts = (action: string) => rows(`SELECT id FROM archive_receipts WHERE action='${action}'`).length

async function adminArchive(table: 'tasks' | 'projects' | 'squads', id: string) {
  const out = await archiveRow(makeEnv('admin@x.test'), adminToolAuth(), { table, id, reason: 'tidy up', actorMemberId: 'mem-admin' })
  expect(out.ok, JSON.stringify(out)).toBe(true)
}
async function adminVerdict(taskId: string, verdict: 'approved' | 'rejected') {
  const out = await invokeTool(adminToolAuth(), makeEnv('admin@x.test'), 'task_verdict', { task_id: taskId, verdict, note: 'looks right' }, ORIGIN)
  expect(out.ok, JSON.stringify(out)).toBe(true)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('S1', 'D1', 's1-sqd', 'Squad One'), ('S2', 'D1', 's2-sqd', 'Empty Squad');
    INSERT INTO projects (id, slug, name) VALUES ('P1', 'p1', 'Project One'), ('P2', 'p2', 'Quiet Project');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('P1', 'S1', 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin', 'admin@x.test', 'Hadi Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-plain', 'plain@x.test', 'Plain Pat', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-plain', 'mem-plain', 'squad', 'S1', 'member');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-other', 'other@x.test', 'Other Person', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-x', 'S1', 'agent-x', 'Agent X', 'member', 'test', 'inactive');
    INSERT INTO tasks (id, squad_id, title, status, done_when, project_id) VALUES
      ('t-1', 'S1', 'Obsolete spike one', 'open', 'n/a', 'P1'),
      ('t-2', 'S1', 'Obsolete spike two', 'open', 'n/a', 'P1'),
      ('t-r1', 'S1', 'Review me one', 'review', 'n/a', 'P1'),
      ('t-r2', 'S1', 'Review me two', 'review', 'n/a', 'P1'),
      ('t-routines', 'S1', 'Grant access', 'review', 'n/a', 'P1'),
      ('t-office', 'S1', 'Publish post', 'review', 'n/a', 'P1');
    UPDATE tasks SET gate_owner = 'gate:outreach' WHERE id IN ('t-r1', 't-r2');
    UPDATE tasks SET gate_owner = 'gate:routines' WHERE id = 't-routines';
    UPDATE tasks SET gate_owner = 'gate:office' WHERE id = 't-office';
  `)
})
afterEach(() => harness.close())

describe('each supported inverse undoes, from the page, and writes its own receipt', () => {
  it('task archive -> unarchive_row', async () => {
    await adminArchive('tasks', 't-1')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const page = await (await get(env, cookie)).text()
    expect(page).toContain('Obsolete spike one')
    expect(page).toContain('name="change"')
    expect(taskArchived('t-1')).toBe(true)
    const res = await undo(env, cookie, archiveChangeId('tasks'))
    expect(res.status).toBe(200)
    expect(taskArchived('t-1')).toBe(false)
    expect(rows(`SELECT status FROM tasks WHERE id='t-1'`)[0]?.status).toBe('open')
    const receipt = rows(`SELECT actor_member_id, reason FROM archive_receipts WHERE action='unarchive' AND entity_table='tasks'`)
    expect(receipt).toHaveLength(1)
    expect(receipt[0]?.actor_member_id).toBe('mem-admin')
    expect(String(receipt[0]?.reason)).toContain(archiveChangeId('tasks', 'archive'))
  })

  it('project archive -> unarchive_row (prior status restored)', async () => {
    await adminArchive('projects', 'P2')
    expect(rows(`SELECT status FROM projects WHERE id='P2'`)[0]?.status).toBe('archived')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    expect((await undo(env, cookie, archiveChangeId('projects'))).status).toBe(200)
    expect(rows(`SELECT status FROM projects WHERE id='P2'`)[0]?.status).not.toBe('archived')
    expect(countReceipts('unarchive')).toBe(1)
  })

  it('squad archive -> unarchive_row', async () => {
    await adminArchive('squads', 'S2')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    expect((await undo(env, cookie, archiveChangeId('squads'))).status).toBe(200)
    expect(rows(`SELECT status FROM squads WHERE id='S2'`)[0]?.status).toBe('active')
    expect(countReceipts('unarchive')).toBe(1)
  })

  it('task verdict -> task_verdict_reverse (reversed_at stamped, task back in review, reversal receipt)', async () => {
    await adminVerdict('t-r1', 'approved')
    expect(rows(`SELECT status FROM tasks WHERE id='t-r1'`)[0]?.status).toBe('approved')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const page = await (await get(env, cookie)).text()
    expect(page).toContain('You approved the task')
    const res = await undo(env, cookie, verdictChangeId('t-r1'))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(rows(`SELECT status FROM tasks WHERE id='t-r1'`)[0]?.status).toBe('review')
    expect(rows(`SELECT reversed_at FROM task_verdicts WHERE task_id='t-r1'`)[0]?.reversed_at).not.toBeNull()
    const receipts = rows(`SELECT actor_id, from_status FROM verdict_reversals WHERE task_id='t-r1'`)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.actor_id).toBe('mem-admin')
  })
})

describe('a changed target is refused', () => {
  it('a task touched after it was archived', async () => {
    await adminArchive('tasks', 't-1')
    harness.sqlite.exec(`UPDATE tasks SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = 't-1'`)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const page = await (await get(env, cookie)).text()
    expect(page).toContain("Changed since")
    expect(page).not.toContain('name="change"')
    const res = await undo(env, cookie, archiveChangeId('tasks'))
    expect(await res.text()).toContain("Changed since")
    expect(taskArchived('t-1')).toBe(true)
    expect(countReceipts('unarchive')).toBe(0)
  })

  it('a project re-archived by someone else (archived_at no longer the one this record stamped)', async () => {
    await adminArchive('projects', 'P2')
    harness.sqlite.exec(`UPDATE projects SET archived_at = '2099-01-01T00:00:00.000Z' WHERE id = 'P2'`)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    expect(await (await get(env, cookie)).text()).not.toContain('name="change"')
    const res = await undo(env, cookie, archiveChangeId('projects'))
    expect(await res.text()).toContain("Changed since")
    expect(rows(`SELECT status FROM projects WHERE id='P2'`)[0]?.status).toBe('archived')
    expect(countReceipts('unarchive')).toBe(0)
  })

  it('an older archive record once the target was restored and archived again', async () => {
    await adminArchive('squads', 'S2')
    const first = archiveChangeId('squads')
    const out = await invokeTool(adminToolAuth(), makeEnv('admin@x.test'), 'unarchive_row', { table: 'squads', id: 'S2', reason: 'by hand' }, ORIGIN)
    expect(out.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 5))
    await adminArchive('squads', 'S2')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const res = await undo(env, cookie, first)
    expect(await res.text()).toContain("Changed since")
    expect(rows(`SELECT status FROM squads WHERE id='S2'`)[0]?.status).toBe('archived')
  })

  it('a verdict whose task moved on after it was cast', async () => {
    await adminVerdict('t-r1', 'approved')
    harness.sqlite.exec(`UPDATE tasks SET status = 'done', updated_at = '2099-01-01T00:00:00.000Z' WHERE id = 't-r1'`)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    expect(await (await get(env, cookie)).text()).not.toContain('name="change"')
    const res = await undo(env, cookie, verdictChangeId('t-r1'))
    expect(await res.text()).toContain("Changed since")
    expect(rows(`SELECT status FROM tasks WHERE id='t-r1'`)[0]?.status).toBe('done')
    expect(rows(`SELECT id FROM verdict_reversals`)).toHaveLength(0)
  })
})

describe('authority: no button without the inverse authority, and the POST is refused', () => {
  function seedPlainOwnArchive(): void {
    // A restricted member's own record (they could not have made it through archive_row; seeded so the page has something of theirs).
    const now = '2026-10-20T10:00:00.000Z'
    harness.sqlite.exec(`
      INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
        VALUES ('t-2', '${now}', 'mine', 'mem-plain', 'open', '${now}');
      INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        VALUES ('rcpt-plain', '${TENANT}', 'tasks', 't-2', 'archive', 'mine', 'mem-plain', 'open', '${now}');
    `)
  }

  it('a plain member sees their own change with no Undo, and a POST naming it is refused', async () => {
    seedPlainOwnArchive()
    const plain = await login('plain@x.test')
    setReauth('mem-plain', freshNow())
    const page = await (await get(plain.env, plain.cookie)).text()
    expect(page).toContain('You archived the task')
    expect(page).not.toContain('name="change"')
    const res = await undo(plain.env, plain.cookie, 'archive:rcpt-plain')
    expect(res.status).toBe(403)
    expect(taskArchived('t-2')).toBe(true)
    expect(countReceipts('unarchive')).toBe(0)
  })

  it('a plain member never sees an org admin\'s changes, and cannot name them', async () => {
    await adminArchive('tasks', 't-1')
    const plain = await login('plain@x.test')
    setReauth('mem-plain', freshNow())
    const page = await (await get(plain.env, plain.cookie)).text()
    expect(page).not.toContain('Obsolete spike one')
    const res = await undo(plain.env, plain.cookie, archiveChangeId('tasks'))
    expect(res.status).toBe(404)
    expect(taskArchived('t-1')).toBe(true)
  })

  it('an org admin sees everyone\'s changes; the viewer\'s own come first', async () => {
    seedPlainOwnArchive()
    await adminArchive('projects', 'P2')
    const { env, cookie } = await login('admin@x.test')
    const page = await (await get(env, cookie)).text()
    expect(page.indexOf('Your changes')).toBeGreaterThan(-1)
    expect(page.indexOf('You archived the project')).toBeLessThan(page.indexOf('Plain Pat archived the task'))
    expect(page).toContain('Changes by everyone else')
  })

  it('a verdict by a plain member is not reversible by that member (needs org admin) but is by an admin', async () => {
    // the verdict row is the plain member's own; reversal authority is org owner/admin, which they lack
    const t = '2026-10-20T10:00:00.000Z'
    harness.sqlite.exec(`
      UPDATE tasks SET status = 'approved', updated_at = '${t}' WHERE id = 't-r2';
      INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, project_id) VALUES ('v-plain', 't-r2', 'approved', 'ok', 'mem-plain', '${t}', 'P1');
    `)
    const plain = await login('plain@x.test')
    setReauth('mem-plain', freshNow())
    expect(await (await get(plain.env, plain.cookie)).text()).not.toContain('name="change"')
    expect((await undo(plain.env, plain.cookie, 'verdict:v-plain')).status).toBe(403)
    expect(rows(`SELECT status FROM tasks WHERE id='t-r2'`)[0]?.status).toBe('approved')
    const admin = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    expect(await (await get(admin.env, admin.cookie)).text()).toContain('name="change" value="verdict:v-plain"')
  })
})

describe('never-undo classes are never offered, and cannot be forced', () => {
  it('member and agent archives show as sentences with no Undo, and a forged POST is not found', async () => {
    const now = '2026-10-20T10:00:00.000Z'
    harness.sqlite.exec(`
      INSERT INTO archive_receipts (id, tenant, entity_table, entity_id, action, reason, actor_member_id, prior_status, created_at)
        VALUES ('r-mem', '${TENANT}', 'members', 'mem-other', 'archive', 'x', 'mem-admin', 'active', '${now}'),
               ('r-agent', '${TENANT}', 'agents', 'agent-x', 'archive', 'x', 'mem-admin', NULL, '${now}');
    `)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const page = await (await get(env, cookie)).text()
    expect(page).toContain('archived the member')
    expect(page).toContain('archived the agent')
    expect(page).not.toContain('name="change"')
    for (const id of ['archive:r-mem', 'archive:r-agent']) expect((await undo(env, cookie, id)).status).toBe(404)
    expect(rows(`SELECT archived_at FROM agents WHERE id='agent-x'`)[0]?.archived_at ?? null).toBeNull()
  })

  it('move_agent_squad and other agent edits are listed but not undoable', async () => {
    harness.sqlite.exec(`
      INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state)
        VALUES ('aa-1', 'agent-x', 'mem-admin', 'user', 'move_agent_squad', '{}', '{}', '{}');
    `)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const page = await (await get(env, cookie)).text()
    expect(page).toContain('moved the agent')
    expect(page).not.toContain('name="change"')
    expect((await undo(env, cookie, 'info:agent_audit:aa-1')).status).toBe(404)
  })

  it('verdicts on gate:routines / gate:office tasks, or bound to a routine proposal, get no Undo and are refused', async () => {
    const t = '2026-10-20T10:00:00.000Z'
    harness.sqlite.exec(`
      UPDATE tasks SET status = 'approved', updated_at = '${t}' WHERE id IN ('t-routines', 't-office', 't-r1');
      INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, project_id) VALUES
        ('v-routines', 't-routines', 'approved', 'ok', 'mem-admin', '${t}', 'P1'),
        ('v-office', 't-office', 'approved', 'ok', 'mem-admin', '${t}', 'P1');
      INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at, project_id, proposal_id) VALUES
        ('v-prop', 't-r1', 'approved', 'ok', 'mem-admin', '${t}', 'P1', 'prop-1');
    `)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const page = await (await get(env, cookie)).text()
    expect(page).toContain('Grant access')
    expect(page).toContain('Publish post')
    expect(page).not.toContain('name="change"')
    for (const id of ['verdict:v-routines', 'verdict:v-office', 'verdict:v-prop']) expect((await undo(env, cookie, id)).status).toBe(403)
    expect(rows(`SELECT id FROM verdict_reversals`)).toHaveLength(0)
    expect(rows(`SELECT reversed_at FROM task_verdicts WHERE reversed_at IS NOT NULL`)).toHaveLength(0)
  })

  it('with task archiving off, a task archive record is not offered', async () => {
    await adminArchive('tasks', 't-1')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const off = { ...env, TASK_ARCHIVE_ENABLED: '0' } as Env
    expect(await (await get(off, cookie)).text()).not.toContain('name="change"')
  })
})

describe('the POST bar and idempotence', () => {
  it('a double undo is idempotent: one restore, one receipt, the second says already undone', async () => {
    await adminArchive('tasks', 't-1')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const id = archiveChangeId('tasks')
    expect((await undo(env, cookie, id)).status).toBe(200)
    const second = await undo(env, cookie, id)
    expect(second.status).toBe(200)
    expect(await second.text()).toContain('Already undone')
    expect(countReceipts('unarchive')).toBe(1)
    expect(taskArchived('t-1')).toBe(false)
  })

  it('a double verdict undo is idempotent', async () => {
    await adminVerdict('t-r1', 'rejected')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const id = verdictChangeId('t-r1')
    expect((await undo(env, cookie, id)).status).toBe(200)
    expect(await (await undo(env, cookie, id)).text()).toContain('Already undone')
    expect(rows(`SELECT id FROM verdict_reversals WHERE task_id='t-r1'`)).toHaveLength(1)
  })

  it('a stale session is sent to re-auth and nothing is written', async () => {
    await adminArchive('tasks', 't-1')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', stale())
    const res = await undo(env, cookie, archiveChangeId('tasks'))
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('/auth/reauth')
    expect(taskArchived('t-1')).toBe(true)
  })

  it('a missing or foreign Origin is refused', async () => {
    await adminArchive('tasks', 't-1')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    expect((await undo(env, cookie, archiveChangeId('tasks'), null)).status).toBe(403)
    expect((await undo(env, cookie, archiveChangeId('tasks'), 'https://evil.example')).status).toBe(403)
    expect(taskArchived('t-1')).toBe(true)
  })

  it('the form carries only a record id: a crafted id for something else finds nothing', async () => {
    await adminArchive('tasks', 't-1')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    for (const id of ['', 'archive:', 'archive:nope', 'tasks:t-1', 'unarchive_row', 'verdict:nope']) {
      expect([400, 404]).toContain((await undo(env, cookie, id)).status)
    }
    expect(taskArchived('t-1')).toBe(true)
  })

  it('an undone change shows as restored, with the restore as its own line', async () => {
    await adminArchive('tasks', 't-1')
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    await undo(env, cookie, archiveChangeId('tasks'))
    const page = await (await get(env, cookie)).text()
    expect(page).toContain('You restored the task')
    expect(page).toContain('Undone')
    expect(page).not.toContain('name="change"')
  })
})
