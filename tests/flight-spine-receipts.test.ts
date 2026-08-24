import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from '../src/lib/canonical-json'
import {
  appendExecutionReceipt,
  executeAuditedProjectionMutations,
  executePreparedExecutionReceiptBatch,
  getExecutionReceipt,
  prepareAuditedDomainMutation,
  prepareAuditedProjectionMutation,
  prepareFreshExecutionReceiptChain,
  type PreparedAtomicDomainMutation,
  type PreparedAuditedProjectionMutation,
  verifyExecutionReceipt,
} from '../src/flight-spine/receipts'
import type { AuthContext, Env } from '../src/types'
import type {
  ExecutionReceipt,
  ExecutionReceiptDraft,
  ExecutionReceiptType,
} from '../src/flight-spine/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-a'
const SERVER_TIME = '2026-08-23T16:00:00.000Z'

let harness: SqliteD1Harness
let env: Env

function memberAuth(tenant = TENANT): AuthContext {
  return {
    userId: 'user-1',
    email: 'member@example.com',
    role: 'member',
    tenant,
    memberId: 'member-1',
    boundAgentId: null,
  }
}

function agentAuth(tenant = TENANT): AuthContext {
  return {
    ...memberAuth(tenant),
    memberId: 'agent-member-1',
    boundAgentId: 'agent-1',
  }
}

function draft(
  idempotencyKey: string,
  overrides: Partial<ExecutionReceiptDraft> = {},
): ExecutionReceiptDraft {
  return {
    type: 'objective.accepted',
    idempotencyKey,
    objectiveId: 'objective-1',
    claims: { accepted: true },
    ...overrides,
  }
}

function allowTestOnlyReceiptCorruption(): void {
  harness.sqlite.exec('DROP TRIGGER execution_receipts_no_update')
}

function receiptChainCounts(): { receipts: number; edges: number; heads: number } {
  return {
    receipts: Number(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM execution_receipts',
    ).get()?.count ?? 0),
    edges: Number(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM execution_receipt_edges',
    ).get()?.count ?? 0),
    heads: Number(harness.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM execution_receipt_heads',
    ).get()?.count ?? 0),
  }
}

function expectNoReceiptChainState(): void {
  expect(receiptChainCounts()).toEqual({ receipts: 0, edges: 0, heads: 0 })
}

function departmentAudit(auditId: string, targetId: string) {
  return {
    expectedAuditId: auditId,
    principalKind: 'member' as const,
    principalId: 'member-1',
    origin: 'rest' as const,
    handler: 'flight_spine_test',
    operation: 'upsert',
    targetKind: 'department',
    targetId,
    requestId: auditId,
    evidence: { test: 'flight-spine-receipts' },
  }
}

function auditedDepartmentMutation(input: {
  auditId: string
  mutationSql: string
  targetId: string
  bindings?: readonly (string | number | boolean | null)[]
  db?: D1Database
}) {
  return prepareAuditedDomainMutation(input.db ?? env.DB, {
    sql: input.mutationSql,
    bindings: input.bindings ?? [],
    audit: departmentAudit(input.auditId, input.targetId),
  })
}

function artifactAudit(auditId: string, targetKind: string, targetId: string) {
  return {
    ...departmentAudit(auditId, targetId),
    handler: 'flight_spine_projection_test',
    targetKind,
  }
}

function auditedProjectionMutation(input: {
  auditId: string
  sql: string
  bindings?: readonly (string | number | boolean | null)[]
  targetKind: string
  targetId: string
  db?: D1Database
}) {
  return prepareAuditedProjectionMutation(input.db ?? env.DB, {
    sql: input.sql,
    bindings: input.bindings ?? [],
    audit: artifactAudit(input.auditId, input.targetKind, input.targetId),
  })
}

async function seedProjectionArtifactPrerequisites(receiptKey: string): Promise<string> {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('projection-dept', 'projection-dept', 'Projection Department');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('projection-squad', 'projection-dept', 'projection-squad', 'Projection Squad');
    INSERT INTO agents (id, squad_id, slug, name) VALUES
      ('projection-agent', 'projection-squad', 'projection-agent', 'Projection Agent'),
      ('projection-verifier', 'projection-squad', 'projection-verifier', 'Projection Verifier');
    INSERT INTO flights (id, tenant, agent, goal, status)
      VALUES ('projection-flight', '${TENANT}', 'projection-agent', 'Projection', 'running');
    INSERT INTO tasks (
      id, squad_id, title, done_when, status, assignee_agent_id, assignment_epoch
    ) VALUES (
      'projection-task', 'projection-squad', 'Projection task', 'Artifact exists',
      'open', 'projection-agent', 1
    );
    INSERT INTO runtime_seats (
      id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
      current_generation, current_fencing_epoch, capabilities_json, created_at, updated_at
    ) VALUES (
      'projection-seat', '${TENANT}', 'projection-agent', 'projection-seat',
      'projection-host', 'test', 'pending', 0, 0, '[]', '${SERVER_TIME}', '${SERVER_TIME}'
    );
    INSERT INTO flight_lanes (
      id, tenant, flight_id, lane_key, role, task_id, assignment_epoch,
      agent_id, runtime_seat_id, done_when, dependency_lane_keys_json, created_at
    ) VALUES (
      'projection-lane', '${TENANT}', 'projection-flight', 'projection-worker',
      'worker', 'projection-task', 1, 'projection-agent', 'projection-seat',
      'Artifact exists', '[]', '${SERVER_TIME}'
    );
    INSERT INTO flight_task_assignments (
      id, tenant, flight_id, lane_id, task_id, assignment_epoch, agent_id,
      runtime_seat_id, assigned_by_principal_kind, assigned_by_principal_id,
      assigned_by_member_id, assignment_receipt_id, assigned_at
    ) VALUES (
      'projection-assignment', '${TENANT}', 'projection-flight', 'projection-lane',
      'projection-task', 1, 'projection-agent', 'projection-seat', 'member',
      'member-1', NULL, NULL, '${SERVER_TIME}'
    );
  `)
  const receipt = await appendExecutionReceipt(env, memberAuth(), {
    type: 'result.reported',
    idempotencyKey: receiptKey,
    objectiveId: 'projection-objective',
    flightId: 'projection-flight',
    taskId: 'projection-task',
    assignmentEpoch: 1,
    claims: { artifactMetadataReady: true },
  })
  return receipt.id
}

function prepareArtifactProjection(input: {
  auditId: string
  artifactId: string
  storageReceiptId: string
  objectKey: string
}) {
  return auditedProjectionMutation({
    auditId: input.auditId,
    sql: `
      INSERT INTO artifacts (
        id, tenant, flight_id, producing_assignment_id, producing_task_id,
        producing_agent_id, producing_runtime_seat_id, assignment_epoch,
        object_key, digest, size_bytes, visibility, retention_until,
        storage_receipt_id, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
      )
    `,
    bindings: [
      input.artifactId,
      TENANT,
      'projection-flight',
      'projection-assignment',
      'projection-task',
      'projection-agent',
      'projection-seat',
      1,
      input.objectKey,
      'a'.repeat(64),
      128,
      'tenant',
      '2026-09-23T16:00:00.000Z',
      input.storageReceiptId,
      SERVER_TIME,
    ],
    targetKind: 'artifact',
    targetId: input.artifactId,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(SERVER_TIME))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine execution receipt ledger', () => {
  it('exposes only frozen receipt metadata and opaque audited-domain handles', async () => {
    expect(prepareAuditedDomainMutation).toHaveLength(2)
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('opaque-prepared'),
    ])
    const domain = auditedDepartmentMutation({
      auditId: 'audit-opaque-domain',
      mutationSql: `
        INSERT INTO departments (id, slug, name)
        VALUES ('opaque-domain', 'opaque-domain', 'Opaque Domain')
      `,
      targetId: 'opaque-domain',
    })
    const exposedPrepared = Object.fromEntries(Object.entries(prepared))
    const exposedDomain = Object.fromEntries(Object.entries(domain))

    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.expectedReceipts)).toBe(true)
    expect(Object.isFrozen(prepared.expectedReceipts[0])).toBe(true)
    expect(Object.keys(prepared).sort()).toEqual([
      'expectedReceipts',
      'expectedStartingHeadId',
      'tenant',
    ])
    expect(exposedPrepared.receiptAndEdgeStatements).toBeUndefined()
    expect(exposedPrepared.finalHeadStatement).toBeUndefined()
    expect(Object.isFrozen(domain)).toBe(true)
    expect(Object.keys(domain)).toEqual(['expectedAuditId'])
    expect(exposedDomain.mutationStatement).toBeUndefined()
    expect(exposedDomain.guardStatement).toBeUndefined()
    await expect(executePreparedExecutionReceiptBatch(env, prepared, []))
      .rejects.toMatchObject({
        name: 'ExecutionReceiptError',
        code: 'invalid_draft',
      })
  })

  it('rejects nonallowlisted and obfuscated projection tables before preparation', () => {
    let prepareCalls = 0
    const observingDb = {
      prepare(sql: string) {
        prepareCalls += 1
        return harness.db.prepare(sql)
      },
      batch: harness.db.batch.bind(harness.db),
    } as D1Database
    const rejectedSql = [
      'INSERT INTO execution_receipts (id) VALUES (?1)',
      'UPDATE execution_receipt_heads SET updated_at = ?1',
      'DELETE FROM execution_receipt_edges WHERE id = ?1',
      'INSERT INTO mutation_audit_entries (id) VALUES (?1)',
      'INSERT INTO host_control_receipts (id) VALUES (?1)',
      'UPDATE tasks SET title = ?1 WHERE id = ?2',
      'DELETE FROM flights WHERE id = ?1',
      'INSERT INTO departments (id, slug, name) VALUES (?1, ?2, ?3)',
      'INSERT INTO Artifacts (id) VALUES (?1)',
      'insert into artifacts (id) values (?1)',
      'INSERT INTO "artifacts" (id) VALUES (?1)',
      'INSERT INTO [artifacts] (id) VALUES (?1)',
      'INSERT INTO `artifacts` (id) VALUES (?1)',
      'INSERT INTO main.artifacts (id) VALUES (?1)',
      'INSERT INTO artifacts_backup (id) VALUES (?1)',
      '/* projection */ INSERT INTO artifacts (id) VALUES (?1)',
      'UPDATE artifact_retrieval_receipts AS r SET retrieved_at = ?1',
    ]

    for (const [index, sql] of rejectedSql.entries()) {
      expect(() => prepareAuditedProjectionMutation(observingDb, {
        sql,
        bindings: [],
        audit: artifactAudit(`audit-rejected-projection-${index}`, 'artifact', 'target'),
      })).toThrowError(expect.objectContaining({
        name: 'ExecutionReceiptError',
        code: 'invalid_draft',
      }))
    }
    expect(prepareCalls).toBe(0)
    expectNoReceiptChainState()
  })

  it('commits an artifacts projection and audit without advancing the receipt chain', async () => {
    const storageReceiptId = await seedProjectionArtifactPrerequisites('projection-storage-1')
    const before = receiptChainCounts()
    const projection = prepareArtifactProjection({
      auditId: 'audit-artifact-projection',
      artifactId: 'artifact-projection',
      storageReceiptId,
      objectKey: 'sha256/aa/artifact-projection',
    })
    const exposed = Object.fromEntries(Object.entries(projection))

    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.keys(projection)).toEqual(['expectedAuditId'])
    expect(exposed.mutationStatement).toBeUndefined()
    expect(exposed.guardStatement).toBeUndefined()
    const audits = await executeAuditedProjectionMutations(env, [projection])

    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      id: 'audit-artifact-projection',
      tenant: TENANT,
      handler: 'flight_spine_projection_test',
      target_kind: 'artifact',
      target_id: 'artifact-projection',
    })
    expect(harness.sqlite.prepare(`
      SELECT id, object_key, storage_receipt_id
        FROM artifacts WHERE id = 'artifact-projection'
    `).get()).toEqual({
      id: 'artifact-projection',
      object_key: 'sha256/aa/artifact-projection',
      storage_receipt_id: storageReceiptId,
    })
    expect(receiptChainCounts()).toEqual(before)
  })

  it('commits an artifact-retrieval projection without advancing the receipt chain', async () => {
    const storageReceiptId = await seedProjectionArtifactPrerequisites('projection-storage-2')
    await executeAuditedProjectionMutations(env, [prepareArtifactProjection({
      auditId: 'audit-artifact-for-retrieval',
      artifactId: 'artifact-for-retrieval',
      storageReceiptId,
      objectKey: 'sha256/aa/artifact-for-retrieval',
    })])
    const retrievalReceipt = await appendExecutionReceipt(env, memberAuth(), {
      type: 'result.reported',
      idempotencyKey: 'projection-retrieval-receipt',
      flightId: 'projection-flight',
      taskId: 'projection-task',
      assignmentEpoch: 1,
      claims: { artifactRetrieved: true },
    })
    const before = receiptChainCounts()
    const projection = auditedProjectionMutation({
      auditId: 'audit-artifact-retrieval-projection',
      sql: `
        INSERT INTO artifact_retrieval_receipts (
          id, tenant, artifact_id, verifier_principal_kind,
          verifier_principal_id, verifier_agent_id, verifier_runtime_seat_id,
          recomputed_digest, retrieval_receipt_id, retrieved_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)
      `,
      bindings: [
        'retrieval-projection',
        TENANT,
        'artifact-for-retrieval',
        'agent',
        'projection-verifier',
        'projection-verifier',
        'a'.repeat(64),
        retrievalReceipt.id,
        SERVER_TIME,
      ],
      targetKind: 'artifact_retrieval_receipt',
      targetId: 'retrieval-projection',
    })

    const audits = await executeAuditedProjectionMutations(env, [projection])

    expect(audits[0]).toMatchObject({
      id: 'audit-artifact-retrieval-projection',
      target_kind: 'artifact_retrieval_receipt',
      target_id: 'retrieval-projection',
    })
    expect(harness.sqlite.prepare(`
      SELECT id, artifact_id, retrieval_receipt_id
        FROM artifact_retrieval_receipts WHERE id = 'retrieval-projection'
    `).get()).toEqual({
      id: 'retrieval-projection',
      artifact_id: 'artifact-for-retrieval',
      retrieval_receipt_id: retrievalReceipt.id,
    })
    expect(receiptChainCounts()).toEqual(before)
  })

  it('rejects empty, forged and mixed projection handle sets without writing', async () => {
    await expect(executeAuditedProjectionMutations(env, [])).rejects.toMatchObject({
      name: 'ExecutionReceiptError',
      code: 'invalid_draft',
    })
    const forged = Object.freeze({
      expectedAuditId: 'forged-projection',
    }) as PreparedAuditedProjectionMutation
    await expect(executeAuditedProjectionMutations(env, [forged])).rejects.toMatchObject({
      name: 'ExecutionReceiptError',
      code: 'invalid_draft',
    })
    const general = auditedDepartmentMutation({
      auditId: 'audit-general-mixed',
      mutationSql: `
        INSERT INTO departments (id, slug, name) VALUES (?1, ?2, ?3)
      `,
      bindings: ['general-mixed', 'general-mixed', 'General Mixed'],
      targetId: 'general-mixed',
    })
    const projection = auditedProjectionMutation({
      auditId: 'audit-projection-mixed',
      sql: 'UPDATE artifacts SET object_key = object_key WHERE id = ?1',
      bindings: ['missing-artifact'],
      targetKind: 'artifact',
      targetId: 'missing-artifact',
    })
    await expect(executeAuditedProjectionMutations(env, [
      projection,
      general as PreparedAuditedProjectionMutation,
    ])).rejects.toMatchObject({
      name: 'ExecutionReceiptError',
      code: 'invalid_draft',
    })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM mutation_audit_entries').get())
      .toEqual({ count: 0 })
    expectNoReceiptChainState()
  })

  it('rolls back zero-row artifact projections without chain effects', async () => {
    const projection = auditedProjectionMutation({
      auditId: 'audit-projection-zero',
      sql: 'UPDATE artifacts SET object_key = object_key WHERE id = ?1',
      bindings: ['projection-missing'],
      targetKind: 'artifact',
      targetId: 'projection-missing',
    })

    await expect(executeAuditedProjectionMutations(env, [projection]))
      .rejects.toThrow(/check constraint/i)

    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM mutation_audit_entries').get())
      .toEqual({ count: 0 })
    expectNoReceiptChainState()
  })

  it('rolls back a multi-row artifacts projection and preserves its receipt baseline', async () => {
    const storageReceiptId = await seedProjectionArtifactPrerequisites('projection-storage-multi-1')
    const secondStorage = await appendExecutionReceipt(env, memberAuth(), {
      type: 'result.reported',
      idempotencyKey: 'projection-storage-multi-2',
      flightId: 'projection-flight',
      taskId: 'projection-task',
      assignmentEpoch: 1,
      claims: { secondArtifactMetadataReady: true },
    })
    const before = receiptChainCounts()
    const projection = auditedProjectionMutation({
      auditId: 'audit-projection-multi',
      sql: `
        INSERT INTO artifacts (
          id, tenant, flight_id, producing_assignment_id, producing_task_id,
          producing_agent_id, producing_runtime_seat_id, assignment_epoch,
          object_key, digest, size_bytes, visibility, retention_until,
          storage_receipt_id, created_at
        ) VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15),
          (?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)
      `,
      bindings: [
        'artifact-multi-a', TENANT, 'projection-flight', 'projection-assignment',
        'projection-task', 'projection-agent', 'projection-seat', 1,
        'sha256/aa/artifact-multi-a', 'a'.repeat(64), 128, 'tenant',
        '2026-09-23T16:00:00.000Z', storageReceiptId, SERVER_TIME,
        'artifact-multi-b', TENANT, 'projection-flight', 'projection-assignment',
        'projection-task', 'projection-agent', 'projection-seat', 1,
        'sha256/aa/artifact-multi-b', 'b'.repeat(64), 256, 'tenant',
        '2026-09-23T16:00:00.000Z', secondStorage.id, SERVER_TIME,
      ],
      targetKind: 'artifact',
      targetId: 'artifact-multi-a,artifact-multi-b',
    })

    await expect(executeAuditedProjectionMutations(env, [projection]))
      .rejects.toThrow(/check constraint/i)

    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM artifacts
       WHERE id IN ('artifact-multi-a', 'artifact-multi-b')
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM mutation_audit_entries').get())
      .toEqual({ count: 0 })
    expect(receiptChainCounts()).toEqual(before)
  })

  it('rolls back earlier artifacts projections when a later projection hard-fails', async () => {
    const storageReceiptId = await seedProjectionArtifactPrerequisites('projection-storage-hard-1')
    const secondStorage = await appendExecutionReceipt(env, memberAuth(), {
      type: 'result.reported',
      idempotencyKey: 'projection-storage-hard-2',
      flightId: 'projection-flight',
      taskId: 'projection-task',
      assignmentEpoch: 1,
      claims: { secondArtifactMetadataReady: true },
    })
    const before = receiptChainCounts()
    const first = prepareArtifactProjection({
      auditId: 'audit-projection-hard-first',
      artifactId: 'artifact-hard',
      storageReceiptId,
      objectKey: 'sha256/aa/artifact-hard-first',
    })
    const duplicate = prepareArtifactProjection({
      auditId: 'audit-projection-hard-duplicate',
      artifactId: 'artifact-hard',
      storageReceiptId: secondStorage.id,
      objectKey: 'sha256/aa/artifact-hard-duplicate',
    })

    await expect(executeAuditedProjectionMutations(env, [first, duplicate]))
      .rejects.toThrow(/unique constraint/i)

    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM artifacts WHERE id = 'artifact-hard'
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM mutation_audit_entries
       WHERE id LIKE 'audit-projection-hard-%'
    `).get()).toEqual({ count: 0 })
    expect(receiptChainCounts()).toEqual(before)
  })

  it('rejects every non-direct or compound SQL shape before preparing or executing it', () => {
    let prepareCalls = 0
    const observingDb = {
      prepare(sql: string) {
        prepareCalls += 1
        return harness.db.prepare(sql)
      },
      batch: harness.db.batch.bind(harness.db),
    } as D1Database
    const rejectedSql = [
      '',
      'SELECT 1 WHERE 0',
      'CREATE TABLE bypass_table (id TEXT)',
      'ALTER TABLE departments ADD COLUMN bypass TEXT',
      'DROP TABLE departments',
      'PRAGMA foreign_keys = OFF',
      'WITH candidate AS (SELECT 1) UPDATE departments SET name = name',
      '-- trusted-looking comment\nUPDATE departments SET name = name',
      '/* trusted-looking comment */ UPDATE departments SET name = name',
      "UPDATE departments SET name = name; DELETE FROM departments",
    ]

    for (const [index, sql] of rejectedSql.entries()) {
      expect(() => prepareAuditedDomainMutation(observingDb, {
        sql,
        bindings: [],
        audit: departmentAudit(`audit-rejected-sql-${index}`, 'rejected-target'),
      })).toThrowError(expect.objectContaining({
        name: 'ExecutionReceiptError',
        code: 'invalid_draft',
      }))
    }
    expect(prepareCalls).toBe(0)
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'bypass_table'
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipts').get())
      .toEqual({ count: 0 })
  })

  it('commits two receipts with one strict domain insert and executor-generated audit guard', async () => {
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('opaque-prepared-objective'),
      draft('opaque-prepared-flight', {
        type: 'flight.materialized',
        flightId: 'opaque-prepared-flight-1',
        claims: { lanes: 2 },
      }),
    ])
    const domain = auditedDepartmentMutation({
      auditId: 'audit-opaque-prepared-domain',
      mutationSql: `
        INSERT OR ABORT INTO departments (id, slug, name)
        VALUES (?1, ?2, ?3)
      `,
      targetId: 'opaque-prepared-domain',
      bindings: ['opaque-prepared-domain', 'opaque-prepared-domain', 'Opaque Prepared Domain'],
    })

    const receipts = await executePreparedExecutionReceiptBatch(env, prepared, [domain])

    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toMatchObject({
      id: prepared.expectedReceipts[0].id,
      sequence: 1,
      predecessorReceiptId: null,
      serverTimestamp: SERVER_TIME,
    })
    expect(receipts[1]).toMatchObject({
      id: prepared.expectedReceipts[1].id,
      sequence: 2,
      predecessorReceiptId: receipts[0].id,
      predecessorHash: receipts[0].receiptHash,
      serverTimestamp: SERVER_TIME,
    })
    expect(harness.sqlite.prepare(`
      SELECT id, slug, name FROM departments WHERE id = 'opaque-prepared-domain'
    `).get()).toEqual({
      id: 'opaque-prepared-domain',
      slug: 'opaque-prepared-domain',
      name: 'Opaque Prepared Domain',
    })
    expect(harness.sqlite.prepare(`
      SELECT id, tenant, principal_kind, handler, operation, target_kind,
             target_id, request_id, evidence_json
        FROM mutation_audit_entries
       WHERE id = 'audit-opaque-prepared-domain'
    `).get()).toEqual({
      id: 'audit-opaque-prepared-domain',
      tenant: TENANT,
      principal_kind: 'member',
      handler: 'flight_spine_test',
      operation: 'upsert',
      target_kind: 'department',
      target_id: 'opaque-prepared-domain',
      request_id: 'audit-opaque-prepared-domain',
      evidence_json: '{"test":"flight-spine-receipts"}',
    })
    expect(harness.sqlite.prepare(`
      SELECT from_receipt_id, to_receipt_id, relation
        FROM execution_receipt_edges
       WHERE tenant = ?
    `).get(TENANT)).toEqual({
      from_receipt_id: receipts[0].id,
      to_receipt_id: receipts[1].id,
      relation: 'predecessor',
    })
  })

  it('commits one directly validated UPDATE with bound values', async () => {
    harness.sqlite.prepare(`
      INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)
    `).run('update-domain', 'update-domain', 'Before')
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('direct-update-receipt'),
    ])
    const domain = auditedDepartmentMutation({
      auditId: 'audit-direct-update',
      mutationSql: 'UPDATE departments SET name = ?1 WHERE id = ?2',
      bindings: ['After', 'update-domain'],
      targetId: 'update-domain',
    })

    const receipts = await executePreparedExecutionReceiptBatch(env, prepared, [domain])

    expect(receipts).toHaveLength(1)
    expect(harness.sqlite.prepare(`
      SELECT id, name FROM departments WHERE id = 'update-domain'
    `).get()).toEqual({ id: 'update-domain', name: 'After' })
    expect(harness.sqlite.prepare(`
      SELECT target_id FROM mutation_audit_entries WHERE id = 'audit-direct-update'
    `).get()).toEqual({ target_id: 'update-domain' })
  })

  it('commits one directly validated DELETE with a bound value', async () => {
    harness.sqlite.prepare(`
      INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)
    `).run('delete-domain', 'delete-domain', 'Delete Me')
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('direct-delete-receipt'),
    ])
    const domain = auditedDepartmentMutation({
      auditId: 'audit-direct-delete',
      mutationSql: 'DELETE FROM departments WHERE id = ?1',
      bindings: ['delete-domain'],
      targetId: 'delete-domain',
    })

    const receipts = await executePreparedExecutionReceiptBatch(env, prepared, [domain])

    expect(receipts).toHaveLength(1)
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM departments WHERE id = 'delete-domain'
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT target_id FROM mutation_audit_entries WHERE id = 'audit-direct-delete'
    `).get()).toEqual({ target_id: 'delete-domain' })
  })

  it('rolls back receipts, edges, head, domain and audit rows on a hard SQL failure', async () => {
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('opaque-domain-failure-first'),
      draft('opaque-domain-failure-second', {
        type: 'flight.materialized',
        flightId: 'opaque-flight-failure',
      }),
    ])
    const firstDomain = auditedDepartmentMutation({
      auditId: 'audit-opaque-domain-rollback-first',
      mutationSql: `
        INSERT INTO departments (id, slug, name)
        VALUES ('opaque-domain-rollback', 'opaque-domain-rollback', 'Opaque Domain Rollback')
      `,
      targetId: 'opaque-domain-rollback',
    })
    const duplicateDomain = auditedDepartmentMutation({
      auditId: 'audit-opaque-domain-rollback-duplicate',
      mutationSql: `
        INSERT INTO departments (id, slug, name)
        VALUES ('opaque-domain-rollback', 'opaque-domain-copy', 'Must Fail')
      `,
      targetId: 'opaque-domain-rollback',
    })

    await expect(executePreparedExecutionReceiptBatch(
      env,
      prepared,
      [firstDomain, duplicateDomain],
    )).rejects.toThrow(/unique constraint/i)

    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipts').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipt_edges').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipt_heads').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM departments WHERE id = 'opaque-domain-rollback'
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM mutation_audit_entries
       WHERE id LIKE 'audit-opaque-domain-rollback-%'
    `).get()).toEqual({ count: 0 })
  })

  it('turns a semantic zero-write into a CHECK abort and rolls back the whole batch', async () => {
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('opaque-semantic-zero-first'),
      draft('opaque-semantic-zero-second', {
        type: 'task.assigned',
        taskId: 'opaque-semantic-zero-task',
      }),
    ])
    const semanticZero = auditedDepartmentMutation({
      auditId: 'audit-opaque-semantic-zero',
      mutationSql: `
        UPDATE departments SET name = 'Expected Name' WHERE id = 'opaque-missing-domain'
      `,
      targetId: 'opaque-missing-domain',
    })

    await expect(executePreparedExecutionReceiptBatch(env, prepared, [semanticZero]))
      .rejects.toThrow(/check constraint/i)

    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipts').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipt_edges').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipt_heads').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM departments WHERE id = 'opaque-missing-domain'
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM mutation_audit_entries
       WHERE id = 'audit-opaque-semantic-zero'
    `).get()).toEqual({ count: 0 })
  })

  it('turns a multi-row mutation into a CHECK abort and rolls back all changed rows', async () => {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES
        ('multi-domain-a', 'multi-domain-a', 'Before A'),
        ('multi-domain-b', 'multi-domain-b', 'Before B');
    `)
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('opaque-multi-first'),
      draft('opaque-multi-second', { type: 'task.assigned', taskId: 'opaque-multi-task' }),
    ])
    const multiRow = auditedDepartmentMutation({
      auditId: 'audit-opaque-multi-row',
      mutationSql: `
        UPDATE departments SET name = 'After'
         WHERE id IN ('multi-domain-a', 'multi-domain-b')
      `,
      targetId: 'multi-domain-a,multi-domain-b',
    })

    await expect(executePreparedExecutionReceiptBatch(env, prepared, [multiRow]))
      .rejects.toThrow(/check constraint/i)

    expect(harness.sqlite.prepare(`
      SELECT id, name FROM departments
       WHERE id IN ('multi-domain-a', 'multi-domain-b') ORDER BY id
    `).all()).toEqual([
      { id: 'multi-domain-a', name: 'Before A' },
      { id: 'multi-domain-b', name: 'Before B' },
    ])
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipts').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipt_edges').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipt_heads').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM mutation_audit_entries
       WHERE id = 'audit-opaque-multi-row'
    `).get()).toEqual({ count: 0 })
  })

  it('rolls back receipts, edges, domain and audit rows when the opaque final CAS is stale', async () => {
    const first = await appendExecutionReceipt(env, memberAuth(), draft('opaque-stale-base'))
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('opaque-stale-first'),
      draft('opaque-stale-second', { type: 'task.assigned', taskId: 'opaque-stale-task' }),
    ])
    const competitor = await appendExecutionReceipt(env, memberAuth(), draft('opaque-stale-competitor'))
    const edgeCountBefore = harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM execution_receipt_edges WHERE tenant = ?
    `).get(TENANT)
    const headBefore = harness.sqlite.prepare(`
      SELECT sequence, receipt_id, receipt_hash
        FROM execution_receipt_heads
       WHERE tenant = ?
    `).get(TENANT)
    const domain = auditedDepartmentMutation({
      auditId: 'audit-opaque-stale-domain',
      mutationSql: `
        INSERT INTO departments (id, slug, name)
        VALUES ('opaque-stale-domain', 'opaque-stale-domain', 'Opaque Stale Domain')
      `,
      targetId: 'opaque-stale-domain',
    })

    await expect(executePreparedExecutionReceiptBatch(env, prepared, [domain]))
      .rejects.toThrow(/head sequence must advance/i)

    expect(first.id).not.toBe(competitor.id)
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count
        FROM execution_receipts
       WHERE idempotency_key IN ('opaque-stale-first', 'opaque-stale-second')
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM execution_receipt_edges WHERE tenant = ?
    `).get(TENANT)).toEqual(edgeCountBefore)
    expect(harness.sqlite.prepare(`
      SELECT sequence, receipt_id, receipt_hash
        FROM execution_receipt_heads
       WHERE tenant = ?
    `).get(TENANT)).toEqual(headBefore)
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM departments WHERE id = 'opaque-stale-domain'
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM mutation_audit_entries
       WHERE id = 'audit-opaque-stale-domain'
    `).get()).toEqual({ count: 0 })
  })

  it('rejects duplicate intra-chain idempotency keys in the fresh builder', async () => {
    await expect(prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('opaque-duplicate-key'),
      draft('opaque-duplicate-key', { type: 'task.assigned', taskId: 'opaque-duplicate-task' }),
    ])).rejects.toMatchObject({
      name: 'ExecutionReceiptError',
      code: 'idempotency_conflict',
    })
  })

  it('rejects a batch result whose cardinality cannot map every opaque piece exactly', async () => {
    const shortResultDb = {
      prepare: harness.db.prepare.bind(harness.db),
      batch: async () => [],
    } as D1Database
    const shortResultEnv = { ...env, DB: shortResultDb }
    const prepared = await prepareFreshExecutionReceiptChain(shortResultEnv, memberAuth(), [
      draft('opaque-short-result'),
    ])
    const domain = auditedDepartmentMutation({
      auditId: 'audit-opaque-short-result',
      mutationSql: `
        INSERT INTO departments (id, slug, name)
        VALUES ('opaque-short-domain', 'opaque-short-domain', 'Opaque Short Domain')
      `,
      targetId: 'opaque-short-domain',
      db: shortResultDb,
    })

    await expect(executePreparedExecutionReceiptBatch(shortResultEnv, prepared, [domain]))
      .rejects.toMatchObject({
        name: 'ExecutionReceiptError',
        code: 'persistence_conflict',
      })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipts').get())
      .toEqual({ count: 0 })
  })

  it('rejects an existing idempotency key in the fresh-only prepared builder', async () => {
    const existing = draft('prepared-existing-key')
    const original = await appendExecutionReceipt(env, memberAuth(), existing)

    await expect(prepareFreshExecutionReceiptChain(env, memberAuth(), [existing]))
      .rejects.toMatchObject({
        name: 'ExecutionReceiptError',
        code: 'idempotency_conflict',
      })
    expect(await appendExecutionReceipt(env, memberAuth(), existing)).toEqual(original)
  })

  it('creates a genesis receipt, then links its successor and advances the tenant head', async () => {
    const first = await appendExecutionReceipt(env, memberAuth(), draft('objective-accepted'))
    const second = await appendExecutionReceipt(env, memberAuth(), draft('flight-materialized', {
      type: 'flight.materialized',
      objectiveId: 'objective-1',
      flightId: 'flight-1',
      claims: { laneCount: 2 },
    }))

    expect(first).toMatchObject({
      sequence: 1,
      predecessorReceiptId: null,
      predecessorHash: null,
    })
    expect(second).toMatchObject({
      sequence: 2,
      predecessorReceiptId: first.id,
      predecessorHash: first.receiptHash,
    })
    expect(harness.sqlite.prepare(`
      SELECT sequence, receipt_id, receipt_hash
        FROM execution_receipt_heads
       WHERE tenant = ?
    `).get(TENANT)).toEqual({
      sequence: second.sequence,
      receipt_id: second.id,
      receipt_hash: second.receiptHash,
    })
    expect(harness.sqlite.prepare(`
      SELECT from_receipt_id, to_receipt_id, relation
        FROM execution_receipt_edges
       WHERE tenant = ?
    `).get(TENANT)).toEqual({
      from_receipt_id: first.id,
      to_receipt_id: second.id,
      relation: 'predecessor',
    })
  })

  it('hashes canonical Unicode-key claims with the documented v1 server preimage', async () => {
    const receipt = await appendExecutionReceipt(env, memberAuth(), draft('unicode-key', {
      objectiveId: 'objective-unicode',
      claims: { '😀': 'astral', 'é': 'accent', a: 'ascii' },
    }))

    const expectedClaims = '{"a":"ascii","é":"accent","😀":"astral"}'
    const expectedPayload = [
      '{"actor_id":"member-1","actor_kind":"member","assignment_epoch":null,',
      `"claims":${expectedClaims},"fencing_epoch":null,"flight_id":null,`,
      '"idempotency_key":"unicode-key","issuer_id":"mupot:tenant-a",',
      '"issuer_kind":"mupot","lease_token_hash":null,"message_id":null,',
      '"objective_id":"objective-unicode","predecessor_hash":null,',
      '"predecessor_receipt_id":null,"seat_generation":null,"seat_id":null,',
      `"server_timestamp":"${SERVER_TIME}","task_id":null,`,
      '"tenant":"tenant-a","type":"objective.accepted"}',
    ].join('')

    expect(receipt.claimsJson).toBe(expectedClaims)
    expect(receipt.payloadDigest).toBe(await sha256Hex(expectedClaims))
    expect(receipt.canonicalPayload).toBe(expectedPayload)
    expect(receipt.receiptHash).toBe(await sha256Hex(expectedPayload))
  })

  it('derives timestamp, predecessor, actor and issuer on the server and ignores forged draft fields', async () => {
    const forgedDraft = {
      ...draft('server-facts'),
      sequence: 999,
      serverTimestamp: '2000-01-01T00:00:00.000Z',
      predecessorReceiptId: 'forged-predecessor',
      predecessorHash: 'a'.repeat(64),
      actorKind: 'controller',
      actorId: 'forged-actor',
      issuerKind: 'runtime',
      issuerId: 'forged-runtime',
      receiptHash: 'b'.repeat(64),
    } as ExecutionReceiptDraft

    const receipt = await appendExecutionReceipt(env, agentAuth(), forgedDraft)

    expect(receipt).toMatchObject({
      sequence: 1,
      serverTimestamp: SERVER_TIME,
      predecessorReceiptId: null,
      predecessorHash: null,
      actorKind: 'agent',
      actorId: 'agent-1',
      issuerKind: 'mupot',
      issuerId: 'mupot:tenant-a',
    })
    expect(receipt.receiptHash).not.toBe('b'.repeat(64))
    expect(receipt.canonicalPayload).not.toContain('forged')
  })

  it('appends, replays and verifies a flight dependency-linked receipt', async () => {
    const input: ExecutionReceiptDraft = {
      type: 'flight.dependency_linked',
      idempotencyKey: 'dependency-linked-key',
      objectiveId: 'objective-dependency',
      flightId: 'flight-parent',
      claims: {
        dependencyId: 'dependency-1',
        parentFlightId: 'flight-parent',
        childFlightId: 'flight-child',
      },
    }

    const first = await appendExecutionReceipt(env, memberAuth(), input)
    vi.setSystemTime(new Date('2026-08-23T18:00:00.000Z'))
    const replay = await appendExecutionReceipt(env, memberAuth(), input)

    expect(first).toMatchObject({
      type: 'flight.dependency_linked',
      objectiveId: 'objective-dependency',
      flightId: 'flight-parent',
      taskId: null,
      assignmentEpoch: null,
      claimsJson: '{"childFlightId":"flight-child","dependencyId":"dependency-1","parentFlightId":"flight-parent"}',
    })
    expect(replay).toEqual(first)
    expect(await getExecutionReceipt(env, first.id)).toEqual(first)
    expect(await verifyExecutionReceipt(env, first.id)).toEqual({ ok: true })
    await expect(appendExecutionReceipt(env, memberAuth(), {
      ...input,
      claims: {
        dependencyId: 'dependency-1',
        parentFlightId: 'flight-parent',
        childFlightId: 'flight-other',
      },
    })).rejects.toMatchObject({
      name: 'ExecutionReceiptError',
      code: 'idempotency_conflict',
    })
  })

  it('appends, replays and verifies an artifact-consumed receipt with assignment epoch', async () => {
    const input: ExecutionReceiptDraft = {
      type: 'artifact.consumed',
      idempotencyKey: 'artifact-consumed-key',
      objectiveId: 'objective-artifact',
      flightId: 'flight-parent',
      taskId: 'task-parent',
      assignmentEpoch: 3,
      claims: {
        artifactId: 'artifact-child',
        flightDependencyId: 'dependency-1',
        consumingAssignmentId: 'assignment-parent',
      },
    }

    const first = await appendExecutionReceipt(env, agentAuth(), input)
    vi.setSystemTime(new Date('2026-08-23T18:00:00.000Z'))
    const replay = await appendExecutionReceipt(env, agentAuth(), input)

    expect(first).toMatchObject({
      type: 'artifact.consumed',
      actorKind: 'agent',
      actorId: 'agent-1',
      objectiveId: 'objective-artifact',
      flightId: 'flight-parent',
      taskId: 'task-parent',
      assignmentEpoch: 3,
      claimsJson: '{"artifactId":"artifact-child","consumingAssignmentId":"assignment-parent","flightDependencyId":"dependency-1"}',
    })
    expect(replay).toEqual(first)
    expect(await getExecutionReceipt(env, first.id)).toEqual(first)
    expect(await verifyExecutionReceipt(env, first.id)).toEqual({ ok: true })
    await expect(appendExecutionReceipt(env, agentAuth(), {
      ...input,
      claims: {
        artifactId: 'artifact-other',
        flightDependencyId: 'dependency-1',
        consumingAssignmentId: 'assignment-parent',
      },
    })).rejects.toMatchObject({
      name: 'ExecutionReceiptError',
      code: 'idempotency_conflict',
    })
  })

  it('rejects receipt categories whose authoritative issuers arrive after Flight 2', async () => {
    const unsupportedTypes = [
      'host.persisted',
      'runtime.injected',
      'runtime.consumed',
      'provider.observed',
      'provider.reconciled',
      'runtime.ack',
      'source.ack',
      'artifact.stored',
      'artifact.retrieved',
      'gate.verdict',
      'host_control.observed',
    ] as const satisfies readonly ExecutionReceiptType[]

    for (const type of unsupportedTypes) {
      await expect(appendExecutionReceipt(env, memberAuth(), draft(`unsupported-${type}`, {
        type,
      } as Partial<ExecutionReceiptDraft>))).rejects.toMatchObject({
        name: 'ExecutionReceiptError',
        code: 'unsupported_receipt_type',
      })
    }
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipts').get())
      .toEqual({ count: 0 })
  })

  it('returns the original row for a same-key same-bytes replay', async () => {
    const input = draft('replay-key', { claims: { b: 2, a: 1 } })
    const first = await appendExecutionReceipt(env, memberAuth(), input)
    vi.setSystemTime(new Date('2026-08-23T17:00:00.000Z'))

    const replay = await appendExecutionReceipt(env, memberAuth(), input)

    expect(replay).toEqual(first)
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count
        FROM execution_receipts
       WHERE tenant = ? AND idempotency_key = ?
    `).get(TENANT, input.idempotencyKey)).toEqual({ count: 1 })
  })

  it('rejects same-key different-bytes reuse without appending a row', async () => {
    await appendExecutionReceipt(env, memberAuth(), draft('conflict-key', {
      claims: { accepted: true },
    }))

    await expect(appendExecutionReceipt(env, memberAuth(), draft('conflict-key', {
      claims: { accepted: false },
    }))).rejects.toMatchObject({
      name: 'ExecutionReceiptError',
      code: 'idempotency_conflict',
    })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipts').get())
      .toEqual({ count: 1 })
  })

  it('rejects same-key replay by a different authenticated actor', async () => {
    const input = draft('actor-conflict')
    await appendExecutionReceipt(env, memberAuth(), input)
    const otherActor = { ...memberAuth(), memberId: 'member-2', userId: 'user-2' }

    await expect(appendExecutionReceipt(env, otherActor, input)).rejects.toMatchObject({
      name: 'ExecutionReceiptError',
      code: 'idempotency_conflict',
    })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM execution_receipts WHERE idempotency_key = 'actor-conflict'
    `).get()).toEqual({ count: 1 })
  })

  it('maps a concurrent stale tenant head to a typed conflict and rolls back the stale row', async () => {
    const first = await appendExecutionReceipt(env, memberAuth(), draft('race-genesis'))
    let injected = false
    const racedDb = {
      prepare: harness.db.prepare.bind(harness.db),
      batch: async (statements: Parameters<D1Database['batch']>[0]) => {
        if (!injected) {
          injected = true
          harness.sqlite.prepare(`
            INSERT INTO execution_receipts (
              id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
              objective_id, idempotency_key, claims_json, canonical_payload,
              payload_digest, predecessor_receipt_id, predecessor_hash,
              receipt_hash, server_timestamp
            ) VALUES (
              'concurrent-receipt', ?, 'objective.accepted', 'mupot',
              'mupot:tenant-a', 'member', 'member-racer', 'objective-racer',
              'concurrent-key', '{}', '{}', ?, ?, ?, ?, ?
            )
          `).run(TENANT, 'a'.repeat(64), first.id, first.receiptHash, 'b'.repeat(64), SERVER_TIME)
          harness.sqlite.prepare(`
            UPDATE execution_receipt_heads
               SET sequence = (SELECT sequence FROM execution_receipts WHERE id = 'concurrent-receipt'),
                   receipt_id = 'concurrent-receipt',
                   receipt_hash = ?,
                   updated_at = ?
             WHERE tenant = ?
          `).run('b'.repeat(64), SERVER_TIME, TENANT)
        }
        return harness.db.batch(statements)
      },
    } as D1Database
    const racedEnv = { ...env, DB: racedDb }

    await expect(appendExecutionReceipt(racedEnv, memberAuth(), draft('stale-writer')))
      .rejects.toMatchObject({
        name: 'ExecutionReceiptError',
        code: 'stale_head',
      })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM execution_receipts WHERE idempotency_key = 'stale-writer'
    `).get()).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM execution_receipt_edges WHERE tenant = ?
    `).get(TENANT)).toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT sequence, receipt_id, receipt_hash
        FROM execution_receipt_heads
       WHERE tenant = ?
    `).get(TENANT)).toEqual({
      sequence: 2,
      receipt_id: 'concurrent-receipt',
      receipt_hash: 'b'.repeat(64),
    })
  })

  it('returns a committed receipt when a successor advances the head before postwrite verification', async () => {
    let competitorReceipt: ExecutionReceipt | null = null
    const postCommitRaceDb = {
      prepare: harness.db.prepare.bind(harness.db),
      batch: async (statements: Parameters<D1Database['batch']>[0]) => {
        const results = await harness.db.batch(statements)
        competitorReceipt = await appendExecutionReceipt(env, memberAuth(), draft('postcommit-successor', {
          type: 'flight.materialized',
          flightId: 'flight-successor',
          claims: { lanes: 2 },
        }))
        return results
      },
    } as D1Database
    const racedEnv = { ...env, DB: postCommitRaceDb }

    const first = await appendExecutionReceipt(racedEnv, memberAuth(), draft('postcommit-first'))
    if (competitorReceipt === null) throw new Error('competitor receipt was not appended')
    const second = competitorReceipt as ExecutionReceipt

    expect(second.predecessorReceiptId).toBe(first.id)
    expect(harness.sqlite.prepare(`
      SELECT sequence, receipt_id, receipt_hash
        FROM execution_receipt_heads
       WHERE tenant = ?
    `).get(TENANT)).toEqual({
      sequence: second.sequence,
      receipt_id: second.id,
      receipt_hash: second.receiptHash,
    })
    expect(await verifyExecutionReceipt(env, first.id)).toEqual({ ok: true })
    expect(await verifyExecutionReceipt(env, second.id)).toEqual({ ok: true })
  })

  it('isolates idempotency, reads and heads by tenant', async () => {
    const first = await appendExecutionReceipt(env, memberAuth(), draft('shared-key'))
    const otherEnv = { ...env, TENANT_SLUG: 'tenant-b' }
    const second = await appendExecutionReceipt(otherEnv, memberAuth('tenant-b'), draft('shared-key'))

    expect(second.predecessorReceiptId).toBeNull()
    expect(await getExecutionReceipt(env, second.id)).toBeNull()
    expect(await getExecutionReceipt(otherEnv, first.id)).toBeNull()
    expect(harness.sqlite.prepare(`
      SELECT tenant, receipt_id FROM execution_receipt_heads ORDER BY tenant
    `).all()).toEqual([
      { tenant: TENANT, receipt_id: first.id },
      { tenant: 'tenant-b', receipt_id: second.id },
    ])
  })

  it('keeps receipt rows immutable', async () => {
    const receipt = await appendExecutionReceipt(env, memberAuth(), draft('immutable'))

    expect(() => harness.sqlite.prepare(`
      UPDATE execution_receipts SET claims_json = ? WHERE id = ?
    `).run(canonicalJson({ accepted: false }), receipt.id)).toThrow(/append-only/i)
    expect(() => harness.sqlite.prepare(`
      DELETE FROM execution_receipts WHERE id = ?
    `).run(receipt.id)).toThrow(/append-only/i)
  })

  it('rereads persisted bytes and verifies the receipt hash chain', async () => {
    const first = await appendExecutionReceipt(env, memberAuth(), draft('verify-first'))
    const second = await appendExecutionReceipt(env, memberAuth(), draft('verify-second', {
      type: 'task.assigned',
      objectiveId: null,
      taskId: 'task-1',
      assignmentEpoch: 3,
      claims: { assignee: 'agent-1' },
    }))

    const reread = await getExecutionReceipt(env, second.id)
    expect(reread).toEqual(second)
    expect(reread?.predecessorReceiptId).toBe(first.id)
    expect(await verifyExecutionReceipt(env, second.id)).toEqual({ ok: true })
  })

  it('reads and verifies a cryptographically valid future artifact-service receipt', async () => {
    const id = 'future-artifact-service-receipt'
    const claims = { artifactId: 'artifact-future', objectKey: 'sha256/aa/future' }
    const claimsJson = canonicalJson(claims)
    const payloadDigest = await sha256Hex(claimsJson)
    const payloadFacts = {
      tenant: TENANT,
      type: 'artifact.stored',
      issuer_kind: 'artifact_service',
      issuer_id: 'artifact-service-1',
      actor_kind: 'agent',
      actor_id: 'artifact-service-agent-1',
      seat_id: null,
      seat_generation: null,
      objective_id: 'objective-future',
      flight_id: 'flight-future',
      task_id: 'task-future',
      message_id: null,
      assignment_epoch: 4,
      fencing_epoch: null,
      lease_token_hash: null,
      idempotency_key: 'future-artifact-service-key',
      claims,
      predecessor_receipt_id: null,
      predecessor_hash: null,
      server_timestamp: SERVER_TIME,
    } as const
    const canonicalPayload = canonicalJson(payloadFacts)
    const receiptHash = await sha256Hex(canonicalPayload)
    harness.sqlite.prepare(`
      INSERT INTO execution_receipts (
        id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
        objective_id, flight_id, task_id, assignment_epoch, idempotency_key,
        claims_json, canonical_payload, payload_digest, predecessor_receipt_id,
        predecessor_hash, receipt_hash, server_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      id,
      TENANT,
      payloadFacts.type,
      payloadFacts.issuer_kind,
      payloadFacts.issuer_id,
      payloadFacts.actor_kind,
      payloadFacts.actor_id,
      payloadFacts.objective_id,
      payloadFacts.flight_id,
      payloadFacts.task_id,
      payloadFacts.assignment_epoch,
      payloadFacts.idempotency_key,
      claimsJson,
      canonicalPayload,
      payloadDigest,
      receiptHash,
      SERVER_TIME,
    )

    expect(await getExecutionReceipt(env, id)).toMatchObject({
      id,
      type: 'artifact.stored',
      issuerKind: 'artifact_service',
      issuerId: 'artifact-service-1',
      actorKind: 'agent',
      actorId: 'artifact-service-agent-1',
      objectiveId: 'objective-future',
      flightId: 'flight-future',
      taskId: 'task-future',
      assignmentEpoch: 4,
      receiptHash,
    })
    expect(await verifyExecutionReceipt(env, id)).toEqual({ ok: true })

    allowTestOnlyReceiptCorruption()
    const mutatedPayload = canonicalJson({
      ...payloadFacts,
      issuer_kind: 'provider_verifier',
      issuer_id: 'provider-verifier-1',
    })
    harness.sqlite.prepare(`
      UPDATE execution_receipts
         SET issuer_kind = 'provider_verifier',
             issuer_id = 'provider-verifier-1',
             canonical_payload = ?
       WHERE id = ?
    `).run(mutatedPayload, id)
    expect(await verifyExecutionReceipt(env, id)).toEqual({
      ok: false,
      error: 'receipt_hash_mismatch',
    })
  })

  it('rejects non-canonical mutated claims after database reread', async () => {
    const receipt = await appendExecutionReceipt(env, memberAuth(), draft('mutated-claims'))
    allowTestOnlyReceiptCorruption()
    harness.sqlite.prepare(`
      UPDATE execution_receipts SET claims_json = ? WHERE id = ?
    `).run('{"z":1,"a":2}', receipt.id)

    expect(await verifyExecutionReceipt(env, receipt.id)).toEqual({
      ok: false,
      error: 'claims_not_canonical',
    })
  })

  it('rejects canonical claims whose bytes no longer match the payload digest', async () => {
    const receipt = await appendExecutionReceipt(env, memberAuth(), draft('mutated-canonical-claims'))
    allowTestOnlyReceiptCorruption()
    harness.sqlite.prepare(`
      UPDATE execution_receipts SET claims_json = ? WHERE id = ?
    `).run(canonicalJson({ accepted: false }), receipt.id)

    expect(await verifyExecutionReceipt(env, receipt.id)).toEqual({
      ok: false,
      error: 'payload_digest_mismatch',
    })
  })

  it('rejects a mutated payload digest after database reread', async () => {
    const receipt = await appendExecutionReceipt(env, memberAuth(), draft('mutated-digest'))
    allowTestOnlyReceiptCorruption()
    harness.sqlite.prepare(`
      UPDATE execution_receipts SET payload_digest = ? WHERE id = ?
    `).run('c'.repeat(64), receipt.id)

    expect(await verifyExecutionReceipt(env, receipt.id)).toEqual({
      ok: false,
      error: 'payload_digest_mismatch',
    })
  })

  it('rejects a mutated canonical payload after database reread', async () => {
    const receipt = await appendExecutionReceipt(env, memberAuth(), draft('mutated-payload'))
    allowTestOnlyReceiptCorruption()
    harness.sqlite.prepare(`
      UPDATE execution_receipts SET canonical_payload = '{}' WHERE id = ?
    `).run(receipt.id)

    expect(await verifyExecutionReceipt(env, receipt.id)).toEqual({
      ok: false,
      error: 'canonical_payload_mismatch',
    })
  })

  it('rejects a mutated receipt hash after database reread', async () => {
    const receipt = await appendExecutionReceipt(env, memberAuth(), draft('mutated-hash'))
    allowTestOnlyReceiptCorruption()
    harness.sqlite.prepare(`
      UPDATE execution_receipts SET receipt_hash = ? WHERE id = ?
    `).run('c'.repeat(64), receipt.id)

    expect(await verifyExecutionReceipt(env, receipt.id)).toEqual({
      ok: false,
      error: 'receipt_hash_mismatch',
    })
  })

  it('rejects a predecessor hash that no longer matches the referenced receipt', async () => {
    await appendExecutionReceipt(env, memberAuth(), draft('predecessor-first'))
    const second = await appendExecutionReceipt(env, memberAuth(), draft('predecessor-second'))
    allowTestOnlyReceiptCorruption()
    harness.sqlite.prepare(`
      UPDATE execution_receipts SET predecessor_hash = ? WHERE id = ?
    `).run('c'.repeat(64), second.id)

    expect(await verifyExecutionReceipt(env, second.id)).toEqual({
      ok: false,
      error: 'predecessor_mismatch',
    })
  })

  it('detects a structurally cyclic predecessor chain before following it forever', async () => {
    const first = await appendExecutionReceipt(env, memberAuth(), draft('cycle-first'))
    const second = await appendExecutionReceipt(env, memberAuth(), draft('cycle-second'))
    allowTestOnlyReceiptCorruption()
    harness.sqlite.prepare(`
      UPDATE execution_receipts
         SET predecessor_receipt_id = ?, predecessor_hash = ?
       WHERE id = ?
    `).run(second.id, second.receiptHash, first.id)

    expect(await verifyExecutionReceipt(env, second.id)).toEqual({
      ok: false,
      error: 'chain_cycle',
    })
  })
})
