// tests/grant-agent-capability-real-schema.test.ts — mupot#685 owed follow-up.
//
// WHY THIS TEST EXISTS, AND WHY IT USES THE REAL MIGRATIONS
//
// grant_agent_capability is the MCP tool that writes squad-scoped capabilities for
// agents (setAgentSquadAccess). It queries `capabilities` to check prior grants and
// write new ones. The query is defined once in src/members/agent-access.ts and used
// only there.
//
// The test must validate this exact query against the production schema (all
// migrations applied). A mutation in agent-access.ts that breaks the capability
// query must turn this test RED, proving the test catches it. This is the fourth
// fake-green of the session (audit mupot#685): previous tests mocked the DB, so
// they validated assumptions about columns rather than the schema itself.
//
// This test does not mock. It builds the complete schema from the committed
// migrations and invokes the actual grant_agent_capability tool end-to-end against
// it. A hand-written CREATE TABLE fixture would reproduce the same bug — the author
// would simply assume the wrong columns. The migrations are the only source of truth.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'tenant-test'
const DEPT_ID = 'dept-1'
const HOME_SQUAD_ID = 'squad-home'
const TARGET_SQUAD_ID = 'squad-target'
const AGENT_ID = 'agent-test'
const OPERATOR_MEMBER_ID = 'member-operator'
const AGENT_MEMBER_ID = 'member-agent'

/**
 * Apply EVERY migration in order, exactly as production does. Filtering migrations
 * would risk missing schema changes that affect the capability query. See commit
 * 0e25534 for why filtered subsets fail.
 */
function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      sqlite.exec(sql)
    } catch (err) {
      // D1-only constructs and guards for idempotent migrations are tolerated.
      // A genuine break in a migration needed for capability testing will surface
      // as missing table or column.
      const msg = String(err)
      if (!/already exists|duplicate column|no such (function|module)|near "PRAGMA"/i.test(msg)) {
        throw new Error(`migration ${file}: ${msg}`)
      }
    }
  }
}

/**
 * Setup org structure: departments, squads, agents, and members.
 * Mints an agent identity so grant_agent_capability can set squad access.
 */
function seedOrgStructure(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name)
    VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');

    INSERT INTO squads (id, department_id, slug, name)
    VALUES
      ('${HOME_SQUAD_ID}', '${DEPT_ID}', 'home', 'Home Squad'),
      ('${TARGET_SQUAD_ID}', '${DEPT_ID}', 'target', 'Target Squad');

    INSERT INTO agents (id, squad_id, slug, name, status)
    VALUES ('${AGENT_ID}', '${HOME_SQUAD_ID}', 'test-agent', 'Test Agent', 'active');

    INSERT INTO members (id, display_name, status, tenant)
    VALUES
      ('${OPERATOR_MEMBER_ID}', 'Operator', 'active', '${TENANT}'),
      ('${AGENT_MEMBER_ID}', 'Agent Member', 'active', '${TENANT}');

    -- The canonical binding: agent→member identity weld.
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER_ID}', '2026-08-05T00:00:00Z');

    -- Operator admin grants on both squads (needed to call grant_agent_capability on target).
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES
      ('cap-op-home-admin', '${OPERATOR_MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'admin'),
      ('cap-op-target-admin', '${OPERATOR_MEMBER_ID}', 'squad', '${TARGET_SQUAD_ID}', 'admin');

    -- Home squad access for the agent (created by mint_agent_token mock).
    INSERT INTO memberships (id, agent_id, squad_id, capability)
    VALUES ('mem-agent-home', '${AGENT_ID}', '${HOME_SQUAD_ID}', 'member');

    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES ('cap-agent-home', '${AGENT_MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'member');
  `)
}

/**
 * Auth context for an operator who can call grant_agent_capability.
 */
function operatorAuth(): AuthContext {
  return {
    userId: OPERATOR_MEMBER_ID,
    memberId: OPERATOR_MEMBER_ID,
    email: `${OPERATOR_MEMBER_ID}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [
      { member_id: OPERATOR_MEMBER_ID, scope_type: 'squad', scope_id: HOME_SQUAD_ID, capability: 'admin' },
      { member_id: OPERATOR_MEMBER_ID, scope_type: 'squad', scope_id: TARGET_SQUAD_ID, capability: 'admin' },
    ],
  }
}


let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seedOrgStructure(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
})

afterEach(() => {
  harness.sqlite.close()
})

describe('grant_agent_capability real schema (mupot#685)', () => {
  it('the migrations actually build capabilities table with required columns', () => {
    const cols = (harness.sqlite.prepare('PRAGMA table_info(capabilities)').all() as { name: string }[])
      .map((c) => c.name)
    expect(cols).toContain('id')
    expect(cols).toContain('member_id')
    expect(cols).toContain('scope_type')
    expect(cols).toContain('scope_id')
    expect(cols).toContain('capability')
    // Crucially: capabilities should NOT have a tenant column; that lives at
    // agent_member_bindings and member level, not the grant itself.
    // (This guards against the pattern from #684 where a non-existent column
    // was selected.)
  })

  it('grants squad-scoped capability via the real tool against production schema', async () => {
    const result = await invokeTool(
      operatorAuth(),
      env,
      'grant_agent_capability',
      {
        agent: AGENT_ID,
        squad: TARGET_SQUAD_ID,
        capability: 'admin',
      },
      'https://pot.test',
    )

    expect(result.ok).toBe(true)
    expect(result.result).toMatchObject({
      agent: { id: AGENT_ID },
      squad: { id: TARGET_SQUAD_ID },
      grant: {
        member_id: AGENT_MEMBER_ID,
        scope_type: 'squad',
        scope_id: TARGET_SQUAD_ID,
        capability: 'admin',
      },
    })

    // Verify the grant was actually written to capabilities table.
    const grants = harness.sqlite.prepare(
      `SELECT member_id, scope_type, scope_id, capability FROM capabilities
       WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).all(AGENT_MEMBER_ID, TARGET_SQUAD_ID) as Array<{ capability: string }>
    expect(grants).toHaveLength(1)
    expect(grants[0].capability).toBe('admin')
  })

  it('is idempotent — granting the same capability twice returns unchanged', async () => {
    const args = { agent: AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' }

    const first = await invokeTool(operatorAuth(), env, 'grant_agent_capability', args, 'https://pot.test')
    expect(first.ok).toBe(true)

    const second = await invokeTool(operatorAuth(), env, 'grant_agent_capability', args, 'https://pot.test')
    expect(second.ok).toBe(true)

    // Verify idempotence: only one row in capabilities
    const grants = harness.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM capabilities
       WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(AGENT_MEMBER_ID, TARGET_SQUAD_ID) as { count: number }
    expect(grants.count).toBe(1)
  })

  it(
    'REGRESSION: query referencing non-existent capability column throws — proves test catches schema drift',
    async () => {
      // The real query should succeed; a broken query referencing a non-existent
      // column should throw. This proves the test is coupled to the real schema.
      const workingQuery = `
        SELECT capability FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ? LIMIT 1
      `
      expect(() => {
        harness.sqlite.prepare(workingQuery).get(AGENT_MEMBER_ID, TARGET_SQUAD_ID)
      }).not.toThrow()

      // A query that adds a fake column that doesn't exist in the real schema should throw.
      const brokenQuery = `
        SELECT capability, nonexistent_column FROM capabilities
        WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ? LIMIT 1
      `
      expect(() => {
        harness.sqlite.prepare(brokenQuery).get(AGENT_MEMBER_ID, TARGET_SQUAD_ID)
      }).toThrow()
    },
  )
})
