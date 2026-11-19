import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemory } from '../src/memory'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env, MemoryHit, MemoryRetrieval } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const SCOPES = ['member:reader', 'squad:team', 'project:project-one']
const MARKER = 'literal_%_marker'
type Fault = 'embedding_failed' | 'empty_embedding' | 'vector_query_failed'

describe('memory recall reliability', () => {
  let h: SqliteD1Harness
  let env: Env
  let fault: Fault | null
  let vectors: Array<{ id: string; metadata: Record<string, string> }>
  const put = (id: string, scope: string, text = MARKER, recent = false) => {
    h.sqlite.prepare('INSERT INTO engrams (id, agent_id, text, created_at) VALUES (?,?,?,?)')
      .run(id, scope, text, recent ? new Date().toISOString().slice(0, 19).replace('T', ' ') : '2020-01-01 00:00:00')
  }
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    fault = null
    vectors = []
    env = {
      TENANT_SLUG: 'recall-test', DB: h.db,
      AI: { run: vi.fn(async () => {
        if (fault === 'embedding_failed') throw new Error('private-provider-error-body')
        return { data: fault === 'empty_embedding' ? [] : [[0.1, 0.2, 0.3]] }
      }) },
      VEC: {
        query: vi.fn(async (_v: number[], opts: { filter: Record<string, string>; topK: number }) => {
          if (fault === 'vector_query_failed') throw new Error('private-provider-error-body')
          return { matches: vectors.filter(row => Object.entries(opts.filter).every(([key, value]) => row.metadata[key] === value))
            .slice(0, opts.topK).map(row => ({ id: row.id, score: 0.9 })) }
        }),
      },
    } as unknown as Env
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept','dept','Department');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('team','dept','team','Team'),('outsiders','dept','outsiders','Outsiders');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-one','project-one','Project','active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-one','team','read');
    `)
  })
  afterEach(() => { vi.useRealTimers(); h.close() })

  describe.each(SCOPES)('%s', scope => {
    it.each(['embedding_failed', 'empty_embedding', 'vector_query_failed'] as Fault[])('%s falls back with scope and literal-wildcard isolation', async providerFault => {
      put('own', scope)
      put('foreign', scope + '-foreign')
      put('wildcard-lookalike', scope, 'literal-any-marker')
      fault = providerFault
      const hits = await createMemory(env).recall(scope, MARKER)
      expect(hits.map(hit => hit.id)).toEqual(['own'])
    })
  })

  it('reports degraded empty results without implying full semantic coverage', async () => {
    fault = 'embedding_failed'
    const out = await createMemory(env).recallDetailed!('member:reader', 'old paraphrased sentence')
    expect(out).toEqual({ hits: [], degraded: true, retrieval: { semantic: 'unavailable', reason: 'embedding_failed', coverage: 'bounded-text-only' } })
    expect(JSON.stringify(out)).not.toContain('private-provider-error-body')
  })

  it('reports normal semantics and preserves vector ranking and scope metadata', async () => {
    put('semantic', 'member:reader', 'unrelated wording')
    vectors.push({ id: 'semantic', metadata: { agentId: 'member:reader', tenant: 'recall-test' } })
    const out = await createMemory(env).recallDetailed!('member:reader', 'a sentence query')
    expect(out).toEqual({ hits: [{ id: 'semantic', text: 'unrelated wording', score: 0.9, source: 'vector' }], degraded: false, retrieval: { semantic: 'available', coverage: 'semantic-and-bounded-text' } })
    expect(env.VEC.query).toHaveBeenCalledWith([0.1, 0.2, 0.3], expect.objectContaining({ filter: { agentId: 'member:reader', tenant: 'recall-test' } }))
  })

  it('reports semantic-only when a full vector result skips bounded fallback', async () => {
    put('semantic', 'member:reader', 'unrelated wording')
    vectors.push({ id: 'semantic', metadata: { agentId: 'member:reader', tenant: 'recall-test' } })
    const out = await createMemory(env).recallDetailed!('member:reader', 'a sentence query', 1)
    expect(out.retrieval).toEqual({ semantic: 'available', coverage: 'semantic-only' })
    expect(out.hits.map(hit => hit.id)).toEqual(['semantic'])
  })

  it('bounds an embedding hang and consumes a late rejection', async () => {
    vi.useFakeTimers()
    put('own', 'member:reader')
    let rejectLate!: (reason: Error) => void
    env.AI.run = (() => new Promise((_resolve, reject) => { rejectLate = reject })) as typeof env.AI.run
    const pending = createMemory(env).recallDetailed!('member:reader', MARKER)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ hits: [{ id: 'own' }], retrieval: { semantic: 'unavailable', reason: 'timeout' } })
    rejectLate(new Error('late private-provider-error-body'))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a query hang without applying its late result', async () => {
    vi.useFakeTimers()
    put('own', 'member:reader')
    let resolveLate!: (value: unknown) => void
    env.VEC.query = (() => new Promise(resolve => { resolveLate = resolve })) as typeof env.VEC.query
    const pending = createMemory(env).recallDetailed!('member:reader', MARKER)
    await vi.advanceTimersByTimeAsync(2000)
    const out = await pending
    expect(out).toMatchObject({ hits: [{ id: 'own' }], retrieval: { semantic: 'unavailable', reason: 'timeout' } })
    resolveLate({ matches: [{ id: 'foreign', score: 1 }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(out.hits.map(hit => hit.id)).toEqual(['own'])
  })

  it('does not turn canonical D1 failure into successful empty recall', async () => {
    fault = 'embedding_failed'
    h.sqlite.exec('DROP TABLE engrams')
    await expect(createMemory(env).recall('member:reader', MARKER)).rejects.toThrow()
  })

  const auth = (squad = 'team'): AuthContext => ({
    userId: 'reader', memberId: 'reader', email: null, role: 'member', tenant: 'recall-test',
    channel: 'workspace', boundAgentId: null,
    capabilities: [{ member_id: 'reader', scope_type: 'squad', scope_id: squad, capability: 'observer' }],
  })
  it.each([
    ['recall', {}, 'member:reader'],
    ['squad_recall', { squad_id: 'team' }, 'squad:team'],
    ['project_recall', { project_id: 'project-one' }, 'project:project-one'],
  ] as const)('%s retains response keys and exposes degradation through MCP', async (tool, args, scope) => {
    put('own', scope)
    put('foreign', scope + '-foreign')
    fault = 'vector_query_failed'
    const out = await invokeTool(auth(), env, tool, { ...args, query: MARKER })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const result = out.result as { degraded: boolean; hits: MemoryHit[]; retrieval: MemoryRetrieval; scope?: string }
    expect(result.hits.map(hit => hit.id)).toEqual(['own'])
    expect(result.degraded).toBe(true)
    expect(result.retrieval).toEqual({ semantic: 'unavailable', reason: 'vector_query_failed', coverage: 'bounded-text-only' })
    if (tool !== 'recall') expect(result.scope).toBe(scope)
  })

  it('refuses a nonparticipant before degraded project memory retrieval', async () => {
    fault = 'vector_query_failed'
    put('private', 'project:project-one')
    const out = await invokeTool(auth('outsiders'), env, 'project_recall', { project_id: 'project-one', query: MARKER })
    expect(out).toMatchObject({ ok: false, status: 404 })
    expect(env.AI.run).not.toHaveBeenCalled()
    expect(env.VEC.query).not.toHaveBeenCalled()
  })
})
