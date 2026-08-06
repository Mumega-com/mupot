import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  prepareAgentSquadAccess,
  removeAgentSquadAccess,
  setAgentSquadAccess,
} from '../src/members/agent-access'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-a'
const AGENT_ID = 'agent-1'
const MEMBER_ID = 'member-1'
const HOME_SQUAD_ID = 'squad-home'
const TARGET_SQUAD_ID = 'squad-target'

function applyMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function seedBoundAgent(sqlite: SqliteD1Harness['sqlite'], bound = true): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${HOME_SQUAD_ID}', 'dept-1', 'home', 'Home'),
      ('${TARGET_SQUAD_ID}', 'dept-1', 'target', 'Target');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${AGENT_ID}', '${HOME_SQUAD_ID}', 'agent', 'Agent', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-home', '${AGENT_ID}', '${HOME_SQUAD_ID}', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Agent Member', 'active', '${TENANT}');
  `)
  if (bound) {
    sqlite.exec(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '2026-07-24T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('grant-home', '${MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'member');
    `)
  }
}

function count(
  sqlite: SqliteD1Harness['sqlite'],
  table: 'memberships' | 'capabilities',
  squadId = TARGET_SQUAD_ID,
): number {
  const predicate = table === 'memberships'
    ? 'agent_id = ? AND squad_id = ?'
    : "member_id = ? AND scope_type = 'squad' AND scope_id = ?"
  const principal = table === 'memberships' ? AGENT_ID : MEMBER_ID
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`)
    .get(principal, squadId) as { count: number }).count
}

describe('canonical agent squad access', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  })

  afterEach(() => harness.close())

  it('creates one neutral routing membership and one authoritative capability', async () => {
    seedBoundAgent(harness.sqlite)

    await expect(setAgentSquadAccess(env, {
      agentId: AGENT_ID,
      memberId: MEMBER_ID,
      squadId: TARGET_SQUAD_ID,
      capability: 'admin',
    })).resolves.toMatchObject({
      ok: true,
      result: 'created',
      membership: {
        agent_id: AGENT_ID,
        squad_id: TARGET_SQUAD_ID,
        capability: 'member',
      },
      grant: {
        member_id: MEMBER_ID,
        scope_type: 'squad',
        scope_id: TARGET_SQUAD_ID,
        capability: 'admin',
      },
    })
    expect(count(harness.sqlite, 'memberships')).toBe(1)
    expect(count(harness.sqlite, 'capabilities')).toBe(1)
  })

  it('is idempotent and updates only authoritative rank without duplicating rows', async () => {
    seedBoundAgent(harness.sqlite)
    const input = {
      agentId: AGENT_ID,
      memberId: MEMBER_ID,
      squadId: TARGET_SQUAD_ID,
      capability: 'member' as const,
    }

    await expect(setAgentSquadAccess(env, input)).resolves.toMatchObject({ ok: true, result: 'created' })
    await expect(setAgentSquadAccess(env, input)).resolves.toMatchObject({ ok: true, result: 'unchanged' })
    await expect(setAgentSquadAccess(env, {
      ...input,
      capability: 'lead',
    })).resolves.toMatchObject({
      ok: true,
      result: 'updated',
      membership: { capability: 'member' },
      grant: { capability: 'lead' },
    })
    expect(count(harness.sqlite, 'memberships')).toBe(1)
    expect(count(harness.sqlite, 'capabilities')).toBe(1)
  })

  it('refuses missing and mismatched canonical identities before writing', async () => {
    seedBoundAgent(harness.sqlite, false)
    await expect(setAgentSquadAccess(env, {
      agentId: AGENT_ID,
      memberId: MEMBER_ID,
      squadId: TARGET_SQUAD_ID,
      capability: 'member',
    })).resolves.toEqual({ ok: false, error: 'agent_identity_unminted' })
    expect(count(harness.sqlite, 'memberships')).toBe(0)

    harness.sqlite.exec(`
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '2026-07-24T00:00:00.000Z');
    `)
    await expect(setAgentSquadAccess(env, {
      agentId: AGENT_ID,
      memberId: 'member-wrong',
      squadId: TARGET_SQUAD_ID,
      capability: 'member',
    })).resolves.toEqual({ ok: false, error: 'agent_identity_conflict' })
    expect(count(harness.sqlite, 'memberships')).toBe(0)
  })

  it('permanently caps the home squad at observer or member', async () => {
    seedBoundAgent(harness.sqlite)

    for (const capability of ['lead', 'admin', 'owner'] as const) {
      await expect(setAgentSquadAccess(env, {
        agentId: AGENT_ID,
        memberId: MEMBER_ID,
        squadId: HOME_SQUAD_ID,
        capability,
      } as Parameters<typeof setAgentSquadAccess>[1])).resolves.toEqual({
        ok: false,
        error: 'home_capability_ceiling',
      })
    }
    expect(harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(MEMBER_ID, HOME_SQUAD_ID)).toEqual({ capability: 'member' })
  })

  it('removes both cross-squad representations but never removes home access', async () => {
    seedBoundAgent(harness.sqlite)
    await setAgentSquadAccess(env, {
      agentId: AGENT_ID,
      memberId: MEMBER_ID,
      squadId: TARGET_SQUAD_ID,
      capability: 'admin',
    })

    await expect(removeAgentSquadAccess(env, {
      agentId: AGENT_ID,
      memberId: MEMBER_ID,
      squadId: HOME_SQUAD_ID,
    })).resolves.toEqual({ ok: false, error: 'home_squad_immutable' })
    await expect(removeAgentSquadAccess(env, {
      agentId: AGENT_ID,
      memberId: MEMBER_ID,
      squadId: TARGET_SQUAD_ID,
    })).resolves.toMatchObject({ ok: true, result: 'removed' })
    expect(count(harness.sqlite, 'memberships')).toBe(0)
    expect(count(harness.sqlite, 'capabilities')).toBe(0)
  })

  it('rolls back the routing edge when the capability write fails', async () => {
    seedBoundAgent(harness.sqlite)
    harness.sqlite.exec(`
      CREATE TRIGGER fail_target_capability
      BEFORE INSERT ON capabilities
      WHEN NEW.scope_type = 'squad' AND NEW.scope_id = '${TARGET_SQUAD_ID}'
      BEGIN
        SELECT RAISE(ABORT, 'injected_access_failure');
      END;
    `)

    await expect(setAgentSquadAccess(env, {
      agentId: AGENT_ID,
      memberId: MEMBER_ID,
      squadId: TARGET_SQUAD_ID,
      capability: 'admin',
    })).rejects.toThrow('injected_access_failure')
    expect(count(harness.sqlite, 'memberships')).toBe(0)
    expect(count(harness.sqlite, 'capabilities')).toBe(0)
  })

  it('prepares guarded access statements behind a binding created in the same batch', async () => {
    seedBoundAgent(harness.sqlite, false)
    const prepared = await prepareAgentSquadAccess(env, {
      agentId: AGENT_ID,
      memberId: MEMBER_ID,
      squadId: TARGET_SQUAD_ID,
      capability: 'member',
    }, {
      agentId: AGENT_ID,
      memberId: MEMBER_ID,
      homeSquadId: HOME_SQUAD_ID,
      disposition: 'creating',
    })
    expect(prepared).toMatchObject({ ok: true, value: { resultAfterCommit: 'created' } })
    if (!prepared.ok) throw new Error(prepared.error)

    await harness.db.batch([
      harness.db.prepare(
        `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(TENANT, AGENT_ID, MEMBER_ID, '2026-07-24T00:00:00.000Z'),
      ...prepared.value.statements,
    ])
    expect(count(harness.sqlite, 'memberships')).toBe(1)
    expect(count(harness.sqlite, 'capabilities')).toBe(1)
  })
})
