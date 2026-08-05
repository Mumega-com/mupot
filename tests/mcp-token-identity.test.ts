import { describe, expect, it } from 'vitest'
import { authenticateMember } from '../src/mcp'
import type { Env } from '../src/types'

describe('MCP bearer authentication token identity', () => {
  it('derives tokenId and boundAgentId from the same live tenant-scoped token row', async () => {
    const seen: { sql?: string; binds?: unknown[] } = {}
    const env = {
      TENANT_SLUG: 'digid',
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async first() {
                  seen.sql = sql
                  seen.binds = args
                  return {
                    token_id: 'tok-agent-7',
                    member_id: 'member-7',
                    email: null,
                    display_name: 'agent-seven',
                    telegram_chat_id: null,
                    status: 'active',
                    created_at: '2026-07-24 00:00:00',
                    channel: 'workspace',
                    bound_agent_id: 'agent-7',
                  }
                },
                async all() {
                  return { results: [] }
                },
              }
            },
          }
        },
      },
    } as unknown as Env

    const auth = await authenticateMember({
      req: { header: (name) => name.toLowerCase() === 'authorization' ? 'Bearer issued-agent-key' : undefined },
      env,
    })

    expect(auth).toMatchObject({
      tokenId: 'tok-agent-7',
      memberId: 'member-7',
      boundAgentId: 'agent-7',
      tenant: 'digid',
    })
    expect(seen.sql).toMatch(/t\.id\s+AS token_id/)
    expect(seen.sql).toContain('t.tenant = ?2')
    expect(seen.binds?.[1]).toBe('digid')
  })
})
