import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasSurfaceCap } from '../src/auth/capability'
import { createVerdictGateCache, evaluateVerdictGates } from '../src/tasks/index'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'

describe('hasSurfaceCap principal liveness and agent-bound resolution', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name)
      VALUES ('dept-1', 'dept-1', 'Department');
      INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-1', 'dept-1', 'squad-1', 'Squad');
      INSERT INTO members (id, tenant, email, display_name, status)
      VALUES
        ('member-active', '${TENANT}', 'active@test.local', 'Active', 'active'),
        ('member-suspended', '${TENANT}', 'suspended@test.local', 'Suspended', 'suspended');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES
        ('agent-active', 'squad-1', 'agent-active', 'Active Agent', 'member', 'test', 'active'),
        ('agent-paused', 'squad-1', 'agent-paused', 'Paused Agent', 'member', 'test', 'paused');
    `)
  })

  afterEach(() => harness.close())

  function auth(overrides: Partial<AuthContext>): AuthContext {
    return {
      userId: 'user-1',
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      memberId: null,
      boundAgentId: null,
      ...overrides,
    }
  }

  function grant(capability: string, principalType: 'member' | 'agent', principalId: string): void {
    harness.sqlite.prepare(
      `INSERT INTO gate_grants
         (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES (?, ?, ?, ?, 'test', datetime('now'))`,
    ).run(crypto.randomUUID(), capability, principalType, principalId)
  }

  it('rejects an identical surface grant held by a suspended member', async () => {
    grant('budget:write', 'member', 'member-suspended')

    await expect(hasSurfaceCap(
      env,
      auth({ memberId: 'member-suspended' }),
      'budget:write',
    )).resolves.toBe(false)
  })

  it('rejects an identical surface grant held by a paused agent', async () => {
    grant('budget:write', 'agent', 'agent-paused')

    await expect(hasSurfaceCap(
      env,
      auth({ userId: 'member-active', memberId: 'member-active', boundAgentId: 'agent-paused' }),
      'budget:write',
    )).resolves.toBe(false)
  })

  it('uses the active bound agent grant instead of the member envelope', async () => {
    grant('outreach:send-gated', 'agent', 'agent-active')

    await expect(hasSurfaceCap(
      env,
      auth({ userId: 'member-active', memberId: 'member-active', boundAgentId: 'agent-active' }),
      'outreach:send-gated',
    )).resolves.toBe(true)
  })

  it('does not borrow a member-envelope surface grant for a bound agent', async () => {
    grant('outreach:send-gated', 'member', 'member-active')

    await expect(hasSurfaceCap(
      env,
      auth({ userId: 'member-active', memberId: 'member-active', boundAgentId: 'agent-active' }),
      'outreach:send-gated',
    )).resolves.toBe(false)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Added by the merge gate. Two of this PR's claimed properties survived
  // mutation — correct, but unpinned. A property nothing can fail for is a hole
  // waiting to be reopened.
  //   deleting the principal_type match in hasActiveGateGrant -> 0 tests red
  //   removing principal type+id from the verdict cache keys  -> 0 tests red
  describe('gate-added pins for the mutation survivors', () => {
    it('a grant of the OTHER principal type never satisfies the check', async () => {
      // Same id, wrong type. Member and agent ids are distinct UUID namespaces in
      // production, so this is unreachable today — which is exactly why deleting
      // the discriminator turned nothing red. It is load-bearing; pin it rather
      // than trust the namespaces to stay disjoint forever.
      grant('budget:write', 'member', 'agent-active')

      await expect(hasSurfaceCap(
        env,
        auth({ userId: 'agent-active', memberId: null, boundAgentId: 'agent-active' }),
        'budget:write',
      )).resolves.toBe(false)
    })

    it('one cache serving two principals does not hand the second the first answer', async () => {
      // The verdict cache is request-scoped, so in production one cache serves one
      // AuthContext and the principal never varies — meaning the key could be a
      // constant and no test would notice. Nothing in the type or the API enforces
      // that one-cache-one-auth invariant, so assert the key discriminates. With
      // principal type+id dropped, the paused agent reads the active agent's `true`.
      grant('gate:loops', 'agent', 'agent-active')

      const cache = createVerdictGateCache()
      const task = {
        id: 'task-1',
        squad_id: 'squad-1',
        gate_owner: 'gate:loops',
        // A THIRD agent: neither principal may verdict its own task, and
        // self_verdict would short-circuit before the cache is ever consulted.
        assignee_agent_id: 'agent-someone-else',
      } as unknown as Parameters<typeof evaluateVerdictGates>[2]

      const first = await evaluateVerdictGates(
        env,
        auth({ userId: 'member-active', memberId: 'member-active', boundAgentId: 'agent-active' }),
        task, 'rejected', cache,
      )
      const second = await evaluateVerdictGates(
        env,
        auth({ userId: 'member-active', memberId: 'member-active', boundAgentId: 'agent-paused' }),
        task, 'rejected', cache,
      )

      expect(first.allowed).toBe(true)
      expect(second.allowed).toBe(false)
    })
  })

})
