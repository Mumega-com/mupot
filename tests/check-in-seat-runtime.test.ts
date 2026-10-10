// tests/check-in-seat-runtime.test.ts — S2 (mumega-com#1351): check_in persists
// fleet_agents.runtime from the SERVER-HELD harness kind of a seat binding, never from client text.
// Real SQLite + the full migration chain (no hand-rolled schema).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { harnessKindToRuntime } from '../src/fleet/registry'
import { upsertHarness } from '../src/members/harness'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const HUMAN = 'member-human'
const SEAT_MEMBER = 'member-seat'
const SQUAD_ID = 'squad-1'
const AGENT_ID = 'agent-seat-1'
const OTHER_AGENT_ID = 'agent-other'

let harness: SqliteD1Harness
let env: Env
let harnessId: string

function seatAuth(): AuthContext {
  return {
    userId: SEAT_MEMBER,
    memberId: SEAT_MEMBER,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [{ member_id: SEAT_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
    seatBinding: { seatId: 'seat-1', label: 'seat-1', harnessId, grantTokenId: 'tok-1', humanMemberId: HUMAN, source: 'handle' },
  }
}

function runtimeOf(agentId: string): string | undefined {
  const r = harness.sqlite.prepare('SELECT runtime FROM fleet_agents WHERE tenant = ? AND agent_id = ?').get(TENANT, agentId) as
    | { runtime: string }
    | undefined
  return r?.runtime
}

function seedFleetRow(agentId: string, runtime: string): void {
  harness.sqlite.prepare(
    `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, member_id)
     VALUES (?1, ?2, 'd', ?3, '[]', 'on_demand', 'running', ?1, ?4)`,
  ).run(agentId, TENANT, runtime, SEAT_MEMBER)
}

describe('check_in persists fleet_agents.runtime from the server-held harness kind (S2)', () => {
  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-1', 's', 'S');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
        VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'seat-1', 'Seat 1', 'generic', '@cf/test', 'active', '2026-08-01T00:00:00Z'),
               ('${OTHER_AGENT_ID}', '${SQUAD_ID}', 'other', 'Other', 'generic', '@cf/test', 'active', '2026-08-01T00:00:00Z');
      INSERT INTO members (id, display_name, email, status, tenant) VALUES
        ('${HUMAN}', 'Human', 'h@example.com', 'active', '${TENANT}'),
        ('${SEAT_MEMBER}', 'Seat', 's@example.com', 'active', '${TENANT}');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: { get: async () => null, put: async () => {} } } as unknown as Env
    const h = await upsertHarness(env, HUMAN, 'client-1', 'Claude Code')
    if (!h) throw new Error('harness fixture failed')
    harnessId = h.id
  })

  afterEach(() => harness.close())

  it('(a) writes the runtime mapped from the harness kind onto the caller\'s own row', async () => {
    seedFleetRow(AGENT_ID, '')
    const res = await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(runtimeOf(AGENT_ID)).toBe('claude-code')
  })

  it('(b) ignores client-supplied runtime text: a runtime arg is refused outright, and lying harness/source args change nothing', async () => {
    seedFleetRow(AGENT_ID, '')
    const refused = await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1', runtime: 'tmux' }, 'https://pot.example')
    expect(refused.ok).toBe(false)
    expect(runtimeOf(AGENT_ID)).toBe('')
    const res = await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1', harness: 'codex-cli', source: 'python' }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(runtimeOf(AGENT_ID)).toBe('claude-code')
  })

  it('never touches another agent\'s row, creates no row, and leaves an already-reported runtime alone', async () => {
    seedFleetRow(OTHER_AGENT_ID, '')
    await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(runtimeOf(OTHER_AGENT_ID)).toBe('')
    expect(runtimeOf(AGENT_ID)).toBeUndefined()
    seedFleetRow(AGENT_ID, 'herdr')
    await invokeTool(seatAuth(), env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(runtimeOf(AGENT_ID)).toBe('herdr')
  })

  it('a session without a seat binding writes nothing, even if the harness arg names a runtime', async () => {
    seedFleetRow(AGENT_ID, '')
    const a = seatAuth()
    delete a.seatBinding
    await invokeTool(a, env, 'check_in', { seat: 'seat-1', harness: 'claude-code' }, 'https://pot.example')
    expect(runtimeOf(AGENT_ID)).toBe('')
  })

  it('a binding that names another human\'s harness id reads as absent: no write', async () => {
    seedFleetRow(AGENT_ID, '')
    const a = seatAuth()
    if (a.seatBinding) a.seatBinding = { ...a.seatBinding, humanMemberId: SEAT_MEMBER }
    await invokeTool(a, env, 'check_in', { seat: 'seat-1' }, 'https://pot.example')
    expect(runtimeOf(AGENT_ID)).toBe('')
  })

  it('kinds with no runtime vocabulary entry leave runtime unset', () => {
    expect(harnessKindToRuntime('chatgpt')).toBeNull()
    expect(harnessKindToRuntime('ci')).toBeNull()
    expect(harnessKindToRuntime('other')).toBeNull()
    expect(harnessKindToRuntime('codex')).toBe('codex')
  })
})
