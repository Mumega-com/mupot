// tests/dyad-gate-policy.test.ts — squads.dyad_gate default gate (migrations/0246).
// Real migration chain + real SQL, through the real invokeTool seam.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { updateUnitConfig } from '../src/org/service'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.example'
const DEPT = 'dept-1'
const SQUAD = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AX = 'agent-x'
const AY = 'agent-y'
const MX = 'member-x'
const MY = 'member-y'
const MHUMAN = 'member-human'
const MADMIN = 'member-admin'

function kv() {
  const store = new Map<string, string>()
  return {
    async get(k: string) { return store.get(k) ?? null },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  }
}

describe('dyad gate default', () => {
  let harness: SqliteD1Harness
  let env: Env

  async function run(sql: string, ...binds: unknown[]) {
    await env.DB.prepare(sql).bind(...binds).run()
  }
  const grant = (cap: string, type: 'agent' | 'member', id: string) =>
    run(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
      crypto.randomUUID(), cap, type, id, MADMIN)
  const setDyad = (on: 0 | 1) => run('UPDATE squads SET dyad_gate = ?1 WHERE id = ?2', on, SQUAD)

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db, SESSIONS: kv() } as unknown as Env
    await run(`INSERT INTO departments (id, slug, name) VALUES (?1, 'dept', 'Dept')`, DEPT)
    await run(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'duo-sqd', 'Duo')`, SQUAD, DEPT)
    for (const [id, slug] of [[AX, 'xbot'], [AY, 'ybot']]) {
      await run(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?1, ?2, ?3, ?3, 'member', 'test', 'active')`, id, SQUAD, slug)
    }
    for (const id of [MX, MY, MHUMAN, MADMIN]) {
      await run(`INSERT INTO members (id, tenant, display_name, status, created_at) VALUES (?1, ?2, ?1, 'active', datetime('now'))`, id, TENANT)
    }
    await run(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, TENANT, AX, MX)
    await run(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, TENANT, AY, MY)
    await run(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at) VALUES ('tok-x', ?1, 'hx', 'x', 'workspace', ?2, ?3, datetime('now'))`, MX, TENANT, AX)
    await run(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at) VALUES ('tok-y', ?1, 'hy', 'y', 'workspace', ?2, ?3, datetime('now'))`, MY, TENANT, AY)
  })
  afterEach(() => harness.close())

  const cap = (m: string, c: 'member' | 'admin' = 'member'): CapabilityGrant =>
    ({ member_id: m, scope_type: 'squad', scope_id: SQUAD, capability: c }) as CapabilityGrant
  const agentAuth = (who: 'x' | 'y'): AuthContext => ({
    userId: who === 'x' ? MX : MY, memberId: who === 'x' ? MX : MY, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: who === 'x' ? AX : AY, capabilities: [cap(who === 'x' ? MX : MY)], tokenId: who === 'x' ? 'tok-x' : 'tok-y',
  })
  const humanAuth = (): AuthContext => ({
    userId: MHUMAN, memberId: MHUMAN, email: 'h@example.com', role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: null, capabilities: [cap(MHUMAN)],
  })
  const create = (auth: AuthContext, args: Record<string, unknown> = {}) =>
    invokeTool(auth, env, 'task_create', { squad_id: 'duo-sqd', title: 'T', done_when: 'checkable thing passes', ...args }, ORIGIN)
  type Out = { ok: boolean; error?: string; result?: { task: { id: string; gate_owner: string | null }; next_step?: string } }
  const gateOf = (r: unknown) => (r as Out).result?.task.gate_owner ?? null
  const hintOf = (r: unknown) => (r as Out).result?.next_step

  it('dyad on: X creates -> gate:ybot; Y creates -> gate:xbot', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    await grant('gate:xbot', 'agent', AX)
    const fromX = await create(agentAuth('x'))
    expect((fromX as Out).ok, JSON.stringify(fromX)).toBe(true)
    expect(gateOf(fromX)).toBe('gate:ybot')
    expect(hintOf(fromX)).toBeUndefined()
    const row = harness.sqlite.prepare('SELECT gate_owner FROM tasks WHERE id = ?').get((fromX as Out).result!.task.id) as { gate_owner: string }
    expect(row.gate_owner).toBe('gate:ybot')
    expect(gateOf(await create(agentAuth('y')))).toBe('gate:xbot')
  })

  it('peer holds no grant: null plus a hint; a creator-only grant is never used', async () => {
    await setDyad(1)
    await grant('gate:xbot', 'agent', AX) // X holds its OWN gate; must not be defaulted for X's task
    const r = await create(agentAuth('x'))
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/holds no live gate:ybot grant/)
  })

  it('peer grant not live (agent paused): null plus a hint', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    await run(`UPDATE agents SET status = 'paused' WHERE id = ?1`, AY)
    const r = await create(agentAuth('x'))
    // a paused peer leaves ONE active agent: not a dyad
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/exactly two/)
  })

  it('three or more active agents: no default, hint says dyad needs exactly two', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    await run(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-z', ?1, 'zbot', 'zbot', 'member', 'test', 'active')`, SQUAD)
    const r = await create(agentAuth('x'))
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/dyad needs exactly two/)
  })

  it('dyad off: unchanged (no default, no hint), even with a live peer grant', async () => {
    await grant('gate:ybot', 'agent', AY)
    const r = await create(agentAuth('x'))
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toBeUndefined()
  })

  it('explicit gate_owner wins, including gate:hadi; validation still applies', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    expect(gateOf(await create(agentAuth('x'), { gate_owner: 'gate:hadi' }))).toBe('gate:hadi')
    expect(gateOf(await create(agentAuth('x'), { gate_owner: 'athena' }))).toBe('gate:athena')
    const bad = await create(agentAuth('x'), { gate_owner: 'gate:office' })
    expect((bad as Out).ok).toBe(false)
    expect((bad as Out).error).toBe('gate_owner_reserved')
    const self = await create(agentAuth('x'), { gate_owner: 'ybot', assignee_agent_id: AX })
    expect((self as Out).error).toBe('gate_owner_creator_is_assignee')
  })

  it('never self: X holding a gate:xbot grant does not make X gate its own task', async () => {
    await setDyad(1)
    await grant('gate:xbot', 'agent', AX)
    await grant('gate:ybot', 'agent', AY)
    expect(gateOf(await create(agentAuth('x')))).not.toBe('gate:xbot')
  })

  it('peer is the assignee: no default (would be self-review), hint given', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    const r = await create(agentAuth('x'), { assignee_agent_id: AY })
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/cannot gate its own work/)
    // creator assigned to itself is fine: peer gates X's work
    expect(gateOf(await create(agentAuth('x'), { assignee_agent_id: AX }))).toBe('gate:ybot')
  })

  it('never gate:hadi / member gate: a peer slug of hadi or a member-held capability is not defaulted', async () => {
    await setDyad(1)
    await run(`UPDATE agents SET slug = 'hadi' WHERE id = ?1`, AY)
    await grant('gate:hadi', 'agent', AY)
    const r = await create(agentAuth('x'))
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/not a usable dyad gate/)

    await run(`UPDATE agents SET slug = 'ybot' WHERE id = ?1`, AY)
    await grant('gate:ybot', 'agent', AY)
    await grant('gate:ybot', 'member', MHUMAN)
    const r2 = await create(agentAuth('x'))
    expect(gateOf(r2)).toBeNull()
    expect(hintOf(r2)).toMatch(/held by a member/)
  })

  it('a human creator gets no default and a hint', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    const r = await create(humanAuth())
    expect((r as Out).ok, JSON.stringify(r)).toBe(true)
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/one of the two dyad agents/)
  })

  it('a bound agent from OUTSIDE the dyad (squad member grant, other home squad) gets no default', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    await grant('gate:xbot', 'agent', AX)
    await run(`INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-out', ?1, 'out-sqd', 'Out')`, DEPT)
    await run(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-w', 'sq-out', 'wbot', 'wbot', 'member', 'test', 'active')`)
    await run(`INSERT INTO members (id, tenant, display_name, status, created_at) VALUES ('member-w', ?1, 'w', 'active', datetime('now'))`, TENANT)
    const w: AuthContext = {
      userId: 'member-w', memberId: 'member-w', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
      boundAgentId: 'agent-w', capabilities: [cap('member-w')],
    }
    const r = await create(w)
    expect((r as Out).ok, JSON.stringify(r)).toBe(true)
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/one of the two dyad agents/)
  })

  it('updateUnitConfig: dyad_gate is a strict boolean and squad-only', async () => {
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_gate: 'true' })).toEqual({ ok: false, error: 'invalid_dyad_gate' })
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_gate: 1 })).toEqual({ ok: false, error: 'invalid_dyad_gate' })
    expect(await updateUnitConfig(env, 'agent', AX, { dyad_gate: true })).toEqual({ ok: false, error: 'invalid_dyad_gate' })
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_gate: true })).toEqual({ ok: true })
    expect((harness.sqlite.prepare('SELECT dyad_gate FROM squads WHERE id = ?').get(SQUAD) as { dyad_gate: number }).dyad_gate).toBe(1)
  })

  describe('update_squad dyad_gate', () => {
    const admin = (): AuthContext => ({
      userId: MADMIN, memberId: MADMIN, email: 'a@example.com', role: 'admin', tenant: TENANT, channel: 'workspace',
      boundAgentId: null, capabilities: [{ member_id: MADMIN, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' } as CapabilityGrant],
    })
    it('admin sets it (strict boolean), result includes it; members cannot; non-booleans refused', async () => {
      const on = await invokeTool(admin(), env, 'update_squad', { squad: 'duo-sqd', dyad_gate: true }, ORIGIN)
      expect((on as { ok: boolean }).ok, JSON.stringify(on)).toBe(true)
      expect((on as unknown as { result: { squad: { dyad_gate: number } } }).result.squad.dyad_gate).toBe(1)
      for (const bad of ['true', 1, 'yes']) {
        const r = await invokeTool(admin(), env, 'update_squad', { squad: 'duo-sqd', dyad_gate: bad }, ORIGIN)
        expect((r as { ok: boolean }).ok).toBe(false)
      }
      const row = harness.sqlite.prepare('SELECT dyad_gate FROM squads WHERE id = ?').get(SQUAD) as { dyad_gate: number }
      expect(row.dyad_gate).toBe(1)
      const denied = await invokeTool(agentAuth('x'), env, 'update_squad', { squad: 'duo-sqd', dyad_gate: false }, ORIGIN)
      expect((denied as { ok: boolean }).ok).toBe(false)
      expect((harness.sqlite.prepare('SELECT dyad_gate FROM squads WHERE id = ?').get(SQUAD) as { dyad_gate: number }).dyad_gate).toBe(1)
    })
  })
})
