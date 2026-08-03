import { describe, expect, it, vi } from 'vitest'

import type { Env } from '../src/types'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    fetch() {
      return new Response('oauth-provider', { status: 418 })
    }
  },
}))

const { default: worker } = await import('../src/index')

const env = {
  TENANT_SLUG: 'mumega',
  RELEASE_SHA: 'test',
} as Env

const ctx = { waitUntil() {} } as unknown as ExecutionContext

function rpc(method: string, params?: unknown, headers?: Record<string, string>) {
  return worker.fetch(
    new Request('https://mupot.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    env,
    ctx,
  )
}

describe('public MCP bootstrap before OAuth', () => {
  it('lets ChatGPT initialize and list tool descriptors before linking', async () => {
    expect((await rpc('initialize')).status).toBe(200)

    const listed = await rpc('tools/list')
    expect(listed.status).toBe(200)
    const body = await listed.json() as { result: { tools: { name: string }[] } }
    expect(body.result.tools.some((tool) => tool.name === 'status')).toBe(true)
  })

  it('returns a tool-level OAuth challenge before linking', async () => {
    const response = await rpc('tools/call', { name: 'status', arguments: {} })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      result: { isError: boolean; _meta: { 'mcp/www_authenticate': string[] } }
    }
    expect(body.result.isError).toBe(true)
    expect(body.result._meta['mcp/www_authenticate'][0]).toContain('mupot.example')
  })

  it('still routes bearer-authenticated tool calls through OAuthProvider', async () => {
    const response = await rpc(
      'tools/call',
      { name: 'status', arguments: {} },
      { authorization: 'Bearer opaque-token' },
    )
    expect(response.status).toBe(418)
  })

  it('does not trust an externally supplied internal auth header on the public bypass', async () => {
    const response = await rpc(
      'tools/call',
      { name: 'status', arguments: {} },
      { 'x-mupot-auth-context': JSON.stringify({ memberId: 'forged', tenant: 'mumega' }) },
    )
    const body = await response.json() as { result: { isError: boolean } }
    expect(body.result.isError).toBe(true)
  })
})
