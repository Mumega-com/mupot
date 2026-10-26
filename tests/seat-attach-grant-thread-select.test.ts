// tests/seat-attach-grant-thread-select.test.ts — R1 (mupot#1792, Mumega-com/mumega-com#1563): a NEW thread under the SAME live
// OAuth grant may EXPLICITLY seat_attach to an agent whose admission the human approved with scope 'harness', with no new tap.
//
// Same stance as seat-attach.test.ts: real sqlite D1 from the full migration chain; requests go through the real path
// (props -> resolveSeatSession -> buildSeatContext -> findLiveAttachment -> tool); the passkey ceremony runs through the real /m/*
// routes. The harness is grant-keyed (WORKSPACES=1, upsertHarness with the consent token id) exactly as OAuth consent builds it.
//
// Athena's conditions (task 565da9e9) -> tests:
//  1 server-side re-verification on attach AND every operation .... 'grant anchor' + 'liveness chain' blocks
//  2 unselected thread stays unattached; no mid-conversation switch . 'selection' block
//  3 no silent migration / no widening ............................ 'consent scope' block
//  4 revoke cuts every thread; revoke between read and write ...... 'revocation' block
//  5 concurrent Rava / hadi-dev isolation, forged handles, races ... 'isolation' block
//  6 openai/subject auxiliary only ................................ 'subject' block
//  7 gate authority not inherited ................................. 'gate authority' block

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { SoftAuthenticator } from './helpers/webauthn-authenticator'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { callerHoldsGateCapability } from '../src/tasks/index'
import { momentsApp } from '../src/secure-moments/routes'
import { mintEnrolmentToken } from '../src/secure-moments/store'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { attachSeatToAgent, decideAdmissionDirect, detachAttachment, ensureAdmission, findLiveAttachment, loadAdmission, promoteAdmissionDetailed, revokeAdmission } from '../src/members/seat-attach'
import { listLiveAttachmentsForEvents } from '../src/mcp/events-attached'
import { TOKEN_LIVE_PREDICATE } from '../src/auth/token-lifecycle'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const HOST = 'secure.example.test'
const ORIGIN = `https://${HOST}`
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
    CONNECTOR_MASTER_KEY: MASTER, SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST,
    SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', WORKSPACES: '1', SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200', ...extra,
  } as unknown as Env
}

let h: SqliteD1Harness
let tokCounter = 0
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined

function seedHuman(id: string): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', 'Human ${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
}

function seedAgent(o: { id: string; slug: string; name: string; squad: string; admins: string[] }): void {
  const memberId = `mem-${o.id}`
  h.sqlite.exec(`
    INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-${o.squad}', 'dept-${o.squad}', 'Dept ${o.squad}');
    INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${o.squad}', 'dept-${o.squad}', '${o.squad}', 'Squad ${o.squad}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${o.id}', '${o.squad}', '${o.slug}', '${o.name}', 'r', 'm', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${memberId}', '${o.name}', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${o.id}', '${memberId}', '2026-10-01T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${o.id}', '${memberId}', 'squad', '${o.squad}', 'member');
  `)
  for (const a of o.admins) h.sqlite.exec(`INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${a}-${o.squad}', '${a}', 'squad', '${o.squad}', 'admin')`)
}

interface Grant { memberId: string; tokenId: string; harnessId: string; ctx: AuthContext }

/** One ChatGPT install: a directory token (the consent token) and the grant-keyed harness built on its id, as OAuth consent does. */
async function grant(env: Env, memberId: string, clientId = 'client-chatgpt'): Promise<Grant> {
  const tokenId = `tok-${memberId}-${++tokCounter}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:${clientId}', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const harness = await upsertHarness(env, memberId, clientId, 'ChatGPT', tokenId)
  if (!harness) throw new Error('harness fixture failed')
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  return { memberId, tokenId, harnessId: harness.id, ctx }
}

interface Rpc { status: number; body: Record<string, unknown>; sc: Record<string, unknown> }
async function rpc(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Rpc> {
  const params: Record<string, unknown> = { name, arguments: args }
  if (meta) params._meta = meta
  const req = new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {} }
}
const thread = (session: string, subject?: string): Record<string, unknown> => ({ 'openai/session': session, ...(subject ? { 'openai/subject': subject } : {}) })
const boot = (env: Env, g: Grant, s: string, subject?: string): Promise<Rpc> => rpc(env, g.ctx, 'boot_context', {}, thread(s, subject))
const attach = (env: Env, g: Grant, s: string, agent: string, scope?: string, subject?: string): Promise<Rpc> =>
  rpc(env, g.ctx, 'seat_attach', { agent, ...(scope ? { scope } : {}) }, thread(s, subject))
const errOf = (r: Rpc): string => JSON.stringify(r.body)

async function hit(path: string, e: Env, r: { method?: string; json?: unknown } = {}): Promise<Response> {
  const headers = new Headers()
  const method = r.method ?? 'GET'
  let body: string | undefined
  if (method === 'POST') { headers.set('origin', ORIGIN); headers.set('content-type', 'application/json'); body = JSON.stringify(r.json ?? {}) }
  return momentsApp.fetch(new Request(`https://${HOST}${path}`, { method, headers, body }), e)
}
const csrfOf = (page: string): string => { const m = /data-csrf="([0-9a-f]{64})"/.exec(page); if (!m) throw new Error('no csrf'); return m[1] }
type J = { ok?: boolean; title?: string; message?: string; publicKey?: { challenge: string } }

async function enrolPasskey(e: Env, memberId: string): Promise<SoftAuthenticator> {
  const link = await linkLoginIdentity(e, { tenant: TENANT, provider: 'google', providerSubject: `g-${memberId}`, verifiedEmail: `${memberId}@example.test`, memberId })
  if (!link.ok) throw new Error('link failed')
  const a = await SoftAuthenticator.create()
  const { token } = await mintEnrolmentToken(e, memberId, link.identity.id)
  const csrf = csrfOf(await (await hit(`/m/enrol/${token}`, e)).text())
  const opts = (await (await hit(`/m/enrol/${token}/options`, e, { method: 'POST', json: { csrf } })).json()) as J
  const credential = await a.register({ rpId: HOST, origin: ORIGIN, challenge: opts.publicKey?.challenge ?? '' })
  expect((await hit(`/m/enrol/${token}/finish`, e, { method: 'POST', json: { csrf, credential } })).status).toBe(200)
  return a
}

async function decideMoment(e: Env, url: string, a: SoftAuthenticator, ceiling?: string): Promise<{ status: number; body: J }> {
  const path = new URL(url).pathname
  const csrf = csrfOf(await (await hit(path, e)).text())
  const code = one<{ attach_code: string | null }>(`SELECT attach_code FROM agent_seat_admissions ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 1`)?.attach_code
  const extra = { ...(ceiling ? { ceiling } : {}), ...(code ? { attach_code: code } : {}) }
  const ch = (await (await hit(`${path}/challenge`, e, { method: 'POST', json: { decision: 'approve', csrf, ...extra } })).json()) as J
  const credential = await a.assert({ rpId: HOST, origin: ORIGIN, challenge: ch.publicKey?.challenge ?? '' })
  const res = await hit(`${path}/decide`, e, { method: 'POST', json: { decision: 'approve', csrf, credential, ...extra } })
  let body: J = {} as J
  try { body = JSON.parse(await res.text()) as J } catch { /* plain text */ }
  return { status: res.status, body }
}

/** Day 1: the human taps ONCE, approving `agent` for every chat of this install (scope harness). Returns the passkey. */
async function admitForAllChats(env: Env, g: Grant, session: string, agent = 'rava', ceiling?: string): Promise<SoftAuthenticator> {
  await boot(env, g, session)
  const pend = await attach(env, g, session, agent, 'harness')
  expect(pend.sc.status, errOf(pend)).toBe('pending_admission')
  const key = await enrolPasskey(env, g.memberId).catch(() => { throw new Error('passkey') })
  const res = await decideMoment(env, String(pend.sc.approve_url), key, ceiling)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const done = await attach(env, g, session, agent)
  expect(done.sc.status, errOf(done)).toBe('attached')
  return key
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedHuman(HUMAN)
  seedAgent({ id: 'agent-rava', slug: 'rava', name: 'Rava', squad: 'squad-core', admins: [HUMAN] })
  seedAgent({ id: 'agent-hadi-dev', slug: 'hadi-dev', name: 'Hadi Dev', squad: 'squad-core', admins: [HUMAN] })
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => { h.close() })

const seatOf = (session: string): string => one<{ id: string }>(`SELECT id FROM agent_seats WHERE label_basename LIKE ? OR client_key_hash IS NOT NULL ORDER BY created_at LIMIT 1`, `%${session}%`)?.id ?? ''
/** FIXTURE ONLY: the harness rows are immutable by trigger in production; tamper tests model a row that is already wrong. */
const tamperHarness = (sql: string): void => {
  const trg = (h.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'harnesses'`).all() as Array<{ name: string }>).map((t) => t.name)
  for (const t of trg) h.sqlite.exec(`DROP TRIGGER ${t}`)
  h.sqlite.exec(sql)
}
const attachments = (): Array<{ id: string; seat_id: string; agent_id: string; admission_id: string; seat_token_id: string; detached_at: string | null }> =>
  h.sqlite.prepare(`SELECT id, seat_id, agent_id, admission_id, seat_token_id, detached_at FROM agent_seat_attachments ORDER BY created_at, rowid`).all() as never
const liveSeatIds = (): string[] => (h.sqlite.prepare(`SELECT seat_id FROM agent_seat_attachments WHERE detached_at IS NULL ORDER BY created_at, rowid`).all() as Array<{ seat_id: string }>).map((r) => r.seat_id)

describe('R1 round 2: grant replacement and approval boundaries', () => {
  it('revoke and re-consent on the same client requires a fresh harness approval', async () => {
    const env = envFor(h)
    const old = await grant(env, HUMAN)
    const key = await admitForAllChats(env, old, 'before-consent')
    const oldAdmission = attachments()[0].admission_id
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(old.tokenId)
    const replacement = await grant(env, HUMAN)
    expect(replacement.harnessId).toBe(old.harnessId)
    expect(replacement.tokenId).not.toBe(old.tokenId)
    await boot(env, replacement, 'after-consent')
    const ask = await attach(env, replacement, 'after-consent', 'rava', 'harness')
    expect(ask.sc.status, errOf(ask)).toBe('pending_admission')
    expect(await loadAdmission(env, oldAdmission)).toMatchObject({ status: 'revoked', scope: 'harness' })
    expect(await findLiveAttachment(env, { memberId: HUMAN, tokenId: replacement.tokenId }, attachments()[0].seat_id)).toBeNull()
    expect(await listLiveAttachmentsForEvents(env, { memberId: HUMAN, harnessId: replacement.harnessId, grantTokenId: replacement.tokenId })).toEqual([])
    expect((await decideMoment(env, String(ask.sc.approve_url), key)).status).toBe(200)
    expect((await attach(env, replacement, 'after-consent', 'rava')).sc.status).toBe('attached')
    expect(attachments().at(-1)!.admission_id).not.toBe(oldAdmission)
    // A repeat upsert of this same grant must preserve the fresh approval.
    await upsertHarness(env, HUMAN, 'client-chatgpt', 'ChatGPT', replacement.tokenId)
    expect((await boot(env, replacement, 'after-consent')).sc.bound_agent_id).toBe('agent-rava')
  })

  it('re-consent cancels a pending harness approval and its old passkey link', async () => {
    const env = envFor(h)
    const old = await grant(env, HUMAN)
    await boot(env, old, 'pending-consent')
    const ask = await attach(env, old, 'pending-consent', 'rava', 'harness')
    const key = await enrolPasskey(env, HUMAN)
    const path = new URL(String(ask.sc.approve_url)).pathname
    const csrf = csrfOf(await (await hit(path, env)).text())
    const attach_code = one<{ attach_code: string }>(`SELECT attach_code FROM agent_seat_admissions`)!.attach_code
    const ch = await (await hit(`${path}/challenge`, env, { method: 'POST', json: { decision: 'approve', csrf, attach_code } })).json() as J
    const credential = await key.assert({ rpId: HOST, origin: ORIGIN, challenge: ch.publicKey!.challenge })
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(old.tokenId)
    const replacement = await grant(env, HUMAN)
    expect(replacement.harnessId).toBe(old.harnessId)
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions`)!.status).toBe('revoked')
    expect((await hit(`${path}/decide`, env, { method: 'POST', json: { decision: 'approve', csrf, attach_code, credential } })).status).not.toBe(200)
    expect(attachments()).toHaveLength(0)
  })

  it('failed harness re-anchor rolls back admission revocation and attachment/token cascades', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'rollback')
    const a = attachments()[0]
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(g.tokenId)
    h.sqlite.exec(`CREATE TRIGGER reject_reanchor BEFORE UPDATE OF grant_id ON harnesses BEGIN SELECT RAISE(ABORT, 'test_reanchor_failure'); END`)
    await expect(grant(env, HUMAN)).rejects.toThrow('test_reanchor_failure')
    expect(await loadAdmission(env, a.admission_id)).toMatchObject({ status: 'live', revoked_at: null })
    expect(one(`SELECT grant_id FROM harnesses WHERE id = ?`, g.harnessId)).toEqual({ grant_id: `oauth:${g.tokenId}` })
    expect(attachments()[0].detached_at).toBeNull()
    expect(one(`SELECT revoked_at FROM member_tokens WHERE id = ?`, a.seat_token_id)).toEqual({ revoked_at: null })
  })

  it('passkey promotion pins its grant snapshot when the harness changes before the INSERT', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'tap-race')
    const ask = await attach(env, g, 'tap-race', 'rava', 'harness')
    const key = await enrolPasskey(env, HUMAN)
    const other = { tokenId: 'other-tap-grant' }
    h.sqlite.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES (?, ?, ?, 'replacement', 'directory', datetime('now'), ?)`).run(other.tokenId, HUMAN, other.tokenId, TENANT)
    const batch = env.DB.batch.bind(env.DB)
    let changed = false
    env.DB.batch = (async (stmts: Parameters<typeof batch>[0]) => {
      // Isolate the INSERT proof: simulate a changed anchor without admission invalidation.
      if (!changed && stmts.some((s) => String((s as unknown as { sql: string }).sql).includes('UPDATE agent_seat_admissions SET status = \'live\''))) {
        changed = true
        tamperHarness(`UPDATE harnesses SET grant_id = 'oauth:${other.tokenId}' WHERE id = '${g.harnessId}'`)
      }
      return batch(stmts)
    }) as typeof env.DB.batch
    expect((await decideMoment(env, String(ask.sc.approve_url), key)).status).toBe(200)
    expect(changed).toBe(true)
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions`)!.status).toBe('live')
    expect(attachments()).toHaveLength(0)
  })

  it('re-anchor revokes only harness-scoped approvals on the reused harness', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const key = await admitForAllChats(env, g, 'scoped-harness')
    await boot(env, g, 'scoped-seat')
    const ask = await attach(env, g, 'scoped-seat', 'hadi-dev')
    expect((await decideMoment(env, String(ask.sc.approve_url), key)).status).toBe(200)
    const other = await grant(env, HUMAN, 'other-install')
    await admitForAllChats(env, other, 'other-harness')
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(g.tokenId)
    expect((await grant(env, HUMAN)).harnessId).toBe(g.harnessId)
    expect(one(`SELECT status FROM agent_seat_admissions WHERE harness_id = ? AND scope = 'harness'`, g.harnessId)).toEqual({ status: 'revoked' })
    expect(one(`SELECT status FROM agent_seat_admissions WHERE harness_id = ? AND scope = 'seat'`, g.harnessId)).toEqual({ status: 'live' })
    expect(one(`SELECT status FROM agent_seat_admissions WHERE harness_id = ?`, other.harnessId)).toEqual({ status: 'live' })
  })

  it('a losing re-anchor CAS preserves the winning consent and its fresh approval', async () => {
    const env = envFor(h)
    const old = await grant(env, HUMAN)
    await admitForAllChats(env, old, 'cas-old')
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(old.tokenId)
    const batch = env.DB.batch.bind(env.DB)
    const winnerEnv = { ...env, DB: { ...env.DB, batch } } as Env
    let winner: Grant | undefined
    let raced = false
    env.DB.batch = (async (stmts: Parameters<typeof batch>[0]) => {
      if (!raced) {
        raced = true
        winner = await grant(winnerEnv, HUMAN)
        await admitForAllChats(winnerEnv, winner, 'cas-winner')
      }
      return batch(stmts)
    }) as typeof env.DB.batch
    await grant(env, HUMAN)
    expect(raced).toBe(true)
    expect(winner!.harnessId).toBe(old.harnessId)
    expect(one(`SELECT status FROM agent_seat_admissions WHERE harness_id = ? AND status = 'live'`, old.harnessId)).toEqual({ status: 'live' })
    expect((await boot(winnerEnv, winner!, 'cas-winner')).sc.bound_agent_id).toBe('agent-rava')
  })

  it('passkey promotion under a revoked grant cannot attach even its original asking seat', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'tap-revoked')
    await attach(env, g, 'tap-revoked', 'rava', 'harness')
    const adm = (await loadAdmission(env, one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!.id))!
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(g.tokenId)
    const result = await promoteAdmissionDetailed(env, adm, HUMAN, 'webauthn', new Date().toISOString(), 'member', adm.attach_code)
    expect(result.landed).toBe(true)
    expect(result.attachmentId).toBeNull()
    expect(attachments()).toHaveLength(0)
  })

  it.each(['original', 'later'])('dashboard reuse of a %s seat requires grant proof', async (which) => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'dashboard-original')
    const original = attachments()[0]
    await detachAttachment(env, { attachmentId: original.id, humanMemberId: HUMAN })
    await boot(env, g, 'dashboard-later')
    const seatId = which === 'original' ? original.seat_id : one<{ id: string }>(`SELECT id FROM agent_seats WHERE id != ?`, original.seat_id)!.id
    const p = { agentId: 'agent-rava', humanMemberId: HUMAN, harnessId: g.harnessId, seatId, via: 'dashboard' as const }
    expect(await ensureAdmission(env, p)).toEqual({ ok: false, error: 'attach_refused' })
    expect(await attachSeatToAgent(env, { humanMemberId: HUMAN, seatId, agentRef: 'rava', via: 'dashboard' })).toEqual({ ok: false, error: 'attach_refused' })
    expect(await attachSeatToAgent(env, { humanMemberId: HUMAN, seatId, agentRef: 'rava', via: 'dashboard', grantTokenId: g.tokenId })).toMatchObject({ ok: true, status: 'attached' })
  })

  it('dashboard INSERT rechecks the supplied grant against a changed harness', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'dashboard-a')
    await boot(env, g, 'dashboard-b')
    const seatId = one<{ id: string }>(`SELECT id FROM agent_seats WHERE id NOT IN (SELECT seat_id FROM agent_seat_attachments)`)!.id
    const other = { tokenId: 'other-dashboard-grant' }
    h.sqlite.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES (?, ?, ?, 'replacement', 'directory', datetime('now'), ?)`).run(other.tokenId, HUMAN, other.tokenId, TENANT)
    const batch = env.DB.batch.bind(env.DB)
    env.DB.batch = (async (stmts: Parameters<typeof batch>[0]) => {
      tamperHarness(`UPDATE harnesses SET grant_id = 'oauth:${other.tokenId}' WHERE id = '${g.harnessId}'`)
      return batch(stmts)
    }) as typeof env.DB.batch
    expect(await attachSeatToAgent(env, { humanMemberId: HUMAN, seatId, agentRef: 'rava', via: 'dashboard', grantTokenId: g.tokenId })).toEqual({ ok: false, error: 'attach_refused' })
    expect(attachments().filter((a) => a.seat_id === seatId)).toHaveLength(0)
  })

  it.each([
    ['retired seat', `UPDATE agent_seats SET retired_at = datetime('now')`],
    ['suspended welded member', `UPDATE members SET status = 'suspended' WHERE id = 'mem-agent-rava'`],
    ['detached attachment with token cascade defeated', `DROP TRIGGER agent_seat_attachments_revoke_token; UPDATE agent_seat_attachments SET detached_at = datetime('now')`],
  ])('events and resolver share liveness for a %s', async (_name, flip) => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'events-shared')
    const a = attachments()[0]
    const events = () => listLiveAttachmentsForEvents(env, { memberId: HUMAN, harnessId: g.harnessId, grantTokenId: g.tokenId })
    const resolved = () => findLiveAttachment(env, { memberId: HUMAN, tokenId: g.tokenId }, a.seat_id)
    expect(await events()).toHaveLength(1)
    expect(await resolved()).not.toBeNull()
    h.sqlite.exec(flip)
    expect(await events()).toEqual([])
    expect(await resolved()).toBeNull()
  })

  it('token alias parameter preserves the supplied time expression verbatim', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    // Replacing t. across the completed fragment would corrupt this literal as well as the alias.
    const now = `CASE WHEN 't.' = char(116, 46) THEN datetime('now') ELSE '9999-01-01' END`
    h.sqlite.prepare(`UPDATE member_tokens SET expires_at = datetime('now', '+1 day') WHERE id = ?`).run(g.tokenId)
    expect(one(`SELECT g.id FROM member_tokens g WHERE g.id = ? AND ${TOKEN_LIVE_PREDICATE(now, 'g')}`, g.tokenId)).toEqual({ id: g.tokenId })
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('selection: a later thread explicitly attaches with no new tap (the headline)', () => {
  it('day-2 thread (new openai/session) attaches to Rava with NO new admission, NO new moment, its own attachment id', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-day1')
    const adm = one<{ id: string; scope: string; status: string }>(`SELECT id, scope, status FROM agent_seat_admissions`)!
    expect(adm).toMatchObject({ scope: 'harness', status: 'live' })
    const momentsBefore = n(`SELECT COUNT(*) AS n FROM secure_moments`)

    // a NEW unselected thread stays its own unattached seat
    const own = await boot(env, g, 'conv-day2')
    expect(own.sc.bound_agent_id).not.toBe('agent-rava')

    const r = await attach(env, g, 'conv-day2', 'rava')
    expect(r.sc, errOf(r)).toMatchObject({ status: 'attached', admission_id: adm.id, agent: { id: 'agent-rava' } })
    expect((await boot(env, g, 'conv-day2')).sc.bound_agent_id).toBe('agent-rava')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_admissions`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM secure_moments`)).toBe(momentsBefore)
    const [a1, a2] = attachments()
    expect(a1.id).not.toBe(a2.id)
    expect(a1.seat_token_id).not.toBe(a2.seat_token_id)
    expect(a1.admission_id).toBe(a2.admission_id)
  })

  it('a new thread that never calls seat_attach is NOT auto-attached (no auto-attach, no default-to-admin)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-day1')
    for (const s of ['conv-x', 'conv-y']) {
      const b = await boot(env, g, s)
      expect(b.sc.bound_agent_id).not.toBe('agent-rava')
    }
    expect(attachments()).toHaveLength(1)
  })

  it('first explicit selection pins the thread: switching to another agent mid-conversation is refused', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-day1', 'rava')
    await admitForAllChats(env, g, 'conv-day1b', 'hadi-dev')
    await boot(env, g, 'conv-day2')
    expect((await attach(env, g, 'conv-day2', 'rava')).sc.status).toBe('attached')
    const sw = await attach(env, g, 'conv-day2', 'hadi-dev')
    expect(errOf(sw)).toContain('already_attached')
    expect((await boot(env, g, 'conv-day2')).sc.bound_agent_id).toBe('agent-rava')
    expect(liveSeatIds().filter((s) => s === attachments().find((a) => a.agent_id === 'agent-rava' && a.seat_id !== undefined)!.seat_id).length).toBeGreaterThan(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('consent scope: reuse only inside what the human recorded; never silent, never widened', () => {
  it('a legacy (scope seat) live admission is NOT reusable by another thread, and is not upgraded by asking', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const pend = await attach(env, g, 'conv-a', 'rava') // default scope
    const key = await enrolPasskey(env, HUMAN)
    expect((await decideMoment(env, String(pend.sc.approve_url), key)).status).toBe(200)
    expect((await attach(env, g, 'conv-a', 'rava')).sc.status).toBe('attached')
    expect(one<{ scope: string }>(`SELECT scope FROM agent_seat_admissions`)!.scope).toBe('seat')

    await boot(env, g, 'conv-b')
    expect(errOf(await attach(env, g, 'conv-b', 'rava'))).toContain('approval_bound_to_other_chat')
    // the SAME thread (detached by its human) asking for the wider scope is refused too: an upgrade is the human's explicit revoke + re-ask
    expect(await detachAttachment(env, { attachmentId: attachments()[0].id, humanMemberId: HUMAN })).toEqual({ ok: true })
    expect(errOf(await attach(env, g, 'conv-a', 'rava', 'harness'))).toContain('admission_scope_mismatch')
    expect(one<{ scope: string }>(`SELECT scope FROM agent_seat_admissions`)!.scope).toBe('seat')
    expect(attachments()).toHaveLength(1)
  })

  it('upgrade is explicit: revoke the old row, ask with scope harness, tap; the old row stays revoked and seat-scoped', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const pend = await attach(env, g, 'conv-a', 'rava')
    const key = await enrolPasskey(env, HUMAN)
    await decideMoment(env, String(pend.sc.approve_url), key)
    await attach(env, g, 'conv-a', 'rava')
    const oldId = one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!.id
    expect(await revokeAdmission(env, { admissionId: oldId, humanMemberId: HUMAN })).toMatchObject({ ok: true })
    const again = await attach(env, g, 'conv-a', 'rava', 'harness')
    expect(again.sc.status, errOf(again)).toBe('pending_admission')
    expect((await decideMoment(env, String(again.sc.approve_url), key)).status).toBe(200)
    expect(one(`SELECT scope, status FROM agent_seat_admissions WHERE id = ?`, oldId)).toMatchObject({ scope: 'seat', status: 'revoked' })
    await boot(env, g, 'conv-b')
    expect((await attach(env, g, 'conv-b', 'rava')).sc.status).toBe('attached')
  })

  it('admission is never transferred or widened: the reusing thread gets the SAME admission, ceiling and agent, nothing else', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-a', 'rava', 'lead')
    await boot(env, g, 'conv-b')
    await attach(env, g, 'conv-b', 'rava')
    const rows = h.sqlite.prepare(`SELECT id, agent_id, ceiling, scope, gate_authority FROM agent_seat_admissions`).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'agent-rava', ceiling: 'lead', scope: 'harness' })
    // hadi-dev has no admission: the harness-wide approval for Rava does not extend to it
    expect((await attach(env, g, 'conv-b', 'hadi-dev')).sc.error ?? errOf(await attach(env, g, 'conv-b', 'hadi-dev'))).toContain('already_attached')
    await boot(env, g, 'conv-c')
    expect((await attach(env, g, 'conv-c', 'hadi-dev')).sc.status).toBe('pending_admission')
  })

  it('a harness-wide approval cannot carry the full ceiling (admin power is never inherited across threads)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const pend = await attach(env, g, 'conv-a', 'rava', 'harness')
    const key = await enrolPasskey(env, HUMAN)
    const res = await decideMoment(env, String(pend.sc.approve_url), key, 'full')
    expect(res.status).toBe(409)
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions`)!.status).toBe('pending')
  })

  it('a harness-wide approval can only be decided at the passkey tap (the dashboard/claim direct path refuses it)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const pend = await attach(env, g, 'conv-a', 'rava', 'harness')
    const id = String(pend.sc.admission_id)
    const code = one<{ attach_code: string }>(`SELECT attach_code FROM agent_seat_admissions WHERE id = ?`, id)!.attach_code
    expect(await decideAdmissionDirect(env, { admissionId: id, humanMemberId: HUMAN, decision: 'approve', attachCode: code })).toEqual({ ok: false, error: 'attach_refused' })
    expect(one<{ status: string }>(`SELECT status FROM agent_seat_admissions WHERE id = ?`, id)!.status).toBe('pending')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('grant anchor and liveness chain: verified on attach AND on every operation', () => {
  async function twoThreads() {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-a')
    await boot(env, g, 'conv-b')
    expect((await attach(env, g, 'conv-b', 'rava')).sc.status).toBe('attached')
    const [a, b] = attachments()
    return { env, g, seatA: a.seat_id, seatB: b.seat_id }
  }
  const stillAttached = async (env: Env, g: Grant, s: string): Promise<boolean> => (await boot(env, g, s)).sc.bound_agent_id === 'agent-rava'

  it.each([
    ['null grant anchor', `UPDATE harnesses SET grant_id = NULL`],
    ['legacy grant anchor', `UPDATE harnesses SET grant_id = 'legacy:x'`],
    ['grant anchor naming another token', `UPDATE harnesses SET grant_id = 'oauth:no-such-token'`],
  ])('%s: the reused thread is cut on its next operation', async (_n, sql) => {
    const { env, g } = await twoThreads()
    tamperHarness(sql)
    expect(await stillAttached(env, g, 'conv-b')).toBe(false)
  })

  it('the original (requesting) thread is ALSO cut when the harness anchor is gone: harness scope needs a proven grant everywhere', async () => {
    const { env, g } = await twoThreads()
    tamperHarness(`UPDATE harnesses SET grant_id = NULL`)
    expect(await stillAttached(env, g, 'conv-a')).toBe(false)
  })

  it('token-kind mismatch: a harness that is not an oauth harness grants nothing', async () => {
    const { env, g, seatB } = await twoThreads()
    tamperHarness(`UPDATE harnesses SET credential_kind = 'token', token_id = '${g.tokenId}'`)
    expect(await findLiveAttachment(env, { memberId: HUMAN, tokenId: g.tokenId }, seatB)).toBeNull()
  })

  it('revoked grant token, expired grant token: every thread is cut', async () => {
    for (const col of ["revoked_at = datetime('now')", "expires_at = datetime('now', '-1 hour')"]) {
      const { env, g } = await twoThreads()
      h.sqlite.exec(`UPDATE member_tokens SET ${col} WHERE id = '${g.tokenId}'`)
      expect(await stillAttached(env, g, 'conv-a')).toBe(false)
      expect(await stillAttached(env, g, 'conv-b')).toBe(false)
      h.close(); h = createSqliteD1(); applyAllMigrations(h.sqlite)
      seedHuman(HUMAN); seedAgent({ id: 'agent-rava', slug: 'rava', name: 'Rava', squad: 'squad-core', admins: [HUMAN] })
      resetAutoSeatRefusalCache()
    }
  })

  it('wrong grant: another install of the same human (different grant token/harness) cannot use or reach the attachment', async () => {
    const { env, seatB } = await twoThreads()
    const other = await grant(env, HUMAN, 'client-chatgpt-2')
    expect(await findLiveAttachment(env, { memberId: HUMAN, tokenId: other.tokenId }, seatB)).toBeNull()
    expect(await findLiveAttachment(env, { memberId: HUMAN, tokenId: null }, seatB)).toBeNull() // no proven grant at all
    // the other install must ask for itself: the harness-wide approval is per install
    await boot(env, other, 'conv-z')
    expect((await attach(env, other, 'conv-z', 'rava', 'harness')).sc.status).toBe('pending_admission')
  })

  it('wrong member: another human cannot resolve the attachment', async () => {
    const { env, g, seatB } = await twoThreads()
    seedHuman('member-human-2')
    expect(await findLiveAttachment(env, { memberId: 'member-human-2', tokenId: g.tokenId }, seatB)).toBeNull()
  })

  it('agent suspended / admission revoked / agent unadmitted: refused on the next operation', async () => {
    const { env, g } = await twoThreads()
    h.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = 'agent-rava'`)
    expect(await stillAttached(env, g, 'conv-b')).toBe(false)
    h.sqlite.exec(`UPDATE agents SET status = 'active' WHERE id = 'agent-rava'`)
    expect(await stillAttached(env, g, 'conv-b')).toBe(true)
    // an unadmitted agent: nobody ever asked for hadi-dev on this install
    await boot(env, g, 'conv-c')
    expect((await attach(env, g, 'conv-c', 'hadi-dev')).sc.status).toBe('pending_admission')
  })

  it('request metadata never supplies authorization: a forged scope/seat/admission in args or _meta changes nothing', async () => {
    const { env, g } = await twoThreads()
    await boot(env, g, 'conv-c')
    const admId = one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!.id
    // a forged seat handle in _meta is rejected outright; it never selects someone else's seat
    const forgedSeat = await rpc(env, g.ctx, 'seat_attach', { agent: 'rava' }, { ...thread('conv-c'), 'mupot/seat': attachments()[0].seat_id })
    expect(forgedSeat.sc.status).not.toBe('attached')
    expect(attachments()).toHaveLength(2)
    // forged admission / subject keys are not authority: an unadmitted agent still needs its own human tap
    const r = await rpc(env, g.ctx, 'seat_attach', { agent: 'hadi-dev' }, { ...thread('conv-c'), 'mupot/admission': admId, 'openai/subject': 'whoever' })
    expect(r.sc.status).toBe('pending_admission')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE agent_id = 'agent-hadi-dev'`)).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('revocation cuts every thread; revoke between a read and a write', () => {
  it('revoking the ADMISSION cuts all threads (boot, attachment resolver, events listing) at once', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-a')
    await boot(env, g, 'conv-b'); await attach(env, g, 'conv-b', 'rava')
    expect((await listLiveAttachmentsForEvents(env, { memberId: HUMAN, harnessId: g.harnessId, grantTokenId: g.tokenId }))).toHaveLength(1)
    const admId = one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!.id
    expect(await revokeAdmission(env, { admissionId: admId, humanMemberId: HUMAN })).toMatchObject({ ok: true, detached: 2 })
    for (const s of ['conv-a', 'conv-b']) expect((await boot(env, g, s)).sc.bound_agent_id).not.toBe('agent-rava')
    expect(await listLiveAttachmentsForEvents(env, { memberId: HUMAN, harnessId: g.harnessId, grantTokenId: g.tokenId })).toHaveLength(0)
    // inbox_mark_handled (a write) is refused for a revoked thread
    const w = await rpc(env, g.ctx, 'inbox_mark_handled', { ids: ['m-1'] }, thread('conv-b'))
    expect(errOf(w)).toContain('not_attached_seat')
    // a revoked admission cannot be reused to attach a new thread
    await boot(env, g, 'conv-c')
    expect((await attach(env, g, 'conv-c', 'rava')).sc.status).toBe('pending_admission')
  })

  it('revoking the GRANT token cuts the thread, the events listing and the attachment resolver', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-a')
    const seat = attachments()[0].seat_id
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = '${g.tokenId}'`)
    expect(await findLiveAttachment(env, { memberId: HUMAN, tokenId: g.tokenId }, seat)).toBeNull()
    expect(await listLiveAttachmentsForEvents(env, { memberId: HUMAN, harnessId: g.harnessId, grantTokenId: g.tokenId })).toHaveLength(0)
  })

  it('revocation landing BETWEEN the read and the write: the attach write lands nothing', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-a')
    await boot(env, g, 'conv-b')
    const seatB = one<{ id: string }>(`SELECT id FROM agent_seats WHERE id NOT IN (SELECT seat_id FROM agent_seat_attachments) AND agent_id != 'agent-rava' ORDER BY created_at LIMIT 1`)!.id
    const admId = one<{ id: string }>(`SELECT id FROM agent_seat_admissions`)!.id
    // the read (ensureAdmission found the admission live) has happened; the revoke lands before the batch write
    const realBatch = env.DB.batch.bind(env.DB)
    let fired = false
    env.DB.batch = (async (stmts: Parameters<typeof realBatch>[0]) => {
      if (!fired) { fired = true; h.sqlite.prepare(`UPDATE agent_seat_admissions SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?`).run(admId) }
      return realBatch(stmts)
    }) as typeof env.DB.batch
    const r = await attachSeatToAgent(env, { humanMemberId: HUMAN, seatId: seatB, agentRef: 'rava', via: 'tool', grantTokenId: g.tokenId })
    expect(fired).toBe(true)
    expect(r).toEqual({ ok: false, error: 'attach_refused' })
    expect(attachments().filter((a) => a.seat_id === seatB)).toHaveLength(0)
  })

  it('revocation of the GRANT between read and write: the attach write lands nothing', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-a')
    await boot(env, g, 'conv-b')
    const seatB = one<{ id: string }>(`SELECT id FROM agent_seats WHERE id NOT IN (SELECT seat_id FROM agent_seat_attachments) AND agent_id != 'agent-rava' ORDER BY created_at LIMIT 1`)!.id
    const realBatch = env.DB.batch.bind(env.DB)
    env.DB.batch = (async (stmts: Parameters<typeof realBatch>[0]) => {
      h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = ?`).run(g.tokenId)
      return realBatch(stmts)
    }) as typeof env.DB.batch
    const r = await attachSeatToAgent(env, { humanMemberId: HUMAN, seatId: seatB, agentRef: 'rava', via: 'tool', grantTokenId: g.tokenId })
    expect(r).toEqual({ ok: false, error: 'attach_refused' })
    expect(attachments().filter((a) => a.seat_id === seatB)).toHaveLength(0)
  })

  it('a stale cached AuthContext cannot outlive the revoke: the thread is re-resolved per request', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-a')
    const cached = g.ctx // the grant context is reused across requests
    expect((await rpc(env, cached, 'boot_context', {}, thread('conv-a'))).sc.bound_agent_id).toBe('agent-rava')
    h.sqlite.exec(`UPDATE agent_seat_admissions SET status = 'revoked', revoked_at = datetime('now')`)
    expect((await rpc(env, cached, 'boot_context', {}, thread('conv-a'))).sc.bound_agent_id).not.toBe('agent-rava')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('isolation: concurrent Rava and hadi-dev threads', () => {
  function memEnv(): Env {
    const vectors: Array<{ id: string; metadata: Record<string, unknown> }> = []
    return {
      ...envFor(h),
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VEC: {
        upsert: async (rows: Array<{ id: string; metadata: Record<string, unknown> }>) => { vectors.push(...rows) },
        query: async (_v: number[], o: { topK: number; filter: Record<string, unknown> }) => ({ matches: vectors.filter((v) => Object.entries(o.filter).every(([k, val]) => v.metadata[k] === val)).slice(0, o.topK).map((v, i) => ({ id: v.id, score: 0.9 - i / 10 })) }),
      },
    } as unknown as Env
  }

  async function raveAndDev(env: Env, g: Grant) {
    await admitForAllChats(env, g, 'conv-rava-1', 'rava')
    await admitForAllChats(env, g, 'conv-dev-1', 'hadi-dev')
    await boot(env, g, 'conv-rava-2'); await attach(env, g, 'conv-rava-2', 'rava')
    await boot(env, g, 'conv-dev-2'); await attach(env, g, 'conv-dev-2', 'hadi-dev')
  }

  it('four threads, two identities: separate attachment ids and tokens; each thread acts as its own identity', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await raveAndDev(env, g)
    const rows = attachments()
    expect(rows).toHaveLength(4)
    expect(new Set(rows.map((r) => r.id)).size).toBe(4)
    expect(new Set(rows.map((r) => r.seat_token_id)).size).toBe(4)
    expect(new Set(rows.map((r) => r.seat_id)).size).toBe(4)
    for (const [s, a] of [['conv-rava-1', 'agent-rava'], ['conv-rava-2', 'agent-rava'], ['conv-dev-1', 'agent-hadi-dev'], ['conv-dev-2', 'agent-hadi-dev']]) {
      expect((await boot(env, g, s)).sc.bound_agent_id).toBe(a)
    }
    const events = await listLiveAttachmentsForEvents(env, { memberId: HUMAN, harnessId: g.harnessId, grantTokenId: g.tokenId })
    expect(events.map((e) => e.agentId).sort()).toEqual(['agent-hadi-dev', 'agent-rava'])
  })

  it('inboxes and memory are separate per identity (memory keyed on each agent\'s own welded member)', async () => {
    const env = memEnv()
    const g = await grant(env, HUMAN)
    await raveAndDev(env, g)
    h.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body) VALUES ('m-rava', '${TENANT}', 'agent-rava', 'agent-x', 'mem-x', 'message', 'for rava'), ('m-dev', '${TENANT}', 'agent-hadi-dev', 'agent-x', 'mem-x', 'message', 'for dev')`)
    const peek = async (s: string): Promise<string> => JSON.stringify((await rpc(env, g.ctx, 'inbox', { peek: true, limit: 10 }, thread(s))).body)
    expect(await peek('conv-rava-2')).toContain('m-rava')
    expect(await peek('conv-rava-2')).not.toContain('m-dev')
    expect(await peek('conv-dev-2')).toContain('m-dev')
    expect(await peek('conv-dev-2')).not.toContain('m-rava')
    const w1 = await rpc(env, g.ctx, 'remember', { text: 'rava-only-marker' }, thread('conv-rava-2'))
    const w2 = await rpc(env, g.ctx, 'remember', { text: 'dev-only-marker' }, thread('conv-dev-2'))
    expect(one<{ agent_id: string }>(`SELECT agent_id FROM engrams WHERE id = ?`, String(w1.sc.engram_id))!.agent_id).toBe('member:mem-agent-rava')
    expect(one<{ agent_id: string }>(`SELECT agent_id FROM engrams WHERE id = ?`, String(w2.sc.engram_id))!.agent_id).toBe('member:mem-agent-hadi-dev')
  })

  it('a forged other-seat handle cannot adopt another thread\'s attachment', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await raveAndDev(env, g)
    const devSeat = attachments().find((a) => a.agent_id === 'agent-hadi-dev')!.seat_id
    const raveSeat = attachments().find((a) => a.agent_id === 'agent-rava')!.seat_id
    for (const forged of [devSeat, raveSeat, `mseat_${raveSeat}`]) {
      const r = await rpc(env, g.ctx, 'boot_context', {}, thread('conv-fresh'), { 'x-mupot-seat': forged })
      expect(r.sc.bound_agent_id, forged).not.toBe('agent-rava')
      expect(r.sc.bound_agent_id, forged).not.toBe('agent-hadi-dev')
    }
  })

  it('concurrent attach races: many threads at once each get exactly one attachment; one thread racing two agents gets one', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await admitForAllChats(env, g, 'conv-rava-1', 'rava')
    await admitForAllChats(env, g, 'conv-dev-1', 'hadi-dev')
    const sessions = ['c1', 'c2', 'c3', 'c4']
    for (const s of sessions) await boot(env, g, s)
    const res = await Promise.all(sessions.map((s, i) => attach(env, g, s, i % 2 === 0 ? 'rava' : 'hadi-dev')))
    for (const r of res) expect(r.sc.status, errOf(r)).toBe('attached')
    // the same thread racing two different agents: exactly one wins
    await boot(env, g, 'c5')
    const race = await Promise.all([attach(env, g, 'c5', 'rava'), attach(env, g, 'c5', 'hadi-dev')])
    expect(race.filter((r) => r.sc.status === 'attached')).toHaveLength(1)
    const seat5 = one<{ id: string }>(`SELECT s.id AS id FROM agent_seats s WHERE s.id NOT IN (SELECT seat_id FROM agent_seat_attachments WHERE detached_at IS NULL) LIMIT 1`)
    void seat5
    const live = h.sqlite.prepare(`SELECT seat_id, COUNT(*) AS c FROM agent_seat_attachments WHERE detached_at IS NULL GROUP BY seat_id HAVING c > 1`).all()
    expect(live).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('openai/subject is an auxiliary signal only', () => {
  it('a differing, absent or forged subject neither attaches, relinks, nor changes authority', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a', 'subject-1')
    const pend = await attach(env, g, 'conv-a', 'rava', 'harness', 'subject-1')
    const key = await enrolPasskey(env, HUMAN)
    await decideMoment(env, String(pend.sc.approve_url), key)
    await attach(env, g, 'conv-a', 'rava', undefined, 'subject-1')
    // same subject, new thread, no explicit attach: still unattached
    expect((await boot(env, g, 'conv-b', 'subject-1')).sc.bound_agent_id).not.toBe('agent-rava')
    // a mismatching subject on the original thread does not detach or re-point it (consistency signal only)
    expect((await boot(env, g, 'conv-a', 'subject-OTHER')).sc.bound_agent_id).toBe('agent-rava')
    // a mismatching subject on an explicit attach neither blocks nor broadens it
    await boot(env, g, 'conv-c', 'subject-OTHER')
    expect((await attach(env, g, 'conv-c', 'rava', undefined, 'subject-OTHER')).sc.status).toBe('attached')
    expect(attachments().every((a) => a.agent_id === 'agent-rava')).toBe(true)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seat_admissions`)).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('gate authority is not inherited through grant continuity', () => {
  it('verdict write guard itself denies a reused harness admission even with gate_authority forced on', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    h.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg-write', 'gate:review', 'agent', 'agent-rava', 'x', '2026-01-01')`)
    await admitForAllChats(env, g, 'verdict-original')
    await boot(env, g, 'verdict-reused')
    expect((await attach(env, g, 'verdict-reused', 'rava')).sc.status).toBe('attached')
    h.sqlite.exec(`DROP TRIGGER agent_seat_admissions_gate_authority_immutable; UPDATE agent_seat_admissions SET gate_authority = 1`)
    const { writeVerdict, VerdictRaceError } = await import('../src/tasks/service')
    const mkTask = (id: string) => h.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, created_at, updated_at)
      VALUES (?, 'squad-core', 't', 'b', 'p', 'review', 'gate:review', 'agent-hadi-dev', '2026-10-01', '2026-10-01')`).run(id)
    const write = (id: string, a: ReturnType<typeof attachments>[number]) => writeVerdict(env, {
      task: one<Record<string, unknown>>(`SELECT * FROM tasks WHERE id = ?`, id) as never,
      verdict: 'approved', note: null, decidedBy: 'agent-rava',
      attribution: { attachmentId: a.id, consentingMemberId: HUMAN, seatId: a.seat_id, grantTokenId: g.tokenId },
    })
    const [original, reused] = attachments()
    // Direct service calls bypass attachedGateAgent: only the atomic write guard can deny this.
    expect(await findLiveAttachment(env, { memberId: HUMAN, tokenId: g.tokenId }, reused.seat_id)).not.toBeNull()
    mkTask('verdict-reused')
    await expect(write('verdict-reused', reused)).rejects.toBeInstanceOf(VerdictRaceError)
    expect(n(`SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = 'verdict-reused'`)).toBe(0)
    expect(one<{ status: string }>(`SELECT status FROM tasks WHERE id = 'verdict-reused'`)!.status).toBe('review')
    // Positive control isolates the requested-seat guard from every other verdict condition.
    mkTask('verdict-original')
    await write('verdict-original', original)
    expect(n(`SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = 'verdict-original'`)).toBe(1)
  })

  it('a reused thread never holds the agent\'s gate, even if the agent holds a live gate grant and the admission bit is forced on', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    // the agent holds a gate BEFORE the human approves: for a seat-scoped admission this would set gate_authority = 1
    h.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg1', 'gate:review', 'agent', 'agent-rava', 'x', '2026-01-01')`)
    await admitForAllChats(env, g, 'conv-a')
    expect(one<{ gate_authority: number }>(`SELECT gate_authority FROM agent_seat_admissions`)!.gate_authority).toBe(0) // harness scope: never auto-opened
    await boot(env, g, 'conv-b'); await attach(env, g, 'conv-b', 'rava')
    const ctxB = async (s: string): Promise<AuthContext> => {
      const { applySeatForRequest } = await import('../src/members/seat-auto')
      const { NO_HINTS } = await import('../src/members/seat-handle')
      return applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: s, codexThreadId: null } })
    }
    expect(await callerHoldsGateCapability(env, await ctxB('conv-b'), 'squad-core', 'gate:review')).toBe(false)
    // defence in depth: force the bit on (fixture only) -- the reused thread STILL does not hold the gate; only the asking thread can
    h.sqlite.exec(`DROP TRIGGER IF EXISTS agent_seat_admissions_gate_authority_immutable; UPDATE agent_seat_admissions SET gate_authority = 1`)
    expect(await callerHoldsGateCapability(env, await ctxB('conv-b'), 'squad-core', 'gate:review')).toBe(false)
  })

  it('the existing exception is unchanged: a seat-scoped admission with gate_authority still lets ITS thread hold the gate', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    h.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg1', 'gate:review', 'agent', 'agent-rava', 'x', '2026-01-01')`)
    await boot(env, g, 'conv-a')
    const pend = await attach(env, g, 'conv-a', 'rava')
    const key = await enrolPasskey(env, HUMAN)
    await decideMoment(env, String(pend.sc.approve_url), key)
    await attach(env, g, 'conv-a', 'rava')
    expect(one<{ gate_authority: number }>(`SELECT gate_authority FROM agent_seat_admissions`)!.gate_authority).toBe(1)
    const { applySeatForRequest } = await import('../src/members/seat-auto')
    const { NO_HINTS } = await import('../src/members/seat-handle')
    const a = await applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'conv-a', codexThreadId: null } })
    expect(await callerHoldsGateCapability(env, a, 'squad-core', 'gate:review')).toBe(true)
  })
})

// keep imports that the scenarios above use only for typing/ratchets referenced
void ensureAdmission; void loadAdmission; void seatOf
