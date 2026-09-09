// tests/tasks-source-pot-assignment-rbac.test.ts — #406 fast-follow (Opus re-gate
// WARN-1 on #404): assignment of a source_pot (cross-pot, untrusted-origin) task
// must require a stronger principal than plain member+.
//
// tasksApp's own HTTP auth (requireAuth, src/auth/index.ts) is cookie-session-only
// and never populates AuthContext.memberId/capabilities — only a coarse org role
// (owner/admin/member) — so a memberId+capabilities principal (the shape needed to
// exercise the fine-grained member-vs-admin ladder) cannot be driven through
// tasksApp.fetch in a test harness today (pre-existing property of this route,
// unrelated to this fix). These tests exercise the exported RBAC primitive
// (canActOnSquad) directly against REAL SQLite so the #406 admin-floor logic is
// verified against the actual capability-resolution SQL, not a JS reimplementation
// of it — mirrors the "test real SQL, not a mock" lesson from prior gates. The
// currently-REACHABLE production path for #406 (a runtime-welded agent token,
// which does carry memberId+capabilities via the MCP bearer surface) is covered
// end-to-end in tests/mcp-task-tools.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canActOnSquad } from '../src/tasks'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-rbac'
const SQUAD_ID = 'squad-1'
const DEPT_ID = 'dept-1'
const MEMBER_ID = 'member-plain'
const ADMIN_MEMBER_ID = 'member-admin'

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    CREATE TABLE squads (id TEXT PRIMARY KEY, department_id TEXT NOT NULL);
    CREATE TABLE capabilities (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, scope_type TEXT NOT NULL,
      scope_id TEXT, capability TEXT NOT NULL
    );
    CREATE TABLE channel_capability_grants (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, squad_id TEXT NOT NULL, capability TEXT NOT NULL
    );
  `)
}

function memberAuth(memberId: string): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
  }
}

function ownerAuth(): AuthContext {
  return { userId: 'owner-1', email: null, role: 'owner', tenant: TENANT }
}

describe('canActOnSquad — #406 admin-floor for source_pot task assignment', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    createSchema(harness.sqlite)
    harness.sqlite.prepare('INSERT INTO squads (id, department_id) VALUES (?, ?)').run(SQUAD_ID, DEPT_ID)
    harness.sqlite.prepare(
      'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)',
    ).run('grant-member', MEMBER_ID, 'squad', SQUAD_ID, 'member')
    harness.sqlite.prepare(
      'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)',
    ).run('grant-admin', ADMIN_MEMBER_ID, 'squad', SQUAD_ID, 'admin')
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  })

  afterEach(() => harness.close())

  it('member+ min: a plain member-capability principal passes (unchanged local-task behavior)', async () => {
    expect(await canActOnSquad(env, memberAuth(MEMBER_ID), SQUAD_ID, 'member')).toBe(true)
  })

  it('admin+ min: a plain member-capability principal is REFUSED (the #406 fix)', async () => {
    expect(await canActOnSquad(env, memberAuth(MEMBER_ID), SQUAD_ID, 'admin')).toBe(false)
  })

  it('admin+ min: an admin-capability principal passes', async () => {
    expect(await canActOnSquad(env, memberAuth(ADMIN_MEMBER_ID), SQUAD_ID, 'admin')).toBe(true)
  })

  it('admin+ min: a web-login owner (no fine-grained capabilities) still bypasses', async () => {
    expect(await canActOnSquad(env, ownerAuth(), SQUAD_ID, 'admin')).toBe(true)
  })

  it('admin+ min: a memberId-less, non-owner/admin principal is refused', async () => {
    const auth: AuthContext = { userId: 'ghost', email: null, role: 'member', tenant: TENANT }
    expect(await canActOnSquad(env, auth, SQUAD_ID, 'admin')).toBe(false)
  })

  it('the default min (omitted) is still member — call-site compatibility for every pre-existing caller', async () => {
    expect(await canActOnSquad(env, memberAuth(MEMBER_ID), SQUAD_ID)).toBe(true)
  })
})
