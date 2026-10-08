// mupot#1774 — inbox_ack of a full lease (100 ids) must stay under D1's 100-parameter
// ceiling. The ack bound tenant, agent and timestamp plus one parameter per id: 103 for a
// full lease, which D1 refuses, so the messages stayed leased and were redelivered. The
// sqlite double has no ceiling; strictD1 adds the one production enforces.

import { describe, expect, it } from 'vitest'

import { ackAgentMessages, leaseAgentInbox } from '../src/agents/messages'
import { D1_MAX_BOUND_PARAMETERS } from '../src/lib/d1-in-list'
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
    // Interleave so each category straddles the 90-id chunk boundary.
    const ids = [...done.slice(0, 25), ...fresh, ...foreign, ...done.slice(25)]
    expect(ids).toHaveLength(100)

    const res = await ackAgentMessages(f.env, { agent: 'agent-a', ids }, LATER)
    expect(res).toMatchObject({ ok: true })
    const out = res as { acked: string[]; already_read: string[]; refused: string[] }
    expect(out.acked).toEqual(fresh)
    expect(out.already_read).toEqual([...done.slice(0, 25), ...done.slice(25)])
    expect(out.refused).toEqual(foreign)
    expect(f.maxBound()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
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
