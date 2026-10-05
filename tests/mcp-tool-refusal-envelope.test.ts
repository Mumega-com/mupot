import { describe, expect, it } from 'vitest'
import { mcpActionsApp, mcpApp } from '../src/mcp'
import type { CapabilityGrant, Env } from '../src/types'

// mupot#1667: tool-level refusals must reach connector harnesses as HTTP 200 + result.isError,
// not as a 4xx the harness replaces with "blocked by a firewall / mcp_request_blocked".
function makeEnv(grants: CapabilityGrant[]): Env {
  const memberId = 'member-1'
  return {
    TENANT_SLUG: 'digid',
    BRAND: 'Digid',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM member_tokens')) {
                  return {
                    member_id: memberId, email: null, display_name: 'm', telegram_chat_id: null,
                    status: 'active', created_at: '2026-06-09 00:00:00', channel: 'workspace',
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
  } as unknown as Env // minimal D1 stub: only the auth + capability reads these paths issue
}

const MEMBER: CapabilityGrant[] = []

function call(app: typeof mcpApp, url: string, payload: unknown, bearer = true) {
  return app.request(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer t' } : {}) },
      body: JSON.stringify(payload),
    },
    makeEnv(MEMBER),
  )
}

const rpcCall = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pot_list', arguments: {} } }

describe('MCP tool refusals are JSON-RPC isError results (#1667)', () => {
  it('member calling an admin-only tool: HTTP 200 + isError + refusal fields', async () => {
    const res = await call(mcpApp, 'https://pot.example/', rpcCall)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      id: number
      error?: unknown
      result: { isError: boolean; content: { type: string; text: string }[]; structuredContent: Record<string, unknown> }
    }
    expect(body.id).toBe(7)
    expect(body.error).toBeUndefined()
    expect(body.result.isError).toBe(true)
    const parsed = JSON.parse(body.result.content[0].text) as Record<string, unknown>
    expect(parsed).toMatchObject({ ok: false, tool: 'pot_list', error: 'forbidden', status: 403 })
    expect(parsed.need).toBe('admin')
    expect(body.result.structuredContent).toEqual(parsed)
  })

  it('unauthenticated tools/call stays HTTP 401 with a JSON-RPC error', async () => {
    const res = await call(mcpApp, 'https://pot.example/', rpcCall, false)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { message: string }; result?: unknown }
    expect(body.error.message).toBe('unauthenticated')
    expect(body.result).toBeUndefined()
  })

  it('REST /actions refusal keeps its HTTP status and body', async () => {
    const res = await call(mcpActionsApp as unknown as typeof mcpApp, 'https://pot.example/actions/pot_list', {})
    expect(res.status).toBe(403)
    const body = await res.json() as { ok: boolean; error: string; detail?: { need?: string } }
    expect(body).toMatchObject({ ok: false, error: 'forbidden' })
    expect(body.detail?.need).toBe('admin')
  })

  it('unknown tool is a JSON-RPC -32602 error at HTTP 200, not isError', async () => {
    const res = await call(mcpApp, 'https://pot.example/', { ...rpcCall, params: { name: 'no_such_tool', arguments: {} } })
    expect(res.status).toBe(200)
    const body = await res.json() as { error?: { code: number; message: string }; result?: unknown }
    expect(body.result).toBeUndefined()
    expect(body.error).toMatchObject({ code: -32602, message: 'unknown_tool' })
  })

  it('schema-invalid args are a JSON-RPC -32602 error at HTTP 200, not isError', async () => {
    const res = await call(mcpApp, 'https://pot.example/', { ...rpcCall, params: { name: 'status', arguments: { bogus: 1 } } })
    expect(res.status).toBe(200)
    const body = await res.json() as { error?: { code: number; message: string }; result?: unknown }
    expect(body.result).toBeUndefined()
    expect(body.error).toMatchObject({ code: -32602, message: 'invalid_args' })
  })
})
