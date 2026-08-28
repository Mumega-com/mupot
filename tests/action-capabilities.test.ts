// tests/action-capabilities.test.ts — Unit tests for Granular Action Capability Tokens (action:*).

import { describe, expect, it } from 'vitest'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { invokeTool, callerHoldsActionCapability } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { grantGateCapability } from '../src/gates/grants'

const TENANT = 'tenant-action'
const ORIGIN = 'https://pot.test'

function makeDb() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)

  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
    VALUES ('dept-1', 'dept-1', 'Dept 1');

    INSERT INTO squads (id, department_id, slug, name)
    VALUES ('squad-1', 'dept-1', 'squad-1', 'Squad 1');

    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
    VALUES
      ('agent-1', 'squad-1', 'agent-1', 'Agent 1', 'member', 'model-1', 'active'),
      ('agent-2', 'squad-1', 'agent-2', 'Agent 2', 'member', 'model-1', 'active');

    INSERT INTO members (id, display_name, status, tenant)
    VALUES
      ('mem-1', 'Agent 1 Member', 'active', '${TENANT}'),
      ('mem-2', 'Agent 2 Member', 'active', '${TENANT}');

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES
      ('${TENANT}', 'agent-1', 'mem-1', '2026-08-05T00:00:00Z'),
      ('${TENANT}', 'agent-2', 'mem-2', '2026-08-05T00:00:00Z');

    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
    VALUES ('tok-agent-2', 'mem-2', 'hash-2', 'workspace', 'workspace', '2026-08-05T00:00:00Z', 'agent-2', '${TENANT}');
  `)

  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    harness,
  }
}

function auth(
  memberId: string,
  capabilities: CapabilityGrant[],
  boundAgentId: string | null = null,
  role: AuthContext['role'] = 'member',
): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role,
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities,
    boundAgentId,
  }
}

describe('Action Capability Tokens (action:*)', () => {
  it('grants action:manage_access to an agent via grant_gate_capability', async () => {
    const { env } = makeDb()
    const orgAdmin = auth('admin-mem', [{ member_id: 'admin-mem', scope_type: 'org', scope_id: null, capability: 'admin' }])

    const out = await invokeTool(
      orgAdmin,
      env,
      'grant_gate_capability',
      {
        capability: 'action:manage_access',
        principal_type: 'member',
        principal_id: 'mem-1',
      },
      ORIGIN,
    )

    expect(out.ok).toBe(true)

    const agentSession = auth('mem-1', [{ member_id: 'mem-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'admin' }], 'agent-1')
    const holds = await callerHoldsActionCapability(env, agentSession, 'action:manage_access')
    expect(holds).toBe(true)
  })

  it('blocks bound agent without action:manage_access on operator_principal_required tools', async () => {
    const { env } = makeDb()
    const normalAgent = auth('mem-1', [{ member_id: 'mem-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'admin' }], 'agent-1')

    const out = await invokeTool(
      normalAgent,
      env,
      'update_agent',
      {
        agent: 'agent-1',
        name: 'Renamed Agent',
      },
      ORIGIN,
    )

    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(403)
      expect(out.error).toBe('operator_principal_required')
    }
  })

  it('permits bound agent WITH action:manage_access to call update_agent', async () => {
    const { env } = makeDb()
    await grantGateCapability(env, {
      capability: 'action:manage_access',
      principalType: 'member',
      principalId: 'mem-1',
      grantedBy: 'admin',
    })

    const authorizedAgent = auth('mem-1', [{ member_id: 'mem-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'admin' }], 'agent-1')

    const out = await invokeTool(
      authorizedAgent,
      env,
      'update_agent',
      {
        agent: 'agent-1',
        name: 'Updated Name by Autonomous Agent',
      },
      ORIGIN,
    )

    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result).toMatchObject({
        agent: {
          id: 'agent-1',
          name: 'Updated Name by Autonomous Agent',
        },
      })
    }
  })

  it('permits bound agent WITH action:manage_access to grant squad capabilities within rank', async () => {
    const { env } = makeDb()
    await grantGateCapability(env, {
      capability: 'action:manage_access',
      principalType: 'member',
      principalId: 'mem-1',
      grantedBy: 'admin',
    })

    const authorizedAgent = auth('mem-1', [{ member_id: 'mem-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'admin' }], 'agent-1')

    const out = await invokeTool(
      authorizedAgent,
      env,
      'grant_agent_capability',
      {
        agent: 'agent-2',
        squad: 'squad-1',
        capability: 'lead',
      },
      ORIGIN,
    )

    expect(out.ok).toBe(true)
  })
})
