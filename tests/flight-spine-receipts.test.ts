import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from '../src/lib/canonical-json'
import {
  appendExecutionReceipt,
  getExecutionReceipt,
  verifyExecutionReceipt,
} from '../src/flight-spine/receipts'
import type { AuthContext, Env } from '../src/types'
import type { ExecutionReceiptDraft, ExecutionReceiptType } from '../src/flight-spine/types'
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
      'runtime.consumed',
      'provider.observed',
      'artifact.stored',
      'gate.verdict',
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
})
