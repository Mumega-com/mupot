// mupot#1618 — MCP Events PR 1: protocol negotiation, server/discover, events/list catalogue.
// (PR 2 adds subscribe/delivery: tests/mcp-events-pr2.test.ts.)
// Real SQL: the schema is the whole committed migration chain (applyAllMigrations).
import { readFileSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpApp, TOOLS } from '../src/mcp'
import { sendAgentMessage } from '../src/agents/messages'
import { InvalidEventSeqError, readAfterSeq } from '../src/mcp/events'
import { sha256Hex } from '../src/members/service'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const SNAPSHOT_PATH = new URL('./fixtures/mcp-legacy-snapshots.json', import.meta.url)
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

// Golden scope (deliberately narrow): ONLY what this PR can change - initialize (every shape,
// including an exact 2026-07-28 ask), the JSON-RPC error envelope (unknown methods, server/discover
// and events/* with the flag off), and tools/call on a stable read tool. NOT the tools/list body or
// the server version, so an unrelated tool edit or version bump cannot break it. initialize's
// serverInfo.version and instructions are normalised (they change with unrelated edits); every other
// byte is compared.
const GOLDEN_CASES: { key: string; method: string; params?: unknown; auth: boolean; flagInvariant: boolean }[] = [
  { key: 'initialize:none', method: 'initialize', auth: false, flagInvariant: true },
  { key: 'initialize:2025-06-18', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, auth: false, flagInvariant: true },
  { key: 'initialize:2024-11-05', method: 'initialize', params: { protocolVersion: '2024-11-05' }, auth: false, flagInvariant: true },
  { key: 'initialize:garbage', method: 'initialize', params: { protocolVersion: 42 }, auth: false, flagInvariant: true },
  { key: 'tools/call:status', method: 'tools/call', params: { name: 'status', arguments: {} }, auth: true, flagInvariant: true },
  { key: 'method_not_found', method: 'nope/nothing', auth: false, flagInvariant: true },
  // With the flag OFF these must be exactly what main answers. With it ON they legitimately differ.
  { key: 'initialize:2026-07-28', method: 'initialize', params: { protocolVersion: '2026-07-28' }, auth: false, flagInvariant: false },
  { key: 'server/discover', method: 'server/discover', auth: false, flagInvariant: false },
  { key: 'events/list', method: 'events/list', params: {}, auth: true, flagInvariant: false },
  { key: 'events/subscribe', method: 'events/subscribe', params: {}, auth: true, flagInvariant: false },
  { key: 'events/unsubscribe', method: 'events/unsubscribe', params: {}, auth: true, flagInvariant: false },
]

function normalise(text: string): string {
  const j = JSON.parse(text) as { result?: { serverInfo?: { version?: string }; instructions?: string } }
  if (j.result?.serverInfo) j.result.serverInfo.version = '<version>'
  if (j.result && 'instructions' in j.result) j.result.instructions = '<instructions>'
  return JSON.stringify(j)
}

async function captureGolden(events: string | undefined, onlyInvariant = false): Promise<Record<string, { status: number; text: string }>> {
  const out: Record<string, { status: number; text: string }> = {}
  for (const c of GOLDEN_CASES) {
    if (onlyInvariant && !c.flagInvariant) continue
    const r = await rawRpc(c.method, c.params, { events, bearer: 'unbound-admin' }, c.auth)
    out[c.key] = { status: r.status, text: normalise(r.text) }
  }
  return out
}

describe('flag-off / legacy surface is byte-identical to main', () => {
  // Golden generated from origin/main (BEFORE this change) with GEN_MCP_SNAPSHOT=1.
  if (process.env.GEN_MCP_SNAPSHOT === '1') {
    it('generates the golden file', async () => {
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(await captureGolden(undefined), null, 1) + '\n')
    })
    return
  }
  const golden = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Record<string, { status: number; text: string }>

  for (const flag of [undefined, 'false', 'TRUE', '1', '']) {
    it(`EVERY request matches main with EVENTS_ENABLED=${JSON.stringify(flag)}`, async () => {
      const now = await captureGolden(flag)
      expect(Object.keys(now)).toEqual(Object.keys(golden))
      for (const key of Object.keys(golden)) expect(now[key], key).toEqual(golden[key])
    })
  }

  it('flag ON leaves every pre-existing (flag-invariant) request byte-identical', async () => {
    const now = await captureGolden('true', true)
    for (const key of Object.keys(now)) expect(now[key], key).toEqual(golden[key])
  })

  it('the golden pins 2025-06-18 + tools-only, method_not_found for the new methods, and the exact-2026 ask', () => {
    const init = parse(golden['initialize:none'].text)
    expect(init.result?.protocolVersion).toBe('2025-06-18')
    expect(init.result?.capabilities).toEqual({ tools: {} })
    expect(parse(golden['initialize:2026-07-28'].text).result?.protocolVersion).toBe('2025-06-18')
    for (const k of ['server/discover', 'events/list', 'events/subscribe', 'events/unsubscribe']) {
      expect(parse(golden[k].text).error?.code, k).toBe(-32601)
      expect(parse(golden[k].text).error?.message, k).toBe('method_not_found')
    }
  })

  it('tools/list tool NAMES are unchanged, flag off and on (derived from the registry, not a frozen body)', async () => {
    const expected = TOOLS.map((t) => t.name)
    for (const flag of [undefined, 'true']) {
      const { text } = await rawRpc('tools/list', undefined, { events: flag })
      const names = (parse(text).result?.tools as { name: string }[]).map((t) => t.name)
      expect(names).toEqual(expected)
    }
  })
})

describe('protocol negotiation (flag on)', () => {
  const ON: EnvOpts = { events: 'true' }

  it('gives 2026-07-28 only to a client that asks for exactly that', async () => {
    const { result } = parse((await rawRpc('initialize', { protocolVersion: '2026-07-28' }, ON)).text)
    expect(result?.protocolVersion).toBe('2026-07-28')
    expect(result?.capabilities).toEqual({ tools: {}, events: {} })
  })

  it.each([undefined, '2025-06-18', '2025-03-26', '2027-01-01', 20260728, null, ' 2026-07-28', '2026-07-28 ', '2026-07-28\n', '2026-07-28\u0000', '2026-7-28', '2026-07-28T', '２０２６-07-28'])(
    'keeps the legacy default for requested version %j',
    async (v) => {
      const params = v === undefined ? undefined : { protocolVersion: v }
      const { result } = parse((await rawRpc('initialize', params, ON)).text)
      expect(result?.protocolVersion).toBe('2025-06-18')
      expect(result?.capabilities).toEqual({ tools: {} })
    },
  )

  it('flag OFF: an exact 2026-07-28 ask still gets the legacy answer', async () => {
    const { result } = parse((await rawRpc('initialize', { protocolVersion: '2026-07-28' })).text)
    expect(result?.protocolVersion).toBe('2025-06-18')
    expect(result?.capabilities).toEqual({ tools: {} })
  })
})

describe('server/discover', () => {
  it('flag off (default): method_not_found, exactly like main', async () => {
    const r = await rawRpc('server/discover', undefined)
    expect(parse(r.text).error).toMatchObject({ code: -32601, message: 'method_not_found', data: 'server/discover' })
  })

  it.each(['false', 'TRUE', '1', ''])('flag value %j is still off', async (v) => {
    expect(parse((await rawRpc('server/discover', undefined, { events: v })).text).error?.code).toBe(-32601)
  })

  it('flag on: supportedVersions + events capability', async () => {
    const r = await rawRpc('server/discover', undefined, { events: 'true' })
    expect(r.status).toBe(200)
    expect(parse(r.text).result).toEqual({
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

  it('rejects a principal from another tenant (tenant check in the events branch)', async () => {
    const forged = { userId: 'member-1', email: null, role: 'member', tenant: 'othertenant', channel: 'workspace' }
    const res = await mcpApp.request(
      'https://pot.example/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mupot-auth-context': JSON.stringify(forged) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/list', params: {} }),
      },
      makeEnv({ events: 'true' }, []),
    )
    expect(res.status).toBe(401)
    expect((JSON.parse(await res.text()) as RpcBody).error?.message).toBe('unauthenticated')
  })

  it('returns ONLY message.created, spec-shaped, for a bound agent', async () => {
    const r = await rawRpc('events/list', {}, BOUND_ADMIN, true)
    expect(r.status).toBe(200)
    const events = parse(r.text).result?.events as Record<string, unknown>[]
    expect(events.map((e) => e.name)).toEqual(['message.created'])
    const e = events[0]
    expect(Object.keys(e).sort()).toEqual(['delivery', 'description', 'inputSchema', 'name', 'payloadSchema'])
    expect(e.delivery).toEqual(['webhook'])
    expect(typeof e.description).toBe('string')
    expect(e.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    expect(e.payloadSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: { message_id: {}, seq: {}, read_after_seq: {}, kind: {}, request_id: {} },
      required: ['message_id', 'seq', 'read_after_seq', 'kind', 'request_id'],
    })
    expect(JSON.stringify(events)).not.toContain('needs_you')
    expect(parse(r.text).result).not.toHaveProperty('nextCursor')
  })

  it('accepts cursor:null, rejects a cursor it never issued', async () => {
    expect((await rawRpc('events/list', { cursor: null }, BOUND_ADMIN, true)).status).toBe(200)
    expect(parse((await rawRpc('events/list', { cursor: 'abc' }, BOUND_ADMIN, true)).text).error?.code).toBe(-32602)
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

  it('a bound agent with no grants still sees message.created (inbox floor is "authenticated")', async () => {
    const r = await rawRpc('events/list', {}, { events: 'true', bearer: 'bound-nogrants' }, true)
    expect((parse(r.text).result?.events as { name: string }[]).map((e) => e.name)).toEqual(['message.created'])
  })

  it("derives the floor from the inbox tool's own min: raising it hides the event from a caller who could not call inbox", async () => {
    const inbox = TOOLS.find((t) => t.name === 'inbox')
    if (!inbox) throw new Error('inbox tool missing')
    const original = inbox.min
    try {
      inbox.min = 'admin'
      const noGrants = parse((await rawRpc('events/list', {}, { events: 'true', bearer: 'bound-nogrants' }, true)).text)
      expect(noGrants.result).toEqual({ events: [] })
      // ... while a caller who DOES pass that floor still sees it (the test is not just "always empty")
      const admin = parse((await rawRpc('events/list', {}, BOUND_ADMIN, true)).text)
      expect((admin.result?.events as { name: string }[]).map((e) => e.name)).toEqual(['message.created'])
    } finally {
      inbox.min = original
    }
  })
})

describe('events/subscribe + events/unsubscribe with the DEFAULT (empty) callback allowlist write nothing', () => {
  // PR 2 replaced the PR 1 not_implemented stubs (full behaviour: tests/mcp-events-pr2.test.ts).
  // What PR 1 pinned and still holds: with EVENTS_CALLBACK_HOSTS unset, a subscribe cannot reach
  // any host and stores nothing.
  const subscribeParams = {
    name: 'message.created',
    arguments: {},
    delivery: { mode: 'webhook', url: 'https://receiver.example.com/cb', secret: 'whsec_' + 'A'.repeat(43) },
    cursor: null,
    ttlMs: null,
  }

  it('events/subscribe refuses every URL by default, with no writes and no fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const before = dumpState()
    const r = await rawRpc('events/subscribe', subscribeParams, BOUND_ADMIN, true, [])
    expect(parse(r.text).error).toMatchObject({ code: -32015, data: { reason: 'callback_host_not_allowed' } })
    expect(parse(r.text).result).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(dumpState()).toBe(before)
  })

  it('events/unsubscribe of a subscription that does not exist is an idempotent no-op', async () => {
    const before = dumpState()
    const r = await rawRpc('events/unsubscribe', subscribeParams, BOUND_ADMIN, true, [])
    expect(parse(r.text).result).toEqual({})
    expect(dumpState()).toBe(before)
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

  async function deliver(to: string, body: string, targetSeat?: string): Promise<{ id: string; seq: number }> {
    const r = await sendAgentMessage(
      makeEnv({}, []),
      { fromAgent: 'agent-b', fromMember: 'member-agent-b', toAgent: to, body, ...(targetSeat ? { targetSeat } : {}) },
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
    // verify-the-id instruction + the signed-reader caveat (Athena/adversarial r2)
    expect(text).toContain("ALWAYS VERIFY that the returned message's id equals the event's message_id")
    expect(def.description as string).toContain('no longer readable') // in the event description itself, not only the payload notes
    expect((def.payloadSchema as { properties: { read_after_seq: { description: string } } }).properties.read_after_seq.description).toContain('no longer readable')
    expect(text).toContain('consumer_fenced')
    expect(text).not.toContain('first returned message is the triggering')
    expect(text).not.toMatch(/pass as since_seq to inbox\.? *$/)
  })

  it('readAfterSeq is seq-1 and never negative', () => {
    expect(readAfterSeq(5)).toBe(4)
    expect(readAfterSeq(1)).toBe(0)
    expect(readAfterSeq(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER - 1)
  })

  it.each([NaN, Infinity, -Infinity, 1.5, -1, 0, -0, Number.MAX_SAFE_INTEGER + 2, '5', null, undefined, {}, 5n])(
    'readAfterSeq refuses %p with a typed error',
    (bad) => {
      expect(() => readAfterSeq(bad)).toThrow(InvalidEventSeqError)
      try {
        readAfterSeq(bad)
      } catch (e) {
        expect((e as InvalidEventSeqError).code).toBe('invalid_event_seq')
      }
    },
  )

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

describe('message.created recovery-read edge cases (why the description says VERIFY the id)', () => {
  const SYSTEM = { system: true, reason: 'test fixture' } as const

  async function deliver(to: string, body: string, targetSeat?: string): Promise<{ id: string; seq: number }> {
    const r = await sendAgentMessage(
      makeEnv({}, []),
      { fromAgent: 'agent-b', fromMember: 'member-agent-b', toAgent: to, body, ...(targetSeat ? { targetSeat } : {}) },
      SYSTEM,
    )
    if (!r.ok) throw new Error(`fixture send failed: ${r.reason}`)
    const row = harness.sqlite.prepare('SELECT seq FROM agent_messages WHERE id = ?').all(r.id)[0] as { seq: number }
    return { id: r.id, seq: Number(row.seq) }
  }

  async function inboxCall(readAfter: number) {
    const r = await rawRpc('tools/call', { name: 'inbox', arguments: { peek: true, since_seq: readAfter, limit: 1 } }, { bearer: 'bound-admin' }, true)
    return { status: r.status, body: JSON.parse(r.text) as { result?: { structuredContent: { messages: { id: string }[] } }; error?: { message: string } } }
  }

  it('trigger already consumed: the NEXT newer message comes back, so a client must see the id mismatch', async () => {
    const trigger = await deliver('agent-a', 'trigger')
    const newer = await deliver('agent-a', 'newer')
    harness.sqlite.prepare('UPDATE agent_messages SET read_at = ? WHERE id = ?').run(T0, trigger.id)
    const got = (await inboxCall(readAfterSeq(trigger.seq))).body.result?.structuredContent.messages ?? []
    expect(got.map((m) => m.id)).toEqual([newer.id])
    expect(got[0].id).not.toBe(trigger.id) // the documented mismatch => "no longer readable"
  })

  it('trigger addressed to another seat: invisible to this reader, the next broadcast message returns', async () => {
    const seated = await deliver('agent-a', 'for seat x only')
    harness.sqlite.prepare("UPDATE agent_messages SET target_seat = 'seat-x' WHERE id = ?").run(seated.id) // send validates seats; set directly
    const broadcast = await deliver('agent-a', 'broadcast')
    const got = (await inboxCall(readAfterSeq(seated.seq))).body.result?.structuredContent.messages ?? []
    expect(got.map((m) => m.id)).toEqual([broadcast.id])
    expect(got.map((m) => m.id)).not.toContain(seated.id)
  })

  it('signed-reader-only inbox: the recovery read is refused 409 consumer_fenced', async () => {
    const trigger = await deliver('agent-a', 'trigger')
    harness.sqlite.exec(`INSERT INTO agent_inbox_fences (tenant, agent_id, mode, generation, key_fingerprint, updated_by_member_id, updated_at, reason)
      VALUES ('${TENANT}', 'agent-a', 'signed_only', 1, '${'a'.repeat(64)}', 'member-1', '${T0}', 'test')`)
    const r = await inboxCall(readAfterSeq(trigger.seq))
    expect(r.body.error?.message).toBe('consumer_fenced')
  })
})

// ── the curated profile door must not serve events at all (adversarial r2 P2-1) ───────────
describe('POST /mcp/profile/needs-you is byte-identical with the flag ON and OFF', () => {
  async function profileRpc(method: string, params: unknown, events: string | undefined, auth: boolean) {
    const res = await mcpApp.request(
      'https://pot.example/profile/needs-you',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer bound-admin' } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
      },
      makeEnv({ events }, []),
    )
    return { status: res.status, text: await res.text() }
  }

  const CASES: { key: string; method: string; params?: unknown; auth: boolean }[] = [
    { key: 'initialize:2026-07-28', method: 'initialize', params: { protocolVersion: '2026-07-28' }, auth: false },
    { key: 'initialize:none', method: 'initialize', auth: false },
    { key: 'server/discover', method: 'server/discover', auth: false },
    { key: 'server/discover:auth', method: 'server/discover', auth: true },
    { key: 'events/list', method: 'events/list', params: {}, auth: true },
    { key: 'events/list:unauth', method: 'events/list', params: {}, auth: false },
    { key: 'events/subscribe', method: 'events/subscribe', params: {}, auth: true },
    { key: 'events/unsubscribe', method: 'events/unsubscribe', params: {}, auth: true },
    { key: 'tools/list', method: 'tools/list', auth: true },
    { key: 'tools/call:inbox', method: 'tools/call', params: { name: 'inbox', arguments: {} }, auth: true },
  ]

  for (const c of CASES) {
    it(`${c.key}: flag "true" == flag off`, async () => {
      const off = await profileRpc(c.method, c.params, undefined, c.auth)
      const on = await profileRpc(c.method, c.params, 'true', c.auth)
      expect(on).toEqual(off)
    })
  }

  it('on the profile door the events methods and discover are method_not_found and 2026-07-28 is not negotiated (flag ON)', async () => {
    for (const m of ['server/discover', 'events/list', 'events/subscribe', 'events/unsubscribe']) {
      const r = await profileRpc(m, {}, 'true', true)
      expect(JSON.parse(r.text).error, m).toMatchObject({ code: -32601, message: 'method_not_found', data: m })
    }
    const init = JSON.parse((await profileRpc('initialize', { protocolVersion: '2026-07-28' }, 'true', false)).text) as { result: { protocolVersion: string; capabilities: unknown } }
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.capabilities).toEqual({ tools: {} })
    // and the profile still refuses the inbox read that the catalogue points at
    const inbox = await profileRpc('tools/call', { name: 'inbox', arguments: {} }, 'true', true)
    expect(inbox.status).toBe(403)
  })

  it('the full /mcp door still serves events with the flag ON (the profile fence is not a global off-switch)', async () => {
    const r = await rawRpc('events/list', {}, { events: 'true', bearer: 'bound-admin' }, true)
    expect((parse(r.text).result?.events as unknown[]).length).toBe(1)
  })
})
