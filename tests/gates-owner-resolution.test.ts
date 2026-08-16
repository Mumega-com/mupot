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
      -- gate:duo mirrors docs/gate-protocol.md §10 (Appendix B) — the real
      -- production shape of gate:routines: TWO active holders, intended, not
      -- ambiguous.
      ('grant-3', 'gate:duo', 'agent', 'agent-active', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-4', 'gate:duo', 'agent', 'agent-second', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-5', 'gate:human', 'member', 'member-active', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-6', 'gate:suspended-human', 'member', 'member-suspended', 'member-active', '2026-08-01T00:00:00.000Z'),
      -- gate:mixed — one active holder, one paused holder. Resolvable via the
      -- active one; the paused holder must not sink the whole capability.
      ('grant-7', 'gate:mixed', 'agent', 'agent-active', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-8', 'gate:mixed', 'agent', 'agent-paused', 'member-active', '2026-08-01T00:00:00.000Z'),
      -- gate:all-inactive — every grant points at a non-active principal —
      -- the true "wall with no door" case, distinct from gate:duo/gate:mixed.
      ('grant-9', 'gate:all-inactive', 'agent', 'agent-paused', 'member-active', '2026-08-01T00:00:00.000Z'),
      ('grant-10', 'gate:all-inactive', 'member', 'member-suspended', 'member-active', '2026-08-01T00:00:00.000Z');
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
      expect(result.holders).toEqual([])
    }
  })

  it('capability with zero grants → no_grant, unresolvable', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:nobody')
    expect(result.resolvable).toBe(false)
    if (!result.resolvable) {
      expect(result.reason).toBe('no_grant')
      expect(result.holders).toEqual([])
    }
  })

  it('capability with exactly one ACTIVE agent grant → resolvable, named', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:athena')
    expect(result.resolvable).toBe(true)
    if (result.resolvable) {
      expect(result.holders).toHaveLength(1)
      expect(result.holders[0].principalType).toBe('agent')
      expect(result.holders[0].principalId).toBe('agent-active')
      expect(result.holders[0].displayName).toBe('Athena')
      expect(result.holders[0].active).toBe(true)
    }
  })

  it('capability with exactly one ACTIVE member grant → resolvable, named (humans hold gates too)', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:human')
    expect(result.resolvable).toBe(true)
    if (result.resolvable) {
      expect(result.holders).toHaveLength(1)
      expect(result.holders[0].principalType).toBe('member')
      expect(result.holders[0].displayName).toBe('Ada Active')
    }
  })

  it('capability granted to a PAUSED agent → inactive, unresolvable (stale owner)', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:paused')
    expect(result.resolvable).toBe(false)
    if (!result.resolvable) {
      expect(result.reason).toBe('inactive')
      expect(result.holders).toHaveLength(1)
      expect(result.holders[0].principalId).toBe('agent-paused')
      expect(result.holders[0].active).toBe(false)
    }
  })

  it('capability granted to a SUSPENDED member → inactive, unresolvable', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:suspended-human')
    expect(result.resolvable).toBe(false)
    if (!result.resolvable) expect(result.reason).toBe('inactive')
  })

  // Flight-008 Slice 2 correction (Athena+River adversarial gate, 2026-08-16):
  // docs/gate-protocol.md §10 (Appendix B) records that the REAL production
  // fix for gate:routines (which shipped with ZERO holders — a wall with no
  // door) was granting it to TWO principals, not narrowing to one. Multiple
  // active holders is the intended shape for a shared/committee gate lane —
  // it must resolve, listing every active holder, not collapse to unresolved.
  it('capability granted to TWO ACTIVE principals → resolvable, lists both holders (gate:routines precedent)', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:duo')
    expect(result.resolvable).toBe(true)
    if (result.resolvable) {
      expect(result.holders).toHaveLength(2)
      expect(result.holders.map((h) => h.principalId).sort()).toEqual(['agent-active', 'agent-second'])
      expect(result.holders.every((h) => h.active)).toBe(true)
    }
  })

  it('capability with ONE active + ONE paused holder → resolvable via the active one only', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:mixed')
    expect(result.resolvable).toBe(true)
    if (result.resolvable) {
      expect(result.holders).toHaveLength(1)
      expect(result.holders[0].principalId).toBe('agent-active')
    }
  })

  it('capability where EVERY grant is inactive → unresolved (the true wall-with-no-door case)', async () => {
    harness = makeHarness()
    const result = await resolveGateOwner(envFor(harness), 'gate:all-inactive')
    expect(result.resolvable).toBe(false)
    if (!result.resolvable) {
      expect(result.reason).toBe('inactive')
      expect(result.holders).toHaveLength(2)
      expect(result.holders.every((h) => !h.active)).toBe(true)
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
