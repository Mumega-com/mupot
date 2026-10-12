// tests/secure-drop.test.ts - secure drops W2 (src/secure-drop/*, src/mcp/secure-drop.ts, the credential branch of
// src/secure-moments/routes.ts, migration 0213): host keys, credential_request, browser sealing, passkey-decided
// provide, pull/ack/revoke, and the defect classes the gate hunts (plaintext at the server, cross-agent pull, pull
// after rotation, replay, ciphertext swapped after the assertion, name traversal, flag-off no-op, script pinning).
// Real migrated schema (sqlite-d1 harness); the browser bundle runs for real in a vm; the host opens with the real
// fleet-runtime/secure-drop.mjs. Contract: docs/architecture/secure-moments.md ("W2: secure drops").
import { createHash, generateKeyPairSync, webcrypto, type KeyObject } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool, advertisedTools } from '../src/mcp/index' // first: the mcp/seeds modules form an import cycle that only resolves from mcp/index
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { SoftAuthenticator } from './helpers/webauthn-authenticator'
import { momentsApp } from '../src/secure-moments/routes'
import { mintEnrolmentToken } from '../src/secure-moments/store'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { secureDropStatus } from '../src/secure-drop/config'
import { DROP_NAME_RE, groupFingerprint, hpkeInfo, parseHostPublicKey } from '../src/secure-drop/keys'
import { decideDrop, loadDrop, sealedDigest } from '../src/secure-drop/store'
import { keyAssurance } from '../src/secure-drop/keys'
import { HPKE_BUNDLE_JS, HPKE_BUNDLE_SHA256, HPKE_BUNDLE_SRI } from '../src/secure-drop/hpke-bundle.generated'
// @ts-expect-error the host script is plain ESM JavaScript with no declaration file
import * as hostScript from '../fleet-runtime/secure-drop.mjs'

const TENANT = 'tenant-a'
const HOST = 'secure.example.test'
const ORIGIN = `https://${HOST}`
const COLONY = 'colony.example.test'
const MASTER = 'a1'.repeat(32)
const ROOT = join(__dirname, '..')
const SECRET = 'sk_live_TOP-SECRET-7f3a9c1e-do-not-leak'

let harness: SqliteD1Harness
let env: Env

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER, PUBLIC_ORIGIN: `https://${COLONY}`,
    SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST, SECURE_DROP: '1',
    ...over,
  } as Env
}
const count = (t: string, where = '1=1'): number => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`).get() as { n: number }).n
const one = <T>(sql: string, ...p: unknown[]): T | undefined => harness.sqlite.prepare(sql).get(...p) as T | undefined
const all = <T>(sql: string, ...p: unknown[]): T[] => harness.sqlite.prepare(sql).all(...p) as T[]

async function link(sub: string, memberId: string, email: string): Promise<string> {
  const r = await linkLoginIdentity(env, { tenant: TENANT, provider: 'google', providerSubject: sub, verifiedEmail: email, memberId })
  if (!r.ok) throw new Error(`link failed ${JSON.stringify(r)}`)
  return r.identity.id
}
const identities: Record<string, string> = {}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}');
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A'), ('squad-b', 'dept', 'b', 'B');
    INSERT INTO users (id, email, role) VALUES ('u-owner', 'owner@x.test', 'owner');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('mem-owner', 'owner@x.test', 'Owner', 'active', '${TENANT}'),
      ('mem-plain', 'plain@x.test', 'Plain', 'active', '${TENANT}'),
      ('mem-sqadmin', 'sqadmin@x.test', 'Squad Admin A', 'active', '${TENANT}'),
      ('mem-sqadmin-b', 'sqadminb@x.test', 'Squad Admin B', 'active', '${TENANT}'),
      ('mem-agent', 'agent@x.test', 'Agent Member', 'active', '${TENANT}'),
      ('mem-agent2', 'agent2@x.test', 'Agent Member 2', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-x', 'squad-a', 'agent-x', 'Agent X', 'r', 'm', 'active'),
      ('agent-y', 'squad-a', 'agent-y', 'Agent Y', 'r', 'm', 'active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', 'agent-x', 'mem-agent', datetime('now')), ('${TENANT}', 'agent-y', 'mem-agent2', datetime('now'));
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at) VALUES
      ('tok-1', 'mem-agent', 'hash-1', 'primary', 'workspace', '${TENANT}', 'agent-x', datetime('now')),
      ('tok-2', 'mem-agent2', 'hash-2', 'primary', 'workspace', '${TENANT}', 'agent-y', datetime('now'));
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-p', 'mem-plain', 'squad', 'squad-a', 'member'),
      ('cap-sa', 'mem-sqadmin', 'squad', 'squad-a', 'admin'),
      ('cap-sb', 'mem-sqadmin-b', 'squad', 'squad-b', 'admin');
  `)
  env = baseEnv()
  identities.owner = await link('g-owner', 'mem-owner', 'owner@x.test')
  identities.plain = await link('g-plain', 'mem-plain', 'plain@x.test')
  identities.sqadmin = await link('g-sqadmin', 'mem-sqadmin', 'sqadmin@x.test')
  identities.sqadminB = await link('g-sqadmin-b', 'mem-sqadmin-b', 'sqadminb@x.test')
})
afterEach(() => { harness.close(); vi.unstubAllGlobals() })

// ── principals ───────────────────────────────────────────────────────────────────────────────────
const agentAuth = (which: 'x' | 'y' = 'x'): AuthContext => ({
  userId: which === 'x' ? 'mem-agent' : 'mem-agent2', email: 'agent@x.test', role: 'member', tenant: TENANT, channel: 'workspace',
  memberId: which === 'x' ? 'mem-agent' : 'mem-agent2', tokenId: which === 'x' ? 'tok-1' : 'tok-2',
  capabilities: [{ member_id: which === 'x' ? 'mem-agent' : 'mem-agent2', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant],
  boundAgentId: which === 'x' ? 'agent-x' : 'agent-y',
})
const ownerAuth = (): AuthContext => ({ userId: 'u-owner', email: 'owner@x.test', role: 'owner', tenant: TENANT, channel: 'dashboard', memberId: 'mem-owner' })
const sqadminAuth = (id = 'mem-sqadmin', squad = 'squad-a'): AuthContext => ({
  userId: id, email: `${id}@x.test`, role: 'member', tenant: TENANT, channel: 'dashboard', memberId: id,
  capabilities: [{ member_id: id, scope_type: 'squad', scope_id: squad, capability: 'admin' } as CapabilityGrant],
})
const plainAuth = (): AuthContext => ({
  userId: 'mem-plain', email: 'plain@x.test', role: 'member', tenant: TENANT, channel: 'dashboard', memberId: 'mem-plain',
  capabilities: [{ member_id: 'mem-plain', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant],
})
async function tool(auth: AuthContext, name: string, args: Record<string, unknown>, e: Env = env): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; status?: number }> {
  const r = await invokeTool(auth, e, name, args, 'https://pot.test')
  return r.ok ? { ok: true, result: r.result as Record<string, unknown> } : { ok: false, error: r.error, status: r.status }
}

// ── a host key + the REAL browser bundle ────────────────────────────────────────────────────────
interface HostKey { privateKey: KeyObject; pub: string; fingerprint: string }
function newHostKey(): HostKey {
  const { privateKey } = generateKeyPairSync('x25519')
  const raw = hostScript.rawPublicOf(privateKey) as Buffer
  return { privateKey, pub: Buffer.from(raw).toString('base64url'), fingerprint: hostScript.fingerprintOf(raw) as string }
}

interface Sealer { seal(pub: string, info: string, aad: string, pt: Uint8Array): Promise<{ enc: string; ct: string }>; fingerprint(pub: string): Promise<string> }
function loadBundle(src: string = HPKE_BUNDLE_JS): Sealer {
  const sandbox: Record<string, unknown> = { crypto: webcrypto, TextEncoder, TextDecoder, atob, btoa, Uint8Array, ArrayBuffer }
  const ctx = vm.createContext(sandbox)
  vm.runInContext(`${src}\nglobalThis.__out = MupotHpke`, ctx)
  return sandbox.__out as Sealer
}
const bundle = loadBundle()
/** agent id and name come from the stored request, exactly as the page's data attributes carry them. */
function dropBinding(dropId: string): { agent: string; name: string } {
  const r = one<{ agent_id: string; name: string }>('SELECT agent_id, name FROM secure_drops WHERE id = ?', dropId)
  return { agent: r?.agent_id ?? 'agent-x', name: r?.name ?? 'bound-name' }
}
async function sealFor(key: HostKey, dropId: string, plaintext: string = SECRET, over: { agent?: string; name?: string } = {}): Promise<{ enc: string; ct: string }> {
  const b = dropBinding(dropId)
  return bundle.seal(key.pub, hpkeInfo(over.agent ?? b.agent, dropId, over.name ?? b.name, key.fingerprint), dropId, new TextEncoder().encode(plaintext))
}
const openWith = (key: HostKey, dropId: string, s: { enc: string; ct: string }): string =>
  Buffer.from(hostScript.hpkeOpen({
    privateKey: key.privateKey, enc: Buffer.from(s.enc, 'base64url'), info: Buffer.from(hpkeInfo(dropBinding(dropId).agent, dropId, dropBinding(dropId).name, key.fingerprint)),
    aad: Buffer.from(dropId), ct: Buffer.from(s.ct, 'base64url'),
  })).toString('utf8')

// ── the secure page ──────────────────────────────────────────────────────────────────────────────
interface Req { method?: string; json?: unknown; origin?: string | null; host?: string; headers?: Record<string, string> }
async function hit(path: string, r: Req = {}, e: Env = env): Promise<Response> {
  const headers = new Headers(r.headers)
  const method = r.method ?? 'GET'
  let body: string | undefined
  if (method === 'POST') {
    const origin = r.origin === undefined ? ORIGIN : r.origin
    if (origin) headers.set('origin', origin)
    headers.set('content-type', 'application/json')
    body = JSON.stringify(r.json ?? {})
  }
  return momentsApp.fetch(new Request(`https://${r.host ?? HOST}${path}`, { method, headers, body }), e)
}
const csrfOf = (html: string): string => {
  const m = /data-csrf="([0-9a-f]{64})"/.exec(html)
  if (!m) throw new Error('no csrf in page')
  return m[1]
}
type J = { ok?: boolean; title?: string; message?: string; publicKey?: { challenge: string } }
const jbody = async (r: Response): Promise<J> => (await r.json()) as J

async function enrol(memberId: string, identityId: string | null): Promise<SoftAuthenticator> {
  const a = await SoftAuthenticator.create()
  const { token } = await mintEnrolmentToken(env, memberId, identityId)
  const csrf = csrfOf(await (await hit(`/m/enrol/${token}`)).text())
  const opts = await jbody(await hit(`/m/enrol/${token}/options`, { method: 'POST', json: { csrf } }))
  const credential = await a.register({ rpId: HOST, origin: ORIGIN, challenge: opts.publicKey?.challenge ?? '' })
  expect((await hit(`/m/enrol/${token}/finish`, { method: 'POST', json: { csrf, credential } })).status).toBe(200)
  return a
}

/** Register the host key for agent X through the real tool and file a request through the real tool. */
async function registerKey(key: HostKey, which: 'x' | 'y' = 'x'): Promise<void> {
  const r = await tool(agentAuth(which), 'host_key_register', { public_key: key.pub })
  if (!r.ok) throw new Error(`register failed ${JSON.stringify(r)}`)
}
interface Request { dropId: string; momentId: string; token: string; path: string; url: string; fingerprint: string }
async function request(name = 'github-token', which: 'x' | 'y' = 'x', extra: Record<string, unknown> = {}): Promise<Request> {
  const r = await tool(agentAuth(which), 'credential_request', { name, purpose: 'Push release tags', ...extra })
  if (!r.ok) throw new Error(`request failed ${JSON.stringify(r)}`)
  const res = r.result as { request_id: string; approve_url: string; host_key_fingerprint: string }
  const u = new URL(res.approve_url)
  const [, , momentId, token] = u.pathname.split('/')
  return { dropId: res.request_id, momentId, token, path: u.pathname, url: res.approve_url, fingerprint: res.host_key_fingerprint }
}

type Choice = { decision: 'provide'; enc: string; ct: string } | { decision: 'deny' }
async function getCsrf(m: Request): Promise<string> {
  const page = await hit(m.path)
  expect(page.status).toBe(200)
  return csrfOf(await page.text())
}
async function challenge(m: Request, csrf: string, c: Choice): Promise<string> {
  const res = await hit(`${m.path}/challenge`, { method: 'POST', json: { ...c, csrf } })
  expect(res.status).toBe(200)
  return (await jbody(res)).publicKey?.challenge ?? ''
}
/** Ceremony in steps so an attack can intervene: `send` is what /decide receives (default: what the challenge was minted for). */
async function decide(m: Request, a: SoftAuthenticator, c: Choice, over: { challenge?: string; send?: Choice; csrf?: string } = {}): Promise<Response> {
  const csrf = over.csrf ?? (await getCsrf(m))
  const ch = over.challenge ?? (await challenge(m, csrf, c))
  const credential = await a.assert({ rpId: HOST, origin: ORIGIN, challenge: ch })
  return hit(`${m.path}/decide`, { method: 'POST', json: { ...(over.send ?? c), csrf, credential } })
}
const momentStatus = (id: string): string => one<{ status: string }>('SELECT status FROM secure_moments WHERE id = ?', id)?.status ?? 'missing'
const dropStatus = (id: string): string => one<{ status: string }>('SELECT status FROM secure_drops WHERE id = ?', id)?.status ?? 'missing'

/** Everything stored, as one string: used to prove the plaintext (and a base64 of it) never reaches the database. */
function wholeDatabase(): string {
  const tables = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  return tables.map((t) => JSON.stringify(all(`SELECT * FROM "${t.name}"`))).join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('flag off is a true no-op', () => {
  it('SECURE_DROP unset: tools are not advertised, refuse before argument handling, and write nothing', async () => {
    const off = baseEnv({ SECURE_DROP: undefined })
    const names = ['host_key_register', 'credential_request', 'secure_drop_pull', 'secure_drop_ack', 'secure_drop_revoke']
    for (const n of names) expect(advertisedTools(off).map((t) => t.name)).not.toContain(n)
    for (const n of names) expect(advertisedTools(env).map((t) => t.name)).toContain(n)
    for (const n of names) {
      // EMPTY args: a flag-off pot must refuse on the flag, not reveal the schema through invalid_args.
      const r = await tool(agentAuth(), n, {}, off)
      expect(r, n).toMatchObject({ ok: false, error: 'secure_drop_disabled' })
    }
    expect(count('host_keys')).toBe(0)
    expect(count('secure_drops')).toBe(0)
    expect(count('secure_moments')).toBe(0)
    expect(count('mutation_audit_entries', "handler = 'secure_drop'")).toBe(0)
  })
  it('SECURE_DROP on but secure moments off or misconfigured: tools refuse (409), nothing written', async () => {
    for (const e of [baseEnv({ SECURE_MOMENTS: undefined }), baseEnv({ SECURE_MOMENTS_HOST: COLONY })]) {
      expect(secureDropStatus(e).state).toBe('misconfigured')
      const r = await tool(agentAuth(), 'host_key_register', { public_key: newHostKey().pub }, e)
      expect(r).toMatchObject({ ok: false, error: 'secure_drop_misconfigured' })
    }
    expect(count('host_keys')).toBe(0)
  })
  it('the vendored sealer is a 404 while off; the credential page cannot be served for an existing request', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    expect((await hit('/m/assets/hpke-seal.v1.js')).status).toBe(200)
    const off = baseEnv({ SECURE_DROP: undefined })
    expect((await hit('/m/assets/hpke-seal.v1.js', {}, off)).status).toBe(404)
    expect((await hit('/m/assets/hpke-seal.v1.js', { host: COLONY })).status).toBe(404)
    expect((await hit(m.path, {}, off)).status).not.toBe(200)
    expect((await hit(`${m.path}/challenge`, { method: 'POST', json: { decision: 'deny', csrf: 'x' } }, off)).status).not.toBe(200)
  })
  it('script-src self exists only on the credential page: other moment pages keep a nonce-only policy', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    expect((await hit(m.path)).headers.get('content-security-policy') ?? '').toMatch(/script-src 'self' 'nonce-[A-Za-z0-9_-]+'/)
    const { token } = await mintEnrolmentToken(env, 'mem-owner', identities.owner)
    const enrol = (await hit(`/m/enrol/${token}`)).headers.get('content-security-policy') ?? ''
    expect(enrol).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+';/)
    expect(enrol).not.toMatch(/script-src[^;]*'self'/)
    expect((await hit('/m/enrol/nope')).headers.get('content-security-policy') ?? '').toContain("script-src 'none'")
  })
})

describe('host_key_register', () => {
  it('is agent-bound only: a human token and an unbound member are refused, nothing written', async () => {
    const key = newHostKey()
    expect(await tool(ownerAuth(), 'host_key_register', { public_key: key.pub })).toMatchObject({ ok: false, error: 'agent_bound_required' })
    expect(await tool(plainAuth(), 'host_key_register', { public_key: key.pub })).toMatchObject({ ok: false, error: 'agent_bound_required' })
    expect(count('host_keys')).toBe(0)
  })
  it('registers the PUBLIC key, returns the fingerprint = sha256(raw pub), and receipts it', async () => {
    const key = newHostKey()
    const r = await tool(agentAuth(), 'host_key_register', { public_key: key.pub })
    expect(r.ok).toBe(true)
    expect(r.result?.fingerprint).toBe(key.fingerprint)
    expect(r.result?.fingerprint).toBe(createHash('sha256').update(Buffer.from(key.pub, 'base64url')).digest('hex'))
    expect(r.result?.fingerprint_grouped).toBe(groupFingerprint(key.fingerprint))
    expect(one<{ agent_id: string }>('SELECT agent_id FROM host_keys WHERE revoked_at IS NULL')?.agent_id).toBe('agent-x')
    expect(count('mutation_audit_entries', "operation = 'host_key_register'")).toBe(1)
  })
  it('rejects malformed and small-order keys', async () => {
    const good = newHostKey().pub
    const bad = [
      '', 'short', `${good}A`, good.slice(0, 42), `${good.slice(0, 42)}=`, 'A'.repeat(43), // all-zero point decodes to 32 zero bytes
      Buffer.from(`01${'00'.repeat(31)}`, 'hex').toString('base64url'),
      Buffer.from(`ec${'ff'.repeat(30)}7f`, 'hex').toString('base64url'),
      Buffer.from(`e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800`, 'hex').toString('base64url'),
      `${good.slice(0, 42)}+`,
    ]
    for (const b of bad) expect(await tool(agentAuth(), 'host_key_register', { public_key: b }), b).toMatchObject({ ok: false })
    expect(await tool(agentAuth(), 'host_key_register', { public_key: 5 })).toMatchObject({ ok: false })
    expect(count('host_keys')).toBe(0)
    expect(await parseHostPublicKey(good)).not.toBeNull()
  })
  it('the same key twice is idempotent; one LIVE key per agent (partial UNIQUE)', async () => {
    const key = newHostKey()
    await registerKey(key)
    const again = await tool(agentAuth(), 'host_key_register', { public_key: key.pub })
    expect(again.result?.unchanged).toBe(true)
    expect(count('host_keys')).toBe(1)
    expect(() => harness.sqlite.prepare(
      `INSERT INTO host_keys (id, tenant, agent_id, public_key_b64u, fingerprint, created_at) VALUES ('h2', ?, 'agent-x', ?, ?, 'a')`,
    ).run(TENANT, newHostKey().pub, 'a'.repeat(64))).toThrow(/UNIQUE/)
  })
  it('rotation revokes the old key and closes open requests + unpulled ciphertext sealed to it', async () => {
    const k1 = newHostKey()
    await registerKey(k1)
    const open = await request('open-one')
    const provided = await request('sealed-one')
    const a = await enrol('mem-owner', identities.owner)
    const s = await sealFor(k1, provided.dropId)
    expect((await decide(provided, a, { decision: 'provide', ...s })).status).toBe(200)
    expect(dropStatus(provided.dropId)).toBe('ready')
    const k2 = newHostKey()
    const r = await tool(agentAuth(), 'host_key_register', { public_key: k2.pub })
    expect(r.result).toMatchObject({ rotated: true })
    expect(count('host_keys', 'revoked_at IS NULL')).toBe(1)
    expect(dropStatus(open.dropId)).toBe('expired')
    expect(dropStatus(provided.dropId)).toBe('expired')
    expect(one<{ ct_b64u: string | null }>('SELECT ct_b64u FROM secure_drops WHERE id = ?', provided.dropId)?.ct_b64u).toBeNull()
    expect(momentStatus(open.momentId)).toBe('expired')
    expect((await hit(open.path)).status).not.toBe(200)
    const pull = await tool(agentAuth(), 'secure_drop_pull', {})
    expect((pull.result?.drops as unknown[]).length).toBe(0)
  })
  it('a revoked key is never resurrected; another agent registering the same public key is its own row', async () => {
    const k1 = newHostKey()
    await registerKey(k1)
    await registerKey(newHostKey())
    expect(await tool(agentAuth(), 'host_key_register', { public_key: k1.pub })).toMatchObject({ ok: false, error: 'host_key_was_revoked' })
    await registerKey(k1, 'y')
    expect(count('host_keys', "agent_id = 'agent-y' AND revoked_at IS NULL")).toBe(1)
    expect(count('host_keys', "agent_id = 'agent-x' AND revoked_at IS NULL")).toBe(1)
  })
})

describe('credential_request', () => {
  it('needs a live host key', async () => {
    expect(await tool(agentAuth(), 'credential_request', { name: 'a', purpose: 'p' })).toMatchObject({ ok: false, error: 'host_key_required' })
    expect(count('secure_drops')).toBe(0)
  })
  it('agent-bound only', async () => {
    await registerKey(newHostKey())
    expect(await tool(ownerAuth(), 'credential_request', { name: 'a', purpose: 'p' })).toMatchObject({ ok: false, error: 'agent_bound_required' })
  })
  it('returns a one-time link and the grouped fingerprint, never a secret; stores the request + a credential moment', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request('npm-publish', 'x', { scope_hint: 'publish only', ttl_minutes: 30 })
    expect(m.url.startsWith(`${ORIGIN}/m/`)).toBe(true)
    expect(m.fingerprint).toBe(groupFingerprint(key.fingerprint))
    const d = one<{ status: string; moment_id: string; agent_id: string; host_key_id: string; scope_hint: string; ct_b64u: string | null }>('SELECT * FROM secure_drops WHERE id = ?', m.dropId)
    expect(d).toMatchObject({ status: 'requested', moment_id: m.momentId, agent_id: 'agent-x', scope_hint: 'publish only', ct_b64u: null })
    expect(one<{ kind: string; subject_id: string; requester_agent_id: string }>('SELECT kind, subject_id, requester_agent_id FROM secure_moments WHERE id = ?', m.momentId))
      .toEqual({ kind: 'credential', subject_id: m.dropId, requester_agent_id: 'agent-x' })
    const ttl = Date.parse(one<{ expires_at: string }>('SELECT expires_at FROM secure_drops WHERE id = ?', m.dropId)?.expires_at ?? '') - Date.now()
    expect(ttl).toBeGreaterThan(29 * 60_000)
    expect(ttl).toBeLessThanOrEqual(30 * 60_000)
    expect(count('mutation_audit_entries', "operation = 'credential_request'")).toBe(1)
  })
  it('name is a safe filename slug: traversal, dots, case, slashes, NUL, length', async () => {
    await registerKey(newHostKey())
    const bad = ['../x', '..', '.', '.env', 'a/b', 'a\\b', 'A', 'a b', '-a', '_a', 'a.b', 'a\u0000b', 'a'.repeat(64), '', ' a', 'a%2fb', 'аbc']
    for (const name of bad) expect(await tool(agentAuth(), 'credential_request', { name, purpose: 'p' }), JSON.stringify(name)).toMatchObject({ ok: false, error: 'invalid_name' })
    expect(await tool(agentAuth(), 'credential_request', { name: 7, purpose: 'p' })).toMatchObject({ ok: false })
    expect(count('secure_drops')).toBe(0)
    for (const name of ['a', 'github-token', 'a_b-c9', 'a'.repeat(63)]) expect((await tool(agentAuth(), 'credential_request', { name, purpose: 'p' })).ok, name).toBe(true)
  })
  it('purpose / scope_hint / ttl are bounded; control and invisible characters refused', async () => {
    await registerKey(newHostKey())
    for (const purpose of ['', 'x'.repeat(281), 'a\nb', 'a‮b', 'a​b']) {
      expect(await tool(agentAuth(), 'credential_request', { name: 'a', purpose }), JSON.stringify(purpose)).toMatchObject({ ok: false, error: 'invalid_purpose' })
    }
    expect(await tool(agentAuth(), 'credential_request', { name: 'a', purpose: 'p', scope_hint: 'x'.repeat(201) })).toMatchObject({ ok: false, error: 'invalid_scope_hint' })
    for (const ttl of [1, 4, 1441, 1.5, -5]) expect(await tool(agentAuth(), 'credential_request', { name: 'a', purpose: 'p', ttl_minutes: ttl }), String(ttl)).toMatchObject({ ok: false, error: 'invalid_ttl' })
    expect(await tool(agentAuth(), 'credential_request', { name: 'a', purpose: 'p', ttl_minutes: '60' })).toMatchObject({ ok: false })
    expect((await tool(agentAuth(), 'credential_request', { name: 'a', purpose: 'p', ttl_minutes: 5 })).ok).toBe(true)
  })
  it('a re-request for the same name supersedes the open one (the old link dies); sealed-but-unpulled blocks a new one', async () => {
    const key = newHostKey()
    await registerKey(key)
    const first = await request('same')
    const second = await request('same')
    expect(dropStatus(first.dropId)).toBe('expired')
    expect(momentStatus(first.momentId)).toBe('expired')
    expect((await hit(first.path)).status).not.toBe(200)
    expect((await hit(second.path)).status).toBe(200)
    const a = await enrol('mem-owner', identities.owner)
    expect((await decide(second, a, { decision: 'provide', ...(await sealFor(key, second.dropId)) })).status).toBe(200)
    expect(await tool(agentAuth(), 'credential_request', { name: 'same', purpose: 'again' })).toMatchObject({ ok: false, error: 'delivery_pending' })
  })
  it('an agent has a cap on open requests', async () => {
    await registerKey(newHostKey())
    for (let i = 0; i < 10; i++) expect((await tool(agentAuth(), 'credential_request', { name: `n${i}`, purpose: 'p' })).ok).toBe(true)
    expect(await tool(agentAuth(), 'credential_request', { name: 'n10', purpose: 'p' })).toMatchObject({ ok: false, error: 'too_many_open_requests' })
  })
})

describe('the credential page', () => {
  it('shows the agent, name, the purpose ONLY in the untrusted box, the fingerprint, a password field, pinned script, nonce CSP', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request('db-pass', 'x', { scope_hint: 'read only' })
    harness.sqlite.prepare('UPDATE secure_drops SET purpose = ? WHERE id = ?').run('<img src=x onerror=alert(1)> trust me', m.dropId)
    const res = await hit(m.path)
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain('Agent X')
    expect(html).toContain('db-pass')
    expect(html).toContain(groupFingerprint(key.fingerprint))
    expect(html).toMatch(/<input id="secret" type="password"/)
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
    expect(/class="untrusted"[\s\S]*&lt;img src=x/.test(html)).toBe(true)
    const nonce = /script-src 'self' 'nonce-([A-Za-z0-9_-]+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1]
    expect(nonce).toBeTruthy()
    expect(html).toContain(`<script nonce="${nonce}" src="/m/assets/hpke-seal.v1.js" integrity="${HPKE_BUNDLE_SRI}" crossorigin="anonymous"></script>`)
    expect(html.match(/<script/g)?.length).toBe(2) // the sealer + the ONE inline script, nothing else
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    expect(res.headers.get('content-security-policy')).toMatch(/connect-src 'self'/)
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/)
    // Opening the page consumed nothing.
    expect(momentStatus(m.momentId)).toBe('pending')
  })
  it('the sealer is served from the host with nosniff, a strict CSP and the pinned bytes', async () => {
    const res = await hit('/m/assets/hpke-seal.v1.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    const body = await res.text()
    expect(createHash('sha256').update(body).digest('hex')).toBe(HPKE_BUNDLE_SHA256)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  it('the SRI value is the sha384 of the served bytes', () => {
    expect(HPKE_BUNDLE_SRI).toBe(`sha384-${createHash('sha384').update(HPKE_BUNDLE_JS).digest('base64')}`)
  })
  it('a rotated host key closes the page; a human sees why', async () => {
    await registerKey(newHostKey())
    const m = await request()
    await registerKey(newHostKey())
    const res = await hit(m.path)
    expect(res.status).not.toBe(200)
  })
})

/** Same 32 bytes, different spelling: the last base64url character of a 32-byte value carries 2 padding bits. */
function nonCanonical(b64u: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return b64u.slice(0, -1) + alphabet[alphabet.indexOf(b64u.slice(-1)) | 1]
}

describe('provide: sealing in the browser, deciding with the passkey', () => {
  it('end to end: provide -> ciphertext only on the server -> pull -> host opens -> ack deletes it', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const s = await sealFor(key, m.dropId)
    const res = await decide(m, a, { decision: 'provide', ...s })
    expect(res.status).toBe(200)
    const resBody = await jbody(res)
    expect(resBody.title).toBe('Credential sealed and sent')
    expect(momentStatus(m.momentId)).toBe('consumed')
    const row = one<{ status: string; enc_b64u: string; ct_b64u: string; ct_sha256: string; decided_by_member_id: string }>('SELECT * FROM secure_drops WHERE id = ?', m.dropId)
    expect(row).toMatchObject({ status: 'ready', enc_b64u: s.enc, ct_b64u: s.ct, decided_by_member_id: 'mem-owner' })
    expect(row?.ct_sha256).toBe(await sealedDigest(Buffer.from(s.enc, 'base64url'), Buffer.from(s.ct, 'base64url')))
    // THE SERVER NEVER HOLDS THE PLAINTEXT: not in any table, not as base64, not in the response.
    const dump = wholeDatabase()
    expect(dump).not.toContain(SECRET)
    expect(dump).not.toContain(Buffer.from(SECRET).toString('base64'))
    expect(dump).not.toContain(Buffer.from(SECRET).toString('base64url'))
    expect(JSON.stringify(resBody)).not.toContain(SECRET)
    // pull as the agent
    const pull = await tool(agentAuth(), 'secure_drop_pull', {})
    const drops = pull.result?.drops as Array<{ id: string; name: string; enc: string; ct: string; host_key_fingerprint: string }>
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ id: m.dropId, name: 'github-token', enc: s.enc, ct: s.ct, host_key_fingerprint: key.fingerprint })
    expect(JSON.stringify(pull)).not.toContain(SECRET)
    // the host opens it with its OWN key
    expect(openWith(key, m.dropId, drops[0])).toBe(SECRET)
    // ack: delivered, ciphertext deleted
    expect(await tool(agentAuth(), 'secure_drop_ack', { id: m.dropId })).toMatchObject({ ok: true, result: { result: 'delivered' } })
    expect(one<{ status: string; enc_b64u: string | null; ct_b64u: string | null }>('SELECT status, enc_b64u, ct_b64u FROM secure_drops WHERE id = ?', m.dropId))
      .toEqual({ status: 'delivered', enc_b64u: null, ct_b64u: null })
    expect((await tool(agentAuth(), 'secure_drop_pull', {})).result?.drops).toEqual([])
  })
  it('receipts exist for request, provide, deliver and carry no secret material (not the plaintext, enc, ct)', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const s = await sealFor(key, m.dropId)
    await decide(m, a, { decision: 'provide', ...s })
    await tool(agentAuth(), 'secure_drop_ack', { id: m.dropId })
    await tool(ownerAuth(), 'secure_drop_revoke', { name: 'github-token' })
    const ops = all<{ operation: string }>("SELECT operation FROM mutation_audit_entries WHERE handler = 'secure_drop' ORDER BY recorded_at").map((r) => r.operation)
    for (const op of ['host_key_register', 'credential_request', 'secure_drop_provide', 'secure_drop_deliver', 'secure_drop_revoke']) expect(ops, op).toContain(op)
    const receipts = JSON.stringify(all('SELECT * FROM mutation_audit_entries WHERE handler = ?', 'secure_drop'))
    for (const bad of [SECRET, s.enc, s.ct, Buffer.from(SECRET).toString('base64')]) expect(receipts).not.toContain(bad)
    const provide = one<{ evidence_json: string; principal_id: string; origin: string }>("SELECT evidence_json, principal_id, origin FROM mutation_audit_entries WHERE operation = 'secure_drop_provide'")
    expect(provide?.principal_id).toBe('mem-owner')
    expect(JSON.parse(provide?.evidence_json ?? '{}').ct_sha256).toBe(one<{ ct_sha256: string }>('SELECT ct_sha256 FROM secure_drops WHERE id = ?', m.dropId)?.ct_sha256)
  })
  it('THE CHALLENGE IS BOUND TO sha256(enc||ciphertext): swapping the ciphertext after the assertion is refused and stores nothing', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const honest = await sealFor(key, m.dropId, 'honest-secret')
    const evil = await sealFor(key, m.dropId, 'attacker-chosen')
    const res = await decide(m, a, { decision: 'provide', ...honest }, { send: { decision: 'provide', ...evil } })
    expect(res.status).toBe(403)
    expect(dropStatus(m.dropId)).toBe('requested')
    expect(momentStatus(m.momentId)).toBe('pending')
    expect(one<{ ct_b64u: string | null }>('SELECT ct_b64u FROM secure_drops WHERE id = ?', m.dropId)?.ct_b64u).toBeNull()
  })
  it('swapping ONLY the ciphertext (same enc) after the assertion is refused too: the digest covers both parts', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const honest = await sealFor(key, m.dropId, 'honest-secret')
    const evil = await sealFor(key, m.dropId, 'attacker-chosen')
    const res = await decide(m, a, { decision: 'provide', ...honest }, { send: { decision: 'provide', enc: honest.enc, ct: evil.ct } })
    expect(res.status).toBe(403)
    expect(dropStatus(m.dropId)).toBe('requested')
    expect(momentStatus(m.momentId)).toBe('pending')
  })
  it('swapping ONLY enc (same ciphertext) after the assertion is refused too', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const honest = await sealFor(key, m.dropId, 'honest-secret')
    const evil = await sealFor(key, m.dropId, 'attacker-chosen')
    const res = await decide(m, a, { decision: 'provide', ...honest }, { send: { decision: 'provide', enc: evil.enc, ct: honest.ct } })
    expect(res.status).toBe(403)
    expect(dropStatus(m.dropId)).toBe('requested')
  })
  it('a challenge minted for provide cannot carry a deny, and one for a deny cannot carry a provide', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const s = await sealFor(key, m.dropId)
    expect((await decide(m, a, { decision: 'deny' }, { send: { decision: 'provide', ...s } })).status).toBe(403)
    expect((await decide(m, a, { decision: 'provide', ...s }, { send: { decision: 'deny' } })).status).toBe(403)
    expect(dropStatus(m.dropId)).toBe('requested')
  })
  it('a challenge minted for one request cannot decide another', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m1 = await request('one')
    const m2 = await request('two')
    const a = await enrol('mem-owner', identities.owner)
    const s = await sealFor(key, m2.dropId)
    const csrf1 = await getCsrf(m1)
    const ch = await challenge(m1, csrf1, { decision: 'provide', ...s })
    expect((await decide(m2, a, { decision: 'provide', ...s }, { challenge: ch })).status).toBe(403)
    expect(dropStatus(m2.dropId)).toBe('requested')
  })
  it('replay: a second provide on a consumed moment is refused and the ciphertext is untouched', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const s = await sealFor(key, m.dropId)
    const s2 = await sealFor(key, m.dropId, 'second')
    // The attacker holds a valid csrf + challenge for a second provide minted BEFORE the first one lands.
    const csrf = await getCsrf(m)
    const ch2 = await challenge(m, csrf, { decision: 'provide', ...s2 })
    expect((await decide(m, a, { decision: 'provide', ...s })).status).toBe(200)
    const again = await decide(m, a, { decision: 'provide', ...s2 }, { challenge: ch2, csrf })
    expect(again.status).toBe(409)
    expect(one<{ ct_b64u: string }>('SELECT ct_b64u FROM secure_drops WHERE id = ?', m.dropId)?.ct_b64u).toBe(s.ct)
  })
  it('a challenge is single-use: reusing it for a second submission is refused', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const s = await sealFor(key, m.dropId)
    const csrf = await getCsrf(m)
    const ch = await challenge(m, csrf, { decision: 'provide', ...s })
    const cred1 = await a.assert({ rpId: HOST, origin: ORIGIN, challenge: ch })
    const first = await hit(`${m.path}/decide`, { method: 'POST', json: { decision: 'provide', ...s, csrf, credential: cred1 } })
    expect(first.status).toBe(200)
    const cred2 = await a.assert({ rpId: HOST, origin: ORIGIN, challenge: ch })
    expect((await hit(`${m.path}/decide`, { method: 'POST', json: { decision: 'provide', ...s, csrf, credential: cred2 } })).status).toBeGreaterThanOrEqual(400)
  })
  it('malformed sealed input is refused: wrong enc length, non-canonical base64url, empty/oversized ciphertext, missing parts', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const csrf = await getCsrf(m)
    const s = await sealFor(key, m.dropId)
    const big = Buffer.alloc(8 * 1024 + 17, 1).toString('base64url')
    const bads: unknown[] = [
      { enc: s.enc.slice(0, 40), ct: s.ct }, { enc: s.enc, ct: '' }, { enc: s.enc, ct: 'AAAA' }, { enc: s.enc, ct: big },
      { enc: `${s.enc}A`, ct: s.ct }, { ct: s.ct }, { enc: s.enc }, { enc: 5, ct: 6 }, { enc: s.enc, ct: `${s.ct}=` },
      { enc: nonCanonical(s.enc), ct: s.ct },
    ]
    for (const b of bads) {
      const res = await hit(`${m.path}/challenge`, { method: 'POST', json: { decision: 'provide', csrf, ...(b as object) } })
      expect(res.status, JSON.stringify(b).slice(0, 80)).toBeGreaterThanOrEqual(400)
    }
    expect(count('passkey_challenges', "purpose = 'decide'")).toBe(0)
  })
  it('the CSRF token is bound to the link: a token from another request is refused', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m1 = await request('one')
    const m2 = await request('two')
    const s = await sealFor(key, m2.dropId)
    const res = await hit(`${m2.path}/challenge`, { method: 'POST', json: { decision: 'provide', ...s, csrf: await getCsrf(m1) } })
    expect(res.status).toBe(403)
  })
  it('deny: records the denial, the agent never receives anything, and the moment is spent', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    expect((await decide(m, a, { decision: 'deny' })).status).toBe(200)
    expect(dropStatus(m.dropId)).toBe('denied')
    expect(momentStatus(m.momentId)).toBe('denied')
    expect((await tool(agentAuth(), 'secure_drop_pull', {})).result?.drops).toEqual([])
    expect(count('mutation_audit_entries', "operation = 'secure_drop_deny'")).toBe(1)
  })
  it('an expired request is not decidable', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    harness.sqlite.prepare("UPDATE secure_drops SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(m.dropId)
    harness.sqlite.prepare("UPDATE secure_moments SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(m.momentId)
    expect((await hit(m.path)).status).not.toBe(200)
    expect((await decide(m, a, { decision: 'deny' }).catch(() => null))?.status ?? 500).not.toBe(200)
    expect(dropStatus(m.dropId)).toBe('requested')
  })
})

describe('authority: a passkey proves WHO, never WHAT', () => {
  it('a plain member with a passkey is refused; the moment and the request stay open', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-plain', identities.plain)
    const res = await decide(m, a, { decision: 'provide', ...(await sealFor(key, m.dropId)) })
    expect(res.status).toBe(403)
    expect(momentStatus(m.momentId)).toBe('pending')
    expect(dropStatus(m.dropId)).toBe('requested')
  })
  it('admin on the agent squad may provide; org owner may provide; admin of ANOTHER squad may not', async () => {
    const key = newHostKey()
    await registerKey(key)
    const other = await request('other-squad')
    const bad = await enrol('mem-sqadmin-b', identities.sqadminB)
    expect((await decide(other, bad, { decision: 'provide', ...(await sealFor(key, other.dropId)) })).status).toBe(403)
    expect(dropStatus(other.dropId)).toBe('requested')
    const sa = await enrol('mem-sqadmin', identities.sqadmin)
    expect((await decide(other, sa, { decision: 'provide', ...(await sealFor(key, other.dropId)) })).status).toBe(200)
    const m2 = await request('by-owner')
    const owner = await enrol('mem-owner', identities.owner)
    expect((await decide(m2, owner, { decision: 'provide', ...(await sealFor(key, m2.dropId)) })).status).toBe(200)
  })
  it('an agent can never decide: its welded member row has no passkey and cannot enrol one', async () => {
    const key = newHostKey()
    await registerKey(key)
    const { token } = await mintEnrolmentToken(env, 'mem-agent', null)
    expect((await hit(`/m/enrol/${token}`)).status).toBe(404)
    expect(count('member_passkeys', "member_id = 'mem-agent'")).toBe(0)
  })
  it('a revoked login identity cuts the passkey off for credentials too', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    harness.sqlite.prepare("UPDATE human_login_identities SET revoked_at = datetime('now') WHERE id = ?").run(identities.owner)
    const res = await decide(m, a, { decision: 'provide', ...(await sealFor(key, m.dropId)) })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(momentStatus(m.momentId)).toBe('pending')
    expect(dropStatus(m.dropId)).toBe('requested')
  })
  it('a host key rotated between the page and the decision refuses the provide without burning the link', async () => {
    const k1 = newHostKey()
    await registerKey(k1)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const s = await sealFor(k1, m.dropId)
    const csrf = await getCsrf(m)
    const ch = await challenge(m, csrf, { decision: 'provide', ...s })
    await registerKey(newHostKey())
    const res = await decide(m, a, { decision: 'provide', ...s }, { challenge: ch, csrf })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(one<{ ct_b64u: string | null }>('SELECT ct_b64u FROM secure_drops WHERE id = ?', m.dropId)?.ct_b64u).toBeNull()
  })
  it('decideDrop itself refuses a key that is no longer live (the batch guard, not only the route pre-check)', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    await enrol('mem-owner', identities.owner)
    const passkey = one<{ id: string }>("SELECT id FROM member_passkeys WHERE member_id = 'mem-owner'")
    harness.sqlite.prepare('UPDATE host_keys SET revoked_at = datetime(\'now\') WHERE agent_id = ?').run('agent-x')
    const drop = await loadDrop(env, m.dropId)
    const s = await sealFor(key, m.dropId)
    const digest = await sealedDigest(Buffer.from(s.enc, 'base64url'), Buffer.from(s.ct, 'base64url'))
    const landed = await decideDrop(env, {
      momentId: m.momentId, token: m.token, drop: drop!, decision: 'provide', memberId: 'mem-owner', passkeyId: passkey!.id,
      sealed: { encB64u: s.enc, ctB64u: s.ct, digestHex: digest }, fingerprint: key.fingerprint,
    }, Date.now())
    expect(landed).toBe(false)
    expect(momentStatus(m.momentId)).toBe('pending')
    expect(dropStatus(m.dropId)).toBe('requested')
  })
  it('a drop bound to a different moment cannot be decided through this one', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request('one')
    const other = await request('two')
    await enrol('mem-owner', identities.owner)
    const passkey = one<{ id: string }>("SELECT id FROM member_passkeys WHERE member_id = 'mem-owner'")
    const drop = await loadDrop(env, other.dropId)
    const landed = await decideDrop(env, { momentId: m.momentId, token: m.token, drop: drop!, decision: 'deny', memberId: 'mem-owner', passkeyId: passkey!.id, fingerprint: key.fingerprint }, Date.now())
    expect(landed).toBe(false)
    expect(momentStatus(m.momentId)).toBe('pending')
    expect(dropStatus(other.dropId)).toBe('requested')
  })
})

describe('pull and ack', () => {
  async function provided(name = 'github-token', which: 'x' | 'y' = 'x', key?: HostKey): Promise<{ key: HostKey; m: Request; s: { enc: string; ct: string } }> {
    const k = key ?? newHostKey()
    await registerKey(k, which)
    const m = await request(name, which)
    const a = await enrol('mem-owner', identities.owner).catch(async () => SoftAuthenticator.create())
    const s = await sealFor(k, m.dropId)
    const res = await decide(m, a, { decision: 'provide', ...s })
    if (res.status !== 200) throw new Error(`provide failed ${res.status} ${await res.text()}`)
    return { key: k, m, s }
  }
  it('another agent cannot pull it and cannot ack it (the ciphertext survives the attempt)', async () => {
    const { m } = await provided('x-secret', 'x')
    await registerKey(newHostKey(), 'y')
    const pull = await tool(agentAuth('y'), 'secure_drop_pull', {})
    expect(pull.result?.drops).toEqual([])
    expect(await tool(agentAuth('y'), 'secure_drop_ack', { id: m.dropId })).toMatchObject({ ok: false, error: 'nothing_to_ack' })
    expect(dropStatus(m.dropId)).toBe('ready')
    expect(one<{ ct_b64u: string | null }>('SELECT ct_b64u FROM secure_drops WHERE id = ?', m.dropId)?.ct_b64u).not.toBeNull()
  })
  it('pull needs a live host key; a human or unbound token is refused', async () => {
    expect(await tool(agentAuth(), 'secure_drop_pull', {})).toMatchObject({ ok: false, error: 'host_key_required' })
    expect(await tool(ownerAuth(), 'secure_drop_pull', {})).toMatchObject({ ok: false, error: 'agent_bound_required' })
    expect(await tool(ownerAuth(), 'secure_drop_ack', { id: crypto.randomUUID() })).toMatchObject({ ok: false, error: 'agent_bound_required' })
  })
  it('pull lists only ciphertext sealed to the CURRENT live key (live-key join), independent of the status batch', async () => {
    const { m } = await provided()
    // Simulate a key revoked without the rotation batch: only the join can hide the drop.
    harness.sqlite.prepare("UPDATE host_keys SET revoked_at = datetime('now') WHERE agent_id = 'agent-x'").run()
    harness.sqlite.prepare("INSERT INTO host_keys (id, tenant, agent_id, public_key_b64u, fingerprint, created_at) VALUES ('hk-new', ?, 'agent-x', ?, ?, datetime('now'))").run(TENANT, newHostKey().pub, 'b'.repeat(64))
    expect(dropStatus(m.dropId)).toBe('ready')
    const pull = await tool(agentAuth(), 'secure_drop_pull', {})
    expect(pull.result?.drops).toEqual([])
    expect(await tool(agentAuth(), 'secure_drop_ack', { id: m.dropId })).toMatchObject({ ok: false, error: 'nothing_to_ack' })
    expect(dropStatus(m.dropId)).toBe('ready')
  })
  it('ack is single use: a replayed ack changes nothing and is refused', async () => {
    const { m } = await provided()
    expect((await tool(agentAuth(), 'secure_drop_ack', { id: m.dropId })).ok).toBe(true)
    const t1 = one<{ delivered_at: string }>('SELECT delivered_at FROM secure_drops WHERE id = ?', m.dropId)?.delivered_at
    expect(await tool(agentAuth(), 'secure_drop_ack', { id: m.dropId })).toMatchObject({ ok: false, error: 'nothing_to_ack' })
    expect(one<{ delivered_at: string }>('SELECT delivered_at FROM secure_drops WHERE id = ?', m.dropId)?.delivered_at).toBe(t1)
    expect(count('mutation_audit_entries', "operation = 'secure_drop_deliver'")).toBe(1)
  })
  it('ack validates the id; an unknown id is refused', async () => {
    await registerKey(newHostKey())
    expect(await tool(agentAuth(), 'secure_drop_ack', { id: 'not-a-uuid' })).toMatchObject({ ok: false, error: 'invalid_id' })
    expect(await tool(agentAuth(), 'secure_drop_ack', { id: crypto.randomUUID() })).toMatchObject({ ok: false, error: 'nothing_to_ack' })
  })
  it('expired requests and over-retention ciphertext are purged lazily on pull (ciphertext deleted)', async () => {
    const { m } = await provided('keep-me')
    const stale = await request('stale')
    harness.sqlite.prepare("UPDATE secure_drops SET retain_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(m.dropId)
    harness.sqlite.prepare("UPDATE secure_drops SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(stale.dropId)
    const pull = await tool(agentAuth(), 'secure_drop_pull', {})
    expect(pull.result?.drops).toEqual([])
    expect(dropStatus(m.dropId)).toBe('expired')
    expect(dropStatus(stale.dropId)).toBe('expired')
    expect(one<{ ct_b64u: string | null; enc_b64u: string | null }>('SELECT ct_b64u, enc_b64u FROM secure_drops WHERE id = ?', m.dropId)).toEqual({ ct_b64u: null, enc_b64u: null })
    expect(await tool(agentAuth(), 'secure_drop_ack', { id: m.dropId })).toMatchObject({ ok: false })
  })
  it('the schema makes ciphertext outside the ready state unrepresentable', async () => {
    const { m } = await provided()
    expect(() => harness.sqlite.prepare("UPDATE secure_drops SET status = 'delivered' WHERE id = ?").run(m.dropId)).toThrow(/CHECK/)
  })
})

describe('revoke', () => {
  async function delivered(name = 'cloud-key'): Promise<Request> {
    const key = newHostKey()
    await registerKey(key)
    const m = await request(name)
    const a = await enrol('mem-owner', identities.owner)
    expect((await decide(m, a, { decision: 'provide', ...(await sealFor(key, m.dropId)) })).status).toBe(200)
    expect((await tool(agentAuth(), 'secure_drop_ack', { id: m.dropId })).ok).toBe(true)
    return m
  }
  it('a human with authority marks a delivered credential; the host sees it on pull and acks it', async () => {
    const m = await delivered()
    const r = await tool(sqadminAuth(), 'secure_drop_revoke', { name: 'cloud-key' })
    expect(r).toMatchObject({ ok: true, result: { effects: ['instructed'] } })
    const pull = await tool(agentAuth(), 'secure_drop_pull', {})
    expect(pull.result?.revokes).toEqual([{ id: m.dropId, name: 'cloud-key' }])
    expect(await tool(agentAuth(), 'secure_drop_ack', { id: m.dropId })).toMatchObject({ ok: true, result: { result: 'revoke_acked' } })
    expect(dropStatus(m.dropId)).toBe('revoked')
    expect((await tool(agentAuth(), 'secure_drop_pull', {})).result?.revokes).toEqual([])
    expect(await tool(agentAuth(), 'secure_drop_ack', { id: m.dropId })).toMatchObject({ ok: false })
    expect(count('mutation_audit_entries', "operation = 'secure_drop_revoke'")).toBe(1)
    expect(count('mutation_audit_entries', "operation = 'secure_drop_revoke_ack'")).toBe(1)
  })
  it('revoking unpulled ciphertext deletes it at once; revoking an open request cancels it and its link', async () => {
    const key = newHostKey()
    await registerKey(key)
    const sealed = await request('sealed-name')
    const open = await request('open-name')
    const a = await enrol('mem-owner', identities.owner)
    expect((await decide(sealed, a, { decision: 'provide', ...(await sealFor(key, sealed.dropId)) })).status).toBe(200)
    expect(await tool(ownerAuth(), 'secure_drop_revoke', { name: 'sealed-name' })).toMatchObject({ ok: true, result: { effects: ['deleted'] } })
    expect(one<{ status: string; ct_b64u: string | null }>('SELECT status, ct_b64u FROM secure_drops WHERE id = ?', sealed.dropId)).toEqual({ status: 'revoked', ct_b64u: null })
    expect((await tool(agentAuth(), 'secure_drop_pull', {})).result?.drops).toEqual([])
    expect(await tool(ownerAuth(), 'secure_drop_revoke', { name: 'open-name' })).toMatchObject({ ok: true, result: { effects: ['cancelled'] } })
    expect(momentStatus(open.momentId)).toBe('expired')
    expect((await hit(open.path)).status).not.toBe(200)
  })
  it('an agent-bound caller, a plain member, and an admin of another squad cannot revoke (same not_found/forbidden)', async () => {
    await delivered()
    expect(await tool(agentAuth(), 'secure_drop_revoke', { name: 'cloud-key' })).toMatchObject({ ok: false, error: 'human_required' })
    expect(await tool(agentAuth('y'), 'secure_drop_revoke', { name: 'cloud-key' })).toMatchObject({ ok: false, error: 'human_required' })
    expect(await tool(plainAuth(), 'secure_drop_revoke', { name: 'cloud-key' })).toMatchObject({ ok: false, error: 'not_found' })
    expect(await tool(sqadminAuth('mem-sqadmin-b', 'squad-b'), 'secure_drop_revoke', { name: 'cloud-key' })).toMatchObject({ ok: false, error: 'not_found' })
    expect(count('secure_drops', 'revoke_requested_at IS NOT NULL')).toBe(0)
  })
  it('the name is validated and an unknown name is not_found; revoke is idempotent-refusing', async () => {
    await delivered()
    expect(await tool(ownerAuth(), 'secure_drop_revoke', { name: '../x' })).toMatchObject({ ok: false, error: 'invalid_name' })
    expect(await tool(ownerAuth(), 'secure_drop_revoke', { name: 'nope' })).toMatchObject({ ok: false, error: 'not_found' })
    expect((await tool(ownerAuth(), 'secure_drop_revoke', { name: 'cloud-key' })).ok).toBe(true)
    expect(await tool(ownerAuth(), 'secure_drop_revoke', { name: 'cloud-key' })).toMatchObject({ ok: false })
  })
  it('the same name for two agents needs agent_id', async () => {
    const kx = newHostKey()
    const ky = newHostKey()
    await registerKey(kx, 'x')
    await registerKey(ky, 'y')
    const a = await enrol('mem-owner', identities.owner)
    const mx = await request('shared', 'x')
    expect((await decide(mx, a, { decision: 'provide', ...(await sealFor(kx, mx.dropId)) })).status).toBe(200)
    const my = await request('shared', 'y')
    expect((await decide(my, a, { decision: 'provide', ...(await sealFor(ky, my.dropId)) })).status).toBe(200)
    expect(await tool(ownerAuth(), 'secure_drop_revoke', { name: 'shared' })).toMatchObject({ ok: false, error: 'ambiguous_name' })
    expect(await tool(ownerAuth(), 'secure_drop_revoke', { name: 'shared', agent_id: 'agent-y' })).toMatchObject({ ok: true })
    expect(dropStatus(mx.dropId)).toBe('ready')
    expect(dropStatus(my.dropId)).toBe('revoked')
  })
})

describe('the server has no decrypt path', () => {
  const dirs = ['src/secure-drop', 'src/secure-moments']
  const files = [
    ...dirs.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.ts') && !f.endsWith('.generated.ts')).map((f) => join(d, f))),
    'src/mcp/secure-drop.ts',
  ]
  const FORBIDDEN_IMPORT = /from\s+['"](?:@hpke|@noble|tweetnacl|libsodium|sodium|node:crypto|crypto|[^'"]*\/vendor\/[^'"]*|[^'"]*lib\/vault[^'"]*|[^'"]*connectors\/crypto[^'"]*)/
  const FORBIDDEN_CALL = /subtle\.(?:decrypt|unwrapKey|deriveKey|deriveBits)|\.decrypt\(|createDecipheriv|privateDecrypt|crypto_box_open|\bhpke(?:Open|Decrypt)\b|\.open\(/
  it('scans a non-trivial set of modules', () => expect(files.length).toBeGreaterThan(10))
  for (const f of files) {
    it(`${f} imports nothing able to open HPKE and calls no decrypt primitive`, () => {
      const src = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(src).not.toMatch(FORBIDDEN_IMPORT)
      expect(src).not.toMatch(FORBIDDEN_CALL)
    })
  }
  it('package.json carries no HPKE library: the sealer is a vendored file for the browser only', () => {
    const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8')
    expect(pkg).not.toMatch(/@hpke|hpke/i)
  })
  it('no table or column of the secure-drop schema can hold plaintext, and the API shapes never name one', () => {
    const cols = all<{ name: string }>("SELECT name FROM pragma_table_info('secure_drops')").map((c) => c.name)
    expect(cols.filter((c) => /secret|plain|clear|value|password/i.test(c))).toEqual([])
    const src = readFileSync(join(ROOT, 'src/mcp/secure-drop.ts'), 'utf8')
    expect(src).not.toMatch(/inputSchema[\s\S]{0,400}(secret|password|plaintext)\s*:/)
  })
})

describe('the vendored browser bundle', () => {
  it('is the pinned file: sha256 in the doc, version header, TS copy byte-identical', () => {
    const file = readFileSync(join(ROOT, 'src/secure-drop/vendor/hpke-seal.v1.js'), 'utf8')
    expect(file).toBe(HPKE_BUNDLE_JS)
    expect(createHash('sha256').update(file).digest('hex')).toBe(HPKE_BUNDLE_SHA256)
    expect(file.startsWith('/* mupot-hpke-bundle v1 | HPKE RFC 9180 base, DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/AES-128-GCM | @hpke/core 1.9.0 @hpke/dhkem-x25519 1.8.0')).toBe(true)
    const doc = readFileSync(join(ROOT, 'docs/architecture/secure-moments.md'), 'utf8')
    expect(doc).toContain(HPKE_BUNDLE_SHA256)
    expect(doc).toContain(HPKE_BUNDLE_SRI)
  })
  it('contains no network, storage or dynamic-code primitive a script-src self policy would not already forbid us from trusting', () => {
    for (const bad of ['eval(', 'new Function', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'localStorage', 'sessionStorage', 'document.cookie', 'fetch(']) {
      expect(HPKE_BUNDLE_JS, bad).not.toContain(bad)
    }
    // The only dynamic import is the Node-only crypto fallback taken when globalThis.crypto is absent.
    expect((HPKE_BUNDLE_JS.match(/import\(/g) ?? []).length).toBe(2)
    for (const m of HPKE_BUNDLE_JS.matchAll(/import\("([^"]+)"\)/g)) expect(m[1]).toBe('crypto')
  })
  it('seals to the host key: the host key opens it, any other key, other drop id, other fingerprint or a flipped bit does not', async () => {
    const key = newHostKey()
    const id = crypto.randomUUID()
    const s = await sealFor(key, id)
    expect(openWith(key, id, s)).toBe(SECRET)
    const other = newHostKey()
    expect(() => openWith(other, id, s)).toThrow()
    expect(() => openWith(key, crypto.randomUUID(), s)).toThrow() // info + aad bind the drop id
    const flipped = Buffer.from(s.ct, 'base64url')
    flipped[0] ^= 1
    expect(() => openWith(key, id, { enc: s.enc, ct: flipped.toString('base64url') })).toThrow()
    expect(() => hostScript.hpkeOpen({ privateKey: key.privateKey, enc: Buffer.from(s.enc, 'base64url'), info: Buffer.from(hpkeInfo(dropBinding(id).agent, id, dropBinding(id).name, other.fingerprint)), aad: Buffer.from(id), ct: Buffer.from(s.ct, 'base64url') })).toThrow()
  })
  it('every seal is a fresh sender context: same key, same secret, different enc and ciphertext', async () => {
    const key = newHostKey()
    const id = crypto.randomUUID()
    const a = await sealFor(key, id)
    const b = await sealFor(key, id)
    expect(a.enc).not.toBe(b.enc)
    expect(a.ct).not.toBe(b.ct)
  })
  it('fingerprint(pub) in the browser equals the server and host spellings', async () => {
    const key = newHostKey()
    expect(await bundle.fingerprint(key.pub)).toBe(key.fingerprint)
    expect(groupFingerprint(key.fingerprint)).toBe(hostScript.groupFingerprint(key.fingerprint))
    expect(hpkeInfo('a', 'd', 'n', 'f')).toBe(hostScript.dropInfo('a', 'd', 'n', 'f'))
    expect(hpkeInfo('a', 'd', 'n', 'f')).toBe(`${hostScript.INFO_PREFIX}a|d|n|f`)
    // One name rule on both sides of the wire (and in the table CHECK).
    expect(hostScript.NAME_RE.source).toBe(DROP_NAME_RE.source)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Round 2: rotation end to end, name/agent binding, key-change signals, pinned guards
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/** The real host script talking to the real tools: JSON-RPC in, invokeTool out, the same result shapes /mcp returns. */
function bridge(which: 'x' | 'y' = 'x'): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params: { name: string; arguments: Record<string, unknown> } }
    const r = await invokeTool(agentAuth(which), env, body.params.name, body.params.arguments, 'https://pot.test')
    const result = r.ok
      ? { content: [{ type: 'text', text: JSON.stringify({ ok: true, result: r.result }) }], structuredContent: r.result }
      : { isError: true, content: [], structuredContent: { ok: false, error: r.error } }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 })
  }) as typeof fetch
}

interface Host { home: string; key: HostKey; secrets: string; out: string[]; pull: () => Promise<number> }
async function hostFor(which: 'x' | 'y' = 'x'): Promise<Host> {
  const home = mkdtempSync(join(tmpdir(), 'secure-drop-e2e-'))
  const cfg = join(home, '.config', 'mupot')
  rmSync(cfg, { recursive: true, force: true })
  const { mkdirSync } = await import('node:fs')
  mkdirSync(cfg, { recursive: true, mode: 0o700 })
  writeFileSync(join(cfg, 'mumega.token'), 'tok_e2e_0123456789abcdef\n', { mode: 0o600 })
  chmodSync(join(cfg, 'mumega.token'), 0o600)
  const out: string[] = []
  const sink = (l: string) => { out.push(l) }
  expect(await hostScript.main(['keygen'], { home, env: {}, out: sink })).toBe(0)
  expect(await hostScript.main(['register'], { home, env: {}, fetch: bridge(which), out: sink })).toBe(0)
  const k = hostScript.loadHostKey(home) as { privateKey: KeyObject; publicB64u: string; fingerprint: string }
  const agent = which === 'x' ? 'agent-x' : 'agent-y'
  return {
    home, out, key: { privateKey: k.privateKey, pub: k.publicB64u, fingerprint: k.fingerprint }, secrets: join(home, '.mupot', 'secrets', agent),
    pull: () => hostScript.main(['pull'], { home, env: {}, fetch: bridge(which), out: sink }) as Promise<number>,
  }
}

describe('P1-1: rotation end to end (real host script, real tools, real page ceremony)', () => {
  it('revoke -> re-request -> provide -> ONE pull: the new credential survives and the old revoke resolves', async () => {
    const host = await hostFor()
    try {
      const a = await enrol('mem-owner', identities.owner)
      const m1 = await request('cloud-key')
      expect((await decide(m1, a, { decision: 'provide', ...(await sealFor(host.key, m1.dropId, 'credential-v1')) })).status).toBe(200)
      expect(await host.pull()).toBe(0)
      expect(readFileSync(join(host.secrets, 'cloud-key'), 'utf8')).toBe('credential-v1')
      expect(dropStatus(m1.dropId)).toBe('delivered')
      // the human revokes v1, then the agent asks again and the human provides v2
      expect((await tool(ownerAuth(), 'secure_drop_revoke', { name: 'cloud-key' })).ok).toBe(true)
      const m2 = await request('cloud-key')
      expect((await decide(m2, a, { decision: 'provide', ...(await sealFor(host.key, m2.dropId, 'credential-v2')) })).status).toBe(200)
      // the server omits the stale revoke while a newer drop of that name is ready
      const listed = await tool(agentAuth(), 'secure_drop_pull', {})
      expect(listed.result?.revokes).toEqual([])
      expect((listed.result?.drops as unknown[]).length).toBe(1)
      expect(await host.pull()).toBe(0)
      expect(readFileSync(join(host.secrets, 'cloud-key'), 'utf8')).toBe('credential-v2')
      expect(dropStatus(m2.dropId)).toBe('delivered')
      // the next pull closes v1's revoke (its file was replaced by v2), and still leaves v2 alone
      expect(await host.pull()).toBe(0)
      expect(dropStatus(m1.dropId)).toBe('revoked')
      expect(readFileSync(join(host.secrets, 'cloud-key'), 'utf8')).toBe('credential-v2')
      expect((await tool(agentAuth(), 'secure_drop_pull', {})).result?.revokes).toEqual([])
    } finally { rmSync(host.home, { recursive: true, force: true }) }
  })
  it('if the newer drop expires unpulled, the OLD revoke comes back (the old file still needs its shred)', async () => {
    const host = await hostFor()
    try {
      const a = await enrol('mem-owner', identities.owner)
      const m1 = await request('cloud-key')
      expect((await decide(m1, a, { decision: 'provide', ...(await sealFor(host.key, m1.dropId, 'credential-v1')) })).status).toBe(200)
      expect(await host.pull()).toBe(0)
      expect((await tool(ownerAuth(), 'secure_drop_revoke', { name: 'cloud-key' })).ok).toBe(true)
      const m2 = await request('cloud-key')
      expect((await decide(m2, a, { decision: 'provide', ...(await sealFor(host.key, m2.dropId, 'credential-v2')) })).status).toBe(200)
      expect((await tool(agentAuth(), 'secure_drop_pull', {})).result?.revokes).toEqual([])
      harness.sqlite.prepare("UPDATE secure_drops SET retain_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(m2.dropId)
      const after = await tool(agentAuth(), 'secure_drop_pull', {})
      expect(after.result?.drops).toEqual([])
      expect(after.result?.revokes).toEqual([{ id: m1.dropId, name: 'cloud-key' }])
      expect(await host.pull()).toBe(0)
      expect(readdirSync(host.secrets).includes('cloud-key')).toBe(false)
    } finally { rmSync(host.home, { recursive: true, force: true }) }
  })
})

describe('P1-2: name and agent are bound into the ciphertext; the host writes only its own files', () => {
  it('the page carries the agent id and name the sealer binds, and the script builds the v2 info', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request('db-pass')
    const html = await (await hit(m.path)).text()
    expect(html).toContain('data-agent-id="agent-x"')
    expect(html).toContain('data-name="db-pass"')
    expect(html).toContain(`data-drop-id="${m.dropId}"`)
    expect(html).toContain("'mupot-secure-drop/v2|'+agentId+'|'+dropId+'|'+dropName+'|'+fpOk")
    expect(html).not.toContain('mupot-secure-drop/v1')
  })
  it('a drop RELABELLED in the database (another name) does not open on the host: no file, no ack, still pullable', async () => {
    const host = await hostFor()
    try {
      const a = await enrol('mem-owner', identities.owner)
      const m = await request('dev-db')
      expect((await decide(m, a, { decision: 'provide', ...(await sealFor(host.key, m.dropId, 'dev-secret')) })).status).toBe(200)
      harness.sqlite.prepare("UPDATE secure_drops SET name = 'prod-db' WHERE id = ?").run(m.dropId) // a compromised D1 writer
      expect(await host.pull()).toBe(1)
      expect(host.out.join('\n')).toMatch(/decryption failed/)
      expect(existsSync(host.secrets) ? readdirSync(host.secrets).filter((f) => !f.startsWith('.')) : []).toEqual([])
      expect(dropStatus(m.dropId)).toBe('ready')
    } finally { rmSync(host.home, { recursive: true, force: true }) }
  })
  it('a server-ordered shred of a file the host did not create is refused (shared host, one Unix user)', async () => {
    const host = await hostFor()
    try {
      const a = await enrol('mem-owner', identities.owner)
      const m = await request('victim-key')
      expect((await decide(m, a, { decision: 'provide', ...(await sealFor(host.key, m.dropId)) })).status).toBe(200)
      expect(await host.pull()).toBe(0)
      // another agent's / the operator's file with the same name in the same tree would be refused: simulate by editing ours
      writeFileSync(join(host.secrets, 'victim-key'), 'replaced-by-someone-else', { mode: 0o600 })
      expect((await tool(ownerAuth(), 'secure_drop_revoke', { name: 'victim-key' })).ok).toBe(true)
      expect(await host.pull()).toBe(1)
      expect(readFileSync(join(host.secrets, 'victim-key'), 'utf8')).toBe('replaced-by-someone-else')
    } finally { rmSync(host.home, { recursive: true, force: true }) }
  })
})

describe('P1-3: key changes are visible to the human and to the governors', () => {
  const pageText = async (m: Request): Promise<string> => (await hit(m.path)).text()
  it('the page shows when the key was registered, says to compare OUT OF BAND, and does not cry wolf for an old first key', async () => {
    const key = newHostKey()
    await registerKey(key)
    harness.sqlite.prepare("UPDATE host_keys SET created_at = datetime('now', '-10 days')").run()
    const m = await request()
    const html = await pageText(m)
    expect(html).toMatch(/This host key was registered 10 days ago/)
    expect(html).toMatch(/host operator, out of band/)
    expect(html).toMatch(/Do NOT take the reference from the agent/)
    expect(html).not.toContain('WARNING')
    expect(html).not.toContain('class="card status-bad"')
  })
  it('a key that CHANGED in the last 24 hours gets a prominent warning', async () => {
    await registerKey(newHostKey())
    await registerKey(newHostKey())
    const m = await request()
    const html = await pageText(m)
    expect(html).toContain('WARNING: this agent&#39;s key CHANGED in the last 24 hours')
    expect(html).toContain('It replaced 1 earlier key')
    expect(html).toContain('class="card status-bad"')
  })
  it('an agent re-keyed more than once is warned about even when the last change is old', async () => {
    await registerKey(newHostKey())
    await registerKey(newHostKey())
    await registerKey(newHostKey())
    harness.sqlite.prepare("UPDATE host_keys SET created_at = datetime('now', '-5 days')").run()
    const m = await request()
    const html = await pageText(m)
    expect(html).toContain('WARNING: this agent has been re-keyed 2 times')
    expect(html).not.toContain('CHANGED in the last 24 hours')
  })
  it('keyAssurance is pure and bounded: first fresh key = no warning; rotation <24h = warning; >=2 rotations = warning', () => {
    const now = Date.parse('2026-10-12T12:00:00.000Z')
    expect(keyAssurance({ liveCreatedAt: '2026-10-12T11:30:00.000Z', replacedCount: 0 }, now).warn).toBe(false)
    expect(keyAssurance({ liveCreatedAt: '2026-10-12T11:30:00.000Z', replacedCount: 1 }, now).warn).toBe(true)
    expect(keyAssurance({ liveCreatedAt: '2026-10-10T11:30:00.000Z', replacedCount: 1 }, now).warn).toBe(false)
    expect(keyAssurance({ liveCreatedAt: '2026-10-01T11:30:00.000Z', replacedCount: 2 }, now).warn).toBe(true)
  })
  it('every registration and rotation notifies the governors\' inbox (agents owned by squad/org admins), and writes a receipt', async () => {
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, owner_member_id) VALUES
        ('agent-gov', 'squad-a', 'agent-gov', 'Governor Assistant', 'r', 'm', 'active', 'mem-sqadmin'),
        ('agent-plain', 'squad-a', 'agent-plain', 'Plain Assistant', 'r', 'm', 'active', 'mem-plain'),
        ('agent-gov-b', 'squad-b', 'agent-gov-b', 'Other Squad Assistant', 'r', 'm', 'active', 'mem-sqadmin-b');
    `)
    const inbox = (to: string): Array<{ body: string; from_agent: string; kind: string }> =>
      all('SELECT body, from_agent, kind FROM agent_messages WHERE to_agent = ? ORDER BY seq', to)
    const k1 = newHostKey()
    const r1 = await tool(agentAuth(), 'host_key_register', { public_key: k1.pub })
    expect(r1.result).toMatchObject({ governors_found: 1, governors_notified: 1 })
    expect(inbox('agent-gov')).toHaveLength(1)
    expect(inbox('agent-gov')[0].body).toContain(groupFingerprint(k1.fingerprint))
    expect(inbox('agent-gov')[0].body).toMatch(/registered/)
    expect(inbox('agent-gov')[0].body).toMatch(/OUT OF BAND/)
    expect(inbox('agent-gov')[0].from_agent).toBe('mupot-secure-drop')
    expect(inbox('agent-plain')).toHaveLength(0) // a plain member is not a governor
    expect(inbox('agent-gov-b')).toHaveLength(0) // admin of ANOTHER squad is not a governor of this agent
    // the same key again says nothing
    await tool(agentAuth(), 'host_key_register', { public_key: k1.pub })
    expect(inbox('agent-gov')).toHaveLength(1)
    // a rotation says ROTATED
    const k2 = newHostKey()
    await tool(agentAuth(), 'host_key_register', { public_key: k2.pub })
    expect(inbox('agent-gov')).toHaveLength(2)
    expect(inbox('agent-gov')[1].body).toMatch(/ROTATED/)
    expect(inbox('agent-gov')[1].body).toContain(groupFingerprint(k2.fingerprint))
    expect(count('mutation_audit_entries', "operation = 'host_key_register'")).toBe(2)
  })
  it('a governor with no inbox agent is found but not reachable: the registration still works and the result says so', async () => {
    const r = await tool(agentAuth(), 'host_key_register', { public_key: newHostKey().pub })
    expect(r.ok).toBe(true)
    expect(r.result).toMatchObject({ governors_found: 1, governors_notified: 0 }) // mem-sqadmin governs squad-a but owns no agent
  })
})

describe('P2s', () => {
  it('the password field is not a login form: new-password, password-manager opt-outs, and success does not hide the form', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const html = await (await hit(m.path)).text()
    expect(html).toMatch(/<input id="secret" type="password" autocomplete="new-password" data-1p-ignore data-lpignore="true"/)
    expect(html).not.toContain('autocomplete="off"')
    expect(html).not.toContain('form.hidden')
    expect(html).not.toMatch(/hidden=true/)
  })
  it('a paused agent cannot be provided for: the page closes and a decision is refused without burning the link', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    const s = await sealFor(key, m.dropId)
    const csrf = await getCsrf(m)
    const ch = await challenge(m, csrf, { decision: 'provide', ...s })
    harness.sqlite.prepare("UPDATE agents SET status = 'paused' WHERE id = 'agent-x'").run()
    expect((await hit(m.path)).status).not.toBe(200)
    const res = await decide(m, a, { decision: 'provide', ...s }, { challenge: ch, csrf })
    expect(res.status).toBe(409)
    expect(momentStatus(m.momentId)).toBe('pending')
    expect(dropStatus(m.dropId)).toBe('requested')
  })
})

describe('batch guards pinned with tests that bypass the route pre-checks', () => {
  async function setupDecide(): Promise<{ key: HostKey; m: Request; passkeyId: string; sealed: { encB64u: string; ctB64u: string; digestHex: string } }> {
    const key = newHostKey()
    await registerKey(key)
    const m = await request()
    await enrol('mem-owner', identities.owner)
    const passkeyId = one<{ id: string }>("SELECT id FROM member_passkeys WHERE member_id = 'mem-owner'")!.id
    const s = await sealFor(key, m.dropId)
    return { key, m, passkeyId, sealed: { encB64u: s.enc, ctB64u: s.ct, digestHex: await sealedDigest(Buffer.from(s.enc, 'base64url'), Buffer.from(s.ct, 'base64url')) } }
  }
  const direct = async (g: Awaited<ReturnType<typeof setupDecide>>, over: { token?: string } = {}): Promise<boolean> =>
    decideDrop(env, {
      momentId: g.m.momentId, token: over.token ?? g.m.token, drop: (await loadDrop(env, g.m.dropId))!, decision: 'provide', memberId: 'mem-owner',
      passkeyId: g.passkeyId, sealed: g.sealed, fingerprint: g.key.fingerprint,
    }, Date.now())
  const untouched = (g: Awaited<ReturnType<typeof setupDecide>>): void => {
    expect(momentStatus(g.m.momentId)).toBe('pending')
    expect(dropStatus(g.m.dropId)).toBe('requested')
    expect(one<{ ct_b64u: string | null }>('SELECT ct_b64u FROM secure_drops WHERE id = ?', g.m.dropId)?.ct_b64u).toBeNull()
  }
  it('the consume query checks the LINK HASH: a wrong link token consumes nothing and stores nothing', async () => {
    const g = await setupDecide()
    expect(await direct(g, { token: 'not-the-link-token' })).toBe(false)
    untouched(g)
    expect(await direct(g)).toBe(true)
  })
  it('the consume query checks the PASSKEY is unrevoked', async () => {
    const g = await setupDecide()
    harness.sqlite.prepare("UPDATE member_passkeys SET revoked_at = datetime('now') WHERE id = ?").run(g.passkeyId)
    expect(await direct(g)).toBe(false)
    untouched(g)
  })
  it('the consume query checks the passkey\'s LOGIN IDENTITY is live', async () => {
    const g = await setupDecide()
    harness.sqlite.prepare("UPDATE human_login_identities SET revoked_at = datetime('now') WHERE id = ?").run(identities.owner)
    expect(await direct(g)).toBe(false)
    untouched(g)
  })
  it('the consume query checks the moment is unexpired and the request is open', async () => {
    const g = await setupDecide()
    harness.sqlite.prepare("UPDATE secure_moments SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(g.m.momentId)
    expect(await direct(g)).toBe(false)
    expect(dropStatus(g.m.dropId)).toBe('requested')
  })
  it('ack checks the drop\'s OWN agent even when the host-key join would pass (inconsistent row: key of agent-y on agent-x\'s drop)', async () => {
    const kx = newHostKey()
    await registerKey(kx, 'x')
    const m = await request()
    const a = await enrol('mem-owner', identities.owner)
    expect((await decide(m, a, { decision: 'provide', ...(await sealFor(kx, m.dropId)) })).status).toBe(200)
    await registerKey(newHostKey(), 'y')
    const yKey = one<{ id: string }>("SELECT id FROM host_keys WHERE agent_id = 'agent-y' AND revoked_at IS NULL")!.id
    harness.sqlite.prepare('UPDATE secure_drops SET host_key_id = ? WHERE id = ?').run(yKey, m.dropId)
    // agent-y's live key now "matches" the drop's host_key_id: only the drop's agent_id stands between y and the ack
    expect(await tool(agentAuth('y'), 'secure_drop_ack', { id: m.dropId })).toMatchObject({ ok: false, error: 'nothing_to_ack' })
    expect(dropStatus(m.dropId)).toBe('ready')
  })
  it('revoke refuses an agent-bound token even when its member row passes the active-human check', async () => {
    const key = newHostKey()
    await registerKey(key)
    const m = await request('cloud-key')
    const a = await enrol('mem-owner', identities.owner)
    expect((await decide(m, a, { decision: 'provide', ...(await sealFor(key, m.dropId)) })).status).toBe(200)
    // a token whose member row IS a human (memberIsActiveHuman passes) but which is welded to an agent: only boundAgentId refuses it
    const bound: AuthContext = { userId: 'u-owner', email: 'owner@x.test', role: 'owner', tenant: TENANT, channel: 'workspace', memberId: 'mem-owner', tokenId: 'tok-1', boundAgentId: 'agent-x' }
    expect(await tool(bound, 'secure_drop_revoke', { name: 'cloud-key' })).toMatchObject({ ok: false, error: 'human_required' })
    expect(dropStatus(m.dropId)).toBe('ready')
  })
})
