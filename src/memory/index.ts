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
// DoS bounds for the lexical leg (gate round 1, P1): SQLite's LIKE '%t%' backtracks, so cost is
// rows x text-length x term-length on the pot's single D1. Bound all three: a short term, only the
// newest LEXICAL_SCAN_ROWS rows of the scope, and only the first LEXICAL_TEXT_CHARS of each text.
// No generic per-member limiter exists in the repo (rate-limit code is agent-meter specific), so
// there is deliberately none here; the three caps bound ONE query's work.
export const LEXICAL_TERM_MAX = 64
export const LEXICAL_SCAN_ROWS = 200
export const LEXICAL_TEXT_CHARS = 4096
// A lexical hit outranks weak semantic hits but not a strong one (vector cosine > this wins).
export const LEXICAL_SCORE = 0.75

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
      // Two bounded queries, so recent non-matching rows can never hide an older exact match.
      const recentRows = await env.DB.prepare(
        'SELECT id, text FROM engrams WHERE agent_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
        .bind(agentId, cutoff, limit)
        .all<{ id: string; text: string }>()

      let lexicalRows: Array<{ id: string; text: string }> = []
      if (term !== null) {
        // LIKE only inside the newest LEXICAL_SCAN_ROWS rows of THIS scope, over a bounded text prefix.
        const res = await env.DB.prepare(
          `SELECT id, text FROM engrams WHERE id IN (SELECT id FROM engrams WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ${LEXICAL_SCAN_ROWS}) AND agent_id = ? AND substr(text, 1, ${LEXICAL_TEXT_CHARS}) LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
          .bind(agentId, agentId, `%${escapeLike(term)}%`, limit)
          .all<{ id: string; text: string }>()
        lexicalRows = res.results ?? []
      }

      // Rank by score; on a duplicate id keep the higher-scoring leg. Stable for ties.
      const candidates: MemoryHit[] = [
        ...lexicalRows.map((r): MemoryHit => ({ id: r.id, text: r.text, score: LEXICAL_SCORE, source: 'lexical' })),
        ...hits,
        ...(recentRows.results ?? []).map((r): MemoryHit => ({ id: r.id, text: r.text, score: 0, source: 'recent' })),
      ]
      const best = new Map<string, MemoryHit>()
      for (const h of candidates) {
        const prior = best.get(h.id)
        if (!prior || h.score > prior.score) best.set(h.id, h)
      }
      const merged = [...best.values()].sort((x, y) => y.score - x.score)
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
