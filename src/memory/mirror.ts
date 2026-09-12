// Real Mirror MemoryPort — HTTP POST /store + /search on MIRROR_URL.
// This is the colony ops-experience store, not src/addons/pot-engram-rrf.ts
// and not Mac GBrain. Down Mirror fails closed. Hits without id+timestamp are dropped.

import type { Env, MemoryHit, MemoryPort } from '../types'
import { MemoryBackendError, type FetchLike } from './verbs'

export function mirrorCite(tenant: string, id: string, timestamp: string): string {
  return `mirror:${tenant}/${id}@${timestamp}`
}

function mirrorBase(env: Env): string {
  return (env.MIRROR_URL ?? '').trim().replace(/\/$/, '')
}

function asTimestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return null
}

function rowsFromSearchBody(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
  if (!body || typeof body !== 'object') return []
  const obj = body as Record<string, unknown>
  const list = obj.results ?? obj.hits ?? obj.engrams
  if (!Array.isArray(list)) return []
  return list.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
}

export function createMirrorMemory(env: Env, deps: { fetch?: FetchLike } = {}): MemoryPort {
  const base = mirrorBase(env)
  if (!base) {
    throw new MemoryBackendError(
      'MEMORY_BACKEND=mirror requires MIRROR_URL',
      'memory_mirror_url_required',
    )
  }
  if (!env.MIRROR_TOKEN?.trim()) {
    throw new MemoryBackendError(
      'MEMORY_BACKEND=mirror requires MIRROR_TOKEN',
      'memory_mirror_token_required',
    )
  }
  const fetchImpl = deps.fetch ?? fetch
  const token = env.MIRROR_TOKEN.trim()
  const tenant = env.TENANT_SLUG

  async function callMirror(path: string, payload: Record<string, unknown>): Promise<unknown> {
    let res: Response
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      throw new MemoryBackendError(
        `Mirror ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`,
        'memory_mirror_down',
      )
    }
    if (!res.ok) {
      throw new MemoryBackendError(
        `Mirror ${path} HTTP ${res.status}`,
        res.status >= 500 ? 'memory_mirror_down' : 'memory_mirror_http_error',
      )
    }
    return res.json()
  }

  return {
    backend: 'mirror',
    async remember(agentId: string, text: string, concepts?: string[]): Promise<string> {
      const contextId = crypto.randomUUID()
      const body = (await callMirror('/store', {
        agent: agentId,
        context_id: contextId,
        text,
        core_concepts: concepts ?? [],
        metadata: { tenant, scope: agentId, source: 'mupot' },
      })) as { id?: string; context_id?: string }

      const id = typeof body.id === 'string' && body.id ? body.id : body.context_id ?? contextId
      if (!id) {
        throw new MemoryBackendError('Mirror /store returned no id', 'memory_mirror_empty')
      }
      return id
    },

    async recall(agentId: string, query: string, limit = 5): Promise<MemoryHit[]> {
      const body = await callMirror('/search', {
        query,
        top_k: limit,
        agent_filter: agentId,
      })
      const hits: MemoryHit[] = []
      for (const row of rowsFromSearchBody(body)) {
        const id = typeof row.id === 'string' && row.id
          ? row.id
          : typeof row.context_id === 'string' && row.context_id
            ? row.context_id
            : null
        const text = typeof row.text === 'string' ? row.text : null
        const timestamp = asTimestamp(row.timestamp) ?? asTimestamp(row.ts)
        if (!id || !text || !timestamp) continue
        hits.push({
          id,
          text,
          score: typeof row.similarity === 'number' ? row.similarity : 1,
          class: 'ops_experience',
          cite: mirrorCite(tenant, id, timestamp),
        })
      }
      return hits.slice(0, limit)
    },
  }
}
