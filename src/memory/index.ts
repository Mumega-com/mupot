// memory — the CF-profile MemoryPort impl (FLIGHT MEM-01 / #1202 & #1204).
// remember: write engram row in 'pending' status (D1) -> embed (Workers AI) -> upsert vector (Vectorize) -> mark 'ready'.
// recall:   embed query -> ANN query (Vectorize, filtered to agentId & tenant) -> join back to D1 for 'ready' engrams.
//
// Invariants enforced:
//   1. Atomic Engram Lifecycle: pending -> ready | failed to prevent partial-commit orphans.
//   2. Sanitized error codes (e.g. memory_embedding_unavailable) when Workers AI or Vectorize are missing/failing.
//   3. Strict scope isolation per member, squad, and project across token rotation.
//   4. Recall queries filter exclusively for 'ready' (or legacy null) engrams.

import type { Env, MemoryPort, MemoryHit } from '../types'

// 768-dim to match the `mupot-memory` Vectorize index (see wrangler.toml / README:
// `wrangler vectorize create mupot-memory --dimensions=768 --metric=cosine`).
// bge-base-en-v1.5 emits 768-dim sentence embeddings.
export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5'

export class MemoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 503,
  ) {
    super(message)
    this.name = 'MemoryError'
  }
}

interface EmbeddingResponse {
  data: number[][]
}

export async function embed(env: Env, text: string): Promise<number[]> {
  if (!env.AI || typeof env.AI.run !== 'function') {
    throw new MemoryError(
      'memory_embedding_unavailable',
      'Workers AI binding (env.AI) is not available or configured in environment',
      503,
    )
  }

  let res: EmbeddingResponse
  try {
    res = (await env.AI.run(EMBED_MODEL, { text: [text] })) as EmbeddingResponse
  } catch (err: any) {
    throw new MemoryError(
      'memory_embedding_unavailable',
      `Workers AI embedding model failed: ${err?.message || String(err)}`,
      503,
    )
  }

  const vector = res?.data?.[0]
  if (!vector || vector.length === 0) {
    throw new MemoryError(
      'memory_embedding_unavailable',
      'Workers AI embedding model returned empty vector',
      503,
    )
  }
  return vector
}

async function markEngramFailed(env: Env, id: string, errorCode: string): Promise<void> {
  if (!env.DB) return
  const now = new Date().toISOString()
  try {
    await env.DB.prepare(
      `UPDATE engrams SET status = 'failed', error_code = ?1, updated_at = ?2 WHERE id = ?3`,
    )
      .bind(errorCode, now, id)
      .run()
  } catch {
    // Non-fatal if status column is absent in older schema
  }
}

export interface EngramReconcileSummary {
  scanned: number
  ready: number
  pending: number
  failed: number
  reindexed: number
  errors: string[]
}

/**
 * Reconciles and repairs pending/failed engrams for an agent or tenant.
 * Never outputs sensitive text content in return receipts or logs.
 */
export async function reconcileEngrams(
  env: Env,
  agentId?: string,
  limit = 50,
): Promise<EngramReconcileSummary> {
  const summary: EngramReconcileSummary = {
    scanned: 0,
    ready: 0,
    pending: 0,
    failed: 0,
    reindexed: 0,
    errors: [],
  }

  if (!env.DB) {
    summary.errors.push('D1 database binding missing')
    return summary
  }

  const agentClause = agentId ? 'AND agent_id = ?1' : ''
  const binds = agentId ? [agentId, limit] : [limit]
  const limitPlaceholder = agentId ? '?2' : '?1'

  let rows: Array<{ id: string; agent_id: string; text: string; status: string | null }> = []
  try {
    const res = await env.DB.prepare(
      `SELECT id, agent_id, text, status FROM engrams
        WHERE (status = 'pending' OR status = 'failed')
          ${agentClause}
        ORDER BY created_at ASC
        LIMIT ${limitPlaceholder}`,
    )
      .bind(...binds)
      .all<{ id: string; agent_id: string; text: string; status: string | null }>()

    rows = res.results ?? []
  } catch {
    return summary
  }

  summary.scanned = rows.length

  for (const row of rows) {
    if (row.status === 'pending') summary.pending++
    if (row.status === 'failed') summary.failed++

    try {
      if (!env.AI || !env.VEC) {
        continue
      }
      const values = await embed(env, row.text)
      await env.VEC.upsert([
        {
          id: row.id,
          values,
          metadata: { agentId: row.agent_id, engramId: row.id, tenant: env.TENANT_SLUG || 'mumega' },
        },
      ])

      const now = new Date().toISOString()
      await env.DB.prepare(
        `UPDATE engrams SET status = 'ready', embedding_model = ?1, error_code = NULL, updated_at = ?2 WHERE id = ?3`,
      )
        .bind(EMBED_MODEL, now, row.id)
        .run()

      summary.reindexed++
      summary.ready++
    } catch (err: any) {
      summary.errors.push(`Engram ${row.id.slice(0, 8)} repair failed: ${err?.code || err?.message || 'unknown'}`)
    }
  }

  return summary
}

export function createMemory(env: Env): MemoryPort {
  return {
    async remember(agentId: string, text: string, concepts?: string[]): Promise<string> {
      if (!env.DB) {
        throw new MemoryError('database_unavailable', 'D1 database binding is required for memory operations', 503)
      }

      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const conceptsJson = concepts && concepts.length > 0 ? JSON.stringify(concepts) : null

      // Step 1: Persist the relational engram in 'pending' status.
      try {
        await env.DB.prepare(
          `INSERT INTO engrams (id, agent_id, text, concepts, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5)`,
        )
          .bind(id, agentId, text, conceptsJson, now)
          .run()
      } catch (err: any) {
        if (err?.message?.includes('no column named status') || err?.message?.includes('table engrams has no column')) {
          await env.DB.prepare(
            'INSERT INTO engrams (id, agent_id, text, concepts) VALUES (?, ?, ?, ?)',
          )
            .bind(id, agentId, text, conceptsJson)
            .run()
        } else {
          throw new MemoryError('database_unavailable', `Failed to persist relational engram: ${err?.message || err}`, 500)
        }
      }

      // Step 2: Validate AI and Vectorize bindings before attempting embedding
      if (!env.AI || typeof env.AI.run !== 'function') {
        await markEngramFailed(env, id, 'missing_ai_binding')
        throw new MemoryError(
          'memory_embedding_unavailable',
          'Workers AI binding (env.AI) is not configured in environment',
          503,
        )
      }

      if (!env.VEC || typeof env.VEC.upsert !== 'function') {
        await markEngramFailed(env, id, 'missing_vectorize_binding')
        throw new MemoryError(
          'vectorize_unavailable',
          'Vectorize index binding (env.VEC) is not configured in environment',
          503,
        )
      }

      // Step 3: Generate embedding vector
      let values: number[]
      try {
        values = await embed(env, text)
      } catch (err: any) {
        await markEngramFailed(env, id, err?.code || 'embedding_failed')
        throw err
      }

      // Step 4: Upsert vector with tenant and agent isolation metadata
      try {
        await env.VEC.upsert([
          {
            id,
            values,
            metadata: { agentId, engramId: id, tenant: env.TENANT_SLUG || 'mumega' },
          },
        ])
      } catch (err: any) {
        await markEngramFailed(env, id, 'vectorize_upsert_failed')
        throw new MemoryError(
          'vectorize_unavailable',
          `Vectorize upsert failed: ${err?.message || String(err)}`,
          503,
        )
      }

      // Step 5: Mark engram status as 'ready'
      try {
        await env.DB.prepare(
          `UPDATE engrams SET status = 'ready', embedding_model = ?1, updated_at = ?2 WHERE id = ?3`,
        )
          .bind(EMBED_MODEL, new Date().toISOString(), id)
          .run()
      } catch {
        // Non-fatal if status column not in legacy schema
      }

      return id
    },

    async recall(agentId: string, query: string, limit = 5): Promise<MemoryHit[]> {
      if (!env.DB) {
        throw new MemoryError('database_unavailable', 'D1 database binding is required for memory recall', 503)
      }

      if (!env.AI || typeof env.AI.run !== 'function') {
        throw new MemoryError(
          'memory_embedding_unavailable',
          'Workers AI binding (env.AI) is not configured in environment',
          503,
        )
      }

      if (!env.VEC || typeof env.VEC.query !== 'function') {
        throw new MemoryError(
          'vectorize_unavailable',
          'Vectorize index binding (env.VEC) is not configured in environment',
          503,
        )
      }

      const values = await embed(env, query)

      let result: { matches?: Array<{ id: string; score: number }> }
      try {
        result = await env.VEC.query(values, {
          topK: limit,
          filter: { agentId, tenant: env.TENANT_SLUG || 'mumega' },
          returnMetadata: 'none',
        })
      } catch (err: any) {
        throw new MemoryError(
          'vectorize_unavailable',
          `Vectorize query failed: ${err?.message || String(err)}`,
          503,
        )
      }

      const matches = result.matches ?? []
      if (matches.length === 0) return []

      // Join back to D1 for canonical text. Filter exclusively for ready (or legacy null) engrams.
      const ids = matches.map((m) => m.id)
      const placeholders = ids.map(() => '?').join(', ')

      let rows: { results?: Array<{ id: string; text: string }> }
      try {
        rows = await env.DB.prepare(
          `SELECT id, text FROM engrams WHERE id IN (${placeholders}) AND agent_id = ? AND (status = 'ready' OR status IS NULL)`,
        )
          .bind(...ids, agentId)
          .all<{ id: string; text: string }>()
      } catch (e: any) {
        if (e?.message?.includes('no column named status') || e?.message?.includes('table engrams has no column')) {
          rows = await env.DB.prepare(
            `SELECT id, text FROM engrams WHERE id IN (${placeholders}) AND agent_id = ?`,
          )
            .bind(...ids, agentId)
            .all<{ id: string; text: string }>()
        } else {
          throw new MemoryError('database_unavailable', `Failed to read engram text: ${e?.message || e}`, 500)
        }
      }

      const textById = new Map<string, string>()
      for (const row of rows.results ?? []) {
        textById.set(row.id, row.text)
      }

      const hits: MemoryHit[] = []
      for (const m of matches) {
        const text = textById.get(m.id)
        if (text === undefined) continue
        hits.push({ id: m.id, text, score: m.score })
      }
      return hits
    },
  }
}
