import { describe, expect, it } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { Agent, AuthContext, Env } from '../src/types'

const TENANT = 'test-tenant'
const MEMBER_ID = 'member-1'
const SQUAD_ID = 'squad-1'
const OTHER_SQUAD_ID = 'squad-2'
const AGENT_ID = 'agent-1'

interface MessageRow {
  seq: number
  id: string
  tenant: string
  to_agent: string
  from_agent: string
  from_member: string
  kind: string
  body: string
  request_id: string | null
  in_reply_to: string | null
  created_at: string
  read_at: string | null
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
    ...overrides,
  }
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    squad_id: SQUAD_ID,
    slug: 'kasra-code',
    name: 'Kasra Code',
    role: 'code',
    model: '@cf/test',
    status: 'active',
    created_at: '2026-07-08T00:00:00.000Z',
    ...overrides,
  }
}

function makeEnv() {
  const messages: MessageRow[] = []
  let seq = 0
  const agents = new Map<string, Agent>([
    [AGENT_ID, agent()],
    ['agent-2', agent({ id: 'agent-2', slug: 'kasra-review', name: 'Kasra Review', role: 'review' })],
    ['agent-3', agent({ id: 'agent-3', slug: 'kasra-research', name: 'Kasra Research', role: 'research' })],
    ['agent-paused', agent({ id: 'agent-paused', slug: 'paused', name: 'Paused', status: 'paused' })],
    ['agent-other', agent({ id: 'agent-other', squad_id: OTHER_SQUAD_ID, slug: 'other', name: 'Other' })],
  ])
  const squads = new Map([
    [SQUAD_ID, { id: SQUAD_ID, department_id: 'dept-1', slug: 'kasra', name: 'Kasra', charter: null, created_at: 'now' }],
    [OTHER_SQUAD_ID, { id: OTHER_SQUAD_ID, department_id: 'dept-2', slug: 'other', name: 'Other', charter: null, created_at: 'now' }],
  ])

  const env = {
    TENANT_SLUG: TENANT,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM agents WHERE id = ?1')) return agents.get(args[0] as string) ?? null
                if (sql.includes('SELECT department_id FROM squads')) {
                  return { department_id: squads.get(args[0] as string)?.department_id ?? null }
                }
                if (sql.includes('FROM squads WHERE id = ?1')) return squads.get(args[0] as string) ?? null
                if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
                  const [tenant, fromAgent, requestId] = args as [string, string, string]
                  const row = messages.find((m) => m.tenant === tenant && m.from_agent === fromAgent && m.request_id === requestId)
                  return row
                    ? {
                        id: row.id,
                        seq: row.seq,
                        to_agent: row.to_agent,
                        kind: row.kind,
                        body: row.body,
                        in_reply_to: row.in_reply_to,
                      }
                    : null
                }
                return null
              },
              async all() {
                if (sql.includes('FROM agents') && sql.includes('WHERE squad_id = ?1')) {
                  const [squadId, limit] = args as [string, number]
                  return {
                    results: [...agents.values()]
                      .filter((a) => a.squad_id === squadId && a.status === 'active')
                      .sort((a, b) => a.slug.localeCompare(b.slug))
                      .slice(0, limit)
                      .map(({ id, slug, name }) => ({ id, slug, name })),
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO agent_messages')) {
                  const [id, tenant, toAgent, fromAgent, fromMember, kind, body, requestId, inReplyTo, createdAt] =
                    args as [string, string, string, string, string, string, string, string | null, string | null, string]
                  if (
                    requestId != null &&
                    messages.some((m) => m.tenant === tenant && m.from_agent === fromAgent && m.request_id === requestId)
                  ) {
                    throw new Error('UNIQUE constraint failed: idx_agent_messages_rid')
                  }
                  messages.push({
                    seq: ++seq,
                    id,
                    tenant,
                    to_agent: toAgent,
                    from_agent: fromAgent,
                    from_member: fromMember,
                    kind,
                    body,
                    request_id: requestId,
                    in_reply_to: inReplyTo,
                    created_at: createdAt,
                    read_at: null,
                  })
                  return { meta: { changes: 1, last_row_id: seq } }
                }
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  } as unknown as Env

  return { env, messages }
}

describe('MCP broadcast tool', () => {
  it('is advertised on the MCP surface', () => {
    expect(TOOLS.map((t) => t.name)).toContain('broadcast')
  })

  it('fans out to active squad peers and excludes the sender by default', async () => {
    const { env, messages } = makeEnv()

    const res = await invokeTool(auth(), env, 'broadcast', { body: 'standup now', kind: 'message' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as { ok: boolean; attempted: number; delivered: number; failed: number; deliveries: Array<{ to: string }> }
    expect(result).toMatchObject({ ok: true, attempted: 2, delivered: 2, failed: 0 })
    expect(result.deliveries.map((d) => d.to).sort()).toEqual(['agent-2', 'agent-3'])
    expect(messages.map((m) => m.to_agent).sort()).toEqual(['agent-2', 'agent-3'])
    expect(messages.every((m) => m.from_agent === AGENT_ID && m.from_member === MEMBER_ID)).toBe(true)
    expect(messages.every((m) => m.body === 'standup now')).toBe(true)
    expect(messages.map((m) => m.to_agent)).not.toContain(AGENT_ID)
    expect(messages.map((m) => m.to_agent)).not.toContain('agent-paused')
  })

  it('can include self when explicitly requested', async () => {
    const { env, messages } = makeEnv()

    const res = await invokeTool(auth(), env, 'broadcast', { body: 'all hands', include_self: true }, 'https://pot.example')

    expect(res.ok).toBe(true)
    expect((res.result as { delivered: number }).delivered).toBe(3)
    expect(messages.map((m) => m.to_agent).sort()).toEqual([AGENT_ID, 'agent-2', 'agent-3'].sort())
  })

  it('derives per-recipient request ids so retrying the same broadcast is idempotent', async () => {
    const { env, messages } = makeEnv()
    const args = { body: 'please ack', kind: 'request', request_id: 'broadcast-1' }

    const first = await invokeTool(auth(), env, 'broadcast', args, 'https://pot.example')
    const second = await invokeTool(auth(), env, 'broadcast', args, 'https://pot.example')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(messages).toHaveLength(2)
    const retry = second.result as { ok: boolean; deliveries: Array<{ duplicate: boolean; request_id: string }> }
    expect(retry.ok).toBe(true)
    expect(retry.deliveries.every((d) => d.duplicate)).toBe(true)
    expect(new Set(retry.deliveries.map((d) => d.request_id)).size).toBe(2)
    expect(retry.deliveries.every((d) => d.request_id.startsWith('bcast:'))).toBe(true)
  })

  it('reports per-recipient conflicts when a request id is reused with different content', async () => {
    const { env, messages } = makeEnv()

    await invokeTool(auth(), env, 'broadcast', { body: 'v1', request_id: 'broadcast-2' }, 'https://pot.example')
    const conflict = await invokeTool(auth(), env, 'broadcast', { body: 'v2', request_id: 'broadcast-2' }, 'https://pot.example')

    expect(conflict.ok).toBe(true)
    const result = conflict.result as { ok: boolean; delivered: number; failed: number; failures: Array<{ error: string }> }
    expect(result.ok).toBe(false)
    expect(result.delivered).toBe(0)
    expect(result.failed).toBe(2)
    expect(result.failures.map((f) => f.error)).toEqual(['request_id_conflict', 'request_id_conflict'])
    expect(messages).toHaveLength(2)
  })

  it('refuses non-agent-bound callers and cross-squad broadcasts', async () => {
    const { env } = makeEnv()

    const noAgent = await invokeTool(auth({ boundAgentId: null }), env, 'broadcast', { squad_id: SQUAD_ID, body: 'x' }, 'https://pot.example')
    expect(noAgent.ok).toBe(false)
    expect(noAgent.error).toBe('not_agent_bound')

    const crossSquad = await invokeTool(auth(), env, 'broadcast', { squad_id: OTHER_SQUAD_ID, body: 'x' }, 'https://pot.example')
    expect(crossSquad.ok).toBe(false)
    expect(crossSquad.status).toBe(403)
    expect(crossSquad.detail).toEqual({ need: 'member', scope: 'squad' })
  })

  it('validates kind and request id before writing', async () => {
    const { env, messages } = makeEnv()

    const badKind = await invokeTool(auth(), env, 'broadcast', { body: 'x', kind: 'ack' }, 'https://pot.example')
    const badRid = await invokeTool(auth(), env, 'broadcast', { body: 'x', request_id: 'has space' }, 'https://pot.example')

    expect(badKind.ok).toBe(false)
    expect(badKind.error).toBe('invalid_args')
    expect(badRid.ok).toBe(false)
    expect(badRid.error).toBe('invalid_request_id')
    expect(messages).toEqual([])
  })
})
