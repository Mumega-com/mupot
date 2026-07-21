// tests/mcp-gate-grants.test.ts — grant_gate_capability / revoke_gate_capability MCP twins.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0007_gates.sql',
  '../migrations/0008_gate_grants.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'

function makeDb() {
  const harness = createSqliteD1()
  for (const migration of migrations) harness.sqlite.exec(migration)
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
