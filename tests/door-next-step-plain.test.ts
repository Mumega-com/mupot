// A plain next step per door state, and tool descriptions that say who they are for (agents must not need to research seat_select vs seat_attach).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildWhoami, AGENT_DOOR_DOCS_URL, type WhoamiFacts } from '../src/mcp/whoami'
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

  it('unseated harness chat: seat_select first, then seat_attach; seats off says so', () => {
    const w = run(authOf({ harnessId: 'h-1' }))
    expect(w.state).toBe('harness_unseated')
    expect(w.next_step_plain).toContain('seat_select {project, folder, thread}')
    expect(w.next_step_plain).toContain('seat_attach {agent}')
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
    expect(doc).not.toMatch(/@|\/home\/|mumega-state/)
  })
})
