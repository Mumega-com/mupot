// tests/agent-inbox-lease-sqlite.test.ts — lease / ack / dead-letter (#899).
//
// Real SQLite, and the schema is the WHOLE committed migration chain via applyAllMigrations
// (the #684 ratchet — scripts/check-test-schema-source.mjs). The first draft of this file
// hand-wrote a five-column agent_messages and pinned migrations 0058 + 0090 individually.
// It passed. That is precisely the shape the ratchet exists to reject: a hand-picked chain
// starts correct and rots without anyone making a mistake, and it would have hidden any
// interaction between 0090 and the 0069 project triggers or the 0032 partial unique index.
// Applying the full chain also means a 0090 that does not parse or does not apply on top of
// everything before it is red HERE, not on the D1 apply.
//
// Every behavioural test below was MUTATION-CHECKED: the guard it names was reverted in
// src/agents/messages.ts, the suite was re-run, the named test was confirmed to fail, and the
// guard was restored. The mapping is in the PR body. A test that stays green with the guard
// removed certifies the hole instead of closing it.

import { describe, expect, it } from 'vitest'

import {
  readAgentInbox,
  leaseAgentInbox,
  ackAgentMessages,
  listDeadLetteredMessages,
  summarizeDeadLetters,
  MAX_DELIVERY_ATTEMPTS,
  DEFAULT_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
} from '../src/agents/messages'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const T0 = '2026-08-10T15:00:00.000Z'
const at = (secondsFromT0: number) => new Date(Date.parse(T0) + secondsFromT0 * 1000).toISOString()
const clock = (iso: string) => ({ now: () => iso })

function fixture() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  // Real FKs are ON in this harness: agent_inbox_fences references agents(id) and
  // members(id), so the seats have to be real rows in the real tables.
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'operator', 'test', 'active'),
      ('agent-b', 'squad-a', 'agent-b', 'Agent Beta', 'operator', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('owner', 'owner@pot.test', 'Owner', 'active', 'tenant-a');
  `)

  const env = { TENANT_SLUG: 'tenant-a', DB: harness.db } as unknown as Env

  const seed = (id: string, to = 'agent-a') => harness.sqlite.exec(`
    INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
    VALUES ('${id}', 'tenant-a', '${to}', 'sender', 'owner', 'request', 'work ${id}', '${T0}');
  `)
  const setMode = (mode: 'bearer_only' | 'signed_only', generation: number, agent = 'agent-a') => harness.sqlite.exec(`
    INSERT INTO agent_inbox_fences
      (tenant, agent_id, mode, generation, key_fingerprint, updated_by_member_id, updated_at, reason)
    VALUES ('tenant-a', '${agent}', '${mode}', ${generation},
      ${mode === 'signed_only' ? `'${'a'.repeat(64)}'` : 'NULL'}, 'owner', '${T0}', 'test transition')
    ON CONFLICT(tenant, agent_id) DO UPDATE SET
      mode=excluded.mode, generation=excluded.generation,
      key_fingerprint=excluded.key_fingerprint, updated_at=excluded.updated_at, reason=excluded.reason;
  `)
  const row = (id: string) => harness.sqlite.prepare(
    `SELECT read_at, delivery_attempts, lease_expires_at, dead_lettered_at, dead_letter_reason
       FROM agent_messages WHERE id = ?`,
  ).get(id) as {
    read_at: string | null
    delivery_attempts: number
    lease_expires_at: string | null
    dead_lettered_at: string | null
    dead_letter_reason: string | null
  }

  return { harness, env, seed, setMode, row }
}

/** Run a full competing lease in the window between the lease UPDATE being prepared+bound and
 *  it being executed. This is the only way to prove the row selection happens INSIDE the
 *  UPDATE: if it were a separate SELECT-then-UPDATE, both callers would hold the same seq. */
function raceLeaseBeforeExecution(env: Env, competitor: () => Promise<unknown>): Env {
  let fired = false
  const wrap = (statement: any, sql: string): any => ({
    bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
    first: (...args: unknown[]) => statement.first(...args),
    run: (...args: unknown[]) => statement.run(...args),
    raw: (...args: unknown[]) => statement.raw(...args),
    all: async (...args: unknown[]) => {
      if (!fired && sql.includes('SET delivery_attempts = delivery_attempts + 1')) {
        fired = true
        await competitor()
      }
      return statement.all(...args)
    },
  })
  return { ...env, DB: { ...env.DB, prepare: (sql: string) => wrap(env.DB.prepare(sql), sql) } } as Env
}

/** Fire `flip` in the window between a statement matching `marker` being prepared+bound and it
 *  being executed. The fence tests in tests/inbox-fence-sqlite.test.ts use the same shape, for
 *  the same reason: a fence checked BEFORE a statement is not a fence, because the flip can land
 *  in between. The only way to prove the predicate inside the SQL is load-bearing is to flip
 *  underneath it. Without this, deleting `AND <fence>` from the lease SQL stays green. */
function flipBeforeStatement(env: Env, marker: string, flip: () => void): Env {
  let flipped = false
  const wrap = (statement: any, sql: string): any => ({
    bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
    first: (...args: unknown[]) => statement.first(...args),
    run: (...args: unknown[]) => {
      if (!flipped && sql.includes(marker)) { flipped = true; flip() }
      return statement.run(...args)
    },
    raw: (...args: unknown[]) => statement.raw(...args),
    all: (...args: unknown[]) => {
      if (!flipped && sql.includes(marker)) { flipped = true; flip() }
      return statement.all(...args)
    },
  })
  return { ...env, DB: { ...env.DB, prepare: (sql: string) => wrap(env.DB.prepare(sql), sql) } } as Env
}

describe('inbox_lease', () => {
  it('hands rows out WITHOUT marking them read, and stamps the lease', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      f.seed('m2')
      const res = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(0)))
      expect(res).toMatchObject({ ok: true, lease_seconds: DEFAULT_LEASE_SECONDS })
      if (!res.ok) throw new Error('unreachable')
      expect(res.messages.map((m) => m.id)).toEqual(['m1', 'm2'])

      // The whole point: read_at is untouched. A crashed reader has not told the pot these
      // were handled — which is exactly what the default `inbox` consume gets wrong.
      expect(f.row('m1').read_at).toBeNull()
      expect(f.row('m2').read_at).toBeNull()
      expect(f.row('m1').lease_expires_at).toBe(at(DEFAULT_LEASE_SECONDS))
      expect(res.remaining).toBe(0)
      expect(res.dead_lettered).toBe(0)
    } finally { f.harness.close() }
  })

  it('hides a leased row from the next lease until the lease expires, then re-leases it', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      const first = await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 60 }, clock(at(0)))
      expect(first.ok && first.messages.map((m) => m.id)).toEqual(['m1'])

      // Inside the lease window: invisible.
      const during = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(59)))
      expect(during.ok && during.messages).toEqual([])
      expect(during.ok && during.remaining).toBe(0)

      // Past it: back on the queue. This is the crash-recovery property the local file spool
      // was standing in for — the reader died, nobody acked, the pot hands it out again.
      const after = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(61)))
      expect(after.ok && after.messages.map((m) => m.id)).toEqual(['m1'])
      expect(f.row('m1').read_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('re-leases exactly at the expiry boundary (<=, not <)', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 60 }, clock(at(0)))
      const boundary = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(60)))
      expect(boundary.ok && boundary.messages.map((m) => m.id)).toEqual(['m1'])
    } finally { f.harness.close() }
  })

  it('increments delivery_attempts once per hand-out', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      expect(f.row('m1').delivery_attempts).toBe(0)
      for (let n = 1; n <= 3; n += 1) {
        const res = await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10 }, clock(at(n * 20)))
        expect(res.ok && res.messages[0]?.delivery_attempts).toBe(n)
        expect(f.row('m1').delivery_attempts).toBe(n)
      }
      // A lease that returns nothing must not charge an attempt.
      await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(61)))
      expect(f.row('m1').delivery_attempts).toBe(3)
    } finally { f.harness.close() }
  })

  it('two concurrent leases cannot claim the same row', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      let competitorIds: string[] = []
      const raced = raceLeaseBeforeExecution(f.env, async () => {
        const other = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(0)))
        competitorIds = other.ok ? other.messages.map((m) => m.id) : []
      })

      const mine = await leaseAgentInbox(raced, { agent: 'agent-a' }, clock(at(0)))
      const myIds = mine.ok ? mine.messages.map((m) => m.id) : []

      // Exactly one of the two holds m1 — never both.
      expect(competitorIds).toEqual(['m1'])
      expect(myIds).toEqual([])
      expect(f.row('m1').delivery_attempts).toBe(1)
    } finally { f.harness.close() }
  })

  it('clamps lease_seconds into [1, MAX_LEASE_SECONDS]', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      const huge = await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10_000_000 }, clock(at(0)))
      expect(huge.ok && huge.lease_seconds).toBe(MAX_LEASE_SECONDS)
      expect(f.row('m1').lease_expires_at).toBe(at(MAX_LEASE_SECONDS))

      f.seed('m2')
      const tiny = await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: -5 }, clock(at(0)))
      expect(tiny.ok && tiny.lease_seconds).toBe(1)

      expect(await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: Number.NaN }, clock(at(0))))
        .toMatchObject({ ok: false, reason: 'invalid_lease' })
    } finally { f.harness.close() }
  })
})

describe('inbox_ack', () => {
  it('marks exactly the acked ids read and clears their lease', async () => {
    const f = fixture()
    try {
      f.seed('m1'); f.seed('m2')
      await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(0)))
      const res = await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['m1'] }, clock(at(5)))
      expect(res).toMatchObject({ ok: true, acked: ['m1'], already_read: [], refused: [] })

      expect(f.row('m1').read_at).toBe(at(5))
      expect(f.row('m1').lease_expires_at).toBeNull()
      // m2 was leased in the same batch but NOT acked — it is still unread, which is the
      // per-message granularity `inbox`'s whole-batch consume cannot express.
      expect(f.row('m2').read_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('is idempotent — re-acking an already-read id is success, not an error', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(0)))
      await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['m1'] }, clock(at(5)))

      const again = await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['m1'] }, clock(at(9)))
      expect(again).toMatchObject({ ok: true, acked: [], already_read: ['m1'], refused: [] })
      // And the second ack must not rewrite the original read_at.
      expect(f.row('m1').read_at).toBe(at(5))
    } finally { f.harness.close() }
  })

  it('refuses to ack a message addressed to another agent, and writes nothing', async () => {
    const f = fixture()
    try {
      f.seed('mine', 'agent-a')
      f.seed('theirs', 'agent-b')
      const res = await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['mine', 'theirs'] }, clock(at(5)))
      expect(res).toMatchObject({ ok: true, acked: ['mine'], refused: ['theirs'] })
      expect(f.row('theirs').read_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('does not distinguish a stranger\'s message from a nonexistent one', async () => {
    const f = fixture()
    try {
      f.seed('theirs', 'agent-b')
      const res = await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['theirs', 'no-such-id'] }, clock(at(5)))
      // Same bucket for both: splitting them would make ack a tenant-wide message-id oracle.
      expect(res).toMatchObject({ ok: true, acked: [], already_read: [], refused: ['theirs', 'no-such-id'] })
    } finally { f.harness.close() }
  })

  it('rejects malformed id lists', async () => {
    const f = fixture()
    try {
      expect(await ackAgentMessages(f.env, { agent: 'agent-a', ids: [] })).toMatchObject({ ok: false, reason: 'invalid_ids' })
      expect(await ackAgentMessages(f.env, { agent: 'agent-a', ids: [''] })).toMatchObject({ ok: false, reason: 'invalid_ids' })
      expect(await ackAgentMessages(f.env, {
        agent: 'agent-a', ids: Array.from({ length: 101 }, (_, i) => `m${i}`),
      })).toMatchObject({ ok: false, reason: 'invalid_ids' })
    } finally { f.harness.close() }
  })

  it('de-duplicates repeated ids within one call', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      const res = await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['m1', 'm1'] }, clock(at(5)))
      expect(res).toMatchObject({ ok: true, acked: ['m1'], already_read: [], refused: [] })
    } finally { f.harness.close() }
  })
})

describe('dead-letter', () => {
  it('parks a message after MAX_DELIVERY_ATTEMPTS hand-outs and stops leasing it', async () => {
    const f = fixture()
    try {
      f.seed('poison')
      for (let n = 1; n <= MAX_DELIVERY_ATTEMPTS; n += 1) {
        const res = await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10 }, clock(at(n * 20)))
        expect(res.ok && res.messages.map((m) => m.id)).toEqual(['poison'])
      }
      expect(f.row('poison').delivery_attempts).toBe(MAX_DELIVERY_ATTEMPTS)
      expect(f.row('poison').dead_lettered_at).toBeNull()

      // The next lease dead-letters instead of handing it out a sixth time.
      const after = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(1000)))
      expect(after.ok && after.messages).toEqual([])
      expect(after.ok && after.dead_lettered).toBe(1)
      expect(f.row('poison').dead_lettered_at).toBe(at(1000))
      expect(f.row('poison').dead_letter_reason).toBe(`max_delivery_attempts_exceeded:${MAX_DELIVERY_ATTEMPTS}`)
      expect(f.row('poison').delivery_attempts).toBe(MAX_DELIVERY_ATTEMPTS)

      // Permanently excluded: not returned by any later lease.
      const later = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(9999)))
      expect(later.ok && later.messages).toEqual([])
    } finally { f.harness.close() }
  })

  it('unblocks the head of the line — the queue behind the poison message drains', async () => {
    const f = fixture()
    try {
      // The 2026-08-10 shape: one oversized message at the head, five behind it, and a
      // reader that keeps timing out on the first. Under `inbox` the five never surface.
      f.seed('poison')
      const behind = ['q1', 'q2', 'q3', 'q4', 'q5']
      for (const id of behind) f.seed(id)

      for (let n = 1; n <= MAX_DELIVERY_ATTEMPTS; n += 1) {
        const res = await leaseAgentInbox(f.env, { agent: 'agent-a', limit: 1, leaseSeconds: 10 }, clock(at(n * 20)))
        expect(res.ok && res.messages.map((m) => m.id)).toEqual(['poison'])
      }

      const drained = await leaseAgentInbox(f.env, { agent: 'agent-a', limit: 10 }, clock(at(1000)))
      expect(drained.ok && drained.messages.map((m) => m.id)).toEqual(behind)
      expect(drained.ok && drained.dead_lettered).toBe(1)
    } finally { f.harness.close() }
  })

  it('does not dead-letter a message whose lease is still live', async () => {
    const f = fixture()
    try {
      f.seed('poison')
      for (let n = 1; n <= MAX_DELIVERY_ATTEMPTS; n += 1) {
        await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10 }, clock(at(n * 20)))
      }
      // Attempts are at the threshold but the last lease has NOT expired: a reader may still
      // be working on it, so parking it here would be wrong.
      const early = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(MAX_DELIVERY_ATTEMPTS * 20 + 5)))
      expect(early.ok && early.dead_lettered).toBe(0)
      expect(f.row('poison').dead_lettered_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('never dead-letters a message the caller acked in time', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      for (let n = 1; n <= MAX_DELIVERY_ATTEMPTS; n += 1) {
        await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10 }, clock(at(n * 20)))
      }
      await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['m1'] }, clock(at(500)))
      const after = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(1000)))
      expect(after.ok && after.dead_lettered).toBe(0)
      expect(f.row('m1').dead_lettered_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('makes the stuck message a queryable fact, self-scoped and pot-wide', async () => {
    const f = fixture()
    try {
      f.seed('poison')
      for (let n = 1; n <= MAX_DELIVERY_ATTEMPTS + 1; n += 1) {
        await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10 }, clock(at(n * 20)))
      }

      const self = await listDeadLetteredMessages(f.env, { agent: 'agent-a' })
      expect(self.ok && self.total).toBe(1)
      expect(self.ok && self.messages[0]).toMatchObject({
        id: 'poison',
        delivery_attempts: MAX_DELIVERY_ATTEMPTS,
        dead_letter_reason: `max_delivery_attempts_exceeded:${MAX_DELIVERY_ATTEMPTS}`,
      })

      const pot = await summarizeDeadLetters(f.env)
      expect(pot.ok && pot.agents).toEqual([{
        agent_id: 'agent-a',
        dead_lettered: 1,
        oldest_dead_lettered_at: at((MAX_DELIVERY_ATTEMPTS + 1) * 20),
        max_delivery_attempts: MAX_DELIVERY_ATTEMPTS,
      }])
      // Metadata only — the pot-wide roll-up must not carry message bodies.
      expect(JSON.stringify(pot)).not.toContain('work poison')
    } finally { f.harness.close() }
  })

  it('an acked dead letter leaves the listing', async () => {
    const f = fixture()
    try {
      f.seed('poison')
      for (let n = 1; n <= MAX_DELIVERY_ATTEMPTS + 1; n += 1) {
        await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10 }, clock(at(n * 20)))
      }
      expect((await listDeadLetteredMessages(f.env, { agent: 'agent-a' })).ok).toBe(true)
      await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['poison'] }, clock(at(5000)))
      const after = await listDeadLetteredMessages(f.env, { agent: 'agent-a' })
      expect(after.ok && after.total).toBe(0)
    } finally { f.harness.close() }
  })
})

describe('agent_inbox_fences is unchanged and covers the new surfaces', () => {
  it('still refuses the bearer `inbox` consume under signed_only, and still consumes under bearer_only', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      f.setMode('signed_only', 1)
      expect(await readAgentInbox(f.env, { agent: 'agent-a' })).toMatchObject({ ok: false, reason: 'consumer_fenced' })
      expect(f.row('m1').read_at).toBeNull()

      f.setMode('bearer_only', 2)
      const ok = await readAgentInbox(f.env, { agent: 'agent-a' })
      expect(ok).toMatchObject({ ok: true })
      expect(f.row('m1').read_at).not.toBeNull()
    } finally { f.harness.close() }
  })

  it('the old `inbox` consume does not touch any lease column', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      await readAgentInbox(f.env, { agent: 'agent-a' })
      const r = f.row('m1')
      expect(r.read_at).not.toBeNull()
      expect(r.delivery_attempts).toBe(0)
      expect(r.lease_expires_at).toBeNull()
      expect(r.dead_lettered_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('refuses lease under signed_only and writes nothing', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      f.setMode('signed_only', 1)
      expect(await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(0))))
        .toMatchObject({ ok: false, reason: 'consumer_fenced' })
      const r = f.row('m1')
      expect(r.delivery_attempts).toBe(0)
      expect(r.lease_expires_at).toBeNull()
      expect(r.dead_lettered_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('refuses ack under signed_only — otherwise a bearer token could destroy the signed consumer\'s inbox', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      f.setMode('signed_only', 1)
      expect(await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['m1'] }, clock(at(5))))
        .toMatchObject({ ok: false, reason: 'consumer_fenced' })
      expect(f.row('m1').read_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('refuses the self dead-letter listing under signed_only (it returns bodies)', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      f.setMode('signed_only', 1)
      expect(await listDeadLetteredMessages(f.env, { agent: 'agent-a' }))
        .toMatchObject({ ok: false, reason: 'consumer_fenced' })
    } finally { f.harness.close() }
  })

  it('linearizes a bearer-to-signed flip INSIDE the lease statement', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      // The flip lands after the pre-check has already passed. Only the fence predicate
      // carried inside the UPDATE can stop the claim now.
      const raced = flipBeforeStatement(f.env, 'SET delivery_attempts = delivery_attempts + 1', () => f.setMode('signed_only', 1))
      expect(await leaseAgentInbox(raced, { agent: 'agent-a' }, clock(at(0))))
        .toMatchObject({ ok: false, reason: 'consumer_fenced' })
      const r = f.row('m1')
      expect(r.delivery_attempts).toBe(0)
      expect(r.lease_expires_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('linearizes a bearer-to-signed flip INSIDE the dead-letter sweep', async () => {
    const f = fixture()
    try {
      f.seed('poison')
      for (let n = 1; n <= MAX_DELIVERY_ATTEMPTS; n += 1) {
        await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10 }, clock(at(n * 20)))
      }
      const raced = flipBeforeStatement(f.env, "SET dead_lettered_at", () => f.setMode('signed_only', 1))
      expect(await leaseAgentInbox(raced, { agent: 'agent-a' }, clock(at(1000))))
        .toMatchObject({ ok: false, reason: 'consumer_fenced' })
      expect(f.row('poison').dead_lettered_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('linearizes a bearer-to-signed flip INSIDE the ack statement', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(0)))
      const raced = flipBeforeStatement(f.env, 'SET read_at = ?3, lease_expires_at = NULL', () => f.setMode('signed_only', 1))
      expect(await ackAgentMessages(raced, { agent: 'agent-a', ids: ['m1'] }, clock(at(5))))
        .toMatchObject({ ok: false, reason: 'consumer_fenced' })
      expect(f.row('m1').read_at).toBeNull()
    } finally { f.harness.close() }
  })

  it('linearizes a bearer-to-signed flip INSIDE the dead-letter listing', async () => {
    const f = fixture()
    try {
      f.seed('poison')
      for (let n = 1; n <= MAX_DELIVERY_ATTEMPTS + 1; n += 1) {
        await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10 }, clock(at(n * 20)))
      }
      const raced = flipBeforeStatement(f.env, 'dead_lettered_at IS NOT NULL', () => f.setMode('signed_only', 1))
      expect(await listDeadLetteredMessages(raced, { agent: 'agent-a' }))
        .toMatchObject({ ok: false, reason: 'consumer_fenced' })
    } finally { f.harness.close() }
  })

  it('a fenced-out bearer cannot dead-letter an inbox it may not read', async () => {
    const f = fixture()
    try {
      f.seed('poison')
      for (let n = 1; n <= MAX_DELIVERY_ATTEMPTS; n += 1) {
        await leaseAgentInbox(f.env, { agent: 'agent-a', leaseSeconds: 10 }, clock(at(n * 20)))
      }
      f.setMode('signed_only', 1)
      expect(await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(at(1000))))
        .toMatchObject({ ok: false, reason: 'consumer_fenced' })
      expect(f.row('poison').dead_lettered_at).toBeNull()
    } finally { f.harness.close() }
  })
})

describe('tenant and recipient scoping', () => {
  it('never leases another tenant\'s or another agent\'s messages', async () => {
    const f = fixture()
    try {
      f.seed('mine', 'agent-a')
      f.seed('theirs', 'agent-b')
      f.harness.sqlite.exec(`
        INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
        VALUES ('other-tenant', 'tenant-b', 'agent-a', 'sender', 'owner', 'request', 'x', '${T0}');
      `)
      const res = await leaseAgentInbox(f.env, { agent: 'agent-a', limit: 100 }, clock(at(0)))
      expect(res.ok && res.messages.map((m) => m.id)).toEqual(['mine'])
    } finally { f.harness.close() }
  })

  it('fails closed with no tenant', async () => {
    const f = fixture()
    try {
      const noTenant = { ...f.env, TENANT_SLUG: '' } as unknown as Env
      expect(await leaseAgentInbox(noTenant, { agent: 'agent-a' })).toMatchObject({ ok: false, reason: 'no_tenant' })
      expect(await ackAgentMessages(noTenant, { agent: 'agent-a', ids: ['m1'] })).toMatchObject({ ok: false, reason: 'no_tenant' })
    } finally { f.harness.close() }
  })
})
