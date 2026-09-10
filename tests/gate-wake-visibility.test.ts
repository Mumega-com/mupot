import { describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { AuthContext, Env } from '../src/types'

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
