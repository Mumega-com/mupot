// tests/attached-sudo.test.ts — "sudo for attached chats".
//
// An ATTACHED chat (W2 seat_attach) acts with min(human, agent, ceiling) and holds no admin of its own. Its ONE way to a
// bigger act is request_elevation for an allow-listed, reversible action (ATTACHED_SUDO_ACTIONS = action:org_structure
// only), approved by the HUMAN WHO ATTACHED IT (passkey), bound to the attachment's OWN session, ending with the
// attachment. Real sqlite D1 from the full migration chain; the chat goes through the real path (applySeatForRequest ->
// buildSeatContext -> findLiveAttachment -> invokeTool); the approval goes through the REAL /m/* passkey routes.
//
// MUTATIONS proven (see the PR body): attaching-human-only decision (findElevationDecisionRefusal), the allow-list
// (ATTACHED_SUDO_ACTIONS), the attachment-session binding (loadLiveAgentSessionByCredential's credential pin), the
// use-time attachment re-check and the approved_by pin (hasElevatedAction), and findLiveAttachment's detached pin.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { SoftAuthenticator } from './helpers/webauthn-authenticator'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { advertisedTools, mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { NO_HINTS } from '../src/members/seat-handle'
import { applySeatForRequest, resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { callerHoldsGateCapability } from '../src/tasks/index'
import { momentsApp } from '../src/secure-moments/routes'
import { mintEnrolmentToken } from '../src/secure-moments/store'
import { linkLoginIdentity } from '../src/auth/login-identity'
import {
  attachSeatToAgent, decideAdmissionDirect, detachAttachment, ensureAdmission, listAttachableAgents, revokeAdmission,
  seatAttachEnabled, findLiveAttachment,
} from '../src/members/seat-attach'
import type { AuthContext, Env } from '../src/types'
import { invokeTool } from '../src/mcp/index'
import { ATTACHED_SUDO_ACTIONS } from '../src/auth/attached-ceiling'
import {
  canDecideElevationRequest, createElevationRequest, decideElevationRequest, hasElevatedAction, loadElevationRequestById,
} from '../src/auth/elevation'
import { decideElevation, mayDecideElevation } from '../src/access/decision-core'
import { attachedOriginRefusal, ATTACHED_PASSKEY_MESSAGE } from '../src/secure-moments/telegram-miniapp'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWebSession } from '../src/auth/web-sessions'
import { resolveCapabilities } from '../src/auth/capability'
import { pendingRequestsBody } from '../src/dashboard/elevation'
import { prepareIdleAttachmentSweep } from '../src/members/seat-attach'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const HUMAN2 = 'member-human-2'
const HOST = 'secure.example.test'
const ORIGIN = `https://${HOST}`
const COLONY = 'colony.example.test'
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
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: `https://${COLONY}`, SESSIONS: memoryKv(), OAUTH_KV: { get: async () => null, put: async () => undefined },
    CONNECTOR_MASTER_KEY: MASTER, SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST,
    SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200', ...extra,
  } as unknown as Env
}

let h: SqliteD1Harness
let tokCounter = 0
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined

function seedHuman(id: string, email = `${id}@example.test`): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${email}', 'Human ${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
}

/** An existing, welded, named agent on a squad; `admin` lists the humans who administer that squad. */
function seedAgent(o: { id: string; slug: string; name: string; squad: string; admins: string[]; memberCap?: string }): void {
  const memberId = `mem-${o.id}`
  h.sqlite.exec(`
    INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-${o.squad}', 'dept-${o.squad}', 'Dept ${o.squad}');
    INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${o.squad}', 'dept-${o.squad}', '${o.squad}', 'Squad ${o.squad}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${o.id}', '${o.squad}', '${o.slug}', '${o.name}', 'r', 'm', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${memberId}', '${o.name}', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${o.id}', '${memberId}', '2026-10-01T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${o.id}', '${memberId}', 'squad', '${o.squad}', '${o.memberCap ?? 'member'}');
  `)
  for (const a of o.admins) h.sqlite.exec(`INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${a}-${o.squad}', '${a}', 'squad', '${o.squad}', 'admin')`)
}

interface Grant { memberId: string; tokenId: string; harnessId: string; ctx: AuthContext }

/** A human's unbound OAuth harness grant (a ChatGPT connector: "Me — auto per workspace"). */
async function grant(env: Env, memberId: string, clientId = 'client-chatgpt', name = 'ChatGPT'): Promise<Grant> {
  const harness = await upsertHarness(env, memberId, clientId, name)
  if (!harness) throw new Error('harness fixture failed')
  const tokenId = `tok-${memberId}-${++tokCounter}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:${clientId}', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  return { memberId, tokenId, harnessId: harness.id, ctx }
}

interface RpcOpts { meta?: Record<string, unknown>; headers?: Record<string, string> }
interface Rpc { status: number; body: Record<string, unknown>; sc: Record<string, unknown> }

async function rpc(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown> = {}, o: RpcOpts = {}): Promise<Rpc> {
  const params: Record<string, unknown> = { name, arguments: args }
  if (o.meta) params._meta = o.meta
  const req = new Request('https://pot.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(o.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {} }
}

const thread = (session: string): Record<string, unknown> => ({ 'openai/session': session })
const boot = (env: Env, g: Grant, session: string): Promise<Rpc> => rpc(env, g.ctx, 'boot_context', {}, { meta: thread(session) })
const attach = (env: Env, g: Grant, session: string, agent: string): Promise<Rpc> => rpc(env, g.ctx, 'seat_attach', { agent }, { meta: thread(session) })
const receiptOf = (r: Rpc): Record<string, unknown> => r.sc.identity_receipt as Record<string, unknown>
const errOf = (r: Rpc): string => String(((r.body.result ?? {}) as { structuredContent?: { error?: unknown } }).structuredContent?.error ?? (r.body.error as { message?: string } | undefined)?.message ?? '')

// ── the passkey ceremony through the REAL /m/* routes ───────────────────────────────────────────
async function hit(path: string, e: Env, r: { method?: string; json?: unknown } = {}): Promise<Response> {
  const headers = new Headers()
  const method = r.method ?? 'GET'
  let body: string | undefined
  if (method === 'POST') { headers.set('origin', ORIGIN); headers.set('content-type', 'application/json'); body = JSON.stringify(r.json ?? {}) }
  return momentsApp.fetch(new Request(`https://${HOST}${path}`, { method, headers, body }), e)
}
const csrfOf = (page: string): string => { const m = /data-csrf="([0-9a-f]{64})"/.exec(page); if (!m) throw new Error('no csrf'); return m[1] }
type J = { ok?: boolean; title?: string; message?: string; publicKey?: { challenge: string } }

async function enrolPasskey(e: Env, memberId: string, email: string): Promise<SoftAuthenticator> {
  const link = await linkLoginIdentity(e, { tenant: TENANT, provider: 'google', providerSubject: `g-${memberId}`, verifiedEmail: email, memberId })
  if (!link.ok) throw new Error('link failed')
  const a = await SoftAuthenticator.create()
  const { token } = await mintEnrolmentToken(e, memberId, link.identity.id)
  const page = await hit(`/m/enrol/${token}`, e)
  const csrf = csrfOf(await page.text())
  const opts = (await (await hit(`/m/enrol/${token}/options`, e, { method: 'POST', json: { csrf } })).json()) as J
  const credential = await a.register({ rpId: HOST, origin: ORIGIN, challenge: opts.publicKey?.challenge ?? '' })
  expect((await hit(`/m/enrol/${token}/finish`, e, { method: 'POST', json: { csrf, credential } })).status).toBe(200)
  return a
}

/** The attach code the human types on the /m/* page: default = the code of the pending admission; null = type nothing. */
const pendingCode = (c?: string | null): { attach_code?: string } => {
  const v = c === undefined ? one<{ attach_code: string | null }>(`SELECT attach_code FROM agent_seat_admissions ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 1`)?.attach_code : c
  return v ? { attach_code: v } : {}
}

async function decideMoment(e: Env, url: string, a: SoftAuthenticator, decision: 'approve' | 'deny', ceiling?: string, decideCeiling: string | undefined = ceiling, attachCode?: string | null): Promise<{ status: number; body: J }> {
  const path = new URL(url).pathname
  const csrf = csrfOf(await (await hit(path, e)).text())
  const ch = (await (await hit(`${path}/challenge`, e, { method: 'POST', json: { decision, csrf, ...(ceiling ? { ceiling } : {}), ...pendingCode(attachCode) } })).json()) as J
  const credential = await a.assert({ rpId: HOST, origin: ORIGIN, challenge: ch.publicKey?.challenge ?? '' })
  const res = await hit(`${path}/decide`, e, { method: 'POST', json: { decision, csrf, credential, ...(decideCeiling ? { ceiling: decideCeiling } : {}), ...pendingCode(attachCode) } })
  const raw = await res.text()
  let body: J = {} as J
  try { body = JSON.parse(raw) as J } catch { /* a 500 is plain text */ }
  return { status: res.status, body }
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedHuman(HUMAN)
  seedHuman(HUMAN2)
  seedAgent({ id: 'agent-rava', slug: 'rava', name: 'Rava', squad: 'squad-core', admins: [HUMAN] })
  seedAgent({ id: 'agent-hadi-admin', slug: 'hadi-admin', name: 'Hadi Admin', squad: 'squad-core', admins: [HUMAN] })
  seedAgent({ id: 'agent-other', slug: 'other-ops', name: 'Other Ops', squad: 'squad-other', admins: [HUMAN2] })
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

/** Walks a thread to an admitted, attached state through the real tool + passkey. Returns the passkey. */
async function admitAndAttach(env: Env, g: Grant, session: string, agent = 'rava'): Promise<SoftAuthenticator> {
  await boot(env, g, session)
  const pend = await attach(env, g, session, agent)
  expect(pend.sc.status, JSON.stringify(pend.body)).toBe('pending_admission')
  const key = await enrolPasskey(env, g.memberId, `${g.memberId}@example.test`)
  const res = await decideMoment(env, String(pend.sc.approve_url), key, 'approve')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const done = await attach(env, g, session, agent)
  expect(done.sc.status, JSON.stringify(done.body)).toBe('attached')
  return key
}

// ════════════════════════════════════════════════════════════════════════════
const POT = 'https://pot.test'
const HUMAN3 = 'member-human-3' // an ORG ADMIN who did NOT attach the chat
const SUDO = 'action:org_structure'
const isoIn = (min: number): string => new Date(Date.now() + min * 60_000).toISOString()
let rawSeq = 0

beforeEach(() => {
  seedHuman(HUMAN3)
  h.sqlite.exec(`
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('org-h3', '${HUMAN3}', 'org', NULL, 'admin');
    UPDATE squads SET slug = 'core-sqd' WHERE id = 'squad-core';
    UPDATE squads SET slug = 'other-sqd' WHERE id = 'squad-other';
  `)
})

interface World { env: Env; g: Grant; key: SoftAuthenticator; att: () => Promise<AuthContext>; sessionId: string }

/** HUMAN's chat 'conv-a' admitted + attached to Rava (ceiling member), checked in so it has its own agent session. */
async function world(): Promise<World> {
  const env = envFor(h)
  const g = await grant(env, HUMAN)
  const key = await admitAndAttach(env, g, 'conv-a')
  const att = (): Promise<AuthContext> => applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'conv-a', codexThreadId: null } })
  const first = await att()
  expect(first.seatBinding?.attached?.agentId).toBe('agent-rava')
  const ci = await invokeTool(first, env, 'check_in', {}, POT)
  expect(ci.ok, JSON.stringify(ci)).toBe(true)
  const sessionId = String((ci.result as { agent_session: { id: string } }).agent_session.id)
  return { env, g, key, att, sessionId }
}

type Out = Awaited<ReturnType<typeof invokeTool>>
const ask = async (w: World, o: { actions?: string[]; scope_type?: string; scope_id?: string; ctx?: AuthContext } = {}): Promise<Out> =>
  invokeTool(o.ctx ?? (await w.att()), w.env, 'request_elevation', {
    actions: o.actions ?? [SUDO], scope_type: o.scope_type ?? 'squad', scope_id: o.scope_id ?? 'squad-core', duration_minutes: 15, reason: 'fix the squad',
  }, POT)
const urlOf = (o: Out): string => String((o.result as { approve_url?: string }).approve_url)
const reqIdOf = (o: Out): string => String((o.result as { request: { id: string } }).request.id)
const text = (o: Out): string => JSON.stringify(o)

/** Decide an ELEVATION moment with a passkey over the real /m/* routes. */
async function decideElevationMoment(e: Env, url: string, a: SoftAuthenticator, decision: 'approve' | 'deny', actions: string[] = [SUDO], duration = 15): Promise<{ status: number; body: J }> {
  const path = new URL(url).pathname
  const csrf = csrfOf(await (await hit(path, e)).text())
  const choice = decision === 'approve' ? { decision, actions, duration_minutes: duration } : { decision }
  const ch = (await (await hit(`${path}/challenge`, e, { method: 'POST', json: { ...choice, csrf } })).json()) as J
  const credential = await a.assert({ rpId: HOST, origin: ORIGIN, challenge: ch.publicKey?.challenge ?? '' })
  const res = await hit(`${path}/decide`, e, { method: 'POST', json: { ...choice, csrf, credential } })
  const raw = await res.text()
  let body: J = {} as J
  try { body = JSON.parse(raw) as J } catch { /* plain text */ }
  return { status: res.status, body }
}

/** The full happy path: ask, the attaching human taps, a live grant exists. */
async function sudo(w: World, o: { scope_type?: string; scope_id?: string } = {}): Promise<string> {
  const r = await ask(w, o)
  expect(r.ok, text(r)).toBe(true)
  const res = await decideElevationMoment(w.env, urlOf(r), w.key, 'approve')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return reqIdOf(r)
}

const squadCap = (id: string): number | null => (one<{ c: number | null }>(`SELECT budget_cap_cents AS c FROM squads WHERE id = ?`, id))!.c
const updateSquad = async (w: World, squad: string, ctx?: AuthContext): Promise<Out> =>
  invokeTool(ctx ?? (await w.att()), w.env, 'update_squad', { squad, budget_cap_cents: 500 }, POT)
const usageRows = (): Array<{ tool_name: string; detail_json: string; agent_session_id: string }> =>
  h.sqlite.prepare(`SELECT tool_name, detail_json, agent_session_id FROM elevation_usage_log ORDER BY rowid`).all() as Array<{ tool_name: string; detail_json: string; agent_session_id: string }>

describe('sudo for attached chats: the request', () => {
  it('requests action:org_structure -> pending, bound to the ATTACHMENT\'s own agent session, with an approve link', async () => {
    const w = await world()
    const r = await ask(w)
    expect(r.ok, text(r)).toBe(true)
    expect(urlOf(r)).toMatch(/\/m\//)
    const row = one<{ agent_session_id: string; agent_id: string; status: string }>(`SELECT agent_session_id, agent_id, status FROM elevation_requests`)!
    expect(row).toMatchObject({ agent_session_id: w.sessionId, agent_id: 'agent-rava', status: 'pending' })
    // that session's credential IS the attachment's own token (not the agent's, not the human's grant token)
    const att = one<{ seat_token_id: string }>(`SELECT seat_token_id FROM agent_seat_attachments WHERE detached_at IS NULL`)!
    expect(one<{ credential_id: string }>(`SELECT credential_id FROM agent_sessions WHERE id = ?`, w.sessionId)!.credential_id).toBe(att.seat_token_id)
  })

  it.each([
    ['action:mint_token'], ['action:manage_access'], ['action:org_department_create'], ['action:register_key'], ['action:deploy'],
    ['action:secrets'], ['action:migrate'], ['action:routine_archive'], ['action:home_access'], ['action:project_status'],
  ])('%s is refused for an attached chat (allow-list), and no request row is written', async (action) => {
    const w = await world()
    const r = await ask(w, { actions: [action] })
    expect(r.ok).toBe(false)
    expect(text(r)).toContain('attached_seat_cannot_elevate')
    expect(n(`SELECT COUNT(*) AS n FROM elevation_requests`)).toBe(0)
  })

  it('a mixed ask (one allowed + one not) is refused whole, and an empty ask is refused', async () => {
    const w = await world()
    expect(text(await ask(w, { actions: [SUDO, 'action:mint_token'] }))).toContain('attached_seat_cannot_elevate')
    expect(text(await ask(w, { actions: [] }))).toContain('attached_seat_cannot_elevate')
    expect(n(`SELECT COUNT(*) AS n FROM elevation_requests`)).toBe(0)
  })

  it('the allow-list is exactly the reversible org-structure act (a one-line, reviewed change to extend)', () => {
    expect([...ATTACHED_SUDO_ACTIONS]).toEqual([SUDO])
  })
})

describe('sudo for attached chats: who approves', () => {
  it('the attaching human approves with their passkey: a live grant on the attachment session, approved by them', async () => {
    const w = await world()
    const id = await sudo(w)
    const g = one<{ agent_session_id: string; approved_by_member_id: string; action: string; scope_id: string }>(`SELECT agent_session_id, approved_by_member_id, action, scope_id FROM elevation_grants`)!
    expect(g).toEqual({ agent_session_id: w.sessionId, approved_by_member_id: HUMAN, action: SUDO, scope_id: 'squad-core' })
    expect((await loadElevationRequestById(w.env, TENANT, id))?.status).toBe('approved')
  })

  it('ANOTHER org admin cannot approve (or deny) it: refused over the real passkey route, the link is not burned, nothing is granted', async () => {
    const w = await world()
    const other = await enrolPasskey(w.env, HUMAN3, `${HUMAN3}@example.test`)
    const r = await ask(w)
    const res = await decideElevationMoment(w.env, urlOf(r), other, 'approve')
    expect(res.status).toBe(404) // the same "nothing here for you" an unauthorised admin gets everywhere
    expect((await decideElevationMoment(w.env, urlOf(r), other, 'deny')).status).toBe(404)
    expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(0)
    expect(one<{ status: string }>(`SELECT status FROM elevation_requests`)!.status).toBe('pending')
    // and the link still works for the human who attached it
    expect((await decideElevationMoment(w.env, urlOf(r), w.key, 'approve')).status).toBe(200)
    expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(1)
  })

  it('every decision surface agrees: the other admin is not offered it (mayDecide / canDecide / dashboard list), the attaching human is', async () => {
    const w = await world()
    const r = await ask(w)
    const req = (await loadElevationRequestById(w.env, TENANT, reqIdOf(r)))!
    const authOf = async (id: string): Promise<AuthContext> => ({ memberId: id, userId: id, role: 'member', tenant: TENANT, capabilities: await resolveCapabilities(w.env, id) }) as unknown as AuthContext
    const human = await authOf(HUMAN)
    const admin3 = await authOf(HUMAN3)
    expect(await mayDecideElevation(w.env, human, req)).toBe(true)
    expect(await mayDecideElevation(w.env, admin3, req)).toBe(false)
    expect(await canDecideElevationRequest(w.env, admin3, admin3.capabilities, req, HUMAN3)).toBe(false)
    const page = async (a: AuthContext, id: string): Promise<string> => String(await pendingRequestsBody(w.env, { ...a, webSessionMemberId: id } as AuthContext))
    expect(await page(human, HUMAN)).toContain('CHAT attached to')
    expect(await page(admin3, HUMAN3)).not.toContain('CHAT attached to')
  })

  it('at the decide transaction itself (no UI): another org admin is forbidden, the attaching human is not (recent reauth)', async () => {
    const w = await world()
    const r = await ask(w)
    const mk = async (member: string): Promise<{ hash: string; caps: Awaited<ReturnType<typeof resolveCapabilities>> }> => {
      const idn = `ident-${member}`
      h.sqlite.exec(`INSERT OR IGNORE INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES ('${idn}', '${TENANT}', 'google', 's-${member}', '${member}@x.test', '${member}', datetime('now'))`)
      const s = await createWebSession(w.env, `raw-${member}-${++rawSeq}`, { tenant: TENANT, memberId: member, loginIdentityId: idn })
      return { hash: s.id_hash, caps: await resolveCapabilities(w.env, member) }
    }
    const decideAs = async (member: string, reauth: boolean) => {
      const m = await mk(member)
      return decideElevationRequest(w.env, {
        tenant: TENANT, requestId: reqIdOf(r), decision: 'approve', selectedActions: [SUDO], decidedByMemberId: member,
        decidedByIsOrgAdmin: member === HUMAN3, decidedByCapabilities: m.caps, decidedByWebSessionHash: m.hash, recentReauthOk: reauth,
      })
    }
    expect(await decideAs(HUMAN3, true)).toMatchObject({ ok: false, reason: 'forbidden' })
    // an attached chat's request is ALWAYS a step-up decision, even though org_structure is not itself "sensitive"
    expect(await decideAs(HUMAN, false)).toMatchObject({ ok: false, reason: 'reauth_required' })
    expect(await decideAs(HUMAN, true)).toMatchObject({ ok: true })
  })

  it('the human cannot approve a scope they do not administer (the approver rule is the ceiling): a request on squad-other is not decidable by them', async () => {
    const w = await world()
    const r = await ask(w, { scope_id: 'squad-other' })
    expect(r.ok, text(r)).toBe(true) // requestable; the AUTHORITY is checked at the decision
    const res = await decideElevationMoment(w.env, urlOf(r), w.key, 'approve')
    expect(res.status).toBe(404)
    expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(0)
  })

  it('the approval page names the origin: requested from a CHAT attached to <agent>', async () => {
    const w = await world()
    const r = await ask(w)
    const html = await (await hit(new URL(urlOf(r)).pathname, w.env)).text()
    expect(html).toContain('a CHAT attached to Rava')
  })
})

describe('sudo for attached chats: use', () => {
  it('without a grant: refused, and the refusal names the exact call (action + scope + RESOLVED id) and who approves', async () => {
    const w = await world()
    const out = await updateSquad(w, 'core-sqd') // a slug, resolved to the id
    expect(out.ok).toBe(false)
    const t = text(out)
    expect(t).toContain('attached_thread_without_matching_sudo_grant')
    expect(t).toContain('request_elevation')
    expect(t).toContain('"scope_id":"squad-core"')
    expect(t).toContain('action:org_structure')
    expect(t).toContain('your human approves with their passkey')
    expect(squadCap('squad-core')).toBeNull()
    const dept = await invokeTool(await w.att(), w.env, 'update_department', { department: 'dept-squad-core', name: 'X' }, POT)
    expect(text(dept)).toContain('attached_thread_without_matching_sudo_grant')
    expect(text(dept)).toContain('"scope_type":"department"')
  })

  it('with the human-approved grant: update_squad works once approved, exactly one usage row AFTER the write, carrying the attachment', async () => {
    const w = await world()
    expect((await updateSquad(w, 'squad-core')).ok).toBe(false) // baseline: refused before the tap
    await sudo(w)
    const out = await updateSquad(w, 'squad-core')
    expect(out.ok, text(out)).toBe(true)
    expect(squadCap('squad-core')).toBe(500)
    const rows = usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool_name: 'update_squad', agent_session_id: w.sessionId })
    const attachmentId = one<{ id: string }>(`SELECT id FROM agent_seat_attachments`)!.id
    expect(JSON.parse(rows[0]!.detail_json)).toMatchObject({ attachment_id: attachmentId, attached_human_member_id: HUMAN, squad_id: 'squad-core' })
  })

  it('a refused or failed attempt writes NO usage row', async () => {
    const w = await world()
    await sudo(w)
    expect((await updateSquad(w, 'squad-other')).ok).toBe(false)
    expect(usageRows()).toHaveLength(0)
  })

  it('the wrong-scope target is refused even with a live grant (the grant is for squad-core only), and names the right call for the target', async () => {
    const w = await world()
    await sudo(w)
    const out = await updateSquad(w, 'other-sqd')
    expect(out.ok).toBe(false)
    expect(text(out)).toContain('attached_thread_without_matching_sudo_grant')
    expect(text(out)).toContain('"scope_id":"squad-other"')
    expect(squadCap('squad-other')).toBeNull()
  })

  it('an elevated attached chat can only LOWER a squad budget cap (the existing elevated-agent rule still applies)', async () => {
    const w = await world()
    await sudo(w)
    h.sqlite.exec(`UPDATE squads SET budget_cap_cents = 100 WHERE id = 'squad-core'`)
    const raise = await updateSquad(w, 'squad-core') // 500 > 100
    expect(raise.ok).toBe(false)
    expect(squadCap('squad-core')).toBe(100)
  })

  it('the grant opens ONLY the org-structure tools: nothing else the chat could reach opens with it', async () => {
    const w = await world()
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('org-h1', '${HUMAN}', 'org', NULL, 'admin')`)
    await sudo(w, { scope_type: 'org', scope_id: '' })
    const ctx = await w.att()
    const before = { agents: n(`SELECT COUNT(*) AS n FROM agents`), depts: n(`SELECT COUNT(*) AS n FROM departments`), tokens: n(`SELECT COUNT(*) AS n FROM member_tokens`), caps: n(`SELECT COUNT(*) AS n FROM capabilities`), squads: n(`SELECT COUNT(*) AS n FROM squads`) }
    const calls: Array<[string, Record<string, unknown>]> = [
      ['create_department', { slug: 'ops-dept', name: 'Ops' }],
      ['mint_agent_token', { agent: 'rava' }],
      ['grant_agent_capability', { agent: 'rava', squad: 'squad-core', capability: 'admin' }],
      ['create_squad', { department: 'dept-squad-core', slug: 'new-sqd', name: 'New' }],
      ['register_agent_key', { agent: 'rava', public_key_x: 'A'.repeat(43) }],
      ['revoke_agent_token', { token_id: 'x' }],
      ['project_create', { slug: 'p', name: 'P' }],
      ['routine_archive', { routine: 'x' }],
    ]
    for (const [tool, a] of calls) expect((await invokeTool(ctx, w.env, tool, a, POT)).ok, `${tool} must stay refused`).toBe(false)
    expect({ agents: n(`SELECT COUNT(*) AS n FROM agents`), depts: n(`SELECT COUNT(*) AS n FROM departments`), tokens: n(`SELECT COUNT(*) AS n FROM member_tokens`), caps: n(`SELECT COUNT(*) AS n FROM capabilities`), squads: n(`SELECT COUNT(*) AS n FROM squads`) }).toEqual(before)
    // control: the SAME grant does open the squad tool (so the refusals above are the guards, not a broken fixture)
    expect((await updateSquad(w, 'squad-core', ctx)).ok).toBe(true)
  })

  it('create_department stays refused for an attached chat even if a forged org grant for its action is bound to the attachment session', async () => {
    const w = await world()
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('org-h1', '${HUMAN}', 'org', NULL, 'admin')`)
    const ws = await liveWebSession(w, HUMAN)
    h.sqlite.prepare(`INSERT INTO elevation_requests (id, tenant, agent_session_id, agent_id, member_id, requested_actions_json, requested_scope_type, requested_scope_id, requested_duration_minutes, reason, status, created_at, decision_expires_at) VALUES ('rq-f', ?, ?, 'agent-rava', 'mem-agent-rava', '["action:org_department_create"]', 'org', '', 15, 'x', 'approved', ?, ?)`).run(TENANT, w.sessionId, isoIn(0), isoIn(10))
    h.sqlite.prepare(`INSERT INTO elevation_grants (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect, approved_by_member_id, approved_by_web_session_hash, created_at, expires_at) VALUES ('gr-f', ?, 'rq-f', ?, 'action:org_department_create', 'org', '', 'irreversible', ?, ?, ?, ?)`).run(TENANT, w.sessionId, HUMAN, ws, isoIn(0), isoIn(15))
    const out = await invokeTool(await w.att(), w.env, 'create_department', { slug: 'sneaky', name: 'Sneaky' }, POT)
    expect(out.ok).toBe(false)
    expect(n(`SELECT COUNT(*) AS n FROM departments WHERE slug = 'sneaky'`)).toBe(0)
    const direct = await hasElevatedAction(w.env, await w.att(), 'action:org_department_create', 'org', null, { recordUsage: false })
    expect(direct).toEqual({ granted: false, reason: 'attached_action_not_sudoable' })
  })
})

/** A LIVE web session for a member (so a hand-built grant is not refused for a dead approver session). */
async function liveWebSession(w: World, member: string): Promise<string> {
  const idn = `ident-${member}`
  h.sqlite.exec(`INSERT OR IGNORE INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES ('${idn}', '${TENANT}', 'google', 's-${member}', '${member}@x.test', '${member}', datetime('now'))`)
  return (await createWebSession(w.env, `raw-live-${member}-${++rawSeq}`, { tenant: TENANT, memberId: member, loginIdentityId: idn })).id_hash
}

describe('sudo for attached chats: the grant belongs to ONE attachment', () => {
  it('a second attached chat of the same agent, the agent\'s own session, and the human\'s own plain seat do NOT inherit it', async () => {
    const w = await world()
    await sudo(w)
    expect((await updateSquad(w, 'squad-core')).ok).toBe(true) // control: the attached chat that asked has it
    // (a) a SECOND chat attached to the same agent by the same human
    await boot(w.env, w.g, 'conv-b')
    // fixture: a live admission is bound to the chat that asked (#2054); re-point it so a second chat of the same agent can attach
    h.sqlite.exec(`DROP TRIGGER IF EXISTS agent_seat_admissions_requested_seat_immutable`)
    h.sqlite.exec(`UPDATE agent_seat_admissions SET requested_seat_id = (SELECT s.id FROM agent_seats s WHERE NOT EXISTS (SELECT 1 FROM agent_seat_attachments a WHERE a.seat_id = s.id AND a.detached_at IS NULL) ORDER BY s.created_at, s.rowid LIMIT 1) WHERE agent_id = 'agent-rava' AND status = 'live'`)
    expect((await attach(w.env, w.g, 'conv-b', 'rava')).sc.status).toBe('attached')
    const second = await applySeatForRequest(w.env, w.g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'conv-b', codexThreadId: null } })
    expect(second.seatBinding?.attached?.agentId).toBe('agent-rava')
    expect(second.seatBinding?.attached?.attachmentId).not.toBe((await w.att()).seatBinding?.attached?.attachmentId)
    await invokeTool(second, w.env, 'check_in', {}, POT)
    h.sqlite.exec(`UPDATE squads SET budget_cap_cents = NULL WHERE id = 'squad-core'`)
    expect((await updateSquad(w, 'squad-core', second)).ok).toBe(false)
    expect(squadCap('squad-core')).toBeNull()
    // (b) the agent's OWN session (a plain agent token, not attached)
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at) VALUES ('tok-own', 'mem-agent-rava', 'hash-own', 'own', 'workspace', '${TENANT}', 'agent-rava', datetime('now'))`)
    const own = { userId: 'mem-agent-rava', memberId: 'mem-agent-rava', email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: 'agent-rava', tokenId: 'tok-own',
      capabilities: [{ member_id: 'mem-agent-rava', scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }] } as unknown as AuthContext
    expect((await invokeTool(own, w.env, 'check_in', {}, POT)).ok).toBe(true)
    expect((await updateSquad(w, 'squad-core', own)).ok).toBe(false)
    // (c) the human's own plain (unattached) seat
    const plain = await applySeatForRequest(w.env, w.g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'conv-z', codexThreadId: null } })
    expect(plain.seatBinding?.attached).toBeUndefined()
    expect((await updateSquad(w, 'squad-core', plain)).ok).toBe(false)
    expect(squadCap('squad-core')).toBeNull()
    // and the chat that asked still has it
    expect((await updateSquad(w, 'squad-core')).ok).toBe(true)
  })

  it('a grant approved by anyone but the attaching human (forged past the decision) does not count at USE: approver_not_attaching_human', async () => {
    const w = await world()
    const ws = await liveWebSession(w, HUMAN3)
    h.sqlite.prepare(`INSERT INTO elevation_requests (id, tenant, agent_session_id, agent_id, member_id, requested_actions_json, requested_scope_type, requested_scope_id, requested_duration_minutes, reason, status, created_at, decision_expires_at) VALUES ('rq-f', ?, ?, 'agent-rava', 'mem-agent-rava', '["action:org_structure"]', 'org', '', 15, 'x', 'approved', ?, ?)`).run(TENANT, w.sessionId, isoIn(0), isoIn(10))
    h.sqlite.prepare(`INSERT INTO elevation_grants (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect, approved_by_member_id, approved_by_web_session_hash, created_at, expires_at) VALUES ('gr-f', ?, 'rq-f', ?, 'action:org_structure', 'org', '', 'reversible', ?, ?, ?, ?)`).run(TENANT, w.sessionId, HUMAN3, ws, isoIn(0), isoIn(15))
    const direct = await hasElevatedAction(w.env, await w.att(), SUDO, 'squad', 'squad-core', { recordUsage: false })
    expect(direct).toEqual({ granted: false, reason: 'approver_not_attaching_human' })
    expect((await updateSquad(w, 'squad-core')).ok).toBe(false)
    expect(squadCap('squad-core')).toBeNull()
  })

  it('a request FORGED with a non-sudoable action on the attachment session is refused at the decision, even for the attaching human', async () => {
    const w = await world()
    const forged = await createElevationRequest(w.env, { tenant: TENANT, agentSessionId: w.sessionId, agentId: 'agent-rava', memberId: 'mem-agent-rava', actions: ['action:mint_token'], scopeType: 'squad', scopeId: 'squad-core', durationMinutes: 15, reason: 'forged' })
    expect(forged.ok).toBe(true)
    const hash = await liveWebSession(w, HUMAN)
    const res = await decideElevationRequest(w.env, {
      tenant: TENANT, requestId: forged.ok ? forged.request.id : '', decision: 'approve', selectedActions: ['action:mint_token'], decidedByMemberId: HUMAN,
      decidedByCapabilities: await resolveCapabilities(w.env, HUMAN), decidedByWebSessionHash: hash, recentReauthOk: true,
    })
    expect(res).toMatchObject({ ok: false, reason: 'invalid_elevation_request' })
    expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(0)
  })

  it('a forged grant for a non-sudoable action bound to the attachment session never opens its tool (attached_action_not_sudoable at use)', async () => {
    const w = await world()
    const ws = await liveWebSession(w, HUMAN)
    h.sqlite.prepare(`INSERT INTO elevation_requests (id, tenant, agent_session_id, agent_id, member_id, requested_actions_json, requested_scope_type, requested_scope_id, requested_duration_minutes, reason, status, created_at, decision_expires_at) VALUES ('rq-m', ?, ?, 'agent-rava', 'mem-agent-rava', '["action:mint_token"]', 'squad', 'squad-core', 15, 'x', 'approved', ?, ?)`).run(TENANT, w.sessionId, isoIn(0), isoIn(10))
    h.sqlite.prepare(`INSERT INTO elevation_grants (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect, approved_by_member_id, approved_by_web_session_hash, created_at, expires_at) VALUES ('gr-m', ?, 'rq-m', ?, 'action:mint_token', 'squad', 'squad-core', 'revocable_if_recorded', ?, ?, ?, ?)`).run(TENANT, w.sessionId, HUMAN, ws, isoIn(0), isoIn(15))
    const tokensBefore = n(`SELECT COUNT(*) AS n FROM member_tokens`)
    const out = await invokeTool(await w.att(), w.env, 'mint_agent_token', { agent: 'rava' }, POT)
    expect(out.ok).toBe(false)
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens`)).toBe(tokensBefore)
    expect(await hasElevatedAction(w.env, await w.att(), 'action:mint_token', 'squad', 'squad-core', { recordUsage: false })).toEqual({ granted: false, reason: 'attached_action_not_sudoable' })
  })
})

describe('sudo for attached chats: it ends with the attachment, and with its clock', () => {
  it('expiry: past the approved window the grant is dead', async () => {
    const w = await world()
    await sudo(w)
    expect((await updateSquad(w, 'squad-core')).ok).toBe(true)
    h.sqlite.exec(`UPDATE elevation_grants SET expires_at = '${isoIn(-1)}'`)
    h.sqlite.exec(`UPDATE squads SET budget_cap_cents = NULL WHERE id = 'squad-core'`)
    expect((await updateSquad(w, 'squad-core')).ok).toBe(false)
    expect(squadCap('squad-core')).toBeNull()
  })

  const attId = (): string => one<{ id: string }>(`SELECT id FROM agent_seat_attachments WHERE detached_at IS NULL`)!.id
  const admId = (): string => one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!.id

  const endings: Array<[string, (w: World) => Promise<void>]> = [
    ['detach', async (w) => { expect(await detachAttachment(w.env, { attachmentId: attId(), humanMemberId: HUMAN })).toEqual({ ok: true }) }],
    ['admission revoke', async (w) => { expect((await revokeAdmission(w.env, { admissionId: admId(), humanMemberId: HUMAN })).ok).toBe(true) }],
    ['seat retire', async () => { h.sqlite.exec(`UPDATE agent_seats SET retired_at = '2026-10-13T00:00:00.000Z'`) }],
    ['idle sweep', async (w) => {
      h.sqlite.exec(`DROP TRIGGER agent_seat_attachments_immutable`)
      h.sqlite.exec(`UPDATE agent_seat_attachments SET created_at = '2020-01-01T00:00:00.000Z', last_used_at = '2020-01-01T00:00:00.000Z'`)
      const harnessId = one<{ harness_id: string }>(`SELECT harness_id FROM agent_seat_attachments LIMIT 1`)!.harness_id
      await prepareIdleAttachmentSweep(w.env, harnessId, new Date().toISOString(), 0).run()
    }],
  ]
  it.each(endings)('%s kills a live sudo grant mid-window: a fresh request AND a ctx a caller still holds are both refused', async (_name, end) => {
    const w = await world()
    await sudo(w)
    const stale = await w.att() // built while the attachment was live
    expect((await updateSquad(w, 'squad-core', stale)).ok).toBe(true) // control: the grant is live right now
    h.sqlite.exec(`UPDATE squads SET budget_cap_cents = NULL WHERE id = 'squad-core'`)
    await end(w)
    // (1) the stale ctx is refused at USE time (hasElevatedAction re-reads the attachment)
    expect(await hasElevatedAction(w.env, stale, SUDO, 'squad', 'squad-core', { recordUsage: false })).toEqual({ granted: false, reason: 'attachment_ended' })
    expect((await updateSquad(w, 'squad-core', stale)).ok).toBe(false)
    // (2) the next real request is no longer attached at all
    const fresh = await w.att()
    expect(fresh.seatBinding?.attached).toBeUndefined()
    expect((await updateSquad(w, 'squad-core', fresh)).ok).toBe(false)
    expect(squadCap('squad-core')).toBeNull()
  })

  it('detach alone (token-revoke cleanup trigger dropped) still ends sudo: the attachment row, not the token, is the authority', async () => {
    const w = await world()
    await sudo(w)
    const stale = await w.att()
    h.sqlite.exec(`DROP TRIGGER agent_seat_attachments_revoke_token`)
    await detachAttachment(w.env, { attachmentId: attId(), humanMemberId: HUMAN })
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens WHERE id = ? AND revoked_at IS NULL`, one<{ t: string }>(`SELECT seat_token_id AS t FROM agent_seat_attachments`)!.t)).toBe(1) // token still live: only detached_at ended it
    expect((await w.att()).seatBinding?.attached).toBeUndefined()
    expect(await hasElevatedAction(w.env, stale, SUDO, 'squad', 'squad-core', { recordUsage: false })).toEqual({ granted: false, reason: 'attachment_ended' })
    expect((await updateSquad(w, 'squad-core', stale)).ok).toBe(false)
    expect(squadCap('squad-core')).toBeNull()
  })

  it('the decide transaction itself refuses a request whose attachment already ended (and closes it), even for the attaching human', async () => {
    const w = await world()
    const r = await ask(w)
    await detachAttachment(w.env, { attachmentId: attId(), humanMemberId: HUMAN })
    const hash = await liveWebSession(w, HUMAN)
    const res = await decideElevationRequest(w.env, {
      tenant: TENANT, requestId: reqIdOf(r), decision: 'approve', selectedActions: [SUDO], decidedByMemberId: HUMAN,
      decidedByCapabilities: await resolveCapabilities(w.env, HUMAN), decidedByWebSessionHash: hash, recentReauthOk: true,
    })
    expect(res).toMatchObject({ ok: false, reason: 'agent_session_ended' })
    expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(0)
  })

  it('re-attaching later is a NEW attachment (new credential, new session): the old grant is not inherited', async () => {
    const w = await world()
    await sudo(w)
    await detachAttachment(w.env, { attachmentId: attId(), humanMemberId: HUMAN })
    expect((await attach(w.env, w.g, 'conv-a', 'rava')).sc.status).toBe('attached')
    const again = await w.att()
    expect(again.seatBinding?.attached?.agentId).toBe('agent-rava')
    await invokeTool(again, w.env, 'check_in', {}, POT)
    expect((await updateSquad(w, 'squad-core', again)).ok).toBe(false)
    expect(squadCap('squad-core')).toBeNull()
  })

  it('a request pending when the chat detaches can no longer be approved (its session is gone)', async () => {
    const w = await world()
    const r = await ask(w)
    await detachAttachment(w.env, { attachmentId: attId(), humanMemberId: HUMAN })
    const res = await decideElevationMoment(w.env, urlOf(r), w.key, 'approve')
    expect(res.status).not.toBe(200)
    expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(0)
  })
})

describe('sudo for attached chats: what stays refused WITH a live grant', () => {
  it('every host-state refusal still holds (presence, fleet, inbox consume, capacity, usage, doorbell, update_agent, host keys, gate edges)', async () => {
    const env = envFor(h)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('org-h5', '${HUMAN}', 'org', NULL, 'admin'), ('org-r5', 'mem-agent-rava', 'org', NULL, 'admin')`)
    const g = await grant(env, HUMAN)
    const key = await admitAndAttach(env, g, 'conv-a')
    h.sqlite.exec(`DROP TRIGGER agent_seat_admissions_immutable`)
    h.sqlite.exec(`UPDATE agent_seat_admissions SET ceiling = 'full'`)
    const w: World = { env, g, key, sessionId: '', att: () => applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'conv-a', codexThreadId: null } }) }
    const first = await w.att()
    expect(first.seatBinding?.attached?.ceiling).toBe('full')
    const ci = await invokeTool(first, env, 'check_in', {}, POT)
    w.sessionId = String((ci.result as { agent_session: { id: string } }).agent_session.id)
    await sudo(w, { scope_type: 'org', scope_id: '' })
    const att = await w.att()
    expect(await hasElevatedAction(env, att, SUDO, 'squad', 'squad-core', { recordUsage: false })).toMatchObject({ granted: true }) // the grant is LIVE for this very ctx
    const code = async (tool: string, a: Record<string, unknown>, e: Env = env): Promise<string> => JSON.stringify(await invokeTool(att, e, tool, a, POT))

    expect(await code('approve_gate_edge', { circuit_id: 'c1', edge_id: 'e1' })).toContain('attached_seat_no_gate_authority')
    expect(await code('request_elevation', { actions: ['action:project_status'], scope_type: 'squad', scope_id: 'squad-core', duration_minutes: 15, reason: 'x' })).toContain('attached_seat_cannot_elevate')
    const bell = await code('set_agent_webhook_doorbell', { webhook_url: 'https://hooks.example.test/wake', bearer: 'x'.repeat(24) }, { ...env, WEBHOOK_DOORBELL: '1' } as Env)
    expect(bell).toContain('"ok":false')
    expect(n(`SELECT COUNT(*) AS n FROM agent_webhook_doorbells`)).toBe(0)
    expect(await code('update_agent', { agent: 'agent-rava', purpose: 'hijacked purpose' })).toContain('"ok":false')
    expect(one<{ purpose: string | null }>(`SELECT purpose FROM agents WHERE id = 'agent-rava'`)!.purpose).not.toBe('hijacked purpose')
    expect(await code('check_in', { presence_mode: 'poll', poll_interval_sec: 30 })).toContain('attached_seat_cannot_set_presence_mode')
    expect(await code('check_in', { presence_mode: 'resident' })).toContain('attached_seat_cannot_set_presence_mode')
    for (const [tool, a] of [['presence_register', { adapter: 'x' }], ['presence_heartbeat', {}], ['presence_deregister', {}], ['report_run_usage', { run_id: 'r1', model: 'm', input: 1, output: 1 }], ['list_agent_sessions', {}]] as Array<[string, Record<string, unknown>]>) {
      expect(await code(tool, a), tool).toContain('attached_seat_not_agent_host')
    }
    expect(n(`SELECT COUNT(*) AS n FROM module_registry`)).toBe(0)
    h.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body) VALUES ('m-host', '${TENANT}', 'agent-rava', 'agent-x', 'mem-x', 'message', 'for the host')`)
    for (const [tool, a] of [['inbox', { limit: 5 }], ['inbox_lease', {}], ['inbox_lease_reconcile', { attempt_id: 'x' }], ['inbox_lease_ack', { attempt_id: 'x' }], ['inbox_ack', { ids: ['m-host'] }]] as Array<[string, Record<string, unknown>]>) {
      expect(await code(tool, a), tool).toContain('attached_seat_peek_only')
    }
    expect(one<{ read_at: string | null }>(`SELECT read_at FROM agent_messages WHERE id = 'm-host'`)!.read_at).toBeNull()
    expect(await code('harness_capacity_report', { harness: 'orca', host_key: 'h', observed_at: Date.now(), live_terminals: 1, agent_sessions: 1, busy_recent: 0, orphaned_terminals: 0, workers_active: 0, workers_release_unknown: 0, worktrees_with_live: 0 })).toContain('attached_seat_not_agent_host')
    expect(await code('host_key_register', { agent: 'rava', public_key: 'A'.repeat(43) })).toContain('"ok":false')
    expect(await code('register_agent_key', { agent: 'rava', public_key_x: 'A'.repeat(43) })).toContain('"ok":false')
    expect(n(`SELECT COUNT(*) AS n FROM agent_keys`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM presence WHERE member_id = 'mem-agent-rava'`)).toBe(0)
    // and the one thing sudo is FOR still works for this very ctx
    expect((await invokeTool(att, env, 'update_squad', { squad: 'squad-core', budget_cap_cents: 500 }, POT)).ok).toBe(true)
  })

  it('human lane and non-attached agent lane are unchanged: a standing org admin updates a squad; a plain agent session decided by an org admin still works', async () => {
    const w = await world()
    const human = { userId: HUMAN3, memberId: HUMAN3, email: null, role: 'admin', tenant: TENANT, channel: 'workspace', boundAgentId: null,
      capabilities: [{ member_id: HUMAN3, scope_type: 'org', scope_id: null, capability: 'admin' }] } as unknown as AuthContext
    expect((await invokeTool(human, w.env, 'update_squad', { squad: 'squad-core', budget_cap_cents: 700 }, POT)).ok).toBe(true)
    expect(squadCap('squad-core')).toBe(700)
    // a plain (non-attached) agent session: ANY org admin may decide its request (the attachment rule is a no-op), no forced step-up for a non-sensitive act
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at) VALUES ('tok-own', 'mem-agent-hadi-admin', 'hash-own', 'own', 'workspace', '${TENANT}', 'agent-hadi-admin', datetime('now'))`)
    const own = { userId: 'mem-agent-hadi-admin', memberId: 'mem-agent-hadi-admin', email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: 'agent-hadi-admin', tokenId: 'tok-own',
      capabilities: [{ member_id: 'mem-agent-hadi-admin', scope_type: 'squad', scope_id: 'squad-core', capability: 'member' }] } as unknown as AuthContext
    const ci = await invokeTool(own, w.env, 'check_in', {}, POT)
    const sid = String((ci.result as { agent_session: { id: string } }).agent_session.id)
    const r = await createElevationRequest(w.env, { tenant: TENANT, agentSessionId: sid, agentId: 'agent-hadi-admin', memberId: 'mem-agent-hadi-admin', actions: [SUDO], scopeType: 'squad', scopeId: 'squad-core', durationMinutes: 15, reason: 'plain' })
    expect(r.ok).toBe(true)
    const hash = await liveWebSession(w, HUMAN3)
    const res = await decideElevationRequest(w.env, {
      tenant: TENANT, requestId: r.ok ? r.request.id : '', decision: 'approve', selectedActions: [SUDO], decidedByMemberId: HUMAN3, decidedByIsOrgAdmin: true,
      decidedByCapabilities: await resolveCapabilities(w.env, HUMAN3), decidedByWebSessionHash: hash, recentReauthOk: false,
    })
    expect(res).toMatchObject({ ok: true })
  })
})

describe('sudo for attached chats: review fixes (#1913 gate round 1)', () => {
  const BOT = '123456789'
  const BOT_TOKEN = `${BOT}:AAEhqMY-dedicated-miniapp-test-token`

  it('the no-grant refusal hands back ids of WORK targets only: a home squad and an unknown name get the same placeholder', async () => {
    const w = await world()
    h.sqlite.exec("UPDATE squads SET kind = 'home' WHERE id = 'squad-other'")
    const home = text(await updateSquad(w, 'squad-other'))
    const unknown = text(await updateSquad(w, 'no-such-squad-anywhere'))
    const work = text(await updateSquad(w, 'squad-core'))
    expect(home).not.toContain('squad-other')
    expect(home).toContain('<the squad id>')
    expect(unknown).toContain('<the squad id>')
    expect(work).toContain('"scope_id":"squad-core"')
  })

  it('a seat retired after the request was filed can no longer be approved (decide-time liveness = use-time liveness)', async () => {
    const w = await world()
    const r = await ask(w)
    h.sqlite.exec("UPDATE agent_seats SET retired_at = '2026-10-14 00:00:00'")
    const hash = await liveWebSession(w, HUMAN)
    const res = await decideElevationRequest(w.env, {
      tenant: TENANT, requestId: reqIdOf(r), decision: 'approve', selectedActions: [SUDO], decidedByMemberId: HUMAN,
      decidedByCapabilities: await resolveCapabilities(w.env, HUMAN), decidedByWebSessionHash: hash, recentReauthOk: true,
    })
    expect(res.ok).toBe(false)
    expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(0)
  })

  it('Telegram delivery for an attached chat goes to the ATTACHING human, not the agent owner (they differ here)', async () => {
    const w = await world()
    Object.assign(w.env, { TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_BOT_ID: BOT, TELEGRAM_MINIAPP_BOT_TOKEN: BOT_TOKEN })
    h.sqlite.exec(`
      UPDATE agents SET owner_member_id = '${HUMAN2}' WHERE id = 'agent-rava';
      UPDATE members SET telegram_chat_id = '2002' WHERE id = '${HUMAN2}';
      UPDATE members SET telegram_chat_id = '1001' WHERE id = '${HUMAN}';
      UPDATE members SET telegram_chat_id = '3003' WHERE id = '${HUMAN3}';
    `)
    const chats: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      chats.push(String((JSON.parse(String(init?.body)) as { chat_id: string }).chat_id))
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 })
    }) as typeof fetch
    try {
      const r = await ask(w)
      expect(r.ok, text(r)).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
    expect(chats).toEqual(['1001']) // the attaching human only; never the owner (2002) or another org admin (3003)
  })
})

describe('sudo for attached chats: step-up + liveness follow-ups (#1915 A and B)', () => {
  it('A: an attached chat\'s request cannot be APPROVED over Telegram (core backstop); nothing is granted, the gate never runs, the request stays open; an unlisted channel is refused the same way', async () => {
    const w = await world()
    const r = await ask(w)
    const human = { memberId: HUMAN, userId: HUMAN, role: 'member', tenant: TENANT, capabilities: await resolveCapabilities(w.env, HUMAN) } as unknown as AuthContext
    const gate = vi.fn(async () => true)
    const mint = vi.fn(async () => { throw new Error('must not mint a session for a refused approval') })
    const base = { id: reqIdOf(r), durationMinutes: 15, mintSession: mint, gate, auth: human, proof: { memberId: HUMAN, via: 'telegram_miniapp' as const, evidence: {} } }
    const approve = await decideElevation(w.env, { ...base, decision: 'approve', selectedActions: [SUDO] })
    expect(approve.status).toBe(403)
    expect(approve.title).toBe('Use a passkey')
    expect(gate).not.toHaveBeenCalled()
    expect(mint).not.toHaveBeenCalled()
    expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(0)
    expect(one<{ status: string }>(`SELECT status FROM elevation_requests WHERE id = ?`, reqIdOf(r))!.status).toBe('pending')
    // a channel that is not on the passkey-class allow-list is refused the same way (an unknown future channel gets no approval power)
    const future = await decideElevation(w.env, { ...base, decision: 'approve', selectedActions: [SUDO], proof: { memberId: HUMAN, via: 'slack_future' as unknown as 'webauthn', evidence: {} } })
    expect(future.status).toBe(403)
  })

  it('A: attachedOriginRefusal refuses an attached-origin APPROVE and allows a DENY; an ordinary agent request is not affected', async () => {
    const w = await world()
    const r = await ask(w)
    const req = (await loadElevationRequestById(w.env, TENANT, reqIdOf(r)))!
    expect(await attachedOriginRefusal(w.env, req, 'approve')).toBe(ATTACHED_PASSKEY_MESSAGE)
    expect(await attachedOriginRefusal(w.env, req, 'deny')).toBeNull()
    // a request whose session is not an attachment's (here: no such session) is untouched by the rule
    expect(await attachedOriginRefusal(w.env, { ...req, agent_session_id: 'no-such-session' }, 'approve')).toBeNull()
  })

  it('A (wiring ratchet): the challenge AND decide Telegram routes both call attachedOriginRefusal (source-level, because a signed-initData route harness is not built here)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'secure-moments', 'telegram-miniapp.ts'), 'utf8')
    expect((src.match(/await attachedOriginRefusal\(/g) ?? []).length).toBe(2)
    expect((src.match(/if \(attachedRefusal\) return fail\(c, 403, attachedRefusal, 'Use a passkey'\)/g) ?? []).length).toBe(2) // and each one actually returns
  })

  it('B: a request cannot be approved while the agent\'s welded member is suspended, and reactivating it later does not resurrect an approval', async () => {
    const w = await world()
    const r = await ask(w)
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = (SELECT member_id FROM agent_member_bindings WHERE agent_id = 'agent-rava')`)
    const hash = await liveWebSession(w, HUMAN)
    const res = await decideElevationRequest(w.env, {
      tenant: TENANT, requestId: reqIdOf(r), decision: 'approve', selectedActions: [SUDO], decidedByMemberId: HUMAN,
      decidedByCapabilities: await resolveCapabilities(w.env, HUMAN), decidedByWebSessionHash: hash, recentReauthOk: true,
    })
    expect(res).toMatchObject({ ok: false, reason: 'agent_session_ended' })
    expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(0)
    h.sqlite.exec(`UPDATE members SET status = 'active' WHERE id = (SELECT member_id FROM agent_member_bindings WHERE agent_id = 'agent-rava')`)
    expect(one<{ status: string }>(`SELECT status FROM elevation_requests WHERE id = ?`, reqIdOf(r))!.status).not.toBe('approved') // reactivation resurrects nothing
  })
})

describe('sudo for attached chats: decide-time liveness mirrors use-time (each mirrored condition broken in turn)', () => {
  // seat member, admission harness and harness owner are immutable by trigger (agent_seat_immutable etc.), so a request cannot meet them
  // broken in production; the SQL mirrors them anyway (defence in depth) and they are deliberately not prestated here.
  const BREAKS: Array<[string, (member: string) => string]> = [
    ['seat retired', () => `UPDATE agent_seats SET retired_at = '2026-10-14 00:00:00'`],
    ['agent inactive', () => `UPDATE agents SET status = 'inactive' WHERE id = 'agent-rava'`],
    ['seat token not directory channel', () => `UPDATE member_tokens SET channel = 'workspace' WHERE id = (SELECT seat_token_id FROM agent_seat_attachments LIMIT 1)`],
    ['seat token not for this agent', () => `UPDATE member_tokens SET agent_id = NULL WHERE id = (SELECT seat_token_id FROM agent_seat_attachments LIMIT 1)`],
    ['seat token revoked', () => `UPDATE member_tokens SET revoked_at = '2026-10-14 00:00:00' WHERE id = (SELECT seat_token_id FROM agent_seat_attachments LIMIT 1)`],
  ]
  for (const [name, sql] of BREAKS) {
    it(`${name}: a pending request cannot be approved and no grant is written`, async () => {
      const w = await world()
      const r = await ask(w)
      h.sqlite.exec('PRAGMA foreign_keys = OFF')
      try { h.sqlite.exec(sql(HUMAN2)) } finally { h.sqlite.exec('PRAGMA foreign_keys = ON') }
      const hash = await liveWebSession(w, HUMAN)
      const res = await decideElevationRequest(w.env, {
        tenant: TENANT, requestId: reqIdOf(r), decision: 'approve', selectedActions: [SUDO], decidedByMemberId: HUMAN,
        decidedByCapabilities: await resolveCapabilities(w.env, HUMAN), decidedByWebSessionHash: hash, recentReauthOk: true,
      })
      expect(res, name).toMatchObject({ ok: false })
      expect(n(`SELECT COUNT(*) AS n FROM elevation_grants`)).toBe(0)
    })
  }
})
