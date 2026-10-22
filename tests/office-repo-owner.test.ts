// Repository ownership from D1 by CANONICAL KEY (src/projects/office-repo-owner.ts, migration 0253), #2137 item 3.
// Real SQL throughout: the full migrated schema over node:sqlite, the real writers (createProject, updateProject,
// provisionDefaultClientProjects) and the real resolver. The old resolver filtered by a substring LIKE and a LIMIT 200
// before it canonicalized; every case below that the old shape fails is named for it.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NO_REPO_IDENTITY,
  canonicalizePendingProjectRepos,
  projectsOwningRepo,
  storedRepoKey,
} from '../src/projects/office-repo-owner'
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

  it('pending rows: owner behind 450 pending decoys (more than two pages) is still found', async () => {
    for (let i = 0; i < 450; i++) addProject(`a-decoy-${String(i).padStart(3, '0')}`, decoy(i))
    addProject('z-owner', 'git@github.com:Mumega/Widgets.git')
    expect(await owners('github:mumega/widgets')).toEqual(['z-owner'])
    // every pending row was canonicalized on the way, so the next lookup is the indexed one
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM projects WHERE repo_key IS NULL").get()).toEqual({ n: 0 })
    expect(keyOf('z-owner')).toBe('github:mumega/widgets')
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

  it('an archived PENDING project owns nothing, and is not healed (it is not scanned)', async () => {
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

describe('pending rows are canonicalized and healed in place', () => {
  it('writes the canonical key, or the no-identity marker for a URL that has none', async () => {
    addProject('net', 'git@github.com:Mumega/Widgets.git')
    addProject('local', '/srv/git/widgets.git')
    addProject('none', null)
    const r = await canonicalizePendingProjectRepos(harness.db, null)
    expect(r.healed).toBe(2)
    expect(keyOf('net')).toBe('github:mumega/widgets')
    expect(keyOf('local')).toBe(NO_REPO_IDENTITY)
    expect(keyOf('none')).toBeNull() // no URL, nothing pending
    expect(await canonicalizePendingProjectRepos(harness.db, null)).toEqual({ matching: [], healed: 0 }) // nothing left to scan
  })

  it('is compare-and-set on repo_url: a URL changed after the page was read is not overwritten with the old answer', async () => {
    addProject('p1', 'https://github.com/mumega/old')
    let raced = false
    const racing = {
      prepare(sql: string) {
        const stmt = harness.db.prepare(sql)
        if (!sql.startsWith('UPDATE projects SET repo_key')) return stmt
        return {
          bind: (...v: unknown[]) => {
            if (!raced) {
              raced = true
              harness.sqlite.exec(`UPDATE projects SET repo_url = 'https://github.com/mumega/new' WHERE id = 'p1'`) // a writer wins the race
            }
            return stmt.bind(...v)
          },
        }
      },
    } as unknown as D1Database
    const r = await canonicalizePendingProjectRepos(racing, null)
    expect(r.healed).toBe(0)
    expect(keyOf('p1')).toBeNull() // still pending (the trigger put it back), never the stale 'old'
    expect(await owners('github:mumega/new')).toEqual(['p1'])
    expect(await owners('github:mumega/old')).toEqual([])
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
