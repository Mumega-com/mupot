// tests/gate-verdict-receipt-retry.test.ts — seed B4: the append retries a BOUNDED number of times on stale_head (another
// receipt took the tenant head) and only on stale_head; any other failure is final, logged, and returned as failed.
// appendExecutionReceipt itself is replaced by a scripted double so each outcome is deterministic (the real concurrent race is
// covered in verdict-submission-binding.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, TaskVerdict } from '../src/types'
import { ExecutionReceiptError } from '../src/flight-spine/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const append = vi.hoisted(() => vi.fn())
vi.mock('../src/flight-spine/receipts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/flight-spine/receipts')>()),
  appendExecutionReceipt: append,
}))

const { emitGateVerdictReceipt, RECEIPT_MAX_ATTEMPTS } = await import('../src/tasks/verdict-binding')

const verdict: TaskVerdict = {
  id: 'v1', task_id: 't1', verdict: 'approved', note: null, decided_by: 'member-1', decided_at: '2026-10-22T00:00:00.000Z',
  decided_via: null, origin_agent_id: null, proposal_id: null, reversed_at: null, receipt_actor_kind: 'member',
}
const okReceipt = { id: 'r1', sequence: 7 }

let harness: SqliteD1Harness
let env: Env
beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { TENANT_SLUG: 'retry-test', DB: harness.db } as unknown as Env
  append.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

describe('gate.verdict receipt append retry', () => {
  it('retries stale_head and succeeds', async () => {
    append
      .mockRejectedValueOnce(new ExecutionReceiptError('stale_head'))
      .mockRejectedValueOnce(new ExecutionReceiptError('stale_head'))
      .mockResolvedValueOnce(okReceipt)
    expect(await emitGateVerdictReceipt(env, verdict)).toEqual({ status: 'appended', receipt_id: 'r1', sequence: 7 })
    expect(append).toHaveBeenCalledTimes(3)
  })

  it('is BOUNDED: persistent stale_head stops after RECEIPT_MAX_ATTEMPTS and reports failed (logged, not thrown)', async () => {
    append.mockRejectedValue(new ExecutionReceiptError('stale_head'))
    expect(await emitGateVerdictReceipt(env, verdict)).toEqual({ status: 'failed', error: 'stale_head' })
    expect(append).toHaveBeenCalledTimes(RECEIPT_MAX_ATTEMPTS)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('gate.verdict receipt append failed'), expect.stringContaining('"verdict_id":"v1"'))
  })

  it('does NOT retry any other failure', async () => {
    for (const error of [new ExecutionReceiptError('integrity_failure'), new ExecutionReceiptError('persistence_conflict'), new ExecutionReceiptError('idempotency_conflict'), new Error('d1 down')]) {
      append.mockReset()
      append.mockRejectedValue(error)
      const outcome = await emitGateVerdictReceipt(env, verdict)
      expect(outcome?.status).toBe('failed')
      expect(append).toHaveBeenCalledTimes(1)
    }
  })

  it('owes nothing without the marker: no append at all', async () => {
    expect(await emitGateVerdictReceipt(env, { ...verdict, receipt_actor_kind: null })).toBeNull()
    expect(append).not.toHaveBeenCalled()
  })
})
