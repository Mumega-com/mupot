import { describe, expect, it } from 'vitest'
import {
  COUNCIL_GATE_LANES,
  COUNCIL_GATE_LANE_VALUES,
  councilGateLaneFor,
  GATE_ATHENA,
} from '../src/gates/lanes'
import { resolveSoleGateOwnerAgent } from '../src/gates/grants'
import { isValidGateOwnerForm } from '../src/tasks/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

describe('Flight-006 Slice 3 — Athena gate lane weaving', () => {
  it('every council gate lane is a well-formed gate capability', () => {
    for (const lane of COUNCIL_GATE_LANE_VALUES) {
      expect(isValidGateOwnerForm(lane)).toBe(true)
    }
  })

  it('declares athena as the correctness/security gate lane', () => {
    expect(COUNCIL_GATE_LANES.athena.lane).toBe(GATE_ATHENA)
    expect(COUNCIL_GATE_LANES.athena.agentSlug).toBe('athena')
    expect(councilGateLaneFor('athena')).toBe(GATE_ATHENA)
    expect(councilGateLaneFor('river')).toBeNull()
  })

  function envWithGrants(harness: SqliteD1Harness, rows: Array<[string, string, string]>): Env {
    const insert = harness.sqlite.prepare(
      'INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const [id, capability, principalId] of rows) {
      insert.run(id, capability, 'agent', principalId, 'owner-1', '2026-08-15T00:00:00.000Z')
    }
    return { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
  }

  it('resolveSoleGateOwnerAgent routes gate:athena to its single agent holder', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envWithGrants(harness, [['g1', 'gate:athena', 'agent-athena']])

    expect(await resolveSoleGateOwnerAgent(env, 'gate:athena')).toBe('agent-athena')
    harness.close()
  })

  it('ambiguous or absent gate:athena holders resolve to null (fail-closed skip)', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envWithGrants(harness, [
      ['g1', 'gate:athena', 'agent-athena'],
      ['g2', 'gate:athena', 'agent-athena-2'],
    ])

    expect(await resolveSoleGateOwnerAgent(env, 'gate:athena')).toBeNull()

    const harness2 = createSqliteD1()
    applyAllMigrations(harness2.sqlite)
    expect(await resolveSoleGateOwnerAgent(
      { DB: harness2.db, TENANT_SLUG: 'mumega' } as unknown as Env,
      'gate:athena',
    )).toBeNull()

    harness.close()
    harness2.close()
  })
})
