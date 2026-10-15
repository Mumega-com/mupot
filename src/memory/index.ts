// memory — the CF-profile MemoryPort impl.
// remember: write engram row (D1) + embed (Workers AI) + upsert vector (Vectorize).
// recall:   embed query + ANN query (Vectorize, filtered to agentId) + join back to D1.
//
// Every engram is scoped to an agentId. recall filters the Vectorize query by
// agentId metadata so an agent never recalls another agent's memory — isolation
// is enforced at the vector query, not just at the join.

import type { Env, MemoryPort, MemoryHit, MemoryEngram } from '../types'

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

// Vectorize upserts are eventually consistent (observed: a fresh write was NOT searchable
// for >2 min and was searchable by ~6 min). recall therefore also reads D1, the source of
// truth, so a write is findable immediately: engrams written in the last RECENT_WINDOW_MS,
// and exact substring matches. Every D1 read is scoped by the same agent_id (scope key) as
// the vector leg. (engrams has no tenant column: D1 is one database per pot/tenant.)
export const RECENT_WINDOW_MS = 15 * 60 * 1000
const LEXICAL_TERM_MAX = 200

/** SQLite datetime('now') text format, UTC: 'YYYY-MM-DD HH:MM:SS'. */
function sqliteTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

/** Escape LIKE wildcards so user text is matched literally (used with ESCAPE '\\'). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** The lexical term, or null when the query is a multi-word sentence (vector-only). */
export function exactTokenOf(query: string): string | null {
  const q = query.trim()
  if (q.length === 0) return null
  const quoted = q.length >= 2 && ((q.startsWith('"') && q.endsWith('"')) || (q.startsWith("'") && q.endsWith("'")))
  const term = quoted ? q.slice(1, -1).trim() : q
  if (term.length === 0) return null
  if (!quoted && /\s/.test(term)) return null
  return term.slice(0, LEXICAL_TERM_MAX)
}

interface EngramRow {
  id: string
  text: string
  concepts: string | null
  created_at: string
}

function parseConcepts(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

function toEngram(r: EngramRow): MemoryEngram {
  return { id: r.id, text: r.text, concepts: parseConcepts(r.concepts), created_at: r.created_at }
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

      // Join back to D1 for the canonical text. Preserve Vectorize's score order.
      const hits: MemoryHit[] = []
      if (matches.length > 0) {
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

        for (const m of matches) {
          const text = textById.get(m.id)
          // Skip vectors whose D1 row is missing or scoped to a different agent
          // (defense in depth against orphaned/cross-tenant vectors).
          if (text === undefined) continue
          hits.push({ id: m.id, text, score: m.score, source: 'vector' })
        }
      }

      // D1 fallback (read-your-writes). Runs when the vector leg came back short or the
      // query is a single exact token (the case a semantic index handles worst).
      const term = exactTokenOf(query)
      if (hits.length >= limit && term === null) return hits

      const cutoff = sqliteTimestamp(Date.now() - RECENT_WINDOW_MS)
      const likeClause = term === null ? '' : " OR text LIKE ? ESCAPE '\\'"
      const binds: unknown[] = [agentId, cutoff]
      if (term !== null) binds.push(`%${escapeLike(term)}%`)
      binds.push(limit)
      const d1 = await env.DB.prepare(
        `SELECT id, text, created_at FROM engrams WHERE agent_id = ? AND (created_at >= ?${likeClause}) ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
        .bind(...binds)
        .all<{ id: string; text: string; created_at: string }>()

      const lowerTerm = term === null ? null : term.toLowerCase()
      const lexical: MemoryHit[] = []
      const recent: MemoryHit[] = []
      for (const row of d1.results ?? []) {
        // A row older than the recency window can only have matched the LIKE leg.
        const isLexical = lowerTerm !== null && (row.text.toLowerCase().includes(lowerTerm) || row.created_at < cutoff)
        if (isLexical) lexical.push({ id: row.id, text: row.text, score: 1, source: 'lexical' })
        else recent.push({ id: row.id, text: row.text, score: 0, source: 'recent' })
      }

      // Exact substring matches outrank weak semantic hits (precision), then vector, then recent.
      const merged: MemoryHit[] = []
      const seen = new Set<string>()
      for (const h of [...lexical, ...hits, ...recent]) {
        if (seen.has(h.id)) continue
        seen.add(h.id)
        merged.push(h)
      }
      return merged.slice(0, limit)
    },

    async recent(agentId: string, limit = 5): Promise<MemoryEngram[]> {
      const rows = await env.DB.prepare(
        'SELECT id, text, concepts, created_at FROM engrams WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
        .bind(agentId, limit)
        .all<EngramRow>()
      return (rows.results ?? []).map(toEngram)
    },

    async get(agentId: string, id: string): Promise<MemoryEngram | null> {
      const row = await env.DB.prepare(
        'SELECT id, text, concepts, created_at FROM engrams WHERE id = ? AND agent_id = ?',
      )
        .bind(id, agentId)
        .first<EngramRow>()
      return row ? toEngram(row) : null
    },
  }
}
