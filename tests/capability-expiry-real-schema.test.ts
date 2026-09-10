// tests/capability-expiry-real-schema.test.ts — migration 0149.
//
// A STANDING CAPABILITY GRANT THAT ENDS ON ITS OWN.
//
// Until 0149 `capabilities` had no expiry. Every grant was permanent, and the
// only way to narrow one was for a human to remember to revoke it. That single
// fact is why "let this agent run its own squad" kept collapsing into "make it
// an admin", and why operator_principal_required pushes people toward browser
// sessions (mupot#1360): with no way to hand an agent BOUNDED authority, the
// only authority available was unbounded and belonged to a human.
//
// NO MOCKS — this is SQL semantics, which a DB mock cannot see (mupot#684).
// The table is built FROM THE COMMITTED MIGRATIONS and the ACTUAL exported
// resolveCapabilities runs against it.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  resolveCapabilities,
  hasCapability,
  CAPABILITY_LIVE_PREDICATE,
  sweepExpiredCapabilities,
} from '../src/auth/capability'
import type { Env } from '../src/types'

const TENANT = 'tenant-capexp'
const MEMBER = 'member-lead'
const SQUAD = 'squad-mcpwp'

describe('migration 0149 — capability grants may expire', () => {
  let h: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'eng', 'Engineering');
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('${SQUAD}', 'dept-1', 'mcpwp', 'MCPWP'),
        ('squad-two', 'dept-1', 'two', 'Two');
      INSERT INTO members (id, tenant, display_name, status, created_at)
      VALUES ('${MEMBER}', '${TENANT}', 'Lead', 'active', datetime('now'));
    `)
    env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => h.sqlite.close())

  function grant(id: string, capability: string, expiresAt: string | null, scopeId = SQUAD): void {
    h.sqlite
      .prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at)
         VALUES (?, '${MEMBER}', 'squad', ?, ?, ?)`,
      )
      .run(id, scopeId, capability, expiresAt)
  }

  /** An expiry earlier today in ISO shape — the format that fails OPEN under a
   *  string compare, so a "fix" using `>` cannot pass this file either. */
  function isoEarlierToday(): string {
    const now = Date.now()
    const midnight = new Date(now)
    midnight.setUTCHours(0, 0, 0, 0)
    return new Date(Math.min(Math.max(now - 3600_000, midnight.getTime()), now)).toISOString()
  }

  it('the migration added the column (not just the file existing)', () => {
    const cols = (h.sqlite.prepare('PRAGMA table_info(capabilities)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('expires_at')
  })

  it('MECHANISM ONLY — applying it expires nothing that already existed', async () => {
    // Every pre-0149 row is NULL. If the NULL arm regresses, every standing grant
    // in the pot stops resolving at once — a total authorization outage.
    const preExisting = h.sqlite
      .prepare('SELECT COUNT(*) n FROM capabilities WHERE expires_at IS NOT NULL')
      .all() as Array<{ n: number }>
    expect(preExisting[0].n).toBe(0)

    grant('cap-legacy', 'lead', null)
    expect(hasCapability(await resolveCapabilities(env, MEMBER), 'squad', SQUAD, 'lead')).toBe(true)
  })

  it('a grant expiring in the future still resolves', async () => {
    grant('cap-future', 'lead', '2099-01-01 00:00:00')
    expect(await resolveCapabilities(env, MEMBER)).toHaveLength(1)
  })

  it('an EXPIRED grant resolves to nothing — nobody revoked it', async () => {
    grant('cap-past', 'lead', '2020-01-01 00:00:00')
    const caps = await resolveCapabilities(env, MEMBER)
    expect(caps).toHaveLength(0)
    expect(hasCapability(caps, 'squad', SQUAD, 'lead')).toBe(false)
  })

  it('an ISO expiry earlier TODAY is refused (a string compare passes it — fail-open)', async () => {
    const iso = isoEarlierToday()
    grant('cap-iso', 'lead', iso)
    const nowSql = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
    expect(iso > nowSql).toBe(true) // the WRONG answer a text compare gives
    expect(await resolveCapabilities(env, MEMBER)).toHaveLength(0) // the RIGHT one
  })

  it('an expired grant does not shadow a live one for the same member', async () => {
    // An over-broad predicate that dropped the whole member would also pass a
    // test that only ever inserted one row.
    grant('cap-dead', 'admin', '2020-01-01 00:00:00')
    grant('cap-live', 'member', null, 'squad-two')
    const caps = await resolveCapabilities(env, MEMBER)
    expect(caps).toHaveLength(1)
    expect(caps[0]).toMatchObject({ scope_id: 'squad-two', capability: 'member' })
  })

  it('the predicate is the ONE exported fragment, with both load-bearing halves', () => {
    const p = CAPABILITY_LIVE_PREDICATE('c', '?2')
    expect(p).toContain('c.expires_at IS NULL') // non-expiring arm
    expect(p).toContain('julianday')            // not a text compare
  })

  it('the sweep REPORTS lapsed grants and does not delete them', async () => {
    grant('cap-lapsed', 'lead', '2020-01-01 00:00:00')
    const result = await sweepExpiredCapabilities(env)
    expect(result.expired).toHaveLength(1)
    expect(result.expired[0]).toMatchObject({ member_id: MEMBER, capability: 'lead' })

    // Still THERE — lapsed, not erased. "What was this agent allowed to do in
    // September" must stay answerable after the fact.
    const row = h.sqlite.prepare(`SELECT capability FROM capabilities WHERE id = 'cap-lapsed'`).all()
    expect(row).toHaveLength(1)
  })

  it('the sweep ignores non-expiring and still-live grants', async () => {
    grant('cap-forever', 'lead', null)
    grant('cap-later', 'member', '2099-01-01 00:00:00', 'squad-two')
    expect((await sweepExpiredCapabilities(env)).expired).toHaveLength(0)
  })
})
