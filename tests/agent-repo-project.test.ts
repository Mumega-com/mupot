// tests/agent-repo-project.test.ts — "an agent knows what project it is part of" from the repo it works in (S1).
// Real sqlite D1 over the whole migration chain. Covers: repo_project on boot_context / seat_select, worktree_open
// without `project` + clone spec (no token), and the guarded project_repos writer on project_update.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool as rawInvoke } from '../src/mcp/index'
import { openWorktree } from '../src/workspaces/service'
import { resolveCallerRepoProject, cloneSpecFor } from '../src/workspaces/repo-project'
import { setProjectRepo } from '../src/workspaces/project-repos'
import { resolveCapabilities } from '../src/auth/capability'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const W = 'member-writer'
const R = 'member-reader'
const X = 'member-outsider'
const REPO = 'https://github.com/Mumega-com/mupot.git'
const REPO_OTHER = 'https://github.com/Other-Org/other.git'
const REPO_SHARED = 'https://git.example.com/Team/Shared.git' // owned by P2 (repo_url) AND P5 (allow-list), both writable by W
const REPO_NOBODY = 'https://github.com/nobody/nothing.git'

let h: SqliteD1Harness
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)

function envFor(): Env {
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test', SESSIONS: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    OAUTH_KV: { get: async () => null, put: async () => undefined }, SEAT_AUTO_ENROLL: '1', SEAT_MAX_PER_MEMBER: '100', WORKSPACES: '1',
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
      ('P2','other','Other','active','${REPO_OTHER}'),
      ('P3','norepo','No repo','active',NULL),
      ('P4','shared-a','Shared A','active','${REPO_SHARED}'),
      ('P5','shared-b','Shared B','active',NULL);
    INSERT INTO project_repos (project_id, repo_key) VALUES ('P5','url:git.example.com/Team/Shared');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('P1','SQ_W','write'),('P1','SQ_R','read'),('P2','SQ_O','write'),('P3','SQ_W','write'),
      ('P4','SQ_W','write'),('P5','SQ_W','write');
  `)
  for (const m of [W, R, X]) member(m)
  h.sqlite.exec(`INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-08-01T00:00:00.000Z')`)
  grant(W, 'SQ_W', 'member'); grant(R, 'SQ_R', 'member'); grant(X, 'SQ_O', 'member')
})
afterEach(() => { h.close() })

/** invokeTool flattened to { status, body }: ok -> 200 + result; refusal -> its status + { error, detail }. */
async function invokeTool(auth: AuthContext, env: Env, name: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const out = await rawInvoke(auth, env, name, args)
  return out.ok ? { status: 200, body: out.result } : { status: out.status, body: { error: out.error, detail: out.detail } }
}

async function humanCtx(env: Env, memberId: string): Promise<AuthContext> {
  return { userId: memberId, email: null, role: 'member', tenant: TENANT, memberId, channel: 'workspace', capabilities: await resolveCapabilities(env, memberId) }
}

/** A real OAuth harness for the member (zero capabilities by design): the door worktree_open resolves the human through. */
function harnessAuth(memberId: string): AuthContext {
  const hid = `hx-${memberId}`
  const tok = `tok-hx-${memberId}`
  h.sqlite.exec(`INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tok}', '${memberId}', 'hash-${tok}', 'oauth:client-${memberId}', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  h.sqlite.exec(`INSERT OR IGNORE INTO harnesses (id, tenant, member_id, oauth_client_id, credential_kind, grant_id) VALUES ('${hid}', '${TENANT}', '${memberId}', 'client-${memberId}#oauth:${tok}', 'oauth', 'oauth:${tok}')`)
  return { userId: memberId, email: null, role: 'member', tenant: TENANT, memberId, channel: 'directory', capabilities: [], latentCapabilities: [], boundAgentId: null, harnessId: hid, tokenId: tok }
}

describe('resolveCallerRepoProject: exactly one readable owner, or null with a reason', () => {
  it('a unique owner resolves, in any spelling of the remote', async () => {
    const env = envFor(); const w = await humanCtx(env, W)
    for (const spelling of [REPO, 'git@github.com:Mumega-com/mupot.git', 'https://github.com/mumega-com/mupot']) {
      expect(await resolveCallerRepoProject(env, w, spelling)).toEqual({ project: { id: 'P1', slug: 'mupot', name: 'Mupot' }, repo_key: 'github:mumega-com/mupot' })
    }
  })
  it('an unknown repo is null + unknown_repo + an ask-your-owner hint', async () => {
    const env = envFor()
    const r = await resolveCallerRepoProject(env, await humanCtx(env, W), REPO_NOBODY)
    expect(r).toMatchObject({ project: null, reason: 'unknown_repo' })
    expect((r as { hint: string }).hint).toMatch(/ask your owner/i)
  })
  it('an ambiguous repo (two readable owners) is null + ambiguous_repo, never a guess', async () => {
    const env = envFor()
    const r = await resolveCallerRepoProject(env, await humanCtx(env, W), REPO_SHARED)
    expect(r).toMatchObject({ project: null, reason: 'ambiguous_repo' })
    expect((r as { hint: string }).hint).toMatch(/ask your owner/i)
  })
  it('a project the caller cannot read is never returned, and its existence is not hinted at', async () => {
    const env = envFor()
    const w = await humanCtx(env, W)
    const r = await resolveCallerRepoProject(env, w, REPO_OTHER) // owned only by P2, which W cannot read
    expect(r).toMatchObject({ project: null, reason: 'unknown_repo' })
    expect(JSON.stringify(r)).not.toMatch(/P2|"other"/)
    // and one unreadable co-owner does not turn a unique readable owner ambiguous or leak: X reads P2 only
    const x = await humanCtx(env, X)
    expect(await resolveCallerRepoProject(env, x, REPO)).toMatchObject({ project: null, reason: 'unknown_repo' })
    expect(await resolveCallerRepoProject(env, x, REPO_OTHER)).toMatchObject({ project: { id: 'P2' } })
  })
  it('a local path / missing repo is not an identity', async () => {
    const env = envFor(); const w = await humanCtx(env, W)
    expect(await resolveCallerRepoProject(env, w, '/home/me/code')).toMatchObject({ project: null, reason: 'invalid_repo' })
    expect(await resolveCallerRepoProject(env, w, undefined)).toMatchObject({ project: null, reason: 'repo_required' })
  })
})

describe('boot_context / seat_select answer repo_project', () => {
  it('boot_context { repo, branch } returns the project; an unknown repo returns null + reason; no repo omits the field', async () => {
    const env = envFor(); const w = await humanCtx(env, W)
    const ok = await invokeTool(w, env, 'boot_context', { repo: REPO, branch: 'refs/heads/feat/x' })
    expect(ok.status).toBe(200)
    expect((ok.body as { repo_project: unknown }).repo_project).toMatchObject({ project: { id: 'P1', slug: 'mupot' }, branch: 'feat/x' })
    const none = await invokeTool(w, env, 'boot_context', { repo: REPO_NOBODY })
    expect((none.body as { repo_project: unknown }).repo_project).toMatchObject({ project: null, reason: 'unknown_repo' })
    const bare = await invokeTool(w, env, 'boot_context', {})
    expect(bare.body).not.toHaveProperty('repo_project')
  })
  it('boot_context never returns a project the caller cannot read', async () => {
    const env = envFor()
    const out = await invokeTool(await humanCtx(env, W), env, 'boot_context', { repo: REPO_OTHER })
    expect((out.body as { repo_project: unknown }).repo_project).toMatchObject({ project: null })
  })
  it('the boot instructions tell the agent to pass git remote get-url origin', async () => {
    const { MUPOT_MCP_INITIALIZE_INSTRUCTIONS } = await import('../src/mcp/instructions')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('git remote get-url origin')
  })
  it('seat_select { repo } resolves with the human\'s grants (a seat session carries none)', async () => {
    const env = envFor()
    const out = await invokeTool(harnessAuth(W), env, 'seat_select', { project: 'mupot', repo: REPO, branch: 'main' })
    expect(out.status).toBe(200)
    expect((out.body as { repo_project: unknown }).repo_project).toMatchObject({ project: { id: 'P1' } })
    const out2 = await invokeTool(harnessAuth(X), env, 'seat_select', { project: 'p', repo: REPO })
    expect((out2.body as { repo_project: unknown }).repo_project).toMatchObject({ project: null })
  })
})

describe('worktree_open without `project`', () => {
  it('resolves the project from the repo and returns a clone spec with no token', async () => {
    const env = envFor()
    const secretRepo = 'https://x-access-token:ghs_SECRETSECRET@github.com/Mumega-com/mupot.git'
    const out = await invokeTool(harnessAuth(W), env, 'worktree_open', { repo: secretRepo, branch: 'feat/y' })
    expect(out.status).toBe(200)
    const b = out.body as Record<string, unknown>
    expect(b).toMatchObject({ project_id: 'P1', repo_key: 'github:mumega-com/mupot', clone_url: 'https://github.com/mumega-com/mupot.git', suggested_dir: 'mupot/feat/y' })
    expect(JSON.stringify(b)).not.toMatch(/ghs_|SECRET|x-access-token|@github/)
    expect(n('SELECT COUNT(*) AS n FROM worktrees WHERE project_id = ?', 'P1')).toBe(1)
  })
  it('refuses an ambiguous or unknown repo with project_unresolved, and writes nothing', async () => {
    const env = envFor()
    for (const repo of [REPO_SHARED, REPO_NOBODY, REPO_OTHER]) {
      const r = await openWorktree(env, harnessAuth(W), { repo, branch: 'main' })
      expect(r).toMatchObject({ ok: false, error: 'project_unresolved' })
    }
    expect(n('SELECT COUNT(*) AS n FROM worktrees')).toBe(0)
  })
  it('without project and without repo is still invalid_args; a reader resolves but cannot write', async () => {
    const env = envFor()
    expect(await openWorktree(env, harnessAuth(W), { branch: 'main' })).toMatchObject({ ok: false, error: 'invalid_args' })
    expect(await openWorktree(env, harnessAuth(W), { kind: 'folder', slug: 'x' })).toMatchObject({ ok: false, error: 'invalid_args' })
    expect(await openWorktree(env, harnessAuth(R), { repo: REPO, branch: 'main' })).toMatchObject({ ok: false, error: 'forbidden' })
  })
  it('stays behind WORKSPACES', async () => {
    const env = { ...envFor(), WORKSPACES: undefined } as unknown as Env
    expect(await openWorktree(env, harnessAuth(W), { repo: REPO, branch: 'main' })).toMatchObject({ ok: false, error: 'workspaces_disabled' })
  })
  it('clone spec is derived from the key prefix as data', () => {
    expect(cloneSpecFor('github:a/b', 's', 'main')).toMatchObject({ clone_url: 'https://github.com/a/b.git', suggested_dir: 's/main' })
    expect(cloneSpecFor('url:git.example.com:8443/T/R', 's', 'x')).toMatchObject({ clone_url: 'https://git.example.com:8443/T/R.git' })
    expect(cloneSpecFor('url:git.example.com/Team/Repo#one', 's', 'x').clone_url).toBe('https://git.example.com/Team/Repo%23one.git')
    expect(cloneSpecFor('weird:thing', 's', 'x').clone_url).toBeNull()
  })
})

describe('project_repos writer (project_update add_repo / remove_repo)', () => {
  const NEW_REPO = 'git@github.com:Mumega-com/extra.git'
  it('refuses a caller without write access (read-only), and one who cannot even read the project', async () => {
    const env = envFor()
    expect(await setProjectRepo(env, await humanCtx(env, R), { project_id: 'P1', op: 'add', repo: NEW_REPO })).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    expect(await setProjectRepo(env, await humanCtx(env, X), { project_id: 'P1', op: 'add', repo: NEW_REPO })).toMatchObject({ ok: false, status: 404 })
    expect(n('SELECT COUNT(*) AS n FROM project_repos WHERE project_id = ?', 'P1')).toBe(0)
    expect(n('SELECT COUNT(*) AS n FROM mutation_audit_entries')).toBe(0)
  })
  it('a writer adds a canonical key and a receipt; a repeat is idempotent with no second receipt; remove deletes', async () => {
    const env = envFor(); const w = await humanCtx(env, W)
    const a = await setProjectRepo(env, w, { project_id: 'P1', op: 'add', repo: NEW_REPO })
    expect(a).toMatchObject({ ok: true, changed: true, repo_key: 'github:mumega-com/extra', repos: ['github:mumega-com/extra'] })
    expect(n("SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE handler = 'project_repos' AND target_id = 'P1' AND operation = 'add'")).toBe(1)
    expect(await setProjectRepo(env, w, { project_id: 'P1', op: 'add', repo: 'https://github.com/mumega-com/extra' })).toMatchObject({ ok: true, changed: false, receipt_id: null })
    expect(n('SELECT COUNT(*) AS n FROM mutation_audit_entries')).toBe(1)
    // and the allow-list is now honoured by worktree_open
    expect(await openWorktree(env, harnessAuth(W), { project: 'P1', repo: NEW_REPO, branch: 'main' })).toMatchObject({ ok: true })
    expect(await setProjectRepo(env, w, { project_id: 'P1', op: 'remove', repo: NEW_REPO })).toMatchObject({ ok: true, changed: true, repos: [] })
    expect(n("SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE operation = 'remove'")).toBe(1)
  })
  it('refuses an invalid URL and a repo another project already owns (no takeover of resolution)', async () => {
    const env = envFor(); const w = await humanCtx(env, W)
    expect(await setProjectRepo(env, w, { project_id: 'P3', op: 'add', repo: '/home/me/code' })).toMatchObject({ ok: false, status: 400, error: 'invalid_repo' })
    expect(await setProjectRepo(env, w, { project_id: 'P3', op: 'add', repo: REPO })).toMatchObject({ ok: false, status: 409, error: 'repo_already_owned' })
    expect(await setProjectRepo(env, w, { project_id: 'P3', op: 'add', repo: REPO_OTHER })).toMatchObject({ ok: false, status: 409, error: 'repo_already_owned' })
    expect(n('SELECT COUNT(*) AS n FROM project_repos WHERE project_id = ?', 'P3')).toBe(0)
  })
  it('two concurrent adds of one fresh repo to different projects: exactly one wins, the other is repo_already_owned', async () => {
    const env = envFor(); const w = await humanCtx(env, W)
    const fresh = 'https://github.com/Mumega-com/fresh.git'
    const [a, b] = await Promise.all([
      setProjectRepo(env, w, { project_id: 'P3', op: 'add', repo: fresh }),
      setProjectRepo(env, w, { project_id: 'P5', op: 'add', repo: fresh }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(n("SELECT COUNT(*) AS n FROM project_repos WHERE repo_key = 'github:mumega-com/fresh'")).toBe(1)
    expect(n("SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE handler = 'project_repos'")).toBe(1)
  })
  it('the atomic guard alone refuses an owner the preflight missed (keyed owner inserted after the read)', async () => {
    const env = envFor(); const w = await humanCtx(env, W)
    h.sqlite.exec("UPDATE projects SET repo_key = 'github:other-org/other' WHERE id = 'P2'") // keyed owner (heal done)
    // P2 owns it by key; wrap DB so projectsOwningRepo's batch is blind (simulates the race window).
    const blind = { ...env, DB: new Proxy(env.DB, { get: (t, k) => (k === 'batch' ? async (st: unknown[]) => (st.length === 3 ? [{ results: [] }, { results: [] }, { results: [] }] : t.batch(st as never)) : (t as never)[k]?.bind?.(t) ?? (t as never)[k]) }) } as unknown as Env
    expect(await setProjectRepo(blind, w, { project_id: 'P3', op: 'add', repo: 'https://github.com/Other-Org/other.git' })).toMatchObject({ ok: false, status: 409, error: 'repo_already_owned' })
    expect(n('SELECT COUNT(*) AS n FROM project_repos WHERE project_id = ?', 'P3')).toBe(0)
  })
  it('through project_update: an org admin edits; add_repo cannot ride along with other fields', async () => {
    const env = envFor()
    const admin: AuthContext = { userId: 'u-admin', email: null, role: 'admin', tenant: TENANT, memberId: W, channel: 'workspace', capabilities: [{ member_id: W, scope_type: 'org', scope_id: TENANT, capability: 'admin' }] }
    const ok = await invokeTool(admin, env, 'project_update', { project_id: 'P3', add_repo: NEW_REPO })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ changed: true, project_repos: ['github:mumega-com/extra'] })
    const mixed = await invokeTool(admin, env, 'project_update', { project_id: 'P3', add_repo: 'https://github.com/a/b', name: 'renamed' })
    expect(mixed.status).toBe(400)
    expect(n("SELECT COUNT(*) AS n FROM projects WHERE id = 'P3' AND name = 'renamed'")).toBe(0)
  })
  it('an agent-bound org-admin caller is refused by the structural chokepoint (refuse lane)', async () => {
    const env = envFor()
    const agentAdmin: AuthContext = { userId: 'a', email: null, role: 'admin', tenant: TENANT, memberId: W, channel: 'workspace', boundAgentId: 'agent-x', capabilities: [{ member_id: W, scope_type: 'org', scope_id: TENANT, capability: 'admin' }] }
    const out = await invokeTool(agentAdmin, env, 'project_update', { project_id: 'P3', add_repo: NEW_REPO })
    expect(out.status).toBe(403)
    expect(n('SELECT COUNT(*) AS n FROM project_repos WHERE project_id = ?', 'P3')).toBe(0)
  })
})
