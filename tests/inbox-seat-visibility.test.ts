// tests/inbox-seat-visibility.test.ts — seat-targeted inbox visibility without cross-seat drain.
//
// 0120 isolates seat mailboxes: an un-scoped read consumes only broadcasts. Seat-targeted
// backlog must still be visible via seats/unread_total; draining across seats requires allSeats.
// Schema from the full migration chain (#684 ratchet).

import { describe, expect, it } from 'vitest'

import {
  readAgentInbox,
  readVerifiedSignedAgentInbox,
  leaseAgentInbox,
} from '../src/agents/messages'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const T0 = '2026-09-01T00:00:00.000Z'
const clock = (iso: string) => ({ now: () => iso })

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

  const seed = (
    id: string,
    body: string,
    targetSeat: string | null = null,
    createdAt = T0,
  ) => harness.sqlite.exec(`
    INSERT INTO agent_messages
      (id, tenant, to_agent, from_agent, from_member, kind, body, created_at, target_seat)
    VALUES ('${id}', 'tenant-a', 'agent-a', 'sender', 'owner', 'message', '${body}', '${createdAt}', ${targetSeat === null ? 'NULL' : `'${targetSeat}'`});
  `)

  const setMode = (mode: 'bearer_only' | 'signed_only', generation: number) => harness.sqlite.exec(`
    INSERT INTO agent_inbox_fences
      (tenant, agent_id, mode, generation, key_fingerprint, updated_by_member_id, updated_at, reason)
    VALUES ('tenant-a', 'agent-a', '${mode}', ${generation},
      ${mode === 'signed_only' ? `'${'a'.repeat(64)}'` : 'NULL'}, 'owner', '${T0}', 'test transition')
    ON CONFLICT(tenant, agent_id) DO UPDATE SET
      mode=excluded.mode, generation=excluded.generation,
      key_fingerprint=excluded.key_fingerprint, updated_at=excluded.updated_at, reason=excluded.reason;
  `)

  const readAt = (id: string) => (harness.sqlite.prepare(
    `SELECT read_at FROM agent_messages WHERE id = ?`,
  ).get(id) as { read_at: string | null }).read_at

  return { harness, env, seed, setMode, readAt }
}

function seatCounts(seats: Array<{ seat: string | null; unread: number }> | undefined) {
  const map = new Map<string | null, number>()
  for (const row of seats ?? []) map.set(row.seat, row.unread)
  return map
}

describe('inbox seat visibility', () => {
  it('no-seat read returns only broadcasts and does not consume seat-targeted rows', async () => {
    const f = fixture()
    try {
      f.seed('bcast', 'broadcast', null)
      f.seed('targeted', 'wake me', 'cursor-cloud-vm')
      const res = await readAgentInbox(f.env, { agent: 'agent-a' })
      expect(res).toMatchObject({ ok: true })
      if (!res.ok) throw new Error('unreachable')
      expect(res.messages).toHaveLength(1)
      expect(res.messages[0].body).toBe('broadcast')
      expect(res.messages[0].target_seat).toBeNull()
      expect(f.readAt('targeted')).toBeNull()
      expect(res.unread_total).toBe(1)
      expect(seatCounts(res.seats).get('cursor-cloud-vm')).toBe(1)
      expect(res.remaining).toBe(0)
    } finally { f.harness.close() }
  })

  it('no-seat peek surfaces seat backlog in seats/unread_total without consuming it', async () => {
    const f = fixture()
    try {
      f.seed('m1', 'broadcast', null, '2026-09-01T00:00:01.000Z')
      f.seed('m2', 'seat-a', 'seat-alpha', '2026-09-01T00:00:02.000Z')
      f.seed('m3', 'seat-b', 'seat-beta', '2026-09-01T00:00:03.000Z')
      const res = await readAgentInbox(f.env, { agent: 'agent-a', peek: true, limit: 10 })
      expect(res.ok && res.messages.map((m) => m.id)).toEqual(['m1'])
      expect(res.unread_total).toBe(3)
      const counts = seatCounts(res.seats)
      expect(counts.get(null)).toBe(1)
      expect(counts.get('seat-alpha')).toBe(1)
      expect(counts.get('seat-beta')).toBe(1)
      expect(res.remaining).toBe(1)
    } finally { f.harness.close() }
  })

  it('seat-scoped read returns that seat plus broadcast, not sibling seats', async () => {
    const f = fixture()
    try {
      f.seed('bcast', 'broadcast', null)
      f.seed('alpha', 'for-alpha', 'seat-alpha')
      f.seed('beta', 'for-beta', 'seat-beta')
      const res = await readAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-alpha', peek: true })
      expect(res.ok && res.messages.map((m) => m.id).sort()).toEqual(['alpha', 'bcast'])
      expect(res.unread_total).toBe(3)
    } finally { f.harness.close() }
  })

  it('allSeats drains every unread row across seats', async () => {
    const f = fixture()
    try {
      f.seed('m1', 'broadcast', null, '2026-09-01T00:00:01.000Z')
      f.seed('m2', 'seat-a', 'seat-alpha', '2026-09-01T00:00:02.000Z')
      f.seed('m3', 'seat-b', 'seat-beta', '2026-09-01T00:00:03.000Z')
      const res = await readAgentInbox(f.env, { agent: 'agent-a', allSeats: true, limit: 10 })
      expect(res.ok && res.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
      expect(res.unread_total).toBe(0)
      expect(res.remaining).toBe(0)
      expect(f.readAt('m1')).not.toBeNull()
      expect(f.readAt('m2')).not.toBeNull()
      expect(f.readAt('m3')).not.toBeNull()
    } finally { f.harness.close() }
  })

  it('allSeats and seat together are refused', async () => {
    const f = fixture()
    try {
      f.seed('m1', 'one', 'seat-a')
      expect(await readAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-a', allSeats: true }))
        .toMatchObject({ ok: false, reason: 'invalid_seat' })
      expect(await leaseAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-a', allSeats: true }, clock(T0)))
        .toMatchObject({ ok: false, reason: 'invalid_seat' })
    } finally { f.harness.close() }
  })

  it('consume marks only the partition-scoped rows read', async () => {
    const f = fixture()
    try {
      f.seed('m1', 'one', 'seat-a')
      f.seed('m2', 'two', null)
      const first = await readAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-a', limit: 1 })
      expect(first.ok && first.messages.map((m) => m.id)).toEqual(['m1'])
      expect(f.readAt('m1')).not.toBeNull()
      expect(f.readAt('m2')).toBeNull()

      const second = await readAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-a' })
      expect(second.ok && second.messages.map((m) => m.id)).toEqual(['m2'])
      expect(f.readAt('m2')).not.toBeNull()

      const third = await readAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-a' })
      expect(third.ok && third.messages).toEqual([])
    } finally { f.harness.close() }
  })

  it('peek path surfaces seat-targeted rows only with seat or allSeats', async () => {
    const f = fixture()
    try {
      f.seed('targeted', 'peek me', 'seat-x')
      const noSeat = await readAgentInbox(f.env, { agent: 'agent-a', peek: true })
      expect(noSeat.ok && noSeat.messages).toEqual([])
      expect(noSeat.unread_total).toBe(1)

      const withSeat = await readAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-x', peek: true })
      expect(withSeat.ok && withSeat.messages[0]?.body).toBe('peek me')
      expect(f.readAt('targeted')).toBeNull()

      const consume = await readAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-x' })
      expect(consume.ok && consume.messages[0]?.body).toBe('peek me')
      expect(f.readAt('targeted')).not.toBeNull()
    } finally { f.harness.close() }
  })

  it('lease path without seat returns only broadcast rows', async () => {
    const f = fixture()
    try {
      f.seed('bcast', 'broadcast', null)
      f.seed('seat', 'leased', 'seat-lease')
      const res = await leaseAgentInbox(f.env, { agent: 'agent-a' }, clock(T0))
      expect(res.ok && res.messages.map((m) => m.id)).toEqual(['bcast'])
      expect(f.readAt('bcast')).toBeNull()
      expect(f.readAt('seat')).toBeNull()
    } finally { f.harness.close() }
  })

  it('lease path with allSeats returns seat-targeted and broadcast rows', async () => {
    const f = fixture()
    try {
      f.seed('bcast', 'broadcast', null)
      f.seed('seat', 'leased', 'seat-lease')
      const res = await leaseAgentInbox(f.env, { agent: 'agent-a', allSeats: true }, clock(T0))
      expect(res.ok && res.messages.map((m) => m.id).sort()).toEqual(['bcast', 'seat'])
      expect(f.readAt('bcast')).toBeNull()
      expect(f.readAt('seat')).toBeNull()
    } finally { f.harness.close() }
  })

  it('lease path with seat partitions sibling seats', async () => {
    const f = fixture()
    try {
      f.seed('alpha', 'alpha body', 'seat-alpha')
      f.seed('beta', 'beta body', 'seat-beta')
      const alpha = await leaseAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-alpha' }, clock(T0))
      expect(alpha.ok && alpha.messages.map((m) => m.id)).toEqual(['alpha'])

      const beta = await leaseAgentInbox(f.env, { agent: 'agent-a', seat: 'seat-beta' }, clock(T0))
      expect(beta.ok && beta.messages.map((m) => m.id)).toEqual(['beta'])
    } finally { f.harness.close() }
  })

  it('reports per-seat unread breakdown including the broadcast bucket', async () => {
    const f = fixture()
    try {
      f.seed('b1', 'b1', null)
      f.seed('a1', 'a1', 'seat-alpha')
      f.seed('a2', 'a2', 'seat-alpha')
      f.seed('b2', 'b2', 'seat-beta')
      const res = await readAgentInbox(f.env, { agent: 'agent-a', peek: true })
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      const counts = seatCounts(res.seats)
      expect(counts.get(null)).toBe(1)
      expect(counts.get('seat-alpha')).toBe(2)
      expect(counts.get('seat-beta')).toBe(1)
      expect(res.unread_total).toBe(4)
      expect(res.remaining).toBe(1)
    } finally { f.harness.close() }
  })

  it('signed-reader fence still refuses bearer reader', async () => {
    const f = fixture()
    try {
      f.seed('m1', 'secret', 'seat-signed')
      f.setMode('signed_only', 1)
      expect(await readAgentInbox(f.env, { agent: 'agent-a' })).toMatchObject({
        ok: false,
        reason: 'consumer_fenced',
      })
      expect(f.readAt('m1')).toBeNull()

      const signed = await readVerifiedSignedAgentInbox(f.env, {
        agent: 'agent-a',
        keyFingerprint: 'a'.repeat(64),
        seat: 'seat-signed',
        peek: true,
      })
      expect(signed).toMatchObject({ ok: true, messages: [{ id: 'm1' }], unread_total: 1 })
    } finally { f.harness.close() }
  })
})
