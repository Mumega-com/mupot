import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const { sendAgentMessage } = vi.hoisted(() => ({
  sendAgentMessage: vi.fn(async () => {
    throw new Error('private pre-insert dependency detail')
  }),
}))

vi.mock('../src/agents/messages', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/agents/messages')>(),
  sendAgentMessage,
}))

import { mcpApp } from '../src/mcp'

const TENANT = 'mumega'
const MEMBER_ID = 'member-wake-reject'
const AGENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const TOKEN_HASH = '15262cc64a0a02d7c114cd40cb31ed04e1848f956dc7cc7c7d6385a1168da667'

let harness: SqliteD1Harness | null = null
afterEach(() => {
  harness?.close()
  harness = null
  sendAgentMessage.mockClear()
})

function envWithMigratedSchema(): Env {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad', 'dept', 'squad', 'Squad');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${AGENT_ID}', 'squad', 'reject-agent', 'Reject Agent', 'member', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'reject@example.test', 'Reject Operator', 'active', '${TENANT}');
    INSERT INTO member_tokens (
      id, member_id, token_hash, label, channel, tenant, expires_at
    ) VALUES (
      'token-reject', '${MEMBER_ID}', '${TOKEN_HASH}', 'reject test', 'workspace', '${TENANT}', NULL
    );
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-reject', '${MEMBER_ID}', 'org', NULL, 'owner');
  `)

  return {
    TENANT_SLUG: TENANT,
    DB: harness.db,
    BUS: { send: vi.fn(async () => undefined) },
    AGENT: {
      idFromName: vi.fn((id: string) => `do:${id}`),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response('{"private":"do detail"}', { status: 503 })),
      })),
    },
  } as unknown as Env
}

describe('wake envelope dependency rejection', () => {
  it('returns fixed MCP wake_failed without reflecting a pre-insert send rejection', async () => {
    const response = await mcpApp.request('https://pot.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wake-token' },
      body: JSON.stringify({
        tool: 'wake_agent',
        args: { agent_id: AGENT_ID, reason: 'dependency-rejection' },
      }),
    }, envWithMigratedSchema())
    const text = await response.text()

    expect(response.status).toBe(409)
    expect(sendAgentMessage).toHaveBeenCalledOnce()
    expect(text).toContain('wake_failed')
    expect(text).not.toContain('private pre-insert dependency detail')
    expect(text).not.toContain('do detail')
  })
})
