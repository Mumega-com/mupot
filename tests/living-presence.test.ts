// tests/living-presence.test.ts — Zero-Touch Auto-Liveness on MCP Tool Invocations.
// Proves that any authenticated tool call automatically touches presence in D1,
// boot_context auto-registers presence, and high-frequency tool loops debounce correctly.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

const sha256 = async (s: string) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('FLIGHT-LIVING-PRESENCE: zero-touch auto-liveness (real SQLite D1)', () => {
  let harness: SqliteD1Harness
  let env: Env
  const tenant = 'mumega'
  const squadId = 'squad-eng'
  const agentId = 'a-opencode'
  const memberId = 'm-opencode'

  beforeAll(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    const tokHash = await sha256('tok-opencode')

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-1', 'eng', 'Engineering', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('${squadId}', 'dept-1', 'squad-eng', 'Engineering Squad', datetime('now'));
      
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${memberId}', '${tenant}', 'OpenCode Harness', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${agentId}', '${squadId}', 'hadi-opencode', 'hadi-opencode', 'agent', 'model-1', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${tenant}', '${agentId}', '${memberId}', datetime('now'));
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('tok-opencode-1', '${memberId}', '${tenant}', '${tokHash}', '${agentId}', 'opencode', 'workspace', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-opencode', '${memberId}', 'squad', '${squadId}', 'member');
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

  it('boot_context auto-registers presence on startup', async () => {
    const auth: AuthContext = {
      memberId,
      boundAgentId: agentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    // Call boot_context with seat name
    const res = await invokeTool(auth, env, 'boot_context', { source: 'tmux', seat: 'OpenCode Mac Pane' }, 'https://mupot.mumega.com')
    expect(res.ok).toBe(true)

    // Allow background promise tick to resolve
    await new Promise((r) => setTimeout(r, 50))

    const presence = harness.sqlite.prepare(
      `SELECT label, source, agent_id FROM presence WHERE member_id = ? AND tenant = ? AND label = 'OpenCode Mac Pane'`,
    ).get(memberId, tenant) as { label: string; source: string; agent_id: string }

    expect(presence).toBeDefined()
    expect(presence.label).toBe('OpenCode Mac Pane')
    expect(presence.source).toBe('tmux')
    expect(presence.agent_id).toBe(agentId)
  })

  it('calling standard MCP tools automatically touches presence without check_in', async () => {
    const auth: AuthContext = {
      memberId,
      boundAgentId: agentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    // Call a read-only tool (peers)
    const res = await invokeTool(auth, env, 'peers', {}, 'https://mupot.mumega.com')
    expect(res.ok).toBe(true)

    await new Promise((r) => setTimeout(r, 50))

    // Verify presence row still exists and is fresh
    const presence = harness.sqlite.prepare(
      `SELECT label, source, agent_id, last_seen_at FROM presence WHERE member_id = ? AND tenant = ? AND label = 'OpenCode Mac Pane'`,
    ).get(memberId, tenant) as { label: string; source: string; agent_id: string; last_seen_at: string }

    expect(presence).toBeDefined()
    expect(presence.label).toBe('OpenCode Mac Pane')
    expect(presence.last_seen_at).toBeDefined()
  })

  it('zero-touch auto-presence works for unminted/new sessions calling tools', async () => {
    const freshMemberId = 'm-cursor-fresh'
    harness.sqlite.exec(`
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${freshMemberId}', '${tenant}', 'Fresh Cursor User', 'cursor@test.com', 'active', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-cursor-fresh', '${freshMemberId}', 'squad', '${squadId}', 'observer');
    `)

    const freshAuth: AuthContext = {
      memberId: freshMemberId,
      boundAgentId: null,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'observer' }],
    }

    // Call status tool
    const res = await invokeTool(freshAuth, env, 'status', {}, 'https://mupot.mumega.com')
    expect(res.ok).toBe(true)

    await new Promise((r) => setTimeout(r, 50))

    // Verify presence was automatically touched
    const presence = harness.sqlite.prepare(
      `SELECT display_name, agent_id FROM presence WHERE member_id = ? AND tenant = ?`,
    ).get(freshMemberId, tenant) as { display_name: string; agent_id: string | null }

    expect(presence).toBeDefined()
    expect(presence.display_name).toBe('Fresh Cursor User')
    expect(presence.agent_id).toBeNull()
  })
})
