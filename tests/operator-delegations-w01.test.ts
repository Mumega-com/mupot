// tests/operator-delegations-w01.test.ts — Operators + Admission W0.1 (mumega-com#1386, follow-ups tracked in mupot#1878).
//
// Real migrated schema (applyAllMigrations), real MCP dispatch (invokeTool), real HTTP routers. Each describe block is one
// defect class from the W0 gate; the mutation that proves its test goes red is named in the block's header comment.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
const { projectsApp } = await import('../src/projects')

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
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('S1', 'D1', 's1-sqd', 'Squad One'), ('S2', 'D1', 's2-sqd', 'Squad Two'), ('S3', 'D2', 's3-sqd', 'Squad Three'),
      ('S4', 'D2', 's4-sqd', 'Squad Four');
    INSERT INTO projects (id, slug, name) VALUES ('P1', 'p1', 'Project One'), ('P2', 'p2', 'Project Two');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('P1', 'S1', 'write');
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale","event_id":"e","effective_at":1}');
  `)
  for (const [id, name, email] of [
    ['mem-hadi', 'Hadi', 'hadi@example.test'],
    ['mem-dana', 'Dana', 'dana@example.test'],
  ]) {
    db.prepare("INSERT INTO members (id, display_name, status, tenant, email) VALUES (?, ?, 'active', ?, ?)").run(id, name, TENANT, email)
  }
  addCap('mem-hadi', 'admin', 'org', null)
  addCap('mem-dana', 'admin', 'department', 'D1')
  for (const [agent, squad] of [['agent-A', 'S1'], ['agent-B', 'S3'], ['agent-C', 'S3']]) {
    const slug = agent.toLowerCase()
    db.prepare("INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, ?, ?, ?, 'member', 'test', 'active')").run(agent, squad, slug, agent)
    db.prepare("INSERT INTO members (id, display_name, status, tenant) VALUES (?, ?, 'active', ?)").run(`seat-${agent}`, `${agent} seat`, TENANT)
    db.prepare('INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, ?)').run(TENANT, agent, `seat-${agent}`, '2026-10-01T00:00:00.000Z')
  }
  // the operator agent is a lead on S1, S2 and S4 (its own live rank)
  addCap('seat-agent-A', 'lead', 'squad', 'S1')
  addCap('seat-agent-A', 'lead', 'squad', 'S2')
  addCap('seat-agent-A', 'lead', 'squad', 'S4')
  db.prepare("INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-A-S1', 'agent-A', 'S1', 'lead')").run()
}

function humanAuth(memberId: string, caps: CapabilityGrant[]): AuthContext {
  return { userId: memberId, email: `${memberId}@example.test`, role: 'member', tenant: TENANT, channel: 'workspace', memberId, capabilities: caps, boundAgentId: null }
}

const hadi = (): AuthContext => humanAuth('mem-hadi', [grant('mem-hadi', 'admin')])
const dana = (): AuthContext => humanAuth('mem-dana', [grant('mem-dana', 'admin', 'department', 'D1')])

function operator(): AuthContext {
  return {
    userId: 'seat-agent-A', email: null, role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'seat-agent-A',
    capabilities: [grant('seat-agent-A', 'lead', 'squad', 'S1'), grant('seat-agent-A', 'lead', 'squad', 'S2'), grant('seat-agent-A', 'lead', 'squad', 'S4')],
    boundAgentId: 'agent-A',
  }
}

async function call(auth: AuthContext, tool: string, args: Record<string, unknown>) {
  return invokeTool(auth, env, tool, args, ORIGIN)
}

async function delegate(scopeType: string, scopeId: string | null, maxGrant: 'member' | 'lead', by: AuthContext = hadi()): Promise<string> {
  const out = await call(by, 'operator_delegate', { agent: 'agent-A', scope_type: scopeType, ...(scopeId ? { scope_id: scopeId } : {}), max_grant: maxGrant })
  if (!out.ok) throw new Error(`delegate failed: ${out.status} ${out.error}`)
  return (out.result as { delegation: { id: string } }).delegation.id
}

function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return harness.sqlite.prepare(sql).all(...params) as T[]
}

function membership(agent: string, squad: string): string | null {
  return rows<{ capability: string }>('SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?', agent, squad)[0]?.capability ?? null
}

interface Receipt {
  id: string
  delegation_id: string
  action: string
  surface: string
  outcome: string
  detail: string
}

function receipts(action?: string): Receipt[] {
  return action
    ? rows<Receipt>('SELECT * FROM operator_delegation_receipts WHERE action = ? ORDER BY seq', action)
    : rows<Receipt>('SELECT * FROM operator_delegation_receipts ORDER BY seq')
}

function refusal(out: Awaited<ReturnType<typeof call>>): { status: number; error: string; detail: Record<string, unknown> } {
  if (out.ok) throw new Error('expected a refusal, call succeeded')
  return { status: out.status, error: out.error, detail: (out.detail ?? {}) as Record<string, unknown> }
}

async function http(app: { request: (req: Request, init?: undefined, env?: Env) => Response | Promise<Response> }, auth: AuthContext, method: string, path: string, body?: unknown, raw?: string) {
  authState.current = auth
  const res = await app.request(
    new Request(`https://pot.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
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

// ── 1. the target's identity must not vanish ─────────────────────────────────────────────────────────────────────
// Mutation: make agentIdForSeatMember join `members.status = 'active'` (the old active-only resolver) -> the HTTP and MCP
// suspended-seat tests go red (the guard is skipped / the act is judged against nothing).
describe('P1: a suspended seat member does not make the target agent\'s standing vanish', () => {
  const body = { action: 'grant', scope_type: 'squad', scope_id: 'S2', capability: 'member' }

  beforeEach(() => {
    // agent-B's seat holds ORG ADMIN (above any delegation's max_grant), then the seat member is suspended
    addCap('seat-agent-B', 'admin', 'org', null)
    harness.sqlite.prepare("UPDATE members SET status = 'suspended' WHERE id = 'seat-agent-B'").run()
  })

  it('HTTP members capabilities: a lead-capped delegate is refused on a suspended seat whose agent outranks the ceiling', async () => {
    await delegate('org', null, 'lead')
    const out = await http(membersApp, operator(), 'POST', '/members/seat-agent-B/capabilities', body)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('requires_human_approval')
    expect(out.body.reason).toBe('target_outranks_delegation')
    expect(rows("SELECT 1 FROM capabilities WHERE member_id = 'seat-agent-B' AND scope_type = 'squad'")).toHaveLength(0)
    expect(receipts('member_capability_grant').map((r) => r.outcome)).toEqual(['refused'])
  })

  it('MCP squad_member_add / move_agent_squad: same refusal for the same suspended seat', async () => {
    await delegate('org', null, 'lead')
    const add = refusal(await call(operator(), 'squad_member_add', { agent: 'agent-B', squad: 'S2', capability: 'member' }))
    expect(add.error).toBe('requires_human_approval')
    expect(add.detail.reason).toBe('target_outranks_delegation')
    const move = refusal(await call(operator(), 'move_agent_squad', { agent: 'agent-B', to_squad: 'S2', capability: 'member' }))
    expect(move.detail.reason).toBe('target_outranks_delegation')
    expect(membership('agent-B', 'S2')).toBeNull()
  })

  it('a suspended seat that does NOT outrank the ceiling still cannot take a raw capabilities row (agent_identity_inactive)', async () => {
    harness.sqlite.prepare("DELETE FROM capabilities WHERE member_id = 'seat-agent-B'").run()
    await delegate('org', null, 'lead')
    const out = await http(membersApp, operator(), 'POST', '/members/seat-agent-B/capabilities', body)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('agent_identity_inactive')
    expect(rows("SELECT 1 FROM capabilities WHERE member_id = 'seat-agent-B' AND scope_type = 'squad'")).toHaveLength(0)
    expect(receipts('member_capability_grant').map((r) => r.outcome)).toEqual(['refused'])
  })

  it('a site that names neither the agent nor a seat member for a standing-touching act is refused (fail closed)', async () => {
    await delegate('org', null, 'lead')
    const { authorizeStructuralWrite } = await import('../src/operators/chokepoint')
    const v = await authorizeStructuralWrite(env, operator(), 'squad_member_add', { squadId: 'S2', capability: 'member' })
    expect(v.kind).toBe('refused')
    if (v.kind === 'refused') expect(v.error).toBe('target_identity_required')
  })
})

// ── 2. overlapping delegations ───────────────────────────────────────────────────────────────────────────────────
// Mutation: stop the candidate loop at the first covering row (the old `break`) -> the "newer squad/lead row" test goes red.
describe('P2: overlapping delegations — the one that permits the act with the highest ceiling is used', () => {
  it('an older org/member row does not shadow a newer squad/lead row', async () => {
    const orgId = await delegate('org', null, 'member')
    // time moves on so the squad row is strictly newer
    harness.sqlite.prepare("UPDATE operator_delegation_receipts SET created_at = created_at").run()
    const squadId = await delegate('squad', 'S2', 'lead')
    const out = await call(operator(), 'squad_member_add', { agent: 'agent-B', squad: 'S2', capability: 'lead' })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(membership('agent-B', 'S2')).toBe('lead')
    const [r] = receipts('squad_member_add')
    expect(r.delegation_id).toBe(squadId) // the one USED is recorded, not the oldest
    const detail = JSON.parse(r.detail) as { considered_delegation_ids: string[]; delegations: Array<{ id: string }> }
    expect(detail.considered_delegation_ids.sort()).toEqual([orgId, squadId].sort())
    expect(detail.delegations.map((d) => d.id)).toEqual([squadId])
  })

  it('an act above every overlapping row is still refused', async () => {
    await delegate('org', null, 'member')
    await delegate('squad', 'S2', 'lead')
    const out = refusal(await call(operator(), 'squad_member_add', { agent: 'agent-B', squad: 'S2', capability: 'admin' }))
    expect(out.error).toBe('requires_human_approval')
    expect(membership('agent-B', 'S2')).toBeNull()
  })

  it('the row whose delegator lost admin is skipped; the live overlapping row decides', async () => {
    await delegate('squad', 'S2', 'lead', dana())
    const orgId = await delegate('org', null, 'member')
    harness.sqlite.prepare("DELETE FROM capabilities WHERE member_id = 'mem-dana'").run()
    const out = await call(operator(), 'squad_member_add', { agent: 'agent-B', squad: 'S2', capability: 'member' })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(receipts('squad_member_add')[0].delegation_id).toBe(orgId)
  })
})

// ── 3. audit completeness ────────────────────────────────────────────────────────────────────────────────────────
describe('P2: project_squad_set records BOTH delegations (project + the squad/department one) and both delegators', () => {
  it('applied receipt names the project delegation, the attach-squad delegation and their delegators', async () => {
    const projectId = await delegate('project', 'P1', 'member', hadi())
    const deptId = await delegate('department', 'D1', 'lead', dana())
    const out = await call(operator(), 'project_squad_set', { project_id: 'P1', squad_id: 'S2', access_level: 'read' })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const [r] = receipts('project_squad_set')
    expect(r.outcome).toBe('applied')
    const detail = JSON.parse(r.detail) as { delegations: Array<{ id: string; delegator_member_id: string; role: string }> }
    expect(detail.delegations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: projectId, delegator_member_id: 'mem-hadi', role: 'covering' }),
      expect.objectContaining({ id: deptId, delegator_member_id: 'mem-dana', role: 'attach_squad' }),
    ]))
    expect(detail.delegations).toHaveLength(2)
  })

  it('a refused attach (squad not covered) still records the delegation that covered the project', async () => {
    const projectId = await delegate('project', 'P1', 'member')
    const out = refusal(await call(operator(), 'project_squad_set', { project_id: 'P1', squad_id: 'S3', access_level: 'read' }))
    expect(out.detail.reason).toBe('attached_squad_not_covered')
    const [r] = receipts('project_squad_set')
    expect(r.outcome).toBe('refused')
    expect(r.delegation_id).toBe(projectId)
  })
})

// ── 4. move TOCTOU ───────────────────────────────────────────────────────────────────────────────────────────────
// Mutations: (a) delete the delegatedTargetDrift call in move_agent_squad -> the drift test goes red (error is no longer
// target_changed); (b) delete the guard statement in moveAgentSquad's batch -> the write-binding test goes red (the
// destination grants land although the agent was no longer in the gate's source squad).
describe('P2: the move source squad resolved at the gate is bound into the write', () => {
  /** Run `effect` once, the first time a statement whose SQL contains `needle` is prepared. */
  function interceptOnce(needle: string, effect: () => void): void {
    const db = harness.db
    const prepare = db.prepare.bind(db)
    let fired = false
    env = {
      ...env,
      DB: new Proxy(db, {
        get(target, prop, recv) {
          if (prop === 'prepare') {
            return (sql: string) => {
              if (!fired && sql.includes(needle)) {
                fired = true
                effect()
              }
              return prepare(sql)
            }
          }
          return Reflect.get(target, prop, recv)
        },
      }),
    }
  }

  beforeEach(async () => {
    await delegate('org', null, 'lead')
  })

  it('the agent moved after the gate resolved it: refused target_changed, nothing written', async () => {
    interceptOnce('INSERT INTO operator_delegation_receipts', () => {
      harness.sqlite.prepare("UPDATE agents SET squad_id = 'S4' WHERE id = 'agent-B'").run()
    })
    const out = refusal(await call(operator(), 'move_agent_squad', { agent: 'agent-B', to_squad: 'S2', capability: 'member' }))
    expect(out.error).toBe('target_changed')
    expect(rows("SELECT squad_id FROM agents WHERE id = 'agent-B'")).toEqual([{ squad_id: 'S4' }])
    expect(membership('agent-B', 'S2')).toBeNull()
    expect(receipts('move_agent_squad').map((r) => r.outcome)).toEqual(['refused'])
  })

  it('the agent moves AFTER every check and before the write batch: the batch refuses and writes NOTHING', async () => {
    harness.sqlite.prepare("INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-B-S3', 'agent-B', 'S3', 'member')").run()
    interceptOnce('INSERT INTO agent_audit', () => {
      harness.sqlite.prepare("UPDATE agents SET squad_id = 'S4' WHERE id = 'agent-B'").run()
    })
    const out = refusal(await call(operator(), 'move_agent_squad', { agent: 'agent-B', to_squad: 'S2', capability: 'member' }))
    expect(out.error).toBe('source_squad_changed')
    expect(rows("SELECT squad_id FROM agents WHERE id = 'agent-B'")).toEqual([{ squad_id: 'S4' }])
    expect(membership('agent-B', 'S2')).toBeNull() // no destination grant landed
    expect(membership('agent-B', 'S3')).toBe('member') // the old-home row was not severed
    expect(rows("SELECT 1 FROM agent_audit WHERE action = 'move_agent_squad'")).toHaveLength(0)
    expect(receipts('move_agent_squad').map((r) => r.outcome)).toEqual(['refused'])
  })

  it('an undisturbed move still lands and closes its receipt applied', async () => {
    const out = await call(operator(), 'move_agent_squad', { agent: 'agent-B', to_squad: 'S2', capability: 'member' })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(rows("SELECT squad_id FROM agents WHERE id = 'agent-B'")).toEqual([{ squad_id: 'S2' }])
    expect(receipts('move_agent_squad').map((r) => r.outcome)).toEqual(['applied'])
  })
})

// ── 5. revoke always works for the original delegator ────────────────────────────────────────────────────────────
describe('P2: operator_revoke for a delegator who has since been demoted', () => {
  it('the original delegator can still withdraw it after losing admin (the dispatcher floor no longer blocks)', async () => {
    const id = await delegate('squad', 'S2', 'lead')
    harness.sqlite.prepare("DELETE FROM capabilities WHERE member_id = 'mem-hadi'").run()
    const demoted = humanAuth('mem-hadi', [])
    const out = await call(demoted, 'operator_revoke', { delegation_id: id })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(rows('SELECT revoked_at FROM agent_operator_delegations WHERE id = ?', id)[0].revoked_at).not.toBeNull()
  })

  it('someone who is neither the delegator nor admin over the scope is still refused', async () => {
    const id = await delegate('squad', 'S2', 'lead')
    harness.sqlite.prepare("INSERT INTO members (id, display_name, status, tenant) VALUES ('mem-eve', 'Eve', 'active', ?)").run(TENANT)
    const eve = humanAuth('mem-eve', [])
    expect(refusal(await call(eve, 'operator_revoke', { delegation_id: id })).error).toBe('forbidden')
    expect(rows('SELECT revoked_at FROM agent_operator_delegations WHERE id = ?', id)[0].revoked_at).toBeNull()
  })

  it('an agent is still refused, delegation or not, even holding org admin', async () => {
    const id = await delegate('squad', 'S2', 'lead')
    const adminAgent: AuthContext = { ...operator(), capabilities: [grant('seat-agent-A', 'admin')] }
    const out = refusal(await call(adminAgent, 'operator_revoke', { delegation_id: id }))
    expect(out.error).toBe('operator_principal_required')
    expect(rows('SELECT revoked_at FROM agent_operator_delegations WHERE id = ?', id)[0].revoked_at).toBeNull()
  })
})

// ── 6. receipts never stay 'attempted' for known refusals ────────────────────────────────────────────────────────
// Mutations: (a) delete the settleOpenDelegatedReceipts call in invokeTool -> every MCP case goes red; (b) delete the
// `.use('*', ... settleOpenDelegatedReceipts ...)` block of orgApp / projectsApp / membersApp -> that app's cases go red.
describe('P2: every delegated site closes its receipt on every early return, on MCP and HTTP', () => {
  function expectClosedRefused(action: string): void {
    const rs = receipts(action)
    expect(rs.length, `${action}: no receipt was opened (the case never reached the site)`).toBeGreaterThan(0)
    expect(rs.map((r) => r.outcome), action).not.toContain('attempted')
    expect(rs[rs.length - 1].outcome, action).toBe('refused')
  }

  beforeEach(async () => {
    await delegate('org', null, 'lead')
  })

  describe('MCP', () => {
    it('create_agent on an archived squad', async () => {
      harness.sqlite.prepare("UPDATE squads SET status = 'archived' WHERE id = 'S2'").run()
      expect(refusal(await call(operator(), 'create_agent', { squad: 'S2', slug: 'zz-agent', name: 'Z' })).error).toBe('squad_archived')
      expectClosedRefused('create_agent')
    })

    it('squad_member_add on an archived squad', async () => {
      harness.sqlite.prepare("UPDATE squads SET status = 'archived' WHERE id = 'S2'").run()
      expect(refusal(await call(operator(), 'squad_member_add', { agent: 'agent-B', squad: 'S2', capability: 'member' })).error).toBe('squad_archived')
      expectClosedRefused('squad_member_add')
    })

    it('grant_agent_capability on an agent with no minted identity', async () => {
      harness.sqlite.prepare("INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-D', 'S3', 'agent-d', 'D', 'member', 'test', 'active')").run()
      expect(refusal(await call(operator(), 'grant_agent_capability', { agent: 'agent-D', squad: 'S2', capability: 'member' })).error).toBe('agent_identity_unminted')
      expectClosedRefused('grant_agent_capability')
    })

    it('move_agent_squad: squad_archived, same_squad and fleet_dispatch_active', async () => {
      harness.sqlite.prepare("UPDATE squads SET status = 'archived' WHERE id = 'S2'").run()
      expect(refusal(await call(operator(), 'move_agent_squad', { agent: 'agent-B', to_squad: 'S2', capability: 'member' })).error).toBe('squad_archived')
      expectClosedRefused('move_agent_squad')
      harness.sqlite.prepare("UPDATE squads SET status = 'active' WHERE id = 'S2'").run()
      harness.sqlite.prepare("INSERT INTO tasks (id, squad_id, title, status, assignee_agent_id) VALUES ('t1', 'S3', 'busy', 'in_progress', 'agent-B')").run()
      expect(refusal(await call(operator(), 'move_agent_squad', { agent: 'agent-B', to_squad: 'S2', capability: 'member' })).error).toBe('fleet_dispatch_active')
      expect(receipts('move_agent_squad').map((r) => r.outcome)).toEqual(['refused', 'refused'])
    })

    it('project_squad_set on an archived squad and project_squad_remove of a missing edge', async () => {
      harness.sqlite.prepare("UPDATE squads SET status = 'archived' WHERE id = 'S2'").run()
      expect(refusal(await call(operator(), 'project_squad_set', { project_id: 'P1', squad_id: 'S2', access_level: 'read' })).error).toBe('squad_archived')
      expectClosedRefused('project_squad_set')
      expect(refusal(await call(operator(), 'project_squad_remove', { project_id: 'P1', squad_id: 'S2' })).error).toBe('project_squad_access_not_found')
      expectClosedRefused('project_squad_remove')
    })
  })

  describe('HTTP', () => {
    it('org: bad JSON after the gate on create squad, unknown agent on memberships', async () => {
      const sq = await http(orgApp, operator(), 'POST', '/departments/D1/squads', undefined, '{')
      expect(sq.status).toBe(400)
      expectClosedRefused('create_squad')
      const mem = await http(orgApp, operator(), 'POST', '/agents/ghost-agent/memberships', { squad_id: 'S2', capability: 'member' })
      expect(mem.status).toBe(404)
      expectClosedRefused('grant_agent_membership')
    })

    it('members: invalid_action after the gate on /members/:id/capabilities', async () => {
      const out = await http(membersApp, operator(), 'POST', '/members/seat-agent-B/capabilities', { action: 'bogus', scope_type: 'squad', scope_id: 'S2', capability: 'member' })
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('invalid_action')
      expectClosedRefused('member_capability_grant')
    })

    it('projects: missing edge on DELETE', async () => {
      const del = await http(projectsApp, operator(), 'DELETE', '/P1/squads/S2')
      expect(del.status).toBe(404)
      expectClosedRefused('project_squad_remove')
    })
  })

  it('a 5xx / thrown outcome is left attempted on purpose (authorised, outcome unknown)', async () => {
    const { authorizeStructuralWrite, settleOpenDelegatedReceipts } = await import('../src/operators/chokepoint')
    const auth = operator()
    const v = await authorizeStructuralWrite(env, auth, 'squad_member_add', { squadId: 'S2', agentId: 'agent-B', capability: 'member' })
    expect(v.kind).toBe('delegated')
    await settleOpenDelegatedReceipts(env, auth, 500)
    expect(receipts('squad_member_add').map((r) => r.outcome)).toEqual(['attempted'])
  })
})

describe('P2 ratchet: every guarded door settles its receipts structurally', () => {
  const src = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

  it('the MCP dispatcher settles after every tool run', () => {
    const text = src('src/mcp/index.ts')
    expect(text).toMatch(/await spec\.run\(auth, env, args, ctx\)[\s\S]{0,1800}await settleOpenDelegatedReceipts\(env, auth,/)
  })

  it.each(['src/org/index.ts', 'src/projects/index.ts', 'src/members/index.ts'])('%s mounts the settle middleware before its routes', (file) => {
    const text = src(file)
    const mw = text.indexOf('settleOpenDelegatedReceipts(c.env, c.get(\'auth\'), c.res.status)')
    expect(mw, `${file} has no settle middleware`).toBeGreaterThan(0)
    // it wraps requireAuth, so it runs around every authenticated route (public routes registered earlier never open receipts)
    const auth = text.search(/\n(orgApp|projectsApp|membersApp)\.use\('\*', requireAuth\)/)
    expect(auth, `${file}: no requireAuth mount found`).toBeGreaterThan(0)
    expect(mw, `${file}: settle middleware must be mounted before requireAuth`).toBeLessThan(auth)
  })

  it('every file that asks the chokepoint for a DELEGABLE act is covered by the dispatcher or a settling app', async () => {
    const { STRUCTURAL_ACTIONS } = await import('../src/operators/chokepoint')
    const delegable = Object.entries(STRUCTURAL_ACTIONS).filter(([, p]) => p.delegable).map(([a]) => a)
    // squad-packs / outreach-pack are human-only surfaces: they close any receipt a delegated verdict opened themselves
    const settling = new Set(['src/org/index.ts', 'src/projects/index.ts', 'src/members/index.ts', 'src/mcp/provision.ts', 'src/mcp/projects.ts', 'src/org/squad-packs.ts', 'src/loops/outreach-pack.ts'])
    const { readdirSync, statSync } = await import('node:fs')
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const n of readdirSync(dir)) {
        const full = join(dir, n)
        if (statSync(full).isDirectory()) walk(full, out)
        else if (n.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const offenders = walk(join(__dirname, '..', 'src'))
      .filter((f) => !f.endsWith('operators/chokepoint.ts'))
      .filter((f) => delegable.some((a) => new RegExp(`(structuralGate|authorizeStructuralWrite)\\([^)]*'${a}'`).test(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(join(__dirname, '..').length + 1))
      .filter((f) => !settling.has(f))
    expect(offenders, 'a file asks for a delegable act but no dispatcher / settling app covers it').toEqual([])
  })
})

// ── 7. standing: gate grants, no-ops ─────────────────────────────────────────────────────────────────────────────
describe('P3: a target holding any gate grant is top standing', () => {
  it('a lead-capped delegate cannot add, remove or move an agent holding a gate grant (agent principal)', async () => {
    harness.sqlite.prepare("INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g1', 'gate:athena', 'agent', 'agent-B', 'mem-hadi', '2026-10-01T00:00:00Z')").run()
    await delegate('org', null, 'lead')
    for (const [tool, args] of [
      ['squad_member_add', { agent: 'agent-B', squad: 'S2', capability: 'member' }],
      ['squad_member_remove', { agent: 'agent-B', squad: 'S3' }],
      ['move_agent_squad', { agent: 'agent-B', to_squad: 'S2', capability: 'member' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = refusal(await call(operator(), tool, args))
      expect(r.error, tool).toBe('requires_human_approval')
      expect(r.detail.reason, tool).toBe('target_outranks_delegation')
    }
    expect(membership('agent-B', 'S2')).toBeNull()
  })

  it('same for a gate grant held by the seat MEMBER', async () => {
    harness.sqlite.prepare("INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('g2', 'gate:athena', 'member', 'seat-agent-B', 'mem-hadi', '2026-10-01T00:00:00Z')").run()
    await delegate('org', null, 'lead')
    const r = refusal(await call(operator(), 'squad_member_add', { agent: 'agent-B', squad: 'S2', capability: 'member' }))
    expect(r.detail.reason).toBe('target_outranks_delegation')
  })

  it('an agent with no gate grant is unaffected', async () => {
    await delegate('org', null, 'lead')
    expect((await call(operator(), 'squad_member_add', { agent: 'agent-B', squad: 'S2', capability: 'member' })).ok).toBe(true)
  })
})

describe('P3: a no-op add is not recorded as applied', () => {
  it('the second identical squad_member_add closes its receipt refused, the first applied', async () => {
    await delegate('org', null, 'lead')
    const args = { agent: 'agent-B', squad: 'S2', capability: 'member' }
    expect((await call(operator(), 'squad_member_add', args)).ok).toBe(true)
    const second = await call(operator(), 'squad_member_add', args)
    expect(second.ok).toBe(true)
    expect((second.ok && (second.result as { result: string }).result)).toBe('unchanged')
    expect(receipts('squad_member_add').map((r) => r.outcome)).toEqual(['applied', 'refused'])
  })
})

describe('P3: addon_activate asks the structural chokepoint', () => {
  it('an agent-bound caller is routed through it (agent_legacy lane, exactly as create_department)', async () => {
    const { authorizeStructuralWrite, STRUCTURAL_ACTIONS, STRUCTURAL_MCP_TOOLS } = await import('../src/operators/chokepoint')
    expect(STRUCTURAL_MCP_TOOLS.addon_activate).toBe('activate_addon')
    expect(STRUCTURAL_MCP_TOOLS.addon_setup).toBe('activate_addon')
    expect(STRUCTURAL_ACTIONS.activate_addon.delegable).toBe(false)
    await delegate('org', null, 'lead')
    // a delegation never opens activation
    const v = await authorizeStructuralWrite(env, operator(), 'activate_addon', {})
    expect(v.kind).toBe('agent_legacy')
  })
})
