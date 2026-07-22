// Tests for the own-fleet task executor (src/integrations/github-execute.ts).

import { describe, it, expect } from 'vitest'
import { executeTaskAsPR } from '../src/integrations/github-execute'
import type { Env } from '../src/types'

// Env: task row present, free tier (repo_file_write enabled), static token. Captures the
// final task UPDATE. A routed fetch mock drives branch/file/PR responses.
function env(opts: { task?: { id: string; status: string; assignee_agent_id?: string | null } | null; token?: string | null } = {}) {
  const task = opts.task === undefined
    ? { id: 'T1', status: 'open', assignee_agent_id: null as string | null, thread_status: 'open', git_branch: null as string | null, github_issue_url: null as string | null }
    : opts.task === null
      ? null
      : {
          ...opts.task,
          assignee_agent_id: opts.task.assignee_agent_id ?? null,
          thread_status: 'open',
          git_branch: null as string | null,
          github_issue_url: null as string | null,
        }
  const updates: Array<{ sql: string; args: unknown[] }> = []
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes('FROM tasks')) return task
          if (sql.includes('FROM task_thread_receipts')) return null
          return null
        },
        run: async () => {
          if (sql.startsWith('UPDATE tasks')) updates.push({ sql, args })
          return { meta: { changes: 1 } }
        },
        all: async () => ({ results: [] }),
      }),
    }),
  }
  return {
    env: { TENANT_SLUG: 't', DB, GITHUB_TOKEN: 'token' in opts ? opts.token : 'ghp_x', GITHUB_PLAN_TIER: 'free' } as unknown as Env,
    updates,
  }
}

// fetch mock: GET ref→sha, POST refs→branch, GET contents→404, PUT contents→commit, POST pulls→PR.
function happyFetch(prNumber = 11) {
  const calls: string[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    const u = String(url)
    calls.push(`${init?.method ?? 'GET'} ${u.replace('https://api.github.com', '')}`)
    if (u.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'SHA' } }), { status: 200 })
    if (u.endsWith('/git/refs')) return new Response(JSON.stringify({ ref: 'refs/heads/x' }), { status: 201 })
    if (u.includes('/contents/') && (!init || init.method === undefined)) return new Response('{}', { status: 404 })
    if (u.includes('/contents/')) return new Response(JSON.stringify({ commit: { html_url: 'https://x/c' } }), { status: 201 })
    if (u.endsWith('/pulls')) return new Response(JSON.stringify({ number: prNumber, html_url: `https://x/pull/${prNumber}` }), { status: 201 })
    return new Response('{}', { status: 500 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const base = {
  taskId: 'T1', repo: 'o/r', branchName: 'feature/t1',
  files: [{ path: 'src/a.ts', content: 'a' }, { path: 'src/b.ts', content: 'b' }],
  title: 'Do T1',
}

describe('executeTaskAsPR', () => {
  it('branch → files → PR → links task to review', async () => {
    const { env: e, updates } = env()
    const { impl } = happyFetch(11)
    const res = await executeTaskAsPR(e, base, { fetchImpl: impl })
    expect(res).toEqual({ ok: true, prNumber: 11, prUrl: 'https://x/pull/11', filesWritten: 2 })
    // status→review + PR url, then branch link (work-item thread)
    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect(updates[0].sql).toContain("status = 'review'")
    expect(updates[0].args).toContain('https://x/pull/11')
    expect(updates.some((u) => u.sql.includes('git_branch'))).toBe(true)
  })

  it('authors commits as the task\'s assigned agent (#21)', async () => {
    // env where the task has an assignee + the agents table resolves it.
    const agent = { slug: 'kasra', name: 'Kasra' }
    const DB = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM tasks')) {
              return {
                id: 'T1',
                status: 'open',
                assignee_agent_id: 'A1',
                thread_status: 'open',
                git_branch: null,
                github_issue_url: null,
              }
            }
            if (sql.includes('FROM agents')) return agent
            if (sql.includes('FROM task_thread_receipts')) return null
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    }
    const e = { TENANT_SLUG: 't', DB, GITHUB_TOKEN: 'ghp_x', GITHUB_PLAN_TIER: 'free' } as unknown as Env
    let authorSeen: unknown = null
    const impl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'S' } }), { status: 200 })
      if (u.endsWith('/git/refs')) return new Response('{}', { status: 201 })
      if (u.includes('/contents/') && (!init || init.method === undefined)) return new Response('{}', { status: 404 })
      if (u.includes('/contents/')) { authorSeen = JSON.parse(String(init?.body)).author; return new Response(JSON.stringify({ commit: {} }), { status: 201 }) }
      if (u.endsWith('/pulls')) return new Response(JSON.stringify({ number: 1, html_url: 'https://x/pull/1' }), { status: 201 })
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const res = await executeTaskAsPR(e, { ...base, files: [{ path: 'a.ts', content: 'x' }] }, { fetchImpl: impl })
    expect(res.ok).toBe(true)
    expect(authorSeen).toEqual({ name: 'Kasra', email: 'kasra@agents.mumega.com' })
  })

  it('uses AGENT_COMMIT_EMAIL_DOMAIN when a fork overrides it (de-mumega-ify #2)', async () => {
    const agent = { slug: 'kasra', name: 'Kasra' }
    const DB = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => {
            if (sql.includes('FROM tasks')) {
              return {
                id: 'T1',
                status: 'open',
                assignee_agent_id: 'A1',
                thread_status: 'open',
                git_branch: null,
                github_issue_url: null,
              }
            }
            if (sql.includes('FROM agents')) return agent
            if (sql.includes('FROM task_thread_receipts')) return null
            return null
          },
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [] }),
        }),
      }),
    }
    const e = {
      TENANT_SLUG: 't',
      DB,
      GITHUB_TOKEN: 'ghp_x',
      GITHUB_PLAN_TIER: 'free',
      AGENT_COMMIT_EMAIL_DOMAIN: 'agents.forkedpot.example',
    } as unknown as Env
    let authorSeen: unknown = null
    const impl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'S' } }), { status: 200 })
      if (u.endsWith('/git/refs')) return new Response('{}', { status: 201 })
      if (u.includes('/contents/') && (!init || init.method === undefined)) return new Response('{}', { status: 404 })
      if (u.includes('/contents/')) { authorSeen = JSON.parse(String(init?.body)).author; return new Response(JSON.stringify({ commit: {} }), { status: 201 }) }
      if (u.endsWith('/pulls')) return new Response(JSON.stringify({ number: 1, html_url: 'https://x/pull/1' }), { status: 201 })
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const res = await executeTaskAsPR(e, { ...base, files: [{ path: 'a.ts', content: 'x' }] }, { fetchImpl: impl })
    expect(res.ok).toBe(true)
    expect(authorSeen).toEqual({ name: 'Kasra', email: 'kasra@agents.forkedpot.example' })
  })

  it('tolerates an existing branch (branch_exists) and proceeds', async () => {
    const { env: e } = env()
    const impl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'S' } }), { status: 200 })
      if (u.endsWith('/git/refs')) return new Response('{}', { status: 422 }) // branch exists
      if (u.includes('/contents/') && (!init || init.method === undefined)) return new Response('{}', { status: 404 })
      if (u.includes('/contents/')) return new Response(JSON.stringify({ commit: {} }), { status: 201 })
      if (u.endsWith('/pulls')) return new Response(JSON.stringify({ number: 5, html_url: 'https://x/pull/5' }), { status: 201 })
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const res = await executeTaskAsPR(e, base, { fetchImpl: impl })
    expect(res.ok).toBe(true)
  })

  it('rejects bad inputs before any network (validate stage)', async () => {
    const { env: e } = env()
    expect((await executeTaskAsPR(e, { ...base, repo: 'bad' })).stage).toBe('validate')
    expect((await executeTaskAsPR(e, { ...base, files: [] })).stage).toBe('validate')
    expect((await executeTaskAsPR(e, { ...base, files: [{ path: '../x', content: 'y' }] })).stage).toBe('validate')
    // P0 guard: cannot ship a GitHub Actions workflow file (CI-RCE)
    expect((await executeTaskAsPR(e, { ...base, files: [{ path: '.github/workflows/x.yml', content: 'on: push' }] })).stage).toBe('validate')
    expect((await executeTaskAsPR(e, { ...base, title: '' })).stage).toBe('validate')
  })

  it('fails at task stage when the task does not exist', async () => {
    const { env: e } = env({ task: null })
    const res = await executeTaskAsPR(e, base)
    expect(res).toEqual({ ok: false, error: 'task_not_found', stage: 'task' })
  })

  it('fails closed at file stage on a write error (task not linked)', async () => {
    const { env: e, updates } = env()
    const impl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: 'S' } }), { status: 200 })
      if (u.endsWith('/git/refs')) return new Response('{}', { status: 201 })
      if (u.includes('/contents/') && (!init || init.method === undefined)) return new Response('{}', { status: 404 })
      if (u.includes('/contents/')) return new Response('{}', { status: 422 }) // write fails
      return new Response('{}', { status: 500 })
    }) as unknown as typeof fetch
    const res = await executeTaskAsPR(e, base, { fetchImpl: impl })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.stage).toBe('file')
    expect(updates).toHaveLength(0) // task NOT linked on failure
  })

  it('capability_disabled when repo_file_write is off (enterprise tier, kill switch governs only enterprise feats — here free works; simulate via no token path)', async () => {
    // free tier enables repo_file_write; to exercise the gate-miss we use a tier with the
    // feature unavailable is not possible (repo_file_write is free) — instead assert no-token.
    const { env: e } = env({ token: null })
    const res = await executeTaskAsPR(e, base)
    expect(res.ok).toBe(false)
  })
})
