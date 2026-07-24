import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveTaskAssignee } from '../src/tasks/assignee'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-a'
const HOME_SQUAD_ID = 'squad-home'
const TARGET_SQUAD_ID = 'squad-target'
const HOME_AGENT_ID = 'agent-home'
const CROSS_AGENT_ID = 'agent-cross'
const MEMBER_ID = 'member-cross'
const OUTSIDE = { value: null, error: 'assignee_not_in_squad' } as const

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    CREATE TABLE squads (id TEXT PRIMARY KEY, department_id TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, squad_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE members (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE member_tokens (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tenant TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE agent_member_bindings (
      tenant TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tenant, agent_id),
      UNIQUE (tenant, member_id)
    );
    CREATE TABLE capabilities (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      capability TEXT NOT NULL
    );
    CREATE TABLE channel_capability_grants (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      squad_id TEXT NOT NULL,
      capability TEXT NOT NULL
    );
  `)
}

function addSquad(sqlite: SqliteD1Harness['sqlite'], id: string, departmentId: string): void {
  sqlite.prepare('INSERT INTO squads (id, department_id) VALUES (?, ?)').run(id, departmentId)
}

function addAgent(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  squadId: string,
  status = 'active',
): void {
  sqlite.prepare('INSERT INTO agents (id, squad_id, status) VALUES (?, ?, ?)').run(id, squadId, status)
}

function addMember(
  sqlite: SqliteD1Harness['sqlite'],
  id = MEMBER_ID,
  tenant = TENANT,
  status = 'active',
): void {
  sqlite.prepare('INSERT INTO members (id, tenant, status) VALUES (?, ?, ?)').run(id, tenant, status)
}

function addToken(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  memberId = MEMBER_ID,
  options: { tenant?: string; revokedAt?: string | null } = {},
): void {
  sqlite.prepare(
    'INSERT INTO member_tokens (id, member_id, agent_id, tenant, revoked_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, memberId, CROSS_AGENT_ID, options.tenant ?? TENANT, options.revokedAt ?? null)
}

function bindAgent(
  sqlite: SqliteD1Harness['sqlite'],
  memberId = MEMBER_ID,
): void {
  sqlite.prepare(
    `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(TENANT, CROSS_AGENT_ID, memberId, '2026-07-24T00:00:00.000Z')
}

function addGrant(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  scopeType: 'org' | 'department' | 'squad',
  scopeId: string | null,
  capability: 'owner' | 'admin' | 'lead' | 'member' | 'observer' = 'member',
): void {
  sqlite.prepare(
    'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)',
  ).run(id, MEMBER_ID, scopeType, scopeId, capability)
}

describe('resolveTaskAssignee — SQLite capability matrix', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    createSchema(harness.sqlite)
    addSquad(harness.sqlite, HOME_SQUAD_ID, 'department-home')
    addSquad(harness.sqlite, TARGET_SQUAD_ID, 'department-target')
    addAgent(harness.sqlite, HOME_AGENT_ID, HOME_SQUAD_ID)
    addAgent(harness.sqlite, CROSS_AGENT_ID, HOME_SQUAD_ID)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  })

  afterEach(() => harness.close())

  it('accepts an active home-squad agent without a member token', async () => {
    await expect(resolveTaskAssignee(env, HOME_AGENT_ID, HOME_SQUAD_ID)).resolves.toEqual({ value: HOME_AGENT_ID })
  })

  it.each([
    ['exact squad', () => addGrant(harness.sqlite, 'grant-squad', 'squad', TARGET_SQUAD_ID)],
    ['department', () => addGrant(harness.sqlite, 'grant-department', 'department', 'department-target')],
    ['org', () => addGrant(harness.sqlite, 'grant-org', 'org', null)],
    ['channel member', () => harness.sqlite.prepare(
      'INSERT INTO channel_capability_grants (id, member_id, squad_id, capability) VALUES (?, ?, ?, ?)',
    ).run('grant-channel', MEMBER_ID, TARGET_SQUAD_ID, 'member')],
  ])('accepts a cross-squad agent with %s member authority', async (_name, grant) => {
    addMember(harness.sqlite)
    bindAgent(harness.sqlite)
    addToken(harness.sqlite, 'token-primary')
    grant()

    await expect(resolveTaskAssignee(env, CROSS_AGENT_ID, TARGET_SQUAD_ID)).resolves.toEqual({ value: CROSS_AGENT_ID })
  })

  it('accepts duplicate live tokens that resolve to one member identity', async () => {
    addMember(harness.sqlite)
    bindAgent(harness.sqlite)
    addToken(harness.sqlite, 'token-one')
    addToken(harness.sqlite, 'token-two')
    addGrant(harness.sqlite, 'grant-squad', 'squad', TARGET_SQUAD_ID)

    await expect(resolveTaskAssignee(env, CROSS_AGENT_ID, TARGET_SQUAD_ID)).resolves.toEqual({ value: CROSS_AGENT_ID })
  })

  it('keeps cross-squad authority after every credential is revoked', async () => {
    addMember(harness.sqlite)
    bindAgent(harness.sqlite)
    addToken(harness.sqlite, 'token-revoked', MEMBER_ID, {
      revokedAt: '2026-07-12T00:00:00.000Z',
    })
    addGrant(harness.sqlite, 'grant-squad', 'squad', TARGET_SQUAD_ID)

    await expect(resolveTaskAssignee(env, CROSS_AGENT_ID, TARGET_SQUAD_ID)).resolves.toEqual({
      value: CROSS_AGENT_ID,
    })
  })

  it('rejects inactive agents even when their home squad matches', async () => {
    harness.sqlite.prepare("UPDATE agents SET status = 'paused' WHERE id = ?").run(HOME_AGENT_ID)

    await expect(resolveTaskAssignee(env, HOME_AGENT_ID, HOME_SQUAD_ID)).resolves.toEqual(OUTSIDE)
  })

  it('fails closed for cross-squad identities and insufficient grants', async () => {
    const cases: Array<{ name: string; seed: () => void }> = [
      {
        name: 'no canonical binding',
        seed: () => {
          addMember(harness.sqlite)
          addToken(harness.sqlite, 'token-primary')
          addGrant(harness.sqlite, 'grant-squad', 'squad', TARGET_SQUAD_ID)
        },
      },
      {
        name: 'observer-only grant',
        seed: () => {
          addMember(harness.sqlite)
          bindAgent(harness.sqlite)
          addToken(harness.sqlite, 'token-primary')
          addGrant(harness.sqlite, 'grant-observer', 'squad', TARGET_SQUAD_ID, 'observer')
        },
      },
      {
        name: 'no grant',
        seed: () => {
          addMember(harness.sqlite)
          bindAgent(harness.sqlite)
          addToken(harness.sqlite, 'token-primary')
        },
      },
    ]

    for (const testCase of cases) {
      harness.close()
      harness = createSqliteD1()
      createSchema(harness.sqlite)
      addSquad(harness.sqlite, HOME_SQUAD_ID, 'department-home')
      addSquad(harness.sqlite, TARGET_SQUAD_ID, 'department-target')
      addAgent(harness.sqlite, HOME_AGENT_ID, HOME_SQUAD_ID)
      addAgent(harness.sqlite, CROSS_AGENT_ID, HOME_SQUAD_ID)
      env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
      testCase.seed()

      await expect(resolveTaskAssignee(env, CROSS_AGENT_ID, TARGET_SQUAD_ID)).resolves.toEqual(OUTSIDE)
    }
  })

  it('rejects a future assignment after the last effective grant is revoked', async () => {
    addMember(harness.sqlite)
    bindAgent(harness.sqlite)
    addToken(harness.sqlite, 'token-primary')
    addGrant(harness.sqlite, 'grant-squad', 'squad', TARGET_SQUAD_ID)

    await expect(resolveTaskAssignee(env, CROSS_AGENT_ID, TARGET_SQUAD_ID)).resolves.toEqual({ value: CROSS_AGENT_ID })
    harness.sqlite.prepare('DELETE FROM capabilities WHERE id = ?').run('grant-squad')
    await expect(resolveTaskAssignee(env, CROSS_AGENT_ID, TARGET_SQUAD_ID)).resolves.toEqual(OUTSIDE)
  })
})
