// tests/squad-join-request.test.ts — squad_join_request: an agent ASKS to join a squad, a human admin of THAT squad taps once.
//
// Real sqlite D1 from the full committed migration chain. The passkey ceremony runs through the REAL /m/* routes on a
// software authenticator; the approve write is the REAL addSquadMember (memberships + capability + receipts). Attached-chat
// cases go through the real OAuth-props -> mcpApp -> seat_attach path, exactly as tests/seat-attach.test.ts does.
//
// MUTATIONS proven (see PR body): the approver `mayAdministerSquad` check (approve + deny), the home-squad refusal, the
// archived refusal, the never-downgrade `already` guard, the agent-active refusal (request + approve), the own-agent check,
// the attach-first refusal, the capability allow-list, the per-agent rate limit, the pending cap, the dedupe/supersede,
// the request expiry, the pre-gate refusal order (a refusal must not burn the link), the deny notice and the audit rows.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { SoftAuthenticator } from './helpers/webauthn-authenticator'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { advertisedTools, invokeTool, mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { reissueMomentLink } from '../src/secure-moments/issue'
import { momentsApp } from '../src/secure-moments/routes'
import { mintEnrolmentToken } from '../src/secure-moments/store'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { SQUAD_JOIN_MAX_PENDING_PER_AGENT, SQUAD_JOIN_MAX_PER_HOUR, decideSquadJoin, loadSquadJoin, memberMayApprove, whoMayApprove } from '../src/members/squad-join'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const ADMIN = 'member-admin' // admin on squad-target
const PLAIN = 'member-plain' // only a member on squad-target
const ORGADM = 'member-orgadmin' // org-scope admin
const HUMAN = 'member-human-1' // owns the attached chats
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
let env: Env
let tokCounter = 0
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined

function seedHuman(id: string): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', 'Human ${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
}

function seedSquad(id: string, kind = 'work'): void {
  h.sqlite.exec(`
    INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-${id}', 'dept-${id}', 'Dept ${id}');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('${id}', 'dept-${id}', '${id}', 'Squad ${id}', '${kind}');`)
}

/** A welded, named agent whose HOME squad is `squad`. */
function seedAgent(id: string, slug: string, name: string, squad: string, status = 'active'): void {
  const memberId = `mem-${id}`
  h.sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${id}', '${squad}', '${slug}', '${name}', 'r', 'm', '${status}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${memberId}', '${name}', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${id}', '${memberId}', '2026-10-01T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${id}', '${memberId}', 'squad', '${squad}', 'member');`)
}

const cap = (member: string, scope: 'squad' | 'org', scopeId: string | null, capability: string): void => {
  h.sqlite.prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)`).run(`cap-${member}-${scope}-${scopeId ?? 'org'}-${capability}`, member, scope, scopeId, capability)
}

/** An agent-bound session (the agent token a daemon holds). */
const agentCtx = (agentId: string): AuthContext => ({
  userId: `mem-${agentId}`, email: '', role: 'member', tenant: TENANT, channel: 'workspace', memberId: `mem-${agentId}`, capabilities: [], boundAgentId: agentId,
})

type Out = Awaited<ReturnType<typeof invokeTool>>
const ask = (agentId: string, args: Record<string, unknown>, e: Env = env, ctx: AuthContext = agentCtx(agentId)): Promise<Out> =>
  invokeTool(ctx, e, 'squad_join_request', args, 'https://pot.test')
interface Asked { link: string; status: string; expires_at: string; agent_prompt: string }
/** The tool never returns the link (it goes only to approvers), so a test that plays the approver mints one for the pending moment. */
async function askOk(agentId: string, args: Record<string, unknown>): Promise<Asked> {
  const r = await ask(agentId, args)
  if (!r.ok) throw new Error(`ask failed ${JSON.stringify(r)}`)
  const res = r.result as Omit<Asked, 'link'>
  const subject = one<{ id: string }>(`SELECT id FROM squad_join_requests WHERE agent_id = ? AND squad_ref = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1`, agentId, String(args.squad))
  const m = subject ? one<{ id: string }>(`SELECT id FROM secure_moments WHERE kind = 'squad_join' AND subject_id = ? AND status = 'pending'`, subject.id) : undefined
  const link = m ? await reissueMomentLink(env, m.id) : null
  return { ...res, link: link?.url ?? '' }
}
const errOf = (r: Out): string => (r.ok ? '' : r.error)

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

async function enrolPasskey(e: Env, memberId: string): Promise<SoftAuthenticator> {
  const link = await linkLoginIdentity(e, { tenant: TENANT, provider: 'google', providerSubject: `g-${memberId}`, verifiedEmail: `${memberId}@example.test`, memberId })
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

async function decide(url: string, a: SoftAuthenticator, decision: 'approve' | 'deny', e: Env = env): Promise<{ status: number; body: J }> {
  const path = new URL(url).pathname
  const csrf = csrfOf(await (await hit(path, e)).text())
  const ch = (await (await hit(`${path}/challenge`, e, { method: 'POST', json: { decision, csrf } })).json()) as J
  const credential = await a.assert({ rpId: HOST, origin: ORIGIN, challenge: ch.publicKey?.challenge ?? '' })
  const res = await hit(`${path}/decide`, e, { method: 'POST', json: { decision, csrf, credential } })
  const raw = await res.text()
  let body: J = {} as J
  try { body = JSON.parse(raw) as J } catch { /* a 500 is plain text */ }
  return { status: res.status, body }
}

const reqRows = (): Array<{ id: string; status: string; capability: string; squad_id: string | null; squad_key: string; requested_via: string; result: string | null }> =>
  h.sqlite.prepare(`SELECT id, status, capability, squad_id, squad_key, requested_via, result FROM squad_join_requests ORDER BY created_at, id`).all() as never
const momentStatuses = (): string[] => (h.sqlite.prepare(`SELECT status FROM secure_moments WHERE kind = 'squad_join' ORDER BY created_at, id`).all() as Array<{ status: string }>).map((r) => r.status)
const member = (agent: string, squad: string): { capability: string } | undefined => one(`SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?`, agent, squad)
const messagesTo = (agent: string): string[] => (h.sqlite.prepare(`SELECT body FROM agent_messages WHERE to_agent = ?`).all(agent) as Array<{ body: string }>).map((r) => r.body)

let adminKey: SoftAuthenticator
let plainKey: SoftAuthenticator

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = envFor(h)
  for (const m of [ADMIN, PLAIN, ORGADM, HUMAN]) seedHuman(m)
  seedSquad('squad-core')
  seedSquad('squad-target')
  seedSquad('squad-home-x', 'home')
  seedAgent('agent-rava', 'rava', 'Rava', 'squad-core')
  seedAgent('agent-hadi-admin', 'hadi-admin', 'Hadi Admin', 'squad-core')
  cap(ADMIN, 'squad', 'squad-target', 'admin')
  cap(PLAIN, 'squad', 'squad-target', 'member')
  cap(ORGADM, 'org', null, 'admin')
  cap(HUMAN, 'squad', 'squad-core', 'admin')
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
  adminKey = await enrolPasskey(env, ADMIN)
  plainKey = await enrolPasskey(env, PLAIN)
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

// ════════════════════════════════════════════════════════════════════════════
describe('the ask grants nothing', () => {
  it('returns { status, expires_at, agent_prompt } with NO link, files one pending request and one pending moment, writes no membership', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target', reason: 'I run the weekly report for them' })
    expect(Object.keys(r).sort()).toEqual(['agent_prompt', 'expires_at', 'link', 'status']) // `link` is the test's own reissue, see askOk
    expect(r.link.startsWith(`${ORIGIN}/m/`)).toBe(true)
    expect(r.agent_prompt).not.toContain(r.link)
    expect(r.agent_prompt).toContain('Rava')
    expect(r.agent_prompt).toContain('as member')
    expect(reqRows()).toMatchObject([{ status: 'pending', capability: 'member', squad_id: 'squad-target', requested_via: 'agent' }])
    expect(momentStatuses()).toEqual(['pending'])
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(n(`SELECT COUNT(*) AS n FROM gate_grants`)).toBe(0)
  })

  it('opening the page decides nothing and shows the agent, the REAL squad, the capability and the reason in an untrusted box', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target', capability: 'observer', reason: '<script>alert(1)</script> let me in' })
    const html = await (await hit(new URL(r.link).pathname, env)).text()
    expect(html).toContain('Rava')
    expect(html).toContain('Squad squad-target')
    expect(html).toContain('observer')
    expect(html).toContain('class="untrusted"')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('Approve with passkey')
    expect(html).toContain('Deny with passkey')
    expect(reqRows()[0]!.status).toBe('pending')
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
  })
})

describe('approve and deny', () => {
  it('approve: the SAME write as squad_member_add (membership + capability + receipt), audited, the agent is told, single use', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    const res = await decide(r.link, adminKey, 'approve')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.title).toBe('Approved')
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'member' })
    expect(n(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'mem-agent-rava' AND scope_type = 'squad' AND scope_id = 'squad-target' AND capability = 'member'`)).toBe(1)
    const receipt = one<{ actor_member_id: string; action: string; capability: string; result: string }>(`SELECT actor_member_id, action, capability, result FROM membership_receipts WHERE squad_id = 'squad-target'`)
    expect(receipt).toEqual({ actor_member_id: ADMIN, action: 'add', capability: 'member', result: 'created' })
    expect(reqRows()[0]).toMatchObject({ status: 'approved', result: 'created' })
    const decidedBy = one<{ decided_by_member_id: string }>(`SELECT decided_by_member_id FROM squad_join_requests`)
    expect(decidedBy?.decided_by_member_id).toBe(ADMIN)
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'squad_join_approve' AND agent_id = 'agent-rava' AND actor_id = ?`, ADMIN)).toBe(1)
    expect(messagesTo('agent-rava').some((b) => b.includes('APPROVED') && b.includes('Squad squad-target'))).toBe(true)
    expect(momentStatuses()).toEqual(['consumed'])
    expect(n(`SELECT COUNT(*) AS n FROM gate_grants`)).toBe(0)
    // single use: the same link cannot decide again, and nothing new is written
    const again = await decide(r.link, adminKey, 'approve').catch(() => ({ status: 0, body: {} as J }))
    expect([0, 404, 409, 410]).toContain(again.status)
    expect(n(`SELECT COUNT(*) AS n FROM membership_receipts WHERE squad_id = 'squad-target'`)).toBe(1)
  })

  it('approve as observer writes observer', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target', capability: 'observer' })
    expect((await decide(r.link, adminKey, 'approve')).status).toBe(200)
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'observer' })
  })

  it('deny: recorded, nothing written, the agent is told in plain words, single use', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    const res = await decide(r.link, adminKey, 'deny')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.title).toBe('Denied')
    expect(reqRows()[0]!.status).toBe('denied')
    expect(momentStatuses()).toEqual(['denied'])
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(n(`SELECT COUNT(*) AS n FROM membership_receipts WHERE squad_id = 'squad-target'`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'squad_join_deny' AND actor_id = ?`, ADMIN)).toBe(1)
    expect(messagesTo('agent-rava').some((b) => b.includes('DENIED') && b.includes('Nothing changed'))).toBe(true)
    const again = await decide(r.link, adminKey, 'approve').catch(() => ({ status: 0, body: {} as J }))
    expect([0, 404, 409, 410]).toContain(again.status)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
  })

  it('an org-scope admin counts (canOnSquad counts them for a work squad)', async () => {
    const orgKey = await enrolPasskey(env, ORGADM)
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    expect((await decide(r.link, orgKey, 'approve')).status).toBe(200)
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'member' })
  })
})

describe('who may approve', () => {
  it('a non-admin of the TARGET squad is refused (approve and deny), the link is NOT burned, and an admin can still decide it', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    const a = await decide(r.link, plainKey, 'approve')
    expect(a.status).toBe(403)
    const d = await decide(r.link, plainKey, 'deny')
    expect(d.status).toBe(403)
    expect(reqRows()[0]!.status).toBe('pending')
    expect(momentStatuses()).toEqual(['pending'])
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect((await decide(r.link, adminKey, 'approve')).status).toBe(200)
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'member' })
  })

  it('an admin of a DIFFERENT squad (the agent\'s own home squad) is not enough', async () => {
    const humanKey = await enrolPasskey(env, HUMAN)
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    expect((await decide(r.link, humanKey, 'approve')).status).toBe(403)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(momentStatuses()).toEqual(['pending'])
  })
})

describe('home squads and other closed targets', () => {
  it('a home-squad target is refused at approve (even for an org admin), nothing written, link not burned; it can be denied', async () => {
    const orgKey = await enrolPasskey(env, ORGADM)
    const r = await askOk('agent-rava', { squad: 'squad-home-x' })
    expect(reqRows()[0]).toMatchObject({ status: 'pending', squad_id: 'squad-home-x' })
    const a = await decide(r.link, orgKey, 'approve')
    expect(a.status).toBe(409)
    expect(a.body.message).toContain('home squad')
    expect(member('agent-rava', 'squad-home-x')).toBeUndefined()
    expect(n(`SELECT COUNT(*) AS n FROM capabilities WHERE scope_id = 'squad-home-x' AND member_id = 'mem-agent-rava'`)).toBe(0)
    expect(momentStatuses()).toEqual(['pending'])
    expect((await decide(r.link, orgKey, 'deny')).status).toBe(200)
    expect(reqRows()[0]!.status).toBe('denied')
  })

  it('an unresolved squad ref can only be closed: approve is refused, deny works for any active human', async () => {
    const r = await askOk('agent-rava', { squad: 'no-such-squad' })
    expect(reqRows()[0]).toMatchObject({ squad_id: null, squad_key: 'ref:no-such-squad' })
    const html = await (await hit(new URL(r.link).pathname, env)).text()
    expect(html).toContain('no squad matches')
    expect((await decide(r.link, adminKey, 'approve')).status).toBe(409)
    expect(momentStatuses()).toEqual(['pending'])
    expect((await decide(r.link, plainKey, 'deny')).status).toBe(200)
  })

  it('an agent whose identity is no longer usable is refused BEFORE the link is burned', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'mem-agent-rava'`)
    const res = await decide(r.link, adminKey, 'approve')
    expect(res.status).toBe(409)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(momentStatuses()).toEqual(['pending'])
  })

  it('an archived squad is refused at approve', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    h.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = 'squad-target'`)
    expect((await decide(r.link, adminKey, 'approve')).status).toBe(409)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(momentStatuses()).toEqual(['pending'])
  })
})

describe('no existence oracle', () => {
  it('a real squad, a squad id, a hidden squad and a nonexistent ref give the identical response shape and prompt', async () => {
    seedSquad('squad-secret')
    const refs = ['squad-target', 'squad-secret', 'does-not-exist', 'DOES-NOT-EXIST-2']
    const outs: Asked[] = []
    for (const ref of refs) outs.push(await askOk('agent-rava', { squad: ref }))
    const raw = await ask('agent-rava', { squad: 'squad-target' })
    expect(raw.ok && Object.keys(raw.result as object).sort()).toEqual(['agent_prompt', 'expires_at', 'status'])
    const norm = (o: Asked, ref: string): string => o.agent_prompt.replace(o.expires_at, '<EXP>').split(`"${ref}"`).join('"<REF>"')
    const shapes = new Set(outs.map((o, i) => norm(o, refs[i]!)))
    expect(shapes.size).toBe(1)
    // the expiry window is the same TTL for all
    const ttl = outs.map((o) => Date.parse(o.expires_at) - Date.now())
    for (const t of ttl) expect(Math.abs(t - ttl[0]!)).toBeLessThan(60_000)
    // the tool-level refusals do not depend on the squad either
    const bad = await ask('agent-rava', { squad: 'does-not-exist', capability: 'lead' })
    const bad2 = await ask('agent-rava', { squad: 'squad-target', capability: 'lead' })
    expect(JSON.stringify(bad)).toBe(JSON.stringify(bad2))
  })
})

describe('dedupe', () => {
  it('a repeat ask for the same squad keeps ONE pending request and ONE pending moment, and rotates the link', async () => {
    const a = await askOk('agent-rava', { squad: 'squad-target' })
    const b = await askOk('agent-rava', { squad: 'squad-target' })
    expect(a.link).not.toBe(b.link)
    expect(reqRows().filter((r) => r.status === 'pending')).toHaveLength(1)
    expect(momentStatuses().filter((s) => s === 'pending')).toHaveLength(1)
    expect((await hit(new URL(a.link).pathname, env)).status).toBe(404) // the old link died
    expect((await hit(new URL(b.link).pathname, env)).status).toBe(200)
  })

  it('the dedupe key is the normalized ref the caller SENT, identical for a real and a nonexistent squad (no oracle)', async () => {
    await askOk('agent-rava', { squad: 'squad-target' })
    await askOk('agent-rava', { squad: '  SQUAD-TARGET ' })
    await askOk('agent-rava', { squad: 'nowhere' })
    await askOk('agent-rava', { squad: 'NOWHERE' })
    const keys = reqRows().filter((r) => r.status === 'pending').map((r) => r.squad_key).sort()
    expect(keys).toEqual(['ref:nowhere', 'ref:squad-target'])
    // the cap counts both kinds the same way: real and nonexistent refs consume the same pending slots
    const id = one<{ id: string }>(`SELECT id FROM squads WHERE slug = 'squad-target'`)!.id
    await askOk('agent-rava', { squad: id })
    expect(reqRows().filter((r) => r.status === 'pending').map((r) => r.squad_key)).toContain(`ref:${id}`)
  })

  it('a CHANGED ask supersedes the old request: the old link can never approve what was asked then', async () => {
    const a = await askOk('agent-rava', { squad: 'squad-target', capability: 'observer' })
    const b = await askOk('agent-rava', { squad: 'squad-target', capability: 'member' })
    expect(reqRows().map((r) => r.status).sort()).toEqual(['pending', 'superseded'])
    expect((await hit(new URL(a.link).pathname, env)).status).not.toBe(200)
    expect((await decide(b.link, adminKey, 'approve')).status).toBe(200)
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'member' })
  })

  it('different agents asking for the same squad do not collide', async () => {
    await askOk('agent-rava', { squad: 'squad-target' })
    await askOk('agent-hadi-admin', { squad: 'squad-target' })
    expect(reqRows().filter((r) => r.status === 'pending')).toHaveLength(2)
  })
})

describe('expiry', () => {
  it('an expired request cannot be approved or denied, writes nothing, and a re-ask files a fresh one', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    h.sqlite.exec(`DROP TRIGGER squad_join_requests_immutable`)
    h.sqlite.exec(`UPDATE squad_join_requests SET expires_at = '2020-01-01T00:00:00.000Z'`)
    const page = await hit(new URL(r.link).pathname, env)
    expect(page.status).toBe(410)
    const res = await hit(`${new URL(r.link).pathname}/decide`, env, { method: 'POST', json: { decision: 'approve', csrf: 'x'.repeat(64), credential: {} } })
    expect(res.status).not.toBe(200)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    const again = await askOk('agent-rava', { squad: 'squad-target' })
    expect(again.link).not.toBe(r.link)
    expect(reqRows().map((x) => x.status)).toEqual(['expired', 'pending'])
  })

  it('an expired MOMENT (request still pending) cannot be decided either', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    h.sqlite.exec(`UPDATE secure_moments SET expires_at = '2020-01-01T00:00:00.000Z' WHERE kind = 'squad_join'`)
    expect((await hit(new URL(r.link).pathname, env)).status).toBe(410)
  })
})

describe('guards on the ask', () => {
  it('the ceiling: a join request can never ask for lead, admin or owner (no row, no link)', async () => {
    for (const capability of ['lead', 'admin', 'owner', 'gate', '', 'MEMBER']) {
      const r = await ask('agent-rava', { squad: 'squad-target', capability })
      expect(errOf(r), capability).toBe('invalid_args')
    }
    expect(reqRows()).toHaveLength(0)
    expect(momentStatuses()).toHaveLength(0)
    // and the table itself refuses a forged elevated row
    expect(() => h.sqlite.exec(`INSERT INTO squad_join_requests (id, tenant, agent_id, squad_ref, squad_key, capability, requested_via, status, created_at, expires_at)
      VALUES ('x', '${TENANT}', 'agent-rava', 's', 's', 'lead', 'agent', 'pending', '2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z')`)).toThrow()
  })

  it('never lowers access the agent already has: an agent that is already lead is left a lead', async () => {
    h.sqlite.exec(`INSERT INTO memberships (agent_id, squad_id, capability) VALUES ('agent-rava', 'squad-target', 'lead')`)
    h.sqlite.exec(`UPDATE capabilities SET capability = 'lead' WHERE id = 'cap-agent-rava'`)
    // `already` needs BOTH planes now (a live capability row as well as the membership).
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-rava-target', 'mem-agent-rava', 'squad', 'squad-target', 'lead')`)
    const r = await askOk('agent-rava', { squad: 'squad-target', capability: 'member' })
    const res = await decide(r.link, adminKey, 'approve')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.message).toContain('nothing was changed')
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'lead' })
    expect(n(`SELECT COUNT(*) AS n FROM membership_receipts WHERE squad_id = 'squad-target'`)).toBe(0)
    expect(reqRows()[0]).toMatchObject({ status: 'approved', result: 'unchanged' })
  })

  it('a LAPSED capability does not make the approval a no-op: the membership alone is not "already"', async () => {
    h.sqlite.exec(`INSERT INTO memberships (agent_id, squad_id, capability, expires_at) VALUES ('agent-rava', 'squad-target', 'member', '2020-01-01 00:00:00')`)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at) VALUES ('cap-rava-target', 'mem-agent-rava', 'squad', 'squad-target', 'member', '2020-01-01 00:00:00')`)
    const r = await askOk('agent-rava', { squad: 'squad-target', capability: 'member' })
    expect((await decide(r.link, adminKey, 'approve')).status).toBe(200)
    expect(reqRows()[0]).toMatchObject({ status: 'approved' })
    // the approval REFRESHED the lapsed rows instead of being swallowed by them: permanent again, via squad_join
    expect(one(`SELECT expires_at, granted_via FROM capabilities WHERE id = 'cap-rava-target'`)).toEqual({ expires_at: null, granted_via: 'squad_join' })
    expect(one(`SELECT expires_at FROM memberships WHERE agent_id = 'agent-rava' AND squad_id = 'squad-target'`)).toEqual({ expires_at: null })
  })

  it('an observer can be raised to member by an approved request, never past what was asked', async () => {
    h.sqlite.exec(`INSERT INTO memberships (agent_id, squad_id, capability) VALUES ('agent-rava', 'squad-target', 'observer')`)
    const r = await askOk('agent-rava', { squad: 'squad-target', capability: 'member' })
    expect((await decide(r.link, adminKey, 'approve')).status).toBe(200)
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'member' })
  })

  it('a deactivated agent is refused (no row, no link)', async () => {
    h.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'agent-rava'`)
    const r = await ask('agent-rava', { squad: 'squad-target' })
    expect(errOf(r)).toBe('agent_inactive')
    expect(reqRows()).toHaveLength(0)
    expect(momentStatuses()).toHaveLength(0)
  })

  it('an agent deactivated AFTER asking cannot be added: refused before the link is burned', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    h.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'agent-rava'`)
    const res = await decide(r.link, adminKey, 'approve')
    expect(res.status).toBe(409)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(momentStatuses()).toEqual(['pending'])
  })

  it('a caller with no agent behind it is refused', async () => {
    const human: AuthContext = { userId: ADMIN, email: '', role: 'member', tenant: TENANT, channel: 'directory', memberId: ADMIN, capabilities: [] }
    expect(errOf(await ask('', { squad: 'squad-target' }, env, human))).toBe('agent_required')
    expect(reqRows()).toHaveLength(0)
  })

  it('naming ANOTHER agent is refused (own_agent_only), naming yourself is fine, nothing leaks about the other', async () => {
    const other = await ask('agent-rava', { squad: 'squad-target', agent: 'hadi-admin' })
    const ghost = await ask('agent-rava', { squad: 'squad-target', agent: 'no-such-agent' })
    expect(errOf(other)).toBe('own_agent_only')
    expect(JSON.stringify(other)).toBe(JSON.stringify(ghost))
    expect(reqRows()).toHaveLength(0)
    expect((await ask('agent-rava', { squad: 'squad-target', agent: 'rava' })).ok).toBe(true)
    expect(reqRows()).toHaveLength(1)
  })

  it('rate limit: one agent gets SQUAD_JOIN_MAX_PER_HOUR calls an hour, another agent is unaffected', async () => {
    for (let i = 0; i < SQUAD_JOIN_MAX_PER_HOUR; i++) expect((await ask('agent-rava', { squad: 'squad-target' })).ok, `call ${i}`).toBe(true)
    const over = await ask('agent-rava', { squad: 'squad-target' })
    expect(errOf(over)).toBe('rate_limited')
    expect(errOf(await ask('agent-rava', { squad: 'nowhere' }))).toBe('rate_limited') // not squad dependent
    expect((await ask('agent-hadi-admin', { squad: 'squad-target' })).ok).toBe(true)
  })

  it('pending cap: an agent cannot bury the humans under requests for many squads', async () => {
    for (let i = 0; i < SQUAD_JOIN_MAX_PENDING_PER_AGENT; i++) expect((await ask('agent-rava', { squad: `squad-x${i}` })).ok).toBe(true)
    expect(errOf(await ask('agent-rava', { squad: 'squad-one-too-many' }))).toBe('too_many_pending_requests')
    expect(reqRows().filter((r) => r.status === 'pending')).toHaveLength(SQUAD_JOIN_MAX_PENDING_PER_AGENT)
  })

  it('oversized or non-string fields are refused', async () => {
    expect(errOf(await ask('agent-rava', { squad: 'x'.repeat(129) }))).toBe('invalid_args')
    expect(errOf(await ask('agent-rava', { squad: 'squad-target', reason: 'r'.repeat(501) }))).toBe('invalid_args')
    expect(errOf(await ask('agent-rava', { squad: 'squad-target', reason: 5 }))).toBe('invalid_args')
    expect(reqRows()).toHaveLength(0)
  })

  it('SECURE_MOMENTS off: not advertised, a direct call refuses, nothing is written', async () => {
    const off = envFor(h, { SECURE_MOMENTS: undefined })
    expect(advertisedTools(off).some((t) => t.name === 'squad_join_request')).toBe(false)
    expect(advertisedTools(env).some((t) => t.name === 'squad_join_request')).toBe(true)
    const r = await ask('agent-rava', { squad: 'squad-target' }, off)
    expect(errOf(r)).toBe('secure_moments_unavailable')
    expect(reqRows()).toHaveLength(0)
  })
})

// ── attached chats go through the real OAuth -> seat -> attach path ──────────────────────────────
interface Grant { memberId: string; tokenId: string; harnessId: string; ctx: AuthContext }
async function grant(e: Env, memberId: string): Promise<Grant> {
  const harness = await upsertHarness(e, memberId, 'client-chatgpt', 'ChatGPT')
  if (!harness) throw new Error('harness fixture failed')
  const tokenId = `tok-${memberId}-${++tokCounter}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:client-chatgpt', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(e, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  return { memberId, tokenId, harnessId: harness.id, ctx }
}
interface Rpc { status: number; body: Record<string, unknown>; sc: Record<string, unknown> }
async function rpc(e: Env, ctx: AuthContext, name: string, args: Record<string, unknown>, session: string): Promise<Rpc> {
  const req = new Request('https://pot.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'openai/session': session } } }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), e)
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {} }
}

describe('an attached chat asks on behalf of its attached agent, and only that agent', () => {
  it('an UNATTACHED seat is refused (attach_first); an attached chat files the request for its agent; naming another agent is refused', async () => {
    const humanKey = await enrolPasskey(env, HUMAN)
    const g = await grant(env, HUMAN)
    await rpc(env, g.ctx, 'boot_context', {}, 'conv-a')
    const unattached = await rpc(env, g.ctx, 'squad_join_request', { squad: 'squad-target' }, 'conv-a')
    expect(JSON.stringify(unattached.body)).toContain('attach_first')
    expect(reqRows()).toHaveLength(0)

    const pend = await rpc(env, g.ctx, 'seat_attach', { agent: 'rava' }, 'conv-a')
    expect(pend.sc.status).toBe('pending_admission')
    expect((await decide(String(pend.sc.approve_url), humanKey, 'approve')).status).toBe(200)
    expect((await rpc(env, g.ctx, 'seat_attach', { agent: 'rava' }, 'conv-a')).sc.status).toBe('attached')

    const other = await rpc(env, g.ctx, 'squad_join_request', { squad: 'squad-target', agent: 'hadi-admin' }, 'conv-a')
    expect(JSON.stringify(other.body)).toContain('own_agent_only')
    expect(reqRows()).toHaveLength(0)

    const ok = await rpc(env, g.ctx, 'squad_join_request', { squad: 'squad-target' }, 'conv-a')
    expect(ok.sc.status, JSON.stringify(ok.body)).toBe('sent_to_admins')
    expect(JSON.stringify(ok.body)).not.toContain('/m/') // no link reaches the chat
    const m = one<{ id: string }>(`SELECT id FROM secure_moments WHERE kind = 'squad_join' AND status = 'pending'`)!
    const issued = (await reissueMomentLink(env, m.id))!.url
    expect(reqRows()).toMatchObject([{ status: 'pending', requested_via: 'attached_chat', squad_id: 'squad-target' }])
    expect(one<{ agent_id: string }>(`SELECT agent_id FROM squad_join_requests`)?.agent_id).toBe('agent-rava')
    // the attached chat's own human (an admin of squad-core only) cannot approve it; the target's admin can
    expect((await decide(issued, humanKey, 'approve')).status).toBe(403)
    expect((await decide(issued, adminKey, 'approve')).status).toBe(200)
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'member' })
  })
})

describe('who may approve: ONE derivation', () => {
  it('whoMayApprove = active humans who are admin on the TARGET (squad admin + org admin), nobody for a closed target', async () => {
    await askOk('agent-rava', { squad: 'squad-target' })
    await askOk('agent-rava', { squad: 'squad-home-x' })
    await askOk('agent-rava', { squad: 'nowhere' })
    const rows = h.sqlite.prepare(`SELECT id, squad_id FROM squad_join_requests ORDER BY squad_ref`).all() as Array<{ id: string; squad_id: string | null }>
    const by = async (sq: string | null): Promise<string[]> => whoMayApprove(env, rows.find((r) => r.squad_id === sq)!)
    expect((await by('squad-target')).sort()).toEqual([ADMIN, ORGADM].sort())
    expect(await by('squad-home-x')).toEqual([])
    expect(await by(null)).toEqual([])
    // a suspended admin and an agent's own welded member are never approvers
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${ORGADM}'`)
    cap('mem-agent-hadi-admin', 'squad', 'squad-target', 'admin')
    expect(await by('squad-target')).toEqual([ADMIN])
  })

  it('LAPSED admins cannot starve the approver scan: 200 lapsed candidates sorted first do not hide the live approver', async () => {
    await askOk('agent-rava', { squad: 'squad-target' })
    const row = one<{ id: string; squad_id: string }>(`SELECT id, squad_id FROM squad_join_requests`)!
    for (let i = 0; i < 205; i += 1) {
      const id = `aaa-lapsed-${String(i).padStart(3, '0')}`
      h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', '${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at) VALUES ('cap-${id}', '${id}', 'squad', 'squad-target', 'admin', '2020-01-01 00:00:00')`)
    }
    expect(await whoMayApprove(env, row)).toContain(ADMIN)
  })

  it('an approver whose admin grant EXPIRES: live => still an approver (kills a misbound now), lapsed => not (migration 0230)', async () => {
    await askOk('agent-rava', { squad: 'squad-target' })
    const row = one<{ id: string; squad_id: string }>(`SELECT id, squad_id FROM squad_join_requests`)!
    h.sqlite.exec(`UPDATE capabilities SET expires_at = '2099-01-01 00:00:00' WHERE member_id = '${ADMIN}' AND scope_id = 'squad-target'`)
    expect(await whoMayApprove(env, row)).toContain(ADMIN)
    expect(await memberMayApprove(env, row, ADMIN)).toBe(true)
    h.sqlite.exec(`UPDATE capabilities SET expires_at = '2020-01-01 00:00:00' WHERE member_id = '${ADMIN}' AND scope_id = 'squad-target'`)
    expect(await whoMayApprove(env, row)).not.toContain(ADMIN)
    expect(await memberMayApprove(env, row, ADMIN)).toBe(false)
  })

  it('a home squad has NO approvers even for a member holding an exact squad-scope admin grant on it (G-FP1b)', async () => {
    cap(ADMIN, 'squad', 'squad-home-x', 'admin')
    await askOk('agent-rava', { squad: 'squad-home-x' })
    const row = one<{ id: string; squad_id: string }>(`SELECT id, squad_id FROM squad_join_requests`)!
    expect(await whoMayApprove(env, row)).toEqual([])
  })

  it('the approval check uses it: a member dropped from the set cannot approve a link they already hold', async () => {
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${ADMIN}'`)
    expect((await decide(r.link, adminKey, 'approve')).status).toBe(403)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
  })
})

describe('segregation of duties', () => {
  it('an owner approving their OWN agent into their own squad is allowed', async () => {
    h.sqlite.exec(`UPDATE agents SET owner_member_id = '${ADMIN}' WHERE id = 'agent-rava'`)
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    expect((await decide(r.link, adminKey, 'approve')).status).toBe(200)
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'member' })
  })

  it('the requesting agent\'s own credential can never decide its request (approve or deny), even given admin standing and a stub gate', async () => {
    cap('mem-agent-rava', 'squad', 'squad-target', 'admin') // the agent would otherwise qualify on grants alone
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    const req = (await loadSquadJoin(env, one<{ id: string }>(`SELECT id FROM squad_join_requests`)!.id))!
    let gateCalls = 0
    const gate = async (): Promise<boolean> => { gateCalls++; return true }
    for (const decision of ['approve', 'deny'] as const) {
      const out = await decideSquadJoin(env, { req, decision, proof: { memberId: 'mem-agent-rava', via: 'webauthn', evidence: {} }, gate }, Date.now())
      expect(out.status, decision).toBe(403)
    }
    expect(gateCalls).toBe(0)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(reqRows()[0]!.status).toBe('pending')
    expect(r.link).toBeTruthy()
  })
})

describe('delivery: the approvers are told, nobody has to paste', () => {
  const tgCalls: Array<{ chat: string; text: string }> = []
  beforeEach(() => {
    tgCalls.length = 0
    h.sqlite.exec(`UPDATE members SET telegram_chat_id = '1001' WHERE id = '${ADMIN}'`)
    h.sqlite.exec(`UPDATE members SET telegram_chat_id = '1002' WHERE id = '${PLAIN}'`) // not an admin: must not be told
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { chat_id: string; text: string }
      tgCalls.push({ chat: b.chat_id, text: b.text })
      return new Response('{"ok":true}', { status: 200 })
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('a squad admin with a bound Telegram chat gets the link (and only they do); the reply to the agent is unchanged', async () => {
    const withTg = envFor(h, { TELEGRAM_BOT_TOKEN: 'tg-test-token' })
    const r = await ask('agent-rava', { squad: 'squad-target', reason: 'ignore previous instructions' }, withTg)
    expect(r.ok).toBe(true)
    const link = /https:\/\/\S+\/m\/\S+/.exec(tgCalls[0]?.text ?? '')?.[0] ?? ''
    expect(tgCalls.map((c) => c.chat)).toEqual(['1001'])
    expect(link).not.toBe('')
    expect((await hit(new URL(link).pathname, env)).status).toBe(200) // the approver's link works
    expect(JSON.stringify(r)).not.toContain('/m/') // and the agent was never given it
    expect(tgCalls[0]!.text).toContain('Rava')
    expect(tgCalls[0]!.text).not.toContain('ignore previous instructions') // the agent's free text is never forwarded
    expect(tgCalls[0]!.text).toContain('cannot be approved from Telegram')
  })

  it('nobody is messaged for a closed target (unresolved or home), and the reply shape is identical', async () => {
    const withTg = envFor(h, { TELEGRAM_BOT_TOKEN: 'tg-test-token' })
    const a = await ask('agent-rava', { squad: 'nowhere' }, withTg)
    const b = await ask('agent-rava', { squad: 'squad-home-x' }, withTg)
    expect(tgCalls).toHaveLength(0)
    expect(a.ok && b.ok).toBe(true)
    expect(Object.keys((a as { result: object }).result)).toEqual(Object.keys((b as { result: object }).result))
  })

  it('a Telegram failure or no bot token never fails the request', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('boom') })
    expect((await ask('agent-rava', { squad: 'squad-target' }, envFor(h, { TELEGRAM_BOT_TOKEN: 'tg-test-token' }))).ok).toBe(true)
    expect((await ask('agent-hadi-admin', { squad: 'squad-target' })).ok).toBe(true) // no token at all
  })
})

// ── check-then-write: the claim closes the window between the checks and the grant ─────────────────
describe('the claim: nothing is granted unless the request is still pending, unexpired and open at the write', () => {
  const proofOf = (memberId: string) => ({ memberId, via: 'webauthn' as const, evidence: {} })
  async function approveWith(onGate: () => void | Promise<void>, agent = 'agent-rava', squad = 'squad-target'): Promise<{ status: number; message: string }> {
    await askOk(agent, { squad })
    const req = (await loadSquadJoin(env, one<{ id: string }>(`SELECT id FROM squad_join_requests ORDER BY created_at DESC LIMIT 1`)!.id))!
    const gate = async (): Promise<boolean> => { await onGate(); return true }
    const out = await decideSquadJoin(env, { req, decision: 'approve', proof: proofOf(ADMIN), gate }, Date.now())
    return { status: out.status, message: out.message }
  }
  const approveAudits = (): number => n(`SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'squad_join_approve'`)

  it('F1: superseded between the checks and the grant -> no membership, no approve audit, request stays superseded', async () => {
    const out = await approveWith(() => { h.sqlite.exec(`UPDATE squad_join_requests SET status = 'superseded'`) })
    expect(out.status).toBe(409)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(n(`SELECT COUNT(*) AS n FROM membership_receipts WHERE squad_id = 'squad-target'`)).toBe(0)
    expect(approveAudits()).toBe(0)
    expect(reqRows()[0]!.status).toBe('superseded')
  })

  it('F4: expired between the checks and the grant -> no membership', async () => {
    const out = await approveWith(() => { h.sqlite.exec(`DROP TRIGGER squad_join_requests_immutable`); h.sqlite.exec(`UPDATE squad_join_requests SET expires_at = '2020-01-01T00:00:00.000Z'`) })
    expect(out.status).toBe(409)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(approveAudits()).toBe(0)
  })

  it('F2: archived between the checks and the grant -> no membership (addSquadMember does not refuse archived itself)', async () => {
    const out = await approveWith(() => { h.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = 'squad-target'`) })
    expect(out.status).toBe(409)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(approveAudits()).toBe(0)
  })

  it('F3: promoted to lead between the checks and the grant -> stays lead (the rank predicate is in the write), reported unchanged', async () => {
    const out = await approveWith(() => {
      h.sqlite.exec(`INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-lead', 'agent-rava', 'squad-target', 'lead')`)
      cap('mem-agent-rava', 'squad', 'squad-target', 'lead')
    })
    expect(out.status, out.message).toBe(200)
    expect(member('agent-rava', 'squad-target')).toEqual({ capability: 'lead' })
    expect(one<{ capability: string }>(`SELECT capability FROM capabilities WHERE member_id = 'mem-agent-rava' AND scope_type = 'squad' AND scope_id = 'squad-target'`)).toEqual({ capability: 'lead' })
    expect(reqRows()[0]).toMatchObject({ status: 'approved', result: 'unchanged' })
  })

  it('a grant that fails after the claim closes the request as failed, with a failure audit and a notice', async () => {
    const out = await approveWith(() => { h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'mem-agent-rava'`) })
    expect(out.status).toBe(409)
    expect(member('agent-rava', 'squad-target')).toBeUndefined()
    expect(reqRows()[0]!.status).toBe('failed')
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'squad_join_failed'`)).toBe(1)
  })

  it('a deny that races the expiry changes nothing (the deny UPDATE carries the expiry guard)', async () => {
    await askOk('agent-rava', { squad: 'squad-target' })
    const req = (await loadSquadJoin(env, one<{ id: string }>(`SELECT id FROM squad_join_requests`)!.id))!
    const gate = async (): Promise<boolean> => { h.sqlite.exec(`DROP TRIGGER squad_join_requests_immutable`); h.sqlite.exec(`UPDATE squad_join_requests SET expires_at = '2020-01-01T00:00:00.000Z'`); return true }
    const out = await decideSquadJoin(env, { req, decision: 'deny', proof: proofOf(ADMIN), gate }, Date.now())
    expect(out.status).toBe(409)
    expect(reqRows()[0]!.status).toBe('pending')
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'squad_join_deny'`)).toBe(0)
  })

  it('the table forbids reopening or skipping the claim: approving only goes to approved|failed, closed rows never move', async () => {
    await askOk('agent-rava', { squad: 'squad-target' })
    h.sqlite.exec(`UPDATE squad_join_requests SET status = 'approving'`)
    expect(() => h.sqlite.exec(`UPDATE squad_join_requests SET status = 'pending'`)).toThrow()
    expect(() => h.sqlite.exec(`UPDATE squad_join_requests SET status = 'denied'`)).toThrow()
    h.sqlite.exec(`UPDATE squad_join_requests SET status = 'approved'`)
    expect(() => h.sqlite.exec(`UPDATE squad_join_requests SET status = 'approving'`)).toThrow()
  })

  it('P2-4: the requesting agent credential is refused on the DENY path of an unresolved or home request (no other guard reaches it)', async () => {
    for (const ref of ['nowhere', 'squad-home-x']) {
      await askOk('agent-rava', { squad: ref })
      const req = (await loadSquadJoin(env, one<{ id: string }>(`SELECT id FROM squad_join_requests WHERE squad_ref = ?`, ref)!.id))!
      let gateCalls = 0
      const out = await decideSquadJoin(env, { req, decision: 'deny', proof: proofOf('mem-agent-rava'), gate: async () => { gateCalls++; return true } }, Date.now())
      expect(out.status, ref).toBe(403)
      expect(gateCalls).toBe(0)
    }
    expect(reqRows().every((r) => r.status === 'pending')).toBe(true)
  })

  it('the approval check is uncapped: an approver past the 200-candidate notice scan can still approve', async () => {
    for (let i = 0; i < 205; i++) {
      const id = `a-${String(i).padStart(3, '0')}`
      seedHuman(id)
      cap(id, 'org', null, 'admin')
    }
    const r = await askOk('agent-rava', { squad: 'squad-target' })
    const row = one<{ id: string; squad_id: string }>(`SELECT id, squad_id FROM squad_join_requests`)!
    expect(await whoMayApprove(env, row)).not.toContain(ADMIN) // beyond the notice scan
    expect(await memberMayApprove(env, row, ADMIN)).toBe(true)
    expect((await decide(r.link, adminKey, 'approve')).status).toBe(200)
  })
})

describe('notices are off the response path', () => {
  it('with a hosting waitUntil the tool returns while the Telegram send is still blocked; releasing it delivers', async () => {
    h.sqlite.exec(`UPDATE members SET telegram_chat_id = '1001' WHERE id = '${ADMIN}'`)
    const calls: string[] = []
    let release: () => void = () => undefined
    const blocked = new Promise<void>((res) => { release = res })
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => { await blocked; calls.push((JSON.parse(String(init.body)) as { chat_id: string }).chat_id); return new Response('{"ok":true}') })
    const pending: Promise<unknown>[] = []
    const t0 = Date.now()
    const r = await invokeTool(agentCtx('agent-rava'), envFor(h, { TELEGRAM_BOT_TOKEN: 't' }), 'squad_join_request', { squad: 'squad-target' }, { origin: 'https://pot.test', waitUntil: (p: Promise<unknown>) => { pending.push(p) } })
    expect(r.ok).toBe(true) // returned although the send has not completed
    expect(Date.now() - t0).toBeLessThan(2500) // inline, the blocked send would hold the reply for the 4s notice timeout
    expect(calls).toEqual([])
    release()
    await Promise.all(pending)
    expect(calls).toEqual(['1001'])
    vi.unstubAllGlobals()
  })
})

describe('round 1 gaps', () => {
  it('P1: the asking agent never sees the link, nor any squad detail, whatever the ref is', async () => {
    for (const ref of ['squad-target', 'squad-home-x', 'nowhere']) {
      const r = await ask('agent-rava', { squad: ref })
      expect(r.ok).toBe(true)
      const text = JSON.stringify(r)
      expect(text).not.toContain('/m/')
      expect(text).not.toContain('http')
      expect(text).not.toContain('Squad squad-target') // the real name of the squad is only on the approver page
    }
  })

  it('M26: a changed REASON alone supersedes the old request', async () => {
    await askOk('agent-rava', { squad: 'squad-target', reason: 'first reason' })
    await askOk('agent-rava', { squad: 'squad-target', reason: 'second reason' })
    expect(reqRows().map((r) => r.status).sort()).toEqual(['pending', 'superseded'])
  })

  it('M29: when no link can be minted the ask fails closed (no success reply, nobody told)', async () => {
    h.sqlite.exec('DROP TABLE secure_moments')
    const r = await ask('agent-rava', { squad: 'squad-target' })
    expect(errOf(r)).toBe('secure_moments_unavailable')
  })

  it('M30: only private chats get a link: a group id, a negative id and junk are never messaged', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => { calls.push((JSON.parse(String(init.body)) as { chat_id: string }).chat_id); return new Response('{"ok":true}') })
    const withTg = envFor(h, { TELEGRAM_BOT_TOKEN: 't' })
    for (const chat of ['-1001234567890', 'abc', '0', '12 34']) {
      h.sqlite.exec(`UPDATE members SET telegram_chat_id = '${chat}' WHERE id = '${ADMIN}'`)
      await invokeTool(agentCtx('agent-rava'), withTg, 'squad_join_request', { squad: 'squad-target', reason: chat }, 'https://pot.test')
    }
    expect(calls).toEqual([])
    h.sqlite.exec(`UPDATE members SET telegram_chat_id = '4242' WHERE id = '${ADMIN}'`)
    await invokeTool(agentCtx('agent-rava'), withTg, 'squad_join_request', { squad: 'squad-target', reason: 'ok' }, 'https://pot.test')
    expect(calls).toEqual(['4242'])
    vi.unstubAllGlobals()
  })

  it('M17: an archived squad has no approvers', async () => {
    await askOk('agent-rava', { squad: 'squad-target' })
    const row = one<{ id: string; squad_id: string }>(`SELECT id, squad_id FROM squad_join_requests`)!
    expect((await whoMayApprove(env, row)).length).toBeGreaterThan(0)
    h.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = 'squad-target'`)
    expect(await whoMayApprove(env, row)).toEqual([])
    expect(await memberMayApprove(env, row, ADMIN)).toBe(false)
  })

  it('P2: channel-derived squad admin grants count as approvers, as resolveCapabilities counts them', async () => {
    seedHuman('member-chan')
    h.sqlite.exec('PRAGMA foreign_keys = OFF')
    h.sqlite.exec(`INSERT INTO channel_capability_grants (id, binding_id, member_id, squad_id, capability) VALUES ('ccg1', 'b1', 'member-chan', 'squad-target', 'admin')`)
    await askOk('agent-rava', { squad: 'squad-target' })
    const row = one<{ id: string; squad_id: string }>(`SELECT id, squad_id FROM squad_join_requests`)!
    expect(await whoMayApprove(env, row)).toContain('member-chan')
    expect(await memberMayApprove(env, row, 'member-chan')).toBe(true)
  })

  it('M33: every close writes its audit row (approve, deny, failed), anchored on the closed request', async () => {
    const a = await askOk('agent-rava', { squad: 'squad-target' })
    expect((await decide(a.link, adminKey, 'approve')).status).toBe(200)
    const b = await askOk('agent-hadi-admin', { squad: 'squad-target' })
    expect((await decide(b.link, adminKey, 'deny')).status).toBe(200)
    const rows = h.sqlite.prepare(`SELECT action, agent_id, actor_id FROM agent_audit WHERE action LIKE 'squad_join_%' ORDER BY seq`).all()
    expect(rows).toEqual([
      { action: 'squad_join_approve', agent_id: 'agent-rava', actor_id: ADMIN },
      { action: 'squad_join_deny', agent_id: 'agent-hadi-admin', actor_id: ADMIN },
    ])
  })
})
