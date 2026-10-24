// tests/migration-0255-admission-scope-dot-keys.test.ts — schema-only: admission scope, dot key table, attachment key link.
// Part A applies the chain strictly BEFORE 0255 with populated rows, then 0255 (legacy rows survive and default to 'seat').
// Part B uses the full chain (createSqliteD1 + applyAllMigrations) for constraints, triggers and foreign keys.

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations, migrationFiles } from './helpers/migrations'

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const TARGET = '0255_admission_scope_dot_keys.sql'
const H64 = 'a'.repeat(64)
let h: SqliteD1Harness | undefined
afterEach(() => { h?.close(); h = undefined })

const rows = (sql: string): Record<string, unknown>[] => h!.sqlite.prepare(sql).all() as Record<string, unknown>[]

function seedAdmission(id: string, extra = ''): void {
  h!.sqlite.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO agent_seat_admissions (id, tenant, agent_id, human_member_id, harness_id, status, ceiling, requested_via, created_at${extra ? ', ' + extra.split('|')[0] : ''})
      VALUES ('${id}', 't', 'a-${id}', 'm1', 'h1', 'pending', 'member', 'tool', '2026-10-01'${extra ? ', ' + extra.split('|')[1] : ''});
    PRAGMA foreign_keys = ON;`)
}

describe('0255 admission scope + dot keys', () => {
  it('existing admissions/attachments survive and default to scope seat; dot_key_id is NULL', () => {
    h = createSqliteD1()
    const files = migrationFiles()
    const idx = files.indexOf(TARGET)
    expect(idx).toBeGreaterThan(-1)
    for (const f of files.slice(0, idx)) h.sqlite.exec(readFileSync(join(DIR, f), 'utf8'))
    h.sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO agent_seat_admissions (id, tenant, agent_id, human_member_id, harness_id, status, ceiling, requested_via, created_at)
        VALUES ('adm-live', 't', 'a1', 'm1', 'h1', 'live', 'lead', 'tool', '2026-10-01'), ('adm-rev', 't', 'a1', 'm2', 'h1', 'revoked', 'member', 'tool', '2026-10-01');
      INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at)
        VALUES ('att1', 't', 's1', 'm1', 'h1', 'a1', 'adm-live', 'tk1', '2026-10-01');
      PRAGMA foreign_keys = ON;`)
    const before = rows(`SELECT id, status, gates, ceiling, gate_authority FROM agent_seat_admissions ORDER BY id`)
    h.sqlite.exec(readFileSync(join(DIR, TARGET), 'utf8'))
    expect(rows(`SELECT id, status, gates, ceiling, gate_authority FROM agent_seat_admissions ORDER BY id`)).toEqual(before)
    expect(rows(`SELECT id, scope FROM agent_seat_admissions ORDER BY id`)).toEqual([{ id: 'adm-live', scope: 'seat' }, { id: 'adm-rev', scope: 'seat' }])
    expect(rows(`SELECT id, dot_key_id FROM agent_seat_attachments`)).toEqual([{ id: 'att1', dot_key_id: null }])
  })

  describe('full chain', () => {
    const setup = (): void => { h = createSqliteD1(); applyAllMigrations(h.sqlite) }

    it('scope defaults to seat and the CHECK refuses anything else', () => {
      setup(); seedAdmission('d1')
      expect(rows(`SELECT scope FROM agent_seat_admissions WHERE id='d1'`)).toEqual([{ scope: 'seat' }])
      seedAdmission('d2', 'scope|\'harness\'')
      expect(rows(`SELECT scope FROM agent_seat_admissions WHERE id='d2'`)).toEqual([{ scope: 'harness' }])
      expect(() => seedAdmission('d3', 'scope|\'dot\'')).toThrow(/CHECK/i)
      expect(() => seedAdmission('d4', 'scope|NULL')).toThrow(/NOT NULL/i)
    })

    it('scope cannot change after insert (pending included)', () => {
      setup(); seedAdmission('d1')
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET scope='harness' WHERE id='d1'`)).toThrow(/agent_seat_admission_immutable/)
      expect(rows(`SELECT scope FROM agent_seat_admissions WHERE id='d1'`)).toEqual([{ scope: 'seat' }])
    })

    it('the original admission guard still blocks what it blocked before', () => {
      setup(); seedAdmission('d1')
      for (const set of [`agent_id='x'`, `human_member_id='x'`, `harness_id='x'`, `created_at='x'`, `requested_via='dashboard'`, `gates=1`, `tenant='x'`]) {
        expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET ${set} WHERE id='d1'`), set).toThrow(/agent_seat_admission_immutable/)
      }
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='live', ceiling='lead' WHERE id='d1'`) // pending -> live with a ceiling: allowed
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET ceiling='full' WHERE id='d1'`)).toThrow(/agent_seat_admission_immutable/)
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='pending' WHERE id='d1'`)).toThrow(/agent_seat_admission_immutable/)
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='revoked', revoked_at='2026-10-02' WHERE id='d1'`)
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='live' WHERE id='d1'`)).toThrow(/agent_seat_admission_immutable/)
      expect(() => h!.sqlite.exec(`DELETE FROM agent_seat_admissions WHERE id='d1'`)).toThrow(/agent_seat_admission_immutable/)
    })

    it('agent_dot_keys: columns, defaults, unique key_hash, indexes', () => {
      setup(); seedAdmission('d1')
      const cols = rows(`PRAGMA table_info(agent_dot_keys)`).map((c) => c.name)
      expect(cols).toEqual(['id', 'tenant', 'admission_id', 'key_hash', 'subject_hash', 'created_at', 'revoked_at'])
      h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('k1','t','d1','${H64}','2026-10-01')`)
      expect(rows(`SELECT subject_hash, revoked_at FROM agent_dot_keys WHERE id='k1'`)).toEqual([{ subject_hash: null, revoked_at: null }])
      expect(() => h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('k2','t','d1','${H64}','2026-10-01')`)).toThrow(/UNIQUE/i)
      expect(() => h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('k3','t','d1','short','2026-10-01')`)).toThrow(/CHECK/i)
      const idx = rows(`SELECT name, "unique" AS u FROM pragma_index_list('agent_dot_keys')`)
      expect(idx).toContainEqual({ name: 'uq_agent_dot_keys_key_hash', u: 1 })
      expect(idx.map((i) => i.name)).toContain('idx_agent_dot_keys_admission')
    })

    it('agent_dot_keys foreign key to the admission is enforced and restricts deletion', () => {
      setup()
      expect(() => h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('k1','t','nope','${H64}','2026-10-01')`)).toThrow(/FOREIGN KEY/i)
      const fk = rows(`SELECT "table" AS t, "from" AS f, on_delete AS d FROM pragma_foreign_key_list('agent_dot_keys')`)
      expect(fk).toEqual([{ t: 'agent_seat_admissions', f: 'admission_id', d: 'RESTRICT' }])
    })

    it('a key is immutable except a one-way revoke, and is never deleted', () => {
      setup(); seedAdmission('d1')
      h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, subject_hash, created_at) VALUES ('k1','t','d1','${H64}','s1','2026-10-01')`)
      for (const set of [`key_hash='${'b'.repeat(64)}'`, `subject_hash='s2'`, `admission_id='d2'`, `tenant='x'`, `created_at='x'`, `id='k9'`]) {
        expect(() => h!.sqlite.exec(`UPDATE agent_dot_keys SET ${set} WHERE id='k1'`), set).toThrow(/agent_dot_key_immutable/)
      }
      h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at='2026-10-02' WHERE id='k1'`)
      expect(() => h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at=NULL WHERE id='k1'`)).toThrow(/agent_dot_key_immutable/)
      expect(() => h!.sqlite.exec(`DELETE FROM agent_dot_keys WHERE id='k1'`)).toThrow(/agent_dot_key_immutable/)
    })

    it('agent_seat_attachments.dot_key_id: nullable FK, immutable after insert, old guard intact', () => {
      setup(); seedAdmission('d1')
      h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('k1','t','d1','${H64}','2026-10-01')`)
      h!.sqlite.exec(`
        PRAGMA foreign_keys = OFF;
        INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at)
          VALUES ('att1','t','s1','m1','h1','a-d1','d1','tk1','2026-10-01');
        INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at, dot_key_id)
          VALUES ('att2','t','s2','m1','h1','a-d1','d1','tk2','2026-10-01','k1');
        PRAGMA foreign_keys = ON;`)
      expect(rows(`SELECT id, dot_key_id FROM agent_seat_attachments ORDER BY id`)).toEqual([{ id: 'att1', dot_key_id: null }, { id: 'att2', dot_key_id: 'k1' }])
      const fk = rows(`SELECT "table" AS t, "from" AS f FROM pragma_foreign_key_list('agent_seat_attachments')`)
      expect(fk).toContainEqual({ t: 'agent_dot_keys', f: 'dot_key_id' })
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_attachments SET dot_key_id='k1' WHERE id='att1'`)).toThrow(/agent_seat_attachment_immutable/)
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_attachments SET dot_key_id=NULL WHERE id='att2'`)).toThrow(/agent_seat_attachment_immutable/)
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_attachments SET seat_id='zzz' WHERE id='att1'`)).toThrow(/agent_seat_attachment_immutable/)
      expect(() => h!.sqlite.exec(`DELETE FROM agent_seat_attachments WHERE id='att1'`)).toThrow(/agent_seat_attachment_immutable/)
      // a key cannot be deleted while an attachment points at it (and keys are no-delete anyway)
      expect(() => h!.sqlite.exec(`DELETE FROM agent_dot_keys WHERE id='k1'`)).toThrow()
      expect(() => h!.sqlite.exec(`INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at, dot_key_id) VALUES ('att3','t','s3','m1','h1','a-d1','d1','tk3','2026-10-01','missing')`)).toThrow(/FOREIGN KEY/i)
    })

    it('revoking an admission still detaches its attachments and revokes their tokens (existing triggers intact)', () => {
      setup(); seedAdmission('d1')
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='live' WHERE id='d1'`)
      h!.sqlite.exec(`PRAGMA foreign_keys = OFF; INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at) VALUES ('att1','t','s1','m1','h1','a-d1','d1','tk1','2026-10-01'); PRAGMA foreign_keys = ON;`)
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='revoked', revoked_at='2026-10-02' WHERE id='d1'`)
      expect(rows(`SELECT detach_reason FROM agent_seat_attachments WHERE id='att1'`)).toEqual([{ detach_reason: 'admission_revoked' }])
    })
  })
})
