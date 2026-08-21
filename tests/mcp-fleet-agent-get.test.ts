import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { Agent, AuthContext, Env } from '../src/types'

const TENANT = 'test-tenant'
const MEMBER_ID = 'member-1'
const SQUAD_ID = 'squad-1'
const OTHER_SQUAD_ID = 'squad-2'
const AGENT_ID = 'agent-1'
const OTHER_AGENT_ID = 'agent-other'

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
    slug: 'kasra',
    name: 'Kasra',
    role: 'builder',
    model: '@cf/test',
    status: 'active',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

type FleetRow = {
  agent_id: string
  runtime: string | null
  status: string | null
  last_reported_at: string | null
}

function makeEnv(fleetRows: FleetRow[] = [
  {
    agent_id: AGENT_ID,
    runtime: 'claude-code',
    status: 'running',
    last_reported_at: '2026-08-21 14:00:00',
  },
  {
    agent_id: OTHER_AGENT_ID,
    runtime: 'hermes',
    status: 'running',
    last_reported_at: '2026-08-21 12:00:00',
  },
]) {
  const agents = new Map<string, Agent>([
    [AGENT_ID, agent()],
    [OTHER_AGENT_ID, agent({ id: OTHER_AGENT_ID, squad_id: OTHER_SQUAD_ID, slug: 'hermes', name: 'Hermes' })],
  ])
  const squads = new Map([
    [SQUAD_ID, { id: SQUAD_ID, department_id: 'dept-1', slug: 'squad-1', name: 'Squad 1' }],
    [OTHER_SQUAD_ID, { id: OTHER_SQUAD_ID, department_id: 'dept-2', slug: 'squad-2', name: 'Squad 2' }],
  ])

  const env = {
    TENANT_SLUG: TENANT,
    FLEET_PRESENCE_TTL_SEC: '300',
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM agents WHERE id = ?1')) {
                  return agents.get(args[0] as string) ?? null
                }
                if (sql.includes('SELECT slug FROM agents WHERE id = ?1')) {
                  const a = agents.get(args[0] as string)
                  return a ? { slug: a.slug } : null
                }
                if (sql.includes('SELECT department_id FROM squads')) {
                  return { department_id: squads.get(args[0] as string)?.department_id ?? null }
                }
                if (sql.includes('FROM squads WHERE id = ?1')) {
                  return squads.get(args[0] as string) ?? null
                }
                if (sql.includes('FROM fleet_agents WHERE tenant = ?1 AND agent_id = ?2')) {
                  const agentRef = args[1] as string
                  const row = fleetRows.find((r) => r.agent_id === agentRef)
                  return row ?? null
                }
                if (sql.includes('COUNT(*) AS n FROM agents WHERE slug = ?1')) {
                  const slug = args[0] as string
                  const matches = Array.from(agents.values()).filter((a) => a.slug === slug)
                  return { n: matches.length }
                }
                return null
              },
              async all() {
                if (sql.includes('FROM agents WHERE slug = ?1')) {
                  const slug = args[0] as string
                  const rows = Array.from(agents.values()).filter((a) => a.slug === slug)
                  return { results: rows }
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

describe('MCP fleet_agent_get tool (mupot#1184)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T14:02:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is advertised on the MCP surface in TOOLS', () => {
    const tool = TOOLS.find((t) => t.name === 'fleet_agent_get')
    expect(tool).toBeDefined()
    expect(tool?.min).toBe('authenticated')
  })

  it('reads self agent fleet status when agent_id is omitted', async () => {
    const { env } = makeEnv()
    const res = await invokeTool(auth(), env, 'fleet_agent_get', {}, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as {
      agent_id: string
      agent_slug: string
      squad_id: string
      runtime: string
      status: string
      last_reported_at: string
      presence_ttl_sec: number
      derived_presence: string
      live: boolean
    }
    expect(result.agent_id).toBe(AGENT_ID)
    expect(result.agent_slug).toBe('kasra')
    expect(result.squad_id).toBe(SQUAD_ID)
    expect(result.runtime).toBe('claude-code')
    expect(result.status).toBe('running')
    expect(result.last_reported_at).toBe('2026-08-21 14:00:00')
    expect(result.presence_ttl_sec).toBe(300)
    expect(result.derived_presence).toBe('live')
    expect(result.live).toBe(true)
  })

  it('reads explicit agent_id by slug', async () => {
    const { env } = makeEnv()
    const res = await invokeTool(auth(), env, 'fleet_agent_get', { agent_id: 'kasra' }, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as { agent_id: string; runtime: string; live: boolean }
    expect(result.agent_id).toBe(AGENT_ID)
    expect(result.runtime).toBe('claude-code')
    expect(result.live).toBe(true)
  })

  it('refuses cross-squad lookup when caller has no observer capability on that squad', async () => {
    const { env } = makeEnv()
    const res = await invokeTool(auth(), env, 'fleet_agent_get', { agent_id: OTHER_AGENT_ID }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(res.error).toBe('forbidden')
  })

  it('allows cross-squad lookup for org admin', async () => {
    const { env } = makeEnv()
    const adminAuth = auth({
      capabilities: [
        { member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
      ],
    })
    const res = await invokeTool(adminAuth, env, 'fleet_agent_get', { agent_id: OTHER_AGENT_ID }, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as { agent_id: string; runtime: string; live: boolean; derived_presence: string }
    expect(result.agent_id).toBe(OTHER_AGENT_ID)
    expect(result.runtime).toBe('hermes')
    // 12:00 is older than 300s from 14:02, so stale
    expect(result.derived_presence).toBe('stale')
    expect(result.live).toBe(false)
  })

  it('returns 404 for unknown agent', async () => {
    const { env } = makeEnv()
    const res = await invokeTool(auth(), env, 'fleet_agent_get', { agent_id: 'nonexistent-agent' }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(res.error).toBe('agent_not_found')
  })
})
