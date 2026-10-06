// mupot#1667: tool-level refusals must reach connector harnesses as HTTP 200 + result.isError,
// not as a 4xx the harness replaces with "blocked by a firewall / mcp_request_blocked".
// Real SQL: the schema is the whole committed migration chain (applyAllMigrations).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpActionsApp, mcpApp } from '../src/mcp'
import { sha256Hex } from '../src/members/service'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { callToolOutcome } from './helpers/mcp-call'

const TENANT = 'digid'
const T0 = '2026-08-01T00:00:00.000Z'
let harness: SqliteD1Harness

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const hash = await sha256Hex('member-tok')
  harness.sqlite.exec(`
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('member-1', NULL, 'Plain member', 'active', '${T0}', '${TENANT}');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('tok-1', 'member-1', '${hash}', 't', 'workspace', '${T0}', NULL, '${TENANT}');
  `)
})

afterEach(() => harness.close())

function makeEnv(): Env {
  return { TENANT_SLUG: TENANT, BRAND: 'Digid', OAUTH_PROVIDER: 'google', DB: harness.db } as unknown as Env // harness D1 adapter satisfies the bindings these paths read
}

function call(app: typeof mcpApp, url: string, payload: unknown, bearer = true) {
  return app.request(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer member-tok' } : {}) },
      body: JSON.stringify(payload),
    },
    makeEnv(),
  )
}

const rpcCall = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pot_list', arguments: {} } }

describe('MCP tool refusals are JSON-RPC isError results (#1667)', () => {
  it('member calling an admin-only tool: HTTP 200 + isError + refusal fields', async () => {
    const res = await call(mcpApp, 'https://pot.example/', rpcCall)
    expect(res.status).toBe(200)
    const outcome = await callToolOutcome(res.clone())
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
    expect(outcome).toMatchObject({ status: 403, error: 'forbidden', isToolRefusal: true })
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
