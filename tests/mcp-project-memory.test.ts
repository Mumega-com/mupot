import { describe, expect, it } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Env, MemoryHit } from '../src/types'

// Project-shared memory (Port: project memory). Mirrors mcp-squad-memory: an opaque
// `project:<id>` scope over the existing engrams+Vectorize seam (NO migration). Gate is
// TWO-tier: project READ (readableProject) for recall, project WRITE
// (anySquadHasProjectWrite / org-admin) for remember — a shared engram steers every
// agent that later recalls it, so writing is a state mutation, not a read. These tests
// prove: advertised; a WRITE participant writes + a READ participant recalls the SAME
// engram; a READ-only participant is REFUSED the write (the self-poisoning P1) but may
// recall; a non-participant is refused both; private memory stays separate.

const TENANT = 'test-tenant'
const PROJECT_ID = 'proj-1'
const SQUAD_WRITE = 'squad-w' // linked to the project at access_level='write'
const SQUAD_READ = 'squad-r' // linked at access_level='read'
const SQUAD_OUT = 'squad-x' // not linked to the project at all
const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'

// project_squad_access levels for PROJECT_ID (the mock's source of truth).
const PSA: Record<string, string> = { [SQUAD_WRITE]: 'write', [SQUAD_READ]: 'read' }

function squadAuth(memberId: string, squadId: string, boundAgentId: string | null = null): AuthContext {
  return {
    userId: memberId,
    memberId,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId,
    capabilities: [{ member_id: memberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
  }
}
// org-admin → unrestrictedProjectRead + access.workspaceAdmin → sees + writes any project.
function adminAuth(boundAgentId: string | null = AGENT_A): AuthContext {
  return {
    userId: 'member-admin',
    memberId: 'member-admin',
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId,
    capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
  }
}

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

function makeEnv() {
  const engrams: EngramRow[] = []
  const vectors: VectorRow[] = []
  const queries: Array<{ topK: number; filter: { agentId: string; tenant: string } }> = []
  const project = { id: PROJECT_ID, slug: 'p1', name: 'Project One', status: 'active' }

  const env = {
    TENANT_SLUG: TENANT,
    AI: {
      async run() {
        return { data: [[0.1, 0.2, 0.3]] }
      },
    },
    VEC: {
      async upsert(rows: VectorRow[]) {
        vectors.push(...rows.map((r) => ({ id: r.id, metadata: r.metadata })))
      },
      async query(_v: number[], opts: { topK: number; filter: { agentId: string; tenant: string } }) {
        queries.push(opts)
        return {
          matches: vectors
            .filter((v) => v.metadata.agentId === opts.filter.agentId && v.metadata.tenant === opts.filter.tenant)
            .slice(0, opts.topK)
            .map((v, i) => ({ id: v.id, score: 0.9 - i / 10 })),
        }
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            const linkedSquads = (jsonArg: unknown): string[] => {
              try {
                return JSON.parse(String(jsonArg)) as string[]
              } catch {
                return []
              }
            }
            return {
              async first() {
                // readableProject
                if (sql.includes('FROM projects p')) {
                  if (args[0] !== PROJECT_ID) return null
                  if (sql.includes('1 = 1')) return project // unrestricted (org-admin)
                  // restricted EXISTS clause: args = [projectId, JSON(squadIds), JSON(deptIds)]
                  const squadIds = linkedSquads(args[1])
                  return squadIds.some((s) => s in PSA) ? project : null
                }
                // anySquadHasProjectWrite: args = [projectId, ...squadIds]
                if (sql.includes('FROM project_squad_access') && sql.includes("('write', 'admin')")) {
                  const squadIds = args.slice(1).map(String)
                  return squadIds.some((s) => PSA[s] === 'write' || PSA[s] === 'admin') ? { ok: 1 } : null
                }
                return null
              },
              async all() {
                if (sql.includes('FROM engrams WHERE id IN')) {
                  const scope = args[args.length - 1] as string
                  const ids = new Set(args.slice(0, -1).map(String))
                  return {
                    results: engrams.filter((e) => e.agent_id === scope && ids.has(e.id)).map((e) => ({ id: e.id, text: e.text })),
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

describe('MCP project memory tools', () => {
  it('advertises project_remember and project_recall', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['project_remember', 'project_recall']))
  })

  it('a WRITE participant writes shared memory under the project scope', async () => {
    const { env, engrams, vectors } = makeEnv()
    const res = await invokeTool(
      squadAuth('member-w', SQUAD_WRITE, AGENT_A),
      env,
      'project_remember',
      { project_id: PROJECT_ID, text: 'the DME cutover ships Friday', concepts: ['dme', 'plan'] },
      'https://pot.example',
    )
    expect(res.ok).toBe(true)
    expect(res.result as { project_id: string; scope: string }).toMatchObject({ project_id: PROJECT_ID, scope: `project:${PROJECT_ID}` })
    expect(engrams[0]).toMatchObject({ agent_id: `project:${PROJECT_ID}`, text: 'the DME cutover ships Friday' })
    expect(vectors[0].metadata).toMatchObject({ agentId: `project:${PROJECT_ID}`, tenant: TENANT })
  })

  it('org-admin writes via the workspace-admin bypass', async () => {
    const { env, engrams } = makeEnv()
    const res = await invokeTool(adminAuth(), env, 'project_remember', { project_id: PROJECT_ID, text: 'admin note' }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(engrams).toHaveLength(1)
  })

  it('a READ participant recalls the SAME engram a WRITE participant wrote (the keystone)', async () => {
    const { env, queries } = makeEnv()
    const write = await invokeTool(squadAuth('member-w', SQUAD_WRITE, AGENT_A), env, 'project_remember', { project_id: PROJECT_ID, text: 'shared project fact' }, 'https://pot.example')
    expect(write.ok).toBe(true)

    const read = await invokeTool(
      squadAuth('member-r', SQUAD_READ, AGENT_B),
      env,
      'project_recall',
      { project_id: PROJECT_ID, query: 'shared', limit: 3 },
      'https://pot.example',
    )
    expect(read.ok).toBe(true)
    const r = read.result as { project_id: string; scope: string; hits: MemoryHit[] }
    expect(r.scope).toBe(`project:${PROJECT_ID}`)
    expect(r.hits.map((h) => h.text)).toEqual(['shared project fact'])
    expect(queries[0]).toMatchObject({ topK: 3, filter: { agentId: `project:${PROJECT_ID}`, tenant: TENANT } })
  })

  // The P1 regression: a READ-only participant must NOT be able to poison shared memory.
  it('REFUSES a read-only participant the write (403 project_write) but allows recall', async () => {
    const { env, engrams } = makeEnv()
    const reader = squadAuth('member-r', SQUAD_READ, AGENT_B)

    const write = await invokeTool(reader, env, 'project_remember', { project_id: PROJECT_ID, text: 'poison' }, 'https://pot.example')
    expect(write.ok).toBe(false)
    expect(write.status).toBe(403)
    expect(write.detail).toEqual({ need: 'project_write', scope: 'project' })
    expect(engrams).toHaveLength(0) // nothing written

    const recall = await invokeTool(reader, env, 'project_recall', { project_id: PROJECT_ID, query: 'x' }, 'https://pot.example')
    expect(recall.ok).toBe(true) // read is allowed
  })

  it('private member memory stays separate from project_recall', async () => {
    const { env } = makeEnv()
    const priv = await invokeTool(adminAuth(), env, 'remember', { text: 'private member fact' }, 'https://pot.example')
    expect(priv.ok).toBe(true)
    const shared = await invokeTool(adminAuth(), env, 'project_recall', { project_id: PROJECT_ID, query: 'private' }, 'https://pot.example')
    expect(shared.ok).toBe(true)
    expect((shared.result as { hits: MemoryHit[] }).hits).toEqual([])
  })

  it('refuses a non-participant both write and recall (project_not_found, no cross-project leak)', async () => {
    const { env, engrams } = makeEnv()
    const outsider = squadAuth('member-out', SQUAD_OUT, 'agent-out')
    const write = await invokeTool(outsider, env, 'project_remember', { project_id: PROJECT_ID, text: 'x' }, 'https://pot.example')
    const read = await invokeTool(outsider, env, 'project_recall', { project_id: PROJECT_ID, query: 'x' }, 'https://pot.example')
    expect(write.ok).toBe(false)
    expect(write.status).toBe(404)
    expect(write.error).toBe('project_not_found')
    expect(read.ok).toBe(false)
    expect(read.error).toBe('project_not_found')
    expect(engrams).toHaveLength(0)
  })

  it('requires project_id and text/query', async () => {
    const { env } = makeEnv()
    const noProj = await invokeTool(adminAuth(), env, 'project_remember', { text: 'x' } as Record<string, unknown>, 'https://pot.example')
    expect(noProj.ok).toBe(false)
    const noText = await invokeTool(adminAuth(), env, 'project_remember', { project_id: PROJECT_ID } as Record<string, unknown>, 'https://pot.example')
    expect(noText.ok).toBe(false)
  })
})
