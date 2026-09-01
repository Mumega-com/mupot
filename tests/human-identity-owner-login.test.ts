// tests/human-identity-owner-login.test.ts — mupot#1162 item 1.
//
// The org owner and the Google-login member must be the SAME principal when
// org_settings.owner_login_emails lists the verified email. Without that mapping,
// OAuth mints a zero-grant row and consent rule 3 fails. This does NOT lower
// canOnSquad('admin') and does NOT skip mint_agent_token (rule 2).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  findOrCreateHumanMember,
  resolveVerifiedHumanMemberId,
  OWNER_LOGIN_EMAILS_KEY,
} from '../src/members/human-identity'
import { canOnSquad, resolveCapabilities } from '../src/auth/capability'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const OWNER_ID = 'mem-hadi-owner'
const LOGIN = 'hadi@digid.ca'

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
}

function seedOwner(sqlite: SqliteD1Harness['sqlite'], email: string | null = null): void {
  const emailSql = email === null ? 'NULL' : `'${email}'`
  sqlite.exec(`
    INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('${OWNER_ID}', ${emailSql}, 'Hadi', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-org-owner', '${OWNER_ID}', 'org', NULL, 'owner');
  `)
}

function seedOwnerLoginEmails(sqlite: SqliteD1Harness['sqlite'], emails: string[]): void {
  sqlite.exec(`
    INSERT INTO org_settings (key, value, updated_at)
      VALUES ('${OWNER_LOGIN_EMAILS_KEY}', '${JSON.stringify(emails)}', '2026-09-01T00:00:00.000Z');
  `)
}

let harness: SqliteD1Harness

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
})

afterEach(() => {
  harness.close()
})

describe('resolveVerifiedHumanMemberId — owner login aliases (#1162)', () => {
  it('maps a listed login email onto the unique org owner, even when that row has no email', async () => {
    seedOwner(harness.sqlite, null)
    seedOwnerLoginEmails(harness.sqlite, [LOGIN])
    const env = envFor(harness)
    expect(await resolveVerifiedHumanMemberId(env, LOGIN)).toBe(OWNER_ID)
    expect(await resolveVerifiedHumanMemberId(env, 'HADI@digid.ca')).toBe(OWNER_ID)
  })

  it('does not steal owner identity when the email is not listed', async () => {
    seedOwner(harness.sqlite, null)
    const env = envFor(harness)
    expect(await resolveVerifiedHumanMemberId(env, LOGIN)).toBeNull()
  })

  it('fails closed when two org owners exist', async () => {
    seedOwner(harness.sqlite, null)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, created_at, tenant)
        VALUES ('mem-other-owner', NULL, 'Other', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-org-owner-2', 'mem-other-owner', 'org', NULL, 'owner');
    `)
    seedOwnerLoginEmails(harness.sqlite, [LOGIN])
    const env = envFor(harness)
    expect(await resolveVerifiedHumanMemberId(env, LOGIN)).toBeNull()
  })

  it('still prefers an exact members.email match over the alias', async () => {
    seedOwner(harness.sqlite, null)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, created_at, tenant)
        VALUES ('mem-login', '${LOGIN}', 'Login', 'active', '2026-08-01T00:00:00.000Z', '${TENANT}');
    `)
    seedOwnerLoginEmails(harness.sqlite, [LOGIN])
    const env = envFor(harness)
    expect(await resolveVerifiedHumanMemberId(env, LOGIN)).toBe('mem-login')
  })
})

describe('findOrCreateHumanMember', () => {
  it('does not mint a second member for a listed owner-login email', async () => {
    seedOwner(harness.sqlite, null)
    seedOwnerLoginEmails(harness.sqlite, [LOGIN])
    const env = envFor(harness)
    const id = await findOrCreateHumanMember(env, LOGIN, 'Hadi Servat')
    expect(id).toBe(OWNER_ID)
    const n = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }
    expect(Number(n.n)).toBe(1)
  })

  it('creates a new zero-grant member for an unknown email (today\'s split, fail closed)', async () => {
    seedOwner(harness.sqlite, null)
    const env = envFor(harness)
    const id = await findOrCreateHumanMember(env, 'stranger@example.test', 'Stranger')
    expect(id).not.toBe(OWNER_ID)
    const grants = await resolveCapabilities(env, id)
    expect(grants).toEqual([])
  })
})

describe('consent rule 3 via identity, not a lowered floor', () => {
  it('the owning member, resolved from the login email, holds admin-or-higher on a squad through org:owner', async () => {
    seedOwner(harness.sqlite, null)
    seedOwnerLoginEmails(harness.sqlite, [LOGIN])
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-mac', 'mac', 'Mac');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-hadi-mac', 'dept-mac', 'hadi-mac', 'hadi-mac');
    `)
    const env = envFor(harness)
    const memberId = await findOrCreateHumanMember(env, LOGIN, 'Hadi')
    const grants = await resolveCapabilities(env, memberId)
    expect(await canOnSquad(env, grants, 'squad-hadi-mac', 'admin')).toBe(true)
    expect(await canOnSquad(env, grants, 'squad-hadi-mac', 'owner')).toBe(true)
  })
})
