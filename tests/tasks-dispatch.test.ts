import { describe, expect, it } from 'vitest'
import { resolveAssignee } from '../src/tasks/index'
import type { Agent } from '../src/types'

// Dispatch (POST /api/tasks {dispatch:true}) waking an agent in execute mode is
// gated on resolveAssignee: the assignee must be an existing agent that lives in
// the SAME squad as the task. A cross-squad / unknown assignee is rejected before
// any wake is emitted (the route turns these into a 4xx). These tests pin that
// boundary directly so the wake can never fan to an agent outside the squad.

const AGENT_IN_SQUAD: Agent = {
  id: 'agent-1',
  squad_id: 'squad-1',
  slug: 'scout',
  name: 'Scout',
  role: 'researcher',
  model: '@cf/meta/llama-3.3',
  status: 'active',
  created_at: '2026-06-06T00:00:00.000Z',
}

// DB that returns a seeded agent (or null) for the agents-by-id lookup.
function makeEnv(agent: Agent | null) {
  const env = {
    DB: {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async first<T>() {
                return (agent as unknown as T) ?? null
              },
            }
          },
        }
      },
    },
  }
  return env as never
}

describe('resolveAssignee — dispatch boundary', () => {
  it('accepts an agent that belongs to the task squad', async () => {
    const r = await resolveAssignee(makeEnv(AGENT_IN_SQUAD), 'agent-1', 'squad-1')
    expect(r.error).toBeUndefined()
    expect(r.value).toBe('agent-1')
  })

  it('rejects an agent in a DIFFERENT squad (assignee_not_in_squad → 4xx)', async () => {
    const r = await resolveAssignee(makeEnv({ ...AGENT_IN_SQUAD, squad_id: 'other-squad' }), 'agent-1', 'squad-1')
    expect(r.error).toBe('assignee_not_in_squad')
    expect(r.value).toBeNull()
  })

  it('rejects an unknown assignee id (invalid_assignee → 4xx)', async () => {
    const r = await resolveAssignee(makeEnv(null), 'ghost', 'squad-1')
    expect(r.error).toBe('invalid_assignee')
    expect(r.value).toBeNull()
  })

  it('treats undefined/null as simply unassigned (no error)', async () => {
    expect(await resolveAssignee(makeEnv(null), undefined, 'squad-1')).toEqual({ value: null })
    expect(await resolveAssignee(makeEnv(null), null, 'squad-1')).toEqual({ value: null })
  })

  it('rejects a non-string / empty assignee', async () => {
    expect((await resolveAssignee(makeEnv(null), '', 'squad-1')).error).toBe('invalid_assignee')
    expect((await resolveAssignee(makeEnv(null), 42, 'squad-1')).error).toBe('invalid_assignee')
  })
})
