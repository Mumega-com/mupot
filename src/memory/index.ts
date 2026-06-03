// memory — the CF-profile MemoryPort impl.
// remember: write engram row (D1) + embed (Workers AI) + upsert vector (Vectorize).
// recall:   embed query + ANN query (Vectorize, filtered to agentId) + join back to D1.
//
// Every engram is scoped to an agentId. recall filters the Vectorize query by
// agentId metadata so an agent never recalls another agent's memory — isolation
// is enforced at the vector query, not just at the join.

import type { Env, MemoryPort, MemoryHit } from '../types'

// 768-dim to match the `mupot-memory` Vectorize index (see wrangler.toml / README:
// `wrangler vectorize create mupot-memory --dimensions=768 --metric=cosine`).
// bge-base-en-v1.5 emits 768-dim sentence embeddings.
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5'

interface EmbeddingResponse {
  data: number[][]
}

async function embed(env: Env, text: string): Promise<number[]> {
  // env.AI.run is typed loosely across model families; the bge embedding model
  // returns { data: number[][] }. Narrow via the local EmbeddingResponse shape.
  const res = (await env.AI.run(EMBED_MODEL, { text: [text] })) as EmbeddingResponse
  const vector = res.data?.[0]
  if (!vector || vector.length === 0) {
    throw new Error('memory: embedding model returned no vector')
  }
  return vector
}

export function createMemory(env: Env): MemoryPort {
  return {
    async remember(agentId: string, text: string, concepts?: string[]): Promise<string> {
      const id = crypto.randomUUID()
      const conceptsJson = concepts && concepts.length > 0 ? JSON.stringify(concepts) : null

      // Persist the relational engram first (source of truth for the text/metadata).
      await env.DB.prepare(
        'INSERT INTO engrams (id, agent_id, text, concepts) VALUES (?, ?, ?, ?)',
      )
        .bind(id, agentId, text, conceptsJson)
        .run()

      // Embed and upsert the vector. Metadata carries agentId for query-time
      // filtering and engramId for the join back to D1.
      const values = await embed(env, text)
      await env.VEC.upsert([
        {
          id,
          values,
          // tenant scopes the vector even on a SHARED Vectorize index (the
          // multi-tenant-operator model) — agentId alone is not a tenant boundary.
          metadata: { agentId, engramId: id, tenant: env.TENANT_SLUG },
        },
      ])

      return id
    },

    async recall(agentId: string, query: string, limit = 5): Promise<MemoryHit[]> {
      const values = await embed(env, query)
      const result = await env.VEC.query(values, {
        topK: limit,
        // Scope to this agent's engrams AND this tenant — cross-agent AND
        // cross-tenant recall are both prevented at the vector query.
        filter: { agentId, tenant: env.TENANT_SLUG },
        returnMetadata: 'none',
      })

      const matches = result.matches ?? []
      if (matches.length === 0) return []

      // Join back to D1 for the canonical text. Preserve Vectorize's score order.
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
        // Skip vectors whose D1 row is missing or scoped to a different agent
        // (defense in depth against orphaned/cross-tenant vectors).
        if (text === undefined) continue
        hits.push({ id: m.id, text, score: m.score })
      }
      return hits
    },
  }
}
