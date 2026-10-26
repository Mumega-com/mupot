import { describe, expect, it } from 'vitest'
import { decodeSocketAttachment } from '../src/agents/seat-events'
import { decodeBearerSubscription, bearerAcceptRefusal, bearerHintVisible } from '../src/agents/seat-events-bearer'

const sub = { kind: 'bearer' as const, tenant: 't', agent: 'a', seat: 's', credential_id: 'c', member_id: 'm', not_after: 1000 }
describe('bearer observer partition and capacity', () => {
  it('never decodes explicit bearer or unknown kinds as a legacy host', () => {
    expect(decodeSocketAttachment({ ...sub, host: 'h', agents: ['a'] }).sub).toBeUndefined()
    expect(decodeSocketAttachment({ kind: 'unknown', host: 'h', agents: ['a'] }).sub).toBeUndefined()
    expect(decodeSocketAttachment({ sub: { kind: 'bearer', host: 'h', agents: ['a'] } }).sub).toBeUndefined()
    expect(decodeSocketAttachment({ host: 'h', agents: ['a'] }).sub).toEqual({ host: 'h', agents: ['a'] })
  })
  it('requires a complete unexpired server descriptor', () => {
    expect(decodeBearerSubscription(sub, 't', 100)).toEqual(sub)
    for (const bad of [{ ...sub, tenant: 'other' }, { ...sub, not_after: 100 }, { ...sub, kind: 'host' }, { ...sub, credential_id: '' }, { ...sub, seat: 3 }]) {
      expect(decodeBearerSubscription(bad, 't', 100)).toBeNull()
    }
  })
  it('only emits own-agent matching-seat and broadcast hints while live', () => {
    expect(bearerHintVisible(sub, { to_agent: 'a', target_seat: 's' }, 100)).toBe(true)
    expect(bearerHintVisible(sub, { to_agent: 'a', target_seat: null }, 100)).toBe(true)
    expect(bearerHintVisible(sub, { to_agent: 'b', target_seat: 's' }, 100)).toBe(false)
    expect(bearerHintVisible(sub, { to_agent: 'a', target_seat: 'x' }, 100)).toBe(false)
    expect(bearerHintVisible({ ...sub, seat: null }, { to_agent: 'a', target_seat: 's' }, 100)).toBe(false)
    expect(bearerHintVisible(sub, { to_agent: 'a', target_seat: 's' }, 1000)).toBe(false)
  })
  it('keeps credential, agent and pot caps independent of host capacity', () => {
    expect(bearerAcceptRefusal(sub, [], false)).toBeNull()
    expect(bearerAcceptRefusal(sub, [], true)).toBe('notify_owned_by_fleet_host')
    expect(bearerAcceptRefusal(sub, [sub, sub], false)).toBe('bearer_credential_capacity')
    expect(bearerAcceptRefusal(sub, Array.from({ length: 4 }, (_, i) => ({ ...sub, credential_id: `other-${i}` })), false)).toBe('bearer_agent_capacity')
    expect(bearerAcceptRefusal(sub, Array.from({ length: 256 }, (_, i) => ({ ...sub, agent: `other-${i}` })), false)).toBe('bearer_pot_capacity')
  })
})
