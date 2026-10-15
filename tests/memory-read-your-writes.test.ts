// tests/memory-read-your-writes.test.ts — a write is findable BEFORE Vectorize indexes it.
//
// Incident (2026-10-15): `remember` returned an engram_id, but `recall` of the exact marker
// missed for >2 min (visible by ~6 min): Vectorize upserts are eventually consistent and recall
// was vector-only. recall now also reads D1 (recent + exact substring), and memory_recent /
// memory_get read D1 directly. REAL sqlite D1 from the committed migration chain; only AI/VEC
// are fakes. VEC is switchable: 'indexed' (synchronous, filter-honouring) or 'empty' (the
// production lag window: upsert accepted, nothing searchable).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-ryw'
const ALICE = 'member-alice'
const BOB = 'member-bob'

interface Vec { id: string; metadata: Record<string, unknown> }

describe('memory read-your-writes', () => {
  let h: SqliteD1Harness
  let env: Env
  let vectors: Vec[]
  let vecMode: 'indexed' | 'empty'

  const ctx = (memberId: string): AuthContext => ({
    userId: memberId, memberId, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null,
    capabilities: [{ member_id: memberId, scope_type: 'org', scope_id: null, capability: 'member' }],
  })
  const remember = async (who: string, text: string): Promise<string> => {
    const out = await invokeTool(ctx(who), env, 'remember', { text })
    if (!out.ok) throw new Error(JSON.stringify(out))
    return (out.result as { engram_id: string }).engram_id
  }
  interface Hit { id: string; text: string; score: number; source?: string }
  const recall = async (who: string, query: string, limit = 5): Promise<Hit[]> => {
    const out = await invokeTool(ctx(who), env, 'recall', { query, limit })
    if (!out.ok) throw new Error(JSON.stringify(out))
    return (out.result as { hits: Hit[] }).hits
  }
  const backdate = (id: string, minutesAgo: number): void => {
    h.sqlite.prepare(`UPDATE engrams SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${minutesAgo} minutes`, id)
  }

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    vectors = []
    vecMode = 'indexed'
    env = {
      TENANT_SLUG: TENANT,
      DB: h.db,
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VEC: {
        upsert: async (rows: Vec[]) => { vectors.push(...rows) },
        query: async (_v: number[], opts: { topK: number; filter: Record<string, unknown> }) => ({
          matches: vecMode === 'empty'
            ? []
            : vectors
              .filter((v) => Object.entries(opts.filter).every(([k, val]) => v.metadata[k] === val))
              .slice(0, opts.topK)
              .map((v, i) => ({ id: v.id, score: 0.9 - i / 10 })),
        }),
      },
    } as unknown as Env
  })
  afterEach(() => h.close())

  describe('recall D1 fallback', () => {
    it('finds a just-written engram by exact marker while Vectorize is empty (lag window)', async () => {
      vecMode = 'empty'
      const id = await remember(ALICE, 'kasra-freshness-probe-XYZ: probe text')
      const hits = await recall(ALICE, 'kasra-freshness-probe-XYZ')
      expect(hits.map((x) => x.id)).toEqual([id])
      expect(hits[0].source).toBe('lexical')
    })

    it('a quoted multi-word query is an exact-substring lookup too', async () => {
      vecMode = 'empty'
      const id = await remember(ALICE, 'the quick brown fox')
      backdate(id, 60) // outside the recency window: only the lexical leg can find it
      expect((await recall(ALICE, '"quick brown"')).map((x) => x.id)).toEqual([id])
      expect(await recall(ALICE, 'quick brown')).toEqual([]) // unquoted sentence: vector-only, vector is empty
    })

    it('a sentence query during the lag window still surfaces the fresh write as source=recent', async () => {
      vecMode = 'empty'
      const id = await remember(ALICE, 'standing team coherence note')
      const hits = await recall(ALICE, 'what did I just write about the team')
      expect(hits).toEqual([{ id, text: 'standing team coherence note', score: 0, source: 'recent' }])
    })

    it('the recency window is 15 minutes: a 16-minute-old write is NOT returned as recent', async () => {
      vecMode = 'empty'
      const fresh = await remember(ALICE, 'fresh engram')
      const stale = await remember(ALICE, 'stale engram')
      backdate(fresh, 14)
      backdate(stale, 16)
      const ids = (await recall(ALICE, 'anything at all here')).map((x) => x.id)
      expect(ids).toContain(fresh)
      expect(ids).not.toContain(stale)
    })

    it('an exact token outranks a crowd of weak vector hits (the five-unrelated-records failure)', async () => {
      for (let i = 0; i < 5; i++) backdate(await remember(ALICE, `old unrelated record ${i}`), 600)
      const fresh = await remember(ALICE, 'needle-token-777 fresh')
      // simulate the lag: the fresh vector is not searchable yet, the five old ones are
      vectors = vectors.filter((v) => v.id !== fresh)
      const hits = await recall(ALICE, 'needle-token-777', 5)
      expect(hits).toHaveLength(5)
      expect(hits[0]).toMatchObject({ id: fresh, source: 'lexical' })
    })

    it('when the vector leg is full and the query is a sentence, D1 is not consulted (no recent noise)', async () => {
      for (let i = 0; i < 3; i++) await remember(ALICE, `indexed ${i}`)
      const unindexed = await remember(ALICE, 'unindexed recent engram')
      vectors = vectors.filter((v) => v.id !== unindexed)
      const hits = await recall(ALICE, 'some semantic question', 3)
      expect(hits).toHaveLength(3)
      expect(hits.every((x) => x.source === 'vector')).toBe(true)
      expect(hits.map((x) => x.id)).not.toContain(unindexed)
    })

    it('the fallback query is skipped (no extra D1 read) when the vector leg is full and the query is a sentence', async () => {
      for (let i = 0; i < 3; i++) await remember(ALICE, `indexed ${i}`)
      const seen: string[] = []
      const realPrepare = h.db.prepare.bind(h.db)
      h.db.prepare = ((sql: string) => { seen.push(sql); return realPrepare(sql) }) as typeof h.db.prepare
      await recall(ALICE, 'some semantic question', 3)
      expect(seen.some((q) => q.includes('created_at >= ?'))).toBe(false)
      seen.length = 0
      await recall(ALICE, 'single-token', 3) // exact token: always consults D1
      expect(seen.some((q) => q.includes('created_at >= ?'))).toBe(true)
    })

    it('dedupes an engram found by several legs and respects the limit', async () => {
      const id = await remember(ALICE, 'dedupe-me-123')
      const hits = await recall(ALICE, 'dedupe-me-123')
      expect(hits.filter((x) => x.id === id)).toHaveLength(1)
      for (let i = 0; i < 6; i++) await remember(ALICE, `dedupe-me-123 extra ${i}`)
      expect((await recall(ALICE, 'dedupe-me-123', 3))).toHaveLength(3)
    })
  })

  describe('scope isolation (vector, recent AND lexical)', () => {
    it("another member's engram never appears for ALICE", async () => {
      const bobId = await remember(BOB, 'bob-secret-marker-42 private')
      // vector leg: indexed mode returns only filter-matching vectors
      expect((await recall(ALICE, 'anything')).map((x) => x.id)).not.toContain(bobId)
      // recent leg (bob's write is inside the window)
      vecMode = 'empty'
      expect((await recall(ALICE, 'what is new around here')).map((x) => x.id)).not.toContain(bobId)
      // lexical leg, exact token and a substring of it
      expect((await recall(ALICE, 'bob-secret-marker-42')).map((x) => x.id)).not.toContain(bobId)
      backdate(bobId, 600)
      expect(await recall(ALICE, 'secret-marker')).toEqual([])
      // sanity: bob does find it
      expect((await recall(BOB, 'bob-secret-marker-42')).map((x) => x.id)).toEqual([bobId])
    })
  })

  describe('LIKE injection', () => {
    beforeEach(async () => {
      vecMode = 'empty'
      for (const t of ['plain alpha', 'fifty% off', 'snake_case name', 'back\\slash path']) backdate(await remember(ALICE, t), 600)
    })

    it('% matches only text that literally contains %', async () => {
      expect((await recall(ALICE, '%')).map((x) => x.text)).toEqual(['fifty% off'])
    })
    it('_ matches only text that literally contains _', async () => {
      expect((await recall(ALICE, '_')).map((x) => x.text)).toEqual(['snake_case name'])
    })
    it('a backslash is literal, not an escape for the next char', async () => {
      expect((await recall(ALICE, '\\')).map((x) => x.text)).toEqual(['back\\slash path'])
      expect(await recall(ALICE, '\\%')).toEqual([])
    })
    it('wildcard-shaped probes do not enumerate the table', async () => {
      expect(await recall(ALICE, '%%')).toEqual([])
      expect(await recall(ALICE, 'a%a')).toEqual([])
      expect(await recall(ALICE, "x'--")).toEqual([])
    })
  })

  describe('memory_recent', () => {
    it('returns only the caller\'s own engrams, newest first, clamped to 1..20', async () => {
      const a1 = await remember(ALICE, 'first')
      const a2 = await remember(ALICE, 'second')
      await remember(BOB, 'bobs')
      backdate(a1, 5)
      backdate(a2, 1)
      const out = await invokeTool(ctx(ALICE), env, 'memory_recent', { limit: 50 })
      expect(out.ok).toBe(true)
      const eng = (out.ok ? out.result : null) as { engrams: Array<{ id: string; text: string; concepts: string[] | null; created_at: string }> }
      expect(eng.engrams.map((e) => e.text)).toEqual(['second', 'first'])
      const one = await invokeTool(ctx(ALICE), env, 'memory_recent', { limit: 0 })
      expect((one.ok ? (one.result as { engrams: unknown[] }).engrams : []).length).toBe(1)
      expect((await invokeTool(ctx(ALICE), env, 'memory_recent', {})).ok).toBe(true)
      expect((await invokeTool(ctx(ALICE), env, 'memory_recent', { limit: 'x' })).ok).toBe(false)
    })
  })

  describe('memory_get (no existence oracle)', () => {
    it('returns own engram', async () => {
      const id = await remember(ALICE, 'mine')
      const out = await invokeTool(ctx(ALICE), env, 'memory_get', { id })
      expect(out.ok && (out.result as { engram: { id: string; text: string } }).engram).toMatchObject({ id, text: 'mine' })
    })
    it("another member's id answers EXACTLY like a nonexistent id", async () => {
      const bobId = await remember(BOB, 'bob only')
      const foreign = await invokeTool(ctx(ALICE), env, 'memory_get', { id: bobId })
      const missing = await invokeTool(ctx(ALICE), env, 'memory_get', { id: crypto.randomUUID() })
      expect(foreign.ok).toBe(false)
      expect(JSON.stringify(foreign)).not.toContain('bob only')
      // identical shape: same status, same error, same message (nothing id-dependent)
      expect({ ...foreign, tool: undefined }).toEqual({ ...missing, tool: undefined })
    })
  })
})
