import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function applyMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function insertRequest(
  sqlite: SqliteD1Harness['sqlite'],
  options: {
    tenant?: string
    actorKind?: 'user' | 'member'
    actorId?: string
    requestId: string
    targetKey?: string
    status?: 'pending' | 'failed' | 'expired'
  },
): void {
  const status = options.status ?? 'pending'
  const finalizedAt = status === 'pending' ? null : '2026-07-24T12:00:00.000Z'
  sqlite.prepare(
    `INSERT INTO agent_connection_requests
      (tenant, actor_kind, actor_id, request_id, request_fingerprint, target_key,
       agent_mode, credential_action, status, error_code, created_at, updated_at,
       finalized_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'existing', 'add', ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.tenant ?? 'tenant-a',
    options.actorKind ?? 'user',
    options.actorId ?? 'owner-1',
    options.requestId,
    options.requestId.padEnd(64, 'a').slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
    options.targetKey ?? `agent:${options.requestId}`,
    status,
    status === 'pending' ? null : 'test_terminal',
    '2026-07-24T12:00:00.000Z',
    '2026-07-24T12:00:00.000Z',
    finalizedAt,
    '2026-07-25T12:00:00.000Z',
  )
}

describe('agent connection pending-request quota', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyMigrations(harness.sqlite)
  })

  afterEach(() => harness.close())

  it('allows three pending requests and refuses a fourth for one actor', () => {
    insertRequest(harness.sqlite, { requestId: 'a1' })
    insertRequest(harness.sqlite, { requestId: 'a2' })
    insertRequest(harness.sqlite, { requestId: 'a3' })

    expect(() => insertRequest(harness.sqlite, { requestId: 'a4' }))
      .toThrow(/agent_connection_pending_quota/)
  })

  it('scopes the quota to tenant, actor kind, and actor id', () => {
    for (const requestId of ['a1', 'a2', 'a3']) {
      insertRequest(harness.sqlite, { requestId })
    }

    expect(() => insertRequest(harness.sqlite, {
      actorId: 'owner-2',
      requestId: 'other-actor',
    })).not.toThrow()
    expect(() => insertRequest(harness.sqlite, {
      actorKind: 'member',
      requestId: 'other-kind',
    })).not.toThrow()
    expect(() => insertRequest(harness.sqlite, {
      tenant: 'tenant-b',
      requestId: 'other-tenant',
    })).not.toThrow()
  })

  it('does not count terminal requests against the pending quota', () => {
    insertRequest(harness.sqlite, { requestId: 'failed', status: 'failed' })
    insertRequest(harness.sqlite, { requestId: 'expired', status: 'expired' })
    insertRequest(harness.sqlite, { requestId: 'a1' })
    insertRequest(harness.sqlite, { requestId: 'a2' })
    insertRequest(harness.sqlite, { requestId: 'a3' })

    expect(() => insertRequest(harness.sqlite, { requestId: 'a4' }))
      .toThrow(/agent_connection_pending_quota/)
  })
})
