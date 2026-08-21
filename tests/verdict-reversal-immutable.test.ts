import { beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

// 0118_verdict_reversals — REAL SQL, asserting append-only immutability.
//
// P0 fix for mupot#1181: an errant verdict on an approved or rejected task
// can be reversed back to review by an org owner/admin with mandatory reason.
// The receipt in verdict_reversals is append-only and enforced by triggers.

const INSERT = `INSERT INTO verdict_reversals
  (id, tenant, task_id, squad_id, from_status, to_status, prior_verdict, reason, actor_id, actor_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const ROW = [
  'reversal-1', 'mumega', 'task-1', 'squad-1',
  'approved', 'review', 'approved',
  'errant approval reversed on new evidence', 'member-1', 'member',
] as const

describe('0118 verdict_reversals — append-only receipt', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  function insertRow(): void {
    const stmt = harness.sqlite.prepare(INSERT)
    stmt.run(...ROW)
  }

  it('accepts an insert', () => {
    insertRow()
    const rows = harness.sqlite.prepare('SELECT * FROM verdict_reversals').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_status).toBe('approved')
    expect(rows[0]!.to_status).toBe('review')
    expect(rows[0]!.prior_verdict).toBe('approved')
    expect(rows[0]!.reason).toBe('errant approval reversed on new evidence')
  })

  it('REFUSES an UPDATE — a reversal receipt cannot be rewritten after the fact', () => {
    insertRow()
    expect(() => {
      harness.sqlite
        .prepare("UPDATE verdict_reversals SET to_status = 'approved' WHERE id = ?")
        .run('reversal-1')
    }).toThrow(/append-only/)
    const rows = harness.sqlite.prepare('SELECT to_status FROM verdict_reversals').all() as Array<Record<string, unknown>>
    expect(rows[0]!.to_status).toBe('review')
  })

  it('REFUSES rewriting the reason — the justification is immutable', () => {
    insertRow()
    expect(() => {
      harness.sqlite
        .prepare("UPDATE verdict_reversals SET reason = 'something else' WHERE id = ?")
        .run('reversal-1')
    }).toThrow(/append-only/)
  })

  it('REFUSES a DELETE — a reversal cannot be erased from history', () => {
    insertRow()
    expect(() => {
      harness.sqlite.prepare('DELETE FROM verdict_reversals WHERE id = ?').run('reversal-1')
    }).toThrow(/append-only/)
    const rows = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM verdict_reversals').all() as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })

  it('REFUSES an empty or whitespace-only reason at the schema level', () => {
    const stmt = harness.sqlite.prepare(INSERT)
    expect(() => stmt.run('rev-blank', 'mumega', 'task-1', 'squad-1', 'approved', 'review', 'approved', '', 'member-1', 'member'))
      .toThrow(/CHECK/i)
    expect(() => stmt.run('rev-ws', 'mumega', 'task-1', 'squad-1', 'approved', 'review', 'approved', '   ', 'member-1', 'member'))
      .toThrow(/CHECK/i)
  })

  it('orders by seq, not created_at — monotonic ordering', () => {
    const stmt = harness.sqlite.prepare(INSERT)
    stmt.run('r1', 'mumega', 'task-1', 'squad-1', 'approved', 'review', 'approved', 'first reversal', 'member-1', 'member')
    stmt.run('r2', 'mumega', 'task-1', 'squad-1', 'rejected', 'review', 'rejected', 'second reversal', 'member-1', 'member')
    const rows = harness.sqlite
      .prepare('SELECT id, seq FROM verdict_reversals ORDER BY seq ASC')
      .all() as Array<{ id: string; seq: number }>
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(rows[1]!.seq).toBeGreaterThan(rows[0]!.seq)
  })
})
