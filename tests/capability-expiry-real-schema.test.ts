// tests/capability-expiry-real-schema.test.ts — migration 0149.
//
// A standing capability grant that ENDS ON ITS OWN.
//
// Until 0149 every row in `capabilities` was permanent, and the only way to
// narrow one was for a human to remember to revoke it. That single fact is why
// "let this agent stand up its own squad" kept collapsing into "make it an
// admin": there was no shape in the schema for a grant that is both REAL (the
// agent acts alone, no approval per action) and BOUNDED (it stops without
// anyone doing anything).
//
// Session elevation (0148) answers a different question — a human approves each
// request, and it dies with the agent session. Right for a one-off privileged
// act; wrong for "this agent leads this squad until the quarter ends", because
// it puts a human in the loop every single time.
//
// NO MOCKS. This is a SQL-semantics guard, and a DB mock cannot see one (see
// tests/token-lifecycle-real-schema.test.ts's header, and mupot#684 behind it).
// The table is built FROM THE COMMITTED MIGRATIONS and the ACTUAL exported
// resolveCapabilities runs against it.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { resolveCapabilities, hasCapability, CAPABILITY_LIVE_PREDICATE } from '../src/auth/capability'
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
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'mcpwp', 'MCPWP');
      INSERT INTO members (id, tenant, display_name, status, created_at)
      VALUES ('${MEMBER}', '${TENANT}', 'Lead', 'active', datetime('now'));
    `)
    env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => h.sqlite.close())

  function grant(id: string, capability: string, expiresAt: string | null): void {
    h.sqlite
      .prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at)
         VALUES (?, '${MEMBER}', 'squad', '${SQUAD}', ?, ?)`,
      )
      .run(id, capability, expiresAt)
  }

  /** An expiry earlier today in ISO shape — the format that fails OPEN under a
   *  string compare, so a "fix" using `>` cannot pass this file either. */
  function isoEarlierToday(): string {
    const now = Date.now()
    const midnight = new Date(now)
    midnight.setUTCHours(0, 0, 0, 0)
    return new Date(Math.min(Math.max(now - 3600_000, midnight.getTime()), now)).toISOString()
  }

  it('the migration actually added the column (not just the file existing)', () => {
    const cols = (h.sqlite.prepare('PRAGMA table_info(capabilities)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('expires_at')
  })

  it('MECHANISM ONLY — applying it expires nothing that already existed', async () => {
    // Every pre-0149 row is NULL, which the predicate reads as non-expiring. If
    // this regresses, every standing grant in the pot stops resolving at once.
    const preExisting = h.sqlite
      .prepare('SELECT COUNT(*) n FROM capabilities WHERE expires_at IS NOT NULL')
      .all() as Array<{ n: number }>
    expect(preExisting[0].n).toBe(0)

    grant('cap-legacy', 'lead', null)
    const caps = await resolveCapabilities(env, MEMBER)
    expect(caps).toHaveLength(1)
    expect(hasCapability(caps, 'squad', SQUAD, 'lead')).toBe(true)
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
    // Demonstrate the trap so the assertion cannot read as arbitrary taste:
    // under `>` this row compares as live.
    const nowSql = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
    expect(iso > nowSql).toBe(true)              // the WRONG answer a text compare gives
    expect(await resolveCapabilities(env, MEMBER)).toHaveLength(0) // the RIGHT one
  })

  it('an expired grant does not shadow a live one for the same member', async () => {
    // Two rows, different scopes, one dead. The live one must survive — an
    // over-broad predicate that dropped the whole member would also pass a test
    // that only ever inserted one row.
    h.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-two', 'dept-1', 'two', 'Two')`)
    grant('cap-dead', 'admin', '2020-01-01 00:00:00')
    h.sqlite
      .prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at)
         VALUES ('cap-live', '${MEMBER}', 'squad', 'squad-two', 'member', NULL)`,
      )
      .run()
    const caps = await resolveCapabilities(env, MEMBER)
    expect(caps).toHaveLength(1)
    expect(caps[0]).toMatchObject({ scope_id: 'squad-two', capability: 'member' })
  })

  it('the predicate is the ONE exported fragment, not a transcription', () => {
    // Same discipline as TOKEN_LIVE_PREDICATE: if this is pasted into a second
    // place, the paste is the bug. Assert the export is what capability.ts runs.
    expect(CAPABILITY_LIVE_PREDICATE('?2')).toContain('expires_at IS NULL')
    expect(CAPABILITY_LIVE_PREDICATE('?2')).toContain('julianday')
  })
})

describe('THE GOAL, without a human in the loop', () => {
  // The scenario, with the human's involvement reduced to ONE act performed
  // BEFORE any of it: writing a bounded grant. Nothing approves anything while
  // the lead works, and nothing revokes anything when it is done.
  let h: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'eng', 'Engineering');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'mcpwp', 'MCPWP');
      INSERT INTO members (id, tenant, display_name, status, created_at)
      VALUES ('${MEMBER}', '${TENANT}', 'Lead', 'active', datetime('now'));
    `)
    env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  })
  afterEach(() => h.sqlite.close())

  it('a grant given ONCE, bounded, carries the lead through and then lapses', async () => {
    // The human's entire involvement: one row, with an end date. No approval
    // flow, no session binding, no second visit.
    const untilTomorrow = new Date(Date.now() + 24 * 3600_000).toISOString()
    h.sqlite
      .prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at)
         VALUES ('cap-granted-once', '${MEMBER}', 'squad', '${SQUAD}', 'lead', ?)`,
      )
      .run(untilTomorrow)

    // While it is live the lead holds real authority on its OWN squad…
    const live = await resolveCapabilities(env, MEMBER)
    expect(hasCapability(live, 'squad', SQUAD, 'lead')).toBe(true)
    // …and nothing beyond it.
    expect(hasCapability(live, 'org', null, 'admin')).toBe(false)
    expect(hasCapability(live, 'squad', SQUAD, 'admin')).toBe(false)

    // Now let the grant lapse. NOBODY ACTS — the row is simply rewritten to a
    // past horizon to stand in for the clock moving, which is the only thing
    // that happens in production either.
    h.sqlite
      .prepare(`UPDATE capabilities SET expires_at = '2020-01-01 00:00:00' WHERE id = 'cap-granted-once'`)
      .run()

    const after = await resolveCapabilities(env, MEMBER)
    expect(after).toHaveLength(0)
    expect(hasCapability(after, 'squad', SQUAD, 'lead')).toBe(false)

    // And the row is still THERE — lapsed, not deleted, so the grant remains
    // auditable after the fact. An expiry that erased its own evidence would
    // make "what was this agent allowed to do in September" unanswerable.
    const row = h.sqlite
      .prepare(`SELECT capability, expires_at FROM capabilities WHERE id = 'cap-granted-once'`)
      .all() as Array<{ capability: string; expires_at: string }>
    expect(row).toHaveLength(1)
    expect(row[0].capability).toBe('lead')
  })
})
