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

  it('integration: getSquad, getAgent, and getTask propagate 409 ambiguous status and candidates instead of flattening to 404 not_found', async () => {
    const { getSquad, getAgent, getTask } = await import('../src/mcp/index')

    const squadOutcome = await getSquad(mockEnv, 'ambig123')
    expect(squadOutcome.ok).toBe(false)
    if (!squadOutcome.ok) {
      expect(squadOutcome.status).toBe(409)
      expect(squadOutcome.error).toBe('ambiguous_squad_id')
      expect((squadOutcome.detail as { candidates: string[] }).candidates.length).toBe(2)
    }

    const agentOutcome = await getAgent(mockEnv, 'ambig123')
    expect(agentOutcome.ok).toBe(false)
    if (!agentOutcome.ok) {
      expect(agentOutcome.status).toBe(409)
      expect(agentOutcome.error).toBe('ambiguous_agent_id')
      expect((agentOutcome.detail as { candidates: string[] }).candidates.length).toBe(2)
    }

    const taskOutcome = await getTask(mockEnv, 'ambig123')
    expect(taskOutcome.ok).toBe(false)
    if (!taskOutcome.ok) {
      expect(taskOutcome.status).toBe(409)
      expect(taskOutcome.error).toBe('ambiguous_task_id')
      expect((taskOutcome.detail as { candidates: string[] }).candidates.length).toBe(2)
    }
  })
})
