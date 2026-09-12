// Native MemoryPort — D1 engrams + Workers AI embed + Vectorize ANN.
// Default backend. Isolation is tenant + agentId at the vector filter.

import type { Env, MemoryHit, MemoryPort } from '../types'

export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5'

interface EmbeddingResponse {
  data: number[][]
}

async function embed(env: Env, text: string): Promise<number[]> {
  const res = (await env.AI.run(EMBED_MODEL, { text: [text] })) as EmbeddingResponse
  const vector = res.data?.[0]
  if (!vector || vector.length === 0) {
    throw new Error('memory: embedding model returned no vector')
  }
  return vector
}

export function createNativeMemory(env: Env): MemoryPort {
  return {
    backend: 'native',
    async remember(agentId: string, text: string, concepts?: string[]): Promise<string> {
      const id = crypto.randomUUID()
      const conceptsJson = concepts && concepts.length > 0 ? JSON.stringify(concepts) : null

      await env.DB.prepare(
        'INSERT INTO engrams (id, agent_id, text, concepts) VALUES (?, ?, ?, ?)',
      )
        .bind(id, agentId, text, conceptsJson)
        .run()

      const values = await embed(env, text)
      await env.VEC.upsert([
        {
          id,
          values,
          metadata: { agentId, engramId: id, tenant: env.TENANT_SLUG },
        },
      ])

      return id
    },

    async recall(agentId: string, query: string, limit = 5): Promise<MemoryHit[]> {
      const values = await embed(env, query)
      const result = await env.VEC.query(values, {
        topK: limit,
        filter: { agentId, tenant: env.TENANT_SLUG },
        returnMetadata: 'none',
      })

      const matches = result.matches ?? []
      if (matches.length === 0) return []

      const ids = matches.map((m) => m.id)
      const placeholders = ids.map(() => '?').join(', ')
      const rows = await env.DB.prepare(
        `SELECT id, text FROM engrams WHERE id IN (${placeholders}) AND agent_id = ?`,
      )
        .bind(...ids, agentId)
        .all<{ id: string; text: string }>()

      const textById = new Map<string, string>()
      for (const row of rows.results ?? []) {
        textById.set(row.id, row.text)
      }

      const hits: MemoryHit[] = []
      for (const m of matches) {
        const text = textById.get(m.id)
        if (text === undefined) continue
        hits.push({ id: m.id, text, score: m.score, class: 'pot_engram' })
      }
      return hits
    },
  }
}
