// Repo-aware GitHub (S2): the task->issue mirror targets the task's project repo, the token is
// repo-scoped, execute-task validates the repo, and webhook-created tasks / merged-PR rows carry
// project_id only on a unique repo owner. Real SQLite + the whole migration chain.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createTask, mirrorTaskCreateDetailed, mirrorTaskUpdate } from '../src/tasks/service'
import { _clearTokenCache, getInstallationToken, getRepoScopedInstallationToken } from '../src/integrations/github-app'
import { executeTaskAsPR } from '../src/integrations/github-execute'
import { githubInboundApp } from '../src/integrations/github-routes'
import { recordMergedPr } from '../src/agents/kpi-sources'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCiz3NKIHssxXUk
AncOUXhFvHBnnW88IsNAZfcFiR8AfK6RGkB4993GAQELWQXNvNof/6jgSSm9KLbu
p4t7Hdi9NT+LJSFBPyY0XfbaoKVHsw/17BcptUP3pmXV4CT40XX3GePzTPeMtPIj
E+Bi4+7vRmR7qIhpydUj8X+/VNX1VRoX5ou2WHPOOHo8fXKg4yh5N4baBoaArsZn
NV6kqkoy8iViypP6V6v02BOBccAc0RuuqbSpYWtHWXwQj5KwKJG6YSQ+232lluzP
TwmY+VcMtpJqz4yF8rvdDZM8iCOVcUiPQzDGuptd6Ag59wcPKQ0eCv5ZVy8+j2Iz
JsaV/lENAgMBAAECggEABD5TGRSCODmDlWKLomswU3aymQeflZWGXiKcgTIAvG06
XLNA5F0eFDjyMQWrHleCeaEIq+xuiaPBmNjPFbmwI30yPBRYGIv49IQsvV7lGRF0
bXhUQacJr8F0qlH5+5LPwQSVTkH1cTpqHvFcZWm6mYvySRdjSj+4CXI4p3NHCg8r
RzJXWxzfeY0umvNcHHmcZlO2GZsUWGwYVvz2h8zM0lgvhwNfYSY6w/IbuYvtmDxe
vOKh4YgxHgPq3QdI0RsKi1lQeVXVIqlHbx6VkbN6Ln548hnuuJnEE/WpfPNc5OY7
E5QRMYLcJUpo53P63glv6jVALjps8GvWEeH3dv5XVQKBgQDNE3PmrFXlmGfBX2iZ
H2v3FgPtJm3jyIDNv81DdY6yQPEfeHrHPbQkTRYHcgpX610fRteMWMViH0ovdEe1
q5cGCbE8AYiozZxq7+zo3JeX6epfnDE6vsQzJhokFNskrHgKk1wbI4ZJAkMX7iuF
o6cL8X/jR37LMJxqL9qZHguFnwKBgQDLPTLd8XYPcSE4yknk/B9jPUoEVx7nxv5Z
IvYl/SFH9QWPUQ1ZLD5mzrNNWSu3TNeA+yx1ERMxRO/NRYbEksYjbdLElICOlmbT
8Rur1kfxlRJ27vy+NEzQLgIj2YIy6yj9e5IZco2A0Q8120J53BQ+ExVbP98nGgPl
EHWTTPxx0wKBgCRN90y04Zf9vRB8pXXGHETnvtYy4W1bx4GlHN9+Zj6kRIt/tqyi
/csXYnj69V3PKvMohWwxIvBV/boc6bz9nYTSHnAzDVBk5fYAd35Z3vRj0rwOWKC/
uNgdPK96ibkaVz34DGw5g8JVBi+sWEQWTrJMlIlV1Np/xpD928MTkJKdAoGAIIZS
taIGusHoByaYXMTcYQ1V4wvuLjlySuGFct7njJRxp1XZRQQHmHxLxX0XueXaNxH7
M2DgKWpW1griXmL+wny41izNxgPbwN89BmrsaITqx43HdMj54fb68LHGXE+155r2
7oueiZbrUDsekFHgC28SY9/83k0Tgnz30/LmE3ECgYEAuOzNvs25mevlAJm38olU
b4HTUjjujozrEZPtNVXIfjkMWl3W933bA/SbWLsWbc3yiSaFPFsLIbUyWtjlWmCG
G6FAsaVI2hWUfgdtEZ1E7ibAmeyRIFGOTPtt2U0XDZcglTFOuTlMh8Dt1tUmrA3v
PiA4slfeSGYulORUGWJsGnU=
-----END PRIVATE KEY-----`

interface Call { url: string; method: string; auth: string | null; body: unknown }

function fixture(extra: Record<string, unknown> = {}) {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-core', 'dept-a', 'squad-core', 'Core');
    INSERT INTO projects (id, slug, name, status, repo_key) VALUES
      ('p-mupot', 'mupot', 'mupot', 'active', 'github:acme/mupot'),
      ('p-norepo', 'norepo', 'norepo', 'active', NULL),
      ('p-gitlab', 'gl', 'gl', 'active', 'url:gitlab.com/acme/x'),
      ('p-dup1', 'd1', 'd1', 'active', 'github:acme/dup'),
      ('p-dup2', 'd2', 'd2', 'active', 'github:acme/dup'),
      ('p-secret', 'sec', 'sec', 'active', 'github:acme/secret');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('p-mupot','squad-core','write'),('p-norepo','squad-core','write'),('p-gitlab','squad-core','write'),
      ('p-dup1','squad-core','write'),('p-dup2','squad-core','write'),('p-secret','squad-core','write');
  `)
  const env = {
    TENANT_SLUG: 'mumega',
    DB: harness.db,
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: PEM,
    GITHUB_APP_INSTALLATION_ID: '789',
    GITHUB_WEBHOOK_SECRET: 'wh',
    GITHUB_PLAN_TIER: 'free',
    BUS: { send: async () => {} },
    ...extra,
  } as unknown as Env
  return { harness, env }
}

let calls: Call[]
/** reachable: full_names the installation can reach. Token response echoes the requested repo only if reachable. */
function stubGitHub(reachable: string[], opts: { echoOwner?: string; extraRepos?: string[] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    const h = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: u, method: init?.method ?? 'GET', auth: h.Authorization ?? null, body })
    if (u.includes('/access_tokens')) {
      const names: string[] = body?.repositories ?? []
      const owner = opts.echoOwner ?? 'acme'
      const ok = names.length > 0 && names.every((n) => reachable.includes(`acme/${n}`))
      if (body && !ok) return new Response('{}', { status: 422 })
      return new Response(JSON.stringify({
        token: body ? `ghs_scoped_${names.join(',')}` : 'ghs_whole',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        repositories: [...names, ...(opts.extraRepos ?? [])].map((n) => ({ full_name: `${owner}/${n}` })),
      }), { status: 201 })
    }
    if (u.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'S' } }), { status: 200 })
    if (u.endsWith('/git/refs')) return new Response('{}', { status: 201 })
    if (u.includes('/contents/') && (init?.method ?? 'GET') === 'GET') return new Response('{}', { status: 404 })
    if (u.includes('/contents/')) return new Response(JSON.stringify({ commit: { html_url: 'c' } }), { status: 201 })
    if (u.endsWith('/pulls')) return new Response(JSON.stringify({ number: 5, html_url: 'https://github.com/acme/mupot/pull/5' }), { status: 201 })
    const m = /repos\/([^/]+\/[^/]+)\/issues/.exec(u)
    return new Response(JSON.stringify({ html_url: `https://github.com/${m?.[1]}/issues/7` }), { status: 201 })
  }))
}
const issuePosts = () => calls.filter((c) => c.method === 'POST' && /\/issues$/.test(c.url))

beforeEach(() => { calls = []; _clearTokenCache() })
afterEach(() => { vi.unstubAllGlobals() })

const mk = (env: Env, project_id: string | null) =>
  createTask(env, { squad_id: 'squad-core', project_id, title: 'T', body: 'B', done_when: 'the thing is done', status: 'open' }, {})

describe('repo-aware mirror', () => {
  it('targets the project repo with a repo-scoped, issues:write token', async () => {
    const { env } = fixture({ GITHUB_REPO: 'Mumega-com/mumega-com' })
    stubGitHub(['acme/mupot'])
    const t = await mk(env, 'p-mupot')
    expect(t.github_issue_url).toBe('https://github.com/acme/mupot/issues/7')
    expect(issuePosts().map((c) => c.url)).toEqual(['https://api.github.com/repos/acme/mupot/issues'])
    const mint = calls.find((c) => c.url.includes('/access_tokens'))
    expect(mint?.body).toEqual({ repositories: ['mupot'], permissions: { issues: 'write' } })
    expect(issuePosts()[0]?.auth).toBe('Bearer ghs_scoped_mupot')
  })

  it('a no-project task falls back to GITHUB_REPO (legacy whole-install token)', async () => {
    const { env } = fixture({ GITHUB_REPO: 'Mumega-com/mumega-com' })
    stubGitHub([])
    const t = await mk(env, null)
    expect(issuePosts().map((c) => c.url)).toEqual(['https://api.github.com/repos/Mumega-com/mumega-com/issues'])
    expect(calls.find((c) => c.url.includes('/access_tokens'))?.body).toBeNull()
    expect(t.github_issue_url).toContain('mumega-com')
  })

  it('a project with no repo skips with a reason and posts nothing (never the fallback repo)', async () => {
    const { env } = fixture({ GITHUB_REPO: 'Mumega-com/mumega-com' })
    stubGitHub(['acme/mupot'])
    const t = await mk(env, 'p-norepo')
    expect(t.github_issue_url).toBeNull()
    expect(issuePosts()).toHaveLength(0)
    expect(await mirrorTaskCreateDetailed(env, t)).toEqual({ url: null, skipped: 'project_has_no_repo' })
  })

  it('a repo host with no issue API is a recorded skip', async () => {
    const { env } = fixture({ GITHUB_REPO: 'Mumega-com/mumega-com' })
    stubGitHub([])
    const t = await mk(env, 'p-gitlab')
    expect(await mirrorTaskCreateDetailed(env, t)).toEqual({ url: null, skipped: 'repo_host_unsupported' })
    expect(issuePosts()).toHaveLength(0)
  })

  it('an unreachable repo skips (no PAT fallback for a project repo)', async () => {
    const { env } = fixture({ GITHUB_REPO: 'Mumega-com/mumega-com', GITHUB_TOKEN: 'ghp_pat' })
    stubGitHub([]) // installation reaches nothing
    const t = await mk(env, 'p-mupot')
    expect(t.github_issue_url).toBeNull()
    expect(issuePosts()).toHaveLength(0)
    expect(await mirrorTaskCreateDetailed(env, t)).toEqual({ url: null, skipped: 'repo_unreachable' })
  })

  it('skipMirror and externalSource still suppress the mirror', async () => {
    const { env } = fixture()
    stubGitHub(['acme/mupot'])
    await createTask(env, { squad_id: 'squad-core', project_id: 'p-mupot', title: 'T', body: 'B', done_when: 'the thing is done', status: 'open' }, { skipMirror: true })
    await createTask(env, { squad_id: 'squad-core', project_id: 'p-mupot', title: 'T', body: 'B', done_when: 'the thing is done', status: 'open' }, { externalSource: 'github-webhook:issues' })
    expect(calls).toHaveLength(0)
  })

  it('update PATCHes the repo in the existing issue URL, not a re-derived one', async () => {
    const { env } = fixture({ GITHUB_REPO: 'Mumega-com/mumega-com' })
    stubGitHub(['acme/mupot'])
    const t = await mk(env, 'p-mupot')
    calls = []
    const url = await mirrorTaskUpdate(env, { ...t, title: 'T2' }, { statusChanged: false })
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.url)).toEqual(['https://api.github.com/repos/acme/mupot/issues/7'])
    expect(url).toBe(t.github_issue_url)
    // An old issue in a repo that is neither the project's nor GITHUB_REPO is left alone.
    calls = []
    await mirrorTaskUpdate(env, { ...t, github_issue_url: 'https://github.com/other/place/issues/3' })
    expect(calls).toHaveLength(0)
  })
})

describe('repo-scoped installation token', () => {
  it('sends repositories + permissions and is cached apart from the whole-install token', async () => {
    const { env } = fixture()
    stubGitHub(['acme/mupot'])
    expect(await getRepoScopedInstallationToken(env, 'acme/mupot', { issues: 'write' })).toBe('ghs_scoped_mupot')
    expect(await getInstallationToken(env)).toBe('ghs_whole')
    expect(await getRepoScopedInstallationToken(env, 'acme/mupot', { issues: 'write' })).toBe('ghs_scoped_mupot')
    expect(calls.filter((c) => c.url.includes('/access_tokens'))).toHaveLength(2)
    expect(calls[0]?.body).toEqual({ repositories: ['mupot'], permissions: { issues: 'write' } })
  })
  it('discards a token GitHub issued for a different owner\'s same-named repo', async () => {
    const { env } = fixture()
    stubGitHub(['acme/mupot'], { echoOwner: 'evil' })
    expect(await getRepoScopedInstallationToken(env, 'acme/mupot', { issues: 'write' })).toBeNull()
  })
  it('discards a token that also covers a repo beyond the one requested (surplus-repo guard)', async () => {
    const { env } = fixture()
    stubGitHub(['acme/mupot'], { extraRepos: ['secret'] })
    expect(await getRepoScopedInstallationToken(env, 'acme/mupot', { issues: 'write' })).toBeNull()
    expect(calls.filter((c) => c.url.includes('/access_tokens'))).toHaveLength(1)
  })
  it('refuses a malformed full name without calling GitHub', async () => {
    const { env } = fixture()
    stubGitHub([])
    expect(await getRepoScopedInstallationToken(env, 'not a repo', { issues: 'write' })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('execute-task repo validation', () => {
  const params = (repo: string) => ({ taskId: 'T-1', repo, branchName: 'feat/x', files: [{ path: 'a.ts', content: 'a' }], title: 'Do' })
  async function seedTask(h: ReturnType<typeof fixture>, projectId: string | null) {
    const t = await createTask(h.env, { squad_id: 'squad-core', project_id: projectId, title: 'T', body: 'B', done_when: 'the thing is done', status: 'open' }, { skipMirror: true })
    return t.id
  }
  it('refuses a repo the task\'s project does not own, before any GitHub call', async () => {
    const f = fixture(); stubGitHub(['acme/mupot', 'acme/secret'])
    const id = await seedTask(f, 'p-mupot')
    const res = await executeTaskAsPR(f.env, { ...params('acme/secret'), taskId: id })
    expect(res).toEqual({ ok: false, error: 'repo_not_task_repo', stage: 'repo' })
    expect(calls).toHaveLength(0)
  })
  it('a project-less task may only target GITHUB_REPO', async () => {
    const f = fixture({ GITHUB_REPO: 'acme/mupot', GITHUB_TOKEN: 'ghp' }); stubGitHub(['acme/mupot', 'acme/secret'])
    const id = await seedTask(f, null)
    const bad = await executeTaskAsPR(f.env, { ...params('acme/secret'), taskId: id })
    expect(bad).toMatchObject({ ok: false, stage: 'repo' })
    expect(calls).toHaveLength(0)
  })
  it('an owned repo proceeds using a repo-scoped contents/pull_requests token', async () => {
    const f = fixture(); stubGitHub(['acme/mupot'])
    const id = await seedTask(f, 'p-mupot')
    const res = await executeTaskAsPR(f.env, { ...params('acme/mupot'), taskId: id })
    expect(res.ok).toBe(true)
    expect(calls.find((c) => c.url.includes('/access_tokens'))?.body).toEqual({
      repositories: ['mupot'], permissions: { contents: 'write', pull_requests: 'write' },
    })
    const api = calls.filter((c) => !c.url.includes('/access_tokens'))
    expect(api.length).toBeGreaterThan(0)
    for (const c of api) expect(c.auth).toBe('Bearer ghs_scoped_mupot')
  })
  it('fails closed when the project-repo ownership lookup errors (DB failure), before any GitHub call', async () => {
    const f = fixture(); stubGitHub(['acme/mupot'])
    const id = await seedTask(f, 'p-mupot')
    const real = f.harness.db
    // Only the ownership read (db.batch) fails; the task lookup (prepare/first) still runs for real.
    const failing = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'batch') return async () => { throw new Error('d1 unavailable') }
        const v = Reflect.get(target, prop, recv)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const res = await executeTaskAsPR({ ...f.env, DB: failing } as Env, { ...params('acme/mupot'), taskId: id })
    expect(res).toEqual({ ok: false, error: 'repo_not_task_repo', stage: 'repo' })
    expect(calls).toHaveLength(0)
  })
  it('an owned repo the installation cannot reach is refused', async () => {
    const f = fixture(); stubGitHub([])
    const id = await seedTask(f, 'p-mupot')
    const res = await executeTaskAsPR(f.env, { ...params('acme/mupot'), taskId: id })
    expect(res).toMatchObject({ ok: false, error: 'repo_unreachable' })
  })
})

describe('webhook project resolution', () => {
  async function hmac(msg: string) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('wh'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))
    return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  let n = 0
  async function post(env: Env, event: string, payload: unknown) {
    const body = JSON.stringify(payload)
    return githubInboundApp.fetch(new Request('https://pot.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, 'x-hub-signature-256': `sha256=${await hmac(body)}` },
      body,
    }), env, {} as ExecutionContext)
  }
  const pr = (full: string, action = 'opened', merged = false) => ({
    action, repository: { full_name: full }, pull_request: { number: 12, title: 'P', html_url: 'u', merged },
  })
  const lastTask = (h: ReturnType<typeof fixture>) =>
    h.harness.sqlite.prepare('SELECT project_id FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { project_id: string | null }

  it('sets project_id when exactly one project owns the repo', async () => {
    const f = fixture()
    expect((await post(f.env, 'pull_request', pr('Acme/Mupot'))).status).toBe(200)
    expect(lastTask(f).project_id).toBe('p-mupot')
  })
  it('leaves project_id null for an ambiguous repo and for an unknown repo', async () => {
    const f = fixture()
    await post(f.env, 'pull_request', pr('acme/dup'))
    expect(lastTask(f).project_id).toBeNull()
    await post(f.env, 'pull_request', pr('acme/nobody'))
    expect(lastTask(f).project_id).toBeNull()
  })
  it('an issues.opened task is attributed the same way', async () => {
    const f = fixture()
    await post(f.env, 'issues', { action: 'opened', repository: { full_name: 'acme/mupot' }, issue: { number: 3, title: 'i', html_url: 'u' } })
    expect(lastTask(f).project_id).toBe('p-mupot')
  })
  it('a merged PR row stores the resolved project_id (null when unresolved)', async () => {
    const f = fixture()
    await post(f.env, 'pull_request', pr('acme/mupot', 'closed', true))
    await post(f.env, 'pull_request', pr('acme/dup', 'closed', true))
    const rows = f.harness.sqlite.prepare('SELECT repo, project_id FROM github_prs_merged ORDER BY repo').all() as Array<{ repo: string; project_id: string | null }>
    expect(rows).toEqual([{ repo: 'acme/dup', project_id: null }, { repo: 'acme/mupot', project_id: 'p-mupot' }])
  })
  it('recordMergedPr binds project_id directly', async () => {
    const f = fixture()
    await recordMergedPr(f.env, { repo: 'a/b', prNumber: 1, title: null, projectId: 'p-x' })
    expect((f.harness.sqlite.prepare('SELECT project_id FROM github_prs_merged').get() as { project_id: string }).project_id).toBe('p-x')
  })
})
