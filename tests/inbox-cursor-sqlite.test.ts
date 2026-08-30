// tests/inbox-cursor-sqlite.test.ts — MCP inbox cursor semantics on the real schema.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-cursor'
const AGENT = 'agent-cursor'
const CTX = { origin: 'https://pot.test' }
let harness: SqliteD1Harness
let env: Env

function auth(): AuthContext {
  return {
    userId: 'user-cursor',
    email: 'cursor@pot.test',
    role: 'member',
    tenant: TENANT,
    memberId: 'member-cursor',
    capabilities: [],
    boundAgentId: AGENT,
  } as AuthContext
}

function seedUnread(count: number): void {
  for (let seq = 1; seq <= count; seq += 1) {
    harness.sqlite.prepare(
      `INSERT INTO agent_messages
        (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
       VALUES (?, ?, ?, 'agent-sender', 'member-sender', 'message', ?, '2026-08-30T00:00:00Z')`,
    ).run(`message-${seq}`, TENANT, AGENT, `body-${seq}`)
  }
}

function unreadState(): Array<{ seq: number; body: string; read_at: string | null }> {
  return harness.sqlite.prepare(
    `SELECT seq, body, read_at FROM agent_messages
      WHERE tenant = ? AND to_agent = ? ORDER BY seq ASC`,
  ).all(TENANT, AGENT) as Array<{ seq: number; body: string; read_at: string | null }>
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
})

afterEach(() => harness.close())

describe('MCP inbox since_seq cursor', () => {
  it('peeks only rows strictly above since_seq without consuming them', async () => {
    seedUnread(5)

    const result = await invokeTool(auth(), env, 'inbox', {
      limit: 2,
      peek: true,
      since_seq: 2,
    }, CTX)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`inbox failed: ${result.error}`)
    expect((result.result as { messages: Array<{ seq: number; body: string }>; consumed: boolean })).toMatchObject({
      messages: [
        { seq: 3, body: 'body-3' },
        { seq: 4, body: 'body-4' },
      ],
      consumed: false,
    })
    expect(unreadState().map((row) => row.read_at)).toEqual([null, null, null, null, null])
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe since_seq value %s and leaves the inbox untouched',
    async (sinceSeq) => {
      seedUnread(2)

      const result = await invokeTool(auth(), env, 'inbox', { peek: true, since_seq: sinceSeq }, CTX)

      expect(result).toMatchObject({
        ok: false,
        status: 400,
        error: 'invalid_args',
        detail: 'since_seq must be a non-negative safe integer',
      })
      expect(unreadState().map((row) => row.read_at)).toEqual([null, null])
    },
  )

  it('rejects since_seq on a consuming read and leaves every row unread', async () => {
    seedUnread(3)

    const result = await invokeTool(auth(), env, 'inbox', { limit: 1, since_seq: 1 }, CTX)

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: 'invalid_args',
      detail: 'since_seq requires peek=true; use inbox_lease and inbox_ack for reliable consumption',
    })
    expect(unreadState().map((row) => row.read_at)).toEqual([null, null, null])
  })
})
