// tests/seat-agent-binding.test.ts — one token, many seat-scoped agent identities.
//
// The weld (member_tokens.agent_id) is one identity per token. Before this rail,
// connect { agent_name } on an already-welded token reported binding:"session_local"
// and persisted nothing, so every harness on that token stayed the welded agent.
// seat_agent_bindings is the override: identity resolves from (token, seat) when a
// row exists, else from the weld. Capabilities are unaffected.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'acme'
const ORIGIN = 'https://pot.test'
const MEMBER_ID = 'member-human'
const OTHER_MEMBER_ID = 'member-other'
const TOKEN_ID = 'token-human'
const SQUAD_ID = 'squad-eng'
const DEPT_ID = 'dept-eng'
const AGENT_WELD = { id: 'agent-weld', slug: 'welded', name: 'Welded Agent' }
const AGENT_RIVER = { id: 'agent-river', slug: 'cursor-river', name: 'Cursor River' }
const AGENT_CURSOR = { id: 'agent-cursor', slug: 'cursor-cloud', name: 'Cursor Cloud' }

function grant(capability: CapabilityGrant['capability'] = 'member'): CapabilityGrant {
  return { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability }
}

function weldedAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'human@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_WELD.id,
    tokenId: TOKEN_ID,
    capabilities: [grant()],
    ...overrides,
  }
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('${DEPT_ID}', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'eng', 'Engineering');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${AGENT_WELD.id}', '${SQUAD_ID}', '${AGENT_WELD.slug}', '${AGENT_WELD.name}', 'active'),
      ('${AGENT_RIVER.id}', '${SQUAD_ID}', '${AGENT_RIVER.slug}', '${AGENT_RIVER.name}', 'active'),
      ('${AGENT_CURSOR.id}', '${SQUAD_ID}', '${AGENT_CURSOR.slug}', '${AGENT_CURSOR.name}', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('${MEMBER_ID}', 'human@example.test', 'Human', 'active', '${TENANT}'),
      ('${OTHER_MEMBER_ID}', 'other@example.test', 'Other', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-human-eng', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENT_WELD.id}', '${MEMBER_ID}', '2026-09-01T00:00:00.000Z');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, created_at, revoked_at,
      agent_id, tenant, expires_at
    ) VALUES (
      '${TOKEN_ID}', '${MEMBER_ID}', 'hash-token-human', 'workspace', 'workspace',
      '2026-09-01T00:00:00.000Z', NULL, '${AGENT_WELD.id}', '${TENANT}', '2099-01-01T00:00:00.000Z'
    );
  `)
}

let harness: SqliteD1Harness
let env: Env

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
})

afterEach(() => {
  harness.close()
})

type ConnectResult = {
  connection_status: string
  binding: string
  seat?: string
  next_step: string
  claimed_agent: { id: string }
}

function bindings(): Array<Record<string, unknown>> {
  return harness.sqlite
    .prepare('SELECT tenant, token_id, seat, agent_id, member_id FROM seat_agent_bindings ORDER BY seat')
    .all()
}

describe('migration 0139 — seat_agent_bindings', () => {
  it('creates seat_agent_bindings with the (tenant, token_id, seat) primary key', () => {
    const cols = harness.sqlite.prepare('PRAGMA table_info(seat_agent_bindings)').all() as Array<{
      name: string
      pk: number
    }>
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['agent_id', 'bound_at', 'last_seen_at', 'member_id', 'seat', 'tenant', 'token_id'].sort(),
    )
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    expect(pk).toEqual(['tenant', 'token_id', 'seat'])

    const indexes = harness.sqlite
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'seat_agent_bindings'`,
      )
      .all() as Array<{ name: string; sql: string | null }>
    expect(
      indexes.some(
        (idx) =>
          typeof idx.sql === 'string' && idx.sql.includes('tenant') && idx.sql.includes('agent_id'),
      ),
    ).toBe(true)
  })
})

describe('connect writes a seat binding on an already-welded token', () => {
  it('connect { agent_name, seat } persists a row and returns binding: seat', async () => {
    const outcome = await invokeTool(
      weldedAuth(),
      env,
      'connect',
      { agent_name: AGENT_RIVER.slug, seat: 'cursor-ide' },
      { origin: ORIGIN, transport: 'mcp' },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as ConnectResult
    expect(result.connection_status).toBe('hot')
    expect(result.binding).toBe('seat')
    expect(result.seat).toBe('cursor-ide')
    expect(result.claimed_agent.id).toBe(AGENT_RIVER.id)
    expect(bindings()).toEqual([
      {
        tenant: TENANT,
        token_id: TOKEN_ID,
        seat: 'cursor-ide',
        agent_id: AGENT_RIVER.id,
        member_id: MEMBER_ID,
      },
    ])
  })

  it('two seats on the same token bind two different agents and both rows coexist', async () => {
    const first = await invokeTool(
      weldedAuth(),
      env,
      'connect',
      { agent_name: AGENT_RIVER.id, seat: 'cursor-ide' },
      { origin: ORIGIN, transport: 'mcp' },
    )
    const second = await invokeTool(
      weldedAuth(),
      env,
      'connect',
      { agent_name: AGENT_CURSOR.id, seat: 'cursor-cloud' },
      { origin: ORIGIN, transport: 'mcp' },
    )
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok) expect((first.result as ConnectResult).binding).toBe('seat')
    if (second.ok) expect((second.result as ConnectResult).binding).toBe('seat')
    expect(bindings()).toEqual([
      {
        tenant: TENANT,
        token_id: TOKEN_ID,
        seat: 'cursor-cloud',
        agent_id: AGENT_CURSOR.id,
        member_id: MEMBER_ID,
      },
      {
        tenant: TENANT,
        token_id: TOKEN_ID,
        seat: 'cursor-ide',
        agent_id: AGENT_RIVER.id,
        member_id: MEMBER_ID,
      },
    ])
  })

  it('connect with no seat on an already-welded token returns binding: none and does not claim session_local', async () => {
    const outcome = await invokeTool(
      weldedAuth(),
      env,
      'connect',
      { agent_name: AGENT_RIVER.slug },
      { origin: ORIGIN, transport: 'mcp' },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as ConnectResult
    expect(result.binding).toBe('none')
    expect(result.binding).not.toBe('session_local')
    expect(JSON.stringify(result)).not.toContain('session_local')
    expect(result.next_step).toMatch(/seat/i)
    expect(result.next_step).toMatch(/welded/i)
    expect(bindings()).toEqual([])
  })
})

describe('invokeTool resolves identity from a matching seat binding', () => {
  async function bindSeat(seat: string, agentId: string): Promise<void> {
    const outcome = await invokeTool(
      weldedAuth(),
      env,
      'connect',
      { agent_name: agentId, seat },
      { origin: ORIGIN, transport: 'mcp', seat },
    )
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  }

  it('ctx.seat resolves identity to the seat-bound agent, not the token weld', async () => {
    await bindSeat('cursor-ide', AGENT_RIVER.id)
    const auth = weldedAuth()
    const outcome = await invokeTool(
      auth,
      env,
      'boot_context',
      {},
      { origin: ORIGIN, transport: 'mcp', seat: 'cursor-ide' },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as { bound_agent_id: string | null; identity_status: string }
    expect(result.bound_agent_id).toBe(AGENT_RIVER.id)
    expect(result.bound_agent_id).not.toBe(AGENT_WELD.id)
    // caller auth object is not mutated — other requests may share it
    expect(auth.boundAgentId).toBe(AGENT_WELD.id)
  })

  it('ctx.seat with no matching binding falls back to the token weld', async () => {
    await bindSeat('cursor-ide', AGENT_RIVER.id)
    const outcome = await invokeTool(
      weldedAuth(),
      env,
      'boot_context',
      {},
      { origin: ORIGIN, transport: 'mcp', seat: 'unknown-harness' },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as { bound_agent_id: string | null }
    expect(result.bound_agent_id).toBe(AGENT_WELD.id)
  })

  it('a binding whose member_id differs from the caller is not honoured', async () => {
    harness.sqlite.exec(`
      INSERT INTO seat_agent_bindings (tenant, token_id, seat, agent_id, member_id)
      VALUES ('${TENANT}', '${TOKEN_ID}', 'stolen-seat', '${AGENT_RIVER.id}', '${OTHER_MEMBER_ID}')
    `)
    const outcome = await invokeTool(
      weldedAuth(),
      env,
      'boot_context',
      {},
      { origin: ORIGIN, transport: 'mcp', seat: 'stolen-seat' },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const result = outcome.result as { bound_agent_id: string | null }
    expect(result.bound_agent_id).toBe(AGENT_WELD.id)
    expect(result.bound_agent_id).not.toBe(AGENT_RIVER.id)
  })
})
