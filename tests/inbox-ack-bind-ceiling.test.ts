// mupot#1774 — inbox_ack of a full lease (100 ids) must stay under D1's 100-parameter
// ceiling. The ack bound tenant, agent and timestamp plus one parameter per id: 103 for a
// full lease, which D1 refuses, so the messages stayed leased and were redelivered. The
// sqlite double has no ceiling; strictD1 adds the one production enforces.

import { describe, expect, it } from 'vitest'

import { ackAgentMessages, leaseAgentInbox } from '../src/agents/messages'
import { D1_MAX_BOUND_PARAMETERS } from '../src/lib/d1-in-list'
import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { strictD1 } from './helpers/strict-d1'
import { applyAllMigrations } from './helpers/migrations'

const T0 = '2026-10-08T20:00:00.000Z'
const LATER = { now: () => '2026-10-08T20:00:05.000Z' }

function fixture() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'operator', 'test', 'active'),
      ('agent-b', 'squad-a', 'agent-b', 'Agent Beta', 'operator', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('owner', 'owner@pot.test', 'Owner', 'active', 'tenant-a');
  `)
  const insert = harness.sqlite.prepare(
    `INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
     VALUES (?, 'tenant-a', ?, 'sender', 'owner', 'request', 'work', ?)`,
  )
  const seed = (prefix: string, count: number, to = 'agent-a') => {
    const ids: string[] = []
    for (let i = 0; i < count; i += 1) {
      const id = `${prefix}-${String(i).padStart(3, '0')}`
      insert.run(id, to, T0)
      ids.push(id)
    }
    return ids
  }
  const markRead = (ids: string[]) => {
    const stmt = harness.sqlite.prepare(`UPDATE agent_messages SET read_at = ? WHERE id = ?`)
    for (const id of ids) stmt.run(T0, id)
  }
  const unread = () => (harness.sqlite.prepare(
    `SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-a' AND read_at IS NULL`,
  ).get() as { n: number }).n
  const strict = strictD1(harness.db)
  const env = { TENANT_SLUG: 'tenant-a', DB: strict.db } as unknown as Env
  return { harness, env, seed, markRead, unread, maxBound: strict.maxBound }
}

describe('mupot#1774: inbox_ack stays under the D1 bind ceiling', () => {
  it('acks a full 100-message lease in one call', async () => {
    const f = fixture()
    f.seed('m', 100)
    const lease = await leaseAgentInbox(f.env, { agent: 'agent-a', limit: 100 }, { now: () => T0 })
    expect(lease).toMatchObject({ ok: true })
    const ids = (lease as { messages: { id: string }[] }).messages.map((m) => m.id)
    expect(ids).toHaveLength(100)

    const res = await ackAgentMessages(f.env, { agent: 'agent-a', ids }, LATER)
    expect(res).toMatchObject({ ok: true, already_read: [], refused: [] })
    expect((res as { acked: string[] }).acked).toEqual(ids)
    expect(f.unread()).toBe(0)
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
    f.harness.close()
  })

  it.each([97, 98, 99, 100])('acks %i ids without exceeding the ceiling', async (count) => {
    const f = fixture()
    const ids = f.seed('m', count)
    const res = await ackAgentMessages(f.env, { agent: 'agent-a', ids }, LATER)
    expect((res as { acked: string[] }).acked).toHaveLength(count)
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
    f.harness.close()
  })

  it('classifies every id across chunk boundaries: acked, already read, refused', async () => {
    const f = fixture()
    const fresh = f.seed('fresh', 40)
    const done = f.seed('done', 50)
    f.markRead(done)
    const foreign = f.seed('foreign', 10, 'agent-b')
    // Order so done, fresh and foreign each have ids on both sides of the 90-id chunk
    // boundary: 0-44 done, 45-64 fresh, 65-69 foreign, 70-87 fresh, 88-92 done,
    // 93-97 foreign, 98-99 fresh.
    const ids = [
      ...done.slice(0, 45), ...fresh.slice(0, 20), ...foreign.slice(0, 5), ...fresh.slice(20, 38),
      ...done.slice(45), ...foreign.slice(5), ...fresh.slice(38),
    ]
    expect(ids).toHaveLength(100)

    const res = await ackAgentMessages(f.env, { agent: 'agent-a', ids }, LATER)
    expect(res).toMatchObject({ ok: true })
    const out = res as { acked: string[]; already_read: string[]; refused: string[] }
    expect(out.acked).toEqual(ids.filter((id) => id.startsWith('fresh-')))
    expect(out.acked).toHaveLength(40)
    expect(out.already_read).toEqual(ids.filter((id) => id.startsWith('done-')))
    expect(out.refused).toEqual(ids.filter((id) => id.startsWith('foreign-')))
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
    f.harness.close()
  })

  it('a retried ack of a full lease is idempotent: 100 already-read ids classify in chunks', async () => {
    // The lost-response retry the ack docstring promises: every id is already read, so the
    // whole list goes to the classification SELECT (2 fixed parameters + 100 ids unchunked).
    const f = fixture()
    const ids = f.seed('m', 100)
    expect((await ackAgentMessages(f.env, { agent: 'agent-a', ids }, LATER) as { acked: string[] }).acked).toEqual(ids)
    const retry = await ackAgentMessages(f.env, { agent: 'agent-a', ids }, LATER)
    expect(retry).toEqual({ ok: true, acked: [], already_read: ids, refused: [] })
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
    f.harness.close()
  })

  it('classifies already-read ids beyond the first chunk (95 read + 5 fresh)', async () => {
    const f = fixture()
    const done = f.seed('done', 95)
    f.markRead(done)
    const fresh = f.seed('fresh', 5)
    const res = await ackAgentMessages(f.env, { agent: 'agent-a', ids: [...done, ...fresh] }, LATER)
    expect(res).toEqual({ ok: true, acked: fresh, already_read: done, refused: [] })
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
    f.harness.close()
  })

  it('is all-or-nothing: one batch of per-chunk statements, and a failure in a later chunk leaves every message unread', async () => {
    const f = fixture()
    const ids = f.seed('m', 100)
    // Count statements across EVERY batch call and fail the 2nd one globally, so a loop of
    // per-chunk batch([stmt]) calls cannot pass as atomic: its first batch would commit alone.
    let batchCalls = 0
    let statementsSeen = 0
    const batchSizes: number[] = []
    const base = f.env.DB
    const proxied = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver)
        return (statements: D1PreparedStatement[]) => {
          batchCalls += 1
          batchSizes.push(statements.length)
          const rewritten = statements.map((statement) => {
            statementsSeen += 1
            return statementsSeen === 2 ? target.prepare('SELECT * FROM no_such_table_1774') : statement
          })
          return target.batch(rewritten)
        }
      },
    })
    const failing: Env = { ...f.env, DB: proxied }
    const res = await ackAgentMessages(failing, { agent: 'agent-a', ids }, LATER)
    expect(res).toMatchObject({ ok: false, reason: 'db_error' })
    expect(batchCalls).toBe(1)
    expect(batchSizes).toEqual([2]) // 100 ids -> two chunks, applied as one transaction
    expect(f.unread()).toBe(100)
    f.harness.close()
  })

  it('still refuses more than 100 ids at the argument check', async () => {
    const f = fixture()
    const ids = f.seed('m', 101)
    expect(await ackAgentMessages(f.env, { agent: 'agent-a', ids }, LATER))
      .toMatchObject({ ok: false, reason: 'invalid_ids' })
    expect(f.unread()).toBe(101)
    f.harness.close()
  })
})
