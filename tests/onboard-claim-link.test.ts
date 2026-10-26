// One-click onboarding, claim half: the claim link (/claim/<code>), the agent-page "Own this agent" click, the reissue path and the
// one-redirect sign-in resume. Real dashboardApp, real web sessions (dev-login), real migration chain, the REAL seat_attach /
// boot_context tools to file the pending ask. Designation (the "Allow for me" step) goes through the real POST /agents/:id/designation.
//
// Properties pinned (and the mutation that must break each test is recorded in the PR body):
//   link shows the right agent and claims it; wrong member refused; expired refused + reissue works; single-use; sign-in resumes
//   back to the claim; freshness is still enforced; the link cannot claim a different agent than the one shown.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { RECENT_REAUTH_WINDOW_MS } from '../src/auth/web-sessions'
import { dashboardApp } from '../src/dashboard/index'
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

interface Pending { code: string; url: string; admissionId: string }
let adminEnv: Env
let adminCtx: AuthContext
async function fileAsk(session = 'thread-1'): Promise<Pending> {
  const out = await rpc(adminEnv, adminCtx, 'seat_attach', { agent: 'ag1' }, session)
  expect(out.status, JSON.stringify(out)).toBe('pending_admission')
  const row = one<{ id: string; attach_code: string }>("SELECT id, attach_code FROM agent_seat_admissions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1")
  if (!row) throw new Error('no pending admission')
  return { code: row.attach_code, url: String(out.claim_url), admissionId: row.id }
}
const admStatus = (id: string): string | undefined => one<{ status: string }>('SELECT status FROM agent_seat_admissions WHERE id = ?', id)?.status
const liveAttachments = (): number => Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL')?.n)

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
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-other', 'other@x.test', 'Olive Other', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-other', 'mem-other', 'org', NULL, 'admin');
  `)
  adminEnv = envFor('admin@x.test')
  adminCtx = await grant(adminEnv, 'mem-admin')
  // The human designates themselves through the REAL control (fresh session), so the chat's seat_attach can file a pending ask.
  const a = await login('admin@x.test')
  setReauth('mem-admin', fresh())
  expect((await post('/agents/ag1/designation', a, { action: 'allow' })).status).toBe(303)
})
afterEach(() => h.close())

describe('seat_attach and boot_context hand the agent the claim link', () => {
  it('seat_attach returns claim_url next to the code; boot_context repeats the same pending claim', async () => {
    const p = await fileAsk()
    expect(p.url).toBe(`${COLONY}/claim/${p.code}`)
    const out = await rpc(adminEnv, adminCtx, 'seat_attach', { agent: 'ag1' }, 'thread-1')
    expect(String(out.tell_the_person)).toContain(p.url)
    const b = await rpc(adminEnv, adminCtx, 'boot_context', {}, 'thread-1')
    expect(b.pending_claim).toMatchObject({ claim_url: p.url, attach_code: p.code, agent: 'ag1' })
    expect(String(b.next_step)).toContain(p.url)
  })

  it('once the claim expired, boot_context no longer shows it (no dead link is handed out)', async () => {
    const p = await fileAsk()
    h.sqlite.prepare("UPDATE agent_seat_admissions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(p.admissionId)
    const b = await rpc(adminEnv, adminCtx, 'boot_context', {}, 'thread-1')
    expect(b.pending_claim).toBeUndefined()
  })

  it('another thread (seat) never sees this seat\'s pending claim in its boot_context', async () => {
    await fileAsk('thread-1')
    const b = await rpc(adminEnv, adminCtx, 'boot_context', {}, 'thread-2')
    expect(b.pending_claim).toBeUndefined()
  })
})

describe('GET /claim/:code', () => {
  it('shows the agent, the app, whose sign-in and when, with ONE Confirm button and no field to type in; claims nothing', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await get(`/claim/${p.code}`, a)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Agent One')
    expect(body).toContain('ChatGPT')
    expect(body).toContain('admin@x.test')
    expect(body.match(/>Confirm</g)?.length).toBe(1)
    const formHtml = /<form[^>]*data-claim-confirm[\s\S]*?<\/form>/.exec(body)?.[0] ?? ''
    expect(formHtml).not.toBe('')
    expect([...formHtml.matchAll(/<input[^>]*>/g)].every((m) => /type="hidden"/.test(m[0]))).toBe(true) // nothing to type
    expect(formHtml).not.toMatch(/attach_code/)
    expect(admStatus(p.admissionId)).toBe('pending')
    expect(liveAttachments()).toBe(0)
  })

  it('a code is also accepted without the dash / in lower case', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await get(`/claim/${p.code.replace('-', '').toLowerCase()}`, a)).status).toBe(200)
  })

  it('signed out: one redirect to login that carries the claim path so sign-in resumes back to it', async () => {
    const p = await fileAsk()
    const res = await dashboardApp.request(`/claim/${p.code}`, {}, envFor('admin@x.test'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/auth/login?return=${encodeURIComponent(`/claim/${p.code}`)}`)
  })

  it('/auth/login keeps that return path in its state so the callback lands back on the claim', async () => {
    const p = await fileAsk()
    const env = envFor('admin@x.test')
    const res = await authApp.request(`${COLONY}/login?return=${encodeURIComponent(`/claim/${p.code}`)}`, {}, env)
    expect(res.status).toBe(302)
    const kv = env.SESSIONS as unknown as ReturnType<typeof memoryKv>
    expect([...kv.store.values()].some((v) => v.includes(`"return":"/claim/${p.code}"`))).toBe(true)
  })

  it('a stale session sees the identity but a "Sign in again to confirm" link instead of Confirm', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', stale())
    const body = await (await get(`/claim/${p.code}`, a)).text()
    expect(body).toContain('Agent One')
    expect(body).not.toContain('>Confirm<')
    expect(body).toContain(`/auth/reauth?return=${encodeURIComponent(`/claim/${p.code}`)}`)
  })

  it('/auth/reauth accepts the claim path as its return target and stores it in the state', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    const res = await authApp.request(`${COLONY}/reauth?return=${encodeURIComponent(`/claim/${p.code}`)}`, { headers: { cookie: a.cookie } }, a.env)
    expect(res.status).toBe(302)
    const kv = a.env.SESSIONS as unknown as ReturnType<typeof memoryKv>
    expect([...kv.store.values()].some((v) => v.includes('"reauth":true') && v.includes(`"return":"/claim/${p.code}"`))).toBe(true)
  })

  it('WRONG MEMBER: another member opening the link learns nothing (404, no agent name) and cannot confirm', async () => {
    const p = await fileAsk()
    const o = await login('other@x.test')
    setReauth('mem-other', fresh())
    const res = await get(`/claim/${p.code}`, o)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('Agent One')
    const posted = await post(`/claim/${p.code}`, o, { admission_id: p.admissionId, agent_id: 'ag1' })
    expect(posted.status).toBe(404)
    expect(admStatus(p.admissionId)).toBe('pending')
    expect(liveAttachments()).toBe(0)
  })

  it('an unknown or malformed code is a 404', async () => {
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await get('/claim/ZZ-ZZ', a)).status).toBe(404)
    expect((await get('/claim/not-a-code-at-all', a)).status).toBe(404)
  })
})

describe('POST /claim/:code (Confirm)', () => {
  it('claims the shown agent: admission live, the asking chat attached, redirect to the agent page', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })
    expect(res.status, await res.clone().text()).toBe(303)
    expect(res.headers.get('location')).toBe('/agents/ag1?claimed=1')
    expect(admStatus(p.admissionId)).toBe('live')
    expect(liveAttachments()).toBe(1)
    expect(one<{ agent_id: string }>('SELECT agent_id FROM agent_seat_attachments')?.agent_id).toBe('ag1')
  })

  it('FRESHNESS STILL ENFORCED: a stale session is sent through ONE redirect to reauth that returns to the claim; nothing is claimed', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    for (const at of [stale(), null]) {
      setReauth('mem-admin', at)
      const res = await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe(`/auth/reauth?return=${encodeURIComponent(`/claim/${p.code}`)}`)
    }
    expect(admStatus(p.admissionId)).toBe('pending')
    expect(liveAttachments()).toBe(0)
    // ...and after the sign-in the same page offers the single Confirm, which now works.
    setReauth('mem-admin', fresh())
    expect(await (await get(`/claim/${p.code}`, a)).text()).toContain('>Confirm<')
    expect((await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })).status).toBe(303)
    expect(admStatus(p.admissionId)).toBe('live')
  })

  it('NEVER A DIFFERENT AGENT: a form naming another agent or admission than the code resolves to is refused (claim_changed), still pending', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag2' })).status).toBe(409)
    expect((await post(`/claim/${p.code}`, a, { admission_id: 'some-other-admission', agent_id: 'ag1' })).status).toBe(409)
    expect((await post(`/claim/${p.code}`, a, {})).status).toBe(409)
    expect(admStatus(p.admissionId)).toBe('pending')
    expect(liveAttachments()).toBe(0)
  })

  it('SINGLE USE: a second confirm of the same link is refused and the link page says it was already claimed', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })).status).toBe(303)
    const again = await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })
    expect(again.status).toBe(409)
    expect(liveAttachments()).toBe(1)
    const page = await get(`/claim/${p.code}`, a)
    expect(page.status).toBe(409)
    expect(await page.text()).toContain('already used')
  })

  it('EXPIRED: the link is refused (page and Confirm) and nothing is claimed', async () => {
    const p = await fileAsk()
    h.sqlite.prepare("UPDATE agent_seat_admissions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(p.admissionId)
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const page = await get(`/claim/${p.code}`, a)
    expect(page.status).toBe(409)
    const body = await page.text()
    expect(body).toContain('expired')
    expect(body).not.toContain('>Confirm<')
    expect((await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })).status).toBe(409)
    expect(admStatus(p.admissionId)).not.toBe('live')
    expect(liveAttachments()).toBe(0)
  })

  it('a non-form content type is refused 415 and claims nothing', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await dashboardApp.request(`/claim/${p.code}`, { method: 'POST', headers: { cookie: a.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ admission_id: p.admissionId, agent_id: 'ag1' }) }, a.env)
    expect(res.status).toBe(415)
    expect(admStatus(p.admissionId)).toBe('pending')
  })

  it('a cross-origin or originless POST is refused by csrf(); no session at all claims nothing', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const f = form({ admission_id: p.admissionId, agent_id: 'ag1' })
    expect((await dashboardApp.request(`/claim/${p.code}`, { method: 'POST', headers: { cookie: a.cookie, origin: 'https://evil.test', 'content-type': f['content-type'] }, body: f.body }, a.env)).status).toBe(403)
    expect((await dashboardApp.request(`/claim/${p.code}`, { method: 'POST', headers: { cookie: a.cookie, 'content-type': f['content-type'] }, body: f.body }, a.env)).status).toBe(403)
    expect([302, 401, 403]).toContain((await dashboardApp.request(`/claim/${p.code}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': f['content-type'] }, body: f.body }, a.env)).status)
    expect(admStatus(p.admissionId)).toBe('pending')
  })

  it('un-designating before the click refuses the claim at the human\'s decision (the existing designation re-check still runs)', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    h.sqlite.exec("UPDATE agents SET attach_designated_member_id = NULL WHERE id = 'ag1'") // fixture: simulates Stop racing the link
    const res = await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })
    expect([409, 404]).toContain(res.status)
    expect(liveAttachments()).toBe(0)
  })
})

describe('agent page: "Own this agent" (no code) and "Issue a new claim link"', () => {
  it('owner with a pending claim on THIS agent sees Own this agent with identity and NO code field; one click claims it', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const body = await (await get('/agents/ag1', a)).text()
    expect(body).toContain('data-claim-own')
    expect(body).toContain('ChatGPT')
    expect(body).not.toMatch(/name="attach_code"/)
    const res = await post('/agents/ag1/claim', a, { admission_id: p.admissionId })
    expect(res.status, await res.clone().text()).toBe(303)
    expect(res.headers.get('location')).toBe('/agents/ag1?claimed=1')
    expect(admStatus(p.admissionId)).toBe('live')
    expect(liveAttachments()).toBe(1)
  })

  it('the card is hidden from every other member, and for other agents', async () => {
    await fileAsk()
    const o = await login('other@x.test')
    setReauth('mem-other', fresh())
    expect(await (await get('/agents/ag1', o)).text()).not.toContain('data-claim-own')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect(await (await get('/agents/ag2', a)).text()).not.toContain('data-claim-own')
  })

  it('WRONG MEMBER cannot use the agent-page click even with the real admission id; nothing changes', async () => {
    const p = await fileAsk()
    const o = await login('other@x.test')
    setReauth('mem-other', fresh())
    const res = await post('/agents/ag1/claim', o, { admission_id: p.admissionId })
    expect([404, 409]).toContain(res.status)
    expect(admStatus(p.admissionId)).toBe('pending')
    expect(liveAttachments()).toBe(0)
  })

  it('an admission id that is not one of this member\'s pending asks for this agent is refused even when another IS pending', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await post('/agents/ag1/claim', a, { admission_id: 'forged-admission-id' })
    expect(res.status).toBe(409)
    expect(admStatus(p.admissionId)).toBe('pending')
    expect(liveAttachments()).toBe(0)
  })

  it('an admission id that belongs to a different agent is refused', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await post('/agents/ag2/claim', a, { admission_id: p.admissionId })
    expect([404, 409]).toContain(res.status)
    expect(admStatus(p.admissionId)).toBe('pending')
  })

  it('FRESHNESS STILL ENFORCED: stale -> ONE redirect to reauth returning to the agent page; the page then shows Confirm', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', stale())
    const stalePage = await (await get('/agents/ag1', a)).text()
    expect(stalePage).toContain('Sign in again to own this agent')
    expect(stalePage).not.toContain('class="btn">Own this agent<')
    const res = await post('/agents/ag1/claim', a, { admission_id: p.admissionId })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/auth/reauth?return=${encodeURIComponent('/agents/ag1?resume=claim')}`)
    expect(admStatus(p.admissionId)).toBe('pending')
    setReauth('mem-admin', fresh())
    expect(await (await get('/agents/ag1?resume=claim', a)).text()).toContain('Confirm: own this agent')
  })

  it('EXPIRED: the page offers "Issue a new claim link"; reissue makes a fresh ask for the SAME agent, app and thread; the agent\'s boot_context shows the new link; the old link is dead', async () => {
    const p = await fileAsk()
    h.sqlite.prepare("UPDATE agent_seat_admissions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(p.admissionId)
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const page = await (await get('/agents/ag1', a)).text()
    expect(page).toContain('Issue a new claim link')
    expect(page).not.toContain('data-claim-own')
    const res = await post('/agents/ag1/claim/reissue', a, {})
    expect(res.status, await res.clone().text()).toBe(303)
    const fresh1 = one<{ id: string; attach_code: string; agent_id: string; requested_seat_id: string; harness_id: string; human_member_id: string }>("SELECT id, attach_code, agent_id, requested_seat_id, harness_id, human_member_id FROM agent_seat_admissions WHERE status = 'pending'")
    const old = one<{ requested_seat_id: string; harness_id: string }>('SELECT requested_seat_id, harness_id FROM agent_seat_admissions WHERE id = ?', p.admissionId)
    if (!fresh1 || !old) throw new Error('fixture')
    expect(fresh1.id).not.toBe(p.admissionId)
    expect(fresh1).toMatchObject({ agent_id: 'ag1', human_member_id: 'mem-admin', requested_seat_id: old.requested_seat_id, harness_id: old.harness_id })
    const b = await rpc(adminEnv, adminCtx, 'boot_context', {}, 'thread-1')
    expect(b.pending_claim).toMatchObject({ claim_url: `${COLONY}/claim/${fresh1.attach_code}` })
    // old link refused, new link works
    expect((await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })).status).toBe(409)
    expect((await post(`/claim/${fresh1.attach_code}`, a, { admission_id: fresh1.id, agent_id: 'ag1' })).status).toBe(303)
    expect(admStatus(fresh1.id)).toBe('live')
  })

  it('reissue by another member, or when there is nothing expired, does nothing', async () => {
    const p = await fileAsk()
    const o = await login('other@x.test')
    setReauth('mem-other', fresh())
    expect((await post('/agents/ag1/claim/reissue', o, {})).status).toBe(409)
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post('/agents/ag1/claim/reissue', a, {})).status).toBe(409) // still pending, not expired
    expect(Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM agent_seat_admissions')?.n)).toBe(1)
    expect(admStatus(p.admissionId)).toBe('pending')
  })

  it('reissue does not revive a thread that has since attached to another agent', async () => {
    const p = await fileAsk()
    h.sqlite.prepare("UPDATE agent_seat_admissions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(p.admissionId)
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post('/agents/ag2/designation', a, { action: 'allow' })).status).toBe(303)
    const out = await rpc(adminEnv, adminCtx, 'seat_attach', { agent: 'ag2' }, 'thread-1')
    expect(out.status).toBe('pending_admission')
    const code2 = String(out.attach_code)
    const adm2 = one<{ id: string }>("SELECT id FROM agent_seat_admissions WHERE agent_id = 'ag2' AND status = 'pending'")!.id
    expect((await post(`/claim/${code2}`, a, { admission_id: adm2, agent_id: 'ag2' })).status).toBe(303)
    expect(liveAttachments()).toBe(1)
    expect(await (await get('/agents/ag1', a)).text()).not.toContain('data-claim-reissue')
    expect((await post('/agents/ag1/claim/reissue', a, {})).status).toBe(409)
  })

  it('reissue does not revive a thread that has since been retired', async () => {
    const p = await fileAsk()
    h.sqlite.prepare("UPDATE agent_seat_admissions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(p.admissionId)
    const seat = one<{ requested_seat_id: string }>('SELECT requested_seat_id FROM agent_seat_admissions WHERE id = ?', p.admissionId)?.requested_seat_id
    h.sqlite.prepare("UPDATE agent_seats SET retired_at = '2026-10-10T00:00:00.000Z' WHERE id = ?").run(seat)
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post('/agents/ag1/claim/reissue', a, {})).status).toBe(409)
    expect(Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_seat_admissions WHERE status = 'pending'")?.n)).toBe(1) // only the (expired-by-clock) original
  })
})

describe('"Allow for me" no longer dead-ends on a stale sign-in', () => {
  it('stale: ONE redirect to reauth returning to the agent page with resume=allow; no write; fresh page shows the single Confirm', async () => {
    h.sqlite.exec("UPDATE agents SET attach_designated_member_id = NULL WHERE id = 'ag2'")
    const a = await login('admin@x.test')
    setReauth('mem-admin', stale())
    const res = await post('/agents/ag2/designation', a, { action: 'allow' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/auth/reauth?return=${encodeURIComponent('/agents/ag2?resume=allow')}`)
    expect(one<{ d: string | null }>("SELECT attach_designated_member_id AS d FROM agents WHERE id = 'ag2'")?.d).toBeNull()
    setReauth('mem-admin', fresh())
    expect(await (await get('/agents/ag2?resume=allow', a)).text()).toContain('Confirm: Allow for me')
    expect((await post('/agents/ag2/designation', a, { action: 'allow' })).status).toBe(303)
    expect(one<{ d: string | null }>("SELECT attach_designated_member_id AS d FROM agents WHERE id = 'ag2'")?.d).toBe('mem-admin')
  })
})

describe('Codex/gate round: honest outcome when the chat cannot be attached; resolved id in the redirect', () => {
  const retireSeat = (admissionId: string) => {
    const seat = one<{ requested_seat_id: string }>('SELECT requested_seat_id FROM agent_seat_admissions WHERE id = ?', admissionId)?.requested_seat_id
    h.sqlite.prepare("UPDATE agent_seats SET retired_at = '2026-10-10T00:00:00.000Z' WHERE id = ?").run(seat)
  }

  it('link: the thread was retired before Confirm -> admission live but the result says NOT attached (claimed=partial), never "Claimed"', async () => {
    const p = await fileAsk()
    retireSeat(p.admissionId)
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/agents/ag1?claimed=partial')
    expect(liveAttachments()).toBe(0)
    const page = await (await get('/agents/ag1?claimed=partial', a)).text()
    expect(page).toContain('not attached yet')
    expect(page).not.toContain('The chat is now acting as')
  })

  it('agent-page click: same honesty when the thread is gone', async () => {
    const p = await fileAsk()
    retireSeat(p.admissionId)
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await post('/agents/ag1/claim', a, { admission_id: p.admissionId })
    expect(res.headers.get('location')).toBe('/agents/ag1?claimed=partial')
  })

  it('the thread already attached to ANOTHER agent via a different admission: the second claim is partial (outcome is per admission)', async () => {
    const p1 = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post('/agents/ag2/designation', a, { action: 'allow' })).status).toBe(303)
    const out = await rpc(adminEnv, adminCtx, 'seat_attach', { agent: 'ag2' }, 'thread-1')
    const adm2 = one<{ id: string }>("SELECT id FROM agent_seat_admissions WHERE agent_id = 'ag2'")!.id
    expect((await post(`/claim/${String(out.attach_code)}`, a, { admission_id: adm2, agent_id: 'ag2' })).headers.get('location')).toBe('/agents/ag2?claimed=1')
    const res = await post(`/claim/${p1.code}`, a, { admission_id: p1.admissionId, agent_id: 'ag1' })
    expect(res.headers.get('location')).toBe('/agents/ag1?claimed=partial')
    expect(liveAttachments()).toBe(1)
  })

  it('a normal claim still says attached (claimed=1) and the page says the chat is acting', async () => {
    const p = await fileAsk()
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(`/claim/${p.code}`, a, { admission_id: p.admissionId, agent_id: 'ag1' })).headers.get('location')).toBe('/agents/ag1?claimed=1')
    expect(await (await get('/agents/ag1?claimed=1', a)).text()).toContain('The chat is now acting as')
  })

  it('Allow for me, stale: the return path carries the DB-resolved agent id even when addressed by slug', async () => {
    h.sqlite.exec("INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agid-xyz', 'S1', 'myslug', 'Slugged', 'member', 'test', 'active')")
    const a = await login('admin@x.test')
    setReauth('mem-admin', stale())
    const res = await post('/agents/myslug/designation', a, { action: 'allow' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/auth/reauth?return=${encodeURIComponent('/agents/agid-xyz?resume=allow')}`)
  })
})
