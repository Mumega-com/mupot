// A plain next step per door state, and tool descriptions that say who they are for (agents must not need to research seat_select vs seat_attach).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { attachConnectOrder, buildWhoami, seatAttachDoor, AGENT_DOOR_DOCS_URL, type WhoamiFacts } from '../src/mcp/whoami'
import { advertisedTools } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'acme'
const ENV = { SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test' } as unknown as Env
const FACTS: WhoamiFacts = { keyed: false, fenced: false, bootstrappedBefore: false, tenantHasAgents: true, actsAs: 'rava' }
const authOf = (p: Partial<AuthContext>): AuthContext => ({ userId: 'u', role: 'member', tenant: TENANT, channel: 'directory', memberId: 'mem-x', capabilities: [], ...p }) as AuthContext // builder reads only the fields named per case
const SEAT = { seatId: 'seat-1', label: 'chat', harnessId: 'h-1', grantTokenId: 'g-1', humanMemberId: 'mem-x', source: 'auto:openai_session' as const }
const run = (a: AuthContext, facts: Partial<WhoamiFacts> = {}, env: Env = ENV) => buildWhoami(env, a, { facts: { ...FACTS, ...facts }, origin: 'https://pot.test' })

describe('whoami.next_step_plain: one sentence per state', () => {
  it('attached: names the agent, the ceiling, says nothing to set up, no handle, never seat tools; points at inbox peek', () => {
    const w = run(authOf({ boundAgentId: 'ag', seatBinding: { ...SEAT, attached: { attachmentId: 'a', admissionId: 'adm', agentId: 'ag', seatAgentId: 'sa', ceiling: 'full' } } }))
    expect(w.next_step_plain).toContain('You are rava')
    expect(w.next_step_plain).toContain('ceiling full')
    expect(w.next_step_plain).toContain('no seat handle needed')
    expect(w.next_step_plain).toContain('never call seat_select or seat_attach')
    expect(w.next_step_plain).toContain('inbox {peek:true}')
  })

  it('own seat (auto): says no handle needed, offers seat_attach, forbids seat_select; a handle seat says keep sending it', () => {
    const auto = run(authOf({ boundAgentId: 'sa', seatBinding: SEAT }))
    expect(auto.state).toBe('own_seat')
    expect(auto.next_step_plain).toContain('no seat handle is needed')
    expect(auto.next_step_plain).toContain('seat_attach {agent}')
    expect(auto.next_step_plain).toContain('do not call seat_select')
    const handle = run(authOf({ boundAgentId: 'sa', seatBinding: { ...SEAT, source: 'handle' } }))
    expect(handle.next_step_plain).toContain('Keep sending your seat handle')
    const noAttach = run(authOf({ boundAgentId: 'sa', seatBinding: SEAT }), {}, { ...ENV, SEAT_ATTACH: undefined } as unknown as Env)
    expect(noAttach.next_step_plain).not.toContain('seat_attach {agent}')
  })

  it('attached: a HANDLE-keyed seat keeps passing its handle; an OAuth/auto seat needs none', () => {
    const att = { attachmentId: 'a', admissionId: 'adm', agentId: 'ag', seatAgentId: 'sa', ceiling: 'member' as const }
    const handle = run(authOf({ boundAgentId: 'ag', seatBinding: { ...SEAT, source: 'handle', attached: att } }))
    expect(handle.state).toBe('acting_as')
    expect(handle.next_step_plain).toContain('keep passing your seat handle')
    expect(handle.next_step_plain).not.toContain('no seat handle needed')
    expect(handle.next_step_plain).toContain('never call seat_select or seat_attach')
    for (const source of ['auto:openai_session', 'auto:codex_thread'] as const) {
      const auto = run(authOf({ boundAgentId: 'ag', seatBinding: { ...SEAT, source, attached: att } }))
      expect(auto.next_step_plain).toContain('no seat handle needed')
      expect(auto.next_step_plain).not.toContain('keep passing')
    }
  })

  it('own seat held / observed: seat_attach is NOT suggested (the floor refuses it) and the sentence says what they can do', () => {
    for (const status of ['held', 'observed'] as const) {
      const w = run(authOf({ boundAgentId: 'sa', seatBinding: SEAT, seatAgentStatus: status }))
      expect(w.state).toBe('own_seat')
      expect(w.next_step_plain).toContain(`This seat is ${status}`)
      expect(w.next_step_plain).toContain('inbox {peek:true}')
      expect(w.next_step_plain).toContain('ask your human to lift')
      expect(w.next_step_plain).not.toContain('seat_attach {agent}')
    }
    const trusted = run(authOf({ boundAgentId: 'sa', seatBinding: SEAT, seatAgentStatus: 'trusted' }))
    expect(trusted.next_step_plain).toContain('seat_attach {agent}')
  })

  it('unseated harness chat: seat_select first, then seat_attach; seats off says so', () => {
    const w = run(authOf({ harnessId: 'h-1' }))
    expect(w.state).toBe('harness_unseated')
    expect(w.next_step_plain).toContain('seat_select {project, folder, thread}')
    expect(w.next_step_plain).toContain('seat_attach {agent}')
    const attachOff = run(authOf({ harnessId: 'h-1' }), {}, { ...ENV, SEAT_ATTACH: undefined } as unknown as Env)
    expect(attachOff.state).toBe('harness_unseated')
    expect(attachOff.next_step_plain).toContain('seat_select {project, folder, thread}')
    expect(attachOff.next_step_plain).not.toContain('seat_attach {agent}')
    const off = run(authOf({ harnessId: 'h-1' }), {}, { ...ENV, SEAT_AUTO_ENROLL: undefined } as unknown as Env)
    expect(off.state).toBe('no_agent') // seats off: seat_select is not offered
    expect(off.next_step_plain).not.toContain('seat_select {project')
  })

  it('workspace agent and legacy consent: seat tools do not apply', () => {
    const host = run(authOf({ channel: 'workspace', boundAgentId: 'ag' }))
    expect(host.state).toBe('host')
    expect(host.next_step_plain).toContain('seat tools (seat_select, seat_attach) do not apply')
    const consent = run(authOf({ boundAgentId: 'ag', consentedByMemberId: 'mem-human' }))
    expect(consent.next_step_plain).toContain('do not apply')
  })

  it('no agent: points at the first missing step; every state links the one-page door doc', () => {
    const w = run(authOf({ channel: 'workspace', boundAgentId: null }))
    expect(w.state).toBe('no_agent')
    expect(w.next_step_plain).toMatch(/^You have no agent yet\./)
    for (const a of [authOf({ channel: 'workspace', boundAgentId: 'ag' }), authOf({ harnessId: 'h-1' })]) expect(run(a).docs).toBe(AGENT_DOOR_DOCS_URL)
  })
})

describe('designation step follows SEAT_ATTACH_DESIGNATED (#2178)', () => {
  const designated = { ...ENV, SEAT_ATTACH_DESIGNATED: '1' } as unknown as Env
  const loose = { ...ENV, SEAT_ATTACH_DESIGNATED: 'true' } as unknown as Env
  const attachOff = { ...ENV, SEAT_ATTACH: undefined, SEAT_ATTACH_DESIGNATED: '1' } as unknown as Env
  const ownSeat = authOf({ boundAgentId: 'sa', seatBinding: SEAT })
  const unseated = authOf({ harnessId: 'h-1' })
  const ORDER_OFF = "Call seat_attach {agent}: it returns pending_admission and an attach code; your human admits that code on /connections; call seat_attach again and it returns attached. boot_context then shows acts_as. An attached connection peeks the inbox with inbox {peek:true} and records what it handled with inbox_mark_handled; it cannot ack or lease."
  const ORDER_ON = "Before seat_attach, your human opens that agent's page and presses 'Allow for me' (the box 'Allow my chats to become this agent'); seat_attach before that returns 409 agent_not_designated_for_you. Then call " + ORDER_OFF.slice('Call '.length)
  const DOOR_TAIL = "seat_attach {agent}: pending_admission; your human approves once with their passkey (an approve_url, or they admit the attach code on /connections), then call seat_attach again and your NEXT request acts as that agent. The attached connection peeks the inbox (inbox_mark_handled) and cannot ack or lease."

  it('attach + auto-enroll on, designated off: connect order and the seat_attach door omit Allow for me', () => {
    expect(attachConnectOrder(ENV)).toBe(ORDER_OFF)
    expect(attachConnectOrder(loose)).toBe(ORDER_OFF) // strict '1'; 'true' is off
    expect(seatAttachDoor(ENV)).toEqual({
      does: 'act as an agent you already have. Call ' + DOOR_TAIL,
      requires: 'the agent must be one your human administers; nothing is attached until they tap',
    })
    for (const auth of [ownSeat, unseated]) {
      const plain = run(auth).next_step_plain
      expect(plain).toContain(ORDER_OFF)
      expect(plain).not.toContain('Allow for me')
      expect(plain).not.toContain('agent_not_designated_for_you')
    }
  })

  it('attach + auto-enroll + designated on: both texts name Allow for me and the 409', () => {
    expect(attachConnectOrder(designated)).toBe(ORDER_ON)
    expect(seatAttachDoor(designated)).toEqual({
      does: "act as an agent you already have. First your human presses 'Allow for me' on that agent's page (otherwise seat_attach returns 409 agent_not_designated_for_you). Then call " + DOOR_TAIL,
      requires: "the agent must be one your human administers, and they must have pressed Allow for me; nothing is attached until they tap",
    })
    for (const auth of [ownSeat, unseated]) {
      const plain = run(auth, {}, designated).next_step_plain
      expect(plain).toContain(ORDER_ON)
      expect(plain).toContain("presses 'Allow for me'")
      expect(plain).toContain('agent_not_designated_for_you')
    }
  })

  it('attach off: the connect order is not offered, even when SEAT_ATTACH_DESIGNATED is set', () => {
    expect(attachConnectOrder(attachOff)).toBe(ORDER_OFF)
    expect(seatAttachDoor(attachOff).does).not.toContain('Allow for me')
    for (const auth of [ownSeat, unseated]) {
      const plain = run(auth, {}, attachOff).next_step_plain
      expect(plain).not.toContain('seat_attach {agent}')
      expect(plain).not.toContain('Allow for me')
      expect(plain).not.toContain('agent_not_designated_for_you')
    }
  })
})

describe('tool descriptions: the FIRST line says who the tool is for and when not to call it', () => {
  const tools = advertisedTools({ SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', VIP_LANE: '1' } as unknown as Env)
  const firstLine = (name: string): string => tools.find((t) => t.name === name)?.scope ?? ''
  it('seat_select / seat_attach / connect', () => {
    expect(firstLine('seat_select')).toMatch(/^Only for a chat with no agent yet/)
    expect(firstLine('seat_select')).toContain('Never call it from an attached chat')
    expect(firstLine('seat_attach')).toMatch(/^Only for a chat on its own seat/)
    expect(firstLine('seat_attach')).toContain('Never call it from a workspace-token agent')
    expect(firstLine('connect')).toMatch(/^Only for a signed-in member session/)
    expect(firstLine('connect')).toContain('Not for seat or attached chats')
  })
})

describe('docs/agent-door.md', () => {
  const doc = readFileSync(new URL('../docs/agent-door.md', import.meta.url), 'utf8')
  it('is at most 40 lines, covers every whoami state, cites PRs and no private paths', () => {
    expect(doc.split('\n').length).toBeLessThanOrEqual(40)
    for (const s of ['acting_as', 'own_seat', 'harness_unseated', 'host', 'no_agent']) expect(doc).toContain(s)
    expect(doc).toMatch(/#2054/)
    expect(doc).not.toContain('Do NOT send a seat handle')
    expect(doc).toContain('a handle-keyed seat keeps passing its handle')
    expect(doc).not.toMatch(/@|\/home\/|mumega-state/)
  })
})
