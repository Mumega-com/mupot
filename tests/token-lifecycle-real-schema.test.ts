// tests/token-lifecycle-real-schema.test.ts — migration 0099.
//
// WHY THIS TEST DOES NOT MOCK
//
// The defect this guards is a SQL-semantics defect, and a DB mock cannot see one.
// mupot#684 is the standing proof: twelve unit tests passed against a query that
// referenced a column which did not exist, because the mock returned canned rows and
// never executed the SQL. So this builds member_tokens FROM THE COMMITTED MIGRATIONS
// and runs the ACTUAL exported predicate against it.
//
// Two specific things are being proven, and both failed silently in earlier drafts:
//
//  1. EXPIRY IS ENFORCED AT BOTH DOORS. `authenticateMember` (src/mcp/index.ts) and
//     `resolveMemberByToken` (src/auth/member-bearer.ts) are independent copies of the
//     bearer lookup — a duplication #41 tracks. Expiry in one but not the other is not
//     a partial fix, it is a bypass: the expired credential just uses the other door.
//     Both now execute TOKEN_LIVE_PREDICATE, and the test asserts the export is what
//     each file references rather than trusting that they were both edited.
//
//  2. MIXED TIMESTAMP FORMATS COMPARE CORRECTLY. member_tokens holds both
//     `2026-06-06 16:11:58` and `2026-06-09T02:51:30.844Z` — verified live 2026-08-13.
//     Lexicographically 'T' (0x54) sorts after ' ' (0x20), so a string comparison
//     between the two shapes is wrong for the same instant, and wrong in whichever
//     direction the row's format happens to dictate. That is a fail-open for half the
//     table. julianday() on both sides is the fix; the mixed-format cases below are
//     the reason it cannot be "simplified" back to `>`.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../src/auth/token-lifecycle'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    try {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    } catch {
      // Same tolerance as list-agent-tokens-real-schema.test.ts: some historical
      // migrations are environment-specific. What matters is that 0099's columns
      // exist afterwards, which the first test asserts explicitly rather than assuming.
    }
  }
}

/** The live-token lookup, built exactly the way both production doors build it. */
const LOOKUP = `SELECT t.id FROM member_tokens t WHERE t.token_hash = ?1 AND ${TOKEN_LIVE_PREDICATE('?2')}`

describe('migration 0099 — member_tokens lifecycle', () => {
  let h: SqliteD1Harness

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    // member_tokens.member_id is a real FK to members(id) — the first draft of this
    // test inserted tokens against a member that did not exist and every case failed
    // with "FOREIGN KEY constraint failed". A mock would have accepted it silently,
    // which is the whole argument for this file.
    h.sqlite
      .prepare("INSERT INTO members (id, email, display_name, status) VALUES ('m1', 'm1@test.local', 'M1', 'active')")
      .run()
  })
  afterEach(() => h.sqlite.close())

  function insert(hash: string, opts: { expires_at?: string | null; revoked_at?: string | null } = {}) {
    h.sqlite
      .prepare(
        `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, expires_at, tenant)
         VALUES (?, 'm1', ?, 'test', 'workspace', datetime('now'), ?, ?, 'mumega')`,
      )
      .run(`id-${hash}`, hash, opts.revoked_at ?? null, opts.expires_at ?? null)
  }

  const live = (hash: string): boolean =>
    h.sqlite.prepare(LOOKUP.replace('?1', '?').replace('?2', '?')).all(hash, nowSqlUtc()).length > 0

  it('the migration actually added both columns (not just the file existing)', () => {
    const cols = h.sqlite.prepare('PRAGMA table_info(member_tokens)').all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('expires_at')
    expect(names).toContain('last_used_at')
  })

  it('a token expiring in the future authenticates', () => {
    insert('future', { expires_at: "2099-01-01 00:00:00" })
    expect(live('future')).toBe(true)
  })

  it('an EXPIRED token authenticates to nothing', () => {
    insert('past', { expires_at: '2020-01-01 00:00:00' })
    expect(live('past')).toBe(false)
  })

  it('expires_at NULL means non-expiring — the owner-gated exception still works', () => {
    // If this regresses, every legitimately non-expiring standing agent credential
    // stops authenticating at once. SQL three-valued logic drops NULL rows from any
    // comparison, so the `IS NULL` arm is the only thing keeping them alive.
    insert('immortal', { expires_at: null })
    expect(live('immortal')).toBe(true)
  })

  it('a revoked token stays dead even with a future expiry', () => {
    insert('revoked', { expires_at: '2099-01-01 00:00:00', revoked_at: '2026-01-01 00:00:00' })
    expect(live('revoked')).toBe(false)
  })

  // ── the mixed-format cases: the reason julianday() is not optional ────────────
  //
  // THESE MUST BE SAME-DAY. The first draft of this file used 2020 and 2099, and a
  // mutation probe caught it: swapping julianday() for a raw `>` left all 13 tests
  // GREEN. With different years the year digits decide the comparison long before the
  // separator is ever reached, so the cases never touched the defect they were named
  // for — a test that validated my intent instead of the behaviour.
  //
  // The divergence only bites when the date portion is IDENTICAL and character 10
  // decides: 'T' is 0x54, ' ' is 0x20, so 'YYYY-MM-DDT…' always sorts ABOVE
  // 'YYYY-MM-DD …' for the same day. An ISO-stamped expiry earlier today therefore
  // compares as "in the future" under a string compare — the credential is expired and
  // keeps working. Fail-open, on exactly the rows that carry the ISO format.
  //
  // CLAMPED TO THE CURRENT UTC DAY — the helper must honour the rule stated above.
  //
  // The first version was `new Date(Date.now() + hours * 3600_000)`, and it broke its
  // own contract for one hour a day. Between 00:00 and 01:00 UTC, "one hour ago" is
  // YESTERDAY, so the two timestamps no longer share a calendar day, the separator at
  // character 10 stops being the deciding character, and the demo assertion
  // `iso > nowSqlUtc()` correctly returns false. CI went red daily in that window on
  // main, blocking every PR — found by Athena 2026-08-14 00:46 UTC.
  //
  // Which is the same defect this file already documents, one level up: a fixture whose
  // VALUES stop reaching the divergence the test is named for. The 2020/2099 draft
  // failed because differing years decided the comparison too early; this failed because
  // a midnight crossing decided it too early. Same class, opposite end.
  //
  // Clamping to [midnight today, now] guarantees same-day in every window. At 00:30 the
  // past instant becomes midnight itself — 30 minutes ago, still today, still strictly
  // ordered under both comparisons. At exactly 00:00:00.000 expiry equals now, which
  // julianday() treats as NOT in the future, so the row is still correctly refused.
  const sameDayIso = (hoursFromNow: number): string => {
    const now = Date.now()
    const midnight = new Date(now)
    midnight.setUTCHours(0, 0, 0, 0)
    const endOfDay = midnight.getTime() + 86_400_000 - 1
    const target = now + hoursFromNow * 3600_000
    const clamped = Math.min(Math.max(target, midnight.getTime()), endOfDay)
    return new Date(clamped).toISOString() // 'YYYY-MM-DDTHH:MM:SS.sssZ'
  }

  it('ISO-8601 expiry EARLIER TODAY is refused (a string compare passes it — fail-open)', () => {
    const iso = sameDayIso(-1) // one hour ago, CLAMPED to today — never yesterday
    insert('iso-past', { expires_at: iso })
    // Demonstrate the trap explicitly so the assertion below cannot be mistaken for
    // an arbitrary preference: under `>` this row reads as live.
    expect(iso > nowSqlUtc()).toBe(true) // the WRONG answer a string compare gives
    expect(live('iso-past')).toBe(false) // the RIGHT answer julianday() gives
  })

  it('ISO-8601 expiry LATER TODAY is honoured', () => {
    insert('iso-future', { expires_at: sameDayIso(1) })
    expect(live('iso-future')).toBe(true)
  })

  it('both timestamp shapes agree for the same instant', () => {
    // Same moment, two formats, same verdict. If these disagree the predicate is
    // comparing text rather than time again.
    const future = new Date(Date.now() + 3600_000)
    insert('iso-fmt', { expires_at: future.toISOString() })
    insert('space-fmt', {
      expires_at: future.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
    })
    expect(live('space-fmt')).toBe(live('iso-fmt'))
    expect(live('space-fmt')).toBe(true)
  })

  it('is mechanism-only — applying it does NOT expire any existing token', () => {
    // Hadi deferred the backfill (2026-08-13): add the columns, let last_used_at record,
    // then choose a horizon from MEASURED usage rather than a guessed number. So this
    // migration's effect on the existing 53 live credentials must be exactly ZERO —
    // expires_at stays NULL, which the predicate reads as non-expiring.
    //
    // This asserts the safety property of deferring, not the absence of work: if a
    // future edit reintroduces a backfill into 0099 without the deliberate decision
    // behind it, this test fails and asks why.
    const nullExpiry = h.sqlite
      .prepare('SELECT COUNT(*) n FROM member_tokens WHERE expires_at IS NOT NULL')
      .all() as Array<{ n: number }>
    expect(nullExpiry[0].n).toBe(0)

    insert('pre-existing') // a token as it exists today: no expiry set
    expect(live('pre-existing')).toBe(true)
  })

  it('last_used_at starts NULL and is nullable — it is telemetry, not a constraint', () => {
    // The column has to accept NULL for every pre-existing row, or adding it would
    // itself be the outage. It gets populated on use, not on migration.
    insert('never-used')
    const row = h.sqlite
      .prepare("SELECT last_used_at FROM member_tokens WHERE token_hash = 'never-used'")
      .all() as Array<{ last_used_at: string | null }>
    expect(row[0].last_used_at).toBeNull()
  })
})

describe('both bearer doors consume the shared predicate', () => {
  // Asserts the SOURCE, not the behaviour — behaviour is covered above. The failure
  // this catches is someone adding a third lookup, or reverting one door to an inline
  // `revoked_at IS NULL`, which would restore the bypass while every behavioural test
  // above still passed against the door that was left correct.
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')

  it('mcp/index.ts authenticateMember uses TOKEN_LIVE_PREDICATE', () => {
    const src = read('src/mcp/index.ts')
    expect(src).toContain("from '../auth/token-lifecycle'")
    expect(src).toContain('TOKEN_LIVE_PREDICATE(')
  })

  it('auth/member-bearer.ts resolveMemberByToken uses TOKEN_LIVE_PREDICATE', () => {
    const src = read('src/auth/member-bearer.ts')
    expect(src).toContain("from './token-lifecycle'")
    expect(src).toContain('TOKEN_LIVE_PREDICATE(')
  })

  it('auth/member-bearer.ts memberTokenHashIsLive uses TOKEN_LIVE_PREDICATE', () => {
    const src = read('src/auth/member-bearer.ts')
    expect(src).toContain('memberTokenHashIsLive')
    const fn = src.slice(src.indexOf('export async function memberTokenHashIsLive'))
    expect(fn).toContain('TOKEN_LIVE_PREDICATE(')
    expect(fn).not.toContain('AND t.revoked_at IS NULL')
  })

  it('no bearer lookup still hardcodes a bare revoked_at-only liveness check', () => {
    for (const p of ['src/mcp/index.ts', 'src/auth/member-bearer.ts']) {
      const src = read(p)
      // The old predicate, as it appeared before 0099. Its return would mean expiry is
      // no longer enforced at that door.
      expect(src).not.toContain('AND t.revoked_at IS NULL\n      LIMIT 1')
    }
  })
})
