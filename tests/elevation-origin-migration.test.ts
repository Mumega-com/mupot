// tests/elevation-origin-migration.test.ts — migration 0210 rebuilds elevation_grants (the
// approver anchor becomes web-session XOR origin-receipt) while elevation_usage_log holds a
// live FK to it. Applied the way D1 applies a file: ONE transaction, foreign keys ENFORCED,
// against a database that already holds a grant and a usage row. Mutation-proved: without the
// `PRAGMA defer_foreign_keys` line the same file fails, so the line is load-bearing.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const DIR = join(import.meta.dirname, '..', 'migrations')
const TARGET = readdirSync(DIR).find((f) => f.includes('elevation_origin_decisions'))
if (!TARGET) throw new Error('0210 elevation_origin_decisions migration not found')

function dbBeforeTarget(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.sql')).sort()) {
    if (f === TARGET) break
    db.exec(readFileSync(join(DIR, f), 'utf8'))
  }
  return db
}

function seed(db: DatabaseSync): void {
  db.exec(`
    BEGIN;
    INSERT INTO departments (id, slug, name) VALUES ('d1','d','D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s1','d1','s','S');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('a1','s1','a','A','member','t','active');
    INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES ('m1','t','m1@x.test','m1','active',datetime('now'));
    INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES ('m2','t','m2@x.test','m2','active',datetime('now'));
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES ('hli','t','google','x','m2@x.test','m2',datetime('now'));
    INSERT INTO web_sessions (id_hash, tenant, member_id, login_identity_id, idle_expires_at, absolute_expires_at) VALUES ('ws1','t','m2','hli','2099-01-01','2099-01-01');
    INSERT INTO agent_sessions (id, tenant, agent_id, member_id, auth_kind, credential_id, idle_expires_at, absolute_expires_at) VALUES ('as1','t','a1','m1','workspace_token','c1','2099-01-01','2099-01-01');
    INSERT INTO elevation_requests (id, tenant, agent_session_id, agent_id, member_id, requested_actions_json, requested_scope_type, requested_scope_id, requested_duration_minutes, reason, status, created_at, decision_expires_at)
      VALUES ('r1','t','as1','a1','m1','["action:project_status"]','squad','s1',60,'why','approved','2026-01-01T00:00:00Z','2026-01-01T00:10:00Z');
    INSERT INTO elevation_grants (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect, approved_by_member_id, approved_by_web_session_hash, created_at, expires_at)
      VALUES ('g1','t','r1','as1','action:project_status','squad','s1','reversible','m2','ws1','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z');
    INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, occurred_at) VALUES ('u1','t','g1','as1','action:project_status','2026-01-01T00:01:00Z');
    COMMIT;
  `)
}

const asOneTx = (db: DatabaseSync, sql: string): void => db.exec(`BEGIN;\n${sql}\nCOMMIT;`)

describe('migration 0210 on a populated database, as one D1 transaction with FKs enforced', () => {
  it('preserves the grant + its usage row, backfills approved_via, and enforces the XOR anchor', () => {
    const db = dbBeforeTarget()
    seed(db)
    asOneTx(db, readFileSync(join(DIR, TARGET), 'utf8'))
    expect(db.prepare(`SELECT approved_via v, approved_by_web_session_hash h, origin_receipt_id r FROM elevation_grants WHERE id='g1'`).get()).toEqual({ v: 'web_session', h: 'ws1', r: null })
    expect(db.prepare(`SELECT COUNT(*) n FROM elevation_usage_log WHERE elevation_grant_id='g1'`).get()).toEqual({ n: 1 })
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
    const ins = (via: string, hash: string | null, receipt: string | null): void => {
      db.prepare(`INSERT INTO elevation_grants (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect, approved_by_member_id, approved_by_web_session_hash, created_at, expires_at, approved_via, origin_receipt_id)
        VALUES (?, 't', 'r1', 'as1', ?, 'squad', 's1', 'reversible', 'm2', ?, 'x', 'y', ?, ?)`).run(`g-${via}-${hash}-${receipt}`, `action:${via}-${hash}-${receipt}`, hash, via, receipt)
    }
    expect(() => ins('web_session', null, null)).toThrow(/CHECK/)            // web needs a hash
    expect(() => ins('agent_attested_origin', 'ws1', null)).toThrow(/CHECK/) // origin must not carry a hash, needs a receipt
    expect(() => ins('agent_attested_origin', null, null)).toThrow(/CHECK/)
    expect(() => ins('web_session', 'ws1', 'rc')).toThrow(/CHECK/)           // web must not carry a receipt
  })

  it('MUTATION: without `PRAGMA defer_foreign_keys` the same rebuild fails on a populated DB', () => {
    const db = dbBeforeTarget()
    seed(db)
    const mutated = readFileSync(join(DIR, TARGET), 'utf8').replace(/^PRAGMA defer_foreign_keys = ON;$/m, '')
    expect(mutated).not.toContain('PRAGMA defer_foreign_keys')
    expect(() => asOneTx(db, mutated)).toThrow(/FOREIGN KEY/i)
  })
})
