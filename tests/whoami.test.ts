// tests/whoami.test.ts — the whoami block (lane A of the onboarding-door build, mupot task 7e0cb92d).
//
// Two layers, because the claim is two claims:
//   1. REAL HANDLER (mcpApp -> resolveAuth -> resolveSeatSession -> tool, real sqlite D1, real consent): for every state a
//      cold client can actually reach, whoami.state and the EXACT missing[] list; every missing[].next_tool is in tools/list
//      and calling it is NOT refused; next_step / available_doors / channel_limits derive from whoami (they cannot
//      disagree with it); status and orient carry the same block.
//   2. PURE buildWhoami over synthetic auth, for the states the prod flags make unreachable from a cold client (attached,
//      legacy consent, silent downgrades, a fenced inbox) and for the stranger rule (#2020).
// Written so the #2021 oracle stubs fail it: whoami with empty missing; missing[] pointing at boot_context/status; and
// deleting channel_limits.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { call, hermesClient, listTools, newWorld, oauthClient, HARNESS_CHOICE, NOW, TENANT, rpc, type Client, type Json, type World } from './helpers/door-clients'
import { hashMemberToken } from '../src/auth/member-bearer'
import { mintHarnessToken } from '../src/members/harness-token'
import { buildWhoami, bootstrapOffered, type Whoami, type WhoamiFacts } from '../src/mcp/whoami'
import { mcpEndpoint } from '../src/dashboard/connect'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

afterEach(() => { vi.unstubAllGlobals() })

const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : [])
const whoamiOf = (b: Json): Whoami => b.whoami as Whoami // the block under test, read off a tool result
const ARGS: Record<string, Json> = { seat_select: { project: 'whoami-test' }, bootstrap_self: { agent_name: 'whoami-agent' } }

/** Every advertised next_tool is in tools/list and is not refused when called with its advertised args. */
async function expectStepsCallable(w: World, c: Client, missing: Whoami['missing']): Promise<void> {
  const tools = await listTools(w, c)
  for (const m of missing) {
    if (m.next_tool === undefined) continue
    expect(tools.has(m.next_tool), `${m.code}: ${m.next_tool} is in tools/list`).toBe(true)
    if (m.code === 'report_runtime') continue // proven separately: it must change registry.outcome
    const r = await call(w, c, m.next_tool, ARGS[m.next_tool] ?? {})
    expect(r.refused, `${m.code}: ${m.next_tool} was refused: ${JSON.stringify(r.body)}`).toBe(false)
  }
}

/** Bearer-only workspace agent without a signing key (K1 unkeyed host). */
async function plainHostClient(w: World): Promise<Client> {
  w.h.sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-plain', 'sq0', 'plain', 'Plain', 'active');
    INSERT INTO members (id, display_name, status, created_at, tenant) VALUES ('mem-plain', 'Plain', 'active', '${NOW}', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'ag-plain', 'mem-plain', '${NOW}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-plain', 'mem-plain', 'squad', 'sq0', 'member');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, created_at, tenant)
      VALUES ('tok-plain', 'mem-plain', '${await hashMemberToken('raw-plain-token')}', 'plain', 'workspace', 'ag-plain', '${NOW}', '${TENANT}');
  `)
  return { kind: 'hermes', props: null, bearer: 'raw-plain-token' }
}

/** K2: a workspace member token with no agent binding. */
async function memberTokenClient(w: World): Promise<Client> {
  w.h.sqlite.exec(`
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('mem-k2', 'k2@pot.test', 'K2', 'active', '${NOW}', '${TENANT}');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, created_at, tenant)
      VALUES ('tok-k2', 'mem-k2', '${await hashMemberToken('raw-k2-token')}', 'k2', 'workspace', NULL, '${NOW}', '${TENANT}');
  `)
  return { kind: 'unknown', props: null, bearer: 'raw-k2-token' }
}

/** K5: a harness token (zero standing, three tools until it has a seat). */
async function harnessTokenClient(w: World): Promise<Client> {
  w.h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('mem-k5', 'k5@pot.test', 'K5', 'active', '${NOW}', '${TENANT}');`)
  const minted = await mintHarnessToken(w.env, { memberId: 'mem-k5', kind: 'ci', label: 'whoami ci', expiresAt: null })
  return { kind: 'unknown', props: null, bearer: minted.token.raw }
}

const originOf = (w: World): string => String(w.env.PUBLIC_ORIGIN)

describe('real handler: each reachable state', () => {
  it('K3 stranger (plain consent, populated pot): no_agent, ONE human step with a link, bootstrap_self never named (#2020)', async () => {
    const w = newWorld()
    try {
      const c = await oauthClient(w, 'unknown', 'Some New Harness', '')
      const boot = (await call(w, c, 'boot_context')).body
      const wh = whoamiOf(boot)
      expect(wh.state).toBe('no_agent')
      expect(wh.harness).toBe('absent')
      expect(wh.have).toEqual(['member'])
      expect(wh.missing).toEqual([{
        code: 'no_agent',
        who_acts: 'owner',
        next_step: expect.stringContaining('"Me (auto)"'), // the label prod's consent screen shows with SEAT_ATTACH off
        link: mcpEndpoint(originOf(w)),
      }])
      expect(wh.missing[0].next_step).toContain('"Existing agent"')
      // the stranger is shown the mint nowhere: not whoami, not doors, not next_step, not channel_limits
      expect(JSON.stringify(boot)).not.toContain('bootstrap_self')
      expect(boot.next_step).toBe(wh.missing[0].next_step) // derived, not a second opinion
      expect(obj(boot.onboarding).next_step).toBe(wh.missing[0].next_step)
      expect(String(obj(boot.channel_limits).to_get_write_access)).toContain(wh.missing[0].next_step)
      expect(arr(boot.available_doors).map((d) => d.tool)).toEqual(['status', 'boot_context']) // connect is not a door for a caller handed no slug (#2031)
      // and the refusal side agrees: the tool still refuses nobody the advert hides (it is not the gate), so state the contract
      expect(wh.missing.every((m) => m.next_tool === undefined)).toBe(true) // owner step: no tool for THIS caller
    } finally { w.h.close() }
  })

  it('K3 in an empty pot: the first member is offered bootstrap_self, and running it is not refused', async () => {
    const w = newWorld()
    try {
      w.h.sqlite.exec('DELETE FROM agents')
      const c = await oauthClient(w, 'unknown', 'Some New Harness', '')
      const boot = (await call(w, c, 'boot_context')).body
      const wh = whoamiOf(boot)
      expect(wh.state).toBe('no_agent')
      expect(wh.missing.map((m) => [m.code, m.who_acts, m.next_tool])).toEqual([['no_agent', 'self', 'bootstrap_self']])
      expect(boot.next_step).toBe(wh.missing[0].next_step)
      expect(arr(boot.available_doors)[0].tool).toBe('bootstrap_self')
      await expectStepsCallable(w, c, wh.missing)
      // once bootstrapped it is never offered again (the tool's own already_bootstrapped predicate)
      const again = whoamiOf((await call(w, c, 'boot_context')).body)
      expect(again.missing.map((m) => m.next_tool)).not.toContain('bootstrap_self')
    } finally { w.h.close() }
  })

  it('K4 harness grant, no seat yet: harness_unseated, exactly [seat_select], derived next_step/doors/limits, step callable', async () => {
    const w = newWorld()
    try {
      const c = await oauthClient(w, 'claude', 'Claude', HARNESS_CHOICE)
      const boot = (await call(w, c, 'boot_context')).body
      const wh = whoamiOf(boot)
      expect(wh.state).toBe('harness_unseated')
      expect(wh.harness).toBe('present')
      expect(wh.have).toEqual(['member', 'harness'])
      expect(wh.missing.map((m) => [m.code, m.who_acts, m.next_tool])).toEqual([['seat_required', 'self', 'seat_select']])
      expect(boot.next_step).toBe(wh.missing[0].next_step)
      expect(obj(boot.onboarding).next_step).toBe(wh.missing[0].next_step)
      expect(String(obj(boot.channel_limits).to_get_write_access)).toContain('seat_select')
      expect(String(obj(boot.channel_limits).to_get_write_access)).not.toContain('bootstrap_self')
      expect(arr(boot.available_doors)[0].tool).toBe('seat_select')
      expect(arr(boot.available_doors).map((d) => d.tool)).not.toContain('bootstrap_self')
      await expectStepsCallable(w, c, wh.missing)
    } finally { w.h.close() }
  })

  it('K5 harness token: harness_unseated; doors are exactly the allowlist (dead end 1); limits name no refused tool', async () => {
    const w = newWorld()
    try {
      const c = await harnessTokenClient(w)
      const boot = (await call(w, c, 'boot_context')).body
      const wh = whoamiOf(boot)
      expect(wh.state).toBe('harness_unseated')
      expect(wh.missing.map((m) => [m.code, m.next_tool])).toEqual([['seat_required', 'seat_select']])
      const doors = arr(boot.available_doors).map((d) => d.tool)
      expect(doors).toEqual(['seat_select', 'boot_context']) // status/connect/bootstrap_self are refused for a harness token
      const limits = obj(boot.channel_limits)
      expect(JSON.stringify(limits.you_can)).toContain('seat_select')
      expect(JSON.stringify(limits.you_can)).not.toMatch(/\b(connect|remember|recall|orient)\b/)
      expect(String(limits.to_get_write_access)).not.toContain('bootstrap_self')
      expect(obj(boot.onboarding).next_step).toBe(wh.missing[0].next_step)
      await expectStepsCallable(w, c, wh.missing)
    } finally { w.h.close() }
  })

  it('K6 own seat (ChatGPT auto seat): own_seat, missing is EMPTY, seat names the agent but never its id, no runtime nag', async () => {
    const w = newWorld()
    try {
      const c = await oauthClient(w, 'chatgpt', 'ChatGPT', HARNESS_CHOICE, { 'openai/session': 'conv-whoami-1' })
      const boot = (await call(w, c, 'boot_context')).body
      const wh = whoamiOf(boot)
      expect(wh.state).toBe('own_seat')
      expect(wh.missing).toEqual([])
      expect(wh.have).toEqual(expect.arrayContaining(['member', 'harness', 'seat', 'agent']))
      expect(wh.seat).toMatchObject({ presented: false })
      expect(typeof wh.seat?.acts_as).toBe('string')
      expect(JSON.stringify(wh)).not.toContain(String(boot.bound_agent_id)) // whoami never exposes agent_id
      expect(obj(boot.onboarding).next_step).toBeUndefined() // dead end cut: no runtime/model/host nag for kind seat
      expect(String(obj(boot.channel_limits).to_get_write_access)).not.toContain('bootstrap_self') // dead end 4
      expect(arr(boot.available_doors)[0].tool).toBe('orient')
      // status and orient carry the same block
      expect(whoamiOf((await call(w, c, 'status')).body).state).toBe('own_seat')
      expect(whoamiOf((await call(w, c, 'orient')).body).state).toBe('own_seat')
    } finally { w.h.close() }
  })

  it('K1 keyed host: host, missing is EMPTY, keyed is a plain fact', async () => {
    const w = newWorld()
    try {
      const c = await hermesClient(w)
      const wh = whoamiOf((await call(w, c, 'boot_context')).body)
      expect(wh.state).toBe('host')
      expect(wh.missing).toEqual([])
      expect(wh.have).toEqual(expect.arrayContaining(['member', 'agent', 'keyed', 'inbox:consume']))
      expect(wh.agent).toEqual({ keyed: true, inbox: 'consume', can_self_report: false })
      expect(wh.seat).toBeUndefined()
    } finally { w.h.close() }
  })

  it('K1 unkeyed host: the one missing step is report_runtime, and following it CHANGES registry.outcome', async () => {
    const w = newWorld()
    try {
      const c = await plainHostClient(w)
      const first = (await call(w, c, 'boot_context')).body
      const wh = whoamiOf(first)
      expect(wh.state).toBe('host')
      expect(wh.missing.map((m) => [m.code, m.who_acts, m.next_tool])).toEqual([['report_runtime', 'self', 'boot_context']])
      expect(obj(first.registry).outcome).toBe('nothing_reported')
      expect(first.next_step).toContain('orient') // the top next_step is not the telemetry nag
      expect(obj(first.onboarding).next_step).toBe(wh.missing[0].next_step)
      // the ONLY step allowed to point at boot_context/status — and it must really move the registry
      const second = (await call(w, c, 'boot_context', { runtime: 'whoami-cli', model: 'whoami-model', host: 'whoami-host' })).body
      expect(obj(second.registry).outcome).toBe('recorded')
      expect(whoamiOf(second).missing).toEqual([])
    } finally { w.h.close() }
  })

  it('K2 member token: no_agent via an org admin, never bootstrap_self (dead end 3), who_acts org_admin', async () => {
    const w = newWorld()
    try {
      const c = await memberTokenClient(w)
      const boot = (await call(w, c, 'boot_context')).body
      const wh = whoamiOf(boot)
      expect(wh.state).toBe('no_agent')
      expect(wh.missing.map((m) => [m.code, m.who_acts, m.next_tool])).toEqual([['agent_required', 'org_admin', undefined]])
      expect(wh.missing[0].next_step).toContain('mint_agent_token')
      expect(JSON.stringify(boot)).not.toContain('bootstrap_self')
      expect(obj(boot.onboarding).next_step).toBe(wh.missing[0].next_step)
      expect(boot.next_step).toBe(wh.missing[0].next_step)
    } finally { w.h.close() }
  })

  it('oracle guards: an unbound caller always has a step; a bound own seat / keyed host has none; no step points at status or boot_context unless it is report_runtime', async () => {
    const w = newWorld()
    try {
      const unbound = [await oauthClient(w, 'u1', 'Unknown', ''), await oauthClient(w, 'claude', 'Claude', HARNESS_CHOICE), await memberTokenClient(w)]
      for (const c of unbound) {
        const wh = whoamiOf((await call(w, c, 'boot_context')).body)
        expect(wh.missing.length).toBeGreaterThan(0)
        for (const m of wh.missing) {
          expect(m.who_acts).toMatch(/^(self|owner|admin|org_admin)$/)
          expect(m.next_step.length).toBeGreaterThan(20)
          if (m.code !== 'report_runtime') expect(['status', 'boot_context']).not.toContain(m.next_tool)
        }
      }
      for (const c of [await oauthClient(w, 'chatgpt', 'ChatGPT', HARNESS_CHOICE, { 'openai/session': 'conv-whoami-2' }), await hermesClient(w)]) {
        expect(whoamiOf((await call(w, c, 'boot_context')).body).missing).toHaveLength(0)
      }
    } finally { w.h.close() }
  })

  it('status and orient (unbound) carry the same whoami as boot; orient refuses AND carries the block', async () => {
    const w = newWorld()
    try {
      const c = await oauthClient(w, 'claude', 'Claude', HARNESS_CHOICE)
      const boot = whoamiOf((await call(w, c, 'boot_context')).body)
      expect(whoamiOf((await call(w, c, 'status')).body)).toEqual(boot)
      const res = await rpc(w, c, 'tools/call', { name: 'orient', arguments: {} })
      const env = (await res.json()) as { error?: Json }
      const err = obj(env.error)
      // refusal envelope (lane B table) AND whoami, as siblings of the unchanged string `data`
      expect(err.message).toBe('invalid_args')
      expect(typeof err.data).toBe('string')
      expect(whoamiOf(err)).toEqual(boot)
      expect(err.next_tool).toBe('seat_select')
      expect(err.who_acts).toBe('self')
    } finally { w.h.close() }
  })
})

describe('round 2', () => {
  it('a lost handle: the harness_unseated step says to re-select with the SAME labels, and doing so returns the same agent, a new handle, and no new agents row', async () => {
    const w = newWorld()
    try {
      const c = await oauthClient(w, 'claude', 'Claude', HARNESS_CHOICE)
      const wh = whoamiOf((await call(w, c, 'boot_context')).body)
      expect(wh.missing[0].next_step).toContain('Lost the handle? Call seat_select again with the same project/folder/thread labels')
      const first = await call(w, c, 'seat_select', { project: 'lost-handle', folder: 'f', thread: 't' })
      expect(first.refused).toBe(false)
      const rows = w.agents()
      const again = await call(w, c, 'seat_select', { project: 'lost-handle', folder: 'f', thread: 't' })
      expect(again.refused, JSON.stringify(again.body)).toBe(false)
      expect(obj(again.body.agent).slug).toBe(obj(first.body.agent).slug)
      expect(again.body.seat_handle).not.toBe(first.body.seat_handle)
      expect(typeof again.body.seat_handle).toBe('string')
      expect(w.agents()).toBe(rows)
      expect(String(again.body.note)).toContain('Lost the handle?')
      expect(String(again.body.note)).not.toContain('shown once')
    } finally { w.h.close() }
  })

  it('the curated profile door (sideEffectFree) does not attach whoami to the unbound orient refusal (it would name seat_select, tool_not_in_profile there)', async () => {
    const w = newWorld()
    try {
      const auth = { userId: 'u', role: 'member', tenant: TENANT, channel: 'directory', memberId: 'mem-admin', capabilities: [], harnessId: 'h-1' } as unknown as AuthContext // fields the orient refusal reads
      const full = await invokeTool(auth, w.env, 'orient', {}, { origin: ORIGIN_P, sideEffectFree: false })
      const prof = await invokeTool(auth, w.env, 'orient', {}, { origin: ORIGIN_P, sideEffectFree: true })
      expect((full as { whoami?: unknown }).whoami).toBeDefined()
      expect(prof.ok).toBe(false)
      expect((prof as { whoami?: unknown }).whoami).toBeUndefined()
    } finally { w.h.close() }
  })

  it('K2: doors do not offer connect (it answers no_squad_access) and the prose is the plain "person, not an agent" step', async () => {
    const w = newWorld()
    try {
      const boot = (await call(w, await memberTokenClient(w), 'boot_context')).body
      expect(arr(boot.available_doors).map((d) => d.tool)).not.toContain('connect')
      expect(arr(boot.available_doors).map((d) => d.tool)).toContain('mint_agent_token')
      expect(whoamiOf(boot).missing[0].next_step).toBe('This token is a person, not an agent. Ask an org admin to run mint_agent_token for your agent, then reconnect with that token.')
      expect(JSON.stringify(boot)).not.toContain('basin-drop')
    } finally { w.h.close() }
  })

  it('onboarding carries whoami.state beside connection_kind', async () => {
    const w = newWorld()
    try {
      const boot = (await call(w, await oauthClient(w, 'claude', 'Claude', HARNESS_CHOICE), 'boot_context')).body
      expect(obj(boot.onboarding)).toMatchObject({ connection_kind: 'member', state: 'harness_unseated' })
    } finally { w.h.close() }
  })
})

const ORIGIN_P = 'https://pot.test'

describe('auto_seat_refused: the step names the actor who can clear the reason (#2031)', () => {
  it('real repro: home grant lowered, new conversation -> org_admin step with NO seat_select, and seat_select really is refused with the same code', async () => {
    const w = newWorld()
    try {
      const c = await oauthClient(w, 'chatgpt', 'ChatGPT', HARNESS_CHOICE, { 'openai/session': 'conv-A' })
      expect(whoamiOf((await call(w, c, 'boot_context')).body).state).toBe('own_seat') // the first conversation seats fine
      const human = w.h.sqlite.prepare("SELECT id FROM members WHERE email = 'chatgpt@pot.test'").get() as { id: string }
      w.h.sqlite.prepare("UPDATE capabilities SET capability = 'member' WHERE member_id = ? AND scope_type = 'squad' AND capability = 'admin'").run(human.id)
      c.meta = { 'openai/session': 'conv-B' }
      const wh = whoamiOf((await call(w, c, 'boot_context')).body)
      const m = wh.missing.find((x) => x.code === 'auto_seat_refused')
      expect(m, JSON.stringify(wh)).toBeDefined()
      expect(m?.who_acts).toBe('org_admin')
      expect(m?.next_tool).toBeUndefined()
      expect(wh.missing.map((x) => x.next_tool)).not.toContain('seat_select')
      const again = await call(w, c, 'seat_select', ARGS.seat_select)
      expect(again.refused).toBe(true)
      expect(String(again.body.error)).toContain('home_rank_insufficient')
    } finally { w.h.close() }
  })

  const refused = (reason: string): Whoami => run(authOf({ harnessId: 'h-1', seatInputs: { handleRejected: false, hints: { openai_session: true, openai_subject: false, codex_thread_id: false }, autoSeatRefused: reason } }))
  const only = (reason: string): Whoami['missing'][number] => {
    const wh = refused(reason)
    expect(wh.state).toBe('harness_unseated')
    expect(wh.missing).toHaveLength(1) // no second, generic seat_select step beside it
    return wh.missing[0]
  }
  it('home_rank_insufficient: org_admin, no tool', () => {
    const m = only('home_rank_insufficient')
    expect(m).toMatchObject({ code: 'auto_seat_refused', who_acts: 'org_admin' })
    expect(m.next_tool).toBeUndefined()
  })
  it('member_not_active: org_admin, no tool', () => {
    const m = only('member_not_active')
    expect(m.who_acts).toBe('org_admin')
    expect(m.next_tool).toBeUndefined()
  })
  it('harness_required: owner, re-consent link with the consent labels', () => {
    const m = only('harness_required')
    expect(m).toMatchObject({ who_acts: 'owner', link: mcpEndpoint(ORIGIN) })
    expect(m.next_tool).toBeUndefined()
    expect(m.next_step).toContain('"Me (auto)"')
  })
  it('seat_cap_reached: self, no seat_select', () => {
    const m = only('seat_cap_reached')
    expect(m.who_acts).toBe('self')
    expect(m.next_tool).toBeUndefined()
    expect(m.next_step).toMatch(/Retire a seat/)
  })
  it('rate_limited: self, wait then seat_select', () => {
    const m = only('rate_limited')
    expect(m).toMatchObject({ who_acts: 'self', next_tool: 'seat_select' })
    expect(m.next_step).toMatch(/Wait about 5 minutes/)
  })
  it('reasons that clear on retry keep seat_select (self)', () => {
    for (const reason of ['seat_not_live', 'error']) expect(only(reason)).toMatchObject({ who_acts: 'self', next_tool: 'seat_select' })
  })
})

describe('doors and the orient refusal agree with whoami (#2031)', () => {
  it('K3 stranger and K4: connect is not a door; doors[0] is never connect', async () => {
    const w = newWorld()
    try {
      for (const c of [await oauthClient(w, 'unknown', 'Some New Harness', ''), await oauthClient(w, 'claude', 'Claude', HARNESS_CHOICE)]) {
        const doors = arr((await call(w, c, 'boot_context')).body.available_doors).map((d) => d.tool)
        expect(doors).not.toContain('connect')
        expect(doors[0]).not.toBe('connect')
      }
    } finally { w.h.close() }
  })

  it('K3 in an empty pot: the orient refusal envelope is whoami.missing[0] (bootstrap_self, self), not the table row (re-consent, owner)', async () => {
    const w = newWorld()
    try {
      w.h.sqlite.exec('DELETE FROM agents')
      const c = await oauthClient(w, 'unknown', 'Some New Harness', '')
      const res = await rpc(w, c, 'tools/call', { name: 'orient', arguments: {} })
      const err = obj(((await res.json()) as { error?: Json }).error)
      expect(err.message).toBe('invalid_args')
      expect(whoamiOf(err).missing[0].next_tool).toBe('bootstrap_self')
      expect(err.who_acts).toBe('self')
      expect(err.next_tool).toBe('bootstrap_self')
      expect(err.next_step).toBe(whoamiOf(err).missing[0].next_step)
    } finally { w.h.close() }
  })
})

// ── pure layer ────────────────────────────────────────────────────────────────

const ENV = { SEAT_AUTO_ENROLL: '1', TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test' } as unknown as Env // only the two flags are read
const FACTS: WhoamiFacts = { keyed: false, fenced: false, bootstrappedBefore: false, tenantHasAgents: true, actsAs: 'seat-abc' }
const ORIGIN = 'https://pot.test'
// AuthContext has many unrelated required fields; the builder reads only the ones named per case.
const authOf = (p: Partial<AuthContext>): AuthContext => ({ userId: 'u', role: 'member', tenant: TENANT, channel: 'directory', memberId: 'mem-x', capabilities: [], ...p }) as AuthContext
const SEAT = { seatId: 'seat-1', label: 'chat', harnessId: 'h-1', grantTokenId: 'g-1', humanMemberId: 'mem-x', source: 'handle' as const }
const run = (a: AuthContext, facts: Partial<WhoamiFacts> = {}, env: Env = ENV): Whoami => buildWhoami(env, a, { facts: { ...FACTS, ...facts }, origin: ORIGIN })

describe('buildWhoami: the states a cold client cannot reach under prod flags', () => {
  it('K7 attached: acting_as basis attached; seat.acts_as names the agent; presented follows the handle; empty missing', () => {
    const wh = run(authOf({ boundAgentId: 'ag', seatBinding: { ...SEAT, attached: { attachmentId: 'a', admissionId: 'adm', agentId: 'ag', seatAgentId: 'sa', ceiling: 'member' } } }), { actsAs: 'athena' })
    expect(wh).toMatchObject({ state: 'acting_as', basis: 'attached', missing: [], seat: { seat_id: 'seat-1', acts_as: 'athena', presented: true } })
    expect(wh.agent).toEqual({ keyed: false, inbox: 'peek', can_self_report: false })
  })

  it('K7 attached under a signed-only inbox: ONE admin step naming set_agent_inbox_consumer, no tool for this caller', () => {
    const wh = run(authOf({ boundAgentId: 'ag', seatBinding: { ...SEAT, attached: { attachmentId: 'a', admissionId: 'adm', agentId: 'ag', seatAgentId: 'sa', ceiling: 'member' } } }), { fenced: true })
    expect(wh.missing).toHaveLength(1)
    expect(wh.missing[0]).toMatchObject({ code: 'inbox_fenced', who_acts: 'admin' })
    expect(wh.missing[0].next_step).toContain('set_agent_inbox_consumer')
    expect(wh.missing[0].next_tool).toBeUndefined()
    expect(wh.agent.inbox).toBe('fenced')
  })

  it('K8 legacy consent: acting_as basis legacy_consent, no seat block', () => {
    const wh = run(authOf({ boundAgentId: 'ag', consentedByMemberId: 'mem-human', capabilities: [{ scope_type: 'squad', scope_id: 's', capability: 'member' }] }))
    expect(wh).toMatchObject({ state: 'acting_as', basis: 'legacy_consent', missing: [] })
    expect(wh.seat).toBeUndefined()
  })

  it('downgrade: attach refused leaves the thread an own_seat (not acting_as) and says why, who_acts owner, with the Connections link', () => {
    const wh = run(authOf({ boundAgentId: 'sa', seatBinding: { ...SEAT, source: 'auto:openai_session' }, seatInputs: { handleRejected: false, hints: { openai_session: true, openai_subject: false, codex_thread_id: false }, attachRefused: 'no_capabilities' } }))
    expect(wh.state).toBe('own_seat')
    expect(wh.basis).toBeUndefined()
    expect(wh.missing).toEqual([{ code: 'attach_refused', who_acts: 'owner', next_step: expect.stringContaining('no_capabilities'), link: `${ORIGIN}/connections` }])
  })

  it('downgrade: a rejected handle on a harness session is a seat_select step; on a bound session it is prose only', () => {
    const seatless = run(authOf({ harnessId: 'h-1', seatInputs: { handleRejected: true, hints: { openai_session: false, openai_subject: false, codex_thread_id: false } } }))
    expect(seatless.state).toBe('harness_unseated')
    expect(seatless.missing.map((m) => [m.code, m.next_tool])).toEqual([['seat_handle_rejected', 'seat_select']])
    const bound = run(authOf({ boundAgentId: 'sa', seatBinding: { ...SEAT, source: 'auto:codex_thread' }, seatInputs: { handleRejected: true, hints: { openai_session: false, openai_subject: false, codex_thread_id: true } } }))
    expect(bound.state).toBe('own_seat')
    expect(bound.missing).toHaveLength(1)
    expect(bound.missing[0].next_tool).toBeUndefined() // seat_select would answer not_unbound_directory_session
  })

  it('downgrade: a refused auto seat names the reason; an unbound K8 zero-capability un-weld says the consent lapsed (state no_agent, never acting_as)', () => {
    const refused = run(authOf({ harnessId: 'h-1', seatInputs: { handleRejected: false, hints: { openai_session: true, openai_subject: false, codex_thread_id: false }, autoSeatRefused: 'rate_limited' } }))
    expect(refused.missing[0]).toMatchObject({ code: 'auto_seat_refused', who_acts: 'self', next_tool: 'seat_select' })
    expect(refused.missing[0].next_step).toContain('rate_limited')
    const unwelded = run(authOf({ boundAgentId: null, consentedByMemberId: 'mem-human' }))
    expect(unwelded.state).toBe('no_agent')
    expect(unwelded.missing[0]).toMatchObject({ code: 'consent_lapsed', who_acts: 'owner', link: mcpEndpoint(ORIGIN) })
    expect(unwelded.missing.map((m) => m.next_tool)).not.toContain('bootstrap_self')
  })

  it('refused_not_adopted says what to change (not "call again with plain strings", dead end 6)', () => {
    const wh = run(authOf({ channel: 'workspace', boundAgentId: 'ag' }), { report: { missingFields: [], outcome: 'refused_not_adopted', detail: 'not adopted (see docs)' } })
    expect(wh.missing).toHaveLength(1)
    expect(wh.missing[0].code).toBe('report_refused')
    expect(wh.missing[0].next_step).not.toContain('plain strings')
    expect(wh.missing[0].next_step).toMatch(/Report the runtime you are actually running on/)
    expect(wh.missing[0].next_tool).toBeUndefined()
  })
})

describe('bootstrapOffered: the stranger rule (#2020)', () => {
  const k3 = authOf({ boundAgentId: null })
  const admin = authOf({ boundAgentId: null, latentCapabilities: [{ scope_type: 'org', scope_id: null, capability: 'admin' }] })
  it('offered: never bootstrapped AND (empty pot OR org admin)', () => {
    expect(bootstrapOffered(k3, { ...FACTS, tenantHasAgents: false })).toBe(true)
    expect(bootstrapOffered(admin, FACTS)).toBe(true)
  })
  it('not offered: a stranger in a populated pot, a repeat bootstrapper, a harness session, a bound session, a workspace token, a lapsed consent', () => {
    expect(bootstrapOffered(k3, FACTS)).toBe(false)
    expect(bootstrapOffered(admin, { ...FACTS, bootstrappedBefore: true })).toBe(false)
    expect(bootstrapOffered(authOf({ harnessId: 'h' }), { ...FACTS, tenantHasAgents: false })).toBe(false)
    expect(bootstrapOffered(authOf({ boundAgentId: 'ag' }), { ...FACTS, tenantHasAgents: false })).toBe(false)
    expect(bootstrapOffered(authOf({ channel: 'workspace' }), { ...FACTS, tenantHasAgents: false })).toBe(false)
    expect(bootstrapOffered(authOf({ consentedByMemberId: 'mem-h' }), { ...FACTS, tenantHasAgents: false })).toBe(false)
  })
})
