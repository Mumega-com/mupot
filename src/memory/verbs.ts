// MEMORY_VERBS v1 HTTP MCP client — GBrain, me0-mcp, or any conformant server.
// Mupot keeps attribution: provenance is server-stamped with tenant + scope.
// Isolation: every call scopes entity to `${tenant}/${scope}` so a shared
// brain cannot leak across pots or agents.

import type { Env, MemoryHit, MemoryPort } from '../types'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class MemoryBackendError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'MemoryBackendError'
  }
}

export function scopedEntity(tenant: string, scope: string): string {
  return `${tenant}/${scope}`
}

export function attributedProvenance(tenant: string, scope: string): string {
  return `mupot tenant=${tenant} scope=${scope}`
}

interface McpToolResult {
  result?: {
    structuredContent?: Record<string, unknown>
    content?: Array<{ type?: string; text?: string }>
    isError?: boolean
  }
  error?: { message?: string }
}

function parseMcpPayload(body: McpToolResult): Record<string, unknown> {
  if (body.error?.message) throw new MemoryBackendError(body.error.message, 'memory_verbs_rpc_error')
  const structured = body.result?.structuredContent
  if (structured && typeof structured === 'object') return structured
  const text = body.result?.content?.find((c) => typeof c.text === 'string')?.text
  if (text) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      return { text }
    }
  }
  throw new MemoryBackendError('MEMORY_VERBS server returned no payload', 'memory_verbs_empty')
}

export function createVerbsMemory(
  env: Env,
  deps: { fetch?: FetchLike } = {},
): MemoryPort {
  const url = env.MEMORY_VERBS_URL?.trim() ?? ''
  if (!url) {
    throw new MemoryBackendError(
      'MEMORY_BACKEND=verbs requires MEMORY_VERBS_URL',
      'memory_verbs_url_required',
    )
  }
  const fetchImpl = deps.fetch ?? fetch

  async function callVerb(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (env.MEMORY_VERBS_TOKEN) headers.authorization = `Bearer ${env.MEMORY_VERBS_TOKEN}`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    if (!res.ok) {
      throw new MemoryBackendError(
        `MEMORY_VERBS ${name} HTTP ${res.status}`,
        'memory_verbs_http_error',
      )
    }
    return parseMcpPayload((await res.json()) as McpToolResult)
  }

  return {
    backend: 'verbs',
    async remember(agentId: string, text: string, concepts?: string[]): Promise<string> {
      const payload = await callVerb('remember', {
        fact: text,
        provenance: attributedProvenance(env.TENANT_SLUG, agentId),
        entity: scopedEntity(env.TENANT_SLUG, agentId),
        kind: concepts?.[0] ?? 'fact',
        visibility: 'world',
      })
      const id = payload.id ?? payload.fact_id
      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new MemoryBackendError('MEMORY_VERBS remember returned no id', 'memory_verbs_empty')
      }
      return String(id)
    },

    async recall(agentId: string, query: string, limit = 5): Promise<MemoryHit[]> {
      const payload = await callVerb('recall', {
        query,
        entity: scopedEntity(env.TENANT_SLUG, agentId),
        limit,
      })
      const facts = Array.isArray(payload.facts) ? payload.facts : []
      const results = Array.isArray(payload.results) ? payload.results : []
      const hits: MemoryHit[] = []
      for (const fact of facts) {
        if (!fact || typeof fact !== 'object') continue
        const row = fact as Record<string, unknown>
        const id = row.fact_id ?? row.id
        const text = typeof row.fact === 'string' ? row.fact : typeof row.text === 'string' ? row.text : null
        if (id == null || !text) continue
        hits.push({ id: String(id), text, score: 1 })
      }
      for (const result of results) {
        if (!result || typeof result !== 'object') continue
        const row = result as Record<string, unknown>
        const id = typeof row.slug === 'string' ? row.slug : null
        const text = typeof row.chunk === 'string' ? row.chunk : typeof row.title === 'string' ? row.title : null
        if (!id || !text) continue
        hits.push({ id, text, score: 0.8 })
      }
      return hits.slice(0, limit)
    },
  }
}
