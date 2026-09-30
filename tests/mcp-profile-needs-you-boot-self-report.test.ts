// tests/mcp-profile-needs-you-boot-self-report.test.ts — round-2 P1 for PR #1624.
// boot_context runtime/model reach selfReportAtBoot, which WRITES the caller's fleet_agents
// row (status -> 'running' even when an operator stopped it). A read-only-hinted profile tool
// must never reach it. Real mcpApp + real migrations on the sqlite harness.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { mcpApp } from '../src/mcp'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { getFleetAgentLiveness } from '../src/fleet/registry'
import type { AuthContext, Env } from '../src/types'

const AGENT = 'agent-x'
let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: 'mumega', BUS: { send: async () => {} } } as unknown as Env
  // An operator-STOPPED poll-mode agent, last reported two days ago.
  harness.sqlite.exec(`
    INSERT INTO fleet_agents (agent_id, tenant, runtime, model, status, reported_by, presence_mode, presence_ttl_sec, last_reported_at)
    VALUES ('${AGENT}', 'mumega', 'codex', 'orig-model', 'stopped', 'operator', 'poll', 300, datetime('now', '-2 days'));
  `)
})
afterEach(() => harness.close())

const auth: AuthContext = {
  userId: 'mem-1', email: 'a@e.test', role: 'member', tenant: 'mumega', memberId: 'mem-1',
  channel: 'workspace', capabilities: [], boundAgentId: AGENT,
} as AuthContext

async function call(path: string, name: string, args: Record<string, unknown>) {
  const res = await mcpApp.request(
    `https://pot.test${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    },
    env,
  )
  return { status: res.status, json: (await res.json()) as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only probe
}

const row = () =>
  harness.sqlite.prepare(`SELECT runtime, model, status, reported_by, last_reported_at FROM fleet_agents WHERE agent_id = ?`).get(AGENT) as
    { runtime: string; model: string; status: string; reported_by: string; last_reported_at: string }

describe('profile boot_context never reaches selfReportAtBoot', () => {
  for (const args of [{ model: 'gpt-5' }, { runtime: 'grok' }, { model: 'gpt-5', runtime: 'grok' }, { model: null }, { runtime: '' }]) {
    it(`refuses ${JSON.stringify(args)}: stopped row stays stopped, not live, model unchanged`, async () => {
      const before = row()
      const r = await call('/profile/needs-you', 'boot_context', args)
      expect(r.status).toBe(400)
      expect(r.json.error.code).toBe(-32602)
      expect(r.json.error.message).toBe('profile_args_not_allowed')
      expect(row()).toEqual(before)
      expect(row().status).toBe('stopped')
      expect(row().model).toBe('orig-model')
      expect((await getFleetAgentLiveness(env, AGENT)).live).toBe(false)
    })
  }

  it('boot_context with no self-report args still works and leaves the stopped row untouched', async () => {
    const before = row()
    const r = await call('/profile/needs-you', 'boot_context', { source: 'chatgpt' })
    expect(r.status).toBe(200)
    expect(row()).toEqual(before)
    expect((await getFleetAgentLiveness(env, AGENT)).live).toBe(false)
  })

  it('the profile tools/list schema for boot_context omits model and runtime', async () => {
    const res = await mcpApp.request(
      'https://pot.test/profile/needs-you',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      env,
    )
    const tools = ((await res.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }> } }).result.tools
    const boot = tools.find((t) => t.name === 'boot_context')!
    expect(Object.keys(boot.inputSchema.properties).sort()).toEqual(['label', 'seat', 'source'])
    expect(boot.description).not.toMatch(/runtime|model/)
  })

  it('the full /mcp boot_context schema is untouched (still lists runtime/model)', async () => {
    const res = await mcpApp.request('https://pot.test/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }, env)
    const tools = ((await res.json()) as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }).result.tools
    expect(Object.keys(tools.find((t) => t.name === 'boot_context')!.inputSchema.properties)).toEqual(
      expect.arrayContaining(['runtime', 'model']),
    )
  })
})

describe('reserved /mcp/profile namespace on the sub-app', () => {
  it('any other /profile/* path or method is a 404, never /mcp', async () => {
    for (const [method, path] of [['POST', '/profile/needs-you/x'], ['POST', '/profile/needs-you/'], ['POST', '/profile/_not_found'], ['POST', '/profile/other'], ['GET', '/profile/needs-you']]) {
      const res = await mcpApp.request(`https://pot.test${path}`, {
        method, headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) },
        ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) } : {}),
      }, env)
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })
})
