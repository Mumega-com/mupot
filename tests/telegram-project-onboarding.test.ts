import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const VALID_PAIRING_HASH = 'a'.repeat(64)
const VALID_REQUEST_DIGEST = 'b'.repeat(64)

describe('Telegram project onboarding schema', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  afterEach(() => {
    harness.close()
  })

  function createProjectAndSquad(): void {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name)
      VALUES ('department-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-1', 'department-1', 'telegram', 'Telegram');
      INSERT INTO projects (id, slug, name, status) VALUES
        ('project-1', 'telegram-onboarding', 'Telegram onboarding', 'active'),
        ('project-2', 'other-project', 'Other project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-1', 'squad-1', 'write');
    `)
  }

  function insertProjectInvite(id: string, pairingHash = VALID_PAIRING_HASH): void {
    harness.sqlite.prepare(`
      INSERT INTO invites (
        id, email, project_id, squad_id, pairing_hash, pairing_expires_at
      ) VALUES (?, ?, 'project-1', 'squad-1', ?, '2026-09-13T01:00:00Z')
    `).run(id, `${id}@example.com`, pairingHash)
  }

  it('adds project invite columns with project and squad foreign keys', () => {
    const columns = harness.sqlite
      .prepare(`SELECT name FROM pragma_table_info('invites')`)
      .all()
      .map((row) => row.name)

    expect(columns).toEqual(expect.arrayContaining([
      'project_id',
      'squad_id',
      'pairing_hash',
      'pairing_expires_at',
    ]))

    const foreignKeys = harness.sqlite
      .prepare(`SELECT "table", "from", "to" FROM pragma_foreign_key_list('invites')`)
      .all()
    expect(foreignKeys).toEqual(expect.arrayContaining([
      { table: 'projects', from: 'project_id', to: 'id' },
      { table: 'squads', from: 'squad_id', to: 'id' },
    ]))
  })

  it('requires project invite fields to be jointly null or non-null and nonblank on insert', () => {
    createProjectAndSquad()

    harness.sqlite.exec(`
      INSERT INTO invites (id, email) VALUES ('legacy-invite', 'legacy@example.com')
    `)
    expect(() => harness.sqlite.exec(`
      INSERT INTO invites (id, email, project_id)
      VALUES ('partial-invite', 'partial@example.com', 'project-1')
    `)).toThrow(/project invite fields/)
    expect(() => harness.sqlite.exec(`
      INSERT INTO invites (
        id, email, project_id, squad_id, pairing_hash, pairing_expires_at
      ) VALUES (
        'blank-invite', 'blank@example.com', 'project-1', 'squad-1',
        '${VALID_PAIRING_HASH}', '   '
      )
    `)).toThrow(/project invite fields/)

    insertProjectInvite('complete-invite')
    expect(harness.sqlite.prepare(`
      SELECT project_id, squad_id, pairing_hash, pairing_expires_at
      FROM invites WHERE id = 'complete-invite'
    `).get()).toEqual({
      project_id: 'project-1',
      squad_id: 'squad-1',
      pairing_hash: VALID_PAIRING_HASH,
      pairing_expires_at: '2026-09-13T01:00:00Z',
    })
  })

  it('enforces the project invite field set on update', () => {
    createProjectAndSquad()
    harness.sqlite.exec(`
      INSERT INTO invites (id, email) VALUES ('invite-update', 'update@example.com')
    `)

    expect(() => harness.sqlite.exec(`
      UPDATE invites SET project_id = 'project-1' WHERE id = 'invite-update'
    `)).toThrow(/project invite fields/)

    harness.sqlite.prepare(`
      UPDATE invites
      SET project_id = 'project-1', squad_id = 'squad-1', pairing_hash = ?,
          pairing_expires_at = '2026-09-13T01:00:00Z'
      WHERE id = 'invite-update'
    `).run(VALID_PAIRING_HASH)
    expect(harness.sqlite.prepare(`
      SELECT project_id, squad_id FROM invites WHERE id = 'invite-update'
    `).get()).toEqual({ project_id: 'project-1', squad_id: 'squad-1' })
  })

  it('rejects an invite insert whose existing project and squad have no access edge', () => {
    createProjectAndSquad()

    expect(() => harness.sqlite.prepare(`
      INSERT INTO invites (
        id, email, project_id, squad_id, pairing_hash, pairing_expires_at
      ) VALUES (
        'mismatched-insert', 'mismatched-insert@example.com', 'project-2', 'squad-1',
        ?, '2026-09-13T01:00:00Z'
      )
    `).run(VALID_PAIRING_HASH)).toThrow(/project invite project-squad mismatch/)
  })

  it('rejects an invite update to an existing project and squad with no access edge', () => {
    createProjectAndSquad()
    insertProjectInvite('mismatched-update')

    expect(() => harness.sqlite.exec(`
      UPDATE invites
      SET project_id = 'project-2'
      WHERE id = 'mismatched-update'
    `)).toThrow(/project invite project-squad mismatch/)
    expect(harness.sqlite.prepare(`
      SELECT project_id, squad_id FROM invites WHERE id = 'mismatched-update'
    `).get()).toEqual({ project_id: 'project-1', squad_id: 'squad-1' })
  })

  it('requires a project invite pairing hash to be a SHA-256 hex digest', () => {
    createProjectAndSquad()

    expect(() => insertProjectInvite('short-hash', 'a'.repeat(63)))
      .toThrow(/pairing hash/)
    expect(() => insertProjectInvite('non-hex-hash', 'g'.repeat(64)))
      .toThrow(/pairing hash/)
    expect(() => insertProjectInvite('uppercase-hash', 'ABCDEF'.repeat(10) + 'ABCD'))
      .not.toThrow()
  })

  it('records webhook receipts once per tenant and update id', () => {
    const insert = harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, request_digest, state, response_text, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    insert.run(
      'tenant-a',
      'update-1',
      VALID_REQUEST_DIGEST,
      'completed',
      'ok',
      '2026-09-13T00:00:00Z',
      '2026-09-13T00:00:01Z',
    )
    expect(() => insert.run(
      'tenant-a',
      'update-1',
      VALID_REQUEST_DIGEST,
      'processing',
      null,
      '2026-09-13T00:00:02Z',
      null,
    )).toThrow(/UNIQUE constraint failed/)
    expect(() => insert.run(
      'tenant-b',
      'update-1',
      VALID_REQUEST_DIGEST,
      'unknown',
      null,
      '2026-09-13T00:00:03Z',
      null,
    )).not.toThrow()

    expect(harness.sqlite.prepare(`
      SELECT tenant, update_id, response_text, completed_at
      FROM telegram_webhook_receipts ORDER BY tenant
    `).all()).toEqual([
      {
        tenant: 'tenant-a',
        update_id: 'update-1',
        response_text: 'ok',
        completed_at: '2026-09-13T00:00:01Z',
      },
      {
        tenant: 'tenant-b',
        update_id: 'update-1',
        response_text: null,
        completed_at: null,
      },
    ])
  })

  it('requires webhook request digests to be 64 hex characters', () => {
    const insert = harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, request_digest, state, created_at
      ) VALUES ('tenant-a', ?, ?, 'processing', '2026-09-13T00:00:00Z')
    `)

    expect(() => insert.run('short', 'a'.repeat(63))).toThrow(/CHECK constraint failed/)
    expect(() => insert.run('non-hex', 'z'.repeat(64))).toThrow(/CHECK constraint failed/)
    expect(() => insert.run('uppercase', 'ABCDEF'.repeat(10) + 'ABCD')).not.toThrow()
  })

  it.each(['processing', 'completed', 'unknown'])('accepts the %s webhook receipt state', (state) => {
    expect(() => harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, request_digest, state, created_at
      ) VALUES ('tenant-a', ?, ?, ?, '2026-09-13T00:00:00Z')
    `).run(`update-${state}`, VALID_REQUEST_DIGEST, state)).not.toThrow()
  })

  it('rejects webhook receipt states outside the durable state machine', () => {
    expect(() => harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (
        tenant, update_id, request_digest, state, created_at
      ) VALUES ('tenant-a', 'update-invalid', ?, 'failed', '2026-09-13T00:00:00Z')
    `).run(VALID_REQUEST_DIGEST)).toThrow(/CHECK constraint failed/)
  })
})
