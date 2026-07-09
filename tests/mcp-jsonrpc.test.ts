import { describe, expect, it } from 'vitest'
import { mcpActionsApp, mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'

function makeEnv(seen: { authSql?: string; authBinds?: unknown[] } = {}): Env {
  const memberId = 'member-1'
  const grants: CapabilityGrant[] = [
    { member_id: memberId, scope_type: 'org', scope_id: null, capability: 'admin' },
  ]

  return {
    TENANT_SLUG: 'digid',
    BRAND: 'Digid',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM member_tokens')) {
                  seen.authSql = sql
                  seen.authBinds = args
                  return {
                    member_id: memberId,
                    email: null,
                    display_name: 'Digid agent admin',
                    telegram_chat_id: null,
                    status: 'active',
                    created_at: '2026-06-09 00:00:00',
                    channel: 'workspace',
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
        }
      },
    },
  } as unknown as Env
}

async function rpc(method: string, params?: unknown, auth = false) {
  return mcpApp.request(
    'https://pot.example/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: 'Bearer test-token' } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    makeEnv(),
  )
}

describe('mcp JSON-RPC compatibility', () => {
  it('initializes without a bearer token for ChatGPT connector discovery', async () => {
    const res = await rpc('initialize')
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { capabilities: unknown; serverInfo: { name: string } } }
    expect(body.result.serverInfo.name).toBe('mupot-digid')
    expect(body.result.capabilities).toEqual({ tools: {} })
  })

  it('lists MCP tools with JSON schemas without a bearer token', async () => {
    const res = await rpc('tools/list')
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { tools: { name: string; inputSchema: unknown }[] } }
    expect(body.result.tools.map((t) => t.name)).toContain('status')
    expect(body.result.tools.find((t) => t.name === 'task_create')?.inputSchema).toMatchObject({
      type: 'object',
      // #142 capsule keystone: done_when is now required alongside squad_id + title.
      required: ['squad_id', 'title', 'done_when'],
    })
  })

  it('requires bearer auth for JSON-RPC tools/call', async () => {
    const res = await rpc('tools/call', { name: 'status', arguments: {} })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toBe('unauthenticated')
  })

  it('calls an authenticated tool through JSON-RPC tools/call', async () => {
    const res = await rpc('tools/call', { name: 'status', arguments: {} }, true)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      result: { structuredContent: { tenant: string; capabilities: CapabilityGrant[] } }
    }
    expect(body.result.structuredContent.tenant).toBe('digid')
    expect(body.result.structuredContent.capabilities[0]).toMatchObject({
      scope_type: 'org',
      capability: 'admin',
    })
  })

  it('binds MCP bearer auth to the current tenant', async () => {
    const seen: { authSql?: string; authBinds?: unknown[] } = {}
    const res = await mcpApp.request(
      'https://pot.example/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }),
      },
      makeEnv(seen),
    )

    expect(res.status).toBe(200)
    expect(seen.authSql).toContain('t.tenant = ?2')
    expect(seen.authSql).toContain('m.tenant = ?2')
    expect(seen.authBinds?.[1]).toBe('digid')
  })

  it('preserves the legacy {tool,args} invocation contract', async () => {
    const res = await mcpApp.request(
      'https://pot.example/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({ tool: 'status', args: {} }),
      },
      makeEnv(),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; result: { tenant: string } }
    expect(body.ok).toBe(true)
    expect(body.result.tenant).toBe('digid')
  })
})

describe('custom GPT Actions compatibility', () => {
  it('serves an OpenAPI schema with actions for every MCP tool', async () => {
    const res = await mcpActionsApp.request('https://pot.example/openapi.json', {}, makeEnv())
    expect(res.status).toBe(200)
    const body = await res.json() as {
      openapi: string
      paths: Record<string, unknown>
      components: { securitySchemes: Record<string, unknown> }
    }
    expect(body.openapi).toBe('3.0.3')
    expect(body.paths['/actions/status']).toBeTruthy()
    expect(body.paths['/actions/task_create']).toBeTruthy()
    expect(body.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
  })

  it('calls an action with the same bearer-token principal', async () => {
    const res = await mcpActionsApp.request(
      'https://pot.example/actions/status',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
        body: JSON.stringify({}),
      },
      makeEnv(),
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; result: { tenant: string } }
    expect(body.ok).toBe(true)
    expect(body.result.tenant).toBe('digid')
  })
})
