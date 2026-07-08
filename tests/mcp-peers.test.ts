import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { Agent, AuthContext, Env } from '../src/types'

const TENANT = 'test-tenant'
const MEMBER_ID = 'member-1'
const SQUAD_ID = 'squad-1'
const OTHER_SQUAD_ID = 'squad-2'
const AGENT_ID = 'agent-1'

type PeerRow = Agent & {
  presence_source: string | null
  presence_label: string | null
  presence_last_seen_at: string | null
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

function makeEnv(peerRows: PeerRow[] = [
  {
    ...agent(),
    presence_source: 'codex',
    presence_label: 'primary',
    presence_last_seen_at: '2026-07-08 01:50:00',
  },
  {
    ...agent({ id: 'agent-2', slug: 'kasra-review', name: 'Kasra Review', role: 'review' }),
    presence_source: null,
    presence_label: null,
    presence_last_seen_at: null,
  },
]) {
  const agents = new Map<string, Agent>([
    [AGENT_ID, agent()],
    ['agent-2', agent({ id: 'agent-2', slug: 'kasra-review', name: 'Kasra Review', role: 'review' })],
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
                return null
              },
              async all() {
                if (sql.includes('FROM agents a')) {
                  const squadId = args[0] as string
                  const limit = Number(args[2])
                  return { results: peerRows.filter((r) => r.squad_id === squadId).slice(0, limit) }
                }
                return { results: [] }
              },
              async run() {
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  } as unknown as Env

  return { env }
}

describe('MCP peers tool', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T01:55:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is advertised on the MCP surface', () => {
    expect(TOOLS.map((t) => t.name)).toContain('peers')
  })

  it('defaults an agent-bound token to its own squad and marks self', async () => {
    const { env } = makeEnv()

    const res = await invokeTool(auth(), env, 'peers', {}, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as {
      squad: { id: string; slug: string; name: string }
      self_agent_id: string
      peers: Array<{ id: string; is_self: boolean; presence: { liveness: string; last_seen_human: string; source: string | null } }>
    }
    expect(result.squad).toEqual({ id: SQUAD_ID, slug: 'kasra', name: 'Kasra' })
    expect(result.self_agent_id).toBe(AGENT_ID)
    expect(result.peers.map((p) => p.id)).toEqual([AGENT_ID, 'agent-2'])
    expect(result.peers[0].is_self).toBe(true)
    expect(result.peers[0].presence.source).toBe('codex')
    expect(result.peers[0].presence.liveness).toBe('active')
    expect(result.peers[0].presence.last_seen_human).toBe('5m ago')
    expect(result.peers[1].presence.liveness).toBe('never')
  })

  it('allows an explicit squad read with observer capability', async () => {
    const { env } = makeEnv()

    const res = await invokeTool(
      auth({
        boundAgentId: null,
        capabilities: [
          { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'observer' },
        ],
      }),
      env,
      'peers',
      { squad_id: SQUAD_ID },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    expect((res.result as { peers: unknown[] }).peers).toHaveLength(2)
  })

  it('requires a squad id when the token is not agent-bound', async () => {
    const { env } = makeEnv()

    const res = await invokeTool(auth({ boundAgentId: null }), env, 'peers', {}, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(res.error).toBe('invalid_args')
  })

  it('refuses explicit squad reads without observer access to that squad', async () => {
    const { env } = makeEnv()

    const res = await invokeTool(auth(), env, 'peers', { squad_id: OTHER_SQUAD_ID }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(res.error).toBe('forbidden')
    expect(res.detail).toEqual({ need: 'observer', scope: 'squad' })
  })
})
