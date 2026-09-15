import { beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

// 0154 telegram_unbind_receipts — REAL SQL, not a hand-rolled fixture.
//
// mupot#1411 P1 round 5 (kasra-review adversarial addendum, 2026-09-15): this
// table's own migration comment claimed "append-only" citing 0091's
// oauth_consent_receipts precedent, but the trigger pair itself was missing
// until this round — an UPDATE forging actor_id, or an outright DELETE, both
// silently succeeded against the schema as it actually shipped. Same shape as
// agent_audit_no_update/_no_delete (0086), oauth_consent_receipts_no_update/
// _no_delete (0091), gate_owner_reassignments (0113): BEFORE UPDATE/DELETE
// triggers that RAISE(ABORT), so the guard cannot be lifted at the
// application layer. Asserted against the real migration chain, because a
// mocked DB would happily "accept" a write a real engine aborts.

const INSERT = `INSERT INTO telegram_unbind_receipts
  (id, tenant, member_id, actor_id, prior_telegram_chat_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`

const ROW = [
  'receipt-1', 'mumega', 'member-1', 'admin-1', '9500000', '2026-09-15T00:00:00.000Z',
] as const

describe('0154 telegram_unbind_receipts — append-only receipt', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant) VALUES ('member-1', 'Target', 'active', 'mumega');
    `)
  })

  function insertRow(): void {
    harness.sqlite.prepare(INSERT).run(...ROW)
  }

  it('accepts an insert', () => {
    insertRow()
    const rows = harness.sqlite.prepare('SELECT * FROM telegram_unbind_receipts').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor_id).toBe('admin-1')
    expect(rows[0]!.prior_telegram_chat_id).toBe('9500000')
  })

  it('REFUSES an UPDATE — actor_id cannot be forged after the fact', () => {
    insertRow()
    expect(() => {
      harness.sqlite
        .prepare("UPDATE telegram_unbind_receipts SET actor_id = 'FORGED' WHERE id = ?")
        .run('receipt-1')
    }).toThrow(/append-only/)
    const rows = harness.sqlite.prepare('SELECT actor_id FROM telegram_unbind_receipts').all() as Array<Record<string, unknown>>
    expect(rows[0]!.actor_id).toBe('admin-1')
  })

  it('REFUSES a DELETE — an unbind receipt cannot be made to have never happened', () => {
    insertRow()
    expect(() => {
      harness.sqlite.prepare('DELETE FROM telegram_unbind_receipts WHERE id = ?').run('receipt-1')
    }).toThrow(/append-only/)
    const rows = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM telegram_unbind_receipts').all() as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })
})
