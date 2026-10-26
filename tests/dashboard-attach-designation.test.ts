// The dashboard "Allow my chats to become this agent" control + POST /agents/:id/designation.
// Real dashboardApp, real web sessions (dev-login), real migration chain. The write is the SAME door
// (authorizeOwnerMemberChange, 'attach_designated_member_id') and the SAME compare-and-set (updateAgentProfile) as MCP
// update_agent; no fixture writes the column directly except the one boss-owned-agent setup noted below.
//
// Mutations proven (PR body): flag check removed; fresh:true flipped to false on Allow; checkWebSession removed; explicit
// Origin check removed; the door call removed; the CAS `expect` dropped; designee column swapped to owner_member_id.
import { RECENT_REAUTH_WINDOW_MS } from '../src/auth/web-sessions'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { upsertHarness } from '../src/members/harness'
import { ensureAdmission } from '../src/members/seat-attach'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const ORIGIN = 'http://localhost'
const ON = { SEAT_ATTACH: '1', SEAT_AUTO_ENROLL: '1', SEAT_ATTACH_DESIGNATED: '1' }

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

let h: SqliteD1Harness
function envFor(email: string, extra: Record<string, string> = ON): Env {
  return { TENANT_SLUG: TENANT, BRAND: 'Test Pot', LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: email, SESSIONS: kv(), DB: h.db, ...extra } as unknown as Env
}
async function login(email: string, extra?: Record<string, string>): Promise<{ env: Env; cookie: string }> {
  const env = envFor(email, extra)
  const res = await authApp.request('/dev-login', {}, env)
  expect(res.status).toBe(302)
  const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  return { env, cookie: `mupot_session=${m[1]}` }
}
const setReauth = (memberId: string, at: string | null) => h.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ? WHERE member_id = ?').run(at, memberId)
const fresh = () => new Date().toISOString()
const stale = () => new Date(Date.now() - (RECENT_REAUTH_WINDOW_MS + 60 * 1000)).toISOString()

function post(env: Env, cookie: string, action: string, origin: string | null = ORIGIN, agent = 'ag1') {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/x-www-form-urlencoded' }
  if (origin) headers.origin = origin
  return dashboardApp.request(`/agents/${agent}/designation`, { method: 'POST', headers, body: new URLSearchParams({ action }) }, env)
}
const designee = (): string | null => (h.sqlite.prepare("SELECT attach_designated_member_id AS d FROM agents WHERE id = 'ag1'").get() as { d: string | null }).d
const auditCount = (): number => (h.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = 'ag1'").get() as { n: number }).n

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('S1', 'D1', 's1-sqd', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag1', 'S1', 'ag1', 'Agent One', 'member', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin', 'admin@x.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-plain', 'plain@x.test', 'Plain Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-plain', 'mem-plain', 'org', NULL, 'member');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-boss', 'boss@x.test', 'Boss Owner', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-boss', 'mem-boss', 'org', NULL, 'owner');
  `)
})
afterEach(() => h.close())

describe('POST /agents/:id/designation', () => {
  it('the org admin designates themselves: column set, audit row attributed to them, redirect', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await post(env, cookie, 'allow')
    expect(res.status, await res.clone().text()).toBe(303)
    expect(designee()).toBe('mem-admin')
    const audit = h.sqlite.prepare("SELECT actor_id, actor_type, fields_changed FROM agent_audit WHERE agent_id = 'ag1' ORDER BY rowid DESC LIMIT 1").get()
    expect(audit).toEqual({ actor_id: 'mem-admin', actor_type: 'user', fields_changed: '["attach_designated_member_id"]' })
  })

  it('a non-org-admin is refused, no write', async () => {
    const { env, cookie } = await login('plain@x.test')
    setReauth('mem-plain', fresh())
    expect((await post(env, cookie, 'allow')).status).toBe(403)
    expect(designee()).toBeNull()
    expect(auditCount()).toBe(0)
  })

  it('an agent whose owner outranks the human is refused even for themselves (agent ceiling)', async () => {
    h.sqlite.exec("UPDATE agents SET owner_member_id = 'mem-boss' WHERE id = 'ag1'") // fixture: boss-owned agent (owner door tested elsewhere)
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(env, cookie, 'allow')).status).toBe(403)
    expect(designee()).toBeNull()
  })

  it('no step-up (stale or never re-authenticated) redirects once to reauth and back to the agent page, no write', async () => {
    const { env, cookie } = await login('admin@x.test')
    for (const at of [stale(), null]) {
      setReauth('mem-admin', at)
      const res = await post(env, cookie, 'allow')
      // One redirect through sign-in that lands back on this agent's page (resume=allow); the write is never done by the redirect.
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe(`/auth/reauth?return=${encodeURIComponent('/agents/ag1?resume=allow')}`)
    }
    expect(designee()).toBeNull()
  })

  it('a missing or cross-origin Origin is refused by csrf() like the owner form, no write; same-origin form passes csrf', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(env, cookie, 'allow', null)).status).toBe(403)
    expect((await post(env, cookie, 'allow', 'https://evil.test')).status).toBe(403)
    expect(designee()).toBeNull()
  })

  it('a non-form content type (which csrf() does not inspect) is refused 415 before parsing, even same-origin', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    const res = await dashboardApp.request('/agents/ag1/designation', {
      method: 'POST', headers: { cookie, origin: 'https://evil.test', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'allow' }),
    }, env)
    expect(res.status).toBe(415)
    const same = await dashboardApp.request('/agents/ag1/designation', {
      method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'text/plain' }, body: 'action=allow',
    }, env)
    expect(same.status).toBe(415)
    expect(designee()).toBeNull()
  })

  it('an agent-bound or bearer-style caller without a web session is refused', async () => {
    const { env } = await login('admin@x.test')
    const res = await dashboardApp.request('/agents/ag1/designation', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'allow' }),
    }, env)
    expect([302, 401, 403]).toContain(res.status)
    expect(designee()).toBeNull()
  })

  it('Stop clears the designation, needs only a real session (no step-up), and the trigger revokes live admissions', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(env, cookie, 'allow')).status).toBe(303)
    const harness = await upsertHarness(env, 'mem-admin', 'claude', 'Claude')
    const adm = await ensureAdmission(env, { agentId: 'ag1', humanMemberId: 'mem-admin', harnessId: harness.id, seatId: 'seat-x', via: 'dashboard' })
    expect(adm.ok, JSON.stringify(adm)).toBe(true)
    const status = () => (h.sqlite.prepare('SELECT status FROM agent_seat_admissions').get() as { status: string }).status
    expect(status()).toBe('live')
    setReauth('mem-admin', stale())
    const res = await post(env, cookie, 'stop')
    expect(res.status).toBe(303)
    expect(designee()).toBeNull()
    expect(status()).toBe('revoked')
    expect((h.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = 'ag1' AND fields_changed = '[\"attach_designated_member_id\"]'").get() as { n: number }).n).toBe(2) // allow + stop
  })

  it('Stop by a non-admin is refused and leaves the designation', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    await post(env, cookie, 'allow')
    const p = await login('plain@x.test')
    expect((await post(p.env, p.cookie, 'stop')).status).toBe(403)
    expect(designee()).toBe('mem-admin')
  })

  it('Stop is refused when the current designee outranks the caller', async () => {
    h.sqlite.exec("UPDATE agents SET attach_designated_member_id = 'mem-boss' WHERE id = 'ag1'") // fixture: boss designation
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(env, cookie, 'stop')).status).toBe(403)
    expect(designee()).toBe('mem-boss')
  })

  it('a concurrent designation change makes the write lose (compare-and-set): 409, the other value stays', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    // Interleave: change the column between the door read and the write by racing the batch.
    const realBatch = env.DB.batch.bind(env.DB)
    let raced = false
    ;(env.DB as unknown as { batch: typeof env.DB.batch }).batch = (async (stmts: Parameters<typeof env.DB.batch>[0]) => {
      if (!raced) { raced = true; h.sqlite.exec("UPDATE agents SET attach_designated_member_id = 'mem-plain' WHERE id = 'ag1'") }
      return realBatch(stmts)
    }) as typeof env.DB.batch
    const res = await post(env, cookie, 'allow')
    expect(res.status).toBe(409)
    expect(designee()).toBe('mem-plain')
  })

  it('flag off: the route refuses (404) and writes nothing', async () => {
    const { env, cookie } = await login('admin@x.test', {})
    setReauth('mem-admin', fresh())
    expect((await post(env, cookie, 'allow')).status).toBe(404)
    expect(designee()).toBeNull()
  })

  it('unknown action is a 400', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    expect((await post(env, cookie, 'nope')).status).toBe(400)
  })
})

describe('agent page control', () => {
  const page = async (env: Env, cookie: string) => (await dashboardApp.request('/agents/ag1', { headers: { cookie } }, env)).text()

  it('flag on: admin sees the control with the warning and a masked designee; Stop only when set', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', fresh())
    let body = await page(env, cookie)
    expect(body).toContain('Allow for me')
    expect(body).toContain('Currently allowed: nobody')
    expect(body).toContain('you approve each one with your passkey. Stopping ends all of them now.')
    expect(body).not.toContain('>Stop<')
    await post(env, cookie, 'allow')
    body = await page(env, cookie)
    expect(body).toContain('Currently allowed: A*** A*** (you)')
    expect(body).not.toContain('Ada Admin')
    expect(body).toContain('>Stop<')
  })

  it('flag off: the control is hidden; non-admin never sees it', async () => {
    const off = await login('admin@x.test', {})
    expect(await page(off.env, off.cookie)).not.toContain('Allow for me')
    const p = await login('plain@x.test')
    expect(await page(p.env, p.cookie)).not.toContain('Allow for me')
  })
})

// Mom-walk D2 (mupot task 7ae27377): an agent's OWNER may designate THEMSELVES for their own agent without org admin.
// Self only, own agents only; everything else keeps the admin floor.
describe('owner self-designation (mom-walk D2)', () => {
  const ownBy = (member: string) => h.sqlite.exec(`UPDATE agents SET owner_member_id = '${member}' WHERE id = 'ag1'`)
  const door = async (env: Env, memberId: string, target: string | null, extra: Record<string, unknown> = {}) => {
    const { authorizeOwnerMemberChange } = await import('../src/org/agent-owner')
    const { resolveCapabilities } = await import('../src/auth/capability')
    const auth = {
      userId: memberId, email: null, role: 'member', tenant: TENANT, memberId,
      capabilities: await resolveCapabilities(env, memberId), boundAgentId: null, ...extra,
    } as unknown as import('../src/types').AuthContext
    return authorizeOwnerMemberChange(env, auth, 'ag1', target, 'attach_designated_member_id')
  }

  it('the OWNER (plain member, no org admin) designates themselves: column set, audit attributed to them', async () => {
    ownBy('mem-plain')
    const { env, cookie } = await login('plain@x.test')
    setReauth('mem-plain', fresh())
    const res = await post(env, cookie, 'allow')
    expect(res.status, await res.clone().text()).toBe(303)
    expect(designee()).toBe('mem-plain')
    const audit = h.sqlite.prepare("SELECT actor_id FROM agent_audit WHERE agent_id = 'ag1' ORDER BY rowid DESC LIMIT 1").get()
    expect(audit).toEqual({ actor_id: 'mem-plain' })
  })

  it('a member who does NOT own the agent is refused, even with a fresh session', async () => {
    ownBy('mem-admin')
    const { env, cookie } = await login('plain@x.test')
    setReauth('mem-plain', fresh())
    expect((await post(env, cookie, 'allow')).status).toBe(403)
    expect(designee()).toBeNull()
  })

  it('a member who merely holds a KEY for the agent (a token minter, not the owner) is refused', async () => {
    ownBy('mem-admin')
    h.sqlite.prepare("INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES (?, 'ag1', 'pk', 'mem-plain', unixepoch())").run(TENANT)
    const { env, cookie } = await login('plain@x.test')
    setReauth('mem-plain', fresh())
    expect((await post(env, cookie, 'allow')).status).toBe(403)
    expect(designee()).toBeNull()
  })

  it('the owner still needs the fresh-session step-up (no weaker than the admin path)', async () => {
    ownBy('mem-plain')
    const { env, cookie } = await login('plain@x.test')
    setReauth('mem-plain', stale())
    const res = await post(env, cookie, 'allow')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('/auth/reauth')
    expect(designee()).toBeNull()
  })

  it('the owner cannot Stop (admin only), and the door refuses clearing or designating someone else', async () => {
    ownBy('mem-plain')
    const { env, cookie } = await login('plain@x.test')
    setReauth('mem-plain', fresh())
    expect((await post(env, cookie, 'allow')).status).toBe(303)
    expect((await post(env, cookie, 'stop')).status).toBe(403)
    expect(designee()).toBe('mem-plain')
    expect(await door(env, 'mem-plain', 'mem-admin')).toMatchObject({ ok: false, error: 'forbidden' })
    expect(await door(env, 'mem-plain', null)).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it('door: the owner may designate only themselves; a non-owner self-target, another member and a bound agent session are refused', async () => {
    ownBy('mem-plain')
    const { env } = await login('plain@x.test')
    expect(await door(env, 'mem-plain', 'mem-plain')).toMatchObject({ ok: true })
    expect(await door(env, 'mem-plain', 'mem-boss')).toMatchObject({ ok: false })
    ownBy('mem-admin')
    expect(await door(env, 'mem-plain', 'mem-plain')).toMatchObject({ ok: false, error: 'forbidden' })
    ownBy('mem-plain')
    expect(await door(env, 'mem-plain', 'mem-plain', { boundAgentId: 'ag1' })).toMatchObject({ ok: false })
    expect(await door(env, 'mem-plain', 'mem-plain', { seatBinding: { seatId: 's', label: 'l', harnessId: 'h', grantTokenId: 'g', humanMemberId: 'mem-plain', source: 'handle' } }))
      .toMatchObject({ ok: false, error: 'seat_session_forbidden' })
  })

  it('the agent ceiling still applies to an owner: an agent bound to a higher-ranked member is refused', async () => {
    ownBy('mem-plain')
    h.sqlite.prepare("INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, 'ag1', 'mem-boss', datetime('now'))").run(TENANT)
    const { env } = await login('plain@x.test')
    expect(await door(env, 'mem-plain', 'mem-plain')).toMatchObject({ ok: false, error: 'agent_rank_exceeds_ceiling' })
  })

  it('the outgoing designee ceiling still applies: a boss designation cannot be replaced by the owner', async () => {
    ownBy('mem-plain')
    h.sqlite.exec("UPDATE agents SET attach_designated_member_id = 'mem-boss' WHERE id = 'ag1'")
    const { env } = await login('plain@x.test')
    expect(await door(env, 'mem-plain', 'mem-plain')).toMatchObject({ ok: false, error: 'target_rank_exceeds_ceiling' })
  })

  it('page: the owner sees Allow for me (never Stop); a non-owner member still sees nothing', async () => {
    ownBy('mem-plain')
    const page = async (env: Env, cookie: string) => (await dashboardApp.request('/agents/ag1', { headers: { cookie } }, env)).text()
    const o = await login('plain@x.test')
    setReauth('mem-plain', fresh())
    expect(await page(o.env, o.cookie)).toContain('Allow for me')
    await post(o.env, o.cookie, 'allow')
    const after = await page(o.env, o.cookie)
    expect(after).toContain('Currently allowed')
    expect(after).not.toContain('>Stop<')
    ownBy('mem-admin')
    expect(await page(o.env, o.cookie)).not.toContain('Allow for me')
  })
})
