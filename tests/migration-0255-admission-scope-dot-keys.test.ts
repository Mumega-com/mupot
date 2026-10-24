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

    const T0 = '2026-10-01T00:00:00.000Z'
    const T1 = '2026-10-02T00:00:00.000Z'
    const key = (id: string, hash: string, adm = 'd1', extra = ''): string =>
      `INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at${extra ? ', ' + extra.split('|')[0] : ''}) VALUES ('${id}','t','${adm}','${hash}','${T0}'${extra ? ', ' + extra.split('|')[1] : ''})`
    const attach = (id: string, seat: string, adm = 'd1', dot = 'NULL'): string =>
      `PRAGMA foreign_keys = OFF; INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at, dot_key_id) VALUES ('${id}','t','${seat}','m1','h1','a-${adm}','${adm}','tk-${id}','${T0}',${dot}); PRAGMA foreign_keys = ON;`
    const live = (id: string): void => { seedAdmission(id); h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='live' WHERE id='${id}'`) }

    it('agent_dot_keys: columns, defaults, unique key_hash, indexes', () => {
      setup(); seedAdmission('d1')
      const cols = rows(`PRAGMA table_info(agent_dot_keys)`).map((c) => c.name)
      expect(cols).toEqual(['id', 'tenant', 'admission_id', 'key_hash', 'subject_hash', 'created_at', 'revoked_at'])
      h!.sqlite.exec(key('k1', H64))
      expect(rows(`SELECT subject_hash, revoked_at FROM agent_dot_keys WHERE id='k1'`)).toEqual([{ subject_hash: null, revoked_at: null }])
      expect(() => h!.sqlite.exec(key('k2', H64))).toThrow(/agent_dot_key_immutable/)
      const idx = rows(`SELECT name, "unique" AS u FROM pragma_index_list('agent_dot_keys')`)
      expect(idx).toContainEqual({ name: 'uq_agent_dot_keys_key_hash', u: 1 })
      expect(idx.map((i) => i.name)).toContain('idx_agent_dot_keys_admission')
    })

    it('key_hash / subject_hash shape: 64 lowercase hex text only (short, long, upper, non-hex, raw 64-char key, BLOB, number)', () => {
      setup(); seedAdmission('d1')
      const bad: string[] = ['short', `X'${'61'.repeat(64)}'`, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ('a'.repeat(63) + '-'), 'mdot_' + 'a'.repeat(59), `X'${'ab'.repeat(32)}'`]
      for (const [i, v] of bad.entries()) {
        const lit = v.startsWith("X'") ? v : `'${v}'`
        expect(() => h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('b${i}','t','d1',${lit},'${T0}')`), v).toThrow(/CHECK/i)
      }
      expect(() => h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('n1','t','d1',${'1'.repeat(64)},'${T0}')`)).toThrow() // integer overflow literal -> not text
      for (const [i, v] of ['short', 'A'.repeat(64), 'z'.repeat(64), `X'${'ab'.repeat(32)}'`].entries()) {
        const lit = v.startsWith("X'") ? v : `'${v}'`
        expect(() => h!.sqlite.exec(key(`s${i}`, 'c'.repeat(63) + String(i), 'd1', `subject_hash|${lit}`)), v).toThrow(/CHECK/i)
      }
      h!.sqlite.exec(key('ok1', 'd'.repeat(64), 'd1', `subject_hash|'${'e'.repeat(64)}'`))
      expect(rows(`SELECT subject_hash FROM agent_dot_keys WHERE id='ok1'`)).toEqual([{ subject_hash: 'e'.repeat(64) }])
    })

    it('created_at / revoked_at shape: ISO timestamp text; empty, short and non-date strings refused', () => {
      setup(); seedAdmission('d1')
      let n = 0
      for (const bad of ['', '2026-10-01', '2026-10-01T', '2026-10-01T00:00:0', 'yesterday at noon!!!!!!', 'x'.repeat(24)]) {
        n++
        expect(() => h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('c${n}','t','d1','${String(n).repeat(64).slice(0, 64)}','${bad}')`), bad).toThrow(/CHECK/i)
        expect(() => h!.sqlite.exec(key(`r${n}`, 'f'.repeat(60) + String(1000 + n), 'd1', `revoked_at|'${bad}'`)), bad).toThrow(/CHECK/i)
      }
      expect(() => h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('c9','t','d1','${'9'.repeat(64)}',NULL)`)).toThrow(/NOT NULL/i)
      h!.sqlite.exec(key('k1', H64))
      for (const bad of ['', '2026-10-02', '2026-10-02T', 'x'.repeat(24)]) expect(() => h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at='${bad}' WHERE id='k1'`), bad).toThrow(/CHECK/i)
      h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at='${T1}' WHERE id='k1'`)
    })

    it('agent_dot_keys foreign key to the admission is RESTRICT; an unknown / closed / cross-tenant admission is refused', () => {
      setup()
      expect(() => h!.sqlite.exec(key('k1', H64, 'nope'))).toThrow(/agent_dot_key_admission_invalid/)
      const fk = rows(`SELECT "table" AS t, "from" AS f, on_delete AS d FROM pragma_foreign_key_list('agent_dot_keys')`)
      expect(fk).toEqual([{ t: 'agent_seat_admissions', f: 'admission_id', d: 'RESTRICT' }])
      seedAdmission('d1'); live('d0')
      expect(() => h!.sqlite.exec(key('kx', 'a'.repeat(64), 'nope'))).toThrow(/agent_dot_key_admission_invalid|FOREIGN KEY/) // unknown id while other open admissions exist
      expect(() => h!.sqlite.exec(`INSERT INTO agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('k1','other','d1','${H64}','${T0}')`)).toThrow(/agent_dot_key_admission_invalid/)
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='denied' WHERE id='d1'`)
      expect(() => h!.sqlite.exec(key('k2', 'b'.repeat(64)))).toThrow(/agent_dot_key_admission_invalid/)
      seedAdmission('d2'); h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='expired' WHERE id='d2'`)
      expect(() => h!.sqlite.exec(key('k3', 'c'.repeat(64), 'd2'))).toThrow(/agent_dot_key_admission_invalid/)
      seedAdmission('d3'); h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='live' WHERE id='d3'`)
      h!.sqlite.exec(key('k4', 'd'.repeat(64), 'd3')) // live: allowed (pending was allowed above in the first tests)
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='revoked', revoked_at='${T1}' WHERE id='d3'`)
      expect(() => h!.sqlite.exec(key('k5', 'e'.repeat(64), 'd3'))).toThrow(/agent_dot_key_admission_invalid/)
    })

    it('a key is immutable except a one-way revoke, and is never deleted', () => {
      setup(); seedAdmission('d1')
      h!.sqlite.exec(key('k1', H64, 'd1', `subject_hash|'${'5'.repeat(64)}'`))
      for (const set of [`key_hash='${'b'.repeat(64)}'`, `subject_hash='${'6'.repeat(64)}'`, `subject_hash=NULL`, `admission_id='d2'`, `tenant='x'`, `created_at='${T1}'`, `id='k9'`]) {
        expect(() => h!.sqlite.exec(`UPDATE agent_dot_keys SET ${set} WHERE id='k1'`), set).toThrow(/agent_dot_key_immutable/)
      }
      h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at='${T1}' WHERE id='k1'`)
      expect(() => h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at=NULL WHERE id='k1'`)).toThrow(/agent_dot_key_immutable/)
      expect(() => h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at='2026-11-01T00:00:00.000Z' WHERE id='k1'`)).toThrow(/agent_dot_key_immutable/)
      expect(() => h!.sqlite.exec(`DELETE FROM agent_dot_keys WHERE id='k1'`)).toThrow(/agent_dot_key_immutable/)
    })

    it('REPLACE cannot un-revoke or overwrite a key (same id, same key_hash) nor replace an admission', () => {
      setup(); live('d1')
      h!.sqlite.exec(key('k1', H64))
      h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at='${T1}' WHERE id='k1'`)
      for (const verb of ['INSERT OR REPLACE INTO', 'REPLACE INTO']) {
        expect(() => h!.sqlite.exec(`${verb} agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('k1','t','d1','${'7'.repeat(64)}','${T0}')`), verb + ' same id').toThrow(/agent_dot_key_immutable/)
        expect(() => h!.sqlite.exec(`${verb} agent_dot_keys (id, tenant, admission_id, key_hash, created_at) VALUES ('k2','t','d1','${H64}','${T0}')`), verb + ' same hash').toThrow(/agent_dot_key_immutable/)
        expect(() => h!.sqlite.exec(`${verb} agent_seat_admissions (id, tenant, agent_id, human_member_id, harness_id, status, ceiling, requested_via, created_at) VALUES ('d1','t','a-x','m9','h9','live','full','tool','${T0}')`), verb + ' admission').toThrow(/agent_seat_admission_immutable/)
      }
      expect(rows(`SELECT id, key_hash, revoked_at FROM agent_dot_keys`)).toEqual([{ id: 'k1', key_hash: H64, revoked_at: T1 }])
      expect(rows(`SELECT id, status, ceiling, scope FROM agent_seat_admissions`)).toEqual([{ id: 'd1', status: 'live', ceiling: 'member', scope: 'seat' }])
    })

    it('revoking an admission revokes its keys (any previous revoked_at shape); other admissions keep theirs', () => {
      setup(); live('d1'); live('d2')
      h!.sqlite.exec(key('k1', H64)); h!.sqlite.exec(key('k2', 'b'.repeat(64))); h!.sqlite.exec(key('k3', 'c'.repeat(64), 'd2'))
      h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at='${T0}' WHERE id='k2'`) // already revoked earlier: its stamp is kept
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='revoked', revoked_at='' WHERE id='d1'`) // empty stamp falls back to now
      const r = rows(`SELECT id, revoked_at FROM agent_dot_keys ORDER BY id`)
      expect(r[0].revoked_at).toMatch(/^\d{4}-\d\d-\d\dT/)
      expect(r[1]).toEqual({ id: 'k2', revoked_at: T0 })
      expect(r[2]).toEqual({ id: 'k3', revoked_at: null })
      live('d4'); h!.sqlite.exec(key('k4', 'd'.repeat(64), 'd4'))
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='revoked', revoked_at='${T1}' WHERE id='d4'`)
      expect(rows(`SELECT revoked_at FROM agent_dot_keys WHERE id='k4'`)).toEqual([{ revoked_at: T1 }])
    })

    it('attachment dot_key_id: nullable FK; must be an unrevoked key of the SAME admission and tenant; immutable after insert', () => {
      setup(); live('d1'); live('d2')
      h!.sqlite.exec(key('k1', H64)); h!.sqlite.exec(key('k2', 'b'.repeat(64), 'd2'))
      h!.sqlite.exec(attach('att1', 's1'))
      h!.sqlite.exec(attach('att2', 's2', 'd1', `'k1'`))
      expect(rows(`SELECT id, dot_key_id FROM agent_seat_attachments ORDER BY id`)).toEqual([{ id: 'att1', dot_key_id: null }, { id: 'att2', dot_key_id: 'k1' }])
      expect(rows(`SELECT "table" AS t, "from" AS f FROM pragma_foreign_key_list('agent_seat_attachments')`)).toContainEqual({ t: 'agent_dot_keys', f: 'dot_key_id' })
      expect(() => h!.sqlite.exec(attach('att3', 's3', 'd1', `'missing'`))).toThrow(/agent_seat_attachment_dot_key_invalid/)
      expect(() => h!.sqlite.exec(attach('att4', 's4', 'd1', `'k2'`))).toThrow(/agent_seat_attachment_dot_key_invalid/) // another admission's key
      expect(() => h!.sqlite.exec(attach('att4t', 's4t', 'd1', `'k1'`).replace("VALUES ('att4t','t'", "VALUES ('att4t','other'"))).toThrow(/agent_seat_attachment_dot_key_invalid/) // other tenant
      h!.sqlite.exec(`UPDATE agent_dot_keys SET revoked_at='${T1}' WHERE id='k1'`)
      expect(() => h!.sqlite.exec(attach('att5', 's5', 'd1', `'k1'`))).toThrow(/agent_seat_attachment_dot_key_invalid/) // revoked key
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_attachments SET dot_key_id='k2' WHERE id='att1'`)).toThrow(/agent_seat_attachment_(dot_key_invalid|immutable)/)
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_attachments SET dot_key_id='k1' WHERE id='att2'`)).toThrow(/agent_seat_attachment_dot_key_invalid/) // same value, key now revoked
      h!.sqlite.exec(key('k6', '6'.repeat(64)))
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_attachments SET dot_key_id='k6' WHERE id='att1'`)).toThrow(/agent_seat_attachment_immutable/)
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_attachments SET dot_key_id=NULL WHERE id='att2'`)).toThrow(/agent_seat_attachment_immutable/)
      // a revoked key does not block detaching the attachment that carries it (detach semantics unchanged)
      h!.sqlite.exec(`UPDATE agent_seat_attachments SET detached_at='${T1}', detach_reason='human' WHERE id='att2'`)
      expect(rows(`SELECT detach_reason FROM agent_seat_attachments WHERE id='att2'`)).toEqual([{ detach_reason: 'human' }])
      expect(() => h!.sqlite.exec(`DELETE FROM agent_dot_keys WHERE id='k6'`)).toThrow()
    })

    it('every guarded column of agent_seat_admissions_immutable refuses an UPDATE, one by one', () => {
      setup(); seedAdmission('p1'); live('l1')
      const cols: Array<[string, string]> = [['id', `'z'`], ['tenant', `'z'`], ['agent_id', `'z'`], ['human_member_id', `'z'`], ['harness_id', `'z'`],
        ['created_at', `'z'`], ['requested_via', `'dashboard'`], ['gates', '1'], ['scope', `'harness'`]]
      for (const [c, v] of cols) {
        expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET ${c}=${v} WHERE id='p1'`), `pending ${c}`).toThrow(/agent_seat_admission_immutable/)
        expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET ${c}=${v} WHERE id='l1'`), `live ${c}`).toThrow(/agent_seat_admission_immutable/)
      }
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET ceiling='full' WHERE id='l1'`)).toThrow(/agent_seat_admission_immutable/)
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET ceiling='lead' WHERE id='p1'`) // pending may still pick its ceiling
      for (const st of ['pending', 'denied', 'expired']) expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='${st}' WHERE id='l1'`), `live->${st}`).toThrow(/agent_seat_admission_immutable/)
      for (const closed of ['denied', 'expired', 'revoked']) {
        seedAdmission(`c-${closed}`); h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='${closed}' WHERE id='c-${closed}'`)
        for (const st of ['live', 'pending']) expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='${st}' WHERE id='c-${closed}'`), `${closed}->${st}`).toThrow(/agent_seat_admission_immutable/)
        expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET revoked_at='${T1}' WHERE id='c-${closed}'`), `${closed} other column`).toThrow(/agent_seat_admission_immutable/)
      }
    })

    it('every guarded column of agent_seat_attachments_immutable refuses an UPDATE, one by one (live and detached rows)', () => {
      setup(); live('d1')
      h!.sqlite.exec(attach('a1', 's1')); h!.sqlite.exec(attach('a2', 's2'))
      h!.sqlite.exec(`UPDATE agent_seat_attachments SET detached_at='${T1}', detach_reason='human', detached_by_member_id='m1' WHERE id='a2'`)
      for (const [c, v] of [['id', `'z'`], ['tenant', `'z'`], ['seat_id', `'z'`], ['human_member_id', `'z'`], ['harness_id', `'z'`], ['agent_id', `'z'`],
        ['admission_id', `'z'`], ['seat_token_id', `'z'`], ['created_at', `'z'`], ['dot_key_id', `'z'`]]) {
        for (const id of ['a1', 'a2']) expect(() => h!.sqlite.exec(`UPDATE agent_seat_attachments SET ${c}=${v} WHERE id='${id}'`), `${id} ${c}`).toThrow(/agent_seat_attachment_(immutable|dot_key_invalid)/)
      }
      for (const [c, v] of [['detached_at', `'2026-12-01T00:00:00.000Z'`], ['detach_reason', `'moved'`], ['detached_by_member_id', `'m2'`]]) {
        expect(() => h!.sqlite.exec(`UPDATE agent_seat_attachments SET ${c}=${v} WHERE id='a2'`), c).toThrow(/agent_seat_attachment_immutable/)
      }
      expect(() => h!.sqlite.exec(`DELETE FROM agent_seat_attachments WHERE id='a1'`)).toThrow(/agent_seat_attachment_immutable/)
      h!.sqlite.exec(`UPDATE agent_seat_attachments SET last_used_at='${T1}' WHERE id='a1'`) // not guarded
    })

    it('the original admission guard still blocks what it blocked before; full lifecycle', () => {
      setup(); seedAdmission('d1')
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='live', ceiling='lead' WHERE id='d1'`)
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='revoked', revoked_at='${T1}' WHERE id='d1'`)
      expect(() => h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='live' WHERE id='d1'`)).toThrow(/agent_seat_admission_immutable/)
      expect(() => h!.sqlite.exec(`DELETE FROM agent_seat_admissions WHERE id='d1'`)).toThrow(/agent_seat_admission_immutable/)
    })

    it('revoking an admission still detaches its attachments and revokes their tokens (existing triggers intact)', () => {
      setup(); live('d1')
      h!.sqlite.exec(attach('att1', 's1'))
      h!.sqlite.exec(`UPDATE agent_seat_admissions SET status='revoked', revoked_at='${T1}' WHERE id='d1'`)
      expect(rows(`SELECT detach_reason FROM agent_seat_attachments WHERE id='att1'`)).toEqual([{ detach_reason: 'admission_revoked' }])
    })
  })
})
