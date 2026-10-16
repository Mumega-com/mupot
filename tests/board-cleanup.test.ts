// tests/board-cleanup.test.ts: agents propose archives, a human org admin archives at /board/cleanup.
// Real dashboardApp, real web sessions, real migration chain; the MCP side goes through invokeTool.
//
// Mutation (see PR body): removing the operator-only gate in the POST (the org-admin + not-agent check)
// turns "a non-admin is refused" red.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
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
const stale = () => new Date(Date.now() - 10 * 60 * 1000).toISOString()

function agentAuth(): AuthContext {
  return {
    userId: 'agent:agent-A', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    memberId: 'seat-agent-A',
    capabilities: [{ member_id: 'seat-agent-A', scope_type: 'squad', scope_id: 'S1', capability: 'member' }],
    boundAgentId: 'agent-A',
  } as AuthContext
}
function adminToolAuth(): AuthContext {
  return {
    userId: 'u', email: 'admin@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-admin',
    capabilities: [{ member_id: 'mem-admin', scope_type: 'org', scope_id: null, capability: 'admin' }], boundAgentId: null,
  } as AuthContext
}

function form(env: Env, cookie: string, body: Record<string, string | string[]>, origin: string | null = ORIGIN) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(body)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item)
  const headers: Record<string, string> = { cookie, 'content-type': 'application/x-www-form-urlencoded' }
  if (origin) headers.origin = origin
  return dashboardApp.request('/board/cleanup/archive', { method: 'POST', headers, body: params.toString() }, env)
}

const rows = (sql: string) => harness.sqlite.prepare(sql).all() as Array<Record<string, unknown>>
const archivedIds = () => rows('SELECT task_id FROM tasks_archive_state').map((r) => String(r.task_id))
const pendingIds = () => rows('SELECT id, task_id FROM archive_proposals WHERE decision IS NULL ORDER BY task_id')

async function propose(taskIds: string[]) {
  const env = makeEnv('admin@x.test')
  return invokeTool(agentAuth(), env, 'archive_propose', { task_ids: taskIds, reason: 'obsolete spike', evidence: 'no activity 90d' }, ORIGIN)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('S1', 'D1', 's1-sqd', 'Squad One');
    INSERT INTO projects (id, slug, name) VALUES ('P1', 'p1', 'Project One');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('P1', 'S1', 'admin');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-A', 'S1', 'agent-a', 'Agent A', 'member', 'test', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('seat-agent-A', 'Agent A seat', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-A', 'seat-agent-A', '2026-10-01T00:00:00.000Z');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin', 'admin@x.test', 'Hadi Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-plain', 'plain@x.test', 'Plain', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-plain', 'mem-plain', 'squad', 'S1', 'member');
    INSERT INTO tasks (id, squad_id, title, status, done_when, project_id) VALUES
      ('t-1', 'S1', 'Obsolete spike one', 'open', 'n/a', 'P1'),
      ('t-2', 'S1', 'Obsolete spike two', 'open', 'n/a', 'P1'),
      ('t-3', 'S1', 'Obsolete spike three', 'blocked', 'n/a', 'P1');
  `)
})
afterEach(() => harness.close())

describe('archive_propose (agent half)', () => {
  it('an agent can propose, the proposal is stored, and nothing is archived', async () => {
    const res = await propose(['t-1', 't-2', 'nope'])
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(pendingIds().map((r) => r.task_id)).toEqual(['t-1', 't-2'])
    expect(archivedIds()).toEqual([])
    expect(rows(`SELECT task_status_at_proposal AS s FROM archive_proposals`).every((r) => r.s === 'open')).toBe(true)
    // a re-proposal while pending is a no-op
    await propose(['t-1'])
    expect(pendingIds()).toHaveLength(2)
  })

  it('an agent cannot archive: archive_row refuses an agent-bound caller and the task stays live', async () => {
    const res = await invokeTool(agentAuth(), makeEnv('admin@x.test'), 'archive_row', { table: 'tasks', id: 't-1', reason: 'x' }, ORIGIN)
    expect(res.ok).toBe(false)
    expect(archivedIds()).toEqual([])
  })

  it('an operator (unbound) caller cannot use archive_propose', async () => {
    const res = await invokeTool(adminToolAuth(), makeEnv('admin@x.test'), 'archive_propose', { task_ids: ['t-1'], reason: 'x' }, ORIGIN)
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('agent_principal_required')
    expect(pendingIds()).toHaveLength(0)
  })
})

describe('/board/cleanup (human half)', () => {
  it('lists pending proposals grouped by reason with title, status and evidence; Needs You links it', async () => {
    await propose(['t-1', 't-3'])
    const { env, cookie } = await login('admin@x.test')
    const res = await dashboardApp.request('/board/cleanup', { headers: { cookie } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('obsolete spike (2)')
    expect(body).toContain('Obsolete spike one')
    expect(body).toContain('no activity 90d')
    expect(body).toContain('blocked')
    expect(body).toContain('Archive selected')
    expect(body).toContain('Archive all (2)')
    const needs = await dashboardApp.request('/needs-you', { headers: { cookie } }, env)
    expect(await needs.text()).toContain('href="/board/cleanup"')
  })

  it('a human org admin archives selected rows through the page; the board drops them and the decision is recorded', async () => {
    await propose(['t-1', 't-2'])
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const before = JSON.stringify(await invokeTool(adminToolAuth(), env, 'task_list', { squad_id: 'S1' }, ORIGIN))
    expect(before).toContain('Obsolete spike one')
    const id1 = String(pendingIds().find((r) => r.task_id === 't-1')?.id)
    const res = await form(env, cookie, { mode: 'selected', proposal_id: [id1] })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(archivedIds()).toEqual(['t-1'])
    expect(rows(`SELECT decision, decided_by_member_id AS by FROM archive_proposals WHERE task_id = 't-1'`)[0]).toEqual({ decision: 'archived', by: 'mem-admin' })
    expect(rows(`SELECT entity_id FROM archive_receipts WHERE entity_table = 'tasks'`).map((r) => r.entity_id)).toEqual(['t-1'])
    expect(pendingIds().map((r) => r.task_id)).toEqual(['t-2'])
    const listed = await invokeTool(adminToolAuth(), env, 'task_list', { squad_id: 'S1' }, ORIGIN)
    expect(JSON.stringify(listed)).not.toContain('Obsolete spike one')
    expect(JSON.stringify(listed)).toContain('Obsolete spike two')
  })

  it('Archive all archives every pending proposal', async () => {
    await propose(['t-1', 't-2', 't-3'])
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const res = await form(env, cookie, { mode: 'all' })
    expect(res.status).toBe(200)
    expect(archivedIds().sort()).toEqual(['t-1', 't-2', 't-3'])
    expect(pendingIds()).toHaveLength(0)
  })

  it('a non-admin is refused (page and POST)', async () => {
    await propose(['t-1'])
    const plain = await login('plain@x.test')
    setReauth('mem-plain', freshNow())
    const page = await dashboardApp.request('/board/cleanup', { headers: { cookie: plain.cookie } }, plain.env)
    expect(page.status).toBe(403)
    const res = await form(plain.env, plain.cookie, { mode: 'all' })
    expect(res.status).toBe(403)
    expect(archivedIds()).toEqual([])
  })

  it('a missing Origin (CSRF) is refused', async () => {
    await propose(['t-1'])
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    expect((await form(env, cookie, { mode: 'all' }, null)).status).toBe(403)
    expect((await form(env, cookie, { mode: 'all' }, 'https://evil.example')).status).toBe(403)
    expect(archivedIds()).toEqual([])
  })

  it('a stale session (no fresh re-auth) is refused with the confirm-it-is-you link', async () => {
    await propose(['t-1'])
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', stale())
    const res = await form(env, cookie, { mode: 'all' })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('/auth/reauth')
    expect(archivedIds()).toEqual([])
  })

  it('an unauthenticated POST is not served', async () => {
    const res = await dashboardApp.request('/board/cleanup/archive', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'mode=all',
    }, makeEnv('admin@x.test'))
    expect([302, 401, 403]).toContain(res.status)
    expect(archivedIds()).toEqual([])
  })

  it('drift: a task whose status changed since the proposal is refused, the others proceed', async () => {
    await propose(['t-1', 't-2'])
    harness.sqlite.exec(`UPDATE tasks SET status = 'in_progress' WHERE id = 't-1'`)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const res = await form(env, cookie, { mode: 'all' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('status_drift')
    expect(archivedIds()).toEqual(['t-2'])
    expect(rows(`SELECT decision FROM archive_proposals WHERE task_id = 't-1'`)[0]).toEqual({ decision: 'refused_status_drift' })
  })

  it('archiveRow refusals apply: a live execution claim keeps the row pending and unarchived', async () => {
    await propose(['t-1', 't-2'])
    harness.sqlite.exec(`UPDATE tasks SET status = 'in_progress' WHERE id = 't-1'`)
    harness.sqlite.exec(`UPDATE archive_proposals SET task_status_at_proposal = 'in_progress' WHERE task_id = 't-1'`)
    harness.sqlite.exec(`UPDATE tasks SET execution_claim_expires_at = ${Date.now() + 3_600_000} WHERE id = 't-1'`)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const res = await form(env, cookie, { mode: 'all' })
    expect(await res.text()).toContain('live_execution_claim')
    expect(archivedIds()).toEqual(['t-2'])
    expect(pendingIds().map((r) => r.task_id)).toEqual(['t-1'])
  })
})
