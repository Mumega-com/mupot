// tests/fleet-control-route.test.ts — POST /api/fleet/control (Deliverable 2).
// Auth ladder (401/403), fail-closed 503, input 400, and the happy path: an owner-capable token
// emits a control-request into the consumer inbox whose Ed25519 signature verifies + an audit row.
import { describe, it, expect, beforeAll } from 'vitest'
import { fleetControlApp } from '../src/fleet/control-routes'
import { verifyControlRequest } from '../src/fleet/control-request'
import type { Env } from '../src/types'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface MsgRow {
  seq: number; tenant: string; to_agent: string; from_agent: string; from_member: string
  kind: string; body: string; request_id: string | null; read_at: string | null
}
interface TokenRow { member_id: string; display_name: string; email: string | null; status: string; bound_agent_id: string | null }
interface Grant { member_id: string; scope_type: string; scope_id: string | null; capability: string }

function makeDb(opts: { tokens: Record<string, TokenRow>; caps: Record<string, Grant[]> }) {
  const messages: MsgRow[] = []
  const log: unknown[][] = []
  let seq = 0
  function first(sql: string, b: unknown[]) {
    if (sql.includes('FROM member_tokens t')) {
      const [hash] = b as [string]
      return opts.tokens[hash] ?? null
    }
    if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
      const [tenant, from_agent, rid] = b as [string, string, string]
      const m = messages.find((x) => x.tenant === tenant && x.from_agent === from_agent && x.request_id === rid)
      return m ? { id: 'x', seq: m.seq, to_agent: m.to_agent, kind: m.kind, body: m.body, in_reply_to: null } : null
    }
    throw new Error('unhandled first: ' + sql)
  }
  function all(sql: string, b: unknown[]) {
    if (sql.includes('FROM\n       capabilities') || sql.includes('FROM capabilities') || sql.includes('capabilities')) {
      const [memberId] = b as [string]
      return opts.caps[memberId] ?? []
    }
    throw new Error('unhandled all: ' + sql)
  }
  function run(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO agent_messages')) {
      const [, tenant, to_agent, from_agent, from_member, kind, body, request_id] = b as string[]
      if (request_id != null && messages.some((m) => m.tenant === tenant && m.from_agent === from_agent && m.request_id === request_id)) {
        throw new Error('UNIQUE constraint failed: idx_agent_messages_rid')
      }
      const s = ++seq
      messages.push({ seq: s, tenant, to_agent, from_agent, from_member, kind, body, request_id: request_id ?? null, read_at: null })
      return { meta: { last_row_id: s, changes: 1 } }
    }
    if (sql.includes('INSERT INTO fleet_control_log')) {
      log.push(b)
      return { meta: { changes: 1 } }
    }
    throw new Error('unhandled run: ' + sql)
  }
  const db = {
    _messages: messages,
    _log: log,
    prepare(sql: string) {
      const binds: unknown[] = []
      const api = {
        bind(...a: unknown[]) { binds.push(...a); return api },
        async first<T>() { return first(sql, binds) as T },
        async all<T>() { return { results: all(sql, binds) as T[] } },
        async run() { return run(sql, binds) },
      }
      return api
    },
  }
  return db
}

const OWNER = 'owner-token'
const MEMBER = 'member-token'
let ownerHash = ''
let memberHash = ''
let panelPrivJwk = ''
let panelPubJwk = ''

beforeAll(async () => {
  ownerHash = await sha256Hex(OWNER)
  memberHash = await sha256Hex(MEMBER)
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  panelPrivJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey))
  panelPubJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.publicKey))
})

function env(db: ReturnType<typeof makeDb>, over: Partial<Env> = {}): Env {
  return {
    TENANT_SLUG: 't',
    DB: db,
    FLEET_PANEL_SK: panelPrivJwk,
    FLEET_CONSUMER_AGENT: 'fleet-consumer',
    ...over,
  } as unknown as Env
}

function db() {
  return makeDb({
    tokens: {
      [ownerHash]: { member_id: 'm-owner', display_name: 'Owner', email: 'o@x.com', status: 'active', bound_agent_id: null },
      [memberHash]: { member_id: 'm-plain', display_name: 'Plain', email: null, status: 'active', bound_agent_id: 'kasra' },
    },
    caps: {
      'm-owner': [{ member_id: 'm-owner', scope_type: 'org', scope_id: null, capability: 'owner' }],
      'm-plain': [{ member_id: 'm-plain', scope_type: 'org', scope_id: null, capability: 'member' }],
    },
  })
}

function post(d: ReturnType<typeof makeDb>, token: string | null, payload: unknown, over: Partial<Env> = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return fleetControlApp.request('/control', { method: 'POST', headers, body: JSON.stringify(payload) }, env(d, over))
}

describe('POST /api/fleet/control', () => {
  it('401 without a token', async () => {
    const res = await post(db(), null, { agent_id: 'image-gen', verb: 'status' })
    expect(res.status).toBe(401)
  })

  it('403 for a non-owner token', async () => {
    const res = await post(db(), MEMBER, { agent_id: 'image-gen', verb: 'status' })
    expect(res.status).toBe(403)
  })

  it('400 for a bad body', async () => {
    expect((await post(db(), OWNER, { agent_id: 'image-gen' })).status).toBe(400)
    expect((await post(db(), OWNER, {})).status).toBe(400)
  })

  it('400 for a malformed agent_id / verb (signer validation)', async () => {
    expect((await post(db(), OWNER, { agent_id: '../evil', verb: 'status' })).status).toBe(400)
    expect((await post(db(), OWNER, { agent_id: 'image-gen', verb: 'rm -rf /' })).status).toBe(400)
  })

  it('503 when FLEET_PANEL_SK is unconfigured (fail-closed)', async () => {
    const res = await post(db(), OWNER, { agent_id: 'image-gen', verb: 'status' }, { FLEET_PANEL_SK: undefined })
    expect(res.status).toBe(503)
  })

  it('413 on an oversized control body (cap before parse)', async () => {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${OWNER}` }
    const huge = JSON.stringify({ agent_id: 'image-gen', verb: 'status', pad: 'x'.repeat(5000) })
    const res = await fleetControlApp.request('/control', { method: 'POST', headers, body: huge }, env(db()))
    expect(res.status).toBe(413)
  })

  it('413 on a multibyte body over the BYTE cap (BLOCK-2 — not String.length)', async () => {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${OWNER}` }
    // ~2050 UTF-16 code units (< 4096) but ~6KB UTF-8 bytes (each '€' = 3 bytes) — must be capped by bytes.
    const huge = JSON.stringify({ agent_id: 'image-gen', verb: 'status', pad: '€'.repeat(2050) })
    const res = await fleetControlApp.request('/control', { method: 'POST', headers, body: huge }, env(db()))
    expect(res.status).toBe(413)
  })

  it('happy path: emits a verifiable signed control-request + audit row', async () => {
    const d = db()
    const res = await post(d, OWNER, { agent_id: 'image-gen', verb: 'stop' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; nonce: string; agent_id: string; verb: string }
    expect(json.ok).toBe(true)
    expect(json.agent_id).toBe('image-gen')

    // exactly one message in the consumer's inbox, and its body is a VALID signed control-request
    const msgs = d._messages.filter((m) => m.to_agent === 'fleet-consumer')
    expect(msgs).toHaveLength(1)
    const req = JSON.parse(msgs[0].body)
    expect(req).toMatchObject({ agent_id: 'image-gen', verb: 'stop', nonce: json.nonce })
    expect(await verifyControlRequest(panelPubJwk, req)).toBe(true)
    expect(msgs[0].kind).toBe('request')
    expect(msgs[0].from_member).toBe('m-owner') // accountability: the real principal

    // audit row recorded
    expect(d._log).toHaveLength(1)
  })

  it('an agent-bound owner token stamps from_agent as the welded agent', async () => {
    // give the agent-bound member owner cap for this test
    const d = makeDb({
      tokens: { [memberHash]: { member_id: 'm-plain', display_name: 'P', email: null, status: 'active', bound_agent_id: 'kasra' } },
      caps: { 'm-plain': [{ member_id: 'm-plain', scope_type: 'org', scope_id: null, capability: 'owner' }] },
    })
    const res = await post(d, MEMBER, { agent_id: 'image-gen', verb: 'start' })
    expect(res.status).toBe(200)
    const msgs = d._messages.filter((m) => m.to_agent === 'fleet-consumer')
    expect(msgs[0].from_agent).toBe('kasra')
  })
})

describe('GET /api/fleet/trust', () => {
  function get(over: Partial<Env> = {}) {
    return fleetControlApp.request('/trust', {}, env(db(), over))
  }

  it('is publicly readable because it exposes verification material, not authority', async () => {
    const res = await get({ FLEET_CONSUMER_AGENT: '05fb2b56-8332-4034-b311-e8d4100dc166' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as {
      tenant: string
      consumer_agent_id: string
      panel_public_key: JsonWebKey
    }
    const expected = JSON.parse(panelPubJwk) as JsonWebKey
    expect(body.tenant).toBe('t')
    expect(body.consumer_agent_id).toBe('05fb2b56-8332-4034-b311-e8d4100dc166')
    expect(body.panel_public_key).toEqual({ kty: 'OKP', crv: 'Ed25519', x: expected.x })
    expect(body.panel_public_key).not.toHaveProperty('d')
    expect(JSON.stringify(body)).not.toContain((JSON.parse(panelPrivJwk) as JsonWebKey).d)
  })

  it('fails closed when either trust binding is unavailable or malformed', async () => {
    expect((await get({ FLEET_PANEL_SK: undefined })).status).toBe(503)
    expect((await get({ FLEET_CONSUMER_AGENT: undefined })).status).toBe(503)
    expect((await get({ FLEET_PANEL_SK: '{bad' })).status).toBe(503)
    expect((await get({ FLEET_CONSUMER_AGENT: '../consumer' })).status).toBe(503)
    expect((await get({ TENANT_SLUG: 'Bad Tenant' })).status).toBe(503)
  })
})
