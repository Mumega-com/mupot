// tests/living-presence.test.ts — Zero-Touch Auto-Liveness on MCP Tool Invocations.
// Proves that:
// 1. Any authenticated tool call automatically touches presence in D1 without check_in.
// 2. Multi-seat isolation: Sibling seats under the same family token bump ONLY their own presence row.
// 3. High-frequency tool loops debounce with KV to protect D1.
// 4. waitUntil is called to protect background touches in Cloudflare Workers.

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
  let sessionsStore: Map<string, string>
  const tenant = 'mumega'
  const squadId = 'squad-eng'
  const familyAgentId = 'a-opencode'
  const memberId = 'm-opencode'

  beforeAll(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    const tokHash1 = await sha256('tok-alpha')
    const tokHash2 = await sha256('tok-beta')

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-1', 'eng', 'Engineering', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('${squadId}', 'dept-1', 'squad-eng', 'Engineering Squad', datetime('now'));
      
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${memberId}', '${tenant}', 'OpenCode Harness', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${familyAgentId}', '${squadId}', 'hadi-opencode', 'hadi-opencode', 'agent', 'model-1', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${tenant}', '${familyAgentId}', '${memberId}', datetime('now'));
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('tok-alpha-id', '${memberId}', '${tenant}', '${tokHash1}', '${familyAgentId}', 'Seat Alpha', 'workspace', datetime('now')),
        ('tok-beta-id', '${memberId}', '${tenant}', '${tokHash2}', '${familyAgentId}', 'Seat Beta', 'workspace', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-opencode', '${memberId}', 'squad', '${squadId}', 'member');
    `)

    sessionsStore = new Map<string, string>()
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

  it('boot_context auto-registers presence on startup with waitUntil', async () => {
    const auth: AuthContext = {
      memberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      tokenId: 'tok-alpha-id',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    const waitedPromises: Promise<unknown>[] = []
    const ctx = {
      origin: 'https://mupot.mumega.com',
      seat: 'OpenCode Mac Pane',
      source: 'tmux',
      waitUntil: (p: Promise<unknown>) => { waitedPromises.push(p) },
    }

    // Call boot_context
    const res = await invokeTool(auth, env, 'boot_context', {}, ctx)
    expect(res.ok).toBe(true)
    expect(waitedPromises.length).toBeGreaterThan(0)
    await Promise.all(waitedPromises)

    const presence = harness.sqlite.prepare(
      `SELECT label, source, agent_id FROM presence WHERE member_id = ? AND tenant = ? AND label = 'OpenCode Mac Pane'`,
    ).get(memberId, tenant) as { label: string; source: string; agent_id: string }

    expect(presence).toBeDefined()
    expect(presence.label).toBe('OpenCode Mac Pane')
    expect(presence.source).toBe('tmux')
    expect(presence.agent_id).toBe(familyAgentId)
  })

  it('KILL-WITNESS: sibling seats on same memberId bump only their own last_seen_at without cross-stealing', async () => {
    // Seed initial presence for Seat Alpha and Seat Beta with past timestamps
    harness.sqlite.exec(`
      INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
      VALUES 
        ('${tenant}', '${memberId}', 'OpenCode Harness', 'tmux', 'Seat Alpha', '${familyAgentId}', '2026-08-20 12:00:00', '2026-08-20 12:00:00'),
        ('${tenant}', '${memberId}', 'OpenCode Harness', 'tmux', 'Seat Beta', '${familyAgentId}', '2026-08-20 12:00:00', '2026-08-20 12:00:00');
    `)

    // Clear KV to ensure clean test
    sessionsStore.clear()

    const authBeta: AuthContext = {
      memberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      tokenId: 'tok-beta-id', // Derives seat 'Seat Beta' from token row
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    const waited: Promise<unknown>[] = []
    const ctxBeta = {
      origin: 'https://mupot.mumega.com',
      waitUntil: (p: Promise<unknown>) => { waited.push(p) },
    }

    // Seat Beta calls a read-only tool (peers)
    const res = await invokeTool(authBeta, env, 'peers', {}, ctxBeta)
    expect(res.ok).toBe(true)
    expect(waited.length).toBeGreaterThan(0)
    await Promise.all(waited)

    // Check presence rows
    const betaRow = harness.sqlite.prepare(
      `SELECT label, last_seen_at FROM presence WHERE member_id = ? AND tenant = ? AND label = 'Seat Beta'`,
    ).get(memberId, tenant) as { label: string; last_seen_at: string }

    const alphaRow = harness.sqlite.prepare(
      `SELECT label, last_seen_at FROM presence WHERE member_id = ? AND tenant = ? AND label = 'Seat Alpha'`,
    ).get(memberId, tenant) as { label: string; last_seen_at: string }

    // KILL-WITNESS ASSERTION:
    // Seat Beta was bumped to recent timestamp (NOT 2026-08-20 12:00:00)
    expect(betaRow.last_seen_at).not.toBe('2026-08-20 12:00:00')
    // Seat Alpha was NOT touched and remains at past timestamp
    expect(alphaRow.last_seen_at).toBe('2026-08-20 12:00:00')
  })

  it('KV debounce throttles rapid repeat tool calls for the same seat', async () => {
    const authAlpha: AuthContext = {
      memberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      tokenId: 'tok-alpha-id',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    // Call tool once — populates KV debounce key
    const waited1: Promise<unknown>[] = []
    await invokeTool(authAlpha, env, 'status', {}, {
      origin: 'https://mupot.mumega.com',
      waitUntil: (p) => waited1.push(p),
    })
    await Promise.all(waited1)

    // Verify debounce key was set in KV
    const dkey = `presence:touch:${tenant}:${memberId}:Seat Alpha`
    expect(sessionsStore.get(dkey)).toBe('1')

    // Manually set last_seen_at to a known marker to detect whether second call writes to D1
    harness.sqlite.exec(`
      UPDATE presence SET last_seen_at = '2026-08-21 00:00:00' WHERE member_id = '${memberId}' AND label = 'Seat Alpha';
    `)

    // Call tool second time immediately — should be debounced by KV and NOT overwrite marker
    const waited2: Promise<unknown>[] = []
    await invokeTool(authAlpha, env, 'status', {}, {
      origin: 'https://mupot.mumega.com',
      waitUntil: (p) => waited2.push(p),
    })
    await Promise.all(waited2)

    const row = harness.sqlite.prepare(
      `SELECT last_seen_at FROM presence WHERE member_id = ? AND tenant = ? AND label = 'Seat Alpha'`,
    ).get(memberId, tenant) as { last_seen_at: string }

    // Assert that DB was NOT written to because KV debounced it
    expect(row.last_seen_at).toBe('2026-08-21 00:00:00')
  })
})
