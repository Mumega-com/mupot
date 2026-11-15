// Evidence-only regression probes for memory plan c5f50625.
// Intentionally red assertions describe observed retrieval gaps. No repair is implemented.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemory } from '../src/memory'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

describe('memory durability evidence (real migration schema)', () => {
  let h: SqliteD1Harness
  let env: Env
  let failUpsert: boolean
  let failQuery: boolean
  let indexed: Map<string, { id: string; metadata: Record<string, unknown> }>
  const scope = 'project:memory-evidence'
  const text = 'The observatory calibration happens every Thursday evening.'
  const query = 'When do we calibrate the observatory equipment?'
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    failUpsert = false
    failQuery = false
    indexed = new Map()
    env = {
      TENANT_SLUG: 'memory-evidence', DB: h.db,
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VEC: {
        upsert: vi.fn(async (rows: Array<{ id: string; metadata: Record<string, unknown> }>) => {
          if (failUpsert) throw new Error('injected upsert outage')
          for (const row of rows) indexed.set(row.id, row)
        }),
        query: async (_values: number[], opts: { filter: Record<string, unknown>; topK: number }) => {
          if (failQuery) throw new Error('injected query outage')
          return { matches: [...indexed.values()]
            .filter(row => Object.entries(opts.filter).every(([key, value]) => row.metadata[key] === value))
            .slice(0, opts.topK).map(row => ({ id: row.id, score: 0.95 })) }
        },
      },
    } as unknown as Env
  })
  afterEach(() => h.close())
  const age = (id: string) => h.sqlite.prepare("UPDATE engrams SET created_at = datetime('now', '-1 day') WHERE id = ?").run(id)

  it('control: an indexed old record is retrievable for a sentence query and isolated by scope', async () => {
    const memory = createMemory(env)
    const id = await memory.remember(scope, text)
    age(id)
    expect((await memory.recall(scope, query)).map(hit => hit.id)).toContain(id)
    expect(await memory.recall('project:other', query)).toEqual([])
  })

  it('proves background failure is swallowed while the relational record remains', async () => {
    failUpsert = true
    const pending: Promise<unknown>[] = []
    const memory = createMemory(env)
    const id = await memory.remember(scope, text, [], { waitUntil: p => { pending.push(p) } })
    await expect(Promise.all(pending)).resolves.toEqual([undefined])
    expect(await memory.get!(scope, id)).toMatchObject({ id, text })
    expect(indexed.has(id)).toBe(false)
    expect(env.VEC.upsert).toHaveBeenCalledTimes(1)
  })

  it('proves awaited failure also leaves a relational record after rejecting', async () => {
    failUpsert = true
    const memory = createMemory(env)
    await expect(memory.remember(scope, text)).rejects.toThrow('injected upsert outage')
    const rows = h.sqlite.prepare('SELECT id, text FROM engrams WHERE agent_id = ?').all(scope)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ text })
    expect(indexed.size).toBe(0)
  })

  it('REGRESSION: an acknowledged old record remains recallable after a failed background upsert', async () => {
    failUpsert = true
    const pending: Promise<unknown>[] = []
    const memory = createMemory(env)
    const id = await memory.remember(scope, text, [], { waitUntil: p => { pending.push(p) } })
    await Promise.all(pending)
    age(id)
    failUpsert = false // provider recovery alone does not re-run the failed upsert
    expect(await memory.get!(scope, id)).toMatchObject({ id, text })
    expect((await memory.recall(scope, query)).map(hit => hit.id)).toContain(id)
  })

  it('REGRESSION: a vector-query outage still permits the exact D1 lexical fallback', async () => {
    const memory = createMemory(env)
    const id = await memory.remember(scope, 'unique-evidence-marker: stored locally')
    age(id)
    failQuery = true
    const hits = await memory.recall(scope, 'unique-evidence-marker')
    expect(hits.map(hit => hit.id)).toContain(id)
  })

  it('disproves the claim that migration 0037 adds episode fields to engrams', () => {
    const columns = h.sqlite.prepare('PRAGMA table_info(engrams)').all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(['id', 'agent_id', 'text', 'concepts', 'created_at'])
    const episodeColumns = h.sqlite.prepare('PRAGMA table_info(agent_episodes)').all() as Array<{ name: string }>
    expect(episodeColumns.map(column => column.name)).toEqual(expect.arrayContaining(['tenant', 'agent_id', 'cycle', 'kind', 'summary']))
  })
})
