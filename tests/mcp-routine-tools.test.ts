import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invokeTool, mcpApp, TOOLS } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { makeReadyRoutineFixture } from './helpers/routine-actions'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const NAMES = [
  'routine_list', 'routine_get', 'routine_create', 'routine_update', 'routine_enable',
  'routine_pause', 'routine_archive', 'routine_run_now', 'routine_run_list',
  'routine_run_get', 'routine_run_answer', 'routine_run_cancel', 'routine_proposal_submit', 'needs_you_list',
] as const

function sessions() {
  const entries = new Map<string, string>()
  return {
    entries,
    get: async <T>(key: string, type?: 'json') => {
      const value = entries.get(key) ?? null
      return type === 'json' && value ? JSON.parse(value) as T : value as T | null
    },
    put: async (key: string, value: string) => { entries.set(key, value) },
    delete: async (key: string) => { entries.delete(key) },
  }
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-write', 'dept-1', 'write', 'Write'), ('squad-read', 'dept-1', 'read', 'Read');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('agent-1', 'squad-write', 'worker', 'Worker', 'active'),
      ('agent-2', 'squad-write', 'other', 'Other', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-write', 'project-write', 'Writable', 'active'),
      ('project-read', 'project-read', 'Read only', 'active'),
      ('project-hidden', 'project-hidden', 'Hidden', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('project-write', 'squad-write', 'write'), ('project-write', 'squad-read', 'read'),
      ('project-read', 'squad-read', 'read');
    INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, gate_owner, created_at, updated_at)
      VALUES ('attention-1', 'squad-write', 'project-write', 'Decision needed', '', 'Done', 'blocked', 'role:delivery', '2026-07-19T10:00:00.000Z', '2026-07-19T10:00:00.000Z');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, SESSIONS: sessions(), TENANT_SLUG: 'tenant-a' } as unknown as Env
}

function grant(capability: CapabilityGrant['capability'], scope_id: string | null, scope_type: CapabilityGrant['scope_type'] = 'squad'): CapabilityGrant {
  return { member_id: 'member-1', capability, scope_id, scope_type }
}

function principal(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'member-1', memberId: 'member-1', email: null, role: 'member', tenant: 'tenant-a',
    channel: 'workspace', boundAgentId: null,
    capabilities: [grant('admin', null, 'org')],
    ...overrides,
  }
}

const policy = {
  name: 'Keep momentum', objective: 'Choose one accountable next action', trigger_kind: 'manual',
  timezone: 'UTC', responsible_squad_id: 'squad-write', budget_micro_usd: 250_000,
  max_occurrences: null,
}

const PUBLIC_RUN_KEYS = [
  'id', 'project_id', 'routine_id', 'routine_revision', 'trigger_kind', 'scheduled_for', 'status',
  'waiting_reason', 'attempt', 'assigned_agent_id', 'task_id', 'flight_id', 'result_summary',
  'cost_micro_usd', 'started_at', 'finished_at', 'created_at', 'updated_at',
].sort()

function assertSafe(value: unknown): void {
  const text = JSON.stringify(value)
  expect(text).not.toContain('"tenant"')
  expect(text).not.toContain('"policy_json"')
  expect(text).not.toContain('"proposal_json"')
}

function expectPublicRun(run: Record<string, unknown>): void {
  expect(Object.keys(run).sort()).toEqual(PUBLIC_RUN_KEYS)
}

type Schema = {
  type?: string | string[]
  const?: unknown
  enum?: unknown[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  items?: Schema
  oneOf?: Schema[]
  pattern?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  format?: string
}

function matchesSchema(schema: Schema, value: unknown): boolean {
  if (schema.oneOf && schema.oneOf.filter(branch => matchesSchema(branch, value)).length !== 1) return false
  if (schema.const !== undefined && value !== schema.const) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types.length > 0 && !types.some(type => (
    type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
      : type === 'array' ? Array.isArray(value)
        : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
          : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
            : type === 'null' ? value === null
              : typeof value === type
  ))) return false
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false
    if (schema.format === 'date-time') {
      const date = new Date(value)
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return false
    }
  }
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return false
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false
    if (schema.items && !value.every(item => matchesSchema(schema.items as Schema, item))) return false
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if ((schema.required ?? []).some(key => !(key in record))) return false
    if (schema.additionalProperties === false && Object.keys(record).some(key => !(key in (schema.properties ?? {})))) return false
    if (schema.properties && Object.entries(record).some(([key, item]) => schema.properties?.[key] !== undefined && !matchesSchema(schema.properties[key], item))) return false
  }
  return true
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function seedRpcAdmin(harness: SqliteD1Harness): Promise<string> {
  const token = 'routine-mcp-test-token'
  harness.sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant) VALUES ('rpc-member', 'RPC member', 'active', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('rpc-admin', 'rpc-member', 'org', NULL, 'admin');
  `)
  harness.sqlite.prepare(
    "INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant) VALUES ('rpc-token', 'rpc-member', ?, 'test', 'workspace', 'tenant-a')",
  ).run(await sha256(token))
  return token
}

async function seedRpcAgent(harness: SqliteD1Harness, capability = 'member'): Promise<string> {
  const token = 'routine-agent-token'
  harness.sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant) VALUES ('agent-member', 'Agent member', 'active', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('agent-member-cap', 'agent-member', 'squad', 'squad-1', '${capability}');
  `)
  harness.sqlite.prepare(
    "INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id) VALUES ('agent-token', 'agent-member', ?, 'test', 'workspace', 'tenant-a', 'agent-1')",
  ).run(await sha256(token))
  return token
}

async function rpcCall(env: Env, token: string, name: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await mcpApp.request('https://pot.test/', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  }, env)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

describe('routine MCP tools', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('discovers exactly the bounded routine surface through JSON-RPC', async () => {
    const response = await mcpApp.request('https://pot.test/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }, { TENANT_SLUG: 'tenant-a' } as Env)
    const body = await response.json() as { result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> } }
    const routines = body.result.tools.filter(tool => tool.name.startsWith('routine_') || tool.name === 'needs_you_list')
    expect(routines.map(tool => tool.name).sort()).toEqual([...NAMES].sort())
    expect(body.result.tools.map(tool => tool.name)).not.toContain('needs_you_resolve')
    const shape: Record<string, { required?: string[]; properties: string[] }> = {
      routine_list: { required: ['project_id'], properties: ['project_id', 'status', 'limit', 'cursor'] },
      routine_get: { required: ['routine_id'], properties: ['routine_id'] },
      routine_create: { required: ['project_id', 'name', 'objective', 'trigger_kind', 'responsible_squad_id', 'budget_micro_usd'], properties: ['project_id', 'name', 'objective', 'trigger_kind', 'run_once_at', 'cron_expression', 'timezone', 'overlap_policy', 'execution_mode', 'responsible_squad_id', 'preferred_agent_id', 'budget_micro_usd', 'max_attempts', 'retry_backoff_seconds', 'max_occurrences', 'stop_at'] },
      routine_update: { required: ['routine_id'], properties: ['routine_id', 'name', 'objective', 'trigger_kind', 'run_once_at', 'cron_expression', 'timezone', 'overlap_policy', 'execution_mode', 'responsible_squad_id', 'preferred_agent_id', 'budget_micro_usd', 'max_attempts', 'retry_backoff_seconds', 'max_occurrences', 'stop_at'] },
      routine_enable: { required: ['routine_id'], properties: ['routine_id'] },
      routine_pause: { required: ['routine_id'], properties: ['routine_id'] },
      routine_archive: { required: ['routine_id'], properties: ['routine_id'] },
      routine_run_now: { required: ['routine_id', 'idempotency_key'], properties: ['routine_id', 'idempotency_key'] },
      routine_run_list: { required: ['project_id'], properties: ['project_id', 'routine_id', 'limit', 'cursor'] },
      routine_run_get: { required: ['run_id'], properties: ['run_id'] },
      routine_run_answer: { required: ['run_id', 'answer'], properties: ['run_id', 'answer'] },
      routine_run_cancel: { required: ['run_id'], properties: ['run_id'] },
      routine_proposal_submit: { required: ['version', 'run_id', 'project_id', 'situation_digest', 'summary', 'action'], properties: ['version', 'run_id', 'project_id', 'situation_digest', 'summary', 'action'] },
      needs_you_list: { properties: ['project_id', 'limit', 'cursor'] },
    }
    for (const tool of routines) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect((tool.inputSchema.required ?? [])).toEqual(shape[tool.name].required ?? [])
      expect(Object.keys(tool.inputSchema.properties as Record<string, unknown>).sort()).toEqual(shape[tool.name].properties.sort())
    }
    expect(TOOLS.find(tool => tool.name === 'routine_run_now')?.inputSchema).toMatchObject({
      required: ['routine_id', 'idempotency_key'],
      properties: { idempotency_key: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9_.:-]{1,200}$' } },
    })
    expect(TOOLS.find(tool => tool.name === 'routine_proposal_submit')?.inputSchema).toMatchObject({
      required: ['version', 'run_id', 'project_id', 'situation_digest', 'summary', 'action'],
      additionalProperties: false,
    })
  })

  it('publishes source-parser-equivalent discriminated proposal schemas', async () => {
    const response = await mcpApp.request('https://pot.test/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }, { TENANT_SLUG: 'tenant-a' } as Env)
    const body = await response.json() as { result: { tools: Array<{ name: string; inputSchema: Schema }> } }
    const schema = body.result.tools.find(tool => tool.name === 'routine_proposal_submit')?.inputSchema
    if (!schema) throw new Error('proposal schema missing')
    const action = schema.properties?.action
    expect(action).toMatchObject({ type: 'object', additionalProperties: false })
    expect(action?.oneOf).toHaveLength(5)
    const base = {
      version: 'routine.proposal/v1', run_id: 'run-1', project_id: 'project-1',
      situation_digest: 'a'.repeat(64), summary: 'A bounded proposal.',
    }
    expect(matchesSchema(schema, { ...base, action: { key: 'no-action', kind: 'no_action', input: { reason: 'No action.' } } })).toBe(true)
    expect(matchesSchema(schema, { ...base, action: { key: 'flight', kind: 'dispatch_flight', input: { goal: 'Flight', task_ids: ['task-1'], artifact_refs: [], budget_micro_usd: 1 } } })).toBe(true)
    expect(matchesSchema(schema, { ...base, action: { key: 'wrong-kind', kind: 'no_action', input: { title: 'Task', description: 'Wrong branch.' } } })).toBe(false)
    expect(matchesSchema(schema, { ...base, action: { key: 'duplicate', kind: 'dispatch_flight', input: { goal: 'Flight', task_ids: ['task-1', 'task-1'], artifact_refs: [], budget_micro_usd: 1 } } })).toBe(false)
    expect(matchesSchema(schema, { ...base, action: { key: 'fraction', kind: 'dispatch_flight', input: { goal: 'Flight', task_ids: ['task-1'], artifact_refs: [], budget_micro_usd: 1.5 } } })).toBe(false)
    expect(matchesSchema(schema, { ...base, action: { key: 'extra', kind: 'no_action', input: { reason: 'No action.', actor_id: 'forged' } } })).toBe(false)
    expect(matchesSchema(schema, { ...base, action: { key: 'bad-time', kind: 'no_action', input: { reason: 'No action.', next_check_at: 'tomorrow' } } })).toBe(false)
  })

  it('uses the shared services for every routine command and returns safe REST-shaped records', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const admin = principal()
    const created = await invokeTool(admin, env, 'routine_create', { project_id: 'project-write', ...policy }, 'https://pot.test')
    expect(created).toMatchObject({ ok: true, result: { routine: { project_id: 'project-write', status: 'draft' } } })
    const routineId = (created.result as { routine: { id: string } }).routine.id
    assertSafe(created.result)

    const scoped = principal({ capabilities: [grant('observer', 'squad-write')] })
    await expect(invokeTool(scoped, env, 'routine_list', { project_id: 'project-hidden' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 404, error: 'project_not_found' })
    await expect(invokeTool(admin, env, 'routine_get', { routine_id: routineId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { routine: { id: routineId } } })
    await expect(invokeTool(admin, env, 'routine_update', { routine_id: routineId, name: 'Keep moving' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { routine: { name: 'Keep moving', revision: 2 } } })
    await expect(invokeTool(admin, env, 'routine_enable', { routine_id: routineId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { routine: { status: 'enabled' } } })
    const first = await invokeTool(admin, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'manual-1' }, 'https://pot.test')
    expect(first).toMatchObject({ ok: true, result: { duplicate: false, run: { routine_id: routineId } } })
    const runId = (first.result as { run: { id: string } }).run.id
    assertSafe(first.result)
    const token = await seedRpcAdmin(harness)
    const rpc = await mcpApp.request('https://pot.test/', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'routine_run_get', arguments: { run_id: runId } } }),
    }, env)
    expect(rpc.status).toBe(200)
    await expect(rpc.json()).resolves.toMatchObject({ result: { structuredContent: { run: { id: runId } } } })
    await expect(invokeTool(admin, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'manual-1' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { duplicate: true, run: { id: runId } } })
    await expect(invokeTool(admin, env, 'routine_run_list', { project_id: 'project-write', limit: 1 }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { runs: [expect.objectContaining({ id: runId })], next_cursor: null } })
    await expect(invokeTool(admin, env, 'routine_run_get', { run_id: runId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { run: { id: runId } } })
    await expect(invokeTool(admin, env, 'routine_pause', { routine_id: routineId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { routine: { status: 'paused' } } })
    await expect(invokeTool(admin, env, 'routine_archive', { routine_id: routineId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { routine: { status: 'archived' } } })
    await expect(invokeTool(admin, env, 'routine_run_cancel', { run_id: runId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { run_id: runId, duplicate: false, outcome: 'confirmed' } })
    await expect(invokeTool(admin, env, 'routine_run_cancel', { run_id: runId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { run_id: runId, duplicate: true, outcome: 'confirmed' } })
    harness.sqlite.prepare("UPDATE routine_runs SET status = 'succeeded' WHERE id = ?").run(runId)
    await expect(invokeTool(admin, env, 'routine_run_cancel', { run_id: runId }, 'https://pot.test'))
      .resolves.toMatchObject({
        ok: true,
        result: { run_id: runId, duplicate: true, outcome: 'confirmed' },
      })
    const attention = await invokeTool(admin, env, 'needs_you_list', { project_id: 'project-write', limit: 1 }, 'https://pot.test')
    expect(attention).toMatchObject({ ok: true, result: { items: [expect.objectContaining({ source_id: 'attention-1' })] } })
    assertSafe(attention.result)
  })

  it('uses the shared exact public Run DTO for create replay list and get', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const admin = principal()
    const created = await invokeTool(admin, env, 'routine_create', { project_id: 'project-write', ...policy }, 'https://pot.test')
    const routineId = (created.result as { routine: { id: string } }).routine.id
    await invokeTool(admin, env, 'routine_enable', { routine_id: routineId }, 'https://pot.test')
    const first = await invokeTool(admin, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'sensitive-key' }, 'https://pot.test')
    const runId = (first.result as { run: { id: string } }).run.id
    harness.sqlite.prepare(`UPDATE routine_runs
      SET occurrence_key = 'manual:sensitive-key', lease_owner = 'secret-lease-owner',
          lease_expires_at = '2026-07-19T18:00:00.000Z', retry_at = '2026-07-19T18:01:00.000Z',
          situation_digest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          proposal_json = '{"raw":"proposal"}'
      WHERE id = ?`).run(runId)

    const replay = await invokeTool(admin, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'sensitive-key' }, 'https://pot.test')
    const listed = await invokeTool(admin, env, 'routine_run_list', { project_id: 'project-write' }, 'https://pot.test')
    const fetched = await invokeTool(admin, env, 'routine_run_get', { run_id: runId }, 'https://pot.test')
    for (const run of [
      (replay.result as { run: Record<string, unknown> }).run,
      (listed.result as { runs: Record<string, unknown>[] }).runs[0],
      (fetched.result as { run: Record<string, unknown> }).run,
    ]) expectPublicRun(run)
  })

  it('enforces observer reads, admin lifecycle/cancellation, and writable responsible-squad run now', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const admin = principal()
    const created = await invokeTool(admin, env, 'routine_create', { project_id: 'project-write', ...policy }, 'https://pot.test')
    const routineId = (created.result as { routine: { id: string } }).routine.id
    await invokeTool(admin, env, 'routine_enable', { routine_id: routineId }, 'https://pot.test')
    const reader = principal({ capabilities: [grant('observer', 'squad-write')] })
    await expect(invokeTool(reader, env, 'routine_get', { routine_id: routineId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true })
    await expect(invokeTool(reader, env, 'routine_update', { routine_id: routineId, name: 'Nope' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    await expect(invokeTool(principal({ boundAgentId: 'agent-1', capabilities: [grant('admin', null, 'org')] }), env, 'routine_pause', { routine_id: routineId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    await expect(invokeTool(reader, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'reader' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    const member = principal({ capabilities: [grant('member', 'squad-write')] })
    await expect(invokeTool(member, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'member-run' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { duplicate: false } })
    const readOnly = principal({ capabilities: [grant('member', 'squad-read')] })
    await expect(invokeTool(readOnly, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'read-only' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    const runId = (await invokeTool(admin, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'admin-run' }, 'https://pot.test')).result as { run: { id: string } }
    await expect(invokeTool(member, env, 'routine_run_cancel', { run_id: runId.run.id }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    await expect(invokeTool(principal({ boundAgentId: 'agent-1', capabilities: [grant('admin', null, 'org')] }), env, 'routine_run_cancel', { run_id: runId.run.id }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('binds proposal submission to the auth-welded assigned agent and action key', async () => {
    const fixture = await makeReadyRoutineFixture('execute_internal')
    harness = fixture.harness
    const proposal = fixture.proposal({ key: 'mcp-no-action', kind: 'no_action', input: { reason: 'No further action.' } })
    const wrongAgent = principal({ boundAgentId: 'agent-2', capabilities: [grant('member', 'squad-1')] })
    await expect(invokeTool(wrongAgent, fixture.env, 'routine_proposal_submit', proposal, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, error: 'assigned_agent_mismatch' })
    const assigned = principal({ boundAgentId: 'agent-1', capabilities: [grant('member', 'squad-1')] })
    await expect(invokeTool(assigned, fixture.env, 'routine_proposal_submit', { ...proposal, agent_id: 'agent-1' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 400, error: 'invalid_args' })
    const accepted = await invokeTool(assigned, fixture.env, 'routine_proposal_submit', proposal, 'https://pot.test')
    expect(accepted).toMatchObject({ ok: true, result: { status: 'succeeded', action_key: 'mcp-no-action', duplicate: false } })
    await expect(invokeTool(assigned, fixture.env, 'routine_proposal_submit', proposal, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { action_key: 'mcp-no-action', duplicate: true } })
    await expect(invokeTool(assigned, fixture.env, 'routine_proposal_submit', {
      ...proposal, action: { ...proposal.action, input: { reason: 'Conflicting replay.' } },
    }, 'https://pot.test')).resolves.toMatchObject({ ok: false, error: 'action_key_conflict' })
  })

  it('resolves an ask-human action through the writable responsible squad', async () => {
    const fixture = await makeReadyRoutineFixture('execute_internal')
    harness = fixture.harness
    const assigned = principal({
      tenant: 'tenant-a', boundAgentId: 'agent-1',
      capabilities: [grant('member', 'squad-1')],
    })
    const proposal = fixture.proposal({
      key: 'mcp-question', kind: 'ask_human',
      input: { question: 'Which outcome is authoritative?', choices: ['Booked', 'Paid'], references: [] },
    })
    await expect(invokeTool(assigned, fixture.env, 'routine_proposal_submit', proposal, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { status: 'waiting', reason: 'answer' } })

    const observer = principal({ capabilities: [grant('observer', 'squad-1')] })
    await expect(invokeTool(observer, fixture.env, 'routine_run_answer', { run_id: 'run-1', answer: 'Paid' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    const responder = principal({ capabilities: [grant('member', 'squad-1')] })
    await expect(invokeTool(responder, fixture.env, 'routine_run_answer', { run_id: 'run-1', answer: 'Unknown' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 400, error: 'invalid_answer' })
    await expect(invokeTool(responder, fixture.env, 'routine_run_answer', { run_id: 'run-1', answer: 'Paid' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { run_id: 'run-1', duplicate: false } })
    await expect(invokeTool(responder, fixture.env, 'routine_run_answer', { run_id: 'run-1', answer: 'Paid' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { run_id: 'run-1', duplicate: true } })
    expect(fixture.harness.sqlite.prepare("SELECT status, result_summary FROM routine_runs WHERE id = 'run-1'").get())
      .toEqual({ status: 'queued', result_summary: 'human_answered' })
  })

  it('denies agent-bound admins on every lifecycle tool and matches REST Run keys', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const admin = principal()
    const agentAdmin = principal({ boundAgentId: 'agent-1', capabilities: [grant('admin', null, 'org')] })
    const created = await invokeTool(admin, env, 'routine_create', { project_id: 'project-write', ...policy }, 'https://pot.test')
    const routineId = (created.result as { routine: { id: string } }).routine.id
    for (const [tool, args] of [
      ['routine_create', { project_id: 'project-write', ...policy, name: 'Agent create' }],
      ['routine_update', { routine_id: routineId, name: 'Agent edit' }],
      ['routine_enable', { routine_id: routineId }],
      ['routine_pause', { routine_id: routineId }],
      ['routine_archive', { routine_id: routineId }],
    ] as const) {
      await expect(invokeTool(agentAdmin, env, tool, args, 'https://pot.test'))
        .resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    }
    await invokeTool(admin, env, 'routine_enable', { routine_id: routineId }, 'https://pot.test')
    const run = await invokeTool(admin, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'rest-parity' }, 'https://pot.test')
    const runId = (run.result as { run: { id: string } }).run.id
    harness.sqlite.prepare(`UPDATE routine_runs
      SET lease_owner = 'lease', lease_expires_at = '2026-07-19T18:00:00.000Z', retry_at = '2026-07-19T18:01:00.000Z',
          situation_digest = '${'cd'.repeat(32)}', proposal_json = '{"x":1}', occurrence_key = 'manual:rest-parity'
      WHERE id = ?`).run(runId)
    const mcpGet = await invokeTool(admin, env, 'routine_run_get', { run_id: runId }, 'https://pot.test')
    expectPublicRun((mcpGet.result as { run: Record<string, unknown> }).run)
    const authState = { current: principal({ capabilities: [grant('admin', null, 'org')] }) }
    // Compare against the shared public DTO keys already asserted by REST route tests.
    expect(Object.keys((mcpGet.result as { run: Record<string, unknown> }).run).sort()).toEqual(PUBLIC_RUN_KEYS)
    void authState
  })

  it('hides revoked proposal replay and classifies MCP cancellation with control children', async () => {
    const fixture = await makeReadyRoutineFixture('execute_internal')
    harness = fixture.harness
    const proposal = fixture.proposal({ key: 'revoked-mcp', kind: 'no_action', input: { reason: 'Done.' } })
    const assigned = principal({
      tenant: 'tenant-a', boundAgentId: 'agent-1',
      capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    })
    await expect(invokeTool(assigned, fixture.env, 'routine_proposal_submit', proposal, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { status: 'succeeded' } })
    const revoked = principal({
      tenant: 'tenant-a', boundAgentId: 'agent-1',
      capabilities: [grant('member', 'squad-write')],
    })
    await expect(invokeTool(revoked, fixture.env, 'routine_proposal_submit', proposal, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, error: 'run_not_found' })
    fixture.harness.sqlite.exec(`
      UPDATE routine_runs SET status = 'waiting', waiting_reason = 'review', proposal_json = NULL WHERE id = 'run-1';
      UPDATE routine_run_actions SET status = 'waiting', result_json = NULL WHERE run_id = 'run-1' AND action_key = 'revoked-mcp';
    `)
    await expect(invokeTool(revoked, fixture.env, 'routine_proposal_submit', proposal, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, error: 'run_not_found' })
    fixture.harness.sqlite.exec(`
      UPDATE routine_runs SET status = 'running', waiting_reason = NULL, proposal_json = NULL WHERE id = 'run-1';
      UPDATE routine_run_actions SET status = 'running' WHERE run_id = 'run-1' AND action_key = 'revoked-mcp';
    `)
    await expect(invokeTool(revoked, fixture.env, 'routine_proposal_submit', proposal, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, error: 'run_not_found' })
    await expect(invokeTool(revoked, fixture.env, 'routine_proposal_submit', { ...proposal, run_id: 'missing-run' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, error: 'run_not_found' })

    const ready = await makeReadyRoutineFixture('execute_internal')
    harness.close()
    harness = ready.harness
    const administrator = principal({
      tenant: 'tenant-a', memberId: 'owner-1', userId: 'owner-1',
      capabilities: [{ member_id: 'owner-1', scope_type: 'org', scope_id: null, capability: 'admin' }],
    })
    const cancelled = await invokeTool(administrator, ready.env, 'routine_run_cancel', { run_id: 'run-1' }, 'https://pot.test')
    expect(cancelled).toMatchObject({
      ok: true, result: { run_id: 'run-1', duplicate: false, outcome: 'unconfirmed' },
    })
    expect(ready.harness.sqlite.prepare("SELECT status FROM flights WHERE id = 'control-flight'").get())
      .toEqual({ status: 'failed' })
    expect(ready.harness.sqlite.prepare("SELECT status FROM tasks WHERE id = 'control-task'").get())
      .toEqual({ status: 'blocked' })
  })

  it('continues opaque run pagination and Needs You cursors through JSON-RPC', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const admin = principal()
    const created = await invokeTool(admin, env, 'routine_create', { project_id: 'project-write', ...policy }, 'https://pot.test')
    const routineId = (created.result as { routine: { id: string } }).routine.id
    await invokeTool(admin, env, 'routine_enable', { routine_id: routineId }, 'https://pot.test')
    await invokeTool(admin, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'page-1' }, 'https://pot.test')
    await invokeTool(admin, env, 'routine_run_now', { routine_id: routineId, idempotency_key: 'page-2' }, 'https://pot.test')
    const page1 = await invokeTool(admin, env, 'routine_run_list', { project_id: 'project-write', limit: 1 }, 'https://pot.test')
    expect(page1).toMatchObject({ ok: true, result: { runs: [expect.any(Object)], next_cursor: expect.any(String) } })
    const cursor = (page1.result as { next_cursor: string }).next_cursor
    const page2 = await invokeTool(admin, env, 'routine_run_list', { project_id: 'project-write', limit: 1, cursor }, 'https://pot.test')
    expect((page2.result as { runs: Array<{ id: string }> }).runs[0].id)
      .not.toEqual((page1.result as { runs: Array<{ id: string }> }).runs[0].id)

    const token = await seedRpcAdmin(harness)
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, gate_owner, created_at, updated_at)
      VALUES ('attention-2', 'squad-write', 'project-write', 'Second decision', '', 'Done', 'blocked', 'role:delivery',
              '2026-07-19T11:00:00.000Z', '2026-07-19T11:00:00.000Z');
    `)
    const rpc1 = await rpcCall(env, token, 'needs_you_list', { project_id: 'project-write', limit: 1 })
    expect(rpc1.status).toBe(200)
    const content1 = (rpc1.body.result as { structuredContent: { items: Array<{ source_id: string }>; next_cursor: string | null } }).structuredContent
    expect(content1.items).toHaveLength(1)
    expect(content1.next_cursor).toEqual(expect.any(String))
    const rpc2 = await rpcCall(env, token, 'needs_you_list', {
      project_id: 'project-write', limit: 1, cursor: content1.next_cursor as string,
    })
    const content2 = (rpc2.body.result as { structuredContent: { items: Array<{ source_id: string }> } }).structuredContent
    expect(content2.items).toHaveLength(1)
    expect(content2.items[0].source_id).not.toEqual(content1.items[0].source_id)
  })

  it('rejects invalid direct invocations and bounded cursors before shared services', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const admin = principal()
    for (const [tool, args] of [
      ['routine_list', { project_id: 'project-write', limit: 101 }],
      ['routine_list', { project_id: 'project-write', cursor: 'not a cursor' }],
      ['routine_run_list', { project_id: 'project-write', limit: 0 }],
      ['routine_run_now', { routine_id: 'x' }],
      ['needs_you_list', { cursor: '<script>' }],
    ] as const) {
      await expect(invokeTool(admin, env, tool, args, 'https://pot.test')).resolves.toMatchObject({ ok: false, status: 400 })
    }
  })
})
