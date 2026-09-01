// tests/presence-fleet-liveness-bridge.test.ts — bridge MCP check-in liveness into fleet_agents.
//
// THE DEFECT: presence (check_in / touchPresence) and fleet_agents (daemon attach) are two
// disconnected liveness surfaces. Wake routing reads fleet_agents; an actively-checking-in
// bound seat can still read stale/offline. These tests run REAL SQL via the migration chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { recordCheckin, bridgeCheckinToFleet } from '../src/fleet/presence'
import type { Env } from '../src/types'

const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const MEMBER_ID = 'member-1'
const AGENT_ID = 'agent-uuid-1'
const STALE = '2020-01-01 00:00:00'

function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function seedMemberAndAgent(sqlite: SqliteD1Harness['sqlite'], tenant: string, slugSuffix = ''): void {
  const slug = slugSuffix || tenant
  sqlite.exec(`
    INSERT INTO departments (id, slug, name, created_at)
      VALUES ('dept-${tenant}', 'eng-${slug}', 'Engineering', datetime('now'));
    INSERT INTO squads (id, department_id, slug, name, created_at)
      VALUES ('squad-${tenant}', 'dept-${tenant}', 'squad-${slug}', 'Squad', datetime('now'));
    INSERT INTO members (id, tenant, display_name, email, status, created_at)
      VALUES ('${MEMBER_ID}', '${tenant}', 'Test Agent', NULL, 'active', datetime('now'));
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
      VALUES ('${AGENT_ID}', 'squad-${tenant}', 'test-agent-${slug}', 'Test Agent', 'agent', 'model-1', 'active', datetime('now'));
  `)
}

function seedFleetRow(
  sqlite: SqliteD1Harness['sqlite'],
  tenant: string,
  agentId: string,
  lastReportedAt: string,
): void {
  sqlite.exec(`
    INSERT INTO fleet_agents (
      agent_id, tenant, display, runtime, squads, lifecycle, status,
      reported_by, agent_type, member_id, host, last_reported_at, updated_at
    ) VALUES (
      '${agentId}', '${tenant}', 'Test Agent', 'claude-code', '[]', 'on_demand', 'running',
      'reporter', 'generic', '${MEMBER_ID}', '', '${lastReportedAt}', '${lastReportedAt}'
    )
  `)
}

function fleetLastReported(sqlite: SqliteD1Harness['sqlite'], tenant: string, agentId: string): string | undefined {
  return (
    sqlite
      .prepare('SELECT last_reported_at FROM fleet_agents WHERE tenant = ? AND agent_id = ?')
      .get(tenant, agentId) as { last_reported_at: string } | undefined
  )?.last_reported_at
}

function fleetCount(sqlite: SqliteD1Harness['sqlite'], tenant?: string): number {
  if (tenant) {
    return (
      sqlite.prepare('SELECT COUNT(*) AS n FROM fleet_agents WHERE tenant = ?').get(tenant) as { n: number }
    ).n
  }
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM fleet_agents').get() as { n: number }).n
}

describe('presence → fleet_agents liveness bridge (real SQLite D1)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMemberAndAgent(harness.sqlite, TENANT_A)
    env = { DB: harness.db, TENANT_SLUG: TENANT_A } as unknown as Env
  })

  afterEach(() => harness.close())

  it('recordCheckin refreshes a stale fleet_agents.last_reported_at for a bound agent', async () => {
    seedFleetRow(harness.sqlite, TENANT_A, AGENT_ID, STALE)
    expect(fleetLastReported(harness.sqlite, TENANT_A, AGENT_ID)).toBe(STALE)

    await recordCheckin(
      env,
      { memberId: MEMBER_ID, displayName: 'Test Agent', email: null, boundAgentId: AGENT_ID },
      { seat: 'cursor-cloud', harness: 'cursor-cloud', source: 'cursor-cloud' },
    )

    const after = fleetLastReported(harness.sqlite, TENANT_A, AGENT_ID)!
    expect(after).not.toBe(STALE)
    expect(sqliteStamp(Date.parse(after.replace(' ', 'T') + 'Z'))).toBe(after)
    expect(Date.parse(after.replace(' ', 'T') + 'Z')).toBeGreaterThan(Date.parse(STALE.replace(' ', 'T') + 'Z'))
  })

  it('check-in with boundAgentId null does not touch fleet_agents', async () => {
    seedFleetRow(harness.sqlite, TENANT_A, AGENT_ID, STALE)
    const before = fleetCount(harness.sqlite, TENANT_A)

    await recordCheckin(
      env,
      { memberId: MEMBER_ID, displayName: 'Operator', email: null, boundAgentId: null },
      { seat: 'operator-seat', source: 'unknown' },
    )

    expect(fleetCount(harness.sqlite, TENANT_A)).toBe(before)
    expect(fleetLastReported(harness.sqlite, TENANT_A, AGENT_ID)).toBe(STALE)
  })

  it('check-in for an agent with no fleet_agents row is a clean no-op (UPDATE-only)', async () => {
    expect(fleetCount(harness.sqlite, TENANT_A)).toBe(0)

    const result = await recordCheckin(
      env,
      { memberId: MEMBER_ID, displayName: 'Test Agent', email: null, boundAgentId: AGENT_ID },
      { seat: 'orphan-seat' },
    )

    expect(result.seat).toBe('orphan-seat')
    expect(fleetCount(harness.sqlite, TENANT_A)).toBe(0)
  })

  it('bridge failure is fail-soft: recordCheckin still writes presence and returns normally', async () => {
    seedFleetRow(harness.sqlite, TENANT_A, AGENT_ID, STALE)
    const origPrepare = env.DB.prepare.bind(env.DB)
    const failingEnv = {
      ...env,
      DB: {
        prepare(sql: string) {
          const stmt = origPrepare(sql)
          if (sql.includes('UPDATE fleet_agents')) {
            return {
              bind(...args: unknown[]) {
                return {
                  async run() {
                    throw new Error('simulated fleet write failure')
                  },
                  async first<T>() {
                    return stmt.bind(...args).first<T>()
                  },
                  async all<T>() {
                    return stmt.bind(...args).all<T>()
                  },
                }
              },
            }
          }
          return stmt
        },
      },
    } as unknown as Env

    const result = await recordCheckin(
      failingEnv,
      { memberId: MEMBER_ID, displayName: 'Test Agent', email: null, boundAgentId: AGENT_ID },
      { seat: 'fail-soft-seat', harness: 'cursor-ide', machine: 'vm-1' },
    )

    expect(result).toMatchObject({ seat: 'fail-soft-seat', harness: 'cursor-ide', machine: 'vm-1' })
    expect(fleetLastReported(harness.sqlite, TENANT_A, AGENT_ID)).toBe(STALE)

    const presence = harness.sqlite
      .prepare('SELECT label, harness, machine FROM presence WHERE tenant = ? AND member_id = ? AND label = ?')
      .get(TENANT_A, MEMBER_ID, 'fail-soft-seat') as { label: string; harness: string; machine: string }
    expect(presence).toMatchObject({ label: 'fail-soft-seat', harness: 'cursor-ide', machine: 'vm-1' })
  })

  it('distinct seats on the same member_id persist independently in presence', async () => {
    await recordCheckin(
      env,
      { memberId: MEMBER_ID, displayName: 'Test Agent', email: null, boundAgentId: AGENT_ID },
      { seat: 'seat-a', harness: 'cursor-ide', model: 'model-a' },
    )
    await recordCheckin(
      env,
      { memberId: MEMBER_ID, displayName: 'Test Agent', email: null, boundAgentId: AGENT_ID },
      { seat: 'seat-b', harness: 'grok-cli', model: 'model-b' },
    )

    const rows = harness.sqlite
      .prepare('SELECT label, harness, model FROM presence WHERE tenant = ? AND member_id = ? ORDER BY label')
      .all(TENANT_A, MEMBER_ID) as Array<{ label: string; harness: string; model: string }>

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ label: 'seat-a', harness: 'cursor-ide', model: 'model-a' })
    expect(rows[1]).toMatchObject({ label: 'seat-b', harness: 'grok-cli', model: 'model-b' })
  })

  it('omitted 7-axis fields COALESCE to previously stored presence values', async () => {
    await recordCheckin(
      env,
      { memberId: MEMBER_ID, displayName: 'Test Agent', email: null, boundAgentId: AGENT_ID },
      {
        seat: 'axis-seat',
        harness: 'cursor-ide',
        machine: 'hadi-mac',
        model: 'claude-3-7-sonnet',
        provider: 'anthropic',
        effort: 'high',
      },
    )

    await recordCheckin(
      env,
      { memberId: MEMBER_ID, displayName: 'Test Agent', email: null, boundAgentId: AGENT_ID },
      { seat: 'axis-seat' },
    )

    const row = harness.sqlite
      .prepare(
        'SELECT harness, machine, model, provider, effort FROM presence WHERE tenant = ? AND member_id = ? AND label = ?',
      )
      .get(TENANT_A, MEMBER_ID, 'axis-seat') as {
      harness: string
      machine: string
      model: string
      provider: string
      effort: string
    }

    expect(row).toMatchObject({
      harness: 'cursor-ide',
      machine: 'hadi-mac',
      model: 'claude-3-7-sonnet',
      provider: 'anthropic',
      effort: 'high',
    })
  })

  it('tenant isolation: check-in in one tenant does not refresh another tenant fleet row', async () => {
    seedFleetRow(harness.sqlite, TENANT_A, AGENT_ID, STALE)
    seedFleetRow(harness.sqlite, TENANT_B, AGENT_ID, STALE)

    await recordCheckin(
      env,
      { memberId: MEMBER_ID, displayName: 'Test Agent', email: null, boundAgentId: AGENT_ID },
      { seat: 'tenant-a-seat' },
    )

    expect(fleetLastReported(harness.sqlite, TENANT_A, AGENT_ID)).not.toBe(STALE)
    expect(fleetLastReported(harness.sqlite, TENANT_B, AGENT_ID)).toBe(STALE)
  })
})

describe('bridgeCheckinToFleet (direct)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMemberAndAgent(harness.sqlite, TENANT_A)
    env = { DB: harness.db, TENANT_SLUG: TENANT_A } as unknown as Env
  })

  afterEach(() => harness.close())

  it('no-ops when boundAgentId is null', async () => {
    seedFleetRow(harness.sqlite, TENANT_A, AGENT_ID, STALE)
    await bridgeCheckinToFleet(env, { memberId: MEMBER_ID, displayName: 'Op', email: null, boundAgentId: null })
    expect(fleetLastReported(harness.sqlite, TENANT_A, AGENT_ID)).toBe(STALE)
  })
})
