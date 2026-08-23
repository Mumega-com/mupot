import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from '../src/lib/canonical-json'
import {
  appendExecutionReceipt,
  composePreparedExecutionReceiptBatch,
  getExecutionReceipt,
  prepareFreshExecutionReceiptChain,
  rereadAndVerifyPreparedExecutionReceipts,
  verifyPreparedExecutionReceiptBatchResult,
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
  it('commits two prepared receipts and a domain row in one verified chain batch', async () => {
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('prepared-objective'),
      draft('prepared-flight', {
        type: 'flight.materialized',
        flightId: 'prepared-flight-1',
        claims: { lanes: 2 },
      }),
    ])
    const domainStatement = env.DB.prepare(`
      INSERT INTO departments (id, slug, name)
      VALUES ('prepared-domain', 'prepared-domain', 'Prepared Domain')
    `)
    const statements = composePreparedExecutionReceiptBatch(prepared, [domainStatement])

    expect(prepared.receiptAndEdgeStatements).toHaveLength(3)
    expect(prepared.expectedReceipts).toHaveLength(2)
    expect(statements).toHaveLength(5)
    expect(statements.at(-1)).toBe(prepared.finalHeadStatement)

    const results = await env.DB.batch(statements)
    const commit = verifyPreparedExecutionReceiptBatchResult(prepared, results)
    const receipts = await rereadAndVerifyPreparedExecutionReceipts(env, prepared, results)

    expect(commit).toEqual({
      finalSequence: 2,
      finalReceiptId: prepared.expectedReceipts[1].id,
      finalReceiptHash: prepared.expectedReceipts[1].receiptHash,
    })
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
      SELECT id, slug, name FROM departments WHERE id = 'prepared-domain'
    `).get()).toEqual({
      id: 'prepared-domain',
      slug: 'prepared-domain',
      name: 'Prepared Domain',
    })
    expect(harness.sqlite.prepare(`
      SELECT receipt_id, receipt_hash FROM execution_receipt_heads WHERE tenant = ?
    `).get(TENANT)).toEqual({
      receipt_id: receipts[1].id,
      receipt_hash: receipts[1].receiptHash,
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

  it('rolls back prepared receipts, edges, head and domain rows when a domain statement fails', async () => {
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('domain-failure-first'),
      draft('domain-failure-second', { type: 'flight.materialized', flightId: 'flight-failure' }),
    ])
    const domainInsert = env.DB.prepare(`
      INSERT INTO departments (id, slug, name)
      VALUES ('domain-rollback', 'domain-rollback', 'Domain Rollback')
    `)
    const forcedFailure = env.DB.prepare(`
      INSERT INTO departments (id, slug, name)
      VALUES ('domain-rollback', 'domain-rollback-copy', 'Must Fail')
    `)

    await expect(env.DB.batch(composePreparedExecutionReceiptBatch(
      prepared,
      [domainInsert, forcedFailure],
    ))).rejects.toThrow(/unique constraint/i)

    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipts').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipt_edges').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM execution_receipt_heads').get())
      .toEqual({ count: 0 })
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM departments WHERE id = 'domain-rollback'
    `).get()).toEqual({ count: 0 })
  })

  it('rolls back prepared receipts, edges and domain rows when the final head CAS is stale', async () => {
    const first = await appendExecutionReceipt(env, memberAuth(), draft('prepared-stale-base'))
    const prepared = await prepareFreshExecutionReceiptChain(env, memberAuth(), [
      draft('prepared-stale-first'),
      draft('prepared-stale-second', { type: 'task.assigned', taskId: 'task-stale' }),
    ])
    const competitor = await appendExecutionReceipt(env, memberAuth(), draft('prepared-stale-competitor'))
    const edgeCountBefore = harness.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM execution_receipt_edges WHERE tenant = ?
    `).get(TENANT)
    const headBefore = harness.sqlite.prepare(`
      SELECT sequence, receipt_id, receipt_hash
        FROM execution_receipt_heads
       WHERE tenant = ?
    `).get(TENANT)
    const domainStatement = env.DB.prepare(`
      INSERT INTO departments (id, slug, name)
      VALUES ('stale-domain', 'stale-domain', 'Stale Domain')
    `)

    await expect(env.DB.batch(composePreparedExecutionReceiptBatch(
      prepared,
      [domainStatement],
    ))).rejects.toThrow(/head sequence must advance/i)

    expect(first.id).not.toBe(competitor.id)
    expect(harness.sqlite.prepare(`
      SELECT COUNT(*) AS count
        FROM execution_receipts
       WHERE idempotency_key IN ('prepared-stale-first', 'prepared-stale-second')
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
      SELECT COUNT(*) AS count FROM departments WHERE id = 'stale-domain'
    `).get()).toEqual({ count: 0 })
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
