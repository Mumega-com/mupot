import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authorizeExecutionScope } from '../src/auth/execution-scope'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-a'
const DEPARTMENT = 'department-a'
const SQUAD_A = 'squad-a'
const SQUAD_B = 'squad-b'
const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'

function grant(
  member_id: string,
  capability: CapabilityGrant['capability'],
  scope_id: string | null,
): CapabilityGrant {
  return { member_id, scope_type: scope_id === null ? 'org' : 'squad', scope_id, capability }
}

function ambientCapabilities(memberId: string): CapabilityGrant[] {
  switch (memberId) {
    case 'observer-a': return [grant(memberId, 'observer', SQUAD_A)]
    case 'member-a': return [grant(memberId, 'member', SQUAD_A)]
    case 'lead-a': return [grant(memberId, 'lead', SQUAD_A)]
    case 'lead-b': return [grant(memberId, 'lead', SQUAD_B)]
    case 'org-admin': return [grant(memberId, 'admin', null)]
    default: return []
  }
}

function auth(memberId: string, overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: ambientCapabilities(memberId),
    boundAgentId: null,
    ...overrides,
  }
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPARTMENT}', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_A}', '${DEPARTMENT}', 'squad-a', 'Squad A'),
      ('${SQUAD_B}', '${DEPARTMENT}', 'squad-b', 'Squad B');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${AGENT_A}', '${SQUAD_A}', 'agent-a', 'Agent A', 'active'),
      ('${AGENT_B}', '${SQUAD_B}', 'agent-b', 'Agent B', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-a', '${AGENT_A}', '${SQUAD_A}', 'member'),
      ('membership-b', '${AGENT_B}', '${SQUAD_B}', 'member');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('observer-a', 'Observer A', 'active', '${TENANT}'),
      ('member-a', 'Member A', 'active', '${TENANT}'),
      ('lead-a', 'Lead A', 'active', '${TENANT}'),
      ('lead-b', 'Lead B', 'active', '${TENANT}'),
      ('agent-a-member', 'Agent A Member', 'active', '${TENANT}'),
      ('org-admin', 'Org Admin', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT_A}', 'agent-a-member', '2026-08-29T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('observer-a-squad-a', 'observer-a', 'squad', '${SQUAD_A}', 'observer'),
      ('member-a-squad-a', 'member-a', 'squad', '${SQUAD_A}', 'member'),
      ('lead-a-squad-a', 'lead-a', 'squad', '${SQUAD_A}', 'lead'),
      ('lead-b-squad-b', 'lead-b', 'squad', '${SQUAD_B}', 'lead'),
      ('org-admin-org', 'org-admin', 'org', NULL, 'admin');
  `)
}

describe('authorizeExecutionScope', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
  })

  afterEach(() => harness.close())

  it('allows an observer to read their squad router scope', async () => {
    await expect(authorizeExecutionScope(env, auth('observer-a'), {
      action: 'router:read', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: true, tenant: TENANT, squadId: SQUAD_A, agentId: null, source: 'principal' })
  })

  it('denies a member router mutation', async () => {
    await expect(authorizeExecutionScope(env, auth('member-a'), {
      action: 'router:mutate', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('allows a same-squad lead router mutation', async () => {
    await expect(authorizeExecutionScope(env, auth('lead-a'), {
      action: 'router:mutate', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: true, tenant: TENANT, squadId: SQUAD_A, agentId: null, source: 'principal' })
  })

  it('denies a cross-squad lead router read', async () => {
    await expect(authorizeExecutionScope(env, auth('lead-b'), {
      action: 'router:read', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('denies a directory session with an empty ambient ceiling despite a durable squad lead grant', async () => {
    const clamped = auth('lead-a', { channel: 'directory', capabilities: [] })

    await expect(authorizeExecutionScope(env, clamped, {
      action: 'router:read', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
    await expect(authorizeExecutionScope(env, clamped, {
      action: 'router:mutate', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
    await expect(authorizeExecutionScope(env, clamped, {
      action: 'meter:read', agentId: AGENT_A,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('allows only router reads through a directory observer ceiling over a durable lead grant', async () => {
    const observerCeiling = auth('lead-a', {
      channel: 'directory',
      capabilities: [grant('lead-a', 'observer', SQUAD_A)],
    })

    await expect(authorizeExecutionScope(env, observerCeiling, {
      action: 'router:read', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: true, tenant: TENANT, squadId: SQUAD_A, agentId: null, source: 'principal' })
    await expect(authorizeExecutionScope(env, observerCeiling, {
      action: 'router:mutate', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('allows a bound agent to read only its own meter', async () => {
    await expect(authorizeExecutionScope(env, auth('agent-a-member', { boundAgentId: AGENT_A }), {
      action: 'meter:read', agentId: AGENT_A,
    })).resolves.toEqual({ ok: true, tenant: TENANT, squadId: SQUAD_A, agentId: AGENT_A, source: 'principal' })
  })

  it('denies a bound agent a foreign meter even when its member holds a lead grant there', async () => {
    harness.sqlite.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
       VALUES (?, ?, 'squad', ?, 'lead')`,
    ).run('agent-a-member-squad-b-lead', 'agent-a-member', SQUAD_B)

    await expect(authorizeExecutionScope(env, auth('agent-a-member', { boundAgentId: AGENT_A }), {
      action: 'meter:read', agentId: AGENT_B,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('allows a same-squad lead to read an agent meter', async () => {
    await expect(authorizeExecutionScope(env, auth('lead-a'), {
      action: 'meter:read', agentId: AGENT_A,
    })).resolves.toEqual({ ok: true, tenant: TENANT, squadId: SQUAD_A, agentId: AGENT_A, source: 'principal' })
  })

  it('denies a cross-squad lead before meter status can be read', async () => {
    await expect(authorizeExecutionScope(env, auth('lead-a'), {
      action: 'meter:read', agentId: AGENT_B,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('allows an org admin to read any tenant agent meter', async () => {
    await expect(authorizeExecutionScope(env, auth('org-admin'), {
      action: 'meter:read', agentId: AGENT_B,
    })).resolves.toEqual({ ok: true, tenant: TENANT, squadId: SQUAD_B, agentId: AGENT_B, source: 'principal' })
  })

  it('does not resurrect a revoked durable grant from a broader ambient ceiling', async () => {
    harness.sqlite.prepare('DELETE FROM capabilities WHERE id = ?').run('lead-a-squad-a')

    await expect(authorizeExecutionScope(env, auth('lead-a'), {
      action: 'router:mutate', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('uses D1 grants and the environment tenant instead of caller authority claims', async () => {
    await expect(authorizeExecutionScope(env, auth('member-a', {
      role: 'admin',
      tenant: 'attacker-tenant',
      capabilities: [{ member_id: 'member-a', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }), {
      action: 'router:mutate', squadId: SQUAD_A,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('verifies the bound-agent identity against the canonical binding', async () => {
    await expect(authorizeExecutionScope(env, auth('member-a', { boundAgentId: AGENT_A }), {
      action: 'meter:read', agentId: AGENT_A,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })
})
