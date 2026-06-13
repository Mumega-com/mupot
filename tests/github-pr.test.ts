// Tests for own-fleet PR primitives (src/integrations/github-pr.ts).

import { describe, it, expect } from 'vitest'
import {
  isValidBranch,
  isValidRepoPath,
  isValidCommitIdentity,
  createBranch,
  putFile,
  openPullRequest,
} from '../src/integrations/github-pr'
import type { Env } from '../src/types'

function env(token: string | null = 'ghp_x'): Env {
  const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) }) }
  return { TENANT_SLUG: 't', DB: db, GITHUB_TOKEN: token ?? undefined } as unknown as Env
}

describe('validation', () => {
  it('branch names: safe subset, no traversal', () => {
    expect(isValidBranch('feature/mupot-x')).toBe(true)
    expect(isValidBranch('main')).toBe(true)
    expect(isValidBranch('a..b')).toBe(false)
    expect(isValidBranch('/lead')).toBe(false)
    expect(isValidBranch('trail/')).toBe(false)
    expect(isValidBranch('has space')).toBe(false)
    expect(isValidBranch('x.lock')).toBe(false)
  })
  it('repo paths: relative, no traversal, bounded', () => {
    expect(isValidRepoPath('src/index.ts')).toBe(true)
    expect(isValidRepoPath('a/b/c/d.txt')).toBe(true)
    expect(isValidRepoPath('/abs')).toBe(false)
    expect(isValidRepoPath('../escape')).toBe(false)
    expect(isValidRepoPath('a/../b')).toBe(false)
    expect(isValidRepoPath('')).toBe(false)
  })
  it('forbids GitHub Actions workflow files (CI-RCE guard)', () => {
    expect(isValidRepoPath('.github/workflows/ci.yml')).toBe(false)
    expect(isValidRepoPath('.github/workflows/deploy.yaml')).toBe(false)
    expect(isValidRepoPath('.github/WORKFLOWS/x.yml')).toBe(false) // case-insensitive
    // adjacent .github paths are still allowed
    expect(isValidRepoPath('.github/agents/kasra.agent.md')).toBe(true)
    expect(isValidRepoPath('.github/CODEOWNERS')).toBe(true)
  })
})

describe('isValidCommitIdentity (#21)', () => {
  it('accepts a sane name + email', () => {
    expect(isValidCommitIdentity({ name: 'Kasra', email: 'kasra@agents.mumega.com' })).toBe(true)
  })
  it('rejects empty name, bad email, non-object', () => {
    expect(isValidCommitIdentity({ name: '', email: 'a@b.com' })).toBe(false)
    expect(isValidCommitIdentity({ name: 'X', email: 'noat' })).toBe(false)
    expect(isValidCommitIdentity(null)).toBe(false)
    expect(isValidCommitIdentity({ name: 'X' })).toBe(false)
  })
})

describe('createBranch', () => {
  it('resolves base sha then creates the ref', async () => {
    let posted: Record<string, unknown> = {}
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/git/ref/heads/')) {
        return new Response(JSON.stringify({ object: { sha: 'BASESHA' } }), { status: 200 })
      }
      posted = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ref: 'refs/heads/x' }), { status: 201 })
    }) as unknown as typeof fetch
    const res = await createBranch(env(), { repo: 'o/r', fromBranch: 'main', newBranch: 'feature/x' }, { fetchImpl })
    expect(res.ok).toBe(true)
    expect(posted.ref).toBe('refs/heads/feature/x')
    expect(posted.sha).toBe('BASESHA')
  })
  it('surfaces branch_exists on 422', async () => {
    const fetchImpl = (async (url: string) =>
      String(url).includes('/git/ref/heads/')
        ? new Response(JSON.stringify({ object: { sha: 'S' } }), { status: 200 })
        : new Response('{}', { status: 422 })) as unknown as typeof fetch
    const res = await createBranch(env(), { repo: 'o/r', fromBranch: 'main', newBranch: 'dup' }, { fetchImpl })
    expect(res).toEqual({ ok: false, error: 'branch_exists' })
  })
  it('rejects bad branch before network', async () => {
    expect((await createBranch(env(), { repo: 'o/r', fromBranch: 'main', newBranch: 'a..b' })).ok).toBe(false)
  })
  it('fails closed without token', async () => {
    expect(await createBranch(env(null), { repo: 'o/r', fromBranch: 'main', newBranch: 'x' })).toEqual({ ok: false, error: 'no_token' })
  })
})

describe('putFile', () => {
  it('creates a file on a branch (no existing sha)', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return new Response('{}', { status: 404 })
      body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ commit: { html_url: 'https://x/c/1' } }), { status: 201 })
    }) as unknown as typeof fetch
    const res = await putFile(env(), { repo: 'o/r', path: 'src/x.ts', content: 'hi', branch: 'feature/x', message: 'add' }, { fetchImpl })
    expect(res.ok).toBe(true)
    expect(body.branch).toBe('feature/x')
    expect(body.sha).toBeUndefined()
    expect(typeof body.content).toBe('string')
    expect(body.author).toBeUndefined() // no identity → App identity
  })

  it('authors the commit as the named agent when an identity is given (#21)', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return new Response('{}', { status: 404 })
      body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ commit: {} }), { status: 201 })
    }) as unknown as typeof fetch
    await putFile(
      env(),
      { repo: 'o/r', path: 'a.ts', content: 'x', branch: 'b', message: 'm', author: { name: 'Kasra', email: 'kasra@agents.mumega.com' } },
      { fetchImpl },
    )
    expect(body.author).toEqual({ name: 'Kasra', email: 'kasra@agents.mumega.com' })
    expect(body.committer).toEqual({ name: 'Kasra', email: 'kasra@agents.mumega.com' })
  })

  it('drops an invalid identity (falls back to App), does not fail the write', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return new Response('{}', { status: 404 })
      body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ commit: {} }), { status: 201 })
    }) as unknown as typeof fetch
    const res = await putFile(
      env(),
      { repo: 'o/r', path: 'a.ts', content: 'x', branch: 'b', message: 'm', author: { name: '', email: 'bad' } as never },
      { fetchImpl },
    )
    expect(res.ok).toBe(true)
    expect(body.author).toBeUndefined()
  })
  it('rejects path traversal', async () => {
    expect((await putFile(env(), { repo: 'o/r', path: '../etc/passwd', content: 'x', branch: 'b', message: 'm' })).ok).toBe(false)
  })
})

describe('openPullRequest', () => {
  it('opens a PR and returns number + url', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ number: 7, html_url: 'https://x/pull/7' }), { status: 201 })
    }) as unknown as typeof fetch
    const res = await openPullRequest(env(), { repo: 'o/r', head: 'feature/x', base: 'main', title: 'Add x', body: 'does x' }, { fetchImpl })
    expect(res).toEqual({ ok: true, number: 7, url: 'https://x/pull/7' })
    expect(body.head).toBe('feature/x')
    expect(body.base).toBe('main')
    expect(body.title).toBe('Add x')
  })
  it('requires a title', async () => {
    expect((await openPullRequest(env(), { repo: 'o/r', head: 'h', base: 'b', title: '  ' })).ok).toBe(false)
  })
  it('surfaces an open failure status', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 422 })) as unknown as typeof fetch
    expect(await openPullRequest(env(), { repo: 'o/r', head: 'h', base: 'b', title: 'T' }, { fetchImpl })).toEqual({ ok: false, error: 'open_failed_422' })
  })
  it('fails closed without token', async () => {
    expect(await openPullRequest(env(null), { repo: 'o/r', head: 'h', base: 'b', title: 'T' })).toEqual({ ok: false, error: 'no_token' })
  })
})
