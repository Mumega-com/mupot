import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDecisionRequest,
  resolveDecisionRequest,
  type CreateDecisionRequestInput,
  type DecisionCause,
} from '../src/flight-spine/decisions'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-decisions'
const MEMBER_ID = 'member-decision'
const TOKEN_ID = 'token-decision'
const SQUAD_ID = 'squad-decision'
const OBJECTIVE_ID = 'objective-decision'

let harness: SqliteD1Harness
let env: Env
let serverTime: string

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'decision@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'dashboard',
    boundAgentId: null,
    tokenId: TOKEN_ID,
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'lead',
    }],
    ...overrides,
  }
}

function adminAuth(): AuthContext {
  return auth({
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'org',
      scope_id: null,
      capability: 'admin',
    }],
  })
}

function future(milliseconds: number): string {
  return new Date(Date.parse(serverTime) + milliseconds).toISOString()
}

function input(overrides: Partial<CreateDecisionRequestInput> = {}): CreateDecisionRequestInput {
  return {
    decisionCause: 'business.choose',
    dedupeKey: 'pricing-model-choice',
    question: 'Which pricing model should the flight adopt?',
    options: [
      { id: 'subscription', label: 'Subscription' },
      { id: 'usage', label: 'Usage based' },
    ],
    consequences: {
      subscription: 'Predictable revenue with a longer commitment.',
      usage: 'Lower entry cost with variable revenue.',
    },
    evidence: { source: 'pricing-study', artifactDigest: 'd'.repeat(64) },
    objectiveId: OBJECTIVE_ID,
    expiresAt: future(24 * 60 * 60 * 1_000),
    idempotencyKey: 'decision-create-1',
    ...overrides,
  }
}

function count(table: string, where = '1 = 1'): number {
  return Number((harness.sqlite.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
  ).get() as { count: number }).count)
}

function sqliteNow(): string {
  return (harness.sqlite.prepare(`
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value
  `).get() as { value: string }).value
}

function envWithBeforeBatch(mutate: () => Promise<void> | void): Env {
  let injected = false
  return {
    ...env,
    DB: {
      prepare: harness.db.prepare.bind(harness.db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        if (!injected) {
          injected = true
          await mutate()
        }
        return harness.db.batch(statements)
      },
    } as D1Database,
  }
}

function envWithAfterBatchError(error: Error): Env {
  return {
    ...env,
    DB: {
      prepare: harness.db.prepare.bind(harness.db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        await harness.db.batch(statements)
        throw error
      },
    } as D1Database,
  }
}

function deleteDecisionAudit(targetId: string): void {
  harness.sqlite.exec('DROP TRIGGER mutation_audit_entries_no_delete')
  harness.sqlite.prepare(`DELETE FROM mutation_audit_entries WHERE target_id = ?`).run(targetId)
}

function seedExpiredOpen(dedupeKey: string): void {
  harness.sqlite.prepare(`
    INSERT INTO decision_requests (
      id, tenant, decision_class, decision_cause, dedupe_key, status,
      exact_authority_required, question, options_json, consequences_json,
      evidence_json, objective_id, requested_by_principal_kind,
      requested_by_principal_id, requested_by_member_id, expires_at,
      created_receipt_id, created_at
    ) VALUES (
      'decision-expired-open', ?, 'business_choice', 'business.choose', ?, 'open',
      'squad:lead', 'Old expired question?',
      '[{"id":"old-a","label":"Old A"},{"id":"old-b","label":"Old B"}]',
      '{"old-a":"Old A consequence","old-b":"Old B consequence"}',
      '{"source":"old"}', ?, 'member', ?, ?, '2000-01-01T00:00:00.000Z',
      NULL, '2000-01-01T00:00:00.000Z'
    )
  `).run(TENANT, dedupeKey, OBJECTIVE_ID, MEMBER_ID, MEMBER_ID)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  serverTime = sqliteNow()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(serverTime))
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('department-decision', 'decision', 'Decision');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD_ID}', 'department-decision', 'decision', 'Decision');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Decision Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('capability-decision', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'lead');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES (
      '${TOKEN_ID}', '${MEMBER_ID}', '${'e'.repeat(64)}', 'decision-token',
      'workspace', '${serverTime}', NULL, NULL, '${TENANT}',
      '${new Date(Date.parse(serverTime) + 24 * 60 * 60 * 1_000).toISOString()}'
    );
    INSERT INTO objectives (
      id, tenant, created_by_principal_kind, created_by_principal_id,
      created_by_member_id, squad_id, title, success_contract,
      authority_envelope, policy_json, budget_micro_usd, payload_json,
      payload_digest, accepted_at, created_at
    ) VALUES (
      '${OBJECTIVE_ID}', '${TENANT}', 'member', '${MEMBER_ID}', '${MEMBER_ID}',
      '${SQUAD_ID}', 'Decision objective', 'Resolve only genuine decisions',
      '{}', '{}', 0, '{}', '${'a'.repeat(64)}', '${serverTime}', '${serverTime}'
    );
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine decision requests', () => {
  it('maps the ten exact server causes to six classes and derived authority without caller overrides', async () => {
    const mappings: Array<[DecisionCause, string, string]> = [
      ['credential.mint', 'credential', 'org:admin'],
      ['credential.rotate', 'credential', 'org:admin'],
      ['credential.revoke', 'credential', 'org:admin'],
      ['deployment.production', 'deployment_or_migration', 'org:admin'],
      ['migration.production', 'deployment_or_migration', 'org:admin'],
      ['destructive.delete', 'destructive', 'org:admin'],
      ['destructive.destroy_runtime', 'destructive', 'org:admin'],
      ['spend.increase', 'spend', 'squad:lead'],
      ['cross_tenant.expand', 'cross_tenant', 'org:admin'],
      ['business.choose', 'business_choice', 'squad:lead'],
    ]
    for (const [index, [decisionCause, decisionClass, authority]] of mappings.entries()) {
      const created = await createDecisionRequest(env, auth(), input({
        decisionCause,
        dedupeKey: `decision-cause-${index}`,
        idempotencyKey: `decision-cause-create-${index}`,
      }))
      expect(created).toMatchObject({ decisionCause, decisionClass, exactAuthorityRequired: authority })
    }

    for (const forged of [
      { ...input(), decisionCause: 'retry.exhausted' },
      { ...input(), decisionCause: 'destructive.delete', decisionClass: 'business_choice' },
      { ...input(), decisionCause: 'credential.rotate', exactAuthorityRequired: 'squad:lead' },
    ]) {
      await expect(createDecisionRequest(env, auth(), forged as CreateDecisionRequestInput))
        .rejects.toMatchObject({ name: 'DecisionError', code: 'invalid_decision' })
    }
  })

  it('enforces offered options, exact consequences, nonempty bounded evidence, and expiry bounds', async () => {
    const invalid: CreateDecisionRequestInput[] = [
      input({ options: [{ id: 'only', label: 'Only' }] }),
      input({ options: Array.from({ length: 11 }, (_, i) => ({ id: `o-${i}`, label: `O ${i}` })) }),
      input({ options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] }),
      input({ options: [{ id: 'a', label: 'A', extra: true } as never, { id: 'b', label: 'B' }] }),
      input({ consequences: { subscription: 'Only one consequence' } }),
      input({ consequences: {
        subscription: 'Subscription consequence',
        usage: 'Usage consequence',
        extra: 'Not an option',
      } }),
      input({ consequences: { subscription: '', usage: 'Usage consequence' } }),
      input({ evidence: {} }),
      input({ evidence: { blob: 'x'.repeat(17_000) } }),
      input({ expiresAt: future((5 * 60 * 1_000) - 1) }),
      input({ expiresAt: future((30 * 24 * 60 * 60 * 1_000) + 1) }),
      input({ expiresAt: serverTime.replace('T', ' ') }),
    ]
    for (const [index, value] of invalid.entries()) {
      await expect(createDecisionRequest(env, auth(), {
        ...value,
        dedupeKey: `invalid-shape-${index}`,
        idempotencyKey: `invalid-shape-${index}`,
      })).rejects.toMatchObject({ name: 'DecisionError', code: 'invalid_decision' })
    }

    await expect(createDecisionRequest(env, auth(), input({
      expiresAt: future((5 * 60 * 1_000) + 1_000),
      dedupeKey: 'valid-min-expiry',
      idempotencyKey: 'valid-min-expiry',
    }))).resolves.toMatchObject({ dedupeKey: 'valid-min-expiry' })
    await expect(createDecisionRequest(env, auth(), input({
      expiresAt: future((30 * 24 * 60 * 60 * 1_000) - 1_000),
      dedupeKey: 'valid-max-expiry',
      idempotencyKey: 'valid-max-expiry',
    }))).resolves.toMatchObject({ dedupeKey: 'valid-max-expiry' })
  })

  it('deduplicates one open request, replays exact bytes, and requires its deterministic audit', async () => {
    const first = await createDecisionRequest(env, auth(), input())
    expect(await createDecisionRequest(env, auth(), input())).toEqual(first)
    vi.setSystemTime(new Date(Date.parse(serverTime) + (31 * 24 * 60 * 60 * 1_000)))
    harness.sqlite.prepare(`UPDATE member_tokens SET expires_at = NULL WHERE id = ?`).run(TOKEN_ID)
    expect(await createDecisionRequest(env, auth(), input())).toEqual(first)
    vi.setSystemTime(new Date(serverTime))
    harness.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ?`)
      .run(serverTime, TOKEN_ID)
    await expect(createDecisionRequest(env, auth(), input()))
      .rejects.toMatchObject({ name: 'DecisionError', code: 'decision_forbidden' })
    harness.sqlite.prepare(`UPDATE member_tokens SET revoked_at = NULL WHERE id = ?`).run(TOKEN_ID)
    await expect(createDecisionRequest(env, auth(), input({
      question: 'Changed request bytes must conflict.',
    }))).rejects.toMatchObject({ name: 'DecisionError', code: 'idempotency_conflict' })
    await expect(createDecisionRequest(env, auth(), input({
      idempotencyKey: 'different-key-same-dedupe',
    }))).rejects.toMatchObject({ name: 'DecisionError', code: 'decision_already_open' })

    deleteDecisionAudit(first.id)
    await expect(createDecisionRequest(env, auth(), input()))
      .rejects.toMatchObject({ name: 'DecisionError', code: 'decision_audit_invalid' })
  })

  it('lazily expires an open dedupe row atomically before creating a replacement', async () => {
    seedExpiredOpen('pricing-model-choice')
    const replacement = await createDecisionRequest(env, auth(), input())
    expect(harness.sqlite.prepare(`
      SELECT id, status FROM decision_requests WHERE dedupe_key = ? ORDER BY created_at
    `).all('pricing-model-choice')).toEqual([
      { id: 'decision-expired-open', status: 'expired' },
      { id: replacement.id, status: 'open' },
    ])
    expect(count('execution_receipts', "type = 'decision.created'")).toBe(1)
    expect(count('mutation_audit_entries', "target_kind = 'decision_request'")).toBe(2)
  })

  it('keeps concurrent expired-dedupe replacement single-winner and retryable', async () => {
    seedExpiredOpen('pricing-model-choice')
    let winner: Awaited<ReturnType<typeof createDecisionRequest>> | null = null
    const racedEnv = envWithBeforeBatch(async () => {
      winner = await createDecisionRequest(env, auth(), input())
    })
    await expect(createDecisionRequest(racedEnv, auth(), input())).rejects.toBeTruthy()
    expect(winner).not.toBeNull()
    expect(await createDecisionRequest(env, auth(), input())).toEqual(winner)
    expect(count('decision_requests', "status = 'open' AND dedupe_key = 'pricing-model-choice'"))
      .toBe(1)
  })

  it('resolves only a currently offered option with accepted consequences and nonempty evidence', async () => {
    const request = await createDecisionRequest(env, auth(), input())
    const invalid = [
      {
        decisionRequestId: request.id,
        idempotencyKey: 'resolve-unoffered',
        selectedOptionId: 'enterprise',
        consequencesAccepted: true,
        resolutionEvidence: { reason: 'Not offered' },
      },
      {
        decisionRequestId: request.id,
        idempotencyKey: 'resolve-unaccepted',
        selectedOptionId: 'subscription',
        consequencesAccepted: false,
        resolutionEvidence: { reason: 'Not accepted' },
      },
      {
        decisionRequestId: request.id,
        idempotencyKey: 'resolve-empty-evidence',
        selectedOptionId: 'subscription',
        consequencesAccepted: true,
        resolutionEvidence: {},
      },
    ]
    for (const value of invalid) {
      await expect(resolveDecisionRequest(env, auth(), value))
        .rejects.toMatchObject({ name: 'DecisionError', code: 'invalid_decision' })
    }
    expect(count('decision_request_resolutions')).toBe(0)
  })

  it('denies a squad lead from resolving high-risk causes and permits current org admin', async () => {
    const request = await createDecisionRequest(env, auth(), input({
      decisionCause: 'destructive.delete',
      dedupeKey: 'destructive-choice',
      idempotencyKey: 'destructive-create',
    }))
    const resolution = {
      decisionRequestId: request.id,
      idempotencyKey: 'destructive-resolution',
      selectedOptionId: 'subscription',
      consequencesAccepted: true as const,
      resolutionEvidence: { approval: 'Org admin approved deletion.' },
    }
    await expect(resolveDecisionRequest(env, auth(), resolution))
      .rejects.toMatchObject({ name: 'DecisionError', code: 'decision_forbidden' })

    harness.sqlite.prepare(`
      UPDATE capabilities SET scope_type = 'org', scope_id = NULL, capability = 'admin'
       WHERE member_id = ?
    `).run(MEMBER_ID)
    await expect(resolveDecisionRequest(env, adminAuth(), resolution))
      .resolves.toMatchObject({ selectedOptionId: 'subscription' })
  })

  it('replays an exact resolution, rejects changed reuse, and keeps resolution evidence immutable', async () => {
    const request = await createDecisionRequest(env, auth(), input())
    const resolutionInput = {
      decisionRequestId: request.id,
      idempotencyKey: 'decision-resolution-1',
      selectedOptionId: 'subscription',
      consequencesAccepted: true as const,
      resolutionEvidence: { rationale: 'Predictable revenue matches the objective.' },
    }
    const resolved = await resolveDecisionRequest(env, auth(), resolutionInput)
    expect(await resolveDecisionRequest(env, auth(), resolutionInput)).toEqual(resolved)
    await expect(resolveDecisionRequest(env, auth(), {
      ...resolutionInput,
      selectedOptionId: 'usage',
    })).rejects.toMatchObject({ name: 'DecisionError', code: 'idempotency_conflict' })
    expect(() => harness.sqlite.prepare(`
      UPDATE decision_request_resolutions SET resolution_json = '{}' WHERE id = ?
    `).run(resolved.id)).toThrow(/immutable/i)
    expect(() => harness.sqlite.prepare(`
      UPDATE execution_receipts SET claims_json = '{}' WHERE id = ?
    `).run(resolved.resolutionReceiptId)).toThrow(/append-only/i)
  })

  it('rechecks expiry and mutable authority inside resolution transaction', async () => {
    const expiring = await createDecisionRequest(env, auth(), input({
      dedupeKey: 'expiring-race',
      idempotencyKey: 'expiring-race-create',
    }))
    const expiryRacedEnv = envWithBeforeBatch(() => {
      harness.sqlite.exec('DROP TRIGGER decision_requests_identity_immutable')
      harness.sqlite.prepare(`UPDATE decision_requests SET expires_at = ? WHERE id = ?`)
        .run('2000-01-01T00:00:00.000Z', expiring.id)
    })
    await expect(resolveDecisionRequest(expiryRacedEnv, auth(), {
      decisionRequestId: expiring.id,
      idempotencyKey: 'expiring-race-resolution',
      selectedOptionId: 'subscription',
      consequencesAccepted: true,
      resolutionEvidence: { rationale: 'Would otherwise be valid.' },
    })).rejects.toBeTruthy()

    const authorityRequest = await createDecisionRequest(env, auth(), input({
      dedupeKey: 'authority-race',
      idempotencyKey: 'authority-race-create',
    }))
    const authorityRacedEnv = envWithBeforeBatch(() => {
      harness.sqlite.prepare(`DELETE FROM capabilities WHERE member_id = ?`).run(MEMBER_ID)
    })
    await expect(resolveDecisionRequest(authorityRacedEnv, auth(), {
      decisionRequestId: authorityRequest.id,
      idempotencyKey: 'authority-race-resolution',
      selectedOptionId: 'subscription',
      consequencesAccepted: true,
      resolutionEvidence: { rationale: 'Would otherwise be valid.' },
    })).rejects.toBeTruthy()
    expect(count('decision_request_resolutions')).toBe(0)
  })

  it('does not convert a postcommit error into success', async () => {
    const value = input({
      dedupeKey: 'postcommit-decision',
      idempotencyKey: 'postcommit-decision',
    })
    const failure = new Error('postcommit decision transport failed')
    await expect(createDecisionRequest(envWithAfterBatchError(failure), auth(), value))
      .rejects.toBe(failure)
    expect(count('decision_requests', "dedupe_key = 'postcommit-decision'"))
      .toBe(1)
    await expect(createDecisionRequest(env, auth(), value))
      .resolves.toMatchObject({ dedupeKey: 'postcommit-decision' })
  })
})
