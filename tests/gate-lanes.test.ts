import { describe, expect, it } from 'vitest'
import {
  COUNCIL_GATE_LANES,
  COUNCIL_GATE_LANE_VALUES,
  councilGateLaneFor,
  GATE_ATHENA,
} from '../src/gates/lanes'
import { loadGateWakeNotices, resolveSoleGateOwnerAgent } from '../src/gates/grants'
import { isValidGateOwnerForm } from '../src/tasks/service'
import { TASK_SELECT_COLUMNS } from '../src/tasks/ranking'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env, Task } from '../src/types'

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

  function seedPrincipalTables(harness: SqliteD1Harness): void {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Department');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad-1', 'Squad');
    `)
  }

  function seedAgent(harness: SqliteD1Harness, id: string, status: 'active' | 'paused' | 'inactive' = 'active'): void {
    harness.sqlite.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?, 'squad-1', ?, ?, ?)`,
    ).run(id, id, id, status)
  }

  function seedMember(harness: SqliteD1Harness, id: string, status: 'active' | 'suspended' = 'active'): void {
    harness.sqlite.prepare(
      `INSERT INTO members (id, display_name, status) VALUES (?, ?, ?)`,
    ).run(id, id, status)
  }

  function seedGrant(harness: SqliteD1Harness, id: string, capability: string, principalType: 'agent' | 'member', principalId: string): void {
    harness.sqlite.prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES (?, ?, ?, ?, 'owner-1', '2026-08-15T00:00:00.000Z')`,
    ).run(id, capability, principalType, principalId)
  }

  it('resolveSoleGateOwnerAgent routes gate:athena to its single agent holder', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedPrincipalTables(harness)
    seedAgent(harness, 'agent-athena')
    seedGrant(harness, 'g1', 'gate:athena', 'agent', 'agent-athena')

    expect(await resolveSoleGateOwnerAgent({ DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env, 'gate:athena'))
      .toMatchObject({
        status: 'resolved',
        capability: 'gate:athena',
        principal: { type: 'agent', id: 'agent-athena' },
      })
    harness.close()
  })

  it('retired leftover does not poison a live holder', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedPrincipalTables(harness)
    seedAgent(harness, 'agent-retired', 'inactive')
    seedAgent(harness, 'agent-live')
    seedGrant(harness, 'g1', 'gate:river', 'agent', 'agent-retired')
    seedGrant(harness, 'g2', 'gate:river', 'agent', 'agent-live')

    expect(await resolveSoleGateOwnerAgent({ DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env, 'gate:river'))
      .toMatchObject({
        status: 'resolved',
        capability: 'gate:river',
        principal: { type: 'agent', id: 'agent-live' },
        inactive_holders: [{ type: 'agent', id: 'agent-retired' }],
      })
    harness.close()
  })

  it('two live holders return a loud capability-scoped ambiguity', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedPrincipalTables(harness)
    seedAgent(harness, 'agent-live-a')
    seedAgent(harness, 'agent-live-b')
    seedGrant(harness, 'g1', 'gate:kayhermes', 'agent', 'agent-live-a')
    seedGrant(harness, 'g2', 'gate:kayhermes', 'agent', 'agent-live-b')

    expect(await resolveSoleGateOwnerAgent({ DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env, 'gate:kayhermes'))
      .toMatchObject({
        status: 'ambiguous',
        capability: 'gate:kayhermes',
        active_holders: [
          { type: 'agent', id: 'agent-live-a' },
          { type: 'agent', id: 'agent-live-b' },
        ],
      })
    harness.close()
  })

  it('corpse-only grants return no_live_holder instead of a wake target', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedPrincipalTables(harness)
    seedAgent(harness, 'agent-corpse', 'inactive')
    seedGrant(harness, 'g1', 'gate:hadi-river', 'agent', 'agent-corpse')

    expect(await resolveSoleGateOwnerAgent({ DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env, 'gate:hadi-river'))
      .toMatchObject({
        status: 'no_live_holder',
        capability: 'gate:hadi-river',
        grant_count: 1,
        inactive_holders: [{ type: 'agent', id: 'agent-corpse' }],
      })
    harness.close()
  })

  it('member-held gate is a distinct resolved principal, not an absent agent grant', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedMember(harness, 'member-hadi')
    seedGrant(harness, 'g1', 'gate:hadi', 'member', 'member-hadi')

    expect(await resolveSoleGateOwnerAgent({ DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env, 'gate:hadi'))
      .toMatchObject({
        status: 'resolved',
        capability: 'gate:hadi',
        principal: { type: 'member', id: 'member-hadi' },
      })
    harness.close()
  })

  it('absent gate:agent-self-completion is visible as no_live_holder', async () => {
    const harness2 = createSqliteD1()
    applyAllMigrations(harness2.sqlite)
    expect(await resolveSoleGateOwnerAgent(
      { DB: harness2.db, TENANT_SLUG: 'mumega' } as unknown as Env,
      'gate:agent-self-completion',
    )).toMatchObject({
      status: 'no_live_holder',
      capability: 'gate:agent-self-completion',
      grant_count: 0,
      inactive_holders: [],
    })
    harness2.close()
  })

  it('persists gate wake outcomes on the task projection an operator reads', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedPrincipalTables(harness)
    harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner)
       VALUES ('task-wake-visible', 'squad-1', 'Gate wake', 'body', 'wake is visible', 'review', 'gate:kayhermes')`,
    ).run()

    const taskColumns = harness.sqlite.prepare(`PRAGMA table_info(tasks)`).all()
      .map((row) => String(row.name))
    expect(taskColumns).toContain('gate_wake_notice')
    expect(TASK_SELECT_COLUMNS).not.toContain('gate_wake_notice')

    harness.sqlite.prepare(
      `UPDATE tasks SET gate_wake_notice = ? WHERE id = ?`,
    ).run('Gate wake ambiguous: gate:kayhermes has two live holders; operator decision required.', 'task-wake-visible')

    const row = harness.sqlite.prepare(`SELECT gate_wake_notice FROM tasks WHERE id = ?`)
      .get('task-wake-visible') as { gate_wake_notice: string }
    expect(row.gate_wake_notice).toContain('gate:kayhermes')
    expect(row.gate_wake_notice).toContain('operator decision required')
    const hydrated = await loadGateWakeNotices(
      { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env,
      [{ id: 'task-wake-visible' } as Task],
    )
    expect(hydrated[0].gate_wake_notice).toContain('operator decision required')
    harness.close()
  })
})
