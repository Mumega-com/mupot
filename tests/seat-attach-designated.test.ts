// tests/seat-attach-designated.test.ts — SEAT_ATTACH_DESIGNATED: attach only to owner-designated agents (migration 0238).
//
// Fixtures go through PRODUCTION writers only: seats from the auto-seat path (boot_context with a thread key), admissions from the
// real seat_attach tool + the real /m/* passkey ceremony (software authenticator at the WebAuthn boundary only), attachments from
// attachSeatToAgent, and DESIGNATION from the real update_agent tool (invokeTool -> authorizeOwnerMemberChange -> updateAgentProfile).
// agents.attach_designated_member_id is never written by a raw INSERT/UPDATE except in the ONE race simulation noted in its test.
//
// MUTATIONS proven (see the PR body for which test kills each): attachDesignatedClause deleted/neutralised at each of its four
// sites (listAttachableAgents, admissionRefusal, findLiveAttachment, the attachment INSERT guard); the designation door's
// no-self-waiver, org floor and seat/attached refusal; the flag gate; the human binding of the clause.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { SoftAuthenticator } from './helpers/webauthn-authenticator'
import { upsertHarness } from '../src/members/harness'
import { prepareConditionalIdentityWeld } from '../src/members/service'
import { weldAudit } from '../src/members/seat-attach'
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
  attachSeatToAgent, decideAdmissionDirect, decideSeatAdmission, detachAttachment, ensureAdmission, listAttachableAgents, loadAdmission, revokeAdmission,
  seatAttachEnabled, findLiveAttachment,
} from '../src/members/seat-attach'
import { invokeTool } from '../src/mcp/index'
import { loadAttachmentOriginOfSession } from '../src/auth/elevation'
import { markMessagesHandledByAttachment } from '../src/members/attached-handled'
import { authorizeOwnerMemberChange } from '../src/org/agent-owner'
import { attachDesignatedClause, seatAttachDesignatedEnabled, resolveAttachableAgent } from '../src/members/seat-attach'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'

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

async function decideMoment(e: Env, url: string, a: SoftAuthenticator, decision: 'approve' | 'deny', ceiling?: string, decideCeiling: string | undefined = ceiling): Promise<{ status: number; body: J }> {
  const path = new URL(url).pathname
  const csrf = csrfOf(await (await hit(path, e)).text())
  const ch = (await (await hit(`${path}/challenge`, e, { method: 'POST', json: { decision, csrf, ...(ceiling ? { ceiling } : {}) } })).json()) as J
  const credential = await a.assert({ rpId: HOST, origin: ORIGIN, challenge: ch.publicKey?.challenge ?? '' })
  const res = await hit(`${path}/decide`, e, { method: 'POST', json: { decision, csrf, credential, ...(decideCeiling ? { ceiling: decideCeiling } : {}) } })
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
  seedHuman(OWNER)
  h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-owner-org', '${OWNER}', 'org', NULL, 'admin')`)
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


const OWNER = 'member-org-owner'
const DESIGNATED = { SEAT_ATTACH_DESIGNATED: '1' }

function orgAdminAuth(memberId = OWNER): AuthContext {
  const capabilities: CapabilityGrant[] = [{ member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' }]
  return { userId: 'op', email: 'op@example.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId, capabilities, boundAgentId: null } as AuthContext
}
/** The production owner door: update_agent. */
async function designate(env: Env, agentId: string, memberId: string | null, auth: AuthContext = orgAdminAuth()) {
  return invokeTool(auth, env, 'update_agent', { agent: agentId, attach_designated_member_id: memberId }, 'https://pot.test')
}
const designatedOf = (agentId: string): string | null => one<{ d: string | null }>(`SELECT attach_designated_member_id AS d FROM agents WHERE id = ?`, agentId)?.d ?? null

describe('the designation writer: the existing owner door, no self waiver', () => {
  it('an org admin designates rava for HUMAN via update_agent; the column and agent_audit record it', async () => {
    const env = envFor(h, DESIGNATED)
    const r = await designate(env, 'agent-rava', HUMAN)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(designatedOf('agent-rava')).toBe(HUMAN)
    expect(one<{ after_state: string }>(`SELECT after_state FROM agent_audit WHERE agent_id = 'agent-rava' AND action = 'update_agent'`)?.after_state).toContain(`"attach_designated_member_id":"${HUMAN}"`)
    expect(designatedOf('agent-hadi-admin')).toBeNull() // default: nobody
  })

  it('a squad ADMIN without the org floor is refused (forbidden need admin scope org), including designating THEMSELVES (no self-target waiver)', async () => {
    const env = envFor(h, DESIGNATED)
    const squadAdmin: CapabilityGrant[] = [{ member_id: HUMAN, scope_type: 'squad', scope_id: 'squad-core', capability: 'admin' }]
    const auth = { ...orgAdminAuth(HUMAN), capabilities: squadAdmin }
    for (const target of [HUMAN, HUMAN2]) {
      const r = await designate(env, 'agent-rava', target, auth)
      expect(r.ok).toBe(false)
      if (!r.ok) { expect(r.status).toBe(403); expect(r.error).toBe('forbidden') }
    }
    expect(designatedOf('agent-rava')).toBeNull()
  })

  it('the rank ceiling still applies: an org admin cannot designate a member who outranks them', async () => {
    const env = envFor(h, DESIGNATED)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h-owner', '${HUMAN2}', 'org', NULL, 'owner')`)
    const r = await designate(env, 'agent-rava', HUMAN2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('target_rank_exceeds_ceiling')
    expect(designatedOf('agent-rava')).toBeNull()
  })

  it('a SEAT chat and an ATTACHED chat cannot set it, through the tool (refused) and at the door itself (seat_session_forbidden)', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h-org', '${HUMAN}', 'org', NULL, 'admin')`)
    const g = await grant(env, HUMAN)
    // seat session, tool path
    const seatRes = await rpc(env, g.ctx, 'update_agent', { agent: 'agent-hadi-admin', attach_designated_member_id: HUMAN }, { meta: thread('conv-s') })
    expect(JSON.stringify(seatRes.body)).toMatch(/forbidden|operator_principal_required|seat/)
    expect(designatedOf('agent-hadi-admin')).toBeNull()
    // attached session, tool path
    await admitAndAttach(env, g, 'conv-a')
    const attRes = await rpc(env, g.ctx, 'update_agent', { agent: 'agent-hadi-admin', attach_designated_member_id: HUMAN }, { meta: thread('conv-a') })
    expect(JSON.stringify(attRes.body)).toMatch(/forbidden|operator_principal_required|seat/)
    expect(designatedOf('agent-hadi-admin')).toBeNull()
    // the door itself, with a server-shaped seat binding on an otherwise sufficient (org admin) auth
    const seatBinding = { seatId: 's', humanMemberId: HUMAN } as unknown as NonNullable<AuthContext['seatBinding']> // shape stub: only presence is read
    const door = await authorizeOwnerMemberChange(env, { ...orgAdminAuth(), seatBinding }, 'agent-hadi-admin', HUMAN, 'attach_designated_member_id')
    expect(door).toMatchObject({ ok: false, error: 'seat_session_forbidden' })
    const attached = { ...seatBinding, attached: { attachmentId: 'a', admissionId: 'd', agentId: 'agent-rava', ceiling: 'full' } } as unknown as NonNullable<AuthContext['seatBinding']> // shape stub
    expect(await authorizeOwnerMemberChange(env, { ...orgAdminAuth(), seatBinding: attached }, 'agent-hadi-admin', null, 'attach_designated_member_id')).toMatchObject({ ok: false, error: 'seat_session_forbidden' })
    // the owner column is unaffected by that rule (same door, other column): no regression for existing callers
    expect(await authorizeOwnerMemberChange(env, { ...orgAdminAuth(), seatBinding }, 'agent-hadi-admin', HUMAN)).toMatchObject({ ok: true })
  })

  it('the rank bound reads the EFFECTIVE auth.capabilities, never DB rows: DB says org admin, the session says nothing', async () => {
    const env = envFor(h, DESIGNATED)
    const clamped = { ...orgAdminAuth(), capabilities: [] as CapabilityGrant[], role: 'member' as const } // OWNER holds org admin in the DB (beforeEach)
    const r = await designate(env, 'agent-rava', HUMAN, clamped)
    expect(r.ok).toBe(false)
    expect(designatedOf('agent-rava')).toBeNull()
  })

  it('un-designating (null) clears it; a whitespace id is refused', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    expect((await designate(env, 'agent-rava', ` ${HUMAN}`)).ok).toBe(false)
    expect(designatedOf('agent-rava')).toBe(HUMAN)
    expect((await designate(env, 'agent-rava', null)).ok).toBe(true)
    expect(designatedOf('agent-rava')).toBeNull()
  })
})

describe('flag SEAT_ATTACH_DESIGNATED', () => {
  it('requires SEAT_ATTACH (and seats); the predicate is a no-op fragment while off', () => {
    expect(seatAttachDesignatedEnabled(envFor(h, DESIGNATED))).toBe(true)
    expect(seatAttachDesignatedEnabled(envFor(h))).toBe(false)
    expect(seatAttachDesignatedEnabled(envFor(h, { ...DESIGNATED, SEAT_ATTACH: undefined }))).toBe(false)
    expect(seatAttachDesignatedEnabled(envFor(h, { ...DESIGNATED, SEAT_ATTACH: '1', SEAT_AUTO_ENROLL: undefined }))).toBe(false)
    expect(seatAttachDesignatedEnabled(envFor(h, { SEAT_ATTACH_DESIGNATED: 'true' }))).toBe(false) // strict '1'
    expect(attachDesignatedClause(envFor(h), 'a', '?4')).not.toContain('attach_designated_member_id')
    expect(attachDesignatedClause(envFor(h, DESIGNATED), 'a', '?4')).toContain('a.attach_designated_member_id = ?4')
  })

  it('OFF: behaviour is today\'s: every admin-squad agent is attachable and attaches, whatever the (ignored) column holds', async () => {
    const env = envFor(h)
    await designate(env, 'agent-hadi-admin', HUMAN2) // a stale designation for someone else must change nothing while off
    expect((await listAttachableAgents(env, HUMAN)).map((a) => a.id).sort()).toEqual(['agent-hadi-admin', 'agent-rava'])
    const g = await grant(env, HUMAN)
    await admitAndAttach(env, g, 'conv-a', 'hadi-admin')
    expect((await boot(env, g, 'conv-a')).sc.bound_agent_id).toBe('agent-hadi-admin')
  })

  it('ON with nobody designated: nothing is attachable (default deny)', async () => {
    const env = envFor(h, DESIGNATED)
    expect(await listAttachableAgents(env, HUMAN)).toEqual([])
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const r = await attach(env, g, 'conv-a', 'rava')
    expect(errOf(r)).toBe('agent_not_found')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_admissions`)).toBe(0)
  })
})

describe('designated agent: attach, then the chat IS that agent (end to end)', () => {
  it('rava designated for HUMAN: attachable; attached chat acts as rava (agent id, inbox peek, send as agent, squad visibility)', async () => {
    const env = envFor(h, DESIGNATED)
    expect((await designate(env, 'agent-rava', HUMAN)).ok).toBe(true)
    expect((await listAttachableAgents(env, HUMAN)).map((a) => a.id)).toEqual(['agent-rava'])
    const g = await grant(env, HUMAN)
    const own = await boot(env, g, 'conv-a')
    expect(own.sc.bound_agent_id).not.toBe('agent-rava')
    await admitAndAttach(env, g, 'conv-a')
    const after = await boot(env, g, 'conv-a')
    expect(after.sc.bound_agent_id).toBe('agent-rava')
    expect((receiptOf(after).agent as { id: string }).id).toBe('agent-rava')
    expect(receiptOf(after).binding_source).toBe('attached_seat')
    // default ceiling for the approval is member
    expect(one<{ ceiling: string }>(`SELECT ceiling FROM agent_seat_admissions`)?.ceiling).toBe('member')
    // inbox: peek works, consuming is refused
    h.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body) VALUES ('m-1', '${TENANT}', 'agent-rava', 'agent-hadi-admin', 'mem-agent-hadi-admin', 'message', 'hi rava')`)
    const peek = await rpc(env, g.ctx, 'inbox', { peek: true }, { meta: thread('conv-a') })
    expect(JSON.stringify(peek.body)).toContain('m-1')
    expect(errOf(await rpc(env, g.ctx, 'inbox', { limit: 5 }, { meta: thread('conv-a') }))).toBe('attached_seat_peek_only')
    // send as the agent; squad-core peer visible, a squad it is not on is not
    const sent = await rpc(env, g.ctx, 'send', { to: 'agent-hadi-admin', body: 'from the chat' }, { meta: thread('conv-a') })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    expect(one<{ from_agent: string }>(`SELECT from_agent FROM agent_messages WHERE body = 'from the chat'`)?.from_agent).toBe('agent-rava')
    const hidden = await rpc(env, g.ctx, 'send', { to: 'agent-other', body: 'nope' }, { meta: thread('conv-a') })
    expect(JSON.stringify(hidden.body)).toContain('send_target_not_visible')
  })

  it('an UNDESIGNATED agent on a squad HUMAN administers is refused at seat_attach (agent_not_found), while the designated one is not', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    expect(errOf(await attach(env, g, 'conv-a', 'hadi-admin'))).toBe('agent_not_found')
    expect(errOf(await attach(env, g, 'conv-a', 'agent-hadi-admin'))).toBe('agent_not_found')
    expect((await attach(env, g, 'conv-a', 'rava')).sc.status).toBe('pending_admission')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_admissions WHERE agent_id = 'agent-hadi-admin'`)).toBe(0)
  })

  it('designation is per HUMAN: an agent designated for HUMAN2 is not attachable by HUMAN', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN2)
    expect(await listAttachableAgents(env, HUMAN)).toEqual([])
    expect((await resolveAttachableAgent(env, HUMAN, 'rava'))).toEqual({ ok: false, error: 'agent_not_found' })
  })

  it('SITE admissionRefusal: an admission PENDING from before the flag (or designation) is refused at the human\'s decision, passkey and dashboard', async () => {
    const off = envFor(h)
    const g = await grant(off, HUMAN)
    await boot(off, g, 'conv-a')
    const pend = await attach(off, g, 'conv-a', 'hadi-admin') // today's flow, flag off
    expect(pend.sc.status).toBe('pending_admission')
    const on = envFor(h, DESIGNATED)
    await designate(on, 'agent-rava', HUMAN) // hadi-admin stays undesignated
    const key = await enrolPasskey(on, HUMAN, `${HUMAN}@example.test`)
    const res = await decideMoment(on, String(pend.sc.approve_url), key, 'approve')
    expect(res.status).toBe(409)
    expect(JSON.stringify(res.body)).toContain('agent_not_designated')
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions`)?.status).toBe('pending')
    const admId = one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!.id
    expect(await decideAdmissionDirect(on, { admissionId: admId, humanMemberId: HUMAN, decision: 'approve' })).toEqual({ ok: false, error: 'attach_refused' })
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions`)?.status).toBe('pending')
  })

  it('SITE findLiveAttachment: un-designating kills the NEXT request of an attached chat (serves its own seat agent again)', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    await admitAndAttach(env, g, 'conv-a')
    expect((await boot(env, g, 'conv-a')).sc.bound_agent_id).toBe('agent-rava')
    expect((await designate(env, 'agent-rava', null)).ok).toBe(true)
    const after = await boot(env, g, 'conv-a')
    expect(after.sc.bound_agent_id).not.toBe('agent-rava')
    expect(receiptOf(after).binding_source).toBe('auto_seat')
    // re-designating for someone else does not revive it for HUMAN
    await designate(env, 'agent-rava', HUMAN2)
    expect((await boot(env, g, 'conv-a')).sc.bound_agent_id).not.toBe('agent-rava')
  })

  it('SITE insert guard: a designation cleared between resolve and insert lands NO attachment (race simulated at the batch seam)', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    await admitAndAttach(env, g, 'conv-a') // admission live + attached
    await boot(env, g, 'conv-b')
    h.sqlite.exec(`DROP TRIGGER IF EXISTS agents_attach_designation_end`) // isolate THIS guard from the cleanup trigger
    // conv-b attaches immediately (admission live). Between resolve and the insert batch, an org admin un-designates through the door.
    let raced = false
    const realDb = env.DB
    const racing = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return async (stmts: Parameters<typeof realDb.batch>[0]) => {
            if (!raced) { raced = true; expect((await designate({ ...env, DB: realDb } as Env, 'agent-rava', null)).ok).toBe(true) }
            return target.batch(stmts)
          }
        }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const seat = one<{ id: string }>(`SELECT s.id AS id FROM agent_seats s WHERE s.agent_id NOT IN ('agent-rava') AND NOT EXISTS (SELECT 1 FROM agent_seat_attachments a WHERE a.seat_id = s.id) LIMIT 1`)!
    const r = await attachSeatToAgent({ ...env, DB: racing } as Env, { humanMemberId: HUMAN, seatId: seat.id, agentRef: 'agent-rava', via: 'tool' })
    expect(raced).toBe(true)
    expect(r).toEqual({ ok: false, error: 'attach_refused' })
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE seat_id = ? AND detached_at IS NULL`, seat.id)).toBe(0)
  })

  it('revoke the admission / detach the thread kills the next request even while designated', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    await admitAndAttach(env, g, 'conv-a')
    await boot(env, g, 'conv-b')
    expect((await attach(env, g, 'conv-b', 'rava')).sc.status).toBe('attached')
    const att = one<{ id: string }>(`SELECT att.id AS id FROM agent_seat_attachments att JOIN agent_seats s ON s.id = att.seat_id WHERE att.detached_at IS NULL ORDER BY att.created_at DESC, att.id LIMIT 1`)!
    expect((await detachAttachment(env, { attachmentId: att.id, humanMemberId: HUMAN })).ok).toBe(true)
    const adm = one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!
    expect((await revokeAdmission(env, { admissionId: adm.id, humanMemberId: HUMAN })).ok).toBe(true)
    for (const s of ['conv-a', 'conv-b']) expect((await boot(env, g, s)).sc.bound_agent_id).not.toBe('agent-rava')
  })
})

describe('connect on a seat session says what it is (text only)', () => {
  const connect = (env: Env, g: Grant, session: string, agent: string) => rpc(env, g.ctx, 'connect', { agent_name: agent }, { meta: thread(session) })
  const nextOf = (r: Rpc): string => String(r.sc.next_step)

  it('flag on + designated: identity_changed false, acting_as the seat agent, and next_step names seat_attach', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    const seatAgent = String((await boot(env, g, 'conv-a')).sc.bound_agent_id)
    const r = await connect(env, g, 'conv-a', 'agent-rava')
    expect(r.sc.identity_changed).toBe(false)
    expect((r.sc.acting_as as { id: string }).id).toBe(seatAgent)
    expect(nextOf(r)).toContain('still')
    expect(nextOf(r)).toContain('reading only')
    expect(nextOf(r)).toContain('seat_attach { agent: "agent-rava" }')
    expect(nextOf(r)).not.toContain('You are now hot')
  })

  it('flag on + NOT designated: says it cannot become that agent (no seat_attach instruction)', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const r = await connect(env, g, 'conv-a', 'agent-hadi-admin')
    expect(r.sc.identity_changed).toBe(false)
    expect(nextOf(r)).toContain('not designated')
    expect(nextOf(r)).not.toContain('seat_attach { agent:')
  })

  it('attach not enabled on this pot: says so plainly, still identity_changed false', async () => {
    const env = envFor(h, { SEAT_ATTACH: undefined })
    const g = await grant(env, HUMAN)
    const seatAgent = String((await boot(env, g, 'conv-a')).sc.bound_agent_id)
    const r = await connect(env, g, 'conv-a', 'agent-rava')
    expect(r.sc.identity_changed).toBe(false)
    expect((r.sc.acting_as as { id: string }).id).toBe(seatAgent)
    expect(nextOf(r)).toContain('not enabled on this pot')
    expect(nextOf(r)).toContain('reading only')
  })

  it('an attached chat connecting to another agent is told it is still the attached agent', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    await admitAndAttach(env, g, 'conv-a')
    const r = await connect(env, g, 'conv-a', 'agent-hadi-admin')
    expect(r.sc.identity_changed).toBe(false)
    expect((r.sc.acting_as as { id: string }).id).toBe('agent-rava')
    expect(nextOf(r)).toContain('attached to rava')
  })

  it('the stale "never exceeds member" strings are gone', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const pend = await attach(env, g, 'conv-a', 'rava')
    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    await decideMoment(env, String(pend.sc.approve_url), key, 'approve')
    const done = await attach(env, g, 'conv-a', 'rava')
    expect(String(done.sc.note)).not.toContain('at most member-level')
    expect(String(done.sc.note)).toContain('approved')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Round 1 (P0): un-designation must stop EVERY reader of an attachment, not just the request chokepoint.
describe('un-designation ends the events path, elevation, and cannot be revived without a new passkey', () => {
  const CB = 'https://hooks.example.com/mcp/events'
  const SECRET = `whsec_${Buffer.from('a'.repeat(32)).toString('base64')}`
  const evEnv = (): Env => envFor(h, { ...DESIGNATED, EVENTS_ENABLED: 'true', EVENTS_CALLBACK_HOSTS: 'hooks.example.com', BUS: { send: vi.fn().mockResolvedValue(undefined) } })
  const ev = async (env: Env, ctx: AuthContext, method: string, params: unknown): Promise<{ status: number; body: { result?: Record<string, unknown>; error?: { message: string; data?: Record<string, unknown> } } }> => {
    const req = new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
    return { status: res.status, body: (await res.json()) as never }
  }
  const sub = (): Record<string, unknown> => ({ name: 'message.created', arguments: {}, delivery: { mode: 'webhook', url: CB, secret: SECRET }, ttlMs: 3_600_000 })
  beforeEach(() => {
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? '{}')) as { type?: string; challenge?: string }
      return new Response(JSON.stringify(b.type === 'verification' ? { challenge: b.challenge } : {}), { status: 200 })
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })
  const dropDesignationTrigger = (): void => { h.sqlite.exec(`DROP TRIGGER IF EXISTS agents_attach_designation_end`) }

  it('end to end: after un-designation a NEW subscribe is refused, the existing subscription stops delivering, and re-designating needs a NEW passkey', async () => {
    const env = evEnv()
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    const key = await admitAndAttach(env, g, 'conv-a')
    expect((await ev(env, g.ctx, 'events/subscribe', sub())).body.error).toBeUndefined()
    const { subscriberAccessLive } = await import('../src/mcp/events-subscriptions')
    const row = one<Record<string, unknown>>(`SELECT * FROM event_subscriptions`)!
    expect(await subscriberAccessLive(env, row as never)).toEqual({ live: true })
    expect((await designate(env, 'agent-rava', null)).ok).toBe(true)
    expect((await ev(env, g.ctx, 'events/subscribe', sub())).body.error).toBeDefined()
    expect((await subscriberAccessLive(env, row as never)).live).toBe(false)
    // the trigger ended the admission and detached the attachment
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions`)?.status).toBe('revoked')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL`)).toBe(0)
    // re-designating the SAME human does not revive anything: the chat is its own seat agent and must be re-admitted by passkey
    await designate(env, 'agent-rava', HUMAN)
    expect((await boot(env, g, 'conv-a')).sc.bound_agent_id).not.toBe('agent-rava')
    expect((await subscriberAccessLive(env, row as never)).live).toBe(false)
    const again = await attach(env, g, 'conv-a', 'rava')
    expect(again.sc.status).toBe('pending_admission')
    const res = await decideMoment(env, String(again.sc.approve_url), key, 'approve')
    expect(res.status).toBe(200)
    expect((await attach(env, g, 'conv-a', 'rava')).sc.status).toBe('attached')
  })

  it('a PENDING admission of the old designee is denied on un-designation (cannot be approved later)', async () => {
    const env = evEnv()
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    expect((await attach(env, g, 'conv-a', 'rava')).sc.status).toBe('pending_admission')
    await designate(env, 'agent-rava', null)
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions`)?.status).toBe('denied')
  })

  describe('with the cleanup trigger MISSING, every reader re-checks the SAME predicate (one test per site)', () => {
    async function liveAttached() {
      const env = evEnv()
      await designate(env, 'agent-rava', HUMAN)
      const g = await grant(env, HUMAN)
      await admitAndAttach(env, g, 'conv-a')
      return { env, g }
    }

    it('events: listLiveAttachmentsForEvents drops the candidate and attachmentLiveness ends the wake (reason agent_not_designated)', async () => {
      const { env, g } = await liveAttached()
      expect((await ev(env, g.ctx, 'events/subscribe', sub())).body.error).toBeUndefined()
      const { listLiveAttachmentsForEvents } = await import('../src/mcp/events-attached')
      const { subscriberAccessLive } = await import('../src/mcp/events-subscriptions')
      const row = one<Record<string, unknown>>(`SELECT * FROM event_subscriptions`)!
      const ids = (): Promise<string[]> => listLiveAttachmentsForEvents(env, { memberId: g.memberId, harnessId: g.harnessId, grantTokenId: g.tokenId }).then((l) => l.map((a) => a.agentId))
      expect(await ids()).toEqual(['agent-rava'])
      dropDesignationTrigger()
      expect((await designate(env, 'agent-rava', null)).ok).toBe(true)
      expect(await ids()).toEqual([])
      expect(await subscriberAccessLive(env, row as never)).toEqual({ live: false, reason: 'agent_not_designated' })
      expect((await ev(env, g.ctx, 'events/subscribe', sub())).body.error).toBeDefined()
    })

    it('chokepoint: findLiveAttachment serves the seat agent again on the very next request', async () => {
      const { env, g } = await liveAttached()
      expect((await boot(env, g, 'conv-a')).sc.bound_agent_id).toBe('agent-rava')
      dropDesignationTrigger()
      await designate(env, 'agent-rava', null)
      expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL`)).toBe(1) // still attached in the table
      expect((await boot(env, g, 'conv-a')).sc.bound_agent_id).not.toBe('agent-rava')
    })

    it('elevation: loadAttachmentOriginOfSession reports the attachment dead (decide-time and telegram-miniapp use it)', async () => {
      const { env } = await liveAttached()
      const tok = one<{ seat_token_id: string }>(`SELECT seat_token_id FROM agent_seat_attachments WHERE detached_at IS NULL`)!.seat_token_id
      expect(await loadAttachmentOriginOfSession(env, TENANT, tok)).toMatchObject({ live: true, agentId: 'agent-rava', humanMemberId: HUMAN })
      dropDesignationTrigger()
      await designate(env, 'agent-rava', null)
      expect(await loadAttachmentOriginOfSession(env, TENANT, tok)).toMatchObject({ live: false })
    })

    it('inbox_mark_handled: the attachment can no longer record handled mail', async () => {
      const { env } = await liveAttached()
      h.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body) VALUES ('m-1', '${TENANT}', 'agent-rava', 'agent-hadi-admin', 'mem-agent-hadi-admin', 'message', 'x'), ('m-2', '${TENANT}', 'agent-rava', 'agent-hadi-admin', 'mem-agent-hadi-admin', 'message', 'y')`)
      const att = one<{ id: string }>(`SELECT id FROM agent_seat_attachments WHERE detached_at IS NULL`)!.id
      const call = (id: string) => markMessagesHandledByAttachment(env, { attachmentId: att, agentId: 'agent-rava', seat: null, ids: [id] })
      expect(await call('m-1')).toMatchObject({ ok: true, handled: ['m-1'] })
      dropDesignationTrigger()
      await designate(env, 'agent-rava', null)
      expect(await call('m-2')).toMatchObject({ ok: true, handled: [], not_visible: ['m-2'] })
    })

    it('promoteAdmission: a designation cleared between the decision check and the promote lands no live admission', async () => {
      const env = envFor(h, DESIGNATED)
      await designate(env, 'agent-rava', HUMAN)
      const g = await grant(env, HUMAN)
      await boot(env, g, 'conv-a')
      expect((await attach(env, g, 'conv-a', 'rava')).sc.status).toBe('pending_admission')
      dropDesignationTrigger()
      const admId = one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!.id
      const realDb = env.DB
      let raced = false
      const racing = new Proxy(realDb, {
        get(target, prop, receiver) {
          if (prop === 'batch') return async (stmts: Parameters<typeof realDb.batch>[0]) => {
            if (!raced) { raced = true; expect((await designate({ ...env, DB: realDb } as Env, 'agent-rava', null)).ok).toBe(true) }
            return target.batch(stmts)
          }
          const v = Reflect.get(target, prop, receiver)
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
      const r = await decideAdmissionDirect({ ...env, DB: racing } as Env, { admissionId: admId, humanMemberId: HUMAN, decision: 'approve' })
      expect(raced).toBe(true)
      expect(r).toEqual({ ok: false, error: 'not_pending' })
      expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions`)?.status).toBe('pending')
    })

    it('dashboard live-admission INSERT: a designation cleared before the insert creates no admission', async () => {
      const env = envFor(h, DESIGNATED)
      await designate(env, 'agent-rava', HUMAN)
      const g = await grant(env, HUMAN)
      await boot(env, g, 'conv-a')
      const seat = one<{ id: string }>(`SELECT id FROM agent_seats WHERE member_id = ? LIMIT 1`, HUMAN)!
      const realDb = env.DB
      let raced = false
      const racing = new Proxy(realDb, {
        get(target, prop, receiver) {
          if (prop === 'batch') return async (stmts: Parameters<typeof realDb.batch>[0]) => {
            if (!raced) { raced = true; expect((await designate({ ...env, DB: realDb } as Env, 'agent-rava', null)).ok).toBe(true) }
            return target.batch(stmts)
          }
          const v = Reflect.get(target, prop, receiver)
          return typeof v === 'function' ? v.bind(target) : v
        },
      })
      const r = await attachSeatToAgent({ ...env, DB: racing } as Env, { humanMemberId: HUMAN, seatId: seat.id, agentRef: 'agent-rava', via: 'dashboard' })
      expect(raced).toBe(true)
      expect(r).toEqual({ ok: false, error: 'attach_refused' })
      expect(n(`SELECT COUNT(*) AS n FROM agent_seat_admissions WHERE status = 'live'`)).toBe(0)
    })
  })
})

// Round 1 (P1): the designation door also has a ceiling on the AGENT, and on whoever currently holds the designation.
describe('the designation door: agent ceiling and outgoing-designee ceiling', () => {
  const ORG_OWNER = 'member-org-owner-2'
  const ownerAuth = (): AuthContext => ({ ...orgAdminAuth(ORG_OWNER), capabilities: [{ member_id: ORG_OWNER, scope_type: 'org', scope_id: null, capability: 'owner' }] as CapabilityGrant[], role: 'owner' } as AuthContext)
  beforeEach(() => {
    seedHuman(ORG_OWNER)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-org-owner-2', '${ORG_OWNER}', 'org', NULL, 'owner')`)
  })

  it('an agent OWNED by a higher-rank member: org admin refused (agent_rank_exceeds_ceiling), the owner is allowed', async () => {
    const env = envFor(h, DESIGNATED)
    expect((await invokeTool(ownerAuth(), env, 'update_agent', { agent: 'agent-hadi-admin', owner_member_id: ORG_OWNER }, 'https://pot.test')).ok).toBe(true) // production writer
    const refused = await designate(env, 'agent-hadi-admin', OWNER) // org admin designating THEMSELVES
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toBe('agent_rank_exceeds_ceiling')
    expect(designatedOf('agent-hadi-admin')).toBeNull()
    const allowed = await designate(env, 'agent-hadi-admin', ORG_OWNER, ownerAuth())
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true)
    expect(designatedOf('agent-hadi-admin')).toBe(ORG_OWNER)
  })

  it('an agent whose WELDED/bound member outranks the actor (a steward agent): org admin refused, owner allowed', async () => {
    const env = envFor(h, DESIGNATED)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-rava-owner', 'mem-agent-rava', 'org', NULL, 'owner')`)
    const refused = await designate(env, 'agent-rava', HUMAN)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toBe('agent_rank_exceeds_ceiling')
    expect((await designate(env, 'agent-rava', HUMAN, ownerAuth())).ok).toBe(true)
  })

  it('M11: replacing or clearing a higher-rank human\'s designation is refused for a lower-rank org admin', async () => {
    const env = envFor(h, DESIGNATED)
    expect((await designate(env, 'agent-rava', ORG_OWNER, ownerAuth())).ok).toBe(true)
    for (const target of [HUMAN, null]) {
      const r = await designate(env, 'agent-rava', target)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('target_rank_exceeds_ceiling')
    }
    expect(designatedOf('agent-rava')).toBe(ORG_OWNER)
    expect((await designate(env, 'agent-rava', null, ownerAuth())).ok).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Codex review round: dispositions pinned by tests.
describe('codex review dispositions', () => {
  const liveAtt = (agent: string): number => n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE agent_id = ? AND detached_at IS NULL`, agent)
  const dropTrigger = (): void => { h.sqlite.exec(`DROP TRIGGER IF EXISTS agents_attach_designation_end`) }
  const raceOnBatch = (env: Env, onFirstBatch: () => Promise<void>): Env => {
    const realDb = env.DB
    let raced = false
    const racing = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'batch') return async (stmts: Parameters<typeof realDb.batch>[0]) => { if (!raced) { raced = true; await onFirstBatch() } return target.batch(stmts) }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    return { ...env, DB: racing } as Env
  }

  it('P1 schema: update_agent advertises attach_designated_member_id as string OR null', () => {
    const t = advertisedTools(envFor(h, DESIGNATED)).find((x) => x.name === 'update_agent')!
    const prop = (t.inputSchema as { properties: Record<string, { type: unknown }> }).properties.attach_designated_member_id
    expect(prop.type).toEqual(['string', 'null'])
  })

  it('P1 floor on CLEAR: a squad admin without the org floor cannot clear a designation; an org admin can', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const squadAdmin = { ...orgAdminAuth(HUMAN), capabilities: [{ member_id: HUMAN, scope_type: 'squad', scope_id: 'squad-core', capability: 'admin' }] as CapabilityGrant[] }
    const r = await designate(env, 'agent-rava', null, squadAdmin)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('forbidden')
    expect(designatedOf('agent-rava')).toBe(HUMAN)
    expect((await designate(env, 'agent-rava', null)).ok).toBe(true)
  })

  it('P1 revival (probe G): a pre-flag live admission + attachment is ended on the FIRST designation; same human needs a new passkey', async () => {
    const off = envFor(h)
    const g = await grant(off, HUMAN)
    const key = await admitAndAttach(off, g, 'conv-g')
    const on = envFor(h, DESIGNATED)
    expect((await boot(on, g, 'conv-g')).sc.bound_agent_id).not.toBe('agent-rava') // flag on, undesignated: serves seat agent
    expect((await designate(on, 'agent-rava', HUMAN)).ok).toBe(true)
    expect((await boot(on, g, 'conv-g')).sc.bound_agent_id).not.toBe('agent-rava') // NOT revived
    expect(liveAtt('agent-rava')).toBe(0)
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions`)?.status).toBe('revoked')
    const again = await attach(on, g, 'conv-g', 'rava')
    expect(again.sc.status).toBe('pending_admission')
    expect((await decideMoment(on, String(again.sc.approve_url), key, 'approve')).status).toBe(200)
    expect((await attach(on, g, 'conv-g', 'rava')).sc.status).toBe('attached')
  })

  it('P1 revival: a designation for H ends OTHER humans\' live and pending admissions of that agent too', async () => {
    const off = envFor(h)
    const g1 = await grant(off, HUMAN)
    await admitAndAttach(off, g1, 'conv-1')
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h2-core', '${HUMAN2}', 'squad', 'squad-core', 'admin')`)
    const g2 = await grant(off, HUMAN2)
    await boot(off, g2, 'conv-2')
    expect((await attach(off, g2, 'conv-2', 'rava')).sc.status).toBe('pending_admission')
    expect((await designate(envFor(h, DESIGNATED), 'agent-rava', HUMAN)).ok).toBe(true)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_admissions WHERE status IN ('live','pending')`)).toBe(0)
  })

  it('flag-off compatibility (probe E): unrelated updates and a NULL->NULL designation write leave today\'s attachment alone', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitAndAttach(env, g, 'conv-e')
    expect((await invokeTool(orgAdminAuth(), env, 'update_agent', { agent: 'agent-rava', name: 'Rava2', purpose: 'x' }, 'https://pot.test')).ok).toBe(true)
    expect((await designate(env, 'agent-rava', null)).ok).toBe(true)
    expect(liveAtt('agent-rava')).toBe(1)
    expect((await boot(env, g, 'conv-e')).sc.bound_agent_id).toBe('agent-rava')
  })

  it('P1 :513 a designation-invalid stale attachment does not block re-attach to another designated agent', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    await designate(env, 'agent-hadi-admin', HUMAN)
    const g = await grant(env, HUMAN)
    const key = await admitAndAttach(env, g, 'conv-a', 'rava')
    dropTrigger() // the stale row case: the cleanup trigger did not run, the row is live but invisible to every reader
    await designate(env, 'agent-rava', null)
    expect(liveAtt('agent-rava')).toBe(1)
    const pend = await attach(env, g, 'conv-a', 'hadi-admin')
    expect(errOf(pend)).not.toBe('already_attached')
    expect(pend.sc.status).toBe('pending_admission')
    expect((await decideMoment(env, String(pend.sc.approve_url), key, 'approve')).status).toBe(200)
    expect((await attach(env, g, 'conv-a', 'hadi-admin')).sc.status).toBe('attached')
    expect(liveAtt('agent-rava')).toBe(0)
  })

  it('P2 :642 a move whose replacement is refused by the designation leaves the CURRENT attachment in place', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    await designate(env, 'agent-hadi-admin', HUMAN)
    const g = await grant(env, HUMAN)
    const key = await admitAndAttach(env, g, 'conv-a', 'rava')
    await boot(env, g, 'conv-b')
    const p2 = await attach(env, g, 'conv-b', 'hadi-admin')
    await decideMoment(env, String(p2.sc.approve_url), key, 'approve') // admission live for hadi-admin; conv-b still unattached
    const seat = one<{ seat_id: string }>(`SELECT seat_id FROM agent_seat_attachments WHERE agent_id = 'agent-rava' AND detached_at IS NULL`)!.seat_id
    dropTrigger() // isolate the batch guard from the trigger's admission revoke
    const racing = raceOnBatch(env, async () => { expect((await designate(env, 'agent-hadi-admin', null)).ok).toBe(true) })
    const r = await attachSeatToAgent(racing, { humanMemberId: HUMAN, seatId: seat, agentRef: 'agent-hadi-admin', via: 'dashboard', moveIfAttached: true })
    expect(r).toEqual({ ok: false, error: 'attach_refused' })
    expect(liveAtt('agent-rava')).toBe(1) // not left unattached
  })

  it('P2 :354 weld: a designation cleared before an identity-only agent\'s promote creates no member/binding/capability', async () => {
    const env = envFor(h, DESIGNATED)
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-bare', 'squad-core', 'bare', 'Bare', 'r', 'm', 'active')`)
    await designate(env, 'agent-bare', HUMAN)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    expect((await attach(env, g, 'conv-a', 'bare')).sc.status).toBe('pending_admission')
    dropTrigger()
    const admId = one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!.id
    const racing = raceOnBatch(env, async () => { expect((await designate(env, 'agent-bare', null)).ok).toBe(true) })
    const r = await decideAdmissionDirect(racing, { admissionId: admId, humanMemberId: HUMAN, decision: 'approve' })
    expect(r).toEqual({ ok: false, error: 'not_pending' })
    expect(n(`SELECT COUNT(*) AS n FROM agent_member_bindings WHERE agent_id = 'agent-bare'`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = 'agent-bare' AND action = 'identity_weld'`)).toBe(0)
  })

  it('P2 :2365 interleave: the write is conditional on the outgoing designation the door authorised (409 designation_changed)', async () => {
    const env = envFor(h, DESIGNATED)
    const ORG_OWNER = 'member-org-owner-9'
    seedHuman(ORG_OWNER)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-oo9', '${ORG_OWNER}', 'org', NULL, 'owner')`)
    // The admin's door check reads current = null; before ITS write lands, the owner installs a higher-rank designation.
    const realPrepare = env.DB.prepare.bind(env.DB)
    let fired = false
    const interleaved = { ...env, DB: new Proxy(env.DB, { get(t, prop, rcv) {
      if (prop === 'prepare') return (sql: string) => {
        if (!fired && /INSERT INTO agent_audit/.test(sql) && /update_agent/.test(sql)) { fired = true; h.sqlite.exec(`UPDATE agents SET attach_designated_member_id = '${ORG_OWNER}' WHERE id = 'agent-rava'`) }
        return realPrepare(sql)
      }
      const v = Reflect.get(t, prop, rcv); return typeof v === 'function' ? v.bind(t) : v } }) } as Env
    const r = await designate(interleaved, 'agent-rava', HUMAN)
    expect(fired).toBe(true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('designation_changed')
    expect(designatedOf('agent-rava')).toBe(ORG_OWNER) // the higher-rank value was NOT overwritten
  })

  it('P2 :323 pending insert: a designation cleared before the pending admission insert creates no admission or link', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-rava', HUMAN)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const seat = one<{ id: string }>(`SELECT id FROM agent_seats WHERE member_id = ? LIMIT 1`, HUMAN)!
    const realPrepare = env.DB.prepare.bind(env.DB)
    let fired = false
    const racing = { ...env, DB: new Proxy(env.DB, { get(t, prop, rcv) {
      if (prop === 'prepare') return (sql: string) => {
        if (!fired && /INSERT INTO agent_seat_admissions/.test(sql) && /'pending'/.test(sql)) { fired = true; h.sqlite.exec(`UPDATE agents SET attach_designated_member_id = NULL WHERE id = 'agent-rava'`) }
        return realPrepare(sql)
      }
      const v = Reflect.get(t, prop, rcv); return typeof v === 'function' ? v.bind(t) : v } }) } as Env
    const r = await attachSeatToAgent(racing, { humanMemberId: HUMAN, seatId: seat.id, agentRef: 'agent-rava', via: 'tool' })
    expect(fired).toBe(true)
    expect(r).toEqual({ ok: false, error: 'attach_refused' })
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_admissions`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM secure_moments WHERE kind = 'seat_admit'`)).toBe(0)
  })

  it('P2 :7437 connect label: a designated agent the human cannot administer is NOT called undesignated', async () => {
    const env = envFor(h, DESIGNATED)
    await designate(env, 'agent-other', HUMAN) // squad-other: HUMAN has no admin there (member read access only)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h-other', '${HUMAN}', 'squad', 'squad-other', 'member')`)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const r = await rpc(env, g.ctx, 'connect', { agent_name: 'agent-other' }, { meta: thread('conv-a') })
    const next = String(r.sc.next_step)
    expect(next).not.toContain('not designated')
    expect(next).toContain('right now')
  })
})
