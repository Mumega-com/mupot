// Upgrade data must survive removing the old coarse grant uniqueness rule.
// Historical schema comes from EVERY preceding migration; no production imports
// or hand-made schema. Target runs as one FK-enforced transaction, like D1.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationFiles } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { splitSqlStatements } from '../scripts/gen-schema-chain.mjs'

const directory = join(import.meta.dirname, '..', 'migrations')
const target = '0153_elevation_grants_partial_unique.sql'

function fixture() {
  const harness = createSqliteD1()
  const db = harness.sqlite
  for (const file of migrationFiles().filter((file) => file < target)) {
    db.exec(readFileSync(join(directory, file), 'utf8'))
  }
  db.exec(`
    INSERT INTO departments(id,slug,name) VALUES('dept','dept','Department');
    INSERT INTO squads(id,department_id,slug,name) VALUES('squad','dept','squad','Squad');
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES('agent','squad','agent','Agent','member','test','active');
    INSERT INTO members(id,tenant,display_name,status,created_at) VALUES('human','fixture','Human','active','2026-09-01T00:00:00Z');
    INSERT INTO members(id,tenant,display_name,status,created_at) VALUES('member','fixture','Agent','active','2026-09-01T00:00:00Z');
    INSERT INTO human_login_identities(id,tenant,provider,provider_subject,member_id,created_at)
      VALUES('identity','fixture','google','subject','human','2026-09-01T00:00:00Z');
    INSERT INTO web_sessions(id_hash,tenant,member_id,login_identity_id,idle_expires_at,absolute_expires_at)
      VALUES('web-fixture','fixture','human','identity','2099-01-01T00:00:00Z','2099-01-01T00:00:00Z');
  `)
  for (const state of ['live', 'expired', 'revoked', 'next']) {
    db.prepare(`INSERT INTO agent_sessions(id,tenant,agent_id,member_id,auth_kind,credential_id,idle_expires_at,absolute_expires_at)
      VALUES(?,'fixture','agent','member','workspace_token',?,'2099-01-01T00:00:00Z','2099-01-01T00:00:00Z')`).run(`session-${state}`, `credential-${state}`)
    db.prepare(`INSERT INTO elevation_requests(id,tenant,agent_session_id,agent_id,member_id,requested_actions_json,
      requested_scope_type,requested_duration_minutes,reason,status,created_at,decision_expires_at)
      VALUES(?,'fixture',?,'agent','member','["action:knowledge_write"]','org',60,'fixture','approved',
      '2026-09-01T00:00:00Z','2099-01-01T00:00:00Z')`).run(`request-${state}`, `session-${state}`)
    if (state === 'next') continue
    db.prepare(`INSERT INTO elevation_grants(id,tenant,elevation_request_id,agent_session_id,action,scope_type,effect,
      approved_by_member_id,approved_by_web_session_hash,created_at,expires_at,revoked_at,revoke_reason)
      VALUES(?,'fixture',?,?,'action:knowledge_write','org','irreversible','human','web-fixture','2026-09-01T00:00:00Z',?,?,?)`)
      .run(`grant-${state}`, `request-${state}`, `session-${state}`, state === 'expired' ? '2026-09-02T00:00:00Z' : '2099-01-01T00:00:00Z',
        state === 'revoked' ? '2026-09-03T00:00:00Z' : null, state === 'revoked' ? 'human revoked' : null)
    db.prepare(`INSERT INTO elevation_usage_log(id,tenant,elevation_grant_id,agent_session_id,action,tool_name,detail_json,occurred_at)
      VALUES(?,'fixture',?,?,'action:knowledge_write','verify_protected_action',?,'2026-09-01T00:05:00Z')`)
      .run(`usage-${state}`, `grant-${state}`, `session-${state}`, JSON.stringify({ state, proof: `receipt-${state}` }))
    db.prepare(`INSERT INTO elevation_action_bindings(id,tenant,elevation_request_id,action,principal,target_system,target_id,
      target_revision,expected_revision,payload_hash,destination,operation,expires_at,action_hash,created_at)
      VALUES(?,'fixture',?,'action:knowledge_write','agent','inkwell','18','kb:18:0','kb:18:0',?,'mirror:fixture','source_write',
      '2099-01-01T00:00:00Z',?,'2026-09-01T00:00:00Z')`)
      .run(`binding-${state}`, `request-${state}`, 'a'.repeat(64), 'b'.repeat(64))
  }
  return harness
}

function upgrade(db: ReturnType<typeof createSqliteD1>['sqlite']) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(readFileSync(join(directory, target), 'utf8'))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function snapshots(db: ReturnType<typeof createSqliteD1>['sqlite']) {
  return {
    grants: db.prepare('SELECT * FROM elevation_grants ORDER BY id').all(),
    usage: db.prepare('SELECT * FROM elevation_usage_log ORDER BY id').all(),
    bindings: db.prepare('SELECT * FROM elevation_action_bindings ORDER BY id').all(),
  }
}

describe('0153 data-preserving grant uniqueness upgrade', () => {
  it('keeps every record recoverable at each nontransactional schema-applier boundary', () => {
    const statements: string[] = splitSqlStatements(readFileSync(join(directory, target), 'utf8'), target)
    const { sqlite: db, close } = fixture()
    try {
      const before = snapshots(db)
      for (const statement of statements) {
        db.exec(statement)
        const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
        const retained = (tables: string[]) => tables.flatMap((table) => names.has(table)
          ? db.prepare(`SELECT * FROM ${table}`).all() : [])
        // Table names are fixed test-owned migration artifacts, never caller input.
        expect(retained(['elevation_grants', '_elevation_grants_rebuild_0153'])).toEqual(expect.arrayContaining(before.grants))
        expect(retained(['elevation_usage_log', '_elevation_usage_backup_0153'])).toEqual(expect.arrayContaining(before.usage))
      }
      expect(snapshots(db)).toEqual(before)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { close() }
  })
  it('retains every column of live, expired and revoked grants, audit records and action bindings', () => {
    const { sqlite: db, close } = fixture()
    try {
      const before = snapshots(db)
      expect(before.grants).toHaveLength(3)
      expect(before.usage).toHaveLength(3)
      upgrade(db)
      expect(snapshots(db)).toEqual(before)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { close() }
  })

  it('allows another exact request on the same session/action/scope after upgrade', () => {
    const { sqlite: db, close } = fixture()
    try {
      upgrade(db)
      db.exec(`INSERT INTO elevation_grants
        SELECT 'grant-next',tenant,'request-next',agent_session_id,action,scope_type,scope_id,effect,
          approved_by_member_id,approved_by_web_session_hash,created_at,expires_at,revoked_at,revoke_reason
        FROM elevation_grants WHERE id='grant-live'`)
      expect(db.prepare('SELECT id FROM elevation_grants ORDER BY id').all()).toHaveLength(4)
      expect(() => db.exec(`INSERT INTO elevation_grants
        SELECT 'grant-duplicate',tenant,elevation_request_id,agent_session_id,action,scope_type,scope_id,effect,
          approved_by_member_id,approved_by_web_session_hash,created_at,expires_at,revoked_at,revoke_reason
        FROM elevation_grants WHERE id='grant-next'`)).toThrow()
    } finally { close() }
  })

  it('rolls back without data loss when existing rows violate the new uniqueness rule', () => {
    const { sqlite: db, close } = fixture()
    try {
      db.exec(`INSERT INTO elevation_grants
        SELECT 'grant-inconsistent',tenant,elevation_request_id,agent_session_id,action,'squad','squad',effect,
          approved_by_member_id,approved_by_web_session_hash,created_at,expires_at,revoked_at,revoke_reason
        FROM elevation_grants WHERE id='grant-live'`)
      const before = snapshots(db)
      expect(() => upgrade(db)).toThrow()
      expect(snapshots(db)).toEqual(before)
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally { close() }
  })
})
