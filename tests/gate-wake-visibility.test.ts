import { describe, expect, it } from 'vitest'
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
      const outcome = await wakeGateOwnerOnReview(env, task, { kind: 'member', id: ACTOR_ID }, ACTOR_ID)
      expect(outcome).toMatchObject({ status: 'delivered', skipped_holders: [
        { type: 'agent', id: 'agent-builder', reason: 'task_assignee' },
        { type: 'agent', id: 'agent-stale', reason: 'not_live' },
      ] })
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
        status: 'no_live_holder', skipped_holders: [{ type: 'agent', id: 'agent-builder', reason: 'task_assignee' }],
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

  it('persists an ambiguous live-holder outcome with the capability and holders', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedOrg(harness.sqlite)
    seedAgent(harness.sqlite, 'agent-live-a')
    seedAgent(harness.sqlite, 'agent-live-b')
    seedGrant(harness.sqlite, 'g1', 'gate:kayhermes', 'agent', 'agent-live-a')
    seedGrant(harness.sqlite, 'g2', 'gate:kayhermes', 'agent', 'agent-live-b')
    seedTask(harness.sqlite, 'task-ambiguous', 'gate:kayhermes')

    const res = await updateToReview(harness, 'task-ambiguous')
    expect(res).toMatchObject({
      ok: true,
      result: {
        gate_wake: {
          status: 'ambiguous',
          capability: 'gate:kayhermes',
          active_holders: [
            { type: 'agent', id: 'agent-live-a' },
            { type: 'agent', id: 'agent-live-b' },
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
