// tests/observed-seat-request-admission.test.ts — the onboarding deadlock (#2035 observed floor x #1794 seat_attach):
// an observed chat could not even ASK to be admitted as its agent. seat_attach is now on the observed floor, files a request only,
// and the human's existing decision path attaches. Real sqlite D1 from the full migration chain; real MCP + dashboard routes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { decideAdmissionDirect, detachAttachment } from '../src/members/seat-attach'
import { agentConnectPrompt } from '../src/dashboard/agent-connect-panel'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const MASTER = 'a1'.repeat(32)

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}
function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://colony.example.test', SESSIONS: memoryKv(), OAUTH_KV: { get: async () => null, put: async () => undefined },
    CONNECTOR_MASTER_KEY: MASTER, SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: 'secure.example.test',
    SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', VIP_LANE: '1', SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200', ...extra,
  } as unknown as Env
}

let h: SqliteD1Harness
let env: Env
let tok = 0
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined

function seedAgent(id: string, slug: string, name: string, squad: string): void {
  const memberId = `mem-${id}`
  h.sqlite.exec(`
    INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-${squad}', 'dept-${squad}', 'Dept ${squad}');
    INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${squad}', 'dept-${squad}', '${squad}', 'Squad ${squad}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${id}', '${squad}', '${slug}', '${name}', 'COO', 'm', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${memberId}', '${name}', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${id}', '${memberId}', '2026-10-01T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${id}', '${memberId}', 'squad', '${squad}', 'member');
    INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${HUMAN}-${squad}', '${HUMAN}', 'squad', '${squad}', 'admin');
  `)
}

interface Rpc { status: number; sc: Record<string, unknown>; text: string }
async function rpc(ctx: AuthContext, name: string, args: Record<string, unknown>, session: string, e: Env = env): Promise<Rpc> {
  const req = new Request('https://pot.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'openai/session': session } } }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), e)
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}, text: JSON.stringify(body) }
}

interface Chat { ctx: AuthContext; session: string; seatId: string }
async function chat(status: 'observed' | 'held' | null, session = 'conv-a'): Promise<Chat> {
  const harness = await upsertHarness(env, HUMAN, 'client-chatgpt', 'ChatGPT')
  if (!harness) throw new Error('harness fixture failed')
  const tokenId = `tok-${++tok}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${HUMAN}', 'hash-${tokenId}', 'oauth:client-chatgpt', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('ctx null')
  await rpc(ctx, 'boot_context', {}, session)
  const row = one<{ id: string }>(`SELECT id FROM agent_seats WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, HUMAN)
  if (!row) throw new Error('no seat')
  h.sqlite.prepare(`UPDATE agent_seats SET admission_status = ? WHERE id = ?`).run(status, row.id)
  return { ctx, session, seatId: row.id }
}
const seatStatus = (id: string): string | null => one<{ s: string | null }>(`SELECT admission_status AS s FROM agent_seats WHERE id = ?`, id)?.s ?? null

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = envFor(h)
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${HUMAN}', '${HUMAN}@example.test', 'Human One', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  h.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('dept-squad-core', 'dept-squad-core', 'D'); INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('squad-core', 'dept-squad-core', 'squad-core', 'Core', 'work');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-core', '${HUMAN}', 'squad', 'squad-core', 'admin')`)
  seedAgent('agent-coo', 'hadi-coo', 'Hadi-COO', 'squad-core')
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

describe('observed seat can FILE a request, and only that', () => {
  it('files a pending request; the seat stays observed and keeps its refusals', async () => {
    const c = await chat('observed')
    const r = await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)
    expect(r.sc.status).toBe('pending_admission')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_admissions WHERE status = 'pending'`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments`)).toBe(0)
    expect(seatStatus(c.seatId)).toBe('observed')
    // a repeat does not widen or re-file
    expect((await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)).sc.status).toBe('already_pending')
    // every other non-floor tool is still refused
    const t = await rpc(c.ctx, 'request_elevation', {}, c.session)
    expect(t.text).toContain('observed_floor')
  })

  it('the observed_floor refusal names the next step and the Connections link', async () => {
    const c = await chat('observed')
    const t = await rpc(c.ctx, 'request_elevation', {}, c.session)
    expect(t.text).toContain("seat_attach {agent:'<slug>'}")
    expect(t.text).toContain('your human approves')
    expect(t.text).toContain('https://colony.example.test/connections')
  })

  it('without approval nothing widens: the human decision attaches, and only then', async () => {
    const c = await chat('observed')
    const r = await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)
    const adm = String(r.sc.admission_id)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL`)).toBe(0)
    const code = one<{ c: string | null }>(`SELECT attach_code AS c FROM agent_seat_admissions WHERE id = ?`, adm)?.c
    expect(await decideAdmissionDirect(env, { admissionId: adm, humanMemberId: HUMAN, decision: 'approve', attachCode: code })).toEqual({ ok: true })
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL`)).toBe(1)
    const boot = await rpc(c.ctx, 'boot_context', {}, c.session)
    const ob = boot.sc.attached_onboarding as Record<string, unknown> | undefined
    expect(ob).toBeDefined()
    expect((ob?.who_you_are as { slug: string }).slug).toBe('hadi-coo')
    expect((ob?.squad as { name: string }).name).toBe('Core')
    expect(String(ob?.how_you_are_woken)).toContain('inbox')
  })

  it('a denied request attaches nothing and the chat stays limited', async () => {
    const c = await chat('observed')
    const adm = String((await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)).sc.admission_id)
    expect(await decideAdmissionDirect(env, { admissionId: adm, humanMemberId: HUMAN, decision: 'deny' })).toEqual({ ok: true })
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments`)).toBe(0)
    expect((await rpc(c.ctx, 'request_elevation', {}, c.session)).text).toContain('observed_floor')
  })

  it('the first task is part of the onboarding block', async () => {
    h.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, done_when) VALUES ('task-1', 'squad-core', 'Welcome: read the board', '', 'open', 'agent-coo', 'read')`)
    const c = await chat('observed')
    const adm = String((await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)).sc.admission_id)
    const code = one<{ c: string | null }>(`SELECT attach_code AS c FROM agent_seat_admissions WHERE id = ?`, adm)?.c
    await decideAdmissionDirect(env, { admissionId: adm, humanMemberId: HUMAN, decision: 'approve', attachCode: code })
    const ob = (await rpc(c.ctx, 'boot_context', {}, c.session)).sc.attached_onboarding as { first_task: { id: string } | null }
    expect(ob.first_task?.id).toBe('task-1')
  })

  it('held cannot file: held stays read-only and says who lifts it', async () => {
    const c = await chat('held')
    const r = await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)
    expect(r.text).toContain('observed_floor')
    expect(r.text).toContain('on hold')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_admissions`)).toBe(0)
  })

  it('boot_context for an observed seat names the one step that works; a held seat gets no attach advice', async () => {
    const o = await chat('observed')
    const b = await rpc(o.ctx, 'boot_context', {}, o.session)
    expect(b.text).toContain('You are observed: request admission with seat_attach')
    expect(b.text).toContain('your human approves')
    expect(String((b.sc.whoami as { next_step_plain: string }).next_step_plain)).toContain('You are observed: request admission with seat_attach')
    expect((b.sc.available_doors as Array<{ tool: string }>).map((d) => d.tool)).toContain('seat_attach')
    const hd = await chat('held', 'conv-held')
    const hb = await rpc(hd.ctx, 'boot_context', {}, hd.session)
    expect(hb.text).not.toContain('request admission with seat_attach')
  })
})

async function attachedChat(): Promise<Chat> {
  const c = await chat('observed')
  const adm = String((await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)).sc.admission_id)
  const code = one<{ c: string | null }>(`SELECT attach_code AS c FROM agent_seat_admissions WHERE id = ?`, adm)?.c
  await decideAdmissionDirect(env, { admissionId: adm, humanMemberId: HUMAN, decision: 'approve', attachCode: code })
  return c
}


describe('chat approval boundaries', () => {
  it('human Detach ends the approval and the same observed chat must ask again', async () => {
    const c = await attachedChat()
    const att = one<{ id: string; admission_id: string }>(`SELECT id, admission_id FROM agent_seat_attachments WHERE detached_at IS NULL`)!
    expect(await detachAttachment(env, { attachmentId: att.id, humanMemberId: HUMAN })).toEqual({ ok: true })
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions WHERE id = ?`, att.admission_id)?.status).toBe('revoked')
    const again = await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)
    expect(again.sc.status).toBe('pending_admission')
    expect(again.sc.admission_id).not.toBe(att.admission_id)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL`)).toBe(0)
    expect((await rpc(c.ctx, 'request_elevation', {}, c.session)).text).toContain('observed_floor')
    expect(await decideAdmissionDirect(env, { admissionId: String(again.sc.admission_id), humanMemberId: HUMAN, decision: 'approve', attachCode: again.sc.attach_code })).toEqual({ ok: true })
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL`)).toBe(1)
  })

  it('an observed chat detached by the idle sweep also needs a new human action', async () => {
    const c = await attachedChat()
    h.sqlite.exec(`UPDATE agent_seat_attachments SET detached_at = datetime('now'), detach_reason = 'idle_expired'`)
    const again = await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)
    expect(again.sc.status).toBe('pending_admission')
    expect(again.text).toContain('Release')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL`)).toBe(0)
  })

  it('a held chat does not advertise seat_attach in tools/list', async () => {
    const c = await chat('held')
    const req = new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'openai/session': c.session } } }) })
    const changes = n('SELECT total_changes() AS n')
    const res = await mcpApp.fetch(mcpInternalRequest(req, c.ctx), env)
    expect(n('SELECT total_changes() AS n')).toBe(changes)
    const body = await res.json() as { result: { tools: Array<{ name: string }> } }
    expect(body.result.tools.map(t => t.name)).not.toContain('seat_attach')
  })

  it('tools/list for a new conversation does not create a seat', async () => {
    const c = await chat('observed')
    const changes = n('SELECT total_changes() AS n')
    const req = new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'openai/session': 'unseen-conversation' } } }) })
    const res = await mcpApp.fetch(mcpInternalRequest(req, c.ctx), env)
    expect(res.status).toBe(200)
    expect(n('SELECT total_changes() AS n')).toBe(changes)
    expect(n('SELECT COUNT(*) AS n FROM agent_seats')).toBe(1)
  })

  it('a connection older than 24h gets no onboarding block', async () => {
    const c = await attachedChat()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000)
    expect((await rpc(c.ctx, 'boot_context', {}, c.session)).sc.attached_onboarding).toBeUndefined()
  })

  it('onboarding skips an archived assignment in favor of a current task', async () => {
    const c = await attachedChat()
    h.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, done_when, created_at) VALUES ('archived-task', 'squad-core', 'Old', '', 'open', 'agent-coo', 'read', '2020-01-01'), ('current-task', 'squad-core', 'Current', '', 'open', 'agent-coo', 'read', '2026-10-01')`)
    h.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_by_member_id, archived_reason, prior_status) VALUES ('archived-task', '2026-10-27', '${HUMAN}', 'finished', 'open')`)
    const ob = (await rpc(c.ctx, 'boot_context', {}, c.session)).sc.attached_onboarding as { first_task: { id: string } }
    expect(ob.first_task.id).toBe('current-task')
  })
})

describe('connection_check (full-duplex)', () => {
  it('refused for an unattached chat with the attach next step (own seat, and observed via the floor)', async () => {
    const plain = await chat(null)
    const r = await rpc(plain.ctx, 'connection_check', {}, plain.session)
    expect(r.text).toContain('not_attached')
    expect(r.text).toContain("seat_attach {agent:'<slug>'}")
    expect(r.text).toContain('approval code')
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'connection_check'`)).toBe(0)
    const obs = await chat('observed', 'conv-obs')
    const o = await rpc(obs.ctx, 'connection_check', {}, obs.session)
    expect(o.text).toContain('observed_floor')
    expect(o.text).toContain('seat_attach')
  })

  it('attached, no wake path: send ok, receive pending then ok after inbox_mark_handled, wake none with the enable line; recorded on the agent', async () => {
    const c = await attachedChat()
    const r1 = (await rpc(c.ctx, 'connection_check', {}, c.session)).sc as { send: { ok: boolean }; receive: { state: string; message_id: string }; wake: { path: string; live: boolean; enable: string }; summary: string }
    expect(r1.send.ok).toBe(true)
    expect(r1.receive.state).toBe('pending')
    expect(r1.wake).toMatchObject({ path: 'none', live: false })
    expect(r1.wake.enable).toContain("say 'monitor my mupot inbox' to enable")
    expect(r1.summary).toBe(`send ✓ receive pending wake: none — ${r1.wake.enable}`)
    // the probe really is in the agent's inbox, from the system sender
    expect(one<{ f: string }>(`SELECT from_agent AS f FROM agent_messages WHERE id = ?`, r1.receive.message_id)?.f).toBe('mupot-onboarding')
    const mh = await rpc(c.ctx, 'inbox_mark_handled', { ids: [r1.receive.message_id] }, c.session)
    expect(mh.text).not.toContain('"error"')
    const r2 = (await rpc(c.ctx, 'connection_check', {}, c.session)).sc as { receive: { state: string }; summary: string }
    expect(r2.receive.state).toBe('ok')
    expect(r2.summary.startsWith('send ✓ receive ✓ wake: none')).toBe(true)
    const rec = one<{ a: string }>(`SELECT after_state AS a FROM agent_audit WHERE action = 'connection_check' ORDER BY seq DESC LIMIT 1`)
    expect(JSON.parse(rec!.a).summary).toBe(r2.summary)
  })

  it.each([false, true])('replaces a host-consumed receive probe (fresh=%s)', async (fresh) => {
    const c = await attachedChat()
    const first = (await rpc(c.ctx, 'connection_check', {}, c.session)).sc as { receive: { message_id: string } }
    h.sqlite.prepare(`UPDATE agent_messages SET read_at = datetime('now') WHERE id = ?`).run(first.receive.message_id)
    const next = (await rpc(c.ctx, 'connection_check', { fresh }, c.session)).sc as { receive: { message_id: string; state: string } }
    expect(next.receive.state).toBe('pending')
    expect(next.receive.message_id).not.toBe(first.receive.message_id)
    expect(one(`SELECT read_at FROM agent_messages WHERE id = ?`, next.receive.message_id)).toEqual({ read_at: null })
    expect((await rpc(c.ctx, 'inbox_mark_handled', { ids: [next.receive.message_id] }, c.session)).sc).toMatchObject({ handled: [next.receive.message_id], not_visible: [] })
    expect((await rpc(c.ctx, 'connection_check', {}, c.session)).sc.receive).toMatchObject({ state: 'ok', message_id: next.receive.message_id })
  })

  it('completed receive proof survives host consumption; fresh starts a new round', async () => {
    const c = await attachedChat()
    const first = (await rpc(c.ctx, 'connection_check', {}, c.session)).sc as { receive: { message_id: string } }
    await rpc(c.ctx, 'inbox_mark_handled', { ids: [first.receive.message_id] }, c.session)
    h.sqlite.prepare(`UPDATE agent_messages SET read_at = datetime('now') WHERE id = ?`).run(first.receive.message_id)
    expect((await rpc(c.ctx, 'connection_check', {}, c.session)).sc.receive).toMatchObject({ state: 'ok', message_id: first.receive.message_id })
    const next = (await rpc(c.ctx, 'connection_check', { fresh: true }, c.session)).sc as { receive: { message_id: string; state: string } }
    expect(next.receive.state).toBe('pending')
    expect(next.receive.message_id).not.toBe(first.receive.message_id)
  })

  it('attached with a live wake path (webhook doorbell) reports it', async () => {
    const c = await attachedChat()
    h.sqlite.prepare(`INSERT INTO agent_webhook_doorbells (tenant, agent_id, webhook_url, auth_ciphertext, auth_last4, created_by_member_id, updated_at) VALUES (?, 'agent-coo', 'https://hook.example.test/x', 'ct', '1234', ?, '2026-10-26T00:00:00.000Z')`).run(TENANT, HUMAN)
    const on = envFor(h, { WEBHOOK_DOORBELL: '1' })
    const r = (await rpc(c.ctx, 'connection_check', {}, c.session, on)).sc as { wake: { path: string; live: boolean; enable: string | null }; summary: string }
    expect(r.wake).toEqual({ path: 'webhook_doorbell', live: true, enable: null })
    expect(r.summary).toContain('wake: webhook_doorbell')
  })

  it('the first boot_context after approval tells the agent to run the check', async () => {
    const c = await attachedChat()
    const ob = (await rpc(c.ctx, 'boot_context', {}, c.session)).sc.attached_onboarding as { first_steps: string[] }
    expect(ob.first_steps.join(' ')).toContain('connection_check')
  })

  it('the agent page shows the last recorded check', async () => {
    const c = await attachedChat()
    await rpc(c.ctx, 'connection_check', {}, c.session)
    const cookie = await session(env, `${HUMAN}@example.test`)
    const { dashboardApp } = await import('../src/dashboard/index')
    const p = await (await dashboardApp.request('/agents/agent-coo', { headers: { cookie } }, { ...env, LOCAL_TEST_AUTH: '1' } as unknown as Env)).text()
    expect(p).toContain('Last connection check')
    expect(p).toContain('send ✓ receive pending')
  })
})

describe('agentConnectPrompt', () => {
  it('is ONE line built from the slug alone', () => {
    expect(agentConnectPrompt({ slug: 'hadi-coo' })).toBe('You are hadi-coo. Use mupot: attach and check full-duplex communication.')
    // injection-shaped slug cannot add quotes, spaces or control characters
    expect(agentConnectPrompt({ slug: "x'; drop\n" })).toBe('You are xdrop. Use mupot: attach and check full-duplex communication.')
  })
})

async function session(e: Env, email: string): Promise<string> {
  const { authApp } = await import('../src/auth')
  const res = await authApp.request('/dev-login', {}, { ...e, LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: email } as unknown as Env)
  const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  return `mupot_session=${m[1]}`
}
async function get(e: Env, cookie: string, path: string): Promise<string> {
  const { dashboardApp } = await import('../src/dashboard/index')
  return (await dashboardApp.request(path, { headers: { cookie } }, { ...e, LOCAL_TEST_AUTH: '1' } as unknown as Env)).text()
}
async function postJson(e: Env, cookie: string, path: string): Promise<Response> {
  const { dashboardApp } = await import('../src/dashboard/index')
  return dashboardApp.request(path, { method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' }, body: '{}' }, { ...e, LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: 'x' } as unknown as Env)
}
const fresh = (): void => { h.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ?').run(new Date().toISOString()) }

describe('/connections with VIP_LANE off', () => {
  it('shows an observed chat with Release only, and Release works (fresh) while Hold/Return stay refused', async () => {
    const c = await chat('observed')
    const off = envFor(h, { VIP_LANE: undefined })
    const cookie = await session(off, `${HUMAN}@example.test`)
    const page = await get(off, cookie, '/connections')
    expect(page).toContain('Observed chats')
    expect(page).toContain(`data-cx-release="${c.seatId}"`)
    expect(page).not.toContain(`data-cx-hold="${c.seatId}"`)
    expect((await postJson(off, cookie, `/connections/seats/${c.seatId}/hold`)).status).toBe(403)
    h.sqlite.prepare(`UPDATE agent_seats SET admission_status = 'held' WHERE id = ?`).run(c.seatId)
    fresh()
    expect((await postJson(off, cookie, `/connections/seats/${c.seatId}/return`)).status).toBe(403)
    expect(seatStatus(c.seatId)).toBe('held')
    h.sqlite.prepare(`UPDATE agent_seats SET admission_status = 'observed' WHERE id = ?`).run(c.seatId)
    h.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ?').run('2020-01-01T00:00:00.000Z')
    expect((await postJson(off, cookie, `/connections/seats/${c.seatId}/release`)).status).toBe(403) // reauth still required
    expect(seatStatus(c.seatId)).toBe('observed')
    fresh()
    expect((await postJson(off, cookie, `/connections/seats/${c.seatId}/release`)).status).toBe(200)
    expect(seatStatus(c.seatId)).toBe('trusted')
  })
  it('no observed chat and flag off: the panel stays absent', async () => {
    await chat(null)
    const off = envFor(h, { VIP_LANE: undefined })
    expect(await get(off, await session(off, `${HUMAN}@example.test`), '/connections')).not.toContain('Observed chats')
  })
})

describe('agent page: Connect a chat checklist', () => {
  const page = async (): Promise<string> => get(env, await session(env, `${HUMAN}@example.test`), '/agents/agent-coo')

  it('no requests yet', async () => {
    const p = await page()
    expect(p).toContain('Copy this to your agent')
    expect(p).toContain('You are hadi-coo. Use mupot: attach and check full-duplex communication.')
    expect(p).toContain('No chat has asked yet. This updates when one does.')
    expect(p).not.toContain('Connected. Mupot takes it from here.')
  })


  it('a second human sees none of the first human’s requests, connections, checks or limited chats', async () => {
    const c = await attachedChat()
    await rpc(c.ctx, 'connection_check', {}, c.session)
    await chat('observed', 'private-chat')
    seedAgent('agent-other', 'other', 'Other', 'squad-core')
    const other = await chat('observed', 'private-pending')
    const pending = await rpc(other.ctx, 'seat_attach', { agent: 'other' }, other.session)
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('human-two', 'two@example.test', 'Two', 'active', '${TENANT}'); INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-two', 'human-two', 'squad', 'squad-core', 'admin')`)
    const cookie = await session(env, 'two@example.test')
    const p = await get(env, cookie, '/agents/agent-coo')
    expect(p).toContain('data-agent-connect')
    expect(p).not.toContain('data-cx-detach=')
    expect(p).not.toContain('data-cx-release=')
    expect(p).not.toContain('Last connection check')
    const second = await get(env, cookie, '/agents/agent-other')
    expect(second).not.toContain(String(pending.sc.admission_id))
    expect(second).not.toContain(String(pending.sc.attach_code))
    expect(second).toContain('No chat has asked yet')
  })

  it('bearer and agent-bound viewers get no Connect a chat panel', async () => {
    await attachedChat()
    const { sha256Hex } = await import('../src/members/service')
    const raw = 'test-panel-bearer-only'
    h.sqlite.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant) VALUES ('panel-bearer', ?, ?, 'panel test', 'workspace', ?)`).run(HUMAN, await sha256Hex(raw), TENANT)
    const { dashboardApp } = await import('../src/dashboard/index')
    const bearer = await dashboardApp.request('/agents/agent-coo', { headers: { authorization: `Bearer ${raw}` } }, env)
    expect(await bearer.text()).not.toContain('data-connect-prompt')
    // An agent member's real cookie still cannot be a human viewer.
    h.sqlite.prepare(`UPDATE members SET email = 'agent@example.test' WHERE id = 'mem-agent-coo'`).run()
    const agentPage = await get(env, await session(env, 'agent@example.test'), '/agents/agent-coo')
    expect(agentPage).not.toContain('data-connect-prompt')
    expect(agentPage).toContain('id="background-connect-prompt"')
  })

  it('a pending request shows with Approve and Reject; plain words only', async () => {
    const c = await chat('observed')
    const r = await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)
    const cookie = await session(env, `${HUMAN}@example.test`)
    fresh()
    const p = await get(env, cookie, '/agents/agent-coo')
    expect(p).toContain(`data-cx-deny="${String(r.sc.admission_id)}"`)
    expect(p).toContain('>Approve<')
    expect(p).not.toContain('No chat has asked yet')
    // Inspect the generated panel's text, including the copy prompt. Its inline
    // script follows all UI markup; no HTML is rewritten or used as sanitized output.
    const start = p.indexOf('data-agent-connect')
    const end = p.indexOf('<script>', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const visible = [...p.slice(start, end).matchAll(/>([^<>]*)</g)]
      .map((match) => match[1]).join(' ')
    expect(visible).toContain('Requests from your chats')
    expect(visible).toContain('Approve')
    expect(visible).toContain('Reject')
    expect(visible.toLowerCase()).not.toMatch(/admission|\bseat\b/)
  })

  it('a request for all chats opens passkey approval, scoped to a fresh human session', async () => {
    const c = await chat('observed')
    const ask = await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo', scope: 'harness' }, c.session)
    const cookie = await session(env, `${HUMAN}@example.test`)
    fresh()
    const p = await get(env, cookie, '/agents/agent-coo')
    expect(p).toContain('Open passkey approval')
    expect(p).toContain(String(ask.sc.attach_code))
    expect(p).not.toContain('data-claim-own')
    const { dashboardApp } = await import('../src/dashboard/index')
    const post = (cookie: string, admissionId: string, agent = 'agent-coo') => dashboardApp.request(`/agents/${agent}/claim/passkey`, { method: 'POST', headers: { cookie, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ admission_id: admissionId }) }, { ...env, LOCAL_TEST_AUTH: '1' } as unknown as Env)
    const admissionId = String(ask.sc.admission_id)
    expect((await post(cookie, 'another-admission')).status).toBe(409)
    seedAgent('other-agent', 'other-agent', 'Other', 'squad-core')
    expect((await post(cookie, admissionId, 'other-agent')).status).toBe(404)
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('other-human', 'other@example.test', 'Other', 'active', '${TENANT}'); INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('other-cap', 'other-human', 'squad', 'squad-core', 'admin')`)
    const otherCookie = await session(env, 'other@example.test')
    fresh()
    expect((await post(otherCookie, admissionId)).status).toBe(404)
    h.sqlite.prepare(`UPDATE web_sessions SET recent_reauth_at = '2020-01-01'`).run()
    const stale = await post(cookie, admissionId)
    expect(stale.status).toBe(303)
    expect(stale.headers.get('location')).toContain('/auth/')
    fresh()
    const done = await post(cookie, admissionId)
    expect(done.status).toBe(303)
    expect(new URL(done.headers.get('location')!).host).toBe('secure.example.test')
    expect(one(`SELECT status FROM agent_seat_admissions WHERE id = ?`, admissionId)).toEqual({ status: 'pending' })
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments`)).toBe(0)
  })

  it('an attached chat shows Connected and Detach', async () => {
    const c = await chat('observed')
    const adm = String((await rpc(c.ctx, 'seat_attach', { agent: 'hadi-coo' }, c.session)).sc.admission_id)
    const code = one<{ c: string | null }>(`SELECT attach_code AS c FROM agent_seat_admissions WHERE id = ?`, adm)?.c
    await decideAdmissionDirect(env, { admissionId: adm, humanMemberId: HUMAN, decision: 'approve', attachCode: code })
    const p = await page()
    expect(p).toContain('Connected. Mupot takes it from here.')
    expect(p).toContain('data-cx-detach=')
  })

  it('an observed chat is listed with Release and Return/Hold actions', async () => {
    const c = await chat('observed')
    const p = await page()
    expect(p).toContain(`data-cx-release="${c.seatId}"`)
    expect(p).toContain(`data-cx-hold="${c.seatId}"`)
    h.sqlite.prepare(`UPDATE agent_seats SET admission_status = 'held' WHERE id = ?`).run(c.seatId)
    expect(await page()).toContain(`data-cx-return="${c.seatId}"`)
  })
})
