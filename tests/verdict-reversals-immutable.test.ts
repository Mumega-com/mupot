import { beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

// 0114_verdict_reversals — REAL SQL, mirroring 0113's own immutability test.
// The end-to-end test (verdict-reversal-e2e.test.ts) proves the write path
// fires correctly; it cannot prove the row is unwritable-after-the-fact, since
// nothing there attempts an UPDATE or DELETE. That property is asserted here
// against the migrations as they will really run.

const INSERT = `INSERT INTO verdict_reversals
  (id, tenant, task_id, squad_id, from_status, prior_decided_by, prior_note, reason, actor_id, actor_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const ROW = [
  'reversal-1', 'mumega', 'task-1', 'squad-1', 'approved',
  'agent-original', 'looks fine (the mistake)', 'evidence was contaminated', 'member-1', 'member',
] as const

describe('0114 verdict_reversals — append-only receipt', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  function insertRow(): void {
    harness.sqlite.prepare(INSERT).run(...ROW)
  }

  it('accepts an insert', () => {
    insertRow()
    const rows = harness.sqlite.prepare('SELECT * FROM verdict_reversals').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_status).toBe('approved')
    expect(rows[0]!.prior_note).toBe('looks fine (the mistake)')
  })

  it('REFUSES an UPDATE — the reason a wrong verdict was reversed cannot be rewritten afterward', () => {
    insertRow()
    expect(() => {
      harness.sqlite.prepare("UPDATE verdict_reversals SET reason = 'a nicer story' WHERE id = ?").run('reversal-1')
    }).toThrow(/append-only/)
    const row = harness.sqlite.prepare('SELECT reason FROM verdict_reversals WHERE id = ?').get('reversal-1') as { reason: string }
    expect(row.reason).toBe('evidence was contaminated')
  })

  it('REFUSES rewriting the preserved prior decision', () => {
    insertRow()
    expect(() => {
      harness.sqlite.prepare("UPDATE verdict_reversals SET prior_note = 'edited' WHERE id = ?").run('reversal-1')
    }).toThrow(/append-only/)
  })

  it('REFUSES a DELETE — a reversal cannot be made to have never happened', () => {
    insertRow()
    expect(() => {
      harness.sqlite.prepare('DELETE FROM verdict_reversals WHERE id = ?').run('reversal-1')
    }).toThrow(/append-only/)
    const count = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM verdict_reversals').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('REFUSES an empty or whitespace-only reason at the schema level, not just in the tool', () => {
    const stmt = harness.sqlite.prepare(INSERT)
    expect(() => stmt.run('r-blank', 'mumega', 'task-1', 'squad-1', 'approved', null, null, '', 'member-1', 'member'))
      .toThrow(/CHECK/i)
    expect(() => stmt.run('r-ws', 'mumega', 'task-1', 'squad-1', 'approved', null, null, '   ', 'member-1', 'member'))
      .toThrow(/CHECK/i)
  })

  it('REFUSES from_status outside approved/rejected — a review task has no verdict to reverse', () => {
    const stmt = harness.sqlite.prepare(INSERT)
    expect(() => stmt.run('r-bad', 'mumega', 'task-1', 'squad-1', 'review', null, null, 'because', 'member-1', 'member'))
      .toThrow(/CHECK/i)
  })

  it('a task with no prior verdict inserts with null prior fields, not a constraint failure', () => {
    const stmt = harness.sqlite.prepare(INSERT)
    expect(() => stmt.run('r-null', 'mumega', 'task-1', 'squad-1', 'rejected', null, null, 'legacy row', 'member-1', 'member'))
      .not.toThrow()
    const row = harness.sqlite.prepare('SELECT prior_decided_by, prior_note FROM verdict_reversals WHERE id = ?').get('r-null') as Record<string, unknown>
    expect(row.prior_decided_by).toBeNull()
    expect(row.prior_note).toBeNull()
  })

  it('orders by seq, not created_at — same lesson 0086 and 0113 already learned', () => {
    const stmt = harness.sqlite.prepare(INSERT)
    stmt.run('r1', 'mumega', 'task-1', 'squad-1', 'approved', 'a', 'x', 'first', 'member-1', 'member')
    stmt.run('r2', 'mumega', 'task-1', 'squad-1', 'rejected', 'b', 'y', 'second', 'member-1', 'member')
    const rows = harness.sqlite.prepare('SELECT id FROM verdict_reversals ORDER BY seq ASC').all() as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2'])
  })
})
