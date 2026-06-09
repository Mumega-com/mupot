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
      headers: { get: () => null },
      async text() {
        return JSON.stringify(responseBody)
      },
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

// Namespaced + host-pinned secret: a loop may name LOOP_SECRET_ghl, which is only
// ever sent to the host pinned in LOOP_SECRET_ghl_HOST. Platform secrets live outside
// the LOOP_SECRET_ prefix and are unreachable from a manifest.
const ENV = {
  TENANT_SLUG: 't',
  LOOP_SECRET_ghl: 'secret-xyz',
  LOOP_SECRET_ghl_HOST: 'x',
  GITHUB_TOKEN: 'platform-secret-must-never-leak',
} as unknown as Env

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

  it('resolves a namespaced, host-pinned secret as a Bearer header — NEVER from the manifest', async () => {
    const { fn, calls } = fakeFetch({ result: { structuredContent: { results: [] } } })
    // ref names the logical 'ghl' secret + carries a decoy inline field.
    const ref = { kind: 'mcp' as const, url: 'https://x/mcp', auth_ref: 'ghl', secret: 'ATTACKER-INLINE' }
    const r = resolveResource(ENV, ref, { fetchFn: fn })
    await r.read('q')
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-xyz') // from LOOP_SECRET_ghl, pinned to host 'x'
    expect(JSON.stringify(calls[0].init)).not.toContain('ATTACKER-INLINE')
  })

  it('P0: a manifest CANNOT exfiltrate a platform secret to an attacker URL', async () => {
    const { fn, calls } = fakeFetch({ result: { structuredContent: { results: [] } } })
    // Attack: bind an attacker URL + name a platform secret. GITHUB_TOKEN is not under
    // the LOOP_SECRET_ prefix, so it is unreachable → no auth header, secret never sent.
    const ref = { kind: 'mcp' as const, url: 'https://attacker.example/mcp', auth_ref: 'GITHUB_TOKEN' }
    const r = resolveResource(ENV, ref, { fetchFn: fn })
    await r.read('q')
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(JSON.stringify(calls[0].init)).not.toContain('platform-secret-must-never-leak')
  })

  it('refuses to send a secret to an unpinned host (fail closed)', () => {
    // LOOP_SECRET_ghl exists but is pinned to host 'x'; this url is a different host.
    const env = { ...ENV } as unknown as Env
    expect(() =>
      resolveResource(env, { kind: 'mcp', url: 'https://evil.example/mcp', auth_ref: 'ghl' }, { fetchFn: fakeFetch({}).fn }),
    ).toThrow('mcp_secret_host_mismatch')
  })

  it('refuses a secret with no host pin', () => {
    const env = { TENANT_SLUG: 't', LOOP_SECRET_np: 'sek' } as unknown as Env // no _HOST
    expect(() =>
      resolveResource(env, { kind: 'mcp', url: 'https://x/mcp', auth_ref: 'np' }, { fetchFn: fakeFetch({}).fn }),
    ).toThrow('mcp_secret_host_not_pinned')
  })

  it('rejects a blocked (private/metadata) host at resolve time', () => {
    expect(() =>
      resolveResource(ENV, { kind: 'mcp', url: 'https://169.254.169.254/mcp' }, { fetchFn: fakeFetch({}).fn }),
    ).toThrow('mcp_url_blocked_host')
  })

  it('omits the auth header when auth_ref names a missing LOOP_SECRET binding', async () => {
    const { fn, calls } = fakeFetch({ result: { structuredContent: { results: [] } } })
    const r = resolveResource(ENV, { kind: 'mcp', url: 'https://x/mcp', auth_ref: 'nope' }, { fetchFn: fn })
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

describe('resolveResource — queue built-in (P4)', () => {
  it('read() maps queued prospects to items (org/email/consent carried for the reasoner + CASL)', async () => {
    const listQueued = vi.fn(async () => [
      { id: 'p1', tenant: 't', loop_id: null, org: 'Acme', contact_name: 'Sam', email: 'sam@acme.com', source: 'seed' as const, consent_basis: 'consent' as const, status: 'queued' as const, notes: null, created_at: 'x' },
    ])
    const r = resolveResource(ENV, { kind: 'queue', name: 'loop-1' }, { listQueued })
    const items = await r.read('', { limit: 5 })
    expect(items[0]).toMatchObject({ id: 'p1', title: 'Acme', email: 'sam@acme.com', consent_basis: 'consent' })
    expect(listQueued).toHaveBeenCalledWith(ENV, { loopId: 'loop-1', limit: 5 })
    await expect(r.act('x', {})).rejects.toThrow('queue_resource_is_read_only')
  })
})
