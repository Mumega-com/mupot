// tests/supabase-connector-authz.test.ts — the Supabase MCP tools must authorise the CALLER
// against the connector's real scope (agent / squad / pot) before any secret is decrypted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import { addConnector } from '../src/connectors/service'
import { resolveCapabilities } from '../src/auth/capability'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

const TENANT = 'mumega'
let env: Env
let fetchSpy: ReturnType<typeof vi.fn>
const toolSupabaseQuery = 'supabase_query'
const toolSupabaseMutate = 'supabase_mutate'
const toolSupabaseSchema = 'supabase_schema'
const ids: Record<string, string> = {}

async function seedConnector(key: string, scope_type: 'agent' | 'squad' | 'pot', scope_id: string | null, url: string) {
  const r = await addConnector(env, {
    type: 'supabase',
    label: key,
    secret: JSON.stringify({ url, apiKey: `KEY-${key}` }),
    scope_type,
    scope_id,
    created_by: 'mem-owner',
  })
  if (!r.ok) throw new Error(`seed failed: ${r.error}`)
  ids[key] = r.connector.id
}

async function authFor(agent: string | null, member: string, role: AuthContext['role'] = 'member'): Promise<AuthContext> {
  return {
    userId: member,
    memberId: member,
    email: null,
    role,
    tenant: TENANT,
    channel: 'workspace',
    capabilities: await resolveCapabilities(env, member),
    boundAgentId: agent,
  }
}

async function run(tool: string, auth: AuthContext, args: Record<string, unknown>) {
  return invokeTool(auth, env, tool, args, { origin: 'https://pot.example', transport: 'mcp' })
}

beforeEach(async () => {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1','work','Work');
    INSERT INTO squads (id, department_id, slug, name, charter) VALUES
      ('sq-a','dept-1','a','Squad A','a'),('sq-b','dept-1','b','Squad B','b');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('mem-owner','o@example.test','Owner','active','mumega'),
      ('mem-a1',NULL,'a1','active','mumega'),('mem-a2',NULL,'a2','active','mumega'),
      ('mem-b1',NULL,'b1','active','mumega');
    INSERT INTO agents (id, squad_id, slug, name, role) VALUES
      ('ag-a1','sq-a','a1','A1','worker'),('ag-a2','sq-a','a2','A2','worker'),('ag-b1','sq-b','b1','B1','worker');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c-o','mem-owner','org',NULL,'owner'),
      ('c-a1','mem-a1','squad','sq-a','member'),('c-a2','mem-a2','squad','sq-a','member'),
      ('c-b1','mem-b1','squad','sq-b','member');
  `)
  env = { DB: h.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: 'f'.repeat(64) } as unknown as Env
  fetchSpy = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchSpy)
  await seedConnector('A', 'squad', 'sq-a', 'https://a.supabase.co')
  await seedConnector('B', 'squad', 'sq-b', 'https://b.supabase.co')
  await seedConnector('POT', 'pot', null, 'https://pot.supabase.co')
  await seedConnector('AG1', 'agent', 'ag-a1', 'https://ag1.supabase.co')
})

afterEach(() => vi.unstubAllGlobals())

const q = { table: 't' }
const m = { table: 't', action: 'delete', match: { id: '1' } }
const calledUrls = () => fetchSpy.mock.calls.map((c) => String(c[0]))

describe('supabase tools authorise the caller against the connector scope', () => {
  it('refuses a cross-squad connector_id for query, mutate and schema, with no outbound fetch', async () => {
    const a2 = await authFor('ag-a2', 'mem-a2')
    for (const [tool, args] of [[toolSupabaseQuery, q], [toolSupabaseMutate, m], [toolSupabaseSchema, {}]] as const) {
      const r = await run(tool, a2, { ...args, connector_id: ids.B })
      expect(r.ok).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("refuses another squad's id passed as connector_id (original exploit shape)", async () => {
    const a2 = await authFor('ag-a2', 'mem-a2')
    for (const [tool, args] of [[toolSupabaseQuery, q], [toolSupabaseMutate, m], [toolSupabaseSchema, {}]] as const) {
      const r = await run(tool, a2, { ...args, connector_id: 'sq-b' })
      expect(r.ok).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lets a member use their own squad connector by id and with no id', async () => {
    const a2 = await authFor('ag-a2', 'mem-a2')
    expect((await run(toolSupabaseQuery, a2, { ...q, connector_id: ids.A })).ok).toBe(true)
    expect((await run(toolSupabaseQuery, a2, q)).ok).toBe(true)
    expect(calledUrls().every((u) => u.startsWith('https://a.supabase.co'))).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('refuses a pot-wide connector to a member and allows it to an org admin', async () => {
    const a2 = await authFor('ag-a2', 'mem-a2')
    for (const [tool, args] of [[toolSupabaseQuery, q], [toolSupabaseMutate, m], [toolSupabaseSchema, {}]] as const) {
      expect((await run(tool, a2, { ...args, connector_id: ids.POT })).ok).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    const owner = await authFor(null, 'mem-owner')
    expect((await run(toolSupabaseQuery, owner, { ...q, connector_id: ids.POT })).ok).toBe(true)
    expect(calledUrls()[0]).toContain('https://pot.supabase.co')
  })

  it("no-id fallback never selects another squad's or a pot-wide connector for a member", async () => {
    // b1 has no connector of its own except B (its squad); remove it so only A and POT remain visible-but-forbidden.
    await env.DB.prepare(`UPDATE connectors SET revoked_at = '2026-11-10' WHERE id = ?1`).bind(ids.B).run()
    const b1 = await authFor('ag-b1', 'mem-b1')
    for (const [tool, args] of [[toolSupabaseQuery, q], [toolSupabaseMutate, m], [toolSupabaseSchema, {}]] as const) {
      const r = await run(tool, b1, args)
      expect(r.ok).toBe(false)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no-id fallback prefers the agent connector, then the own squad connector', async () => {
    const a1 = await authFor('ag-a1', 'mem-a1')
    expect((await run(toolSupabaseQuery, a1, q)).ok).toBe(true)
    expect(calledUrls()[0]).toContain('https://ag1.supabase.co')
  })

  it('an agent-scoped connector is usable only by that agent', async () => {
    const a2 = await authFor('ag-a2', 'mem-a2')
    expect((await run(toolSupabaseQuery, a2, { ...q, connector_id: ids.AG1 })).ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    const a1 = await authFor('ag-a1', 'mem-a1')
    expect((await run(toolSupabaseQuery, a1, { ...q, connector_id: ids.AG1 })).ok).toBe(true)
  })

  it('an unbound non-admin member gets nothing from the no-id fallback', async () => {
    const human = await authFor(null, 'mem-a1')
    expect((await run(toolSupabaseQuery, human, q)).ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refusal is identical for "not yours" and "does not exist"', async () => {
    const a2 = await authFor('ag-a2', 'mem-a2')
    for (const [tool, args] of [[toolSupabaseQuery, q], [toolSupabaseMutate, m], [toolSupabaseSchema, {}]] as const) {
      const notYours = await run(tool, a2, { ...args, connector_id: ids.B })
      const potNotYours = await run(tool, a2, { ...args, connector_id: ids.POT })
      const missing = await run(tool, a2, { ...args, connector_id: 'does-not-exist' })
      expect(JSON.stringify(notYours)).toBe(JSON.stringify(missing))
      expect(JSON.stringify(potNotYours)).toBe(JSON.stringify(missing))
    }
  })
})
