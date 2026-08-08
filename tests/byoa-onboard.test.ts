import { describe, expect, it } from 'vitest'
import { byoaOnboardPageBody, byoaOnboardSuccessBody, loadByoaOnboardView } from '../src/dashboard/byoa-onboard'
import { getHarnessPack } from '../src/byoa/catalog'
import { mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'

function render(node: unknown): string {
  return String(node)
}

function makeEnv(): Env {
  const memberId = 'member-operator'
  const grants: CapabilityGrant[] = [
    { member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' },
  ]
  return {
    TENANT_SLUG: 'test',
    BRAND: 'Test',
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this
          },
          async first() {
            if (sql.includes('FROM member_tokens')) {
              return {
                member_id: memberId,
                email: null,
                display_name: 'Operator',
                telegram_chat_id: null,
                status: 'active',
                created_at: '2026-06-09 00:00:00',
                channel: 'workspace',
                bound_agent_id: null,
              }
            }
            return null
          },
          async all() {
            if (sql.includes('FROM capabilities') || sql.includes('capability')) {
              return { results: grants }
            }
            return { results: grants }
          },
          async run() {
            return { meta: { changes: 0 } }
          },
        }
      },
      async batch() {
        return []
      },
    },
  } as unknown as Env
}

async function call(name: string, args: Record<string, unknown>) {
  return mcpApp.request(
    'https://agents.digid.ca/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    },
    makeEnv(),
  )
}

describe('BYOA onboarding dashboard helpers', () => {
  it('renders the harness picker and MCP flow hint', () => {
    const view = loadByoaOnboardView([{ id: 'squad-1', name: 'Growth', dept_name: 'Ops' }])
    const html = render(byoaOnboardPageBody(view))
    expect(html).toContain('Bring your own agent')
    expect(html).toContain('name="harness"')
    expect(html).toContain('codex')
    expect(html).toContain('get_harness_pack')
    expect(html).toContain('data-byoa-submit')
  })

  it('renders show-once success with pack files', () => {
    const pack = getHarnessPack('codex')
    expect(pack.ok).toBe(true)
    if (!pack.ok) return
    const html = render(
      byoaOnboardSuccessBody({
        agentName: 'Coder',
        agentSlug: 'coder',
        agentId: 'agent-1',
        squadName: 'Growth',
        harness: pack.harness,
        rawToken: 'mupot_' + 'a'.repeat(64),
        tokenId: 'tok-1',
        capability: 'member',
        keyStatus: null,
        mcpEndpoint: 'https://pot.example/mcp',
      }),
    )
    expect(html).toContain('data-byoa-success')
    expect(html).toContain('data-harness="codex"')
    expect(html).toContain('config.toml')
    expect(html).toContain('/agents/onboard/packs/codex')
  })
})

describe('BYOA MCP pack tools', () => {
  it('advertises list_harness_packs and get_harness_pack', async () => {
    const res = await mcpApp.request(
      'https://agents.digid.ca/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      makeEnv(),
    )
    const body = (await res.json()) as { result: { tools: { name: string }[] } }
    const names = body.result.tools.map((t) => t.name)
    expect(names).toContain('list_harness_packs')
    expect(names).toContain('get_harness_pack')
  })

  it('list_harness_packs returns shippable A/C packs and docs-only Desktop', async () => {
    const res = await call('list_harness_packs', {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: {
        structuredContent: {
          packs: { id: string }[]
          docs_only: { id: string }[]
          flow: string[]
        }
      }
    }
    const sc = body.result.structuredContent
    expect(sc.flow).toContain('create_agent')
    expect(sc.flow).toContain('get_harness_pack')
    expect(sc.packs.map((p) => p.id)).toContain('codex')
    expect(sc.packs.map((p) => p.id)).toContain('cursor-background')
    expect(sc.docs_only.map((d) => d.id)).toContain('claude-desktop')
  })

  it('get_harness_pack returns embedded files for codex', async () => {
    const res = await call('get_harness_pack', { harness: 'codex' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: { structuredContent: { files: { path: string; content: string }[]; harness: string } }
    }
    const sc = body.result.structuredContent
    expect(sc.harness).toBe('codex')
    expect(sc.files.some((f) => f.path === 'config.toml')).toBe(true)
    expect(sc.files.map((f) => f.content).join('')).toContain('bearer_token_env_var')
    expect(JSON.stringify(sc)).not.toMatch(/mupot_[0-9a-f]{64}/)
  })

  it('get_harness_pack refuses Claude Desktop', async () => {
    const res = await call('get_harness_pack', { harness: 'claude-desktop' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('docs_only')
  })
})
