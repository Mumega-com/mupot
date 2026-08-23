import { createHash } from 'node:crypto'
import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordHostControlFact,
  type RecordHostControlFactInput,
} from '../src/flight-spine/host-control'
import { canonicalJson } from '../src/lib/canonical-json'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-host-control'
const NOW = '2030-08-23T16:00:00.000Z'
const MEMBER_ID = 'member-host-control'
const AGENT_ID = 'agent-host-control'
const TOKEN_ID = 'token-host-control'
const SEAT_ID = 'seat-host-control'
const OBSERVATION_RECEIPT_ID = 'receipt-host-observed-1'
const REQUEST_SIGNATURE_DIGEST = 'a'.repeat(64)
const OBSERVATION_SIGNATURE_DIGEST = 'b'.repeat(64)

let harness: SqliteD1Harness
let env: Env

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'host-control@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    tokenId: TOKEN_ID,
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: 'squad-host-control',
      capability: 'member',
    }],
    ...overrides,
  }
}

function input(overrides: Partial<RecordHostControlFactInput> = {}): RecordHostControlFactInput {
  return {
    principalKind: 'agent',
    principalId: AGENT_ID,
    origin: 'signed_wrapper',
    hostId: 'host-control-1',
    unitName: 'mupot-runtime-agent-host-control',
    runtimeSeatId: SEAT_ID,
    processGeneration: 1,
    action: 'restart',
    reason: 'Observed wrapper restart after a declared health failure.',
    requestId: 'host-control-request-1',
    idempotencyKey: 'host-control-idempotency-1',
    requestSignatureDigest: REQUEST_SIGNATURE_DIGEST,
    observationSignatureDigest: OBSERVATION_SIGNATURE_DIGEST,
    observedResult: 'succeeded',
    observationReceiptId: OBSERVATION_RECEIPT_ID,
    observedAt: NOW,
    ...overrides,
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function observationClaims(value: RecordHostControlFactInput): Record<string, unknown> {
  return {
    action: value.action,
    hostId: value.hostId,
    observationSignatureDigest: value.observationSignatureDigest,
    observedAt: value.observedAt,
    observedResult: value.observedResult,
    origin: value.origin,
    principalId: value.principalId,
    principalKind: value.principalKind,
    processGeneration: value.processGeneration,
    reason: value.reason,
    requestId: value.requestId,
    requestSignatureDigest: value.requestSignatureDigest,
    runtimeSeatId: value.runtimeSeatId ?? null,
    unitName: value.unitName,
  }
}

function insertObservationReceipt(value: RecordHostControlFactInput): void {
  const claims = observationClaims(value)
  const claimsJson = canonicalJson(claims)
  const payload = canonicalJson({
    tenant: TENANT,
    type: 'host_control.observed',
    issuer_kind: 'adapter',
    issuer_id: 'signed-host-wrapper',
    actor_kind: 'agent',
    actor_id: value.principalId,
    seat_id: value.runtimeSeatId ?? null,
    seat_generation: value.runtimeSeatId ? value.processGeneration : null,
    objective_id: null,
    flight_id: null,
    task_id: null,
    message_id: null,
    assignment_epoch: null,
    fencing_epoch: null,
    lease_token_hash: null,
    idempotency_key: `observed:${value.requestId}`,
    claims,
    predecessor_receipt_id: null,
    predecessor_hash: null,
    server_timestamp: value.observedAt,
  })
  harness.sqlite.prepare(`
    INSERT INTO execution_receipts (
      id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
      seat_id, seat_generation, objective_id, flight_id, task_id, message_id,
      assignment_epoch, fencing_epoch, lease_token_hash, idempotency_key,
      claims_json, canonical_payload, payload_digest, predecessor_receipt_id,
      predecessor_hash, receipt_hash, server_timestamp
    ) VALUES (
      ?, ?, 'host_control.observed', 'adapter', 'signed-host-wrapper', 'agent', ?,
      ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?
    )
  `).run(
    value.observationReceiptId,
    TENANT,
    value.principalId,
    value.runtimeSeatId ?? null,
    value.runtimeSeatId ? value.processGeneration : null,
    `observed:${value.requestId}`,
    claimsJson,
    payload,
    sha256(claimsJson),
    sha256(payload),
    value.observedAt,
  )
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
      VALUES ('department-host-control', 'host-control', 'Host Control');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-host-control', 'department-host-control', 'host-control', 'Host Control');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${AGENT_ID}', 'squad-host-control', 'host-control', 'Host Control', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-host-control', '${AGENT_ID}', 'squad-host-control', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Host Control Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '${NOW}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('capability-host-control', '${MEMBER_ID}', 'squad', 'squad-host-control', 'member');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES (
      '${TOKEN_ID}', '${MEMBER_ID}', '${'c'.repeat(64)}', 'host-control-token',
      'workspace', '${NOW}', NULL, '${AGENT_ID}', '${TENANT}',
      '2031-08-23T16:00:00.000Z'
    );
    INSERT INTO runtime_seats (
      id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
      current_generation, current_fencing_epoch, process_public_key,
      capabilities_json, created_at, updated_at
    ) VALUES (
      '${SEAT_ID}', '${TENANT}', '${AGENT_ID}', 'host-control-seat',
      'host-control-1', 'test', 'active', 1, 0, 'public-key', '[]', '${NOW}', '${NOW}'
    );
    INSERT INTO runtime_seat_generations (
      id, tenant, runtime_seat_id, generation, host_id, process_id,
      process_uid, sandbox_id, executable_digest, public_key,
      broker_attestation_digest, started_at, created_at
    ) VALUES (
      'generation-host-control-1', '${TENANT}', '${SEAT_ID}', 1, 'host-control-1',
      'pid-host-control', 'uid-host-control', 'sandbox-host-control',
      '${'d'.repeat(64)}', 'public-key', '${'e'.repeat(64)}', '${NOW}', '${NOW}'
    );
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine host-control facts', () => {
  it('records only a signed observed fact and a receipt-owned audited request without executing a host action', async () => {
    const value = input()
    insertObservationReceipt(value)
    const fact = await recordHostControlFact(env, auth(), value)

    expect(fact).toMatchObject({
      tenant: TENANT,
      principalKind: 'agent',
      principalId: AGENT_ID,
      credentialId: TOKEN_ID,
      runtimeSeatId: SEAT_ID,
      processGeneration: 1,
      action: 'restart',
      observedResult: 'succeeded',
      observationReceiptId: OBSERVATION_RECEIPT_ID,
    })
    expect(harness.sqlite.prepare(`
      SELECT type, actor_kind, actor_id FROM execution_receipts
       WHERE id = ?
    `).get(fact.requestReceiptId)).toEqual({
      type: 'host_control.requested',
      actor_kind: 'agent',
      actor_id: AGENT_ID,
    })
    expect(count('host_control_receipts')).toBe(1)
    expect(count('mutation_audit_entries')).toBe(1)
  })

  it('rejects shell/PTY origins, unknown principals, missing generation, and unsigned observations', async () => {
    const cases: Array<[string, RecordHostControlFactInput]> = [
      ['shell', input({ origin: 'shell' } as never)],
      ['pty', input({ origin: 'pty' } as never)],
      ['unknown principal', input({ principalKind: 'member' } as never)],
      ['missing generation', input({ processGeneration: undefined } as never)],
      ['missing request signature', input({ requestSignatureDigest: '' })],
      ['missing observation signature', input({ observationSignatureDigest: '' })],
    ]
    for (const [, value] of cases) {
      await expect(recordHostControlFact(env, auth(), value))
        .rejects.toMatchObject({ name: 'HostControlError', code: 'invalid_host_control_fact' })
    }
    expect(count('host_control_receipts')).toBe(0)
    expect(count('execution_receipts')).toBe(0)
  })

  it('requires the exact signed observation and transaction-time live principal authority', async () => {
    const value = input()
    insertObservationReceipt({ ...value, observedResult: 'failed' })
    await expect(recordHostControlFact(env, auth(), value))
      .rejects.toMatchObject({ name: 'HostControlError', code: 'observation_receipt_invalid' })

    const validValue = {
      ...value,
      observationReceiptId: 'receipt-host-observed-2',
      requestId: 'host-control-request-2',
      idempotencyKey: 'host-control-idempotency-2',
    }
    insertObservationReceipt(validValue)
    const racingEnv = envWithBeforeBatch(() => {
      harness.sqlite.prepare(`DELETE FROM capabilities WHERE member_id = ?`).run(MEMBER_ID)
    })
    await expect(recordHostControlFact(racingEnv, auth(), validValue))
      .rejects.toMatchObject({ name: 'HostControlError', code: 'host_control_persistence_conflict' })
    expect(count('host_control_receipts')).toBe(0)
    expect(count('mutation_audit_entries')).toBe(0)
    expect(count('execution_receipts')).toBe(2)
  })
})
