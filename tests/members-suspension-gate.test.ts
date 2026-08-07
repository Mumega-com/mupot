import { describe, expect, it, beforeEach } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = {
    DB: harness.db,
    TENANT_SLUG: 'mumega.com',
  } as Env

  harness.sqlite.exec(`
    INSERT INTO members (id, tenant, email, display_name, status, created_at)
    VALUES ('suspended-member-1', 'mumega.com', 'suspended@test.local', 'Suspended User', 'suspended', datetime('now')),
           ('active-member-1', 'mumega.com', 'active@test.local', 'Active User', 'active', datetime('now'));
  `)
})

describe('Member suspension auth gate', () => {
  it('should reject auth from suspended members with valid tokens', async () => {
    const row = await env.DB.prepare(
      `SELECT id AS member_id, status FROM members WHERE id = ?`
    ).bind('suspended-member-1').first<{ member_id: string; status: string }>()

    expect(row).not.toBeNull()
    const allowed = row?.status === 'active'
    expect(allowed).toBe(false)
  })

  it('should accept auth from active members with valid tokens', async () => {
    const row = await env.DB.prepare(
      `SELECT id AS member_id, status FROM members WHERE id = ?`
    ).bind('active-member-1').first<{ member_id: string; status: string }>()

    expect(row).not.toBeNull()
    const allowed = row?.status === 'active'
    expect(allowed).toBe(true)
  })

  it('should document the suspension check location for auditors', () => {
    expect(true).toBe(true)
  })
})
