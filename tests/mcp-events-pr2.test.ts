// mupot#1618 — MCP Events PR 2: events/subscribe, events/unsubscribe, callback verification,
// signing, queue delivery, receipts. Real SQL (whole migration chain); fake fetch; fake BUS.
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpApp } from '../src/mcp'
import { sendAgentMessage } from '../src/agents/messages'
import { handleQueue } from '../src/bus/consumer'
import {
  MAX_DELIVERIES_PER_MINUTE,
  MAX_DELIVERY_ATTEMPTS,
  deliverSubscriptionEvent,
  enqueueMessageCreatedDeliveries,
  type DeliveryJob,
} from '../src/bus/events-delivery'
import { revokeSubscriptionForAgent, MAX_ACTIVE_SUBSCRIPTIONS_PER_AGENT } from '../src/mcp/events-subscriptions'
import { standardWebhooksSignature, validateCallbackUrl } from '../src/mcp/events-webhook'
import { sha256Hex } from '../src/members/service'
import type { BusEvent, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'digid'
const T0 = '2026-08-01T00:00:00.000Z'
const HOST = 'hooks.example.com'
const URL_A = `https://${HOST}/mcp/events`
const MASTER_KEY = 'ab'.repeat(32)
const SECRET_A = 'whsec_' + Buffer.alloc(32, 7).toString('base64')
const SECRET_B = 'whsec_' + Buffer.alloc(32, 9).toString('base64')

type Bearer = 'bound-admin' | 'bound-nogrants' | 'bound-c' | 'unbound-admin' | 'dir-zero'

let harness: SqliteD1Harness
let busSend: ReturnType<typeof vi.fn>
let sqlLog: string[]

async function seed(h: SqliteD1Harness): Promise<void> {
  const tok = async (id: string, member: string, channel: string, agent: string | null, name: Bearer) => {
    const hash = await sha256Hex(name)
    h.sqlite.exec(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES ('${id}', '${member}', '${hash}', 't', '${channel}', '${T0}', ${agent ? `'${agent}'` : 'NULL'}, '${TENANT}')`,
    )
  }
  const members = ['member-1', 'member-dir', 'member-agent-a', 'member-agent-b', 'member-agent-c']
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-1', 'agent-a', 'Agent A', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-b', 'squad-1', 'agent-b', 'Agent B', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-c', 'squad-1', 'agent-c', 'Agent C', 'active');
    ${members.map((m) => `INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${m}', NULL, '${m}', 'active', '${T0}', '${TENANT}');`).join('\n')}
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-a', 'member-agent-a', '${T0}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-b', 'member-agent-b', '${T0}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-c', 'member-agent-c', '${T0}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-1', 'member-1', 'org', NULL, 'admin');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', 'member-agent-a', 'org', NULL, 'admin');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-c', 'member-agent-c', 'org', NULL, 'admin');
  `)
  await tok('tok-ba', 'member-agent-a', 'workspace', 'agent-a', 'bound-admin')
  await tok('tok-bn', 'member-agent-b', 'workspace', 'agent-b', 'bound-nogrants')
  await tok('tok-bc', 'member-agent-c', 'workspace', 'agent-c', 'bound-c')
  await tok('tok-ua', 'member-1', 'workspace', null, 'unbound-admin')
  await tok('tok-dz', 'member-dir', 'directory', null, 'dir-zero')
}

interface EnvOpts {
  events?: string
  hosts?: string | null
  masterKey?: string | null
}

function makeEnv(opts: EnvOpts = {}): Env {
  const hosts = opts.hosts === undefined ? HOST : opts.hosts
  const masterKey = opts.masterKey === undefined ? MASTER_KEY : opts.masterKey
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Digid',
    OAUTH_PROVIDER: 'google',
    EVENTS_ENABLED: opts.events ?? 'true',
    ...(hosts !== null ? { EVENTS_CALLBACK_HOSTS: hosts } : {}),
    ...(masterKey !== null ? { CONNECTOR_MASTER_KEY: masterKey } : {}),
    BUS: { send: busSend },
    DB: {
      prepare(sql: string) {
        sqlLog.push(sql)
        return harness.db.prepare(sql)
      },
      batch: (stmts: Parameters<typeof harness.db.batch>[0]) => harness.db.batch(stmts),
    },
  } as unknown as Env
}

// ── fake fetch ───────────────────────────────────────────────────────────────────

interface Sent {
  url: string
  headers: Record<string, string>
  body: string
  redirect: string | undefined
}
let sent: Sent[]
type Handler = (req: Sent, init: RequestInit) => Response | Promise<Response>

function echoChallenge(req: Sent): Response {
  const parsed = JSON.parse(req.body) as { type?: string; challenge?: string }
  if (parsed.type === 'verification') return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200 })
  return new Response('{}', { status: 200 })
}

function installFetch(handler: Handler = echoChallenge): void {
  sent = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req: Sent = {
      url: String(input),
      headers: init.headers as Record<string, string>,
      body: String(init.body),
      redirect: init.redirect,
    }
    sent.push(req)
    return Promise.resolve(handler(req, init))
  })
}

// ── rpc ──────────────────────────────────────────────────────────────────────────

interface RpcBody {
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: { reason?: string } }
}

async function rpc(method: string, params: unknown, bearer: Bearer = 'bound-admin', env: Env = makeEnv()) {
  const res = await mcpApp.request(
    'https://pot.example/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    env,
  )
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as RpcBody }
}

function subParams(over: Record<string, unknown> = {}, delivery: Record<string, unknown> = {}) {
  return {
    name: 'message.created',
    arguments: {},
    delivery: { mode: 'webhook', url: URL_A, secret: SECRET_A, ...delivery },
    ttlMs: 3_600_000,
    ...over,
  }
}

async function subscribeOk(bearer: Bearer = 'bound-admin', params = subParams()): Promise<string> {
  const r = await rpc('events/subscribe', params, bearer)
  expect(r.body.error).toBeUndefined()
  return r.body.result?.id as string
}

interface SubRow {
  id: string
  status: string
  agent_id: string
  secret_ciphertext: string
  secret_fingerprint: string
  prev_secret_ciphertext: string | null
  refresh_before: string
  token_id: string
  revoke_reason: string | null
}
const subs = (): SubRow[] => harness.sqlite.prepare('SELECT * FROM event_subscriptions ORDER BY created_at').all() as unknown as SubRow[]
const receipts = (): Record<string, unknown>[] =>
  harness.sqlite.prepare('SELECT * FROM event_delivery_receipts ORDER BY created_at, rowid').all() as Record<string, unknown>[]

/** Independent Standard Webhooks verifier (node:crypto, not the code under test). */
function verifySw(secret: string, id: string, ts: string, body: string, header: string): boolean {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  return header.split(' ').some((p) => p === `v1,${expected}`)
}

function dumpAll(): string {
  const tables = harness.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]
  const out: Record<string, unknown[]> = {}
  for (const { name } of tables) out[name] = harness.sqlite.prepare(`SELECT * FROM "${name}"`).all()
  return JSON.stringify(out)
}

const logCapture: string[] = []
beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  await seed(harness)
  busSend = vi.fn().mockResolvedValue(undefined)
  sqlLog = []
  logCapture.length = 0
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logCapture.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    })
  }
  installFetch()
})

afterEach(() => {
  harness.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── subscribe ────────────────────────────────────────────────────────────────────

describe('events/subscribe', () => {
  it('happy path: verifies the callback with a signed single-use challenge, stores an active row', async () => {
    const r = await rpc('events/subscribe', subParams())
    expect(r.body.error).toBeUndefined()
    const res = r.body.result as { id: string; refreshBefore: string; cursor: null; truncated: boolean }
    expect(res.id).toMatch(/^sub_[0-9a-f]{32}$/)
    expect(res.cursor).toBeNull()
    expect(res.truncated).toBe(false)
    expect(Date.parse(res.refreshBefore) - Date.now()).toBeGreaterThan(3_000_000)

    expect(sent).toHaveLength(1)
    const v = sent[0]
    expect(v.url).toBe(URL_A)
    expect(v.redirect).toBe('manual')
    expect(v.headers['webhook-id']).toMatch(/^msg_verification_/)
    expect(v.headers['X-MCP-Subscription-Id']).toBe(res.id)
    expect(v.headers['content-type']).toBe('application/json')
    expect(verifySw(SECRET_A, v.headers['webhook-id'], v.headers['webhook-timestamp'], v.body, v.headers['webhook-signature'])).toBe(true)
    const body = JSON.parse(v.body) as { type: string; challenge: string }
    expect(body.type).toBe('verification')
    expect(body.challenge.length).toBeGreaterThan(16)

    const rows = subs()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: res.id, status: 'active', agent_id: 'agent-a', token_id: 'tok-ba' })
  })

  it('a challenge is single-use random: two verifications never share one', async () => {
    await subscribeOk('bound-admin', subParams({}, { url: `https://${HOST}/one` }))
    await subscribeOk('bound-admin', subParams({}, { url: `https://${HOST}/two` }))
    const c = sent.map((s) => (JSON.parse(s.body) as { challenge: string }).challenge)
    expect(new Set(c).size).toBe(2)
  })

  it('is idempotent: same identity refreshes (one row, ttl moves), verification is cached for the same secret', async () => {
    const id1 = await subscribeOk('bound-admin', subParams({ ttlMs: 600_000 }))
    const before = subs()[0].refresh_before
    const id2 = await subscribeOk('bound-admin', subParams({ ttlMs: 7_200_000 }))
    expect(id2).toBe(id1)
    expect(subs()).toHaveLength(1)
    expect(subs()[0].refresh_before > before).toBe(true)
    expect(sent).toHaveLength(1) // second call hit the verification cache
  })

  it('key order / null vs absent arguments do not create a second subscription', async () => {
    const id1 = await subscribeOk('bound-admin', subParams({ arguments: {} }))
    const id2 = await subscribeOk('bound-admin', subParams({ arguments: null }))
    expect(id2).toBe(id1)
    expect(subs()).toHaveLength(1)
  })

  it('a NEW secret is re-verified with that secret and the old one is kept for the rotation window', async () => {
    await subscribeOk('bound-admin', subParams())
    const fp1 = subs()[0].secret_fingerprint
    await subscribeOk('bound-admin', subParams({}, { secret: SECRET_B }))
    expect(sent).toHaveLength(2)
    const v2 = sent[1]
    expect(verifySw(SECRET_B, v2.headers['webhook-id'], v2.headers['webhook-timestamp'], v2.body, v2.headers['webhook-signature'])).toBe(true)
    const row = subs()[0]
    expect(row.secret_fingerprint).not.toBe(fp1)
    expect(row.prev_secret_ciphertext).not.toBeNull()
  })

  it('concurrent identical subscribes yield ONE row', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => rpc('events/subscribe', subParams())))
    for (const r of results) expect(r.body.error).toBeUndefined()
    expect(new Set(results.map((r) => r.body.result?.id)).size).toBe(1)
    expect(subs()).toHaveLength(1)
  })

  it('the signing secret is stored only as ciphertext and never appears in any column, receipt, log or result', async () => {
    const r = await rpc('events/subscribe', subParams())
    const raw = SECRET_A.slice('whsec_'.length)
    const row = subs()[0]
    expect(row.secret_ciphertext).not.toContain(raw)
    expect(row.secret_ciphertext.length).toBeGreaterThan(40)
    expect(row.secret_fingerprint).toMatch(/^[0-9a-f]{8}$/)
    // Deliver once so receipts and delivery logs exist too.
    await deliverSubscriptionEvent(makeEnv(), job(row.id))
    await rpc('events/subscribe', subParams({}, { secret: SECRET_B }))
    for (const s of [SECRET_A, SECRET_B]) {
      const raw2 = s.slice('whsec_'.length)
      expect(dumpAll()).not.toContain(raw2)
      expect(dumpAll()).not.toContain(s)
      expect(r.text).not.toContain(raw2)
      expect(logCapture.join('\n')).not.toContain(raw2)
    }
  })

  it('refuses unbound, zero-capability and directory-zero sessions', async () => {
    for (const bearer of ['unbound-admin', 'bound-nogrants', 'dir-zero'] as Bearer[]) {
      const r = await rpc('events/subscribe', subParams(), bearer)
      expect(r.body.error?.code, bearer).toBe(-32003)
      expect(r.status).toBe(403)
    }
    expect(subs()).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('only message.created is subscribable: every other event name (incl. needs_you.created) is unknown_event; arguments must be empty', async () => {
    const list = await rpc('events/list', {})
    expect((list.body.result?.events as { name: string }[]).map((e) => e.name)).toEqual(['message.created'])
    for (const name of ['needs_you.created', 'nope.created', 'message.deleted', '']) {
      const r = await rpc('events/subscribe', subParams({ name }))
      expect(r.body.error?.code, name).toBe(-32602)
    }
    expect((await rpc('events/subscribe', subParams({ name: 'needs_you.created' }))).body.error?.message).toBe('unknown_event')
    expect((await rpc('events/subscribe', subParams({ arguments: { to_agent: 'agent-b' } }))).body.error?.code).toBe(-32602)
    expect((await rpc('events/subscribe', subParams({ arguments: [] }))).body.error?.code).toBe(-32602)
    expect(sent).toHaveLength(0)
    expect(subs()).toHaveLength(0)
  })

  it('refuses to START a subscription for an inactive agent (events/list still offers the event to it)', async () => {
    harness.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = 'agent-a'`)
    const r = await rpc('events/subscribe', subParams())
    expect(r.body.error).toMatchObject({ code: -32003, data: { reason: 'agent_inactive' } })
    expect(sent).toHaveLength(0)
    expect(subs()).toHaveLength(0)
  })

  it.each([
    ['no whsec_ prefix', Buffer.alloc(32, 1).toString('base64')],
    ['too short (23 bytes)', 'whsec_' + Buffer.alloc(23, 1).toString('base64')],
    ['too long (65 bytes)', 'whsec_' + Buffer.alloc(65, 1).toString('base64')],
    ['not base64', 'whsec_%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%'],
    ['empty', ''],
  ])('rejects an invalid secret: %s', async (_n, secret) => {
    const r = await rpc('events/subscribe', subParams({}, { secret }))
    expect(r.body.error?.code).toBe(-32602)
    expect(sent).toHaveLength(0)
  })

  it('accepts the 24 and 64 byte boundaries', async () => {
    await subscribeOk('bound-admin', subParams({}, { url: `https://${HOST}/a24`, secret: 'whsec_' + Buffer.alloc(24, 3).toString('base64') }))
    await subscribeOk('bound-admin', subParams({}, { url: `https://${HOST}/a64`, secret: 'whsec_' + Buffer.alloc(64, 3).toString('base64') }))
    expect(subs()).toHaveLength(2)
  })

  it('ttlMs: default, clamped to min and max, null is not granted as "no expiry", invalid refused', async () => {
    const gap = async (ttlMs: unknown) => {
      const r = await rpc('events/subscribe', subParams({ ttlMs }, { url: `https://${HOST}/t/${String(ttlMs)}` }))
      return r.body.error ? r.body.error.code : Date.parse(r.body.result?.refreshBefore as string) - Date.now()
    }
    expect(await gap(1)).toBeGreaterThan(290_000)
    expect(await gap(1)).toBeLessThan(310_000)
    expect(await gap(10 * 24 * 3_600_000)).toBeLessThan(24 * 3_600_000 + 5_000)
    const nul = await rpc('events/subscribe', subParams({ ttlMs: null }, { url: `https://${HOST}/t/null` }))
    expect(typeof nul.body.result?.refreshBefore).toBe('string') // NOT null: we do not grant no-expiry
    expect(await gap(-5)).toBe(-32602)
    expect(await gap('soon')).toBe(-32602)
    const dflt = await rpc('events/subscribe', { ...subParams({}, { url: `https://${HOST}/t/dflt` }), ttlMs: undefined })
    expect(Date.parse(dflt.body.result?.refreshBefore as string) - Date.now()).toBeGreaterThan(3_500_000)
  })

  it('caps active subscriptions per agent', async () => {
    for (let i = 0; i < MAX_ACTIVE_SUBSCRIPTIONS_PER_AGENT; i++) {
      await subscribeOk('bound-admin', subParams({}, { url: `https://${HOST}/n${i}` }))
    }
    const r = await rpc('events/subscribe', subParams({}, { url: `https://${HOST}/overflow` }))
    expect(r.body.error?.message).toBe('subscription_limit')
    // A refresh of an existing one is still fine at the cap.
    await subscribeOk('bound-admin', subParams({}, { url: `https://${HOST}/n0` }))
  })

  it('fails closed when secret storage (CONNECTOR_MASTER_KEY) is not configured: no fetch, no row', async () => {
    const r = await rpc('events/subscribe', subParams(), 'bound-admin', makeEnv({ masterKey: null }))
    expect(r.body.error?.message).toBe('secret_storage_unavailable')
    expect(sent).toHaveLength(0)
    expect(subs()).toHaveLength(0)
  })

  it('sweeps this agent\'s expired subscriptions opportunistically', async () => {
    const id = await subscribeOk()
    harness.sqlite.exec(`UPDATE event_subscriptions SET refresh_before = '2020-01-01T00:00:00.000Z' WHERE id = '${id}'`)
    await subscribeOk('bound-admin', subParams({}, { url: `https://${HOST}/other` }))
    expect(subs().find((s) => s.id === id)?.status).toBe('expired')
  })
})

describe('callback URL policy (default refuse-all; exact-hostname allowlist)', () => {
  const cases: [string, string, string | null, string][] = [
    ['http scheme', `http://${HOST}/cb`, HOST, 'callback_scheme_not_https'],
    ['IPv4 literal', 'https://203.0.113.9/cb', HOST, 'callback_host_ip_literal'],
    ['IPv4 literal even if allowlisted', 'https://203.0.113.9/cb', '203.0.113.9', 'callback_host_ip_literal'],
    ['IPv6 literal', 'https://[2001:db8::1]/cb', HOST, 'callback_host_ip_literal'],
    ['decimal-encoded loopback', 'https://2130706433/cb', HOST, 'callback_host_ip_literal'],
    ['hex-encoded loopback', 'https://0x7f.1/cb', HOST, 'callback_host_ip_literal'],
    ['userinfo', `https://user:pw@${HOST}/cb`, HOST, 'callback_credentials_not_allowed'],
    ['username only', `https://user@${HOST}/cb`, HOST, 'callback_credentials_not_allowed'],
    ['non-default port', `https://${HOST}:8443/cb`, HOST, 'callback_port_not_allowed'],
    ['host not in the allowlist', 'https://evil.example.net/cb', HOST, 'callback_host_not_allowed'],
    ['subdomain of an allowlisted host', `https://a.${HOST}/cb`, HOST, 'callback_host_not_allowed'],
    ['parent of an allowlisted host', 'https://example.com/cb', HOST, 'callback_host_not_allowed'],
    ['trailing-dot host', `https://${HOST}./cb`, HOST, 'callback_host_not_allowed'],
    ['wildcard entry is not interpreted', 'https://a.example.com/cb', '*.example.com', 'callback_host_not_allowed'],
    ['EMPTY allowlist (the default) refuses everything', `https://${HOST}/cb`, '', 'callback_host_not_allowed'],
    ['UNSET allowlist refuses everything', `https://${HOST}/cb`, null, 'callback_host_not_allowed'],
    ['fragment', `https://${HOST}/cb#x`, HOST, 'callback_url_invalid'],
    ['garbage', 'not a url', HOST, 'callback_url_invalid'],
    ['non-string', '', HOST, 'callback_url_invalid'],
  ]
  it.each(cases)('refuses: %s', async (_n, url, hosts, reason) => {
    const r = await rpc('events/subscribe', subParams({}, { url }), 'bound-admin', makeEnv({ hosts }))
    expect(r.body.error).toMatchObject({ code: -32015, message: 'CallbackEndpointError', data: { reason } })
    expect(sent).toHaveLength(0) // never fetched
    expect(subs()).toHaveLength(0)
  })

  it('allows an explicit :443 (normalised to the default port) on an allowlisted host, case-insensitively', async () => {
    const r = await rpc('events/subscribe', subParams({}, { url: `https://HOOKS.Example.com:443/cb` }))
    expect(r.body.error).toBeUndefined()
    expect(sent[0].url).toBe('https://hooks.example.com/cb')
  })

  it('validateCallbackUrl is pure and matches the table for a few spot checks', () => {
    expect(validateCallbackUrl(`https://${HOST}/x`, { EVENTS_CALLBACK_HOSTS: ` ${HOST.toUpperCase()} , other.example.org ` })).toMatchObject({ ok: true })
    expect(validateCallbackUrl(`https://${HOST}/x`, {})).toMatchObject({ ok: false, reason: 'callback_host_not_allowed' })
  })
})

describe('callback verification', () => {
  const fails: [string, Handler, string][] = [
    ['wrong challenge echoed', () => new Response(JSON.stringify({ challenge: 'nope' }), { status: 200 }), 'challenge_failed'],
    ['no challenge in the body', () => new Response('{}', { status: 200 }), 'challenge_failed'],
    ['non-JSON body', () => new Response('ok', { status: 200 }), 'challenge_failed'],
    ['JSON null body', () => new Response('null', { status: 200 }), 'challenge_failed'],
    ['non-2xx status', () => new Response('{}', { status: 500 }), 'callback_http_error'],
    ['redirect response is a failure and is never followed', () => new Response(null, { status: 302, headers: { location: 'https://evil.example.net/' } }), 'callback_redirect'],
    ['network error', () => { throw new Error('boom') }, 'callback_unreachable'],
  ]
  it.each(fails)('%s -> -32015 and no row', async (_n, handler, reason) => {
    installFetch((req, init) => {
      void req
      void init
      return handler(req, init)
    })
    const r = await rpc('events/subscribe', subParams())
    expect(r.body.error).toMatchObject({ code: -32015, data: { reason } })
    expect(subs()).toHaveLength(0)
    expect(sent.every((s) => s.redirect === 'manual')).toBe(true)
    expect(sent).toHaveLength(1) // a redirect target is never requested
  })

  it('a 2xx with the right challenge but a 3xx-free path succeeds only when the challenge is constant-time equal', async () => {
    installFetch((req) => {
      const c = (JSON.parse(req.body) as { challenge: string }).challenge
      return new Response(JSON.stringify({ challenge: c + 'x' }), { status: 200 }) // prefix-equal but longer
    })
    const r = await rpc('events/subscribe', subParams())
    expect(r.body.error).toMatchObject({ data: { reason: 'challenge_failed' } })
  })

  it('times out after 10 seconds with reason timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let started!: () => void
    const startedP = new Promise<void>((res) => { started = res })
    installFetch((_req, init) => new Promise<Response>((_res, rej) => {
      started()
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    const p = rpc('events/subscribe', subParams())
    await startedP
    await vi.advanceTimersByTimeAsync(9_999)
    await vi.advanceTimersByTimeAsync(2)
    const r = await p
    expect(r.body.error).toMatchObject({ code: -32015, data: { reason: 'timeout' } })
    expect(subs()).toHaveLength(0)
  })
})

// ── unsubscribe ──────────────────────────────────────────────────────────────────

describe('events/unsubscribe', () => {
  it('revokes the caller\'s own subscription; idempotent; result is empty', async () => {
    const id = await subscribeOk()
    const r1 = await rpc('events/unsubscribe', subParams())
    expect(r1.body.result).toEqual({})
    expect(subs().find((s) => s.id === id)).toMatchObject({ status: 'revoked', revoke_reason: 'unsubscribed' })
    const r2 = await rpc('events/unsubscribe', subParams())
    expect(r2.body.result).toEqual({})
    // ...and it works even if the host has since left the allowlist.
    const r3 = await rpc('events/unsubscribe', subParams(), 'bound-admin', makeEnv({ hosts: null }))
    expect(r3.body.result).toEqual({})
  })

  it('another agent cannot touch it (same URL/name from a different principal addresses a different id)', async () => {
    const id = await subscribeOk('bound-admin')
    const r = await rpc('events/unsubscribe', subParams(), 'bound-c')
    expect(r.body.result).toEqual({})
    expect(subs().find((s) => s.id === id)?.status).toBe('active')
    // Direct: even holding agent-a's exact id, agent-c's revoke is a no-op.
    expect(await revokeSubscriptionForAgent(makeEnv(), 'agent-c', id, 'x')).toBe(false)
    expect(subs().find((s) => s.id === id)?.status).toBe('active')
    expect(await revokeSubscriptionForAgent(makeEnv(), 'agent-a', id, 'x')).toBe(true)
  })

  it('refuses unbound and zero-capability callers', async () => {
    for (const bearer of ['unbound-admin', 'bound-nogrants'] as Bearer[]) {
      const r = await rpc('events/unsubscribe', subParams(), bearer)
      expect(r.body.error?.code, bearer).toBe(-32003)
    }
  })

  it('two agents subscribing to the same URL get two independent subscriptions', async () => {
    const a = await subscribeOk('bound-admin')
    const c = await subscribeOk('bound-c')
    expect(a).not.toBe(c)
    await rpc('events/unsubscribe', subParams(), 'bound-c')
    expect(subs().find((s) => s.id === a)?.status).toBe('active')
    expect(subs().find((s) => s.id === c)?.status).toBe('revoked')
  })
})

// ── signing ──────────────────────────────────────────────────────────────────────

describe('Standard Webhooks signing', () => {
  it('matches the reference vector', async () => {
    // Standard Webhooks README example.
    const sig = await standardWebhooksSignature(
      ['whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'],
      'msg_p5jXN8AQM9LWM0D4loKWxJek',
      1614265330,
      '{"test": 2432232314}',
    )
    expect(sig).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
  })

  it('matches an independent HMAC implementation and signs old+new during rotation (space separated)', async () => {
    const both = await standardWebhooksSignature([SECRET_B, SECRET_A], 'evt_1', 1700000000, '{"a":1}')
    const parts = both.split(' ')
    expect(parts).toHaveLength(2)
    expect(verifySw(SECRET_B, 'evt_1', '1700000000', '{"a":1}', parts[0])).toBe(true)
    expect(verifySw(SECRET_A, 'evt_1', '1700000000', '{"a":1}', parts[1])).toBe(true)
    expect(verifySw(SECRET_A, 'evt_1', '1700000001', '{"a":1}', parts[1])).toBe(false) // timestamp is covered
    expect(verifySw(SECRET_A, 'evt_1', '1700000000', '{"a":2}', parts[1])).toBe(false) // body is covered
  })
})

// ── delivery ─────────────────────────────────────────────────────────────────────

function job(subscriptionId: string, over: Partial<DeliveryJob> = {}): DeliveryJob {
  return {
    subscription_id: subscriptionId,
    event_id: 'evt_' + 'f'.repeat(32),
    event_name: 'message.created',
    timestamp: '2026-08-01T12:00:00.000Z',
    data: { message_id: 'msg-1', seq: 42, read_after_seq: 41, kind: 'message', request_id: 'req-1' },
    from_agent: 'agent-b',
    attempt: 1,
    ...over,
  }
}

const eventReq = (): Sent[] => sent.filter((s) => (JSON.parse(s.body) as { type?: string }).type !== 'verification')

describe('delivery', () => {
  let id: string
  beforeEach(async () => {
    id = await subscribeOk()
    sent.length = 0
  })

  it('POSTs one signed, body-free event and records ONE delivered receipt', async () => {
    const out = await deliverSubscriptionEvent(makeEnv(), job(id))
    expect(out).toBe('delivered')
    expect(sent).toHaveLength(1)
    const req = sent[0]
    expect(req.url).toBe(URL_A)
    expect(req.redirect).toBe('manual')
    expect(JSON.parse(req.body)).toEqual({
      eventId: 'evt_' + 'f'.repeat(32),
      name: 'message.created',
      timestamp: '2026-08-01T12:00:00.000Z',
      data: { message_id: 'msg-1', seq: 42, read_after_seq: 41, kind: 'message', request_id: 'req-1' },
      cursor: null,
    })
    expect(req.body).not.toContain('from_agent')
    expect(req.headers['webhook-id']).toBe('evt_' + 'f'.repeat(32))
    expect(req.headers['X-MCP-Subscription-Id']).toBe(id)
    expect(verifySw(SECRET_A, req.headers['webhook-id'], req.headers['webhook-timestamp'], req.body, req.headers['webhook-signature'])).toBe(true)
    const rc = receipts()
    expect(rc).toHaveLength(1)
    expect(rc[0]).toMatchObject({ outcome: 'delivered', attempt: 1, http_status: 200, subscription_id: id })
  })

  it('receipts hold metadata only: no body, no secret, no message content', async () => {
    await deliverSubscriptionEvent(makeEnv(), job(id))
    await deliverSubscriptionEvent(makeEnv(), job(id, { event_id: 'evt_2' }))
    const dump = JSON.stringify(receipts())
    expect(dump).not.toContain('whsec_')
    expect(dump).not.toContain(SECRET_A.slice(6))
    expect(dump).not.toContain('"data"')
    expect(dump).not.toContain('msg-1')
    expect(Object.keys(receipts()[0]).sort()).toEqual(
      ['attempt', 'created_at', 'error_class', 'event_id', 'http_status', 'id', 'outcome', 'signed_at', 'subscription_id'],
    )
  })

  it('receipts are append-only', () => {
    harness.sqlite.exec(`INSERT INTO event_delivery_receipts (id, subscription_id, event_id, attempt, outcome, created_at)
      VALUES ('r1', '${id}', 'e', 1, 'delivered', '${T0}')`)
    expect(() => harness.sqlite.exec(`UPDATE event_delivery_receipts SET outcome = 'failed' WHERE id = 'r1'`)).toThrow(/append-only/)
    expect(() => harness.sqlite.exec(`DELETE FROM event_delivery_receipts WHERE id = 'r1'`)).toThrow(/append-only/)
  })

  it('retries transient failures with exponential backoff; eventId/webhook-id stable, signature fresh per attempt', async () => {
    installFetch(() => new Response('', { status: 503 }))
    const t0 = Date.now()
    const o1 = await deliverSubscriptionEvent(makeEnv(), job(id), { nowMs: t0 })
    expect(o1).toBe('retry')
    expect(busSend).toHaveBeenCalledTimes(1)
    const [msg1, opts1] = busSend.mock.calls[0] as [BusEvent<DeliveryJob>, { delaySeconds: number }]
    expect(msg1.type).toBe('mcp.event.delivery')
    expect(msg1.payload.attempt).toBe(2)
    expect(msg1.payload.event_id).toBe('evt_' + 'f'.repeat(32))
    expect(opts1.delaySeconds).toBe(10)

    await deliverSubscriptionEvent(makeEnv(), msg1.payload, { nowMs: t0 + 15_000 })
    const [msg2, opts2] = busSend.mock.calls[1] as [BusEvent<DeliveryJob>, { delaySeconds: number }]
    expect(msg2.payload.attempt).toBe(3)
    expect(opts2.delaySeconds).toBe(20)

    expect(sent).toHaveLength(2)
    expect(sent[0].headers['webhook-id']).toBe(sent[1].headers['webhook-id'])
    expect(sent[0].headers['webhook-timestamp']).not.toBe(sent[1].headers['webhook-timestamp'])
    expect(sent[0].headers['webhook-signature']).not.toBe(sent[1].headers['webhook-signature'])
    expect(sent[0].body).toBe(sent[1].body) // same event bytes
    for (const s of sent) expect(verifySw(SECRET_A, s.headers['webhook-id'], s.headers['webhook-timestamp'], s.body, s.headers['webhook-signature'])).toBe(true)
    expect(receipts().map((r) => [r.attempt, r.outcome])).toEqual([[1, 'retry'], [2, 'retry']])
  })

  it('stops after the bounded attempt count', async () => {
    installFetch(() => new Response('', { status: 500 }))
    const out = await deliverSubscriptionEvent(makeEnv(), job(id, { attempt: MAX_DELIVERY_ATTEMPTS }))
    expect(out).toBe('failed')
    expect(busSend).not.toHaveBeenCalled()
    expect(receipts()[0]).toMatchObject({ outcome: 'failed', error_class: 'retries_exhausted:http_500' })
  })

  it.each([
    ['429', () => new Response('', { status: 429 })],
    ['408', () => new Response('', { status: 408 })],
    ['network error', () => { throw new Error('reset') }],
  ] as [string, Handler][])('%s is transient', async (_n, h) => {
    installFetch(h)
    expect(await deliverSubscriptionEvent(makeEnv(), job(id))).toBe('retry')
    expect(busSend).toHaveBeenCalledTimes(1)
  })

  it('a timeout is transient', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    installFetch((_r, init) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
    }))
    const p = deliverSubscriptionEvent(makeEnv(), job(id))
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await p).toBe('retry')
    expect(receipts()[0]).toMatchObject({ outcome: 'retry', error_class: 'timeout' })
  })

  it('410 revokes the subscription (gone) and later jobs are not delivered', async () => {
    installFetch(() => new Response('', { status: 410 }))
    expect(await deliverSubscriptionEvent(makeEnv(), job(id))).toBe('gone')
    expect(busSend).not.toHaveBeenCalled()
    expect(subs()[0]).toMatchObject({ status: 'revoked', revoke_reason: 'callback_gone' })
    installFetch()
    expect(await deliverSubscriptionEvent(makeEnv(), job(id, { event_id: 'evt_next' }))).toBe('refused')
    expect(sent).toHaveLength(0)
  })

  it('413 and other permanent 4xx are NOT retried', async () => {
    for (const status of [413, 400, 401, 404]) {
      installFetch(() => new Response('', { status }))
      expect(await deliverSubscriptionEvent(makeEnv(), job(id, { event_id: `evt_${status}` }))).toBe('failed')
    }
    expect(busSend).not.toHaveBeenCalled()
    expect(receipts().find((r) => r.http_status === 413)).toMatchObject({ error_class: 'payload_too_large' })
  })

  it('a redirect response is a permanent failure and is never followed', async () => {
    installFetch(() => new Response(null, { status: 307, headers: { location: 'https://evil.example.net/x' } }))
    expect(await deliverSubscriptionEvent(makeEnv(), job(id))).toBe('failed')
    expect(sent).toHaveLength(1)
    expect(sent[0].redirect).toBe('manual')
    expect(busSend).not.toHaveBeenCalled()
    expect(receipts()[0]).toMatchObject({ outcome: 'failed', error_class: 'redirect_refused' })
  })

  it('does not deliver for an expired subscription (and marks it expired)', async () => {
    const out = await deliverSubscriptionEvent(makeEnv(), job(id), { nowMs: Date.now() + 3 * 3_600_000 })
    expect(out).toBe('refused')
    expect(sent).toHaveLength(0)
    expect(subs()[0].status).toBe('expired')
    expect(receipts()[0]).toMatchObject({ outcome: 'refused', error_class: 'subscription_expired' })
  })

  it('does not deliver for a revoked subscription', async () => {
    await rpc('events/unsubscribe', subParams())
    expect(await deliverSubscriptionEvent(makeEnv(), job(id))).toBe('refused')
    expect(sent).toHaveLength(0)
    expect(receipts()[0]).toMatchObject({ outcome: 'refused', error_class: 'subscription_revoked' })
  })

  describe('access is re-checked at delivery time', () => {
    it('revoked token stops delivery and revokes the subscription', async () => {
      harness.sqlite.exec(`UPDATE member_tokens SET revoked_at = '${T0}' WHERE id = 'tok-ba'`)
      expect(await deliverSubscriptionEvent(makeEnv(), job(id))).toBe('refused')
      expect(sent).toHaveLength(0)
      expect(subs()[0]).toMatchObject({ status: 'revoked', revoke_reason: 'access_token_not_live' })
    })
    it('expired token stops delivery', async () => {
      harness.sqlite.exec(`UPDATE member_tokens SET expires_at = '2020-01-01 00:00:00' WHERE id = 'tok-ba'`)
      expect(await deliverSubscriptionEvent(makeEnv(), job(id))).toBe('refused')
      expect(sent).toHaveLength(0)
    })
    it('deactivated agent stops delivery', async () => {
      harness.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = 'agent-a'`)
      expect(await deliverSubscriptionEvent(makeEnv(), job(id))).toBe('refused')
      expect(subs()[0].revoke_reason).toBe('access_agent_inactive')
      expect(sent).toHaveLength(0)
    })
    it('suspended member stops delivery', async () => {
      harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'member-agent-a'`)
      expect(await deliverSubscriptionEvent(makeEnv(), job(id))).toBe('refused')
      expect(sent).toHaveLength(0)
    })
    it('losing every capability stops delivery', async () => {
      harness.sqlite.exec(`DELETE FROM capabilities WHERE member_id = 'member-agent-a'`)
      expect(await deliverSubscriptionEvent(makeEnv(), job(id))).toBe('refused')
      expect(subs()[0].revoke_reason).toBe('access_no_capability')
      expect(sent).toHaveLength(0)
    })
  })

  it('never delivers an event for a message the subscribing agent sent itself', async () => {
    expect(await deliverSubscriptionEvent(makeEnv(), job(id, { from_agent: 'agent-a' }))).toBe('refused')
    expect(sent).toHaveLength(0)
    expect(receipts()[0]).toMatchObject({ outcome: 'refused', error_class: 'self_event' })
  })

  it('caps new events per subscription per minute; the excess is refused with a receipt', async () => {
    const env = makeEnv()
    for (let i = 0; i < MAX_DELIVERIES_PER_MINUTE; i++) {
      expect(await deliverSubscriptionEvent(env, job(id, { event_id: `evt_${i}` }))).toBe('delivered')
    }
    expect(await deliverSubscriptionEvent(env, job(id, { event_id: 'evt_over' }))).toBe('refused')
    expect(sent).toHaveLength(MAX_DELIVERIES_PER_MINUTE)
    expect(receipts().at(-1)).toMatchObject({ outcome: 'refused', error_class: 'rate_limited', event_id: 'evt_over' })
    // retries of an event already in flight are not counted against the cap
    installFetch(() => new Response('', { status: 200 }))
    expect(await deliverSubscriptionEvent(env, job(id, { event_id: 'evt_0', attempt: 2 }))).toBe('delivered')
  })

  it('signs with the old AND new secret during a rotation, and only until the window ends', async () => {
    await subscribeOk('bound-admin', subParams({}, { secret: SECRET_B }))
    sent.length = 0
    await deliverSubscriptionEvent(makeEnv(), job(id))
    const s = sent[0]
    expect(s.headers['webhook-signature'].split(' ')).toHaveLength(2)
    expect(verifySw(SECRET_A, s.headers['webhook-id'], s.headers['webhook-timestamp'], s.body, s.headers['webhook-signature'])).toBe(true)
    expect(verifySw(SECRET_B, s.headers['webhook-id'], s.headers['webhook-timestamp'], s.body, s.headers['webhook-signature'])).toBe(true)
    sent.length = 0
    harness.sqlite.exec(`UPDATE event_subscriptions SET prev_secret_expires_at = '2020-01-01T00:00:00.000Z'`)
    await deliverSubscriptionEvent(makeEnv(), job(id, { event_id: 'evt_after' }))
    expect(sent[0].headers['webhook-signature'].split(' ')).toHaveLength(1)
  })
})

// ── queue wiring + flag gate ─────────────────────────────────────────────────────

function messageCreated(over: Partial<Record<string, unknown>> = {}): BusEvent {
  return {
    type: 'message.created',
    tenant: TENANT,
    agent_id: 'agent-a',
    actor: { kind: 'agent', id: 'agent-b' },
    payload: {
      message_id: 'msg-9',
      seq: 9,
      to_agent: 'agent-a',
      from_agent: 'agent-b',
      from_member: 'member-agent-b',
      kind: 'message',
      request_id: 'r-9',
      created_at: '2026-08-01T12:00:00.000Z',
      body: 'SECRET MESSAGE BODY MUST NEVER LEAVE',
      ...over,
    },
    ts: '2026-08-01T12:00:00.000Z',
  }
}

async function runQueue(env: Env, ev: BusEvent) {
  const ack = vi.fn()
  const retry = vi.fn()
  await handleQueue({ messages: [{ id: 'q1', body: ev, attempts: 1, ack, retry }] } as never, env)
  return { ack, retry }
}

describe('queue wiring (message.created -> mcp.event.delivery)', () => {
  it('enqueues one body-free job per active subscription of the RECIPIENT only', async () => {
    const a = await subscribeOk('bound-admin')
    await subscribeOk('bound-c')
    const { ack } = await runQueue(makeEnv(), messageCreated())
    expect(ack).toHaveBeenCalled()
    const jobs = busSend.mock.calls.map((c) => (c[0] as BusEvent<DeliveryJob>).payload)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].subscription_id).toBe(a)
    expect(JSON.stringify(busSend.mock.calls)).not.toContain('SECRET MESSAGE BODY')
    expect(jobs[0].data).toEqual({ message_id: 'msg-9', seq: 9, read_after_seq: 8, kind: 'message', request_id: 'r-9' })
    // eventId is deterministic per (subscription, message): a queue redelivery yields the same id
    busSend.mockClear()
    await runQueue(makeEnv(), messageCreated())
    expect((busSend.mock.calls[0][0] as BusEvent<DeliveryJob>).payload.event_id).toBe(jobs[0].event_id)
  })

  it('end to end: a queued mcp.event.delivery job is signed and POSTed', async () => {
    await subscribeOk('bound-admin')
    sent.length = 0
    await runQueue(makeEnv(), messageCreated())
    const queued = busSend.mock.calls[0][0] as BusEvent
    await runQueue(makeEnv(), queued)
    expect(eventReq()).toHaveLength(1)
    expect(eventReq()[0].body).not.toContain('SECRET MESSAGE BODY')
  })

  it('feedback-loop guard: a message the subscriber sent itself is never fanned out', async () => {
    await subscribeOk('bound-admin')
    await runQueue(makeEnv(), messageCreated({ from_agent: 'agent-a', to_agent: 'agent-a' }))
    expect(busSend).not.toHaveBeenCalled()
    expect(await enqueueMessageCreatedDeliveries(makeEnv(), messageCreated({ from_agent: 'agent-a', to_agent: 'agent-a' }))).toBe(0)
  })

  it('a malformed seq (0, negative, fractional, non-number) is dropped, never coerced into a wrong read_after_seq', async () => {
    await subscribeOk('bound-admin')
    for (const seq of [0, -3, 1.5, '7', null]) {
      await runQueue(makeEnv(), messageCreated({ seq }))
    }
    expect(busSend).not.toHaveBeenCalled()
  })

  it('expired and revoked subscriptions are not enqueued', async () => {
    const id = await subscribeOk('bound-admin')
    harness.sqlite.exec(`UPDATE event_subscriptions SET refresh_before = '2020-01-01T00:00:00.000Z' WHERE id = '${id}'`)
    await runQueue(makeEnv(), messageCreated())
    expect(busSend).not.toHaveBeenCalled()
    harness.sqlite.exec(`UPDATE event_subscriptions SET refresh_before = '2099-01-01T00:00:00.000Z', status = 'revoked' WHERE id = '${id}'`)
    await runQueue(makeEnv(), messageCreated())
    expect(busSend).not.toHaveBeenCalled()
  })

  it('FLAG OFF: no subscription read, no queue message, no fetch — even with an active row present', async () => {
    await subscribeOk('bound-admin')
    sent.length = 0
    busSend.mockClear()
    sqlLog.length = 0
    const off = makeEnv({ events: 'false' })
    const { ack } = await runQueue(off, messageCreated())
    expect(ack).toHaveBeenCalled()
    expect(busSend).not.toHaveBeenCalled()
    expect(sqlLog.filter((s) => s.includes('event_subscriptions') || s.includes('event_delivery_receipts'))).toEqual([])
    // and a delivery job that somehow reaches the consumer is dropped without a read or a POST
    sqlLog.length = 0
    const queued = { ...messageCreated(), type: 'mcp.event.delivery', payload: job('sub_x') } as BusEvent
    await runQueue(off, queued)
    expect(sqlLog.filter((s) => s.includes('event_subscriptions'))).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('flag unset behaves like off', async () => {
    await subscribeOk('bound-admin')
    busSend.mockClear()
    const env = { ...makeEnv(), EVENTS_ENABLED: undefined } as unknown as Env
    await runQueue(env, messageCreated())
    expect(busSend).not.toHaveBeenCalled()
  })

  it('FLAG OFF: events/subscribe is method-not-found before any auth or DB work', async () => {
    sqlLog.length = 0
    const r = await rpc('events/subscribe', subParams(), 'bound-admin', makeEnv({ events: 'false' }))
    expect(r.body.error).toMatchObject({ code: -32601, message: 'method_not_found' })
    expect(sqlLog).toEqual([])
    expect(subs()).toHaveLength(0)
  })
})

// ── end to end: deliver -> payload -> the catalogue's own recovery read ──────────

describe('recovery read described by the catalogue works on a real delivery', () => {
  const SEND_AUTHZ = { system: true, reason: 'test: exercises sendAgentMessage primitive directly' } as const

  async function sendReal(env: Env, to: string, body: string, requestId?: string) {
    const res = await sendAgentMessage(
      env,
      { fromAgent: 'agent-b', fromMember: 'member-agent-b', toAgent: to, body, kind: 'message', ...(requestId ? { requestId } : {}) },
      SEND_AUTHZ,
    )
    expect(res.ok).toBe(true)
    // the bus event sendAgentMessage emitted for it (real emitter, spied queue)
    const ev = busSend.mock.calls.map((c) => c[0] as BusEvent).filter((e) => e.type === 'message.created').at(-1) as BusEvent
    // HARNESS LIMITATION: the node:sqlite D1 double reports meta.last_row_id = 0 for
    // INSERT ... SELECT (real D1 returns the rowid), so the emitted seq is 0 here. Take the real
    // seq from the row the send just wrote and put it in the event, exactly as production emits it.
    const row = harness.sqlite.prepare('SELECT seq FROM agent_messages WHERE id = ?').get((ev.payload as { message_id: string }).message_id) as { seq: number }
    return { ...ev, payload: { ...(ev.payload as object), seq: row.seq } }
  }

  /** queue: message.created -> delivery job -> POST; returns the delivered event body's `data`. */
  async function deliverThroughQueue(env: Env, ev: BusEvent): Promise<Record<string, unknown>> {
    busSend.mockClear()
    sent.length = 0
    await runQueue(env, ev)
    const queued = busSend.mock.calls.map((c) => c[0] as BusEvent).find((e) => e.type === 'mcp.event.delivery')
    expect(queued).toBeDefined()
    await runQueue(env, queued as BusEvent)
    expect(eventReq()).toHaveLength(1)
    return (JSON.parse(eventReq()[0].body) as { data: Record<string, unknown> }).data
  }

  async function inboxRead(sinceSeq: number) {
    const r = await mcpApp.request(
      'https://pot.example/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer bound-admin' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'inbox', arguments: { peek: true, since_seq: sinceSeq, limit: 1 } },
        }),
      },
      makeEnv(),
    )
    const j = JSON.parse(await r.text()) as { result?: { structuredContent?: { messages?: { id: string; body: string; seq: number }[] } }; error?: unknown }
    expect(j.error).toBeUndefined()
    return j.result?.structuredContent?.messages ?? []
  }

  it('deliver -> take the payload -> inbox {peek, since_seq: read_after_seq, limit: 1} returns the triggering row and nothing foreign', async () => {
    await subscribeOk('bound-admin')
    const env = makeEnv()
    // seq 1 -> agent-a (first ever row: read_after_seq must be 0, not -1)
    const ev1 = await sendReal(env, 'agent-a', 'FIRST-FOR-A')
    const d1 = await deliverThroughQueue(env, ev1)
    expect(d1.read_after_seq).toBe(0)
    expect((await inboxRead(d1.read_after_seq as number)).map((m) => m.body)).toEqual(['FIRST-FOR-A'])
    // a foreign row (agent-c) sits between, then another row for agent-a
    await sendReal(env, 'agent-c', 'FOREIGN-FOR-C')
    const ev3 = await sendReal(env, 'agent-a', 'THIRD-FOR-A')
    const d3 = await deliverThroughQueue(env, ev3)
    expect(d3.seq).toBe(3)
    expect(d3.read_after_seq).toBe(2)
    expect(JSON.stringify(eventReq()[0].body)).not.toContain('THIRD-FOR-A') // the event itself is body-free
    const got = await inboxRead(d3.read_after_seq as number)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ id: d3.message_id, body: 'THIRD-FOR-A', seq: 3 })
    expect(JSON.stringify(got)).not.toContain('FOREIGN-FOR-C')
    // and the naive read the catalogue used to describe (since_seq = seq) would have SKIPPED it
    expect(await inboxRead(d3.seq as number)).toEqual([])
  })

  it('the delivered data matches the catalogue payloadSchema exactly (required keys, no extras)', async () => {
    await subscribeOk('bound-admin')
    const env = makeEnv()
    const list = await rpc('events/list', {})
    const schema = (list.body.result?.events as { name: string; payloadSchema: { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean } }[])
      .find((e) => e.name === 'message.created')!.payloadSchema
    const ev = await sendReal(env, 'agent-a', 'schema check', 'rid-schema')
    const data = await deliverThroughQueue(env, ev)
    for (const k of schema.required) expect(data, k).toHaveProperty(k)
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(data).filter((k) => !(k in schema.properties))).toEqual([])
    expect(data.request_id).toBe('rid-schema')
  })
})
