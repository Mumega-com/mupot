// tests/onboarding-next-step.test.ts — mupot task 13f6b7e8: ONE typed legal next step from the shared whoami
// derivation, for the six onboarding cases. Pure (buildWhoami is pure; no seat, agent or token is created here).

import { describe, expect, it } from 'vitest'
import { buildWhoami, type OnboardingNext, type WhoamiFacts } from '../src/mcp/whoami'
import type { AuthContext, Env } from '../src/types'

const ORIGIN = 'https://pot.test'
const ENV = { TENANT_SLUG: 'mumega', SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1' } as unknown as Env
const FACTS: WhoamiFacts = { keyed: false, fenced: false, bootstrappedBefore: false, tenantHasAgents: true, actsAs: null }
const authOf = (p: Partial<AuthContext>): AuthContext => ({ userId: 'u', role: 'member', tenant: 'mumega', channel: 'directory', memberId: 'mem-x', capabilities: [], ...p }) as unknown as AuthContext // builder reads only the fields named per case
const SEAT = { seatId: 'seat-1', label: 'chat', harnessId: 'h-1', grantTokenId: 'g-1', humanMemberId: 'mem-x', source: 'auto:openai_session' as const }
const ATTACHED = { attachmentId: 'a', admissionId: 'adm', agentId: 'ag', seatAgentId: 'sa', ceiling: 'member' as const }
const next = (a: AuthContext, facts: Partial<WhoamiFacts> = {}, expectedAgent?: string, env: Env = ENV): OnboardingNext =>
  buildWhoami(env, a, { facts: { ...FACTS, ...facts }, origin: ORIGIN, ...(expectedAgent !== undefined ? { expectedAgent } : {}) }).onboarding_next

describe('onboarding_next: one legal step per case', () => {
  it('existing OAuth person with no agent: owner/self step, never a seat tool, never a second agent when one was bootstrapped', () => {
    const fresh = next(authOf({ capabilities: [{ scope_type: 'org', scope_id: null, capability: 'admin' }] as AuthContext['capabilities'] }), { tenantHasAgents: false })
    expect(fresh).toMatchObject({ case: 'existing_oauth', who_acts: 'self', next_tool: 'bootstrap_self' })
    const again = next(authOf({}), { bootstrappedBefore: true, tenantHasAgents: false })
    expect(again.case).toBe('existing_oauth')
    expect(again.next_tool).toBeUndefined() // already bootstrapped: no duplicate agent offered
    expect(again.who_acts).toBe('owner')
    expect(again.link).toBe(`${ORIGIN}/mcp`)
  })

  it('stranger in a populated pot is not offered the identity mint', () => {
    expect(next(authOf({}))).toMatchObject({ case: 'existing_oauth', who_acts: 'owner' })
    expect(next(authOf({})).next_tool).toBeUndefined()
  })

  it('workspace bearer bound to an agent: read own work, no seat tools', () => {
    const n = next(authOf({ channel: 'workspace', boundAgentId: 'ag' }))
    expect(n).toMatchObject({ case: 'workspace_bearer', who_acts: 'self', next_tool: 'needs_you_list' })
    expect(n.next_step).toContain('do not apply')
  })

  it('own chat (seat, not attached): seat_attach when attach is on; never seat_select; held chat is read-only', () => {
    expect(next(authOf({ boundAgentId: 'sa', seatBinding: SEAT }))).toMatchObject({ case: 'own_chat', who_acts: 'self', next_tool: 'seat_attach' })
    const off = next(authOf({ boundAgentId: 'sa', seatBinding: SEAT }), {}, undefined, { ...ENV, SEAT_ATTACH: undefined } as unknown as Env)
    expect(off).toMatchObject({ case: 'own_chat', next_tool: 'needs_you_list' })
    const held = next(authOf({ boundAgentId: 'sa', seatBinding: SEAT, seatAgentStatus: 'held' }))
    expect(held).toMatchObject({ case: 'own_chat', next_tool: 'needs_you_list' })
  })

  it('attached chat: peek the inbox only; never attach/select again; non-routable', () => {
    const n = next(authOf({ boundAgentId: 'ag', seatBinding: { ...SEAT, attached: ATTACHED } }), { actsAs: 'athena' })
    expect(n).toMatchObject({ case: 'attached_chat', who_acts: 'self', next_tool: 'inbox' })
    expect(n.next_step).toContain('peek')
    expect(n.next_step).toMatch(/cannot ack or lease/)
    expect(n.next_tool).not.toBe('seat_attach')
  })

  it('wrong expected principal: owner step with a reconnect link, no tool, overrides the state step', () => {
    const own = next(authOf({ boundAgentId: 'sa', seatBinding: SEAT }), { actsAs: 'seat-abc' }, 'rava')
    expect(own).toMatchObject({ case: 'wrong_expected_principal', who_acts: 'owner' })
    expect(own.next_tool).toBeUndefined()
    expect(own.next_step).toContain('rava')
    expect(own.link).toBe(`${ORIGIN}/mcp`)
    // the expected principal matched (by slug, case-insensitive, or by bound id): the ordinary step stands
    expect(next(authOf({ boundAgentId: 'sa', seatBinding: SEAT }), { actsAs: 'Rava' }, 'rava').case).toBe('own_chat')
    expect(next(authOf({ channel: 'workspace', boundAgentId: 'ag-1' }), {}, 'ag-1').case).toBe('workspace_bearer')
    // unbound caller with an expectation is also wrong, and still never offered a mint
    const unbound = next(authOf({ capabilities: [{ scope_type: 'org', scope_id: null, capability: 'admin' }] as AuthContext['capabilities'] }), { tenantHasAgents: false }, 'rava')
    expect(unbound.case).toBe('wrong_expected_principal')
    expect(unbound.next_tool).toBeUndefined()
  })

  it('revoked consent: owner re-consents; no bootstrap, no seat tool', () => {
    const n = next(authOf({ boundAgentId: null, consentedByMemberId: 'mem-human' }), { tenantHasAgents: false })
    expect(n).toMatchObject({ case: 'revoked_consent', who_acts: 'owner', link: `${ORIGIN}/mcp` })
    expect(n.next_tool).toBeUndefined()
  })

  it('unseated harness: seat_select is the one step; still exactly one object with a case', () => {
    expect(next(authOf({ harnessId: 'h-1' }))).toMatchObject({ case: 'harness_unseated', next_tool: 'seat_select' })
  })

  it('is read-only: building it twice gives the same answer and takes no db', () => {
    const a = authOf({ boundAgentId: 'sa', seatBinding: SEAT })
    expect(next(a)).toEqual(next(a))
  })
})
