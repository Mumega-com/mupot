import { describe, expect, it } from 'vitest'
import { mirrorApp } from '../src/addons/mirror'

describe('Mirror Persistent Agent Memory REST API Suite (B-001)', () => {
  const store = new Map<string, any>()

  const mockEnv = {
    TENANT_SLUG: 'mumega.com',
    MIRROR_SECRET: 'test-mirror-secret-123',
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          run: async () => {
            if (sql.includes('INSERT INTO engrams')) {
              store.set(args[0], {
                id: args[0],
                agent_id: args[1],
                text: args[2],
                concepts: args[3],
                created_at: new Date().toISOString(),
              })
            }
            if (sql.includes('DELETE FROM engrams')) {
              store.delete(args[0])
            }
            return { success: true }
          },
          first: async () => {
            if (sql.includes('SELECT id FROM engrams') || sql.includes('SELECT id, agent_id, text')) {
              const entry = store.get(args[0])
              if (!entry) return null
              if (args[1] && entry.agent_id !== args[1]) return null
              return entry
            }
            return null
          },
          all: async () => {
            if (sql.includes('SELECT id, agent_id, text')) {
              const results = Array.from(store.values()).filter((e) => {
                if (args.length === 2 && typeof args[0] === 'string' && !args[0].includes('%')) {
                  return e.agent_id === args[0]
                }
                return true
              })
              return { results }
            }
            return { results: [] }
          },
        }),
      }),
    },
  } as any

  const authHeaders = {
    'Content-Type': 'application/json',
    'X-Mirror-Secret': 'test-mirror-secret-123',
  }

  it('1) POST /memory/store creates a new memory engram', async () => {
    const res = await mirrorApp.request(
      '/memory/store',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          id: 'engram-b001-001',
          agent_id: 'river-code',
          text: 'Mirror memory kernel provides 16D RRF vector search',
          concepts: ['mirror', 'memory', 'vector'],
        }),
      },
      mockEnv
    )

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.id).toBe('engram-b001-001')
    expect(json.agent_id).toBe('river-code')
    expect(json.text).toContain('Mirror memory kernel')
  })

  it('2) GET /memory/:id retrieves stored engram by ID', async () => {
    const res = await mirrorApp.request(
      '/memory/engram-b001-001',
      { headers: authHeaders },
      mockEnv
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.engram.id).toBe('engram-b001-001')
    expect(json.engram.agent_id).toBe('river-code')
    expect(json.engram.text).toContain('16D RRF vector search')
  })

  it('3) GET /memory lists recent engrams', async () => {
    const res = await mirrorApp.request('/memory?limit=10', { headers: authHeaders }, mockEnv)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.engrams.length).toBeGreaterThan(0)
  })

  it('4) POST /memory/search runs RRF memory search', async () => {
    const res = await mirrorApp.request(
      '/memory/search',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ query: 'vector search', agent_id: 'river-code' }),
      },
      mockEnv
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.engine).toBe('16d-rrf')
  })

  it('5) DELETE /memory/:id forgets an engram entry', async () => {
    const res = await mirrorApp.request(
      '/memory/engram-b001-001',
      {
        method: 'DELETE',
        headers: authHeaders,
      },
      mockEnv
    )

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.deleted_id).toBe('engram-b001-001')

    // Confirm it's gone
    const fetchRes = await mirrorApp.request('/memory/engram-b001-001', { headers: authHeaders }, mockEnv)
    expect(fetchRes.status).toBe(404)
  })

  it('6) Fail-closed 400 when text is missing from /memory/store', async () => {
    const res = await mirrorApp.request(
      '/memory/store',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ agent_id: 'river-code' }),
      },
      mockEnv
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('invalid_payload')
  })
})
