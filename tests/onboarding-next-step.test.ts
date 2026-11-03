// tests/onboarding-next-step.test.ts — mupot task 13f6b7e8: ONE typed legal next step from the shared whoami
// derivation, for the six onboarding cases. Pure (buildWhoami is pure; no seat, agent or token is created here).

import { describe, expect, it } from 'vitest'
import { attachConnectOrder, buildWhoami, type OnboardingNext, type WhoamiFacts } from '../src/mcp/whoami'
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
    // a bare actsAs label is no longer a key: only an exact id, or a slug/name resolving to exactly the caller, matches
    expect(next(authOf({ boundAgentId: 'sa', seatBinding: SEAT }), { actsAs: 'Rava' }, 'rava').case).toBe('wrong_expected_principal')
    expect(next(authOf({ boundAgentId: 'sa', seatBinding: SEAT }), { actsAs: 'Rava' }, 'sa').case).toBe('own_chat')
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

  it('own chat with designation required: the step is the designate step (same sentence as plainNextStep), never seat_attach', () => {
    const env = { ...ENV, SEAT_ATTACH_DESIGNATED: '1' } as unknown as Env
    const a = authOf({ boundAgentId: 'sa', seatBinding: SEAT })
    const owner = next(a, {}, undefined, env)
    expect(owner).toMatchObject({ case: 'own_chat', who_acts: 'owner' })
    expect(owner.next_tool).toBeUndefined()
    expect(owner.next_step).toContain('Allow for me')
    const admin = next(a, { humanCanDesignate: false }, undefined, env)
    expect(admin).toMatchObject({ case: 'own_chat', who_acts: 'org_admin' })
    expect(admin.next_tool).toBeUndefined()
    expect(admin.next_step).toContain('attach_designated_member_id')
    const plain = buildWhoami(env, a, { facts: { ...FACTS, humanCanDesignate: false }, origin: ORIGIN }).next_step_plain
    expect(plain).toContain(admin.next_step)
  })

  it('harness_unseated names seat_select only when seats are callable (seat enrolment on)', () => {
    const off = { ...ENV, SEAT_AUTO_ENROLL: undefined } as unknown as Env
    // a harness credential is harness_unseated whatever the flag; with enrolment off the handle-rejected step must not name seat_select
    const a = authOf({ harnessCredential: true, seatInputs: { handleRejected: true, hints: { openai_session: false, openai_subject: false, codex_thread_id: false } } as AuthContext['seatInputs'] })
    expect(next(a, {}, undefined, ENV).next_tool).toBe('seat_select')
    const n = next(a, {}, undefined, off)
    expect(n.case).toBe('harness_unseated')
    expect(n.next_tool).toBeUndefined()
  })

  it('wrong expected principal: echoed string is capped at 64 chars, control characters stripped, surrounding space trimmed', () => {
    const a = authOf({ boundAgentId: 'sa', seatBinding: SEAT })
    const long = next(a, { actsAs: 'x' }, 'A'.repeat(200))
    expect(long.next_step).toContain('A'.repeat(64))
    expect(long.next_step).not.toContain('A'.repeat(65))
    const ctl = next(a, { actsAs: 'x' }, 'ra\u0000v\na\u001b[31m')
    expect(ctl.next_step).toContain('rav a'.replace(' ', '') + '[31m')
    // eslint-disable-next-line no-control-regex -- asserting none survive
    expect(ctl.next_step).not.toMatch(/[\u0000-\u001f\u007f]/)
    // trim: a padded exact id of the true principal still matches
    expect(next(a, { actsAs: 'rava' }, '   sa  ').case).toBe('own_chat')
  })

  it('OAuth connection consented to an agent (legacy_consent) is labelled existing_oauth, not workspace_bearer', () => {
    expect(next(authOf({ boundAgentId: 'ag', consentedByMemberId: 'mem-human' }))).toMatchObject({ case: 'existing_oauth', next_tool: 'needs_you_list' })
  })
})

const DIR = [
  { id: 'ag-1', slug: 'rava', name: 'Rava Prime' },
  { id: 'ag-2', slug: 'athena', name: 'Athena' },
  { id: 'ag-3', slug: 'rava', name: 'Impostor' }, // same slug, other squad
  { id: 'ag-k', slug: 'kasra', name: 'Kasra' },
  { id: 'ag-fw', slug: 'fw', name: '\uFF41thena' }, // fullwidth a: only NFKC folds it onto athena
  { id: 'ag-k2', slug: 'k2', name: '\u212Aasra' }, // Kelvin sign
]
const ws = (id: string): AuthContext => authOf({ channel: 'workspace', boundAgentId: id })

describe('onboarding_next: expected principal and precedence (#2289)', () => {
  it('id matches exactly and first; startsWith/prefix of an id does not', () => {
    expect(next(ws('ag-1'), { agentDirectory: DIR }, 'ag-1').case).toBe('workspace_bearer')
    expect(next(ws('ag-1'), { agentDirectory: DIR }, 'ag').case).toBe('wrong_expected_principal')
    expect(next(ws('ag-1'), {}, 'ag-1').case).toBe('workspace_bearer') // no directory read needed for an id
  })

  it('a slug or name counts only when it resolves to exactly one active agent AND that agent is the caller', () => {
    expect(next(ws('ag-1'), { agentDirectory: DIR }, 'Rava Prime').case).toBe('workspace_bearer')
    expect(next(ws('ag-1'), { agentDirectory: DIR }, 'Rava Prime').case).toBe('workspace_bearer') // unique name
    const amb = next(ws('ag-1'), { agentDirectory: DIR }, 'rava') // slug shared by two agents: even the real owner is asked for the id
    expect(amb).toMatchObject({ case: 'wrong_expected_principal', who_acts: 'self', next_tool: 'boot_context' })
    expect(amb.next_step).toContain('agent id')
    expect(next(ws('ag-3'), { agentDirectory: DIR }, 'athena').case).toBe('wrong_expected_principal') // someone else's slug
    expect(next(ws('ag-3'), { agentDirectory: DIR }, 'Impostor').case).toBe('workspace_bearer') // unique name of the caller
    expect(next(ws('ag-1'), {}, 'rava').case).toBe('wrong_expected_principal') // unknown directory fails closed
  })

  it('NFKC fold: the Kelvin sign collides with K, so the name is ambiguous, not silently matched', () => {
    expect(next(ws('ag-2'), { agentDirectory: DIR }, 'athena').case).toBe('wrong_expected_principal') // fullwidth look-alike collides under NFKC
    expect(next(ws('ag-k2'), { agentDirectory: DIR }, 'kasra').case).toBe('wrong_expected_principal')
    expect(next(ws('ag-k'), { agentDirectory: DIR }, 'kasra').case).toBe('wrong_expected_principal')
    expect(next(ws('ag-k'), { agentDirectory: DIR }, 'ag-k').case).toBe('workspace_bearer')
  })

  it('strips line/paragraph separators, NEL, C1 and bidi controls from the echo', () => {
    const n = next(ws('ag-1'), { agentDirectory: DIR }, 'ev\u2028i\u0085l\u202e\u2066x')
    expect(n.next_step).toContain('evilx')
    expect(n.next_step).not.toMatch(/[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/)
  })

  it('own chat expecting another existing agent: seat_attach step (reuses attachConnectOrder); designation required: no tool; attach off: reconnect', () => {
    const chat = authOf({ boundAgentId: 'sa', seatBinding: SEAT })
    const n = next(chat, { agentDirectory: DIR }, 'ag-2')
    expect(n).toMatchObject({ case: 'wrong_expected_principal', who_acts: 'self', next_tool: 'seat_attach' })
    expect(n.next_step).toContain(attachConnectOrder(ENV))
    const des = { ...ENV, SEAT_ATTACH_DESIGNATED: '1' } as unknown as Env
    const d = next(chat, { agentDirectory: DIR, humanCanDesignate: true }, 'ag-2', des)
    expect(d.next_tool).toBeUndefined()
    expect(d.next_step).toContain('Allow for me')
    const off = { ...ENV, SEAT_ATTACH: '0' } as unknown as Env
    const o = next(chat, { agentDirectory: DIR }, 'ag-2', off)
    expect(o.next_tool).toBeUndefined()
    expect(o.next_step).toContain('reconnects the connector')
    // a name that is not an existing agent never offers attach
    expect(next(chat, { agentDirectory: DIR }, 'nobody').next_tool).toBeUndefined()
    // unseated harness: seat_select FIRST (seat_attach needs a seat), then the attach order
    const h = next(authOf({ harnessId: 'h-1' }), { agentDirectory: DIR }, 'ag-2')
    expect(h).toMatchObject({ who_acts: 'self', next_tool: 'seat_select' })
    expect(h.next_step).toContain(attachConnectOrder(ENV))
    expect(h.next_step.indexOf('seat_select')).toBeLessThan(h.next_step.indexOf('seat_attach'))
  })

  it('truncated directory: a name is ambiguous, an exact id still matches', () => {
    expect(next(ws('ag-2'), { agentDirectory: DIR, agentDirectoryTruncated: true }, 'Athena Zed').case).toBe('wrong_expected_principal')
    expect(next(ws('ag-1'), { agentDirectory: DIR, agentDirectoryTruncated: true }, 'Rava Prime')).toMatchObject({ case: 'wrong_expected_principal', next_tool: 'boot_context' })
    expect(next(ws('ag-1'), { agentDirectory: DIR, agentDirectoryTruncated: true }, 'ag-1').case).toBe('workspace_bearer')
  })

  it('lapsed consent outranks an unseated harness (intended: re-consent repairs the binding the seat depends on)', () => {
    const n = next(authOf({ boundAgentId: null, consentedByMemberId: 'mem-human', harnessId: 'h-1' }))
    expect(n.case).toBe('revoked_consent')
    expect(n.next_tool).toBeUndefined()
  })

  it('a wrong expectation outranks lapsed consent', () => {
    expect(next(authOf({ boundAgentId: null, consentedByMemberId: 'mem-human' }), {}, 'rava').case).toBe('wrong_expected_principal')
  })
})
