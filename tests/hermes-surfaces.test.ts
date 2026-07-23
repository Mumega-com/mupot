import { describe, it, expect } from 'vitest'
import { architectCeremonyPlan, assertSeatableCapability } from '../src/hermes-surfaces/architect'
import { hermesSessionKeyForMember } from '../src/hermes-surfaces/bindings'

describe('architectCeremonyPlan', () => {
  it('lists MCP tools and seats the requester', () => {
    const plan = architectCeremonyPlan({
      departmentSlug: 'growth',
      squadSlug: 'content',
      agentSlug: 'writer-hermes',
      requesterMemberId: '11111111-1111-1111-1111-111111111111',
    })
    expect(plan.tools).toContain('seat_member_on_squad')
    expect(plan.steps.some((s) => s.includes('create_department'))).toBe(true)
    expect(plan.steps.some((s) => s.includes('11111111-1111-1111-1111-111111111111'))).toBe(true)
    expect(plan.rule).toMatch(/seat the requesting member/i)
  })

  it('assertSeatableCapability allowlists ranks', () => {
    expect(assertSeatableCapability('member')).toBe('member')
    expect(() => assertSeatableCapability('owner')).toThrow()
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
