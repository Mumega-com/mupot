import { Hono } from 'hono'
import type { Env } from '../types'

export const mirrorApp = new Hono<{ Bindings: Env }>()

const RRF_K = 60 // Standard RRF constant

export interface MirrorSearchHit {
  id: string
  text: string
  agent_id: string
  rrfScore: number
  textRank?: number
  vectorRank?: number
  concepts?: string[]
}

// Helper to verify secret header authorization
function verifyMirrorSecret(c: { req: { header: (name: string) => string | undefined }; env: Env }): boolean {
  const secret = c.env.MIRROR_SECRET || c.env.MIRROR_TOKEN
  if (!secret) return true // Pass through if no secret is configured

  const authHeader = c.req.header('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader
  const xSecret = c.req.header('x-secret') || c.req.header('x-mirror-secret')

  const providedToken = bearerToken || xSecret
  return providedToken === secret
}

mirrorApp.use('*', async (c, next) => {
  if (c.req.path.endsWith('/health')) return next()
  if (!verifyMirrorSecret(c)) {
    return c.json({ error: 'unauthorized', detail: 'invalid or missing secret header' }, 401)
  }
  return next()
})

// GET /health — liveness and status of Mirror 16D RRF memory search engine
mirrorApp.get('/health', (c) => {
  return c.json({
    ok: true,
    addon: 'mirror',
    status: 'active',
    engine: '16d-rrf',
    dimensions: 16,
    vectorizeConfigured: Boolean(c.env.VEC),
  })
})

// POST /search (and /rrf-search) — 16D RRF vector memory search endpoint
const handleSearch = async (c: import('hono').Context<{ Bindings: Env }>) => {
  let body: { query?: string; agent_id?: string; limit?: number; k?: number }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', detail: 'Request body must be valid JSON' }, 400)
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json({ error: 'invalid_payload', detail: 'query string is required' }, 400)
  }

  const queryText = body.query.trim()
  const agentId = body.agent_id
  const limit = Math.min(Math.max(1, body.limit ?? 5), 50)
  const rrfK = body.k ?? RRF_K

  try {
    // Rank set 1: Text search via D1
    const textHitsMap = new Map<string, { id: string; text: string; agent_id: string; concepts?: string[]; textRank: number }>()

    if (c.env.DB) {
      const sql = agentId
        ? `SELECT id, agent_id, text, concepts FROM engrams WHERE agent_id = ? AND text LIKE ? ORDER BY id DESC LIMIT 50`
        : `SELECT id, agent_id, text, concepts FROM engrams WHERE text LIKE ? ORDER BY id DESC LIMIT 50`
      
      const params = agentId ? [agentId, `%${queryText}%`] : [`%${queryText}%`]
      const rows = await c.env.DB.prepare(sql).bind(...params).all<{ id: string; agent_id: string; text: string; concepts: string | null }>()

      let rank = 1
      for (const row of rows.results ?? []) {
        let concepts: string[] | undefined
        if (row.concepts) {
          try { concepts = JSON.parse(row.concepts) } catch {}
        }
        textHitsMap.set(row.id, {
          id: row.id,
          text: row.text,
          agent_id: row.agent_id,
          concepts,
          textRank: rank++,
        })
      }
    }

    // Rank set 2: Vector search if Vectorize binding is available
    const vectorHitsMap = new Map<string, { id: string; vectorRank: number; score?: number }>()
    if (c.env.VEC && c.env.AI) {
      try {
        const embedRes = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [queryText] }) as { data?: number[][] }
        const vector = embedRes.data?.[0]
        if (vector) {
          const filterRecord: Record<string, string> = { tenant: c.env.TENANT_SLUG || 'default' }
          if (agentId) filterRecord.agentId = agentId
          const vecRes = await c.env.VEC.query(vector, { topK: 50, filter: filterRecord as any })
          let vRank = 1
          for (const match of vecRes.matches ?? []) {
            vectorHitsMap.set(match.id, { id: match.id, vectorRank: vRank++, score: match.score })
          }
        }
      } catch {
        // Vector search error degrades gracefully to text RRF if vector engine fails
      }
    }

    // Combine using 16D Reciprocal Rank Fusion (RRF): RRF_score = sum(1 / (k + rank))
    const allIds = new Set<string>([...textHitsMap.keys(), ...vectorHitsMap.keys()])
    const fusedHits: MirrorSearchHit[] = []

    for (const id of allIds) {
      const textHit = textHitsMap.get(id)
      const vectorHit = vectorHitsMap.get(id)

      let rrfScore = 0
      if (textHit) {
        rrfScore += 1 / (rrfK + textHit.textRank)
      }
      if (vectorHit) {
        rrfScore += 1 / (rrfK + vectorHit.vectorRank)
      }

      // Fetch text content if vector hit only
      let text = textHit?.text ?? ''
      let agent_id = textHit?.agent_id ?? agentId ?? 'unknown'
      let concepts = textHit?.concepts

      if (!text && c.env.DB) {
        const d1Row = await c.env.DB.prepare('SELECT id, agent_id, text, concepts FROM engrams WHERE id = ?').bind(id).first<{ id: string; agent_id: string; text: string; concepts: string | null }>()
        if (d1Row) {
          text = d1Row.text
          agent_id = d1Row.agent_id
          if (d1Row.concepts) {
            try { concepts = JSON.parse(d1Row.concepts) } catch {}
          }
        }
      }

      fusedHits.push({
        id,
        text,
        agent_id,
        rrfScore,
        textRank: textHit?.textRank,
        vectorRank: vectorHit?.vectorRank,
        concepts,
      })
    }

    // Sort by descending RRF score
    fusedHits.sort((a, b) => b.rrfScore - a.rrfScore)
    const results = fusedHits.slice(0, limit)

    return c.json({
      ok: true,
      query: queryText,
      hits: results,
      total: results.length,
      engine: '16d-rrf',
    }, 200)
  } catch (err) {
    // Fail-closed discipline: HTTP 500 on database or search engine failure
    return c.json({
      error: 'mirror_search_failed',
      detail: err instanceof Error ? err.message : String(err),
    }, 500)
  }
}

mirrorApp.post('/search', handleSearch)
mirrorApp.post('/rrf-search', handleSearch)

// POST /engrams — add engram to memory
mirrorApp.post('/engrams', async (c) => {
  let body: { text?: string; agent_id?: string; concepts?: string[] }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', detail: 'Request body must be valid JSON' }, 400)
  }

  if (!body.text || typeof body.text !== 'string' || body.text.trim().length === 0) {
    return c.json({ error: 'invalid_payload', detail: 'text string is required' }, 400)
  }

  if (!c.env.DB) {
    return c.json({ error: 'database_unavailable', detail: 'DB binding missing' }, 500)
  }

  const id = crypto.randomUUID()
  const agentId = body.agent_id ?? 'river'
  const text = body.text.trim()
  const conceptsJson = body.concepts && body.concepts.length > 0 ? JSON.stringify(body.concepts) : null

  try {
    await c.env.DB.prepare(
      'INSERT INTO engrams (id, agent_id, text, concepts) VALUES (?, ?, ?, ?)'
    ).bind(id, agentId, text, conceptsJson).run()
  } catch (err) {
    return c.json({
      error: 'engram_store_failed',
      detail: err instanceof Error ? err.message : String(err),
    }, 500)
  }

  return c.json({ ok: true, id, agent_id: agentId, text }, 201)
})
