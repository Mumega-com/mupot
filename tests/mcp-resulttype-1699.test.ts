// mupot#1699 — resultType on EVERY result under protocol 2026-07-28 (SEP-2322); legacy bytes unchanged.
// Real SQL: the schema is the whole committed migration chain (applyAllMigrations).
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENTS_METHODS, isModernProtocolRequest, withResultType } from '../src/mcp/events'
import { sha256Hex } from '../src/members/service'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { mcpApp } from '../src/mcp'
const mcpRequest = mcpApp.request.bind(mcpApp) // raw: the helper rewrites isError results into legacy 4xx

const TENANT = 'digid'
const T0 = '2026-08-01T00:00:00.000Z'

// Bearer name -> what that principal is.
//   bound-admin      agent-bound workspace token, org admin (org admin)
//   bound-nogrants   agent-bound workspace token, NO grants (no floor)
//   unbound-admin    human workspace token, admin, not bound to an agent (legacy fixture)
//   dir-zero         directory-channel token, zero capabilities, not bound (B1 ceiling)
type Bearer = 'bound-admin' | 'bound-nogrants' | 'unbound-admin' | 'dir-zero'

let harness: SqliteD1Harness

async function seed(h: SqliteD1Harness): Promise<void> {
  const tok = async (id: string, member: string, channel: string, agent: string | null, name: Bearer) => {
    const hash = await sha256Hex(name)
    h.sqlite.exec(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES ('${id}', '${member}', '${hash}', 't', '${channel}', '${T0}', ${agent ? `'${agent}'` : 'NULL'}, '${TENANT}')`,
    )
  }
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-1', 'agent-a', 'Agent A', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-b', 'squad-1', 'agent-b', 'Agent B', 'active');
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('member-1', NULL, 'Human', 'active', '${T0}', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('member-dir', NULL, 'Dir', 'active', '${T0}', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('member-agent-a', NULL, 'Agent A', 'active', '${T0}', '${TENANT}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('member-agent-b', NULL, 'Agent B', 'active', '${T0}', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-a', 'member-agent-a', '${T0}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-b', 'member-agent-b', '${T0}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-1', 'member-1', 'org', NULL, 'admin');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', 'member-agent-a', 'org', NULL, 'admin');
  `)
  await tok('tok-ba', 'member-agent-a', 'workspace', 'agent-a', 'bound-admin')
  await tok('tok-bn', 'member-agent-b', 'workspace', 'agent-b', 'bound-nogrants')
  await tok('tok-ua', 'member-1', 'workspace', null, 'unbound-admin')
  await tok('tok-dz', 'member-dir', 'directory', null, 'dir-zero')
}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  await seed(harness)
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

interface EnvOpts {
  events?: string
  bearer?: Bearer
}

function makeEnv(opts: EnvOpts, sqlLog: string[]): Env {
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Digid',
    OAUTH_PROVIDER: 'google',
    ...(opts.events !== undefined ? { EVENTS_ENABLED: opts.events } : {}),
    EVENTS_CALLBACK_HOSTS: 'hooks.example',
    DB: {
      prepare(sql: string) {
        sqlLog.push(sql)
        return harness.db.prepare(sql)
      },
      batch: (stmts: Parameters<typeof harness.db.batch>[0]) => harness.db.batch(stmts),
    },
  } as unknown as Env
}


const MODERN = '2026-07-28'
const META = { 'io.modelcontextprotocol/protocolVersion': MODERN }

interface Rpc { status: number; json: { result?: Record<string, unknown>; error?: { code: number; message: string } } | null; text: string }

async function rpc(
  method: string,
  params: Record<string, unknown> | undefined,
  o: { events?: string; bearer?: Bearer; header?: string; meta?: boolean } = {},
): Promise<Rpc> {
  const withMeta = o.meta ? { ...(params ?? {}), _meta: META } : params
  const res = await mcpRequest(
    'https://pot.example/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${o.bearer ?? 'bound-admin'}`,
        ...(o.header !== undefined ? { 'mcp-protocol-version': o.header } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(withMeta === undefined ? {} : { params: withMeta }) }),
    },
    makeEnv({ events: o.events ?? 'true', bearer: o.bearer }, []),
  )
  const text = await res.text()
  return { status: res.status, text, json: text ? (JSON.parse(text) as Rpc['json']) : null }
}

// Every method handleJsonRpc dispatches, with params that reach a RESULT (not an error) for bound-admin.
// subscribe is not here: its success path needs the vault master key + a callback fetch (covered by the
// "all result returns go through ok()" source ratchet below and mcp-events-pr2 for its own behaviour).
const RESULT_CASES: { method: string; params?: Record<string, unknown> }[] = [
  { method: 'initialize', params: { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: 'x', version: '1' } } },
  { method: 'tools/list' },
  { method: 'tools/call', params: { name: 'status', arguments: {} } },
  { method: 'server/discover' },
  { method: 'events/list', params: {} },
  { method: 'events/unsubscribe', params: { name: 'message.created', arguments: {}, delivery: { mode: 'webhook', url: 'https://hooks.example/cb' } } },
]

describe('#1699 resultType under protocol 2026-07-28', () => {
  it('the dispatch table is fully enumerated (no method can be added without a conformance row)', () => {
    const idx = readFileSync(new URL('../src/mcp/index.ts', import.meta.url), 'utf8')
    const a = idx.indexOf('async function handleJsonRpc(')
    const fn = idx.slice(a, idx.indexOf('// ── app ──', a))
    const dispatched = new Set([...fn.matchAll(/(?<![.\w])method === '([^']+)'/g)].map((m) => m[1]))
    for (const m of EVENTS_METHODS) dispatched.add(m)
    // notifications/initialized answers 204 with NO body (no result to stamp); subscribe: see above.
    const covered = new Set([...RESULT_CASES.map((c) => c.method), 'notifications/initialized', 'events/subscribe'])
    expect([...dispatched].sort()).toEqual([...covered].sort())
  })

  it('every result return inside handleJsonRpc goes through the single ok() stamper', () => {
    const idx = readFileSync(new URL('../src/mcp/index.ts', import.meta.url), 'utf8')
    const a = idx.indexOf('async function handleJsonRpc(')
    const fn = idx.slice(a, idx.indexOf('// ── app ──', a))
    const direct = [...fn.matchAll(/rpcResult\(/g)].length
    expect(direct).toBe(1) // only inside ok() itself
  })

  for (const c of RESULT_CASES) {
    it(`${c.method}: carries resultType "complete" (header carrier)`, async () => {
      const r = await rpc(c.method, c.params, { header: MODERN })
      expect(r.status).toBe(200)
      expect(r.json?.error).toBeUndefined()
      expect(r.json?.result?.resultType).toBe('complete')
    })
    it(`${c.method}: carries resultType "complete" (_meta carrier, no header)`, async () => {
      const r = await rpc(c.method, c.params, { meta: true })
      expect(r.json?.error).toBeUndefined()
      expect(r.json?.result?.resultType).toBe('complete')
    })
    it(`${c.method}: legacy request (header 2025-06-18) has NO resultType`, async () => {
      const r = await rpc(c.method, c.method === 'initialize' ? { protocolVersion: '2025-06-18' } : c.params, { header: '2025-06-18' })
      if (c.method === 'server/discover' || c.method.startsWith('events/')) {
        // legacy + flag on: discover/events are served flag-on regardless of version (PR1 behaviour);
        // discover has always carried its own resultType, events results must not gain one for legacy.
        if (c.method !== 'server/discover') expect(r.json?.result && 'resultType' in r.json.result).toBe(false)
        return
      }
      expect(r.json?.result && 'resultType' in r.json.result).toBe(false)
    })
  }

  it('tools/call isError refusal result also carries resultType (a result, not a JSON-RPC error)', async () => {
    const r = await rpc('tools/call', { name: 'pot_list', arguments: {} }, { header: MODERN, bearer: 'bound-nogrants' })
    expect(r.status).toBe(200)
    expect(r.json?.result?.isError).toBe(true)
    expect(r.json?.result?.resultType).toBe('complete')
  })

  it('JSON-RPC errors carry no resultType (not results)', async () => {
    const r = await rpc('nope/nothing', undefined, { header: MODERN })
    expect(r.json?.error?.code).toBe(-32601)
    expect(r.text).not.toContain('resultType')
  })

  it('tools/list under 2026-07-28 also carries the required CacheableResult fields (SEP-2549)', async () => {
    const r = await rpc('tools/list', undefined, { header: MODERN })
    expect(r.json?.result?.ttlMs).toBe(0)
    expect(r.json?.result?.cacheScope).toBe('private')
  })

  it('flag OFF: a request carrying the 2026-07-28 header/_meta is byte-identical to one without', async () => {
    for (const c of RESULT_CASES.filter((x) => x.method === 'tools/list')) {
      const plain = await rpc(c.method, c.params, { events: 'false' })
      const hdr = await rpc(c.method, c.params, { events: 'false', header: MODERN })
      const meta = await rpc(c.method, c.params, { events: 'false', meta: true })
      expect(hdr.text).toBe(plain.text)
      expect(meta.text).toBe(plain.text)
      expect(plain.text).not.toContain('resultType')
    }
  })

  it('tools/list body under legacy is byte-identical with flag on vs off', async () => {
    const on = await rpc('tools/list', undefined, { events: 'true', header: '2025-06-18' })
    const off = await rpc('tools/list', undefined, { events: 'false', header: '2025-06-18' })
    expect(on.text).toBe(off.text)
  })

  it('modern tools/list = legacy tools/list + resultType/ttlMs/cacheScope only', async () => {
    const legacy = await rpc('tools/list', undefined, { header: '2025-06-18' })
    const modern = await rpc('tools/list', undefined, { header: MODERN })
    const { resultType, ttlMs, cacheScope, ...rest } = modern.json?.result ?? {}
    expect([resultType, ttlMs, cacheScope]).toEqual(['complete', 0, 'private'])
    expect(rest).toEqual(legacy.json?.result)
  })

  it('profile door never goes modern (events are not served there)', async () => {
    const res = await mcpRequest(
      'https://pot.example/profile/needs-you',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer bound-admin', 'mcp-protocol-version': MODERN },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      makeEnv({ events: 'true' }, []),
    )
    expect(await res.text()).not.toContain('resultType')
  })

  it('unit: isModernProtocolRequest is exact-match and flag-gated; withResultType preserves/guards', () => {
    expect(isModernProtocolRequest(false, MODERN, {})).toBe(false)
    expect(isModernProtocolRequest(true, MODERN, undefined)).toBe(true)
    expect(isModernProtocolRequest(true, ' 2026-07-28', undefined)).toBe(false)
    expect(isModernProtocolRequest(true, undefined, { _meta: META })).toBe(true)
    expect(isModernProtocolRequest(true, undefined, { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } })).toBe(false)
    expect(isModernProtocolRequest(true, undefined, { _meta: [] })).toBe(false)
    expect(withResultType({ a: 1 })).toEqual({ resultType: 'complete', a: 1 })
    expect(withResultType({ resultType: 'input_required' })).toEqual({ resultType: 'input_required' })
    expect(withResultType(null)).toBe(null)
  })
})
