// Observability: what protocolVersion each client requests on initialize / server/discover, and what we negotiated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../src/members/service'
import { NEGOTIATION_PRINCIPAL_ROW_CAP, NEGOTIATION_RETENTION_MS, NEGOTIATION_TENANT_ROW_CEILING, recordNegotiation } from '../src/mcp/negotiation-log'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { mcpRequest } from './helpers/mcp-call'

const TENANT = 'digid'
const T0 = '2026-08-01T00:00:00.000Z'
let harness: SqliteD1Harness

interface Row {
  tenant: string; at: string; method: string; harness_id: string | null; member_id: string | null; client_name: string | null
  requested_version: string; negotiated_version: string; events_returned: number
}
const rows = (): Row[] => harness.sqlite.prepare('SELECT * FROM mcp_negotiation_log ORDER BY at, rowid').all() as Row[]

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const hash = await sha256Hex('tok-secret-value')
  harness.sqlite.exec(`
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('member-1', NULL, 'Human', 'active', '${T0}', '${TENANT}');
    INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, client_name, kind) VALUES ('h-1', '${TENANT}', 'member-1', 'cid', 'ChatGPT', 'chatgpt');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant) VALUES ('tok-1', 'member-1', '${hash}', 't', 'workspace', '${T0}', NULL, '${TENANT}');
  `)
})
afterEach(() => { harness.close(); vi.restoreAllMocks() })

function env(events = 'true'): Env {
  return { TENANT_SLUG: TENANT, BRAND: 'Digid', OAUTH_PROVIDER: 'google', EVENTS_ENABLED: events, DB: harness.db } as unknown as Env
}

/** An ExecutionContext that collects waitUntil work so a test can drain the background negotiation write after the response. */
function collectingCtx(): { ctx: ExecutionContext; drain: () => Promise<void> } {
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext // test double: only waitUntil is exercised
  return { ctx, drain: async () => { await Promise.all(pending) } }
}

async function rpc(method: string, params: unknown, auth: boolean, events = 'true') {
  const { ctx, drain } = collectingCtx()
  const res = await mcpRequest('https://pot.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer tok-secret-value' } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, env(events), ctx)
  await drain()
  return (await res.json()) as { result?: { protocolVersion?: string; capabilities?: Record<string, unknown> } }
}

describe('mcp negotiation log', () => {
  it('records both versions with correct fields (authenticated)', async () => {
    const legacy = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'x', version: '1' } }, true)
    const modern = await rpc('initialize', { protocolVersion: '2026-07-28' }, true)
    expect(legacy.result?.capabilities).toEqual({ tools: {} })
    expect(modern.result?.capabilities).toHaveProperty('events')
    const r = rows()
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ tenant: TENANT, method: 'initialize', requested_version: '2025-06-18', negotiated_version: '2025-06-18', events_returned: 0 })
    expect(r[1]).toMatchObject({ method: 'initialize', requested_version: '2026-07-28', negotiated_version: '2026-07-28', events_returned: 1 })
    expect(r[0].member_id).toBe('member-1')
    expect(r[0].harness_id).toBeNull() // bearer token path carries no harness; the OAuth path does (below)
  })

  it('records the harness id and its client_name label for an OAuth-injected context', async () => {
    await recordNegotiation(env(), Date.parse(T0), {
      method: 'initialize', requested: '2026-07-28', negotiated: '2026-07-28', eventsReturned: true, principal: { harnessId: 'h-1', memberId: 'member-1' },
    })
    expect(rows()[0]).toMatchObject({ harness_id: 'h-1', client_name: 'ChatGPT', member_id: 'member-1' })
  })

  it('records an unknown / newer requested version verbatim (bounded) and what it negotiates to', async () => {
    const res = await rpc('initialize', { protocolVersion: '2027-01-01' }, true)
    expect(res.result?.protocolVersion).toBe('2025-06-18')
    const long = '2099-01-01' + 'z'.repeat(500)
    await rpc('initialize', { protocolVersion: long }, true)
    await rpc('initialize', { protocolVersion: 42 }, true)
    await rpc('initialize', {}, true)
    const r = rows()
    expect(r[0]).toMatchObject({ requested_version: '2027-01-01', negotiated_version: '2025-06-18', events_returned: 0 })
    expect(r[1].requested_version).toHaveLength(64)
    expect(r[1].requested_version.startsWith('2099-01-01zzz')).toBe(true)
    expect(r[2].requested_version).toBe('<number>')
    expect(r[3].requested_version).toBe('<absent>')
  })

  it('flag off: records what was requested and that events were not returned', async () => {
    await rpc('initialize', { protocolVersion: '2026-07-28' }, true, 'false')
    expect(rows()[0]).toMatchObject({ requested_version: '2026-07-28', negotiated_version: '2025-06-18', events_returned: 0 })
  })

  it('server/discover is recorded with its method and version source', async () => {
    await rpc('server/discover', { protocolVersion: '2026-07-28' }, true)
    expect(rows()[0]).toMatchObject({ method: 'server/discover', requested_version: '2026-07-28', events_returned: 1, negotiated_version: '2026-07-28,2025-06-18' })
  })

  it('unauthenticated: console line only, no row', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await rpc('initialize', { protocolVersion: '2026-07-28' }, false)
    expect(rows()).toHaveLength(0)
    expect(info.mock.calls.some((c) => c[0] === '[mcp:negotiation]')).toBe(true)
  })

  it('rate limit: one row per minute per principal+method+version; a new version or minute writes again', async () => {
    await rpc('initialize', { protocolVersion: '2026-07-28' }, true)
    await rpc('initialize', { protocolVersion: '2026-07-28' }, true)
    expect(rows()).toHaveLength(1)
    await rpc('initialize', { protocolVersion: '2025-06-18' }, true)
    expect(rows()).toHaveLength(2)
    const base = Date.parse(T0)
    const p = { harnessId: 'h-1', memberId: 'member-1' }
    const rec = (ms: number) => recordNegotiation(env(), base + ms, { method: 'initialize', requested: 'v', negotiated: '2025-06-18', eventsReturned: false, principal: p })
    await rec(0); await rec(30_000); await rec(61_000)
    expect(rows().filter((x) => x.requested_version === 'v')).toHaveLength(1) // upsert: one row; the minute-apart repeat updates it in place
    expect((harness.sqlite.prepare("SELECT hit_count AS n FROM mcp_negotiation_log WHERE requested_version = 'v'").get() as { n: number }).n).toBe(2) // 0s and 61s count; the 30s one is rate-limited
  })

  it('retention prune, per-principal cap, and tenant ceiling evicts oldest first', async () => {
    const base = Date.parse(T0)
    await recordNegotiation(env(), base, { method: 'initialize', requested: 'old', negotiated: 'n', eventsReturned: false, principal: { harnessId: 'h-1' } })
    await recordNegotiation(env(), base + NEGOTIATION_RETENTION_MS + 1000, { method: 'initialize', requested: 'new', negotiated: 'n', eventsReturned: false, principal: { harnessId: 'h-1' } })
    expect(rows().map((x) => x.requested_version)).toEqual(['new'])
    harness.sqlite.exec('DELETE FROM mcp_negotiation_log')
    for (let i = 0; i < NEGOTIATION_PRINCIPAL_ROW_CAP + 10; i++) {
      await recordNegotiation(env(), base + i * 61_000, { method: 'initialize', requested: `v${i}`, negotiated: 'n', eventsReturned: false, principal: { harnessId: 'h-1' } })
    }
    expect(rows()).toHaveLength(NEGOTIATION_PRINCIPAL_ROW_CAP)
    harness.sqlite.exec('DELETE FROM mcp_negotiation_log')
    const ins = harness.sqlite.prepare(`INSERT INTO mcp_negotiation_log (id, tenant, at, method, harness_id, requested_version, negotiated_version, events_returned) VALUES (?, ?, ?, 'initialize', ?, ?, 'n', 0)`)
    for (let i = 0; i < NEGOTIATION_TENANT_ROW_CEILING; i++) ins.run(`id${i}`, TENANT, new Date(base + 1000 + i).toISOString(), `other-${i % 50}`, `x${i}`)
    await recordNegotiation(env(), base + 10_000_000, { method: 'initialize', requested: 'fresh', negotiated: 'n', eventsReturned: false, principal: { harnessId: 'h-new' } })
    const all = rows()
    expect(all).toHaveLength(NEGOTIATION_TENANT_ROW_CEILING)
    expect(all.some((x) => x.requested_version === 'fresh')).toBe(true)
    expect(all.some((x) => x.at === new Date(base + 1000).toISOString())).toBe(false) // oldest evicted
  })

  it('stores no secret: the bearer and header values appear in no column or console line', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await rpc('initialize', { protocolVersion: '2026-07-28', clientInfo: { name: 'cli' } }, true)
    const dump = JSON.stringify(rows()) + JSON.stringify(info.mock.calls)
    expect(dump).not.toContain('tok-secret-value')
    expect(dump.toLowerCase()).not.toContain('bearer')
    expect(Object.keys(rows()[0]).sort()).toEqual(['at', 'client_name', 'events_returned', 'first_seen', 'harness_id', 'hit_count', 'id', 'member_id', 'method', 'negotiated_version', 'requested_version', 'tenant'])
  })

  it('upsert: a client reconnecting every minute for hours never exhausts its quota, and a NEW version still gets a row', async () => {
    const base = Date.parse(T0)
    const p = { harnessId: 'h-1', memberId: 'member-1' }
    for (let i = 0; i < NEGOTIATION_PRINCIPAL_ROW_CAP + 50; i++) {
      await recordNegotiation(env(), base + i * 61_000, { method: 'initialize', requested: '2025-06-18', negotiated: '2025-06-18', eventsReturned: false, principal: p })
    }
    expect(rows().filter((x) => x.requested_version === '2025-06-18')).toHaveLength(1)
    const row = harness.sqlite.prepare("SELECT hit_count AS n, first_seen AS f, at FROM mcp_negotiation_log WHERE requested_version = '2025-06-18'").get() as { n: number; f: string; at: string }
    expect(row.n).toBe(NEGOTIATION_PRINCIPAL_ROW_CAP + 50)
    expect(row.f).toBe(T0)
    expect(row.at > row.f).toBe(true)
    await recordNegotiation(env(), base + 999 * 61_000, { method: 'initialize', requested: '2026-07-28', negotiated: '2025-06-18', eventsReturned: false, principal: p })
    expect(rows().map((x) => x.requested_version).sort()).toEqual(['2025-06-18', '2026-07-28'])
  })

  it('anonymous: the console line carries only the bucketed version and no clientInfo label', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await rpc('initialize', { protocolVersion: 'attacker-controlled-free-text', clientInfo: { name: 'evil-label' } }, false)
    const line = JSON.stringify(info.mock.calls.filter((c) => c[0] === '[mcp:negotiation]'))
    expect(line).not.toContain('attacker-controlled-free-text')
    expect(line).not.toContain('evil-label')
    expect(line).toContain('other')
    expect(rows()).toHaveLength(0)
  })

  it('a held seat leaves no row', async () => {
    await recordNegotiation(env(), Date.parse(T0), { method: 'initialize', requested: '2025-06-18', negotiated: 'n', eventsReturned: false, principal: { harnessId: 'h-1', heldSeat: true } })
    expect(rows()).toHaveLength(0)
  })
  // A DB whose negotiation INSERT blocks until released: proves the response never waits on the observability write.
  function slowWriteEnv(): { env: Env; release: () => void; started: () => boolean } {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let started = false
    const real = harness.db
    const db = new Proxy(real, {
      get(t, k, rcv) {
        if (k !== 'prepare') return Reflect.get(t, k, rcv)
        return (sql: string) => {
          const st = t.prepare(sql)
          if (!sql.includes('INSERT INTO mcp_negotiation_log')) return st
          return new Proxy(st, {
            get(s, kk) {
              if (kk === 'bind') return (...a: unknown[]) => { const b = s.bind(...a); return new Proxy(b, { get(bs, bk) { if (bk === 'run') return async () => { started = true; await gate; return bs.run() }; return Reflect.get(bs, bk) } }) }
              return Reflect.get(s, kk)
            },
          })
        }
      },
    })
    return { env: { ...env(), DB: db } as unknown as Env, release, started: () => started }
  }
  const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const initInit = { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok-secret-value' }, body: initBody }

  it('NO execution context: initialize returns BEFORE a slow negotiation write resolves (fire-and-forget, not await)', async () => {
    const slow = slowWriteEnv()
    const res = await Promise.race([
      mcpRequest('https://pot.example/', initInit, slow.env),
      new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500)),
    ])
    expect(res).not.toBe('blocked')
    expect(rows()).toHaveLength(0) // the write is still gated: the response did not wait for it
    slow.release()
    await vi.waitFor(() => expect(rows()).toHaveLength(1))
  })

  it('WITH an execution context: the write rides waitUntil and the response does not wait for it', async () => {
    const slow = slowWriteEnv()
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await Promise.race([
      mcpRequest('https://pot.example/', initInit, slow.env, ctx),
      new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500)),
    ])
    expect(res).not.toBe('blocked')
    expect(pending).toHaveLength(1)
    expect(rows()).toHaveLength(0)
    slow.release()
    await Promise.all(pending)
    expect(rows()).toHaveLength(1)
  })

  it('version source: header / _meta never leak into the recorded version or the bucket (negotiation reads params.protocolVersion only)', async () => {
    const c1 = collectingCtx()
    const res = await mcpRequest('https://pot.example/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-secret-value', 'mcp-protocol-version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }),
    }, env(), c1.ctx)
    await c1.drain()
    expect(((await res.json()) as { result?: { protocolVersion?: string } }).result?.protocolVersion).toBe('2025-06-18')
    expect(rows()[0]).toMatchObject({ requested_version: '<absent>', negotiated_version: '2025-06-18', events_returned: 0 })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await rpc('initialize', {}, false)
    const line = info.mock.calls.find((c) => c[0] === '[mcp:negotiation]')
    expect(JSON.stringify(line)).toContain('undefined') // bucket = typeof undefined, same as the [mcp:initialize] line
  })

  it('Events off: server/discover is logged as events_returned=false (and still answers method_not_found)', async () => {
    const c2 = collectingCtx()
    const res = await mcpRequest('https://pot.example/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-secret-value' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { protocolVersion: '2026-07-28' } }),
    }, env('false'), c2.ctx)
    await c2.drain()
    expect(((await res.json()) as { error?: { code?: number } }).error?.code).toBe(-32601)
    expect(rows()[0]).toMatchObject({ method: 'server/discover', requested_version: '2026-07-28', events_returned: 0 })
  })
})
