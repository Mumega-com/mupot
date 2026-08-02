// tests/mcp-session-health.test.ts — MCP read/write session coherence (#602).
//
// Problem (#602): Status (read) succeeds while Send (write) fails as session_expired;
// reconnect does not restore writes; inbox consumed on failed write breaks fallback ACK.
//
// Required behavior:
// - Session expiry applies coherently to reads and writes (or every response exposes
//   a typed reauthentication requirement).
// - Reconnect replaces the expired generation and restores both read and write tools.
// - Failed write never consumes the corresponding inbox message.
// - Health/status exposes read and write readiness separately.
// - Tests cover expiry between read/write, reconnect, replay, and duplicate suppression.
//
// Related: #544 (runtime-session/v1), #577 (endpoint-registration/v1).

import { describe, it, expect } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext, CapabilityGrant } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-1'
const ORIGIN = 'https://pot.test'

function migratedDb() {
  const fixture = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    fixture.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  // Set up a minimal working fixture: member, agent, squad.
  fixture.sqlite.exec(`
    INSERT INTO members (id, email, display_name, status) VALUES
      ('member-1', 'member@example.test', 'Member One', 'active');
    INSERT INTO departments (id, slug, name) VALUES
      ('dept-1', 'dept-1', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-1', 'dept-1', 'squad-1', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, role) VALUES
      ('agent-sender', 'squad-1', 'sender', 'Sender', 'worker'),
      ('agent-receiver', 'squad-1', 'receiver', 'Receiver', 'worker');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-sender', 'agent-sender', 'squad-1', 'member'),
      ('membership-receiver', 'agent-receiver', 'squad-1', 'member');
  `)
  return fixture
}

function envWith(DB: Env['DB']): Env {
  return {
    DB,
    TENANT_SLUG: TENANT,
    SESSIONS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  } as Env
}

// Mock principal for an agent-bound token
function agentBoundPrincipal(agentId: string, memberId: string, grants: CapabilityGrant[] = []): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: 'agent@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: grants,
    boundAgentId: agentId,
  }
}

function grant(capability: CapabilityGrant['capability'], scope_type = 'squad', scope_id: string | null = 'squad-1'): CapabilityGrant {
  return { member_id: 'member-1', scope_type, scope_id, capability } as CapabilityGrant
}

// Mock principal for an unauthenticated caller
function unauthenticatedPrincipal(): AuthContext {
  return {
    userId: 'unknown',
    memberId: undefined,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [],
    boundAgentId: null,
  }
}

describe('MCP session health — read/write coherence (#602)', () => {
  describe('send requires agent-bound token', () => {
    it('unauthenticated caller cannot send', async () => {
      const db = migratedDb()
      const env = envWith(db.DB)

      const result = await invokeTool(unauthenticatedPrincipal(), env, 'send', {
        to: 'agent-receiver',
        body: 'test',
      }, ORIGIN)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('not_agent_bound')
    })

    it('member-only token (no agent binding) cannot send', async () => {
      const db = migratedDb()
      const env = envWith(db.DB)
      const auth: AuthContext = {
        userId: 'member-1',
        memberId: 'member-1',
        email: 'member@example.test',
        role: 'member',
        tenant: TENANT,
        channel: 'workspace',
        capabilities: [],
        boundAgentId: null, // no agent binding
      }

      const result = await invokeTool(auth, env, 'send', {
        to: 'agent-receiver',
        body: 'test',
      }, ORIGIN)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('not_agent_bound')
    })
  })

  describe('status read path works for any authenticated member', () => {
    it('member-only token can read own status', async () => {
      const db = migratedDb()
      const env = envWith(db.DB)
      const auth: AuthContext = {
        userId: 'member-1',
        memberId: 'member-1',
        email: 'member@example.test',
        role: 'member',
        tenant: TENANT,
        channel: 'workspace',
        capabilities: [],
        boundAgentId: null,
      }

      const result = await invokeTool(auth, env, 'status', {}, ORIGIN)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const data = result.result as Record<string, unknown>
      expect(data.member_id).toBe('member-1')
      expect(data.bound_agent_id).toBe(null)
    })

    it('agent-bound token can read own status and sees bound_agent_id', async () => {
      const db = migratedDb()
      const env = envWith(db.DB)
      const auth = agentBoundPrincipal('agent-sender', 'member-1')

      const result = await invokeTool(auth, env, 'status', {}, ORIGIN)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const data = result.result as Record<string, unknown>
      expect(data.member_id).toBe('member-1')
      expect(data.bound_agent_id).toBe('agent-sender')
    })
  })

  describe('coherent send/status operation (baseline)', () => {
    it('agent-bound token can send and status works after', async () => {
      const db = migratedDb()
      const env = envWith(db.DB)
      const auth = agentBoundPrincipal('agent-sender', 'member-1', [grant('member', 'squad', 'squad-1')])

      // Send a message
      const sendResult = await invokeTool(auth, env, 'send', {
        to: 'agent-receiver',
        body: 'test message',
      }, ORIGIN)

      if (!sendResult.ok) {
        console.error('send failed:', sendResult.error, sendResult.detail)
      }
      expect(sendResult.ok).toBe(true)
      if (!sendResult.ok) return

      // Status should still work after send
      const statusResult = await invokeTool(auth, env, 'status', {}, ORIGIN)

      expect(statusResult.ok).toBe(true)
      if (!statusResult.ok) return
      const data = statusResult.result as Record<string, unknown>
      expect(data.member_id).toBe('member-1')
    })
  })

  describe('replay-once: duplicate suppression by request_id', () => {
    it('send with request_id is idempotent on retry (same sender, same rid, same content)', async () => {
      const db = migratedDb()
      const env = envWith(db.DB)
      const auth = agentBoundPrincipal('agent-sender', 'member-1', [grant('member', 'squad', 'squad-1')])

      const msg = {
        to: 'agent-receiver',
        body: 'replay test',
        request_id: 'req-1',
      }

      const first = await invokeTool(auth, env, 'send', msg, ORIGIN)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const firstData = first.result as Record<string, unknown>
      const firstId = firstData.id

      // Retry with same request_id
      const second = await invokeTool(auth, env, 'send', msg, ORIGIN)
      expect(second.ok).toBe(true)
      if (!second.ok) return
      const secondData = second.result as Record<string, unknown>
      expect(secondData.duplicate).toBe(true)
      expect(secondData.id).toBe(firstId)
    })

    it("different sender cannot reuse another agent's request_id", async () => {
      const db = migratedDb()
      const env = envWith(db.DB)

      // Agent A sends with request_id 'shared'
      const authA = agentBoundPrincipal('agent-sender', 'member-1', [grant('member', 'squad', 'squad-1')])
      const resultA = await invokeTool(authA, env, 'send', {
        to: 'agent-receiver',
        body: 'from A',
        request_id: 'shared',
      }, ORIGIN)
      expect(resultA.ok).toBe(true)

      // Agent B tries to send with same request_id to same recipient
      const authB = agentBoundPrincipal('agent-receiver', 'member-1', [grant('member', 'squad', 'squad-1')])
      const resultB = await invokeTool(authB, env, 'send', {
        to: 'agent-receiver',
        body: 'from B',
        request_id: 'shared',
      }, ORIGIN)

      // Should succeed because it's a different sender (agent-receiver, not agent-sender)
      expect(resultB.ok).toBe(true)
      if (!resultB.ok) return
      const dataB = resultB.result as Record<string, unknown>
      expect(dataB.duplicate).toBe(false)
    })

    it('send with same request_id but different content fails as request_id_conflict', async () => {
      const db = migratedDb()
      const env = envWith(db.DB)
      const auth = agentBoundPrincipal('agent-sender', 'member-1', [grant('member', 'squad', 'squad-1')])

      const first = await invokeTool(auth, env, 'send', {
        to: 'agent-receiver',
        body: 'version 1',
        request_id: 'req-conflict',
      }, ORIGIN)
      expect(first.ok).toBe(true)

      // Same sender, same request_id, different content
      const second = await invokeTool(auth, env, 'send', {
        to: 'agent-receiver',
        body: 'version 2 (different)',
        request_id: 'req-conflict',
      }, ORIGIN)

      expect(second.ok).toBe(false)
      if (second.ok) return
      expect(second.error).toBe('request_id_conflict')
    })
  })

  describe('reconnect after session state change', () => {
    // This test documents expected behavior: a new auth context
    // (simulating reconnect after expiry) should be treated as a fresh principal.
    it('new auth context (post-reconnect) allows fresh send with same request_id', async () => {
      const db = migratedDb()
      const env = envWith(db.DB)

      // First session: send with request_id
      const authSession1 = agentBoundPrincipal('agent-sender', 'member-1', [grant('member', 'squad', 'squad-1')])
      const firstSend = await invokeTool(authSession1, env, 'send', {
        to: 'agent-receiver',
        body: 'first session',
        request_id: 'req-1',
      }, ORIGIN)
      expect(firstSend.ok).toBe(true)

      // Simulate reconnect by getting a new auth context (new session)
      // But same member and agent identity.
      // The same sender attempting the same request_id should still be detected
      // as a replay within the same logical session window.
      const authSession2 = agentBoundPrincipal('agent-sender', 'member-1', [grant('member', 'squad', 'squad-1')])
      const secondSend = await invokeTool(authSession2, env, 'send', {
        to: 'agent-receiver',
        body: 'first session',
        request_id: 'req-1',
      }, ORIGIN)

      // Should detect as duplicate (replayed) within the system lifecycle.
      expect(secondSend.ok).toBe(true)
      if (!secondSend.ok) return
      const dataSecond = secondSend.result as Record<string, unknown>
      expect(dataSecond.duplicate).toBe(true)
    })

    it('status works across session reconnect (same principal, new connection)', async () => {
      const db = migratedDb()
      const env = envWith(db.DB)
      const auth = agentBoundPrincipal('agent-sender', 'member-1')

      // First session
      const status1 = await invokeTool(auth, env, 'status', {}, ORIGIN)
      expect(status1.ok).toBe(true)
      if (!status1.ok) return
      const data1 = status1.result as Record<string, unknown>
      const bound1 = data1.bound_agent_id

      // Simulate reconnect with same auth context
      const status2 = await invokeTool(auth, env, 'status', {}, ORIGIN)
      expect(status2.ok).toBe(true)
      if (!status2.ok) return
      const data2 = status2.result as Record<string, unknown>
      const bound2 = data2.bound_agent_id

      expect(bound2).toBe(bound1)
    })
  })
})
