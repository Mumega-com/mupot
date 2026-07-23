import { describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { listProjectDocs, writeProjectDoc } from '../src/projects/docs'
import { projectMemoryScope } from '../src/projects/memory-scope'
import type { AuthContext, Env, MemoryHit } from '../src/types'

// Slice 2 — docs↔memory unification: the docs surface and project_remember/
// project_recall share ONE store (engrams + Vectorize under project:<id>).
// No second docs table. Round-trip both directions.

const TENANT = 'test-tenant'
const PROJECT_ID = 'proj-1'
const SQUAD_WRITE = 'squad-w'
const AGENT_A = 'agent-a'
const PSA: Record<string, string> = { [SQUAD_WRITE]: 'write' }

interface EngramRow {
  id: string
  agent_id: string
  text: string
  concepts: string | null
  created_at: string
}

interface VectorRow {
  id: string
  metadata: { agentId: string; engramId: string; tenant: string }
}

function writeAuth(): AuthContext {
  return {
    userId: 'member-w',
    memberId: 'member-w',
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_A,
    capabilities: [
      { member_id: 'member-w', scope_type: 'squad', scope_id: SQUAD_WRITE, capability: 'member' },
    ],
  }
}

function makeEnv() {
  const engrams: EngramRow[] = []
  const vectors: VectorRow[] = []
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
        return {
          matches: vectors
            .filter(
              (v) =>
                v.metadata.agentId === opts.filter.agentId && v.metadata.tenant === opts.filter.tenant,
            )
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
                if (sql.includes('FROM projects p')) {
                  if (args[0] !== PROJECT_ID) return null
                  if (sql.includes('1 = 1')) return project
                  const squadIds = linkedSquads(args[1])
                  return squadIds.some((s) => s in PSA) ? project : null
                }
                if (sql.includes('FROM project_squad_access') && sql.includes("('write', 'admin')")) {
                  const squadIds = args.slice(1).map(String)
                  return squadIds.some((s) => PSA[s] === 'write' || PSA[s] === 'admin')
                    ? { ok: 1 }
                    : null
                }
                if (sql.includes('FROM engrams') && sql.includes('WHERE id = ?') && sql.includes('AND agent_id = ?')) {
                  const id = String(args[0])
                  const scope = String(args[1])
                  return engrams.find((e) => e.id === id && e.agent_id === scope) ?? null
                }
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
                if (
                  sql.includes('FROM engrams') &&
                  sql.includes('WHERE agent_id = ?') &&
                  sql.includes('ORDER BY created_at DESC')
                ) {
                  const scope = String(args[0])
                  const limit = Number(args[1])
                  return {
                    results: engrams
                      .filter((e) => e.agent_id === scope)
                      .slice()
                      .reverse()
                      .slice(0, limit)
                      .map((e) => ({
                        id: e.id,
                        text: e.text,
                        concepts: e.concepts,
                        created_at: e.created_at,
                      })),
                  }
                }
                return { results: [] }
              },
              async run() {
                if (sql.includes('INSERT INTO engrams')) {
                  const [id, scope, text, concepts] = args as [string, string, string, string | null]
                  engrams.push({
                    id,
                    agent_id: scope,
                    text,
                    concepts,
                    created_at: `2026-07-23T00:00:${String(engrams.length).padStart(2, '0')}.000Z`,
                  })
                }
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  } as unknown as Env

  return { env, engrams, vectors }
}

describe('docs↔memory unification (one store)', () => {
  it('shares the projectMemoryScope opaque key with MCP project memory', () => {
    expect(projectMemoryScope(PROJECT_ID)).toBe(`project:${PROJECT_ID}`)
  })

  it('a doc written via the docs path is retrievable via project_recall', async () => {
    const { env, engrams, vectors } = makeEnv()
    const doc = await writeProjectDoc(env, PROJECT_ID, 'docs-path fact for the mubot', ['docs'], null)
    expect(doc.scope).toBe(`project:${PROJECT_ID}`)
    expect(engrams[0]).toMatchObject({
      agent_id: `project:${PROJECT_ID}`,
      text: 'docs-path fact for the mubot',
    })
    expect(vectors[0].metadata).toMatchObject({
      agentId: `project:${PROJECT_ID}`,
      tenant: TENANT,
    })

    const recall = await invokeTool(
      writeAuth(),
      env,
      'project_recall',
      { project_id: PROJECT_ID, query: 'docs-path', limit: 5 },
      'https://pot.example',
    )
    expect(recall.ok).toBe(true)
    const result = recall.result as { scope: string; hits: MemoryHit[] }
    expect(result.scope).toBe(`project:${PROJECT_ID}`)
    expect(result.hits.map((h) => h.text)).toEqual(['docs-path fact for the mubot'])
    expect(result.hits[0]?.id).toBe(doc.id)
  })

  it('a project_remember write surfaces in the docs view', async () => {
    const { env } = makeEnv()
    const remember = await invokeTool(
      writeAuth(),
      env,
      'project_remember',
      { project_id: PROJECT_ID, text: 'mubot lesson from the field', concepts: ['lesson'] },
      'https://pot.example',
    )
    expect(remember.ok).toBe(true)
    const remembered = remember.result as { engram_id: string; scope: string }

    const listed = await listProjectDocs(env, PROJECT_ID, 20)
    expect(listed.scope).toBe(remembered.scope)
    expect(listed.docs.map((d) => d.text)).toEqual(['mubot lesson from the field'])
    expect(listed.docs[0]?.id).toBe(remembered.engram_id)
    expect(listed.docs[0]?.concepts).toEqual(['lesson'])
  })

  it('does not introduce a second docs table migration', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(__dirname, '..', 'migrations')
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, file), 'utf8')
      expect(sql).not.toMatch(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?project_docs\b/i)
      expect(sql).not.toMatch(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?docs\b/i)
    }
  })
})
