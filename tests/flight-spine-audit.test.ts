import { createHash } from 'node:crypto'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  auditMutation,
  type MutationAuditInput,
} from '../src/flight-spine/audit'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-audit'
const NOW = '2030-08-23T16:00:00.000Z'
const MEMBER_ID = 'member-audit'
const AGENT_ID = 'agent-audit'
const TOKEN_ID = 'token-audit'
const SEAT_ID = 'seat-audit'

let harness: SqliteD1Harness
let env: Env

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'audit@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    tokenId: TOKEN_ID,
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: 'squad-audit',
      capability: 'member',
    }],
    ...overrides,
  }
}

function input(overrides: Partial<MutationAuditInput> = {}): MutationAuditInput {
  return {
    origin: 'rest',
    handler: 'flight_spine.test_mutation',
    operation: 'update',
    targetKind: 'task',
    targetId: 'task-audit',
    before: { password: 'not-for-the-ledger', version: 1 },
    after: { version: 2 },
    runtimeSeatId: SEAT_ID,
    runtimeGeneration: 1,
    requestId: 'request-audit-1',
    idempotencyKey: 'audit-idempotency-1',
    evidence: {
      apiToken: 'raw-token-value',
      note: 'Authorization: Bearer raw-bearer-value',
    },
    ...overrides,
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function count(table: string): number {
  return Number((harness.sqlite.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).get() as { count: number }).count)
}

function envWithBeforeAuditInsert(mutate: () => void): Env {
  let injected = false
  const wrap = (statement: D1PreparedStatement, matches: boolean): D1PreparedStatement => ({
    bind(...values: unknown[]) {
      return wrap(statement.bind(...values), matches)
    },
    async run<T>() {
      if (matches && !injected) {
        injected = true
        mutate()
      }
      return statement.run<T>()
    },
    first: statement.first.bind(statement),
    all: statement.all.bind(statement),
    raw: statement.raw.bind(statement),
  }) as D1PreparedStatement
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        const statement = env.DB.prepare(sql)
        return wrap(statement, /INSERT INTO mutation_audit_entries/.test(sql))
      },
      batch: env.DB.batch.bind(env.DB),
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
      VALUES ('department-audit', 'audit', 'Audit');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-audit', 'department-audit', 'audit', 'Audit');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${AGENT_ID}', 'squad-audit', 'audit', 'Audit', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-audit', '${AGENT_ID}', 'squad-audit', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Audit Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '${NOW}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('capability-audit', '${MEMBER_ID}', 'squad', 'squad-audit', 'member');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES (
      '${TOKEN_ID}', '${MEMBER_ID}', '${'a'.repeat(64)}', 'audit-token',
      'workspace', '${NOW}', NULL, '${AGENT_ID}', '${TENANT}',
      '2031-08-23T16:00:00.000Z'
    );
    INSERT INTO runtime_seats (
      id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
      current_generation, current_fencing_epoch, process_public_key,
      capabilities_json, created_at, updated_at
    ) VALUES (
      '${SEAT_ID}', '${TENANT}', '${AGENT_ID}', 'audit-seat', 'host-audit',
      'test', 'active', 1, 0, 'public-key', '[]', '${NOW}', '${NOW}'
    );
    INSERT INTO runtime_seat_generations (
      id, tenant, runtime_seat_id, generation, host_id, process_id,
      process_uid, sandbox_id, executable_digest, public_key,
      broker_attestation_digest, started_at, created_at
    ) VALUES (
      'generation-audit-1', '${TENANT}', '${SEAT_ID}', 1, 'host-audit',
      'pid-audit', 'uid-audit', 'sandbox-audit', '${'b'.repeat(64)}',
      'public-key', '${'c'.repeat(64)}', '${NOW}', '${NOW}'
    );
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine mutation audit', () => {
  it('attributes the authenticated principal and canonical before/after digests without raw secrets', async () => {
    const record = await auditMutation(env, auth(), input())

    expect(record).toMatchObject({
      tenant: TENANT,
      principalKind: 'agent',
      principalId: AGENT_ID,
      memberId: MEMBER_ID,
      agentId: AGENT_ID,
      credentialId: TOKEN_ID,
      runtimeSeatId: SEAT_ID,
      runtimeGeneration: 1,
      origin: 'rest',
      handler: 'flight_spine.test_mutation',
      beforeDigest: sha256('{"password":"[redacted]","version":1}'),
      afterDigest: sha256('{"version":2}'),
    })
    expect(record.evidence).toEqual({
      apiToken: '[redacted]',
      note: 'Authorization: [redacted]',
    })
    const persisted = JSON.stringify(harness.sqlite.prepare(`
      SELECT * FROM mutation_audit_entries WHERE id = ?
    `).get(record.id))
    expect(persisted).not.toContain('not-for-the-ledger')
    expect(persisted).not.toContain('raw-token-value')
    expect(persisted).not.toContain('raw-bearer-value')
  })

  it('returns an exact replay, rejects changed reuse, and leaves audit rows immutable', async () => {
    const first = await auditMutation(env, auth(), input())
    expect(await auditMutation(env, auth(), input())).toEqual(first)
    await expect(auditMutation(env, auth(), input({ after: { version: 3 } })))
      .rejects.toMatchObject({ name: 'MutationAuditError', code: 'audit_conflict' })

    expect(() => harness.sqlite.prepare(`
      UPDATE mutation_audit_entries SET operation = 'delete' WHERE id = ?
    `).run(first.id)).toThrow(/append-only/i)
    expect(() => harness.sqlite.prepare(`
      DELETE FROM mutation_audit_entries WHERE id = ?
    `).run(first.id)).toThrow(/append-only/i)
  })

  it('rejects shell or PTY origins and rechecks the live credential at write time', async () => {
    for (const origin of ['shell', 'pty'] as const) {
      await expect(auditMutation(env, auth(), input({ origin } as never)))
        .rejects.toMatchObject({ name: 'MutationAuditError', code: 'invalid_audit' })
    }

    const racingEnv = envWithBeforeAuditInsert(() => {
      harness.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ?`)
        .run(NOW, TOKEN_ID)
    })
    await expect(auditMutation(racingEnv, auth(), input({ requestId: 'request-revoked' })))
      .rejects.toMatchObject({
        name: 'MutationAuditError',
        code: 'audit_persistence_conflict',
      })
    expect(count('mutation_audit_entries')).toBe(0)
  })
})
