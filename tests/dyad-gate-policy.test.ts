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
  const pin = (a = AX, b = AY) => run('UPDATE squads SET dyad_agent_a = ?1, dyad_agent_b = ?2 WHERE id = ?3', a, b, SQUAD)
  const setDyad = (on: 0 | 1) => (on ? pin() : Promise.resolve())

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

  it('roster drift: a third active agent changes nothing; the pinned peer stays the peer', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    await run(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-z', ?1, 'zbot', 'zbot', 'member', 'test', 'active')`, SQUAD)
    await grant('gate:zbot', 'agent', 'agent-z')
    expect(gateOf(await create(agentAuth('x')))).toBe('gate:ybot')
  })

  it('pinned pair broken (peer paused, or moved out of the squad): no default, hint', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    await run(`UPDATE agents SET status = 'paused' WHERE id = ?1`, AY)
    const r = await create(agentAuth('x'))
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/no longer two active agents of this squad/)
    await run(`UPDATE agents SET status = 'active' WHERE id = ?1`, AY)
    expect(gateOf(await create(agentAuth('x')))).toBe('gate:ybot')
    await run(`INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-out', ?1, 'out-sqd', 'Out')`, DEPT)
    await run(`UPDATE agents SET squad_id = 'sq-out' WHERE id = ?1`, AY)
    const moved = await create(agentAuth('x'))
    expect(gateOf(moved)).toBeNull()
    expect(hintOf(moved)).toMatch(/no longer two active agents of this squad/)
  })

  it('exclusive holder: a same-owner puppet agent in another squad holding the peer gate blocks the default', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    await run(`INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-out', ?1, 'out-sqd', 'Out')`, DEPT)
    await run(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-p', 'sq-out', 'pbot', 'pbot', 'member', 'test', 'active')`)
    expect(gateOf(await create(agentAuth('x')))).toBe('gate:ybot')
    await grant('gate:ybot', 'agent', 'agent-p')
    const r = await create(agentAuth('x'))
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/not held exclusively/)
  })

  it('exclusive holder: the creator also holding the peer gate blocks the default', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    await grant('gate:ybot', 'agent', AX)
    const r = await create(agentAuth('x'))
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/not held exclusively/)
  })

  it('an unpinned third agent (not in the pair) creating gets no default', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    await run(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-z', ?1, 'zbot', 'zbot', 'member', 'test', 'active')`, SQUAD)
    await run(`INSERT INTO members (id, tenant, display_name, status, created_at) VALUES ('member-z', ?1, 'z', 'active', datetime('now'))`, TENANT)
    const z: AuthContext = {
      userId: 'member-z', memberId: 'member-z', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
      boundAgentId: 'agent-z', capabilities: [cap('member-z')],
    }
    const r = await create(z)
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/pinned dyad agents/)
  })

  it('dyad off (no pair pinned): unchanged (no default, no hint), even with a live peer grant', async () => {
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
    expect(hintOf(r2)).toMatch(/not held exclusively/)
  })

  it('a human creator gets no default and a hint', async () => {
    await setDyad(1)
    await grant('gate:ybot', 'agent', AY)
    const r = await create(humanAuth())
    expect((r as Out).ok, JSON.stringify(r)).toBe(true)
    expect(gateOf(r)).toBeNull()
    expect(hintOf(r)).toMatch(/pinned dyad agents/)
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
    expect(hintOf(r)).toMatch(/pinned dyad agents/)
  })

  it('updateUnitConfig: pair must be both-or-neither, distinct, active, in THIS squad; squad-only', async () => {
    const bad = { ok: false, error: 'invalid_dyad_pair' }
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_agent_a: AX })).toEqual(bad)
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_agent_a: AX, dyad_agent_b: null })).toEqual(bad)
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_agent_a: AX, dyad_agent_b: AX })).toEqual(bad)
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_agent_a: AX, dyad_agent_b: 'no-such' })).toEqual(bad)
    expect(await updateUnitConfig(env, 'agent', AX, { dyad_agent_a: AX, dyad_agent_b: AY })).toEqual(bad)
    await run(`INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-out', ?1, 'out-sqd', 'Out')`, DEPT)
    await run(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-w', 'sq-out', 'wbot', 'wbot', 'member', 'test', 'active')`)
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_agent_a: AX, dyad_agent_b: 'agent-w' })).toEqual(bad)
    await run(`UPDATE agents SET status = 'paused' WHERE id = ?1`, AY)
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_agent_a: AX, dyad_agent_b: AY })).toEqual(bad)
    await run(`UPDATE agents SET status = 'active' WHERE id = ?1`, AY)
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_agent_a: AX, dyad_agent_b: AY })).toEqual({ ok: true })
    expect(await updateUnitConfig(env, 'squad', SQUAD, { dyad_agent_a: null, dyad_agent_b: null })).toEqual({ ok: true })
  })

  describe('update_squad dyad pair', () => {
    const admin = (role: 'owner' | 'member' = 'owner', caps?: CapabilityGrant[]): AuthContext => ({
      userId: MADMIN, memberId: MADMIN, email: 'a@example.com', role, tenant: TENANT, channel: 'workspace',
      boundAgentId: null, capabilities: caps ?? [{ member_id: MADMIN, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' } as CapabilityGrant],
    })
    const upd = (auth: AuthContext, args: Record<string, unknown>) => invokeTool(auth, env, 'update_squad', { squad: 'duo-sqd', ...args }, ORIGIN)
    const pair = () => harness.sqlite.prepare('SELECT dyad_agent_a AS a, dyad_agent_b AS b FROM squads WHERE id = ?').get(SQUAD) as { a: string | null; b: string | null }

    it('org owner pins by slug, read returns ids, clears with nulls', async () => {
      const on = await upd(admin('owner'), { dyad_agent_a: 'xbot', dyad_agent_b: 'ybot' })
      expect((on as { ok: boolean }).ok, JSON.stringify(on)).toBe(true)
      expect(pair()).toEqual({ a: AX, b: AY })
      expect((on as unknown as { result: { squad: { dyad_agent_a: string; dyad_agent_b: string } } }).result.squad).toMatchObject({ dyad_agent_a: AX, dyad_agent_b: AY })
      expect((await upd(admin('owner'), { dyad_agent_a: null, dyad_agent_b: null }) as { ok: boolean }).ok).toBe(true)
      expect(pair()).toEqual({ a: null, b: null })
    })

    it('a squad admin who is not org owner/admin is refused, set or clear', async () => {
      const sqAdmin = admin('member')
      for (const args of [{ dyad_agent_a: 'xbot', dyad_agent_b: 'ybot' }]) {
        const r = await upd(sqAdmin, args)
        expect((r as { ok: boolean }).ok).toBe(false)
        expect(JSON.stringify(r)).toMatch(/dyad_pair_org_admin_only/)
      }
      expect(pair()).toEqual({ a: null, b: null })
      await upd(admin('owner'), { dyad_agent_a: 'xbot', dyad_agent_b: 'ybot' })
      expect((await upd(sqAdmin, { dyad_agent_a: null, dyad_agent_b: null }) as { ok: boolean }).ok).toBe(false)
      expect(pair()).toEqual({ a: AX, b: AY })
    })

    it('half pair, same agent twice, non-member agent: refused; agents (bound) refused; home squad refused', async () => {
      expect((await upd(admin('owner'), { dyad_agent_a: 'xbot' }) as { ok: boolean }).ok).toBe(false)
      expect((await upd(admin('owner'), { dyad_agent_a: 'xbot', dyad_agent_b: 'xbot' }) as { ok: boolean }).ok).toBe(false)
      expect((await upd(admin('owner'), { dyad_agent_a: 'xbot', dyad_agent_b: 'nobody' }) as { ok: boolean }).ok).toBe(false)
      const agentAdmin: AuthContext = { ...admin('owner'), boundAgentId: AX }
      expect((await upd(agentAdmin, { dyad_agent_a: 'xbot', dyad_agent_b: 'ybot' }) as { ok: boolean }).ok).toBe(false)
      await run(`UPDATE squads SET kind = 'home' WHERE id = ?1`, SQUAD)
      const home = await upd(admin('owner'), { dyad_agent_a: 'xbot', dyad_agent_b: 'ybot' })
      expect((home as { ok: boolean }).ok).toBe(false)
      expect(pair()).toEqual({ a: null, b: null })
    })
  })
})
