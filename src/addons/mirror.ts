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

// Helper to safely parse concepts JSON array
function parseConceptsJson(rawJson: string | null | undefined): string[] | undefined {
  if (!rawJson) return undefined
  try {
    const parsed = JSON.parse(rawJson)
    return Array.isArray(parsed) ? parsed : undefined
  } catch (err) {
    console.warn('[mirror] Non-fatal JSON parse warning for concepts:', err)
    return undefined
  }
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
  } catch (err) {
    return c.json({ error: 'invalid_json', detail: `Request body must be valid JSON: ${err}` }, 400)
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
        const concepts = parseConceptsJson(row.concepts)
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
      } catch (err) {
        // Non-fatal vector search degradation: degrades gracefully to D1 text RRF
        console.warn('[mirror] Vector search degraded to D1 text RRF:', err)
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
          concepts = parseConceptsJson(d1Row.concepts)
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

// ── Canonical /memory REST API Endpoints (B-001) ─────────────────────────────

// POST /memory/store — store memory engram (supports upsert, concepts, vector embedding)
mirrorApp.post('/memory/store', async (c) => {
  let body: { id?: string; text?: string; agent_id?: string; concepts?: string[] }
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

  const id = body.id && typeof body.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : crypto.randomUUID()
  const agentId = body.agent_id ?? 'river'
  const text = body.text.trim()
  const conceptsJson = body.concepts && body.concepts.length > 0 ? JSON.stringify(body.concepts) : null

  try {
    await c.env.DB.prepare(
      'INSERT INTO engrams (id, agent_id, text, concepts) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, concepts = excluded.concepts'
    ).bind(id, agentId, text, conceptsJson).run()

    if (c.env.VEC && c.env.AI) {
      try {
        const embedRes = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] }) as { data?: number[][] }
        const vector = embedRes.data?.[0]
        if (vector) {
          await c.env.VEC.insert([{
            id,
            values: vector,
            metadata: { tenant: c.env.TENANT_SLUG || 'default', agentId, text: text.slice(0, 500) },
          }])
        }
      } catch (err) {
        console.warn('[mirror] Vector index write failed (relational engram preserved):', err)
      }
    }
  } catch (err) {
    return c.json({
      error: 'memory_store_failed',
      detail: err instanceof Error ? err.message : String(err),
    }, 500)
  }

  return c.json({ ok: true, id, agent_id: agentId, text, concepts: body.concepts }, 201)
})

// POST /memory/search — 16D RRF vector memory search
mirrorApp.post('/memory/search', handleSearch)

// POST/DELETE /memory/forget & DELETE /memory/:id — delete engram entry
const handleForget = async (c: import('hono').Context<{ Bindings: Env }>) => {
  let id = c.req.param('id')
  let agentId: string | undefined

  if (!id) {
    try {
      const body = await c.req.json()
      id = body.id
      agentId = body.agent_id
    } catch {}
  }

  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    return c.json({ error: 'invalid_payload', detail: 'id string parameter is required' }, 400)
  }

  if (!c.env.DB) {
    return c.json({ error: 'database_unavailable', detail: 'DB binding missing' }, 500)
  }

  const targetId = id.trim()

  try {
    const checkSql = agentId
      ? 'SELECT id FROM engrams WHERE id = ? AND agent_id = ?'
      : 'SELECT id FROM engrams WHERE id = ?'
    const params = agentId ? [targetId, agentId] : [targetId]
    const existing = await c.env.DB.prepare(checkSql).bind(...params).first()

    if (!existing) {
      return c.json({ error: 'not_found', detail: `engram memory entry '${targetId}' not found` }, 404)
    }

    const deleteSql = agentId
      ? 'DELETE FROM engrams WHERE id = ? AND agent_id = ?'
      : 'DELETE FROM engrams WHERE id = ?'
    await c.env.DB.prepare(deleteSql).bind(...params).run()

    if (c.env.VEC) {
      try {
        await c.env.VEC.deleteByIds([targetId])
      } catch (err) {
        console.warn('[mirror] Vector index delete failed (relational engram purged):', err)
      }
    }

    return c.json({ ok: true, deleted_id: targetId, count: 1 }, 200)
  } catch (err) {
    return c.json({
      error: 'memory_forget_failed',
      detail: err instanceof Error ? err.message : String(err),
    }, 500)
  }
}

mirrorApp.post('/memory/forget', handleForget)
mirrorApp.delete('/memory/forget', handleForget)
mirrorApp.delete('/memory/:id', handleForget)

// GET /memory/:id — fetch engram by ID
mirrorApp.get('/memory/:id', async (c) => {
  const id = c.req.param('id')
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    return c.json({ error: 'invalid_payload', detail: 'id string parameter is required' }, 400)
  }

  if (!c.env.DB) {
    return c.json({ error: 'database_unavailable', detail: 'DB binding missing' }, 500)
  }

  try {
    const row = await c.env.DB.prepare(
      'SELECT id, agent_id, text, concepts, created_at FROM engrams WHERE id = ?'
    ).bind(id.trim()).first<{ id: string; agent_id: string; text: string; concepts: string | null; created_at: string }>()

    if (!row) {
      return c.json({ error: 'not_found', detail: `engram memory entry '${id}' not found` }, 404)
    }

    const concepts = parseConceptsJson(row.concepts)

    return c.json({
      ok: true,
      engram: {
        id: row.id,
        agent_id: row.agent_id,
        text: row.text,
        concepts,
        created_at: row.created_at,
      },
    }, 200)
  } catch (err) {
    return c.json({
      error: 'memory_fetch_failed',
      detail: err instanceof Error ? err.message : String(err),
    }, 500)
  }
})

// GET /memory — list recent engrams
mirrorApp.get('/memory', async (c) => {
  if (!c.env.DB) {
    return c.json({ error: 'database_unavailable', detail: 'DB binding missing' }, 500)
  }

  const agentId = c.req.query('agent_id')
  const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 20), 100)

  try {
    const sql = agentId
      ? 'SELECT id, agent_id, text, concepts, created_at FROM engrams WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
      : 'SELECT id, agent_id, text, concepts, created_at FROM engrams ORDER BY id DESC LIMIT ?'
    const params = agentId ? [agentId, limit] : [limit]
    const rows = await c.env.DB.prepare(sql).bind(...params).all<{ id: string; agent_id: string; text: string; concepts: string | null; created_at: string }>()

    const engrams = (rows.results ?? []).map((r) => {
      const concepts = parseConceptsJson(r.concepts)
      return { id: r.id, agent_id: r.agent_id, text: r.text, concepts, created_at: r.created_at }
    })

    return c.json({ ok: true, engrams, total: engrams.length }, 200)
  } catch (err) {
    return c.json({
      error: 'memory_list_failed',
      detail: err instanceof Error ? err.message : String(err),
    }, 500)
  }
})

