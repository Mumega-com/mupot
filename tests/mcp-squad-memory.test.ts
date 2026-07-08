import { describe, expect, it } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { Agent, AuthContext, Env, MemoryHit } from '../src/types'

const TENANT = 'test-tenant'
const MEMBER_ID = 'member-1'
const SQUAD_ID = 'squad-1'
const OTHER_SQUAD_ID = 'squad-2'
const AGENT_ID = 'agent-1'
const PEER_AGENT_ID = 'agent-2'

interface EngramRow {
  id: string
  agent_id: string
  text: string
  concepts: string | null
}

interface VectorRow {
  id: string
  metadata: { agentId: string; engramId: string; tenant: string }
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
  const engrams: EngramRow[] = []
  const vectors: VectorRow[] = []
  const queries: Array<{ topK: number; filter: { agentId: string; tenant: string } }> = []
  const agents = new Map<string, Agent>([
    [AGENT_ID, agent()],
    [PEER_AGENT_ID, agent({ id: PEER_AGENT_ID, slug: 'kasra-review', name: 'Kasra Review', role: 'review' })],
    ['agent-other', agent({ id: 'agent-other', squad_id: OTHER_SQUAD_ID, slug: 'other', name: 'Other' })],
  ])
  const squads = new Map([
    [SQUAD_ID, { id: SQUAD_ID, department_id: 'dept-1', slug: 'kasra', name: 'Kasra', charter: null, created_at: 'now' }],
    [OTHER_SQUAD_ID, { id: OTHER_SQUAD_ID, department_id: 'dept-2', slug: 'other', name: 'Other', charter: null, created_at: 'now' }],
  ])

  const env = {
    TENANT_SLUG: TENANT,
    AI: {
      async run() {
        return { data: [[0.1, 0.2, 0.3]] }
      },
    },
    VEC: {
      async upsert(rows: Array<{ id: string; metadata: { agentId: string; engramId: string; tenant: string } }>) {
        vectors.push(...rows.map((r) => ({ id: r.id, metadata: r.metadata })))
      },
      async query(_values: number[], opts: { topK: number; filter: { agentId: string; tenant: string } }) {
        queries.push(opts)
        return {
          matches: vectors
            .filter((v) => v.metadata.agentId === opts.filter.agentId && v.metadata.tenant === opts.filter.tenant)
            .slice(0, opts.topK)
            .map((v, index) => ({ id: v.id, score: 0.9 - index / 10 })),
        }
      },
    },
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
                if (sql.includes('FROM engrams WHERE id IN')) {
                  const scope = args[args.length - 1] as string
                  const ids = new Set(args.slice(0, -1).map(String))
                  return {
                    results: engrams
                      .filter((e) => e.agent_id === scope && ids.has(e.id))
                      .map((e) => ({ id: e.id, text: e.text })),
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO engrams')) {
                  const [id, scope, text, concepts] = args as [string, string, string, string | null]
                  engrams.push({ id, agent_id: scope, text, concepts })
                }
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  } as unknown as Env

  return { env, engrams, vectors, queries }
}

describe('MCP squad memory tools', () => {
  it('advertises squad_remember and squad_recall on the MCP surface', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['squad_remember', 'squad_recall']))
  })

  it('writes shared memory under the caller agent squad scope', async () => {
    const { env, engrams, vectors } = makeEnv()

    const res = await invokeTool(
      auth(),
      env,
      'squad_remember',
      { text: 'broadcast receipts live in Mupot now', concepts: ['cutover', 'memory'] },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    expect((res.result as { squad_id: string; scope: string })).toMatchObject({
      squad_id: SQUAD_ID,
      scope: `squad:${SQUAD_ID}`,
    })
    expect(engrams).toHaveLength(1)
    expect(engrams[0]).toMatchObject({
      agent_id: `squad:${SQUAD_ID}`,
      text: 'broadcast receipts live in Mupot now',
      concepts: JSON.stringify(['cutover', 'memory']),
    })
    expect(vectors[0].metadata).toMatchObject({ agentId: `squad:${SQUAD_ID}`, tenant: TENANT })
  })

  it('lets a different agent in the same squad recall the shared engram', async () => {
    const { env, queries } = makeEnv()

    const write = await invokeTool(auth(), env, 'squad_remember', { text: 'shared squad fact' }, 'https://pot.example')
    expect(write.ok).toBe(true)

    const read = await invokeTool(
      auth({ boundAgentId: PEER_AGENT_ID }),
      env,
      'squad_recall',
      { query: 'shared', limit: 3 },
      'https://pot.example',
    )

    expect(read.ok).toBe(true)
    const result = read.result as { squad_id: string; scope: string; hits: MemoryHit[] }
    expect(result.squad_id).toBe(SQUAD_ID)
    expect(result.scope).toBe(`squad:${SQUAD_ID}`)
    expect(result.hits.map((h) => h.text)).toEqual(['shared squad fact'])
    expect(queries[0]).toMatchObject({ topK: 3, filter: { agentId: `squad:${SQUAD_ID}`, tenant: TENANT } })
  })

  it('keeps private remember separate from squad_recall', async () => {
    const { env } = makeEnv()

    const privateWrite = await invokeTool(auth(), env, 'remember', { text: 'private member fact' }, 'https://pot.example')
    expect(privateWrite.ok).toBe(true)

    const sharedRead = await invokeTool(auth(), env, 'squad_recall', { query: 'private' }, 'https://pot.example')
    expect(sharedRead.ok).toBe(true)
    expect((sharedRead.result as { hits: MemoryHit[] }).hits).toEqual([])
  })

  it('allows explicit squad recall with observer access but refuses observer writes', async () => {
    const { env } = makeEnv()
    const observer = auth({
      boundAgentId: null,
      capabilities: [
        { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'observer' },
      ],
    })

    const recall = await invokeTool(observer, env, 'squad_recall', { squad_id: SQUAD_ID, query: 'x' }, 'https://pot.example')
    expect(recall.ok).toBe(true)

    const remember = await invokeTool(observer, env, 'squad_remember', { squad_id: SQUAD_ID, text: 'x' }, 'https://pot.example')
    expect(remember.ok).toBe(false)
    expect(remember.error).toBe('forbidden')
  })

  it('refuses cross-squad shared memory access without a target-squad grant', async () => {
    const { env } = makeEnv()

    const recall = await invokeTool(auth(), env, 'squad_recall', { squad_id: OTHER_SQUAD_ID, query: 'x' }, 'https://pot.example')
    const remember = await invokeTool(auth(), env, 'squad_remember', { squad_id: OTHER_SQUAD_ID, text: 'x' }, 'https://pot.example')

    expect(recall.ok).toBe(false)
    expect(recall.status).toBe(403)
    expect(recall.detail).toEqual({ need: 'observer', scope: 'squad' })
    expect(remember.ok).toBe(false)
    expect(remember.status).toBe(403)
    expect(remember.detail).toEqual({ need: 'member', scope: 'squad' })
  })
})
