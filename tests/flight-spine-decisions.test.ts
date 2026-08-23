import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDecisionRequest,
  resolveDecisionRequest,
  type CreateDecisionRequestInput,
} from '../src/flight-spine/decisions'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-decisions'
const NOW = '2030-08-23T16:00:00.000Z'
const MEMBER_ID = 'member-decision'
const SQUAD_ID = 'squad-decision'
const OBJECTIVE_ID = 'objective-decision'

let harness: SqliteD1Harness
let env: Env

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'decision@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'dashboard',
    boundAgentId: null,
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'lead',
    }],
    ...overrides,
  }
}

function input(overrides: Partial<CreateDecisionRequestInput> = {}): CreateDecisionRequestInput {
  return {
    decisionClass: 'business_choice',
    dedupeKey: 'pricing-model-choice',
    exactAuthorityRequired: 'Squad lead chooses the materially different pricing outcome.',
    question: 'Which pricing model should the flight adopt?',
    options: [
      { id: 'subscription', label: 'Subscription' },
      { id: 'usage', label: 'Usage based' },
    ],
    consequences: {
      subscription: 'Predictable revenue; longer commitment.',
      usage: 'Lower entry cost; variable revenue.',
    },
    evidence: {
      apiToken: 'must-not-persist',
      observation: 'Authorization: Bearer must-not-persist-either',
    },
    objectiveId: OBJECTIVE_ID,
    expiresAt: '2031-08-23T16:00:00.000Z',
    idempotencyKey: 'decision-create-1',
    ...overrides,
  }
}

function count(table: string): number {
  return Number((harness.sqlite.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).get() as { count: number }).count)
}

function envWithBeforeBatch(mutate: () => void): Env {
  let injected = false
  return {
    ...env,
    DB: {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        if (!injected) {
          injected = true
          mutate()
        }
        return env.DB.batch(statements)
      },
    } as D1Database,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('department-decision', 'decision', 'Decision');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD_ID}', 'department-decision', 'decision', 'Decision');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Decision Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('capability-decision', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'lead');
    INSERT INTO objectives (
      id, tenant, created_by_principal_kind, created_by_principal_id,
      created_by_member_id, squad_id, title, success_contract,
      authority_envelope, policy_json, budget_micro_usd, payload_json,
      payload_digest, accepted_at, created_at
    ) VALUES (
      '${OBJECTIVE_ID}', '${TENANT}', 'member', '${MEMBER_ID}', '${MEMBER_ID}',
      '${SQUAD_ID}', 'Decision objective', 'Resolve only genuine decisions',
      '{}', '{}', 0, '{}', '${'a'.repeat(64)}', '${NOW}', '${NOW}'
    );
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine decision requests', () => {
  it('accepts exactly the six decision classes, canonicalizes safe claims, and never models retry exhaustion', async () => {
    const classes = [
      'credential',
      'deployment_or_migration',
      'destructive',
      'spend',
      'cross_tenant',
      'business_choice',
    ] as const
    for (const [index, decisionClass] of classes.entries()) {
      const created = await createDecisionRequest(env, auth(), input({
        decisionClass,
        dedupeKey: `decision-class-${index}`,
        idempotencyKey: `decision-class-create-${index}`,
      }))
      expect(created.decisionClass).toBe(decisionClass)
      expect(JSON.stringify(created)).not.toContain('must-not-persist')
    }

    await expect(createDecisionRequest(env, auth(), input({
      decisionClass: 'retry_exhaustion',
      dedupeKey: 'retry-exhaustion',
      idempotencyKey: 'retry-exhaustion-create',
    } as never))).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'invalid_decision',
    })
    expect(count('decision_requests')).toBe(6)
  })

  it('deduplicates one open request and replays only exact idempotent creation bytes', async () => {
    const first = await createDecisionRequest(env, auth(), input())
    expect(await createDecisionRequest(env, auth(), input())).toEqual(first)

    await expect(createDecisionRequest(env, auth(), input({
      idempotencyKey: 'decision-create-other',
    }))).rejects.toMatchObject({ name: 'DecisionError', code: 'decision_already_open' })
    await expect(createDecisionRequest(env, auth(), input({
      question: 'A changed question must conflict.',
    }))).rejects.toMatchObject({ name: 'DecisionError', code: 'idempotency_conflict' })
    expect(count('decision_requests')).toBe(1)
    expect(count('execution_receipts')).toBe(1)
    expect(count('mutation_audit_entries')).toBe(1)
  })

  it('resolves only an open unexpired request, replays exactly, and keeps resolution evidence immutable', async () => {
    const request = await createDecisionRequest(env, auth(), input())
    const resolutionInput = {
      decisionRequestId: request.id,
      idempotencyKey: 'decision-resolution-1',
      resolution: { optionId: 'subscription', approved: true },
      consequencesAccepted: { acknowledged: ['longer commitment'] },
    }
    const resolved = await resolveDecisionRequest(env, auth(), resolutionInput)

    expect(await resolveDecisionRequest(env, auth(), resolutionInput)).toEqual(resolved)
    expect(harness.sqlite.prepare(`
      SELECT status, resolved_at FROM decision_requests WHERE id = ?
    `).get(request.id)).toEqual({ status: 'resolved', resolved_at: NOW })
    expect(() => harness.sqlite.prepare(`
      UPDATE decision_request_resolutions SET resolution_json = '{}' WHERE id = ?
    `).run(resolved.id)).toThrow(/immutable/i)
    expect(() => harness.sqlite.prepare(`
      DELETE FROM decision_request_resolutions WHERE id = ?
    `).run(resolved.id)).toThrow(/immutable/i)
    expect(() => harness.sqlite.prepare(`
      UPDATE execution_receipts SET claims_json = '{}' WHERE id = ?
    `).run(resolved.resolutionReceiptId)).toThrow(/append-only/i)

    const expiring = await createDecisionRequest(env, auth(), input({
      dedupeKey: 'expired-decision',
      idempotencyKey: 'expired-decision-create',
      expiresAt: '2030-08-23T17:00:00.000Z',
    }))
    const receiptsBeforeExpiredResolution = count('execution_receipts')
    vi.setSystemTime(new Date('2030-08-23T18:00:00.000Z'))
    await expect(resolveDecisionRequest(env, auth(), {
      decisionRequestId: expiring.id,
      idempotencyKey: 'expired-decision-resolution',
      resolution: { optionId: 'usage' },
      consequencesAccepted: { acknowledged: true },
    })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'decision_not_open_or_expired',
    })
    expect(count('execution_receipts')).toBe(receiptsBeforeExpiredResolution)
  })

  it('rechecks mutable resolution authority inside the receipt-owned transaction', async () => {
    const request = await createDecisionRequest(env, auth(), input())
    const before = {
      receipts: count('execution_receipts'),
      audits: count('mutation_audit_entries'),
    }
    const racingEnv = envWithBeforeBatch(() => {
      harness.sqlite.prepare(`DELETE FROM capabilities WHERE member_id = ?`).run(MEMBER_ID)
    })

    await expect(resolveDecisionRequest(racingEnv, auth(), {
      decisionRequestId: request.id,
      idempotencyKey: 'decision-resolution-raced',
      resolution: { optionId: 'usage' },
      consequencesAccepted: { acknowledged: true },
    })).rejects.toMatchObject({
      name: 'DecisionError',
      code: 'decision_persistence_conflict',
    })
    expect(count('decision_request_resolutions')).toBe(0)
    expect(count('execution_receipts')).toBe(before.receipts)
    expect(count('mutation_audit_entries')).toBe(before.audits)
  })
})
