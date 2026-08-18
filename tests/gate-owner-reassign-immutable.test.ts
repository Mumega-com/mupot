import { beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

// 0113_gate_owner_reassignments — REAL SQL, not the task-tool mock.
//
// The mock harness in mcp-task-tools.test.ts proves the write path fires with
// the right arguments. It cannot prove the receipt is actually immutable,
// because a mock that records SQL will happily "accept" an UPDATE that a real
// engine would abort. A receipt an operator can quietly edit is not a receipt,
// and that property only exists if the triggers exist — so it is asserted here
// against the migrations as they will really run.
//
// Same shape as agent_audit_no_update/_no_delete (0086) and
// oauth_consent_receipts_no_update/_no_delete (0091): BEFORE UPDATE/DELETE
// triggers that RAISE(ABORT), so the guard cannot be lifted at the application
// layer. Unlike agent_audit this table needs NO narrow allow-list: nothing ever
// backfills a column after insert, so the ban is total.

const INSERT = `INSERT INTO gate_owner_reassignments
  (id, tenant, task_id, squad_id, from_gate_owner, to_gate_owner, reason, actor_id, actor_type, task_status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const ROW = [
  'reassign-1', 'mumega', 'task-1', 'squad-1',
  'gate:agent-self-completion', 'gate:athena',
  'original holder retired', 'member-1', 'member', 'review',
] as const

describe('0113 gate_owner_reassignments — append-only receipt', () => {
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
    const rows = harness.sqlite.prepare('SELECT * FROM gate_owner_reassignments').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_gate_owner).toBe('gate:agent-self-completion')
    expect(rows[0]!.to_gate_owner).toBe('gate:athena')
    expect(rows[0]!.reason).toBe('original holder retired')
  })

  it('REFUSES an UPDATE — the from/to pair cannot be rewritten after the fact', () => {
    insertRow()
    expect(() => {
      harness.sqlite
        .prepare("UPDATE gate_owner_reassignments SET to_gate_owner = 'gate:someone-else' WHERE id = ?")
        .run('reassign-1')
    }).toThrow(/append-only/)
    const rows = harness.sqlite.prepare('SELECT to_gate_owner FROM gate_owner_reassignments').all() as Array<Record<string, unknown>>
    expect(rows[0]!.to_gate_owner).toBe('gate:athena')
  })

  it('REFUSES rewriting the reason — the stated justification is part of the record', () => {
    insertRow()
    expect(() => {
      harness.sqlite
        .prepare("UPDATE gate_owner_reassignments SET reason = 'something more flattering' WHERE id = ?")
        .run('reassign-1')
    }).toThrow(/append-only/)
  })

  it('REFUSES a DELETE — a reassignment cannot be made to have never happened', () => {
    insertRow()
    expect(() => {
      harness.sqlite.prepare('DELETE FROM gate_owner_reassignments WHERE id = ?').run('reassign-1')
    }).toThrow(/append-only/)
    const rows = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM gate_owner_reassignments').all() as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })

  it('REFUSES an empty or whitespace-only reason at the schema level', () => {
    // The application already refuses this with gate_owner_reason_required. The
    // CHECK is the second line: an application guard protects the one call site
    // it lives in, and this table is the audit trail for an authority change —
    // a blank-reason row must be impossible regardless of which writer produced it.
    const stmt = harness.sqlite.prepare(INSERT)
    expect(() => stmt.run('reassign-blank', 'mumega', 'task-1', 'squad-1', 'gate:a', 'gate:b', '', 'member-1', 'member', 'review'))
      .toThrow(/CHECK/i)
    expect(() => stmt.run('reassign-ws', 'mumega', 'task-1', 'squad-1', 'gate:a', 'gate:b', '   ', 'member-1', 'member', 'review'))
      .toThrow(/CHECK/i)
  })

  it('orders by seq, not created_at — two rows in the same millisecond must still have one order', () => {
    // agent_audit (0086) records this being caught before shipping: ordering an
    // audit chain by a timestamp makes it unreconstructable when two rows share
    // a millisecond, and "the prior entry" stops having one answer.
    const stmt = harness.sqlite.prepare(INSERT)
    stmt.run('r1', 'mumega', 'task-1', 'squad-1', 'gate:a', 'gate:b', 'first', 'member-1', 'member', 'review')
    stmt.run('r2', 'mumega', 'task-1', 'squad-1', 'gate:b', 'gate:c', 'second', 'member-1', 'member', 'review')
    const rows = harness.sqlite
      .prepare('SELECT id, seq FROM gate_owner_reassignments ORDER BY seq ASC')
      .all() as Array<{ id: string; seq: number }>
    expect(rows.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(rows[1]!.seq).toBeGreaterThan(rows[0]!.seq)
  })
})
