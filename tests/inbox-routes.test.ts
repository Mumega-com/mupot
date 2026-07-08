// tests/inbox-routes.test.ts — the HTTP mirror of the agent inbox (GET /api/inbox, POST
// /api/inbox/send) used by the bash wake-hooks. member-bearer auth is mocked to control the
// caller's welded identity; the DB fake faithfully models agents + agent_messages.

import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../src/types'

// Mock the member-token auth so we drive the caller's weld directly.
vi.mock('../src/auth/member-bearer', () => ({
  bearerToken: (h?: string) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
  resolveMemberByToken: async (_env: unknown, token: string | null) => {
    if (token === 'tok-code') return { memberId: 'm-code', displayName: 'code', email: null, boundAgentId: 'ag-code' }
    if (token === 'tok-review') return { memberId: 'm-rev', displayName: 'review', email: null, boundAgentId: 'ag-review' }
    if (token === 'tok-unbound') return { memberId: 'm-h', displayName: 'h', email: null, boundAgentId: null }
    return null
  },
}))

// Import AFTER the mock is registered.
const { inboxApp } = await import('../src/agents/inbox-routes')

interface MsgRow {
  seq: number; id: string; tenant: string; to_agent: string; from_agent: string; from_member: string
  kind: string; body: string; request_id: string | null; in_reply_to: string | null; created_at: string; read_at: string | null
}

interface KeyRow { pubkey: string; algo: string; member_id: string | null }

function makeDb(
  agents: Array<{ id: string; squad_id: string; slug: string; name: string }>,
  keys: Record<string, KeyRow> = {},
) {
  const messages: MsgRow[] = []
  const nonces = new Set<string>()
  let seqCounter = 0

  function runRun(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO agent_messages')) {
      const [id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, maxUnread] =
        b as [string, string, string, string, string, string, string, string | null, string | null, string, number]
      const unread = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length
      if (typeof maxUnread === 'number' && unread >= maxUnread) return { meta: { changes: 0 } }
      if (request_id != null && messages.some((m) => m.tenant === tenant && m.from_agent === from_agent && m.request_id === request_id)) {
        throw new Error('UNIQUE constraint failed')
      }
      const seq = ++seqCounter
      messages.push({ seq, id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, read_at: null })
      return { meta: { last_row_id: seq, changes: 1 } }
    }
    throw new Error('unhandled run: ' + sql)
  }
  function runFirst(sql: string, b: unknown[]) {
    if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
      const [tenant, from_agent, request_id] = b as [string, string, string]
      const m = messages.find((x) => x.tenant === tenant && x.from_agent === from_agent && x.request_id === request_id)
      return m ? { id: m.id, seq: m.seq, to_agent: m.to_agent, kind: m.kind, body: m.body, in_reply_to: m.in_reply_to } : null
    }
    if (sql.includes('COUNT(*) AS n FROM agent_messages')) {
      const [tenant, to_agent] = b as [string, string]
      return { n: messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length }
    }
    if (sql.includes('FROM agents WHERE id = ?1 LIMIT 1')) {
      const [ref] = b as [string]
      return agents.find((a) => a.id === ref) ?? null
    }
    if (sql.includes('FROM agent_keys WHERE tenant')) {
      const [tenant, agentId] = b as [string, string]
      return keys[`${tenant}:${agentId}`] ?? null
    }
    throw new Error('unhandled first: ' + sql)
  }
  function runAll(sql: string, b: unknown[]) {
    if (sql.includes('UPDATE agent_messages SET read_at')) {
      const [readAt, tenant, to_agent, limit] = b as [string, string, string, number]
      const claimed = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).sort((x, y) => x.seq - y.seq).slice(0, limit)
      for (const m of claimed) m.read_at = readAt
      return claimed.map((m) => ({ ...m }))
    }
    if (sql.includes('FROM agent_messages') && sql.includes('read_at IS NULL') && sql.includes('ORDER BY seq ASC')) {
      const [tenant, to_agent, limit] = b as [string, string, number]
      return messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).sort((x, y) => x.seq - y.seq).slice(0, limit).map((m) => ({ ...m }))
    }
    if (sql.includes('FROM agents WHERE slug = ?1')) {
      const [ref] = b as [string]
      return agents.filter((a) => a.slug === ref)
    }
    throw new Error('unhandled all: ' + sql)
  }
  function runSigned(sql: string, b: unknown[]) {
    if (sql.includes('DELETE FROM agent_attach_nonces')) return { meta: { changes: 0 } }
    if (sql.includes('INSERT OR IGNORE INTO agent_attach_nonces')) {
      const [nonce] = b as [string]
      if (nonces.has(nonce)) return { meta: { changes: 0 } }
      nonces.add(nonce)
      return { meta: { changes: 1 } }
    }
    return null
  }

  const db = {
    _messages: messages,
    prepare(sql: string) {
      const binds: unknown[] = []
      const api = {
        bind(...a: unknown[]) { binds.push(...a); return api },
        async first<T>() { return runFirst(sql, binds) as T },
        async all<T>() { return { results: runAll(sql, binds) as T[] } },
        async run() { return runSigned(sql, binds) ?? runRun(sql, binds) },
      }
      return api
    },
  }
  return db
}

function env(
  agents: Array<{ id: string; squad_id: string; slug: string; name: string }> = [],
  keys: Record<string, KeyRow> = {},
): { env: Env; db: ReturnType<typeof makeDb> } {
  const db = makeDb(agents, keys)
  return { env: { TENANT_SLUG: 't', DB: db } as unknown as Env, db }
}

function getReq(token?: string, query = ''): Request {
  return new Request(`https://pot.test/${query}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}
function postReq(token: string | undefined, body: unknown, raw?: string): Request {
  return new Request('https://pot.test/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw !== undefined ? raw : JSON.stringify(body),
  })
}

const INBOX_SIG_DOMAIN = 'agent-inbox:v1'
const canonInbox = (p: {
  tenant: string
  agent_id: string
  peek: boolean
  limit: number
  ts: number
  nonce: string
}) => [INBOX_SIG_DOMAIN, p.tenant, p.agent_id, p.peek ? '1' : '0', String(p.limit), String(p.ts), p.nonce].join('\n')
const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url')

async function genKey() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { kp, pubX: (pub as JsonWebKey).x as string }
}

async function signedInboxBody(
  privKey: CryptoKey,
  agent_id: string,
  over: Partial<{ tenant: string; peek: boolean; limit: number; ts: number; nonce: string }> = {},
) {
  const body = {
    agent_id,
    peek: over.peek ?? true,
    limit: over.limit ?? 20,
    ts: over.ts ?? Math.floor(Date.now() / 1000),
    nonce: over.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(32))),
  }
  const tenant = over.tenant ?? 't'
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privKey, new TextEncoder().encode(canonInbox({ tenant, ...body })))
  return { ...body, sig: b64url(sig) }
}

const postSigned = (body: unknown, e: Env) =>
  inboxApp.fetch(new Request('https://pot.test/signed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), e)

const AGENTS = [
  { id: 'ag-code', squad_id: 's1', slug: 'code', name: 'Code' },
  { id: 'ag-review', squad_id: 's1', slug: 'review', name: 'Review' },
]

describe('GET /api/inbox', () => {
  it('no token → 401', async () => {
    const { env: e } = env(AGENTS)
    expect((await inboxApp.fetch(getReq(undefined), e)).status).toBe(401)
  })
  it('unbound token → 403', async () => {
    const { env: e } = env(AGENTS)
    expect((await inboxApp.fetch(getReq('tok-unbound'), e)).status).toBe(403)
  })
  it('happy: reads + consumes the caller’s own inbox', async () => {
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'x', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm-rev', kind: 'message', body: 'hi code', request_id: null, in_reply_to: null, created_at: 't0', read_at: null })
    const res = await inboxApp.fetch(getReq('tok-code'), e)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { messages: Array<{ body: string }>; consumed: boolean }
    expect(j.messages.map((m) => m.body)).toEqual(['hi code'])
    expect(j.consumed).toBe(true)
    // consumed → second read empty
    const res2 = await inboxApp.fetch(getReq('tok-code'), e)
    const j2 = (await res2.json()) as { messages: unknown[] }
    expect(j2.messages.length).toBe(0)
  })
  it('peek=1 does not consume', async () => {
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'x', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'message', body: 'hi', request_id: null, in_reply_to: null, created_at: 't0', read_at: null })
    const res = await inboxApp.fetch(getReq('tok-code', '?peek=1'), e)
    const j = (await res.json()) as { messages: unknown[]; consumed: boolean }
    expect(j.messages.length).toBe(1)
    expect(j.consumed).toBe(false)
    const res2 = await inboxApp.fetch(getReq('tok-code', '?peek=1'), e)
    expect(((await res2.json()) as { messages: unknown[] }).messages.length).toBe(1) // still there
  })
  it('invalid limit → 400', async () => {
    const { env: e } = env(AGENTS)
    expect((await inboxApp.fetch(getReq('tok-code', '?limit=abc'), e)).status).toBe(400)
  })
})

describe('POST /api/inbox/send', () => {
  it('unbound token → 403', async () => {
    const { env: e } = env(AGENTS)
    expect((await inboxApp.fetch(postReq('tok-unbound', { to: 'review', body: 'x' }), e)).status).toBe(403)
  })
  it('happy: code → review lands in review’s inbox', async () => {
    const { env: e, db } = env(AGENTS)
    const res = await inboxApp.fetch(postReq('tok-code', { to: 'review', body: 'build it' }), e)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { ok: boolean; to: string }
    expect(j.to).toBe('ag-review')
    expect(db._messages[0].from_agent).toBe('ag-code')
    expect(db._messages[0].to_agent).toBe('ag-review')
  })
  it('unknown recipient → 404', async () => {
    const { env: e } = env(AGENTS)
    expect((await inboxApp.fetch(postReq('tok-code', { to: 'ghost', body: 'x' }), e)).status).toBe(404)
  })
  it('missing body → 400', async () => {
    const { env: e } = env(AGENTS)
    expect((await inboxApp.fetch(postReq('tok-code', { to: 'review' }), e)).status).toBe(400)
  })
  it('oversized → 413', async () => {
    const { env: e } = env(AGENTS)
    const raw = JSON.stringify({ to: 'review', body: 'x'.repeat(9000) })
    expect((await inboxApp.fetch(postReq('tok-code', undefined, raw), e)).status).toBe(413)
  })
})

describe('POST /api/inbox/signed', () => {
  it('valid signature can peek without consuming, then consume the signed agent inbox', async () => {
    const { kp, pubX } = await genKey()
    const { env: e, db } = env(AGENTS, { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-code' } })
    db._messages.push({
      seq: 1,
      id: 'x',
      tenant: 't',
      to_agent: 'ag-code',
      from_agent: 'ag-review',
      from_member: 'm-rev',
      kind: 'request',
      body: 'wake up',
      request_id: 'rid-1',
      in_reply_to: null,
      created_at: 't0',
      read_at: null,
    })

    const peekRes = await postSigned(await signedInboxBody(kp.privateKey, 'ag-code', { peek: true, limit: 10 }), e)
    expect(peekRes.status).toBe(200)
    const peek = await peekRes.json() as { messages: Array<{ body: string }>; consumed: boolean; agent: string }
    expect(peek.agent).toBe('ag-code')
    expect(peek.consumed).toBe(false)
    expect(peek.messages.map((m) => m.body)).toEqual(['wake up'])

    const consumeRes = await postSigned(await signedInboxBody(kp.privateKey, 'ag-code', { peek: false, limit: 10 }), e)
    expect(consumeRes.status).toBe(200)
    const consumed = await consumeRes.json() as { messages: Array<{ body: string }>; consumed: boolean }
    expect(consumed.consumed).toBe(true)
    expect(consumed.messages.map((m) => m.body)).toEqual(['wake up'])

    const emptyRes = await postSigned(await signedInboxBody(kp.privateKey, 'ag-code', { peek: true, limit: 10 }), e)
    expect(((await emptyRes.json()) as { messages: unknown[] }).messages).toEqual([])
  })

  it('replay of the same signed inbox request is rejected', async () => {
    const { kp, pubX } = await genKey()
    const { env: e } = env(AGENTS, { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: null } })
    const body = await signedInboxBody(kp.privateKey, 'ag-code', { peek: true, limit: 10 })
    expect((await postSigned(body, e)).status).toBe(200)
    expect((await postSigned(body, e)).status).toBe(409)
  })

  it('tampered read mode after signing is rejected', async () => {
    const { kp, pubX } = await genKey()
    const { env: e } = env(AGENTS, { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: null } })
    const body = await signedInboxBody(kp.privateKey, 'ag-code', { peek: true, limit: 10 })
    ;(body as Record<string, unknown>).peek = false
    expect((await postSigned(body, e)).status).toBe(401)
  })

  it('unknown signed agent key is unauthorized', async () => {
    const { kp } = await genKey()
    const { env: e } = env(AGENTS)
    expect((await postSigned(await signedInboxBody(kp.privateKey, 'ag-code'), e)).status).toBe(401)
  })
})
