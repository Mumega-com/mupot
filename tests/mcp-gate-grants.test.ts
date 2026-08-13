// tests/mcp-gate-grants.test.ts — grant_gate_capability / revoke_gate_capability MCP twins.

import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { mintAgentBoundToken } from '../src/members/service'
import { applyAllMigrations } from './helpers/migrations'


const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'

function makeDb() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    grants: () => harness.sqlite.prepare('SELECT * FROM gate_grants').all() as Array<Record<string, unknown>>,
  }
}

function grant(capability: CapabilityGrant['capability'], scope_type = 'org', scope_id: string | null = null): CapabilityGrant {
  return { member_id: 'n/a', scope_type, scope_id, capability } as CapabilityGrant
}

function auth(memberId: string, capabilities: CapabilityGrant[], role: AuthContext['role'] = 'member'): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role,
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId: null,
  }
}

const orgAdmin = auth('admin-member', [grant('admin', 'org', null)])
const grantless = auth('grantless', [])
const squadAdmin = auth('squad-admin', [grant('admin', 'squad', 'squad-X')])

describe('gate grant MCP tools — registry', () => {
  it('registers grant_gate_capability and revoke_gate_capability at min admin', () => {
    for (const name of ['grant_gate_capability', 'revoke_gate_capability']) {
      const spec = TOOLS.find((t) => t.name === name)
      expect(spec, name).toBeDefined()
      expect(spec?.min).toBe('admin')
    }
  })
})

describe('grant_gate_capability', () => {
  it('rejects grantless and non-org admin', async () => {
    const db = makeDb()
    for (const caller of [grantless, squadAdmin]) {
      const out = await invokeTool(caller, db.env, 'grant_gate_capability', {
        capability: 'gate:kasra-core',
        principal_type: 'agent',
        principal_id: 'agent-1',
      }, ORIGIN)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.status).toBe(403)
    }
    expect(db.grants()).toHaveLength(0)
  })

  it('rejects non-gate capability strings', async () => {
    const db = makeDb()
    const out = await invokeTool(orgAdmin, db.env, 'grant_gate_capability', {
      capability: 'outreach:send',
      principal_type: 'member',
      principal_id: 'member-1',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toBe('invalid_capability')
    expect(db.grants()).toHaveLength(0)
  })

  it('grants idempotently for org-admin', async () => {
    const db = makeDb()
    const args = {
      capability: 'gate:kasra-core',
      principal_type: 'agent',
      principal_id: 'agent-gate-1',
    }
    const first = await invokeTool(orgAdmin, db.env, 'grant_gate_capability', args, ORIGIN)
    const second = await invokeTool(orgAdmin, db.env, 'grant_gate_capability', args, ORIGIN)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(db.grants()).toHaveLength(1)
    expect(db.grants()[0]).toMatchObject({
      capability: 'gate:kasra-core',
      principal_type: 'agent',
      principal_id: 'agent-gate-1',
      granted_by: 'admin-member',
    })
  })
})

describe('revoke_gate_capability', () => {
  it('revokes an existing grant', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'grant_gate_capability', {
      capability: 'gate:kasra-core',
      principal_type: 'member',
      principal_id: 'member-gate',
    }, ORIGIN)
    expect(db.grants()).toHaveLength(1)
    const out = await invokeTool(orgAdmin, db.env, 'revoke_gate_capability', {
      capability: 'gate:kasra-core',
      principal_type: 'member',
      principal_id: 'member-gate',
    }, ORIGIN)
    expect(out.ok).toBe(true)
    expect(db.grants()).toHaveLength(0)
  })
})

describe('grant_list_gate_capabilities (D3 read tool, 2026-08-13)', () => {
  it('registers the tool at min admin', () => {
    const spec = TOOLS.find((t) => t.name === 'grant_list_gate_capabilities')
    expect(spec, 'grant_list_gate_capabilities').toBeDefined()
    expect(spec?.min).toBe('admin')
  })

  it('rejects grantless and non-org admin callers', async () => {
    const db = makeDb()
    for (const caller of [grantless, squadAdmin]) {
      const out = await invokeTool(caller, db.env, 'grant_list_gate_capabilities', {}, ORIGIN)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.status).toBe(403)
    }
  })

  it('returns an empty list when no grants exist', async () => {
    const db = makeDb()
    const out = await invokeTool(orgAdmin, db.env, 'grant_list_gate_capabilities', {}, ORIGIN)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.grants).toEqual([])
      expect(out.result.count).toBe(0)
    }
  })

  it('lists all grants for org-admin (audit visibility)', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'grant_gate_capability', {
      capability: 'gate:kasra-core', principal_type: 'agent', principal_id: 'agent-1',
    }, ORIGIN)
    await invokeTool(orgAdmin, db.env, 'grant_gate_capability', {
      capability: 'gate:athena', principal_type: 'agent', principal_id: 'agent-2',
    }, ORIGIN)
    await invokeTool(orgAdmin, db.env, 'grant_gate_capability', {
      capability: 'gate:kasra-core', principal_type: 'member', principal_id: 'member-9',
    }, ORIGIN)

    const out = await invokeTool(orgAdmin, db.env, 'grant_list_gate_capabilities', {}, ORIGIN)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.count).toBe(3)
      const caps = out.result.grants.map((g: { capability: string }) => g.capability).sort()
      expect(caps).toEqual(['gate:athena', 'gate:kasra-core', 'gate:kasra-core'])
    }
  })

  it('filters by capability / principal_type / principal_id', async () => {
    const db = makeDb()
    await invokeTool(orgAdmin, db.env, 'grant_gate_capability', {
      capability: 'gate:kasra-core', principal_type: 'agent', principal_id: 'agent-1',
    }, ORIGIN)
    await invokeTool(orgAdmin, db.env, 'grant_gate_capability', {
      capability: 'gate:athena', principal_type: 'agent', principal_id: 'agent-2',
    }, ORIGIN)

    const byCap = await invokeTool(orgAdmin, db.env, 'grant_list_gate_capabilities', {
      capability: 'gate:athena',
    }, ORIGIN)
    expect(byCap.ok).toBe(true)
    if (byCap.ok) {
      expect(byCap.result.count).toBe(1)
      expect(byCap.result.grants[0].principal_id).toBe('agent-2')
    }

    const byPrincipal = await invokeTool(orgAdmin, db.env, 'grant_list_gate_capabilities', {
      principal_id: 'agent-1',
    }, ORIGIN)
    expect(byPrincipal.ok).toBe(true)
    if (byPrincipal.ok) {
      expect(byPrincipal.result.count).toBe(1)
      expect(byPrincipal.result.grants[0].capability).toBe('gate:kasra-core')
    }

    const byType = await invokeTool(orgAdmin, db.env, 'grant_list_gate_capabilities', {
      principal_type: 'member',
    }, ORIGIN)
    expect(byType.ok).toBe(true)
    if (byType.ok) expect(byType.result.count).toBe(0)
  })
})


describe('mintAgentBoundToken lands the D2 lane grant atomically (2026-08-13)', () => {
  it('grants gate:<slug> lane gate atomically, NOT gate:agent-self-completion (BLOCK-1)', async () => {
    const db = makeDb()
    // Seed the FK targets the mint touches: department -> squad -> agent.
    db.env.DB.prepare(
      `INSERT INTO departments (id, slug, name, created_at)
       VALUES ('dept-mint', 'mint-dept', 'Mint Dept', '2026-08-13T00:00:00.000Z')`,
    ).run()
    db.env.DB.prepare(
      `INSERT INTO squads (id, department_id, slug, name, charter, created_at)
       VALUES ('squad-mint', 'dept-mint', 'squad-mint', 'Mint Squad', NULL, '2026-08-13T00:00:00.000Z')`,
    ).run()
    db.env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
       VALUES ('agent-mint-1', 'squad-mint', 'minty', 'Minty', 'member', '@cf/meta/llama-3.3', 'active', '2026-08-13T00:00:00.000Z')`,
    ).run()

    const result = await mintAgentBoundToken(
      db.env,
      { id: 'agent-mint-1', squad_id: 'squad-mint', slug: 'minty', name: 'Minty' },
      'minty',
    )
    expect(result.tokenId).toBeTruthy()

    const rows = db.grants()
    expect(rows).toHaveLength(1)
    // D2: the agent's own lane gate (gate:<slug>) — part of the atomic mint.
    expect(rows[0]).toMatchObject({
      capability: 'gate:minty',
      principal_type: 'agent',
      principal_id: 'agent-mint-1',
      granted_by: 'system:mint',
    })
    // BLOCK-1 (kasra-review): gate:agent-self-completion is deliberately NOT
    // granted at mint — the verdict route treats it as assignee-or-org-admin
    // only, so a universal grant would be a dead authority surface.

    // Re-mint is idempotent — no duplicate grant rows.
    await mintAgentBoundToken(
      db.env,
      { id: 'agent-mint-1', squad_id: 'squad-mint', slug: 'minty', name: 'Minty' },
      'minty',
    )
    expect(db.grants()).toHaveLength(1)
  })
})
