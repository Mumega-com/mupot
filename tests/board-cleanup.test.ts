// tests/board-cleanup.test.ts: agents propose archives, a human org admin archives at /board/cleanup.
// Real dashboardApp, real web sessions, real migration chain; the MCP side goes through invokeTool.
//
// Mutation (see PR body): removing the operator-only gate in the POST (the org-admin + not-agent check)
// turns "a non-admin is refused" red.

import { RECENT_REAUTH_WINDOW_MS } from '../src/auth/web-sessions'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { makeBoardCleanupApp } from '../src/dashboard/board-cleanup'
import { countPendingProposals, listPendingProposals, MAX_PENDING_PER_AGENT, PROPOSAL_TTL_MS } from '../src/hygiene/archive-proposals'
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

function renderedIds(html: string): string[] {
  return Array.from(html.matchAll(/name="rendered_id" value="([^"]+)"/g)).map((m) => m[1] as string)
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
    expect(body).toContain('Proposed by Agent A (2)')
    expect(body).toMatch(/Agent.{1,6}s note: obsolete spike/)
    expect(body).toContain('Squad One / Project One')
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
    const res = await form(env, cookie, { mode: 'all', rendered_id: pendingIds().map((r) => String(r.id)) })
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
    const res = await form(env, cookie, { mode: 'all', rendered_id: pendingIds().map((r) => String(r.id)) })
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
    const res = await form(env, cookie, { mode: 'all', rendered_id: pendingIds().map((r) => String(r.id)) })
    expect(await res.text()).toContain('live_execution_claim')
    expect(archivedIds()).toEqual(['t-2'])
    expect(pendingIds().map((r) => r.task_id)).toEqual(['t-1'])
  })

  it('Archive all archives ONLY the proposals the page rendered (a proposal that arrived after render is untouched)', async () => {
    await propose(['t-1'])
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const page = await (await dashboardApp.request('/board/cleanup', { headers: { cookie } }, env)).text()
    expect(page).toContain('Archive all (1)')
    await propose(['t-3']) // arrives after the human loaded the page
    const res = await form(env, cookie, { mode: 'all', rendered_id: renderedIds(page) })
    expect(res.status).toBe(200)
    expect(archivedIds()).toEqual(['t-1'])
    expect(pendingIds().map((r) => r.task_id)).toEqual(['t-3'])
  })

  it('"Archive all" with no rendered ids archives nothing (never falls back to a fresh read)', async () => {
    await propose(['t-1'])
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    await form(env, cookie, { mode: 'all' })
    expect(archivedIds()).toEqual([])
  })

  it('a decided proposal is never re-run (decision IS NULL is pinned)', async () => {
    await propose(['t-1'])
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const id = String(pendingIds()[0]?.id)
    await form(env, cookie, { mode: 'selected', proposal_id: [id] })
    harness.sqlite.exec(`DELETE FROM tasks_archive_state WHERE task_id = 't-1'`) // restored by an operator since
    const again = await form(env, cookie, { mode: 'selected', proposal_id: [id] })
    expect(await again.text()).toContain('not_pending')
    expect(archivedIds()).toEqual([])
  })

  it('a retitled or touched task is refused (refused_task_changed), the untouched proposal proceeds', async () => {
    await propose(['t-1', 't-2'])
    harness.sqlite.exec(`UPDATE tasks SET title = 'Retitled', updated_at = '2099-01-01T00:00:00.000Z' WHERE id = 't-1'`)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const res = await form(env, cookie, { mode: 'all', rendered_id: pendingIds().map((r) => String(r.id)) })
    expect(await res.text()).toContain('task_changed')
    expect(archivedIds()).toEqual(['t-2'])
    expect(rows(`SELECT decision FROM archive_proposals WHERE task_id = 't-1'`)[0]).toEqual({ decision: 'refused_task_changed' })
  })

  it('an expired proposal (older than 14 days) is not listed, not counted and not archivable', async () => {
    await propose(['t-1'])
    const old = new Date(Date.now() - PROPOSAL_TTL_MS - 60_000).toISOString()
    harness.sqlite.exec(`UPDATE archive_proposals SET created_at = '${old}'`)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    expect(await listPendingProposals(env)).toHaveLength(0)
    expect(await countPendingProposals(env)).toBe(0)
    const id = String(pendingIds()[0]?.id)
    await form(env, cookie, { mode: 'selected', proposal_id: [id] })
    expect(archivedIds()).toEqual([])
  })

  it('the Needs You count and the page use the same rows, oldest first, regardless of the agent-written reason', async () => {
    const env = makeEnv('admin@x.test')
    await invokeTool(agentAuth(), env, 'archive_propose', { task_ids: ['t-1'], reason: 'zzz late' }, ORIGIN)
    harness.sqlite.exec(`UPDATE archive_proposals SET created_at = '${new Date(Date.now() - 1000).toISOString()}'`)
    await invokeTool(agentAuth(), env, 'archive_propose', { task_ids: ['t-2'], reason: '!!! jump the queue' }, ORIGIN)
    const list = await listPendingProposals(env)
    expect(list.map((p) => p.task_id)).toEqual(['t-1', 't-2'])
    expect(await countPendingProposals(env)).toBe(list.length)
  })
})

describe('archive_propose visibility, cap and flag', () => {
  it('a hidden id and a missing id get the same undifferentiated answer; a visible id is proposed', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('S2', 'D1', 's2-sqd', 'Squad Two');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('P1', 'S2', 'admin');
      INSERT INTO tasks (id, squad_id, title, status, done_when, project_id) VALUES ('t-hidden', 'S2', 'Hidden', 'open', 'n/a', 'P1');
    `)
    const res = await propose(['t-hidden', 'does-not-exist', 't-1'])
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const body = JSON.stringify(res)
    expect(body).toContain('"not_proposable":["t-hidden","does-not-exist"]')
    expect(pendingIds().map((r) => r.task_id)).toEqual(['t-1'])
  })

  it('the per-agent pending cap is enforced inside the INSERT', async () => {
    const stmt = harness.sqlite.prepare(`INSERT INTO archive_proposals (id, tenant, task_id, proposed_by_agent_id, reason, evidence, task_status_at_proposal, created_at)
      VALUES (?, '${TENANT}', ?, 'agent-A', 'bulk', '', 'open', ?)`)
    for (let i = 0; i < MAX_PENDING_PER_AGENT - 1; i++) stmt.run(`p-${i}`, `ghost-${i}`, new Date().toISOString())
    const res = await propose(['t-1', 't-2'])
    expect(JSON.stringify(res)).toContain('"proposed":["t-1"]')
    expect(JSON.stringify(res)).toContain('"cap_reached":["t-2"]')
    expect(rows(`SELECT COUNT(*) AS n FROM archive_proposals WHERE decision IS NULL`)[0]).toEqual({ n: MAX_PENDING_PER_AGENT })
  })

  it('refuses up front with not_supported when TASK_ARCHIVE_ENABLED is off', async () => {
    const env = { ...makeEnv('admin@x.test'), TASK_ARCHIVE_ENABLED: undefined } as Env
    const res = await invokeTool(agentAuth(), env, 'archive_propose', { task_ids: ['t-1'], reason: 'x' }, ORIGIN)
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain('not_supported')
    expect(pendingIds()).toHaveLength(0)
  })
})

describe('POST gate: agent-bound session', () => {
  it('an agent-bound caller is refused on the POST and nothing is archived', async () => {
    await propose(['t-1'])
    const agent = agentAuth()
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
    app.use('*', async (c, next) => { c.set('auth', agent); await next() })
    app.route('/', makeBoardCleanupApp((_e, _t, body) => body))
    const res = await app.request('/board/cleanup/archive', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ mode: 'all', rendered_id: String(pendingIds()[0]?.id) }).toString(),
    }, makeEnv('admin@x.test'))
    expect(res.status).toBe(403)
    expect(archivedIds()).toEqual([])
  })
})
