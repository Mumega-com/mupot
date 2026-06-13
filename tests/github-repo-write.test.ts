// Tests for GitHub repo-write actions (src/integrations/github-repo-write.ts).
//
// Acceptance criteria:
//   (1) writeAgentDef: validates repo + agentName (no path traversal), content bounds
//   (2) writeAgentDef: create (no sha) vs update (existing sha) — correct PUT body
//   (3) writeAgentDef: capability gate + no-token fail-closed
//   (4) assignIssueToCopilot: capability gate (needs paid tier)
//   (5) assignIssueToCopilot: resolves bot id via suggestedActors, sends actorIds + feature header
//   (6) assignIssueToCopilot: copilot_unavailable when bot not assignable; fail-closed on errors

import { describe, it, expect } from 'vitest'
import {
  writeAgentDef,
  assignIssueToCopilot,
  isValidAgentName,
  isValidRepo,
} from '../src/integrations/github-repo-write'
import type { Env } from '../src/types'

// Env with a static GITHUB_TOKEN (so resolveOutboundGitHubToken returns it without minting —
// no App creds, no master key → getInstallationToken short-circuits to null → PAT fallback).
function env(opts: { tier?: string; token?: string | undefined; kill?: string } = {}): Env {
  const db = {
    prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) }),
  }
  return {
    TENANT_SLUG: 'writepot',
    DB: db,
    GITHUB_TOKEN: 'token' in opts ? opts.token : 'ghp_static',
    GITHUB_PLAN_TIER: opts.tier ?? 'free',
    GITHUB_ENTERPRISE_FEATURES: opts.kill,
  } as unknown as Env
}

describe('validation helpers', () => {
  it('agent name: lowercase/digits/hyphen only, no traversal', () => {
    expect(isValidAgentName('kasra')).toBe(true)
    expect(isValidAgentName('kasra-review')).toBe(true)
    expect(isValidAgentName('../etc/passwd')).toBe(false)
    expect(isValidAgentName('a/b')).toBe(false)
    expect(isValidAgentName('Kasra')).toBe(false)
    expect(isValidAgentName('-bad')).toBe(false)
    expect(isValidAgentName('')).toBe(false)
  })
  it('repo: owner/repo only, no dot-segment path traversal', () => {
    expect(isValidRepo('Mumega-com/mumega-com')).toBe(true)
    expect(isValidRepo('owner/repo.js')).toBe(true) // dots inside a name are fine
    expect(isValidRepo('a/b/c')).toBe(false)
    expect(isValidRepo('noslash')).toBe(false)
    expect(isValidRepo('../../evil')).toBe(false)
    expect(isValidRepo('owner/..')).toBe(false) // would repoint the REST URL path
    expect(isValidRepo('../name')).toBe(false)
    expect(isValidRepo('../...')).toBe(false)
    expect(isValidRepo('owner/../../x')).toBe(false)
  })
})

describe('writeAgentDef', () => {
  it('rejects bad inputs before any network call', async () => {
    expect((await writeAgentDef(env(), { repo: 'bad', agentName: 'k', content: 'x' })).ok).toBe(false)
    expect((await writeAgentDef(env(), { repo: 'a/b', agentName: '../x', content: 'x' })).ok).toBe(false)
    expect((await writeAgentDef(env(), { repo: 'a/b', agentName: 'k', content: '' })).ok).toBe(false)
    expect((await writeAgentDef(env(), { repo: 'a/b', agentName: 'k', content: 'x'.repeat(30_001) })).ok).toBe(false)
  })

  it('creates a new file (no existing sha → PUT without sha)', async () => {
    let putBody: Record<string, unknown> = {}
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        // GET existing → 404 (file does not exist yet)
        return new Response('{}', { status: 404 })
      }
      putBody = JSON.parse(String(init.body))
      expect(String(url)).toContain('/repos/Mumega-com/mumega-com/contents/.github/agents/kasra.agent.md')
      return new Response(JSON.stringify({ commit: { html_url: 'https://github.com/x/commit/abc' } }), { status: 201 })
    }) as unknown as typeof fetch

    const res = await writeAgentDef(env(), { repo: 'Mumega-com/mumega-com', agentName: 'kasra', content: '# Kasra' }, { fetchImpl })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.updated).toBe(false)
      expect(res.commitUrl).toContain('/commit/')
    }
    expect(putBody.sha).toBeUndefined() // create → no sha
    expect(typeof putBody.content).toBe('string') // base64
  })

  it('updates an existing file (sha threaded into PUT)', async () => {
    let putBody: Record<string, unknown> = {}
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) {
        return new Response(JSON.stringify({ sha: 'existingsha123' }), { status: 200 })
      }
      putBody = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ commit: { html_url: 'https://github.com/x/commit/def' } }), { status: 200 })
    }) as unknown as typeof fetch

    const res = await writeAgentDef(env(), { repo: 'a/b', agentName: 'loom', content: '# Loom' }, { fetchImpl })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.updated).toBe(true)
    expect(putBody.sha).toBe('existingsha123')
  })

  it('fails closed with no token', async () => {
    const res = await writeAgentDef(env({ token: undefined }), { repo: 'a/b', agentName: 'k', content: 'x' })
    expect(res).toEqual({ ok: false, error: 'no_token' })
  })

  it('surfaces a write failure status', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return new Response('{}', { status: 404 })
      return new Response('{}', { status: 422 })
    }) as unknown as typeof fetch
    const res = await writeAgentDef(env(), { repo: 'a/b', agentName: 'k', content: 'x' }, { fetchImpl })
    expect(res).toEqual({ ok: false, error: 'write_failed_422' })
  })
})

describe('assignIssueToCopilot', () => {
  it('blocked on free tier (needs paid coding_agent_assign)', async () => {
    const res = await assignIssueToCopilot(env({ tier: 'free' }), { repo: 'a/b', issueNumber: 1 })
    expect(res).toEqual({ ok: false, error: 'capability_disabled' })
  })

  it('rejects invalid issue number', async () => {
    const res = await assignIssueToCopilot(env({ tier: 'pro' }), { repo: 'a/b', issueNumber: 0 })
    expect(res).toEqual({ ok: false, error: 'invalid_issue' })
  })

  it('assigns Copilot: resolves bot id, sends actorIds + feature header', async () => {
    let sawFeatureHeader = false
    let mutationVars: Record<string, unknown> = {}
    let calls = 0
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls++
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (headers['GraphQL-Features'] === 'issues_copilot_assignment_api_support') sawFeatureHeader = true
      const body = JSON.parse(String(init?.body))
      if (body.query.includes('suggestedActors')) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                issue: { id: 'ISSUE_NODE_1' },
                suggestedActors: { nodes: [{ login: 'copilot-swe-agent', __typename: 'Bot', id: 'BOT_COPILOT' }] },
              },
            },
          }),
          { status: 200 },
        )
      }
      // mutation
      mutationVars = body.variables
      return new Response(JSON.stringify({ data: { replaceActorsForAssignable: { assignable: { __typename: 'Issue' } } } }), { status: 200 })
    }) as unknown as typeof fetch

    const res = await assignIssueToCopilot(env({ tier: 'enterprise' }), { repo: 'Mumega-com/mumega-com', issueNumber: 42 }, { fetchImpl })
    expect(res).toEqual({ ok: true, assigned: true })
    expect(sawFeatureHeader).toBe(true)
    expect(calls).toBe(2)
    expect(mutationVars.assignableId).toBe('ISSUE_NODE_1')
    expect(mutationVars.actorIds).toEqual(['BOT_COPILOT']) // actorIds, NOT assigneeIds
  })

  it('copilot_unavailable when the bot is not an assignable actor', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ data: { repository: { issue: { id: 'I1' }, suggestedActors: { nodes: [{ login: 'someuser', __typename: 'User', id: 'U1' }] } } } }),
        { status: 200 },
      )) as unknown as typeof fetch
    const res = await assignIssueToCopilot(env({ tier: 'pro' }), { repo: 'a/b', issueNumber: 5 }, { fetchImpl })
    expect(res).toEqual({ ok: false, error: 'copilot_unavailable' })
  })

  it('fails closed when the mutation returns errors', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.query.includes('suggestedActors')) {
        return new Response(JSON.stringify({ data: { repository: { issue: { id: 'I1' }, suggestedActors: { nodes: [{ login: 'copilot-swe-agent', id: 'BOT' }] } } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ errors: [{ message: 'nope' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await assignIssueToCopilot(env({ tier: 'pro' }), { repo: 'a/b', issueNumber: 5 }, { fetchImpl })
    expect(res).toEqual({ ok: false, error: 'assign_failed' })
  })
})
