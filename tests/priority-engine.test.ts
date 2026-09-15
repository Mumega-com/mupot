import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../src/types'
import type { AgentRuntimeState } from '../src/dashboard/observatory'
import {
  MemoryTickStore,
  excludeTask,
  propose,
  resolveSelectedAgent,
  tick,
  type EngineSnapshot,
} from '../src/scheduler/priority-engine'
import { createD1TickStore } from '../src/scheduler/tick-store-sql'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-open',
    squad_id: 'squad-core',
    project_id: 'proj-dev',
    priority: 'P1',
    parent_task_id: null,
    title: 'Write scheduler tests',
    body: 'Deterministic propose-only work.',
    done_when: 'vitest priority-engine tests pass',
    status: 'open',
    assignee_agent_id: null,
    assignee_member_id: null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function snapshot(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  const agentStates = new Map<string, AgentRuntimeState>([['agent-live', 'live']])
  return {
    tasks: [task()],
    projects: new Map([['proj-dev', { id: 'proj-dev', status: 'active', production: false }]]),
    agentStates,
    agents: [{ id: 'agent-live', status: 'active', compatible: true, in_progress_count: 0 }],
    budget: { remaining_micro_usd: 1_000_000, selected_cost_micro_usd: 1_000 },
    actor: 'c51d08bc-9de8-4077-9c51-d9b4778bd0b6',
    ...overrides,
  }
}

describe('eligibility fail-closed', () => {
  it('excludes done/review/blocked and missing/placeholder done_when', () => {
    expect(excludeTask(task({ status: 'done' }), snapshot())).toBe('status_not_open')
    expect(excludeTask(task({ status: 'review' }), snapshot())).toBe('status_not_open')
    expect(excludeTask(task({ status: 'blocked' }), snapshot())).toBe('status_not_open')
    expect(excludeTask(task({ done_when: '   ' }), snapshot())).toBe('missing_done_when')
    expect(excludeTask(task({ done_when: '(backfill required)' }), snapshot())).toBe('placeholder_done_when')
  })

  it('excludes member-owned work and honors the exact live assigned agent', () => {
    expect(excludeTask(task({ assignee_member_id: 'member-hadi' }), snapshot())).toBe('member_owned')
    const assigned = task({ id: 'owned', assignee_agent_id: 'agent-bravo' })
    const twoAgents = snapshot({
      tasks: [assigned],
      agentStates: new Map<string, AgentRuntimeState>([
        ['agent-alpha', 'live'],
        ['agent-bravo', 'live'],
      ]),
      agents: [
        { id: 'agent-alpha', status: 'active', compatible: true, in_progress_count: 0 },
        { id: 'agent-bravo', status: 'active', compatible: true, in_progress_count: 2 },
      ],
    })
    expect(excludeTask(assigned, twoAgents)).toBeNull()
    expect(resolveSelectedAgent(assigned, twoAgents)).toBe('agent-bravo')
    expect(propose(twoAgents, { paused: false, killed: false }).selected_agent_id).toBe('agent-bravo')
  })

  it('excludes unresolved parent, human gates, unsafe work, paused/missing projects, stale agents, over-budget', () => {
    const parentOpen = task({ id: 'parent', status: 'open' })
    const child = task({ id: 'child', parent_task_id: 'parent' })
    expect(excludeTask(child, snapshot({ tasks: [parentOpen, child] }))).toBe('unresolved_dependency')

    expect(excludeTask(task({ gate_owner: 'gate:hadi' }), snapshot())).toBe('human_gate')
    expect(excludeTask(task({ title: 'Please merge to main' }), snapshot())).toBe('unsafe_side_effect')
    expect(excludeTask(task({ body: 'wrangler deploy the worker' }), snapshot())).toBe('unsafe_side_effect')

    const paused = snapshot({
      projects: new Map([['proj-dev', { id: 'proj-dev', status: 'paused', production: false }]]),
    })
    expect(excludeTask(task(), paused)).toBe('project_archived_or_paused')
    const archived = snapshot({
      projects: new Map([['proj-dev', { id: 'proj-dev', status: 'archived', production: false }]]),
    })
    expect(excludeTask(task(), archived)).toBe('project_archived_or_paused')
    expect(excludeTask(task({ project_id: null }), snapshot())).toBe('missing_or_inactive_project')
    const planned = snapshot({
      projects: new Map([['proj-dev', { id: 'proj-dev', status: 'planned', production: false }]]),
    })
    expect(excludeTask(task(), planned)).toBe('missing_or_inactive_project')
    expect(excludeTask(task({ title: 'Waiting human-wait on operator' }), snapshot())).toBe('human_gate')
    expect(excludeTask(task({ execution_receipt_id: 'receipt-open' }), snapshot())).toBe('contradictory_telemetry')

    const stale = snapshot({
      tasks: [task({ assignee_agent_id: 'agent-dead' })],
      agentStates: new Map([['agent-dead', 'stale']]),
      agents: [{ id: 'agent-dead', status: 'active', compatible: true, in_progress_count: 0 }],
    })
    expect(excludeTask(stale.tasks[0], stale)).toBe('stale_or_incompatible_agent')

    expect(excludeTask(task(), snapshot({
      budget: { remaining_micro_usd: 10, selected_cost_micro_usd: 100 },
    }))).toBe('over_budget')
  })
})

describe('propose ranking', () => {
  it('selects the highest-value eligible open task and persists score/exclusions', () => {
    const p0 = task({ id: 'p0', priority: 'P0', created_at: '2026-09-10T00:00:00.000Z' })
    const p1 = task({ id: 'p1', priority: 'P1', created_at: '2026-09-01T00:00:00.000Z' })
    const blocked = task({ id: 'blocked', status: 'blocked', priority: 'P0' })
    const result = propose(snapshot({ tasks: [p1, blocked, p0] }), { paused: false, killed: false })
    expect(result.selected_task_id).toBe('p0')
    expect(result.selected_agent_id).toBe('agent-live')
    expect(result.candidates).toEqual(['p0', 'p1'])
    expect(result.exclusions.some((row) => row.task_id === 'blocked' && row.reason === 'status_not_open')).toBe(true)
    expect(result.score_components.p0.priority_rank).toBe(0)
    expect(result.score_components.p1.priority_rank).toBe(1)
    expect(result.result).toBe('proposed')
  })

  it('refuses when paused or killed', () => {
    expect(propose(snapshot(), { paused: true, killed: false }).result).toBe('refused')
    expect(propose(snapshot(), { paused: false, killed: true }).result).toBe('refused')
    expect(propose(snapshot(), { paused: false, killed: true }).exclusions[0].reason).toBe('engine_killed')
  })
})

describe('tick CAS and modes', () => {
  it('is idempotent for the same key and refuses a concurrent second claim', async () => {
    const store = new MemoryTickStore()
    const first = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'propose',
      idempotency_key: 'tick-1',
      now: '2026-09-15T06:00:00.000Z',
    })
    const replay = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'propose',
      idempotency_key: 'tick-1',
      now: '2026-09-15T06:01:00.000Z',
    })
    expect(replay).toEqual(first)
    expect(first.actor).toBe('c51d08bc-9de8-4077-9c51-d9b4778bd0b6')
    expect(first.dispatch.attempted).toBe(false)

    const raced = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'propose',
      idempotency_key: 'tick-2',
    })
    expect(raced.result).toBe('refused')
    expect(raced.selected_task_id).toBeNull()

    const concurrentStore = new MemoryTickStore()
    const [left, right] = await Promise.all([
      tick({
        store: concurrentStore,
        snapshot: snapshot(),
        control: { paused: false, killed: false },
        mode: 'canary',
        idempotency_key: 'race-a',
        dispatch: async () => 'dispatch-a',
      }),
      tick({
        store: concurrentStore,
        snapshot: snapshot(),
        control: { paused: false, killed: false },
        mode: 'canary',
        idempotency_key: 'race-b',
        dispatch: async () => 'dispatch-b',
      }),
    ])
    const outcomes = [left, right]
    expect(outcomes.filter((row) => row.result === 'dispatched')).toHaveLength(1)
    expect(outcomes.filter((row) => row.result === 'refused')).toHaveLength(1)
    expect(new Set(outcomes.map((row) => row.dispatch.receipt_id).filter(Boolean)).size).toBe(1)
  })

  it('reserves the same idempotency key atomically under Promise.all', async () => {
    const store = new MemoryTickStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    const first = tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'same-key',
      dispatch: async () => {
        calls.push('first')
        await gate
        return 'dispatch-same'
      },
    })
    await Promise.resolve()
    const second = tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'same-key',
      dispatch: async () => {
        calls.push('second')
        return 'should-not-run'
      },
    })
    release()
    const [a, b] = await Promise.all([first, second])
    expect([a, b].filter((row) => row.result === 'dispatched')).toHaveLength(1)
    expect([a, b].some((row) => row.result === 'refused' && row.exclusions[0]?.reason === 'idempotency_in_flight')).toBe(true)
    expect(calls).toEqual(['first'])
  })

  it('propose never dispatches; canary dispatches only on proven active non-production', async () => {
    const store = new MemoryTickStore()
    const calls: string[] = []
    const proposed = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'propose',
      idempotency_key: 'propose-1',
      dispatch: async (taskId) => {
        calls.push(taskId)
        return 'should-not-run'
      },
    })
    expect(proposed.result).toBe('proposed')
    expect(calls).toEqual([])

    const canaryStore = new MemoryTickStore()
    const canary = await tick({
      store: canaryStore,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'canary-1',
      dispatch: async (taskId, agentId) => {
        calls.push(`${taskId}:${agentId}`)
        return 'dispatch-1'
      },
    })
    expect(canary.result).toBe('dispatched')
    expect(canary.dispatch).toEqual({ attempted: true, receipt_id: 'dispatch-1' })
    expect(calls).toEqual(['task-open:agent-live'])

    const prod = await tick({
      store: new MemoryTickStore(),
      snapshot: snapshot({
        projects: new Map([['proj-dev', { id: 'proj-dev', status: 'active', production: true }]]),
      }),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'canary-prod',
      dispatch: async () => 'nope',
    })
    expect(prod.result).toBe('refused')
    expect(prod.dispatch.attempted).toBe(false)
    expect(prod.exclusions.some((row) => row.reason === 'production_or_unproven_scope')).toBe(true)

    const nullProject = await tick({
      store: new MemoryTickStore(),
      snapshot: snapshot({ tasks: [task({ project_id: null })] }),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'canary-null-project',
      dispatch: async () => 'nope',
    })
    expect(nullProject.result).not.toBe('dispatched')
    expect(nullProject.dispatch.attempted).toBe(false)
  })

  it('rolls a failed dispatch back so a later key can claim and persists a failed receipt', async () => {
    const store = new MemoryTickStore()
    const failed = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'fail-1',
      dispatch: async () => {
        throw new Error('dispatch rejected')
      },
    })
    expect(failed.result).toBe('failed')
    expect(failed.dispatch).toEqual({ attempted: true, receipt_id: null })
    expect(await store.get('fail-1')).toEqual(failed)

    const retry = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'fail-2',
      dispatch: async () => 'dispatch-recovered',
    })
    expect(retry.result).toBe('dispatched')
    expect(retry.dispatch.receipt_id).toBe('dispatch-recovered')
  })

  it('fails closed without an authenticated actor', async () => {
    await expect(tick({
      store: new MemoryTickStore(),
      snapshot: snapshot({ actor: '   ' }),
      control: { paused: false, killed: false },
      mode: 'propose',
      idempotency_key: 'no-actor',
    })).rejects.toThrow('priority_engine_actor_unavailable')
  })
})

describe('adversarial current-backlog simulation', () => {
  it('ignores noisy unsafe/human/stale/member-owned work and still picks the lone eligible P0', async () => {
    const eligible = task({
      id: 'safe-p0',
      priority: 'P0',
      title: 'Document dry-run scheduler',
      body: 'No side effects.',
    })
    const noisy: Task[] = [
      task({ id: 'deploy', title: 'Deploy production worker', priority: 'P0' }),
      task({ id: 'hadi', title: 'Need Hadi', gate_owner: 'gate:hadi', priority: 'P0' }),
      task({ id: 'done', status: 'done', priority: 'P0' }),
      task({ id: 'review', status: 'review', priority: 'P0' }),
      task({ id: 'blocked', status: 'blocked', priority: 'P0' }),
      task({ id: 'stale', assignee_agent_id: 'missing', priority: 'P0' }),
      task({ id: 'empty-done', done_when: '', priority: 'P0' }),
      task({ id: 'human-owned', assignee_member_id: 'member-1', priority: 'P0' }),
      task({ id: 'no-project', project_id: null, priority: 'P0' }),
      eligible,
    ]
    const receipt = await tick({
      store: new MemoryTickStore(),
      snapshot: snapshot({ tasks: noisy }),
      control: { paused: false, killed: false },
      mode: 'propose',
      idempotency_key: 'sim-1',
    })
    expect(receipt.selected_task_id).toBe('safe-p0')
    expect(receipt.exclusions.map((row) => row.task_id).sort()).toEqual([
      'blocked', 'deploy', 'done', 'empty-done', 'hadi', 'human-owned', 'no-project', 'review', 'stale',
    ].sort())
    expect(receipt.gate).toBe('athena_required')
  })
})

describe('durable D1 CAS', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  afterEach(() => {
    harness.close()
  })

  it('persists decision/execution receipts and refuses a second same-key dispatch', async () => {
    const store = createD1TickStore(harness.db)
    const first = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'durable-1',
      now: '2026-09-15T11:00:00.000Z',
      dispatch: async () => 'durable-dispatch',
    })
    expect(first.result).toBe('dispatched')
    const replay = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'durable-1',
      dispatch: async () => 'must-not-run',
    })
    expect(replay).toEqual(first)

    const raced = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'durable-2',
      dispatch: async () => 'second',
    })
    expect(raced.result).toBe('refused')

    const rows = harness.sqlite.prepare(
      'SELECT idempotency_key, result FROM priority_engine_receipts ORDER BY idempotency_key',
    ).all()
    expect(rows).toEqual([
      { idempotency_key: 'durable-1', result: 'dispatched' },
      { idempotency_key: 'durable-2', result: 'refused' },
    ])
    expect(() => harness.sqlite.exec(
      "UPDATE priority_engine_receipts SET result = 'failed' WHERE idempotency_key = 'durable-1'",
    )).toThrow(/append-only/)
  })

  it('rolls a durable failed dispatch back so a later key can claim', async () => {
    const store = createD1TickStore(harness.db)
    const failed = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'durable-fail',
      dispatch: async () => {
        throw new Error('rejected')
      },
    })
    expect(failed.result).toBe('failed')
    const claims = harness.sqlite.prepare('SELECT task_id FROM priority_engine_claims').all()
    expect(claims).toEqual([])
    const recovered = await tick({
      store,
      snapshot: snapshot(),
      control: { paused: false, killed: false },
      mode: 'canary',
      idempotency_key: 'durable-recover',
      dispatch: async () => 'recovered',
    })
    expect(recovered.result).toBe('dispatched')
  })
})
