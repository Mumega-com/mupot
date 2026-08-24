import { createHash } from 'node:crypto'
import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptObjective, getObjective } from '../src/flight-spine/objectives'
import type { AcceptObjectiveInput } from '../src/flight-spine/objectives'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-objectives'
const SERVER_TIME = '2026-08-23T16:00:00.000Z'
const MEMBER_ID = 'member-command'
const LEAD_MEMBER_ID = 'member-objective-lead'
const OTHER_MEMBER_ID = 'member-other'
const AGENT_ID = 'agent-command'
const SQUAD_ID = 'squad-command'
const TARGET_SQUAD_ID = 'squad-target'
const PROJECT_ID = 'project-command'

let harness: SqliteD1Harness
let env: Env

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'command@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'member',
    }],
    ...overrides,
  }
}

function leadAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return auth({
    userId: LEAD_MEMBER_ID,
    memberId: LEAD_MEMBER_ID,
    boundAgentId: null,
    capabilities: [{
      member_id: LEAD_MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'lead',
    }],
    ...overrides,
  })
}

function objectiveInput(overrides: Partial<AcceptObjectiveInput> = {}): AcceptObjectiveInput {
  return {
    squadId: SQUAD_ID,
    projectId: PROJECT_ID,
    title: '  Materialize a novel composition  ',
    successContract: 'Two independent worker outputs are integrated and gated.',
    authorityEnvelope: {
      allowedActions: ['task:create', 'flight:materialize'],
      publication: 'none',
    },
    policy: {
      maxAttempts: 3,
      proofWindowSeconds: 1_800,
    },
    budgetMicroUsd: 0,
    payload: { '😀': 'astral', 'é': 'accent', a: 1 },
    idempotencyKey: 'objective-command-001',
    ...overrides,
  }
}

function count(table: string): number {
  return Number((harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number
  }).count)
}

function envWithBeforeBatch(mutate: () => void): Env {
  let injected = false
  return {
    ...env,
    DB: {
      prepare: harness.db.prepare.bind(harness.db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        if (!injected) {
          injected = true
          mutate()
        }
        return harness.db.batch(statements)
      },
    } as D1Database,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(SERVER_TIME))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('department-command', 'command', 'Command');
    INSERT INTO squads (
      id, department_id, slug, name, budget_cap_cents, budget_window
    ) VALUES
      ('${SQUAD_ID}', 'department-command', 'command', 'Command', 100, 'day'),
      ('${TARGET_SQUAD_ID}', 'department-command', 'target', 'Target', 100, 'day');
    INSERT INTO agents (
      id, squad_id, slug, name, role, model, status, budget_cap_cents, budget_window
    ) VALUES (
      '${AGENT_ID}', '${SQUAD_ID}', 'command', 'Command Agent', 'member', 'test',
      'active', 200, 'day'
    );
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES
        ('membership-command', '${AGENT_ID}', '${SQUAD_ID}', 'member'),
        ('membership-target', '${AGENT_ID}', '${TARGET_SQUAD_ID}', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES
        ('${MEMBER_ID}', 'Command Member', 'active', '${TENANT}'),
        ('${LEAD_MEMBER_ID}', 'Objective Lead', 'active', '${TENANT}'),
        ('${OTHER_MEMBER_ID}', 'Other Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '${SERVER_TIME}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES
        ('capability-command', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member'),
        ('capability-target', '${MEMBER_ID}', 'squad', '${TARGET_SQUAD_ID}', 'lead'),
        ('capability-objective-lead', '${LEAD_MEMBER_ID}', 'squad', '${SQUAD_ID}', 'lead'),
        ('capability-other', '${OTHER_MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
    INSERT INTO projects (id, slug, name, status)
      VALUES ('${PROJECT_ID}', 'project-command', 'Project Command', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('${PROJECT_ID}', '${SQUAD_ID}', 'write');
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine objective acceptance', () => {
  it('atomically persists server-derived creator facts, canonical payload and authorization receipts', async () => {
    const input = {
      ...objectiveInput(),
      createdByPrincipalKind: 'member',
      createdByPrincipalId: 'forged-principal',
      createdByMemberId: 'forged-member',
      acceptedAt: '2000-01-01T00:00:00.000Z',
      payloadDigest: 'f'.repeat(64),
    } as AcceptObjectiveInput

    const accepted = await acceptObjective(env, auth(), input)
    const reread = await getObjective(env, auth(), accepted.id)

    const canonicalPayload = '{"a":1,"é":"accent","😀":"astral"}'
    const expectedDigest = createHash('sha256').update(canonicalPayload).digest('hex')
    expect(accepted).toMatchObject({
      tenant: TENANT,
      squadId: SQUAD_ID,
      projectId: PROJECT_ID,
      title: 'Materialize a novel composition',
      budgetMicroUsd: 0,
      payloadDigest: expectedDigest,
      acceptedAt: SERVER_TIME,
    })
    expect(reread).toEqual(accepted)

    expect(harness.sqlite.prepare(`
      SELECT created_by_principal_kind, created_by_principal_id,
             created_by_member_id, payload_json, payload_digest, accepted_at
        FROM objectives WHERE id = ?
    `).get(accepted.id)).toEqual({
      created_by_principal_kind: 'agent',
      created_by_principal_id: AGENT_ID,
      created_by_member_id: MEMBER_ID,
      payload_json: canonicalPayload,
      payload_digest: expectedDigest,
      accepted_at: SERVER_TIME,
    })
    expect(harness.sqlite.prepare(`
      SELECT objective_id, payload_digest, acceptance_receipt_id
        FROM objective_acceptance_keys WHERE tenant = ? AND idempotency_key = ?
    `).get(TENANT, input.idempotencyKey)).toEqual({
      objective_id: accepted.id,
      payload_digest: expectedDigest,
      acceptance_receipt_id: accepted.acceptanceReceiptId,
    })

    expect(harness.sqlite.prepare(`
      SELECT type, actor_kind, actor_id, objective_id
        FROM execution_receipts ORDER BY sequence
    `).all()).toEqual([
      {
        type: 'objective.authorized', actor_kind: 'agent', actor_id: AGENT_ID,
        objective_id: accepted.id,
      },
      {
        type: 'objective.accepted', actor_kind: 'agent', actor_id: AGENT_ID,
        objective_id: accepted.id,
      },
    ])
    expect(count('mutation_audit_entries')).toBe(2)
  })

  it('returns the original immutable objective for exact replay and rejects changed reuse', async () => {
    const input = objectiveInput({ budgetMicroUsd: 0 })
    const first = await acceptObjective(env, auth(), input)
    vi.setSystemTime(new Date('2026-08-23T17:00:00.000Z'))

    const replay = await acceptObjective(env, auth(), input)

    expect(replay).toEqual(first)
    expect(count('objectives')).toBe(1)
    expect(count('objective_acceptance_keys')).toBe(1)
    expect(count('execution_receipts')).toBe(2)
    expect(count('mutation_audit_entries')).toBe(2)

    await expect(acceptObjective(env, auth(), {
      ...input,
      title: 'Changed title under the same key',
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(() => harness.sqlite.prepare(
      'UPDATE objectives SET title = ? WHERE id = ?',
    ).run('Mutated', first.id)).toThrow(/immutable/i)
  })

  it('binds replay to the original actor and rereads that actor current authority', async () => {
    const input = objectiveInput()
    await acceptObjective(env, auth(), input)
    const other = auth({
      userId: OTHER_MEMBER_ID,
      memberId: OTHER_MEMBER_ID,
      boundAgentId: null,
      capabilities: [{
        member_id: OTHER_MEMBER_ID,
        scope_type: 'squad',
        scope_id: SQUAD_ID,
        capability: 'member',
      }],
    })

    await expect(acceptObjective(env, other, input))
      .rejects.toMatchObject({ code: 'idempotency_conflict' })

    harness.sqlite.prepare("DELETE FROM capabilities WHERE id = 'capability-command'").run()
    await expect(acceptObjective(env, auth({ capabilities: [] }), input))
      .rejects.toMatchObject({ code: 'objective_forbidden' })
    expect(count('objectives')).toBe(1)
    expect(count('execution_receipts')).toBe(2)
  })

  it('does not return another actor objective when that actor wins the same-key batch race', async () => {
    const input = objectiveInput()
    const other = auth({
      userId: OTHER_MEMBER_ID,
      memberId: OTHER_MEMBER_ID,
      boundAgentId: null,
      capabilities: [{
        member_id: OTHER_MEMBER_ID,
        scope_type: 'squad',
        scope_id: SQUAD_ID,
        capability: 'member',
      }],
    })
    let injected = false
    const racedDb = {
      prepare: harness.db.prepare.bind(harness.db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        if (!injected) {
          injected = true
          await acceptObjective(env, other, input)
        }
        return harness.db.batch(statements)
      },
    } as D1Database
    const racedEnv = { ...env, DB: racedDb }

    await expect(acceptObjective(racedEnv, auth(), input))
      .rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(harness.sqlite.prepare(`
      SELECT created_by_principal_kind, created_by_principal_id, created_by_member_id
        FROM objectives
    `).get()).toEqual({
      created_by_principal_kind: 'member',
      created_by_principal_id: OTHER_MEMBER_ID,
      created_by_member_id: OTHER_MEMBER_ID,
    })
    expect(count('objectives')).toBe(1)
    expect(count('execution_receipts')).toBe(2)
  })

  it('rereads current squad authority and requires lead for a positive budget', async () => {
    harness.sqlite.prepare(
      "UPDATE capabilities SET capability = 'member' WHERE id = 'capability-objective-lead'",
    ).run()

    await expect(acceptObjective(env, leadAuth({
      capabilities: [{
        member_id: LEAD_MEMBER_ID,
        scope_type: 'squad',
        scope_id: SQUAD_ID,
        capability: 'member',
      }],
    }), objectiveInput({ budgetMicroUsd: 500_000 })))
      .rejects.toMatchObject({ code: 'objective_budget_forbidden' })
    expect(count('objectives')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
  })

  it('honors an explicit empty directory capability view even when DB grants exist', async () => {
    await expect(acceptObjective(env, auth({
      channel: 'directory',
      capabilities: [],
    }), objectiveInput()))
      .rejects.toMatchObject({ code: 'objective_forbidden' })
    expect(count('objectives')).toBe(0)
  })

  it('honors a consent-clamped member view instead of widening to a live DB lead grant', async () => {
    await expect(acceptObjective(env, leadAuth({
      channel: 'directory',
      capabilities: [{
        member_id: LEAD_MEMBER_ID,
        scope_type: 'squad',
        scope_id: SQUAD_ID,
        capability: 'member',
      }],
    }), objectiveInput({ budgetMicroUsd: 500_000 })))
      .rejects.toMatchObject({ code: 'objective_budget_forbidden' })
    expect(count('objectives')).toBe(0)
  })

  it('requires a bound agent membership to meet the requested minimum rank', async () => {
    await expect(acceptObjective(env, auth({
      capabilities: [{
        member_id: MEMBER_ID,
        scope_type: 'squad',
        scope_id: TARGET_SQUAD_ID,
        capability: 'lead',
      }],
    }), objectiveInput({
      squadId: TARGET_SQUAD_ID,
      projectId: null,
      budgetMicroUsd: 500_000,
      idempotencyKey: 'objective-target-agent-minimum',
    })))
      .rejects.toMatchObject({ code: 'objective_budget_forbidden' })
    expect(count('objectives')).toBe(0)
  })

  it('enforces the lowest current agent or squad budget cap', async () => {
    await expect(acceptObjective(env, leadAuth(), objectiveInput({ budgetMicroUsd: 1_000_001 })))
      .rejects.toMatchObject({
        code: 'objective_budget_exceeds_cap',
        detail: { capMicroUsd: 1_000_000, bindingKind: 'squad', bindingId: SQUAD_ID },
      })
    expect(count('objectives')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
  })

  it('rolls back receipts, objective and audit when live capability is revoked before the batch', async () => {
    const racedEnv = envWithBeforeBatch(() => {
      harness.sqlite.prepare("DELETE FROM capabilities WHERE id = 'capability-command'").run()
    })

    await expect(acceptObjective(racedEnv, auth(), objectiveInput()))
      .rejects.toMatchObject({ code: 'objective_persistence_conflict' })
    expect(count('objectives')).toBe(0)
    expect(count('objective_acceptance_keys')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it('rolls back the atomic acceptance when a squad cap drops below budget before the batch', async () => {
    const racedEnv = envWithBeforeBatch(() => {
      harness.sqlite.prepare('UPDATE squads SET budget_cap_cents = 10 WHERE id = ?')
        .run(SQUAD_ID)
    })

    await expect(acceptObjective(
      racedEnv,
      leadAuth(),
      objectiveInput({ budgetMicroUsd: 500_000 }),
    )).rejects.toMatchObject({ code: 'objective_persistence_conflict' })
    expect(count('objectives')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it('rolls back the atomic acceptance when the bound agent is disabled before the batch', async () => {
    const racedEnv = envWithBeforeBatch(() => {
      harness.sqlite.prepare("UPDATE agents SET status = 'paused' WHERE id = ?").run(AGENT_ID)
    })

    await expect(acceptObjective(racedEnv, auth(), objectiveInput()))
      .rejects.toMatchObject({ code: 'objective_persistence_conflict' })
    expect(count('objectives')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })

  it('fails closed on tenant, squad and project scope mismatches before writing facts', async () => {
    await expect(acceptObjective(env, auth({ tenant: 'other-tenant' }), objectiveInput()))
      .rejects.toMatchObject({ code: 'unauthorized_tenant' })
    await expect(acceptObjective(env, auth(), objectiveInput({ squadId: 'missing-squad' })))
      .rejects.toMatchObject({ code: 'objective_forbidden' })

    harness.sqlite.prepare(`
      UPDATE project_squad_access SET access_level = 'read'
       WHERE project_id = ? AND squad_id = ?
    `).run(PROJECT_ID, SQUAD_ID)
    await expect(acceptObjective(env, auth(), objectiveInput({ budgetMicroUsd: 0 })))
      .rejects.toMatchObject({ code: 'project_access_forbidden' })

    expect(count('objectives')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
  })
})
