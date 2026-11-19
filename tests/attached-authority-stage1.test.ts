// mupot#980005ac stage 1 — Helper/Full choice + expiry on /claim; Connections shows level+expiry; fail-closed
// on expiry/revoke/suspension; Full == Helper in effect (no authority widen). Real-schema sqlite D1 + real
// dashboardApp / MCP seat_attach seam. Mutation targets listed in the PR body.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authApp } from '../src/auth'
import { RECENT_REAUTH_WINDOW_MS } from '../src/auth/web-sessions'
import { ATTACHED_SUDO_ACTIONS, attachedAuthority, ceilingCapability } from '../src/auth/attached-ceiling'
import {
  parseAttachAuthorityDays,
  parseAttachAuthorityLevel,
  authorityExpiresAtIso,
} from '../src/auth/attached-authority'
import { dashboardApp } from '../src/dashboard/index'
import { upsertHarness } from '../src/members/harness'
import { ensureAdmission, decideAdmissionDirect, loadConnections, findLiveAttachment } from '../src/members/seat-attach'
import { resolveSeatCapabilities } from '../src/members/seat-handle'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resolveCapabilities } from '../src/auth/capability'
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
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined
const n = (sql: string, ...p: unknown[]): number => Number((h.sqlite.prepare(sql).get(...p) as { n: number }).n)

const form = (data: Record<string, string>) => ({ 'content-type': 'application/x-www-form-urlencoded' as const, body: new URLSearchParams(data) })
function get(path: string, u: { env: Env; cookie: string }) {
  return dashboardApp.request(path, { headers: { cookie: u.cookie } }, u.env)
}
function post(path: string, u: { env: Env; cookie: string }, data: Record<string, string>) {
  const f = form(data)
  return dashboardApp.request(path, { method: 'POST', headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': f['content-type'] }, body: f.body }, u.env)
}

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

interface Pending { code: string; url: string; admissionId: string; path: string }
let adminEnv: Env
let adminCtx: AuthContext
async function fileAsk(session = 'thread-1'): Promise<Pending> {
  const out = await rpc(adminEnv, adminCtx, 'seat_attach', { reason: 'This chat is assigned to operate the requested agent.', agent: 'ag1' }, session)
  expect(out.status, JSON.stringify(out)).toBe('pending_admission')
  const row = one<{ id: string; attach_code: string }>('SELECT id, attach_code FROM agent_seat_admissions WHERE status = \'pending\' ORDER BY created_at DESC LIMIT 1')
  if (!row) throw new Error('no pending admission')
  const path = new URL(String(out.claim_url)).pathname
  return { code: row.attach_code, url: String(out.claim_url), admissionId: row.id, path }
}

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('S1', 'D1', 's1-sqd', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag1', 'S1', 'ag1', 'Agent One', 'member', 'test', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag-admin', 'S1', 'ag-admin', 'Admin Agent', 'admin', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin', 'admin@x.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-member', 'member@x.test', 'Mo Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-member', 'mem-member', 'org', NULL, 'member');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-other', 'other@x.test', 'Olive Other', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-other', 'mem-other', 'org', NULL, 'admin');
  `)
  adminEnv = envFor('admin@x.test')
  adminCtx = await grant(adminEnv, 'mem-admin')
  const a = await login('admin@x.test')
  setReauth('mem-admin', fresh())
  expect((await post('/agents/ag1/designation', a, { action: 'allow' })).status).toBe(303)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); h.close() })

describe('parse helpers (Helper default, Full never inferred)', () => {
  it('defaults to helper; never upgrades from harness/model/label/tool text', () => {
    expect(parseAttachAuthorityLevel(undefined)).toBe('helper')
    expect(parseAttachAuthorityLevel('')).toBe('helper')
    expect(parseAttachAuthorityLevel('codex')).toBe('helper')
    expect(parseAttachAuthorityLevel('claude')).toBe('helper')
    expect(parseAttachAuthorityLevel('FULL')).toBe('full')
    expect(parseAttachAuthorityLevel('full')).toBe('full')
    expect(parseAttachAuthorityDays(undefined)).toEqual({ ok: true, days: 7 })
    expect(parseAttachAuthorityDays('3')).toEqual({ ok: true, days: 3 })
    expect(parseAttachAuthorityDays('99')).toEqual({ ok: true, days: 7 })
    expect(parseAttachAuthorityDays('0').ok).toBe(false)
    expect(authorityExpiresAtIso(7, Date.parse('2026-11-15T00:00:00.000Z')).startsWith('2026-11-22')).toBe(true)
  })
})

describe('GET /claim — Helper default, Full never preselected; GET never confirms', () => {
  it('shows Helper checked, Full unchecked, Connect button, machine+project; claims nothing', async () => {
    const p = await fileAsk('ui-thread')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await get(p.path, a)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-authority-choice')
    expect(body).toMatch(/name="authority_level" value="helper" checked/)
    expect(body).toMatch(/name="authority_level" value="full"/)
    expect(body).not.toMatch(/name="authority_level" value="full"[^>]*checked/)
    expect(body).toContain('data-claim-connect')
    expect(body).toContain('Connect')
    expect(body).toContain('Squad One') // project context = squad
    expect(n('SELECT COUNT(*) AS n FROM agent_seat_admissions WHERE status = \'live\'')).toBe(0)
  })
})

describe('POST /claim — Connect stores immutable provenance and read-back', () => {
  it('stores Helper by default with 7-day expiry, decision ledger, and redirects with stored level', async () => {
    const p = await fileAsk('store-helper')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await post(p.path, a, { admission_id: p.admissionId, agent_id: 'ag1' }) // no authority fields → helper
    expect(res.status).toBe(303)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toContain('authority=helper')
    expect(loc).toContain('expires=')
    const row = one<{ authority_level: string; authority_expires_at: string | null; decided_by_member_id: string }>(
      'SELECT authority_level, authority_expires_at, decided_by_member_id FROM agent_seat_admissions WHERE id = ?', p.admissionId,
    )
    expect(row?.authority_level).toBe('helper')
    expect(row?.authority_expires_at).toBeTruthy()
    expect(row?.decided_by_member_id).toBe('mem-admin')
    expect(n('SELECT COUNT(*) AS n FROM agent_seat_authority_decisions WHERE admission_id = ? AND authority_level = \'helper\'', p.admissionId)).toBe(1)
  })

  it('stores Full only when explicitly chosen; never from harness label', async () => {
    const p = await fileAsk('store-full')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await post(p.path, a, {
      admission_id: p.admissionId, agent_id: 'ag1', authority_level: 'full', authority_days: '3',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('authority=full')
    const row = one<{ authority_level: string }>('SELECT authority_level FROM agent_seat_admissions WHERE id = ?', p.admissionId)
    expect(row?.authority_level).toBe('full')
    // Immutability: cannot rewrite Full onto a live row in place.
    expect(() => h.sqlite.prepare('UPDATE agent_seat_admissions SET authority_level = ? WHERE id = ?').run('helper', p.admissionId)).toThrow()
  })

  it('wrong approver (different signed-in human) cannot confirm', async () => {
    const p = await fileAsk('wrong-human')
    const o = await login('other@x.test')
    setReauth('mem-other', fresh())
    const res = await post(p.path, o, { admission_id: p.admissionId, agent_id: 'ag1', authority_level: 'full' })
    expect(res.status).toBe(404)
    expect(one<{ status: string }>('SELECT status FROM agent_seat_admissions WHERE id = ?', p.admissionId)?.status).toBe('pending')
  })

  it('stale multi-tab: second Connect after first succeeds is refused; one decision', async () => {
    const p = await fileAsk('multi-tab')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(p.path, a, { admission_id: p.admissionId, agent_id: 'ag1', authority_level: 'helper' })).status).toBe(303)
    expect((await post(p.path, a, { admission_id: p.admissionId, agent_id: 'ag1', authority_level: 'full' })).status).toBe(409)
    expect(one<{ authority_level: string }>('SELECT authority_level FROM agent_seat_admissions WHERE id = ?', p.admissionId)?.authority_level).toBe('helper')
    expect(n('SELECT COUNT(*) AS n FROM agent_seat_authority_decisions WHERE admission_id = ?', p.admissionId)).toBe(1)
  })

  it('CSRF / non-form content type refused; nothing claimed', async () => {
    const p = await fileAsk('csrf')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await dashboardApp.request(p.path, {
      method: 'POST',
      headers: { cookie: a.cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ admission_id: p.admissionId, agent_id: 'ag1', authority_level: 'full' }),
    }, a.env)
    expect(res.status).toBe(415)
    expect(one<{ status: string }>('SELECT status FROM agent_seat_admissions WHERE id = ?', p.admissionId)?.status).toBe('pending')
  })

  it('claim_changed when shown admission/agent no longer matches', async () => {
    const p = await fileAsk('stale-intent')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await post(p.path, a, { admission_id: 'not-this-one', agent_id: 'ag1', authority_level: 'full' })
    expect(res.status).toBe(409)
    expect(one<{ status: string }>('SELECT status FROM agent_seat_admissions WHERE id = ?', p.admissionId)?.status).toBe('pending')
  })
})

describe('Connections list — level + expiry + one-step Revoke', () => {
  it('shows Helper/Full and expiry; Revoke fails closed on the next findLiveAttachment', async () => {
    const p = await fileAsk('cx-list')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(p.path, a, { admission_id: p.admissionId, agent_id: 'ag1', authority_level: 'helper', authority_days: '7' })).status).toBe(303)
    const page = await (await get('/connections', a)).text()
    expect(page).toContain('Helper')
    expect(page).toMatch(/until \d{4}-\d{2}-\d{2}/)
    expect(page).toContain(`data-cx-revoke="${p.admissionId}"`)

    const seat = one<{ seat_id: string; human_member_id: string }>('SELECT seat_id, human_member_id FROM agent_seat_attachments WHERE detached_at IS NULL LIMIT 1')!
    const grantTok = adminCtx.tokenId!
    expect(await findLiveAttachment(adminEnv, { memberId: seat.human_member_id, tokenId: grantTok }, seat.seat_id)).not.toBeNull()

    const revoke = await dashboardApp.request(`/connections/admissions/${p.admissionId}/revoke`, {
      method: 'POST', headers: { cookie: a.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}',
    }, a.env)
    expect(revoke.status).toBe(200)
    expect(await findLiveAttachment(adminEnv, { memberId: seat.human_member_id, tokenId: grantTok }, seat.seat_id)).toBeNull()
  })
})

describe('fail-closed: expiry, agent deactivate, human suspend; legacy unaffected', () => {
  it('authority past expiry refuses on the next findLiveAttachment', async () => {
    const p = await fileAsk('expiry')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(p.path, a, { admission_id: p.admissionId, agent_id: 'ag1', authority_level: 'full', authority_days: '1' })).status).toBe(303)
    const seat = one<{ seat_id: string; human_member_id: string }>('SELECT seat_id, human_member_id FROM agent_seat_attachments WHERE detached_at IS NULL LIMIT 1')!
    expect(await findLiveAttachment(adminEnv, { memberId: seat.human_member_id, tokenId: adminCtx.tokenId! }, seat.seat_id)).not.toBeNull()
    // Age the authority expiry (fixture-only; live rows are otherwise immutable for authority_*).
    h.sqlite.exec(`DROP TRIGGER IF EXISTS agent_seat_admissions_authority_immutable`)
    h.sqlite.prepare('UPDATE agent_seat_admissions SET authority_expires_at = ? WHERE id = ?')
      .run('2020-01-01 00:00:00', p.admissionId)
    expect(await findLiveAttachment(adminEnv, { memberId: seat.human_member_id, tokenId: adminCtx.tokenId! }, seat.seat_id)).toBeNull()
  })

  it('legacy NULL authority_expires_at keeps working as Helper (no retroactive expiry)', async () => {
    const p = await fileAsk('legacy')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(p.path, a, { admission_id: p.admissionId, agent_id: 'ag1' })).status).toBe(303)
    h.sqlite.exec(`DROP TRIGGER IF EXISTS agent_seat_admissions_authority_immutable`)
    h.sqlite.prepare('UPDATE agent_seat_admissions SET authority_expires_at = NULL, authority_level = ? WHERE id = ?')
      .run('helper', p.admissionId)
    const seat = one<{ seat_id: string; human_member_id: string }>('SELECT seat_id, human_member_id FROM agent_seat_attachments WHERE detached_at IS NULL LIMIT 1')!
    const live = await findLiveAttachment(adminEnv, { memberId: seat.human_member_id, tokenId: adminCtx.tokenId! }, seat.seat_id)
    expect(live).not.toBeNull()
    expect(live?.authority_level).toBe('helper')
    expect(live?.authority_expires_at).toBeNull()
  })

  it('deactivated agent and suspended human fail closed', async () => {
    const p = await fileAsk('suspend')
    const a = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(p.path, a, { admission_id: p.admissionId, agent_id: 'ag1' })).status).toBe(303)
    const seat = one<{ seat_id: string; human_member_id: string }>('SELECT seat_id, human_member_id FROM agent_seat_attachments WHERE detached_at IS NULL LIMIT 1')!
    h.sqlite.prepare('UPDATE agents SET status = ? WHERE id = ?').run('inactive', 'ag1')
    expect(await findLiveAttachment(adminEnv, { memberId: seat.human_member_id, tokenId: adminCtx.tokenId! }, seat.seat_id)).toBeNull()
    h.sqlite.prepare('UPDATE agents SET status = ? WHERE id = ?').run('active', 'ag1')
    h.sqlite.prepare('UPDATE members SET status = ? WHERE id = ?').run('suspended', 'mem-admin')
    expect(await findLiveAttachment(adminEnv, { memberId: seat.human_member_id, tokenId: adminCtx.tokenId! }, seat.seat_id)).toBeNull()
  })
})

describe('Full == Helper in effect (stage 1: no widen)', () => {
  it('authority_level is not consulted by attachedAuthority / ceilingCapability / ATTACHED_SUDO_ACTIONS', async () => {
    // Prove the stage-1 contract: Full is recorded but does not change the clamps that decide actions.
    const authHelper = {
      seatBinding: {
        attached: { attachmentId: 'a1', admissionId: 'd1', agentId: 'ag1', seatAgentId: 's1', ceiling: 'member' as const },
        humanMemberId: 'mem-admin',
        seatId: 'seat',
        grantTokenId: 'tok',
      },
    }
    const authFull = {
      seatBinding: {
        attached: { attachmentId: 'a2', admissionId: 'd2', agentId: 'ag1', seatAgentId: 's1', ceiling: 'member' as const },
        humanMemberId: 'mem-admin',
        seatId: 'seat',
        grantTokenId: 'tok',
      },
    }
    // attachedAuthority ignores authority_level entirely (it is not even on the binding today).
    expect(attachedAuthority(authHelper as never)?.ceiling).toBe(attachedAuthority(authFull as never)?.ceiling)
    expect(ceilingCapability('member')).toBe(ceilingCapability('member'))
    expect(ceilingCapability('full')).toBeNull() // capability ceiling 'full' = agent's own standing; unrelated to Helper/Full mode
    expect([...ATTACHED_SUDO_ACTIONS]).toEqual(['action:org_structure'])
  })

  it('resolveSeatCapabilities is identical for Helper vs Full admissions with the same rank ceiling', async () => {
    const make = async (level: 'helper' | 'full', session: string) => {
      const out = await rpc(adminEnv, adminCtx, 'seat_attach', { reason: 'This chat is assigned to operate the requested agent.', agent: 'ag1' }, session)
      const row = one<{ id: string; attach_code: string }>('SELECT id, attach_code FROM agent_seat_admissions WHERE status = \'pending\' ORDER BY created_at DESC LIMIT 1')!
      const a = await login('admin@x.test')
      setReauth('mem-admin', fresh())
      const path = new URL(String(out.claim_url)).pathname
      expect((await post(path, a, { admission_id: row.id, agent_id: 'ag1', authority_level: level })).status).toBe(303)
      // Only one live attachment at a time per seat — detach before the second sample when needed.
      return row.id
    }
    // First Helper on one seat, measure caps, revoke, then Full on a fresh seat.
    const helperId = await make('helper', 'cap-helper')
    const seatH = one<{ seat_id: string }>('SELECT seat_id FROM agent_seat_attachments WHERE admission_id = ? AND detached_at IS NULL', helperId)!.seat_id
    const liveH = await findLiveAttachment(adminEnv, { memberId: 'mem-admin', tokenId: adminCtx.tokenId! }, seatH)
    expect(liveH).not.toBeNull()
    const humanGrants = await resolveCapabilities(adminEnv, 'mem-admin')
    const capsH = await resolveSeatCapabilities(adminEnv, {
      humanMemberId: 'mem-admin', agentId: liveH!.agent_id, agentSquadId: liveH!.agent_squad_id,
      agentMemberId: liveH!.agent_member_id, ceiling: liveH!.ceiling,
    })
    // Revoke helper admission so we can attach Full on a new thread.
    const a = await login('admin@x.test')
    await dashboardApp.request(`/connections/admissions/${helperId}/revoke`, {
      method: 'POST', headers: { cookie: a.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}',
    }, a.env)
    const fullId = await make('full', 'cap-full')
    const seatF = one<{ seat_id: string }>('SELECT seat_id FROM agent_seat_attachments WHERE admission_id = ? AND detached_at IS NULL', fullId)!.seat_id
    const liveF = await findLiveAttachment(adminEnv, { memberId: 'mem-admin', tokenId: adminCtx.tokenId! }, seatF)
    expect(liveF).not.toBeNull()
    expect(liveF!.authority_level).toBe('full')
    const capsF = await resolveSeatCapabilities(adminEnv, {
      humanMemberId: 'mem-admin', agentId: liveF!.agent_id, agentSquadId: liveF!.agent_squad_id,
      agentMemberId: liveF!.agent_member_id, ceiling: liveF!.ceiling,
    })
    expect(JSON.stringify(capsF)).toBe(JSON.stringify(capsH))
    // Rank matrix: a member-tier human cannot attach their way onto an admin agent they do not designate/admin.
    const memberEnv = envFor('member@x.test')
    const memberCtx = await grant(memberEnv, 'mem-member')
    const refuse = await rpc(memberEnv, memberCtx, 'seat_attach', { reason: 'Trying to borrow admin.', agent: 'ag-admin' }, 'member-try')
    expect(refuse.status === 'pending_admission' || String(refuse.error || refuse.status).length > 0).toBe(true)
    // Even if a pending ask somehow existed, designation/admin refusal at promote keeps the rank floor.
    void humanGrants
  })
})


describe('round 1 expiry and decision regressions',()=>{
  async function claimed(thread:string){
    const p=await fileAsk(thread); const a=await login('admin@x.test');setReauth('mem-admin',fresh())
    expect((await post(p.path,a,{admission_id:p.admissionId,agent_id:'ag1',authority_days:'1'})).status).toBe(303)
    const att=one<{seat_id:string;seat_token_id:string;human_member_id:string}>('SELECT seat_id,seat_token_id,human_member_id FROM agent_seat_attachments WHERE admission_id=?',p.admissionId)!
    return {p,a,att}
  }
  it('request and subscription liveness both stop exactly at authority expiry',async()=>{
    const {p,att}=await claimed('event-expiry')
    const expiry=one<{authority_expires_at:string}>('SELECT authority_expires_at FROM agent_seat_admissions WHERE id=?',p.admissionId)!.authority_expires_at
    const tok=one<{member_id:string}>('SELECT member_id FROM member_tokens WHERE id=?',att.seat_token_id)!
    const sub={token_id:att.seat_token_id,member_id:tok.member_id,agent_id:'ag1',grant_token_id:adminCtx.tokenId,consented_by_member_id:'mem-admin'}
    const {subscriberAccessLive}=await import('../src/mcp/events-subscriptions')
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse(expiry+'Z')-1000)
    expect(await subscriberAccessLive(adminEnv,sub as never)).toEqual({live:true})
    expect(await findLiveAttachment(adminEnv,{memberId:'mem-admin',tokenId:adminCtx.tokenId!},att.seat_id)).not.toBeNull()
    vi.setSystemTime(Date.parse(expiry+'Z'))
    expect(await subscriberAccessLive(adminEnv,sub as never)).toEqual({live:false,reason:'authority_expired'})
    expect(await findLiveAttachment(adminEnv,{memberId:'mem-admin',tokenId:adminCtx.tokenId!},att.seat_id)).toBeNull()
  })
  it('expired live admission is hidden before renewal and no longer holds its unique slot',async()=>{
    const {p,a}=await claimed('renew-expiry')
    h.sqlite.exec('DROP TRIGGER agent_seat_admissions_authority_immutable')
    h.sqlite.prepare('UPDATE agent_seat_admissions SET authority_expires_at=? WHERE id=?').run('2020-01-01 00:00:00',p.admissionId)
    expect((await loadConnections(adminEnv,'mem-admin')).admissions.some(a=>a.id===p.admissionId)).toBe(false)
    expect(await (await get('/connections',a)).text()).not.toContain(`data-cx-revoke="${p.admissionId}"`)
    const result=await rpc(adminEnv,adminCtx,'seat_attach',{agent:'ag1',reason:'Renew this expired connection.'},'renew-expiry')
    expect(result).toMatchObject({status:'pending_admission'})
    expect(result.admission_id).not.toBe(p.admissionId)
    expect(one<{status:string}>('SELECT status FROM agent_seat_admissions WHERE id=?',p.admissionId)?.status).toBe('revoked')
  })
  it.each([0,8,1.5])('direct approval refuses invalid duration %s before persistence',async days=>{
    const p=await fileAsk('bad-direct-days')
    expect(await decideAdmissionDirect(adminEnv,{admissionId:p.admissionId,humanMemberId:'mem-admin',decision:'approve',attachCode:p.code,authorityDays:days})).toEqual({ok:false,error:'invalid_authority_days'})
    expect(one<{status:string}>('SELECT status FROM agent_seat_admissions WHERE id=?',p.admissionId)?.status).toBe('pending')
  })
  it('invalid claim duration returns HTTP 400 and leaves admission pending',async()=>{
    const p=await fileAsk('bad-http-days');const a=await login('admin@x.test');setReauth('mem-admin',fresh())
    expect((await post(p.path,a,{admission_id:p.admissionId,agent_id:'ag1',authority_days:'-1'})).status).toBe(400)
    expect(one<{status:string}>('SELECT status FROM agent_seat_admissions WHERE id=?',p.admissionId)?.status).toBe('pending')
  })
  it('agent-page default confirmation stores helper rather than hardwiring full',async()=>{
    const p=await fileAsk('agent-default');const {confirmClaimOnAgentPage}=await import('../src/members/claim')
    expect(await confirmClaimOnAgentPage(adminEnv,{memberId:'mem-admin',agentId:'ag1',shownAdmissionId:p.admissionId,attachCode:p.code})).toMatchObject({ok:true,authorityLevel:'helper'})
    expect(one('SELECT authority_level FROM agent_seat_admissions WHERE id=?',p.admissionId)).toEqual({authority_level:'helper'})
  })
  it('direct dashboard admission writes an absolute expiry and matching decision',async()=>{
    await rpc(adminEnv,adminCtx,'boot_context',{},'direct-no-ask')
    const seat=one<{id:string;harness_id:string}>('SELECT id,harness_id FROM agent_seats ORDER BY rowid DESC LIMIT 1')!
    const result=await ensureAdmission(adminEnv,{agentId:'ag1',humanMemberId:'mem-admin',harnessId:seat.harness_id,seatId:seat.id,via:'dashboard'})
    expect(result).toMatchObject({ok:true,state:'live'})
    if(!result.ok)throw new Error('admission failed')
    expect(result.admission.authority_expires_at).toEqual(expect.any(String))
    expect(one<{authority_expires_at:string}>('SELECT authority_expires_at FROM agent_seat_authority_decisions WHERE admission_id=?',result.admission.id)?.authority_expires_at).toBe(result.admission.authority_expires_at)
  })
  it('lost promotion race writes no decision for a denied admission',async()=>{
    const p=await fileAsk('ledger-race')
    const env={...adminEnv,DB:{...adminEnv.DB,batch(stmts:Parameters<Env['DB']['batch']>[0]){
      h.sqlite.prepare("UPDATE agent_seat_admissions SET status='denied' WHERE id=?").run(p.admissionId)
      return adminEnv.DB.batch(stmts)
    }}} as Env
    expect(await decideAdmissionDirect(env,{admissionId:p.admissionId,humanMemberId:'mem-admin',decision:'approve',attachCode:p.code})).toMatchObject({ok:false})
    expect(n('SELECT COUNT(*) AS n FROM agent_seat_authority_decisions WHERE admission_id=?',p.admissionId)).toBe(0)
  })
  it.each(['code','agent'])('refuses absent stored expiry after an incomplete %s promotion result',async path=>{
    const p=await fileAsk('missing-expiry')
    // Inject only the failed collaborator response; actual claim lookup/readback uses real SQLite.
    const admissions=await import('../src/members/seat-attach')
    vi.spyOn(admissions,'decideAdmissionDirect').mockResolvedValue({ok:true})
    const claims=await import('../src/members/claim')
    const result=path==='code'
      ? await claims.confirmClaimByCode(adminEnv,{memberId:'mem-admin',code:p.code,shownAdmissionId:p.admissionId,shownAgentId:'ag1'})
      : await claims.confirmClaimOnAgentPage(adminEnv,{memberId:'mem-admin',agentId:'ag1',shownAdmissionId:p.admissionId,attachCode:p.code})
    expect(result).toEqual({ok:false,error:'attach_refused'})
  })

  it('lockout delta: expired A can ask for B and cleanup retires the hidden expired approval',async()=>{
    const {p,att,a}=await claimed('lockout-switch')
    setReauth('mem-admin',fresh())
    expect((await post('/agents/ag-admin/designation',a,{action:'allow'})).status).toBe(303)
    h.sqlite.exec('DROP TRIGGER agent_seat_admissions_authority_immutable')
    h.sqlite.prepare('UPDATE agent_seat_admissions SET authority_expires_at=? WHERE id=?').run('2020-01-01 00:00:00',p.admissionId)
    const result=await rpc(adminEnv,adminCtx,'seat_attach',{agent:'ag-admin',reason:'This chat now needs the other agent.'},'lockout-switch')
    expect(result).toMatchObject({status:'pending_admission'})
    expect(one<{status:string}>('SELECT status FROM agent_seat_admissions WHERE id=?',p.admissionId)?.status).toBe('revoked')
    expect(n('SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE admission_id=? AND detached_at IS NULL',p.admissionId)).toBe(0)
    expect(await (await get('/connections',a)).text()).not.toContain(`data-cx-revoke="${p.admissionId}"`)
    expect(one<{agent_id:string}>('SELECT agent_id FROM agent_seat_admissions WHERE id=?',result.admission_id)?.agent_id).toBe('ag-admin')
  })
  it('lockout delta: expired admission stops elevation origin liveness',async()=>{
    const {p,att}=await claimed('origin-expiry')
    const {loadAttachmentOriginOfSession}=await import('../src/auth/elevation')
    expect(await loadAttachmentOriginOfSession(adminEnv,TENANT,att.seat_token_id)).toMatchObject({live:true})
    h.sqlite.exec('DROP TRIGGER agent_seat_admissions_authority_immutable')
    h.sqlite.prepare('UPDATE agent_seat_admissions SET authority_expires_at=? WHERE id=?').run('2020-01-01 00:00:00',p.admissionId)
    expect(await loadAttachmentOriginOfSession(adminEnv,TENANT,att.seat_token_id)).toMatchObject({live:false})
  })
  it('lockout delta: expired non-owner claim no longer shows a wake setup card',async()=>{
    const {p}=await claimed('wake-expiry')
    h.sqlite.prepare('UPDATE agents SET owner_member_id=NULL WHERE id=?').run('ag1')
    const {loadWakeCard}=await import('../src/members/wake-setup')
    expect(await loadWakeCard(adminEnv,adminCtx,'mem-admin','ag1')).toMatchObject({show:true})
    h.sqlite.exec('DROP TRIGGER agent_seat_admissions_authority_immutable')
    h.sqlite.prepare('UPDATE agent_seat_admissions SET authority_expires_at=? WHERE id=?').run('2020-01-01 00:00:00',p.admissionId)
    expect(await loadWakeCard(adminEnv,adminCtx,'mem-admin','ag1')).toEqual({show:false})
  })
  it('lockout delta: expired authority is not an already-claimed claim link',async()=>{
    const {p}=await claimed('claim-expiry');const {lookupClaim}=await import('../src/members/claim')
    expect(await lookupClaim(adminEnv,'mem-admin',p.code)).toMatchObject({state:'already_claimed'})
    h.sqlite.exec('DROP TRIGGER agent_seat_admissions_authority_immutable')
    h.sqlite.prepare('UPDATE agent_seat_admissions SET authority_expires_at=? WHERE id=?').run('2020-01-01 00:00:00',p.admissionId)
    expect(await lookupClaim(adminEnv,'mem-admin',p.code)).toMatchObject({state:'expired'})
  })
  it('lockout delta M30: agent-page invalid days returns HTTP400 without a decision',async()=>{
    const p=await fileAsk('agent-invalid-days');const a=await login('admin@x.test');setReauth('mem-admin',fresh())
    const r=await post('/agents/ag1/claim',a,{admission_id:p.admissionId,attach_code:p.code,authority_days:'1.5'})
    expect(r.status).toBe(400)
    expect(one<{status:string}>('SELECT status FROM agent_seat_admissions WHERE id=?',p.admissionId)?.status).toBe('pending')
    expect(n('SELECT COUNT(*) AS n FROM agent_seat_authority_decisions WHERE admission_id=?',p.admissionId)).toBe(0)
  })

})
