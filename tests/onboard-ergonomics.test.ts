// tests/onboard-ergonomics.test.ts — mupot#1664 CEREMONY slice (no identity/approval change).
//   1. task_create: squad by slug / default own squad / description alias / gate_owner at create
//   2. presence refreshed by ANY authenticated agent-bound call (self-rate-limited)
//   3. agent self-read of its OWN presence + sessions (never another agent's)
//   4. agent self-end of its OWN session (already allowed; pinned here)
// Real migration chain + real SQL (createSqliteD1), through the real invokeTool seam.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { evaluateAgentSession, loadAgentSessionById } from '../src/auth/agent-sessions'

const TENANT = 'mumega'
const ORIGIN = 'https://pot.example'
const DEPT = 'dept-1'
const SQUAD_CORE = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SQUAD_OTHER = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT_A = 'agent-a'
const AGENT_B = 'agent-b'
const MEM_A = 'member-a'
const MEM_B = 'member-b'
const MEM_ADMIN = 'member-admin'
const TOK_A = 'token-a'
const TOK_B = 'token-b'

function kv() {
  const store = new Map<string, string>()
  return {
    async get(k: string) { return store.get(k) ?? null },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  }
}

describe('onboard ergonomics (#1664 ceremony slice)', () => {
  let harness: SqliteD1Harness
  let env: Env

  async function run(sql: string, ...binds: unknown[]) {
    await env.DB.prepare(sql).bind(...binds).run()
  }

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db, SESSIONS: kv() } as unknown as Env
    await run(`INSERT INTO departments (id, slug, name) VALUES (?1, 'dept', 'Dept')`, DEPT)
    await run(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad-core', 'Core')`, SQUAD_CORE, DEPT)
    await run(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad-other', 'Other')`, SQUAD_OTHER, DEPT)
    for (const [id, slug] of [[AGENT_A, 'agent-a'], [AGENT_B, 'agent-b']]) {
      await run(
        `INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?1, ?2, ?3, ?3, 'member', 'test', 'active')`,
        id, SQUAD_CORE, slug,
      )
    }
    for (const id of [MEM_A, MEM_B, MEM_ADMIN]) {
      await run(`INSERT INTO members (id, tenant, display_name, status, created_at) VALUES (?1, ?2, ?1, 'active', datetime('now'))`, id, TENANT)
    }
    await run(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, TENANT, AGENT_A, MEM_A)
    await run(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, TENANT, AGENT_B, MEM_B)
    await run(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at) VALUES (?1, ?2, 'h-a', 'claude-ai', 'workspace', ?3, ?4, datetime('now'))`,
      TOK_A, MEM_A, TENANT, AGENT_A,
    )
    await run(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at) VALUES (?1, ?2, 'h-b', 'b-seat', 'workspace', ?3, ?4, datetime('now'))`,
      TOK_B, MEM_B, TENANT, AGENT_B,
    )
  })
  afterEach(() => harness.close())

  const memberGrant = (member: string, squad: string): CapabilityGrant =>
    ({ member_id: member, scope_type: 'squad', scope_id: squad, capability: 'member' }) as CapabilityGrant

  function agentAuth(which: 'a' | 'b' = 'a', capabilities?: CapabilityGrant[]): AuthContext {
    const a = which === 'a'
    return {
      userId: a ? MEM_A : MEM_B,
      memberId: a ? MEM_A : MEM_B,
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: a ? AGENT_A : AGENT_B,
      capabilities: capabilities ?? [memberGrant(a ? MEM_A : MEM_B, SQUAD_CORE)],
      tokenId: a ? TOK_A : TOK_B,
    }
  }

  function humanAuth(capabilities: CapabilityGrant[] = [memberGrant(MEM_ADMIN, SQUAD_CORE)]): AuthContext {
    return {
      userId: MEM_ADMIN, memberId: MEM_ADMIN, email: 'x@example.com', role: 'member',
      tenant: TENANT, channel: 'workspace', boundAgentId: null, capabilities,
    }
  }

  const create = (auth: AuthContext, args: Record<string, unknown>) =>
    invokeTool(auth, env, 'task_create', { title: 'T', done_when: 'checkable thing passes', ...args }, ORIGIN)

  const taskRow = async (id: string) =>
    harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>

  // ───────────────────────── 1. task_create ─────────────────────────
  describe('task_create', () => {
    it('accepts a squad SLUG, a full UUID and a short prefix — all land on the same squad', async () => {
      for (const ref of ['squad-core', SQUAD_CORE, SQUAD_CORE.slice(0, 8)]) {
        const res = await create(agentAuth(), { squad_id: ref })
        expect(res.ok, `${ref}: ${JSON.stringify(res)}`).toBe(true)
        const t = (res as { result: { task: { id: string } } }).result.task
        expect((await taskRow(t.id)).squad_id).toBe(SQUAD_CORE)
      }
    })

    it('defaults to the bound agent\'s own squad when squad_id is omitted', async () => {
      const res = await create(agentAuth(), {})
      expect(res.ok, JSON.stringify(res)).toBe(true)
      const t = (res as { result: { task: { id: string } } }).result.task
      expect((await taskRow(t.id)).squad_id).toBe(SQUAD_CORE)
    })

    it('an UNBOUND caller that omits squad_id is still refused (400)', async () => {
      const res = await create(humanAuth(), {})
      expect(res.ok).toBe(false)
      if (!res.ok) expect([res.status, res.error]).toEqual([400, 'invalid_args'])
    })

    it('a slug does not widen access: a squad the caller holds no member grant on is 403, unknown slug 404', async () => {
      const denied = await create(agentAuth(), { squad_id: 'squad-other' })
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.status).toBe(403)
      const missing = await create(agentAuth(), { squad_id: 'no-such-squad' })
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.status).toBe(404)
    })

    it('unknown fields are still refused', async () => {
      const res = await create(agentAuth(), { squad_id: 'squad-core', bogus: 1 })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe('invalid_args')
    })

    it('description is an alias of body; both given and different is a 400', async () => {
      const ok = await create(agentAuth(), { description: 'the long text' })
      expect(ok.ok).toBe(true)
      const id = (ok as { result: { task: { id: string } } }).result.task.id
      expect((await taskRow(id)).body).toBe('the long text')

      const same = await create(agentAuth(), { body: 'x', description: 'x' })
      expect(same.ok).toBe(true)
      const clash = await create(agentAuth(), { body: 'x', description: 'y' })
      expect(clash.ok).toBe(false)
      if (!clash.ok) expect(clash.error).toBe('invalid_args')
    })

    it('gate_owner at create: bare slug is prefixed gate:, a full gate: form is kept', async () => {
      const bare = await create(agentAuth(), { gate_owner: 'hadi', assignee_agent_id: AGENT_B })
      expect(bare.ok, JSON.stringify(bare)).toBe(true)
      expect((await taskRow((bare as { result: { task: { id: string } } }).result.task.id)).gate_owner).toBe('gate:hadi')
      const full = await create(agentAuth(), { gate_owner: 'gate:athena', assignee_agent_id: AGENT_B })
      expect(full.ok).toBe(true)
      expect((await taskRow((full as { result: { task: { id: string } } }).result.task.id)).gate_owner).toBe('gate:athena')
      const none = await create(agentAuth(), {})
      expect((await taskRow((none as { result: { task: { id: string } } }).result.task.id)).gate_owner).toBeNull()
    })

    it('gate_owner at create is REFUSED when the creator is the assignee (agent and member forms)', async () => {
      const selfAgent = await create(agentAuth(), { gate_owner: 'hadi', assignee_agent_id: AGENT_A })
      expect(selfAgent.ok).toBe(false)
      if (!selfAgent.ok) expect(selfAgent.error).toBe('gate_owner_creator_is_assignee')

      // member-assignee form: a human creator assigning the task to themselves
      await run(
        `INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES (?1, 'squad', ?2, 'member')`,
        MEM_ADMIN, SQUAD_CORE,
      )
      const selfMember = await create(humanAuth(), { squad_id: 'squad-core', gate_owner: 'hadi', assignee_member_id: MEM_ADMIN })
      expect(selfMember.ok).toBe(false)
      if (!selfMember.ok) expect(selfMember.error).toBe('gate_owner_creator_is_assignee')
    })

    it('gate_owner form guard and reserved machine gates', async () => {
      const bad = await create(agentAuth(), { gate_owner: 'Not A Slug!' })
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.error).toBe('invalid_gate_owner')
      const blank = await create(agentAuth(), { gate_owner: '   ' })
      expect(blank.ok).toBe(false)
      for (const reserved of ['office', 'gate:routines', 'agent-self-completion', 'self-anything']) {
        const r = await create(agentAuth(), { gate_owner: reserved })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toBe('gate_owner_reserved')
      }
    })
  })

  // ───────────────────────── 2. presence on any call ─────────────────────────
  describe('presence refreshed by any authenticated agent call', () => {
    const seed = (member: string, agent: string | null, label: string, agoSeconds: number) =>
      run(
        `INSERT INTO presence (tenant, member_id, display_name, source, label, seat, agent_id, harness, first_seen_at, last_seen_at)
         VALUES (?1, ?2, ?2, 'mcp', ?3, ?3, ?4, 'unknown', datetime('now', ?5), datetime('now', ?5))`,
        TENANT, member, label, agent, `-${agoSeconds} seconds`,
      )
    const seen = (member: string, label: string) =>
      (harness.sqlite.prepare('SELECT last_seen_at FROM presence WHERE member_id = ? AND label = ?').get(member, label) as { last_seen_at: string }).last_seen_at
    const ageSeconds = (member: string, label: string) =>
      (Date.now() - Date.parse(seen(member, label).replace(' ', 'T') + 'Z')) / 1000

    // Production shape: the agent's dedicated member holds several seats of the SAME agent
    // (other machines/tokens). The credential's session records which seat IT checked in as.
    async function checkInAs(seat: string, ageSec: number) {
      await invokeTool(agentAuth(), env, 'check_in', { seat }, ORIGIN)
      await run(`UPDATE presence SET last_seen_at = datetime('now', ?1) WHERE member_id = ?2 AND label = ?3`, `-${ageSec} seconds`, MEM_A, seat)
    }

    it('a non-check_in call refreshes the seat THIS credential checked in under (not the token label), and no sibling seat', async () => {
      await checkInAs('mupot-mac', 500) // token label is "claude-ai"
      await seed(MEM_A, AGENT_A, 'dead-sibling', 300000) // same agent, same member, dead 3 days
      expect(ageSeconds(MEM_A, 'mupot-mac')).toBeGreaterThan(400)
      const res = await invokeTool(agentAuth(), env, 'task_list', {}, ORIGIN)
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(ageSeconds(MEM_A, 'mupot-mac')).toBeLessThan(30)
      expect(ageSeconds(MEM_A, 'dead-sibling')).toBeGreaterThan(290000)
    })

    it('is rate-limited: a row seen <60s ago is not rewritten', async () => {
      await checkInAs('mupot-mac', 20)
      const before = seen(MEM_A, 'mupot-mac')
      await invokeTool(agentAuth(), env, 'task_list', {}, ORIGIN)
      expect(seen(MEM_A, 'mupot-mac')).toBe(before)
    })

    it('never touches another agent\'s row', async () => {
      await checkInAs('mupot-mac', 500)
      await seed(MEM_B, AGENT_B, 'b-laptop', 500)
      await invokeTool(agentAuth(), env, 'task_list', {}, ORIGIN)
      expect(ageSeconds(MEM_B, 'b-laptop')).toBeGreaterThan(400)
    })

    it('a credential with no declared seat refreshes no seat row', async () => {
      await seed(MEM_A, AGENT_A, 'orphan-seat', 500)
      await invokeTool(agentAuth(), env, 'task_list', {}, ORIGIN)
      expect(ageSeconds(MEM_A, 'orphan-seat')).toBeGreaterThan(400)
    })
  })

  // ───────────────────────── 3. self-read ─────────────────────────
  describe('agent self-read of presence and sessions', () => {
    const noGrants = (which: 'a' | 'b') => agentAuth(which, [])

    beforeEach(async () => {
      await invokeTool(noGrants('a'), env, 'check_in', { seat: 'seat-a' }, ORIGIN)
      await invokeTool(noGrants('b'), env, 'check_in', { seat: 'seat-b' }, ORIGIN)
      await run(
        `INSERT INTO module_registry (id, tenant, kind, adapter, project_id, identity, status, capabilities, last_heartbeat, registered_at)
         VALUES ('m-a', ?1, 'agent_system', 'ad-a', NULL, ?2, 'online', '[]', datetime('now'), datetime('now'))`,
        TENANT, AGENT_A,
      )
      await run(
        `INSERT INTO module_registry (id, tenant, kind, adapter, project_id, identity, status, capabilities, last_heartbeat, registered_at)
         VALUES ('m-b', ?1, 'agent_system', 'ad-b', NULL, ?2, 'online', '[]', datetime('now'), datetime('now'))`,
        TENANT, AGENT_B,
      )
    })

    it('presence_list self:true — a grantless agent sees ITS OWN modules and seats, never another agent\'s', async () => {
      const res = await invokeTool(noGrants('a'), env, 'presence_list', { self: true }, ORIGIN)
      expect(res.ok, JSON.stringify(res)).toBe(true)
      const r = res.result as { modules: Array<{ identity: string }>; seats: Array<{ agent_id: string; seat: string }> }
      expect(r.modules.map((m) => m.identity)).toEqual([AGENT_A])
      expect(r.seats.length).toBeGreaterThan(0)
      expect(r.seats.every((s) => s.agent_id === AGENT_A)).toBe(true)
      expect(JSON.stringify(r)).not.toContain(AGENT_B)
      expect(JSON.stringify(r)).not.toContain('seat-b')
    })

    it('presence_list self:true needs an agent-bound token, and takes no project_id', async () => {
      const unbound = await invokeTool(humanAuth([]), env, 'presence_list', { self: true }, ORIGIN)
      expect(unbound.ok).toBe(false)
      const both = await invokeTool(noGrants('a'), env, 'presence_list', { self: true, project_id: null }, ORIGIN)
      expect(both.ok).toBe(false)
    })

    it('presence_list WITHOUT self: a non-admin (even agent-bound) still cannot read the roster', async () => {
      const grantless = await invokeTool(noGrants('a'), env, 'presence_list', {}, ORIGIN)
      expect(grantless.ok).toBe(false)
      if (!grantless.ok) expect(grantless.error).toBe('forbidden')
      const observerUnscoped = await invokeTool(agentAuth('a', [
        { member_id: MEM_A, scope_type: 'squad', scope_id: SQUAD_CORE, capability: 'observer' } as CapabilityGrant,
      ]), env, 'presence_list', {}, ORIGIN)
      expect(observerUnscoped.ok).toBe(false)
      if (!observerUnscoped.ok) expect(observerUnscoped.error).toBe('forbidden')
      // project-scoped read keeps the SAME refusal shape it had when spec.min was 'observer'
      const projectScoped = await invokeTool(noGrants('a'), env, 'presence_list', { project_id: 'proj-x' }, ORIGIN)
      expect(projectScoped.ok).toBe(false)
      if (!projectScoped.ok) expect(projectScoped.error).toBe('forbidden')
      const admin = await invokeTool(humanAuth([{ member_id: MEM_ADMIN, scope_type: 'org', scope_id: null, capability: 'admin' } as CapabilityGrant]), env, 'presence_list', {}, ORIGIN)
      expect(admin.ok).toBe(true)
      expect((admin.result as { modules: unknown[] }).modules.length).toBe(2)
    })

    it('list_agent_sessions self — own sessions only; another agent\'s session id never appears', async () => {
      const rowA = harness.sqlite.prepare('SELECT id FROM agent_sessions WHERE agent_id = ?').all(AGENT_A) as Array<{ id: string }>
      const rowB = harness.sqlite.prepare('SELECT id FROM agent_sessions WHERE agent_id = ?').all(AGENT_B) as Array<{ id: string }>
      expect(rowA.length).toBe(1)
      expect(rowB.length).toBe(1)
      for (const args of [{ self: true }, {}]) {
        const res = await invokeTool(noGrants('a'), env, 'list_agent_sessions', args, ORIGIN)
        expect(res.ok, JSON.stringify(res)).toBe(true)
        const r = res.result as { agent: { id: string }; sessions: Array<{ id: string }>; live_count: number }
        expect(r.agent.id).toBe(AGENT_A)
        expect(r.sessions.map((s) => s.id)).toEqual([rowA[0].id])
        expect(JSON.stringify(r)).not.toContain(rowB[0].id)
        expect(r.live_count).toBe(1)
      }
    })

    it('list_agent_sessions: a non-admin cannot name ANOTHER agent (nor itself by name), and self needs a bound token', async () => {
      const other = await invokeTool(noGrants('a'), env, 'list_agent_sessions', { agent: AGENT_B }, ORIGIN)
      expect(other.ok).toBe(false)
      if (!other.ok) expect(other.error).toBe('forbidden')
      const unboundSelf = await invokeTool(humanAuth([]), env, 'list_agent_sessions', { self: true }, ORIGIN)
      expect(unboundSelf.ok).toBe(false)
      const withBoth = await invokeTool(noGrants('a'), env, 'list_agent_sessions', { self: true, agent: AGENT_B }, ORIGIN)
      expect(withBoth.ok).toBe(false)
      // an agent that holds org admin and names another agent: still operator-principal-only
      const adminAgent = agentAuth('a', [{ member_id: MEM_A, scope_type: 'org', scope_id: null, capability: 'admin' } as CapabilityGrant])
      const named = await invokeTool(adminAgent, env, 'list_agent_sessions', { agent: AGENT_B }, ORIGIN)
      expect(named.ok).toBe(false)
      if (!named.ok) expect(named.error).toBe('operator_principal_required')
    })

    it('self:false is honoured: no implicit self on a bound token, falls to the admin path', async () => {
      const res = await invokeTool(noGrants('a'), env, 'list_agent_sessions', { self: false }, ORIGIN)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe('forbidden')
    })

    it('list_agent_sessions: an admin operator still lists any agent, and a non-self call without agent is a 400', async () => {
      const admin = humanAuth([{ member_id: MEM_ADMIN, scope_type: 'squad', scope_id: SQUAD_CORE, capability: 'admin' } as CapabilityGrant])
      const ok = await invokeTool(admin, env, 'list_agent_sessions', { agent: AGENT_B }, ORIGIN)
      expect(ok.ok).toBe(true)
      const missing = await invokeTool(admin, env, 'list_agent_sessions', {}, ORIGIN)
      expect(missing.ok).toBe(false)
      if (!missing.ok) expect(missing.status).toBe(400)
    })
  })

  // ───────────────────────── 4. self-end ─────────────────────────
  describe('agent self-end of its own session', () => {
    it('end_agent_session ends the caller\'s OWN session and leaves another agent\'s live', async () => {
      const a = await invokeTool(agentAuth('a', []), env, 'check_in', {}, ORIGIN)
      const b = await invokeTool(agentAuth('b', []), env, 'check_in', {}, ORIGIN)
      const idA = (a.result as { agent_session: { id: string } }).agent_session.id
      const idB = (b.result as { agent_session: { id: string } }).agent_session.id
      const end = await invokeTool(agentAuth('a', []), env, 'end_agent_session', {}, ORIGIN)
      expect(end.ok).toBe(true)
      expect(evaluateAgentSession((await loadAgentSessionById(env, TENANT, idA))!).ok).toBe(false)
      expect(evaluateAgentSession((await loadAgentSessionById(env, TENANT, idB))!).ok).toBe(true)
    })
  })
})
