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
import { TOOLS } from '../src/mcp/index'
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
