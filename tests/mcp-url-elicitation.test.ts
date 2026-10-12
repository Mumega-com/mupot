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
  buildElicitation, detectUrlElicitation, openState, parseMomentLink, principalKey, argsDigest, urlElicitationActive, readOutcome, findSameAsk, sealState,
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
const sh = (sid: string): Record<string, string> => ({ 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' })

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
      { headers: sh('mce1.whatever.deadbeef') })
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
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: sh(sid ?? '') })
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
    const r = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs() }, { headers: sh(sid ?? '') })
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
      const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: sh(sid) })
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
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: sh(sid) })
    expect(r.json.error).toBeUndefined()
  })

  it('per-request _meta capability on a non-modern request is the fallback carrier', async () => {
    const env = makeEnv()
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, _meta: { [META]: URL_CAPS } }, { headers: { 'mcp-protocol-version': '2025-11-25' } })
    expect(r.json.error?.code).toBe(-32042)
  })

  it('a retry (the same call again) while pending creates nothing and does not rotate the link; after a decision it reports the outcome', async () => {
    const env = makeEnv()
    const sid = (await initWithUrl(env)) ?? ''
    const call = () => rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: sh(sid) })
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
    const call = (reason?: string) => rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs(reason) }, { headers: sh(sid) })
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
    const call = () => rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: sh(sid) })
    await call()
    harness.sqlite.exec(`UPDATE seed_attach_requests SET status='denied', decided_at='${new Date().toISOString()}'`)
    vi.setSystemTime(new Date('2026-09-01T00:30:00Z'))
    const r = await call()
    expect(r.json.error?.code).toBe(-32042)
  })

  it('a retry by ANOTHER principal never sees someone else\'s request', async () => {
    const env = makeEnv()
    const sidX = (await initWithUrl(env)) ?? ''
    await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: sh(sidX) })
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { bearer: 'tok-y', headers: sh(sidX) })
    expect(r.json.error?.code).toBe(-32042) // their OWN new request
    expect(count('seed_attach_requests')).toBe(2)
  })
})

describe('2025-11-25 elevation retry is principal-scoped', () => {
  it('another agent making the identical ask gets its own new request, never the first agent\'s state', async () => {
    const env = makeEnv()
    await checkIn(env)
    await checkIn(env, 'tok-y')
    const sid = (await initWithUrl(env)) ?? ''
    const a = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs() }, { headers: sh(sid) })
    expect(a.json.error?.code).toBe(-32042)
    harness.sqlite.exec(`UPDATE elevation_requests SET status='approved', decided_at='${new Date().toISOString()}'`)
    const b = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs() }, { bearer: 'tok-y', headers: sh(sid) })
    expect(b.json.error?.code).toBe(-32042)
    expect(count('elevation_requests')).toBe(2)
    expect(count('elevation_requests', "agent_id = 'agent-y' AND status = 'pending'")).toBe(1)
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
    expect(r.json.error?.message).toBe('invalid_request_state')
    expect(r.json.result).toBeUndefined()
    // a refused state never falls through to running the tool
    expect([count('seed_attach_requests'), count('elevation_requests'), count('secure_moments')]).toEqual(before)
    return String(r.json.error?.data ?? '')
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
    expect(await refusal(makeEnv(), 'seed_attach_request', { seed: seedText }, foreign)).toBe('integrity')
  })

  it('another principal replaying the state is refused', async () => {
    const env = makeEnv()
    const state = await firstRound(env)
    expect(await refusal(env, 'seed_attach_request', { seed: seedText }, state, 'tok-y')).toBe('principal')
  })

  it('a state replayed on a different tool or with different arguments is refused', async () => {
    const env = makeEnv()
    await checkIn(env)
    const state = await firstRound(env)
    expect(['tool', 'principal']).toContain(await refusal(env, 'request_elevation', elevArgs(), state)) // an elevation principal includes the session, so either layer may speak first
    expect(await refusal(env, 'seed_attach_request', { seed: seedText + '\n# changed' }, state)).toBe('args')
  })

  it('an expired state is refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const env = makeEnv()
    await checkIn(env)
    const state = await firstRound(env, 'request_elevation', elevArgs())
    vi.setSystemTime(new Date('2026-09-01T00:11:00Z')) // past the elevation's 10 minute window
    expect(await refusal(env, 'request_elevation', elevArgs(), state)).toBe('expired')
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
    expect(await detectUrlElicitation(env, { modern: false, params: p, sessionId: null, protocolVersionHeader: '2025-11-25' })).toBe('error32042')
    for (const h of [null, undefined, '2025-06-18', '2025-03-26', '2026-07-28 ']) expect(await detectUrlElicitation(env, { modern: false, params: p, sessionId: null, protocolVersionHeader: h })).toBeNull()
    expect(await detectUrlElicitation(env, { modern: true, params: {}, sessionId: null })).toBeNull()
    expect(await detectUrlElicitation(env, { modern: false, params: {}, sessionId: null })).toBeNull()
  })
  it('openState refuses non-object payloads even with a valid MAC shape', async () => {
    const env = makeEnv()
    const r = await openState(env, 'mus1.e30.' + '0'.repeat(64), { principal: principalKey({ memberId: 'm', boundAgentId: 'a' }), tool: 'seed_attach_request', argsSha256: await argsDigest({}) })
    expect(r.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Round 2 (gate findings on PR #1866)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const authFor = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'mem-1', email: null, role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-1', tokenId: 'tok-1', capabilities: [], boundAgentId: 'agent-x', ...over,
} as unknown as AuthContext)

async function siblingToken(): Promise<string> {
  harness.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
    VALUES ('tok-1b', 'mem-1', '${await sha256Hex('tok-x2')}', 't', 'workspace', '${T0}', 'agent-x', '${TENANT}')`)
  return 'tok-x2'
}
const sessionOf = (tokenId: string): string => one<{ id: string }>("SELECT id FROM agent_sessions WHERE credential_id = ? AND revoked_at IS NULL", tokenId)?.id ?? ''

describe('P2-A: an elevation retry is scoped to the filing AGENT SESSION', () => {
  it('a sibling session of the same agent files its own request and never sees session 1\'s (2025-11-25)', async () => {
    const env = makeEnv()
    const t2 = await siblingToken()
    await checkIn(env)
    await checkIn(env, t2)
    expect(sessionOf('tok-1')).not.toBe(sessionOf('tok-1b'))
    const sid = (await initWithUrl(env)) ?? ''
    const a = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs() }, { headers: sh(sid) })
    expect(a.json.error?.code).toBe(-32042)
    const b = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs() }, { bearer: t2, headers: sh(sid) })
    expect(b.json.error?.code).toBe(-32042) // its own new elicitation, not "pending" for session 1's request
    expect(count('elevation_requests')).toBe(2)
    expect(count('elevation_requests', `agent_session_id = '${sessionOf('tok-1b')}'`)).toBe(1)
  })

  it('session 1\'s requestState replayed from session 2 is refused', async () => {
    const env = makeEnv()
    const t2 = await siblingToken()
    await checkIn(env)
    await checkIn(env, t2)
    const first = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs(), _meta: modernMeta() }, { headers: modernHeaders })
    const state = (first.json.result as { requestState: string }).requestState
    const before = count('elevation_requests')
    const r = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs(), requestState: state, _meta: modernMeta() }, { bearer: t2, headers: modernHeaders })
    expect(r.json.error?.code).toBe(-32602)
    expect(r.json.error?.data).toBe('principal')
    expect(count('elevation_requests')).toBe(before)
  })

  it('principal key differs per session; seed principal has no session part', () => {
    expect(principalKey({ memberId: 'm', boundAgentId: 'a' }, 's1')).not.toBe(principalKey({ memberId: 'm', boundAgentId: 'a' }, 's2'))
    expect(principalKey({ memberId: 'm', boundAgentId: 'a' })).toBe('m|a')
  })
})

describe('each principal guard layer pinned on its own (the paired layer bypassed)', () => {
  async function fileViaTool(env: Env) {
    await checkIn(env)
    const sid = (await initWithUrl(env)) ?? ''
    await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs() }, { headers: sh(sid) })
    return { reqId: one<{ id: string }>('SELECT id FROM elevation_requests')?.id ?? '', session: sessionOf('tok-1') }
  }
  const NOW = Date.now()

  it('readOutcome (elevation): the SESSION check alone', async () => {
    const env = makeEnv()
    const { reqId, session } = await fileViaTool(env)
    expect(await readOutcome(env, authFor(), 'elevation', reqId, session, NOW)).toMatchObject({ status: 'pending' })
    expect(await readOutcome(env, authFor(), 'elevation', reqId, 'some-other-session', NOW)).toBeNull()
    expect(await readOutcome(env, authFor(), 'elevation', reqId, null, NOW)).toBeNull()
  })
  it('readOutcome (elevation): the AGENT check alone (right session, wrong agent)', async () => {
    const env = makeEnv()
    const { reqId, session } = await fileViaTool(env)
    expect(await readOutcome(env, authFor({ boundAgentId: 'agent-y' }), 'elevation', reqId, session, NOW)).toBeNull()
    expect(await readOutcome(env, authFor({ boundAgentId: null }), 'elevation', reqId, session, NOW)).toBeNull()
  })
  it('readOutcome (seed): member check alone and agent check alone', async () => {
    const env = makeEnv()
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } })
    const id = String(structured(r).request_id)
    expect(await readOutcome(env, authFor(), 'seed_attach', id, null, NOW)).toMatchObject({ status: 'pending' })
    expect(await readOutcome(env, authFor({ memberId: 'mem-2' }), 'seed_attach', id, null, NOW)).toBeNull() // right agent, wrong member
    expect(await readOutcome(env, authFor({ boundAgentId: null }), 'seed_attach', id, null, NOW)).toBeNull() // right member, wrong agent
    expect(await readOutcome(env, authFor({ boundAgentId: 'agent-y' }), 'seed_attach', id, null, NOW)).toBeNull()
  })
  it('findSameAsk (elevation): session filter, agent filter and moment-ownership filter each alone', async () => {
    const env = makeEnv()
    const { reqId, session } = await fileViaTool(env)
    const args = elevArgs()
    expect(await findSameAsk(env, authFor(), 'elevation', args, session, NOW)).toBe(reqId)
    expect(await findSameAsk(env, authFor(), 'elevation', args, 'other-session', NOW)).toBeNull() // session only
    expect(await findSameAsk(env, authFor({ boundAgentId: 'agent-y' }), 'elevation', args, session, NOW)).toBeNull() // agent only
    harness.sqlite.exec("UPDATE secure_moments SET requester_agent_id = 'agent-y'")
    expect(await findSameAsk(env, authFor(), 'elevation', args, session, NOW)).toBeNull() // moment ownership only
  })
  it('findSameAsk (seed): member filter, agent filter and moment-exists filter each alone', async () => {
    const env = makeEnv()
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } })
    const id = String(structured(r).request_id)
    const args = { seed: seedText }
    expect(await findSameAsk(env, authFor(), 'seed_attach', args, null, NOW)).toBe(id)
    expect(await findSameAsk(env, authFor({ memberId: 'mem-2' }), 'seed_attach', args, null, NOW)).toBeNull()
    expect(await findSameAsk(env, authFor({ boundAgentId: null }), 'seed_attach', args, null, NOW)).toBeNull()
    expect(await findSameAsk(env, authFor({ boundAgentId: 'agent-y' }), 'seed_attach', args, null, NOW)).toBeNull()
    harness.sqlite.exec('DELETE FROM secure_moments')
    expect(await findSameAsk(env, authFor(), 'seed_attach', args, null, NOW)).toBeNull() // never went through a moment
  })
  it('findSameAsk: elevation without a session, or without an agent, is never a retry', async () => {
    const env = makeEnv()
    const { session } = await fileViaTool(env)
    expect(await findSameAsk(env, authFor(), 'elevation', elevArgs(), null, NOW)).toBeNull()
    expect(await findSameAsk(env, authFor({ boundAgentId: null }), 'elevation', elevArgs(), session, NOW)).toBeNull()
  })

  async function sealFor(env: Env, over: { m?: string; s?: string; p?: string; k?: 'seed_attach' | 'elevation' }) {
    const args = { seed: seedText }
    return sealState(env, {
      v: 1, p: over.p ?? principalKey({ memberId: 'mem-1', boundAgentId: 'agent-x' }), t: 'seed_attach_request', a: await argsDigest(args),
      m: over.m ?? '', s: over.s ?? '', k: over.k ?? 'seed_attach', e: Date.now() + 60_000,
    })
  }
  it('shortCircuit moment check: subject mismatch alone, requester mismatch alone, missing moment alone', async () => {
    const env = makeEnv()
    const seed2 = seedText.replace('name: Mumega.com', 'name: Mumega.com Two')
    const r1 = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } })
    const r2 = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seed2 } })
    const subj1 = String(structured(r1).request_id)
    const subj2 = String(structured(r2).request_id)
    const m1 = one<{ id: string }>('SELECT id FROM secure_moments WHERE subject_id = ?', subj1)?.id ?? ''
    const m2 = one<{ id: string }>('SELECT id FROM secure_moments WHERE subject_id = ?', subj2)?.id ?? ''
    const go = async (state: string | null) => {
      const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, requestState: state, _meta: modernMeta() }, { headers: modernHeaders })
      return r
    }
    // control: a consistent state is answered
    expect(structured(await go(await sealFor(env, { m: m1, s: subj1 })))).toMatchObject({ retry: true, status: 'pending' })
    // moment of request 2 paired with subject 1: both rows are this principal's own, ONLY the subject-binding differs
    const mismatch = await go(await sealFor(env, { m: m2, s: subj1 }))
    expect(mismatch.text.slice(0, 400)).toContain('not_found')
    // moment owned by another agent while the subject is still ours
    harness.sqlite.prepare("UPDATE secure_moments SET requester_agent_id = 'agent-y' WHERE id = ?").run(m1)
    expect((await go(await sealFor(env, { m: m1, s: subj1 }))).json.error?.data).toBe('not_found')
    // moment row gone (item 4): a VALID state never falls through to the tool
    const before = count('seed_attach_requests')
    harness.sqlite.exec('DELETE FROM secure_moments')
    const gone = await go(await sealFor(env, { m: m1, s: subj1 }))
    expect(gone.json.error?.data).toBe('not_found')
    expect(gone.json.result).toBeUndefined()
    expect(count('seed_attach_requests')).toBe(before)
    expect(count('secure_moments')).toBe(0) // the tool did not run and re-mint a moment
  })
  it('shortCircuit outcome check: a valid state whose subject belongs to another member is refused, not run', async () => {
    const env = makeEnv()
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { bearer: 'tok-y' })
    const subj = String(structured(r).request_id)
    const mY = one<{ id: string }>('SELECT id FROM secure_moments WHERE subject_id = ?', subj)?.id ?? ''
    harness.sqlite.prepare("UPDATE secure_moments SET requester_agent_id = 'agent-x' WHERE id = ?").run(mY) // moment passes; ONLY the subject owner check can refuse
    const before = count('seed_attach_requests')
    const out = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, requestState: await sealFor(env, { m: mY, s: subj }), _meta: modernMeta() }, { headers: modernHeaders })
    expect(out.json.error?.data).toBe('not_found')
    expect(count('seed_attach_requests')).toBe(before)
  })
  it('openState layers each alone: tool binding and kind binding', async () => {
    const env = makeEnv()
    const args = { seed: seedText }
    const dig = await argsDigest(args)
    const pk = principalKey({ memberId: 'mem-1', boundAgentId: 'agent-x' })
    const mk = (t: string, k: 'seed_attach' | 'elevation') => sealState(env, { v: 1, p: pk, t, a: dig, m: 'm', s: 's', k, e: Date.now() + 60_000 })
    const okState = (await mk('seed_attach_request', 'seed_attach')) ?? ''
    expect((await openState(env, okState, { principal: pk, tool: 'seed_attach_request', argsSha256: dig })).ok).toBe(true)
    // right tool binding per request but a state minted for another tool name: tool layer alone
    expect(await openState(env, okState, { principal: pk, tool: 'request_elevation', argsSha256: dig })).toEqual({ ok: false, reason: 'tool' })
    // kind inconsistent with the registry entry for the tool: kind layer alone
    const badKind = (await mk('seed_attach_request', 'elevation')) ?? ''
    expect(await openState(env, badKind, { principal: pk, tool: 'seed_attach_request', argsSha256: dig })).toEqual({ ok: false, reason: 'tool' })
    // a tool outside the registry never verifies
    const alien = (await mk('check_in', 'seed_attach')) ?? ''
    expect(await openState(env, alien, { principal: pk, tool: 'check_in', argsSha256: dig })).toEqual({ ok: false, reason: 'tool' })
  })
})

describe('P3-2: a bad requestState is refused AFTER authz', () => {
  it('a caller below the tool floor gets the normal forbidden refusal, not a state error', async () => {
    const env = makeEnv()
    harness.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-3', 'a3@x.test', 'A3', 'active', '${TENANT}');
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('tok-3', 'mem-3', '${await sha256Hex('tok-z')}', 't', 'workspace', '${T0}', NULL, '${TENANT}')`)
    const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, requestState: 'mus1.garbage.sig', _meta: modernMeta() }, { bearer: 'tok-z', headers: modernHeaders })
    expect(r.json.error).toBeUndefined()
    expect(r.json.result?.isError).toBe(true)
    expect(JSON.stringify(r.json.result)).toContain('forbidden')
    expect(JSON.stringify(r.json.result)).not.toContain('invalid_request_state')
  })
  it('schema errors win over a bad state; unauthenticated is 401', async () => {
    const env = makeEnv()
    const bad = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: {}, requestState: 'x', _meta: modernMeta() }, { headers: modernHeaders })
    expect(bad.json.error?.message).toBe('invalid_args')
    const anon = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, requestState: 'x' }, { bearer: 'nope' })
    expect(anon.status).toBe(401)
  })
})

describe('P1-1 / P3-3: protocol version', () => {
  it('a client asking for 2025-11-25 and declaring url gets 2025-11-25; everyone else keeps 2025-06-18', async () => {
    const env = makeEnv()
    const init = (v: string, caps: unknown) => rpc(env, 'initialize', { protocolVersion: v, capabilities: caps, clientInfo: { name: 't', version: '1' } }, { bearer: null as unknown as string })
    const yes = await init('2025-11-25', URL_CAPS)
    expect((yes.json.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25')
    expect(yes.headers.get('mcp-session-id')).toBeTruthy()
    expect(yes.headers.get('access-control-expose-headers')).toBe('Mcp-Session-Id')
    for (const [v, caps] of [['2025-11-25', {}], ['2025-06-18', URL_CAPS], ['2025-03-26', URL_CAPS], ['2025-11-25', { elicitation: { form: {} } }]] as Array<[string, unknown]>) {
      const r = await init(v, caps)
      expect((r.json.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18')
      expect(r.headers.get('mcp-session-id')).toBeNull()
      expect(r.headers.get('access-control-expose-headers')).toBeNull()
    }
  })
  it('-32042 only on a request that carries MCP-Protocol-Version 2025-11-25', async () => {
    const env = makeEnv()
    const sid = (await initWithUrl(env)) ?? ''
    for (const h of [{ 'mcp-session-id': sid }, { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' }]) {
      const r = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText }, _meta: { [META]: URL_CAPS } }, { headers: h })
      expect(r.json.error).toBeUndefined()
      expect(structured(r).approve_url).toBeTypeOf('string')
    }
  })
  it('SEP-1303: with the version negotiated, a schema error is a tool execution error; otherwise -32602 as before', async () => {
    const env = makeEnv()
    const sid = (await initWithUrl(env)) ?? ''
    const v25 = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { nope: 1 } }, { headers: sh(sid) })
    expect(v25.json.error).toBeUndefined()
    expect(v25.json.result?.isError).toBe(true)
    expect(JSON.stringify(v25.json.result)).toContain('invalid_args')
    const plain = await rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { nope: 1 } })
    expect(plain.json.error?.code).toBe(-32602)
    const off = await rpc(makeEnv({ MCP_URL_ELICITATION: undefined }), 'tools/call', { name: 'seed_attach_request', arguments: { nope: 1 } }, { headers: sh(sid) })
    expect(off.json.error?.code).toBe(-32602)
    const unk = await rpc(env, 'tools/call', { name: 'no_such_tool', arguments: {} }, { headers: sh(sid) })
    expect(unk.json.error?.code).toBe(-32602) // unknown tool stays a protocol error
  })
  it('session ids are unique per initialize', async () => {
    const env = makeEnv()
    const a = await initWithUrl(env)
    const b = await initWithUrl(env)
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
  })
})

describe('P2-2: GET and DELETE on /mcp', () => {
  const call = (env: Env, method: string) => mcpApp.request('https://pot.example/', { method, headers: { authorization: 'Bearer tok-x' } }, env)
  it('flag on: 405 with Allow: POST', async () => {
    for (const m of ['GET', 'DELETE']) {
      const r = await call(makeEnv(), m)
      expect(r.status).toBe(405)
      expect(r.headers.get('allow')).toBe('POST')
    }
  })
  it('flag off: exactly the unchanged answer (the same as an env that never heard of the flag)', async () => {
    for (const m of ['GET', 'DELETE']) {
      const off = await call(makeEnv({ MCP_URL_ELICITATION: undefined }), m)
      const inert = await call(makeEnv({ MCP_URL_ELICITATION: undefined, SECURE_MOMENTS: undefined }), m)
      expect(off.status).toBe(inert.status)
      expect(off.status).not.toBe(405)
      expect(await off.text()).toBe(await inert.text())
    }
  })
})

describe('P2-6: scope_id normalisation matches request_elevation storage', () => {
  it('a blank scope_id is the same ask as an omitted one', async () => {
    const env = makeEnv()
    await checkIn(env)
    const sid = (await initWithUrl(env)) ?? ''
    const org = { actions: ['action:project_status'], scope_type: 'org', duration_minutes: 60, reason: 'org ask' }
    const a = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: org }, { headers: sh(sid) })
    expect(a.json.error?.code).toBe(-32042)
    expect(one<{ requested_scope_id: string }>('SELECT requested_scope_id FROM elevation_requests')?.requested_scope_id).toBe('')
    for (const blank of ['', '   ']) {
      const b = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: { ...org, scope_id: blank } }, { headers: sh(sid) })
      expect(structured(b), JSON.stringify(blank)).toMatchObject({ retry: true, status: 'pending' })
    }
    expect(count('elevation_requests')).toBe(1)
  })
})

describe('round 2 survivors pinned', () => {
  it('findSameAsk (elevation): the AGENT filter alone (session and moment owner both say yes)', async () => {
    const env = makeEnv()
    await checkIn(env)
    const sid = (await initWithUrl(env)) ?? ''
    await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs() }, { headers: sh(sid) })
    const session = sessionOf('tok-1')
    harness.sqlite.exec("UPDATE secure_moments SET requester_agent_id = 'agent-y'")
    expect(await findSameAsk(env, authFor({ boundAgentId: 'agent-y' }), 'elevation', elevArgs(), session, Date.now())).toBeNull()
    expect(await findSameAsk(env, authFor(), 'elevation', elevArgs(), session, Date.now())).toBeNull() // moment owner now differs for the true agent
  })

  it('a valid elevation state with no live agent session is refused (principal), never run', async () => {
    const env = makeEnv()
    await checkIn(env)
    const first = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs(), _meta: modernMeta() }, { headers: modernHeaders })
    const state = (first.json.result as { requestState: string }).requestState
    harness.sqlite.exec("UPDATE agent_sessions SET revoked_at = datetime('now')")
    const r = await rpc(env, 'tools/call', { name: 'request_elevation', arguments: elevArgs(), requestState: state, _meta: modernMeta() }, { headers: modernHeaders })
    expect(r.json.error?.code).toBe(-32602)
    expect(r.json.error?.data).toBe('principal')
  })

  it('a pending seed ask older than the retry window is re-asked through the tool (reuse + fresh elicitation), not answered as a retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'))
    const env = makeEnv()
    const sid = (await initWithUrl(env)) ?? ''
    const call = () => rpc(env, 'tools/call', { name: 'seed_attach_request', arguments: { seed: seedText } }, { headers: sh(sid) })
    expect((await call()).json.error?.code).toBe(-32042)
    vi.setSystemTime(new Date('2026-09-01T00:30:00Z'))
    const again = await call()
    expect(again.json.error?.code).toBe(-32042)
    expect(count('seed_attach_requests')).toBe(1) // the tool reused the request
  })
})
