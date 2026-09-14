import { describe, expect, it, vi } from 'vitest'

import {
  ackAgentInboxLeaseAttempt,
  ackAgentMessages,
  leaseAgentInbox,
  reconcileAgentInboxLeaseAttempt,
} from '../src/agents/messages'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const T0 = '2026-08-10T15:00:00.000Z'
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString()
const clock = (seconds: number) => ({ now: () => at(seconds) })
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UNKNOWN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function fixture() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'operator', 'test', 'active'),
      ('agent-b', 'squad-a', 'agent-b', 'Agent B', 'operator', 'test', 'active');
  `)
  const env = { TENANT_SLUG: 'tenant-a', DB: harness.db } as unknown as Env
  const seed = (id: string, seat: string | null = null) => harness.sqlite.prepare(`
    INSERT INTO agent_messages
      (id, tenant, to_agent, from_agent, from_member, kind, body, created_at, target_seat)
    VALUES (?, 'tenant-a', 'agent-a', 'sender', 'sender-member', 'request', ?, ?, ?)
  `).run(id, `work ${id}`, T0, seat)

  const installToken = (values: {
    id?: string
    agent?: string
    tenant?: string
    label?: string
    revokedAt?: string | null
    expiresAt?: string | null
  } = {}) => {
    const id = values.id ?? 'tok-a'
    const agent = values.agent ?? 'agent-a'
    const tenant = values.tenant ?? 'tenant-a'
    const member = `member-${id}`
    harness.sqlite.prepare(`
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES (?, ?, ?, 'active', ?)
    `).run(member, `${member}@pot.test`, member, tenant)
    harness.sqlite.prepare(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(tenant, agent, member, T0)
    harness.sqlite.prepare(`
      INSERT INTO member_tokens
        (id, member_id, tenant, token_hash, agent_id, label, channel, created_at, revoked_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'workspace', ?, ?, ?)
    `).run(id, member, tenant, id.padEnd(64, '0').slice(0, 64), agent, values.label ?? '', T0,
      values.revokedAt ?? null, values.expiresAt ?? null)
    return { id, member, agent, tenant }
  }

  const auth = (token: ReturnType<typeof installToken>, boundAgent = token.agent): AuthContext => ({
    userId: token.member,
    memberId: token.member,
    email: null,
    tenant: token.tenant,
    role: 'member',
    channel: 'workspace',
    boundAgentId: boundAgent,
    tokenId: token.id,
    capabilities: [],
  })

  return { harness, env, seed, installToken, auth }
}

describe('authoritative attempt scope proof and ACK', () => {
  it('echoes strict current scope through status, lease, reconcile, and attempt ACK', async () => {
    const f = fixture()
    try {
      const token = f.installToken({ label: 'seat-a' })
      f.seed('seat-message', 'seat-a')
      const actor = f.auth(token)
      const scope = { tenant: 'tenant-a', agent_id: 'agent-a', effective_inbox_seat: 'seat-a' }

      const strictStatus = await invokeTool(actor, f.env, 'inbox_consumer_status', { strict_scope: true })
      expect(strictStatus.ok && strictStatus.result).toEqual({
        strict_scope: true,
        ...scope,
        mode: 'bearer_only',
        generation: 0,
        key_matches: true,
        key_fingerprint: null,
        active_key_present: false,
        updated_at: null,
      })
      const legacy = await invokeTool(actor, f.env, 'inbox_consumer_status', {})
      expect(legacy).toMatchObject({ ok: true, result: { agent_id: 'agent-a', mode: 'bearer_only' } })
      expect(legacy.ok && Object.hasOwn(legacy.result as object, 'strict_scope')).toBe(false)

      expect(await invokeTool(actor, f.env, 'inbox_lease', {
        attempt_id: A, limit: 1, lease_seconds: 30,
      })).toMatchObject({ ok: true, result: { ...scope, attempt_id: A, state: 'leased' } })
      expect(await invokeTool(actor, f.env, 'inbox_lease_reconcile', { attempt_id: A }))
        .toMatchObject({ ok: true, result: { ...scope, attempt_id: A, state: 'leased' } })
      const acked = await invokeTool(actor, f.env, 'inbox_lease_ack', { attempt_id: A })
      expect(acked).toMatchObject({
        ok: true,
        result: { ...scope, attempt_id: A, state: 'acked', consumed: true },
      })
      expect(JSON.stringify(acked)).not.toContain('work seat-message')
      expect(JSON.stringify(acked)).not.toContain('messages')
      expect(f.harness.sqlite.prepare(
        "SELECT lease_attempt_id FROM agent_messages WHERE id='seat-message'",
      ).get()).toEqual({ lease_attempt_id: null })
      expect(await invokeTool(actor, f.env, 'inbox_lease_ack', {
        attempt_id: A, message_id: 'seat-message',
      })).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    } finally { f.harness.close() }
  })

  it('treats a live token with an empty label as the broadcast partition', async () => {
    const f = fixture()
    try {
      const token = f.installToken({ label: '' })
      f.seed('broadcast')
      const actor = f.auth(token)
      expect(await invokeTool(actor, f.env, 'inbox_consumer_status', { strict_scope: true }))
        .toMatchObject({ ok: true, result: { strict_scope: true, effective_inbox_seat: null } })
      expect(await invokeTool(actor, f.env, 'inbox_lease', {
        attempt_id: A, limit: 1,
      })).toMatchObject({
        ok: true,
        result: { tenant: 'tenant-a', agent_id: 'agent-a', effective_inbox_seat: null, state: 'leased' },
      })
    } finally { f.harness.close() }
  })

  it('marks stale attempt A expired without consuming or altering newer lease B', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      await leaseAgentInbox(f.env, {
        agent: 'agent-a', limit: 1, leaseSeconds: 1, attemptId: A,
      }, clock(0))
      await leaseAgentInbox(f.env, {
        agent: 'agent-a', limit: 1, leaseSeconds: 30, attemptId: B,
      }, clock(2))

      expect(await ackAgentInboxLeaseAttempt(f.env, {
        agent: 'agent-a', attemptId: A,
      }, clock(3))).toMatchObject({ ok: true, state: 'expired', consumed: false })
      expect(f.harness.sqlite.prepare(
        "SELECT read_at, delivery_attempts, lease_expires_at FROM agent_messages WHERE id='m1'",
      ).get()).toEqual({ read_at: null, delivery_attempts: 2, lease_expires_at: at(32) })
      expect(await reconcileAgentInboxLeaseAttempt(f.env, {
        agent: 'agent-a', attemptId: B,
      }, clock(3))).toMatchObject({ ok: true, state: 'leased', messages: [{ id: 'm1', delivery_attempts: 2 }] })

      expect(await ackAgentInboxLeaseAttempt(f.env, {
        agent: 'agent-a', attemptId: B,
      }, clock(3))).toMatchObject({ ok: true, state: 'acked', consumed: true })
    } finally { f.harness.close() }
  })

  it('supports both generic-ACK-first and attempt-ACK-first race orders idempotently', async () => {
    const first = fixture()
    try {
      first.seed('m1')
      await leaseAgentInbox(first.env, {
        agent: 'agent-a', limit: 1, leaseSeconds: 30, attemptId: A,
      }, clock(0))
      await ackAgentMessages(first.env, { agent: 'agent-a', ids: ['m1'] }, clock(1))
      expect(await ackAgentInboxLeaseAttempt(first.env, {
        agent: 'agent-a', attemptId: A,
      }, clock(2))).toMatchObject({ ok: true, state: 'acked', consumed: true })
      expect(await ackAgentInboxLeaseAttempt(first.env, {
        agent: 'agent-a', attemptId: A,
      }, clock(3))).toMatchObject({ ok: true, state: 'acked', consumed: true })
    } finally { first.harness.close() }

    const second = fixture()
    try {
      second.seed('m1')
      await leaseAgentInbox(second.env, {
        agent: 'agent-a', limit: 1, leaseSeconds: 30, attemptId: A,
      }, clock(0))
      expect(await ackAgentInboxLeaseAttempt(second.env, {
        agent: 'agent-a', attemptId: A,
      }, clock(1))).toMatchObject({ ok: true, state: 'acked', consumed: true })
      expect(await ackAgentMessages(second.env, { agent: 'agent-a', ids: ['m1'] }, clock(2)))
        .toMatchObject({ ok: true, already_read: ['m1'] })
    } finally { second.harness.close() }
  })

  it('keeps same-id ACKs isolated across broadcast and targeted seat partitions', async () => {
    const f = fixture()
    try {
      f.seed('broadcast')
      f.seed('seat-b-message', 'seat-b')
      await leaseAgentInbox(f.env, {
        agent: 'agent-a', seat: 'seat-a', limit: 1, leaseSeconds: 30, attemptId: A,
      }, clock(0))
      await leaseAgentInbox(f.env, {
        agent: 'agent-a', seat: 'seat-b', limit: 1, leaseSeconds: 30, attemptId: A,
      }, clock(0))

      expect(await ackAgentInboxLeaseAttempt(f.env, {
        agent: 'agent-a', seat: 'seat-a', attemptId: A,
      }, clock(1))).toMatchObject({ ok: true, state: 'acked', consumed: true })
      expect(f.harness.sqlite.prepare(
        'SELECT id, read_at FROM agent_messages ORDER BY seq',
      ).all()).toEqual([
        { id: 'broadcast', read_at: at(1) },
        { id: 'seat-b-message', read_at: null },
      ])
      expect(await ackAgentInboxLeaseAttempt(f.env, {
        agent: 'agent-a', seat: 'seat-b', attemptId: A,
      }, clock(1))).toMatchObject({ ok: true, state: 'acked', consumed: true })
    } finally { f.harness.close() }
  })

  it('rolls the message read back when the consumer fence flips inside the ACK batch', async () => {
    const f = fixture()
    try {
      const token = f.installToken()
      f.seed('m1')
      f.harness.sqlite.prepare(`
        INSERT INTO agent_inbox_fences
          (tenant, agent_id, mode, generation, key_fingerprint, updated_by_member_id, updated_at, reason)
        VALUES ('tenant-a', 'agent-a', 'bearer_only', 1, NULL, ?, ?, 'test')
      `).run(token.member, T0)
      await leaseAgentInbox(f.env, {
        agent: 'agent-a', limit: 1, leaseSeconds: 30, attemptId: A,
      }, clock(0))
      f.harness.sqlite.exec(`
        CREATE TRIGGER flip_fence_during_attempt_ack
        AFTER UPDATE OF read_at ON agent_messages
        WHEN NEW.read_at IS NOT NULL
        BEGIN
          UPDATE agent_inbox_fences
             SET mode='signed_only', generation=2, key_fingerprint='${'f'.repeat(64)}'
           WHERE tenant=NEW.tenant AND agent_id=NEW.to_agent;
        END;
      `)

      expect(await ackAgentInboxLeaseAttempt(f.env, {
        agent: 'agent-a', attemptId: A,
      }, clock(1))).toMatchObject({ ok: false, reason: 'consumer_fenced' })
      expect(f.harness.sqlite.prepare(
        "SELECT read_at, lease_expires_at FROM agent_messages WHERE id='m1'",
      ).get()).toEqual({ read_at: null, lease_expires_at: at(30) })
      expect(f.harness.sqlite.prepare(
        'SELECT state, message_id FROM agent_inbox_lease_attempts WHERE attempt_id=?',
      ).get(A)).toEqual({ state: 'leased', message_id: 'm1' })
    } finally { f.harness.close() }
  })

  it('never rolls back a same-time legacy inbox consume when attempt ACK is fenced', async () => {
    const f = fixture()
    vi.useFakeTimers()
    try {
      const token = f.installToken()
      const actor = f.auth(token)
      f.seed('m1')
      vi.setSystemTime(new Date(at(0)))
      expect(await invokeTool(actor, f.env, 'inbox_lease', {
        attempt_id: A, limit: 1, lease_seconds: 30,
      })).toMatchObject({ ok: true, result: { state: 'leased', messages: [{ id: 'm1' }] } })

      vi.setSystemTime(new Date(at(1)))
      expect(await invokeTool(actor, f.env, 'inbox', {})).toMatchObject({
        ok: true, result: { consumed: true, messages: [{ id: 'm1' }] },
      })
      expect(f.harness.sqlite.prepare(
        "SELECT read_at, lease_expires_at FROM agent_messages WHERE id='m1'",
      ).get()).toEqual({ read_at: at(1), lease_expires_at: at(30) })

      f.harness.sqlite.prepare(`
        INSERT INTO agent_inbox_fences
          (tenant, agent_id, mode, generation, key_fingerprint, updated_by_member_id, updated_at, reason)
        VALUES ('tenant-a', 'agent-a', 'signed_only', 1, ?, ?, ?, 'test')
      `).run('f'.repeat(64), token.member, at(1))
      expect(await invokeTool(actor, f.env, 'inbox_lease_ack', { attempt_id: A }))
        .toMatchObject({ ok: false, status: 409, error: 'consumer_fenced' })

      expect(f.harness.sqlite.prepare(
        "SELECT read_at, lease_expires_at FROM agent_messages WHERE id='m1'",
      ).get()).toEqual({ read_at: at(1), lease_expires_at: at(30) })
      expect(f.harness.sqlite.prepare(
        'SELECT state, message_id FROM agent_inbox_lease_attempts WHERE attempt_id=?',
      ).get(A)).toEqual({ state: 'leased', message_id: 'm1' })
    } finally {
      vi.useRealTimers()
      f.harness.close()
    }
  })

  it('does not read anything for unknown, empty, cancelled, or expired attempts', async () => {
    const f = fixture()
    try {
      f.seed('m1')
      const unknown = await ackAgentInboxLeaseAttempt(f.env, {
        agent: 'agent-a', attemptId: UNKNOWN,
      }, clock(0))
      expect(unknown, JSON.stringify(unknown)).toMatchObject({ ok: true, state: 'cancelled', consumed: false })
      expect(await leaseAgentInbox(f.env, {
        agent: 'agent-a', limit: 1, leaseSeconds: 1, attemptId: A,
      }, clock(0))).toMatchObject({ ok: true, state: 'leased' })
      expect(await ackAgentInboxLeaseAttempt(f.env, {
        agent: 'agent-a', attemptId: A,
      }, clock(2))).toMatchObject({ ok: true, state: 'expired', consumed: false })
      expect(f.harness.sqlite.prepare("SELECT read_at FROM agent_messages WHERE id='m1'").get())
        .toEqual({ read_at: null })

      await ackAgentMessages(f.env, { agent: 'agent-a', ids: ['m1'] }, clock(3))
      expect(await leaseAgentInbox(f.env, {
        agent: 'agent-a', limit: 1, attemptId: B,
      }, clock(4))).toMatchObject({ ok: true, state: 'empty' })
      expect(await ackAgentInboxLeaseAttempt(f.env, {
        agent: 'agent-a', attemptId: B,
      }, clock(5))).toMatchObject({ ok: true, state: 'empty', consumed: false })
    } finally { f.harness.close() }
  })

  it('fails strict scope proof for missing, revoked, expired, tenant, and agent mismatches before writes', async () => {
    const scenarios: Array<(f: ReturnType<typeof fixture>) => { auth: AuthContext; env: Env }> = [
      (f) => ({
        auth: {
          userId: 'missing', memberId: 'missing', email: null, tenant: 'tenant-a', role: 'member',
          channel: 'workspace', boundAgentId: 'agent-a', tokenId: 'missing', capabilities: [],
        },
        env: f.env,
      }),
      (f) => {
        const token = f.installToken({ id: 'tok-revoked', revokedAt: at(0) })
        return { auth: f.auth(token), env: f.env }
      },
      (f) => {
        const token = f.installToken({ id: 'tok-expired', expiresAt: '2000-01-01T00:00:00.000Z' })
        return { auth: f.auth(token), env: f.env }
      },
      (f) => {
        const token = f.installToken({ id: 'tok-tenant' })
        return {
          auth: { ...f.auth(token), tenant: 'tenant-b' },
          env: { ...f.env, TENANT_SLUG: 'tenant-b' } as Env,
        }
      },
      (f) => {
        const token = f.installToken({ id: 'tok-agent' })
        return { auth: f.auth(token, 'agent-b'), env: f.env }
      },
      (f) => {
        const token = f.installToken({ id: 'tok-db-error' })
        const failingDb = {
          ...f.env.DB,
          prepare(sql: string) {
            if (sql.includes('SELECT t.label FROM member_tokens')) {
              const failed = {
                bind: () => failed,
                first: async () => { throw new Error('scope lookup unavailable') },
              }
              return failed
            }
            return f.env.DB.prepare(sql)
          },
        }
        return { auth: f.auth(token), env: { ...f.env, DB: failingDb } as unknown as Env }
      },
    ]

    for (const scenario of scenarios) {
      const f = fixture()
      try {
        f.seed('m1')
        const value = scenario(f)
        expect(await invokeTool(value.auth, value.env, 'inbox_consumer_status', { strict_scope: true }))
          .toMatchObject({ ok: false, status: 500, error: 'seat_resolution_failed' })
        expect(await invokeTool(value.auth, value.env, 'inbox_lease', {
          attempt_id: A, limit: 1,
        })).toMatchObject({ ok: false, status: 500, error: 'seat_resolution_failed' })
        expect(await invokeTool(value.auth, value.env, 'inbox_lease_reconcile', { attempt_id: A }))
          .toMatchObject({ ok: false, status: 500, error: 'seat_resolution_failed' })
        expect(await invokeTool(value.auth, value.env, 'inbox_lease_ack', { attempt_id: A }))
          .toMatchObject({ ok: false, status: 500, error: 'seat_resolution_failed' })
        expect(f.harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_inbox_lease_attempts').get())
          .toEqual({ n: 0 })
        expect(f.harness.sqlite.prepare("SELECT read_at FROM agent_messages WHERE id='m1'").get())
          .toEqual({ read_at: null })
      } finally { f.harness.close() }
    }
  })
})
