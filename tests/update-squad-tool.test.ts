// tests/update-squad-tool.test.ts — mupot#611 item 1 (squad half): the new
// update_squad MCP tool, plus an end-to-end check that update_agent's PATCHABLE
// list actually wires budget_cap_cents/budget_window through to updateAgentProfile
// (the service-layer validation itself is covered exhaustively in
// tests/agent-profile-update.test.ts and tests/work-unit.test.ts — this file is
// about the MCP tool glue: the admin gate, the resolve, and the before/after diff
// that ships in the emitted event and the tool's own response).
//
// Real SQLite, all migrations applied, tools invoked directly via .run() (same
// pattern as tests/agent-messages.test.ts) rather than through the JSON-RPC seam —
// faithful to the production write path without hand-rolling a SQL-routing mock.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
// Enter the module graph via mcp/index (TOOLS), not mcp/provision directly.
// provision.ts imports memberCanOnSquad back from index.ts (a real, working
// circular import — index.ts spreads ...PROVISION_TOOLS at module-eval time),
// and Node's ESM circular resolution only completes that safely when index.ts
// is the FIRST module entered. tests/provision-tools.test.ts and
// tests/agent-messages.test.ts both enter this way for the same reason.
import { TOOLS, invokeTool } from '../src/mcp/index'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

const CTX = { origin: 'https://pot.test' }
const toolUpdateSquad = TOOLS.find((t) => t.name === 'update_squad')!
const toolUpdateAgent = TOOLS.find((t) => t.name === 'update_agent')!

function auth(capabilities: CapabilityGrant[] = [], boundAgentId: string | null = null): AuthContext {
  return {
    userId: 'u1', email: 'operator@example.com', role: 'member', tenant: 'test',
    memberId: 'member-operator', capabilities, boundAgentId,
  } as AuthContext
}

describe('update_squad — mupot#611 item 1', () => {
  let harness: SqliteD1Harness
  let env: Env
  let squadId: string

  beforeEach(async () => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'dept-1', 'sqa', 'Squad A');
      INSERT INTO org_settings (key, value, updated_at)
        VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
    `)
    env = { DB: harness.db, TENANT_SLUG: 'test' } as unknown as Env
    squadId = 'sq-a'
  })

  it('is registered', () => {
    expect(toolUpdateSquad).toBeTruthy()
  })

  it('sets budget_cap_cents on a squad that had none — the exact ceiling this fix removes', async () => {
    // Before this fix, create_squad was the ONLY place budget_cap_cents could be
    // set. A squad created without a cap could never dispatch a budgeted flight
    // again (flight_budget_policy_missing, src/mcp/index.ts).
    const before = await env.DB.prepare('SELECT budget_cap_cents, budget_window FROM squads WHERE id = ?')
      .bind(squadId).first<{ budget_cap_cents: number | null; budget_window: string }>()
    expect(before?.budget_cap_cents).toBeNull()
    expect(before?.budget_window).toBe('week')

    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await toolUpdateSquad.run(auth(orgAdmin), env, { squad: squadId, budget_cap_cents: 8000 }, CTX)
    expect(result.ok).toBe(true)

    const after = await env.DB.prepare('SELECT budget_cap_cents, budget_window FROM squads WHERE id = ?')
      .bind(squadId).first<{ budget_cap_cents: number | null; budget_window: string }>()
    expect(after?.budget_cap_cents).toBe(8000)
    expect(after?.budget_window).toBe('week') // untouched — partial patch
  })

  it('returns the before/after diff for exactly the fields touched', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await toolUpdateSquad.run(
      auth(orgAdmin), env,
      { squad: squadId, budget_cap_cents: 3000, budget_window: 'day' },
      CTX,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as { changed: Record<string, { from: unknown; to: unknown }> }
    expect(output.changed.budget_cap_cents).toEqual({ from: null, to: 3000 })
    expect(output.changed.budget_window).toEqual({ from: 'week', to: 'day' })
  })

  it('clears a cap with an explicit null', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    await toolUpdateSquad.run(auth(orgAdmin), env, { squad: squadId, budget_cap_cents: 3000 }, CTX)
    const cleared = await toolUpdateSquad.run(auth(orgAdmin), env, { squad: squadId, budget_cap_cents: null }, CTX)
    expect(cleared.ok).toBe(true)

    const after = await env.DB.prepare('SELECT budget_cap_cents FROM squads WHERE id = ?')
      .bind(squadId).first<{ budget_cap_cents: number | null }>()
    expect(after?.budget_cap_cents).toBeNull()
  })

  it('rejects a negative cap (mirrors the creation-path guard)', async () => {
    // MUTATION TARGET: pairs with the updateUnitConfig guard test in
    // tests/work-unit.test.ts — this one pins it at the MCP-tool boundary too.
    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await toolUpdateSquad.run(auth(orgAdmin), env, { squad: squadId, budget_cap_cents: -1 }, CTX)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)

    const after = await env.DB.prepare('SELECT budget_cap_cents FROM squads WHERE id = ?')
      .bind(squadId).first<{ budget_cap_cents: number | null }>()
    expect(after?.budget_cap_cents).toBeNull()
  })

  it('403s a caller without admin on the squad (lead is not enough)', async () => {
    const leadOnly: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'squad', scope_id: squadId, capability: 'lead' },
    ]
    const result = await toolUpdateSquad.run(auth(leadOnly), env, { squad: squadId, budget_cap_cents: 1000 }, CTX)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)

    const after = await env.DB.prepare('SELECT budget_cap_cents FROM squads WHERE id = ?')
      .bind(squadId).first<{ budget_cap_cents: number | null }>()
    expect(after?.budget_cap_cents).toBeNull()
  })

  it('inherits department-admin authority onto the squad (same ladder as every other tool here)', async () => {
    const deptAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'department', scope_id: 'dept-1', capability: 'admin' },
    ]
    const result = await toolUpdateSquad.run(auth(deptAdmin), env, { squad: squadId, budget_cap_cents: 1000 }, CTX)
    expect(result.ok).toBe(true)
  })

  it('404s a squad that does not exist', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await toolUpdateSquad.run(auth(orgAdmin), env, { squad: 'ghost-squad', budget_cap_cents: 1000 }, CTX)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
  })

  it('403s an agent-bound caller (operator-principal-required, same guard as update_agent)', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await toolUpdateSquad.run(auth(orgAdmin, 'agent-caller'), env, { squad: squadId, budget_cap_cents: 1000 }, CTX)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('400s an empty patch', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await toolUpdateSquad.run(auth(orgAdmin), env, { squad: squadId }, CTX)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })
})

describe('update_agent — budget fields wired through the MCP tool (mupot#611 item 1)', () => {
  let harness: SqliteD1Harness
  let env: Env
  let agentId: string

  beforeEach(async () => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'dept-1', 'sqa', 'Squad A');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-1', 'sq-a', 'prime', 'Prime', 'active');
      INSERT INTO org_settings (key, value, updated_at)
        VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
    `)
    env = { DB: harness.db, TENANT_SLUG: 'test' } as unknown as Env
    agentId = 'agent-1'
  })

  it('sets budget_cap_cents through the tool the same way any other profile field is patched', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await toolUpdateAgent.run(auth(orgAdmin), env, { agent: agentId, budget_cap_cents: 4200 }, CTX)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const output = result.result as { agent: { budget_cap_cents: number | null }; changed: Record<string, unknown> }
    expect(output.agent.budget_cap_cents).toBe(4200)
    expect(output.changed).toHaveProperty('budget_cap_cents')

    const row = await env.DB.prepare('SELECT budget_cap_cents FROM agents WHERE id = ?')
      .bind(agentId).first<{ budget_cap_cents: number | null }>()
    expect(row?.budget_cap_cents).toBe(4200)
  })

  it('rejects a negative budget_cap_cents at the tool boundary too', async () => {
    const orgAdmin: CapabilityGrant[] = [
      { member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' },
    ]
    const result = await toolUpdateAgent.run(auth(orgAdmin), env, { agent: agentId, budget_cap_cents: -50 }, CTX)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })
})

// mupot#1495 "type-safe slugs" — update_squad had NO slug field at all
// before this (a rename needed a raw D1 UPDATE by hand, per mupot#1498's
// own account of the Psychonom bootstrap). These go through invokeTool
// (not toolUpdateSquad.run() directly, unlike the rest of this file, which
// predates and is baselined against scripts/check-mcp-tool-seam.mjs) so a
// NEW test in this file cannot itself become a fresh seam violation.
describe('update_squad — slug field (mupot#1495)', () => {
  let harness: SqliteD1Harness
  let env: Env
  const CTX2 = { origin: 'https://pot.test', transport: 'mcp' as const }

  beforeEach(async () => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('sq-a', 'dept-1', 'sqa', 'Squad A'),
        ('sq-b', 'dept-1', 'existing-sqd', 'Squad B');
      INSERT INTO org_settings (key, value, updated_at)
        VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00');
    `)
    env = { DB: harness.db, TENANT_SLUG: 'test' } as unknown as Env
  })

  function orgAdminAuth(): AuthContext {
    return {
      userId: 'u1', email: 'operator@example.com', role: 'member', tenant: 'test',
      memberId: 'member-operator', boundAgentId: null,
      capabilities: [{ member_id: 'member-operator', scope_type: 'org', scope_id: null, capability: 'admin' }],
    } as AuthContext
  }

  it('renames a squad slug when the new slug carries the -sqd suffix', async () => {
    const outcome = await invokeTool(orgAdminAuth(), env, 'update_squad', { squad: 'sq-a', slug: 'psychonom-sqd' }, CTX2)
    expect(outcome.ok).toBe(true)
    const row = await env.DB.prepare('SELECT slug FROM squads WHERE id = ?').bind('sq-a').first<{ slug: string }>()
    expect(row?.slug).toBe('psychonom-sqd')
  })

  it('rejects a new slug with no -sqd suffix', async () => {
    const outcome = await invokeTool(orgAdminAuth(), env, 'update_squad', { squad: 'sq-a', slug: 'psychonom' }, CTX2)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.status).toBe(400)
    const row = await env.DB.prepare('SELECT slug FROM squads WHERE id = ?').bind('sq-a').first<{ slug: string }>()
    expect(row?.slug).toBe('sqa') // untouched
  })

  it('409s on a slug collision within the same department', async () => {
    const outcome = await invokeTool(orgAdminAuth(), env, 'update_squad', { squad: 'sq-a', slug: 'existing-sqd' }, CTX2)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.status).toBe(409)
    expect(outcome.error).toBe('slug_taken')
    const row = await env.DB.prepare('SELECT slug FROM squads WHERE id = ?').bind('sq-a').first<{ slug: string }>()
    expect(row?.slug).toBe('sqa') // untouched
  })

  it('an EXISTING unsuffixed squad slug is left alone by every other field patch — #1495 backfill is separate', async () => {
    // 'sqa' has no -sqd suffix and was never touched by this migration —
    // patching budget_cap_cents alone must not force a slug rewrite.
    const outcome = await invokeTool(orgAdminAuth(), env, 'update_squad', { squad: 'sq-a', budget_cap_cents: 500 }, CTX2)
    expect(outcome.ok).toBe(true)
    const row = await env.DB.prepare('SELECT slug FROM squads WHERE id = ?').bind('sq-a').first<{ slug: string }>()
    expect(row?.slug).toBe('sqa')
  })

  // ── P0(c) (kasra-review adversarial round-1 gate on PR #1510, Athena's
  // round-2 confirmation): renaming INTO a slug team_bootstrap has already
  // claimed for `x` (a `<x>-prj` project exists) needs department:admin, the
  // OLD create_squad floor — squad:admin (this tool's ordinary floor) is not
  // enough, because the squat IS a rename. ─────────────────────────────────
  describe('reserved-name rename requires department:admin (mupot#1498, P0c)', () => {
    beforeEach(() => {
      harness.sqlite.exec(`
        INSERT INTO projects (id, slug, name, status) VALUES ('proj-reserved', 'reserved-prj', 'Reserved', 'active');
      `)
    })

    function squadAdminOnlyAuth(): AuthContext {
      return {
        userId: 'u2', email: 'squadadmin@example.com', role: 'member', tenant: 'test',
        memberId: 'member-squad-admin', boundAgentId: null,
        capabilities: [{ member_id: 'member-squad-admin', scope_type: 'squad', scope_id: 'sq-a', capability: 'admin' }],
      } as AuthContext
    }

    function deptAdminAuth(): AuthContext {
      return {
        userId: 'u3', email: 'deptadmin@example.com', role: 'member', tenant: 'test',
        memberId: 'member-dept-admin', boundAgentId: null,
        capabilities: [{ member_id: 'member-dept-admin', scope_type: 'department', scope_id: 'dept-1', capability: 'admin' }],
      } as AuthContext
    }

    it('403s a squad-admin-only rename into a name reserved by an existing <x>-prj project', async () => {
      const outcome = await invokeTool(
        squadAdminOnlyAuth(),
        env,
        'update_squad',
        { squad: 'sq-a', slug: 'reserved-sqd' },
        CTX2,
      )
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.status).toBe(403)
      expect(outcome.error).toBe('forbidden')
      const row = await env.DB.prepare('SELECT slug FROM squads WHERE id = ?').bind('sq-a').first<{ slug: string }>()
      expect(row?.slug).toBe('sqa') // untouched
    })

    it('allows a department-admin rename into the SAME reserved name', async () => {
      const outcome = await invokeTool(
        deptAdminAuth(),
        env,
        'update_squad',
        { squad: 'sq-a', slug: 'reserved-sqd' },
        CTX2,
      )
      expect(outcome.ok).toBe(true)
      const row = await env.DB.prepare('SELECT slug FROM squads WHERE id = ?').bind('sq-a').first<{ slug: string }>()
      expect(row?.slug).toBe('reserved-sqd')
    })

    it('does NOT require department:admin for a rename into an UNRESERVED -sqd name', async () => {
      // Control: squad-admin alone is still enough when the target name is
      // not claimed by any project or team_bootstrap attempt.
      const outcome = await invokeTool(
        squadAdminOnlyAuth(),
        env,
        'update_squad',
        { squad: 'sq-a', slug: 'unclaimed-sqd' },
        CTX2,
      )
      expect(outcome.ok).toBe(true)
    })
  })
})
