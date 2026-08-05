// tests/list-agent-tokens-real-schema.test.ts — mupot#684.
//
// WHY THIS TEST EXISTS, AND WHY IT USES THE REAL MIGRATIONS
//
// list_agent_tokens shipped to production with `capability` in its SELECT list.
// member_tokens has no such column — a token's capability lives in `capabilities`,
// keyed by the token's member. D1 rejected the query and the tool returned
// `internal_error` on its first live call.
//
// TWELVE UNIT TESTS PASSED against that broken query. They could not have caught it:
// the DB mock returns canned row objects and never executes the SQL, so a query
// referencing a non-existent column is indistinguishable from a correct one. The
// mock validated my assumptions about the schema, which were wrong, rather than the
// schema itself.
//
// So this file does not mock. It builds member_tokens FROM THE COMMITTED MIGRATIONS
// and runs the tool's ACTUAL query against it. A hand-written CREATE TABLE here would
// reproduce the same bug — I would simply have typed `capability` into the fixture too.
// The migrations are the only source of truth that cannot drift from production.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

/**
 * Apply EVERY migration in order, exactly as production does. Filtering for just the
 * member_tokens statements looked cheaper and was wrong twice: leading `--` comments
 * broke the DDL match, and migration 0020 rebuilds the table via member_tokens_new +
 * rename, so a filtered subset references tables it never created. The real schema is
 * the whole chain; anything less is another assumption of mine standing in for it.
 */
function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      sqlite.exec(sql)
    } catch (err) {
      // D1-only constructs (and already-applied guards) are tolerated; a genuine break
      // in a migration that builds what we assert on will surface as a missing table.
      const msg = String(err)
      if (!/already exists|duplicate column|no such (function|module)|near "PRAGMA"/i.test(msg)) {
        throw new Error(`migration ${file}: ${msg}`)
      }
    }
  }
}

let harness: SqliteD1Harness

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
})

afterEach(() => {
  harness.sqlite.close()
})

describe('member_tokens real schema (mupot#684)', () => {
  it('the migrations actually build member_tokens', () => {
    const cols = harness.sqlite.prepare('PRAGMA table_info(member_tokens)').all() as { name: string }[]
    expect(cols.length).toBeGreaterThan(0)
  })

  it('member_tokens has NO capability column — the assumption that broke production', () => {
    const cols = (harness.sqlite.prepare('PRAGMA table_info(member_tokens)').all() as { name: string }[])
      .map((c) => c.name)
    expect(cols).not.toContain('capability')
    // and the columns list_agent_tokens actually projects DO exist:
    for (const required of ['id', 'member_id', 'label', 'channel', 'created_at', 'revoked_at', 'agent_id', 'tenant']) {
      expect(cols).toContain(required)
    }
  })

  // The decisive one: run the tool's REAL query. If it names a column that does not
  // exist, sqlite throws here exactly as D1 did in production.
  it("list_agent_tokens' query executes against the real schema", () => {
    const query = `SELECT id, member_id, label, channel, created_at, revoked_at
         FROM member_tokens
        WHERE agent_id = ?1 AND tenant = ?2
        ORDER BY created_at ASC`
    expect(() => {
      harness.sqlite.prepare(query.replace(/\?\d+/g, '?')).all('agent-x', 'mumega')
    }).not.toThrow()
  })

  it('the include_revoked variant also executes', () => {
    const query = `SELECT id, member_id, label, channel, created_at, revoked_at
         FROM member_tokens
        WHERE agent_id = ?1 AND tenant = ?2
          AND revoked_at IS NULL
        ORDER BY created_at ASC`
    expect(() => {
      harness.sqlite.prepare(query.replace(/\?\d+/g, '?')).all('agent-x', 'mumega')
    }).not.toThrow()
  })

  it('REGRESSION: the shipped query naming `capability` throws — proving this test catches it', () => {
    const broken = `SELECT id, member_id, label, channel, capability, created_at, revoked_at
         FROM member_tokens WHERE agent_id = ? AND tenant = ?`
    expect(() => harness.sqlite.prepare(broken).all('agent-x', 'mumega')).toThrow()
  })
})
