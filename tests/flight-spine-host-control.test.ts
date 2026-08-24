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
const MEMBER_ID = 'member-host-control'
const AGENT_ID = 'agent-host-control'
const TOKEN_ID = 'token-host-control'
const SEAT_ID = 'seat-host-control'
const REQUEST_SIGNATURE_DIGEST = 'a'.repeat(64)
const OBSERVATION_SIGNATURE_DIGEST = 'b'.repeat(64)

let harness: SqliteD1Harness
let env: Env
let serverTime: string

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
    observationReceiptId: 'receipt-host-observed-1',
    observedAt: serverTime,
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
    origin: 'signed_wrapper',
    principalId: AGENT_ID,
    principalKind: 'agent',
    processGeneration: value.processGeneration,
    reason: value.reason,
    requestId: value.requestId,
    requestSignatureDigest: value.requestSignatureDigest,
    runtimeSeatId: value.runtimeSeatId,
    unitName: value.unitName,
  }
}

interface ObservationOverrides {
  issuerKind?: 'adapter' | 'runtime' | 'mupot'
  actorKind?: 'agent' | 'system' | 'controller'
  actorId?: string
  seatId?: string | null
  seatGeneration?: number | null
  objectiveId?: string | null
  flightId?: string | null
  taskId?: string | null
  claims?: Record<string, unknown>
}

function insertObservationReceipt(
  value: RecordHostControlFactInput,
  overrides: ObservationOverrides = {},
): void {
  const claims = overrides.claims ?? observationClaims(value)
  const claimsJson = canonicalJson(claims)
  const issuerKind = overrides.issuerKind ?? 'adapter'
  const actorKind = overrides.actorKind ?? 'agent'
  const actorId = overrides.actorId ?? AGENT_ID
  const seatId = overrides.seatId === undefined ? value.runtimeSeatId : overrides.seatId
  const seatGeneration = overrides.seatGeneration === undefined
    ? value.processGeneration
    : overrides.seatGeneration
  const objectiveId = overrides.objectiveId === undefined
    ? (value.objectiveId ?? null)
    : overrides.objectiveId
  const flightId = overrides.flightId === undefined ? (value.flightId ?? null) : overrides.flightId
  const taskId = overrides.taskId === undefined ? (value.taskId ?? null) : overrides.taskId
  const payload = canonicalJson({
    tenant: TENANT,
    type: 'host_control.observed',
    issuer_kind: issuerKind,
    issuer_id: 'signed-host-wrapper',
    actor_kind: actorKind,
    actor_id: actorId,
    seat_id: seatId,
    seat_generation: seatGeneration,
    objective_id: objectiveId,
    flight_id: flightId,
    task_id: taskId,
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
      ?, ?, 'host_control.observed', ?, 'signed-host-wrapper', ?, ?,
      ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?
    )
  `).run(
    value.observationReceiptId,
    TENANT,
    issuerKind,
    actorKind,
    actorId,
    seatId,
    seatGeneration,
    objectiveId,
    flightId,
    taskId,
    `observed:${value.requestId}`,
    claimsJson,
    payload,
    sha256(claimsJson),
    sha256(payload),
    value.observedAt,
  )
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

function deleteHostAudit(): void {
  harness.sqlite.exec('DROP TRIGGER mutation_audit_entries_no_delete')
  harness.sqlite.exec(`DELETE FROM mutation_audit_entries WHERE target_kind = 'host_control_receipt'`)
}

function corruptHostAudit(): void {
  harness.sqlite.exec('DROP TRIGGER mutation_audit_entries_no_update')
  harness.sqlite.exec(`
    UPDATE mutation_audit_entries SET handler = 'flight_spine.corrupt_host_audit'
     WHERE target_kind = 'host_control_receipt'
  `)
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  serverTime = sqliteNow()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(serverTime))
  const tokenExpiry = new Date(Date.parse(serverTime) + 24 * 60 * 60 * 1_000).toISOString()
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
      VALUES ('${TENANT}', '${AGENT_ID}', '${MEMBER_ID}', '${serverTime}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('capability-host-control', '${MEMBER_ID}', 'squad', 'squad-host-control', 'member');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES (
      '${TOKEN_ID}', '${MEMBER_ID}', '${'c'.repeat(64)}', 'host-control-token',
      'workspace', '${serverTime}', NULL, '${AGENT_ID}', '${TENANT}', '${tokenExpiry}'
    );
    INSERT INTO runtime_seats (
      id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
      current_generation, current_fencing_epoch, process_public_key,
      capabilities_json, created_at, updated_at
    ) VALUES (
      '${SEAT_ID}', '${TENANT}', '${AGENT_ID}', 'host-control-seat',
      'host-control-1', 'test', 'active', 1, 0, 'public-key', '[]',
      '${serverTime}', '${serverTime}'
    );
    INSERT INTO runtime_seat_generations (
      id, tenant, runtime_seat_id, generation, host_id, process_id,
      process_uid, sandbox_id, executable_digest, public_key,
      broker_attestation_digest, started_at, created_at
    ) VALUES (
      'generation-host-control-1', '${TENANT}', '${SEAT_ID}', 1, 'host-control-1',
      'pid-host-control', 'uid-host-control', 'sandbox-host-control',
      '${'d'.repeat(64)}', 'public-key', '${'e'.repeat(64)}',
      '${serverTime}', '${serverTime}'
    );
    INSERT INTO runtime_seat_generations (
      id, tenant, runtime_seat_id, generation, host_id, process_id,
      process_uid, sandbox_id, executable_digest, public_key,
      broker_attestation_digest, started_at, created_at
    ) VALUES (
      'generation-host-control-2', '${TENANT}', '${SEAT_ID}', 2, 'host-control-1',
      'pid-host-control-2', 'uid-host-control', 'sandbox-host-control-2',
      '${'f'.repeat(64)}', 'public-key-2', '${'0'.repeat(64)}',
      '${serverTime}', '${serverTime}'
    );
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine host-control facts', () => {
  it('derives the exact active seat agent and records digest-correlated facts without executing a host action', async () => {
    const value = input()
    insertObservationReceipt(value)
    const fact = await recordHostControlFact(env, auth(), value)

    expect(fact).toMatchObject({
      tenant: TENANT,
      principalKind: 'agent',
      principalId: AGENT_ID,
      credentialId: TOKEN_ID,
      runtimeSeatId: SEAT_ID,
      origin: 'signed_wrapper',
      processGeneration: 1,
      observationReceiptId: value.observationReceiptId,
    })
    expect(harness.sqlite.prepare(`
      SELECT type, actor_kind, actor_id, seat_id, seat_generation
        FROM execution_receipts WHERE id = ?
    `).get(fact.requestReceiptId)).toEqual({
      type: 'host_control.requested',
      actor_kind: 'agent',
      actor_id: AGENT_ID,
      seat_id: SEAT_ID,
      seat_generation: 1,
    })
    expect(count('host_control_receipts')).toBe(1)
    expect(count('mutation_audit_entries', "target_kind = 'host_control_receipt'")).toBe(1)
  })

  it('rejects caller-selected principals, missing/stale seats or generations, and non-wrapper origins', async () => {
    const invalid = [
      input({ runtimeSeatId: null } as never),
      input({ processGeneration: 2 }),
      { ...input(), principalKind: 'controller', principalId: 'controller-known' },
      { ...input(), origin: 'controller' },
    ]
    for (const value of invalid) {
      await expect(recordHostControlFact(env, auth(), value as RecordHostControlFactInput))
        .rejects.toMatchObject({
          name: 'HostControlError',
          code: expect.stringMatching(/invalid_host_control_fact|host_control_forbidden/),
        })
    }
    expect(count('host_control_receipts')).toBe(0)
  })

  it('rejects stale observations and issuer, actor, seat, generation, or correlation mismatches', async () => {
    const stale = input({
      requestId: 'host-stale',
      idempotencyKey: 'host-stale',
      observationReceiptId: 'receipt-host-stale',
      observedAt: new Date(Date.parse(serverTime) - 91_000).toISOString(),
    })
    insertObservationReceipt(stale)
    await expect(recordHostControlFact(env, auth(), stale))
      .rejects.toMatchObject({ name: 'HostControlError', code: 'observation_stale' })

    const mismatches: Array<[string, ObservationOverrides]> = [
      ['issuer', { issuerKind: 'mupot' }],
      ['actor', { actorKind: 'controller', actorId: 'controller-known' }],
      ['seat', { seatId: null, seatGeneration: null }],
      ['generation', { seatGeneration: 2 }],
      ['correlation', { taskId: 'task-other' }],
      ['claims', { claims: { wrong: true } }],
    ]
    for (const [index, [label, overrides]] of mismatches.entries()) {
      const value = input({
        requestId: `host-mismatch-${label}`,
        idempotencyKey: `host-mismatch-${label}`,
        observationReceiptId: `receipt-host-mismatch-${index}`,
      })
      insertObservationReceipt(value, overrides)
      await expect(recordHostControlFact(env, auth(), value))
        .rejects.toMatchObject({ name: 'HostControlError', code: 'observation_receipt_invalid' })
    }
  })

  it('rechecks seat, credential, and current capability inside the receipt-owned transaction', async () => {
    const cases: Array<[string, () => void]> = [
      ['seat state', () => harness.sqlite.prepare(`
        UPDATE runtime_seats SET state = 'revoked', revoked_at = ? WHERE id = ?
      `).run(serverTime, SEAT_ID)],
      ['credential', () => harness.sqlite.prepare(`
        UPDATE member_tokens SET revoked_at = ? WHERE id = ?
      `).run(serverTime, TOKEN_ID)],
      ['authority', () => harness.sqlite.prepare(`
        DELETE FROM capabilities WHERE member_id = ?
      `).run(MEMBER_ID)],
    ]
    for (const [index, [, mutate]] of cases.entries()) {
      const value = input({
        requestId: `host-race-${index}`,
        idempotencyKey: `host-race-${index}`,
        observationReceiptId: `receipt-host-race-${index}`,
      })
      insertObservationReceipt(value)
      await expect(recordHostControlFact(envWithBeforeBatch(mutate), auth(), value)).rejects.toBeTruthy()
      expect(count('host_control_receipts')).toBe(0)
      expect(count('mutation_audit_entries')).toBe(0)
      if (index === 0) {
        harness.sqlite.prepare(`
          UPDATE runtime_seats SET state = 'active', revoked_at = NULL WHERE id = ?
        `).run(SEAT_ID)
      } else if (index === 1) {
        harness.sqlite.prepare(`UPDATE member_tokens SET revoked_at = NULL WHERE id = ?`).run(TOKEN_ID)
      } else {
        harness.sqlite.prepare(`
          INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
          VALUES ('capability-host-control-restored', ?, 'squad', 'squad-host-control', 'member')
        `).run(MEMBER_ID)
      }
    }
  })

  it('requires an exact deterministic audit on replay and rejects changed reuse', async () => {
    const value = input()
    insertObservationReceipt(value)
    const first = await recordHostControlFact(env, auth(), value)
    expect(await recordHostControlFact(env, auth(), value)).toEqual(first)
    vi.setSystemTime(new Date(Date.parse(serverTime) + 120_000))
    expect(await recordHostControlFact(env, auth(), value)).toEqual(first)
    vi.setSystemTime(new Date(serverTime))
    harness.sqlite.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ?`)
      .run(serverTime, TOKEN_ID)
    await expect(recordHostControlFact(env, auth(), value))
      .rejects.toMatchObject({ name: 'HostControlError', code: 'host_control_forbidden' })
    harness.sqlite.prepare(`UPDATE member_tokens SET revoked_at = NULL WHERE id = ?`).run(TOKEN_ID)
    await expect(recordHostControlFact(env, auth(), {
      ...value,
      reason: 'Changed reason must conflict.',
    })).rejects.toMatchObject({ name: 'HostControlError', code: 'idempotency_conflict' })

    deleteHostAudit()
    await expect(recordHostControlFact(env, auth(), value))
      .rejects.toMatchObject({ name: 'HostControlError', code: 'host_control_audit_invalid' })
  })

  it('rejects a conflicting replay audit and preserves a postcommit error', async () => {
    const firstValue = input()
    insertObservationReceipt(firstValue)
    await recordHostControlFact(env, auth(), firstValue)
    corruptHostAudit()
    await expect(recordHostControlFact(env, auth(), firstValue))
      .rejects.toMatchObject({ name: 'HostControlError', code: 'host_control_audit_invalid' })
  })

  it('does not turn a postcommit transport failure into success', async () => {
    const value = input({
      requestId: 'host-postcommit',
      idempotencyKey: 'host-postcommit',
      observationReceiptId: 'receipt-host-postcommit',
    })
    insertObservationReceipt(value)
    const failure = new Error('postcommit host-control transport failed')
    await expect(recordHostControlFact(envWithAfterBatchError(failure), auth(), value))
      .rejects.toBe(failure)
    expect(count('host_control_receipts')).toBe(1)
    expect(await recordHostControlFact(env, auth(), value)).toMatchObject({ requestId: value.requestId })
  })
})
