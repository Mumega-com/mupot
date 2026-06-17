// Write-receipt tests (#186) — phantom-success guard.
import { describe, it, expect } from 'vitest'
import { rowsWritten, assertWritten, assertBatchWritten } from '../src/lib/receipt'

describe('rowsWritten', () => {
  it('reads meta.changes', () => {
    expect(rowsWritten({ meta: { changes: 3 } })).toBe(3)
  })
  it('falls back to rows_written', () => {
    expect(rowsWritten({ meta: { rows_written: 2 } })).toBe(2)
  })
  it('absent meta → 0 (fail-closed)', () => {
    expect(rowsWritten({})).toBe(0)
    expect(rowsWritten({ meta: {} })).toBe(0)
  })
})

describe('assertWritten', () => {
  it('passes when changes >= expected', () => {
    expect(() => assertWritten({ success: true, meta: { changes: 1 } }, 'x')).not.toThrow()
  })
  it('throws receipt_failed on a 0-row write (phantom success)', () => {
    expect(() => assertWritten({ success: true, meta: { changes: 0 } }, 'tasks.insert')).toThrow(
      /receipt_failed: tasks\.insert .* wrote 0 row/,
    )
  })
  it('throws when success is explicitly false', () => {
    expect(() => assertWritten({ success: false, meta: { changes: 1 } }, 'x')).toThrow(/receipt_failed/)
  })
  it('honors a higher expected count', () => {
    expect(() => assertWritten({ meta: { changes: 1 } }, 'x', 2)).toThrow(/expected >= 2/)
    expect(() => assertWritten({ meta: { changes: 2 } }, 'x', 2)).not.toThrow()
  })
})

describe('assertBatchWritten', () => {
  it('passes when every statement wrote a row', () => {
    const ok = [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }]
    expect(() => assertBatchWritten(ok, 'mint_agent_token')).not.toThrow()
  })
  it('throws naming the offending index on a partial batch', () => {
    const partial = [{ meta: { changes: 1 } }, { meta: { changes: 0 } }, { meta: { changes: 1 } }]
    expect(() => assertBatchWritten(partial, 'mint_agent_token')).toThrow(/mint_agent_token\[1\]/)
  })
})

// Wiring: the guard actually fires inside createTask (not just in isolation).
describe('createTask — phantom-success is surfaced', () => {
  it('throws receipt_failed when the INSERT writes 0 rows', async () => {
    const { createTask } = await import('../src/tasks/service')
    // DB whose INSERT resolves "successfully" but changes nothing.
    const env = {
      DB: { prepare: () => ({ bind: () => ({ run: async () => ({ success: true, meta: { changes: 0 } }) }) }) },
    } as unknown as import('../src/types').Env
    await expect(
      createTask(env, { squad_id: 's1', title: 't', done_when: 'GET /health 200' }, { skipMirror: true }),
    ).rejects.toThrow(/receipt_failed: tasks\.insert/)
  })
})
