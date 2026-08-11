// #919 — tests for the strict-batch detector itself.
//
// The detector exists because this harness was MORE transactional than the platform it
// stands for: batch() runs BEGIN IMMEDIATE + sequential execute + COMMIT, and real SQLite
// reads its own writes inside a transaction. Production D1 does not — a statement in a
// batch sees the pre-batch snapshot. That gap certified mupot#916 as correct for the life
// of the feature, and an audit found 24 of 46 batch sites carrying the same defect.
//
// The detector is now itself test infrastructure, so it gets the same treatment it exists
// to enforce: it is tested, not trusted.
import { describe, expect, it } from 'vitest'

import { createSqliteD1, tablesRead, tablesWritten } from './helpers/sqlite-d1'

describe('#919 strict-batch SQL inspection', () => {
  it('names the table each statement writes', () => {
    expect(tablesWritten("UPDATE flights SET status='landed' WHERE id=?1")).toEqual(['flights'])
    expect(tablesWritten('INSERT INTO flight_event_outbox (id) VALUES (?1)')).toEqual(['flight_event_outbox'])
    expect(tablesWritten('INSERT OR IGNORE INTO squads (id) VALUES (?1)')).toEqual(['squads'])
    expect(tablesWritten('DELETE FROM agents WHERE id=?1')).toEqual(['agents'])
    expect(tablesWritten('SELECT 1 FROM flights')).toEqual([])
  })

  it('names the tables each statement reads, including subqueries and INSERT...SELECT', () => {
    expect(tablesRead('INSERT INTO outbox (id) SELECT id FROM flights WHERE tenant=?1')).toContain('flights')
    expect(tablesRead('UPDATE routine_runs SET cost = (SELECT SUM(c) FROM flights f)')).toContain('flights')
    expect(tablesRead('SELECT a.id FROM tasks a JOIN agents b ON b.id = a.assignee')).toEqual(['tasks', 'agents'])
  })

  it('does NOT count a statement own write target as a read', () => {
    // Otherwise every UPDATE would trip the detector against itself.
    expect(tablesRead("UPDATE flights SET status='landed' WHERE id=?1")).not.toContain('flights')
    expect(tablesRead('INSERT INTO outbox (id, tenant) VALUES (?1, ?2)')).not.toContain('outbox')
    expect(tablesRead('DELETE FROM agents WHERE id=?1')).not.toContain('agents')
  })

  it('ignores json_each — it is a table-valued function, not a table', () => {
    // landGovernedFlight reads json_each(flights.meta); treating that as a table read would
    // be a false positive on the very site that motivated this work.
    expect(tablesRead("SELECT 1 FROM json_each(flights.meta, '$.task_ids')")).not.toContain('json_each')
  })
})

describe('#919 strict-batch detector', () => {
  const strict = <T>(fn: () => T): T => {
    process.env.CRG_D1_STRICT_BATCH = '1'
    try { return fn() } finally { delete process.env.CRG_D1_STRICT_BATCH }
  }

  it('is OFF by default — an intra-batch read-after-write passes, exactly as today', async () => {
    const h = createSqliteD1()
    h.sqlite.exec('CREATE TABLE a (id TEXT PRIMARY KEY, v TEXT); CREATE TABLE b (id TEXT);')
    await expect(h.db.batch([
      h.db.prepare("INSERT INTO a (id, v) VALUES ('1', 'x')"),
      h.db.prepare("INSERT INTO b (id) SELECT id FROM a"),
    ])).resolves.toBeDefined()
    h.close()
  })

  it('when ON, refuses a batch whose later statement reads a table an earlier one wrote', async () => {
    const h = createSqliteD1()
    h.sqlite.exec('CREATE TABLE a (id TEXT PRIMARY KEY, v TEXT); CREATE TABLE b (id TEXT);')
    await strict(async () => {
      await expect(h.db.batch([
        h.db.prepare("INSERT INTO a (id, v) VALUES ('1', 'x')"),
        h.db.prepare('INSERT INTO b (id) SELECT id FROM a'),
      ])).rejects.toThrow(/read-after-write \(#919\).*reads "a"/s)
    })
    h.close()
  })

  it('when ON, allows a batch whose statements touch disjoint tables', async () => {
    // The detector must not become a blanket ban on batching, or every call site pays for
    // 24 defective ones.
    const h = createSqliteD1()
    h.sqlite.exec('CREATE TABLE a (id TEXT PRIMARY KEY); CREATE TABLE b (id TEXT PRIMARY KEY);')
    await strict(async () => {
      await expect(h.db.batch([
        h.db.prepare("INSERT INTO a (id) VALUES ('1')"),
        h.db.prepare("INSERT INTO b (id) VALUES ('2')"),
      ])).resolves.toBeDefined()
    })
    h.close()
  })

  it('when ON, allows repeated writes to the same table with no read between them', async () => {
    const h = createSqliteD1()
    h.sqlite.exec('CREATE TABLE a (id TEXT PRIMARY KEY);')
    await strict(async () => {
      await expect(h.db.batch([
        h.db.prepare("INSERT INTO a (id) VALUES ('1')"),
        h.db.prepare("INSERT INTO a (id) VALUES ('2')"),
      ])).resolves.toBeDefined()
    })
    h.close()
  })
})
