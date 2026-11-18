import { describe, expect, it, vi } from 'vitest'

// #2450: a controllable seam over the presence read so a THROWING lookup can be proven to count as not-live.
const liveness = vi.hoisted(() => ({ throwFor: new Set<string>() }))
vi.mock('../src/fleet/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fleet/registry')>()
  return {
    ...actual,
    getFleetAgentLiveness: async (...args: Parameters<typeof actual.getFleetAgentLiveness>) => {
      if (liveness.throwFor.has(args[1])) throw new Error('presence read failed')
      return actual.getFleetAgentLiveness(...args)
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
      // live first (agent-live-b), then holders without fresh presence, then skipped holders
      expect(outcome.holders).toEqual([
        { type: 'agent', id: 'agent-live-b', status: 'delivered' },
        { type: 'agent', id: 'agent-live-a', status: 'delivered' },
        { type: 'agent', id: 'agent-stale', status: 'delivered' },
        { type: 'agent', id: 'agent-builder', status: 'skipped_task_assignee' },
      ])
      // Response detail is trimmed: no per-holder presence or channel internals.
      expect(outcome).not.toHaveProperty('deliveries')
      expect(outcome).not.toHaveProperty('skipped_holders')
    } finally { harness.close() }
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
      expect(outcome.holders?.slice(0, 2).map(h => h.id)).toEqual(['agent-live-b', 'agent-live-a'])
    } finally { liveness.throwFor.clear(); harness.close() }
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
      expect(outcome.notice).toBe('Gate wake not delivered: every agent holder of gate:kasra-core is ineligible (agent-builder (task_assignee), agent-live-a (self_verdict)); member holders keep their needs_you item.')
      expect(outcome.notice).not.toContain('live holders')
      expect(events).toEqual([])
    } finally { harness.close() }
  })

  it('#2450-6: caps the fan-out at 10 holders, live first, and records the cap', async () => {
    const { harness, env, task } = fanoutFixture()
    try {
      for (let i = 0; i < 10; i++) {
        const id = `agent-extra-${String(i).padStart(2, '0')}`
        seedAgent(harness.sqlite, id)
        seedGrant(harness.sqlite, `grant-${id}`, 'gate:kasra-core', 'agent', id)
      }
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      // 13 eligible (live-a, live-b, stale, 10 extras without presence): 10 woken, the live two among them.
      expect(outcome).toMatchObject({ status: 'delivered', presence: { live: 2, total: 13 }, width_cap: { limit: 10, omitted: 3 } })
      const woken = (harness.sqlite.prepare('SELECT to_agent FROM agent_messages').all() as Array<{ to_agent: string }>).map(r => r.to_agent)
      expect(woken).toHaveLength(10)
      expect(woken).toEqual(expect.arrayContaining(['agent-live-a', 'agent-live-b']))
      expect(outcome.holders?.filter(h => h.status === 'skipped_width_cap')).toHaveLength(3)
      expect(outcome.notice).toContain('width cap 10 reached; 3 eligible holders not woken')
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
