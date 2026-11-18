import { describe, expect, it, vi } from 'vitest'

// #2450: a controllable seam over the presence read so a THROWING lookup can be proven to count as not-live.
const liveness = vi.hoisted(() => ({ throwFor: new Set<string>(), calls: 0 }))
vi.mock('../src/fleet/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fleet/registry')>()
  return {
    ...actual,
    getFleetAgentLiveness: async (...args: Parameters<typeof actual.getFleetAgentLiveness>) => {
      liveness.calls++
      if (liveness.throwFor.has(args[1])) throw new Error('presence read failed')
      return actual.getFleetAgentLiveness(...args)
    },
  }
})
// #2450 round 2: the same seam over the verdict-independence read, so a FAILED eligibility read is provable.
const eligibility = vi.hoisted(() => ({ throwFor: new Set<string>(), calls: 0 }))
vi.mock('../src/tasks/verdict-independence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tasks/verdict-independence')>()
  return {
    ...actual,
    findVerdictIndependenceConflict: async (...args: Parameters<typeof actual.findVerdictIndependenceConflict>) => {
      eligibility.calls++
      if (eligibility.throwFor.has(args[1])) throw new Error('eligibility read failed')
      return actual.findVerdictIndependenceConflict(...args)
    },
  }
})

import { invokeTool, wakeGateOwnerOnReview } from '../src/mcp'
import { ackAgentMessages } from '../src/agents/messages'
import { listNeedsYou } from '../src/attention/service'
import { routinePrincipal } from '../src/routines/access'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { AuthContext, BusEvent, Env, Task } from '../src/types'

const TENANT = 'mumega'
const DEPARTMENT_ID = 'dept-wake'
const SQUAD_ID = 'squad-wake'
const ACTOR_ID = 'member-actor'

function auth(): AuthContext {
  return {
    userId: ACTOR_ID,
    memberId: ACTOR_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: ACTOR_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
}

function seedOrg(sqlite: { exec(sql: string): void }): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPARTMENT_ID}', 'dept-wake', 'Wake Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPARTMENT_ID}', 'squad-wake', 'Wake Squad');
  `)
}

function seedAgent(sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } }, id: string, status: 'active' | 'inactive' = 'active'): void {
  sqlite.prepare(
    `INSERT INTO agents (id, squad_id, slug, name, status) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, SQUAD_ID, id, id, status)
}

function seedMember(sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } }, id: string, status: 'active' | 'suspended' = 'active'): void {
  sqlite.prepare(
    `INSERT INTO members (id, display_name, status) VALUES (?, ?, ?)`,
  ).run(id, id, status)
}

function seedGrant(sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } }, id: string, capability: string, principalType: 'agent' | 'member', principalId: string): void {
  sqlite.prepare(
    `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
     VALUES (?, ?, ?, ?, 'owner-1', '2026-08-15T00:00:00.000Z')`,
  ).run(id, capability, principalType, principalId)
}

function seedTask(sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } }, id: string, capability: string): void {
  sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner)
     VALUES (?, ?, 'Gate wake task', 'body', 'wake outcome is visible', 'in_progress', ?)`,
  ).run(id, SQUAD_ID, capability)
}

async function updateToReview(
  harness: ReturnType<typeof createSqliteD1>,
  taskId: string,
) {
  return invokeTool(
    auth(),
    { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env,
    'task_update',
    { task_id: taskId, status: 'review' },
    'https://pot.example',
  )
}

describe('gate wake outcomes are visible on task reads', () => {
  function fanoutFixture() {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedOrg(harness.sqlite)
    seedMember(harness.sqlite, ACTOR_ID)
    harness.sqlite.prepare(`UPDATE members SET tenant = ? WHERE id = ?`).run(TENANT, ACTOR_ID)
    harness.sqlite.prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-member', ?, 'squad', ?, 'member')`).run(ACTOR_ID, SQUAD_ID)
    for (const id of ['agent-live-a', 'agent-live-b', 'agent-builder', 'agent-stale', 'agent-corpse']) {
      seedAgent(harness.sqlite, id, id === 'agent-corpse' ? 'inactive' : 'active')
      seedGrant(harness.sqlite, `grant-${id}`, 'gate:kasra-core', 'agent', id)
      harness.sqlite.prepare(`INSERT INTO fleet_agents (tenant, agent_id, runtime, status, last_reported_at)
        VALUES (?, ?, 'codex', 'running', ?)`).run(TENANT, id,
          id === 'agent-stale' ? '2000-01-01T00:00:00.000Z' : new Date().toISOString())
    }
    seedGrant(harness.sqlite, 'grant-member', 'gate:kasra-core', 'member', ACTOR_ID)
    harness.sqlite.prepare(`INSERT INTO projects (id, slug, name, status) VALUES ('project-fanout', 'fanout', 'Fanout', 'active')`).run()
    harness.sqlite.prepare(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-fanout', ?, 'write')`).run(SQUAD_ID)
    seedTask(harness.sqlite, 'task-fanout', 'gate:kasra-core')
    harness.sqlite.prepare(`UPDATE tasks SET project_id = 'project-fanout' WHERE id = 'task-fanout'`).run()
    harness.sqlite.prepare(`UPDATE tasks SET status = 'review', assignee_agent_id = 'agent-builder', result = 'reviewed result' WHERE id = 'task-fanout'`).run()
    const events: BusEvent[] = []
    const env = { DB: harness.db, TENANT_SLUG: TENANT, BUS: { send: async (event: BusEvent) => { events.push(event) } } } as unknown as Env
    const task = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = 'task-fanout'`).get() as unknown as Task
    return { harness, env, events, task }
  }

  it('fans out kasra-core to both live agents, keeps member needs_you, and isolates acknowledgements', async () => {
    const { harness, env, events, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id = 'agent-stale'`).run()
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toMatchObject({ status: 'delivered', holders: expect.arrayContaining([
        { type: 'agent', id: 'agent-builder', status: 'skipped_task_assignee' },
      ]) })
      const messages = harness.sqlite.prepare('SELECT id, to_agent, body, request_id, read_at FROM agent_messages ORDER BY to_agent').all() as Array<{ id: string; to_agent: string; body: string; request_id: string; read_at: string | null }>
      expect(messages.map(m => m.to_agent)).toEqual(['agent-live-a', 'agent-live-b'])
      expect(messages[0].body).toBe(messages[1].body)
      expect(messages[0].request_id).not.toBe(messages[1].request_id)
      expect(events.filter(e => e.type === 'agent.wake').map(e => e.agent_id)).toEqual(['agent-live-a', 'agent-live-b'])
      const needs = await listNeedsYou(env, routinePrincipal(auth()), { auth: auth() })
      expect(needs.items).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: task.id })]))
      await ackAgentMessages(env, { agent: 'agent-live-a', ids: [messages[0].id] })
      const unread = harness.sqlite.prepare('SELECT to_agent FROM agent_messages WHERE read_at IS NULL').all()
      expect(unread).toEqual([{ to_agent: 'agent-live-b' }])
    } finally { harness.close() }
  })

  it('#2450-1: wakes holders with no or stale presence; presence only counts and ranks', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM fleet_agents WHERE agent_id = 'agent-live-a'`).run()
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(harness.sqlite.prepare('SELECT to_agent FROM agent_messages ORDER BY to_agent').all()).toEqual([
        { to_agent: 'agent-live-a' }, { to_agent: 'agent-live-b' }, { to_agent: 'agent-stale' },
      ])
      expect(outcome).toMatchObject({ status: 'delivered', presence: { live: 1, total: 3 } })
      // Stable holder order (the resolver's), never liveness order: the order must not leak who is live.
      expect(outcome.holders).toEqual([
        { type: 'agent', id: 'agent-builder', status: 'skipped_task_assignee' },
        { type: 'agent', id: 'agent-live-a', status: 'delivered' },
        { type: 'agent', id: 'agent-live-b', status: 'delivered' },
        { type: 'agent', id: 'agent-stale', status: 'delivered' },
      ])
      // Response detail is trimmed: no per-holder presence or channel internals.
      expect(outcome).not.toHaveProperty('deliveries')
      expect(outcome).not.toHaveProperty('skipped_holders')
    } finally { harness.close() }
  })

  it('#2450-4: holders[] and the saved notice are identical whichever holder is live (no liveness leak)', async () => {
    const run = async (notLive: string) => {
      const { harness, env, task } = fanoutFixture()
      try {
        harness.sqlite.prepare(`DELETE FROM fleet_agents WHERE agent_id = ?`).run(notLive)
        const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
        const saved = harness.sqlite.prepare('SELECT gate_wake_notice FROM tasks WHERE id = ?').get(task.id) as { gate_wake_notice: string }
        return { holders: outcome.holders, notice: outcome.notice, saved: saved.gate_wake_notice }
      } finally { harness.close() }
    }
    const a = await run('agent-live-a')
    const b = await run('agent-live-b')
    expect(a.holders).toEqual(b.holders)
    expect(a.notice).toBe(b.notice)
    expect(a.saved).toBe(b.saved)
    expect(a.saved).toBe('Gate wake delivered: gate:kasra-core -> agent agent-live-a (delivered), agent agent-live-b (delivered), agent agent-stale (delivered); live 1 of 3. Skipped: agent-builder (task_assignee).')
  })

  it('#2450-2: skips a non-assignee submitter with the task_verdict self_verdict reason, never delivered', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
        VALUES ('submission-by-b', ?, ?, ?, 'agent-live-b', 'docs/result.md', ?, ?, 'reviewed result', '2026-10-01T00:00:00.000Z')`).run(TENANT, task.id, SQUAD_ID, 'a'.repeat(64), 'b'.repeat(64))
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(harness.sqlite.prepare('SELECT to_agent FROM agent_messages ORDER BY to_agent').all()).toEqual([
        { to_agent: 'agent-live-a' }, { to_agent: 'agent-stale' },
      ])
      expect(outcome.holders).toEqual(expect.arrayContaining([{ type: 'agent', id: 'agent-live-b', status: 'skipped_self_verdict' }]))
      expect(outcome.notice).toContain('agent-live-b (self_verdict)')
      // The predicate the fan-out reused agrees with task_verdict itself.
      const decide = await invokeTool({ ...auth(), boundAgentId: 'agent-live-b' }, env, 'task_verdict', {
        task_id: task.id, verdict: 'rejected', note: 'n', expected_submission_id: 'submission-by-b',
      })
      expect(decide).toMatchObject({ ok: false, error: 'self_verdict' })
    } finally { harness.close() }
  })

  it('#2450-2: skips a sole holder who submitted the result as no_eligible_holder', async () => {
    const { harness, env, events, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-live-a'`).run()
      harness.sqlite.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
        VALUES ('submission-by-a', ?, ?, ?, 'agent-live-a', 'docs/result.md', ?, ?, 'reviewed result', '2026-10-01T00:00:00.000Z')`).run(TENANT, task.id, SQUAD_ID, 'a'.repeat(64), 'b'.repeat(64))
      expect(await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)).toMatchObject({
        status: 'no_eligible_holder', holders: [{ type: 'agent', id: 'agent-live-a', status: 'skipped_self_verdict' }],
        notice: 'Gate wake not delivered: gate:kasra-core holder agent agent-live-a is not an eligible decider (self_verdict).',
      })
      expect(events).toEqual([])
    } finally { harness.close() }
  })

  it('#2450-5: a throwing liveness lookup counts as not live (still woken, ranked after live holders)', async () => {
    const { harness, env, task } = fanoutFixture()
    liveness.throwFor.add('agent-live-a')
    try {
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toMatchObject({ status: 'delivered', presence: { live: 1, total: 3 } })
      expect(outcome.holders?.slice(1, 3)).toEqual([
        { type: 'agent', id: 'agent-live-a', status: 'delivered' }, { type: 'agent', id: 'agent-live-b', status: 'delivered' },
      ])
    } finally { liveness.throwFor.clear(); harness.close() }
  })

  it('#2450-3: a failed eligibility read fails closed with its own reason, never delivered or "ineligible"', async () => {
    const { harness, env, task } = fanoutFixture()
    eligibility.throwFor.add('agent-live-b')
    try {
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(harness.sqlite.prepare('SELECT to_agent FROM agent_messages ORDER BY to_agent').all()).toEqual([
        { to_agent: 'agent-live-a' }, { to_agent: 'agent-stale' },
      ])
      // A possibly-eligible holder was not woken: partial, not delivered.
      expect(outcome).toMatchObject({ status: 'partial', eligibility_unknown: 1 })
      expect(outcome.holders).toEqual(expect.arrayContaining([{ type: 'agent', id: 'agent-live-b', status: 'skipped_eligibility_unknown' }]))
      expect(outcome.notice).toContain('agent-live-b (eligibility_unknown)')
    } finally { eligibility.throwFor.clear(); harness.close() }
  })

  it('#2450-3: every eligibility read failing reports eligibility_unknown, not no_eligible_holder', async () => {
    const { harness, env, events, task } = fanoutFixture()
    for (const id of ['agent-live-a', 'agent-live-b', 'agent-stale']) eligibility.throwFor.add(id)
    try {
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome.status).toBe('eligibility_unknown')
      expect(outcome.notice).toBe('Gate wake not delivered: eligibility of gate:kasra-core agent holders could not be read (agent-live-a, agent-live-b, agent-stale); skipped as unknown, not ineligible. Also skipped: agent-builder (task_assignee). Member holders keep their needs_you item.')
      expect(events).toEqual([])
    } finally { eligibility.throwFor.clear(); harness.close() }
  })

  it('#2450-3: a sole holder whose eligibility read fails is still woken (base behaviour), and the gap is reported', async () => {
    const { harness, env, task } = fanoutFixture()
    eligibility.throwFor.add('agent-live-a')
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-live-a'`).run()
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toMatchObject({ status: 'delivered', eligibility_unknown: 1 })
      expect(outcome.notice).toBe('Gate wake delivered: gate:kasra-core -> agent agent-live-a (bus=sent, inbox=sent). Eligibility could not be read; delivered unverified.')
      expect(harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all()).toEqual([{ to_agent: 'agent-live-a' }])
    } finally { eligibility.throwFor.clear(); harness.close() }
  })

  it('#2450-2: the affiliated leg: an agent acting for the human assignee is skipped as self_verdict', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      seedMember(harness.sqlite, 'member-human')
      harness.sqlite.prepare(`UPDATE tasks SET assignee_agent_id = NULL, assignee_member_id = 'member-human' WHERE id = ?`).run(task.id)
      harness.sqlite.prepare(`UPDATE agents SET owner_member_id = 'member-human' WHERE id = 'agent-live-a'`).run()
      const fresh = harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task.id) as unknown as Task
      const outcome = await wakeGateOwnerOnReview(env, fresh, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome.holders).toEqual(expect.arrayContaining([{ type: 'agent', id: 'agent-live-a', status: 'skipped_self_verdict' }]))
      expect((harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all() as Array<{ to_agent: string }>).map(r => r.to_agent))
        .not.toContain('agent-live-a')
    } finally { harness.close() }
  })

  function selfCompletionFixture(producer: 'assignee' | 'other' | 'none', gate = 'gate:agent-self-completion') {
    const fx = fanoutFixture()
    fx.harness.sqlite.prepare(`DELETE FROM gate_grants`).run()
    seedGrant(fx.harness.sqlite, 'grant-sc-builder', gate, 'agent', 'agent-builder')
    seedGrant(fx.harness.sqlite, 'grant-sc-a', gate, 'agent', 'agent-live-a')
    fx.harness.sqlite.prepare(`UPDATE tasks SET gate_owner = ? WHERE id = ?`).run(gate, fx.task.id)
    if (producer !== 'none') {
      fx.harness.sqlite.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
        VALUES ('submission-sc', ?, ?, ?, ?, 'docs/result.md', ?, ?, 'reviewed result', '2026-10-01T00:00:00.000Z')`)
        .run(TENANT, fx.task.id, SQUAD_ID, producer === 'assignee' ? 'agent-builder' : 'agent-stale', 'a'.repeat(64), 'b'.repeat(64))
    }
    const task = fx.harness.sqlite.prepare(`SELECT * FROM tasks WHERE id = ?`).get(fx.task.id) as unknown as Task
    return { ...fx, task }
  }

  it('#2450-2: self-completion lane: the assignee who produced the current result is eligible and woken', async () => {
    const { harness, env, task } = selfCompletionFixture('assignee')
    try {
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome.holders).toEqual(expect.arrayContaining([{ type: 'agent', id: 'agent-builder', status: 'delivered' }]))
    } finally { harness.close() }
  })

  it('#2450-2: self-completion lane: an assignee that did not produce the current result is skipped', async () => {
    for (const producer of ['other', 'none'] as const) {
      const { harness, env, task } = selfCompletionFixture(producer)
      try {
        const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
        expect(outcome.holders).toEqual(expect.arrayContaining([{ type: 'agent', id: 'agent-builder', status: 'skipped_task_assignee' }]))
      } finally { harness.close() }
    }
  })

  it('#2450-2: the producer exemption is the self-completion lane only; on another gate the producing assignee is skipped', async () => {
    const { harness, env, task } = selfCompletionFixture('assignee', 'gate:kasra-core')
    try {
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome.holders).toEqual(expect.arrayContaining([{ type: 'agent', id: 'agent-builder', status: 'skipped_task_assignee' }]))
    } finally { harness.close() }
  })

  it('#2450-5: one channel failing for a holder makes that holder (and the wake) partial', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id = 'agent-stale'`).run()
      const busFails = { ...env, BUS: { send: async (event: BusEvent) => { if (event.agent_id === 'agent-live-b') throw new Error('bus down') } } } as unknown as Env
      const outcome = await wakeGateOwnerOnReview(busFails, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome.status).toBe('partial')
      expect(outcome.holders).toEqual(expect.arrayContaining([
        { type: 'agent', id: 'agent-live-a', status: 'delivered' },
        { type: 'agent', id: 'agent-live-b', status: 'partial' },
      ]))
      expect(harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'agent-live-b'`).get()).toEqual({ n: 1 })
    } finally { harness.close() }
  })

  it('#2450-7: the inbox row goes to the fleet identity the presence lookup resolved, on both paths', async () => {
    for (const sole of [false, true]) {
      const { harness, env, events, task } = fanoutFixture()
      try {
        // agent-live-b's runtime registered under its SLUG, not its agents.id.
        harness.sqlite.prepare(`UPDATE agents SET slug = 'kb-slug' WHERE id = 'agent-live-b'`).run()
        harness.sqlite.prepare(`UPDATE fleet_agents SET agent_id = 'kb-slug' WHERE agent_id = 'agent-live-b'`).run()
        if (sole) harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-live-b'`).run()
        const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
        expect(outcome.status).toBe('delivered')
        const rows = (harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all() as Array<{ to_agent: string }>).map(r => r.to_agent)
        expect(rows).toContain('kb-slug')
        expect(rows).not.toContain('agent-live-b')
        // The bus wake still addresses the agents.id (the in-Worker AgentDO key).
        expect(events.filter(e => e.type === 'agent.wake').map(e => e.agent_id)).toContain('agent-live-b')
      } finally { harness.close() }
    }
  })

  it('#2458-2: a stopped fleet row never receives (bus or inbox) and is recorded stopped_skipped, on both paths', async () => {
    for (const sole of [false, true]) {
      const { harness, env, events, task } = fanoutFixture()
      try {
        // The #2451 round-2 repro: the holder's fleet row is keyed by its slug and operator-stopped (fresh report).
        harness.sqlite.prepare(`UPDATE agents SET slug = 'kb-slug' WHERE id = 'agent-live-b'`).run()
        harness.sqlite.prepare(`UPDATE fleet_agents SET agent_id = 'kb-slug', status = 'stopped' WHERE agent_id = 'agent-live-b'`).run()
        if (sole) harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-live-b'`).run()
        const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
        const rows = (harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all() as Array<{ to_agent: string }>).map(r => r.to_agent)
        expect(rows).not.toContain('kb-slug')
        expect(rows).not.toContain('agent-live-b')
        expect(events.filter(e => e.type === 'agent.wake').map(e => e.agent_id)).not.toContain('agent-live-b')
        expect(outcome.holders).toEqual(expect.arrayContaining([{ type: 'agent', id: 'agent-live-b', status: 'stopped_skipped' }]))
        if (sole) {
          // #2461: the holder exists and is eligible but cannot be woken: holders_stopped, never no_live_holder.
          expect(outcome.status).toBe('holders_stopped')
          expect(outcome.stopped).toBe(1)
          expect(outcome.notice).toBe('Gate wake not delivered: gate:kasra-core holder agent agent-live-b is stopped.')
        } else {
          expect(outcome.status).toBe('delivered')
          expect(rows.sort()).toEqual(['agent-live-a', 'agent-stale'])
          expect(outcome.notice).toContain('Stopped: agent-live-b.')
        }
      } finally { harness.close() }
    }
  })

  it.each([['fan-out', false], ['sole holder', true]])('#2461-P1: a detached poll seat (runtime \'\', presence_mode \'\', stopped) never receives (%s)', async (_path, sole) => {
    {
      const { harness, env, events, task } = fanoutFixture()
      try {
        // The exact row shape markStopped writes for a detached poll seat that never reported a runtime:
        // registry.ts deriveFleetAgentRoute takes its early return for this row, so the stopped flag must survive it.
        harness.sqlite.prepare(`UPDATE fleet_agents SET runtime = '', presence_mode = '', presence_ttl_sec = NULL,
          status = 'stopped', last_reported_at = ? WHERE agent_id = 'agent-live-b'`).run(new Date().toISOString())
        if (sole) harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-live-b'`).run()
        const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
        const rows = (harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all() as Array<{ to_agent: string }>).map(r => r.to_agent)
        expect(rows).not.toContain('agent-live-b')
        expect(events.filter(e => e.type === 'agent.wake').map(e => e.agent_id)).not.toContain('agent-live-b')
        expect(outcome.holders).toEqual(expect.arrayContaining([{ type: 'agent', id: 'agent-live-b', status: 'stopped_skipped' }]))
        if (sole) {
          expect(outcome.status).toBe('holders_stopped')
        } else {
          expect(outcome.status).toBe('delivered')
          expect(rows.sort()).toEqual(['agent-live-a', 'agent-stale'])
        }
      } finally { harness.close() }
    }
  })

  function stopFleetRow(harness: ReturnType<typeof createSqliteD1>, id: string): void {
    harness.sqlite.prepare(`INSERT INTO fleet_agents (tenant, agent_id, runtime, status, last_reported_at) VALUES (?, ?, 'codex', 'stopped', ?)
      ON CONFLICT DO UPDATE SET status = 'stopped'`).run(TENANT, id, new Date().toISOString())
  }

  it('#2461-3: every eligible fan-out holder stopped (all judged) is holders_stopped with every field, never no_live_holder', async () => {
    const { harness, env, events, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id NOT IN ('agent-live-a', 'agent-live-b', 'agent-builder', ?)`).run(ACTOR_ID)
      harness.sqlite.prepare(`UPDATE fleet_agents SET status = 'stopped' WHERE agent_id IN ('agent-live-a', 'agent-live-b')`).run()
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toEqual({
        status: 'holders_stopped',
        capability: 'gate:kasra-core',
        active_holders: expect.any(Array),
        inactive_holders: expect.any(Array),
        grant_count: 4,
        stopped: 2,
        holders: [
          { type: 'agent', id: 'agent-builder', status: 'skipped_task_assignee' },
          { type: 'agent', id: 'agent-live-a', status: 'stopped_skipped' },
          { type: 'agent', id: 'agent-live-b', status: 'stopped_skipped' },
        ],
        notice: 'Gate wake not delivered: every eligible agent holder of gate:kasra-core that was read is stopped. Skipped: agent-builder (task_assignee). Stopped: agent-live-a, agent-live-b. Member holders keep their needs_you item.',
        notice_persisted: true,
      })
      expect(events).toEqual([])
      // #2461-4 store-and-forward decision: a stopped holder keeps no inbox row (dropped), only the stopped_skipped receipt.
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual({ n: 0 })
    } finally { harness.close() }
  })

  it('#2461-3: all read holders stopped while one is unreadable and others are unread is eligibility_unknown with every field', async () => {
    const { harness, env, events, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-builder'`).run()
      // Stable order: agent-builder (assignee), agent-s-00..19 (stopped, 19 eligible + agent-s-07 unreadable) = 21 holders.
      const ids: string[] = []
      for (let i = 0; i < 21; i++) {
        const id = `agent-s-${String(i).padStart(2, '0')}`
        seedAgent(harness.sqlite, id)
        seedGrant(harness.sqlite, `grant-${id}`, 'gate:kasra-core', 'agent', id)
        stopFleetRow(harness, id)
        ids.push(id)
      }
      eligibility.throwFor.add('agent-s-07')
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      // 20 reads: builder + s-00..s-18. s-19 and s-20 unread (read cap). s-07 unknown. 18 stopped.
      const stoppedIds = ids.slice(0, 19).filter(id => id !== 'agent-s-07')
      expect(outcome).toEqual({
        status: 'eligibility_unknown',
        capability: 'gate:kasra-core',
        active_holders: expect.any(Array),
        inactive_holders: expect.any(Array),
        grant_count: 22,
        stopped: 18,
        eligibility_unknown: 1,
        width_cap: { limit: 10, omitted: 2 },
        holders: [
          { type: 'agent', id: 'agent-builder', status: 'skipped_task_assignee' },
          ...ids.map(id => ({ type: 'agent', id, status: id === 'agent-s-07' ? 'skipped_eligibility_unknown' : stoppedIds.includes(id) ? 'stopped_skipped' : 'skipped_width_cap' })),
        ],
        notice: `Gate wake not delivered: every eligible agent holder of gate:kasra-core that was read is stopped. read cap 20 reached; 2 agent holders not read or woken (agent-s-19, agent-s-20). Skipped: agent-builder (task_assignee), agent-s-07 (eligibility_unknown). Stopped: ${stoppedIds.join(', ')}.`,
        notice_persisted: true,
      })
      expect(events).toEqual([])
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual({ n: 0 })
    } finally { eligibility.throwFor.clear(); harness.close() }
  })

  it('#2461-2: stopped holders do not consume the width cap: 10 stopped sorting first + 10 live, every live holder woken', async () => {
    const { harness, env, events, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-builder'`).run()
      const stopped: string[] = []
      const live: string[] = []
      for (let i = 0; i < 10; i++) {
        const s = `agent-aa-stop-${String(i).padStart(2, '0')}`
        const l = `agent-zz-live-${String(i).padStart(2, '0')}`
        for (const id of [s, l]) { seedAgent(harness.sqlite, id); seedGrant(harness.sqlite, `grant-${id}`, 'gate:kasra-core', 'agent', id) }
        stopFleetRow(harness, s)
        harness.sqlite.prepare(`INSERT INTO fleet_agents (tenant, agent_id, runtime, status, last_reported_at) VALUES (?, ?, 'codex', 'running', ?)`).run(TENANT, l, new Date().toISOString())
        stopped.push(s); live.push(l)
      }
      // Builder first, then the 10 stopped: drop the assignee so the 20-read budget covers exactly 10 stopped + 10 live.
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id = 'agent-builder'`).run()
      liveness.calls = 0
      eligibility.calls = 0
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toMatchObject({ status: 'delivered', stopped: 10, presence: { live: 10, total: 10 } })
      expect(outcome.width_cap).toBeUndefined()
      expect(eligibility.calls).toBe(20)
      expect(liveness.calls).toBe(20)
      const woken = (harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all() as Array<{ to_agent: string }>).map(r => r.to_agent).sort()
      expect(woken).toEqual(live)
      expect(events.filter(e => e.type === 'agent.wake').map(e => e.agent_id).sort()).toEqual(live)
      expect(outcome.holders).toEqual([
        ...stopped.map(id => ({ type: 'agent', id, status: 'stopped_skipped' })),
        ...live.map(id => ({ type: 'agent', id, status: 'delivered' })),
      ])
      expect(outcome.notice).toContain('; live 10 of 10.')
    } finally { harness.close() }
  })

  it('#2461-2: 12 stopped + 10 live: the read cap (not the width cap) trips; 8 live woken, 2 unread, partial', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants`).run()
      for (let i = 0; i < 12; i++) {
        const id = `agent-aa-stop-${String(i).padStart(2, '0')}`
        seedAgent(harness.sqlite, id); seedGrant(harness.sqlite, `grant-${id}`, 'gate:kasra-core', 'agent', id); stopFleetRow(harness, id)
      }
      for (let i = 0; i < 10; i++) {
        const id = `agent-zz-live-${String(i).padStart(2, '0')}`
        seedAgent(harness.sqlite, id); seedGrant(harness.sqlite, `grant-${id}`, 'gate:kasra-core', 'agent', id)
      }
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toMatchObject({ status: 'partial', stopped: 12, width_cap: { limit: 10, omitted: 2 } })
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual({ n: 8 })
      expect(outcome.notice).toContain('read cap 20 reached; 2 agent holders not read or woken (agent-zz-live-08, agent-zz-live-09)')
    } finally { harness.close() }
  })

  it('#2458-3: a stale slug-keyed registration falls back to agents.id for the inbox row, on both paths', async () => {
    for (const sole of [false, true]) {
      const { harness, env, events, task } = fanoutFixture()
      try {
        // Resident (non-poll) runtime registered under its slug, last report long past the TTL: a dead address.
        harness.sqlite.prepare(`UPDATE agents SET slug = 'kb-slug' WHERE id = 'agent-live-b'`).run()
        harness.sqlite.prepare(`UPDATE fleet_agents SET agent_id = 'kb-slug', last_reported_at = '2000-01-01T00:00:00.000Z' WHERE agent_id = 'agent-live-b'`).run()
        if (sole) harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-live-b'`).run()
        const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
        expect(outcome.status).toBe('delivered')
        const rows = (harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all() as Array<{ to_agent: string }>).map(r => r.to_agent)
        expect(rows).toContain('agent-live-b')
        expect(rows).not.toContain('kb-slug')
        expect(events.filter(e => e.type === 'agent.wake').map(e => e.agent_id)).toContain('agent-live-b')
      } finally { harness.close() }
    }
  })

  it('#2458-3: an active poll-mode slug registration keeps the fleet identity even when stale (mailbox route)', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`UPDATE agents SET slug = 'kb-slug' WHERE id = 'agent-live-b'`).run()
      harness.sqlite.prepare(`UPDATE fleet_agents SET agent_id = 'kb-slug', presence_mode = 'poll', last_reported_at = '2000-01-01T00:00:00.000Z' WHERE agent_id = 'agent-live-b'`).run()
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-live-b'`).run()
      expect((await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)).status).toBe('delivered')
      expect(harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all()).toEqual([{ to_agent: 'kb-slug' }])
    } finally { harness.close() }
  })

  function seedSelfVerdictHolders(harness: ReturnType<typeof createSqliteD1>, task: Task, count: number): string[] {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = `agent-inel-${String(i).padStart(2, '0')}`
      seedAgent(harness.sqlite, id)
      seedGrant(harness.sqlite, `grant-${id}`, 'gate:kasra-core', 'agent', id)
      harness.sqlite.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
        VALUES (?, ?, ?, ?, ?, 'docs/result.md', ?, ?, 'reviewed result', '2026-10-01T00:00:00.000Z')`).run(`submission-${id}`, TENANT, task.id, SQUAD_ID, id, 'a'.repeat(64), 'b'.repeat(64))
      ids.push(id)
    }
    return ids
  }

  it('#2458-4: 21 provably ineligible holders after an eligible one: reads capped at 20, the wake is partial', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id = 'agent-builder'`).run()
      seedAgent(harness.sqlite, 'agent-aa-first')
      seedGrant(harness.sqlite, 'grant-agent-aa-first', 'gate:kasra-core', 'agent', 'agent-aa-first')
      seedSelfVerdictHolders(harness, task, 21)
      liveness.calls = 0
      eligibility.calls = 0
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      // Stable order: aa-first (eligible), inel-00..18 (19 ineligible) = 20 reads; inel-19, inel-20, live-a, live-b, stale unread.
      expect(eligibility.calls).toBe(20)
      expect(liveness.calls).toBe(1)
      expect(outcome).toMatchObject({ status: 'partial', width_cap: { limit: 10, omitted: 5 } })
      expect(harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all()).toEqual([{ to_agent: 'agent-aa-first' }])
      expect(outcome.holders?.filter(h => h.status === 'skipped_width_cap').map(h => h.id)).toEqual(['agent-inel-19', 'agent-inel-20', 'agent-live-a', 'agent-live-b', 'agent-stale'])
      expect(outcome.holders?.filter(h => h.status === 'skipped_self_verdict')).toHaveLength(19)
      expect(outcome.notice).toContain('read cap 20 reached; 5 agent holders not read or woken')
    } finally { harness.close() }
  })

  it('#2458-4: 21 provably ineligible holders ahead of every eligible one: 20 reads, eligibility_unknown, nobody woken', async () => {
    const { harness, env, events, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id = 'agent-builder'`).run()
      seedSelfVerdictHolders(harness, task, 21)
      liveness.calls = 0
      eligibility.calls = 0
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(eligibility.calls).toBe(20)
      expect(liveness.calls).toBe(0)
      expect(outcome.status).toBe('eligibility_unknown')
      expect(outcome.holders?.filter(h => h.status === 'skipped_width_cap').map(h => h.id)).toEqual(['agent-inel-20', 'agent-live-a', 'agent-live-b', 'agent-stale'])
      expect(events).toEqual([])
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual({ n: 0 })
    } finally { harness.close() }
  })

  it('#2450-3: with no member holder, the all-ineligible notice does not mention member holders', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id NOT IN ('agent-live-a', 'agent-builder')`).run()
      harness.sqlite.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
        VALUES ('submission-by-a', ?, ?, ?, 'agent-live-a', 'docs/result.md', ?, ?, 'reviewed result', '2026-10-01T00:00:00.000Z')`).run(TENANT, task.id, SQUAD_ID, 'a'.repeat(64), 'b'.repeat(64))
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toMatchObject({ status: 'no_eligible_holder',
        notice: 'Gate wake not delivered: every agent holder of gate:kasra-core is ineligible (agent-builder (task_assignee), agent-live-a (self_verdict)).' })
    } finally { harness.close() }
  })

  it('#2450-5: one holder failing on both channels while another succeeds is partial (some, not every)', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.exec(`CREATE TRIGGER fail_stale_inbox BEFORE INSERT ON agent_messages WHEN NEW.to_agent = 'agent-stale'
        BEGIN SELECT RAISE(ABORT, 'inbox down'); END;`)
      const failingEnv = { ...env, BUS: { send: async (event: BusEvent) => { if (event.agent_id === 'agent-stale') throw new Error('bus down') } } } as unknown as Env
      const outcome = await wakeGateOwnerOnReview(failingEnv, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome.status).toBe('partial')
      expect(outcome.holders).toEqual(expect.arrayContaining([
        { type: 'agent', id: 'agent-stale', status: 'delivery_failed' },
        { type: 'agent', id: 'agent-live-a', status: 'delivered' },
      ]))
      expect(outcome.notice).toBe('Gate wake partial: gate:kasra-core -> agent agent-live-a (delivered), agent agent-live-b (delivered), agent agent-stale (delivery_failed); live 2 of 3. Skipped: agent-builder (task_assignee).')
    } finally { harness.close() }
  })

  it('#2450-5: a multi-holder gate with exactly one eligible target still fans out to it', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id NOT IN ('agent-live-a', 'agent-builder')`).run()
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toMatchObject({ status: 'delivered', presence: { live: 1, total: 1 } })
      expect(outcome.notice).toBe('Gate wake delivered: gate:kasra-core -> agent agent-live-a (delivered); live 1 of 1. Skipped: agent-builder (task_assignee).')
      expect(harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all()).toEqual([{ to_agent: 'agent-live-a' }])
    } finally { harness.close() }
  })

  it('#2450-3: every agent holder ineligible gets its own status and a notice naming that outcome', async () => {
    const { harness, env, events, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id NOT IN ('agent-live-a', 'agent-builder', ?)`).run(ACTOR_ID)
      harness.sqlite.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
        VALUES ('submission-by-a', ?, ?, ?, 'agent-live-a', 'docs/result.md', ?, ?, 'reviewed result', '2026-10-01T00:00:00.000Z')`).run(TENANT, task.id, SQUAD_ID, 'a'.repeat(64), 'b'.repeat(64))
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome.status).toBe('no_eligible_holder')
      expect(outcome.notice).toBe('Gate wake not delivered: every agent holder of gate:kasra-core is ineligible (agent-builder (task_assignee), agent-live-a (self_verdict)). Member holders keep their needs_you item.')
      expect(outcome.notice).not.toContain('live holders')
      expect(events).toEqual([])
    } finally { harness.close() }
  })

  it('#2450-6: caps the fan-out (deliveries AND reads) at 10 holders in stable order; a cap hit is partial', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      for (let i = 0; i < 10; i++) {
        const id = `agent-extra-${String(i).padStart(2, '0')}`
        seedAgent(harness.sqlite, id)
        seedGrant(harness.sqlite, `grant-${id}`, 'gate:kasra-core', 'agent', id)
      }
      liveness.calls = 0
      eligibility.calls = 0
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      // Stable order: agent-builder (assignee), agent-extra-00..09 fill the cap; live-a, live-b, stale are never read.
      expect(outcome).toMatchObject({ status: 'partial', presence: { live: 0, total: 10 }, width_cap: { limit: 10, omitted: 3 } })
      const woken = (harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all() as Array<{ to_agent: string }>).map(r => r.to_agent)
      expect(woken).toHaveLength(10)
      expect(woken.every(id => id.startsWith('agent-extra-'))).toBe(true)
      expect(outcome.holders?.filter(h => h.status === 'skipped_width_cap').map(h => h.id)).toEqual(['agent-live-a', 'agent-live-b', 'agent-stale'])
      expect(liveness.calls).toBe(10)
      expect(eligibility.calls).toBe(10)
      expect(outcome.notice).toContain('width cap 10 reached; 3 agent holders not read or woken (agent-live-a, agent-live-b, agent-stale)')
    } finally { harness.close() }
  })


  it('wakes the exact two-agent plus one-member lane shape', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id IN ('agent-builder', 'agent-stale', 'agent-corpse')`).run()
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toMatchObject({ status: 'delivered', grant_count: 3 })
      expect(harness.sqlite.prepare('SELECT to_agent FROM agent_messages ORDER BY to_agent').all()).toEqual([
        { to_agent: 'agent-live-a' }, { to_agent: 'agent-live-b' },
      ])
    } finally { harness.close() }
  })

  it('retains the single-agent wake payload, request key, and notice without a presence row', async () => {
    const { harness, env, events, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-live-a'`).run()
      harness.sqlite.prepare('DELETE FROM fleet_agents').run()
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toEqual({
        status: 'delivered', capability: task.gate_owner,
        principal: { type: 'agent', id: 'agent-live-a' },
        active_holders: [{ type: 'agent', id: 'agent-live-a' }], inactive_holders: [], grant_count: 1,
        notice: 'Gate wake delivered: gate:kasra-core -> agent agent-live-a (bus=sent, inbox=sent).', notice_persisted: true,
      })
      const wake = events.find(e => e.type === 'agent.wake')!
      expect(wake.payload).toEqual({ task_id: task.id, gate_owner: task.gate_owner, by: ACTOR_ID })
      expect(harness.sqlite.prepare('SELECT body, request_id FROM agent_messages').get()).toEqual({
        body: JSON.stringify({ type: 'task_review', task_id: task.id, gate_owner: task.gate_owner, squad_id: task.squad_id }),
        request_id: `review-wake:${task.id}:${wake.ts}`,
      })
    } finally { harness.close() }
  })

  it('records a sole assignee holder skip without any bus or inbox wake', async () => {
    const { harness, env, events, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`DELETE FROM gate_grants WHERE principal_id <> 'agent-builder'`).run()
      expect(await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)).toMatchObject({
        status: 'no_eligible_holder', holders: [{ type: 'agent', id: 'agent-builder', status: 'skipped_task_assignee' }],
        notice: 'Gate wake not delivered: gate:kasra-core holder agent agent-builder is not an eligible decider (task_assignee).',
      })
      expect(events).toEqual([])
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_messages').get()).toEqual({ n: 0 })
      expect(harness.sqlite.prepare('SELECT gate_wake_notice FROM tasks WHERE id = ?').get(task.id)).toMatchObject({ gate_wake_notice: expect.stringContaining('task_assignee') })
    } finally { harness.close() }
  })

  it('first holder verdict wins; second holder cannot reuse the spent submission pin', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
        VALUES ('submission-fanout', ?, ?, ?, 'agent-builder', 'docs/result.md', ?, ?, 'reviewed result', '2026-10-01T00:00:00.000Z')`).run(TENANT, task.id, SQUAD_ID, 'a'.repeat(64), 'b'.repeat(64))
      const decide = (agentId: string) => invokeTool({ ...auth(), boundAgentId: agentId }, env, 'task_verdict', {
        task_id: task.id, verdict: 'rejected', note: 'holder review', expected_submission_id: 'submission-fanout',
      })
      expect(await decide('agent-live-a')).toMatchObject({ ok: true })
      expect(await decide('agent-live-b')).toMatchObject({ ok: false, error: 'not_in_review' })
      // Re-entering review with identical bytes does not revive the rejected submission.
      harness.sqlite.prepare(`UPDATE tasks SET status = 'review' WHERE id = ?`).run(task.id)
      expect(await decide('agent-live-b')).toMatchObject({ ok: false, error: 'submission_mismatch' })
      expect(harness.sqlite.prepare('SELECT submission_id, decided_by FROM task_verdicts').all()).toEqual([
        { submission_id: 'submission-fanout', decided_by: 'agent-live-a' },
      ])
    } finally { harness.close() }
  })

  it('#2450-5: two holders deciding concurrently: exactly one verdict lands, the other is refused', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      harness.sqlite.prepare(`INSERT INTO task_result_submissions (id, tenant, task_id, squad_id, submitted_by_agent_id, artifact_path, artifact_sha256, result_digest, result_text, created_at)
        VALUES ('submission-race', ?, ?, ?, 'agent-builder', 'docs/result.md', ?, ?, 'reviewed result', '2026-10-01T00:00:00.000Z')`).run(TENANT, task.id, SQUAD_ID, 'a'.repeat(64), 'b'.repeat(64))
      const decide = (agentId: string, verdict: 'approved' | 'rejected') => invokeTool({ ...auth(), boundAgentId: agentId }, env, 'task_verdict', {
        task_id: task.id, verdict, note: `race ${agentId}`, expected_submission_id: 'submission-race',
      })
      // Both calls start before either writes: neither sees the other's verdict at its pre-checks.
      const results = await Promise.all([decide('agent-live-a', 'rejected'), decide('agent-live-b', 'rejected')])
      const winners = results.filter(r => (r as { ok: boolean }).ok)
      const losers = results.filter(r => !(r as { ok: boolean }).ok) as Array<{ error: string }>
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      expect(losers[0].error).toBe('verdict_race')
      expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ?').get(task.id)).toEqual({ n: 1 })
    } finally { harness.close() }
  })

  it('persists an ambiguous live-holder outcome with the capability and holders', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedOrg(harness.sqlite)
    // #2450: multiple AGENT holders are woken (even without presence); only a gate with no agent holder to wake
    // (here: two members) stays an operator-decision ambiguity.
    seedMember(harness.sqlite, 'member-a')
    seedMember(harness.sqlite, 'member-b')
    seedGrant(harness.sqlite, 'g1', 'gate:kayhermes', 'member', 'member-a')
    seedGrant(harness.sqlite, 'g2', 'gate:kayhermes', 'member', 'member-b')
    seedTask(harness.sqlite, 'task-ambiguous', 'gate:kayhermes')

    const res = await updateToReview(harness, 'task-ambiguous')
    expect(res).toMatchObject({
      ok: true,
      result: {
        gate_wake: {
          status: 'ambiguous',
          capability: 'gate:kayhermes',
          active_holders: [
            { type: 'member', id: 'member-a' },
            { type: 'member', id: 'member-b' },
          ],
        },
      },
    })

    const row = harness.sqlite.prepare('SELECT gate_wake_notice FROM tasks WHERE id = ?').get('task-ambiguous') as {
      gate_wake_notice: string
    }
    expect(row.gate_wake_notice).toContain('gate:kayhermes')
    expect(row.gate_wake_notice).toContain('operator decision required')

    const board = await invokeTool(
      auth(),
      { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env,
      'task_board',
      { squad_id: SQUAD_ID },
      'https://pot.example',
    )
    expect(board).toMatchObject({
      ok: true,
      result: {
        columns: {
          review: [{ id: 'task-ambiguous', gate_wake_notice: expect.stringContaining('operator decision required') }],
        },
      },
    })
    harness.close()
  })

  it('persists absent-grant and corpse outcomes instead of returning a success-shaped no-op', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedOrg(harness.sqlite)
    seedAgent(harness.sqlite, 'agent-corpse', 'inactive')
    seedGrant(harness.sqlite, 'g1', 'gate:hadi-river', 'agent', 'agent-corpse')
    seedTask(harness.sqlite, 'task-corpse', 'gate:hadi-river')
    seedTask(harness.sqlite, 'task-absent', 'gate:agent-self-completion')

    const corpse = await updateToReview(harness, 'task-corpse')
    expect(corpse).toMatchObject({
      ok: true,
      result: { gate_wake: { status: 'no_live_holder', capability: 'gate:hadi-river', grant_count: 1 } },
    })
    const absent = await updateToReview(harness, 'task-absent')
    expect(absent).toMatchObject({
      ok: true,
      result: { gate_wake: { status: 'no_live_holder', capability: 'gate:agent-self-completion', grant_count: 0 } },
    })

    const notices = harness.sqlite.prepare(
      `SELECT id, gate_wake_notice FROM tasks WHERE id IN ('task-corpse', 'task-absent') ORDER BY id`,
    ).all() as Array<{ id: string; gate_wake_notice: string }>
    expect(notices[0].gate_wake_notice).toContain('no live holder')
    expect(notices[1].gate_wake_notice).toContain('no live holder')
    harness.close()
  })

  it('surfaces an active member-held gate as requires_human without creating an orphan agent message', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedOrg(harness.sqlite)
    seedMember(harness.sqlite, 'member-hadi')
    seedGrant(harness.sqlite, 'g1', 'gate:hadi', 'member', 'member-hadi')
    seedTask(harness.sqlite, 'task-member', 'gate:hadi')

    const res = await updateToReview(harness, 'task-member')
    expect(res).toMatchObject({
      ok: true,
      result: {
        gate_wake: {
          status: 'requires_human',
          capability: 'gate:hadi',
          principal: { type: 'member', id: 'member-hadi' },
        },
      },
    })
    const messageCount = harness.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_messages').get() as { count: number }
    expect(messageCount.count).toBe(0)
    const notice = harness.sqlite.prepare('SELECT gate_wake_notice FROM tasks WHERE id = ?').get('task-member') as {
      gate_wake_notice: string
    }
    expect(notice.gate_wake_notice).toContain('requires human')
    harness.close()
  })
})
