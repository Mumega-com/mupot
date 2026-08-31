// tests/seven-axis-presence.test.ts — 7-axis multi-harness seat onboarding.
//
// Proves:
//   1. check_in persists the full 7-axis declaration (seat/harness/machine/model/provider/effort/flight_id).
//   2. Distinct seats on the same member_id persist independently (no overwrite collapse).
//   3. MCP status echoes the active seat dimensions (self + cross-agent).
//   4. Cursor Cloud dispatch injects the exact identity declaration.
//   5. The live roster renderer surfaces harness/machine/model/effort badges.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import {
  injectSevenAxisSeatDeclaration,
  sevenAxisCheckInDeclaration,
  CURSOR_CLOUD_SEAT,
  CURSOR_CLOUD_HARNESS,
  CURSOR_CLOUD_MODEL,
  CURSOR_CLOUD_EFFORT,
  CURSOR_CLOUD_MACHINE,
} from '../src/cursor/seat-identity'
import { listPresence, normalizeHarness, normalizeEffort } from '../src/fleet/presence'
import { renderSevenAxisSeatRoster } from '../src/dashboard/mission-control-views'
import type { AuthContext, Env } from '../src/types'
import type { PresenceView } from '../src/fleet/presence'

const sha256 = async (s: string) => {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('')
}

describe('7-axis multi-harness seat onboarding (real SQLite D1)', () => {
  let harness: SqliteD1Harness
  let env: Env
  const tenant = 'mumega'
  const squadId = 'squad-eng'
  const familyAgentId = 'a-grok-desktop'
  const memberId = 'm-grok-desktop'
  const observerMemberId = 'm-observer'
  const observerAgentId = 'a-observer'
  const flightId = '11111111-2222-4333-8444-555555555555'

  beforeAll(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    const tokHash = await sha256('tok-grok')

    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-1', 'eng', 'Engineering', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('${squadId}', 'dept-1', 'squad-eng', 'Engineering Squad', datetime('now'));

      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('${memberId}', '${tenant}', 'hadi-grok-desktop', NULL, 'active', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('${familyAgentId}', '${squadId}', 'hadi-grok-desktop', 'hadi-grok-desktop', 'agent', 'grok-4.6', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
        ('${tenant}', '${familyAgentId}', '${memberId}', datetime('now'));
      INSERT INTO member_tokens (id, member_id, tenant, token_hash, agent_id, label, channel, created_at) VALUES
        ('tok-1', '${memberId}', '${tenant}', '${tokHash}', '${familyAgentId}', 'desktop', 'workspace', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-1', '${memberId}', 'squad', '${squadId}', 'member');

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

  function auth(): AuthContext {
    return {
      memberId,
      boundAgentId: familyAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }
  }

  it('check_in persists the full 7-axis declaration', async () => {
    const res = await invokeTool(auth(), env, 'check_in', {
      seat: 'cursor-mac',
      harness: 'cursor-ide',
      machine: 'hadi-mac',
      model: 'claude-3-7-sonnet',
      provider: 'anthropic',
      effort: 'high',
      flight_id: flightId,
      source: 'claude-code',
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result).toMatchObject({
      ok: true,
      seat: 'cursor-mac',
      agent: 'hadi-grok-desktop',
      agent_id: familyAgentId,
      harness: 'cursor-ide',
      machine: 'hadi-mac',
      model: 'claude-3-7-sonnet',
      provider: 'anthropic',
      effort: 'high',
      flight_id: flightId,
      debounced: false,
    })

    const row = harness.sqlite.prepare(
      `SELECT label, harness, machine, model, provider, effort, flight_id, source, agent_id
         FROM presence WHERE tenant = ? AND member_id = ? AND label = 'cursor-mac'`,
    ).get(tenant, memberId) as {
      label: string
      harness: string
      machine: string
      model: string
      provider: string
      effort: string
      flight_id: string
      source: string
      agent_id: string
    }
    expect(row).toMatchObject({
      label: 'cursor-mac',
      harness: 'cursor-ide',
      machine: 'hadi-mac',
      model: 'claude-3-7-sonnet',
      provider: 'anthropic',
      effort: 'high',
      flight_id: flightId,
      source: 'claude-code',
      agent_id: familyAgentId,
    })
  })

  it('distinct seats on the same member_id persist independently', async () => {
    const grok = await invokeTool(auth(), env, 'check_in', {
      seat: 'grok-desktop',
      harness: 'grok-cli',
      machine: 'hadi-mac',
      model: 'grok-4.6',
      provider: 'xai',
      effort: 'extended-thinking-64k',
    })
    expect(grok.ok).toBe(true)
    if (grok.ok) expect((grok.result as { debounced: boolean }).debounced).toBe(false)

    const cloud = await invokeTool(auth(), env, 'check_in', {
      seat: 'cursor-cloud-builder',
      harness: 'cursor-cloud',
      machine: 'cursor-cloud-vm',
      model: 'claude-3-7-sonnet',
      provider: 'anthropic',
      effort: 'high',
      flight_id: flightId,
    })
    expect(cloud.ok).toBe(true)
    if (cloud.ok) expect((cloud.result as { debounced: boolean }).debounced).toBe(false)

    const rows = harness.sqlite.prepare(
      `SELECT label, harness, model, effort FROM presence WHERE tenant = ? AND member_id = ? ORDER BY label ASC`,
    ).all(tenant, memberId) as Array<{ label: string; harness: string; model: string; effort: string }>

    const bySeat = Object.fromEntries(rows.map((r) => [r.label, r]))
    expect(bySeat['cursor-mac']).toMatchObject({ harness: 'cursor-ide', model: 'claude-3-7-sonnet', effort: 'high' })
    expect(bySeat['grok-desktop']).toMatchObject({ harness: 'grok-cli', model: 'grok-4.6', effort: 'extended-thinking-64k' })
    expect(bySeat['cursor-cloud-builder']).toMatchObject({
      harness: 'cursor-cloud',
      model: 'claude-3-7-sonnet',
      effort: 'high',
    })
    expect(rows.length).toBe(3)
  })

  it('status echoes the active seat dimensions for self and cross-agent lookup', async () => {
    const self = await invokeTool(auth(), env, 'status', {})
    expect(self.ok).toBe(true)
    if (!self.ok) return
    const r = self.result as {
      seat_name: string
      seats: string[]
      active_seat: {
        seat: string
        harness: string
        machine: string | null
        model: string | null
        provider: string | null
        effort: string | null
        flight_id: string | null
      }
      seat_roster: Array<{ seat: string; harness: string; model: string | null }>
    }
    expect(r.seats).toEqual(expect.arrayContaining(['cursor-mac', 'grok-desktop', 'cursor-cloud-builder']))
    expect(r.active_seat).toBeTruthy()
    expect(r.active_seat.harness).toMatch(/cursor-cloud|grok-cli|cursor-ide/)
    expect(r.seat_roster).toHaveLength(3)
    expect(r.seat_roster.map((s) => s.seat)).toEqual(
      expect.arrayContaining(['cursor-mac', 'grok-desktop', 'cursor-cloud-builder']),
    )
    const mac = r.seat_roster.find((s) => s.seat === 'cursor-mac')
    expect(mac).toMatchObject({ harness: 'cursor-ide', model: 'claude-3-7-sonnet' })

    const observerAuth: AuthContext = {
      memberId: observerMemberId,
      boundAgentId: observerAgentId,
      tenant,
      role: 'member',
      channel: 'workspace',
      capabilities: [{ scope_type: 'squad', scope_id: squadId, capability: 'observer' }],
    }
    const cross = await invokeTool(observerAuth, env, 'status', { agent_id: familyAgentId })
    expect(cross.ok).toBe(true)
    if (!cross.ok) return
    const agent = (cross.result as { agent: { seat_roster: Array<{ seat: string; harness: string }>; active_seat: { harness: string } } }).agent
    expect(agent.active_seat.harness).toBeTruthy()
    expect(agent.seat_roster.map((s) => s.seat)).toEqual(
      expect.arrayContaining(['cursor-mac', 'grok-desktop', 'cursor-cloud-builder']),
    )
  })

  it('listPresence projects 7-axis columns onto the live roster', async () => {
    const rows = await listPresence(env, Date.now())
    const seats = rows.filter((r) => r.member_id === memberId)
    expect(seats.map((s) => s.label)).toEqual(
      expect.arrayContaining(['cursor-mac', 'grok-desktop', 'cursor-cloud-builder']),
    )
    expect(seats.every((s) => typeof s.harness === 'string')).toBe(true)
    expect(seats.find((s) => s.label === 'grok-desktop')?.provider).toBe('xai')
    expect(seats.find((s) => s.label === 'cursor-mac')?.harness).toBe('cursor-ide')
    expect(seats.find((s) => s.label === 'cursor-cloud-builder')?.flight_id).toBe(flightId)
  })

  it('check_in accepts and persists an exact Codex CLI harness', async () => {
    const res = await invokeTool(auth(), env, 'check_in', {
      seat: 'hadi-codex-cli',
      harness: 'codex-cli',
      machine: 'hadi-mac',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      effort: 'high',
      source: 'codex',
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.result).toMatchObject({
      seat: 'hadi-codex-cli',
      harness: 'codex-cli',
      machine: 'hadi-mac',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      effort: 'high',
    })

    const row = harness.sqlite.prepare(
      `SELECT label, harness, machine, model, provider, effort, source
         FROM presence WHERE tenant = ? AND member_id = ? AND label = 'hadi-codex-cli'`,
    ).get(tenant, memberId) as {
      label: string
      harness: string
      machine: string
      model: string
      provider: string
      effort: string
      source: string
    }
    expect(row).toEqual({
      label: 'hadi-codex-cli',
      harness: 'codex-cli',
      machine: 'hadi-mac',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      effort: 'high',
      source: 'codex',
    })
  })
})

describe('7-axis normalizers and Cursor Cloud seat injection', () => {
  it('normalizes unknown harness/effort without storing raw client junk', () => {
    expect(normalizeHarness('codex-cli')).toBe('codex-cli')
    expect(normalizeHarness('cursor-cloud')).toBe('cursor-cloud')
    expect(normalizeHarness('evil-runtime')).toBe('unknown')
    expect(normalizeHarness(42)).toBe('unknown')
    expect(normalizeEffort('high')).toBe('high')
    expect(normalizeEffort('extended-thinking-64k')).toBe('extended-thinking-64k')
    expect(normalizeEffort('ludicrous')).toBeNull()
  })

  it('injects the exact Cursor Cloud 7-axis check_in declaration', () => {
    const flightId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const injected = injectSevenAxisSeatDeclaration('Ship the radar roster.', flightId)
    const identity = sevenAxisCheckInDeclaration(flightId)
    expect(identity).toBe(
      `Identity: You are Cursor Cloud Flight Agent. On start, invoke check_in({ seat: "${CURSOR_CLOUD_SEAT}", harness: "${CURSOR_CLOUD_HARNESS}", machine: "${CURSOR_CLOUD_MACHINE}", model: "${CURSOR_CLOUD_MODEL}", provider: "anthropic", effort: "${CURSOR_CLOUD_EFFORT}", flight_id: "${flightId}" })`,
    )
    expect(injected.startsWith(identity)).toBe(true)
    expect(injected).toContain('Ship the radar roster.')
    expect(injectSevenAxisSeatDeclaration(injected, 'other-id')).toBe(injected)
  })

  it('renders harness/machine/model/effort badges for distinct active seats', () => {
    const now = '2026-08-26 14:00:00'
    const rows: PresenceView[] = [
      {
        member_id: 'm1',
        display_name: 'hadi-grok-desktop',
        source: 'unknown',
        label: 'cursor-mac',
        agent_id: 'a1',
        last_seen_at: now,
        first_seen_at: now,
        harness: 'cursor-ide',
        machine: 'hadi-mac',
        model: 'claude-3-7-sonnet',
        provider: 'anthropic',
        effort: 'high',
        flight_id: null,
        liveness: 'active',
        last_seen_human: 'just now',
        schedule: null,
      },
      {
        member_id: 'm1',
        display_name: 'hadi-grok-desktop',
        source: 'unknown',
        label: 'grok-desktop',
        agent_id: 'a1',
        last_seen_at: now,
        first_seen_at: now,
        harness: 'grok-cli',
        machine: 'hadi-mac',
        model: 'grok-4.6',
        provider: 'xai',
        effort: 'extended-thinking-64k',
        flight_id: null,
        liveness: 'active',
        last_seen_human: 'just now',
        schedule: null,
      },
      {
        member_id: 'm2',
        display_name: 'idle-seat',
        source: 'tmux',
        label: 'old-tmux',
        agent_id: 'a2',
        last_seen_at: now,
        first_seen_at: now,
        harness: 'unknown',
        machine: null,
        model: null,
        provider: null,
        effort: null,
        flight_id: null,
        liveness: 'idle',
        last_seen_human: '2h ago',
        schedule: null,
      },
    ]
    const html = renderSevenAxisSeatRoster(rows)
    expect(html).toContain('data-roster="seven-axis"')
    expect(html).toContain('cursor-mac')
    expect(html).toContain('grok-desktop')
    expect(html).toContain('cursor-ide')
    expect(html).toContain('grok-cli')
    expect(html).toContain('hadi-mac')
    expect(html).toContain('claude-3-7-sonnet')
    expect(html).toContain('grok-4.6')
    expect(html).toContain('extended-thinking-64k')
    expect(html).not.toContain('old-tmux')
  })
})
