import { describe, it, expect } from 'vitest'
import {
  architectCeremonyPlan,
  assertSeatableCapability,
  ARCHITECT_GATE_OWNER,
} from '../src/hermes-surfaces/architect'
import {
  bindMemberHermesAgent,
  hermesSessionKeyForMember,
  HermesSurfacesError,
} from '../src/hermes-surfaces/bindings'
import type { Env } from '../src/types'

describe('architectCeremonyPlan', () => {
  it('lists MCP tools and seats the requester', () => {
    const plan = architectCeremonyPlan({
      departmentSlug: 'growth',
      squadSlug: 'content',
      agentSlug: 'writer-hermes',
      requesterMemberId: '11111111-1111-1111-1111-111111111111',
    })
    expect(plan.tools).toContain('seat_member_on_squad')
    expect(plan.tools).toContain('request_architect_standup')
    expect(plan.steps.some((s) => s.includes('create_department'))).toBe(true)
    expect(plan.steps.some((s) => s.includes('11111111-1111-1111-1111-111111111111'))).toBe(true)
    expect(plan.rule).toMatch(/request_architect_standup/i)
  })

  it('assertSeatableCapability allowlists ranks', () => {
    expect(assertSeatableCapability('member')).toBe('member')
    expect(() => assertSeatableCapability('owner')).toThrow()
  })

  it('uses a stable architect gate owner capability', () => {
    expect(ARCHITECT_GATE_OWNER).toBe('gate:architect')
  })
})

describe('hermesSessionKeyForMember', () => {
  it('scopes Open WebUI memory key to member UUID', () => {
    expect(hermesSessionKeyForMember('22222222-2222-2222-2222-222222222222')).toBe(
      'mupot-member:22222222-2222-2222-2222-222222222222',
    )
    expect(() => hermesSessionKeyForMember('not-a-uuid')).toThrow()
  })
})

describe('bindMemberHermesAgent squad capability', () => {
  const MEMBER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const AGENT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const SQUAD = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  const DEPT = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

  function makeEnv(opts: {
    memberOk?: boolean
    agentOk?: boolean
    squadGrant?: 'observer' | 'member' | 'lead' | null
  }): Env {
    const memberOk = opts.memberOk !== false
    const agentOk = opts.agentOk !== false
    const squadGrant = opts.squadGrant === undefined ? 'member' : opts.squadGrant
    const bindings = new Map<string, { member_id: string; agent_id: string; created_at: string; updated_at: string }>()

    return {
      TENANT_SLUG: 'test-tenant',
      DB: {
        prepare(sql: string) {
          const s = sql.replace(/\s+/g, ' ').toLowerCase()
          const binds: unknown[] = []
          const stmt = {
            bind(...args: unknown[]) {
              binds.push(...args)
              return stmt
            },
            async first<T>(): Promise<T | null> {
              if (s.includes('from members')) {
                return memberOk ? ({ id: MEMBER } as unknown as T) : null
              }
              if (s.includes('from agents') && s.includes('join squads')) {
                return agentOk ? ({ id: AGENT, squad_id: SQUAD } as unknown as T) : null
              }
              if (s.includes('from squads') && s.includes('department_id')) {
                return { department_id: DEPT } as unknown as T
              }
              if (s.includes('from member_hermes_bindings')) {
                const row = bindings.get(MEMBER)
                return (row ?? null) as T | null
              }
              return null
            },
            async all<T>() {
              if (s.includes('from capabilities')) {
                const rows =
                  squadGrant === null
                    ? []
                    : [
                        {
                          member_id: MEMBER,
                          scope_type: 'squad',
                          scope_id: SQUAD,
                          capability: squadGrant,
                        },
                      ]
                return { results: rows as unknown as T[] }
              }
              return { results: [] as T[] }
            },
            async run() {
              if (s.includes('insert into member_hermes_bindings')) {
                const now = new Date().toISOString()
                bindings.set(MEMBER, {
                  member_id: MEMBER,
                  agent_id: AGENT,
                  created_at: now,
                  updated_at: now,
                })
              }
              return { meta: { changes: 1 } }
            },
          }
          return stmt
        },
      },
    } as unknown as Env
  }

  it('rejects bind when member lacks member+ on agent squad', async () => {
    await expect(
      bindMemberHermesAgent(makeEnv({ squadGrant: 'observer' }), { memberId: MEMBER, agentId: AGENT }),
    ).rejects.toMatchObject({ code: 'member_not_on_squad' })
    await expect(
      bindMemberHermesAgent(makeEnv({ squadGrant: null }), { memberId: MEMBER, agentId: AGENT }),
    ).rejects.toBeInstanceOf(HermesSurfacesError)
  })

  it('binds when member holds member+ and agent is squad-joined', async () => {
    const binding = await bindMemberHermesAgent(makeEnv({ squadGrant: 'member' }), {
      memberId: MEMBER,
      agentId: AGENT,
    })
    expect(binding.member_id).toBe(MEMBER)
    expect(binding.agent_id).toBe(AGENT)
  })

  it('rejects agent with no squad join (tenant fence)', async () => {
    await expect(
      bindMemberHermesAgent(makeEnv({ agentOk: false }), { memberId: MEMBER, agentId: AGENT }),
    ).rejects.toMatchObject({ code: 'agent_not_found' })
  })
})
