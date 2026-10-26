// Mom-walk flow fixes (dry walk 2026-10-26, points 2/7/8/9): honest designate hint, attached-chat welcome, seat_attach lists choices,
// email-aware signed-out claim resume. Real tools, real migrations, real dashboardApp.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { RECENT_REAUTH_WINDOW_MS } from '../src/auth/web-sessions'
import { dashboardApp } from '../src/dashboard/index'
import { sendClaimWelcome, welcomeBody } from '../src/members/claim-welcome'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const ORIGIN = 'http://localhost'
const COLONY = 'https://colony.example.test'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string, type?: string) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

let h: SqliteD1Harness
function envFor(email: string): Env {
  return {
    TENANT_SLUG: TENANT, BRAND: 'Test Pot', LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: email, SESSIONS: memoryKv(), DB: h.db,
    OAUTH_KV: { get: async () => null, put: async () => undefined }, OAUTH_CLIENT_ID: 'cid', PUBLIC_ORIGIN: COLONY,
    SEAT_ATTACH: '1', SEAT_AUTO_ENROLL: '1', SEAT_ATTACH_DESIGNATED: '1', SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200',
  } as unknown as Env
}
async function login(email: string): Promise<{ env: Env; cookie: string }> {
  const env = envFor(email)
  const res = await authApp.request('/dev-login', {}, env)
  expect(res.status).toBe(302)
  const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  return { env, cookie: `mupot_session=${m[1]}` }
}
const setReauth = (memberId: string, at: string | null) => h.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ? WHERE member_id = ?').run(at, memberId)
const fresh = () => new Date().toISOString()
const stale = () => new Date(Date.now() - (RECENT_REAUTH_WINDOW_MS + 60 * 1000)).toISOString()
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined

const form = (data: Record<string, string>) => ({ 'content-type': 'application/x-www-form-urlencoded' as const, body: new URLSearchParams(data) })
function get(path: string, u: { env: Env; cookie: string }) {
  return dashboardApp.request(path, { headers: { cookie: u.cookie } }, u.env)
}
function post(path: string, u: { env: Env; cookie: string }, data: Record<string, string>) {
  const f = form(data)
  return dashboardApp.request(path, { method: 'POST', headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': f['content-type'] }, body: f.body }, u.env)
}

// ── the chat side: a real OAuth harness grant, a real auto seat, the real seat_attach tool ─────────────────────────
let tokN = 0
async function grant(env: Env, memberId: string): Promise<AuthContext> {
  const harness = await upsertHarness(env, memberId, 'client-chatgpt', 'ChatGPT')
  if (!harness) throw new Error('harness fixture failed')
  const tokenId = `tok-${memberId}-${++tokN}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:client-chatgpt', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  return ctx
}
async function rpc(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown>, session: string): Promise<Record<string, unknown>> {
  const req = new Request('https://pot.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'openai/session': session } } }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as { result?: { structuredContent?: Record<string, unknown> } }
  return body.result?.structuredContent ?? {}
}

let adminEnv: Env
let adminCtx: AuthContext
let momEnv: Env
let momCtx: AuthContext
const bootText = async (env: Env, ctx: AuthContext, session: string): Promise<string> => JSON.stringify(await rpc(env, ctx, 'boot_context', {}, session))

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('S1', 'D1', 's1-sqd', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag1', 'S1', 'ag1', 'Agent One', 'member', 'test', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag2', 'S1', 'ag2', 'Agent Two', 'member', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin', 'admin@x.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-mom', 'mom@x.test', 'Mom', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-mom', 'mem-mom', 'squad', 'S1', 'admin');
    UPDATE agents SET attach_designated_member_id = 'mem-mom' WHERE id = 'ag1';
  `)
  adminEnv = envFor('admin@x.test')
  adminCtx = await grant(adminEnv, 'mem-admin')
  momEnv = envFor('mom@x.test')
  momCtx = await grant(momEnv, 'mem-mom')
})
afterEach(() => h.close())

describe('(a) the designate hint depends on whether the human can press it', () => {
  it('a non-org-admin human is told to ask an org admin, not to press Allow for me', async () => {
    const boot = await bootText(momEnv, momCtx, 'mom-thread')
    expect(boot).toContain('ask an org admin to designate')
    expect(boot).not.toContain("presses 'Allow for me'")
    expect(boot).not.toContain("opens that agent's page and presses")
  })
  it('an org admin still gets the Allow for me instruction', async () => {
    const boot = await bootText(adminEnv, adminCtx, 'admin-thread')
    expect(boot).toContain("presses 'Allow for me'")
    expect(boot).not.toContain('ask an org admin to designate')
  })
  it('seat_attach on an agent the human is not designated for names who can designate (same text for any unknown name: no oracle)', async () => {
    const out = JSON.stringify(await rpc(momEnv, momCtx, 'seat_attach', { agent: 'ag2' }, 'mom-thread'))
    expect(out).toContain('agent_not_found')
    expect(out).toContain('org admin')
    const other = JSON.stringify(await rpc(momEnv, momCtx, 'seat_attach', { agent: 'does-not-exist' }, 'mom-thread'))
    expect(other).toContain('org admin')
  })
})

describe('(b) the claim welcome to an attached chat drops steps that cannot work', () => {
  it('welcomeBody for an attached chat omits squad_choose and the wake card; the default keeps both', () => {
    const attached = welcomeBody('Ada', 'ag1', true)
    expect(attached).not.toContain('Set up wake')
    expect(attached).toContain('do not call squad_choose')
    expect(attached).not.toContain('Call squad_choose when')
    expect(attached).toContain('boot_context')
    const runtime = welcomeBody('Ada', 'ag1')
    expect(runtime).toContain('Call squad_choose when')
    expect(runtime).toContain('Set up wake')
  })
  it('sendClaimWelcome keeps the runtime text when the admission has no live attachment', async () => {
    const out = await rpc(momEnv, momCtx, 'seat_attach', { agent: 'ag1' }, 'mom-thread')
    expect(out.status, JSON.stringify(out)).toBe('pending_admission')
    const adm = h.sqlite.prepare("SELECT id, agent_id, human_member_id FROM agent_seat_admissions WHERE status = 'pending'").get() as { id: string; agent_id: string; human_member_id: string }
    expect(await sendClaimWelcome(momEnv, adm)).toBe('sent')
    const body = (h.sqlite.prepare('SELECT body FROM agent_messages WHERE request_id = ?').get(`welcome:${adm.id}`) as { body: string }).body
    expect(body).toContain('Set up wake')
  })
})

describe('(c) seat_attach with no agent lists the choices', () => {
  it('lists exactly the agents attach would accept, and nothing it would refuse', async () => {
    const out = await rpc(momEnv, momCtx, 'seat_attach', {}, 'mom-thread')
    expect(out.status, JSON.stringify(out)).toBe('choose_agent')
    const agents = out.agents as { id: string; slug: string; name: string }[]
    expect(agents.map((a) => a.id)).toEqual(['ag1'])
    // every listed agent is accepted by the same tool; the unlisted one is refused
    const ok = await rpc(momEnv, momCtx, 'seat_attach', { agent: agents[0]!.id }, 'mom-thread')
    expect(ok.status, JSON.stringify(ok)).toBe('pending_admission')
    expect(JSON.stringify(await rpc(momEnv, momCtx, 'seat_attach', { agent: 'ag2' }, 'mom-thread'))).toContain('agent_not_found')
  })
  it('a human with nothing attachable gets an empty list and a next step, not an error', async () => {
    h.sqlite.exec("UPDATE agents SET attach_designated_member_id = NULL")
    const out = await rpc(momEnv, momCtx, 'seat_attach', {}, 'mom-thread')
    expect(out.status).toBe('no_choices')
    expect(out.agents).toEqual([])
    expect(String(out.note)).toContain('org admin')
  })
  it('a present-but-invalid agent value is refused, not turned into a list', async () => {
    const out = await rpc(momEnv, momCtx, 'seat_attach', { agent: 'x'.repeat(200) }, 'mom-thread')
    expect(out.status).toBeUndefined()
    expect(out.agents).toBeUndefined()
  })
})

describe('(d) signed-out claim resume goes through the chooser, return preserved and validated', () => {
  const claimPath = '/claim/AB-CD'
  const env = (): Env => ({ ...envFor('mom@x.test'), EMAIL_LOGIN_ENABLED: 'true' }) as Env
  it('the claim link redirects to the landing chooser with return, not straight to /auth/login', async () => {
    const res = await dashboardApp.request(claimPath, {}, env())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/?return=${encodeURIComponent(claimPath)}`)
  })
  it('the landing shows Google (carrying return) AND email sign-in, and plants the return cookie', async () => {
    const res = await dashboardApp.request(`/?return=${encodeURIComponent(claimPath)}`, { headers: { accept: 'text/html' } }, env())
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(`/auth/login?return=${encodeURIComponent(claimPath)}`)
    expect(html).toContain('/auth/email/start')
    expect(res.headers.get('set-cookie') ?? '').toContain(`mupot_login_return=${encodeURIComponent(claimPath)}`)
  })
  it('email login is not offered when EMAIL_LOGIN_ENABLED is off', async () => {
    const res = await dashboardApp.request(`/?return=${encodeURIComponent(claimPath)}`, { headers: { accept: 'text/html' } }, envFor('mom@x.test'))
    expect(await res.text()).not.toContain('/auth/email/start')
  })
  it.each(['//evil.example/x', 'https://evil.example/', '/a/../b', '/\\evil', 'javascript:alert(1)'])('an invalid return %s is dropped: no cookie, plain Google link', async (bad) => {
    const res = await dashboardApp.request(`/?return=${encodeURIComponent(bad)}`, { headers: { accept: 'text/html' } }, env())
    const html = await res.text()
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mupot_login_return')
    expect(html).toContain('href="/auth/login"')
    expect(html).not.toContain('evil')
  })
})
