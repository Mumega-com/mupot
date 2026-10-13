// tests/workspaces-w1.test.ts — workspaces W1 (design: mumega-com docs/architecture/harness-seats-worktrees.md
// §4.0 harnesses.grant_id, §4.1 worktrees + project_repos + worktree_open / worktree_list), behind WORKSPACES.
//
// Real sqlite D1 built from the WHOLE committed migration chain; real doors for the harness cases
// (membersApp mint -> bearer -> mcpApp tools/call -> invokeTool chokepoint). Not proven: the
// cloudflare:workers entrypoint, and real D1 interleaving (concurrency is approximated by Promise.all
// over a real UNIQUE index).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations, migrationFiles } from './helpers/migrations'
import { membersApp } from '../src/members'
import { TOOLS, invokeTool, mcpApp, advertisedTools } from '../src/mcp/index'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { loadHarness, upsertHarness } from '../src/members/harness'
import { seatSelect } from '../src/members/seat-select'
import { openWorktree, listWorktrees, normalizeBranch, normalizeSlug, normalizeThreadId } from '../src/workspaces/service'
import { repoKeyFromUrl } from '../src/workspaces/repo-key'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.test'
const W = 'member-writer'
const R = 'member-reader'
const X = 'member-outsider'
const REPO = 'https://github.com/Mumega-com/mupot.git'
const REPO_SPELLINGS = [
  'https://github.com/Mumega-com/mupot.git',
  'git@github.com:Mumega-com/mupot.git',
  'https://github.com/mumega-com/mupot',
  'ssh://git@github.com/Mumega-com/mupot.git/',
  'https://api.github.com/repos/Mumega-com/mupot',
]

let h: SqliteD1Harness
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)

function kv() {
  const store = new Map<string, string>([['sess:admin-sid', JSON.stringify({ userId: 'u-admin', email: 'a@x.test', role: 'admin', createdAt: '2026-01-01T00:00:00Z' })]])
  return { get: async (k: string, type?: string) => { const v = store.get(k); if (v === undefined) return null; return type === 'json' ? JSON.parse(v) : v }, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) }
}

function envFor(extra: Record<string, unknown> = {}): Env {
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: ORIGIN, SESSIONS: kv(), OAUTH_KV: { get: async () => null, put: async () => undefined },
    SEAT_AUTO_ENROLL: '1', SEAT_MAX_PER_MEMBER: '100', WORKSPACES: '1', ...extra,
  } as unknown as Env
}

function member(id: string): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', '${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
}
function grant(memberId: string, squad: string, cap: string): void {
  h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${memberId}-${squad}', '${memberId}', 'squad', '${squad}', '${cap}')`)
}

beforeEach(() => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1','d','D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('SQ_W','d1','w','W'),('SQ_R','d1','r','R'),('SQ_O','d1','o','O');
    INSERT INTO projects (id, slug, name, status, repo_url) VALUES
      ('P1','mupot','Mupot','active','${REPO}'),
      ('P2','other','Other','active','https://github.com/Other-Org/other.git'),
      ('P3','norepo','No repo','active',NULL);
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('P1','SQ_W','write'),('P1','SQ_R','read'),('P2','SQ_O','write'),('P3','SQ_W','write');
  `)
  for (const m of [W, R, X, 'agent-member-1', 'agent-member-2', 'agent-member-3']) member(m)
  h.sqlite.exec(`INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-08-01T00:00:00.000Z')`)
  grant(W, 'SQ_W', 'member'); grant(R, 'SQ_R', 'member'); grant(X, 'SQ_O', 'member')
})
afterEach(() => { h.close(); vi.unstubAllGlobals() })

// ── helpers ─────────────────────────────────────────────────────────────────────────────

async function mintHarness(env: Env, memberId: string): Promise<{ raw: string; harnessId: string; tokenId: string }> {
  const res = await membersApp.request(`/members/${memberId}/tokens`, {
    method: 'POST', headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'ci', harness_kind: 'ci' }),
  }, env)
  const j = (await res.json()) as { token: { raw: string; id: string }; harness: { id: string } }
  if (res.status !== 201) throw new Error(`mint ${res.status} ${JSON.stringify(j)}`)
  return { raw: j.token.raw, harnessId: j.harness.id, tokenId: j.token.id }
}

async function rpc(env: Env, raw: string, name: string, args: Record<string, unknown>): Promise<{ status: number; text: string; sc: Record<string, unknown> }> {
  const res = await mcpApp.fetch(new Request(`${ORIGIN}/`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), env)
  const text = await res.text()
  const json = JSON.parse(text) as { result?: { structuredContent?: Record<string, unknown> } }
  return { status: res.status, text, sc: json.result?.structuredContent ?? {} }
}

/** A harness-shaped context: ZERO capabilities by design, a harness pointer, no agent. */
function harnessAuth(memberId: string, harnessId?: string | null, tokenId?: string): AuthContext {
  let hid: string | null
  if (harnessId === undefined) {
    // a REAL harness row for this member (the door verifies it live)
    hid = `hx-${memberId}`
    h.sqlite.exec(`INSERT OR IGNORE INTO harnesses (id, tenant, member_id, oauth_client_id) VALUES ('${hid}', '${TENANT}', '${memberId}', 'client-${memberId}')`)
  } else hid = harnessId
  return {
    userId: memberId, email: null, role: 'member', tenant: TENANT, memberId, channel: 'directory',
    capabilities: [], latentCapabilities: [], boundAgentId: null, harnessId: hid, harnessCredential: true,
    ...(tokenId ? { tokenId } : {}),
  }
}

function agentAuth(memberId: string, caps: Array<{ squad: string; cap: 'member' | 'observer' | 'admin' }>): AuthContext {
  return {
    userId: memberId, email: null, role: 'member', tenant: TENANT, memberId, channel: 'directory', boundAgentId: 'agent-x',
    capabilities: caps.map((c) => ({ member_id: memberId, scope_type: 'squad' as const, scope_id: c.squad, capability: c.cap })),
  }
}

const wtRows = (): number => n('SELECT COUNT(*) AS n FROM worktrees')
const open = (env: Env, auth: AuthContext, a: Record<string, unknown>) => openWorktree(env, auth, { project: 'P1', repo: REPO, branch: 'main', ...a })

// ════════════════════════════════════════════════════════════════════════════
describe('identity: one row per project + repo + branch, never a path', () => {
  it('the same branch from two machines (two harness tokens) and five spellings of the repo URL is ONE row', async () => {
    const env = envFor()
    const m1 = await mintHarness(env, W)
    const m2 = await mintHarness(env, W)
    const ids = new Set<string>()
    let i = 0
    for (const spelling of REPO_SPELLINGS) {
      const r = await rpc(env, i++ % 2 ? m1.raw : m2.raw, 'worktree_open', { project: 'P1', repo: spelling, branch: i % 3 ? 'feature/x' : 'refs/heads/feature/x' })
      expect(r.status, r.text).toBe(200)
      ids.add(String(r.sc.worktree_id))
    }
    expect(ids.size).toBe(1)
    expect(wtRows()).toBe(1)
    const row = h.sqlite.prepare('SELECT kind, repo_key, ref_kind, ref_name, harness_id FROM worktrees').get()!
    expect(row).toMatchObject({ kind: 'git_branch', repo_key: 'github:mumega-com/mupot', ref_kind: 'branch', ref_name: 'feature/x', harness_id: '' })
  })

  it('first open says created, every later one says not created and returns the same id', async () => {
    const env = envFor()
    const a = await open(env, harnessAuth(W))
    const b = await open(env, harnessAuth(W))
    expect(a).toMatchObject({ ok: true, created: true })
    expect(b).toMatchObject({ ok: true, created: false })
    expect(a.ok && b.ok && a.worktree.id === b.worktree.id).toBe(true)
  })

  it('concurrent opens of one identity land on ONE row', async () => {
    const env = envFor()
    const rs = await Promise.all(Array.from({ length: 8 }, () => open(env, harnessAuth(W))))
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(new Set(rs.map((r) => (r.ok ? r.worktree.id : ''))).size).toBe(1)
    expect(rs.filter((r) => r.ok && r.created)).toHaveLength(1)
    expect(wtRows()).toBe(1)
  })

  it('two unrelated repos never collide, even on the same branch name and even on one project', async () => {
    h.sqlite.exec(`INSERT INTO project_repos (project_id, repo_key) VALUES ('P1','github:other-org/mupot'), ('P1','url:git.example.test/team/mupot')`)
    const env = envFor()
    const a = await open(env, harnessAuth(W), { repo: REPO, branch: 'main' })
    const b = await open(env, harnessAuth(W), { repo: 'https://github.com/Other-Org/mupot.git', branch: 'main' })
    const c = await open(env, harnessAuth(W), { repo: 'https://git.example.test/team/mupot.git', branch: 'main' })
    const ids = [a, b, c].map((r) => (r.ok ? r.worktree.id : 'FAIL'))
    expect(new Set(ids).size).toBe(3)
    expect(wtRows()).toBe(3)
  })

  it('branch and repo normalisation: a detached HEAD, a path-ish or remote ref, or an unsettled repo has no identity', async () => {
    expect(normalizeBranch('refs/heads/a/b')).toBe('a/b')
    for (const bad of ['HEAD', '', '   ', 'refs/remotes/origin/main', 'a..b', 'a b', '/abs', 'x/', 'x.lock', 'a\nb', 'a@{1}', 'a~1', 5, null]) {
      expect(normalizeBranch(bad), String(bad)).toBeNull()
    }
    expect(repoKeyFromUrl('https://github.com/owner')).toBeNull() // owner only
    expect(repoKeyFromUrl('not a url')).toBeNull()
    expect(repoKeyFromUrl('https://github.com/%E0%A4%A/x')).toBeNull() // undecodable: unsure
    const env = envFor()
    for (const a of [{ branch: 'HEAD' }, { branch: undefined }, { repo: 'https://github.com/Mumega-com' }, { repo: undefined }]) {
      const r = await open(env, harnessAuth(W), a)
      expect(r.ok).toBe(false)
    }
    expect(wtRows()).toBe(0)
  })

  it('last_head_sha / last_seen_at are display only: stamped on open, never an input to anything', async () => {
    const env = envFor()
    const a = await open(env, harnessAuth(W), { head_sha: 'ABCDEF1234567' })
    expect(a.ok && a.worktree.last_head_sha).toBe('abcdef1234567')
    expect(a.ok && a.worktree.last_seen_at).not.toBeNull()
    const b = await open(env, harnessAuth(W))
    expect(b.ok && b.worktree.last_head_sha).toBe('abcdef1234567') // an open without a sha keeps the last one
    expect((await open(env, harnessAuth(W), { head_sha: 'zzz' })).ok).toBe(false)
    // an UNAUTHORISED caller's sha is never written
    const denied = await open(env, harnessAuth(R), { head_sha: '1111111' })
    expect(denied.ok).toBe(false)
    expect(h.sqlite.prepare('SELECT last_head_sha AS s FROM worktrees').get()!.s).toBe('abcdef1234567')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('the repo must belong to the project', () => {
  it('a repo that is neither the project repo nor allow-listed is refused with repo_not_in_project and writes nothing', async () => {
    const env = envFor()
    const r = await open(env, harnessAuth(W), { repo: 'https://github.com/Other-Org/other.git' })
    expect(r).toMatchObject({ ok: false, error: 'repo_not_in_project' })
    expect(wtRows()).toBe(0)
  })

  it('through the tool: the refusal is the stable code', async () => {
    const env = envFor()
    const m = await mintHarness(env, W)
    const r = await rpc(env, m.raw, 'worktree_open', { project: 'P1', repo: 'https://github.com/evil/mupot', branch: 'main' })
    expect(r.text).toContain('repo_not_in_project')
    expect(wtRows()).toBe(0)
  })

  it('an allow-list entry on ANOTHER project does not authorise this one', async () => {
    h.sqlite.exec(`INSERT INTO project_repos (project_id, repo_key) VALUES ('P2','github:evil/mupot')`)
    const r = await open(envFor(), harnessAuth(W), { repo: 'https://github.com/evil/mupot' })
    expect(r).toMatchObject({ ok: false, error: 'repo_not_in_project' })
  })

  it('a project with NO repo_url accepts only allow-listed repos', async () => {
    const env = envFor()
    expect(await openWorktree(env, harnessAuth(W), { project: 'P3', repo: REPO, branch: 'main' })).toMatchObject({ ok: false, error: 'repo_not_in_project' })
    h.sqlite.exec(`INSERT INTO project_repos (project_id, repo_key) VALUES ('P3','github:mumega-com/mupot')`)
    expect(await openWorktree(env, harnessAuth(W), { project: 'P3', repo: REPO, branch: 'main' })).toMatchObject({ ok: true })
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('the harness door: worktree_open only, authorised by the human', () => {
  it('a harness token (ZERO capabilities) opens a workspace because the HUMAN can write the project', async () => {
    const env = envFor()
    const m = await mintHarness(env, W)
    const boot = await rpc(env, m.raw, 'boot_context', {})
    expect(boot.sc.capabilities).toEqual([]) // the session holds nothing
    const r = await rpc(env, m.raw, 'worktree_open', { project: 'mupot', repo: REPO, branch: 'main' }) // by slug
    expect(r.status, r.text).toBe(200)
    expect(typeof r.sc.worktree_id).toBe('string')
  })

  it('the door admits no other new tool: worktree_list and every project tool stay behind a seat', async () => {
    const env = envFor()
    const m = await mintHarness(env, W)
    for (const [tool, args] of [['worktree_list', { project: 'P1' }], ['project_list', {}], ['project_get', { id: 'P1' }], ['recall', { query: 'x' }]] as const) {
      const r = await rpc(env, m.raw, tool, args)
      expect(r.text, tool).toContain('harness_session_seat_required')
    }
  })

  it('a human with only READ access is refused (403 forbidden project_write) and nothing is written', async () => {
    const env = envFor()
    const m = await mintHarness(env, R)
    const r = await rpc(env, m.raw, 'worktree_open', { project: 'P1', repo: REPO, branch: 'main' })
    expect(r.text).toContain('project_write')
    expect(wtRows()).toBe(0)
  })

  it('a human with no access to the project does not learn it exists (project_not_found)', async () => {
    const env = envFor()
    const m = await mintHarness(env, X)
    const r = await rpc(env, m.raw, 'worktree_open', { project: 'P1', repo: REPO, branch: 'main' })
    expect(r.text).toContain('project_not_found')
    expect(r.text).not.toContain('project_write')
    expect(wtRows()).toBe(0)
  })

  it('an observer-rank squad grant on a write-linked squad is not write access', async () => {
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${W}'`)
    grant(W, 'SQ_W', 'observer')
    const r = await open(envFor(), harnessAuth(W))
    expect(r).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it('authority is the human\'s LIVE grants: revoking them refuses the next call', async () => {
    const env = envFor()
    expect((await open(env, harnessAuth(W))).ok).toBe(true)
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${W}'`)
    expect(await open(env, harnessAuth(W), { branch: 'other' })).toMatchObject({ ok: false })
  })

  it('a suspended human is refused', async () => {
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${W}'`)
    expect(await open(envFor(), harnessAuth(W))).toMatchObject({ ok: false, error: 'principal_required' })
  })

  it('an org-scope admin grant writes every project', async () => {
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-org-x', '${X}', 'org', NULL, 'admin')`)
    expect(await open(envFor(), harnessAuth(X))).toMatchObject({ ok: true })
  })

  it('an agent-bound caller uses its OWN capabilities: allowed only where its squad writes', async () => {
    const env = envFor()
    expect(await open(env, agentAuth('agent-member-1', [{ squad: 'SQ_W', cap: 'member' }]))).toMatchObject({ ok: true })
    expect(await open(env, agentAuth('agent-member-2', [{ squad: 'SQ_R', cap: 'member' }]))).toMatchObject({ ok: false, error: 'forbidden' })
    expect(await open(env, agentAuth('agent-member-3', [{ squad: 'SQ_O', cap: 'admin' }]))).toMatchObject({ ok: false, error: 'project_not_found' })
  })

  it('invokeTool reaches worktree_open for a harness-session context via the same chokepoint', async () => {
    const env = envFor()
    const out = await invokeTool(harnessAuth(W), env, 'worktree_open', { project: 'P1', repo: REPO, branch: 'main' })
    expect(out.ok).toBe(true)
    const denied = await invokeTool(harnessAuth(W), env, 'worktree_list', { project: 'P1' })
    expect(denied).toMatchObject({ ok: false, error: 'harness_session_seat_required' })
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('visibility and isolation', () => {
  it('worktree_list shows the project\'s workspaces to a reader and to a writer, to nobody else', async () => {
    const env = envFor()
    await open(env, harnessAuth(W), { branch: 'a' })
    await open(env, harnessAuth(W), { branch: 'b' })
    const asW = await listWorktrees(env, harnessAuth(W), { project: 'P1' })
    const asR = await listWorktrees(env, harnessAuth(R), { project: 'P1' })
    expect(asW.ok && asW.worktrees.map((w) => w.ref_name).sort()).toEqual(['a', 'b'])
    expect(asR.ok && asR.worktrees).toHaveLength(2)
    expect(await listWorktrees(env, harnessAuth(X), { project: 'P1' })).toMatchObject({ ok: false, error: 'project_not_found' })
    expect(await listWorktrees(env, harnessAuth(X), { project: 'mupot' })).toMatchObject({ ok: false, error: 'project_not_found' })
  })

  it('another squad cannot open on, or list, a project it has no access to; ids are not a side channel', async () => {
    const env = envFor()
    const made = await open(env, harnessAuth(W))
    expect(made.ok).toBe(true)
    const wrong = await openWorktree(env, harnessAuth(X), { project: 'P1', repo: REPO, branch: 'main' })
    expect(wrong).toMatchObject({ ok: false, error: 'project_not_found' })
    // X's own project lists none of P1's rows
    const own = await listWorktrees(env, harnessAuth(X), { project: 'P2' })
    expect(own.ok && own.worktrees).toEqual([])
  })

  it('a foreign tenant\'s rows are neither listed nor reused, and the same identity under another tenant is a separate row', async () => {
    const env = envFor()
    h.sqlite.exec(`INSERT INTO worktrees (id, tenant, project_id, kind, repo_key, harness_id, ref_kind, ref_name, created_by_member_id)
                   VALUES ('foreign-1', 'other-tenant', 'P1', 'git_branch', 'github:mumega-com/mupot', '', 'branch', 'main', '${W}')`)
    const listed = await listWorktrees(env, harnessAuth(W), { project: 'P1' })
    expect(listed.ok && listed.worktrees).toEqual([])
    const mine = await open(env, harnessAuth(W))
    expect(mine.ok && mine.worktree.id).not.toBe('foreign-1')
    expect(mine.ok && mine.created).toBe(true)
    expect(wtRows()).toBe(2)
  })

  it('archived workspaces are hidden from the list by default and refuse reopening', async () => {
    const env = envFor()
    const a = await open(env, harnessAuth(W))
    if (!a.ok) throw new Error('open failed')
    h.sqlite.exec(`UPDATE worktrees SET archived_at = '2026-10-12T00:00:00Z' WHERE id = '${a.worktree.id}'`)
    expect(await open(env, harnessAuth(W))).toMatchObject({ ok: false, error: 'worktree_archived' })
    const hidden = await listWorktrees(env, harnessAuth(W), { project: 'P1' })
    expect(hidden.ok && hidden.worktrees).toEqual([])
    const shown = await listWorktrees(env, harnessAuth(W), { project: 'P1', include_archived: true })
    expect(shown.ok && shown.worktrees).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('kinds: folder and thread, kept minimal', () => {
  it('a folder is project + a human-chosen slug; a machine path is refused; one row per slug', async () => {
    const env = envFor()
    const a = await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: 'Research-Notes' })
    const b = await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: 'research-notes' })
    expect(a).toMatchObject({ ok: true, created: true })
    expect(b).toMatchObject({ ok: true, created: false })
    expect(a.ok && b.ok && a.worktree.id === b.worktree.id).toBe(true)
    for (const bad of ['/home/me/notes', 'C:\\x', '../up', '~root', '.hidden', 'a/b', '', 'x'.repeat(65)]) {
      expect(await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: bad }), bad).toMatchObject({ ok: false })
    }
    expect(normalizeSlug('ok_1.2-x')).toBe('ok_1.2-x')
    expect(wtRows()).toBe(1)
  })

  it('fields that do not belong to the kind are refused, so a path cannot ride along', async () => {
    const env = envFor()
    expect(await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: 'x', branch: 'main' })).toMatchObject({ ok: false, error: 'invalid_args' })
    expect(await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: 'x', repo: REPO })).toMatchObject({ ok: false, error: 'invalid_args' })
    expect(await open(env, harnessAuth(W), { slug: 'x' })).toMatchObject({ ok: false, error: 'invalid_args' })
    expect(await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'bogus' })).toMatchObject({ ok: false, error: 'invalid_args' })
    expect(wtRows()).toBe(0)
  })

  it('a thread is scoped to ONE harness: the same thread id on two harnesses is two rows, on one harness one row', async () => {
    const env = envFor()
    const m1 = await mintHarness(env, W)
    const m2 = await mintHarness(env, W)
    const a = await openWorktree(env, harnessAuth(W, m1.harnessId, m1.tokenId), { project: 'P1', kind: 'thread', thread: 'th-1' })
    const a2 = await openWorktree(env, harnessAuth(W, m1.harnessId, m1.tokenId), { project: 'P1', kind: 'thread', thread: 'th-1' })
    const b = await openWorktree(env, harnessAuth(W, m2.harnessId, m2.tokenId), { project: 'P1', kind: 'thread', thread: 'th-1' })
    expect(a.ok && a2.ok && b.ok).toBe(true)
    expect(a.ok && a2.ok && a.worktree.id === a2.worktree.id).toBe(true)
    expect(a.ok && b.ok && a.worktree.id !== b.worktree.id).toBe(true)
    expect(normalizeThreadId('a b')).toBeNull()
  })

  it('a thread needs a harness that is the caller\'s own, verified live', async () => {
    const env = envFor()
    const mine = await mintHarness(env, W)
    const theirs = await mintHarness(env, R)
    // the harness door verifies the pointer live: absent, someone else's, or unknown all fail closed
    expect(await openWorktree(env, harnessAuth(W, null), { project: 'P1', kind: 'thread', thread: 't' })).toMatchObject({ ok: false, error: 'principal_required' })
    expect(await openWorktree(env, harnessAuth(W, theirs.harnessId, theirs.tokenId), { project: 'P1', kind: 'thread', thread: 't' })).toMatchObject({ ok: false, error: 'principal_required' })
    expect(await openWorktree(env, harnessAuth(W, 'no-such'), { project: 'P1', kind: 'thread', thread: 't' })).toMatchObject({ ok: false, error: 'principal_required' })
    // a seat-shaped caller that claims a harness it does not own is refused at the thread step
    const seatLike = { ...agentAuth('agent-member-1', [{ squad: 'SQ_W', cap: 'member' }]), seatBinding: { seatId: 's', label: 'l', harnessId: theirs.harnessId, grantTokenId: 'g', humanMemberId: W, source: 'handle' as const } }
    expect(await openWorktree(env, seatLike, { project: 'P1', kind: 'thread', thread: 't' })).toMatchObject({ ok: false, error: 'harness_required' })
    expect(await openWorktree(env, harnessAuth(W, mine.harnessId, mine.tokenId), { project: 'P1', kind: 'thread', thread: 't' })).toMatchObject({ ok: true })
  })

  it('the schema itself refuses a mis-shaped row, an identity edit, and a thread on an unknown harness', () => {
    const ins = (cols: string): void => h.sqlite.exec(`INSERT INTO worktrees (id, tenant, project_id, created_by_member_id, ${cols.split('|')[0]}) VALUES ('w-${Math.random()}', '${TENANT}', 'P1', '${W}', ${cols.split('|')[1]})`)
    expect(() => ins("kind, ref_kind, ref_name, repo_key|'folder','slug','x','github:a/b'")).toThrow()
    expect(() => ins("kind, ref_kind, ref_name|'git_branch','branch','main'")).toThrow() // no repo_key
    expect(() => ins("kind, ref_kind, ref_name, repo_key, harness_id|'git_branch','branch','main','github:a/b','h'")).toThrow()
    expect(() => ins("kind, ref_kind, ref_name, harness_id|'thread','thread','t','ghost-harness'")).toThrow(/worktree_harness_unknown/)
    ins("kind, ref_kind, ref_name, repo_key|'git_branch','branch','main','github:a/b'")
    expect(() => h.sqlite.exec(`UPDATE worktrees SET ref_name = 'moved'`)).toThrow(/worktree_identity_immutable/)
    expect(() => h.sqlite.exec(`UPDATE worktrees SET project_id = 'P2'`)).toThrow(/worktree_identity_immutable/)
    h.sqlite.exec(`UPDATE worktrees SET archived_at = '2026-10-12', last_head_sha = 'abcdef1'`) // archive + display columns stay editable
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('flag WORKSPACES off: no change', () => {
  it('unset and every non-"1" value refuse before any read or write, and the tools are not advertised', async () => {
    for (const v of [undefined, '0', 'true', '', 'on']) {
      const env = envFor({ WORKSPACES: v })
      const before = wtRows()
      const out = await invokeTool(harnessAuth(W), env, 'worktree_open', { project: 'P1', repo: REPO, branch: 'main' })
      expect(out, String(v)).toMatchObject({ ok: false, error: 'workspaces_disabled' })
      expect(await invokeTool(agentAuth('a', [{ squad: 'SQ_W', cap: 'admin' }]), env, 'worktree_list', { project: 'P1' })).toMatchObject({ ok: false, error: 'workspaces_disabled' })
      expect(await open(env, harnessAuth(W))).toMatchObject({ ok: false, error: 'workspaces_disabled' })
      // refused BEFORE schema validation: a flag-off pot never reveals the argument schema
      expect(await invokeTool(harnessAuth(W), env, 'worktree_open', {})).toMatchObject({ ok: false, error: 'workspaces_disabled' })
      expect(await invokeTool(agentAuth('a', [{ squad: 'SQ_W', cap: 'admin' }]), env, 'worktree_open', { bogus: 1 })).toMatchObject({ ok: false, error: 'workspaces_disabled' })
      expect(wtRows()).toBe(before)
      const names = advertisedTools(env).map((t) => t.name)
      expect(names).not.toContain('worktree_open')
      expect(names).not.toContain('worktree_list')
    }
    expect(advertisedTools(envFor()).map((t) => t.name)).toEqual(expect.arrayContaining(['worktree_open', 'worktree_list']))
    expect(TOOLS.map((t) => t.name)).toContain('worktree_open')
  })

  it('flag off: the OAuth harness upsert is the pre-WORKSPACES behaviour (keyed on the client, labels refresh)', async () => {
    const env = envFor({ WORKSPACES: undefined })
    const a = await upsertHarness(env, W, 'client-1', 'ChatGPT', 'grant-a')
    const b = await upsertHarness(env, W, 'client-1', 'ChatGPT v2', 'grant-b')
    expect(a?.id).toBe(b?.id)
    expect(n('SELECT COUNT(*) AS n FROM harnesses')).toBe(1)
    expect(h.sqlite.prepare('SELECT oauth_client_id AS c, client_name AS nm FROM harnesses').get()).toMatchObject({ c: 'client-1', nm: 'ChatGPT v2' })
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('4.0 harness identity is one GRANT', () => {
  it('two installs of a shared client_id are two harnesses; a refresh of one grant is the same harness', async () => {
    const env = envFor()
    const a1 = await upsertHarness(env, W, 'chatgpt-shared-client', 'ChatGPT', 'tok-install-A')
    const b = await upsertHarness(env, W, 'chatgpt-shared-client', 'ChatGPT', 'tok-install-B')
    const a2 = await upsertHarness(env, W, 'chatgpt-shared-client', 'ChatGPT (renamed)', 'tok-install-A')
    expect(a1?.id).not.toBe(b?.id)
    expect(a1?.id).toBe(a2?.id)
    expect(n('SELECT COUNT(*) AS n FROM harnesses')).toBe(2)
    expect(a1?.grant_id).toBe('oauth:tok-install-A')
    expect(a1?.oauth_client_id.startsWith('chatgpt-shared-client#')).toBe(true) // a label, not the key
    expect(h.sqlite.prepare(`SELECT client_name AS nm FROM harnesses WHERE id = ?`).get(a1!.id)).toMatchObject({ nm: 'ChatGPT (renamed)' })
  })

  it('grant isolation is per human: the same grant string under two members is two rows', async () => {
    const env = envFor()
    const a = await upsertHarness(env, W, 'c', 'Cursor', 'same')
    const b = await upsertHarness(env, R, 'c', 'Cursor', 'same')
    expect(a?.id).not.toBe(b?.id)
  })

  it('seat keys, per-harness caps and seats follow harnesses.id, so two installs do not share a seat', async () => {
    const env = envFor()
    const a = await upsertHarness(env, W, 'shared', 'ChatGPT', 'tok-A')
    const b = await upsertHarness(env, W, 'shared', 'ChatGPT', 'tok-B')
    const sa = await seatSelect(env, { channel: 'directory', boundAgentId: null, memberId: W, harnessId: a!.id, tokenId: 'tok-A' }, { project: 'p', folder: '/same/folder' })
    const sb = await seatSelect(env, { channel: 'directory', boundAgentId: null, memberId: W, harnessId: b!.id, tokenId: 'tok-B' }, { project: 'p', folder: '/same/folder' })
    expect(sa.ok && sb.ok).toBe(true)
    expect(sa.ok && sb.ok && sa.agent.id !== sb.agent.id).toBe(true)
    expect(n('SELECT COUNT(*) AS n FROM agent_seats')).toBe(2)
  })

  it('a pre-existing client-keyed harness keeps working after WORKSPACES is switched on: same id, same seat', async () => {
    const off = envFor({ WORKSPACES: undefined })
    const legacy = await upsertHarness(off, W, 'client-old', 'Cursor')
    const auth = { channel: 'directory' as const, boundAgentId: null, memberId: W, harnessId: legacy!.id, tokenId: 'tok-old' }
    const first = await seatSelect(off, auth, { project: 'p', folder: '/f' })
    const on = envFor()
    expect((await loadHarness(on, W, legacy!.id))?.id).toBe(legacy!.id)
    const again = await seatSelect(on, auth, { project: 'p', folder: '/f' })
    expect(first.ok && again.ok && first.seat.id === again.seat.id).toBe(true)
    expect(first.ok && again.ok && again.disposition).not.toBe('created')
  })

  it('token harnesses are one row per member_tokens row, grant = token:<id>', async () => {
    const env = envFor()
    const m1 = await mintHarness(env, W)
    const m2 = await mintHarness(env, W)
    const rows = h.sqlite.prepare(`SELECT id, grant_id AS g, token_id AS t FROM harnesses WHERE credential_kind = 'token'`).all()
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.g).toBe(`token:${String(r.t)}`)
    expect(m1.harnessId).not.toBe(m2.harnessId)
  })

  it('the schema pins the grant: unique per (tenant, member), immutable, shaped, defaulted for every writer', () => {
    const ins = (id: string, member: string, client: string, grantId: string | null): void => h.sqlite.exec(
      `INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, grant_id) VALUES ('${id}', '${TENANT}', '${member}', '${client}', ${grantId === null ? 'NULL' : `'${grantId}'`})`)
    ins('h-1', W, 'c1', 'oauth:g1')
    expect(() => ins('h-2', W, 'c2', 'oauth:g1')).toThrow(/UNIQUE/) // same grant, same member
    ins('h-3', R, 'c3', 'oauth:g1') // another member: fine
    expect(() => h.sqlite.exec(`UPDATE harnesses SET grant_id = 'oauth:other' WHERE id = 'h-1'`)).toThrow(/harness_grant_immutable/)
    expect(() => ins('h-4', W, 'c4', 'token:xyz')).toThrow(/harness_grant_shape|harness_credential_shape/) // squatting the token namespace
    expect(() => ins('h-5', W, 'c5', 'legacy:someone-else')).toThrow(/harness_grant_shape/)
    ins('h-6', W, 'c6', null) // a writer that picks no grant still gets one
    expect(h.sqlite.prepare(`SELECT grant_id AS g FROM harnesses WHERE id = 'h-6'`).get()!.g).toBe('legacy:h-6')
  })

  it('consent: two consents through one client_id are two harnesses with WORKSPACES on; flag off keeps one row', async () => {
    const consent = async (flagOn: boolean): Promise<void> => {
      const provider = {
        parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', scope: ['mcp:read', 'mcp:write'] })),
        completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
        lookupClient: vi.fn(async () => ({ clientName: 'ChatGPT' })),
      }
      const env = {
        DB: h.db, TENANT_SLUG: TENANT, BRAND: 'mupot', POT_TIER: 'scale', GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs',
        SESSIONS: kv(), OAUTH_PROVIDER: provider, BUS: { send: async () => {} }, SEAT_AUTO_ENROLL: '1', ...(flagOn ? { WORKSPACES: '1' } : {}),
      } as unknown as Env
      const authorize = await handleOAuthAuthorize(new Request(`${ORIGIN}/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256`), env)
      const nonce = /mupot_oauth_nonce=([^;]+)/.exec(authorize.headers.get('Set-Cookie') ?? '')![1]
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
        if (url.includes('googleapis.com/oauth2/v2/userinfo')) return new Response(JSON.stringify({ id: 'google-sub-w', name: 'W', email: `${W}@example.test`, verified_email: true }), { status: 200 })
        throw new Error(`unexpected fetch: ${url}`)
      }))
      const cb = await handleOAuthAuthorize(new Request(`${ORIGIN}/oauth/google-callback?code=abc&state=${nonce}`, { headers: { Cookie: `mupot_oauth_nonce=${nonce}` } }), env)
      const cn = /mupot_oauth_consent=([^;]+)/.exec(cb.headers.getSetCookie().find((c) => c.startsWith('mupot_oauth_consent=')) ?? '')![1]
      const res = await handleOAuthAuthorize(new Request(`${ORIGIN}/oauth/consent`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${cn}` },
        body: new URLSearchParams({ consent_nonce: cn, action: 'continue', agent_id: '__harness__' }).toString(),
      }), env)
      expect(res.status).toBe(302)
    }
    await consent(true)
    await consent(true)
    const on = h.sqlite.prepare(`SELECT grant_id AS g, oauth_client_id AS c FROM harnesses`).all()
    expect(on).toHaveLength(2)
    expect(new Set(on.map((r) => r.g)).size).toBe(2)
    for (const r of on) { expect(String(r.g).startsWith('oauth:')).toBe(true); expect(String(r.c).startsWith('client-1#')).toBe(true) }
    // each grant's id is its OWN consent token, which rides in the grant props
    for (const r of on) expect(n(`SELECT COUNT(*) AS n FROM member_tokens WHERE id = ?`, String(r.g).slice('oauth:'.length))).toBe(1)

    h.sqlite.exec('DELETE FROM harnesses')
    await consent(false)
    await consent(false)
    expect(n('SELECT COUNT(*) AS n FROM harnesses')).toBe(1)
    expect(h.sqlite.prepare('SELECT oauth_client_id AS c FROM harnesses').get()!.c).toBe('client-1')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('backfill (migration 0216 over a populated pre-0216 schema)', () => {
  it('every existing OAuth row becomes its own legacy grant, token rows keep token:<id>, ids and seats are untouched', () => {
    const pre = createSqliteD1()
    try {
      const files = migrationFiles()
      const idx = files.indexOf('0216_workspaces.sql')
      expect(idx).toBeGreaterThan(0)
      for (const f of files.slice(0, idx)) pre.sqlite.exec(readFileSync(join(__dirname, '..', 'migrations', f), 'utf8'))
      pre.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('m1','m1@x.test','m1','active','2026-10-01','${TENANT}'),('m2','m2@x.test','m2','active','2026-10-01','${TENANT}');
        INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, harness_kind) VALUES ('tk1','m1','hash-tk1','harness:ci','directory','2026-10-01','${TENANT}','ci');
        INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, client_name, kind) VALUES
          ('ha','${TENANT}','m1','shared-client','ChatGPT','chatgpt'),
          ('hb','${TENANT}','m2','shared-client','ChatGPT','chatgpt'),
          ('hc','${TENANT}','m2','other-client','Cursor','cursor');
        INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, client_name, kind, credential_kind, token_id) VALUES ('ht','${TENANT}','m1','token:tk1','ci','ci','token','tk1');
      `)
      pre.sqlite.exec(readFileSync(join(__dirname, '..', 'migrations', '0216_workspaces.sql'), 'utf8'))
      const rows = pre.sqlite.prepare('SELECT id, grant_id AS g FROM harnesses ORDER BY id').all()
      expect(rows).toEqual([
        { id: 'ha', g: 'legacy:ha' }, { id: 'hb', g: 'legacy:hb' }, { id: 'hc', g: 'legacy:hc' }, { id: 'ht', g: 'token:tk1' },
      ])
      expect(new Set(rows.map((r) => r.g)).size).toBe(4)
      // a new grant-keyed row for the SAME client + member now coexists with the legacy one
      pre.sqlite.exec(`INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, grant_id) VALUES ('hn','${TENANT}','m1','shared-client#oauth:new','oauth:new')`)
      expect(Number(pre.sqlite.prepare('SELECT COUNT(*) AS n FROM harnesses').get()!.n)).toBe(5)
    } finally { pre.close() }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Gate round 1 fix pass
// ════════════════════════════════════════════════════════════════════════════
describe('FIX 1: the human-authority branch is the VERIFIED harness door only', () => {
  it('a plain unbound directory session with capabilities [] is refused like project_get, even though the human could write', async () => {
    const env = envFor()
    const plain: AuthContext = { userId: W, email: null, role: 'member', tenant: TENANT, memberId: W, channel: 'directory', capabilities: [], boundAgentId: null }
    expect(await open(env, plain)).toMatchObject({ ok: false, error: 'project_not_found' })
    expect(await listWorktrees(env, plain, { project: 'P1' })).toMatchObject({ ok: false, error: 'project_not_found' })
    const viaTool = await invokeTool(plain, env, 'worktree_open', { project: 'P1', repo: REPO, branch: 'main' })
    expect(viaTool).toMatchObject({ ok: false })
    expect(wtRows()).toBe(0)
  })

  it('a consent-bound session whose capabilities were zeroed (the human was demoted) is refused, not revived with anything wider', async () => {
    const env = envFor()
    // the agent's dedicated member holds a raw write grant; the consent session's capabilities are zeroed
    member('agent-dedicated'); grant('agent-dedicated', 'SQ_W', 'admin')
    const demoted: AuthContext = {
      userId: 'agent-dedicated', email: null, role: 'member', tenant: TENANT, memberId: 'agent-dedicated', channel: 'directory',
      capabilities: [], boundAgentId: null, consentedByMemberId: W,
    }
    expect(await open(env, demoted)).toMatchObject({ ok: false, error: 'principal_required' })
    expect(await listWorktrees(env, demoted, { project: 'P1' })).toMatchObject({ ok: false, error: 'principal_required' })
    expect(wtRows()).toBe(0)
  })

  it('the session\'s own capabilities are used as they are: a plain session WITH a write grant opens', async () => {
    const own: AuthContext = {
      userId: W, email: null, role: 'member', tenant: TENANT, memberId: W, channel: 'directory', boundAgentId: null,
      capabilities: [{ member_id: W, scope_type: 'squad', scope_id: 'SQ_W', capability: 'member' }],
    }
    expect(await open(envFor(), own)).toMatchObject({ ok: true })
  })

  it('the harness session still works (verified harness row), by OAuth harness and by token harness', async () => {
    const env = envFor()
    expect(await open(env, harnessAuth(W))).toMatchObject({ ok: true })
    const m = await mintHarness(env, W)
    expect(await open(env, harnessAuth(W, m.harnessId, m.tokenId), { branch: 'tok' })).toMatchObject({ ok: true })
  })

  it('a forged or mismatched harness pointer is refused: another member\'s harness, unknown id, wrong token for a token harness', async () => {
    const env = envFor()
    const mine = await mintHarness(env, W)
    const theirs = await mintHarness(env, R)
    expect(await open(env, harnessAuth(W, theirs.harnessId, theirs.tokenId))).toMatchObject({ ok: false, error: 'principal_required' })
    expect(await open(env, harnessAuth(W, 'ghost'))).toMatchObject({ ok: false, error: 'principal_required' })
    expect(await open(env, harnessAuth(W, mine.harnessId, 'some-other-token'))).toMatchObject({ ok: false, error: 'principal_required' })
    expect(await open(env, harnessAuth(W, mine.harnessId))).toMatchObject({ ok: false, error: 'principal_required' }) // token harness with no token
    expect(wtRows()).toBe(0)
  })

  it('a harness-flagged context that is ALSO agent-bound uses its own capabilities, never the human\'s', async () => {
    const env = envFor()
    const both = { ...harnessAuth(W), boundAgentId: 'agent-x' }
    expect(await open(env, both)).toMatchObject({ ok: false }) // own capabilities are []
    expect(wtRows()).toBe(0)
  })
})

describe('FIX 2: one write predicate, one project reader', () => {
  it('resolves by id before slug: a project whose slug equals another project\'s id never shadows it', async () => {
    h.sqlite.exec(`INSERT INTO projects (id, slug, name, status, repo_url) VALUES ('P4','P1','Decoy','active','${REPO}'); INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('P4','SQ_W','write');`)
    const r = await open(envFor(), harnessAuth(W))
    expect(r.ok && r.worktree.project_id).toBe('P1')
    const bySlug = await openWorktree(envFor(), harnessAuth(W), { project: 'norepo', kind: 'folder', slug: 'x' })
    expect(bySlug.ok && bySlug.worktree.project_id).toBe('P3')
  })

  it('a department-only grant matches project_remember (no new, wider predicate)', async () => {
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${W}'; INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-dept', '${W}', 'department', 'd1', 'member')`)
    // project_remember's predicate reads access.squadIds only (departments are not expanded), so a
    // department grant alone is not project write. This tool answers the same.
    expect(await open(envFor(), harnessAuth(W))).toMatchObject({ ok: false })
  })
})

describe('FIX 3: thread rows belong to their owner', () => {
  it('another writer and a project reader never see (or get ids of) someone else\'s thread rows; the owner does', async () => {
    member('member-writer2'); grant('member-writer2', 'SQ_W', 'member')
    const env = envFor()
    const t = await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'thread', thread: 'secret-thread-1' })
    expect(t.ok).toBe(true)
    await open(env, harnessAuth(W))
    await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: 'shared-notes' })
    const own = await listWorktrees(env, harnessAuth(W), { project: 'P1' })
    expect(own.ok && own.worktrees.map((x) => x.kind).sort()).toEqual(['folder', 'git_branch', 'thread'])
    for (const who of ['member-writer2', R]) {
      const other = await listWorktrees(env, harnessAuth(who), { project: 'P1' })
      expect(other.ok && other.worktrees.map((x) => x.kind).sort(), who).toEqual(['folder', 'git_branch'])
      expect(JSON.stringify(other), who).not.toContain('secret-thread-1')
      expect(JSON.stringify(other), who).not.toContain('hx-' + W)
    }
    // a seat/agent caller reads only the threads of the human behind it
    const seatOfW = { ...agentAuth('agent-member-1', [{ squad: 'SQ_W', cap: 'member' }]), seatBinding: { seatId: 's', label: 'l', harnessId: 'hx-' + W, grantTokenId: 'g', humanMemberId: W, source: 'handle' as const } }
    const viaSeat = await listWorktrees(env, seatOfW, { project: 'P1' })
    expect(viaSeat.ok && viaSeat.worktrees.some((x) => x.kind === 'thread')).toBe(true)
    const plainAgent = await listWorktrees(env, agentAuth('agent-member-2', [{ squad: 'SQ_W', cap: 'member' }]), { project: 'P1' })
    expect(plainAgent.ok && plainAgent.worktrees.some((x) => x.kind === 'thread')).toBe(false)
  })
})

describe('FIX 4: creation caps and cursor pagination', () => {
  const seed = (member_id: string, kind: 'folder' | 'git_branch', count: number, tag: string): void => {
    for (let i = 0; i < count; i += 1) {
      if (kind === 'folder') {
        h.sqlite.exec(`INSERT INTO worktrees (id, tenant, project_id, kind, repo_key, harness_id, ref_kind, ref_name, created_by_member_id) VALUES ('${tag}-${i}', '${TENANT}', 'P1', 'folder', '', '', 'slug', '${tag}-${i}', '${member_id}')`)
      } else {
        h.sqlite.exec(`INSERT INTO worktrees (id, tenant, project_id, kind, repo_key, harness_id, ref_kind, ref_name, created_by_member_id) VALUES ('${tag}-${i}', '${TENANT}', 'P1', 'git_branch', 'github:mumega-com/mupot', '', 'branch', '${tag}-${i}', '${member_id}')`)
      }
    }
  }

  it('folder + thread rows are capped at 200 per member per project, atomically, and a reopen at the cap still works', async () => {
    const env = envFor()
    seed(W, 'folder', 199, 'f')
    expect(await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: 'the-200th' })).toMatchObject({ ok: true, created: true })
    expect(await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: 'the-201st' })).toMatchObject({ ok: false, error: 'worktree_cap_reached' })
    expect(await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: 'the-200th' })).toMatchObject({ ok: true, created: false })
    expect(await openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'thread', thread: 'th' })).toMatchObject({ ok: false, error: 'worktree_cap_reached' })
    expect(n(`SELECT COUNT(*) AS n FROM worktrees WHERE created_by_member_id = ?`, W)).toBe(200)
    // per member and per project: another member, and a branch by the same member, are unaffected
    member('member-writer2'); grant('member-writer2', 'SQ_W', 'member')
    expect(await openWorktree(env, harnessAuth('member-writer2'), { project: 'P1', kind: 'folder', slug: 'ok' })).toMatchObject({ ok: true })
    expect(await open(env, harnessAuth(W))).toMatchObject({ ok: true })
    expect(await openWorktree(env, harnessAuth(W), { project: 'P3', kind: 'folder', slug: 'other-project' })).toMatchObject({ ok: true })
  })

  it('branches are capped at 1000 per member per project', async () => {
    const env = envFor()
    seed(W, 'git_branch', 1000, 'b')
    expect(await open(env, harnessAuth(W), { branch: 'one-too-many' })).toMatchObject({ ok: false, error: 'worktree_cap_reached' })
    expect(await open(env, harnessAuth(W), { branch: 'b-5' })).toMatchObject({ ok: true, created: false })
  })

  it('concurrent creations cannot overshoot the cap', async () => {
    const env = envFor()
    seed(W, 'folder', 195, 'f')
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => openWorktree(env, harnessAuth(W), { project: 'P1', kind: 'folder', slug: `race-${i}` })))
    expect(rs.filter((r) => r.ok)).toHaveLength(5)
    expect(n(`SELECT COUNT(*) AS n FROM worktrees WHERE created_by_member_id = ?`, W)).toBe(200)
  })

  it('list is branch-first and paginated by an opaque cursor with no gaps or repeats', async () => {
    const env = envFor()
    const a = harnessAuth(W)
    await openWorktree(env, a, { project: 'P1', kind: 'thread', thread: 't-1' })
    for (const f of ['f1', 'f2', 'f3']) await openWorktree(env, a, { project: 'P1', kind: 'folder', slug: f })
    for (const b of ['b1', 'b2', 'b3', 'b4']) await open(env, a, { branch: b })
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: Awaited<ReturnType<typeof listWorktrees>> = await listWorktrees(env, a, { project: 'P1', limit: 3, ...(cursor ? { cursor } : {}) })
      if (!page.ok) throw new Error('list failed')
      expect(page.worktrees.length).toBeLessThanOrEqual(3)
      seen.push(...page.worktrees.map((x) => `${x.kind}:${x.ref_name}`))
      cursor = page.next_cursor
      pages += 1
    } while (cursor && pages < 10)
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(8)
    expect(seen.slice(0, 4).every((x) => x.startsWith('git_branch:'))).toBe(true)
    expect(seen.slice(4, 7).every((x) => x.startsWith('folder:'))).toBe(true)
    expect(seen[7]).toBe('thread:t-1')
  })

  it('bad limit and forged cursors are refused', async () => {
    const env = envFor()
    for (const limit of [0, -1, 201, 1.5, '5']) expect(await listWorktrees(env, harnessAuth(W), { project: 'P1', limit })).toMatchObject({ ok: false, error: 'invalid_args' })
    for (const cursor of ['x', '9|a|b', '1|2', 5, '%E0|a|b']) expect(await listWorktrees(env, harnessAuth(W), { project: 'P1', cursor })).toMatchObject({ ok: false, error: 'invalid_args' })
  })
})

describe('FIX 5: re-consent churn', () => {
  const tok = (id: string, memberId: string, revokedDaysAgo: number | null): void => {
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, revoked_at)
                   VALUES ('${id}', '${memberId}', 'hash-${id}', 'oauth:x', 'directory', '2026-10-01', '${TENANT}', ${revokedDaysAgo === null ? 'NULL' : `strftime('%Y-%m-%d %H:%M:%S', 'now', '-${revokedDaysAgo} days')`})`)
  }
  const grantOf = (id: string): string => String(h.sqlite.prepare('SELECT grant_id AS g FROM harnesses WHERE id = ?').get(id)!.g)

  it('a re-consent after the prior grant was revoked ADOPTS the harness (same id, grant moves) and its seat survives', async () => {
    const env = envFor()
    tok('tA', W, null); tok('tB', W, null)
    const first = await upsertHarness(env, W, 'client-1', 'ChatGPT', 'tA')
    const seat1 = await seatSelect(env, { channel: 'directory', boundAgentId: null, memberId: W, harnessId: first!.id, tokenId: 'tA' }, { project: 'p', folder: '/f' })
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = strftime('%Y-%m-%d %H:%M:%S','now') WHERE id = 'tA'`)
    const second = await upsertHarness(env, W, 'client-1', 'ChatGPT', 'tB')
    expect(second?.id).toBe(first?.id)
    expect(grantOf(first!.id)).toBe('oauth:tB')
    expect(n('SELECT COUNT(*) AS n FROM harnesses')).toBe(1)
    const seat2 = await seatSelect(env, { channel: 'directory', boundAgentId: null, memberId: W, harnessId: second!.id, tokenId: 'tB' }, { project: 'p', folder: '/f' })
    expect(seat1.ok && seat2.ok && seat1.seat.id === seat2.seat.id).toBe(true)
    expect(n('SELECT COUNT(*) AS n FROM agent_seats')).toBe(1)
  })

  it('repeated revoke + re-consent never grows harnesses or seats', async () => {
    const env = envFor()
    let prev = 'g0'
    tok(prev, W, null)
    const h0 = await upsertHarness(env, W, 'client-1', 'ChatGPT', prev)
    for (let i = 1; i <= 6; i += 1) {
      h.sqlite.exec(`UPDATE member_tokens SET revoked_at = strftime('%Y-%m-%d %H:%M:%S','now') WHERE id = '${prev}'`)
      const next = `g${i}`
      tok(next, W, null)
      const again = await upsertHarness(env, W, 'client-1', 'ChatGPT', next)
      expect(again?.id).toBe(h0?.id)
      prev = next
    }
    expect(n('SELECT COUNT(*) AS n FROM harnesses')).toBe(1)
  })

  it('a still-LIVE prior grant (a second machine) is never adopted: two installs stay two harnesses', async () => {
    const env = envFor()
    tok('tA', W, null); tok('tB', W, null)
    const a = await upsertHarness(env, W, 'client-1', 'ChatGPT', 'tA')
    const b = await upsertHarness(env, W, 'client-1', 'ChatGPT', 'tB')
    expect(a?.id).not.toBe(b?.id)
    expect(grantOf(a!.id)).toBe('oauth:tA')
  })

  it('outside the window, another client, another member, or a legacy row: a fresh harness', async () => {
    const env = envFor()
    tok('old', W, 45); tok('c2', W, null); tok('c3', W, null); tok('c4', R, null)
    const a = await upsertHarness(env, W, 'client-1', 'ChatGPT', 'old')
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = strftime('%Y-%m-%d %H:%M:%S','now','-45 days') WHERE id = 'old'`)
    expect((await upsertHarness(env, W, 'client-1', 'ChatGPT', 'c2'))?.id).not.toBe(a?.id) // 45 days: expired window
    tok('rv', W, 1)
    const b = await upsertHarness(env, W, 'client-9', 'Cursor', 'rv')
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = strftime('%Y-%m-%d %H:%M:%S','now') WHERE id = 'rv'`)
    expect((await upsertHarness(env, W, 'client-OTHER', 'Cursor', 'c3'))?.id).not.toBe(b?.id) // different client
    expect((await upsertHarness(env, R, 'client-9', 'Cursor', 'c4'))?.id).not.toBe(b?.id) // different member
    const legacy = await upsertHarness(envFor({ WORKSPACES: undefined }), W, 'client-L', 'Cursor')
    tok('c5', W, null)
    expect((await upsertHarness(env, W, 'client-L', 'Cursor', 'c5'))?.id).not.toBe(legacy?.id)
  })

  it('concurrent consents after a revoke: exactly one adopts the harness, the other gets its own (no two live grants on one harness)', async () => {
    const env = envFor()
    tok('tA', W, null); tok('tB', W, null); tok('tC', W, null)
    const a = await upsertHarness(env, W, 'client-1', 'ChatGPT', 'tA')
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = strftime('%Y-%m-%d %H:%M:%S','now') WHERE id = 'tA'`)
    const [b, c] = await Promise.all([upsertHarness(env, W, 'client-1', 'ChatGPT', 'tB'), upsertHarness(env, W, 'client-1', 'ChatGPT', 'tC')])
    expect([b?.id, c?.id].filter((x) => x === a?.id)).toHaveLength(1)
    expect(new Set([b?.id, c?.id]).size).toBe(2)
    const grants = h.sqlite.prepare('SELECT grant_id AS g FROM harnesses').all().map((r) => r.g)
    expect(new Set(grants).size).toBe(grants.length)
  })

  it('the schema permits the grant move ONLY from a revoked grant to a live grant of the same member', () => {
    tok('tA', W, null); tok('tB', W, null); tok('tR', R, null)
    h.sqlite.exec(`INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, grant_id) VALUES ('hh', '${TENANT}', '${W}', 'c#oauth:tA', 'oauth:tA')`)
    expect(() => h.sqlite.exec(`UPDATE harnesses SET grant_id = 'oauth:tB' WHERE id = 'hh'`)).toThrow(/harness_grant_immutable/) // old grant still live
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = strftime('%Y-%m-%d %H:%M:%S','now') WHERE id = 'tA'`)
    expect(() => h.sqlite.exec(`UPDATE harnesses SET grant_id = 'oauth:tR' WHERE id = 'hh'`)).toThrow(/harness_grant_immutable/) // someone else's token
    expect(() => h.sqlite.exec(`UPDATE harnesses SET grant_id = 'oauth:nope' WHERE id = 'hh'`)).toThrow(/harness_grant_immutable/) // no such token
    expect(() => h.sqlite.exec(`UPDATE harnesses SET grant_id = 'legacy:hh' WHERE id = 'hh'`)).toThrow(/harness_grant_immutable/) // not an oauth grant
    h.sqlite.exec(`UPDATE harnesses SET grant_id = 'oauth:tB' WHERE id = 'hh'`)
    expect(grantOf('hh')).toBe('oauth:tB')
  })
})

describe('P3s', () => {
  it('repo keys: network repos only; non-GitHub path case is preserved; GitHub still folds', () => {
    for (const bad of ['file:///srv/repos/mupot.git', '/srv/repos/mupot', './mupot', '../mupot', '~/mupot', 'C:\\work\\mupot', 'C:/work/mupot', 'mupot', '']) {
      expect(repoKeyFromUrl(bad), bad).toBeNull()
    }
    expect(repoKeyFromUrl('https://git.example.test/Team/Repo.git')).toBe('url:git.example.test/Team/Repo')
    expect(repoKeyFromUrl('git@GIT.example.test:Team/Repo.git')).toBe('url:git.example.test/Team/Repo')
    expect(repoKeyFromUrl('https://git.example.test/team/repo')).not.toBe(repoKeyFromUrl('https://git.example.test/Team/Repo'))
    expect(repoKeyFromUrl('https://GitHub.com/Mumega-Com/Mupot.git')).toBe('github:mumega-com/mupot')
  })

  it('two repos differing only by path case on a self-hosted forge never collide', async () => {
    h.sqlite.exec(`INSERT INTO project_repos (project_id, repo_key) VALUES ('P1','url:git.example.test/Team/Repo'), ('P1','url:git.example.test/team/repo')`)
    const env = envFor()
    const a = await open(env, harnessAuth(W), { repo: 'https://git.example.test/Team/Repo.git' })
    const b = await open(env, harnessAuth(W), { repo: 'https://git.example.test/team/repo.git' })
    expect(a.ok && b.ok && a.worktree.id !== b.worktree.id).toBe(true)
  })

  it('a file:// repo is refused as invalid_args even if someone allow-listed a look-alike', async () => {
    const r = await open(envFor(), harnessAuth(W), { repo: 'file:///srv/repos/mupot.git' })
    expect(r).toMatchObject({ ok: false, error: 'invalid_args' })
  })

  it('a harness that a thread worktree names cannot be deleted out from under it', async () => {
    const env = envFor()
    const a = harnessAuth(W)
    await openWorktree(env, a, { project: 'P1', kind: 'thread', thread: 'th' })
    expect(() => h.sqlite.exec(`DELETE FROM harnesses WHERE id = 'hx-${W}'`)).toThrow(/harness_has_worktrees/)
    h.sqlite.exec(`DELETE FROM worktrees WHERE harness_id = 'hx-${W}'`)
    h.sqlite.exec(`DELETE FROM harnesses WHERE id = 'hx-${W}'`)
  })
})
