// tests/inbox-truncation-honesty.test.ts
//
// Real SQLite, whole committed migration chain. These test BEHAVIOUR, not shape,
// because the defect being closed is that a capped response is successful,
// well-formed, and indistinguishable from a complete one at the call site.
//
// WHY THIS EXISTS. On 2026-09-03 the same mistake was made four times in one
// night by three different agents across two substrates:
//   1. the seatlink bridge peeked at limit=100, ignored what was left, and
//      dropped genuinely-unread mail;
//   2. a gate consumed rows it never read, unrecoverably, an hour after blocking
//      (1) for the same shape;
//   3. an agent-profile page rendered a capped row count as a total, in the very
//      commit arguing that an unknown must never be presented as a measurement;
//   4. a CI watcher read a half-populated result as settled and reported
//      failures that had not happened.
//
// Every one was committed by someone actively hunting the same bug elsewhere, so
// the fix cannot be "be careful". `remaining` was also POLYSEMOUS — counted after
// the consuming path had already marked rows read, so it included the returned
// rows on peek and excluded them on consume. One field, two meanings, chosen by a
// different argument.

import { describe, expect, it } from 'vitest'
import { readAgentInbox, leaseAgentInbox } from '../src/agents/messages'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const T0 = '2026-09-03T03:00:00.000Z'

function fixture() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'operator', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('owner', 'owner@pot.test', 'Owner', 'active', 'tenant-a');
  `)
  const env = { TENANT_SLUG: 'tenant-a', DB: harness.db } as unknown as Env
  const seed = (n: number) => {
    for (let i = 0; i < n; i += 1) {
      harness.sqlite.exec(`
        INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
        VALUES ('m${i}', 'tenant-a', 'agent-a', 'sender', 'owner', 'request', 'work ${i}', '${T0}');
      `)
    }
  }
  return { env, seed, close: () => harness.close() }
}

describe('a capped read says so — peek', () => {
  it('reports complete:false and what is left when the read is capped', async () => {
    const f = fixture()
    f.seed(10)
    const res = await readAgentInbox(f.env, { agent: 'agent-a', peek: true, limit: 4 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.messages).toHaveLength(4)
    expect(res.complete).toBe(false)
    expect(res.remaining).toBe(6)
    f.close()
  })

  it('reports complete:true when it handed back everything', async () => {
    const f = fixture()
    f.seed(3)
    const res = await readAgentInbox(f.env, { agent: 'agent-a', peek: true, limit: 50 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.complete).toBe(true)
    expect(res.remaining).toBe(0)
    f.close()
  })

  it('an empty inbox is complete, not truncated — absent is not incomplete', async () => {
    const f = fixture()
    const res = await readAgentInbox(f.env, { agent: 'agent-a', peek: true })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.messages).toHaveLength(0)
    expect(res.complete).toBe(true)
    f.close()
  })

  it('a read exactly at the boundary is complete, not falsely flagged', async () => {
    const f = fixture()
    f.seed(4)
    const res = await readAgentInbox(f.env, { agent: 'agent-a', peek: true, limit: 4 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.messages).toHaveLength(4)
    expect(res.complete).toBe(true)
    expect(res.remaining).toBe(0)
    f.close()
  })
})

describe('a capped read says so — consume', () => {
  it('reports complete:false and what is still unread after consuming', async () => {
    const f = fixture()
    f.seed(10)
    const res = await readAgentInbox(f.env, { agent: 'agent-a', limit: 4 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.messages).toHaveLength(4)
    expect(res.complete).toBe(false)
    expect(res.remaining).toBe(6)
    f.close()
  })

  it('reports complete:true when the consume drained the inbox', async () => {
    const f = fixture()
    f.seed(3)
    const res = await readAgentInbox(f.env, { agent: 'agent-a', limit: 50 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.complete).toBe(true)
    expect(res.remaining).toBe(0)
    f.close()
  })
})

// THE REGRESSION THAT MATTERS. `remaining` used to mean different things on the
// two paths, so a caller that learned the rule on one was silently wrong on the
// other. Both paths must now answer identically for identical state.
describe('remaining means the same thing on both paths', () => {
  it('peek and consume agree on what is left over, from identical state', async () => {
    const a = fixture()
    a.seed(10)
    const peeked = await readAgentInbox(a.env, { agent: 'agent-a', peek: true, limit: 4 })

    const b = fixture()
    b.seed(10)
    const consumed = await readAgentInbox(b.env, { agent: 'agent-a', limit: 4 })

    expect(peeked.ok && consumed.ok).toBe(true)
    if (!peeked.ok || !consumed.ok) return
    expect(peeked.remaining).toBe(consumed.remaining)
    expect(peeked.complete).toBe(consumed.complete)
    a.close(); b.close()
  })

  it('neither path ever counts the rows it just handed back', async () => {
    const f = fixture()
    f.seed(5)
    const res = await readAgentInbox(f.env, { agent: 'agent-a', peek: true, limit: 5 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // All five returned; nothing is left over. If `remaining` still included the
    // returned rows this would read 5 and the caller would loop forever.
    expect(res.remaining).toBe(0)
    f.close()
  })
})

describe('lease reads answer the same question', () => {
  it('reports complete:false when more remains leasable', async () => {
    const f = fixture()
    f.seed(10)
    const res = await leaseAgentInbox(f.env, { agent: 'agent-a', limit: 4 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.complete).toBe(false)
    expect(res.remaining).toBeGreaterThan(0)
    f.close()
  })

  it('reports complete:true when it took everything leasable', async () => {
    const f = fixture()
    f.seed(2)
    const res = await leaseAgentInbox(f.env, { agent: 'agent-a', limit: 50 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.complete).toBe(true)
    expect(res.remaining).toBe(0)
    f.close()
  })
})


describe('pagination — the cursor must be reflected in what is left over', () => {
  it('page two of two reports complete, not a phantom remainder', async () => {
    const f = fixture()
    f.seed(150)
    const p1 = await readAgentInbox(f.env, { agent: 'agent-a', peek: true, limit: 100, sinceSeq: 0 })
    expect(p1.ok).toBe(true)
    if (!p1.ok) return
    expect(p1.messages).toHaveLength(100)
    expect(p1.complete).toBe(false)
    expect(p1.remaining).toBe(50)

    const cursor = p1.messages[p1.messages.length - 1].seq
    const p2 = await readAgentInbox(f.env, { agent: 'agent-a', peek: true, limit: 100, sinceSeq: cursor })
    expect(p2.ok).toBe(true)
    if (!p2.ok) return
    expect(p2.messages).toHaveLength(50)
    // The whole point of the cursor: nothing is left ABOVE it once drained.
    expect(p2.remaining).toBe(0)
    expect(p2.complete).toBe(true)
    f.close()
  })
})
