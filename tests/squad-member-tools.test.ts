// tests/squad-member-tools.test.ts — mupot#1161
//
// Real migrations. Mutation-shaped: each authz refusal is a tool call that
// would succeed if authorizeSquadMembershipWrite dropped that check.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { invokeTool } from '../src/mcp'
import { authorizeSquadMembershipWrite } from '../src/members/squad-membership'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-test'
const DEPT_ID = 'dept-1'
const HOME_SQUAD_ID = 'squad-home'
const TARGET_SQUAD_ID = 'squad-target'
const OTHER_SQUAD_ID = 'squad-other'
const AGENT_ID = 'agent-kasra'
const CALLER_AGENT_ID = 'agent-hadi'
const OPERATOR_MEMBER_ID = 'member-operator'
const AGENT_MEMBER_ID = 'member-kasra'
const HADI_MEMBER_ID = 'member-hadi'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      sqlite.exec(sql)
    } catch (err) {
      const msg = String(err)
      if (!/already exists|duplicate column|no such (function|module)|near "PRAGMA"/i.test(msg)) {
        throw new Error(`migration ${file}: ${msg}`)
      }
    }
  }
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name)
    VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');

    INSERT INTO squads (id, department_id, slug, name)
    VALUES
      ('${HOME_SQUAD_ID}', '${DEPT_ID}', 'home', 'Home Squad'),
      ('${TARGET_SQUAD_ID}', '${DEPT_ID}', 'hadi-mac', 'Hadi Mac'),
      ('${OTHER_SQUAD_ID}', '${DEPT_ID}', 'other', 'Other Squad');

    INSERT INTO agents (id, squad_id, slug, name, status)
    VALUES
      ('${AGENT_ID}', '${HOME_SQUAD_ID}', 'kasra', 'Kasra', 'active'),
      ('${CALLER_AGENT_ID}', '${TARGET_SQUAD_ID}', 'hadi', 'Hadi', 'active');

    INSERT INTO members (id, display_name, status, tenant)
    VALUES
      ('${OPERATOR_MEMBER_ID}', 'Operator', 'active', '${TENANT}'),
      ('${AGENT_MEMBER_ID}', 'Kasra Member', 'active', '${TENANT}'),
      ('${HADI_MEMBER_ID}', 'Hadi Member', 'active', '${TENANT}');

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES
      ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER_ID}', '2026-08-18T00:00:00Z'),
      ('${TENANT}', '${CALLER_AGENT_ID}', '${HADI_MEMBER_ID}', '2026-08-18T00:00:00Z');

    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES
      ('cap-op-target-admin', '${OPERATOR_MEMBER_ID}', 'squad', '${TARGET_SQUAD_ID}', 'admin'),
      ('cap-op-home-admin', '${OPERATOR_MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'admin'),
      ('cap-hadi-target-lead', '${HADI_MEMBER_ID}', 'squad', '${TARGET_SQUAD_ID}', 'lead'),
      ('cap-kasra-home', '${AGENT_MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'member');

    INSERT INTO memberships (id, agent_id, squad_id, capability)
    VALUES
      ('mem-kasra-home', '${AGENT_ID}', '${HOME_SQUAD_ID}', 'member'),
      ('mem-hadi-target', '${CALLER_AGENT_ID}', '${TARGET_SQUAD_ID}', 'member');
  `)
}

function operatorAuth(): AuthContext {
  return {
    userId: OPERATOR_MEMBER_ID,
    memberId: OPERATOR_MEMBER_ID,
    email: 'op@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [
      {
        member_id: OPERATOR_MEMBER_ID,
        scope_type: 'squad',
        scope_id: TARGET_SQUAD_ID,
        capability: 'admin',
      },
      {
        member_id: OPERATOR_MEMBER_ID,
        scope_type: 'squad',
        scope_id: HOME_SQUAD_ID,
        capability: 'admin',
      },
    ],
  }
}

function leadAuth(): AuthContext {
  return {
    userId: HADI_MEMBER_ID,
    memberId: HADI_MEMBER_ID,
    email: 'hadi@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [
      {
        member_id: HADI_MEMBER_ID,
        scope_type: 'squad',
        scope_id: TARGET_SQUAD_ID,
        capability: 'lead',
      },
    ],
  }
}

function memberOnlyAuth(): AuthContext {
  return {
    userId: AGENT_MEMBER_ID,
    memberId: AGENT_MEMBER_ID,
    email: 'kasra@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [
      {
        member_id: AGENT_MEMBER_ID,
        scope_type: 'squad',
        scope_id: HOME_SQUAD_ID,
        capability: 'member',
      },
    ],
  }
}

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
})

afterEach(() => {
  harness.sqlite.close()
})

describe('squad_member_add / remove / list (mupot#1161)', () => {
  it('admin on the TARGET squad adds an agent and writes a receipt', async () => {
    const result = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.result).toMatchObject({
      agent: { id: AGENT_ID },
      squad: { id: TARGET_SQUAD_ID },
      capability: 'member',
      result: 'created',
    })

    const membership = harness.sqlite.prepare(
      'SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID) as { capability: string }
    expect(membership.capability).toBe('member')

    const grant = harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(AGENT_MEMBER_ID, TARGET_SQUAD_ID) as { capability: string }
    expect(grant.capability).toBe('member')

    const receipt = harness.sqlite.prepare(
      `SELECT action, target_agent_id, squad_id, capability, result
         FROM membership_receipts WHERE target_agent_id = ?`,
    ).get(AGENT_ID) as { action: string; squad_id: string; capability: string; result: string }
    expect(receipt.action).toBe('add')
    expect(receipt.squad_id).toBe(TARGET_SQUAD_ID)
    expect(receipt.capability).toBe('member')
    expect(receipt.result).toBe('created')
  })

  it('lead on the target can grant member but not admin', async () => {
    const memberGrant = await invokeTool(
      leadAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(memberGrant.ok).toBe(true)

    const adminGrant = await invokeTool(
      leadAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'admin' },
      'https://pot.test',
    )
    expect(adminGrant.ok).toBe(false)
    if (adminGrant.ok) return
    expect(adminGrant.error).toBe('cannot_grant_above_own_rank')
  })

  it('member on a different squad cannot add to the target', async () => {
    const result = await invokeTool(
      memberOnlyAuth(),
      env,
      'squad_member_add',
      { agent: CALLER_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('forbidden')
  })

  it('bound-agent callers cannot add — operator principal required', async () => {
    const boundLead: AuthContext = { ...leadAuth(), boundAgentId: CALLER_AGENT_ID }
    const added = await invokeTool(
      boundLead,
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(added.ok).toBe(false)
    if (added.ok) return
    expect(added.error).toBe('operator_principal_required')
  })

  it('refuses self-grant even for a lead on the target squad', async () => {
    const result = await invokeTool(
      leadAuth(),
      env,
      'squad_member_add',
      { agent: CALLER_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('self_grant')
  })

  it('refuses owner as a grantable capability', async () => {
    const result = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'owner' },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('invalid_capability')
  })

  it('remove deletes membership and the visibility join goes away', async () => {
    const added = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(added.ok).toBe(true)

    const removed = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_remove',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(removed.ok).toBe(true)

    const membership = harness.sqlite.prepare(
      'SELECT id FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)
    expect(membership).toBeUndefined()

    const grant = harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(AGENT_MEMBER_ID, TARGET_SQUAD_ID)
    expect(grant).toBeUndefined()

    const receipt = harness.sqlite.prepare(
      `SELECT action, result FROM membership_receipts
        WHERE target_agent_id = ? AND action = 'remove'`,
    ).get(AGENT_ID) as { action: string; result: string }
    expect(receipt.result).toBe('removed')
  })

  it('refuses removing the home-squad membership', async () => {
    const result = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_remove',
      { agent: AGENT_ID, squad: HOME_SQUAD_ID },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('home_squad_immutable')
  })

  it('list requires observer+ on the target and returns the added agent', async () => {
    await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'lead' },
      'https://pot.test',
    )
    const listed = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_list',
      { squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const members = (listed.result as { members: Array<{ agent_id: string; grant_capability: string }> }).members
    const kasra = members.find((row) => row.agent_id === AGENT_ID)
    expect(kasra?.grant_capability).toBe('lead')

    const stranger = await invokeTool(
      memberOnlyAuth(),
      env,
      'squad_member_list',
      { squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(stranger.ok).toBe(false)
    if (stranger.ok) return
    expect(stranger.error).toBe('forbidden')
  })

  it('authorizeSquadMembershipWrite goes red if the self-grant check is the thing being tested', async () => {
    const denial = await authorizeSquadMembershipWrite({
      env,
      auth: leadAuth(),
      targetAgentId: CALLER_AGENT_ID,
      squad: { id: TARGET_SQUAD_ID, department_id: DEPT_ID },
      requestedCapability: 'member',
    })
    expect(denial).toEqual({ ok: false, error: 'self_grant' })
  })

  it('authorizeSquadMembershipWrite refuses a member-rank caller on the target', async () => {
    const grants: CapabilityGrant[] = [
      {
        member_id: AGENT_MEMBER_ID,
        scope_type: 'squad',
        scope_id: TARGET_SQUAD_ID,
        capability: 'member',
      },
    ]
    const denial = await authorizeSquadMembershipWrite({
      env,
      auth: { ...memberOnlyAuth(), capabilities: grants },
      targetAgentId: CALLER_AGENT_ID,
      squad: { id: TARGET_SQUAD_ID, department_id: DEPT_ID },
      requestedCapability: 'member',
    })
    expect(denial).toEqual({ ok: false, error: 'forbidden' })
  })
})
