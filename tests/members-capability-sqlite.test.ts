import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resolveActiveAgentMember,
  upsertActiveAgentCapabilityGrant,
  upsertCapabilityGrant,
} from '../src/members/service'
import type { CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-a'
const AGENT_ID = 'agent-product'
const TARGET_SQUAD_ID = 'squad-other'

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
      tenant TEXT NOT NULL
    );
    CREATE TABLE member_tokens (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id),
      token_hash TEXT NOT NULL UNIQUE,
      agent_id TEXT,
      tenant TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE capabilities (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('org', 'department', 'squad')),
      scope_id TEXT,
      capability TEXT NOT NULL CHECK (capability IN ('owner', 'admin', 'lead', 'member', 'observer')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (member_id, scope_type, scope_id)
    );
  `)
}

function addMember(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  tenant = TENANT,
  status: 'active' | 'suspended' = 'active',
): void {
  sqlite.prepare('INSERT INTO members (id, display_name, status, tenant) VALUES (?, ?, ?, ?)')
    .run(id, id, status, tenant)
}

function addToken(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  memberId: string,
  options: { tenant?: string; agentId?: string; revokedAt?: string | null } = {},
): void {
  sqlite.prepare(
    `INSERT INTO member_tokens (id, member_id, token_hash, agent_id, tenant, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    memberId,
    `hash-${id}`,
    options.agentId ?? AGENT_ID,
    options.tenant ?? TENANT,
    options.revokedAt ?? null,
  )
}

function readTargetGrants(sqlite: SqliteD1Harness['sqlite']): Array<{ id: string; capability: string }> {
  return sqlite.prepare(
    `SELECT id, capability FROM capabilities
      WHERE member_id = 'member-product' AND scope_type = 'squad' AND scope_id = ?
      ORDER BY id`,
  ).all(TARGET_SQUAD_ID) as Array<{ id: string; capability: string }>
}

describe('SQLite-backed capability grant state', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    createSchema(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  })

  afterEach(() => harness.close())

  it('filters cross-tenant, revoked, and inactive identities in real SQLite state', async () => {
    addMember(harness.sqlite, 'member-product')
    addMember(harness.sqlite, 'member-other-tenant', 'tenant-b')
    addMember(harness.sqlite, 'member-token-other-tenant')
    addMember(harness.sqlite, 'member-inactive', TENANT, 'suspended')
    addMember(harness.sqlite, 'member-revoked')
    addToken(harness.sqlite, 'token-product', 'member-product')
    addToken(harness.sqlite, 'token-member-other-tenant', 'member-other-tenant')
    addToken(harness.sqlite, 'token-other-tenant', 'member-token-other-tenant', { tenant: 'tenant-b' })
    addToken(harness.sqlite, 'token-inactive', 'member-inactive')
    addToken(harness.sqlite, 'token-revoked', 'member-revoked', { revokedAt: '2026-07-12T00:00:00.000Z' })

    await expect(resolveActiveAgentMember(env, AGENT_ID)).resolves.toBe('member-product')
  })

  it('rejects a changed or ambiguous binding in the same statement without mutating the grant', async () => {
    addMember(harness.sqlite, 'member-product')
    addMember(harness.sqlite, 'member-second')
    addToken(harness.sqlite, 'token-product', 'member-product')
    harness.sqlite.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('grant-before', 'member-product', 'squad', ?, 'observer')`,
    ).run(TARGET_SQUAD_ID)

    const expectedMemberId = await resolveActiveAgentMember(env, AGENT_ID)
    expect(expectedMemberId).toBe('member-product')
    addToken(harness.sqlite, 'token-second', 'member-second')

    await expect(upsertActiveAgentCapabilityGrant(env, {
      agentId: AGENT_ID,
      expectedMemberId: expectedMemberId as string,
      squadId: TARGET_SQUAD_ID,
      capability: 'member',
    })).resolves.toBeNull()
    expect(readTargetGrants(harness.sqlite)).toEqual([{ id: 'grant-before', capability: 'observer' }])
  })

  it('classifies created, unchanged, and updated from the committed guarded upsert', async () => {
    addMember(harness.sqlite, 'member-product')
    addToken(harness.sqlite, 'token-product', 'member-product')
    const input = {
      agentId: AGENT_ID,
      expectedMemberId: 'member-product',
      squadId: TARGET_SQUAD_ID,
      capability: 'member' as const,
    }

    await expect(upsertActiveAgentCapabilityGrant(env, input)).resolves.toMatchObject({ result: 'created' })
    await expect(upsertActiveAgentCapabilityGrant(env, input)).resolves.toMatchObject({ result: 'unchanged' })
    await expect(upsertActiveAgentCapabilityGrant(env, {
      ...input,
      capability: 'lead',
    })).resolves.toMatchObject({ result: 'updated' })
    expect(readTargetGrants(harness.sqlite)).toEqual([
      { id: expect.any(String) as string, capability: 'lead' },
    ])
  })

  it('consolidates duplicate NULL-scope grants and persists one row after regrant', async () => {
    addMember(harness.sqlite, 'member-product')
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('grant-a', 'member-product', 'org', NULL, 'member');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('grant-b', 'member-product', 'org', NULL, 'observer');
    `)
    const grant: CapabilityGrant = {
      member_id: 'member-product',
      scope_type: 'org',
      scope_id: null,
      capability: 'member',
    }

    await expect(upsertCapabilityGrant(env, grant)).resolves.toMatchObject({ result: 'updated' })
    expect(harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = 'member-product' AND scope_type = 'org' AND scope_id IS NULL`,
    ).all()).toEqual([{ capability: 'member' }])

    await expect(upsertCapabilityGrant(env, grant)).resolves.toMatchObject({ result: 'unchanged' })
    expect(harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = 'member-product' AND scope_type = 'org' AND scope_id IS NULL`,
    ).all()).toEqual([{ capability: 'member' }])
  })

  it('rolls back the delete when the replacement insert fails', async () => {
    addMember(harness.sqlite, 'member-product')
    harness.sqlite.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES ('grant-before', 'member-product', 'squad', ?, 'observer')`,
    ).run(TARGET_SQUAD_ID)
    const invalidGrant = {
      member_id: 'member-product',
      scope_type: 'squad',
      scope_id: TARGET_SQUAD_ID,
      capability: 'invalid',
    } as unknown as CapabilityGrant

    await expect(upsertCapabilityGrant(env, invalidGrant)).rejects.toThrow()
    expect(readTargetGrants(harness.sqlite)).toEqual([{ id: 'grant-before', capability: 'observer' }])
  })
})
