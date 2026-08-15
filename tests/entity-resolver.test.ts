import { describe, expect, it } from 'vitest'
import { resolveEntity } from '../src/lib/entity-resolver'
import type { Env } from '../src/types'

describe('entity-resolver — fail-closed short-UUID prefix resolution', () => {
  const mockEnv = {
    TENANT_SLUG: 'mumega',
    DB: {
      prepare: (query: string) => ({
        bind: (...binds: unknown[]) => ({
          first: async () => {
            if (binds[0] === '17aa283f-8cdb-4c1f-864f-1974ee45a033') {
              return { id: '17aa283f-8cdb-4c1f-864f-1974ee45a033', name: 'loom' }
            }
            return null
          },
          all: async () => {
            const prefix = binds[0] as string
            if (prefix.startsWith('17aa283f')) {
              return { results: [{ id: '17aa283f-8cdb-4c1f-864f-1974ee45a033', name: 'loom' }] }
            }
            if (prefix.startsWith('ambig123')) {
              return {
                results: [
                  { id: 'ambig123-1111-4444-8888-aaaaaaaaaaaa', name: 'agent1' },
                  { id: 'ambig123-2222-4444-8888-bbbbbbbbbbbb', name: 'agent2' },
                ],
              }
            }
            return { results: [] }
          },
        }),
      }),
    },
  } as unknown as Env

  it('resolves exact UUID match', async () => {
    const res = await resolveEntity<{ id: string; name: string }>(
      mockEnv,
      'agents',
      '17aa283f-8cdb-4c1f-864f-1974ee45a033',
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.entity.name).toBe('loom')
    }
  })

  it('resolves unique 8-char short prefix', async () => {
    const res = await resolveEntity<{ id: string; name: string }>(
      mockEnv,
      'agents',
      '17aa283f',
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.entity.id).toBe('17aa283f-8cdb-4c1f-864f-1974ee45a033')
      expect(res.entity.name).toBe('loom')
    }
  })

  it('fails closed with not_found when prefix < 8 chars', async () => {
    const res = await resolveEntity<{ id: string }>(mockEnv, 'agents', '17aa28')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('not_found')
    }
  })

  it('fails closed with ambiguous and returns candidate IDs when multiple match', async () => {
    const res = await resolveEntity<{ id: string }>(mockEnv, 'agents', 'ambig123')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('ambiguous')
      if (res.reason === 'ambiguous') {
        expect(res.candidates.length).toBe(2)
        expect(res.candidates).toContain('ambig123-1111-4444-8888-aaaaaaaaaaaa')
        expect(res.candidates).toContain('ambig123-2222-4444-8888-bbbbbbbbbbbb')
      }
    }
  })
})
