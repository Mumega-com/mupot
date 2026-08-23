import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordArtifactMetadata,
  recordArtifactRetrieval,
  type RecordArtifactMetadataInput,
  type RecordArtifactRetrievalInput,
} from '../src/flight-spine/artifacts'
import {
  linkChildFlight,
  recordConsumedChildArtifact,
  type FlightDependency,
} from '../src/flight-spine/dependencies'
import { canonicalJson, sha256Hex } from '../src/lib/canonical-json'
import { acceptObjective, type AcceptedObjective } from '../src/flight-spine/objectives'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-artifacts'
const SQUAD_ID = 'squad-artifacts'
const PARENT_AGENT = 'agent-parent-artifacts'
const PRODUCER_AGENT = 'agent-producer-artifacts'
const VERIFIER_AGENT = 'agent-verifier-artifacts'
const PARENT_MEMBER = 'member-parent-artifacts'
const PRODUCER_MEMBER = 'member-producer-artifacts'
const VERIFIER_MEMBER = 'member-verifier-artifacts'
const PARENT_FLIGHT = 'flight-parent-artifacts'
const CHILD_FLIGHT = 'flight-child-artifacts'
const PRODUCER_ASSIGNMENT = 'assignment-producer-artifacts'
const VERIFIER_ASSIGNMENT = 'assignment-verifier-artifacts'
const PARENT_ASSIGNMENT = 'assignment-parent-artifacts'
const PRODUCER_TASK = 'task-producer-artifacts'
const VERIFIER_TASK = 'task-verifier-artifacts'
const PARENT_TASK = 'task-parent-artifacts'
const PRODUCER_SEAT = 'seat-producer-artifacts'
const VERIFIER_SEAT = 'seat-verifier-artifacts'
const PARENT_SEAT = 'seat-parent-artifacts'
const DIGEST = 'a'.repeat(64)
const ARTIFACT_ID = 'artifact-child-output'

let harness: SqliteD1Harness
let env: Env
let objective: AcceptedObjective
let dependency: FlightDependency
let serverTime: string
let retentionUntil: string

function authFor(
  memberId: string,
  agentId: string,
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: agentId,
    capabilities: [{
      member_id: memberId,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'member',
    }],
    ...overrides,
  }
}

const parentAuth = (overrides: Partial<AuthContext> = {}) =>
  authFor(PARENT_MEMBER, PARENT_AGENT, overrides)
const producerAuth = (overrides: Partial<AuthContext> = {}) =>
  authFor(PRODUCER_MEMBER, PRODUCER_AGENT, overrides)
const verifierAuth = (overrides: Partial<AuthContext> = {}) =>
  authFor(VERIFIER_MEMBER, VERIFIER_AGENT, overrides)

function sqliteNow(): string {
  const row = harness.sqlite.prepare(`
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value
  `).get() as { value: string }
  return row.value
}

function plusDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + (days * 24 * 60 * 60 * 1_000)).toISOString()
}

function count(table: string, where = ''): number {
  return Number((harness.sqlite.prepare(`
    SELECT COUNT(*) AS count FROM ${table} ${where}
  `).get() as { count: number }).count)
}

function receiptChainCounts(): { receipts: number; heads: number; edges: number } {
  return {
    receipts: count('execution_receipts'),
    heads: count('execution_receipt_heads'),
    edges: count('execution_receipt_edges'),
  }
}

function metadataInput(
  overrides: Partial<RecordArtifactMetadataInput> = {},
): RecordArtifactMetadataInput {
  return {
    artifactId: ARTIFACT_ID,
    producingAssignmentId: PRODUCER_ASSIGNMENT,
    storageReceiptId: `receipt-stored-${ARTIFACT_ID}`,
    objectKey: `sha256/${DIGEST.slice(0, 2)}/${DIGEST}`,
    digest: DIGEST,
    sizeBytes: 4_096,
    visibility: 'tenant',
    retentionUntil,
    repositoryUrl: null,
    commitSha: null,
    repositoryPath: null,
    ...overrides,
  }
}

function storageClaims(input: RecordArtifactMetadataInput): Record<string, unknown> {
  return {
    artifactId: input.artifactId,
    producingAssignmentId: input.producingAssignmentId,
    objectKey: input.objectKey,
    digest: input.digest,
    sizeBytes: input.sizeBytes,
    visibility: input.visibility,
    retentionUntil: input.retentionUntil,
    repositoryUrl: input.repositoryUrl ?? null,
    commitSha: input.commitSha ?? null,
    repositoryPath: input.repositoryPath ?? null,
  }
}

interface FutureReceiptInput {
  id: string
  type: 'artifact.stored' | 'artifact.retrieved' | 'result.reported'
  issuerKind?: 'artifact_service' | 'mupot'
  issuerId?: string
  actorKind?: 'member' | 'agent' | 'system' | 'controller'
  actorId: string
  seatId: string | null
  seatGeneration: number | null
  objectiveId?: string | null
  flightId: string | null
  taskId: string | null
  assignmentEpoch: number | null
  claims: Record<string, unknown>
  payloadDigestOverride?: string
  receiptHashOverride?: string
}

async function insertFutureReceipt(input: FutureReceiptInput): Promise<void> {
  const issuerKind = input.issuerKind ?? 'artifact_service'
  const issuerId = input.issuerId ?? 'artifact-service-test'
  const actorKind = input.actorKind ?? 'agent'
  const claimsJson = canonicalJson(input.claims)
  const payloadDigest = input.payloadDigestOverride ?? await sha256Hex(claimsJson)
  const payloadFacts = {
    tenant: TENANT,
    type: input.type,
    issuer_kind: issuerKind,
    issuer_id: issuerId,
    actor_kind: actorKind,
    actor_id: input.actorId,
    seat_id: input.seatId,
    seat_generation: input.seatGeneration,
    objective_id: input.objectiveId === undefined ? objective.id : input.objectiveId,
    flight_id: input.flightId,
    task_id: input.taskId,
    message_id: null,
    assignment_epoch: input.assignmentEpoch,
    fencing_epoch: null,
    lease_token_hash: null,
    idempotency_key: `key-${input.id}`,
    claims: input.claims,
    predecessor_receipt_id: null,
    predecessor_hash: null,
    server_timestamp: serverTime,
  }
  const canonicalPayload = canonicalJson(payloadFacts)
  const receiptHash = input.receiptHashOverride ?? await sha256Hex(canonicalPayload)
  harness.sqlite.prepare(`
    INSERT INTO execution_receipts (
      id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
      seat_id, seat_generation, objective_id, flight_id, task_id, message_id,
      assignment_epoch, fencing_epoch, lease_token_hash, idempotency_key,
      claims_json, canonical_payload, payload_digest, predecessor_receipt_id,
      predecessor_hash, receipt_hash, server_timestamp
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?,
      NULL, NULL, ?, ?
    )
  `).run(
    input.id,
    TENANT,
    input.type,
    issuerKind,
    issuerId,
    actorKind,
    input.actorId,
    input.seatId,
    input.seatGeneration,
    payloadFacts.objective_id,
    input.flightId,
    input.taskId,
    input.assignmentEpoch,
    payloadFacts.idempotency_key,
    claimsJson,
    canonicalPayload,
    payloadDigest,
    receiptHash,
    serverTime,
  )
}

async function insertStorageReceipt(
  input: RecordArtifactMetadataInput,
  overrides: Partial<FutureReceiptInput> = {},
): Promise<void> {
  await insertFutureReceipt({
    id: input.storageReceiptId,
    type: 'artifact.stored',
    actorId: PRODUCER_AGENT,
    seatId: PRODUCER_SEAT,
    seatGeneration: 1,
    flightId: CHILD_FLIGHT,
    taskId: PRODUCER_TASK,
    assignmentEpoch: 1,
    claims: storageClaims(input),
    ...overrides,
  })
}

function retrievalInput(
  overrides: Partial<RecordArtifactRetrievalInput> = {},
): RecordArtifactRetrievalInput {
  return {
    artifactId: ARTIFACT_ID,
    retrievalReceiptId: `receipt-retrieved-${ARTIFACT_ID}`,
    recomputedDigest: DIGEST,
    ...overrides,
  }
}

async function insertRetrievalReceipt(
  input: RecordArtifactRetrievalInput,
  overrides: Partial<FutureReceiptInput> = {},
): Promise<void> {
  await insertFutureReceipt({
    id: input.retrievalReceiptId,
    type: 'artifact.retrieved',
    actorId: VERIFIER_AGENT,
    seatId: VERIFIER_SEAT,
    seatGeneration: 1,
    flightId: CHILD_FLIGHT,
    taskId: VERIFIER_TASK,
    assignmentEpoch: 1,
    claims: {
      artifactId: input.artifactId,
      recomputedDigest: input.recomputedDigest,
    },
    ...overrides,
  })
}

async function recordDefaultArtifact(
  overrides: Partial<RecordArtifactMetadataInput> = {},
) {
  const input = metadataInput(overrides)
  await insertStorageReceipt(input)
  return recordArtifactMetadata(env, producerAuth(), input)
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

function envWithAfterBatch(mutate: () => Promise<void> | void): Env {
  return {
    ...env,
    DB: {
      prepare: harness.db.prepare.bind(harness.db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        const results = await harness.db.batch(statements)
        await mutate()
        return results
      },
    } as D1Database,
  }
}

function envWithBatchError(error: Error): Env {
  return {
    ...env,
    DB: {
      prepare: harness.db.prepare.bind(harness.db),
      async batch() {
        throw error
      },
    } as D1Database,
  }
}

function deleteAuditWhere(where: string): void {
  harness.sqlite.exec('DROP TRIGGER mutation_audit_entries_no_delete')
  harness.sqlite.exec(`DELETE FROM mutation_audit_entries WHERE ${where}`)
}

function corruptAuditWhere(where: string): void {
  harness.sqlite.exec('DROP TRIGGER mutation_audit_entries_no_update')
  harness.sqlite.exec(`
    UPDATE mutation_audit_entries
       SET handler = 'flight_spine.corrupted_artifact_audit'
     WHERE ${where}
  `)
}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  serverTime = sqliteNow()
  retentionUntil = plusDays(serverTime, 31)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('department-artifacts', 'artifacts', 'Artifacts');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD_ID}', 'department-artifacts', 'artifacts', 'Artifacts');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${PARENT_AGENT}', '${SQUAD_ID}', 'parent-artifacts', 'Parent', 'member', 'test', 'active'),
      ('${PRODUCER_AGENT}', '${SQUAD_ID}', 'producer-artifacts', 'Producer', 'member', 'test', 'active'),
      ('${VERIFIER_AGENT}', '${SQUAD_ID}', 'verifier-artifacts', 'Verifier', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('membership-parent-artifacts', '${PARENT_AGENT}', '${SQUAD_ID}', 'member'),
      ('membership-producer-artifacts', '${PRODUCER_AGENT}', '${SQUAD_ID}', 'member'),
      ('membership-verifier-artifacts', '${VERIFIER_AGENT}', '${SQUAD_ID}', 'member');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${PARENT_MEMBER}', 'Parent Member', 'active', '${TENANT}'),
      ('${PRODUCER_MEMBER}', 'Producer Member', 'active', '${TENANT}'),
      ('${VERIFIER_MEMBER}', 'Verifier Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${PARENT_AGENT}', '${PARENT_MEMBER}', '${serverTime}'),
      ('${TENANT}', '${PRODUCER_AGENT}', '${PRODUCER_MEMBER}', '${serverTime}'),
      ('${TENANT}', '${VERIFIER_AGENT}', '${VERIFIER_MEMBER}', '${serverTime}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('capability-parent-artifacts', '${PARENT_MEMBER}', 'squad', '${SQUAD_ID}', 'member'),
      ('capability-producer-artifacts', '${PRODUCER_MEMBER}', 'squad', '${SQUAD_ID}', 'member'),
      ('capability-verifier-artifacts', '${VERIFIER_MEMBER}', 'squad', '${SQUAD_ID}', 'member');
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
  objective = await acceptObjective(env, parentAuth(), {
    squadId: SQUAD_ID,
    title: 'Produce, retrieve, and consume a child artifact',
    successContract: 'The exact child artifact is independently retrieved and consumed.',
    authorityEnvelope: { allowedActions: ['artifact:record', 'artifact:retrieve', 'artifact:consume'] },
    policy: { retentionDays: 30 },
    budgetMicroUsd: 0,
    payload: { artifact: 'fresh' },
    idempotencyKey: 'objective-artifacts-001',
  })
  const acceptedMillis = Date.parse(objective.acceptedAt)
  harness.sqlite.prepare(`
    INSERT INTO flights (
      id, tenant, agent, dispatched_by_agent_id, goal, status, meta, created_at
    ) VALUES (?, ?, ?, ?, 'Parent artifact flight', 'running', '{}', ?)
  `).run(PARENT_FLIGHT, TENANT, PARENT_AGENT, PARENT_AGENT, acceptedMillis + 1)
  harness.sqlite.prepare(`
    INSERT INTO flights (
      id, tenant, agent, dispatched_by_agent_id, goal, status, meta, created_at
    ) VALUES (?, ?, ?, ?, 'Child artifact flight', 'running', '{}', ?)
  `).run(CHILD_FLIGHT, TENANT, PRODUCER_AGENT, PARENT_AGENT, acceptedMillis + 2)
  harness.sqlite.prepare(`
    INSERT INTO flight_objectives (
      id, tenant, flight_id, objective_id, materialization_receipt_id, linked_at
    ) VALUES ('parent-artifact-objective-link', ?, ?, ?, NULL, ?)
  `).run(TENANT, PARENT_FLIGHT, objective.id, objective.acceptedAt)
  dependency = await linkChildFlight(env, parentAuth(), {
    objectiveId: objective.id,
    parentFlightId: PARENT_FLIGHT,
    childFlightId: CHILD_FLIGHT,
  })
  harness.sqlite.exec(`
    INSERT INTO tasks (
      id, squad_id, title, done_when, status, assignee_agent_id, assignment_epoch
    ) VALUES
      ('${PRODUCER_TASK}', '${SQUAD_ID}', 'Produce child output', 'Artifact metadata exists', 'in_progress', '${PRODUCER_AGENT}', 1),
      ('${VERIFIER_TASK}', '${SQUAD_ID}', 'Verify child output', 'Artifact digest is recomputed', 'in_progress', '${VERIFIER_AGENT}', 1),
      ('${PARENT_TASK}', '${SQUAD_ID}', 'Consume child output', 'Child artifact is consumed', 'in_progress', '${PARENT_AGENT}', 1);
    INSERT INTO runtime_seats (
      id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
      current_generation, current_fencing_epoch, capabilities_json, created_at, updated_at
    ) VALUES
      ('${PRODUCER_SEAT}', '${TENANT}', '${PRODUCER_AGENT}', 'producer', 'host-producer', 'test', 'active', 1, 0, '[]', '${serverTime}', '${serverTime}'),
      ('${VERIFIER_SEAT}', '${TENANT}', '${VERIFIER_AGENT}', 'verifier', 'host-verifier', 'test', 'active', 1, 0, '[]', '${serverTime}', '${serverTime}'),
      ('${PARENT_SEAT}', '${TENANT}', '${PARENT_AGENT}', 'parent', 'host-parent', 'test', 'active', 1, 0, '[]', '${serverTime}', '${serverTime}');
    INSERT INTO runtime_seat_generations (
      id, tenant, runtime_seat_id, generation, host_id, process_id, process_uid,
      sandbox_id, executable_digest, public_key, broker_attestation_digest,
      started_at, created_at
    ) VALUES
      ('generation-producer-artifacts', '${TENANT}', '${PRODUCER_SEAT}', 1, 'host-producer', 'pid-producer', 'uid-producer', 'sandbox-producer', '${'1'.repeat(64)}', 'key-producer', '${'2'.repeat(64)}', '${serverTime}', '${serverTime}'),
      ('generation-verifier-artifacts', '${TENANT}', '${VERIFIER_SEAT}', 1, 'host-verifier', 'pid-verifier', 'uid-verifier', 'sandbox-verifier', '${'3'.repeat(64)}', 'key-verifier', '${'4'.repeat(64)}', '${serverTime}', '${serverTime}'),
      ('generation-parent-artifacts', '${TENANT}', '${PARENT_SEAT}', 1, 'host-parent', 'pid-parent', 'uid-parent', 'sandbox-parent', '${'5'.repeat(64)}', 'key-parent', '${'6'.repeat(64)}', '${serverTime}', '${serverTime}');
    INSERT INTO flight_lanes (
      id, tenant, flight_id, lane_key, role, task_id, assignment_epoch,
      agent_id, runtime_seat_id, done_when, dependency_lane_keys_json, created_at
    ) VALUES
      ('lane-producer-artifacts', '${TENANT}', '${CHILD_FLIGHT}', 'producer', 'worker', '${PRODUCER_TASK}', 1, '${PRODUCER_AGENT}', '${PRODUCER_SEAT}', 'Artifact metadata exists', '[]', '${serverTime}'),
      ('lane-verifier-artifacts', '${TENANT}', '${CHILD_FLIGHT}', 'verifier', 'gate', '${VERIFIER_TASK}', 1, '${VERIFIER_AGENT}', '${VERIFIER_SEAT}', 'Artifact digest is recomputed', '["producer"]', '${serverTime}'),
      ('lane-parent-artifacts', '${TENANT}', '${PARENT_FLIGHT}', 'parent', 'integrator', '${PARENT_TASK}', 1, '${PARENT_AGENT}', '${PARENT_SEAT}', 'Child artifact is consumed', '[]', '${serverTime}');
    INSERT INTO flight_task_assignments (
      id, tenant, flight_id, lane_id, task_id, assignment_epoch, agent_id,
      runtime_seat_id, assigned_by_principal_kind, assigned_by_principal_id,
      assigned_by_member_id, assignment_receipt_id, assigned_at
    ) VALUES
      ('${PRODUCER_ASSIGNMENT}', '${TENANT}', '${CHILD_FLIGHT}', 'lane-producer-artifacts', '${PRODUCER_TASK}', 1, '${PRODUCER_AGENT}', '${PRODUCER_SEAT}', 'agent', '${PARENT_AGENT}', '${PARENT_MEMBER}', NULL, '${serverTime}'),
      ('${VERIFIER_ASSIGNMENT}', '${TENANT}', '${CHILD_FLIGHT}', 'lane-verifier-artifacts', '${VERIFIER_TASK}', 1, '${VERIFIER_AGENT}', '${VERIFIER_SEAT}', 'agent', '${PARENT_AGENT}', '${PARENT_MEMBER}', NULL, '${serverTime}'),
      ('${PARENT_ASSIGNMENT}', '${TENANT}', '${PARENT_FLIGHT}', 'lane-parent-artifacts', '${PARENT_TASK}', 1, '${PARENT_AGENT}', '${PARENT_SEAT}', 'agent', '${PARENT_AGENT}', '${PARENT_MEMBER}', NULL, '${serverTime}');
  `)
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine artifact metadata facts', () => {
  it('projects canonical artifact metadata from one verified artifact-service storage receipt', async () => {
    const input = metadataInput()
    await insertStorageReceipt(input)
    const beforeChain = receiptChainCounts()
    const beforeTask = harness.sqlite.prepare(`
      SELECT status, result, assignment_epoch FROM tasks WHERE id = ?
    `).get(PRODUCER_TASK)

    const artifact = await recordArtifactMetadata(env, producerAuth(), input)

    expect(artifact).toEqual({
      id: ARTIFACT_ID,
      tenant: TENANT,
      flightId: CHILD_FLIGHT,
      producingAssignmentId: PRODUCER_ASSIGNMENT,
      producingTaskId: PRODUCER_TASK,
      producingAgentId: PRODUCER_AGENT,
      producingRuntimeSeatId: PRODUCER_SEAT,
      assignmentEpoch: 1,
      objectKey: `sha256/aa/${DIGEST}`,
      digest: DIGEST,
      sizeBytes: 4_096,
      visibility: 'tenant',
      retentionUntil,
      repositoryUrl: null,
      commitSha: null,
      repositoryPath: null,
      storageReceiptId: input.storageReceiptId,
      createdAt: serverTime,
    })
    expect(harness.sqlite.prepare(`
      SELECT id, flight_id, producing_assignment_id, producing_task_id,
             producing_agent_id, producing_runtime_seat_id, assignment_epoch,
             object_key, digest, size_bytes, visibility, retention_until,
             storage_receipt_id
        FROM artifacts WHERE id = ?
    `).get(ARTIFACT_ID)).toEqual({
      id: ARTIFACT_ID,
      flight_id: CHILD_FLIGHT,
      producing_assignment_id: PRODUCER_ASSIGNMENT,
      producing_task_id: PRODUCER_TASK,
      producing_agent_id: PRODUCER_AGENT,
      producing_runtime_seat_id: PRODUCER_SEAT,
      assignment_epoch: 1,
      object_key: `sha256/aa/${DIGEST}`,
      digest: DIGEST,
      size_bytes: 4_096,
      visibility: 'tenant',
      retention_until: retentionUntil,
      storage_receipt_id: input.storageReceiptId,
    })
    expect(harness.sqlite.prepare(`
      SELECT principal_kind, principal_id, handler, target_kind, target_id,
             runtime_seat_id, runtime_generation
        FROM mutation_audit_entries
       WHERE target_kind = 'artifact' AND target_id = ?
    `).get(ARTIFACT_ID)).toEqual({
      principal_kind: 'agent',
      principal_id: PRODUCER_AGENT,
      handler: 'flight_spine.record_artifact_metadata',
      target_kind: 'artifact',
      target_id: ARTIFACT_ID,
      runtime_seat_id: PRODUCER_SEAT,
      runtime_generation: 1,
    })
    expect(receiptChainCounts()).toEqual(beforeChain)
    expect(harness.sqlite.prepare(`
      SELECT status, result, assignment_epoch FROM tasks WHERE id = ?
    `).get(PRODUCER_TASK)).toEqual(beforeTask)
    expect(harness.sqlite.prepare(`
      SELECT type, issuer_kind FROM execution_receipts WHERE id = ?
    `).get(input.storageReceiptId)).toEqual({
      type: 'artifact.stored',
      issuer_kind: 'artifact_service',
    })
  })

  it('rejects noncanonical digests, sizes, object keys, visibility, and retention', async () => {
    const cases: Array<{
      name: string
      input: RecordArtifactMetadataInput
      code: string
    }> = [
      {
        name: 'uppercase digest',
        input: metadataInput({
          artifactId: 'artifact-invalid-digest',
          storageReceiptId: 'receipt-invalid-digest',
          digest: DIGEST.toUpperCase(),
          objectKey: `sha256/aa/${DIGEST.toUpperCase()}`,
        }),
        code: 'invalid_artifact',
      },
      {
        name: 'zero size',
        input: metadataInput({
          artifactId: 'artifact-zero-size',
          storageReceiptId: 'receipt-zero-size',
          sizeBytes: 0,
        }),
        code: 'invalid_artifact',
      },
      {
        name: 'non-content-addressed object key',
        input: metadataInput({
          artifactId: 'artifact-invalid-object-key',
          storageReceiptId: 'receipt-invalid-object-key',
          objectKey: 'uploads/latest/output.bin',
        }),
        code: 'invalid_artifact',
      },
      {
        name: 'unknown visibility',
        input: metadataInput({
          artifactId: 'artifact-invalid-visibility',
          storageReceiptId: 'receipt-invalid-visibility',
          visibility: 'private' as never,
        }),
        code: 'invalid_artifact',
      },
      {
        name: 'less than 30 days retention',
        input: metadataInput({
          artifactId: 'artifact-short-retention',
          storageReceiptId: 'receipt-short-retention',
          retentionUntil: plusDays(sqliteNow(), 29),
        }),
        code: 'retention_too_short',
      },
    ]

    for (const testCase of cases) {
      await insertStorageReceipt(testCase.input)
      await expect(
        recordArtifactMetadata(env, producerAuth(), testCase.input),
        testCase.name,
      ).rejects.toMatchObject({ code: testCase.code })
    }
    expect(count('artifacts')).toBe(0)
    expect(count('mutation_audit_entries', "WHERE target_kind = 'artifact'")).toBe(0)
  })

  it('canonicalizes one safe GitHub repository tuple and accepts a nested relative path', async () => {
    const input = metadataInput({
      repositoryUrl: 'https://github.com/Mumega/mupot.git',
      commitSha: 'c'.repeat(40),
      repositoryPath: 'packages/flight-spine/src/artifacts.ts',
    })
    await insertStorageReceipt(input, {
      claims: storageClaims({
        ...input,
        repositoryUrl: 'https://github.com/Mumega/mupot',
      }),
    })

    const artifact = await recordArtifactMetadata(env, producerAuth(), input)

    expect(artifact.repositoryUrl).toBe('https://github.com/Mumega/mupot')
    expect(artifact.commitSha).toBe('c'.repeat(40))
    expect(artifact.repositoryPath).toBe('packages/flight-spine/src/artifacts.ts')
  })

  it('rejects unsafe repository remotes and repository-relative paths', async () => {
    const cases = [
      { repositoryUrl: 'http://github.com/Mumega/mupot', repositoryPath: 'src/file.ts' },
      { repositoryUrl: 'https://user@github.com/Mumega/mupot', repositoryPath: 'src/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot?ref=main', repositoryPath: 'src/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot#readme', repositoryPath: 'src/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot/tree/main', repositoryPath: 'src/file.ts' },
      { repositoryUrl: 'https://gitlab.com/Mumega/mupot', repositoryPath: 'src/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot/', repositoryPath: 'src/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot\n', repositoryPath: 'src/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: '/src/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: 'src/file.ts/' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: 'src\\file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: 'src//file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: './src/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: '../src/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: 'src/../file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: 'src/%2e%2e/file.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: 'src%2ffile.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: 'src/line\nbreak.ts' },
      { repositoryUrl: 'https://github.com/Mumega/mupot', repositoryPath: 'https://example.test/file' },
    ]

    for (const [index, testCase] of cases.entries()) {
      const digest = await sha256Hex(`unsafe-repository-case-${index}`)
      const input = metadataInput({
        artifactId: `artifact-unsafe-repository-${index}`,
        storageReceiptId: `receipt-unsafe-repository-${index}`,
        digest,
        objectKey: `sha256/${digest.slice(0, 2)}/${digest}`,
        repositoryUrl: testCase.repositoryUrl,
        commitSha: 'd'.repeat(40),
        repositoryPath: testCase.repositoryPath,
      })
      await insertStorageReceipt(input)
      await expect(
        recordArtifactMetadata(env, producerAuth(), input),
        JSON.stringify(testCase),
      ).rejects.toMatchObject({ code: 'invalid_artifact' })
    }
    expect(count('artifacts')).toBe(0)
  })

  it('requires a verified artifact-service stored receipt with exact canonical claims', async () => {
    const wrongIssuer = metadataInput({
      artifactId: 'artifact-wrong-issuer',
      storageReceiptId: 'receipt-wrong-issuer',
    })
    await insertStorageReceipt(wrongIssuer, { issuerKind: 'mupot' })
    await expect(recordArtifactMetadata(env, producerAuth(), wrongIssuer))
      .rejects.toMatchObject({ code: 'storage_receipt_invalid' })

    const wrongType = metadataInput({
      artifactId: 'artifact-wrong-type',
      storageReceiptId: 'receipt-wrong-type',
    })
    await insertStorageReceipt(wrongType, { type: 'artifact.retrieved' })
    await expect(recordArtifactMetadata(env, producerAuth(), wrongType))
      .rejects.toMatchObject({ code: 'storage_receipt_invalid' })

    const corrupted = metadataInput({
      artifactId: 'artifact-corrupt-receipt',
      storageReceiptId: 'receipt-corrupt-receipt',
    })
    await insertStorageReceipt(corrupted, { receiptHashOverride: 'f'.repeat(64) })
    await expect(recordArtifactMetadata(env, producerAuth(), corrupted))
      .rejects.toMatchObject({ code: 'storage_receipt_invalid' })

    const mismatchedClaims = metadataInput({
      artifactId: 'artifact-mismatched-claims',
      storageReceiptId: 'receipt-mismatched-claims',
    })
    await insertStorageReceipt(mismatchedClaims, {
      claims: { ...storageClaims(mismatchedClaims), sizeBytes: 4_097 },
    })
    await expect(recordArtifactMetadata(env, producerAuth(), mismatchedClaims))
      .rejects.toMatchObject({ code: 'storage_receipt_invalid' })

    expect(count('artifacts')).toBe(0)
  })

  it('binds the producer to the current exact assignment, task, agent, seat, and epoch', async () => {
    const input = metadataInput()
    await insertStorageReceipt(input)

    await expect(recordArtifactMetadata(env, verifierAuth(), input))
      .rejects.toMatchObject({ code: 'producer_scope_mismatch' })

    harness.sqlite.prepare(`
      UPDATE tasks SET assignment_epoch = 2 WHERE id = ?
    `).run(PRODUCER_TASK)
    await expect(recordArtifactMetadata(env, producerAuth(), input))
      .rejects.toMatchObject({ code: 'producer_scope_mismatch' })
    expect(count('artifacts')).toBe(0)
  })

  it('reasserts current producer facts inside the audited projection transaction', async () => {
    const input = metadataInput()
    await insertStorageReceipt(input)
    const racedEnv = envWithBeforeBatch(() => {
      harness.sqlite.prepare(`
        UPDATE runtime_seats
           SET state = 'revoked', revoked_at = ?, updated_at = ?
         WHERE id = ?
      `).run(serverTime, serverTime, PRODUCER_SEAT)
    })

    await expect(recordArtifactMetadata(racedEnv, producerAuth(), input))
      .rejects.toMatchObject({ code: 'producer_scope_mismatch' })
    expect(count('artifacts')).toBe(0)
    expect(count('mutation_audit_entries', "WHERE target_kind = 'artifact'")).toBe(0)
  })

  it('uses SQLite statement time to reject retention that only passes the preflight clock', async () => {
    const sqliteMillis = Date.parse(sqliteNow())
    const preflight = new Date(sqliteMillis - 60_000)
    const racedRetention = new Date(
      sqliteMillis + (30 * 24 * 60 * 60 * 1_000) - 1_000,
    ).toISOString()
    vi.useFakeTimers()
    vi.setSystemTime(preflight)
    expect(Date.parse(racedRetention) - Date.now())
      .toBeGreaterThan(30 * 24 * 60 * 60 * 1_000)
    const input = metadataInput({
      artifactId: 'artifact-retention-statement-time',
      storageReceiptId: 'receipt-retention-statement-time',
      retentionUntil: racedRetention,
    })
    await insertStorageReceipt(input)

    let rejected: unknown
    try {
      await recordArtifactMetadata(env, producerAuth(), input)
    } catch (error) {
      rejected = error
    }

    expect(rejected).toBeTruthy()
    expect(rejected).not.toMatchObject({ code: 'retention_too_short' })
    expect(count('artifacts')).toBe(0)
    expect(count('mutation_audit_entries', "WHERE target_kind = 'artifact'")).toBe(0)
  })

  it('replays only byte-identical request identity and resolves an exact concurrent winner', async () => {
    const input = metadataInput()
    await insertStorageReceipt(input)
    const first = await recordArtifactMetadata(env, producerAuth(), input)
    expect(await recordArtifactMetadata(env, producerAuth(), input)).toEqual(first)

    const secondReceipt = metadataInput({ storageReceiptId: 'receipt-stored-conflicting-replay' })
    await insertStorageReceipt(secondReceipt)
    await expect(recordArtifactMetadata(env, producerAuth(), secondReceipt))
      .rejects.toMatchObject({ code: 'artifact_conflict' })

    const racedInput = metadataInput({
      artifactId: 'artifact-concurrent-winner',
      storageReceiptId: 'receipt-concurrent-winner',
      digest: 'b'.repeat(64),
      objectKey: `sha256/bb/${'b'.repeat(64)}`,
    })
    await insertStorageReceipt(racedInput)
    const racedEnv = envWithBeforeBatch(async () => {
      await recordArtifactMetadata(env, producerAuth(), racedInput)
    })
    const raced = await recordArtifactMetadata(racedEnv, producerAuth(), racedInput)

    expect(raced.id).toBe(racedInput.artifactId)
    expect(count('artifacts')).toBe(2)
    expect(count('mutation_audit_entries', "WHERE target_kind = 'artifact'")).toBe(2)
  })

  it('refuses a preexisting artifact projection when its deterministic audit is missing', async () => {
    const input = metadataInput()
    await insertStorageReceipt(input)
    await recordArtifactMetadata(env, producerAuth(), input)
    deleteAuditWhere(`target_kind = 'artifact' AND target_id = '${ARTIFACT_ID}'`)

    await expect(recordArtifactMetadata(env, producerAuth(), input))
      .rejects.toMatchObject({ code: 'artifact_audit_invalid' })
  })

  it('rethrows a postcommit artifact audit reread integrity failure instead of replaying success', async () => {
    const input = metadataInput()
    await insertStorageReceipt(input)
    const corruptingEnv = envWithAfterBatch(() => {
      deleteAuditWhere(`target_kind = 'artifact' AND target_id = '${ARTIFACT_ID}'`)
    })

    await expect(recordArtifactMetadata(corruptingEnv, producerAuth(), input))
      .rejects.toMatchObject({ name: 'ExecutionReceiptError', code: 'integrity_failure' })
    expect(count('artifacts')).toBe(1)
    expect(count('mutation_audit_entries', "WHERE target_kind = 'artifact'")).toBe(0)
  })

  it('preserves a non-conflict projection executor error', async () => {
    const input = metadataInput()
    await insertStorageReceipt(input)
    const failure = new Error('projection transport failed')

    await expect(recordArtifactMetadata(
      envWithBatchError(failure),
      producerAuth(),
      input,
    )).rejects.toBe(failure)
    expect(count('artifacts')).toBe(0)
  })
})

describe('Flight Spine artifact retrieval and child consumption facts', () => {
  it('projects one independent digest-matching retrieval without creating a receipt', async () => {
    const artifact = await recordDefaultArtifact()
    const input = retrievalInput()
    await insertRetrievalReceipt(input)
    const beforeChain = receiptChainCounts()
    const beforeTasks = harness.sqlite.prepare(`
      SELECT id, status, result, assignment_epoch
        FROM tasks WHERE id IN (?, ?) ORDER BY id
    `).all(PRODUCER_TASK, VERIFIER_TASK)

    const retrieval = await recordArtifactRetrieval(env, verifierAuth(), input)

    expect(retrieval).toEqual({
      id: expect.any(String),
      tenant: TENANT,
      artifactId: artifact.id,
      verifierPrincipalKind: 'agent',
      verifierPrincipalId: VERIFIER_AGENT,
      verifierAgentId: VERIFIER_AGENT,
      verifierRuntimeSeatId: VERIFIER_SEAT,
      recomputedDigest: DIGEST,
      retrievalReceiptId: input.retrievalReceiptId,
      retrievedAt: serverTime,
    })
    expect(harness.sqlite.prepare(`
      SELECT artifact_id, verifier_principal_kind, verifier_principal_id,
             verifier_agent_id, verifier_runtime_seat_id, recomputed_digest,
             retrieval_receipt_id
        FROM artifact_retrieval_receipts WHERE id = ?
    `).get(retrieval.id)).toEqual({
      artifact_id: ARTIFACT_ID,
      verifier_principal_kind: 'agent',
      verifier_principal_id: VERIFIER_AGENT,
      verifier_agent_id: VERIFIER_AGENT,
      verifier_runtime_seat_id: VERIFIER_SEAT,
      recomputed_digest: DIGEST,
      retrieval_receipt_id: input.retrievalReceiptId,
    })
    expect(harness.sqlite.prepare(`
      SELECT handler, target_kind, target_id, runtime_seat_id, runtime_generation
        FROM mutation_audit_entries
       WHERE target_kind = 'artifact_retrieval_receipt'
    `).get()).toEqual({
      handler: 'flight_spine.record_artifact_retrieval',
      target_kind: 'artifact_retrieval_receipt',
      target_id: retrieval.id,
      runtime_seat_id: VERIFIER_SEAT,
      runtime_generation: 1,
    })
    expect(receiptChainCounts()).toEqual(beforeChain)
    expect(harness.sqlite.prepare(`
      SELECT id, status, result, assignment_epoch
        FROM tasks WHERE id IN (?, ?) ORDER BY id
    `).all(PRODUCER_TASK, VERIFIER_TASK)).toEqual(beforeTasks)
  })

  it('rejects the producer as verifier and refuses a mismatched recomputed digest', async () => {
    await recordDefaultArtifact()
    const selfRetrieval = retrievalInput({ retrievalReceiptId: 'receipt-self-retrieval' })
    await insertRetrievalReceipt(selfRetrieval, {
      actorId: PRODUCER_AGENT,
      seatId: PRODUCER_SEAT,
      taskId: PRODUCER_TASK,
    })
    await expect(recordArtifactRetrieval(env, producerAuth(), selfRetrieval))
      .rejects.toMatchObject({ code: 'verifier_not_independent' })

    const wrongDigest = retrievalInput({
      retrievalReceiptId: 'receipt-wrong-recomputed-digest',
      recomputedDigest: 'b'.repeat(64),
    })
    await insertRetrievalReceipt(wrongDigest)
    await expect(recordArtifactRetrieval(env, verifierAuth(), wrongDigest))
      .rejects.toMatchObject({ code: 'digest_mismatch' })
    expect(count('artifact_retrieval_receipts')).toBe(0)
  })

  it('requires a verified artifact-service retrieved receipt and its exact verifier identity', async () => {
    await recordDefaultArtifact()
    const wrongIssuer = retrievalInput({ retrievalReceiptId: 'receipt-retrieval-wrong-issuer' })
    await insertRetrievalReceipt(wrongIssuer, { issuerKind: 'mupot' })
    await expect(recordArtifactRetrieval(env, verifierAuth(), wrongIssuer))
      .rejects.toMatchObject({ code: 'retrieval_receipt_invalid' })

    const wrongType = retrievalInput({ retrievalReceiptId: 'receipt-retrieval-wrong-type' })
    await insertRetrievalReceipt(wrongType, { type: 'artifact.stored' })
    await expect(recordArtifactRetrieval(env, verifierAuth(), wrongType))
      .rejects.toMatchObject({ code: 'retrieval_receipt_invalid' })

    const corrupt = retrievalInput({ retrievalReceiptId: 'receipt-retrieval-corrupt' })
    await insertRetrievalReceipt(corrupt, { payloadDigestOverride: 'f'.repeat(64) })
    await expect(recordArtifactRetrieval(env, verifierAuth(), corrupt))
      .rejects.toMatchObject({ code: 'retrieval_receipt_invalid' })

    const exactIdentity = retrievalInput({ retrievalReceiptId: 'receipt-retrieval-exact-identity' })
    await insertRetrievalReceipt(exactIdentity)
    await expect(recordArtifactRetrieval(env, producerAuth(), exactIdentity))
      .rejects.toMatchObject({ code: 'verifier_scope_mismatch' })
    expect(count('artifact_retrieval_receipts')).toBe(0)
  })

  it('reasserts current verifier assignment and seat facts inside the projection transaction', async () => {
    await recordDefaultArtifact()
    const input = retrievalInput()
    await insertRetrievalReceipt(input)
    const racedEnv = envWithBeforeBatch(() => {
      harness.sqlite.prepare(`
        UPDATE tasks SET assignee_agent_id = ? WHERE id = ?
      `).run(PRODUCER_AGENT, VERIFIER_TASK)
    })

    await expect(recordArtifactRetrieval(racedEnv, verifierAuth(), input))
      .rejects.toMatchObject({ code: 'verifier_scope_mismatch' })
    expect(count('artifact_retrieval_receipts')).toBe(0)
    expect(count(
      'mutation_audit_entries',
      "WHERE target_kind = 'artifact_retrieval_receipt'",
    )).toBe(0)
  })

  it('allows one exact retrieval receipt per verifier and rejects a different replay identity', async () => {
    await recordDefaultArtifact()
    const input = retrievalInput()
    await insertRetrievalReceipt(input)
    const first = await recordArtifactRetrieval(env, verifierAuth(), input)
    expect(await recordArtifactRetrieval(env, verifierAuth(), input)).toEqual(first)

    const second = retrievalInput({ retrievalReceiptId: 'receipt-retrieval-second' })
    await insertRetrievalReceipt(second)
    await expect(recordArtifactRetrieval(env, verifierAuth(), second))
      .rejects.toMatchObject({ code: 'retrieval_conflict' })
    expect(count('artifact_retrieval_receipts')).toBe(1)
  })

  it('returns an exact concurrent retrieval winner only with its deterministic audit', async () => {
    await recordDefaultArtifact()
    const input = retrievalInput()
    await insertRetrievalReceipt(input)
    let winner: Awaited<ReturnType<typeof recordArtifactRetrieval>> | null = null
    const racedEnv = envWithBeforeBatch(async () => {
      winner = await recordArtifactRetrieval(env, verifierAuth(), input)
    })

    const recovered = await recordArtifactRetrieval(racedEnv, verifierAuth(), input)

    expect(recovered).toEqual(winner)
    expect(count('artifact_retrieval_receipts')).toBe(1)
    expect(harness.sqlite.prepare(`
      SELECT target_id FROM mutation_audit_entries
       WHERE target_kind = 'artifact_retrieval_receipt'
    `).get()).toEqual({ target_id: recovered.id })
  })

  it('rejects a concurrent retrieval winner whose deterministic audit is missing', async () => {
    await recordDefaultArtifact()
    const input = retrievalInput({ retrievalReceiptId: 'receipt-retrieval-raced-no-audit' })
    await insertRetrievalReceipt(input)
    const racedEnv = envWithBeforeBatch(async () => {
      const winner = await recordArtifactRetrieval(env, verifierAuth(), input)
      deleteAuditWhere(`
        target_kind = 'artifact_retrieval_receipt'
        AND target_id = '${winner.id}'
      `)
    })

    await expect(recordArtifactRetrieval(racedEnv, verifierAuth(), input))
      .rejects.toMatchObject({ code: 'retrieval_audit_invalid' })
    expect(count('artifact_retrieval_receipts')).toBe(1)
  })

  it('refuses a preexisting retrieval projection when its deterministic audit conflicts', async () => {
    await recordDefaultArtifact()
    const input = retrievalInput()
    await insertRetrievalReceipt(input)
    const retrieval = await recordArtifactRetrieval(env, verifierAuth(), input)
    corruptAuditWhere(`
      target_kind = 'artifact_retrieval_receipt'
      AND target_id = '${retrieval.id}'
    `)

    await expect(recordArtifactRetrieval(env, verifierAuth(), input))
      .rejects.toMatchObject({ code: 'retrieval_audit_invalid' })
  })

  it('rethrows a postcommit retrieval audit reread integrity failure instead of replaying success', async () => {
    await recordDefaultArtifact()
    const input = retrievalInput()
    await insertRetrievalReceipt(input)
    const corruptingEnv = envWithAfterBatch(() => {
      deleteAuditWhere(`target_kind = 'artifact_retrieval_receipt'`)
    })

    await expect(recordArtifactRetrieval(corruptingEnv, verifierAuth(), input))
      .rejects.toMatchObject({ name: 'ExecutionReceiptError', code: 'integrity_failure' })
    expect(count('artifact_retrieval_receipts')).toBe(1)
    expect(count(
      'mutation_audit_entries',
      "WHERE target_kind = 'artifact_retrieval_receipt'",
    )).toBe(0)
  })

  it('records explicit consumption of the exact linked child artifact without completing a task', async () => {
    const artifact = await recordDefaultArtifact()
    const beforeTask = harness.sqlite.prepare(`
      SELECT status, result, assignment_epoch FROM tasks WHERE id = ?
    `).get(PARENT_TASK)

    const consumed = await recordConsumedChildArtifact(env, parentAuth(), {
      flightDependencyId: dependency.id,
      artifactId: artifact.id,
      consumingTaskId: PARENT_TASK,
      consumingAssignmentId: PARENT_ASSIGNMENT,
    })

    expect(consumed).toMatchObject({
      tenant: TENANT,
      flightDependencyId: dependency.id,
      artifactId: ARTIFACT_ID,
      consumingFlightId: PARENT_FLIGHT,
      consumingTaskId: PARENT_TASK,
      consumingAssignmentId: PARENT_ASSIGNMENT,
      consumptionReceiptId: expect.any(String),
    })
    expect(harness.sqlite.prepare(`
      SELECT type, issuer_kind, flight_id, task_id, claims_json
        FROM execution_receipts WHERE id = ?
    `).get(consumed.consumptionReceiptId)).toEqual({
      type: 'artifact.consumed',
      issuer_kind: 'mupot',
      flight_id: PARENT_FLIGHT,
      task_id: PARENT_TASK,
      claims_json: JSON.stringify({
        childArtifactId: ARTIFACT_ID,
        dependencyId: dependency.id,
      }),
    })
    expect(harness.sqlite.prepare(`
      SELECT status, result, assignment_epoch FROM tasks WHERE id = ?
    `).get(PARENT_TASK)).toEqual(beforeTask)
  })
})
