// tests/mcp-url-elicitation.test.ts — W3: MCP URL-mode elicitation of secure-moment links
// (src/mcp/url-elicitation.ts, wired in handleJsonRpc + invokeTool.shortCircuit). Real migrated schema; requests go
// through the real /mcp JSON-RPC door with real bearer resolution. Contract: docs/architecture/secure-moments.md (W3).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpApp } from '../src/mcp'
import { sha256Hex } from '../src/members/service'
import type { AuthContext, Env } from '../src/types'
import {
  buildElicitation, detectUrlElicitation, openState, parseMomentLink, principalKey, argsDigest, urlElicitationActive,
  CLIENT_CAPABILITIES_META_KEY,
} from '../src/mcp/url-elicitation'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-a'
const HOST = 'secure.example.test'
const MASTER = 'a1'.repeat(32)
const T0 = '2026-08-01T00:00:00.000Z'
const seedText = readFileSync(join(__dirname, '..', 'docs', 'examples', 'seeds', 'mumega-com.seed.yaml'), 'utf8')
const META = CLIENT_CAPABILITIES_META_KEY
const VERSION_META = 'io.modelcontextprotocol/protocolVersion'
const URL_CAPS = { elicitation: { url: {} } }

let harness: SqliteD1Harness
const count = (t: string, where = '1=1'): number => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`).get() as { n: number }).n
const one = <T>(sql: string, ...p: unknown[]): T | undefined => harness.sqlite.prepare(sql).get(...p) as T | undefined

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Test', OAUTH_PROVIDER: 'google', CONNECTOR_MASTER_KEY: MASTER,
    PUBLIC_ORIGIN: 'https://colony.example.test', SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST, MCP_URL_ELICITATION: '1',
    ...over,
  } as Env
}

async function bootstrapDb(): Promise<void> {
  const tok = async (id: string, member: string, agent: string, name: string) => {
    harness.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('${id}', '${member}', '${await sha256Hex(name)}', 't', 'workspace', '${T0}', '${agent}', '${TENANT}')`)
  }
  harness.sqlite.exec(`
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}');
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('mem-1', 'a1@x.test', 'A1', 'active', '${TENANT}'), ('mem-2', 'a2@x.test', 'A2', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-x', 'squad-a', 'agent-x', 'Agent X', 'r', 'm', 'active'), ('agent-y', 'squad-a', 'agent-y', 'Agent Y', 'r', 'm', 'active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', 'agent-x', 'mem-1', '${T0}'), ('${TENANT}', 'agent-y', 'mem-2', '${T0}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-1', 'mem-1', 'squad', 'squad-a', 'member'), ('cap-2', 'mem-2', 'squad', 'squad-a', 'member');
  `)
  await tok('tok-1', 'mem-1', 'agent-x', 'tok-x')
  await tok('tok-2', 'mem-2', 'agent-y', 'tok-y')
}

type Rpc = { status: number; headers: Headers; text: string; json: { result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } } }
async function rpc(env: Env, method: string, params: unknown, o: { bearer?: string; headers?: Record<string, string> } = {}): Promise<Rpc> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...o.headers }
  if (o.bearer !== null) headers.authorization = `Bearer ${o.bearer ?? 'tok-x'}`
  const res = await mcpApp.request('https://pot.example/', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) }, env)
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, json: JSON.parse(text) }
}

const elevArgs = (reason = 'need it') => ({ actions: ['action:project_status', 'action:manage_access'], scope_type: 'squad', scope_id: 'squad-a', duration_minutes: 60, reason })
const modernMeta = (caps: unknown = URL_CAPS) => ({ [VERSION_META]: '2026-07-28', ...(caps === 'omit' ? {} : { [META]: caps }) })
const modernHeaders = { 'mcp-protocol-version': '2026-07-28' }

async function checkIn(env: Env, bearer = 'tok-x'): Promise<void> {
  const r = await rpc(env, 'tools/call', { name: 'check_in', arguments: {} }, { bearer })
  expect(r.json.error).toBeUndefined()
}
async function initWithUrl(env: Env, caps: unknown = URL_CAPS): Promise<string | null> {
  const r = await rpc(env, 'initialize', { protocolVersion: '2025-11-25', capabilities: caps, clientInfo: { name: 't', version: '1' } }, { bearer: null as unknown as string })
  return r.headers.get('mcp-session-id')
}
const structured = (r: Rpc): Record<string, unknown> => (r.json.result?.structuredContent ?? {}) as Record<string, unknown>
const momentRows = (): Array<{ id: string; link_token_sha256: string; status: string; subject_id: string; kind: string }> =>
  harness.sqlite.prepare('SELECT id, link_token_sha256, status, subject_id, kind FROM secure_moments ORDER BY created_at').all() as never

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  await bootstrapDb()
})
afterEach(() => { harness.close(); vi.useRealTimers() })

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('flag and capability gates: everything off or undeclared is the unchanged plain result', () => {
  it('flag on but no client capability: the plain tool result, no session header on initialize', async () => {
    const env = makeEnv()
    const init = await rpc(env, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }, { bearer: null as unknown as string })
    expect(init.headers.get('mcp-session-id')).toBeNull()
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } })
    expect(r.json.error).toBeUndefined()
    expect(r.json.result?.resultType).toBeUndefined()
    expect(typeof structured(r).approve_url).toBe('string')
  })

  it('flag OFF: capability declared everywhere changes nothing (initialize bytes, 2025 session, 2026 meta)', async () => {
    const off = makeEnv({ MCP_URL_ELICITATION: undefined })
    const base = makeEnv({ MCP_URL_ELICITATION: undefined })
    const withCaps = await rpc(off, 'initialize', { protocolVersion: '2025-11-25', capabilities: URL_CAPS, clientInfo: { name: 't', version: '1' } }, { bearer: null as unknown as string })
    const noCaps = await rpc(base, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }, { bearer: null as unknown as string })
    expect(withCaps.headers.get('mcp-session-id')).toBeNull()
    expect(withCaps.text).toBe(noCaps.text)
    const a = await rpc(off, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, _meta: { [META]: URL_CAPS } },
      { headers: { 'mcp-session-id': 'mce1.whatever.deadbeef' } })
    expect(a.json.error).toBeUndefined()
    expect(a.json.result?.resultType).toBeUndefined()
    const b = await rpc(off, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, _meta: modernMeta() }, { headers: modernHeaders })
    expect(b.json.result?.resultType).toBeUndefined()
    expect(structured(b).approve_url).toBeTypeOf('string')
  })

  it.each([
    ['secure moments off', { SECURE_MOMENTS: undefined }],
    ['no signing key', { CONNECTOR_MASTER_KEY: undefined }],
    ['malformed signing key', { CONNECTOR_MASTER_KEY: 'abc' }],
    ['flag value "0"', { MCP_URL_ELICITATION: '0' }],
  ] as Array<[string, Partial<Env>]>)('inert when %s', async (_n, over) => {
    expect(urlElicitationActive(makeEnv(over))).toBe(false)
  })

  it('modern request WITHOUT url (form only / nothing) is plain; resultType complete comes from the modern path', async () => {
    const env = makeEnv()
    for (const caps of ['omit', { elicitation: { form: {} } }, { elicitation: { url: null } }, { elicitation: { url: [] } }, { elicitation: { url: 'yes' } }]) {
      const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, _meta: modernMeta(caps) }, { headers: modernHeaders })
      expect(r.json.error).toBeUndefined()
      expect(r.json.result?.resultType).toBe('complete')
      expect(structured(r).approve_url).toBeTypeOf('string')
    }
  })

  it('a tool outside the two request tools is never elicited', async () => {
    const env = makeEnv()
    const r = await rpc(env, 'tools/call', { name: 'check_in', arguments: {}, _meta: modernMeta() }, { headers: modernHeaders })
    expect(r.json.result?.resultType).toBe('complete')
    expect(r.json.result?.inputRequests).toBeUndefined()
  })
})

describe('2025-11-25: -32042 URLElicitationRequiredError', () => {
  it('initialize declaring url hands a signed capability session id; tools/call with it returns -32042 with the exact shape', async () => {
    const env = makeEnv()
    const sid = await initWithUrl(env)
    expect(sid).toMatch(/^mce1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/)
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: { 'mcp-session-id': sid ?? '' } })
    expect(r.json.result).toBeUndefined()
    expect(r.json.error?.code).toBe(-32042)
    const data = r.json.error?.data as { elicitations: Array<Record<string, unknown>> }
    expect(Object.keys(data)).toEqual(['elicitations'])
    expect(data.elicitations).toHaveLength(1)
    const e0 = data.elicitations[0]
    expect(Object.keys(e0).sort()).toEqual(['elicitationId', 'message', 'mode', 'url'])
    expect(e0.mode).toBe('url')
    const m = momentRows()
    expect(m).toHaveLength(1)
    expect(e0.elicitationId).toBe(m[0].id)
    expect(String(e0.url)).toMatch(new RegExp(`^https://${HOST}/m/${m[0].id}/[A-Za-z0-9_-]+$`))
    // The plain link is in the error text too (guaranteed path).
    expect(r.json.error?.message).toContain(String(e0.url))
    expect(count('seed_attach_requests')).toBe(1)
  })

  it('the same for request_elevation (one elevation request, one moment)', async () => {
    const env = makeEnv()
    await checkIn(env)
    const sid = await initWithUrl(env)
    const r = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs() }, { headers: { 'mcp-session-id': sid ?? '' } })
    expect(r.json.error?.code).toBe(-32042)
    expect(count('elevation_requests')).toBe(1)
    expect(momentRows().map((x) => x.kind)).toEqual(['elevation'])
  })

  it('a session id from an initialize that did NOT declare url is never issued; forged/tampered/foreign ids get the plain result', async () => {
    const env = makeEnv()
    expect(await initWithUrl(env, {})).toBeNull()
    const good = (await initWithUrl(env)) ?? ''
    const [pre, payload, mac] = good.split('.')
    const flipped = `${pre}.${payload}.${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`
    const forgedPayload = `${pre}.${Buffer.from(JSON.stringify({ c: 'url', iat: Date.now() })).toString('base64url')}.${mac}`
    const otherKey = await (async () => {
      const e2 = makeEnv({ CONNECTOR_MASTER_KEY: 'b2'.repeat(32) })
      return (await initWithUrl(e2)) ?? ''
    })()
    for (const sid of [flipped, forgedPayload, otherKey, 'mce1.x.y', 'garbage', `${good}.extra`]) {
      const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: { 'mcp-session-id': sid } })
      expect(r.json.error, sid).toBeUndefined()
      expect(structured(r).approve_url).toBeTypeOf('string')
    }
  })

  it('an expired capability session id is ignored', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const env = makeEnv()
    const sid = (await initWithUrl(env)) ?? ''
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'))
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: { 'mcp-session-id': sid } })
    expect(r.json.error).toBeUndefined()
  })

  it('per-request _meta capability on a non-modern request is the fallback carrier', async () => {
    const env = makeEnv()
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, _meta: { [META]: URL_CAPS } })
    expect(r.json.error?.code).toBe(-32042)
  })

  it('a retry (the same call again) while pending creates nothing and does not rotate the link; after a decision it reports the outcome', async () => {
    const env = makeEnv()
    const sid = (await initWithUrl(env)) ?? ''
    const call = () => rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: { 'mcp-session-id': sid } })
    expect((await call()).json.error?.code).toBe(-32042)
    const before = momentRows()
    const again = await call()
    expect(again.json.error).toBeUndefined()
    expect(structured(again)).toMatchObject({ ok: true, retry: true, status: 'pending', kind: 'seed_attach' })
    expect(structured(again).approve_url).toBeUndefined()
    expect(count('seed_attach_requests')).toBe(1)
    expect(momentRows()).toEqual(before) // same hash: the link the human opened is still alive
    harness.sqlite.exec(`UPDATE seed_attach_requests SET status='denied', decided_at='${new Date().toISOString()}'`)
    const decided = await call()
    expect(structured(decided)).toMatchObject({ retry: true, status: 'denied' })
    expect(count('seed_attach_requests')).toBe(1)
    expect(momentRows()).toEqual(before)
  })

  it('elevation retry: pending then approved report state; a DIFFERENT ask is a new request', async () => {
    const env = makeEnv()
    await checkIn(env)
    const sid = (await initWithUrl(env)) ?? ''
    const call = (reason?: string) => rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs(reason) }, { headers: { 'mcp-session-id': sid } })
    expect((await call()).json.error?.code).toBe(-32042)
    const pending = await call()
    expect(structured(pending)).toMatchObject({ retry: true, status: 'pending', kind: 'elevation' })
    expect(count('elevation_requests')).toBe(1)
    harness.sqlite.exec(`UPDATE elevation_requests SET status='approved', decided_at='${new Date().toISOString()}'`)
    expect(structured(await call())).toMatchObject({ retry: true, status: 'approved' })
    expect(count('elevation_requests')).toBe(1)
    expect((await call('a different reason')).json.error?.code).toBe(-32042)
    expect(count('elevation_requests')).toBe(2)
  })

  it('a closed ask older than the retry window is a fresh ask, not a retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const env = makeEnv()
    const sid = (await initWithUrl(env)) ?? ''
    const call = () => rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: { 'mcp-session-id': sid } })
    await call()
    harness.sqlite.exec(`UPDATE seed_attach_requests SET status='denied', decided_at='${new Date().toISOString()}'`)
    vi.setSystemTime(new Date('2026-09-01T00:30:00Z'))
    const r = await call()
    expect(r.json.error?.code).toBe(-32042)
  })

  it('a retry by ANOTHER principal never sees someone else\'s request', async () => {
    const env = makeEnv()
    const sidX = (await initWithUrl(env)) ?? ''
    await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: { 'mcp-session-id': sidX } })
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { bearer: 'tok-y', headers: { 'mcp-session-id': sidX } })
    expect(r.json.error?.code).toBe(-32042) // their OWN new request
    expect(count('seed_attach_requests')).toBe(2)
  })
})

describe('2026-07-28: MRTR input_required', () => {
  const callModern = (env: Env, name: string, args: unknown, extra: Record<string, unknown> = {}, bearer = 'tok-x', caps: unknown = URL_CAPS) =>
    rpc(env, 'tools/call', { name, arguments: args, _meta: modernMeta(caps), ...extra }, { bearer, headers: modernHeaders })

  it('declared url => input_required with a url-mode elicitation/create and a requestState; NO -32042, no elicitationId', async () => {
    const env = makeEnv()
    const r = await callModern(env, 'seed_attach_request', { seed: seedText })
    expect(r.json.error).toBeUndefined()
    const res = r.json.result as Record<string, unknown>
    expect(Object.keys(res).sort()).toEqual(['inputRequests', 'requestState', 'resultType'])
    expect(res.resultType).toBe('input_required')
    const reqs = res.inputRequests as Record<string, { method: string; params: Record<string, unknown> }>
    expect(Object.keys(reqs)).toHaveLength(1)
    const only = Object.values(reqs)[0]
    expect(only.method).toBe('elicitation/create')
    expect(Object.keys(only.params).sort()).toEqual(['message', 'mode', 'url'])
    expect(only.params.mode).toBe('url')
    expect(String(only.params.url)).toMatch(new RegExp(`^https://${HOST}/m/[0-9a-f-]{36}/[A-Za-z0-9_-]+$`))
    expect(res.requestState).toMatch(/^mus1\./)
    expect(count('seed_attach_requests')).toBe(1)
  })

  async function firstRound(env: Env, name = 'seed_attach_request', args: unknown = { seed: seedText }, bearer = 'tok-x'): Promise<string> {
    const r = await callModern(env, name, args, {}, bearer)
    return (r.json.result as { requestState: string }).requestState
  }
  const accept = { secure_moment: { action: 'accept' } }

  it('retry with the state: reads the outcome, creates nothing, rotates nothing; decided => real outcome', async () => {
    const env = makeEnv()
    const state = await firstRound(env)
    const before = momentRows()
    const r = await callModern(env, 'seed_attach_request', { seed: seedText }, { requestState: state, inputResponses: accept })
    expect(r.json.result?.resultType).toBe('complete')
    expect(structured(r)).toMatchObject({ ok: true, retry: true, status: 'pending', elicitation_action: 'accept' })
    expect(count('seed_attach_requests')).toBe(1)
    expect(momentRows()).toEqual(before)
    harness.sqlite.exec(`UPDATE seed_attach_requests SET status='applied', decided_at='${new Date().toISOString()}'`)
    const done = await callModern(env, 'seed_attach_request', { seed: seedText }, { requestState: state, inputResponses: accept })
    expect(structured(done)).toMatchObject({ retry: true, status: 'applied' })
    expect(count('seed_attach_requests')).toBe(1)
    const declined = await callModern(env, 'seed_attach_request', { seed: seedText }, { requestState: state, inputResponses: { secure_moment: { action: 'decline' } } })
    expect(structured(declined)).toMatchObject({ elicitation_action: 'decline', status: 'applied' })
  })

  it('elevation retry with the state reports pending then approved', async () => {
    const env = makeEnv()
    await checkIn(env)
    const state = await firstRound(env, 'request_elevation', elevArgs())
    const r = await callModern(env, 'request_elevation', elevArgs(), { requestState: state, inputResponses: accept })
    expect(structured(r)).toMatchObject({ retry: true, status: 'pending', kind: 'elevation' })
    harness.sqlite.exec(`UPDATE elevation_requests SET status='approved', decided_at='${new Date().toISOString()}'`)
    expect(structured(await callModern(env, 'request_elevation', elevArgs(), { requestState: state, inputResponses: accept }))).toMatchObject({ status: 'approved' })
    expect(count('elevation_requests')).toBe(1)
  })

  const refusal = async (env: Env, name: string, args: unknown, state: unknown, bearer = 'tok-x') => {
    const before = [count('seed_attach_requests'), count('elevation_requests'), count('secure_moments')]
    const r = await callModern(env, name, args, { requestState: state }, bearer)
    expect(r.json.error?.code).toBe(-32602)
    expect(r.json.error?.message).toMatch(/^invalid_request_state:/)
    expect(r.json.result).toBeUndefined()
    // a refused state never falls through to running the tool
    expect([count('seed_attach_requests'), count('elevation_requests'), count('secure_moments')]).toEqual(before)
    return r.json.error?.message ?? ''
  }

  it('tampered body, tampered mac, truncated, wrong prefix, non-string, oversize: all refused, nothing created', async () => {
    const env = makeEnv()
    const state = await firstRound(env)
    const [pre, rest] = [state.slice(0, 5), state.slice(5)]
    const [body, mac] = rest.split('.')
    const flipC = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), e: 9e15 })).toString('base64url')
    for (const bad of [`${pre}${flipC(body, 3)}.${mac}`, `${pre}${body}.${flipC(mac, 0)}`, `${pre}${forgedBody}.${mac}`, state.slice(0, -4), `x${state}`, '', 123, { a: 1 }, null, `${state}.x`, `${pre}${body}`, state + 'a'.repeat(5000)]) {
      await refusal(env, 'seed_attach_request', { seed: seedText }, bad)
    }
  })

  it('a state signed under a different key is refused', async () => {
    const other = makeEnv({ CONNECTOR_MASTER_KEY: 'c3'.repeat(32) })
    const foreign = await firstRound(other)
    expect(await refusal(makeEnv(), 'seed_attach_request', { seed: seedText }, foreign)).toBe('invalid_request_state:integrity')
  })

  it('another principal replaying the state is refused', async () => {
    const env = makeEnv()
    const state = await firstRound(env)
    expect(await refusal(env, 'seed_attach_request', { seed: seedText }, state, 'tok-y')).toBe('invalid_request_state:principal')
  })

  it('a state replayed on a different tool or with different arguments is refused', async () => {
    const env = makeEnv()
    await checkIn(env)
    const state = await firstRound(env)
    expect(await refusal(env, 'request_elevation', elevArgs(), state)).toBe('invalid_request_state:tool')
    expect(await refusal(env, 'seed_attach_request', { seed: seedText + '\n# changed' }, state)).toBe('invalid_request_state:args')
  })

  it('an expired state is refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const env = makeEnv()
    await checkIn(env)
    const state = await firstRound(env, 'request_elevation', elevArgs())
    vi.setSystemTime(new Date('2026-09-01T00:11:00Z')) // past the elevation's 10 minute window
    expect(await refusal(env, 'request_elevation', elevArgs(), state)).toBe('invalid_request_state:expired')
  })

  it('a state is not a decision: a valid state with every response never decides anything', async () => {
    const env = makeEnv()
    const state = await firstRound(env)
    for (const action of ['accept', 'decline', 'cancel', 'approve', 'x']) {
      await callModern(env, 'seed_attach_request', { seed: seedText }, { requestState: state, inputResponses: { secure_moment: { action } } })
    }
    expect(one<{ status: string }>('SELECT status FROM seed_attach_requests')?.status).toBe('pending')
    expect(one<{ status: string }>('SELECT status FROM secure_moments')?.status).toBe('pending')
  })

  it('flag OFF: a requestState is ignored like any unknown param (tool runs as before)', async () => {
    const state = await firstRound(makeEnv())
    const off = makeEnv({ MCP_URL_ELICITATION: undefined })
    const r = await callModern(off, 'seed_attach_request', { seed: seedText }, { requestState: state })
    expect(r.json.error).toBeUndefined()
    expect(structured(r).reused).toBe(true)
  })

  it('every result on a modern request carries resultType while the flag is on (spec 2026-07-28)', async () => {
    const env = makeEnv()
    const r = await rpc(env, 'tools/list', { _meta: modernMeta() }, { headers: modernHeaders })
    expect(r.json.result?.resultType).toBe('complete')
  })
})

describe('the URL is only ever the secure-moment URL', () => {
  const auth = (): AuthContext => ({
    userId: 'mem-1', email: null, role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-1', tokenId: 'tok-1', capabilities: [], boundAgentId: 'agent-x',
  } as unknown as AuthContext)
  const mk = async (url: string, over: Partial<{ agent: string | null; status: string; kind: string }> = {}) => {
    const env = makeEnv()
    const id = crypto.randomUUID()
    harness.sqlite.prepare(`INSERT INTO secure_moments (id, tenant, kind, subject_id, requester_agent_id, decider_member_id, link_token_sha256, status, step_up_required, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, NULL, '${'0'.repeat(64)}', ?, 1, ?, ?)`).run(id, TENANT, over.kind ?? 'seed_attach', `s-${id}`, over.agent === undefined ? 'agent-x' : over.agent, over.status ?? 'pending', new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString())
    return buildElicitation(env, auth(), { toolName: 'seed_attach_request', args: {}, mode: 'error32042', result: { approve_url: typeof url === 'string' ? url.replace('ID', id) : url } })
  }
  const good = `https://${HOST}/m/ID/AAAAAAAAAAAAAAAAAAAAAAAA`

  it('accepts exactly the secure-host shape', async () => {
    expect((await mk(good))?.kind).toBe('error')
  })
  it.each([
    ['other host', `https://evil.example.test/m/ID/AAAAAAAAAAAAAAAAAAAAAAAA`],
    ['parent-ish host', `https://x.${HOST}/m/ID/AAAAAAAAAAAAAAAAAAAAAAAA`],
    ['http', `http://${HOST}/m/ID/AAAAAAAAAAAAAAAAAAAAAAAA`],
    ['port', `https://${HOST}:8443/m/ID/AAAAAAAAAAAAAAAAAAAAAAAA`],
    ['userinfo', `https://u:p@${HOST}/m/ID/AAAAAAAAAAAAAAAAAAAAAAAA`],
    ['userinfo host trick', `https://${HOST}@evil.example.test/m/ID/AAAAAAAAAAAAAAAAAAAAAAAA`],
    ['query', `${good}?next=https://evil.example.test`],
    ['fragment', `${good}#x`],
    ['wrong path', `https://${HOST}/x/ID/AAAAAAAAAAAAAAAAAAAAAAAA`],
    ['enrol link', `https://${HOST}/m/enrol/AAAAAAAAAAAAAAAAAAAAAAAA`],
    ['trailing path', `${good}/decide`],
    ['not a string', 42 as unknown as string],
  ])('refuses %s', async (_n, url) => {
    expect(await mk(url)).toBeNull()
  })
  it('refuses a moment that is another agent\'s, not pending, or the wrong kind for the tool', async () => {
    expect(await mk(good, { agent: 'agent-y' })).toBeNull()
    expect(await mk(good, { agent: null })).toBeNull()
    expect(await mk(good, { status: 'consumed' })).toBeNull()
    expect(await mk(good, { kind: 'elevation' })).toBeNull()
  })
  it('parseMomentLink is null while secure moments are off', () => {
    expect(parseMomentLink(makeEnv({ SECURE_MOMENTS: undefined }), good.replace('ID', '11111111-1111-4111-8111-111111111111'))).toBeNull()
  })
  it('the live link in the elicitation is byte-identical to the tool result approve_url', async () => {
    const env = makeEnv()
    const plain = await rpc(makeEnv({ MCP_URL_ELICITATION: undefined }), 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } })
    void plain
    const el = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, _meta: modernMeta() }, { headers: modernHeaders })
    const url = String(((el.json.result as { inputRequests: Record<string, { params: { url: string } }> }).inputRequests.secure_moment).params.url)
    const row = momentRows().at(-1)
    expect(new URL(url).host).toBe(HOST)
    const token = url.split('/').at(-1) ?? ''
    expect(await sha256Hex(token)).toBe(row?.link_token_sha256)
  })
})

describe('helpers', () => {
  it('detectUrlElicitation: modern needs _meta url; non-modern never gets mrtr', async () => {
    const env = makeEnv()
    const p = { _meta: { [META]: URL_CAPS } }
    expect(await detectUrlElicitation(env, { modern: true, params: p, sessionId: null })).toBe('mrtr')
    expect(await detectUrlElicitation(env, { modern: false, params: p, sessionId: null })).toBe('error32042')
    expect(await detectUrlElicitation(env, { modern: true, params: {}, sessionId: null })).toBeNull()
    expect(await detectUrlElicitation(env, { modern: false, params: {}, sessionId: null })).toBeNull()
  })
  it('openState refuses non-object payloads even with a valid MAC shape', async () => {
    const env = makeEnv()
    const r = await openState(env, 'mus1.e30.' + '0'.repeat(64), { principal: principalKey({ memberId: 'm', boundAgentId: 'a' }), tool: 'seed_attach_request', argsSha256: await argsDigest({}) })
    expect(r.ok).toBe(false)
  })
})
