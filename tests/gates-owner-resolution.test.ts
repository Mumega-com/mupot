// mupot — resolveGateOwner / resolveGateOwners (Flight-008 Slice 2, mupot#1061,
// Safe Approvals Triage). Real SQLite-backed D1 (all migrations applied) so the
// resolution logic is proved against the actual gate_grants/agents/members
// schema, not a hand-rolled mock shape.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveGateOwner, resolveGateOwners } from '../src/gates/grants'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Alpha');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('agent-active', 'squad-a', 'athena', 'Athena', 'active'),
      ('agent-paused', 'squad-a', 'paused-bot', 'Paused Bot', 'paused'),
      ('agent-second', 'squad-a', 'second-bot', 'Second Bot', 'active');
    INSERT INTO members (id, email, display_name, status) VALUES
      ('member-active', 'active@test.com', 'Ada Active', 'active'),
      ('member-suspended', 'suspended@test.com', 'Sam Suspended', 'suspended');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES
      ('grant-1', 'gate:athena', 'agent', 'agent-active', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-2', 'gate:paused', 'agent', 'agent-paused', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-3', 'gate:duo', 'agent', 'agent-active', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-4', 'gate:duo', 'agent', 'agent-second', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-5', 'gate:human', 'member', 'member-active', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-6', 'gate:suspended-human', 'member', 'member-suspended', 'member-active', '2026-08-01T00:00:00.000Z');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
}

describe('resolveGateOwner', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('gate_owner === null → absent, unresolvable', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), null)
    expect(result.resolvable).toBe(false)
    if (!result.resolvable) {
      expect(result.reason).toBe('absent')
      expect(result.holder).toBeNull()
    }
  })

  it('capability with zero grants → no_grant, unresolvable', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:nobody')
    expect(result.resolvable).toBe(false)
    if (!result.resolvable) expect(result.reason).toBe('no_grant')
  })

  it('capability with exactly one ACTIVE agent grant → resolvable, named', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:athena')
    expect(result.resolvable).toBe(true)
    if (result.resolvable) {
      expect(result.holder.principalType).toBe('agent')
      expect(result.holder.principalId).toBe('agent-active')
      expect(result.holder.displayName).toBe('Athena')
      expect(result.holder.active).toBe(true)
    }
  })

  it('capability with exactly one ACTIVE member grant → resolvable, named (humans hold gates too)', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:human')
    expect(result.resolvable).toBe(true)
    if (result.resolvable) {
      expect(result.holder.principalType).toBe('member')
      expect(result.holder.displayName).toBe('Ada Active')
    }
  })

  it('capability granted to a PAUSED agent → inactive, unresolvable (stale owner)', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:paused')
    expect(result.resolvable).toBe(false)
    if (!result.resolvable) {
      expect(result.reason).toBe('inactive')
      expect(result.holder?.principalId).toBe('agent-paused')
      expect(result.holder?.active).toBe(false)
    }
  })

  it('capability granted to a SUSPENDED member → inactive, unresolvable', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:suspended-human')
    expect(result.resolvable).toBe(false)
    if (!result.resolvable) expect(result.reason).toBe('inactive')
  })

  it('capability granted to TWO principals → multiple_grants, unresolvable (no unambiguous owner)', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:duo')
    expect(result.resolvable).toBe(false)
    if (!result.resolvable) {
      expect(result.reason).toBe('multiple_grants')
      expect(result.holder).toBeNull()
    }
  })
})

describe('resolveGateOwners (batch)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('resolves several capabilities, de-duplicated, in one call', async () => {
    harness = makeHarness()
    const map = await resolveGateOwners(envFor(harness), [
      'gate:athena', 'gate:athena', 'gate:paused', null, 'gate:nobody',
    ])
    expect(map.size).toBe(3) // distinct non-null capabilities only
    expect(map.get('gate:athena')?.resolvable).toBe(true)
    expect(map.get('gate:paused')?.resolvable).toBe(false)
    expect(map.get('gate:nobody')?.resolvable).toBe(false)
  })

  it('empty input → empty map, no query', async () => {
    harness = makeHarness()
    const map = await resolveGateOwners(envFor(harness), [])
    expect(map.size).toBe(0)
  })
})
