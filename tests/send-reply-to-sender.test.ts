// tests/send-reply-to-sender.test.ts — a REPLY exception to home-squad privacy on `send`.
//
// A home-squad seat (built by the real auto-seat path) can message a squad-core agent, but that
// agent's answer used to be refused (send_target_not_visible: nothing of its grants covers a home
// squad). `send` with in_reply_to = a message addressed to the caller may now reach that message's
// sender and no one else. Real sqlite D1 over the full migration chain; the home seat comes from
// boot_context's auto-seat, the sends go through the real MCP `send` tool.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { REPLY_CAP_PER_MESSAGE, resolveVisibleSendTarget, sendToRef } from '../src/agents/messages'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
let h: SqliteD1Harness
let tok = 0
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)

function envFor(): Env {
  const store = new Map<string, string>()
  const kv = { async get(k: string) { return store.get(k) ?? null }, async put(k: string, v: string) { store.set(k, v) }, async delete(k: string) { store.delete(k) } }
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test', SESSIONS: kv, OAUTH_KV: { get: async () => null, put: async () => undefined },
    SEAT_AUTO_ENROLL: '1', SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200',
  } as unknown as Env
}

async function rpc(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
  const params: Record<string, unknown> = { name, arguments: args }
  if (meta) params._meta = meta
  const req = new Request('https://pot.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: Array<{ text?: string }> } }
  const text = body.result?.content?.[0]?.text
  const parsed = text ? (JSON.parse(text) as { ok?: boolean; status?: number }) : {}
  return { status: parsed.ok === false ? Number(parsed.status) : res.status, sc: body.result?.structuredContent ?? {}, raw: JSON.stringify(body) }
}

interface Seat { ctx: AuthContext; agentId: string; memberId: string; meta: Record<string, unknown> }

/** A human's ChatGPT connector, auto-seated on the human's HOME squad by the production path. */
async function homeSeat(env: Env, human: string, session: string): Promise<Seat> {
  h.sqlite.exec(`INSERT OR IGNORE INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${human}', '${human}@example.test', 'H ${human}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const harness = await upsertHarness(env, human, 'client-chatgpt', 'ChatGPT')
  if (!harness) throw new Error('harness')
  const tokenId = `tok-${++tok}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${human}', 'hash-${tokenId}', 'oauth:chatgpt', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId: human, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('ctx')
  const meta = { 'openai/session': session }
  const b = await rpc(env, ctx, 'boot_context', {}, meta)
  const agentId = String(b.sc.bound_agent_id)
  const memberId = String(b.sc.member_id)
  expect(n(`SELECT COUNT(*) AS n FROM agents a JOIN squads s ON s.id = a.squad_id WHERE a.id = ? AND s.kind = 'home'`, agentId)).toBe(1)
  // The seat reaches kasra the way production does: kasra is a (guest) member of the seat's home
  // squad, so the seat's home grant makes it visible. Nothing here gives kasra a grant over the home.
  const homeSquad = String(h.sqlite.prepare(`SELECT squad_id FROM agents WHERE id = ?`).get(agentId)!.squad_id)
  h.sqlite.exec(`INSERT OR IGNORE INTO memberships (id, agent_id, squad_id, capability) SELECT 'guest-' || a.id || '-${agentId}', a.id, '${homeSquad}', 'member' FROM agents a WHERE a.squad_id = 'squad-core'`)
  return { ctx, agentId, memberId, meta }
}

/** A squad-core agent's own bound token: member-level grant on squad-core ONLY (never a home squad, never admin). */
async function coreAgent(env: Env, agentId: string, slug: string): Promise<AuthContext> {
  const memberId = `mem-${agentId}`
  h.sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name) VALUES ('${agentId}', 'squad-core', '${slug}', 'Name ${slug}');
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${memberId}', '${memberId}@example.test', '${slug}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${memberId}', '${memberId}', 'squad', 'squad-core', 'member');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-${agentId}', '${agentId}', 'squad-core', 'member');
  `)
  h.sqlite.exec(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${agentId}', '${memberId}', '2026-10-09T00:00:00.000Z')`)
  const tokenId = `tok-${++tok}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'cli', 'workspace', '${agentId}', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'workspace', boundAgentId: agentId, harnessId: null })
  if (!ctx) throw new Error('core ctx')
  return ctx
}

const sendFrom = (env: Env, s: Seat, args: Record<string, unknown>) => rpc(env, s.ctx, 'send', args, s.meta)
const msgId = (to: string, from: string): string =>
  String(h.sqlite.prepare(`SELECT id FROM agent_messages WHERE to_agent = ? AND from_agent = ? ORDER BY seq DESC LIMIT 1`).get(to, from)!.id)

let env: Env
let kasra: AuthContext
beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-core', 'core', 'Core');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-core', 'core', 'Core');
  `)
  env = envFor()
  kasra = await coreAgent(env, 'agent-kasra', 'kasra')
})
afterEach(() => h.close())

describe('reply into a home squad', () => {
  it('baseline: a non-reply send from kasra to the home seat is refused, with the reply path in the next step', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    const r = await rpc(env, kasra, 'send', { to: seat.agentId, body: 'hello' })
    expect(r.status).toBe(404)
    expect(r.raw).toContain('send_target_not_visible')
    expect(r.raw).toContain('in_reply_to')
  })

  it('seat -> kasra lands; kasra replies with in_reply_to (message id) and it reaches the seat', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    expect((await sendFrom(env, seat, { to: 'agent-kasra', body: 'please help' })).status).toBe(200)
    const orig = msgId('agent-kasra', seat.agentId)
    const r = await rpc(env, kasra, 'send', { to: seat.agentId, body: 'done', in_reply_to: orig })
    expect(r.status).toBe(200)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ? AND from_agent = 'agent-kasra' AND in_reply_to = ? AND body = 'done'`, seat.agentId, orig)).toBe(1)
  })

  it('addressing the sender by slug or @slug also works (the ref still resolves only to that sender)', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'q' })
    const orig = msgId('agent-kasra', seat.agentId)
    const slug = String(h.sqlite.prepare(`SELECT slug FROM agents WHERE id = ?`).get(seat.agentId)!.slug)
    expect((await rpc(env, kasra, 'send', { to: `@${slug}`, body: 'a', in_reply_to: orig })).status).toBe(200)
  })

  it('ack protocol: request with request_id, kind=ack reply with in_reply_to = that request_id reaches the seat', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    expect((await sendFrom(env, seat, { to: 'agent-kasra', body: 'need X', kind: 'request', request_id: 'req-abc-1' })).status).toBe(200)
    const r = await rpc(env, kasra, 'send', { to: seat.agentId, body: 'X done', kind: 'ack', in_reply_to: 'req-abc-1' })
    expect(r.status).toBe(200)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ? AND kind = 'ack'`, seat.agentId)).toBe(1)
  })

  it('a reply without in_reply_to is refused', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'q' })
    const r = await rpc(env, kasra, 'send', { to: seat.agentId, body: 'no link' })
    expect(r.status).toBe(404)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`, seat.agentId)).toBe(0)
  })

  it('in_reply_to pointing at a message NOT addressed to the caller is refused', async () => {
    await coreAgent(env, 'agent-other', 'other')
    const seat = await homeSeat(env, 'human-1', 's1')
    await sendFrom(env, seat, { to: 'agent-other', body: 'for other, not kasra' })
    const orig = msgId('agent-other', seat.agentId)
    const r = await rpc(env, kasra, 'send', { to: seat.agentId, body: 'eavesdrop', in_reply_to: orig })
    expect(r.status).toBe(404)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`, seat.agentId)).toBe(0)
  })

  it('in_reply_to to a message from a DIFFERENT sender is refused (reply cannot be redirected to another home seat)', async () => {
    const a = await homeSeat(env, 'human-1', 's1')
    const b = await homeSeat(env, 'human-2', 's2')
    await sendFrom(env, a, { to: 'agent-kasra', body: 'from a' })
    const orig = msgId('agent-kasra', a.agentId)
    const r = await rpc(env, kasra, 'send', { to: b.agentId, body: 'to b', in_reply_to: orig })
    expect(r.status).toBe(404)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`, b.agentId)).toBe(0)
  })

  it('an expired message (older than the window) is refused; a recent one is accepted', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'old' })
    const orig = msgId('agent-kasra', seat.agentId)
    const age = (days: number) => h.sqlite.prepare(`UPDATE agent_messages SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - days * 86400000).toISOString(), orig)
    age(8)
    expect((await rpc(env, kasra, 'send', { to: seat.agentId, body: 'late', in_reply_to: orig })).status).toBe(404)
    age(6)
    expect((await rpc(env, kasra, 'send', { to: seat.agentId, body: 'in time', in_reply_to: orig })).status).toBe(200)
  })

  it('a message row from another tenant never authorises a reply', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    h.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at) VALUES ('xmsg-1', 'other-pot', 'agent-kasra', '${seat.agentId}', '${seat.memberId}', 'message', 'x', '${new Date().toISOString()}')`)
    const r = await rpc(env, kasra, 'send', { to: seat.agentId, body: 'cross', in_reply_to: 'xmsg-1' })
    expect(r.status).toBe(404)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ?`, seat.agentId)).toBe(0)
  })

  it('a deactivated sender is not reachable through the reply path', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'q' })
    const orig = msgId('agent-kasra', seat.agentId)
    h.sqlite.prepare(`UPDATE agents SET status = 'inactive' WHERE id = ?`).run(seat.agentId)
    expect((await rpc(env, kasra, 'send', { to: seat.agentId, body: 'x', in_reply_to: orig })).status).toBe(404)
  })

  it('caps replies per original message', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'q' })
    const orig = msgId('agent-kasra', seat.agentId)
    for (let i = 0; i < REPLY_CAP_PER_MESSAGE; i++) {
      const r = await rpc(env, kasra, 'send', { to: seat.agentId, body: `r${i}`, in_reply_to: orig })
      expect(r.status).toBe(200)
    }
    const over = await rpc(env, kasra, 'send', { to: seat.agentId, body: 'too many', in_reply_to: orig })
    expect(over.status).toBe(404)
    expect(over.raw).toContain('reply limit')
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ? AND in_reply_to = ?`, seat.agentId, orig)).toBe(REPLY_CAP_PER_MESSAGE)
  })

  it('a third squad-core agent that was not the addressee gets no reply path (to_agent must be the caller)', async () => {
    const other = await coreAgent(env, 'agent-third', 'third')
    const seat = await homeSeat(env, 'human-1', 's1')
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'q' })
    const orig = msgId('agent-kasra', seat.agentId)
    const r = await rpc(env, other, 'send', { to: seat.agentId, body: 'steal', in_reply_to: orig })
    expect(r.status).toBe(404)
  })

  it('grants no visibility: after a landed reply, home seats are still invisible to kasra for non-reply sends and name resolution', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    const other = await homeSeat(env, 'human-2', 's2')
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'q' })
    const orig = msgId('agent-kasra', seat.agentId)
    expect((await rpc(env, kasra, 'send', { to: seat.agentId, body: 'ok', in_reply_to: orig })).status).toBe(200)
    expect((await rpc(env, kasra, 'send', { to: seat.agentId, body: 'again, no link' })).status).toBe(404)
    expect((await rpc(env, kasra, 'send', { to: other.agentId, body: 'other seat', in_reply_to: orig })).status).toBe(404)
    const authz = { isAdmin: false, grants: kasra.capabilities ?? [] }
    const viaResolver = await resolveVisibleSendTarget(env, seat.agentId, authz, kasra.memberId as string)
    expect(viaResolver.ok).toBe(false)
  })
})

describe('reply path: no oracle, atomic cap, canonical key', () => {
  async function thread(rid?: string) {
    const seat = await homeSeat(env, 'human-1', 's1')
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'q', ...(rid ? { request_id: rid } : {}) })
    return { seat, orig: msgId('agent-kasra', seat.agentId) }
  }
  const landed = (seatAgent: string): number => n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ? AND from_agent = 'agent-kasra'`, seatAgent)

  it('seat and project_id are refused on the reply path, identically for real and guessed values (no seat-label or membership probe)', async () => {
    const { seat, orig } = await thread()
    const label = String(h.sqlite.prepare(`SELECT label FROM member_tokens WHERE agent_id = ? LIMIT 1`).get(seat.agentId)?.label ?? 'x')
    const probes = [{ seat: label }, { seat: 'no-such-seat' }, { project_id: 'no-such-project' }]
    const out: string[] = []
    for (const extra of probes) {
      const r = await rpc(env, kasra, 'send', { to: seat.agentId, body: 'p', in_reply_to: orig, ...extra })
      expect(r.status).toBe(404)
      out.push(r.raw.replace(/\\"seq\\":\d+/g, ''))
    }
    expect(new Set(out).size).toBe(1)
    expect(landed(seat.agentId)).toBe(0)
  })

  it('inbox_full on the reply path is indistinguishable from any other refusal', async () => {
    const { seat, orig } = await thread()
    h.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at) VALUES ('fill-1', '${TENANT}', '${seat.agentId}', 'agent-kasra', 'mem-agent-kasra', 'message', 'x', '${new Date().toISOString()}')`)
    const authz = { isAdmin: false, grants: kasra.capabilities ?? [] }
    const res = await sendToRef(env, { fromAgent: 'agent-kasra', fromMember: kasra.memberId as string, toRef: seat.agentId, body: 'r', inReplyTo: orig }, authz, { maxUnread: 1 })
    expect(res).toEqual({ ok: false, reason: 'send_target_not_visible', detail: undefined })
  })

  it('a non-admin caller whose grants span two members gets no reply path', async () => {
    const { seat, orig } = await thread()
    const grants = [...(kasra.capabilities ?? []), { ...(kasra.capabilities ?? [])[0], member_id: 'someone-else' }]
    const res = await sendToRef(env, { fromAgent: 'agent-kasra', fromMember: kasra.memberId as string, toRef: seat.agentId, body: 'r', inReplyTo: orig }, { isAdmin: false, grants })
    expect(res.ok).toBe(false)
    expect(landed(seat.agentId)).toBe(0)
  })

  it('concurrent replies: 60 at once land exactly REPLY_CAP_PER_MESSAGE', async () => {
    const { seat, orig } = await thread()
    await Promise.all(Array.from({ length: 60 }, (_, i) => rpc(env, kasra, 'send', { to: seat.agentId, body: `c${i}`, in_reply_to: orig })))
    expect(landed(seat.agentId)).toBe(REPLY_CAP_PER_MESSAGE)
  })

  it('citing the message id and the request_id share ONE cap, and both store the canonical id', async () => {
    const { seat, orig } = await thread('req-mix')
    await Promise.all(Array.from({ length: 60 }, (_, i) => rpc(env, kasra, 'send', { to: seat.agentId, body: `m${i}`, in_reply_to: i % 2 ? orig : 'req-mix' })))
    expect(landed(seat.agentId)).toBe(REPLY_CAP_PER_MESSAGE)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE from_agent = 'agent-kasra' AND in_reply_to = ?`, orig)).toBe(REPLY_CAP_PER_MESSAGE)
  })

  it('another agent\'s rows keyed on the same original never consume the replier\'s cap (per original + replier)', async () => {
    const { seat, orig } = await thread()
    await coreAgent(env, 'agent-third', 'third')
    for (let i = 0; i < REPLY_CAP_PER_MESSAGE; i++) {
      h.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, in_reply_to, created_at) VALUES ('x-${i}', '${TENANT}', '${seat.agentId}', 'agent-third', 'mem-agent-third', 'message', 'x', '${orig}', '${new Date().toISOString()}')`)
    }
    expect((await rpc(env, kasra, 'send', { to: seat.agentId, body: 'mine', in_reply_to: orig })).status).toBe(200)
  })

  it('request_id shadowing: an unrelated sender\'s message whose request_id equals this id never shadows or redirects', async () => {
    const a = await homeSeat(env, 'human-1', 's1')
    const b = await homeSeat(env, 'human-2', 's2')
    await sendFrom(env, a, { to: 'agent-kasra', body: 'from a' })
    const aId = msgId('agent-kasra', a.agentId)
    await sendFrom(env, b, { to: 'agent-kasra', body: 'from b, rid collides with a\'s message id', request_id: aId })
    const bId = msgId('agent-kasra', b.agentId)
    // to A citing A's id: the id match wins and lands on A, never on B
    expect((await rpc(env, kasra, 'send', { to: a.agentId, body: 'to a', in_reply_to: aId })).status).toBe(200)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ? AND in_reply_to = ?`, a.agentId, aId)).toBe(1)
    // to B citing the same string: B's request_id match is found (sender filtered before the pick)
    expect((await rpc(env, kasra, 'send', { to: b.agentId, body: 'to b', in_reply_to: aId })).status).toBe(200)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ? AND in_reply_to = ?`, b.agentId, bId)).toBe(1)
  })

  it('pins which row wins: the exact message-id match beats a newer request_id match from the same sender', async () => {
    const seat = await homeSeat(env, 'human-1', 's1')
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'first' })
    const x = msgId('agent-kasra', seat.agentId)
    await sendFrom(env, seat, { to: 'agent-kasra', body: 'second, newer', request_id: x })
    expect((await rpc(env, kasra, 'send', { to: seat.agentId, body: 'r', in_reply_to: x })).status).toBe(200)
    expect(n(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = ? AND in_reply_to = ?`, seat.agentId, x)).toBe(1)
  })

  it('a ref that matches two different senders of messages to the caller is refused as ambiguous', async () => {
    const a = await homeSeat(env, 'human-1', 's1')
    const b = await homeSeat(env, 'human-2', 's2')
    await sendFrom(env, a, { to: 'agent-kasra', body: 'a', request_id: 'same-rid' })
    await sendFrom(env, b, { to: 'agent-kasra', body: 'b', request_id: 'same-rid' })
    h.sqlite.prepare(`UPDATE agents SET name = 'Twin' WHERE id IN (?, ?)`).run(a.agentId, b.agentId)
    const r = await rpc(env, kasra, 'send', { to: 'Twin', body: 'x', in_reply_to: 'same-rid' })
    expect(r.status).toBe(404)
    expect(landed(a.agentId) + landed(b.agentId)).toBe(0)
  })
})

