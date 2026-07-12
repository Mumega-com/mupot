import { describe, expect, it } from 'vitest'
import { TOOLS, invokeTool } from '../src/mcp'
import type { AuthContext, Capability, CapabilityGrant, Env, Task } from '../src/types'

const TENANT = 'test-tenant'
const MEMBER_ID = 'member-1'
const SQUAD_ID = 'squad-1'
const OTHER_SQUAD_ID = 'squad-2'
const AGENT_ID = 'agent-1'

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    squad_id: SQUAD_ID,
    title: 'Ship the adapter',
    body: 'wire the task tools',
    done_when: 'task tool tests pass',
    status: 'open',
    assignee_agent_id: null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: null,
    created_at: '2026-07-08T00:00:00.000Z',
    updated_at: '2026-07-08T00:00:00.000Z',
    ...overrides,
  }
}

type CrossSquadAssignee = {
  memberId?: string
  capability?: Capability
}

function makeEnv(
  rows: Task[] = [task()],
  crossSquadAssignee: CrossSquadAssignee = {},
  agentStatuses: Partial<Record<string, string>> = {},
) {
  const updates: { sql: string; args: unknown[] }[] = []
  const events: unknown[] = []
  const agents = new Map([
    [AGENT_ID, { id: AGENT_ID, squad_id: SQUAD_ID, slug: 'agent-one', name: 'Agent One', role: null, model: null, status: agentStatuses[AGENT_ID] ?? 'active', created_at: 'now' }],
    ['agent-other', { id: 'agent-other', squad_id: OTHER_SQUAD_ID, slug: 'other', name: 'Other', role: null, model: null, status: agentStatuses['agent-other'] ?? 'active', created_at: 'now' }],
  ])
  const squads = new Map([
    [SQUAD_ID, { id: SQUAD_ID, department_id: 'dept-1', slug: 'squad-one', name: 'Squad One', charter: null, created_at: 'now' }],
    [OTHER_SQUAD_ID, { id: OTHER_SQUAD_ID, department_id: 'dept-2', slug: 'squad-two', name: 'Squad Two', charter: null, created_at: 'now' }],
  ])
  const tasks = new Map(rows.map((r) => [r.id, r]))
  const assigneeMemberId = crossSquadAssignee.memberId
  const agentMembers = new Map<string, string[]>(
    assigneeMemberId ? [['agent-other', [assigneeMemberId]]] : [],
  )
  const grants = new Map<string, CapabilityGrant[]>(
    assigneeMemberId && crossSquadAssignee.capability
      ? [[assigneeMemberId, [{
        member_id: assigneeMemberId,
        scope_type: 'squad',
        scope_id: SQUAD_ID,
        capability: crossSquadAssignee.capability,
      }]]]
      : [],
  )

  const env = {
    TENANT_SLUG: TENANT,
    BUS: {
      send: async (event: unknown) => {
        events.push(event)
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM agents WHERE id = ?1')) return agents.get(args[0] as string) ?? null
                if (sql.includes('SELECT department_id FROM squads')) {
                  return { department_id: squads.get(args[0] as string)?.department_id ?? null }
                }
                if (sql.includes('FROM squads WHERE id = ?1')) return squads.get(args[0] as string) ?? null
                if (sql.includes('FROM tasks WHERE id = ?1')) return tasks.get(args[0] as string) ?? null
                return null
              },
              async all() {
                if (sql.includes('SELECT DISTINCT t.member_id')) {
                  return {
                    results: (agentMembers.get(args[1] as string) ?? []).map((member_id) => ({ member_id })),
                  }
                }
                if (sql.includes('FROM capabilities') && sql.includes('UNION ALL')) {
                  return { results: grants.get(args[0] as string) ?? [] }
                }
                if (sql.includes('FROM tasks')) {
                  const squadId = args[0] as string
                  let result = rows.filter((r) => r.squad_id === squadId)
                  if (sql.includes('status = ?2')) result = result.filter((r) => r.status === args[1])
                  if (sql.includes('assignee_agent_id')) {
                    const assignee = args.find((a) => typeof a === 'string' && String(a).startsWith('agent-'))
                    if (assignee) result = result.filter((r) => r.assignee_agent_id === assignee)
                  }
                  return { results: result }
                }
                return { results: [] }
              },
              async run() {
                updates.push({ sql, args })
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  } as unknown as Env

  return { env, updates, events }
}

describe('MCP task cutover tools', () => {
  it('advertises task_list, task_board, task_update, and task_dispatch on the MCP surface', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['task_create', 'task_list', 'task_board', 'task_update', 'task_dispatch']))
  })

  it('advertises an optional task_create assignee', () => {
    const taskCreate = TOOLS.find((tool) => tool.name === 'task_create')

    expect(taskCreate?.inputSchema.properties).toMatchObject({
      assignee_agent_id: { type: 'string' },
    })
  })

  it('task_create passes a shared-policy-resolved assignee to createTask', async () => {
    const { env, updates } = makeEnv([], { memberId: 'member-other', capability: 'member' })

    const res = await invokeTool(
      auth(),
      env,
      'task_create',
      {
        squad_id: SQUAD_ID,
        title: 'Assign the shared-policy task',
        done_when: 'MCP task tests pass',
        assignee_agent_id: 'agent-other',
      },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    expect((res.result as { task: Task }).task.assignee_agent_id).toBe('agent-other')
    expect(updates[0].sql).toContain('INSERT INTO tasks')
    expect(updates[0].args[6]).toBe('agent-other')
  })

  it('task_list defaults an agent-bound token to its own squad and filters status', async () => {
    const { env } = makeEnv([
      task({ id: 'task-open', status: 'open' }),
      task({ id: 'task-done', status: 'done' }),
      task({ id: 'task-other', squad_id: OTHER_SQUAD_ID, status: 'open' }),
    ])

    const res = await invokeTool(auth(), env, 'task_list', { status: 'open', limit: 10 }, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as { squad_id: string; tasks: Task[] }
    expect(result.squad_id).toBe(SQUAD_ID)
    expect(result.tasks.map((t) => t.id)).toEqual(['task-open'])
  })

  it('task_board groups visible squad tasks by lifecycle status', async () => {
    const { env } = makeEnv([
      task({ id: 'task-open', status: 'open' }),
      task({ id: 'task-review', status: 'review' }),
      task({ id: 'task-blocked', status: 'blocked' }),
    ])

    const res = await invokeTool(auth(), env, 'task_board', {}, 'https://pot.example')

    expect(res.ok).toBe(true)
    const result = res.result as { counts: Record<string, number>; columns: Record<string, Task[]> }
    expect(result.counts.open).toBe(1)
    expect(result.counts.review).toBe(1)
    expect(result.counts.blocked).toBe(1)
    expect(result.columns.review[0].id).toBe('task-review')
  })

  it('task_update applies transition gates, same-squad assignment, and emits task.updated', async () => {
    const { env, updates, events } = makeEnv([task()])

    const res = await invokeTool(
      auth(),
      env,
      'task_update',
      { task_id: 'task-1', status: 'in_progress', assignee_agent_id: AGENT_ID, body: 'updated' },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    const result = res.result as { task: Task }
    expect(result.task.status).toBe('in_progress')
    expect(result.task.assignee_agent_id).toBe(AGENT_ID)
    expect(result.task.body).toBe('updated')
    expect(updates[0].sql).toContain('UPDATE tasks')
    expect(updates[0].args).toEqual([
      'Ship the adapter',
      'updated',
      'task tool tests pass',
      'in_progress',
      AGENT_ID,
      null,
      null,
      null,
      result.task.updated_at,
      'task-1',
    ])
    expect(events).toEqual([
      expect.objectContaining({
        type: 'task.updated',
        squad_id: SQUAD_ID,
        actor: { kind: 'member', id: MEMBER_ID },
      }),
    ])
  })

  it('task_update accepts a cross-squad assignee with one active bound member and a target-squad member grant', async () => {
    const { env } = makeEnv([task()], { memberId: 'member-other', capability: 'member' })

    const res = await invokeTool(
      auth(),
      env,
      'task_update',
      { task_id: 'task-1', assignee_agent_id: 'agent-other' },
      'https://pot.example',
    )

    expect(res).toMatchObject({ ok: true, result: { task: { assignee_agent_id: 'agent-other' } } })
  })

  it('task_update fails closed for a cross-squad assignee without an active bound member', async () => {
    const { env } = makeEnv()

    const res = await invokeTool(
      auth(),
      env,
      'task_update',
      { task_id: 'task-1', assignee_agent_id: 'agent-other' },
      'https://pot.example',
    )

    expect(res).toMatchObject({ ok: false, status: 400, error: 'assignee_not_in_squad' })
  })

  it('task_update fails closed for observer-only cross-squad authority', async () => {
    const { env } = makeEnv([task()], { memberId: 'member-other', capability: 'observer' })

    const res = await invokeTool(
      auth(),
      env,
      'task_update',
      { task_id: 'task-1', assignee_agent_id: 'agent-other' },
      'https://pot.example',
    )

    expect(res).toMatchObject({ ok: false, status: 400, error: 'assignee_not_in_squad' })
  })

  it('task_update refuses cross-squad tasks even when the caller has a member grant elsewhere', async () => {
    const { env } = makeEnv([task({ squad_id: OTHER_SQUAD_ID })])

    const res = await invokeTool(auth(), env, 'task_update', { task_id: 'task-1', status: 'in_progress' }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(res.error).toBe('forbidden')
  })

  it('task_update refuses invalid lifecycle jumps', async () => {
    const { env } = makeEnv([task({ status: 'open' })])

    const res = await invokeTool(auth(), env, 'task_update', { task_id: 'task-1', status: 'done' }, 'https://pot.example')

    expect(res.ok).toBe(false)
    expect(res.error).toBe('invalid_transition')
  })

  it('task_update records completion time when an approved task transitions to done', async () => {
    const { env, updates } = makeEnv([
      task({ status: 'approved', gate_owner: 'gate:m0-census' }),
    ])

    const res = await invokeTool(
      auth(),
      env,
      'task_update',
      { task_id: 'task-1', status: 'done' },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    const result = res.result as { task: Task }
    expect(result.task.completed_at).toBe(result.task.updated_at)
    expect(result.task.completed_at).not.toBeNull()
    expect(updates[0].sql).toContain('completed_at = ?')
    expect(updates[0].args).toContain(result.task.completed_at)
  })

  it('task_update records completion time for an ordinary in-progress task', async () => {
    const { env } = makeEnv([task({ status: 'in_progress' })])

    const res = await invokeTool(
      auth(),
      env,
      'task_update',
      { task_id: 'task-1', status: 'done' },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    const result = res.result as { task: Task }
    expect(result.task.completed_at).toBe(result.task.updated_at)
  })

  it('task_update preserves completion time when editing an already-completed task', async () => {
    const completedAt = '2026-07-08T01:00:00.000Z'
    const { env } = makeEnv([
      task({ status: 'done', completed_at: completedAt }),
    ])

    const res = await invokeTool(
      auth(),
      env,
      'task_update',
      { task_id: 'task-1', title: 'Clarify the completed task' },
      'https://pot.example',
    )

    expect(res.ok).toBe(true)
    const result = res.result as { task: Task }
    expect(result.task.completed_at).toBe(completedAt)
    expect(result.task.updated_at).not.toBe(task().updated_at)
  })

  it('task_dispatch emits a canonical task-scoped wake for the stored assignee', async () => {
    const { env, events } = makeEnv([task({ assignee_agent_id: AGENT_ID })])

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: 'task-1' }, 'https://pot.example')

    expect(res).toMatchObject({
      ok: true,
      result: {
        dispatched: true,
        task_id: 'task-1',
        agent_id: AGENT_ID,
        squad_id: SQUAD_ID,
        receipt: {
          id: expect.any(String),
          dispatched_by: { kind: 'member', id: MEMBER_ID },
          dispatched_at: expect.any(String),
        },
      },
    })
    const result = res.result as { receipt: { id: string } }
    expect(events).toEqual([
      expect.objectContaining({
        type: 'agent.wake',
        tenant: TENANT,
        squad_id: SQUAD_ID,
        agent_id: AGENT_ID,
        actor: { kind: 'member', id: MEMBER_ID },
        payload: {
          task_id: 'task-1',
          by: MEMBER_ID,
          dispatch_receipt_id: result.receipt.id,
        },
      }),
    ])
  })

  it('task_dispatch refuses an unassigned task without emitting a wake', async () => {
    const { env, events } = makeEnv([task()])

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: 'task-1' }, 'https://pot.example')

    expect(res).toMatchObject({ ok: false, status: 409, error: 'task_not_dispatchable' })
    expect(events).toEqual([])
  })

  it('task_dispatch refuses a task outside the caller capability scope', async () => {
    const { env, events } = makeEnv([
      task({ squad_id: OTHER_SQUAD_ID, assignee_agent_id: 'agent-other' }),
    ])

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: 'task-1' }, 'https://pot.example')

    expect(res).toMatchObject({ ok: false, status: 404, error: 'task_not_found' })
    expect(events).toEqual([])
  })

  it('task_dispatch revalidates cross-squad assignment before emitting a wake', async () => {
    const { env, events } = makeEnv(
      [task({ assignee_agent_id: 'agent-other' })],
      { memberId: 'member-other', capability: 'member' },
    )

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: 'task-1' }, 'https://pot.example')

    expect(res).toMatchObject({ ok: true, result: { agent_id: 'agent-other' } })
    expect(events).toHaveLength(1)
  })

  it('task_dispatch fails closed when cross-squad authority was revoked', async () => {
    const { env, events } = makeEnv([task({ assignee_agent_id: 'agent-other' })])

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: 'task-1' }, 'https://pot.example')

    expect(res).toMatchObject({ ok: false, status: 409, error: 'task_not_dispatchable' })
    expect(events).toEqual([])
  })

  it('task_dispatch fails closed when the assigned agent is inactive', async () => {
    const { env, events } = makeEnv(
      [task({ assignee_agent_id: AGENT_ID })],
      {},
      { [AGENT_ID]: 'paused' },
    )

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: 'task-1' }, 'https://pot.example')

    expect(res).toMatchObject({ ok: false, status: 409, error: 'task_not_dispatchable' })
    expect(events).toEqual([])
  })

  it('task_dispatch refuses terminal tasks', async () => {
    const { env, events } = makeEnv([task({ status: 'done', assignee_agent_id: AGENT_ID })])

    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: 'task-1' }, 'https://pot.example')

    expect(res).toMatchObject({ ok: false, status: 409, error: 'task_not_runnable' })
    expect(events).toEqual([])
  })
})
