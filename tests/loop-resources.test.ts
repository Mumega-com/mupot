// tests/loop-resources.test.ts — ResourceRef resolver / MCP seam (P1, #32).
// Sensitive surface: assert secret-from-env (never manifest), tool_filter allowlist,
// JSON-RPC shape, error mapping, memory built-in, and the queue-not-yet guard.

import { describe, expect, it, vi } from 'vitest'
import { resolveResource } from '../src/loops/resources'
import type { Env } from '../src/types'

function fakeFetch(responseBody: unknown, ok = true, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return {
      ok,
      status,
      async json() {
        return responseBody
      },
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

const ENV = { TENANT_SLUG: 't', GHL_API_KEY: 'secret-xyz' } as unknown as Env

describe('resolveResource — mcp', () => {
  it('read() POSTs a tools/call JSON-RPC and parses structuredContent.results', async () => {
    const { fn, calls } = fakeFetch({
      result: { structuredContent: { results: [{ id: 'p1', title: 'Acme', url: 'https://acme' }] } },
    })
    const r = resolveResource(ENV, { kind: 'mcp', url: 'https://x/mcp' }, { fetchFn: fn })
    const items = await r.read('manufacturers', { limit: 10 })
    expect(items).toEqual([{ id: 'p1', title: 'Acme', url: 'https://acme' }])
    // wire shape
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.jsonrpc).toBe('2.0')
    expect(body.method).toBe('tools/call')
    expect(body.params).toEqual({ name: 'search', arguments: { query: 'manufacturers', limit: 10 } })
  })

  it('resolves the secret from env[auth_ref] as a Bearer header — NEVER from the manifest', async () => {
    const { fn, calls } = fakeFetch({ result: { structuredContent: { results: [] } } })
    // The ref names GHL_API_KEY (an env binding) and also carries a decoy inline field.
    const ref = { kind: 'mcp' as const, url: 'https://x/mcp', auth_ref: 'GHL_API_KEY', secret: 'ATTACKER-INLINE' }
    const r = resolveResource(ENV, ref, { fetchFn: fn })
    await r.read('q')
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-xyz') // from env, not the ref
    expect(JSON.stringify(calls[0].init)).not.toContain('ATTACKER-INLINE')
  })

  it('omits the auth header when auth_ref names a missing binding', async () => {
    const { fn, calls } = fakeFetch({ result: { structuredContent: { results: [] } } })
    const r = resolveResource(ENV, { kind: 'mcp', url: 'https://x/mcp', auth_ref: 'NOPE' }, { fetchFn: fn })
    await r.read('q')
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('enforces tool_filter as an allowlist on both read and act', async () => {
    const { fn } = fakeFetch({ result: { structuredContent: { results: [] } } })
    const r = resolveResource(
      ENV,
      { kind: 'mcp', url: 'https://x/mcp', tool_filter: ['search'] },
      { fetchFn: fn },
    )
    await expect(r.read('q')).resolves.toEqual([]) // 'search' allowed
    await expect(r.act('delete_everything', {})).rejects.toThrow('tool_not_allowed: delete_everything')
    await expect(r.read('q', { tool: 'danger' })).rejects.toThrow('tool_not_allowed: danger')
  })

  it('maps an HTTP error to mcp_http_<status>', async () => {
    const { fn } = fakeFetch({}, false, 503)
    const r = resolveResource(ENV, { kind: 'mcp', url: 'https://x/mcp' }, { fetchFn: fn })
    await expect(r.read('q')).rejects.toThrow('mcp_http_503')
  })

  it('maps a JSON-RPC error to mcp_error', async () => {
    const { fn } = fakeFetch({ error: { message: 'bad tool' } })
    const r = resolveResource(ENV, { kind: 'mcp', url: 'https://x/mcp' }, { fetchFn: fn })
    await expect(r.act('x', {})).rejects.toThrow('mcp_error: bad tool')
  })

  it('falls back to text content blocks when there is no structuredContent', async () => {
    const { fn } = fakeFetch({
      result: { content: [{ type: 'text', text: 'hello' }, { type: 'image' }] },
    })
    const r = resolveResource(ENV, { kind: 'mcp', url: 'https://x/mcp' }, { fetchFn: fn })
    const items = await r.read('q')
    expect(items).toEqual([{ id: 'content-0', text: 'hello' }])
  })
})

describe('resolveResource — memory built-in', () => {
  it('read() maps recall hits to items; act() is read-only', async () => {
    const recall = vi.fn(async () => [{ id: 'm1', text: 'a note', score: 0.9 }])
    const r = resolveResource(ENV, { kind: 'memory', name: 'outreach' }, { recall })
    const items = await r.read('context', { limit: 3 })
    expect(items).toEqual([{ id: 'm1', text: 'a note' }])
    expect(recall).toHaveBeenCalledWith('outreach', 'context', 3)
    await expect(r.act('x', {})).rejects.toThrow('memory_resource_is_read_only')
  })
})

describe('resolveResource — queue not yet', () => {
  it('throws a loud not-yet error (P4) rather than silently returning empty', () => {
    expect(() => resolveResource(ENV, { kind: 'queue', name: 'prospects' })).toThrow('resource_queue_lands_in_p4')
  })
})
