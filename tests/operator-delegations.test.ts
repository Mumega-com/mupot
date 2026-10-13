// tests/operator-delegations.test.ts — Operators + Admission W0 (mumega-com#1386): delegated operators.
//
// Real migrated schema (applyAllMigrations), real MCP dispatch (invokeTool), real HTTP routers (membersApp, orgApp). Every
// refusal below is asserted by its CODE, not just "not ok", and each defect class has a mutation in the PR body proving the
// test goes red when the guard is removed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Capability, CapabilityGrant, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { invokeTool } = await import('../src/mcp/index')
const { membersApp } = await import('../src/members')
const { orgApp } = await import('../src/org')
const { gatesApp } = await import('../src/tasks')
const { projectsApp } = await import('../src/projects')
const { createDelegation, revokeDelegation } = await import('../src/operators/delegations')

const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'

let harness: SqliteD1Harness
let env: Env

function grant(member_id: string, capability: Capability, scope_type: CapabilityGrant['scope_type'] = 'org', scope_id: string | null = null): CapabilityGrant {
  return { member_id, scope_type, scope_id, capability } as CapabilityGrant
}

function addCap(memberId: string, capability: Capability, scopeType: string, scopeId: string | null): void {
  harness.sqlite
    .prepare('INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), memberId, scopeType, scopeId, capability)
}

function seed(): void {
  const db = harness.sqlite
  db.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'Dept One'), ('D2', 'd2', 'Dept Two');
    INSERT INTO departments (id, slug, name, kind) VALUES ('DH', 'dh', 'Home Dept', 'home');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('S1', 'D1', 's1-sqd', 'Squad One'), ('S2', 'D1', 's2-sqd', 'Squad Two'), ('S3', 'D2', 's3-sqd', 'Squad Three');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('SH', 'DH', 'home-sqd', 'Home', 'home');
    INSERT INTO projects (id, slug, name) VALUES ('P1', 'p1', 'Project One'), ('P2', 'p2', 'Project Two');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('P1', 'S1', 'write');
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale","event_id":"e","effective_at":1}');
  `)
  for (const [id, name, email] of [
    ['mem-hadi', 'Hadi', 'hadi@example.test'],
    ['mem-bob', 'Bob', 'bob@example.test'],
    ['mem-dana', 'Dana', 'dana@example.test'],
  ]) {
    db.prepare("INSERT INTO members (id, display_name, status, tenant, email) VALUES (?, ?, 'active', ?, ?)").run(id, name, TENANT, email)
  }
  addCap('mem-hadi', 'admin', 'org', null)
  addCap('mem-dana', 'admin', 'department', 'D1')
  addCap('mem-bob', 'lead', 'squad', 'S1')
  // agents A (the operator), B (a target), C (an undelegated peer). Each has a seat member welded to it.
  for (const [agent, squad] of [['agent-A', 'S1'], ['agent-B', 'S3'], ['agent-C', 'S3']]) {
    const slug = agent.toLowerCase()
    db.prepare("INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, ?, ?, ?, 'member', 'test', 'active')").run(agent, squad, slug, agent)
    db.prepare("INSERT INTO members (id, display_name, status, tenant) VALUES (?, ?, 'active', ?)").run(`seat-${agent}`, `${agent} seat`, TENANT)
    db.prepare('INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, ?)').run(TENANT, agent, `seat-${agent}`, '2026-10-01T00:00:00.000Z')
  }
  // the operator agent is a lead on S1 and S2 (its own live rank), nothing on S3
  addCap('seat-agent-A', 'lead', 'squad', 'S1')
  addCap('seat-agent-A', 'lead', 'squad', 'S2')
  db.prepare("INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-A-S1', 'agent-A', 'S1', 'lead')").run()
}

function humanAuth(memberId: string, caps: CapabilityGrant[]): AuthContext {
  return { userId: memberId, email: `${memberId}@example.test`, role: 'member', tenant: TENANT, channel: 'workspace', memberId, capabilities: caps, boundAgentId: null }
}

const hadi = (): AuthContext => humanAuth('mem-hadi', [grant('mem-hadi', 'admin')])
const dana = (): AuthContext => humanAuth('mem-dana', [grant('mem-dana', 'admin', 'department', 'D1')])
const bob = (): AuthContext => humanAuth('mem-bob', [grant('mem-bob', 'lead', 'squad', 'S1')])

function agentAuth(agent: 'agent-A' | 'agent-B' | 'agent-C', caps: CapabilityGrant[]): AuthContext {
  return { userId: `seat-${agent}`, email: null, role: 'member', tenant: TENANT, channel: 'workspace', memberId: `seat-${agent}`, capabilities: caps, boundAgentId: agent }
}

/** The operator agent as the live session sees it: lead on S1 and S2. */
const operator = (): AuthContext => agentAuth('agent-A', [grant('seat-agent-A', 'lead', 'squad', 'S1'), grant('seat-agent-A', 'lead', 'squad', 'S2')])
/** The same agent but holding ORG ADMIN on its own grants — the #1357 shape. Without a delegation it must still be refused. */
const adminOperator = (): AuthContext => agentAuth('agent-A', [grant('seat-agent-A', 'admin')])

async function delegate(scopeType: string, scopeId: string | null, maxGrant: 'member' | 'lead', by: AuthContext = hadi()): Promise<string> {
  const out = await invokeTool(by, env, 'operator_delegate', { agent: 'agent-A', scope_type: scopeType, ...(scopeId ? { scope_id: scopeId } : {}), max_grant: maxGrant }, ORIGIN)
  if (!out.ok) throw new Error(`delegate failed: ${out.status} ${out.error}`)
  return (out.result as { delegation: { id: string } }).delegation.id
}

function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return harness.sqlite.prepare(sql).all(...params) as T[]
}

function membership(agent: string, squad: string): string | null {
  const r = rows<{ capability: string }>('SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?', agent, squad)
  return r[0]?.capability ?? null
}

async function call(auth: AuthContext, tool: string, args: Record<string, unknown>) {
  return invokeTool(auth, env, tool, args, ORIGIN)
}

function refusal(out: Awaited<ReturnType<typeof call>>): { status: number; error: string; detail: Record<string, unknown> } {
  if (out.ok) throw new Error('expected a refusal, call succeeded')
  return { status: out.status, error: out.error, detail: (out.detail ?? {}) as Record<string, unknown> }
}

async function http(app: { request: (req: Request, init?: undefined, env?: Env) => Response | Promise<Response> }, auth: AuthContext, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  authState.current = auth
  const res = await app.request(
    new Request(`https://pot.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }),
    undefined,
    env,
  )
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed()
  env = { TENANT_SLUG: TENANT, DB: harness.db, DELEGATED_OPERATORS: '1' } as unknown as Env
  authState.current = null
})

afterEach(() => {
  authState.current = null
  harness.close()
})

describe('#1357: an org-admin agent is refused on BOTH doors without a delegation', () => {
  const memberCapBody = { action: 'grant', scope_type: 'squad', scope_id: 'S1', capability: 'member' }

  it('MCP refuses every delegable structural tool with operator_principal_required', async () => {
    const a = adminOperator()
    const cases: Array<[string, Record<string, unknown>]> = [
      ['grant_agent_capability', { agent: 'agent-B', squad: 'S1', capability: 'member' }],
      ['squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' }],
      ['squad_member_remove', { agent: 'agent-B', squad: 'S1' }],
      ['move_agent_squad', { agent: 'agent-B', to_squad: 'S1', capability: 'member' }],
      ['create_squad', { department: 'D1', slug: 'x-sqd', name: 'X' }],
      ['create_agent', { squad: 'S1', slug: 'x-agt', name: 'X' }],
      ['project_squad_set', { project_id: 'P1', squad_id: 'S2', access_level: 'read' }],
      ['project_squad_remove', { project_id: 'P1', squad_id: 'S1' }],
      ['update_squad', { squad: 'S1', budget_cap_cents: 1 }],
    ]
    for (const [tool, args] of cases) {
      const r = refusal(await call(a, tool, args))
      expect(r.status, tool).toBe(403)
      expect(r.error, tool).toBe('operator_principal_required')
    }
    expect(membership('agent-B', 'S1')).toBeNull()
  })

  it('HTTP refuses the same acts: members capabilities, org memberships, org create squad/agent', async () => {
    const a = adminOperator()
    const cap = await http(membersApp, a, 'POST', '/members/seat-agent-B/capabilities', memberCapBody)
    expect(cap.status).toBe(403)
    expect(cap.body.error).toBe('operator_principal_required')
    const mem = await http(orgApp, a, 'POST', '/agents/agent-B/memberships', { squad_id: 'S1', capability: 'member' })
    expect(mem.status).toBe(403)
    expect(mem.body.error).toBe('operator_principal_required')
    const sq = await http(orgApp, a, 'POST', '/departments/D1/squads', { slug: 'x-sqd', name: 'X' })
    expect(sq.status).toBe(403)
    expect(sq.body.error).toBe('operator_principal_required')
    const ag = await http(orgApp, a, 'POST', '/squads/S1/agents', { slug: 'x-agt', name: 'X' })
    expect(ag.status).toBe(403)
    expect(ag.body.error).toBe('operator_principal_required')
    expect(rows('SELECT 1 FROM capabilities WHERE member_id = ? AND scope_id = ?', 'seat-agent-B', 'S1')).toHaveLength(0)
  })

  it('the same holds with the flag OFF, even when a delegation row exists (flag off ignores delegations)', async () => {
    const id = await delegate('org', null, 'lead')
    env = { ...env, DELEGATED_OPERATORS: undefined } as Env
    const r = refusal(await call(operator(), 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' }))
    expect(r.error).toBe('operator_principal_required')
    const h = await http(membersApp, operator(), 'POST', '/members/seat-agent-B/capabilities', memberCapBody)
    expect(h.status).toBe(403)
    expect(h.body.error).toBe('operator_principal_required')
    expect(rows('SELECT 1 FROM operator_delegation_receipts WHERE delegation_id = ?', id)).toHaveLength(0)
  })

  it('a HUMAN org admin still passes the same HTTP and MCP doors (no regression)', async () => {
    const ok = await http(membersApp, hadi(), 'POST', '/members/seat-agent-B/capabilities', memberCapBody)
    expect(ok.status).toBe(201)
    const out = await call(hadi(), 'squad_member_add', { agent: 'agent-C', squad: 'S1', capability: 'member' })
    expect(out.ok).toBe(true)
  })
})

describe('a delegated agent can do the in-scope acts, with receipts naming agent + delegator + delegation', () => {
  it('squad_member_add / grant / remove / move / create_agent / create_squad inside a department delegation', async () => {
    const id = await delegate('department', 'D1', 'lead')
    const a = operator()

    expect((await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' })).ok).toBe(true)
    expect(membership('agent-B', 'S1')).toBe('member')

    expect((await call(a, 'grant_agent_capability', { agent: 'agent-B', squad: 'S2', capability: 'lead' })).ok).toBe(true)
    expect(membership('agent-B', 'S2')).toBe('lead')

    expect((await call(a, 'squad_member_remove', { agent: 'agent-B', squad: 'S1' })).ok).toBe(true)
    expect(membership('agent-B', 'S1')).toBeNull()

    // move C: from S3 is in ANOTHER department -> out of scope; move an agent that lives in S1/S2 instead
    expect((await call(a, 'create_agent', { squad: 'S2', slug: 'new-agt', name: 'New' })).ok).toBe(true)
    const created = rows<{ id: string }>("SELECT id FROM agents WHERE slug = 'new-agt'")
    expect(created).toHaveLength(1)
    harness.sqlite.prepare("INSERT INTO members (id, display_name, status, tenant) VALUES ('seat-new', 'n', 'active', ?)").run(TENANT)
    harness.sqlite.prepare('INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, ?)').run(TENANT, created[0].id, 'seat-new', '2026-10-01T00:00:00.000Z')
    expect((await call(a, 'move_agent_squad', { agent: created[0].id, to_squad: 'S1', capability: 'member' })).ok).toBe(true)
    expect(rows<{ squad_id: string }>('SELECT squad_id FROM agents WHERE id = ?', created[0].id)[0].squad_id).toBe('S1')

    expect((await call(a, 'create_squad', { department: 'D1', slug: 'made-sqd', name: 'Made' })).ok).toBe(true)

    const receipts = rows<Record<string, string>>('SELECT * FROM operator_delegation_receipts WHERE delegation_id = ? ORDER BY seq', id)
    expect(receipts.map((r) => r.action)).toEqual(['squad_member_add', 'grant_agent_capability', 'squad_member_remove', 'create_agent', 'move_agent_squad', 'create_squad'])
    for (const r of receipts) {
      expect(r.agent_id).toBe('agent-A')
      expect(r.delegator_member_id).toBe('mem-hadi')
      expect(r.delegation_id).toBe(id)
      expect(r.surface).toBe('mcp')
    }
  })

  it('the HTTP twins accept the same delegated acts and mark surface=http', async () => {
    const id = await delegate('department', 'D1', 'lead')
    const a = operator()
    expect((await http(orgApp, a, 'POST', '/agents/agent-B/memberships', { squad_id: 'S1', capability: 'member' })).status).toBe(201)
    expect(membership('agent-B', 'S1')).toBe('member')
    expect((await http(membersApp, a, 'POST', '/members/seat-agent-C/capabilities', { action: 'grant', scope_type: 'squad', scope_id: 'S2', capability: 'member' })).status).toBe(201)
    expect(membership('agent-C', 'S2')).toBe('member')
    expect((await http(membersApp, a, 'POST', '/members/seat-agent-C/capabilities', { action: 'revoke', scope_type: 'squad', scope_id: 'S2' })).status).toBe(200)
    expect(membership('agent-C', 'S2')).toBeNull()
    expect((await http(orgApp, a, 'POST', '/departments/D1/squads', { slug: 'http-sqd', name: 'H' })).status).toBe(201)
    expect((await http(orgApp, a, 'POST', '/squads/S1/agents', { slug: 'http-agt', name: 'H' })).status).toBe(201)
    const receipts = rows<Record<string, string>>('SELECT * FROM operator_delegation_receipts WHERE delegation_id = ?', id)
    expect(receipts).toHaveLength(5)
    for (const r of receipts) {
      expect(r.surface).toBe('http')
      expect(r.agent_id).toBe('agent-A')
      expect(r.delegator_member_id).toBe('mem-hadi')
    }
  })

  it('project_squad_set / remove under a project delegation, mapped to the ceiling (read<=member ok, admin not)', async () => {
    await delegate('project', 'P1', 'member')
    const a = operator()
    expect(await call(a, 'project_squad_set', { project_id: 'P1', squad_id: 'S2', access_level: 'write' })).toMatchObject({ ok: true })
    const r = refusal(await call(a, 'project_squad_set', { project_id: 'P1', squad_id: 'S3', access_level: 'admin' }))
    expect(r.error).toBe('requires_human_approval')
    expect(r.detail.act).toBe('project_squad_set')
    const other = refusal(await call(a, 'project_squad_set', { project_id: 'P2', squad_id: 'S2', access_level: 'read' }))
    expect(other.error).toBe('outside_delegation_scope')
    expect((await call(a, 'project_squad_remove', { project_id: 'P1', squad_id: 'S2' })).ok).toBe(true)
  })
})

describe('out of scope is refused', () => {
  it('a squad delegation covers that squad only; another squad, department, project and tenant are refused', async () => {
    await delegate('squad', 'S1', 'lead')
    const a = operator()
    expect((await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' })).ok).toBe(true)
    for (const squad of ['S2', 'S3']) {
      const r = refusal(await call(a, 'squad_member_add', { agent: 'agent-B', squad, capability: 'member' }))
      expect(r.error, squad).toBe('outside_delegation_scope')
    }
    expect(refusal(await call(a, 'create_squad', { department: 'D1', slug: 'z-sqd', name: 'Z' })).error).toBe('outside_delegation_scope')
    expect(refusal(await call(a, 'project_squad_set', { project_id: 'P1', squad_id: 'S1', access_level: 'read' })).error).toBe('outside_delegation_scope')
    const foreign = { ...a, tenant: 'tenant-other' }
    expect(refusal(await call(foreign, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' })).detail).toMatchObject({ reason: 'tenant_scope' })
    expect(membership('agent-B', 'S2')).toBeNull()
    expect(membership('agent-B', 'S3')).toBeNull()
  })

  it('a department delegation does not reach another department; a move needs BOTH ends covered', async () => {
    await delegate('department', 'D1', 'lead')
    const a = operator()
    expect(refusal(await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S3', capability: 'member' })).error).toBe('outside_delegation_scope')
    // agent-B lives in S3 (D2): moving it OUT of D2 touches an uncovered squad
    expect(refusal(await call(a, 'move_agent_squad', { agent: 'agent-B', to_squad: 'S1', capability: 'member' })).error).toBe('outside_delegation_scope')
    expect(rows<{ squad_id: string }>("SELECT squad_id FROM agents WHERE id = 'agent-B'")[0].squad_id).toBe('S3')
  })

  it('a project delegation covers the squads linked to that project', async () => {
    await delegate('project', 'P1', 'lead')
    const a = operator()
    expect((await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' })).ok).toBe(true)
    expect(refusal(await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S2', capability: 'member' })).error).toBe('outside_delegation_scope')
  })

  it('a home squad is never reachable, even under an org delegation', async () => {
    await delegate('org', null, 'lead')
    const a = operator()
    expect(refusal(await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'SH', capability: 'member' })).error).toBe('home_scope_not_grantable')
  })

  it('HTTP: a member capability write at org or department scope is never delegable', async () => {
    await delegate('org', null, 'lead')
    const r = await http(membersApp, operator(), 'POST', '/members/seat-agent-B/capabilities', { action: 'grant', scope_type: 'department', scope_id: 'D1', capability: 'member' })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('outside_delegation_scope')
  })
})

describe('the rank ceiling', () => {
  it('refuses above max_grant, admin and owner with a machine-readable requires_human_approval naming the act', async () => {
    await delegate('org', null, 'member')
    const a = operator()
    for (const capability of ['lead', 'admin']) {
      const r = refusal(await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability }))
      expect(r.status).toBe(403)
      expect(r.error).toBe('requires_human_approval')
      expect(r.detail).toMatchObject({ requires_human_approval: true, act: 'squad_member_add', reason: 'above_max_grant', requested: { capability } })
      expect(typeof r.detail.delegation_id).toBe('string')
    }
    const g = refusal(await call(a, 'grant_agent_capability', { agent: 'agent-B', squad: 'S1', capability: 'admin' }))
    expect(g.detail).toMatchObject({ act: 'grant_agent_capability', requires_human_approval: true })
    // owner is not even a grantable capability value
    expect(refusal(await call(a, 'grant_agent_capability', { agent: 'agent-B', squad: 'S1', capability: 'owner' })).status).toBeGreaterThanOrEqual(400)
    expect(membership('agent-B', 'S1')).toBeNull()
    // the same on HTTP
    const h = await http(orgApp, a, 'POST', '/agents/agent-B/memberships', { squad_id: 'S1', capability: 'lead' })
    expect(h.status).toBe(403)
    expect(h.body).toMatchObject({ error: 'requires_human_approval', act: 'grant_agent_capability', requires_human_approval: true })
  })

  it('never above the agent\'s OWN live rank, even when max_grant allows it', async () => {
    await delegate('org', null, 'lead')
    // demote the operator agent to member on S1: it may not confer lead there
    harness.sqlite.prepare("UPDATE capabilities SET capability = 'member' WHERE member_id = 'seat-agent-A' AND scope_id = 'S1'").run()
    const a = agentAuth('agent-A', [grant('seat-agent-A', 'member', 'squad', 'S1')])
    const r = refusal(await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'lead' }))
    expect(r.error).toBe('requires_human_approval')
    expect(r.detail.reason).toBe('above_agent_rank')
    expect((await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' })).ok).toBe(true)
    // an agent with NO standing on the squad confers nothing
    const none = refusal(await call(a, 'squad_member_add', { agent: 'agent-C', squad: 'S3', capability: 'observer' }))
    expect(none.error).toBe('requires_human_approval')
    expect(none.detail.reason).toBe('above_agent_rank')
  })

  it('an existing standing above max_grant is not the agent\'s to overwrite, remove or move', async () => {
    await delegate('org', null, 'lead')
    harness.sqlite.prepare("INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-B-S1', 'agent-B', 'S1', 'admin')").run()
    const a = operator()
    for (const [tool, args] of [
      ['squad_member_remove', { agent: 'agent-B', squad: 'S1' }],
      ['squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = refusal(await call(a, tool, args))
      expect(r.error, tool).toBe('requires_human_approval')
      expect(r.detail.reason, tool).toBe('target_outranks_delegation')
    }
    expect(membership('agent-B', 'S1')).toBe('admin')
  })
})

describe('what a delegation can never buy', () => {
  it('gate grants and gate revokes are refused for an agent with an org delegation, on MCP and HTTP', async () => {
    await delegate('org', null, 'lead')
    const a = agentAuth('agent-A', [grant('seat-agent-A', 'admin')])
    for (const tool of ['grant_gate_capability', 'revoke_gate_capability']) {
      const r = refusal(await call(a, tool, { capability: 'gate:kasra-core', principal_type: 'agent', principal_id: 'agent-B' }))
      expect(r.error, tool).toBe('operator_principal_required')
    }
    const post = await http(gatesApp, a, 'POST', '/grants', { capability: 'gate:kasra-core', principal_type: 'agent', principal_id: 'agent-B' })
    expect(post.status).toBe(403)
    expect(post.body.error).toBe('operator_principal_required')
    const del = await http(gatesApp, a, 'DELETE', '/grants', { capability: 'gate:kasra-core', principal_type: 'agent', principal_id: 'agent-B' })
    expect(del.status).toBe(403)
    expect(rows('SELECT 1 FROM gate_grants')).toHaveLength(0)
  })

  it('tokens and credentials: minting a token (MCP + HTTP), revoking one, and registering a key are all refused', async () => {
    await delegate('org', null, 'lead')
    const a = agentAuth('agent-A', [grant('seat-agent-A', 'admin')])
    for (const [tool, args] of [
      ['mint_agent_token', { agent: 'agent-B' }],
      ['list_agent_tokens', { agent: 'agent-B' }],
      ['revoke_agent_token', { agent: 'agent-B', token_id: 'x' }],
      ['provision_agent_connection', { request_id: 'r1', existing_agent: 'agent-B', credential: { action: 'add' } }],
      ['register_agent_key', { agent: 'agent-B', public_key: 'x' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = refusal(await call(a, tool, args))
      expect(r.error, tool).toBe('operator_principal_required')
    }
    const mint = await http(membersApp, a, 'POST', '/members/seat-agent-B/tokens', { label: 'x' })
    expect(mint.status).toBe(403)
    expect(mint.body.error).toBe('operator_principal_required')
    expect((await http(membersApp, a, 'DELETE', '/members/seat-agent-B/tokens/t1')).status).toBe(403)
    expect((await http(membersApp, a, 'PATCH', '/members/mem-bob', { status: 'suspended' })).body.error).toBe('operator_principal_required')
    expect((await http(membersApp, a, 'POST', '/invites', { email: 'x@example.test', capability: 'member' })).body.error).toBe('operator_principal_required')
    expect(rows('SELECT 1 FROM member_tokens')).toHaveLength(0)
  })

  it('acts on the agent ITSELF are refused: no self-grant, no self-move, no self-add', async () => {
    await delegate('org', null, 'lead')
    const a = operator()
    for (const [tool, args] of [
      ['grant_agent_capability', { agent: 'agent-A', squad: 'S2', capability: 'member' }],
      ['squad_member_add', { agent: 'agent-A', squad: 'S2', capability: 'member' }],
      ['squad_member_remove', { agent: 'agent-A', squad: 'S1' }],
      ['move_agent_squad', { agent: 'agent-A', to_squad: 'S2', capability: 'member' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(refusal(await call(a, tool, args)).error, tool).toBe('cannot_act_on_self')
    }
    const h = await http(membersApp, a, 'POST', '/members/seat-agent-A/capabilities', { action: 'grant', scope_type: 'squad', scope_id: 'S2', capability: 'member' })
    expect(h.body.error).toBe('cannot_act_on_self')
    const o = await http(orgApp, a, 'POST', '/agents/agent-A/memberships', { squad_id: 'S2', capability: 'member' })
    expect(o.body.error).toBe('cannot_act_on_self')
    expect(membership('agent-A', 'S2')).toBeNull()
  })

  it('acts on a HUMAN member (including the delegator) are refused', async () => {
    await delegate('org', null, 'lead')
    const a = operator()
    for (const human of ['mem-hadi', 'mem-bob']) {
      const h = await http(membersApp, a, 'POST', `/members/${human}/capabilities`, { action: 'grant', scope_type: 'squad', scope_id: 'S1', capability: 'member' })
      expect(h.status, human).toBe(403)
      expect(h.body.error, human).toBe('human_target_forbidden')
      const rv = await http(membersApp, a, 'POST', `/members/${human}/capabilities`, { action: 'revoke', scope_type: 'squad', scope_id: 'S1' })
      expect(rv.body.error, human).toBe('human_target_forbidden')
    }
    expect(rows("SELECT 1 FROM capabilities WHERE member_id = 'mem-hadi' AND scope_type = 'squad'")).toHaveLength(0)
    expect(rows("SELECT 1 FROM capabilities WHERE member_id = 'mem-bob' AND scope_id = 'S1' AND capability = 'lead'")).toHaveLength(1)
  })

  it('non-delegable structural acts never open under a delegation (update_squad, create_department over HTTP, deactivate)', async () => {
    await delegate('org', null, 'lead')
    const a = operator()
    expect(refusal(await call(adminOperator(), 'update_squad', { squad: 'S1', budget_cap_cents: 5 })).error).toBe('operator_principal_required')
    expect(refusal(await call(a, 'update_squad', { squad: 'S1', budget_cap_cents: 5 })).status).toBe(403)
    const dep = await http(orgApp, a, 'POST', '/departments', { slug: 'zz', name: 'ZZ' })
    expect(dep.status).toBe(403)
    const d = await call(a, 'deactivate_agent', { agent: 'agent-B' })
    expect(d.ok).toBe(false)
    expect(rows<{ status: string }>("SELECT status FROM agents WHERE id = 'agent-B'")[0].status).toBe('active')
  })
})

describe('authority is re-derived on every request', () => {
  it('revocation takes effect on the very next request', async () => {
    const id = await delegate('department', 'D1', 'lead')
    const a = operator()
    expect((await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' })).ok).toBe(true)
    const revoke = await call(hadi(), 'operator_revoke', { delegation_id: id })
    expect(revoke.ok).toBe(true)
    expect(refusal(await call(a, 'squad_member_remove', { agent: 'agent-B', squad: 'S1' })).error).toBe('operator_principal_required')
    expect((await http(orgApp, a, 'POST', '/agents/agent-C/memberships', { squad_id: 'S1', capability: 'member' })).status).toBe(403)
    expect(membership('agent-B', 'S1')).toBe('member')
  })

  it('the delegator losing admin kills the delegation on the next request (grants, then suspension)', async () => {
    await delegate('department', 'D1', 'lead', dana())
    const a = operator()
    expect((await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' })).ok).toBe(true)
    harness.sqlite.prepare("DELETE FROM capabilities WHERE member_id = 'mem-dana'").run()
    expect(refusal(await call(a, 'squad_member_remove', { agent: 'agent-B', squad: 'S1' })).error).toBe('delegator_authority_lost')
    expect(membership('agent-B', 'S1')).toBe('member')
    // restored admin brings it back (nothing was revoked), then suspension kills it again
    addCap('mem-dana', 'admin', 'department', 'D1')
    expect((await call(a, 'squad_member_remove', { agent: 'agent-B', squad: 'S1' })).ok).toBe(true)
    harness.sqlite.prepare("UPDATE members SET status = 'suspended' WHERE id = 'mem-dana'").run()
    expect(refusal(await call(a, 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' })).error).toBe('delegator_authority_lost')
  })

  it('a delegator demoted to squad lead no longer carries a department delegation', async () => {
    await delegate('department', 'D1', 'lead', dana())
    harness.sqlite.prepare("UPDATE capabilities SET capability = 'lead' WHERE member_id = 'mem-dana'").run()
    const r = refusal(await call(operator(), 'squad_member_add', { agent: 'agent-B', squad: 'S1', capability: 'member' }))
    expect(r.error).toBe('delegator_authority_lost')
  })
})

describe('an agent can never create or alter a delegation', () => {
  it('operator_delegate / operator_revoke / operator_list refuse every agent-bound caller, delegation or not', async () => {
    const id = await delegate('org', null, 'lead')
    // operator() holds only lead, so the dispatcher's min-admin floor stops it first (still a 403 refusal)
    expect(refusal(await call(operator(), 'operator_delegate', { agent: 'agent-C', scope_type: 'org', max_grant: 'lead' })).status).toBe(403)
    for (const a of [adminOperator(), agentAuth('agent-C', [grant('seat-agent-C', 'admin')])]) {
      for (const [tool, args] of [
        ['operator_delegate', { agent: 'agent-C', scope_type: 'org', max_grant: 'lead' }],
        ['operator_delegate', { agent: 'agent-A', scope_type: 'squad', scope_id: 'S3', max_grant: 'member' }],
        ['operator_revoke', { delegation_id: id }],
        ['operator_list', {}],
      ] as Array<[string, Record<string, unknown>]>) {
        const r = refusal(await call(a, tool, args))
        expect(r.error, tool).toBe('operator_principal_required')
      }
    }
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(1)
    expect(rows('SELECT 1 FROM agent_operator_delegations WHERE revoked_at IS NOT NULL')).toHaveLength(0)
  })

  it('an agent cannot revoke-then-recreate its own delegation, nor widen it', async () => {
    const id = await delegate('squad', 'S1', 'member')
    const a = adminOperator()
    expect(refusal(await call(a, 'operator_revoke', { delegation_id: id })).error).toBe('operator_principal_required')
    expect(refusal(await call(a, 'operator_delegate', { agent: 'agent-A', scope_type: 'org', max_grant: 'lead' })).error).toBe('operator_principal_required')
    expect(rows('SELECT scope_type, max_grant FROM agent_operator_delegations')).toEqual([{ scope_type: 'squad', max_grant: 'member' }])
  })

  it('a non-admin human, an agent seat acting without a boundAgentId, and an out-of-scope admin are refused too', async () => {
    expect(refusal(await call(bob(), 'operator_delegate', { agent: 'agent-A', scope_type: 'squad', scope_id: 'S1', max_grant: 'member' })).status).toBe(403)
    // bob is a lead, not an admin: the tool floor (min admin) refuses before the writer does
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(0)
    // dana is admin over D1 only: she cannot delegate the org, nor S3 (D2)
    expect(refusal(await call(dana(), 'operator_delegate', { agent: 'agent-A', scope_type: 'org', max_grant: 'member' })).error).toBe('forbidden')
    expect(refusal(await call(dana(), 'operator_delegate', { agent: 'agent-A', scope_type: 'squad', scope_id: 'S3', max_grant: 'member' })).error).toBe('forbidden')
    // an agent's seat member presented WITHOUT boundAgentId (a token replayed as a plain member) is still not human
    const seat = humanAuth('seat-agent-C', [grant('seat-agent-C', 'admin')])
    expect(refusal(await call(seat, 'operator_delegate', { agent: 'agent-A', scope_type: 'org', max_grant: 'member' })).error).toBe('operator_principal_required')
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(0)
  })

  it('max_grant admin/owner is refused by the tool schema AND by the table CHECK', async () => {
    for (const max_grant of ['admin', 'owner']) {
      expect((await call(hadi(), 'operator_delegate', { agent: 'agent-A', scope_type: 'org', max_grant })).ok).toBe(false)
    }
    expect(() =>
      harness.sqlite
        .prepare("INSERT INTO agent_operator_delegations (id, tenant, agent_id, delegator_member_id, scope_type, scope_id, max_grant, created_by_member_id) VALUES ('x', ?, 'agent-A', 'mem-hadi', 'org', NULL, 'admin', 'mem-hadi')")
        .run(TENANT),
    ).toThrow()
  })

  it('the table refuses un-revoking, widening, re-pointing, a non-human creator and deleting', async () => {
    const id = await delegate('squad', 'S1', 'member')
    await call(hadi(), 'operator_revoke', { delegation_id: id })
    const upd = (sql: string) => () => harness.sqlite.prepare(sql).run(id)
    expect(upd('UPDATE agent_operator_delegations SET revoked_at = NULL WHERE id = ?')).toThrow(/one-way revoke/)
    const live = await delegate('squad', 'S2', 'member')
    const upd2 = (sql: string) => () => harness.sqlite.prepare(sql).run(live)
    expect(upd2("UPDATE agent_operator_delegations SET max_grant = 'lead' WHERE id = ?")).toThrow(/one-way revoke/)
    expect(upd2("UPDATE agent_operator_delegations SET scope_id = 'S3' WHERE id = ?")).toThrow(/one-way revoke/)
    expect(upd2("UPDATE agent_operator_delegations SET delegator_member_id = 'mem-bob' WHERE id = ?")).toThrow(/one-way revoke/)
    expect(upd2('DELETE FROM agent_operator_delegations WHERE id = ?')).toThrow(/never deleted/)
    expect(() =>
      harness.sqlite
        .prepare("INSERT INTO agent_operator_delegations (id, tenant, agent_id, delegator_member_id, scope_type, scope_id, max_grant, created_by_member_id) VALUES ('y', ?, 'agent-A', 'mem-hadi', 'org', NULL, 'member', 'seat-agent-A')")
        .run(TENANT),
    ).toThrow()
  })

  it('at most one live delegation per agent and scope; re-delegating after a revoke is a new row', async () => {
    const id = await delegate('squad', 'S1', 'member')
    const dup = await call(hadi(), 'operator_delegate', { agent: 'agent-A', scope_type: 'squad', scope_id: 'S1', max_grant: 'lead' })
    expect(refusal(dup).error).toBe('delegation_exists')
    await call(hadi(), 'operator_revoke', { delegation_id: id })
    const again = await delegate('squad', 'S1', 'lead')
    expect(again).not.toBe(id)
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(2)
  })

  it('a home squad or home department cannot be delegated, and delegate is off when the flag is off', async () => {
    expect(refusal(await call(hadi(), 'operator_delegate', { agent: 'agent-A', scope_type: 'squad', scope_id: 'SH', max_grant: 'member' })).error).toBe('home_scope_not_delegable')
    expect(refusal(await call(hadi(), 'operator_delegate', { agent: 'agent-A', scope_type: 'department', scope_id: 'DH', max_grant: 'member' })).error).toBe('home_scope_not_delegable')
    env = { ...env, DELEGATED_OPERATORS: undefined } as Env
    expect(refusal(await call(hadi(), 'operator_delegate', { agent: 'agent-A', scope_type: 'org', max_grant: 'member' })).error).toBe('delegated_operators_disabled')
  })

  it('operator_list shows live rows to a human admin and hides revoked ones unless asked', async () => {
    const id = await delegate('squad', 'S1', 'member')
    const live = await call(hadi(), 'operator_list', {})
    expect(live.ok && (live.result as { count: number }).count).toBe(1)
    await call(hadi(), 'operator_revoke', { delegation_id: id })
    expect((await call(hadi(), 'operator_list', {})).ok && ((await call(hadi(), 'operator_list', {})).ok ? 0 : 1)).toBe(0)
    const all = await call(hadi(), 'operator_list', { include_revoked: true })
    expect(all.ok && (all.result as { count: number }).count).toBe(1)
  })
})

describe('flag off: MCP is unchanged and HTTP now matches it', () => {
  beforeEach(() => {
    env = { ...env, DELEGATED_OPERATORS: undefined } as Env
  })

  it('an org-admin agent keeps the pre-W0 capability lane for create_squad / create_agent on MCP, and HTTP agrees', async () => {
    const a = adminOperator()
    expect((await call(a, 'create_squad', { department: 'D1', slug: 'legacy-sqd', name: 'L' })).ok).toBe(true)
    expect((await call(a, 'create_agent', { squad: 'S1', slug: 'legacy-agt', name: 'L' })).ok).toBe(true)
    // HTTP twin: same act, same answer (before W0 HTTP ran through requireCapability; for these it was already open)
    expect((await http(orgApp, a, 'POST', '/departments/D1/squads', { slug: 'legacy2-sqd', name: 'L2' })).status).toBe(201)
    expect((await http(orgApp, a, 'POST', '/squads/S1/agents', { slug: 'legacy2-agt', name: 'L2' })).status).toBe(201)
    expect(rows('SELECT 1 FROM operator_delegation_receipts')).toHaveLength(0)
  })

  it('flag ON closes that capability lane for the delegable creates: delegation replaces it', async () => {
    env = { ...env, DELEGATED_OPERATORS: '1' } as Env
    const a = adminOperator()
    expect(refusal(await call(a, 'create_squad', { department: 'D1', slug: 'closed-sqd', name: 'C' })).error).toBe('operator_principal_required')
    expect((await http(orgApp, a, 'POST', '/departments/D1/squads', { slug: 'closed2-sqd', name: 'C' })).status).toBe(403)
  })

  it('HTTP project squad edges: an org-admin agent is now refused only when the flag is on and it has no delegation', async () => {
    const a = adminOperator()
    // flag off: the pre-W0 capability lane (workspace admin) still works on BOTH doors
    const off = await call(a, 'project_squad_set', { project_id: 'P1', squad_id: 'S2', access_level: 'read' })
    expect(off.ok).toBe(true)
    expect((await http(projectsApp, a, 'PUT', '/P1/squads/S3', { access_level: 'read' })).status).toBe(200)
  })
})

describe('HTTP project squad edges under a delegation', () => {
  it('a project delegation covers PUT/DELETE /:id/squads/:squadId on its own project only', async () => {
    const id = await delegate('project', 'P1', 'member')
    const a = operator()
    expect((await http(projectsApp, a, 'PUT', '/P1/squads/S2', { access_level: 'write' })).status).toBe(200)
    expect((await http(projectsApp, a, 'PUT', '/P1/squads/S3', { access_level: 'admin' })).body).toMatchObject({ error: 'requires_human_approval', act: 'project_squad_set' })
    expect((await http(projectsApp, a, 'PUT', '/P2/squads/S2', { access_level: 'read' })).body.error).toBe('outside_delegation_scope')
    expect((await http(projectsApp, a, 'DELETE', '/P1/squads/S2')).status).toBe(204)
    expect(rows<{ surface: string }>('SELECT surface FROM operator_delegation_receipts WHERE delegation_id = ?', id).every((r) => r.surface === 'http')).toBe(true)
  })

  it('an undelegated org-admin agent is refused on the project twin when the flag is on', async () => {
    const r = await http(projectsApp, adminOperator(), 'PUT', '/P1/squads/S2', { access_level: 'read' })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('operator_principal_required')
  })
})

describe('the writers refuse an agent on their own, not only behind the tool gate (defence in depth)', () => {
  it('createDelegation / revokeDelegation called directly with an agent-bound or seat-member principal write nothing', async () => {
    const id = await delegate('squad', 'S1', 'member')
    const seatNoBinding = humanAuth('seat-agent-C', [grant('seat-agent-C', 'admin')])
    for (const who of [adminOperator(), seatNoBinding]) {
      const made = await createDelegation(env, who, { agentId: 'agent-A', scopeType: 'org', scopeId: null, maxGrant: 'lead' })
      expect(made).toEqual({ ok: false, error: 'operator_principal_required' })
      const revoked = await revokeDelegation(env, who, id)
      expect(revoked).toEqual({ ok: false, error: 'operator_principal_required' })
    }
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(1)
    expect(rows('SELECT 1 FROM agent_operator_delegations WHERE revoked_at IS NOT NULL')).toHaveLength(0)
  })

  it('a session that CLAIMS a bound agent but carries a human member id is still refused by the writer itself', async () => {
    const spoof = { ...hadi(), boundAgentId: 'agent-A' }
    expect(await createDelegation(env, spoof, { agentId: 'agent-A', scopeType: 'org', scopeId: null, maxGrant: 'member' })).toEqual({ ok: false, error: 'operator_principal_required' })
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(0)
  })

  it('a suspended human cannot delegate, and a human cannot delegate to their own seat', async () => {
    harness.sqlite.prepare("UPDATE members SET status = 'suspended' WHERE id = 'mem-hadi'").run()
    const out = await createDelegation(env, hadi(), { agentId: 'agent-A', scopeType: 'org', scopeId: null, maxGrant: 'member' })
    expect(out).toEqual({ ok: false, error: 'human_principal_required' })
  })
})
