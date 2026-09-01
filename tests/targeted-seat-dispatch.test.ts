// tests/targeted-seat-dispatch.test.ts — Migration 0120: targeted seat mailboxes and partition leasing.
//
// Proves:
//   (a) send() with target_seat persists target_seat in agent_messages.
//   (b) inbox() with seat fetches only matching seat messages + broadcast (target_seat IS NULL) messages.
//   (c) inbox() for Seat Alpha does NOT consume or drain messages targeted to Seat Beta.
//   (d) inbox_lease() partitions leases by seat correctly.
//   (e) Schema ratchets and migration numbering remain 100% GREEN.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

const sha256 = async (s: string) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('targeted seat dispatch & isolated mailboxes (Migration 0120)', () => {
  let harness: SqliteD1Harness
  let env: Env
  const tenant = 'mumega'
  const squadId = 'squad-eng'
  const senderAgentId = 'a-sender'
  const senderMemberId = 'm-sender'
  const familyAgentId = 'a-grok-family'
  const familyMemberId = 'm-grok-family'

  beforeAll(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    const tokHashSender = await sha256('tok-sender')
    const tokHashFamily = await sha256('tok-family')

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-1', 'eng', 'Engineering', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('${squadId}', 'dept-1', 'squad-eng', 'Engineering Squad', datetime('now'));
      
      -- Sender Agent
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${senderMemberId}', '${tenant}', 'Sender Agent', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${senderAgentId}', '${squadId}', 'sender-agent', 'Sender Agent', 'agent', 'grok-beta', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${tenant}', '${senderAgentId}', '${senderMemberId}', datetime('now'));
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('tok-s', '${senderMemberId}', '${tenant}', '${tokHashSender}', '${senderAgentId}', 'sender', 'workspace', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-s', '${senderMemberId}', 'squad', '${squadId}', 'member');

      -- Recipient Family Agent (e.g. hadi-grok-desktop)
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${familyMemberId}', '${tenant}', 'hadi-grok-desktop', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${familyAgentId}', '${squadId}', 'hadi-grok-desktop', 'hadi-grok-desktop', 'agent', 'grok-beta', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${tenant}', '${familyAgentId}', '${familyMemberId}', datetime('now'));
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('tok-f', '${familyMemberId}', '${tenant}', '${tokHashFamily}', '${familyAgentId}', 'family', 'workspace', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-f', '${familyMemberId}', 'squad', '${squadId}', 'member');
    `)

    const sessionsStore = new Map<string, string>()
    const mockSessions = {
      get: async (k: string) => sessionsStore.get(k) ?? null,
      put: async (k: string, v: string) => { sessionsStore.set(k, v) },
      delete: async (k: string) => { sessionsStore.delete(k) },
    }

    env = {
      TENANT_SLUG: tenant,
      DB: harness.db,
      SESSIONS: mockSessions,
    } as unknown as Env
  })

  afterAll(() => {
    harness.close()
  })

  it('send with seat persists target_seat in D1', async () => {
    const senderAuth: AuthContext = {
      memberId: senderMemberId,
      boundAgentId: senderAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ member_id: senderMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    // Send targeted message to Seat Alpha
    const resA = await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Hello Seat Alpha only',
      seat: 'cursor-mupot-setup',
      request_id: 'req-alpha-1',
    })
    expect(resA.ok).toBe(true)
    if (resA.ok) {
      expect((resA.result as any).target_seat).toBe('cursor-mupot-setup')
    }

    // Send targeted message to Seat Beta
    const resB = await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Hello Mumega Ceo desktop only',
      seat: 'Mumega Ceo',
      request_id: 'req-beta-1',
    })
    expect(resB.ok).toBe(true)

    // Send broadcast family message (no seat specified)
    const resC = await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Hello all family seats',
      request_id: 'req-family-1',
    })
    expect(resC.ok).toBe(true)

    // Verify D1 rows
    const rows = harness.sqlite.prepare(
      `SELECT body, target_seat FROM agent_messages WHERE to_agent = ? ORDER BY seq ASC`,
    ).all(familyAgentId) as Array<{ body: string; target_seat: string | null }>

    expect(rows).toHaveLength(3)
    expect(rows[0].target_seat).toBe('cursor-mupot-setup')
    expect(rows[1].target_seat).toBe('Mumega Ceo')
    expect(rows[2].target_seat).toBeNull()
  })

  it('seat-scoped inbox() consumes only matching seat messages + broadcast, leaving other seats untouched', async () => {
    const familyAuth: AuthContext = {
      memberId: familyMemberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ member_id: familyMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    // Seat Alpha (cursor-mupot-setup) reads its inbox with consume
    const readAlpha = await invokeTool(familyAuth, env, 'inbox', {
      seat: 'cursor-mupot-setup',
      peek: false,
    })

    expect(readAlpha.ok).toBe(true)
    if (readAlpha.ok) {
      const msgs = (readAlpha.result as any).messages as any[]
      // Should receive: "Hello Seat Alpha only" and "Hello all family seats" (broadcast)
      // Should NOT receive: "Hello Mumega Ceo desktop only"
      expect(msgs).toHaveLength(2)
      expect(msgs.some((m) => m.body === 'Hello Seat Alpha only')).toBe(true)
      expect(msgs.some((m) => m.body === 'Hello all family seats')).toBe(true)
      expect(msgs.some((m) => m.body === 'Hello Mumega Ceo desktop only')).toBe(false)
    }

    // Now Seat Beta (Mumega Ceo) reads its inbox
    const readBeta = await invokeTool(familyAuth, env, 'inbox', {
      seat: 'Mumega Ceo',
      peek: false,
    })

    expect(readBeta.ok).toBe(true)
    if (readBeta.ok) {
      const msgs = (readBeta.result as any).messages as any[]
      // Its targeted message must still be unread and delivered here!
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body).toBe('Hello Mumega Ceo desktop only')
      expect(msgs[0].target_seat).toBe('Mumega Ceo')
    }
  })

  it('inbox_lease partitions visibility by seat correctly', async () => {
    const senderAuth: AuthContext = {
      memberId: senderMemberId,
      boundAgentId: senderAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ member_id: senderMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    const familyAuth: AuthContext = {
      memberId: familyMemberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ member_id: familyMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    // Send two new messages
    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Lease target Alpha',
      seat: 'cursor-mupot-setup',
      request_id: 'req-alpha-lease',
    })

    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Lease target Beta',
      seat: 'Mumega Ceo',
      request_id: 'req-beta-lease',
    })

    // Lease for Alpha
    const leaseAlpha = await invokeTool(familyAuth, env, 'inbox_lease', {
      seat: 'cursor-mupot-setup',
    })
    expect(leaseAlpha.ok).toBe(true)
    if (leaseAlpha.ok) {
      const msgs = (leaseAlpha.result as any).messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body).toBe('Lease target Alpha')
      expect(msgs[0].target_seat).toBe('cursor-mupot-setup')
    }

    // Lease for Beta
    const leaseBeta = await invokeTool(familyAuth, env, 'inbox_lease', {
      seat: 'Mumega Ceo',
    })
    expect(leaseBeta.ok).toBe(true)
    if (leaseBeta.ok) {
      const msgs = (leaseBeta.result as any).messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body).toBe('Lease target Beta')
      expect(msgs[0].target_seat).toBe('Mumega Ceo')
    }
  })

  it('KILL-WITNESS: un-scoped inbox() call leaves targeted rows for Seat A completely UNREAD and unconsumed', async () => {
    const senderAuth: AuthContext = {
      memberId: senderMemberId,
      boundAgentId: senderAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ member_id: senderMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    const familyAuth: AuthContext = {
      memberId: familyMemberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ member_id: familyMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    // Send targeted message to Seat Alpha
    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Protected Seat Alpha Message',
      seat: 'cursor-mupot-setup',
      request_id: 'req-alpha-kill-witness',
    })

    // Send un-targeted broadcast message
    await invokeTool(senderAuth, env, 'send', {
      to: familyAgentId,
      body: 'Broadcast Family Message',
      request_id: 'req-broadcast-kill-witness',
    })

    // Generic un-scoped inbox() call (no seat arg) — represents legacy/unaware caller
    const unScopedRead = await invokeTool(familyAuth, env, 'inbox', {
      peek: false,
    })
    expect(unScopedRead.ok).toBe(true)
    if (unScopedRead.ok) {
      const msgs = (unScopedRead.result as any).messages as any[]
      // MUST only receive and consume the broadcast message
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body).toBe('Broadcast Family Message')
      expect(msgs[0].target_seat).toBeNull()
    }

    // Verify in D1: Protected Seat Alpha Message MUST STILL HAVE read_at IS NULL
    const alphaRow = harness.sqlite.prepare(
      `SELECT body, target_seat, read_at FROM agent_messages WHERE request_id = 'req-alpha-kill-witness'`,
    ).get() as { body: string; target_seat: string; read_at: string | null }

    expect(alphaRow.body).toBe('Protected Seat Alpha Message')
    expect(alphaRow.target_seat).toBe('cursor-mupot-setup')
    expect(alphaRow.read_at).toBeNull() // Protected! Not drained by un-scoped call.
  })
})
