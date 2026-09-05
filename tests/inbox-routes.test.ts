// tests/inbox-routes.test.ts — the HTTP mirror of the agent inbox (GET /api/inbox, POST
// /api/inbox/send) used by the bash wake-hooks. member-bearer auth is mocked to control the
// caller's welded identity; the DB fake faithfully models agents + agent_messages.

import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { Env, CapabilityGrant } from '../src/types'

// SQLite's lower() is ASCII-only — it does not fold Unicode case. Use this, never
// String.prototype.toLowerCase(), when mocking a `lower(...)` SQL predicate.
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
}

// Mock the member-token auth so we drive the caller's weld directly. tokenId is included
// (the real resolveMemberByToken always returns it — mupot#1325 P1: the earlier mock omitted
// it, so no test in this file COULD fail for a missing token->seat binding check) and feeds
// resolveBoundSeat's `SELECT label FROM member_tokens WHERE id = ?1` lookup in the DB fake below.
vi.mock('../src/auth/member-bearer', () => ({
  bearerToken: (h?: string) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
  resolveMemberByToken: async (_env: unknown, token: string | null) => {
    if (token === 'tok-code') return { tokenId: 'tid-code', memberId: 'm-code', displayName: 'code', email: null, boundAgentId: 'ag-code' }
    // seat-bound variant of the same agent's token — label 'hadi-codex-cli' in member_tokens.
    if (token === 'tok-code-cli') return { tokenId: 'tid-code-cli', memberId: 'm-code', displayName: 'code', email: null, boundAgentId: 'ag-code' }
    if (token === 'tok-review') return { tokenId: 'tid-review', memberId: 'm-rev', displayName: 'review', email: null, boundAgentId: 'ag-review' }
    if (token === 'tok-unbound') return { tokenId: 'tid-unbound', memberId: 'm-h', displayName: 'h', email: null, boundAgentId: null }
    return null
  },
}))

// Import AFTER the mock is registered.
const { inboxApp } = await import('../src/agents/inbox-routes')

interface MsgRow {
  seq: number; id: string; tenant: string; to_agent: string; from_agent: string; from_member: string
  kind: string; body: string; request_id: string | null; in_reply_to: string | null; created_at: string; read_at: string | null
  target_seat?: string | null
}

interface KeyRow { pubkey: string; algo: string; member_id: string | null }

function makeDb(
  agents: Array<{ id: string; squad_id: string; slug: string; name: string }>,
  keys: Record<string, KeyRow> = {},
  memberStatuses: Record<string, string> = {},
  signedOnlyAgents: ReadonlySet<string> = new Set(),
  // Gate 1 (#392) fixtures: member -> capability grants, and squad -> department_id.
  capabilityGrants: Record<string, CapabilityGrant[]> = {},
  squadDepartments: Record<string, string | null> = {},
) {
  const messages: MsgRow[] = []
  const nonces = new Set<string>()
  let seqCounter = 0
  const keyFingerprint = (tenant: string, agentId: string) => {
    const key = keys[`${tenant}:${agentId}`]
    return key ? createHash('sha256').update(key.pubkey).digest('hex') : null
  }

  function runRun(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO agent_messages')) {
      const [id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, maxUnread, _projectId, targetSeat] =
        b as [string, string, string, string, string, string, string, string | null, string | null, string, number, string | null, string | null]
      const unread = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length
      if (typeof maxUnread === 'number' && unread >= maxUnread) return { meta: { changes: 0 } }
      if (request_id != null && messages.some((m) => m.tenant === tenant && m.from_agent === from_agent && m.request_id === request_id)) {
        throw new Error('UNIQUE constraint failed')
      }
      const seq = ++seqCounter
      messages.push({ seq, id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, read_at: null, target_seat: targetSeat ?? null })
      return { meta: { last_row_id: seq, changes: 1 } }
    }
    throw new Error('unhandled run: ' + sql)
  }

  // Faithfully reflects the seatSql fragment shape (src/agents/messages.ts) rather than
  // hardcoding "unscoped means broadcast-only" — a fake that always applied the correct
  // filter regardless of the SQL text would never notice a dropped/fail-open predicate.
  // Three shapes: "target_seat = ?N OR target_seat IS NULL" (scoped — seat is the last
  // bind), "target_seat IS NULL" alone (broadcast-only default), or NEITHER present
  // (mutated/fail-open — every unread row for the recipient matches, seat or not).
  function seatMatches(sql: string, b: unknown[], m: MsgRow): boolean {
    if (sql.includes('OR target_seat IS NULL')) {
      const seat = b[b.length - 1] as string
      return m.target_seat === seat || (m.target_seat ?? null) === null
    }
    if (sql.includes('target_seat IS NULL')) return (m.target_seat ?? null) === null
    return true // no seat predicate in the SQL at all — matches everything (fail-open)
  }
  function runFirst(sql: string, b: unknown[]) {
    if (/^\s*SELECT mode, generation, key_fingerprint FROM agent_inbox_fences/.test(sql)) {
      const [tenant, agentId] = b as [string, string]
      return tenant === 't' && signedOnlyAgents.has(agentId)
        ? { mode: 'signed_only', generation: 1, key_fingerprint: keyFingerprint(tenant, agentId) }
        : null
    }
    if (sql.includes('FROM agent_keys k') && sql.includes('JOIN members m')) {
      const [tenant, agentId] = b as [string, string]
      const key = keys[`${tenant}:${agentId}`]
      return key?.member_id && memberStatuses[key.member_id] !== 'inactive' ? key : null
    }
    if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
      const [tenant, from_agent, request_id] = b as [string, string, string]
      const m = messages.find((x) => x.tenant === tenant && x.from_agent === from_agent && x.request_id === request_id)
      return m ? { id: m.id, seq: m.seq, to_agent: m.to_agent, kind: m.kind, body: m.body, in_reply_to: m.in_reply_to } : null
    }
    if (sql.includes('FROM member_tokens t') && sql.includes('t.agent_id = ?2') && sql.includes('t.label = ?3')) {
      const [tenant, agentId, label] = b as [string, string, string]
      return tenant === 't' && agentId === 'ag-review' && label === 'hadi-codex-cli' ? { 1: 1 } : null
    }
    // resolveBoundSeat's lookup (src/agents/inbox-seat.ts) — the same query the MCP inbox
    // tools use, reused unmodified by the HTTP route (mupot#1325): resolve the CALLER's
    // bound seat label from its own token id, never from anything the caller supplies.
    if (sql.includes('SELECT label FROM member_tokens WHERE id = ?1 AND tenant = ?2')) {
      const [tokenId, tenant] = b as [string, string]
      if (tenant !== 't') return null
      if (tokenId === 'tid-code-cli') return { label: 'hadi-codex-cli' }
      return null // tok-code / tok-review / tok-unbound carry no seat label
    }
    if (sql.includes('COUNT(*) AS n FROM agent_messages')) {
      const [tenant, to_agent] = b as [string, string]
      const effectiveMode = signedOnlyAgents.has(to_agent) ? 'signed_only' : 'bearer_only'
      const signed = sql.includes("mode = 'signed_only'")
      const suppliedFingerprint = b[2] as string | undefined
      if (signed) {
        if (effectiveMode !== 'signed_only' || suppliedFingerprint !== keyFingerprint(tenant, to_agent)) return { n: 0 }
      } else if (effectiveMode !== 'bearer_only') return { n: 0 }
      return { n: messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null && seatMatches(sql, b, m)).length }
    }
    if (sql.includes('FROM agents WHERE id = ?1 LIMIT 1')) {
      const [ref] = b as [string]
      return agents.find((a) => a.id === ref) ?? null
    }
    if (sql.includes('FROM agent_keys WHERE tenant')) {
      const [tenant, agentId] = b as [string, string]
      return keys[`${tenant}:${agentId}`] ?? null
    }
    if (sql.includes('SELECT department_id FROM squads WHERE id = ?1')) {
      const [squadId] = b as [string]
      const dept = squadDepartments[squadId]
      return dept === undefined ? null : { department_id: dept }
    }
    throw new Error('unhandled first: ' + sql)
  }
  function runAll(sql: string, b: unknown[]) {
    if (sql.includes('FROM capabilities') && sql.includes('channel_capability_grants')) {
      const [memberId] = b as [string]
      return capabilityGrants[memberId] ?? []
    }
    if (sql.includes('UPDATE agent_messages SET read_at')) {
      const [readAt, tenant, to_agent, limit] = b as [string, string, string, number]
      const effectiveMode = signedOnlyAgents.has(to_agent) ? 'signed_only' : 'bearer_only'
      const signed = sql.includes("mode = 'signed_only'")
      if (signed) {
        if (effectiveMode !== 'signed_only' || b[4] !== keyFingerprint(tenant, to_agent)) return []
      } else if (effectiveMode !== 'bearer_only') return []
      const claimed = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null && seatMatches(sql, b, m)).sort((x, y) => x.seq - y.seq).slice(0, limit)
      for (const m of claimed) m.read_at = readAt
      return claimed.map((m) => ({ ...m }))
    }
    if (sql.includes('FROM agent_messages') && sql.includes('read_at IS NULL') && sql.includes('ORDER BY seq ASC')) {
      const [tenant, to_agent, sinceSeqOrLimit, maybeLimit] = b as [string, string, number, number?]
      const effectiveMode = signedOnlyAgents.has(to_agent) ? 'signed_only' : 'bearer_only'
      const signed = sql.includes("mode = 'signed_only'")
      if (signed) {
        if (effectiveMode !== 'signed_only' || b[4] !== keyFingerprint(tenant, to_agent)) return []
      } else if (effectiveMode !== 'bearer_only') return []
      const hasCursor = sql.includes('seq >')
      const sinceSeq = hasCursor ? (sinceSeqOrLimit ?? 0) : 0
      const limit = hasCursor ? (maybeLimit as number) : sinceSeqOrLimit
      return messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null && m.seq > sinceSeq && seatMatches(sql, b, m)).sort((x, y) => x.seq - y.seq).slice(0, limit).map((m) => ({ ...m }))
    }
    if (sql.includes('FROM agents WHERE slug = ?1')) {
      const [ref] = b as [string]
      return agents.filter((a) => a.slug === ref)
    }
    if (sql.includes('WHERE lower(name) = lower(?1)')) {
      // F4, 2026-09: SQLite's lower() is ASCII-only (does not fold Unicode case) — mirror
      // that here with an ASCII-only fold instead of JS's Unicode-folding toLowerCase().
      const [ref] = b as [string]
      return agents.filter((a) => asciiLower(a.name) === asciiLower(String(ref)))
    }
    if (sql.includes('SELECT squad_id FROM memberships WHERE agent_id = ?1')) {
      return []
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
  memberStatuses: Record<string, string> = {},
  signedOnlyAgents: ReadonlySet<string> = new Set(),
  capabilityGrants: Record<string, CapabilityGrant[]> = {},
  squadDepartments: Record<string, string | null> = {},
): { env: Env; db: ReturnType<typeof makeDb> } {
  const db = makeDb(agents, keys, memberStatuses, signedOnlyAgents, capabilityGrants, squadDepartments)
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
  it('consuming (no peek) read on a seat-bound token only consumes its own seat + broadcast rows, leaving other-seat mail untouched', async () => {
    // Probes the DB-level seat predicate on the CONSUMING path directly (not just the
    // route-level seat_mismatch refusal above) — the shape mupot#1325's own-seat default
    // now exercises: no ?seat, own bound seat mail present alongside another seat's mail.
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'a', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'for cli', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-cli' })
    db._messages.push({ seq: 2, id: 'b', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'for mac', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-mac' })
    const res = await inboxApp.fetch(getReq('tok-code-cli'), e)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { messages: Array<{ body: string }> }
    expect(j.messages.map((m) => m.body)).toEqual(['for cli'])
    // the OTHER seat's row must remain unread — the consuming UPDATE must not have touched it.
    expect(db._messages.find((m) => m.id === 'b')?.read_at).toBeNull()
  })
  it('consuming (no peek) read on an UNSCOPED token (no seat label) stays broadcast-only — seat-tagged mail is never consumed by it', async () => {
    // The "fail open" mutation: dropping the default branch's `AND target_seat IS NULL`
    // would let a token with no seat binding at all silently consume every seat's mail on
    // its next unscoped poll. tok-code carries no seat label (see the member_tokens fake).
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'a', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'broadcast', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: null })
    db._messages.push({ seq: 2, id: 'b', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'for mac', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-mac' })
    const res = await inboxApp.fetch(getReq('tok-code'), e)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { messages: Array<{ body: string }> }
    expect(j.messages.map((m) => m.body)).toEqual(['broadcast'])
    expect(db._messages.find((m) => m.id === 'b')?.read_at).toBeNull()
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
  it('seat query (same-value echo on a seat-bound token) reads matching exact-seat and broadcast rows only', async () => {
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'a', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'broadcast', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: null })
    db._messages.push({ seq: 2, id: 'b', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'for cli', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-cli' })
    db._messages.push({ seq: 3, id: 'c', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'for mac', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-mac' })

    const res = await inboxApp.fetch(getReq('tok-code-cli', '?peek=1&seat=hadi-codex-cli'), e)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { messages: Array<{ body: string; target_seat: string | null }>; remaining: number }
    expect(j.messages.map((m) => m.body)).toEqual(['broadcast', 'for cli'])
    expect(j.messages.map((m) => m.target_seat)).toEqual([null, 'hadi-codex-cli'])
    expect(j.remaining).toBe(0)
  })
  it('no ?seat on a seat-bound token still returns its own seat mail plus broadcasts', async () => {
    // mupot#1325 P0-2: before the fix, omitting ?seat fell to `target_seat IS NULL`
    // (broadcast-only) even for a token whose OWN seat mail is waiting — reported as
    // messages:[] / complete:true, indistinguishable from "nothing to deliver".
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'a', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'broadcast', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: null })
    db._messages.push({ seq: 2, id: 'b', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'for cli', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-cli' })
    db._messages.push({ seq: 3, id: 'c', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'for mac', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-mac' })

    const res = await inboxApp.fetch(getReq('tok-code-cli', '?peek=1'), e)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { messages: Array<{ body: string }> }
    expect(j.messages.map((m) => m.body).sort()).toEqual(['broadcast', 'for cli'])
  })
  it('?seat=<other seat> on a seat-bound token refuses seat_mismatch and touches no rows', async () => {
    // mupot#1325 P0-1: this is the LEAK + DESTROY path — a token bound to one seat asking
    // for another's mail via the query string, on the default CONSUMING path (no peek).
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'v', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'request', body: 'for mac only', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-mac' })
    const res = await inboxApp.fetch(getReq('tok-code-cli', '?seat=hadi-codex-mac'), e)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'seat_mismatch' })
    // the victim's row must still be unread — nothing consumed, nothing leaked.
    expect(db._messages.find((m) => m.id === 'v')?.read_at).toBeNull()
  })
  it('?seat=<anything> on a token with NO seat label refuses seat_not_bound', async () => {
    const { env: e } = env(AGENTS)
    const res = await inboxApp.fetch(getReq('tok-code', '?seat=hadi-codex-cli'), e)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'seat_not_bound' })
  })
  it('invalid limit → 400', async () => {
    const { env: e } = env(AGENTS)
    expect((await inboxApp.fetch(getReq('tok-code', '?limit=abc'), e)).status).toBe(400)
  })
  it('signed-only fence rejects bearer reads without consuming', async () => {
    const { env: e, db } = env(AGENTS, {}, {}, new Set(['ag-code']))
    db._messages.push({ seq: 1, id: 'x', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'message', body: 'fenced', request_id: null, in_reply_to: null, created_at: 't0', read_at: null })
    const res = await inboxApp.fetch(getReq('tok-code'), e)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'consumer_fenced' })
    expect(db._messages[0].read_at).toBeNull()
  })
})

// Gate 1 (#392): m-code (tok-code's welded member) needs a squad-scoped observer grant on
// 's1' (both ag-code and ag-review live there) to reach ag-review under the new confinement —
// see the dedicated 'POST /api/inbox/send — gate 1' describe block below for the confinement
// cases themselves.
const M_CODE_OBSERVES_S1: Record<string, CapabilityGrant[]> = {
  'm-code': [{ member_id: 'm-code', scope_type: 'squad', scope_id: 's1', capability: 'observer' }],
}

describe('POST /api/inbox/send', () => {
  it('unbound token → 403', async () => {
    const { env: e } = env(AGENTS)
    expect((await inboxApp.fetch(postReq('tok-unbound', { to: 'review', body: 'x' }), e)).status).toBe(403)
  })
  it('happy: code → review lands in review’s inbox', async () => {
    const { env: e, db } = env(AGENTS, {}, {}, new Set(), M_CODE_OBSERVES_S1)
    const res = await inboxApp.fetch(postReq('tok-code', { to: 'review', body: 'build it' }), e)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { ok: boolean; to: string }
    expect(j.to).toBe('ag-review')
    expect(db._messages[0].from_agent).toBe('ag-code')
    expect(db._messages[0].to_agent).toBe('ag-review')
  })
  it('accepts an exact target seat for the recipient inbox', async () => {
    const { env: e, db } = env(AGENTS, {}, {}, new Set(), M_CODE_OBSERVES_S1)
    const res = await inboxApp.fetch(postReq('tok-code', { to: 'review', body: 'build it', seat: 'hadi-codex-cli' }), e)
    expect(res.status).toBe(200)
    const j = (await res.json()) as { ok: boolean; target_seat: string | null }
    expect(j.target_seat).toBe('hadi-codex-cli')
    expect(db._messages[0].target_seat).toBe('hadi-codex-cli')
  })
  it('rejects a non-string exact target seat', async () => {
    const { env: e } = env(AGENTS, {}, {}, new Set(), M_CODE_OBSERVES_S1)
    const res = await inboxApp.fetch(postReq('tok-code', { to: 'review', body: 'build it', seat: 123 }), e)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_args', detail: 'seat must be a string' })
  })
  it('unknown recipient → 404', async () => {
    const { env: e } = env(AGENTS, {}, {}, new Set(), M_CODE_OBSERVES_S1)
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

// Gate 1 (#392): confine the welded-token send TARGET. ag-review lives on a DIFFERENT squad
// here (s2) than ag-code (s1), so — unlike the AGENTS fixture above — a plain member grant on
// ag-code's own squad does NOT make ag-review visible.
const CROSS_SQUAD_AGENTS = [
  { id: 'ag-code', squad_id: 's1', slug: 'code', name: 'Code' },
  { id: 'ag-review', squad_id: 's2', slug: 'review', name: 'Review' },
]

describe('POST /api/inbox/send — gate 1 target confinement', () => {
  it('a welded token with NO capability grants cannot reach an agent on another squad → 404, generic reason', async () => {
    const { env: e } = env(CROSS_SQUAD_AGENTS)
    const res = await inboxApp.fetch(postReq('tok-code', { to: 'review', body: 'x' }), e)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'send_target_not_visible' })
  })

  it('the same generic reason covers BOTH an invisible target and a nonexistent one (non-leaking)', async () => {
    const { env: e } = env(CROSS_SQUAD_AGENTS)
    const invisible = await inboxApp.fetch(postReq('tok-code', { to: 'review', body: 'x' }), e)
    const missing = await inboxApp.fetch(postReq('tok-code', { to: 'ghost', body: 'x' }), e)
    expect(invisible.status).toBe(missing.status)
    expect(await invisible.json()).toMatchObject({ error: 'send_target_not_visible' })
    expect(await missing.json()).toMatchObject({ error: 'send_target_not_visible' })
  })

  it('an observer grant on the TARGET squad opens the send', async () => {
    const grants: Record<string, CapabilityGrant[]> = {
      'm-code': [{ member_id: 'm-code', scope_type: 'squad', scope_id: 's2', capability: 'observer' }],
    }
    const { env: e, db } = env(CROSS_SQUAD_AGENTS, {}, {}, new Set(), grants)
    const res = await inboxApp.fetch(postReq('tok-code', { to: 'review', body: 'reachable now' }), e)
    expect(res.status).toBe(200)
    expect(db._messages[0].to_agent).toBe('ag-review')
  })

  it('an org-admin grant preserves tenant-wide send (no squad grant needed)', async () => {
    const grants: Record<string, CapabilityGrant[]> = {
      'm-code': [{ member_id: 'm-code', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
    const { env: e, db } = env(CROSS_SQUAD_AGENTS, {}, {}, new Set(), grants)
    const res = await inboxApp.fetch(postReq('tok-code', { to: 'review', body: 'admin can reach anyone' }), e)
    expect(res.status).toBe(200)
    expect(db._messages[0].to_agent).toBe('ag-review')
  })
})

describe('POST /api/inbox/signed', () => {
  it('signed Host remains authoritative while the bearer inbox is fenced', async () => {
    const { kp, pubX } = await genKey()
    const { env: e, db } = env(
      AGENTS,
      { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-code' } },
      {},
      new Set(['ag-code']),
    )
    db._messages.push({ seq: 1, id: 'x', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'message', body: 'host only', request_id: null, in_reply_to: null, created_at: 't0', read_at: null })
    const res = await postSigned(await signedInboxBody(kp.privateKey, 'ag-code', { peek: false, limit: 1 }), e)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ consumed: true, messages: [{ body: 'host only' }] })
  })

  it('valid signature can peek without consuming, then consume the signed agent inbox', async () => {
    const { kp, pubX } = await genKey()
    const { env: e, db } = env(
      AGENTS,
      { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-code' } },
      {},
      new Set(['ag-code']),
    )
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

  it('bearer-only mode refuses signed peek and consumption', async () => {
    const { kp, pubX } = await genKey()
    const { env: e, db } = env(AGENTS, { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-code' } })
    db._messages.push({ seq: 1, id: 'x', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm', kind: 'message', body: 'preflight', request_id: null, in_reply_to: null, created_at: 't0', read_at: null })
    const peek = await postSigned(await signedInboxBody(kp.privateKey, 'ag-code', { peek: true, limit: 1 }), e)
    expect(peek.status).toBe(409)
    expect(await peek.json()).toMatchObject({ error: 'consumer_fenced' })
    const consume = await postSigned(await signedInboxBody(kp.privateKey, 'ag-code', { peek: false, limit: 1 }), e)
    expect(consume.status).toBe(409)
    expect(await consume.json()).toMatchObject({ error: 'consumer_fenced' })
    expect(db._messages[0].read_at).toBeNull()
  })

  it('replay of the same signed inbox request is rejected', async () => {
    const { kp, pubX } = await genKey()
    const { env: e } = env(
      AGENTS,
      { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-code' } },
      {},
      new Set(['ag-code']),
    )
    const body = await signedInboxBody(kp.privateKey, 'ag-code', { peek: true, limit: 10 })
    expect((await postSigned(body, e)).status).toBe(200)
    expect((await postSigned(body, e)).status).toBe(409)
  })

  it('tampered read mode after signing is rejected', async () => {
    const { kp, pubX } = await genKey()
    const { env: e } = env(AGENTS, { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-code' } })
    const body = await signedInboxBody(kp.privateKey, 'ag-code', { peek: true, limit: 10 })
    ;(body as Record<string, unknown>).peek = false
    expect((await postSigned(body, e)).status).toBe(401)
  })

  it('unknown signed agent key is unauthorized', async () => {
    const { kp } = await genKey()
    const { env: e } = env(AGENTS)
    expect((await postSigned(await signedInboxBody(kp.privateKey, 'ag-code'), e)).status).toBe(401)
  })

  it('unbound or disabled keys cannot read a signed inbox', async () => {
    const { kp, pubX } = await genKey()
    const unbound = env(AGENTS, { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: null } })
    expect((await postSigned(await signedInboxBody(kp.privateKey, 'ag-code'), unbound.env)).status).toBe(401)

    const disabled = env(
      AGENTS,
      { 't:ag-code': { pubkey: pubX, algo: 'Ed25519', member_id: 'm-code' } },
      { 'm-code': 'inactive' },
    )
    expect((await postSigned(await signedInboxBody(kp.privateKey, 'ag-code'), disabled.env)).status).toBe(401)
  })
})

describe('GET /api/inbox/stream', () => {
  it('no token → 401', async () => {
    const { env: e } = env(AGENTS)
    const res = await inboxApp.fetch(getReq(undefined, 'stream'), e)
    expect(res.status).toBe(401)
  })
  it('unbound token → 403', async () => {
    const { env: e } = env(AGENTS)
    const res = await inboxApp.fetch(getReq('tok-unbound', 'stream'), e)
    expect(res.status).toBe(403)
  })
  it('invalid since → 400', async () => {
    const { env: e } = env(AGENTS)
    const res = await inboxApp.fetch(getReq('tok-code', 'stream?since=abc'), e)
    expect(res.status).toBe(400)
  })
  it('invalid poll_ms → 400', async () => {
    const { env: e } = env(AGENTS)
    const res = await inboxApp.fetch(getReq('tok-code', 'stream?poll_ms=-5'), e)
    expect(res.status).toBe(400)
  })
  it('emits the recipient’s unread messages as SSE data frames', async () => {
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'x', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm-rev', kind: 'message', body: 'hi code', request_id: null, in_reply_to: null, created_at: 't0', read_at: null })
    const res = await inboxApp.fetch(getReq('tok-code', 'stream'), e)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    // Read only the first frame: the initial flush (poll loop runs forever).
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    await reader.cancel()
    expect(text).toMatch(/^data: /)
    const event = JSON.parse(text.slice(5))
    expect(event.type).toBe('initial')
    expect(event.messages.map((m: { body: string }) => m.body)).toEqual(['hi code'])
    // peek semantics: the stream never consumes — a later read still sees the message.
    const again = await inboxApp.fetch(getReq('tok-code', '?peek=1'), e)
    const j = (await again.json()) as { messages: unknown[] }
    expect(j.messages.length).toBe(1)
  })
  it('seat query (same-value echo on a seat-bound token) emits matching exact-seat and broadcast rows only', async () => {
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'a', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm-rev', kind: 'request', body: 'broadcast', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: null })
    db._messages.push({ seq: 2, id: 'b', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm-rev', kind: 'request', body: 'for cli', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-cli' })
    db._messages.push({ seq: 3, id: 'c', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm-rev', kind: 'request', body: 'for mac', request_id: null, in_reply_to: null, created_at: 't0', read_at: null, target_seat: 'hadi-codex-mac' })
    const res = await inboxApp.fetch(getReq('tok-code-cli', 'stream?seat=hadi-codex-cli'), e)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    await reader.cancel()
    const event = JSON.parse(text.slice(5))
    expect(event.type).toBe('initial')
    expect(event.messages.map((m: { body: string }) => m.body)).toEqual(['broadcast', 'for cli'])
    expect(event.since).toBe(2)
  })
  it('?seat=<other seat> on the stream route refuses seat_mismatch (JSON, not a stream)', async () => {
    const { env: e } = env(AGENTS)
    const res = await inboxApp.fetch(getReq('tok-code-cli', 'stream?seat=hadi-codex-mac'), e)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'seat_mismatch' })
  })
  it('since=N skips already-seen messages in the initial flush', async () => {
    const { env: e, db } = env(AGENTS)
    db._messages.push({ seq: 1, id: 'a', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm-rev', kind: 'message', body: 'old', request_id: null, in_reply_to: null, created_at: 't0', read_at: null })
    db._messages.push({ seq: 2, id: 'b', tenant: 't', to_agent: 'ag-code', from_agent: 'ag-review', from_member: 'm-rev', kind: 'request', body: 'new', request_id: 'rid', in_reply_to: null, created_at: 't0', read_at: null })
    const res = await inboxApp.fetch(getReq('tok-code', 'stream?since=1'), e)
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    await reader.cancel()
    const event = JSON.parse(text.slice(5))
    expect(event.type).toBe('initial')
    expect(event.messages.map((m: { body: string }) => m.body)).toEqual(['new'])
    expect(event.since).toBe(2)
  })
})
