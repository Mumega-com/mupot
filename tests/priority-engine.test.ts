import { describe, expect, it } from 'vitest'
import type { Task } from '../src/types'
import type { AgentRuntimeState } from '../src/dashboard/observatory'
import {
  MemoryTickStore,
  excludeTask,
  propose,
  tick,
  type EngineSnapshot,
} from '../src/scheduler/priority-engine'

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

  it('excludes unresolved parent, human gates, unsafe work, paused projects, stale agents, over-budget', () => {
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

  it('propose never dispatches; canary dispatches exactly once on non-production', async () => {
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
    expect(prod.result).toBe('proposed')
    expect(prod.dispatch.attempted).toBe(false)
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
  it('ignores noisy unsafe/human/stale work and still picks the lone eligible P0', async () => {
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
      'blocked', 'deploy', 'done', 'empty-done', 'hadi', 'review', 'stale',
    ].sort())
    expect(receipt.gate).toBe('athena_required')
  })
})
