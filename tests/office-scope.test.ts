// Repository scope on office items (#2137 item 2) and the office's own SQLite migration to schema v2.
// Real D1 schema + the real office core over node:sqlite. D1 is the authority: a project that stops owning a repository
// stops serving its items, and an office wiped and rebuilt gets the same answer.

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildNotice, type Notice, type NoticeFields } from '../src/projects/office-contract'
import {
  OFFICE_SCHEMA_TOO_NEW,
  OFFICE_SCHEMA_VERSION,
  applyNotice,
  ensureOfficeSchema,
  isRepoScope,
  rebuildWorkingSet,
  SCOPE_RELINQUISH_CONFIRM_MS,
  clearRelinquishMark,
  sweepRelinquishedScopes,
  verifyNoticeScope,
  type OfficeSql,
} from '../src/projects/office-core'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let harness: SqliteD1Harness

function store(): { sql: OfficeSql; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  const sql: OfficeSql = {
    exec: (q, ...b) => void db.prepare(q).run(...b),
    all: (q, ...b) => db.prepare(q).all(...b) as Record<string, unknown>[],
  }
  return { sql, db }
}

const NOW = Date.parse('2026-10-22T09:00:00.000Z')
const T = (s: number) => new Date(Date.parse('2026-10-22T08:00:00.000Z') + s * 1000).toISOString()
const fields = (over: Partial<NoticeFields> = {}): NoticeFields => ({
  tenant: 'pot-a', connection: 'inst-1', scope: 'github:mumega/widgets', provider: 'github', item_id: 'PR_1', event_id: 'd-1',
  version: 'sha-a', kind: 'pr', state: 'open', url: 'https://github.com/mumega/widgets/pull/1', title: 'T', actor: 'octo', updated_at: T(0), ...over,
})
const notice = (over: Partial<NoticeFields> = {}): Promise<Notice> => buildNotice(fields(over))
const held = (sql: OfficeSql) => sql.all('SELECT item_id, scope FROM office_items ORDER BY item_id')

async function office(...ns: Partial<NoticeFields>[]): Promise<OfficeSql> {
  const { sql } = store()
  ensureOfficeSchema(sql)
  for (const [i, n] of ns.entries()) applyNotice(sql, await notice({ event_id: `e-${i}`, ...n }), NOW)
  return sql
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p1', 'p1', 'One', 'x', 'active', 'https://github.com/mumega/widgets');
    INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p2', 'p2', 'Two', 'x', 'active', 'https://github.com/mumega/gadgets');
  `)
})
afterEach(() => harness.close())

const env = () => ({ DB: harness.db })

describe('applyNotice stores the scope with the item', () => {
  it('first sight and a newer notice both carry it', async () => {
    const sql = await office({ item_id: 'A' })
    expect(held(sql)).toEqual([{ item_id: 'A', scope: 'github:mumega/widgets' }])
    applyNotice(sql, await notice({ item_id: 'A', event_id: 'e-9', version: 'sha-b', updated_at: T(60), scope: 'github:mumega/moved' }), NOW)
    expect(held(sql)).toEqual([{ item_id: 'A', scope: 'github:mumega/moved' }])
  })
})

describe('verifyNoticeScope: D1 vouches for the repository before a notice is taken in', () => {
  it('owned, not owned, unverifiable', async () => {
    expect(await verifyNoticeScope(env(), 'p1', { scope: 'github:mumega/widgets' })).toEqual({ ok: true })
    expect(await verifyNoticeScope(env(), 'p2', { scope: 'github:mumega/widgets' })).toEqual({ ok: false, reason: 'scope_not_owned' })
    expect(await verifyNoticeScope(env(), 'p1', { scope: 'github:mumega/unknown' })).toEqual({ ok: false, reason: 'scope_not_owned' })
    const down = { DB: { prepare: () => { throw new Error('d1 down') } } as unknown as D1Database }
    expect(await verifyNoticeScope(down, 'p1', { scope: 'github:mumega/widgets' })).toEqual({ ok: false, reason: 'scope_unverifiable' })
  })

  it('an archived owner owns nothing; a second claimant does not unseat the first (intake is what refuses ambiguity)', async () => {
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p3', 'p3', 'Three', 'x', 'active', 'git@github.com:Mumega/Widgets.git')`)
    expect(await verifyNoticeScope(env(), 'p1', { scope: 'github:mumega/widgets' })).toEqual({ ok: true })
    expect(await verifyNoticeScope(env(), 'p3', { scope: 'github:mumega/widgets' })).toEqual({ ok: true })
    harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'p1'`)
    expect(await verifyNoticeScope(env(), 'p1', { scope: 'github:mumega/widgets' })).toEqual({ ok: false, reason: 'scope_not_owned' })
  })

  it('a scope that names no repository (Linear team) passes: nothing in D1 can contradict it', async () => {
    expect(isRepoScope('linear:team-1')).toBe(false)
    expect(isRepoScope('github:o/r')).toBe(true)
    expect(isRepoScope('url:git.example/o/r')).toBe(true)
    expect(await verifyNoticeScope(env(), 'p1', { scope: 'linear:team-1' })).toEqual({ ok: true })
  })
})

const LATER = NOW + SCOPE_RELINQUISH_CONFIRM_MS
const marks = (sql: OfficeSql) => sql.all(`SELECT key, value FROM office_meta WHERE key LIKE 'relinquished_seen_at:%' ORDER BY key`)
/** The two answers that destroy: a sweep, then another at least the confirm window later. */
async function sweepTwice(sql: OfficeSql, project = 'p1') {
  const first = await sweepRelinquishedScopes(env(), sql, project, NOW)
  const second = await sweepRelinquishedScopes(env(), sql, project, LATER)
  return { first, second }
}

describe('sweepRelinquishedScopes: one answer withholds, two answers a TTL apart delete', () => {
  it('repo_url moved to another project: first sweep withholds and marks, the confirming sweep deletes', async () => {
    const sql = await office({ item_id: 'W1' }, { item_id: 'W2' })
    harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/other' WHERE id = 'p1'`) // p1 gives widgets up
    harness.sqlite.exec(`INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES ('p9', 'p9', 'Nine', 'x', 'active', 'https://github.com/mumega/widgets')`)
    const first = await sweepRelinquishedScopes(env(), sql, 'p1', NOW)
    expect(first).toEqual({ purged: 0, withheld: ['github:mumega/widgets'], unverifiable: [] })
    expect(held(sql)).toHaveLength(2) // nothing destroyed on one answer
    expect(marks(sql)).toEqual([{ key: 'relinquished_seen_at:github:mumega/widgets', value: new Date(NOW).toISOString() }])
    const second = await sweepRelinquishedScopes(env(), sql, 'p1', LATER)
    expect(second).toEqual({ purged: 2, withheld: [], unverifiable: [] })
    expect(held(sql)).toEqual([])
    expect(marks(sql)).toEqual([]) // the mark goes with the rows
    expect(sql.all(`SELECT value FROM office_meta WHERE key = 'scope_purged'`)).toEqual([{ value: '2' }])
  })

  it('a second sweep that comes too soon does not confirm (the mark must be a full window old)', async () => {
    const sql = await office({ item_id: 'W1' })
    harness.sqlite.exec(`UPDATE projects SET repo_url = NULL WHERE id = 'p1'`)
    await sweepRelinquishedScopes(env(), sql, 'p1', NOW)
    const soon = await sweepRelinquishedScopes(env(), sql, 'p1', LATER - 1)
    expect(soon).toEqual({ purged: 0, withheld: ['github:mumega/widgets'], unverifiable: [] })
    expect(held(sql)).toHaveLength(1)
    expect((await sweepRelinquishedScopes(env(), sql, 'p1', LATER)).purged).toBe(1)
  })

  it('THE RACE: one wrong "not owned" answer between two right ones deletes nothing and leaves no mark', async () => {
    const sql = await office({ item_id: 'W1' })
    // sweep 1: D1 momentarily answers as if the project owned nothing (a heal landing between split reads, a lagging replica)
    const blip = { DB: { batch: async () => [{ results: [] }, { results: [] }], prepare: () => ({ bind: () => ({}) }) } as unknown as D1Database }
    expect(await sweepRelinquishedScopes(blip, sql, 'p1', NOW)).toEqual({ purged: 0, withheld: ['github:mumega/widgets'], unverifiable: [] })
    expect(held(sql)).toHaveLength(1)
    // sweep 2, a window later: D1 is right again. The doubt is withdrawn, the rows were never touched.
    expect(await sweepRelinquishedScopes(env(), sql, 'p1', LATER)).toEqual({ purged: 0, withheld: [], unverifiable: [] })
    expect(held(sql)).toEqual([{ item_id: 'W1', scope: 'github:mumega/widgets' }])
    expect(marks(sql)).toEqual([])
    // and the same blip AFTER the window cannot delete either: it is a first sighting again, not a confirmation
    expect((await sweepRelinquishedScopes(blip, sql, 'p1', LATER + SCOPE_RELINQUISH_CONFIRM_MS)).purged).toBe(0)
    expect(held(sql)).toHaveLength(1)
  })

  it('a heal injected between the reads of the real resolver changes nothing (the batch is one snapshot)', async () => {
    harness.sqlite.exec(`UPDATE projects SET repo_key = NULL WHERE id = 'p1'`) // p1's own row is pending
    const sql = await office({ item_id: 'W1' })
    const racing = {
      prepare: (q: string) => {
        const st = harness.db.prepare(q) as any
        return new Proxy(st, { get: (t, k) => (k === 'bind' ? (...a: unknown[]) => t.bind(...a) : t[k]) })
      },
      batch: async (ss: D1PreparedStatement[]) => {
        const out = await harness.db.batch(ss)
        harness.sqlite.exec(`UPDATE projects SET repo_key = 'github:mumega/widgets' WHERE id = 'p1'`) // heal right after
        return out
      },
    } as unknown as D1Database
    expect(await sweepRelinquishedScopes({ DB: racing }, sql, 'p1', NOW)).toEqual({ purged: 0, withheld: [], unverifiable: [] })
    expect(held(sql)).toHaveLength(1)
  })

  it('only the relinquished repository goes; the ones still owned stay and keep no mark', async () => {
    harness.sqlite.exec(`INSERT INTO project_repos (project_id, repo_key) VALUES ('p1', 'github:mumega/extra')`)
    const sql = await office({ item_id: 'W1' }, { item_id: 'X1', scope: 'github:mumega/extra' })
    harness.sqlite.exec(`DELETE FROM project_repos WHERE project_id = 'p1'`)
    const { first, second } = await sweepTwice(sql)
    expect(first.withheld).toEqual(['github:mumega/extra'])
    expect(second.purged).toBe(1)
    expect(held(sql)).toEqual([{ item_id: 'W1', scope: 'github:mumega/widgets' }])
    expect(marks(sql)).toEqual([])
  })

  it('regaining ownership between the two sweeps clears the mark: the second sweep starts over, not a confirmation', async () => {
    const sql = await office({ item_id: 'W1' })
    harness.sqlite.exec(`UPDATE projects SET repo_url = NULL WHERE id = 'p1'`)
    await sweepRelinquishedScopes(env(), sql, 'p1', NOW)
    harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/widgets', repo_key = 'github:mumega/widgets' WHERE id = 'p1'`)
    expect((await sweepRelinquishedScopes(env(), sql, 'p1', LATER)).purged).toBe(0)
    expect(marks(sql)).toEqual([])
    harness.sqlite.exec(`UPDATE projects SET repo_url = NULL WHERE id = 'p1'`)
    expect((await sweepRelinquishedScopes(env(), sql, 'p1', LATER + 1)).purged).toBe(0) // first sighting again
    expect(held(sql)).toHaveLength(1)
  })

  it('an archived project or a cleared repo_url relinquishes everything (after confirmation)', async () => {
    const a = await office({ item_id: 'W1' })
    harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'p1'`)
    expect((await sweepTwice(a)).second.purged).toBe(1)
    harness.sqlite.exec(`UPDATE projects SET status = 'active', repo_url = NULL WHERE id = 'p1'`)
    const b = await office({ item_id: 'W1' })
    expect((await sweepTwice(b)).second.purged).toBe(1)
  })

  it('items of a repository this project never owned (a replay, a mislabel) go too, after confirmation', async () => {
    const sql = await office({ item_id: 'G1', scope: 'github:mumega/gadgets' }) // gadgets belongs to p2
    const { first, second } = await sweepTwice(sql)
    expect(first.purged).toBe(0)
    expect(second.purged).toBe(1)
  })

  it('a still-owned repository is untouched, and a second sweep is a no-op', async () => {
    const sql = await office({ item_id: 'W1' })
    expect(await sweepRelinquishedScopes(env(), sql, 'p1', NOW)).toEqual({ purged: 0, withheld: [], unverifiable: [] })
    expect(await sweepRelinquishedScopes(env(), sql, 'p1', LATER)).toEqual({ purged: 0, withheld: [], unverifiable: [] })
    expect(held(sql)).toHaveLength(1)
  })

  it('D1 unreachable: nothing is deleted on a guess, no mark moves, and the scope is reported so the read path withholds it', async () => {
    const sql = await office({ item_id: 'W1' })
    harness.sqlite.exec(`UPDATE projects SET repo_url = NULL WHERE id = 'p1'`)
    await sweepRelinquishedScopes(env(), sql, 'p1', NOW) // a real first sighting
    const down = { DB: { prepare: () => { throw new Error('d1 down') } } as unknown as D1Database }
    expect(await sweepRelinquishedScopes(down, sql, 'p1', LATER)).toEqual({ purged: 0, withheld: [], unverifiable: ['github:mumega/widgets'] })
    expect(held(sql)).toHaveLength(1) // an outage is not the confirming answer
    expect(marks(sql)).toHaveLength(1)
  })

  it('non-repository scopes are never swept (no D1 source can vouch for them yet)', async () => {
    const sql = await office({ provider: 'linear', scope: 'linear:team-1', item_id: 'L1' })
    expect((await sweepTwice(sql)).second).toEqual({ purged: 0, withheld: [], unverifiable: [] })
    expect(held(sql)).toHaveLength(1)
  })

  it('marks of scopes that no longer have items are forgotten', async () => {
    const sql = await office({ item_id: 'W1' })
    sql.exec(`INSERT INTO office_meta (key, value) VALUES ('relinquished_seen_at:github:mumega/gone', '2026-01-01T00:00:00.000Z')`)
    await sweepRelinquishedScopes(env(), sql, 'p1', NOW)
    expect(marks(sql)).toEqual([])
  })

  it('an item that arrived after the confirming check began survives that sweep', async () => {
    const sql = await office({ item_id: 'OLD' })
    harness.sqlite.exec(`UPDATE projects SET repo_url = NULL WHERE id = 'p1'`)
    await sweepRelinquishedScopes(env(), sql, 'p1', NOW - 2 * SCOPE_RELINQUISH_CONFIRM_MS) // first sighting, long ago
    // OLD was applied at NOW; a confirming sweep that STARTED before then leaves it, one that started after removes it
    expect((await sweepRelinquishedScopes(env(), sql, 'p1', NOW - 1000)).purged).toBe(0)
    expect((await sweepRelinquishedScopes(env(), sql, 'p1', NOW)).purged).toBe(1)
  })

  it('a notice verified against D1 voids an earlier doubt about its scope (facade: scopeVouched)', async () => {
    const sql = await office({ item_id: 'W1' })
    harness.sqlite.exec(`UPDATE projects SET repo_url = NULL WHERE id = 'p1'`)
    await sweepRelinquishedScopes(env(), sql, 'p1', NOW)
    expect(marks(sql)).toHaveLength(1)
    clearRelinquishMark(sql, 'github:mumega/widgets')
    expect(marks(sql)).toEqual([])
  })
})

describe('the office is a projection: destroy-and-rebuild still passes', () => {
  it('a wiped office rebuilds the D1-derived state, and a relinquished repository cannot come back through a replay', async () => {
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('d', 'd', 'D');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('s', 'd', 's', 'S');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p1', 's', 'write');
      INSERT INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t1', 's', 'p1', 'Open', 'b', 'open');
    `)
    const before = store()
    ensureOfficeSchema(before.sql)
    const binding = { ok: true as const, tenant: 'pot-a', projectId: 'p1' }
    await rebuildWorkingSet(env(), before.sql, binding, '2026-10-22T10:00:00.000Z')
    applyNotice(before.sql, await notice({ item_id: 'W1' }), NOW)
    // the project gives the repository up in D1; two sweeps a window apart settle it
    harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/other' WHERE id = 'p1'`)
    await sweepTwice(before.sql)
    expect(held(before.sql)).toEqual([])

    // destroy: a brand-new office, rebuilt from D1 alone, holds the same D1-derived state
    const after = store()
    ensureOfficeSchema(after.sql)
    await rebuildWorkingSet(env(), after.sql, binding, '2026-10-22T10:00:00.000Z')
    const derived = (s: OfficeSql) => [s.all('SELECT * FROM office_project_view'), s.all('SELECT * FROM office_tasks')]
    expect(derived(after.sql)).toEqual(derived(before.sql))
    expect(held(after.sql)).toEqual([])
    // a late replay of the same GitHub delivery is refused at the door, so the rebuilt office cannot re-learn it
    expect(await verifyNoticeScope(env(), 'p1', await notice({ item_id: 'W1', event_id: 'replay' }))).toEqual({ ok: false, reason: 'scope_not_owned' })
  })
})

// ── the office's own SQLite: v1 -> v2 ─────────────────────────────────────────

const V1_OFFICE_ITEMS = `CREATE TABLE office_items (
  provider TEXT NOT NULL, connection TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  version TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, actor TEXT NOT NULL, updated_at TEXT NOT NULL,
  hash TEXT NOT NULL, last_event_id TEXT NOT NULL, conflict_version TEXT, applied_at TEXT NOT NULL,
  PRIMARY KEY (provider, connection, item_id))`

function v1Office(): OfficeSql {
  const { sql } = store()
  sql.exec(`CREATE TABLE office_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  sql.exec(V1_OFFICE_ITEMS)
  sql.exec(`INSERT INTO office_meta (key, value) VALUES ('schema_version', '1')`)
  const ins = (provider: string, item: string, url: string) =>
    sql.exec(
      `INSERT INTO office_items (provider, connection, item_id, kind, state, version, url, title, actor, updated_at, hash, last_event_id, applied_at)
       VALUES (?, 'inst-1', ?, 'pr', 'open', 'v', ?, 't', 'a', ?, 'h', 'e', ?)`,
      provider, item, url, T(0), T(1),
    )
  ins('github', 'PR_ok', 'https://github.com/Mumega/Widgets/pull/12')
  ins('github', 'ISS_ok', 'https://github.com/mumega/widgets/issues/3#issuecomment-1')
  ins('github', 'PR_other', 'https://github.com/mumega/gadgets/pull/4')
  ins('github', 'PR_bad', 'https://evil.example/mumega/widgets/pull/1') // a link that does not name a GitHub repository
  ins('linear', 'LIN_1', 'https://linear.app/mumega/issue/MUM-1/x') // no scope can be derived from a Linear link
  return sql
}

describe('office_meta.schema_version 1 -> 2', () => {
  it('is 2 now, and a fresh office is created at 2 with the scope column and its index', () => {
    expect(OFFICE_SCHEMA_VERSION).toBe('2')
    const { sql } = store()
    ensureOfficeSchema(sql)
    expect(sql.all(`SELECT value FROM office_meta WHERE key = 'schema_version'`)).toEqual([{ value: '2' }])
    expect(sql.all('PRAGMA table_info(office_items)').map((c) => c.name)).toContain('scope')
    expect(sql.all(`SELECT name FROM sqlite_master WHERE name = 'idx_office_items_scope'`)).toHaveLength(1)
  })

  it('migrates v1 rows in place: scope read back from the GitHub link, unverifiable rows deleted, version bumped', () => {
    const sql = v1Office()
    ensureOfficeSchema(sql)
    expect(sql.all('SELECT item_id, scope FROM office_items ORDER BY item_id')).toEqual([
      { item_id: 'ISS_ok', scope: 'github:mumega/widgets' },
      { item_id: 'PR_ok', scope: 'github:mumega/widgets' }, // case folded like repoKeyFromUrl
      { item_id: 'PR_other', scope: 'github:mumega/gadgets' },
    ])
    expect(sql.all(`SELECT value FROM office_meta WHERE key = 'schema_version'`)).toEqual([{ value: '2' }])
    expect(sql.all(`SELECT name FROM sqlite_master WHERE name = 'idx_office_items_scope'`)).toHaveLength(1)
  })

  it('a migrated office is then swept like any other: p1 keeps its repository, loses the one it never owned', async () => {
    const sql = v1Office()
    ensureOfficeSchema(sql)
    expect((await sweepTwice(sql)).second.purged).toBe(1)
    expect(sql.all('SELECT item_id FROM office_items ORDER BY item_id')).toEqual([{ item_id: 'ISS_ok' }, { item_id: 'PR_ok' }])
  })

  it('is idempotent, and does not touch an already-migrated office', async () => {
    const sql = v1Office()
    ensureOfficeSchema(sql)
    const once = JSON.stringify(sql.all('SELECT * FROM office_items ORDER BY item_id'))
    ensureOfficeSchema(sql)
    ensureOfficeSchema(sql)
    expect(JSON.stringify(sql.all('SELECT * FROM office_items ORDER BY item_id'))).toBe(once)
    const fresh = await office({ item_id: 'A' })
    ensureOfficeSchema(fresh)
    expect(held(fresh)).toEqual([{ item_id: 'A', scope: 'github:mumega/widgets' }])
  })

  it('migrates by the columns it finds even when the version row is missing', () => {
    const sql = v1Office()
    sql.exec(`DELETE FROM office_meta WHERE key = 'schema_version'`)
    ensureOfficeSchema(sql)
    expect(sql.all('PRAGMA table_info(office_items)').map((c) => c.name)).toContain('scope')
    expect(sql.all(`SELECT value FROM office_meta WHERE key = 'schema_version'`)).toEqual([{ value: '2' }])
  })

  it('a layout NEWER than this code is refused, not guessed at', () => {
    const { sql } = store()
    ensureOfficeSchema(sql)
    sql.exec(`UPDATE office_meta SET value = '3' WHERE key = 'schema_version'`)
    expect(() => ensureOfficeSchema(sql)).toThrow(OFFICE_SCHEMA_TOO_NEW)
    expect(sql.all(`SELECT value FROM office_meta WHERE key = 'schema_version'`)).toEqual([{ value: '3' }]) // not downgraded
  })
})
