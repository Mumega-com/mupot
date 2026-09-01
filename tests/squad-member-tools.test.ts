// tests/squad-member-tools.test.ts — mupot#1161
//
// Real migrations. Mutation-shaped: each authz refusal is a tool call that
// would succeed if authorizeSquadMembershipWrite dropped that check.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { invokeTool } from '../src/mcp'
import { authorizeSquadMembershipWrite } from '../src/members/squad-membership'
import { deleteAgent } from '../src/org/service'
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

    const receipts = harness.sqlite.prepare(
      `SELECT actor_member_id, result FROM membership_receipts
        WHERE target_agent_id = ? AND action = 'remove' ORDER BY seq`,
    ).all(AGENT_ID) as Array<{ actor_member_id: string; result: string }>
    expect(receipts.every((row) => row.result === 'removed')).toBe(true)
    expect(receipts.map((row) => row.actor_member_id).sort()).toEqual(
      [OPERATOR_MEMBER_ID, 'system:cascade'].sort(),
    )
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
    expect(kasra?.membership_capability).toBe('lead')

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

  it('lead on the target may grant observer, member, and lead', async () => {
    for (const capability of ['observer', 'member', 'lead'] as const) {
      harness.sqlite.exec(
        `DELETE FROM memberships WHERE agent_id = '${AGENT_ID}' AND squad_id = '${TARGET_SQUAD_ID}';
         DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER_ID}' AND scope_id = '${TARGET_SQUAD_ID}';`,
      )
      const granted = await invokeTool(
        leadAuth(),
        env,
        'squad_member_add',
        { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability },
        'https://pot.test',
      )
      expect(granted.ok, capability).toBe(true)
    }
  })

  it('admin on the target may grant admin; lead may not', async () => {
    const byAdmin = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'admin' },
      'https://pot.test',
    )
    expect(byAdmin.ok).toBe(true)

    harness.sqlite.exec(
      `DELETE FROM memberships WHERE agent_id = '${AGENT_ID}' AND squad_id = '${TARGET_SQUAD_ID}';
       DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER_ID}' AND scope_id = '${TARGET_SQUAD_ID}';`,
    )
    const byLead = await invokeTool(
      leadAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'admin' },
      'https://pot.test',
    )
    expect(byLead.ok).toBe(false)
    if (byLead.ok) return
    expect(byLead.error).toBe('cannot_grant_above_own_rank')
  })

  it('org-admin with no squad grant still adds — inheritance, not a local squad row', async () => {
    const orgAdmin: AuthContext = {
      ...operatorAuth(),
      capabilities: [
        {
          member_id: OPERATOR_MEMBER_ID,
          scope_type: 'org',
          scope_id: null,
          capability: 'admin',
        },
      ],
    }
    const granted = await invokeTool(
      orgAdmin,
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'lead' },
      'https://pot.test',
    )
    expect(granted.ok).toBe(true)
  })

  it('department-admin inherits onto a squad in that department', async () => {
    const deptAdmin: AuthContext = {
      ...operatorAuth(),
      capabilities: [
        {
          member_id: OPERATOR_MEMBER_ID,
          scope_type: 'department',
          scope_id: DEPT_ID,
          capability: 'admin',
        },
      ],
    }
    const granted = await invokeTool(
      deptAdmin,
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'admin' },
      'https://pot.test',
    )
    expect(granted.ok).toBe(true)
  })

  it('observer on the target cannot add', async () => {
    const observer: AuthContext = {
      ...leadAuth(),
      capabilities: [
        {
          member_id: HADI_MEMBER_ID,
          scope_type: 'squad',
          scope_id: TARGET_SQUAD_ID,
          capability: 'observer',
        },
      ],
    }
    const result = await invokeTool(
      observer,
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'observer' },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('forbidden')
  })

  it('lead on a different squad cannot add to the target', async () => {
    const otherLead: AuthContext = {
      ...leadAuth(),
      capabilities: [
        {
          member_id: HADI_MEMBER_ID,
          scope_type: 'squad',
          scope_id: OTHER_SQUAD_ID,
          capability: 'lead',
        },
      ],
    }
    const result = await invokeTool(
      otherLead,
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('forbidden')
  })

  it('direct self-grant: boundAgentId equals the target even when the member has no binding', async () => {
    const denial = await authorizeSquadMembershipWrite({
      env,
      auth: { ...operatorAuth(), boundAgentId: AGENT_ID },
      targetAgentId: AGENT_ID,
      squad: { id: TARGET_SQUAD_ID, department_id: DEPT_ID },
      requestedCapability: 'member',
    })
    expect(denial).toEqual({ ok: false, error: 'self_grant' })
  })

  it('member on the target cannot remove either — same predicate as add', async () => {
    const result = await invokeTool(
      memberOnlyAuth(),
      env,
      'squad_member_remove',
      { agent: CALLER_AGENT_ID, squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('forbidden')
  })

  it('rolls back the grant when the membership receipt insert aborts', async () => {
    harness.sqlite.exec(`
      CREATE TRIGGER fail_membership_receipt_insert
      BEFORE INSERT ON membership_receipts
      BEGIN
        SELECT RAISE(ABORT, 'injected_receipt_failure');
      END;
    `)
    const result = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'lead' },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('receipt_failed')
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ n: 0 })
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(AGENT_MEMBER_ID, TARGET_SQUAD_ID)).toEqual({ n: 0 })
  })

  it('rolls back the removal when the membership receipt insert aborts', async () => {
    const added = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(added.ok).toBe(true)

    harness.sqlite.exec(`
      CREATE TRIGGER fail_membership_receipt_remove
      BEFORE INSERT ON membership_receipts
      BEGIN
        SELECT RAISE(ABORT, 'injected_receipt_failure');
      END;
    `)
    const removed = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_remove',
      { agent: AGENT_ID, squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.error).toBe('receipt_failed')
    expect(harness.sqlite.prepare(
      'SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?',
    ).get(AGENT_ID, TARGET_SQUAD_ID)).toEqual({ capability: 'member' })
    expect(harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(AGENT_MEMBER_ID, TARGET_SQUAD_ID)).toEqual({ capability: 'member' })
  })
})

describe('squad membership delete receipts (cascade, mupot#1164)', () => {
  it('PRAGMA foreign_keys is on — the D1-equivalent condition for CASCADE+AFTER DELETE', () => {
    expect(harness.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })

  it('deleting an agent writes a removal receipt for every cascaded membership', async () => {
    const unboundId = 'agent-unbound-del'
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${unboundId}', '${TARGET_SQUAD_ID}', 'unbound-del', 'Unbound', 'active');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-unbound-del', '${unboundId}', '${TARGET_SQUAD_ID}', 'lead');
    `)
    harness.sqlite.exec(`
      INSERT INTO membership_receipts (
        id, tenant, actor_member_id, target_agent_id, squad_id, action, capability, result
      ) VALUES (
        'add-unbound-del', '${TENANT}', '${OPERATOR_MEMBER_ID}', '${unboundId}',
        '${TARGET_SQUAD_ID}', 'add', 'lead', 'created'
      );
    `)

    await expect(deleteAgent(env, unboundId)).resolves.toEqual({ ok: true })
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ?',
    ).get(unboundId)).toEqual({ n: 0 })
    const removal = harness.sqlite.prepare(
      `SELECT id, tenant, actor_member_id, prior_capability, result
         FROM membership_receipts
        WHERE target_agent_id = ? AND action = 'remove'`,
    ).get(unboundId) as {
      id: string
      tenant: string
      actor_member_id: string
      prior_capability: string
      result: string
    }
    expect(removal.actor_member_id).toBe('system:cascade')
    expect(removal.prior_capability).toBe('lead')
    expect(removal.result).toBe('removed')

    // #1170: the cascade trigger records tenant='system' with NO COALESCE fallback. A
    // trigger cannot see env.TENANT_SLUG and therefore cannot know the tenant; the
    // previous COALESCE chain GUESSED, and sometimes guessed wrong, hiding a revocation
    // from a tenant-scoped audit while the matching grant stayed visible. Asserting the
    // literal is the point — if a future reader reinstates a "helpful" fallback because
    // 'system' looks like a placeholder, this goes red.
    expect(removal.tenant).toBe('system')

    // #1173: the receipt id carries a random suffix so a REUSED membership id cannot
    // collide on the UNIQUE constraint. Shape, not value — the suffix is random by
    // design. The pre-fix form ('cascade-' || OLD.id, no suffix) fails this.
    expect(removal.id).toMatch(/^cascade-mem-unbound-del-[0-9a-f]{8}$/)
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM membership_receipts
        WHERE target_agent_id = ? AND action = 'add'`,
    ).get(unboundId)).toEqual({ n: 1 })
  })

  it('deleting a squad writes a removal receipt for every cascaded membership', () => {
    const doomedSquad = 'squad-doomed'
    const doomedAgent = 'agent-doomed'
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${doomedSquad}', '${DEPT_ID}', 'doomed', 'Doomed');
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${doomedAgent}', '${doomedSquad}', 'doomed', 'Doomed Agent', 'active');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-doomed', '${doomedAgent}', '${doomedSquad}', 'admin');
    `)

    harness.sqlite.exec(`DELETE FROM squads WHERE id = '${doomedSquad}'`)
    expect(harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM memberships WHERE squad_id = ?',
    ).get(doomedSquad)).toEqual({ n: 0 })
    const removal = harness.sqlite.prepare(
      `SELECT actor_member_id, prior_capability, result
         FROM membership_receipts
        WHERE target_agent_id = ? AND action = 'remove'`,
    ).get(doomedAgent) as { actor_member_id: string; prior_capability: string; result: string }
    expect(removal).toEqual({
      actor_member_id: 'system:cascade',
      prior_capability: 'admin',
      result: 'removed',
    })
  })
})

// #1174: the four source-grep tests that lived here were vacuous as evidence.
// Three text-preserving mutants (isSelfGrant -> return false, if(false && ...) x2)
// left them GREEN while behavioural tests went RED. The behavioural coverage in
// the suites above is genuinely sound — cite that, never the greps. Removed.

describe('target-rank guard — cannot affect a member at or above your own rank (#1169)', () => {
  // Seed an admin and an owner membership on the target squad so we can test
  // that a lead cannot remove or demote them.
  function seedWithHighRankTargets(sqlite: SqliteD1Harness['sqlite']): void {
    sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
      VALUES
        ('member-admin-target', 'Admin Target Member', 'active', '${TENANT}'),
        ('member-owner-target', 'Owner Target Member', 'active', '${TENANT}');

      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES
        ('agent-admin-target', '${TARGET_SQUAD_ID}', 'admin-target', 'Admin Target', 'active'),
        ('agent-owner-target', '${TARGET_SQUAD_ID}', 'owner-target', 'Owner Target', 'active');

      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES
        ('${TENANT}', 'agent-admin-target', 'member-admin-target', '2026-08-19T00:00:00Z'),
        ('${TENANT}', 'agent-owner-target', 'member-owner-target', '2026-08-19T00:00:00Z');

      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES
        ('mem-admin-target', 'agent-admin-target', '${TARGET_SQUAD_ID}', 'admin'),
        ('mem-owner-target', 'agent-owner-target', '${TARGET_SQUAD_ID}', 'owner');
    `)
  }

  beforeEach(() => {
    seedWithHighRankTargets(harness.sqlite)
  })

  it('lead cannot remove an admin from the squad', async () => {
    const result = await invokeTool(
      leadAuth(),
      env,
      'squad_member_remove',
      { agent: 'agent-admin-target', squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_affect_higher_rank')
  })

  it('lead cannot demote an admin to observer', async () => {
    const result = await invokeTool(
      leadAuth(),
      env,
      'squad_member_add',
      { agent: 'agent-admin-target', squad: TARGET_SQUAD_ID, capability: 'observer' },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_affect_higher_rank')
  })

  it('lead cannot remove an owner from the squad', async () => {
    const result = await invokeTool(
      leadAuth(),
      env,
      'squad_member_remove',
      { agent: 'agent-owner-target', squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_affect_higher_rank')
  })

  it('lead cannot remove an owner whose membership is NOT on its home squad', async () => {
    // Residual (1) from Athena's #1164 gate. The test above plants agent-owner-target
    // with home squad == TARGET_SQUAD_ID, so home_squad_immutable is ALSO applicable on
    // that path — two guards can fire and only one is under test. It is not vacuous (it
    // asserts the specific error), but it never proves the general case: that rank alone
    // stops a lead acting on an owner.
    //
    // Here the agent's home is HOME_SQUAD_ID and the owner membership is on
    // TARGET_SQUAD_ID, so home_squad_immutable cannot apply and cannot_affect_higher_rank
    // is the ONLY thing that can refuse. That makes this the discriminating case.
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-owner-away', 'Owner Away Member', 'active', '${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-owner-away', '${HOME_SQUAD_ID}', 'owner-away', 'Owner Away', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'agent-owner-away', 'member-owner-away', '2026-08-19T00:00:00Z');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-owner-away', 'agent-owner-away', '${TARGET_SQUAD_ID}', 'owner');
    `)
    const result = await invokeTool(
      leadAuth(),
      env,
      'squad_member_remove',
      { agent: 'agent-owner-away', squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_affect_higher_rank')
  })

  it('lead cannot demote an owner on a squad that is not the owner home squad', async () => {
    // The add/demote half of the same discrimination — #1169 covers BOTH verbs, and a
    // guard that only held on remove would pass the test above while leaving demotion open.
    //
    // Fixture is planted here rather than reused from the test above: the harness resets
    // between cases, so borrowing that agent produced 'agent_not_found' and would have
    // been a test passing for a reason unrelated to what it claims to check.
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-owner-away2', 'Owner Away Two', 'active', '${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-owner-away2', '${HOME_SQUAD_ID}', 'owner-away2', 'Owner Away Two', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'agent-owner-away2', 'member-owner-away2', '2026-08-19T00:00:00Z');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-owner-away2', 'agent-owner-away2', '${TARGET_SQUAD_ID}', 'owner');
    `)
    const result = await invokeTool(
      leadAuth(),
      env,
      'squad_member_add',
      { agent: 'agent-owner-away2', squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_affect_higher_rank')
  })

  it('admin can remove a lead (lower rank)', async () => {
    // Agent's home squad is HOME_SQUAD_ID; the membership being removed is on TARGET_SQUAD_ID
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-lead-target', 'Lead Target Member', 'active', '${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-lead-target', '${HOME_SQUAD_ID}', 'lead-target', 'Lead Target', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'agent-lead-target', 'member-lead-target', '2026-08-19T00:00:00Z');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-lead-target', 'agent-lead-target', '${TARGET_SQUAD_ID}', 'lead');
    `)
    const result = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_remove',
      { agent: 'agent-lead-target', squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(result.ok).toBe(true)
  })

  it('lead can remove a member (lower rank)', async () => {
    // Agent's home squad is HOME_SQUAD_ID; the membership being removed is on TARGET_SQUAD_ID
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-low-target', 'Low Target Member', 'active', '${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-low-target', '${HOME_SQUAD_ID}', 'low-target', 'Low Target', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'agent-low-target', 'member-low-target', '2026-08-19T00:00:00Z');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-low-target', 'agent-low-target', '${TARGET_SQUAD_ID}', 'member');
    `)
    const result = await invokeTool(
      leadAuth(),
      env,
      'squad_member_remove',
      { agent: 'agent-low-target', squad: TARGET_SQUAD_ID },
      'https://pot.test',
    )
    expect(result.ok).toBe(true)
  })

  it('authorizeSquadMembershipWrite directly: lead vs admin target = cannot_affect_higher_rank', async () => {
    const denial = await authorizeSquadMembershipWrite({
      env,
      auth: leadAuth(),
      targetAgentId: 'agent-admin-target',
      squad: { id: TARGET_SQUAD_ID, department_id: DEPT_ID },
      requestedCapability: null,
    })
    expect(denial.ok).toBe(false)
    if (denial.ok) return
    expect(denial.error).toBe('cannot_affect_higher_rank')
  })
})

describe('0116 memberships rebuild is defensive on D1 (FK pragma is a no-op)', () => {
  const migration = readFileSync(join(MIGRATIONS_DIR, '0116_memberships_capability_admin.sql'), 'utf8')

  it('says the PRAGMA is decorative on D1 — so nobody re-relies on it', () => {
    expect(migration).toMatch(/DECORATIVE ON D1/)
    expect(migration).toMatch(/PRAGMA foreign_keys inside an open transaction/)
  })

  it('copies only rows whose agent and squad parents exist', () => {
    expect(migration).toMatch(
      /WHERE EXISTS \(SELECT 1 FROM agents a WHERE a\.id = m\.agent_id\)/,
    )
    expect(migration).toMatch(
      /AND EXISTS \(SELECT 1 FROM squads s WHERE s\.id = m\.squad_id\)/,
    )
  })

  it('the 0116 INSERT SELECT excludes an orphan from the rebuild rather than aborting (the orphan is preserved separately by the quarantine table, #1172)', () => {
    harness.sqlite.exec('PRAGMA foreign_keys = OFF')
    harness.sqlite.exec(`
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-orphan-0116', 'agent-does-not-exist', 'squad-does-not-exist', 'member');
    `)
    harness.sqlite.exec(`
      CREATE TABLE memberships_orphan_probe (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        squad_id TEXT NOT NULL,
        capability TEXT NOT NULL
      );
    `)
    const insert = migration.match(/INSERT INTO memberships_new[\s\S]*?;/)?.[0]
    if (!insert) throw new Error('0116 INSERT not found')
    harness.sqlite.exec(insert.replaceAll('memberships_new', 'memberships_orphan_probe'))
    const copied = harness.sqlite.prepare(
      'SELECT id FROM memberships_orphan_probe WHERE id = ?',
    ).get('mem-orphan-0116')
    expect(copied).toBeUndefined()
    const kept = harness.sqlite.prepare(
      'SELECT COUNT(*) AS n FROM memberships_orphan_probe',
    ).get() as { n: number }
    expect(kept.n).toBeGreaterThan(0)
  })

  // ── #1171, residual (2) third leg. Athena's M6 mutation SURVIVED 35/35: reverting the
  // app-path prior read from `memberships` back to `capabilities` broke nothing, because
  // no test planted the one state where the two sources DISAGREE.
  //
  // They disagree exactly when a membership row exists and the capabilities grant does NOT.
  // Reading from `capabilities` then yields null, classifyResult sees null and returns
  // 'created' — a DEMOTION recorded as a first-time grant, with prior_capability blank. The
  // audit trail loses the fact that authority was taken away.
  //
  // Two cases, because they fail for different reasons and one alone leaves a hole.

  it('records the prior capability from memberships when the capabilities grant is ABSENT', async () => {
    // Case A — the general defect. No owner involved, so this is independent of the rank
    // guard: any membership without a matching capabilities row discriminates the two reads.
    // Home is HOME_SQUAD_ID and the membership is on TARGET_SQUAD_ID so home_squad_immutable
    // cannot fire and confound the result.
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-nogrant', 'No Grant Member', 'active', '${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-nogrant', '${HOME_SQUAD_ID}', 'nogrant', 'No Grant', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'agent-nogrant', 'member-nogrant', '2026-08-19T00:00:00Z');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-nogrant', 'agent-nogrant', '${TARGET_SQUAD_ID}', 'member');
    `)

    // Precondition, asserted rather than assumed: the capabilities row really is absent.
    // If a fixture ever starts creating one, this test would silently stop discriminating.
    const before = harness.sqlite.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get('member-nogrant', TARGET_SQUAD_ID)
    expect(before).toBeUndefined()

    const result = await invokeTool(
      operatorAuth(),
      env,
      'squad_member_add',
      { agent: 'agent-nogrant', squad: TARGET_SQUAD_ID, capability: 'observer' },
      'https://pot.test',
    )
    expect(result.ok).toBe(true)

    const receipt = harness.sqlite.prepare(
      `SELECT prior_capability, capability, result
         FROM membership_receipts WHERE target_agent_id = ?`,
    ).get('agent-nogrant') as {
      prior_capability: string | null
      capability: string
      result: string
    }
    // Reading from `capabilities` would make both of these wrong: null and 'created'.
    expect(receipt.prior_capability).toBe('member')
    expect(receipt.result).toBe('updated')
    expect(receipt.capability).toBe('observer')
  })

  it('records prior_capability owner on a demotion, which the capabilities grant can never hold', async () => {
    // Case B — the scenario named in #1171. Even when a capabilities row EXISTS it can never
    // say 'owner', because isAgentAccessCapability filters that value out. So a
    // demotion-from-owner is the one case where the wrong source is not merely stale but
    // structurally incapable of holding the right answer.
    //
    // The actor holds 'owner' on the target squad: the #1169 target-rank guard refuses
    // anyone below the target's current rank, so a lead or admin cannot reach this path
    // at all (see the two cannot_affect_higher_rank cases above).
    const ownerAuth: AuthContext = {
      ...leadAuth(),
      capabilities: [
        {
          member_id: HADI_MEMBER_ID,
          scope_type: 'squad',
          scope_id: TARGET_SQUAD_ID,
          capability: 'owner',
        },
      ],
    }

    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant)
      VALUES ('member-demote-owner', 'Demote Owner Member', 'active', '${TENANT}');
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-demote-owner', '${HOME_SQUAD_ID}', 'demote-owner', 'Demote Owner', 'active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', 'agent-demote-owner', 'member-demote-owner', '2026-08-19T00:00:00Z');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('mem-demote-owner', 'agent-demote-owner', '${TARGET_SQUAD_ID}', 'owner');
    `)

    const result = await invokeTool(
      ownerAuth,
      env,
      'squad_member_add',
      { agent: 'agent-demote-owner', squad: TARGET_SQUAD_ID, capability: 'member' },
      'https://pot.test',
    )
    expect(result.ok).toBe(true)

    const receipt = harness.sqlite.prepare(
      `SELECT prior_capability, capability, result
         FROM membership_receipts WHERE target_agent_id = ?`,
    ).get('agent-demote-owner') as {
      prior_capability: string | null
      capability: string
      result: string
    }
    // The whole point of #1171: this must read 'owner', not null and not 'created'.
    expect(receipt.prior_capability).toBe('owner')
    expect(receipt.result).toBe('updated')
    expect(receipt.capability).toBe('member')
  })
})
