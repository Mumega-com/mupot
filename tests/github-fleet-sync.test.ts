// Tests for fleet→GitHub agent-def sync (src/integrations/github-fleet-sync.ts).

import { describe, it, expect } from 'vitest'
import {
  defSlug,
  agentDefMarkdown,
  syncFleetToGitHub,
  type FleetAgent,
} from '../src/integrations/github-fleet-sync'
import type { Env } from '../src/types'

describe('defSlug', () => {
  it('sanitizes to a valid agent-def name', () => {
    expect(defSlug('Kasra')).toBe('kasra')
    expect(defSlug('kasra_review')).toBe('kasra-review')
    expect(defSlug('weird  name!!')).toBe('weird-name')
    expect(defSlug('--edge--')).toBe('edge')
  })
})

describe('agentDefMarkdown', () => {
  const agent: FleetAgent = { slug: 'kasra', name: 'Kasra', role: 'build agent', okr: 'ship features', status: 'active' }

  it('produces frontmatter wired to the pot MCP endpoint', () => {
    const md = agentDefMarkdown(agent, 'https://pot.example/mcp')
    expect(md).toContain('name: "Kasra"')
    expect(md).toContain('mcp-servers:')
    expect(md).toContain('url: "https://pot.example/mcp"')
    expect(md).toContain('Authorization: "Bearer ${COPILOT_MCP_MUPOT_TOKEN}"')
    expect(md).toContain('## Kasra')
    expect(md).toContain('**Objective:** ship features')
    // valid-ish frontmatter delimiters
    expect(md.startsWith('---\n')).toBe(true)
    expect(md.split('---').length).toBeGreaterThanOrEqual(3)
  })

  it('escapes quotes in name/description (no YAML break)', () => {
    const md = agentDefMarkdown({ ...agent, name: 'Kas"ra', role: 'a "weird" role' }, 'https://x/mcp')
    expect(md).toContain('name: "Kas\\"ra"')
  })

  it('flattens newlines so a field cannot inject a frontmatter line', () => {
    const md = agentDefMarkdown({ ...agent, name: 'Evil\nadmin: true' }, 'https://x/mcp')
    // the injected newline is flattened to a space inside the quoted scalar
    expect(md).toContain('name: "Evil admin: true"')
    expect(md).not.toMatch(/^admin: true/m) // no line injected as a frontmatter key
  })

  it('handles a null role/okr', () => {
    const md = agentDefMarkdown({ slug: 'x', name: 'X', role: null, okr: null, status: 'active' }, 'https://x/mcp')
    expect(md).toContain('pot agent')
    expect(md).not.toContain('**Objective:**')
  })
})

describe('syncFleetToGitHub', () => {
  function envWithAgents(agents: FleetAgent[], token: string | null = 'ghp_x'): Env {
    const db = {
      prepare: () => ({
        all: async () => ({ results: agents }),
        bind: () => ({ all: async () => ({ results: agents }), first: async () => null, run: async () => ({ meta: { changes: 0 } }) }),
        first: async () => null,
      }),
    }
    return { TENANT_SLUG: 't', DB: db, GITHUB_TOKEN: token ?? undefined, GITHUB_PLAN_TIER: 'free' } as unknown as Env
  }

  it('dry-run generates a def per active agent without writing', async () => {
    const env = envWithAgents([
      { slug: 'kasra', name: 'Kasra', role: 'build', okr: null, status: 'active' },
      { slug: 'loom', name: 'Loom', role: 'coordinate', okr: null, status: 'active' },
    ])
    const res = await syncFleetToGitHub(env, { repo: 'a/b', mcpUrl: 'https://x/mcp', dryRun: true })
    expect(res.synced).toBe(2)
    expect(res.items.every((i) => i.ok && i.detail.startsWith('dry-run'))).toBe(true)
  })

  it('writes each agent def via writeAgentDef (create path)', async () => {
    const env = envWithAgents([{ slug: 'kasra', name: 'Kasra', role: 'build', okr: null, status: 'active' }])
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return new Response('{}', { status: 404 }) // GET → not found
      return new Response(JSON.stringify({ commit: { html_url: 'https://x/commit/1' } }), { status: 201 }) // PUT
    }) as unknown as typeof fetch
    const res = await syncFleetToGitHub(env, { repo: 'Mumega-com/mumega-com', mcpUrl: 'https://x/mcp' }, { fetchImpl })
    expect(res.synced).toBe(1)
    expect(res.items[0]).toEqual({ agent: 'kasra', ok: true, detail: 'created' })
  })

  it('reports a per-agent failure without aborting the rest', async () => {
    const env = envWithAgents(
      [
        { slug: 'kasra', name: 'Kasra', role: 'build', okr: null, status: 'active' },
        { slug: 'loom', name: 'Loom', role: 'coordinate', okr: null, status: 'active' },
      ],
      null, // no token → writeAgentDef returns no_token for all
    )
    const res = await syncFleetToGitHub(env, { repo: 'a/b', mcpUrl: 'https://x/mcp' })
    expect(res.synced).toBe(0)
    expect(res.items.every((i) => !i.ok && i.detail === 'no_token')).toBe(true)
  })
})
