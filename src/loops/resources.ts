// mupot — ResourceRef resolver: the seam that turns a declarative ResourceRef into a
// live handle the runtime can read from / act through (P1, #32).
//
// THE BIG BET (market scan 2026-06-08): MCP won. So sources and channels are
// MCP-native — any MCP server (our own pot MCP, a ChatGPT connector, Google Drive,
// GitHub, the ~17k public servers) plugs in with zero bespoke adapter code. Built-in
// kinds (`memory`) cover what already lives in-pot and isn't worth an MCP hop.
//
// SECURITY (sensitive surface — external read + credentials):
//   - A secret is NEVER read from the manifest/ResourceRef. `auth_ref` is an OPAQUE
//     NAME; the resolver looks it up in the Worker env (server-side binding) and uses
//     it as a bearer token. A manifest can name a secret; it can never supply one.
//   - `tool_filter`, when set, is an allowlist: the resolver refuses any tool (read
//     or act) not in it. Defense against a manifest binding a broad MCP server and
//     then calling a dangerous tool.
//   - The MCP transport is injectable (fetchFn) so this is unit-tested without network.

import type { Env } from '../types'
import type { ResourceRef, ResourceKind } from './manifest'
import { createMemory } from '../memory'

export interface ResourceItem {
  id: string
  title?: string
  text?: string
  url?: string
  [k: string]: unknown
}

export interface ResolvedResource {
  kind: ResourceKind
  /** Perceive: pull items from the source. `tool` overrides the default read tool. */
  read(query: string, opts?: { tool?: string; limit?: number }): Promise<ResourceItem[]>
  /** Act: invoke a named tool on the resource (gated by tool_filter). */
  act(tool: string, args: Record<string, unknown>): Promise<unknown>
}

export interface ResolveDeps {
  /** MCP HTTP transport. Defaults to global fetch; injected in tests. */
  fetchFn?: typeof fetch
  /** Memory recall seam (built-in 'memory'). Defaults to createMemory(env).recall. */
  recall?: (scope: string, query: string, limit?: number) => Promise<Array<{ id: string; text: string; score: number }>>
}

const DEFAULT_READ_TOOL = 'search'

/** Resolve a ResourceRef to a live handle. Throws on an unsupported/forbidden ref. */
export function resolveResource(env: Env, ref: ResourceRef, deps: ResolveDeps = {}): ResolvedResource {
  switch (ref.kind) {
    case 'mcp':
      return mcpResource(env, ref, deps)
    case 'memory':
      return memoryResource(env, ref, deps)
    case 'queue':
      // The concrete prospect/work queue lands in P4 (#35). Recognised by the
      // manifest validator, not yet resolvable — fail loud, never silently empty.
      throw new Error('resource_queue_lands_in_p4')
    default:
      throw new Error('unsupported_resource_kind')
  }
}

// ── built-in: memory ───────────────────────────────────────────────────────────

function memoryResource(env: Env, ref: ResourceRef, deps: ResolveDeps): ResolvedResource {
  const scope = ref.name && ref.name.length > 0 ? ref.name : 'loop'
  const recall = deps.recall ?? ((s, q, lim) => createMemory(env).recall(s, q, lim))
  return {
    kind: 'memory',
    async read(query, opts) {
      const hits = await recall(scope, query, opts?.limit ?? 5)
      return hits.map((h) => ({ id: h.id, text: h.text }))
    },
    async act() {
      // Memory is a read source; it has no act surface.
      throw new Error('memory_resource_is_read_only')
    },
  }
}

// ── MCP transport ────────────────────────────────────────────────────────────────

/**
 * Minimal JSON-RPC-over-HTTP MCP client. We do not run the stateful initialize
 * handshake — for a stateless tools/call over HTTP the call carries everything.
 * Keeps the Worker bundle tiny (no MCP SDK) per the size budget.
 */
async function mcpRpc(
  fetchFn: typeof fetch,
  url: string,
  secret: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  if (secret) headers.authorization = `Bearer ${secret}`
  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`mcp_http_${res.status}`)
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } }
  if (json.error) throw new Error(`mcp_error: ${json.error.message ?? 'unknown'}`)
  return json.result
}

/** Coerce an MCP tools/call result into ResourceItem[] (ChatGPT search shape first). */
function coerceItems(result: unknown): ResourceItem[] {
  if (result && typeof result === 'object') {
    const r = result as { structuredContent?: unknown; content?: unknown }
    const sc = r.structuredContent as { results?: unknown } | undefined
    if (sc && Array.isArray(sc.results)) {
      return sc.results.filter((x): x is ResourceItem => !!x && typeof x === 'object' && typeof (x as ResourceItem).id === 'string')
    }
    // Fallback: text content blocks → a single item per text block.
    if (Array.isArray(r.content)) {
      return (r.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c, i) => ({ id: `content-${i}`, text: c.text as string }))
    }
  }
  return []
}

function mcpResource(env: Env, ref: ResourceRef, deps: ResolveDeps): ResolvedResource {
  const fetchFn = deps.fetchFn ?? fetch
  const url = ref.url as string // validator guarantees an https url for kind='mcp'
  // Secret is resolved SERVER-SIDE from the env by the opaque auth_ref name. It is
  // never taken from the manifest. A missing binding → undefined → unauthenticated
  // call (the server decides). We index env defensively.
  const secret =
    ref.auth_ref && typeof (env as unknown as Record<string, unknown>)[ref.auth_ref] === 'string'
      ? ((env as unknown as Record<string, unknown>)[ref.auth_ref] as string)
      : undefined
  const filter = ref.tool_filter

  function assertAllowed(tool: string): void {
    if (filter && !filter.includes(tool)) throw new Error(`tool_not_allowed: ${tool}`)
  }

  return {
    kind: 'mcp',
    async read(query, opts) {
      const tool = opts?.tool ?? DEFAULT_READ_TOOL
      assertAllowed(tool)
      const result = await mcpRpc(fetchFn, url, secret, 'tools/call', {
        name: tool,
        arguments: { query, ...(opts?.limit ? { limit: opts.limit } : {}) },
      })
      return coerceItems(result)
    },
    async act(tool, args) {
      assertAllowed(tool)
      return mcpRpc(fetchFn, url, secret, 'tools/call', { name: tool, arguments: args })
    },
  }
}
