// tests/access-approve.test.ts — the Access approve page (src/access/*): JWT verification, member
// resolution, flag/host/CSRF gates, the seed request -> approve flow (exactly once), and elevation
// narrowing. Real migrated schema (sqlite-d1 harness); the JWKS is a test key served through a stubbed
// fetch. Contract: docs/architecture/access-approve-page.md.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { invokeTool } from '../src/mcp/index' // first: the mcp/seeds modules form an import cycle that only resolves from mcp/index
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { verifyAccessJwt, resetAccessJwksCache, type AccessJwtConfig } from '../src/access/jwt'
import { approveApp } from '../src/access/routes'
import { createAgentSession } from '../src/auth/agent-sessions'
import { createElevationRequest } from '../src/auth/elevation'
import { approveUrl } from '../src/access/config'

const TENANT = 'tenant-a'
const TEAM = 'acme.cloudflareaccess.com'
const AUD = 'aud-tag-123'
const HOST = 'mupot.example.test'
const MASTER = 'a1'.repeat(32)
const seedText = readFileSync(join(__dirname, '..', 'docs', 'examples', 'seeds', 'mumega-com.seed.yaml'), 'utf8')

// ── test JWKS + signer ───────────────────────────────────────────────────────────────────────────
interface TestKey { kid: string; priv: CryptoKey; jwk: JsonWebKey }
async function makeKey(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { kid, priv: pair.privateKey, jwk: { ...jwk, kid, use: 'sig', alg: 'RS256' } }
}
const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b)
  let s = ''
  for (const x of u) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64uJson = (o: unknown): string => b64u(new TextEncoder().encode(JSON.stringify(o)))

let key: TestKey
let otherKey: TestKey
beforeAll(async () => {
  key = await makeKey('k1')
  otherKey = await makeKey('k1') // same kid, different key material: a forged signature
})

interface Claims { [k: string]: unknown }
const nowS = (): number => Math.floor(Date.now() / 1000)
// One login per test: CSRF tokens bind to the login's iat, so tests that reuse a token pin it.
let loginIat = nowS()
async function sign(over: Claims = {}, opts: { key?: TestKey; header?: Record<string, unknown> } = {}): Promise<string> {
  const k = opts.key ?? key
  const header = { alg: 'RS256', kid: k.kid, typ: 'JWT', ...opts.header }
  const payload = { iss: `https://${TEAM}`, aud: [AUD], exp: nowS() + 600, iat: loginIat, email: 'owner@x.test', sub: 'sub-owner', ...over }
  const data = `${b64uJson(header)}.${b64uJson(payload)}`
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, k.priv, new TextEncoder().encode(data))
  return `${data}.${b64u(sig)}`
}
const jwksResponse = (keys: TestKey[]): Response => new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), { status: 200 })
const cfg: AccessJwtConfig = { teamHost: TEAM, aud: AUD, maxAgeSeconds: 60 }

beforeEach(() => { resetAccessJwksCache(); loginIat = nowS() })

// ── JWT verification ─────────────────────────────────────────────────────────────────────────────
describe('verifyAccessJwt', () => {
  const deps = () => ({ fetchImpl: async () => jwksResponse([key]) })
  it('accepts a valid token and returns the human claims', async () => {
    const r = await verifyAccessJwt(await sign(), cfg, deps())
    expect(r).toMatchObject({ ok: true, claims: { email: 'owner@x.test', sub: 'sub-owner' } })
  })
  it('accepts aud as a bare string', async () => {
    expect((await verifyAccessJwt(await sign({ aud: AUD }), cfg, deps())).ok).toBe(true)
  })
  it.each([
    ['missing header', undefined, 'missing'],
    ['garbage', 'not.a.jwt.at.all', 'malformed'],
  ])('%s', async (_n, tok, reason) => {
    expect(await verifyAccessJwt(tok, cfg, deps())).toEqual({ ok: false, reason })
  })
  it('refuses the wrong audience (exact match, no prefix/substring)', async () => {
    expect(await verifyAccessJwt(await sign({ aud: ['aud-tag-1234'] }), cfg, deps())).toEqual({ ok: false, reason: 'bad_audience' })
    expect(await verifyAccessJwt(await sign({ aud: [] }), cfg, deps())).toEqual({ ok: false, reason: 'bad_audience' })
  })
  it('refuses the wrong issuer', async () => {
    expect(await verifyAccessJwt(await sign({ iss: 'https://evil.cloudflareaccess.com' }), cfg, deps())).toEqual({ ok: false, reason: 'bad_issuer' })
  })
  it('refuses an expired token', async () => {
    expect(await verifyAccessJwt(await sign({ exp: nowS() - 1 }), cfg, deps())).toEqual({ ok: false, reason: 'expired' })
  })
  it('refuses a stale iat (older than the freshness window) and a future iat', async () => {
    expect(await verifyAccessJwt(await sign({ iat: nowS() - 61 }), cfg, deps())).toEqual({ ok: false, reason: 'stale' })
    expect(await verifyAccessJwt(await sign({ iat: nowS() + 120 }), cfg, deps())).toEqual({ ok: false, reason: 'not_yet_valid' })
  })
  it('refuses a bad signature (same kid, other key)', async () => {
    expect(await verifyAccessJwt(await sign({}, { key: otherKey }), cfg, deps())).toEqual({ ok: false, reason: 'bad_signature' })
  })
  it('refuses alg none / HS256 / crit headers', async () => {
    const t = await sign({}, { header: { alg: 'none' } })
    expect(await verifyAccessJwt(t, cfg, deps())).toEqual({ ok: false, reason: 'unsupported_alg' })
    expect(await verifyAccessJwt(await sign({}, { header: { alg: 'HS256' } }), cfg, deps())).toEqual({ ok: false, reason: 'unsupported_alg' })
    expect(await verifyAccessJwt(await sign({}, { header: { crit: ['x'] } }), cfg, deps())).toEqual({ ok: false, reason: 'unsupported_alg' })
  })
  it('refuses a token naming no human (service-token shape: no email)', async () => {
    expect(await verifyAccessJwt(await sign({ email: undefined }), cfg, deps())).toEqual({ ok: false, reason: 'missing_claims' })
  })
  it('refetches the JWKS once on an unknown kid (rotation) but not more than once per 30s', async () => {
    const k2 = await makeKey('k2')
    let calls = 0
    let current = [key]
    const fetchImpl = async () => { calls++; return jwksResponse(current) }
    const t0 = Date.now()
    expect((await verifyAccessJwt(await sign(), cfg, { fetchImpl, nowMs: t0 })).ok).toBe(true)
    expect(calls).toBe(1)
    current = [key, k2]
    const rotated = await sign({}, { key: k2 })
    // Within 30s of the last fetch: no refetch, the unknown kid is refused.
    expect(await verifyAccessJwt(rotated, cfg, { fetchImpl, nowMs: t0 + 5000 })).toEqual({ ok: false, reason: 'unknown_key' })
    expect(calls).toBe(1)
    expect((await verifyAccessJwt(rotated, cfg, { fetchImpl, nowMs: t0 + 31_000 })).ok).toBe(true)
    expect(calls).toBe(2)
  })
  it('fails closed when the JWKS cannot be fetched', async () => {
    expect(await verifyAccessJwt(await sign(), cfg, { fetchImpl: async () => new Response('no', { status: 500 }) })).toEqual({ ok: false, reason: 'jwks_unavailable' })
  })
})

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
let harness: SqliteD1Harness
let env: Env
const root = new Hono<{ Bindings: Env }>()
root.route('/approve', approveApp)

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER,
    ACCESS_APPROVE_ENABLED: '1', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_CANONICAL_HOST: HOST,
    ...over,
  } as Env
}

function setupDb(): void {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}');
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO users (id, email, role) VALUES ('u-owner', 'owner@x.test', 'owner');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('mem-owner', 'owner@x.test', 'Owner', 'active', '${TENANT}'),
      ('mem-plain', 'plain@x.test', 'Plain', 'active', '${TENANT}'),
      ('mem-susp', 'susp@x.test', 'Susp', 'suspended', '${TENANT}'),
      ('mem-agent', 'agent@x.test', 'Agent Member', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-x', 'squad-a', 'agent-x', 'Agent X', 'r', 'm', 'active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-x', 'mem-agent', datetime('now'));
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-p', 'mem-plain', 'squad', 'squad-a', 'member');
  `)
  env = baseEnv()
}
beforeEach(setupDb)
afterEach(() => { harness.close(); vi.unstubAllGlobals() })

function stubJwks(keys: TestKey[] = [key]): void {
  vi.stubGlobal('fetch', vi.fn(async () => jwksResponse(keys)))
}

interface Req { method?: string; jwt?: string | null; origin?: string | null; host?: string; form?: Record<string, string | string[]>; extra?: Record<string, string> }
async function hit(path: string, r: Req = {}, e: Env = env): Promise<Response> {
  stubJwks()
  const headers = new Headers(r.extra)
  const jwt = r.jwt === undefined ? await sign() : r.jwt
  if (jwt) headers.set('cf-access-jwt-assertion', jwt)
  const method = r.method ?? 'GET'
  let body: URLSearchParams | undefined
  if (method === 'POST') {
    const origin = r.origin === undefined ? `https://${HOST}` : r.origin
    if (origin) headers.set('origin', origin)
    body = new URLSearchParams()
    for (const [k, v] of Object.entries(r.form ?? {})) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x)
    headers.set('content-type', 'application/x-www-form-urlencoded')
  }
  return root.fetch(new Request(`https://${r.host ?? HOST}${path}`, { method, headers, body }), e)
}
const csrfOf = (html: string): string => {
  const m = /name="csrf" value="([0-9a-f]{64})"/.exec(html)
  if (!m) throw new Error('no csrf in page')
  return m[1]
}
const count = (t: string, where = '1=1') => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`).get() as { n: number }).n

// ── gates ────────────────────────────────────────────────────────────────────────────────────────
describe('gates', () => {
  it('flag unset => every /approve/* route is a 404, JWT or not, and the real app agrees', async () => {
    const off = baseEnv({ ACCESS_APPROVE_ENABLED: undefined })
    for (const p of ['/approve/seed/x', '/approve/elevation/x', '/approve/', '/approve/anything/else']) {
      expect((await hit(p, {}, off)).status).toBe(404)
      expect((await hit(p, { jwt: null }, off)).status).toBe(404)
      expect((await hit(p, { method: 'POST', form: { decision: 'approve' } }, off)).status).toBe(404)
    }
    expect((await hit('/approve/seed/x', {}, { ...off, ACCESS_APPROVE_ENABLED: 'false' } as Env)).status).toBe(404)
  })
  it('is mounted before the dashboard catch-all in the real app', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    const mount = src.indexOf("app.route('/approve', approveApp)")
    expect(mount).toBeGreaterThan(0)
    expect(mount).toBeLessThan(src.indexOf('app.route(ROUTES.dashboard, dashboardApp)'))
  })
  it('enabled but not fully configured => 503, never an open page', async () => {
    expect((await hit('/approve/seed/x', {}, baseEnv({ ACCESS_AUD: undefined }))).status).toBe(503)
    expect((await hit('/approve/seed/x', {}, baseEnv({ ACCESS_TEAM_DOMAIN: 'evil.example.com' }))).status).toBe(503)
  })
  it('missing / bad JWT => 403; wrong host => 403 even with a valid JWT', async () => {
    expect((await hit('/approve/seed/x', { jwt: null })).status).toBe(403)
    expect((await hit('/approve/seed/x', { jwt: await sign({}, { key: otherKey }) })).status).toBe(403)
    expect((await hit('/approve/seed/x', { host: 'mupot.workers.dev' })).status).toBe(403)
    expect((await hit('/approve/seed/x', { host: `${HOST}.evil.test` })).status).toBe(403)
  })
  it('a stale iat is refused with guidance', async () => {
    const res = await hit('/approve/seed/x', { jwt: await sign({ iat: nowS() - 300 }) })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('older than the approval freshness window')
  })
})

// ── member resolution ────────────────────────────────────────────────────────────────────────────
describe('member resolution', () => {
  const as = async (email: string, sub: string) => hit('/approve/seed/none', { jwt: await sign({ email, sub }) })
  it('an active human org admin reaches the page (unknown id is a plain 404, not a refusal)', async () => {
    expect((await as('owner@x.test', 'sub-owner')).status).toBe(404)
  })
  it('refuses an agent-welded member row even though its email matches', async () => {
    const res = await as('agent@x.test', 'sub-agent')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('cannot approve')
    expect(count('human_login_identities')).toBe(0)
  })
  it('refuses a suspended member and an unknown identity', async () => {
    expect((await as('susp@x.test', 'sub-susp')).status).toBe(403)
    expect((await as('nobody@x.test', 'sub-nobody')).status).toBe(403)
  })
  it('a plain member is not an org admin: seed pages read as not found', async () => {
    expect((await as('plain@x.test', 'sub-plain')).status).toBe(404)
  })
  it('an identity already bound to member A cannot be used by an email that names member B', async () => {
    // First login binds sub-owner to mem-owner via the guarded attach; a second login with the same sub
    // and a different email still resolves to mem-owner (the join key wins), never to the emailed member.
    await hit('/approve/elevation/none', { jwt: await sign({ email: 'owner@x.test', sub: 'sub-owner' }), method: 'POST', form: { decision: 'deny' } })
    const res = await as('plain@x.test', 'sub-owner')
    expect(res.status).toBe(404) // mem-owner (admin) resolved, unknown id
  })
})

// ── seed: request -> approve exactly once ────────────────────────────────────────────────────────
const agentAuth = (): AuthContext => ({
  userId: 'mem-agent', email: 'agent@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-agent',
  capabilities: [{ member_id: 'mem-agent', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant], boundAgentId: 'agent-x',
})
const fileSeed = (text = seedText, a: AuthContext = agentAuth(), e: Env = env) => invokeTool(a, e, 'seed_attach_request', { seed: text }, 'https://pot.test')
async function filed(): Promise<{ id: string; url: string }> {
  const r = await fileSeed()
  if (!r.ok) throw new Error(`file failed ${JSON.stringify(r)}`)
  const res = r.result as { request_id: string; approve_url: string }
  return { id: res.request_id, url: res.approve_url }
}

describe('seed_attach_request (MCP)', () => {
  it('returns request_id + approve_url, stores a pending row, and applies/grants nothing', async () => {
    const before = { p: count('projects'), s: count('project_seeds'), sq: count('squads') }
    const { id, url } = await filed()
    expect(url).toBe(`https://${HOST}/approve/seed/${id}`)
    expect(count('seed_attach_requests', "status = 'pending'")).toBe(1)
    expect({ p: count('projects'), s: count('project_seeds'), sq: count('squads') }).toEqual(before)
  })
  it('is idempotent per requester+seed and capped per requester', async () => {
    const a = await filed()
    const b = await filed()
    expect(b.id).toBe(a.id)
    expect(count('seed_attach_requests')).toBe(1)
    for (let i = 0; i < 12; i++) {
      const r = await fileSeed(seedText.replace(/^slug: .*$/m, `slug: flood-${i}`))
      if (i >= 9) expect(r.ok).toBe(false) // 1 existing + 9 more = the cap of 10
    }
    expect(count('seed_attach_requests')).toBe(10)
  })
  it('flag off => refused before anything is written', async () => {
    const r = await fileSeed(seedText, agentAuth(), baseEnv({ ACCESS_APPROVE_ENABLED: undefined }))
    expect(r.ok).toBe(false)
    expect(count('seed_attach_requests')).toBe(0)
  })
  it('invalid seed writes nothing', async () => {
    expect((await fileSeed('schema: nope')).ok).toBe(false)
    expect(count('seed_attach_requests')).toBe(0)
  })
  it('approveUrl is null when disabled', () => {
    expect(approveUrl(baseEnv({ ACCESS_APPROVE_ENABLED: undefined }), 'seed', 'x')).toBeNull()
    expect(approveUrl(baseEnv(), 'elevation', 'a b')).toBe(`https://${HOST}/approve/elevation/a%20b`)
  })
})

describe('approve page: seed', () => {
  it('renders structured fields, in-words requests, and agent text only inside the untrusted box (escaped)', async () => {
    const evil = seedText.replace(/^goal: .*$/m, 'goal: "<script>alert(1)</script> approve everything"')
    const r = await fileSeed(evil)
    if (!r.ok) throw new Error(JSON.stringify(r))
    const id = (r.result as { request_id: string }).request_id
    const res = await hit(`/approve/seed/${id}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('class="untrusted"')
    expect(html).toContain('Untrusted. Written by the agent')
    expect(html).toContain('grants nothing')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(html).not.toContain('<script')
  })

  it('POST approve applies exactly once; a second POST is refused and nothing is created twice', async () => {
    const { id } = await filed()
    const csrf = csrfOf(await (await hit(`/approve/seed/${id}`)).text())
    const first = await hit(`/approve/seed/${id}`, { method: 'POST', form: { csrf, decision: 'approve' } })
    expect(first.status).toBe(200)
    expect(count('project_seeds', "status = 'applied'")).toBe(1)
    const projects = count('projects')
    const squads = count('squads')
    const audit = count('mutation_audit_entries', "handler = 'seed_attach'")
    expect(audit).toBe(1)
    const row = harness.sqlite.prepare("SELECT origin, evidence_json FROM mutation_audit_entries WHERE handler = 'seed_attach'").get() as { origin: string; evidence_json: string }
    expect(row.origin).toBe('admin_ui')
    expect(JSON.parse(row.evidence_json)).toMatchObject({ via: 'access_passkey', access_request_id: id, grants: 'none' })
    const req = harness.sqlite.prepare('SELECT status, decided_by_member_id, decided_via FROM seed_attach_requests WHERE id = ?').get(id)
    expect(req).toEqual({ status: 'applied', decided_by_member_id: 'mem-owner', decided_via: 'access_passkey' })

    const second = await hit(`/approve/seed/${id}`, { method: 'POST', form: { csrf, decision: 'approve' } })
    expect(second.status).toBe(409)
    expect([count('projects'), count('squads'), count('mutation_audit_entries', "handler = 'seed_attach'")]).toEqual([projects, squads, audit])
  })

  it('two concurrent approvals: exactly one applies', async () => {
    const { id } = await filed()
    const csrf = csrfOf(await (await hit(`/approve/seed/${id}`)).text())
    const results = await Promise.all([
      hit(`/approve/seed/${id}`, { method: 'POST', form: { csrf, decision: 'approve' } }),
      hit(`/approve/seed/${id}`, { method: 'POST', form: { csrf, decision: 'approve' } }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(count('project_seeds', "status = 'applied'")).toBe(1)
    expect(count('mutation_audit_entries', "handler = 'seed_attach'")).toBe(1)
  })

  it('deny consumes the request, writes a receipt, and a later approve is refused', async () => {
    const { id } = await filed()
    const csrf = csrfOf(await (await hit(`/approve/seed/${id}`)).text())
    expect((await hit(`/approve/seed/${id}`, { method: 'POST', form: { csrf, decision: 'deny' } })).status).toBe(200)
    const e = harness.sqlite.prepare("SELECT evidence_json FROM mutation_audit_entries WHERE operation = 'seed_request_deny'").get() as { evidence_json: string }
    expect(JSON.parse(e.evidence_json)).toMatchObject({ via: 'access_passkey', decision: 'deny' })
    expect((await hit(`/approve/seed/${id}`, { method: 'POST', form: { csrf, decision: 'approve' } })).status).toBe(409)
    expect(count('project_seeds')).toBe(0)
  })

  it('an expired request cannot be approved or viewed', async () => {
    const { id } = await filed()
    const csrf = csrfOf(await (await hit(`/approve/seed/${id}`)).text())
    harness.sqlite.prepare("UPDATE seed_attach_requests SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id)
    expect((await hit(`/approve/seed/${id}`)).status).toBe(410)
    expect((await hit(`/approve/seed/${id}`, { method: 'POST', form: { csrf, decision: 'approve' } })).status).toBe(409)
    expect(count('project_seeds')).toBe(0)
  })

  it('a tampered stored seed is refused (digest no longer matches) and nothing is applied', async () => {
    const { id } = await filed()
    const csrf = csrfOf(await (await hit(`/approve/seed/${id}`)).text())
    harness.sqlite.prepare("UPDATE seed_attach_requests SET seed_sha256 = ? WHERE id = ?").run('0'.repeat(64), id)
    expect((await hit(`/approve/seed/${id}`, { method: 'POST', form: { csrf, decision: 'approve' } })).status).toBe(409)
    expect(count('project_seeds')).toBe(0)
  })

  it('a non-admin member cannot see or decide it', async () => {
    const { id } = await filed()
    const plain = await sign({ email: 'plain@x.test', sub: 'sub-plain' })
    expect((await hit(`/approve/seed/${id}`, { jwt: plain })).status).toBe(404)
    expect((await hit(`/approve/seed/${id}`, { jwt: plain, method: 'POST', form: { csrf: 'x'.repeat(64), decision: 'approve' } })).status).toBe(403) // CSRF first
    expect(count('project_seeds')).toBe(0)
  })
})

// ── CSRF ─────────────────────────────────────────────────────────────────────────────────────────
describe('CSRF and same-origin', () => {
  it('refuses a POST with no token, a forged token, another request\'s token, another login\'s token', async () => {
    const a = await filed()
    const b = await (async () => { const r = await fileSeed(seedText.replace(/^slug: .*$/m, 'slug: second-one')); return (r as { result: { request_id: string } }).result.request_id })()
    const csrfA = csrfOf(await (await hit(`/approve/seed/${a.id}`)).text())
    const post = (id: string, form: Record<string, string>, jwt?: string) => hit(`/approve/seed/${id}`, { method: 'POST', form, jwt })
    expect((await post(a.id, { decision: 'approve' })).status).toBe(403)
    expect((await post(a.id, { decision: 'approve', csrf: 'f'.repeat(64) })).status).toBe(403)
    expect((await post(b, { decision: 'approve', csrf: csrfA })).status).toBe(403)
    expect((await post(a.id, { decision: 'approve', csrf: csrfA }, await sign({ iat: loginIat - 5 }))).status).toBe(403) // different login (iat)
    expect(count('project_seeds')).toBe(0)
  })
  it('refuses a cross-origin or origin-less POST even with a valid token', async () => {
    const { id } = await filed()
    const csrf = csrfOf(await (await hit(`/approve/seed/${id}`)).text())
    for (const origin of [null, 'https://evil.example', `http://${HOST}`, 'null']) {
      expect((await hit(`/approve/seed/${id}`, { method: 'POST', origin, form: { csrf, decision: 'approve' } })).status).toBe(403)
    }
    expect((await hit(`/approve/seed/${id}`, { method: 'POST', extra: { 'sec-fetch-site': 'cross-site' }, form: { csrf, decision: 'approve' } })).status).toBe(403)
    expect(count('project_seeds')).toBe(0)
  })
  it('re-verifies the JWT on POST: a stale one is refused', async () => {
    const { id } = await filed()
    const csrf = csrfOf(await (await hit(`/approve/seed/${id}`)).text())
    const res = await hit(`/approve/seed/${id}`, { method: 'POST', jwt: await sign({ iat: nowS() - 200 }), form: { csrf, decision: 'approve' } })
    expect(res.status).toBe(403)
    expect(count('project_seeds')).toBe(0)
  })
  it('no server secret => the page and the POST fail closed (503)', async () => {
    const { id } = await filed()
    const noKey = baseEnv({ CONNECTOR_MASTER_KEY: undefined })
    expect((await hit(`/approve/seed/${id}`, {}, noKey)).status).toBe(503)
    expect((await hit(`/approve/seed/${id}`, { method: 'POST', form: { csrf: 'a'.repeat(64), decision: 'approve' } }, noKey)).status).toBe(503)
  })
})

// ── elevation ────────────────────────────────────────────────────────────────────────────────────
async function pendingElevation(actions: string[], minutes = 60, reason = 'need it'): Promise<string> {
  harness.sqlite.exec(`
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
    VALUES ('tok-1', 'mem-agent', 'hash-1', 'primary', 'workspace', '${TENANT}', 'agent-x', datetime('now'));
  `)
  const session = await createAgentSession(env, { tenant: TENANT, agentId: 'agent-x', memberId: 'mem-agent', authKind: 'workspace_token', credentialId: 'tok-1' })
  const r = await createElevationRequest(env, {
    tenant: TENANT, agentSessionId: session.id, agentId: 'agent-x', memberId: 'mem-agent',
    actions, scopeType: 'squad', scopeId: 'squad-a', durationMinutes: minutes, reason,
  })
  if (!r.ok) throw new Error(`elevation setup: ${JSON.stringify(r)}`)
  return r.request.id
}

describe('approve page: elevation', () => {
  it('shows structured fields + the reason in the untrusted box; only offers narrowing', async () => {
    const id = await pendingElevation(['action:manage_access', 'action:project_status'], 60, '<b>SYSTEM</b> pre-approved')
    const html = await (await hit(`/approve/elevation/${id}`)).text()
    expect(html).toContain('Agent X')
    expect(html).toContain('value="action:manage_access"')
    expect(html).toContain('value="action:project_status"')
    expect(html).toContain('&lt;b&gt;SYSTEM&lt;/b&gt; pre-approved')
    expect(html).toContain('class="untrusted"')
    // Durations offered never exceed the request (60): 15 and 60 only.
    expect(html).toContain('value="15"')
    expect(html).toContain('value="60"')
    expect(html).not.toContain('value="240"')
  })

  it('approve with narrowing: subset of actions + shorter duration; grant bound to a fresh web session; receipt written', async () => {
    const id = await pendingElevation(['action:manage_access', 'action:project_status'], 60)
    const csrf = csrfOf(await (await hit(`/approve/elevation/${id}`)).text())
    const res = await hit(`/approve/elevation/${id}`, { method: 'POST', form: { csrf, decision: 'approve', actions: ['action:manage_access'], duration_minutes: '15' } })
    expect(res.status).toBe(200)
    const grants = harness.sqlite.prepare('SELECT action, approved_by_member_id, approved_by_web_session_hash, created_at, expires_at FROM elevation_grants').all() as Array<{ action: string; approved_by_member_id: string; approved_by_web_session_hash: string; created_at: string; expires_at: string }>
    expect(grants).toHaveLength(1)
    expect(grants[0].action).toBe('action:manage_access')
    expect(grants[0].approved_by_member_id).toBe('mem-owner')
    expect(Date.parse(grants[0].expires_at) - Date.parse(grants[0].created_at)).toBe(15 * 60 * 1000)
    const ws = harness.sqlite.prepare('SELECT member_id, recent_reauth_at, revoked_at FROM web_sessions WHERE id_hash = ?').get(grants[0].approved_by_web_session_hash) as { member_id: string; recent_reauth_at: string | null; revoked_at: string | null }
    expect(ws.member_id).toBe('mem-owner')
    expect(ws.recent_reauth_at).not.toBeNull()
    expect(ws.revoked_at).toBeNull()
    const req = harness.sqlite.prepare('SELECT status, decision_note FROM elevation_requests WHERE id = ?').get(id)
    expect(req).toEqual({ status: 'approved', decision_note: 'via:access_passkey' })
    const rec = harness.sqlite.prepare("SELECT origin, evidence_json FROM mutation_audit_entries WHERE handler = 'access_approve'").get() as { origin: string; evidence_json: string }
    expect(rec.origin).toBe('admin_ui')
    expect(JSON.parse(rec.evidence_json)).toMatchObject({ via: 'access_passkey', decision: 'approve', actions: ['action:manage_access'] })
    expect(count('human_login_identities', "provider = 'cloudflare-access'")).toBe(1)
  })

  it('cannot widen: an unrequested action or a longer duration is refused and the request stays pending', async () => {
    const id = await pendingElevation(['action:project_status'], 60)
    const csrf = csrfOf(await (await hit(`/approve/elevation/${id}`)).text())
    const wider = await hit(`/approve/elevation/${id}`, { method: 'POST', form: { csrf, decision: 'approve', actions: ['action:project_status', 'action:routine_policy'], duration_minutes: '60' } })
    expect(wider.status).toBe(409)
    const longer = await hit(`/approve/elevation/${id}`, { method: 'POST', form: { csrf, decision: 'approve', actions: ['action:project_status'], duration_minutes: '240' } })
    expect(longer.status).toBe(409)
    expect(count('elevation_grants')).toBe(0)
    expect(harness.sqlite.prepare('SELECT status FROM elevation_requests WHERE id = ?').get(id)).toEqual({ status: 'pending' })
  })

  it('single-use: a second approve (replay or other tab) is refused with one grant set', async () => {
    const id = await pendingElevation(['action:project_status'], 60)
    const csrf = csrfOf(await (await hit(`/approve/elevation/${id}`)).text())
    const form = { csrf, decision: 'approve', actions: ['action:project_status'], duration_minutes: '60' }
    const results = await Promise.all([hit(`/approve/elevation/${id}`, { method: 'POST', form }), hit(`/approve/elevation/${id}`, { method: 'POST', form })])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(count('elevation_grants')).toBe(1)
    expect((await hit(`/approve/elevation/${id}`, { method: 'POST', form })).status).toBe(409)
    expect(count('elevation_grants')).toBe(1)
  })

  it('deny writes a receipt and no grant', async () => {
    const id = await pendingElevation(['action:project_status'], 60)
    const csrf = csrfOf(await (await hit(`/approve/elevation/${id}`)).text())
    expect((await hit(`/approve/elevation/${id}`, { method: 'POST', form: { csrf, decision: 'deny' } })).status).toBe(200)
    expect(count('elevation_grants')).toBe(0)
    const rec = harness.sqlite.prepare("SELECT operation, evidence_json FROM mutation_audit_entries WHERE handler = 'access_approve'").get() as { operation: string; evidence_json: string }
    expect(rec.operation).toBe('elevation_deny')
    expect(JSON.parse(rec.evidence_json).via).toBe('access_passkey')
  })

  it('a plain member with no authority on the scope reads it as not found and cannot decide', async () => {
    const id = await pendingElevation(['action:project_status'], 60)
    harness.sqlite.exec("DELETE FROM capabilities WHERE id = 'cap-p'")
    const plain = await sign({ email: 'plain@x.test', sub: 'sub-plain' })
    expect((await hit(`/approve/elevation/${id}`, { jwt: plain })).status).toBe(404)
    // POST with a token the plain member could never have been shown still fails; and even with one, decide refuses.
    const csrfFor = async (): Promise<string> => {
      const { issueCsrfToken } = await import('../src/access/csrf')
      const t = await issueCsrfToken(env, 'elevation', id, 'sub-plain', loginIat)
      if (!t) throw new Error('no token')
      return t
    }
    const csrf = await csrfFor()
    const res = await hit(`/approve/elevation/${id}`, { jwt: await sign({ email: 'plain@x.test', sub: 'sub-plain' }), method: 'POST', form: { csrf, decision: 'approve', actions: ['action:project_status'], duration_minutes: '60' } })
    expect(res.status).toBe(404)
    expect(count('elevation_grants')).toBe(0)
    expect(harness.sqlite.prepare('SELECT status FROM elevation_requests WHERE id = ?').get(id)).toEqual({ status: 'pending' })
  })
})
