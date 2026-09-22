// tests/mcp-check-in-poll-presence.test.ts — mupot#1494 round 2 adversarial gate follow-up.
// check_in(presence_mode:'poll'|'resident') against REAL SQLite + the full migration chain
// (tests/helpers/migrations.ts applyAllMigrations), not a hand-rolled mock — the round-1 gate
// noted that hand-rolled fleet_agents mocks were exactly why P1-c (squads population) and
// P2-f (operator-stop must win) were invisible: a mock that returns whatever the test author
// expects can't catch a real JOIN or a real ON CONFLICT branch being wrong.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const MEMBER_ID = 'member-1'
const DEPT_ID = 'dept-1'
const SQUAD_ID = 'squad-1'
const OTHER_SQUAD_ID = 'squad-2'
const AGENT_ID = 'agent-uuid-orca'

function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
    ...overrides,
  }
}

let harness: SqliteD1Harness
let env: Env

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');
    INSERT INTO squads (id, department_id, slug, name)
    VALUES
      ('${SQUAD_ID}', '${DEPT_ID}', 'orca-squad', 'Orca Squad'),
      ('${OTHER_SQUAD_ID}', '${DEPT_ID}', 'other-squad', 'Other Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
    VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'orca-runner', 'Orca Runner', 'generic', '@cf/test', 'active', '2026-08-01T00:00:00Z');
    INSERT INTO members (id, display_name, email, status, tenant)
    VALUES ('${MEMBER_ID}', 'Orca Operator', 'orca@example.com', 'active', '${TENANT}');
  `)
}

function fleetRow(sqlite: SqliteD1Harness['sqlite']): Record<string, unknown> | undefined {
  return sqlite.prepare('SELECT * FROM fleet_agents WHERE tenant = ? AND agent_id = ?').get(TENANT, AGENT_ID) as
    | Record<string, unknown>
    | undefined
}

describe('MCP check_in(presence_mode) against REAL schema (mupot#1494 round 2)', () => {
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: TENANT, SESSIONS: { get: async () => null, put: async () => {} } } as unknown as Env
  })

  afterEach(() => harness.close())

  it('establishes a poll-mode row keyed by the caller\'s OWN uuid, runtime UNSET (not \'poll\'), squads populated from its REAL home squad (P1-c)', async () => {
    const res = await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ presence_mode: 'poll', poll_interval_sec: 300, presence_ttl_sec: 600 })

    const row = fleetRow(harness.sqlite)
    expect(row).toBeDefined()
    expect(row!.runtime).toBe('') // P2-h: never 'poll' — that is a delivery cadence, not a harness
    expect(row!.presence_mode).toBe('poll')
    expect(row!.presence_ttl_sec).toBe(600)
    expect(row!.status).toBe('running')
    expect(JSON.parse(row!.squads as string)).toEqual(['orca-squad'])
  })

  it('re-resolves squads on a LATER check_in after the agent is reassigned — not a one-time snapshot (P1-c)', async () => {
    await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')
    harness.sqlite.prepare('UPDATE agents SET squad_id = ? WHERE id = ?').run(OTHER_SQUAD_ID, AGENT_ID)

    await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')

    const row = fleetRow(harness.sqlite)
    expect(JSON.parse(row!.squads as string)).toEqual(['other-squad'])
  })

  it('does NOT resurrect a row an operator (or the agent\'s own prior self-detach) stopped — no refresh, typed note (P2-f)', async () => {
    // Establish, then simulate an operator/self-detach exactly like markStopped would.
    await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')
    const stoppedAt = sqliteStamp(Date.now() - 3_600_000)
    harness.sqlite.prepare(
      `UPDATE fleet_agents SET status = 'stopped', last_reported_at = ?, updated_at = ? WHERE tenant = ? AND agent_id = ?`,
    ).run(stoppedAt, stoppedAt, TENANT, AGENT_ID)

    const res = await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ presence_stopped_by_operator: true })
    expect(res.result).not.toHaveProperty('presence_mode')
    expect(res.result).not.toHaveProperty('poll_interval_sec')

    const row = fleetRow(harness.sqlite)
    expect(row!.status).toBe('stopped')
    expect(row!.last_reported_at).toBe(stoppedAt) // untouched
  })

  it('an ordinary poll check_in (no operator stop) refreshes last_reported_at normally', async () => {
    await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')
    const firstSeen = fleetRow(harness.sqlite)!.last_reported_at as string

    // Simulate time passing by directly backdating, then check in again.
    harness.sqlite.prepare(`UPDATE fleet_agents SET last_reported_at = ? WHERE tenant = ? AND agent_id = ?`)
      .run(sqliteStamp(Date.now() - 120_000), TENANT, AGENT_ID)

    const res = await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ presence_mode: 'poll' })
    const row = fleetRow(harness.sqlite)
    expect(row!.status).toBe('running')
    expect(row!.last_reported_at).not.toBe(sqliteStamp(Date.now() - 120_000))
    void firstSeen
  })

  it('presence_mode: resident CLEARS a prior poll registration — dispatch then falls back to resident rules (P2-g)', async () => {
    await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')
    expect(fleetRow(harness.sqlite)!.presence_mode).toBe('poll')

    const res = await invokeTool(auth(), env, 'check_in', { presence_mode: 'resident' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    const row = fleetRow(harness.sqlite)
    expect(row!.presence_mode).toBe('')
    expect(row!.presence_ttl_sec).toBeNull()
  })

  it('a subsequent plain check_in (no presence_mode) still refreshes an already-poll-registered row', async () => {
    await invokeTool(auth(), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 60 }, 'https://pot.example')
    harness.sqlite.prepare(`UPDATE fleet_agents SET last_reported_at = ? WHERE tenant = ? AND agent_id = ?`)
      .run(sqliteStamp(Date.now() - 90_000), TENANT, AGENT_ID)

    const res = await invokeTool(auth(), env, 'check_in', { source: 'codex' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    const row = fleetRow(harness.sqlite)
    expect(row!.presence_mode).toBe('poll') // untouched by the plain touch
    expect(row!.last_reported_at).not.toBe(sqliteStamp(Date.now() - 90_000))
  })
})
