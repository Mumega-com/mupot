// tests/unique-seat-checkin.test.ts — Unique seat identity on check_in & status attribution.
// Proves that multiple seats sharing an agent family token can claim unique seat names,
// debounce independently across both seat and label args, coexist in presence without overwriting,
// and surface seat identity in status.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

const sha256 = async (s: string) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('unique seat check_in and status telemetry (real SQLite D1)', () => {
  let harness: SqliteD1Harness
  let env: Env
  const tenant = 'mumega'
  const squadId = 'squad-eng'
  const familyAgentId = 'a-grok-desktop'
  const memberId = 'm-grok-desktop'
  const observerMemberId = 'm-observer'
  const observerAgentId = 'a-observer'

  beforeAll(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    const tokHash = await sha256('tok-grok')

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-1', 'eng', 'Engineering', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('${squadId}', 'dept-1', 'squad-eng', 'Engineering Squad', datetime('now'));
      
      -- Grok Desktop family agent
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${memberId}', '${tenant}', 'hadi-grok-desktop', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${familyAgentId}', '${squadId}', 'hadi-grok-desktop', 'hadi-grok-desktop', 'agent', 'grok-beta', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${tenant}', '${familyAgentId}', '${memberId}', datetime('now'));
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('tok-1', '${memberId}', '${tenant}', '${tokHash}', '${familyAgentId}', 'desktop', 'workspace', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-1', '${memberId}', 'squad', '${squadId}', 'member');

      -- Observer agent
      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${observerMemberId}', '${tenant}', 'Observer Agent', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${observerAgentId}', '${squadId}', 'observer', 'Observer Agent', 'agent', 'model-1', 'active', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-2', '${observerMemberId}', 'squad', '${squadId}', 'observer');
    `)

    const sessionsStore = new Map<string, string>()
    const mockSessions = {
      get: async (k: string) => sessionsStore.get(k) ?? null,
      put: async (k: string, v: string) => { sessionsStore.set(k, v) },
      delete: async (k: string) => { sessionsStore.delete(k) },
    }

    const mockAgentDo = {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        fetch: async () => new Response(JSON.stringify({ state: 'idle' }), { status: 200 }),
      }),
    }

    env = {
      TENANT_SLUG: tenant,
      DB: harness.db,
      SESSIONS: mockSessions,
      AGENT: mockAgentDo,
    } as unknown as Env
  })

  afterAll(() => {
    harness.close()
  })

  it('check_in with label returns seat name and family identity', async () => {
    const auth: AuthContext = {
      memberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    const res = await invokeTool(auth, env, 'check_in', { source: 'tmux', label: 'Mumega Ceo' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result).toEqual({
        ok: true,
        seat: 'Mumega Ceo',
        agent: 'hadi-grok-desktop',
        agent_id: familyAgentId,
        debounced: false,
      })
    }

    // Verify presence table
    const presence = harness.sqlite.prepare(
      `SELECT label, source, agent_id FROM presence WHERE member_id = ? AND tenant = ? AND label = 'Mumega Ceo'`,
    ).get(memberId, tenant) as { label: string; source: string; agent_id: string }
    expect(presence.label).toBe('Mumega Ceo')
    expect(presence.source).toBe('tmux')
    expect(presence.agent_id).toBe(familyAgentId)
  })

  it('distinct seat names do not debounce each other (isolated debounce keys)', async () => {
    const auth: AuthContext = {
      memberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    // Seat Alpha checks in
    const checkA1 = await invokeTool(auth, env, 'check_in', { source: 'tmux', seat: 'Seat Alpha' })
    expect(checkA1.ok).toBe(true)
    if (checkA1.ok) expect((checkA1.result as any).debounced).toBe(false)

    // Repeat Seat Alpha immediately — debounced
    const checkA2 = await invokeTool(auth, env, 'check_in', { source: 'tmux', seat: 'Seat Alpha' })
    expect(checkA2.ok).toBe(true)
    if (checkA2.ok) expect((checkA2.result as any).debounced).toBe(true)

    // Seat Beta checks in immediately on same memberId — NOT debounced because seat differs
    const checkB1 = await invokeTool(auth, env, 'check_in', { source: 'tmux', seat: 'Seat Beta' })
    expect(checkB1.ok).toBe(true)
    if (checkB1.ok) {
      expect((checkB1.result as any).seat).toBe('Seat Beta')
      expect((checkB1.result as any).debounced).toBe(false)
    }

    // KILL-WITNESS: Assert BOTH Seat Alpha AND Seat Beta exist in presence simultaneously (no overwrite collapse)
    const allSeats = harness.sqlite.prepare(
      `SELECT label, source FROM presence WHERE member_id = ? AND tenant = ? ORDER BY label ASC`,
    ).all(memberId, tenant) as Array<{ label: string; source: string }>
    
    const labels = allSeats.map((s) => s.label)
    expect(labels).toContain('Mumega Ceo')
    expect(labels).toContain('Seat Alpha')
    expect(labels).toContain('Seat Beta')
    expect(allSeats.length).toBeGreaterThanOrEqual(3)
  })

  it('distinct label args do not debounce each other and both persist (kill-witness vs label debounce collapse)', async () => {
    const auth: AuthContext = {
      memberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    // Label Alpha checks in
    const resL1 = await invokeTool(auth, env, 'check_in', { source: 'tmux', label: 'Label Alpha' })
    expect(resL1.ok).toBe(true)
    if (resL1.ok) expect((resL1.result as any).debounced).toBe(false)

    // Repeat Label Alpha immediately — debounced
    const resL2 = await invokeTool(auth, env, 'check_in', { source: 'tmux', label: 'Label Alpha' })
    expect(resL2.ok).toBe(true)
    if (resL2.ok) expect((resL2.result as any).debounced).toBe(true)

    // Label Beta checks in immediately on same memberId — NOT debounced because label differs
    const resL3 = await invokeTool(auth, env, 'check_in', { source: 'tmux', label: 'Label Beta' })
    expect(resL3.ok).toBe(true)
    if (resL3.ok) {
      expect((resL3.result as any).seat).toBe('Label Beta')
      expect((resL3.result as any).debounced).toBe(false)
    }

    // Assert both Label Alpha and Label Beta exist in presence
    const labelRows = harness.sqlite.prepare(
      `SELECT label FROM presence WHERE member_id = ? AND tenant = ? AND label IN ('Label Alpha', 'Label Beta')`,
    ).all(memberId, tenant) as Array<{ label: string }>
    expect(labelRows.length).toBe(2)
  })

  it('status() echoes seat_name and full seats list on self lookup', async () => {
    const auth: AuthContext = {
      memberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }

    const res = await invokeTool(auth, env, 'status', {})
    expect(res.ok).toBe(true)
    if (res.ok) {
      const r = res.result as any
      expect(r.member_id).toBe(memberId)
      expect(r.bound_agent_id).toBe(familyAgentId)
      expect(r.seat_name).toBe('Label Beta') // Latest seat recorded in presence
      expect(r.seats).toContain('Seat Alpha')
      expect(r.seats).toContain('Seat Beta')
      expect(r.seats).toContain('Mumega Ceo')
      expect(r.seats).toContain('Label Alpha')
      expect(r.seats).toContain('Label Beta')
    }
  })

  it('status(agent_id) includes seat_name and active seats on cross-agent lookup', async () => {
    const observerAuth: AuthContext = {
      memberId: observerMemberId,
      boundAgentId: observerAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'observer' }],
    }

    const res = await invokeTool(observerAuth, env, 'status', { agent_id: familyAgentId })
    expect(res.ok).toBe(true)
    if (res.ok) {
      const r = res.result as any
      expect(r.agent.id).toBe(familyAgentId)
      expect(r.agent.name).toBe('hadi-grok-desktop')
      expect(r.agent.seat_name).toBe('Label Beta')
      expect(r.agent.seats).toContain('Seat Alpha')
      expect(r.agent.seats).toContain('Seat Beta')
      expect(r.agent.seats).toContain('Mumega Ceo')
      expect(r.agent.seats).toContain('Label Alpha')
      expect(r.agent.seats).toContain('Label Beta')
    }
  })
})
