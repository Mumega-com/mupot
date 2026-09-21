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

  it('does not reveal whether an unauthorized router squad exists', async () => {
    const caller = auth('lead-a')

    const foreign = await authorizeExecutionScope(env, caller, {
      action: 'router:read', squadId: SQUAD_B,
    })
    const missing = await authorizeExecutionScope(env, caller, {
      action: 'router:read', squadId: 'missing-squad',
    })

    expect(foreign).toEqual({ ok: false, status: 403, error: 'forbidden' })
    expect(missing).toEqual(foreign)
  })

  it('returns not found when an org admin names a missing router squad', async () => {
    await expect(authorizeExecutionScope(env, auth('org-admin'), {
      action: 'router:read', squadId: 'missing-squad',
    })).resolves.toEqual({ ok: false, status: 404, error: 'not_found' })
  })

  // Athena's fail-closed/404-vs-403 reconciliation (adversarial round on
  // G-FP1b): the org-admin fast path added to authorizeRouterScope to
  // restore the 404-on-missing-squad property above must NOT become a new
  // route ahead of the home-squad scope check — an org admin naming a REAL
  // home squad must still be refused (403), never treated as "not found"
  // (which would itself leak "this squad id exists" for a home squad) and
  // never admitted.
  it('refuses (403, not 404 or ok) when an org admin names a REAL home-kind squad for router access', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind)
      VALUES ('squad-home-router', '${DEPARTMENT}', 'home-router', 'Home', 'home');
    `)
    await expect(authorizeExecutionScope(env, auth('org-admin'), {
      action: 'router:read', squadId: 'squad-home-router',
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
    await expect(authorizeExecutionScope(env, auth('org-admin'), {
      action: 'router:mutate', squadId: 'squad-home-router',
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

  it('does not reveal whether an unauthorized meter agent exists', async () => {
    const caller = auth('lead-a')

    const foreign = await authorizeExecutionScope(env, caller, {
      action: 'meter:read', agentId: AGENT_B,
    })
    const missing = await authorizeExecutionScope(env, caller, {
      action: 'meter:read', agentId: 'missing-agent',
    })

    expect(foreign).toEqual({ ok: false, status: 403, error: 'forbidden' })
    expect(missing).toEqual(foreign)
  })

  it('returns not found when an org admin names a missing meter agent', async () => {
    await expect(authorizeExecutionScope(env, auth('org-admin'), {
      action: 'meter:read', agentId: 'missing-agent',
    })).resolves.toEqual({ ok: false, status: 404, error: 'not_found' })
  })

  it('pre-denies bound-agent foreign ids without revealing their existence', async () => {
    const caller = auth('agent-a-member', { boundAgentId: AGENT_A })
    const prepares = { value: 0 }
    const tracked = {
      ...env,
      DB: {
        prepare(sql: string) {
          prepares.value += 1
          return env.DB.prepare(sql)
        },
      },
    } as Env

    const foreign = await authorizeExecutionScope(tracked, caller, {
      action: 'meter:read', agentId: AGENT_B,
    })
    const missing = await authorizeExecutionScope(tracked, caller, {
      action: 'meter:read', agentId: 'missing-agent',
    })

    expect(foreign).toEqual({ ok: false, status: 403, error: 'forbidden' })
    expect(missing).toEqual(foreign)
    expect(prepares.value).toBe(0)
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

// Adversarial round 1 P1 (Athena): "two mutation survivors" in this file —
// findAgentAuthorizedForLead's raw-SQL EXISTS clause (src/auth/execution-
// scope.ts:79-96) replicates hasCapability's org/department inheritance rule
// inline rather than going through planeCoversScope, so it needed the same
// kind='home' exclusion hand-added to both disjuncts (s.kind != 'home'). A
// home squad is the ONE case that distinguishes "exclusion present" from
// "exclusion silently deleted" — every existing test above uses only work
// squads, so none of them would notice either leg going missing.
describe('authorizeExecutionScope — home squad exclusion (G-FP1b point 2)', () => {
  let harness: SqliteD1Harness
  let env: Env
  const HOME_SQUAD = 'squad-home-agent'
  const HOME_AGENT = 'agent-home'

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind)
      VALUES ('${HOME_SQUAD}', '${DEPARTMENT}', 'home-agent', 'Home', 'home');
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${HOME_AGENT}', '${HOME_SQUAD}', 'home-agent', 'Home Agent', 'active');
      INSERT INTO members (id, display_name, status, tenant) VALUES
        ('org-lead', 'Org Lead', 'active', '${TENANT}'),
        ('dept-lead', 'Dept Lead', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('org-lead-org', 'org-lead', 'org', NULL, 'lead'),
        ('dept-lead-dept', 'dept-lead', 'department', '${DEPARTMENT}', 'lead');
    `)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
  })

  afterEach(() => harness.close())

  it('org-admin bypass (principalIsOrgAdmin path): refused for an agent living in a home squad', async () => {
    await expect(authorizeExecutionScope(env, auth('org-admin'), {
      action: 'meter:read', agentId: HOME_AGENT,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('findAgentAuthorizedForLead ORG leg: an org-scope LEAD durable grant does not reach an agent in a home squad', async () => {
    await expect(authorizeExecutionScope(env, auth('org-lead', { capabilities: undefined }), {
      action: 'meter:read', agentId: HOME_AGENT,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('findAgentAuthorizedForLead DEPARTMENT leg: a department-scope LEAD durable grant on the home\'s OWN department does not reach the home agent', async () => {
    await expect(authorizeExecutionScope(env, auth('dept-lead', { capabilities: undefined }), {
      action: 'meter:read', agentId: HOME_AGENT,
    })).resolves.toEqual({ ok: false, status: 403, error: 'forbidden' })
  })

  it('sanity: the SAME org/department durable grants DO reach an agent on a real work squad in that department', async () => {
    await expect(authorizeExecutionScope(env, auth('org-lead', { capabilities: undefined }), {
      action: 'meter:read', agentId: AGENT_A,
    })).resolves.toEqual({ ok: true, tenant: TENANT, squadId: SQUAD_A, agentId: AGENT_A, source: 'principal' })
    await expect(authorizeExecutionScope(env, auth('dept-lead', { capabilities: undefined }), {
      action: 'meter:read', agentId: AGENT_A,
    })).resolves.toEqual({ ok: true, tenant: TENANT, squadId: SQUAD_A, agentId: AGENT_A, source: 'principal' })
  })
})
