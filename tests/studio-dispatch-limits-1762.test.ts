// #1762 (a) — Studio cursor-cloud dispatch is bounded per member and per repo by ONE atomic conditional INSERT. Real schema.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { dispatchStudioFlight } from '../src/dashboard/studio'
import { launchCursorAgent } from '../src/cursor/client'

const REPO = 'https://github.com/Mumega-com/mupot'
const auth = (memberId: string): AuthContext => ({ userId: `u-${memberId}`, email: `${memberId}@pot.test`, role: 'member', tenant: 'pot-a', memberId })

let harness: SqliteD1Harness | undefined
afterEach(() => { harness?.close(); harness = undefined; vi.unstubAllGlobals() })

function pod(extra: Partial<Env> = {}): Env {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
  `)
  harness = h
  return { DB: h.db, TENANT_SLUG: 'pot-a', RELEASE_SHA: 'a'.repeat(40), CURSOR_API_TOKEN: 'tok', ...extra } as unknown as Env
}

function stubLaunch(status = 200): ReturnType<typeof vi.fn> {
  let n = 0
  const f = vi.fn(async () => {
    n += 1
    if (status !== 200) return new Response('boom', { status })
    return new Response(JSON.stringify({
      agent: { id: `bc-${n}`, name: 'n', status: 'ACTIVE', url: `https://cursor.com/agents/bc-${n}`, createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', latestRunId: `run-${n}`, repos: [{ url: REPO }] },
      run: { id: `run-${n}`, agentId: `bc-${n}`, status: 'CREATING', createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', f)
  return f
}

const dispatch = (env: Env, who: string, repo: string, i = 0) =>
  dispatchStudioFlight(env, auth(who), { prompt: `work ${i}`, repoUrl: repo, model: 'cursor-cloud' })

describe('#1762 Studio dispatch bounds', () => {
  it('concurrent Promise.all over the member limit: exactly N succeed, N Cursor launches, rest 429', async () => {
    const env = pod({ STUDIO_DISPATCH_REPO_LIMIT: '100' })
    const f = stubLaunch()
    const repos = Array.from({ length: 8 }, (_, i) => `${REPO}-${i}`)
    const out = await Promise.all(repos.map((r, i) => dispatch(env, 'm1', r, i)))
    expect(out.filter((o) => o.ok)).toHaveLength(3)
    const refused = out.filter((o) => !o.ok)
    expect(refused).toHaveLength(5)
    for (const r of refused) expect(r).toMatchObject({ ok: false, status: 429, error: 'studio_member_limit' })
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('member limit is env-overridable and per member (another member is unaffected)', async () => {
    const env = pod({ STUDIO_DISPATCH_MEMBER_LIMIT: '1' })
    stubLaunch()
    expect((await dispatch(env, 'm1', `${REPO}-a`)).ok).toBe(true)
    expect(await dispatch(env, 'm1', `${REPO}-b`)).toMatchObject({ ok: false, status: 429 })
    expect((await dispatch(env, 'm2', `${REPO}-c`)).ok).toBe(true)
  })

  it('per-repo: concurrent members on one repo -> one reserved/maybe at a time; normalised repo key cannot be dodged', async () => {
    const env = pod()
    const f = stubLaunch(500) // maybe_launched
    const variants = [REPO, `${REPO}/`, `${REPO.toUpperCase()}.git`, REPO]
    const out = await Promise.all(variants.map((r, i) => dispatch(env, `m${i}`, r, i)))
    expect(out.filter((o) => o.ok)).toHaveLength(1)
    for (const r of out.filter((o) => !o.ok)) expect(r).toMatchObject({ status: 429, error: 'studio_repo_limit' })
    expect(f).toHaveBeenCalledTimes(1)
    // after the maybe-launched slot, the same repo stays blocked for other members
    expect(await dispatch(env, 'm9', REPO)).toMatchObject({ ok: false, status: 429, error: 'studio_repo_limit' })
  })

  it('a clean refusal (4xx) releases the slot; a launched agent does not count against the repo bound', async () => {
    const env = pod({ STUDIO_DISPATCH_MEMBER_LIMIT: '1' })
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'bad' }), { status: 422 }))
    vi.stubGlobal('fetch', f)
    expect((await dispatch(env, 'm1', REPO)).ok).toBe(true)
    expect(await dispatch(env, 'm1', REPO)).toMatchObject({ ok: true }) // slot was released, not consumed
    stubLaunch()
    expect((await dispatch(env, 'm1', REPO)).ok).toBe(true) // launched
    expect(await dispatch(env, 'm2', REPO)).toMatchObject({ ok: true }) // launched slot does not occupy the repo bound
  })

  it('no repoUrl / no token never consume a slot', async () => {
    const env = pod({ STUDIO_DISPATCH_MEMBER_LIMIT: '1' })
    stubLaunch()
    for (let i = 0; i < 4; i += 1) expect((await dispatchStudioFlight(env, auth('m1'), { prompt: `p${i}` })).ok).toBe(true)
    expect(harnessCount()).toBe(0)
  })

  it('slots outside the window do not count', async () => {
    const env = pod({ STUDIO_DISPATCH_MEMBER_LIMIT: '1' })
    stubLaunch()
    expect((await dispatch(env, 'm1', `${REPO}-a`)).ok).toBe(true)
    harness?.sqlite.exec('UPDATE studio_dispatch_slots SET created_at = created_at - 100 * 60000')
    expect((await dispatch(env, 'm1', `${REPO}-b`)).ok).toBe(true)
  })
})

function harnessCount(): number {
  return (harness?.sqlite.prepare('SELECT COUNT(*) AS n FROM studio_dispatch_slots').get() as { n: number }).n
}

describe('#1762 P3 cursor create POST redirect handling', () => {
  it('3xx on the create POST -> maybe_launched, request uses redirect:manual', async () => {
    const f = vi.fn(async () => new Response(null, { status: 303, headers: { location: 'https://evil.example/' } }))
    vi.stubGlobal('fetch', f)
    const o = await launchCursorAgent('tok', { name: 'n', repoUrl: REPO, prompt: 'p' })
    expect(o.state).toBe('maybe_launched')
    if (o.state === 'maybe_launched') expect(o.error).toMatchObject({ status: 502, code: 'cursor_unexpected_redirect' })
    expect(f).toHaveBeenCalledOnce()
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.redirect).toBe('manual')
  })
})
