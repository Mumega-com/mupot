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
import { isBlockedHost } from './manifest'
import { createMemory } from '../memory'

// Secrets a loop may name are NAMESPACED: auth_ref 'ghl' resolves env.LOOP_SECRET_ghl,
// and the secret only travels to the host pinned in env.LOOP_SECRET_ghl_HOST. Platform
// secrets (GITHUB_TOKEN, BUS_TOKEN, OAUTH_*, …) are NOT under this prefix, so a manifest
// can never name them. This is the fix for the P1 adversarial BLOCK (url×auth_ref exfil).
const SECRET_PREFIX = 'LOOP_SECRET_'
const HOST_SUFFIX = '_HOST'
const MCP_TIMEOUT_MS = 15_000
const MCP_MAX_RESPONSE_BYTES = 1_000_000 // 1 MB cap on an MCP response body

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
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`mcp_http_${res.status}`)
  // Size cap: reject an oversized body before parsing (a bound server may be hostile).
  const declared = res.headers.get('content-length')
  if (declared && Number(declared) > MCP_MAX_RESPONSE_BYTES) throw new Error('mcp_response_too_large')
  const text = await res.text()
  if (text.length > MCP_MAX_RESPONSE_BYTES) throw new Error('mcp_response_too_large')
  const json = JSON.parse(text) as { result?: unknown; error?: { message?: string } }
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
  const url = ref.url as string // validator guarantees a safe https url for kind='mcp'

  // Defense in depth: re-check the host at resolve time (the validator already
  // rejected blocked hosts, but a caller could bypass validation).
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error('mcp_url_invalid')
  }
  if (isBlockedHost(host)) throw new Error('mcp_url_blocked_host')

  // ── Secret resolution (the P0 fix) ────────────────────────────────────────────
  // auth_ref names a NAMESPACED secret: env.LOOP_SECRET_<auth_ref>. Platform secrets
  // (GITHUB_TOKEN, BUS_TOKEN, OAUTH_*) live OUTSIDE this prefix → unreachable by a
  // manifest. AND the secret is HOST-PINNED: it is only ever sent to the host named
  // in env.LOOP_SECRET_<auth_ref>_HOST. If the pin is missing or mismatched we refuse
  // to send the secret (fail closed) — a secret can never travel to an unpinned host.
  let secret: string | undefined
  if (ref.auth_ref) {
    const bag = env as unknown as Record<string, unknown>
    const rawSecret = bag[SECRET_PREFIX + ref.auth_ref]
    const pinnedHost = bag[SECRET_PREFIX + ref.auth_ref + HOST_SUFFIX]
    if (typeof rawSecret === 'string' && rawSecret.length > 0) {
      if (typeof pinnedHost !== 'string' || pinnedHost.length === 0) {
        throw new Error('mcp_secret_host_not_pinned')
      }
      if (pinnedHost.toLowerCase() !== host.toLowerCase()) {
        throw new Error('mcp_secret_host_mismatch')
      }
      secret = rawSecret
    }
    // auth_ref named but no LOOP_SECRET_* binding → no secret (unauthenticated call).
  }
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
