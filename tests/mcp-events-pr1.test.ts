// mupot#1618 — MCP Events PR 1: protocol negotiation, server/discover, events/list catalogue.
// No subscribe/delivery exists in this build; these tests also prove that.
// Real SQL: the schema is the whole committed migration chain (applyAllMigrations).
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpApp } from '../src/mcp'
import { sendAgentMessage } from '../src/agents/messages'
import { readAfterSeq } from '../src/mcp/events'
import { sha256Hex } from '../src/members/service'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const SNAPSHOT_PATH = new URL('./fixtures/mcp-legacy-snapshots.json', import.meta.url)
const TENANT = 'digid'
const T0 = '2026-08-01T00:00:00.000Z'

// Bearer name -> what that principal is.
//   bound-admin      agent-bound workspace token, org admin (holds the needs_you_list floor)
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
    DB: {
      prepare(sql: string) {
        sqlLog.push(sql)
        return harness.db.prepare(sql)
      },
      batch: (stmts: Parameters<typeof harness.db.batch>[0]) => harness.db.batch(stmts),
    },
  } as unknown as Env
}

/** Every row of every table except member_tokens (the pre-existing last_used telemetry touch). */
function dumpState(): string {
  const tables = harness.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]
  const out: Record<string, unknown[]> = {}
  for (const { name } of tables) {
    if (name === 'member_tokens') continue
    out[name] = harness.sqlite.prepare(`SELECT * FROM "${name}"`).all()
  }
  return JSON.stringify(out)
}

async function rawRpc(method: string, params: unknown, opts: EnvOpts = {}, auth = false, sqlLog: string[] = []) {
  const res = await mcpApp.request(
    'https://pot.example/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${opts.bearer ?? 'unbound-admin'}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
    },
    makeEnv(opts, sqlLog),
  )
  return { status: res.status, text: await res.text() }
}

interface RpcBody {
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}
const parse = (t: string): RpcBody => JSON.parse(t) as RpcBody

const LEGACY_CASES: { key: string; method: string; params?: unknown; auth: boolean }[] = [
  { key: 'initialize:none', method: 'initialize', auth: false },
  { key: 'initialize:2025-06-18', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, auth: false },
  { key: 'initialize:2024-11-05', method: 'initialize', params: { protocolVersion: '2024-11-05' }, auth: false },
  { key: 'initialize:garbage', method: 'initialize', params: { protocolVersion: 42 }, auth: false },
  { key: 'tools/list', method: 'tools/list', auth: false },
  { key: 'tools/call:status', method: 'tools/call', params: { name: 'status', arguments: {} }, auth: true },
  { key: 'method_not_found', method: 'nope/nothing', auth: false },
]

async function captureLegacy(events: string | undefined): Promise<Record<string, { status: number; text: string }>> {
  const out: Record<string, { status: number; text: string }> = {}
  for (const c of LEGACY_CASES) out[c.key] = await rawRpc(c.method, c.params, { events }, c.auth)
  return out
}

describe('legacy (2025-06-18) surface is byte-identical', () => {
  // Golden generated from origin/main 0071a552 (BEFORE this change) with GEN_MCP_SNAPSHOT=1.
  if (process.env.GEN_MCP_SNAPSHOT === '1') {
    it('generates the golden file', async () => {
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(await captureLegacy(undefined), null, 1) + '\n')
    })
    return
  }
  const golden = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Record<string, { status: number; text: string }>

  for (const flag of [undefined, 'true', 'false']) {
    it(`matches the pre-change bytes with EVENTS_ENABLED=${String(flag)}`, async () => {
      const now = await captureLegacy(flag)
      expect(Object.keys(now)).toEqual(Object.keys(golden))
      for (const key of Object.keys(golden)) expect(now[key], key).toEqual(golden[key])
    })
  }

  it('the golden really pins 2025-06-18 and tools-only capabilities', () => {
    const init = parse(golden['initialize:none'].text)
    expect(init.result?.protocolVersion).toBe('2025-06-18')
    expect(init.result?.capabilities).toEqual({ tools: {} })
  })
})

describe('protocol negotiation', () => {
  it('gives 2026-07-28 only to a client that asks for exactly that', async () => {
    const { result } = parse((await rawRpc('initialize', { protocolVersion: '2026-07-28' })).text)
    expect(result?.protocolVersion).toBe('2026-07-28')
  })

  it('never advertises events in initialize capabilities while the flag is off', async () => {
    const { result } = parse((await rawRpc('initialize', { protocolVersion: '2026-07-28' })).text)
    expect(result?.capabilities).toEqual({ tools: {} })
  })

  it('advertises events for a 2026-07-28 initialize only when the flag is on', async () => {
    const { result } = parse((await rawRpc('initialize', { protocolVersion: '2026-07-28' }, { events: 'true' })).text)
    expect(result?.capabilities).toEqual({ tools: {}, events: {} })
  })

  it.each([undefined, '2025-06-18', '2025-03-26', '2027-01-01', 20260728, null])(
    'keeps the legacy default for requested version %s',
    async (v) => {
      const params = v === undefined ? undefined : { protocolVersion: v }
      const { result } = parse((await rawRpc('initialize', params, { events: 'true' })).text)
      expect(result?.protocolVersion).toBe('2025-06-18')
      expect(result?.capabilities).toEqual({ tools: {} })
    },
  )
})

describe('server/discover', () => {
  it('flag off (default): supportedVersions + tools only, no events', async () => {
    const r = await rawRpc('server/discover', undefined)
    expect(r.status).toBe(200)
    expect(parse(r.text).result).toEqual({
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-06-18'],
      capabilities: { tools: {} },
    })
  })

  it.each(['false', 'TRUE', '1', ''])('flag value %j is still off', async (v) => {
    const { result } = parse((await rawRpc('server/discover', undefined, { events: v })).text)
    expect(result?.capabilities).toEqual({ tools: {} })
  })

  it('flag on: advertises events', async () => {
    const { result } = parse((await rawRpc('server/discover', undefined, { events: 'true' })).text)
    expect(result).toEqual({
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-06-18'],
      capabilities: { tools: {}, events: {} },
    })
  })
})

const BOUND_ADMIN: EnvOpts = { events: 'true', bearer: 'bound-admin' }

describe('events/* with the flag off', () => {
  it.each(['events/list', 'events/subscribe', 'events/unsubscribe'])('%s is method-not-found', async (m) => {
    const sql: string[] = []
    const r = await rawRpc(m, {}, { bearer: 'bound-admin' }, true, sql)
    expect(parse(r.text).error).toMatchObject({ code: -32601, message: 'method_not_found', data: m })
    expect(sql).toEqual([]) // no auth or DB work at all
  })
})

describe('events/list', () => {
  it('requires authentication (401)', async () => {
    const r = await rawRpc('events/list', {}, BOUND_ADMIN, false)
    expect(r.status).toBe(401)
    expect(parse(r.text).error?.message).toBe('unauthenticated')
  })

  it('returns the v1 catalogue with spec-shaped definitions for a bound agent', async () => {
    const r = await rawRpc('events/list', {}, BOUND_ADMIN, true)
    expect(r.status).toBe(200)
    const events = parse(r.text).result?.events as Record<string, unknown>[]
    expect(events.map((e) => e.name)).toEqual(['message.created', 'needs_you.created'])
    for (const e of events) {
      // spec: name, description, delivery ['webhook'], inputSchema, payloadSchema
      expect(Object.keys(e).sort()).toEqual(['delivery', 'description', 'inputSchema', 'name', 'payloadSchema'])
      expect(e.delivery).toEqual(['webhook'])
      expect(typeof e.description).toBe('string')
      expect(e.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false })
      expect(e.payloadSchema).toMatchObject({ type: 'object', additionalProperties: false })
    }
    expect(events[0].payloadSchema).toMatchObject({
      properties: { message_id: {}, seq: {}, read_after_seq: {}, kind: {}, request_id: {} },
      required: ['message_id', 'seq', 'read_after_seq', 'kind', 'request_id'],
    })
    expect(events[1].payloadSchema).toMatchObject({
      properties: { item_id: {}, project_id: {}, kind: {} },
      required: ['item_id', 'kind'],
    })
    // no nextCursor on a single page
    expect(parse(r.text).result).not.toHaveProperty('nextCursor')
  })

  it('accepts cursor:null, rejects a cursor it never issued', async () => {
    expect((await rawRpc('events/list', { cursor: null }, BOUND_ADMIN, true)).status).toBe(200)
    const bad = parse((await rawRpc('events/list', { cursor: 'abc' }, BOUND_ADMIN, true)).text)
    expect(bad.error?.code).toBe(-32602)
  })

  it('an UNBOUND session gets an EMPTY catalogue, not the full one', async () => {
    const r = await rawRpc('events/list', {}, { events: 'true', bearer: 'unbound-admin' }, true)
    expect(r.status).toBe(200)
    expect(parse(r.text).result).toEqual({ events: [] })
  })

  it('a zero-capability directory session (weld nulled) gets an EMPTY catalogue', async () => {
    const r = await rawRpc('events/list', {}, { events: 'true', bearer: 'dir-zero' }, true)
    expect(parse(r.text).result).toEqual({ events: [] })
  })

  it('a bound agent without the needs_you_list floor sees only message.created', async () => {
    const r = await rawRpc('events/list', {}, { events: 'true', bearer: 'bound-nogrants' }, true)
    const names = (parse(r.text).result?.events as { name: string }[]).map((e) => e.name)
    expect(names).toEqual(['message.created'])
  })
})

describe('events/subscribe + events/unsubscribe are not implemented and write nothing', () => {
  const subscribeParams = {
    name: 'message.created',
    arguments: {},
    delivery: { mode: 'webhook', url: 'https://receiver.example.com/cb', secret: 'whsec_' + 'A'.repeat(43) },
    cursor: null,
    ttlMs: null,
  }

  it.each(['events/subscribe', 'events/unsubscribe'])('%s refuses, with no writes and no fetch', async (m) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const before = dumpState()
    const r = await rawRpc(m, subscribeParams, BOUND_ADMIN, true, [])
    expect(parse(r.text).error).toMatchObject({ code: -32601, message: 'not_implemented' })
    expect(parse(r.text).result).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(dumpState()).toBe(before) // no row anywhere changed
  })

  it.each(['events/subscribe', 'events/unsubscribe'])('%s still requires authentication', async (m) => {
    const sql: string[] = []
    const r = await rawRpc(m, subscribeParams, BOUND_ADMIN, false, sql)
    expect(r.status).toBe(401)
    expect(sql).toEqual([])
  })
})

// ── the catalogue's own read instruction must actually work (Athena BLOCK_P1) ──────────────
describe('message.created read instruction is TRUE end to end (real SQL)', () => {
  const SYSTEM = { system: true, reason: 'test fixture' } as const

  async function deliver(to: string, body: string): Promise<{ id: string; seq: number }> {
    const r = await sendAgentMessage(
      makeEnv({}, []),
      { fromAgent: 'agent-b', fromMember: 'member-agent-b', toAgent: to, body },
      SYSTEM,
    )
    if (!r.ok) throw new Error(`fixture send failed: ${r.reason}`)
    // The seq the event payload would carry: read from the row, not from the send result.
    const row = harness.sqlite.prepare('SELECT seq FROM agent_messages WHERE id = ?').all(r.id)[0] as { seq: number } | undefined
    if (!row) throw new Error('fixture row missing')
    return { id: r.id, seq: Number(row.seq) }
  }

  /** Call the inbox tool exactly as the catalogue instructs, as the bound agent-a bearer. */
  async function inboxAsCatalogueSays(readAfter: number, bearer: Bearer = 'bound-admin') {
    const r = await rawRpc('tools/call', { name: 'inbox', arguments: { peek: true, since_seq: readAfter, limit: 1 } }, { bearer }, true)
    expect(r.status).toBe(200)
    const sc = (JSON.parse(r.text) as { result: { structuredContent: { messages: { id: string; seq: number; body: string; to_agent?: string }[] } } }).result.structuredContent
    return sc.messages
  }

  async function catalogueMessageCreated(): Promise<Record<string, unknown>> {
    const r = await rawRpc('events/list', {}, BOUND_ADMIN, true)
    const events = parse(r.text).result?.events as Record<string, unknown>[]
    return events.find((e) => e.name === 'message.created') as Record<string, unknown>
  }

  it('the catalogue text names inbox with read_after_seq and never message_get', async () => {
    const def = await catalogueMessageCreated()
    const text = JSON.stringify(def)
    expect(text).toContain('inbox {\\"peek\\":true,\\"since_seq\\":<read_after_seq>,\\"limit\\":1}')
    expect(text).toContain('read_after_seq')
    expect(text).not.toContain('message_get')
    expect(text).not.toMatch(/pass as since_seq to inbox\.? *$/)
  })

  it('readAfterSeq is seq-1 and never negative', () => {
    expect(readAfterSeq(5)).toBe(4)
    expect(readAfterSeq(1)).toBe(0)
    expect(readAfterSeq(0)).toBe(0)
  })

  it("returns exactly the triggering message for the bound agent, with older and newer rows present", async () => {
    const older = await deliver('agent-a', 'older unread')
    const trigger = await deliver('agent-a', 'the trigger')
    const newer = await deliver('agent-a', 'newer')
    const foreign = await deliver('agent-b', 'someone elses mail')
    expect(new Set([older.seq, trigger.seq, newer.seq, foreign.seq]).size).toBe(4)

    const got = await inboxAsCatalogueSays(readAfterSeq(trigger.seq))
    expect(got.map((m) => m.id)).toEqual([trigger.id])
    expect(got[0].body).toBe('the trigger')
    expect(got.map((m) => m.id)).not.toContain(foreign.id)
  })

  it('the naive since_seq=seq (the bug) would SKIP the triggering row', async () => {
    const trigger = await deliver('agent-a', 'the trigger')
    const later = await deliver('agent-a', 'later')
    const naive = await inboxAsCatalogueSays(trigger.seq)
    expect(naive.map((m) => m.id)).toEqual([later.id])
  })

  it('a foreign agent’s message id / seq yields nothing for the reader', async () => {
    const foreign = await deliver('agent-b', 'private to agent-b')
    const got = await inboxAsCatalogueSays(readAfterSeq(foreign.seq)) // agent-a reading
    expect(got.map((m) => m.id)).not.toContain(foreign.id)
    expect(got).toEqual([])
    // and the mirror: agent-b's own token does see it, proving the row is really there
    const own = await inboxAsCatalogueSays(readAfterSeq(foreign.seq), 'bound-nogrants')
    expect(own.map((m) => m.id)).toEqual([foreign.id])
  })
})
