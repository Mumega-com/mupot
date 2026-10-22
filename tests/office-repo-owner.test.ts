// Repository ownership from D1 by CANONICAL KEY (src/projects/office-repo-owner.ts, migration 0253), #2137 item 3.
// Real SQL throughout: the full migrated schema over node:sqlite, the real writers (createProject, updateProject,
// provisionDefaultClientProjects) and the real resolver. The old resolver filtered by a substring LIKE and a LIMIT 200
// before it canonicalized; every case below that the old shape fails is named for it.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NO_REPO_IDENTITY,
  PENDING_SCAN_CAP,
  projectsOwningRepo,
  reposOwnedByProject,
  storedRepoKey,
} from '../src/projects/office-repo-owner'
import { healProjectRepoKeys } from '../src/projects/repo-key-heal'
import { backfill, loadCanonicalizer, sqlString } from '../scripts/backfill-repo-key.mjs'
import { provisionDefaultClientProjects } from '../src/projects/client-bootstrap'
import { createProject, updateProject } from '../src/projects/service'
import { repoKeyFromUrl } from '../src/workspaces/repo-key'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let harness: SqliteD1Harness

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
  `)
})
afterEach(() => harness.close())

const env = (): Env => ({ DB: harness.db, TENANT_SLUG: 'pot-a', BRAND: 'Mupot', RELEASE_SHA: 'a'.repeat(40) }) as unknown as Env

function addProject(id: string, repoUrl: string | null, repoKey?: string | null, extra = ''): void {
  harness.sqlite
    .prepare(`INSERT INTO projects (id, slug, name, goal, status, repo_url, repo_key${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (?, ?, ?, 'x', 'active', ?, ?${extra ? ', ' + extra.split('=')[1] : ''})`)
    .run(id, id, id, repoUrl, repoKey === undefined ? null : repoKey)
}

const keyOf = (id: string) => (harness.sqlite.prepare('SELECT repo_key FROM projects WHERE id = ?').get(id) as { repo_key: string | null }).repo_key
const owners = async (key: string) => {
  const r = await projectsOwningRepo(harness.db, key)
  if (!r.ok) throw new Error('unavailable')
  return r.owners
}

describe('every spelling of one repository resolves to its owner (pending rows: the key was never stored)', () => {
  const SPELLINGS = [
    'https://github.com/mumega/widgets',
    'https://github.com/Mumega/Widgets',
    'https://GITHUB.com/MUMEGA/Widgets',
    'https://github.com/mumega/widgets.git',
    'https://github.com/mumega/widgets.git.git',
    'https://github.com/mumega/widgets/',
    'https://github.com/mumega/widgets.git/',
    'https://www.github.com/mumega/widgets',
    'git@github.com:mumega/widgets.git',
    'git@github.com:Mumega/Widgets',
    'ssh://git@github.com/mumega/widgets.git',
    'https://github.com/mumega/%77idgets', // percent-encoded 'w': the substring the old LIKE looked for is not in this text
    'https://github.com/mumega/%57idgets',
    'https://github.com/mumega/%2577idgets', // double-encoded
    'https://github.com/mumega/widgets?tab=readme#top',
  ]
  it.each(SPELLINGS)('%s', async (url) => {
    expect(repoKeyFromUrl(url)).toBe('github:mumega/widgets') // the premise: the canonical fold agrees
    addProject('owner', url)
    addProject('bystander', 'https://github.com/mumega/gadgets')
    expect(await owners('github:mumega/widgets')).toEqual(['owner'])
    expect(await owners('github:mumega/gadgets')).toEqual(['bystander'])
  })

  it('a non-GitHub host keeps its path case; a different case is a different repository', async () => {
    addProject('a', 'https://git.example.com/Team/Repo.git')
    addProject('b', 'https://git.example.com/team/repo')
    expect(await owners('url:git.example.com/Team/Repo')).toEqual(['a'])
    expect(await owners('url:git.example.com/team/repo')).toEqual(['b'])
    addProject('c', 'https://git.example.com/Team/%52epo') // %52 = R
    expect(await owners('url:git.example.com/Team/Repo')).toEqual(['a', 'c'])
  })

  it('the same spellings resolve when the key is STORED (through the index, not the pending scan)', async () => {
    for (const [i, url] of SPELLINGS.entries()) addProject(`p${i}`, url, repoKeyFromUrl(url))
    expect((await owners('github:mumega/widgets')).length).toBe(SPELLINGS.length)
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM projects WHERE repo_key IS NULL").get()).toEqual({ n: 0 })
  })
})

describe('the real owner is found however many unrelated rows share a substring (the LIMIT 200 hole)', () => {
  const decoy = (i: number) => `https://github.com/mumega/widgets-extra-${i}`

  it('stored keys: 450 substring decoys that sort first, owner last', async () => {
    for (let i = 0; i < 450; i++) addProject(`a-decoy-${String(i).padStart(3, '0')}`, decoy(i), repoKeyFromUrl(decoy(i)))
    addProject('z-owner', 'https://github.com/mumega/%77idgets', 'github:mumega/widgets')
    expect(await owners('github:mumega/widgets')).toEqual(['z-owner'])
  })

  it('pending rows: owner behind 450 pending decoys is still found, in one read', async () => {
    for (let i = 0; i < 450; i++) addProject(`a-decoy-${String(i).padStart(3, '0')}`, decoy(i))
    addProject('z-owner', 'git@github.com:Mumega/Widgets.git')
    expect(await owners('github:mumega/widgets')).toEqual(['z-owner'])
    // the lookup is READ-ONLY: it healed nothing (healing is the cron's and the backfill's job)
    expect(keyOf('z-owner')).toBeNull()
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM projects WHERE repo_key IS NULL").get()).toEqual({ n: 451 })
  })

  it('ownership through project_repos is not cut off either: 450 projects on the list for other repos', async () => {
    for (let i = 0; i < 450; i++) {
      addProject(`l-${String(i).padStart(3, '0')}`, null)
      harness.sqlite.prepare('INSERT INTO project_repos (project_id, repo_key) VALUES (?, ?)').run(`l-${String(i).padStart(3, '0')}`, `github:mumega/widgets-extra-${i}`)
    }
    addProject('z-listed', null)
    harness.sqlite.prepare('INSERT INTO project_repos (project_id, repo_key) VALUES (?, ?)').run('z-listed', 'github:mumega/widgets')
    expect(await owners('github:mumega/widgets')).toEqual(['z-listed'])
  })

  it('more pending rows than one read may take is `unavailable` (fail closed), never a truncated list', async () => {
    harness.sqlite.exec('BEGIN')
    const ins = harness.sqlite.prepare(`INSERT INTO projects (id, slug, name, goal, status, repo_url) VALUES (?, ?, ?, 'x', 'active', ?)`)
    for (let i = 0; i < PENDING_SCAN_CAP + 1; i++) ins.run(`d-${String(i).padStart(4, '0')}`, `d-${i}`, `d-${i}`, `https://github.com/mumega/decoy-${i}`)
    harness.sqlite.exec('COMMIT')
    expect(await projectsOwningRepo(harness.db, 'github:mumega/widgets')).toEqual({ ok: false, reason: 'unavailable' })
    // ...and a heal pass drains the backlog, after which the lookup answers again
    for (let i = 0; i < 25; i++) await healProjectRepoKeys(harness.db, { limit: 50 })
    expect(await owners('github:mumega/widgets')).toEqual([])
  })

  it('more than 200 REAL owners are all reported (ambiguity cannot be hidden by a page limit)', async () => {
    for (let i = 0; i < 230; i++) addProject(`o-${String(i).padStart(3, '0')}`, 'https://github.com/mumega/widgets', 'github:mumega/widgets')
    expect((await owners('github:mumega/widgets')).length).toBe(230)
  })
})

describe('who owns', () => {
  it('both sources count and are deduplicated; archived projects own nothing', async () => {
    addProject('p1', 'https://github.com/mumega/widgets', 'github:mumega/widgets')
    harness.sqlite.prepare('INSERT INTO project_repos (project_id, repo_key) VALUES (?, ?)').run('p1', 'github:mumega/widgets')
    expect(await owners('github:mumega/widgets')).toEqual(['p1'])
    addProject('p2', null)
    harness.sqlite.prepare('INSERT INTO project_repos (project_id, repo_key) VALUES (?, ?)').run('p2', 'github:mumega/widgets')
    expect(await owners('github:mumega/widgets')).toEqual(['p1', 'p2'])
    harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'p1'`)
    expect(await owners('github:mumega/widgets')).toEqual(['p2'])
    harness.sqlite.exec(`UPDATE projects SET archived_at = '2026-10-01T00:00:00Z' WHERE id = 'p2'`)
    expect(await owners('github:mumega/widgets')).toEqual([])
  })

  it('an archived PENDING project owns nothing (and the resolver heals nothing)', async () => {
    addProject('p1', 'https://github.com/mumega/widgets')
    harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'p1'`)
    expect(await owners('github:mumega/widgets')).toEqual([])
    expect(keyOf('p1')).toBeNull()
  })

  it('an answer is only ever the exact key: a longer or shorter name, or another host, is not it', async () => {
    addProject('p1', 'https://github.com/mumega/widgets')
    addProject('fork', 'https://github.com/mumega/widgets-fork')
    addProject('short', 'https://github.com/mumega/widget')
    addProject('other-host', 'https://gitlab.com/mumega/widgets')
    expect(await owners('github:mumega/widgets')).toEqual(['p1'])
  })

  it('a D1 failure is reported as unavailable, never as "no owner"', async () => {
    const broken = { prepare: () => { throw new Error('d1 down') } } as unknown as D1Database
    expect(await projectsOwningRepo(broken, 'github:mumega/widgets')).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('one consistent read: every answer is a single db.batch (#2138 round 2)', () => {
  /** A D1 that counts how reads reach it and can fire a hook after a read that is NOT part of a batch. */
  function spying(onSerialRead?: () => void) {
    const log = { serialReads: 0, batches: 0, batchedStatements: 0 }
    const wrap = (stmt: any): any =>
      new Proxy(stmt, {
        get(t, k) {
          if (k === 'bind') return (...a: unknown[]) => wrap(t.bind(...a))
          if (k === 'all' || k === 'first' || k === 'run' || k === 'raw') {
            return async (...a: unknown[]) => {
              log.serialReads++
              const r = await t[k](...a)
              onSerialRead?.()
              return r
            }
          }
          return t[k]
        },
      })
    const db = {
      prepare: (sql: string) => wrap(harness.db.prepare(sql)),
      batch: (ss: any[]) => {
        log.batches++
        log.batchedStatements += ss.length
        return (harness.db as any).batch(ss)
      },
    } as unknown as D1Database
    return { db, log }
  }

  it('the resolver reads in ONE batch of three and nothing outside it', async () => {
    addProject('p1', 'https://github.com/mumega/widgets', 'github:mumega/widgets')
    const { db, log } = spying()
    expect(await projectsOwningRepo(db, 'github:mumega/widgets')).toEqual({ ok: true, owners: ['p1'] })
    expect(log).toEqual({ serialReads: 0, batches: 1, batchedStatements: 3 })
  })

  it('the per-project read (what an office asks) is ONE batch of two, however many repositories it holds', async () => {
    addProject('p1', 'https://github.com/mumega/widgets', 'github:mumega/widgets')
    for (let i = 0; i < 40; i++) harness.sqlite.prepare('INSERT INTO project_repos (project_id, repo_key) VALUES (?, ?)').run('p1', `github:mumega/extra-${i}`)
    const { db, log } = spying()
    const r = await reposOwnedByProject(db, 'p1')
    expect(r.ok && r.keys.size).toBe(41)
    expect(log).toEqual({ serialReads: 0, batches: 1, batchedStatements: 2 })
  })

  it('the exact race: a heal landing between the reads cannot make a real owner vanish', async () => {
    // A pending row is the real owner. In the old shape (key read, then allow-list read, then pending scan as separate
    // round trips) a heal fired after the FIRST read leaves the row in neither result: owners [] -> the office purged.
    addProject('real-owner', 'git@github.com:Mumega/Widgets.git')
    const heal = () => harness.sqlite.exec(`UPDATE projects SET repo_key = 'github:mumega/widgets' WHERE id = 'real-owner' AND repo_key IS NULL`)
    const { db, log } = spying(heal)
    expect(await projectsOwningRepo(db, 'github:mumega/widgets')).toEqual({ ok: true, owners: ['real-owner'] })
    expect(log.serialReads).toBe(0) // nothing outside the batch for the heal to slip between
    expect(keyOf('real-owner')).toBeNull() // so the hook never fired
    // the same for the per-project read
    const second = spying(heal)
    const r = await reposOwnedByProject(second.db, 'real-owner')
    expect(r.ok && [...r.keys]).toEqual(['github:mumega/widgets'])
    expect(second.log.serialReads).toBe(0)
  })

  it('a heal just BEFORE or just AFTER the batch gives the same answer (each is consistent)', async () => {
    addProject('real-owner', 'git@github.com:Mumega/Widgets.git')
    const healNow = () => harness.sqlite.exec(`UPDATE projects SET repo_key = 'github:mumega/widgets' WHERE id = 'real-owner'`)
    expect(await owners('github:mumega/widgets')).toEqual(['real-owner'])
    healNow()
    expect(await owners('github:mumega/widgets')).toEqual(['real-owner'])
  })
})

describe('the lookups never write D1, and neither does anything the office Worker imports (#2138 round 2)', () => {
  it('the resolver is read-only: pending rows stay pending after any number of lookups', async () => {
    addProject('p1', 'https://github.com/mumega/widgets')
    for (let i = 0; i < 3; i++) {
      await owners('github:mumega/widgets')
      await reposOwnedByProject(harness.db, 'p1')
    }
    expect(keyOf('p1')).toBeNull()
  })

  it('ratchet: every D1 statement in the office’s import closure is a SELECT', () => {
    const root = join(__dirname, '..')
    const files = [
      'src/projects/office-core.ts',
      'src/projects/office-repo-owner.ts',
      'src/projects/office-contract.ts',
      ...readdirSync(join(root, 'workers/project-office/src')).filter((f) => f.endsWith('.ts')).map((f) => `workers/project-office/src/${f}`),
    ]
    const offenders: string[] = []
    let prepares = 0
    for (const f of files) {
      const text = readFileSync(join(root, f), 'utf8')
      // every `.prepare(` in these files talks to D1 (the office's own SQLite goes through sql.exec / storage.sql)
      for (const m of text.matchAll(/\.prepare\(\s*(?:`([\s\S]*?)`|'([^']*)'|"([^"]*)")/g)) {
        prepares++
        const stmt = (m[1] ?? m[2] ?? m[3] ?? '').trim()
        if (!/^SELECT\b/i.test(stmt)) offenders.push(`${f}: ${stmt.slice(0, 60)}`)
      }
      if (/\bDB\s*\.\s*(exec|dump)\b|\.run\(/.test(text) && !f.endsWith('project-office.ts')) offenders.push(`${f}: DB write verb`)
    }
    expect(offenders).toEqual([])
    expect(prepares).toBeGreaterThanOrEqual(5) // verifyOfficeBinding, rebuildWorkingSet x2, owner reads x5: a ratchet that reads nothing proves nothing
    // the module the main Worker uses to WRITE the key is not reachable from the office Worker
    for (const f of files) expect(readFileSync(join(root, f), 'utf8')).not.toMatch(/from\s+['"][^'"]*repo-key-heal['"]/)
  })
})

describe('healing pending rows (cron slice and one-time backfill), never on a request path', () => {
  it('the cron heal writes the canonical key, or the no-identity marker, for a bounded slice', async () => {
    addProject('net', 'git@github.com:Mumega/Widgets.git')
    addProject('local', '/srv/git/widgets.git')
    addProject('none', null)
    for (let i = 0; i < 5; i++) addProject(`more-${i}`, `https://github.com/mumega/more-${i}`)
    const first = await healProjectRepoKeys(harness.db, { limit: 3 })
    expect(first).toEqual({ scanned: 3, healed: 3, drained: false })
    const rest = await healProjectRepoKeys(harness.db, { limit: 50 })
    expect(rest).toEqual({ scanned: 4, healed: 4, drained: true })
    expect(keyOf('net')).toBe('github:mumega/widgets')
    expect(keyOf('local')).toBe(NO_REPO_IDENTITY)
    expect(keyOf('none')).toBeNull() // no URL, nothing pending
    expect(await healProjectRepoKeys(harness.db, { limit: 50 })).toEqual({ scanned: 0, healed: 0, drained: true })
  })

  it('compare-and-set on repo_url: a URL changed after the row was read is not overwritten with the old answer', async () => {
    addProject('p1', 'https://github.com/mumega/old')
    const racing = racingDb(() => harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/new' WHERE id = 'p1'`))
    expect((await healProjectRepoKeys(racing, { limit: 10 })).healed).toBe(0)
    expect(keyOf('p1')).toBeNull() // still pending (the trigger put it back), never the stale 'old'
    expect(await owners('github:mumega/new')).toEqual(['p1'])
    expect(await owners('github:mumega/old')).toEqual([])
  })

  it('compare-and-set on repo_key IS NULL: a key another healer or a writer filled in the meantime is never overwritten', async () => {
    addProject('p1', 'https://github.com/mumega/widgets')
    // between the heal's read and its write, a project writer stores a key for the SAME url (a different, deliberate value)
    const racing = racingDb(() => harness.sqlite.exec(`UPDATE projects SET repo_key = 'github:mumega/writer-chose-this' WHERE id = 'p1'`))
    expect((await healProjectRepoKeys(racing, { limit: 10 })).healed).toBe(0)
    expect(keyOf('p1')).toBe('github:mumega/writer-chose-this')
  })

  /** A D1 whose first heal UPDATE is preceded by `interfere()` (another writer winning the race). */
  function racingDb(interfere: () => void): D1Database {
    let fired = false
    return {
      prepare(sql: string) {
        const stmt = harness.db.prepare(sql)
        if (!sql.startsWith('UPDATE projects SET repo_key')) return stmt
        return {
          bind: (...v: unknown[]) => {
            if (!fired) {
              fired = true
              interfere()
            }
            return stmt.bind(...v)
          },
        }
      },
    } as unknown as D1Database
  }
})

describe('scripts/backfill-repo-key.mjs: the one-time backfill (same canonicalizer, idempotent, --dry-run)', () => {
  /** runSql backed by the real migrated SQLite, like wrangler would be backed by D1. */
  const runSql = async (sql: string) => {
    const stmt = harness.sqlite.prepare(sql)
    if (/^\s*SELECT/i.test(sql)) return { rows: stmt.all() as { id: string; repo_url: string }[], changes: 0 }
    return { rows: [], changes: Number(stmt.run().changes) }
  }

  it('uses the repo’s own canonicalizer: the loaded function agrees with storedRepoKey on every spelling', async () => {
    const canon = await loadCanonicalizer()
    for (const url of ['git@github.com:Mumega/Widgets.git', 'https://github.com/mumega/%77idgets', '/srv/git/x', 'https://git.example.com/Team/Repo.git', null])
      expect(canon(url)).toBe(storedRepoKey(url))
  })

  it('backfills every pending row, pages through them, and a second run changes nothing', async () => {
    const canon = await loadCanonicalizer()
    for (let i = 0; i < 25; i++) addProject(`b-${String(i).padStart(2, '0')}`, i % 2 ? `git@github.com:Mumega/R${i}.git` : `https://github.com/mumega/r${i}`)
    addProject('local', '/srv/git/x')
    addProject('none', null)
    const first = await backfill({ runSql, canonicalize: canon, pageSize: 7 })
    expect(first).toEqual({ scanned: 26, healed: 26, skipped: 0, dryRun: false })
    expect(keyOf('b-01')).toBe('github:mumega/r1')
    expect(keyOf('local')).toBe(NO_REPO_IDENTITY)
    expect(keyOf('none')).toBeNull()
    expect(await backfill({ runSql, canonicalize: canon, pageSize: 7 })).toEqual({ scanned: 0, healed: 0, skipped: 0, dryRun: false })
    expect(await owners('github:mumega/r1')).toEqual(['b-01']) // and the indexed lookup now answers
  })

  it('--dry-run reads and reports, and writes nothing', async () => {
    const canon = await loadCanonicalizer()
    addProject('p1', 'https://github.com/mumega/widgets')
    const lines: string[] = []
    const r = await backfill({ runSql, canonicalize: canon, dryRun: true, log: (l: string) => lines.push(l) })
    expect(r).toEqual({ scanned: 1, healed: 0, skipped: 0, dryRun: true })
    expect(lines).toEqual(['would set p1 -> github:mumega/widgets'])
    expect(keyOf('p1')).toBeNull()
  })

  it('is compare-and-set: a row a writer changed or filled since it was read is left alone', async () => {
    const canon = await loadCanonicalizer()
    addProject('changed', 'https://github.com/mumega/old')
    addProject('filled', 'https://github.com/mumega/widgets')
    let n = 0
    const racing = async (sql: string) => {
      if (/^\s*UPDATE/i.test(sql) && n++ === 0) {
        harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/new' WHERE id = 'changed'`)
        harness.sqlite.exec(`UPDATE projects SET repo_key = 'github:mumega/by-writer' WHERE id = 'filled'`)
      }
      return runSql(sql)
    }
    const r = await backfill({ runSql: racing, canonicalize: canon })
    expect(r.healed).toBe(0)
    expect(keyOf('filled')).toBe('github:mumega/by-writer')
    expect(keyOf('changed')).toBeNull()
  })

  it('quotes hostile values: an apostrophe in a URL cannot break out of the statement', async () => {
    expect(sqlString("a'b")).toBe("'a''b'")
    addProject('p1', "https://github.com/mumega/it's-fine'; DROP TABLE projects; --")
    await backfill({ runSql, canonicalize: await loadCanonicalizer() })
    expect(harness.sqlite.prepare('SELECT count(*) AS n FROM projects').get()).toEqual({ n: 1 })
  })
})

describe('migration 0253: a changed repo_url without a key update puts the key back to pending', () => {
  it('a raw UPDATE of repo_url (any writer that does not know the column) cannot leave a stale owner behind', async () => {
    addProject('p1', 'https://github.com/mumega/old', 'github:mumega/old')
    expect(await owners('github:mumega/old')).toEqual(['p1'])
    harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/new' WHERE id = 'p1'`)
    expect(keyOf('p1')).toBeNull()
    expect(await owners('github:mumega/old')).toEqual([]) // the old repository is released
    expect(await owners('github:mumega/new')).toEqual(['p1'])
  })

  it('a writer that updates both is left alone; an unrelated update or the same URL is not touched', async () => {
    addProject('p1', 'https://github.com/mumega/old', 'github:mumega/old')
    harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/new', repo_key = 'github:mumega/new' WHERE id = 'p1'`)
    expect(keyOf('p1')).toBe('github:mumega/new')
    harness.sqlite.exec(`UPDATE projects SET name = 'renamed' WHERE id = 'p1'`)
    harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/new' WHERE id = 'p1'`)
    expect(keyOf('p1')).toBe('github:mumega/new')
  })

  it('clearing repo_url releases the repository', async () => {
    addProject('p1', 'https://github.com/mumega/old', 'github:mumega/old')
    harness.sqlite.exec(`UPDATE projects SET repo_url = NULL WHERE id = 'p1'`)
    expect(await owners('github:mumega/old')).toEqual([])
  })

  it('existing rows are pending after the migration (no unsafe SQL backfill), and the lookup is indexed', () => {
    const idx = (harness.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_projects_repo_key', 'idx_projects_repo_key_pending', 'idx_project_repos_repo_key') ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    expect(idx).toEqual(['idx_project_repos_repo_key', 'idx_projects_repo_key', 'idx_projects_repo_key_pending'])
    const plan = (harness.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT p.id FROM projects p WHERE p.repo_key = ? AND p.archived_at IS NULL AND p.status != 'archived'`).all('x') as { detail: string }[]).map((r) => r.detail).join(' ')
    expect(plan).toContain('idx_projects_repo_key')
    const plan2 = (harness.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT p.id FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE r.repo_key = ?`).all('x') as { detail: string }[]).map((r) => r.detail).join(' ')
    expect(plan2).toContain('idx_project_repos_repo_key')
    const plan3 = (harness.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT p.id, p.repo_url FROM projects p WHERE p.repo_url IS NOT NULL AND p.repo_key IS NULL AND p.id > ? AND p.archived_at IS NULL AND p.status != 'archived' ORDER BY p.id LIMIT 200`).all('') as { detail: string }[]).map((r) => r.detail).join(' ')
    expect(plan3).toContain('idx_projects_repo_key_pending')
  })
})

describe('every writer of projects.repo_url stores the key beside it', () => {
  it('createProject', async () => {
    const created = await createProject(env(), { slug: 'w', name: 'W', repo_url: 'https://github.com/Mumega/%77idgets.git' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(keyOf(created.value.id)).toBe('github:mumega/widgets')
    expect(await owners('github:mumega/widgets')).toEqual([created.value.id])
    const bare = await createProject(env(), { slug: 'b', name: 'B' })
    if (bare.ok) expect(keyOf(bare.value.id)).toBeNull()
  })

  it('updateProject: set, change and clear', async () => {
    const created = await createProject(env(), { slug: 'w', name: 'W', repo_url: 'https://github.com/mumega/one' })
    if (!created.ok) throw new Error('create')
    const id = created.value.id
    expect(keyOf(id)).toBe('github:mumega/one')
    expect((await updateProject(env(), id, { repo_url: 'https://github.com/mumega/two' })).ok).toBe(true)
    expect(keyOf(id)).toBe('github:mumega/two')
    expect(await owners('github:mumega/one')).toEqual([])
    expect(await owners('github:mumega/two')).toEqual([id])
    expect((await updateProject(env(), id, { repo_url: null })).ok).toBe(true)
    expect(keyOf(id)).toBeNull()
    expect(await owners('github:mumega/two')).toEqual([])
  })

  it('updateProject with a different spelling of the same repo keeps ownership', async () => {
    const created = await createProject(env(), { slug: 'w', name: 'W', repo_url: 'https://github.com/mumega/one' })
    if (!created.ok) throw new Error('create')
    await updateProject(env(), created.value.id, { repo_url: 'https://github.com/Mumega/One.git' })
    expect(await owners('github:mumega/one')).toEqual([created.value.id]) // pending or stored, either way found
  })

  it('client bootstrap (insert and update paths)', async () => {
    const first = await provisionDefaultClientProjects(env())
    const withRepo = first.projects.filter((p) => p.project.repo_url)
    expect(withRepo.length).toBeGreaterThan(0)
    for (const p of withRepo) expect(keyOf(p.project.id)).toBe(storedRepoKey(p.project.repo_url))
    harness.sqlite.exec(`UPDATE projects SET repo_key = 'github:stale/key' WHERE repo_url IS NOT NULL`)
    await provisionDefaultClientProjects(env()) // the update path rewrites repo_url AND repo_key together
    for (const p of withRepo) expect(keyOf(p.project.id)).toBe(storedRepoKey(p.project.repo_url))
  })

  it('storedRepoKey: key, no-identity marker, null', () => {
    expect(storedRepoKey('git@github.com:A/B.git')).toBe('github:a/b')
    expect(storedRepoKey('/local/path')).toBe(NO_REPO_IDENTITY)
    expect(storedRepoKey('file:///x')).toBe(NO_REPO_IDENTITY)
    expect(storedRepoKey(null)).toBeNull()
    expect(storedRepoKey(undefined)).toBeNull()
  })

  it('ratchet: no statement in src/ writes projects.repo_url without repo_key beside it', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (p.endsWith('.ts') && !p.endsWith('schema-chain.generated.ts')) files.push(p)
      }
    }
    walk(join(__dirname, '..', 'src'))
    const offenders: string[] = []
    let inspected = 0
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      // INSERT INTO projects (<columns>) and UPDATE projects SET <assignments> WHERE
      for (const m of text.matchAll(/INSERT\s+INTO\s+projects\s*\(([^)]*)\)/gi)) {
        if (/\brepo_url\b/.test(m[1] ?? '')) {
          inspected++
          if (!/\brepo_key\b/.test(m[1] ?? '')) offenders.push(`${f}: INSERT without repo_key`)
        }
      }
      for (const m of text.matchAll(/UPDATE\s+projects\s+SET([\s\S]*?)WHERE/gi)) {
        if (/\brepo_url\s*=/.test(m[1] ?? '')) {
          inspected++
          if (!/\brepo_key\s*=/.test(m[1] ?? '')) offenders.push(`${f}: UPDATE without repo_key`)
        }
      }
    }
    expect(offenders).toEqual([])
    expect(inspected).toBeGreaterThanOrEqual(4) // service insert + update, bootstrap insert + update: a ratchet that reads nothing proves nothing
  })
})
