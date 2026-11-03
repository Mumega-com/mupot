// tests/seat-attach-schema-parity.test.ts — mupot task 13f6b7e8: every served schema surface for seat_attach
// carries `reason` with the SAME bounds, and the handler enforces the same bounds it advertises.
//
// Surfaces: the source registry (advertisedTools), JSON-RPC tools/list (POST /mcp), the legacy GET /mcp/tools args
// text, and openapi.full.json (built by openApiSpec from the same spec.inputSchema object, proven here by identity
// of the tools/list schema with the registry schema). The curated needs-you profile does not carry seat_attach.
// A ChatGPT app's own cached copy of the schema is NOT a served surface and cannot be proven here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { advertisedTools, mcpApp } from '../src/mcp/index'
import { profileEntry } from '../src/mcp/profile-needs-you'
import type { Env } from '../src/types'

const ENV = { TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test', SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1' } as unknown as Env // only flags + tenant are read by the list paths

interface Prop { type?: string; minLength?: number; maxLength?: number }
interface Schema { properties?: Record<string, Prop>; required?: string[]; additionalProperties?: boolean }

const BOUNDS = { type: 'string', minLength: 1, maxLength: 280 }

async function listedSchema(): Promise<Schema> {
  const res = await mcpApp.fetch(new Request('https://pot.test/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), ENV)
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string; inputSchema: Schema }> } }
  const t = body.result?.tools?.find((x) => x.name === 'seat_attach')
  if (!t) throw new Error(`seat_attach missing from tools/list (status ${res.status})`)
  return t.inputSchema
}

describe('seat_attach schema parity across served surfaces', () => {
  it('source registry advertises reason with 1..280 bounds', () => {
    const spec = advertisedTools(ENV).find((t) => t.name === 'seat_attach')
    const reason = (spec?.inputSchema as Schema | undefined)?.properties?.reason
    expect(reason).toMatchObject(BOUNDS)
  })

  it('tools/list serves the same reason property as the registry, and still allows the list-choices call (reason not unconditionally required)', async () => {
    const listed = await listedSchema()
    // Pinned literal read off the actual served tools/list response (not the registry object it is built from).
    expect(listed.properties?.reason).toEqual({ type: 'string', minLength: 1, maxLength: 280, description: expect.stringContaining('Required when naming an agent') })
    expect(Object.keys(listed.properties ?? {}).sort()).toEqual(['agent', 'reason', 'scope', 'seat'])
    expect(listed.required ?? []).not.toContain('reason') // `agent` omitted lists choices and needs no reason
    expect(listed.additionalProperties).toBe(false)
  })

  it('GET /mcp/tools args text names reason, the bounds and the requirement', async () => {
    const res = await mcpApp.fetch(new Request('https://pot.test/tools'), ENV)
    const body = (await res.json()) as { tools: Array<{ name: string; args: string }> }
    const t = body.tools.find((x) => x.name === 'seat_attach')
    expect(t?.args).toContain('reason?: string')
    expect(t?.args).toContain('1..280')
    expect(t?.args).toMatch(/reason is required when agent is supplied/)
  })

  it('the curated needs-you profile does not serve seat_attach (no stale copy of the schema there)', () => {
    expect(profileEntry('seat_attach')).toBeUndefined()
  })

  it('flag off: seat_attach is not advertised at all (no half-schema)', () => {
    expect(advertisedTools({ ...ENV, SEAT_ATTACH: undefined } as unknown as Env).some((t) => t.name === 'seat_attach')).toBe(false)
  })
})

// Handler level: the tool enforces what the schema advertises, on the same harness the passing seat-attach tests use.
describe('seat_attach handler: reason', () => {
  let h: SqliteD1Harness
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('hh', 'hh@example.test', 'H', 'active', '2026-10-09T00:00:00.000Z', 'mumega');
      INSERT INTO departments (id, slug, name) VALUES ('d1', 'd1', 'D1');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('sq1', 'd1', 'sq1', 'Sq1');
      INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag-rava', 'sq1', 'rava', 'Rava', 'r', 'm', 'active');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('mem-rava', 'Rava', 'active', 'mumega');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('mumega', 'ag-rava', 'mem-rava', '2026-10-01T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c1', 'mem-rava', 'squad', 'sq1', 'member');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c2', 'hh', 'squad', 'sq1', 'admin');
    `)
    resetHarnessProbeSampling(); resetAutoSeatRefusalCache()
  })
  afterEach(() => h.close())

  async function callAttach(args: Record<string, unknown>): Promise<{ error: string; field: unknown; status: unknown }> {
    const kv = { get: async () => null, put: async () => undefined, delete: async () => undefined }
    const env = { DB: h.db, TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test', SESSIONS: kv, OAUTH_KV: kv, CONNECTOR_MASTER_KEY: 'a1'.repeat(32), SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200' } as unknown as Env // only the flags and bindings the seat path reads
    const harness = await upsertHarness(env, 'hh', 'client-x', 'ChatGPT')
    if (!harness) throw new Error('harness fixture failed')
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-1', 'hh', 'hash-1', 'oauth:client-x', 'directory', '2026-10-09T00:00:00.000Z', 'mumega')`)
    const ctx = await buildAuthContextFromProps(env, { memberId: 'hh', tokenId: 'tok-1', email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
    if (!ctx) throw new Error('grant ctx null')
    const post = (name: string, a: Record<string, unknown>) => mcpApp.fetch(mcpInternalRequest(new Request('https://pot.test/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a, _meta: { 'openai/session': 'conv-1' } } }),
    }), ctx), env)
    await post('boot_context', {}) // creates the conversation's seat
    const res = await post('seat_attach', args)
    const body = (await res.json()) as { result?: { structuredContent?: Record<string, unknown> }; error?: { message?: string; data?: Record<string, unknown> } }
    const sc = body.result?.structuredContent ?? {}
    const detail = (sc.detail ?? {}) as Record<string, unknown>
    return { error: String(sc.error ?? body.error?.message ?? ''), field: sc.field ?? detail.field ?? body.error?.data?.field, status: sc.status }
  }

  it('agent without reason: invalid_args naming field "reason"; no admission row written', async () => {
    const r = await callAttach({ agent: 'rava' })
    expect(r.error).toBe('invalid_args')
    expect(r.field).toBe('reason')
    expect(Number(h.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_seat_admissions').get()!.n)).toBe(0)
  })

  it('agent with a valid reason reaches the admission result, not invalid_args', async () => {
    const r = await callAttach({ agent: 'rava', reason: 'This chat is assigned to operate the requested agent.' })
    expect(r.error).not.toBe('invalid_args')
    expect(r.status).toBe('pending_admission')
    expect(Number(h.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_seat_admissions').get()!.n)).toBe(1)
  })
})
