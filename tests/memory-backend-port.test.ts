import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  attributedProvenance,
  createMemory,
  MemoryBackendError,
  mirrorCite,
  resolveMemoryBackend,
  resolveMemoryLayers,
  scopedEntity,
} from '../src/memory'
import type { Env } from '../src/types'

function env(partial: Partial<Env> = {}): Env {
  return { TENANT_SLUG: 'pot-a', ...partial } as Env
}

describe('memory backend port', () => {
  it('defaults to native', () => {
    expect(resolveMemoryBackend(env())).toBe('native')
    expect(resolveMemoryBackend(env({ MEMORY_BACKEND: 'vectorize' }))).toBe('native')
    expect(createMemory(env()).backend).toBe('native')
    expect(resolveMemoryLayers(env())).toEqual(['native'])
  })

  it('does not schedule Mirror dreamer or cron work from this module', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/memory')
    for (const name of ['index.ts', 'layers.ts', 'mirror.ts', 'native.ts', 'verbs.ts']) {
      const src = readFileSync(join(dir, name), 'utf8')
      expect(src, name).not.toMatch(/dreamer|setInterval|CronJob|routine_create/i)
    }
  })

  it('refuses an unknown backend instead of falling through to native', () => {
    expect(() => resolveMemoryBackend(env({ MEMORY_BACKEND: 'gbrain-full' }))).toThrowError(MemoryBackendError)
    expect(() => resolveMemoryBackend(env({ MEMORY_BACKEND: 'gbrain-full' }))).toThrow(/unknown MEMORY_BACKEND/)
  })

  it('refuses verbs without MEMORY_VERBS_URL', () => {
    expect(() => createMemory(env({ MEMORY_BACKEND: 'verbs' }))).toThrowError(MemoryBackendError)
    expect(() => createMemory(env({ MEMORY_BACKEND: 'verbs' }))).toThrow(/MEMORY_VERBS_URL/)
  })

  it('refuses mem0 — not a live backend', () => {
    expect(() => resolveMemoryBackend(env({ MEMORY_BACKEND: 'mem0' }))).toThrow(/unknown MEMORY_BACKEND/)
  })

  it('stamps tenant+scope on a verbs remember and scopes recall', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { name: string; arguments: Record<string, unknown> }
      }
      calls.push({ name: body.params.name, args: body.params.arguments })
      if (body.params.name === 'remember') {
        return new Response(JSON.stringify({
          result: { structuredContent: { id: 'fact-9', status: 'inserted', protocol_version: 1 } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        result: {
          structuredContent: {
            protocol_version: 1,
            facts: [{ fact_id: 'fact-9', fact: 'CEO prefers dark mode', provenance: 'mupot' }],
            total: 1,
            results: [],
          },
        },
      }), { status: 200 })
    }

    const memory = createMemory(env({
      MEMORY_BACKEND: 'verbs',
      MEMORY_VERBS_URL: 'https://brain.example/mcp',
      MEMORY_VERBS_TOKEN: 'gbrain_xxx',
    }), { fetch: fetchImpl })

    expect(memory.backend).toBe('verbs')
    const id = await memory.remember('member:ceo-1', 'CEO prefers dark mode', ['preference'])
    expect(id).toBe('fact-9')
    expect(calls[0]).toEqual({
      name: 'remember',
      args: {
        fact: 'CEO prefers dark mode',
        provenance: attributedProvenance('pot-a', 'member:ceo-1'),
        entity: scopedEntity('pot-a', 'member:ceo-1'),
        kind: 'preference',
        visibility: 'world',
      },
    })

    const hits = await memory.recall('member:ceo-1', 'dark mode', 5)
    expect(hits).toEqual([{ id: 'fact-9', text: 'CEO prefers dark mode', score: 1 }])
    expect(calls[1]?.args.entity).toBe('pot-a/member:ceo-1')
  })

  it('refuses mirror without MIRROR_URL or MIRROR_TOKEN', () => {
    expect(() => createMemory(env({ MEMORY_BACKEND: 'mirror' }))).toThrow(/MIRROR_URL/)
    expect(() => createMemory(env({
      MEMORY_BACKEND: 'mirror',
      MIRROR_URL: 'https://mirror.example',
    }))).toThrow(/MIRROR_TOKEN/)
  })

  it('does not treat MIRROR_URL as a backend switch', () => {
    expect(createMemory(env({
      MIRROR_URL: 'https://mirror.example',
      MIRROR_TOKEN: 'tok',
    })).backend).toBe('native')
  })

  it('refuses Mac GBrain as a memory backend', () => {
    expect(() => resolveMemoryBackend(env({ MEMORY_BACKEND: 'gbrain' }))).toThrow(/unknown MEMORY_BACKEND/)
  })

  it('mirror remember/recall stamps ops_experience cite and fails closed when down', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      if (String(url).endsWith('/store')) {
        return new Response(JSON.stringify({ status: 'success', context_id: 'ctx-1' }), { status: 200 })
      }
      return new Response(JSON.stringify([
        {
          id: 'eng-9',
          context_id: 'ctx-1',
          text: 'ship on Tuesdays',
          similarity: 0.88,
          timestamp: '2026-09-12T02:00:00Z',
        },
        { id: 'eng-no-cite', text: 'stale claim', similarity: 0.9 },
      ]), { status: 200 })
    }

    const memory = createMemory(env({
      MEMORY_BACKEND: 'mirror',
      MIRROR_URL: 'https://mirror.example/',
      MIRROR_TOKEN: 'tok',
    }), { fetch: fetchImpl })

    expect(memory.backend).toBe('mirror')
    expect(await memory.remember('squad:core', 'ship on Tuesdays', ['ops'])).toBe('ctx-1')
    expect(calls[0]).toEqual({
      url: 'https://mirror.example/store',
      body: {
        agent: 'squad:core',
        context_id: expect.any(String),
        text: 'ship on Tuesdays',
        core_concepts: ['ops'],
        metadata: { tenant: 'pot-a', scope: 'squad:core', source: 'mupot' },
      },
    })

    const hits = await memory.recall('squad:core', 'ship', 5)
    expect(hits).toEqual([{
      id: 'eng-9',
      text: 'ship on Tuesdays',
      score: 0.88,
      class: 'ops_experience',
      cite: mirrorCite('pot-a', 'eng-9', '2026-09-12T02:00:00Z'),
    }])

    const down = createMemory(env({
      MEMORY_BACKEND: 'mirror',
      MIRROR_URL: 'https://mirror.example',
      MIRROR_TOKEN: 'tok',
    }), { fetch: async () => new Response('nope', { status: 503 }) })
    await expect(down.recall('squad:core', 'ship')).rejects.toThrow(/HTTP 503/)
    await expect(down.remember('squad:core', 'x')).rejects.toThrowError(MemoryBackendError)
  })

  it('MEMORY_LAYERS=native,mirror adds Mirror beside native', () => {
    expect(resolveMemoryLayers(env({
      MEMORY_LAYERS: 'native,mirror',
      MIRROR_URL: 'https://mirror.example',
      MIRROR_TOKEN: 'tok',
    }))).toEqual(['native', 'mirror'])
    const memory = createMemory(env({
      MEMORY_LAYERS: 'native,mirror',
      MIRROR_URL: 'https://mirror.example',
      MIRROR_TOKEN: 'tok',
    }), { fetch: async () => new Response('[]', { status: 200 }) })
    expect(memory.backend).toBe('native')
    expect(memory.layers).toEqual(['native', 'mirror'])
  })

  it('refuses a GBrain or mem0 layer', () => {
    expect(() => resolveMemoryLayers(env({ MEMORY_LAYERS: 'native,gbrain' }))).toThrow(/unknown MEMORY_LAYERS/)
    expect(() => resolveMemoryLayers(env({ MEMORY_LAYERS: 'mem0' }))).toThrow(/unknown MEMORY_LAYERS/)
  })

  it('layered recall keeps native hits when Mirror is down', async () => {
    const native = {
      backend: 'native' as const,
      async remember() { return 'n-1' },
      async recall(): Promise<Array<{ id: string; text: string; score: number; class: 'pot_engram' }>> {
        return [{ id: 'n-1', text: 'local note', score: 0.5, class: 'pot_engram' }]
      },
    }
    const { createLayeredMemory } = await import('../src/memory/layers')
    const layered = createLayeredMemory({
      native,
      mirror: {
        backend: 'mirror',
        remember: async () => { throw new MemoryBackendError('down', 'memory_mirror_down') },
        recall: async () => { throw new MemoryBackendError('down', 'memory_mirror_down') },
      },
    }, ['native', 'mirror'])

    expect(await layered.remember('member:ceo-1', 'local note')).toBe('n-1')
    await expect(layered.remember('squad:core', 'ops note')).rejects.toBeInstanceOf(MemoryBackendError)
    const hits = await layered.recall('squad:core', 'note')
    expect(hits).toEqual([{ id: 'n-1', text: 'local note', score: 0.5, class: 'pot_engram' }])
  })

})
