// squad_choose: an agent in its owner's home squad (the lobby) picks its working squad once, bounded by the OWNER's standing.
// Real sqlite D1 from the full committed migration chain; the write is the real moveAgentSquad batch.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool } from '../src/mcp/index'
import { deterministicScorer } from '../src/members/squad-choice'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
let h: SqliteD1Harness
let env: Env
const all = <T>(sql: string, ...p: unknown[]): T[] => h.sqlite.prepare(sql).all(...p) as T[]
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test' } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'eng', 'Eng'), ('d2', 'ops', 'Ops');
    INSERT INTO squads (id, department_id, slug, name, kind, charter) VALUES
      ('sq-home', 'd1', 'home-owner', 'Home Owner', 'home', NULL),
      ('sq-a', 'd1', 'frontend-a', 'Frontend Web', 'work', 'react typescript web ui'),
      ('sq-b', 'd1', 'secret-b', 'Secret B', 'work', 'nothing'),
      ('sq-c', 'd2', 'ops-c', 'Ops Desk', 'work', 'operations'),
      ('sq-old', 'd1', 'old-old', 'Old', 'work', NULL),
      ('sq-obs', 'd1', 'obs-only', 'Observed', 'work', NULL);
    UPDATE squads SET status = 'archived' WHERE id = 'sq-old';
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('m-owner', 'Owner', 'active', '${TENANT}'), ('mem-a1', 'A1', 'active', '${TENANT}'), ('m-other', 'Other', 'active', '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, purpose, skills, owner_member_id)
      VALUES ('a1', 'sq-home', 'a1', 'A1', 'member', 'm', 'active', 'build react web ui', '["typescript","react"]', 'm-owner');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'a1', 'mem-a1', '2026-10-01T00:00:00.000Z');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-h', 'a1', 'sq-home', 'member');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c-a1-home', 'mem-a1', 'squad', 'sq-home', 'member'),
      ('c-own-home', 'm-owner', 'squad', 'sq-home', 'admin'),
      ('c-own-a', 'm-owner', 'squad', 'sq-a', 'lead'),
      ('c-own-c', 'm-owner', 'squad', 'sq-c', 'admin'),
      ('c-own-old', 'm-owner', 'squad', 'sq-old', 'admin'),
      ('c-own-obs', 'm-owner', 'squad', 'sq-obs', 'member');
  `)
})
afterEach(() => h.close())

const agentCtx = (id = 'a1', member = 'mem-a1'): AuthContext => ({ userId: member, email: '', role: 'member', tenant: TENANT, channel: 'workspace', memberId: member, capabilities: [], boundAgentId: id })
const choose = (args: Record<string, unknown>, ctx: AuthContext = agentCtx()) => invokeTool(ctx, env, 'squad_choose', args, 'https://pot.test')
const squadOf = (): string => one<{ squad_id: string }>("SELECT squad_id FROM agents WHERE id = 'a1'")!.squad_id
const audits = () => all<{ fields_changed: string }>("SELECT fields_changed FROM agent_audit WHERE agent_id = 'a1' AND action = 'move_agent_squad'")
const errOf = (r: Awaited<ReturnType<typeof choose>>): string => (r.ok ? '' : r.error)

describe('candidates', () => {
  it('lists only work squads where the OWNER holds lead or better, best match first, each with a reason', async () => {
    const r = await choose({})
    expect(r.ok).toBe(true)
    const res = (r as { result: { in_lobby: boolean; candidates: Array<{ squad_id: string; reason: { matching_skills: string[]; purpose: string | null } }> } }).result
    expect(res.in_lobby).toBe(true)
    // sq-a (lead) and sq-c (admin) only: not sq-b (no standing), not sq-obs (member < lead), not the archived one, not a home
    expect(res.candidates.map((c) => c.squad_id)).toEqual(['sq-a', 'sq-c'])
    expect(res.candidates[0]!.reason.matching_skills).toEqual(expect.arrayContaining(['react', 'typescript']))
    expect(res.candidates[0]!.reason.purpose).toBe('react typescript web ui')
  })

  it('the scorer is a pure deterministic seam', () => {
    const agent = { id: 'x', name: 'x', squad_id: 's', purpose: 'billing', skills: '["invoices"]', capabilities: null }
    const facts = { id: 'q', slug: 'billing-q', name: 'Billing', charter: 'invoices', projects: [], recent_tasks: 3 }
    expect(deterministicScorer.score(agent, facts)).toEqual(deterministicScorer.score(agent, facts))
    expect(deterministicScorer.score(agent, facts).matched).toEqual(['billing', 'invoices'])
  })

  it('boot-time step: boot_context carries choose_squad for a lobby agent and drops it after the choice', async () => {
    const boot = () => invokeTool(agentCtx(), env, 'boot_context', {}, 'https://pot.test')
    const before = await boot()
    expect(before.ok && (before.result as { choose_squad?: { tool: string } }).choose_squad?.tool).toBe('squad_choose')
    expect((await choose({ squad_id: 'sq-a' })).ok).toBe(true)
    const after = await boot()
    expect(after.ok && (after.result as { choose_squad?: unknown }).choose_squad).toBeUndefined()
  })
})

describe('choosing', () => {
  it('moves the agent: binding changes, lobby grants severed, destination grant member, a receipt with the owner named', async () => {
    const r = await choose({ squad_id: 'sq-a', reason: 'I do web ui' })
    expect(r.ok).toBe(true)
    expect(squadOf()).toBe('sq-a')
    expect(one("SELECT capability FROM capabilities WHERE member_id = 'mem-a1' AND scope_id = 'sq-a'")).toEqual({ capability: 'member' })
    expect(one("SELECT 1 AS x FROM capabilities WHERE member_id = 'mem-a1' AND scope_id = 'sq-home'")).toBeUndefined()
    const a = audits()
    expect(a).toHaveLength(1)
    expect(a[0]!.fields_changed).toContain('squad_choose by agent under owner m-owner: I do web ui')
  })

  it('refuses a squad outside the candidate list (no owner standing, owner below lead, archived, a home, unknown)', async () => {
    for (const id of ['sq-b', 'sq-obs', 'sq-old', 'sq-home', 'nope']) {
      expect(errOf(await choose({ squad_id: id }))).toBe('squad_not_a_candidate')
    }
    expect(squadOf()).toBe('sq-home')
    expect(audits()).toHaveLength(0)
  })

  it('caps the level: only observer or member, default member; never above the agent choice list', async () => {
    for (const level of ['lead', 'admin', 'owner', 'god']) expect(errOf(await choose({ squad_id: 'sq-a', level }))).toBe('invalid_level')
    expect(squadOf()).toBe('sq-home')
    expect((await choose({ squad_id: 'sq-c', level: 'observer' })).ok).toBe(true)
    expect(one("SELECT capability FROM capabilities WHERE member_id = 'mem-a1' AND scope_id = 'sq-c'")).toEqual({ capability: 'observer' })
  })

  it('is one-time: a different squad afterwards is refused, the same squad is idempotent with no second write', async () => {
    expect((await choose({ squad_id: 'sq-a' })).ok).toBe(true)
    expect(errOf(await choose({ squad_id: 'sq-c' }))).toBe('already_placed')
    const again = await choose({ squad_id: 'sq-a' })
    expect(again.ok && (again.result as { already: boolean }).already).toBe(true)
    expect(squadOf()).toBe('sq-a')
    expect(audits()).toHaveLength(1)
  })

  it('once placed, listing offers nothing', async () => {
    expect((await choose({ squad_id: 'sq-a' })).ok).toBe(true)
    const r = await choose({})
    expect(r.ok && (r.result as { in_lobby: boolean; candidates: unknown[] })).toEqual({ in_lobby: false, candidates: [] })
  })

  it('home fallback: an agent that never chooses stays in the lobby with its home grant', async () => {
    await choose({})
    expect(squadOf()).toBe('sq-home')
    expect(one("SELECT capability FROM capabilities WHERE member_id = 'mem-a1' AND scope_id = 'sq-home'")).toEqual({ capability: 'member' })
  })

  it('the owner\'s standing is read live: a grant revoked after listing refuses the choice', async () => {
    h.sqlite.exec("DELETE FROM capabilities WHERE id = 'c-own-a'")
    expect(errOf(await choose({ squad_id: 'sq-a' }))).toBe('squad_not_a_candidate')
    expect(squadOf()).toBe('sq-home')
  })
})

describe('who may call it', () => {
  it('refuses a session that is not a direct agent credential', async () => {
    const human: AuthContext = { userId: 'm-owner', email: '', role: 'owner', tenant: TENANT, channel: 'workspace', memberId: 'm-owner', capabilities: [] }
    expect(errOf(await choose({ squad_id: 'sq-a' }, human))).toBe('agent_session_required')
    const seat: AuthContext = { ...agentCtx(), seatBinding: { seatId: 's', label: 'l', harnessId: 'h', grantTokenId: 't', humanMemberId: 'm-owner', source: 'handle', attached: false } as AuthContext['seatBinding'] }
    expect(errOf(await choose({ squad_id: 'sq-a' }, seat))).toBe('attached_session_forbidden')
    expect(squadOf()).toBe('sq-home')
  })

  it('has no owner when ownership is ambiguous: no candidates, no move', async () => {
    h.sqlite.exec("UPDATE agents SET owner_member_id = NULL WHERE id = 'a1'; INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-o2', 'm-other', 'squad', 'sq-home', 'admin');")
    expect(errOf(await choose({}))).toBe('owner_unknown')
    expect(errOf(await choose({ squad_id: 'sq-a' }))).toBe('owner_unknown')
    expect(squadOf()).toBe('sq-home')
  })

  it('falls back to the single human who administers the home when owner_member_id is unset', async () => {
    h.sqlite.exec("UPDATE agents SET owner_member_id = NULL WHERE id = 'a1'")
    expect((await choose({ squad_id: 'sq-a' })).ok).toBe(true)
  })

  it('an agent whose owner is itself an agent identity has no owner standing', async () => {
    h.sqlite.exec("UPDATE agents SET owner_member_id = 'mem-a1' WHERE id = 'a1'")
    expect(errOf(await choose({ squad_id: 'sq-a' }))).toBe('owner_unknown')
  })
})
