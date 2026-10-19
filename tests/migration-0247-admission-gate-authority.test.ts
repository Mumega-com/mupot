// tests/migration-0247-admission-gate-authority.test.ts — 0247 adds agent_seat_admissions.gate_authority (opt-in, default 0).
// Pre-migration state: the whole chain strictly BEFORE 0247 with real populated admission / attachment rows, THEN 0247.
// Asserts rows, attachments, triggers and indexes survive untouched and legacy rows default to 0 (no gate authority).

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { migrationFiles } from './helpers/migrations'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const TARGET = '0247_admission_gate_authority.sql'
let h: SqliteD1Harness | undefined
afterEach(() => { h?.close(); h = undefined })

describe('0247 admission gate_authority', () => {
  it('preserves existing admissions/attachments/triggers/indexes; legacy rows default to gate_authority 0; gates stays frozen', () => {
    h = createSqliteD1()
    const files = migrationFiles()
    const idx = files.indexOf(TARGET)
    expect(idx).toBeGreaterThan(-1)
    for (const f of files.slice(0, idx)) h.sqlite.exec(readFileSync(join(DIR, f), 'utf8'))
    const before = (sql: string): unknown[] => h!.sqlite.prepare(sql).all()
    h.sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO agent_seat_admissions (id, tenant, agent_id, human_member_id, harness_id, status, ceiling, requested_via, created_at)
        VALUES ('adm-live', 't', 'a1', 'm1', 'h1', 'live', 'lead', 'tool', '2026-10-01'), ('adm-rev', 't', 'a1', 'm2', 'h1', 'revoked', 'member', 'tool', '2026-10-01');
      INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at)
        VALUES ('att1', 't', 's1', 'm1', 'h1', 'a1', 'adm-live', 'tk1', '2026-10-01');
      PRAGMA foreign_keys = ON;`)
    const rowsBefore = before(`SELECT id, status, gates, ceiling FROM agent_seat_admissions ORDER BY id`)
    const attsBefore = before(`SELECT * FROM agent_seat_attachments`)
    const schemaBefore = before(`SELECT type, name FROM sqlite_master WHERE tbl_name IN ('agent_seat_admissions','agent_seat_attachments') ORDER BY name`)

    h.sqlite.exec(readFileSync(join(DIR, TARGET), 'utf8'))

    expect(before(`SELECT id, status, gates, ceiling FROM agent_seat_admissions ORDER BY id`)).toEqual(rowsBefore)
    expect(before(`SELECT * FROM agent_seat_attachments`)).toEqual(attsBefore)
    expect(before(`SELECT id, gate_authority FROM agent_seat_admissions ORDER BY id`)).toEqual([{ id: 'adm-live', gate_authority: 0 }, { id: 'adm-rev', gate_authority: 0 }])
    const schemaAfter = before(`SELECT type, name FROM sqlite_master WHERE tbl_name IN ('agent_seat_admissions','agent_seat_attachments') ORDER BY name`)
    for (const e of schemaBefore) expect(schemaAfter).toContainEqual(e) // every prior trigger + index still there
    expect(schemaAfter).toContainEqual({ type: 'trigger', name: 'agent_seat_admissions_gate_authority_immutable' })
    // the legacy column is still frozen at 0 and the new bit is immutable once decided
    expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET gate_authority = 1 WHERE id = 'adm-live'`)).toThrow(/gate_authority_immutable/)
    expect(() => h!.sqlite.exec(`INSERT INTO agent_seat_admissions (id, tenant, agent_id, human_member_id, harness_id, status, gates, requested_via, created_at) VALUES ('x','t','a9','m9','h9','pending',1,'tool','2026-10-02')`)).toThrow()
  })
})
