import { describe, expect, it } from 'vitest'
import { mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'

// boot_context MCP tool — #126 identity_status signal for coherent first-run onboarding.
//
// The tool derives identity_status from member_tokens.agent_id (the weld, migration 0019):
//   - bound_agent_id set   → token is an agent-minted seat → "minted"
//   - bound_agent_id null  → human/operator principal      → "unminted"
//
// Tests drive the JSON-RPC seam (tools/call) exactly as a real harness would.

interface Opts {
  boundAgentId?: string | null // member_tokens.agent_id (the weld)
  grants?: CapabilityGrant[]
}

function makeEnv(opts: Opts = {}): Env {
  const memberId = 'member-1'
  const grants = opts.grants ?? [
    { member_id: memberId, scope_type: 'org', scope_id: null, capability: 'member' },
  ]
  const boundAgentId = opts.boundAgentId ?? null

  const handler = (sql: string) => ({
    bind() {
      return {
        async first() {
          if (sql.includes('FROM member_tokens')) {
            return {
              member_id: memberId,
              email: null,
              display_name: 'Test Principal',
              telegram_chat_id: null,
              status: 'active',
              created_at: '2026-06-13 00:00:00',
              channel: 'workspace',
              bound_agent_id: boundAgentId,
            }
          }
          return null
        },
        async all() {
          if (sql.includes('FROM capabilities')) return { results: grants }
          return { results: [] }
        },
      }
    },
  })

  return {
    TENANT_SLUG: 'digid',
    BRAND: 'Digid',
    OAUTH_PROVIDER: 'google',
    DB: { prepare: (sql: string) => handler(sql) },
  } as unknown as Env
}

async function bootContext(env: Env, auth = true) {
  return mcpApp.request(
    'https://agents.digid.ca/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: 'Bearer test-token' } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'boot_context', arguments: {} },
      }),
    },
    env,
  )
}

describe('boot_context MCP tool (#126)', () => {
  it('is advertised in tools/list', async () => {
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
    expect(body.result.tools.map((t) => t.name)).toContain('boot_context')
  })

  it('unminted agent → identity_status:"unminted" with mint next_step', async () => {
    const res = await bootContext(makeEnv({ boundAgentId: null }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: {
        structuredContent: {
          identity_status: string
          bound_agent_id: string | null
          next_step: string
          tenant: string
          member_id: string
          channel: string
        }
      }
    }
    const sc = body.result.structuredContent
    expect(sc.identity_status).toBe('unminted')
    expect(sc.bound_agent_id).toBeNull()
    expect(sc.next_step).toMatch(/mint_agent_token/)
    // stable principal fields present
    expect(sc.tenant).toBe('digid')
    expect(sc.member_id).toBe('member-1')
    expect(sc.channel).toBe('workspace')
  })

  it('minted agent → identity_status:"minted" with orient next_step', async () => {
    const res = await bootContext(makeEnv({ boundAgentId: 'agent-growth-1' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: {
        structuredContent: {
          identity_status: string
          bound_agent_id: string | null
          next_step: string
          mcp_endpoint: string
        }
      }
    }
    const sc = body.result.structuredContent
    expect(sc.identity_status).toBe('minted')
    expect(sc.bound_agent_id).toBe('agent-growth-1')
    expect(sc.next_step).toMatch(/orient/)
    // mcp_endpoint is derived from the request origin
    expect(sc.mcp_endpoint).toContain('https://agents.digid.ca')
  })

  it('401 without a bearer token', async () => {
    const res = await bootContext(makeEnv(), false)
    expect(res.status).toBe(401)
  })

  it('rejects extra args (additionalProperties: false)', async () => {
    const res = await mcpApp.request(
      'https://agents.digid.ca/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'boot_context', arguments: { unexpected_field: 'injected' } },
        }),
      },
      makeEnv({ boundAgentId: null }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBe('invalid_args')
  })
})
