import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

// mupot#2310: the documented arguments of cursor_run_status and execution_meter_status must work,
// and a missing required argument must say so (invalid_args), not look like a permission failure.

let harness: SqliteD1Harness
function envFor(h: SqliteD1Harness): Env {
  return { DB: h.db, TENANT_SLUG: 'mumega', CURSOR_API_TOKEN: 'tok', BUS: { send: async () => {} } } as unknown as Env
}
function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'm', memberId: 'm', email: 'm@x.test', role: 'member', tenant: 'mumega', channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: 'm', scope_type: 'org', scope_id: null, capability: 'admin' }],
    ...overrides,
  }
}
const call = (a: AuthContext, name: string, args: Record<string, unknown>) =>
  invokeTool(a, envFor(harness), name, args, 'https://pot.example')

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'operator', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m', 'm@x.test', 'M', 'active', 'mumega');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-m', 'm', 'org', NULL, 'admin');
  `)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => {
  vi.unstubAllGlobals()
  harness.close()
})

describe('cursor_run_status argument contract', () => {
  const tool = TOOLS.find((t) => t.name === 'cursor_run_status')

  it('states the real requirement in the schema', () => {
    expect(tool?.args).toContain('reservation_id')
    expect(tool?.args).toMatch(/agent_id.*run_id/)
    expect(JSON.stringify(tool?.inputSchema)).toMatch(/reservation_id, OR both agent_id and run_id/)
  })

  it.each([
    ['no args', {}, 'agent_id, run_id'],
    ['agent_id only', { agent_id: 'a' }, 'run_id'],
    ['run_id only', { run_id: 'r' }, 'agent_id'],
  ])('%s -> invalid_args naming the missing fields', async (_l, args, missing) => {
    const out = await call(auth(), 'cursor_run_status', args)
    expect(out).toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    expect(JSON.stringify((out as { detail?: unknown }).detail)).toContain(`missing: ${missing}`)
  })

  it.each([
    ['reservation_id alone', { reservation_id: 'res-1' }],
    ['agent_id plus run_id', { agent_id: 'a', run_id: 'r' }],
  ])('documented example %s is not an argument error', async (_l, args) => {
    const out = await call(auth(), 'cursor_run_status', args)
    expect(out.ok === false && out.error === 'invalid_args').toBe(false)
  })
})

describe('execution_meter_status argument contract', () => {
  it('documents that agent_id is required unless bound', () => {
    const tool = TOOLS.find((t) => t.name === 'execution_meter_status')
    expect(tool?.args).toMatch(/required unless/)
  })

  it('unbound caller without agent_id -> invalid_args "agent_id required", not 403', async () => {
    expect(await call(auth(), 'execution_meter_status', {})).toMatchObject({ ok: false, status: 400, error: 'invalid_args', detail: 'agent_id required' })
  })

  it('forbidden caller WITH an agent_id still gets 403', async () => {
    const nobody = auth({ capabilities: [] })
    expect(await call(nobody, 'execution_meter_status', { agent_id: 'agent-a' })).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('documented example { agent_id } works for an authorized caller', async () => {
    const out = await call(auth(), 'execution_meter_status', { agent_id: 'agent-a' })
    expect(out).toMatchObject({ ok: true })
  })

  it('bound caller may omit agent_id (self)', async () => {
    const out = await call(auth({ boundAgentId: 'agent-a' }), 'execution_meter_status', {})
    expect(out.ok === false && out.error === 'invalid_args').toBe(false)
  })
})
