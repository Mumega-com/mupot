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
import { createHash } from 'node:crypto'
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

describe('every bearer door consumes the shared predicate', () => {
  // Asserts the SOURCE, not the behaviour — behaviour is covered above (and, for the
  // oauth-authorize doors, in tests/mcp-bearer-expiry-outcome.test.ts).
  //
  // THIS SECTION FAILED AT ITS OWN JOB ONCE. It was written to catch "someone adding a
  // third lookup", but the check below iterated a HARDCODED two-element file list, so a
  // third and fourth lookup — resolveExternalToken and buildAuthContextFromProps, both
  // in src/mcp/oauth-authorize.ts, both on the POST /mcp path — were added with a bare
  // revoked_at check and could never have failed it. Expired credentials authenticated
  // in production for the whole time this file was green.
  //
  // So the enumeration is now DERIVED FROM THE SOURCE TREE rather than typed out: every
  // single-row member_tokens lookup that exists must consume the shared predicate. A
  // fifth door added tomorrow is in scope automatically, which is the only version of
  // this guard that actually holds.
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

  it('mcp/oauth-authorize.ts resolveExternalToken uses TOKEN_LIVE_PREDICATE', () => {
    const src = read('src/mcp/oauth-authorize.ts')
    expect(src).toContain("from '../auth/token-lifecycle'")
    const fn = src.slice(src.indexOf('async function resolveExternalTokenInner'))
    expect(fn.slice(0, 2000)).toContain('TOKEN_LIVE_PREDICATE(')
  })

  it('mcp/oauth-authorize.ts buildAuthContextFromProps uses TOKEN_LIVE_PREDICATE', () => {
    const src = read('src/mcp/oauth-authorize.ts')
    const fn = src.slice(src.indexOf('async function buildAuthContextFromPropsInner'))
    expect(fn.slice(0, 2000)).toContain('TOKEN_LIVE_PREDICATE(')
  })

  // ── the derived enumeration ───────────────────────────────────────────────────
  //
  // Walks src/ and extracts EVERY string containing a SELECT over member_tokens --
  // template literals and quoted strings alike, since mupot writes SQL in both. Each
  // must consume the shared predicate, or be exempted BY QUERY FINGERPRINT below.
  //
  // TWO EARLIER VERSIONS OF THIS GUARD FAILED, AND BOTH FAILURES SHAPE IT:
  //
  //  1. It iterated a hardcoded two-file list, so the two oauth-authorize doors could
  //     never fail it. That is what let expired credentials authenticate.
  //
  //  2. Its replacement derived the file list but matched only backtick literals
  //     containing the exact text `LIMIT 1`, and exempted whole FILES. An adversarial
  //     pass drove three real shapes straight through it: a single-row lookup with no
  //     LIMIT clause at all (D1's .first() needs none -- and one exists, at
  //     src/tasks/runtime-receipts.ts), `LIMIT  1` with two spaces, and SQL written as
  //     a quoted string. It then appended a genuine revoked_at-only bearer lookup to an
  //     exempt FILE and the suite stayed green. A file is not the unit of authority; a
  //     query is. Exempting by filename re-created, one level up, exactly the defect
  //     this file exists to prevent.
  //
  // Hence: no LIMIT heuristic, all quote forms, and exemptions pinned to the
  // normalized text of one specific query. Change that query by a character and its
  // fingerprint changes and it must be re-justified.
  const SRC_DIR = join(__dirname, '..', 'src')

  function tsFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...tsFiles(full))
      else if (entry.name.endsWith('.ts') && !entry.name.includes('schema-chain')) out.push(full)
    }
    return out
  }

  /** Every string literal in a source file, in any of TypeScript's three quote forms. */
  function stringLiterals(src: string): string[] {
    const re = /`([^`\\]*(?:\\[\s\S][^`\\]*)*)`|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"/g
    const out: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '')
    return out
  }

  /** Whitespace-normalized SHA-256 prefix — stable across reindentation, not across
   *  a change to the query's actual columns, table, or predicate. */
  function fingerprint(sql: string): string {
    return createHash('sha256').update(sql.split(/\s+/).filter(Boolean).join(' ')).digest('hex').slice(0, 12)
  }

  // Queries that read member_tokens WITHOUT granting anything, and must therefore be
  // able to see a non-live row. Pinned to the query, not the file.
  const NON_AUTH_QUERIES: ReadonlyArray<{ fingerprint: string; why: string }> = [
    { fingerprint: 'dd4c5c20f09a', why: 'control-center: aggregate of member/channel pairs for an operator view. Grants nothing.' },
    { fingerprint: '426f3c16d874', why: 'dashboard: DISTINCT member/channel listing. Grants nothing.' },
    { fingerprint: '87a0ace21487', why: 'keys page: lists a tenant preset-labelled keys. Display only.' },
    { fingerprint: '021f1001e123', why: 'label read for seat naming (agents/inbox-seat.ts and mcp/index.ts share this query). Runs on an ALREADY authenticated session and only narrows it; it cannot grant.' },
    { fingerprint: '5531526a4ea7', why: 'list_agent_tokens — inventory. Must show expired rows or they become unlistable.' },
    { fingerprint: 'bc19cd43e6b7', why: 'revoke_agent_token ownership lookup — SELECTs revoked_at for the caller to judge. Revoking an already-expired token must stay possible. Also selects channel, so the revoke can retire the agent_sessions row keyed to the same credential; still grants nothing.' },
    { fingerprint: '55c5b8ae2ab0', why: 'agent-connection status read — returns revoked_at for display. Grants nothing.' },
    { fingerprint: 'c5f8c11a05f4', why: 'credential REPLACE target. Reached only after authorize() has required admin on the home squad; the new credential a grants come from the request and are ceilinged against the ACTOR, never inherited from this row. Replacing an expired token is legitimate recovery.' },
    { fingerprint: '768c3883fe85', why: 'members service: token inventory listing. Display only.' },
    { fingerprint: '213bb53402c3', why: 'the expiry SWEEP itself (token-lifecycle.ts) — it exists to find tokens BY their expiry, so the live-only predicate would make it return nothing.' },
  ]

  it('EVERY SELECT over member_tokens in src/ consumes the shared predicate or is fingerprint-exempt', () => {
    const offenders: string[] = []
    const exempt = new Map(NON_AUTH_QUERIES.map((e) => [e.fingerprint, e.why]))
    const seen = new Set<string>()
    let inspected = 0
    for (const file of tsFiles(SRC_DIR)) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('member_tokens')) continue
      for (const literal of stringLiterals(src)) {
        if (!/FROM\s+member_tokens/i.test(literal)) continue
        if (!/^\s*SELECT/i.test(literal.trim())) continue
        inspected += 1
        const usesShared =
          literal.includes('TOKEN_LIVE_PREDICATE(') || /\$\{\w*[lL]ivePredicate\(/.test(literal)
        if (usesShared) continue
        const fp = fingerprint(literal)
        seen.add(fp)
        if (!exempt.has(fp)) {
          offenders.push(`${file.slice(file.indexOf('src/'))} [${fp}]: ${literal.trim().slice(0, 90)}…`)
        }
      }
    }
    // Anti-vacuity: a walker that matched nothing would be green for the worst reason.
    expect(inspected).toBeGreaterThanOrEqual(20)
    expect(offenders).toEqual([])
  })

  it('the exemption list has no dead entries — a stale fingerprint hides a real regression', () => {
    // If a query is edited, its fingerprint changes: the new text correctly becomes an
    // offender, but the OLD entry lingers and would silently re-exempt that exact text
    // if it ever came back. Fail on the leftover so exemptions stay a live inventory.
    const present = new Set<string>()
    for (const file of tsFiles(SRC_DIR)) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('member_tokens')) continue
      for (const literal of stringLiterals(src)) {
        if (!/FROM\s+member_tokens/i.test(literal)) continue
        if (!/^\s*SELECT/i.test(literal.trim())) continue
        present.add(fingerprint(literal))
      }
    }
    const dead = NON_AUTH_QUERIES.filter((e) => !present.has(e.fingerprint)).map((e) => e.fingerprint)
    expect(dead).toEqual([])
  })
})
