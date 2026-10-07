// mupot#1733 — router_tick must not wake execute mode on a task whose gate has no eligible
// independent holder (same hasIndependentRuntimeGate predicate as task_dispatch), and
// task_dispatch warns when a member-only gate routes to the inbox. Real schema.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { runRouterTick } from '../src/router/engine'
import { diagnoseGateHolderFailure } from '../src/tasks/runtime-receipts'
import { invokeTool } from '../src/mcp'
import type { AuthContext, BusEvent, Env } from '../src/types'

const TENANT = 'tenant-1733'
const T0 = '2026-10-07T00:00:00.000Z'
const SQUAD = 'squad-r'
const WORKER = 'agent-worker'
const GATE_AGENT = 'agent-gate'
const OPERATOR = 'member-op'
const TASK = 'task-1733'

let h: SqliteD1Harness
let env: Env
let events: BusEvent[]

function seed(gateOwner: string | null) {
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES
      ('${WORKER}', '${SQUAD}', 'worker', 'Worker', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${OPERATOR}', 'Op', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-op', '${OPERATOR}', 'squad', '${SQUAD}', 'lead');
    INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at)
      VALUES ('${TENANT}', 'seat-w', 'W', 'test', 'seat-w', '${WORKER}', datetime('now'), datetime('now'));
  `)
  h.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, gate_owner, created_at, updated_at)
     VALUES (?, ?, 't', 'b', 'done', 'open', NULL, ?, ?, ?)`,
  ).run(TASK, SQUAD, gateOwner, T0, T0)
}

/** An independent agent holder of gate:gater (other agent, live credential, squad standing). */
function agentHolder() {
  h.sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${GATE_AGENT}', '${SQUAD}', 'gater', 'Gater', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('member-ga', 'GA', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-ga', 'member-ga', 'squad', '${SQUAD}', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${GATE_AGENT}', 'member-ga', '${T0}');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at)
      VALUES ('tok-ga', 'member-ga', 'hash-ga', 'gate', 'workspace', '${T0}', NULL, '${GATE_AGENT}', '${TENANT}', '2099-01-01T00:00:00.000Z');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-a', 'gate:gater', 'agent', '${GATE_AGENT}', '${OPERATOR}', '${T0}');
  `)
}

function humanHolder(opts: { status?: string; standing?: boolean; gate?: string } = {}) {
  h.sqlite.exec(`
    INSERT INTO members (id, display_name, status, tenant) VALUES ('member-human', 'H', '${opts.status ?? 'active'}', '${TENANT}');
    ${opts.standing === false ? '' : `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h', 'member-human', 'squad', '${SQUAD}', 'member');`}
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-h', '${opts.gate ?? 'gate:hadi'}', 'member', 'member-human', '${OPERATOR}', '${T0}');
  `)
}

const tick = (dryRun = false) => runRouterTick(
  env,
  { ok: true, tenant: TENANT, squadId: SQUAD, agentId: null, source: 'principal' },
  { squadId: SQUAD, dryRun },
  { memberId: OPERATOR },
)
const assignee = () =>
  h.sqlite.prepare('SELECT assignee_agent_id AS a FROM tasks WHERE id = ?').get(TASK) as { a: string | null }

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  events = []
  env = { DB: h.db, TENANT_SLUG: TENANT, BUS: { send: async (e: BusEvent) => { events.push(e) } } } as unknown as Env
})
afterEach(() => h.close())

describe('router_tick gate-holder hold (#1733)', () => {
  it('no eligible holder: no claim, no wake, held with reason', async () => {
    seed('gate:nobody')
    const r = await tick()
    expect(r.decisions).toEqual([{ task_id: TASK, outcome: 'held_no_gate_holder', agent_id: null, gate_owner: 'gate:nobody' }])
    expect(r.assigned).toBe(0)
    expect(assignee().a).toBeNull()
    expect(events).toHaveLength(0)
  })

  it('dry run also holds (would_assign never promises a refused wake)', async () => {
    seed('gate:nobody')
    expect((await tick(true)).decisions[0]?.outcome).toBe('held_no_gate_holder')
  })

  it('eligible agent holder: wakes', async () => {
    seed('gate:gater')
    agentHolder()
    const r = await tick()
    expect(r.decisions[0]).toMatchObject({ task_id: TASK, outcome: 'assigned', agent_id: WORKER })
    expect(assignee().a).toBe(WORKER)
    expect(events).toHaveLength(1)
  })

  it('eligible independent human holder: wakes (normal-dispatch mode)', async () => {
    seed('gate:hadi')
    humanHolder()
    expect((await tick()).decisions[0]?.outcome).toBe('assigned')
  })

  it('human holder without squad standing: held', async () => {
    seed('gate:hadi')
    humanHolder({ standing: false })
    expect((await tick()).decisions[0]?.outcome).toBe('held_no_gate_holder')
  })

  it.each([null, 'gate:agent-self-completion'])('gate_owner=%s unchanged: wakes', async (g) => {
    seed(g)
    const r = await tick()
    expect(r.decisions[0]?.outcome).toBe('assigned')
    expect(events).toHaveLength(1)
  })
})

describe('task_dispatch gate_member_only_inbox warning (#1733)', () => {
  const auth: AuthContext = {
    userId: OPERATOR, tenant: TENANT, channel: 'workspace', role: 'member', memberId: OPERATOR,
    tokenId: 'tok-op', boundAgentId: null,
    capabilities: [{ member_id: OPERATOR, scope_type: 'squad', scope_id: SQUAD, capability: 'lead' }],
  }
  const dispatch = () => invokeTool(auth, env, 'task_dispatch', { task_id: TASK }, 'https://pot.test')
  function poll() {
    h.sqlite.prepare(
      `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
       VALUES (?, ?, 'T', '', '[]', 'on_demand', 'running', ?, 'generic', 'poll', 300, datetime('now'), datetime('now'))`,
    ).run(WORKER, TENANT, WORKER)
  }
  const assign = () => h.sqlite.prepare('UPDATE tasks SET assignee_agent_id = ? WHERE id = ?').run(WORKER, TASK)

  it('member-only holder + live poll seat: ok with warning', async () => {
    seed('gate:hadi'); humanHolder(); assign(); poll()
    const out = await dispatch()
    expect(out.ok).toBe(true)
    expect(out).toMatchObject({ result: { warning: { code: 'gate_member_only_inbox', gate_owner: 'gate:hadi' } } })
  })

  it('member-only holder, no poll/runtime (in-worker route): ok, no warning', async () => {
    seed('gate:hadi'); humanHolder(); assign()
    const out = await dispatch()
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out)).not.toContain('gate_member_only_inbox')
  })

  it('agent holder + live poll seat: no warning', async () => {
    seed('gate:gater'); agentHolder(); assign(); poll()
    const out = await dispatch()
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out)).not.toContain('gate_member_only_inbox')
  })

  it('self-completion gate + poll: no warning', async () => {
    seed('gate:agent-self-completion'); assign(); poll()
    expect(JSON.stringify(await dispatch())).not.toContain('gate_member_only_inbox')
  })
})

describe('diagnoseGateHolderFailure member probe (#1733)', () => {
  const diag = () => diagnoseGateHolderFailure(env, 'gate:hadi', WORKER, { allowMemberHolders: true })

  it('suspended human is not labelled no_squad_standing', async () => {
    seed('gate:hadi'); humanHolder({ status: 'suspended' })
    expect(await diag()).toBe('no_holder')
  })

  it('human affiliated with the assignee (owner) is not labelled no_squad_standing', async () => {
    seed('gate:hadi'); humanHolder()
    h.sqlite.exec("UPDATE agents SET owner_member_id = 'member-human' WHERE id = 'agent-worker'")
    expect(await diag()).toBe('no_holder')
  })

  it('active independent human without standing keeps no_squad_standing', async () => {
    seed('gate:hadi'); humanHolder({ standing: false })
    expect(await diag()).toBe('no_squad_standing')
  })
})
