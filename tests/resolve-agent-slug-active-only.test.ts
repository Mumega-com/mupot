// tests/resolve-agent-slug-active-only.test.ts — mupot#702.
//
// A slug resolves only against NON-TOMBSTONE agents (active or paused); an id resolves
// against any agent, including inactive ones.
//
// The bug: agents.slug is UNIQUE(squad_id, slug) and a deactivated row keeps its slug
// forever, so every deactivation left a permanent land-mine. The dead row did nothing but
// still COUNTED toward ambiguity, and `agent: "kasra"` failed with ambiguous_slug against
// a row switched off weeks earlier. Measured in production: all three duplicate pairs were
// a live agent shadowed by its own tombstone, not a real collision.
//
// The schema here comes from the committed migrations, not a hand-written CREATE TABLE.
// This test asserts on which ROW a capability-gating resolver picks; a fixture I typed
// myself would be my belief about `agents`, and #684 is what that costs.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { resolveAgentRef } from '../src/org/resolve'
import type { Env } from '../src/types'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const failures: string[] = []
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (error) {
      failures.push(`${file}: ${String(error)}`)
    }
  }
  // Fail closed: a swallowed migration error builds a schema that is not production's.
  if (failures.length > 0) throw new Error(`migrations did not apply cleanly:\n${failures.join('\n')}`)
}

let harness: SqliteD1Harness
let env: Env

function squad(id: string): void {
  harness.sqlite.exec(
    `INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('${id}-dept', '${id}-dept', '${id}-dept');
     INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${id}', '${id}-dept', '${id}', '${id}');`,
  )
}

function agent(id: string, slug: string, squadId: string, status: 'active' | 'paused' | 'inactive'): void {
  squad(squadId)
  harness.sqlite.exec(
    `INSERT INTO agents (id, squad_id, slug, name, status)
     VALUES ('${id}', '${squadId}', '${slug}', '${slug}', '${status}')`,
  )
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env
})

afterEach(() => harness.close())

describe('resolveAgentRef — a tombstone must not shadow a live agent (mupot#702)', () => {
  it('the production case: one inactive + one active resolves to the ACTIVE row', async () => {
    // Exactly the live shape: ea2b0370 inactive (older) + c855f82c active (newer).
    agent('ea2b0370', 'kasra', '813ca010', 'inactive')
    agent('c855f82c', 'kasra', 'squad-core', 'active')

    const resolved = await resolveAgentRef(env, 'kasra')

    expect(resolved.ok).toBe(true)
    // Asserting the exact id, not merely `ok`: picking the WRONG row still resolves, and
    // the row's squad_id then drives a capability check and which agent a credential binds
    // to. "It resolved" is not the property — "it resolved to the live one" is.
    expect(resolved.ok && resolved.value.id).toBe('c855f82c')
    expect(resolved.ok && resolved.value.squad_id).toBe('squad-core')
  })

  it('FAIL-CLOSED PRESERVED: two ACTIVE agents sharing a slug are still ambiguous', async () => {
    // The self-poisoning defect this resolver exists to prevent. The status filter narrows
    // what a slug may match; it must never turn a real collision into an arbitrary pick.
    agent('active-a', 'twin', 'squad-a', 'active')
    agent('active-b', 'twin', 'squad-b', 'active')

    const resolved = await resolveAgentRef(env, 'twin')

    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.reason).toBe('ambiguous')
  })

  it('a slug matching only deactivated rows is not_found, not ambiguous', async () => {
    // The live `cursor` shape: both rows inactive. Both outcomes are refusals; not_found
    // is the truthful one for an agent nobody has activated.
    agent('cur-1', 'cursor', 'squad-x', 'inactive')
    agent('cur-2', 'cursor', 'squad-y', 'inactive')

    const resolved = await resolveAgentRef(env, 'cursor')

    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.reason).toBe('not_found')
  })

  it('an INACTIVE agent is still addressable BY ID — deactivated is not deleted', async () => {
    // An operator must be able to inspect, reactivate, or merge a deactivated row. #705
    // makes this load-bearing: recall filters by agentId, so an agent row owns engrams.
    // If a deactivated row became unaddressable, its memory would be unreachable.
    agent('ea2b0370', 'kasra', '813ca010', 'inactive')

    const resolved = await resolveAgentRef(env, 'ea2b0370')

    expect(resolved.ok).toBe(true)
    expect(resolved.ok && resolved.value.id).toBe('ea2b0370')
  })

  it('a PAUSED agent is still slug-addressable — paused is not a tombstone', async () => {
    // agents.status is CHECK IN ('active','paused','inactive'). `paused` is a live agent
    // that is temporarily stopped; you address it by slug precisely to resume, inspect or
    // reassign it. An `= 'active'` predicate would have made every paused agent
    // unaddressable — trading one silent breakage for another. Found by the diverse gate.
    agent('paused-1', 'napping', 'squad-nap', 'paused')
    agent('dead-1', 'napping', 'squad-dead', 'inactive')

    const resolved = await resolveAgentRef(env, 'napping')

    expect(resolved.ok).toBe(true)
    expect(resolved.ok && resolved.value.id).toBe('paused-1')
  })

  it('paused + active sharing a slug is a REAL collision and stays ambiguous', async () => {
    // Both rows are live. Excluding tombstones must not collapse a genuine collision into
    // an arbitrary pick — that is the self-poisoning defect this resolver exists to stop.
    agent('act-1', 'both', 'squad-1', 'active')
    agent('pau-1', 'both', 'squad-2', 'paused')

    const resolved = await resolveAgentRef(env, 'both')

    expect(resolved.ok).toBe(false)
    expect(!resolved.ok && resolved.reason).toBe('ambiguous')
  })

  it('a single active agent still resolves by slug (no regression)', async () => {
    agent('solo-1', 'solo', 'squad-solo', 'active')
    const resolved = await resolveAgentRef(env, 'solo')
    expect(resolved.ok && resolved.value.id).toBe('solo-1')
  })

  it('an unknown slug is not_found', async () => {
    const resolved = await resolveAgentRef(env, 'nobody-here')
    expect(!resolved.ok && resolved.reason).toBe('not_found')
  })
})
