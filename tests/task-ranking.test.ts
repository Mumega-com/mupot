// tests/task-ranking.test.ts — #22 v1 ATC task ranking.
//
// Part A: pure unit tests for rankTasks (src/tasks/ranking.ts) — no D1, no
// network, exercises each heuristic from the spec in isolation.
// Part B: a light integration check that the dashboard GET /api/tasks route
// (src/tasks/index.ts) actually applies rankTasks end-to-end, including
// wiring in agent runtime states from the existing radar query.

import { describe, expect, it, vi } from 'vitest'
import { rankTasks, excludeFromRanking } from '../src/tasks/ranking'
import { tasksApp } from '../src/tasks'
import type { Env, Task } from '../src/types'
import type { AgentRuntimeState } from '../src/dashboard/observatory'

// ── fixtures ─────────────────────────────────────────────────────────────────

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-default',
    squad_id: 'squad-1',
    title: 'Untitled',
    body: '',
    done_when: 'something checkable',
    status: 'open',
    assignee_agent_id: null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: null,
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
    ...overrides,
  }
}

const NO_AGENTS: ReadonlyMap<string, AgentRuntimeState> = new Map()

// ═══════════════════════════════════════════════════════════════════════════
// Part A — rankTasks (pure)
// ═══════════════════════════════════════════════════════════════════════════

describe('rankTasks — status band ordering', () => {
  it('ranks in_progress above open, even when the open task is much older', () => {
    const oldOpen = task({ id: 'old-open', status: 'open', created_at: '2020-01-01T00:00:00.000Z' })
    const freshInProgress = task({ id: 'fresh-in-progress', status: 'in_progress', created_at: '2026-07-10T00:00:00.000Z' })

    const ranked = rankTasks([oldOpen, freshInProgress], NO_AGENTS)

    expect(ranked.map((t) => t.id)).toEqual(['fresh-in-progress', 'old-open'])
  })

  it('ranks blocked lowest, even when the blocked task is much older than open/in_progress work', () => {
    const ancientBlocked = task({ id: 'ancient-blocked', status: 'blocked', created_at: '2010-01-01T00:00:00.000Z' })
    const freshOpen = task({ id: 'fresh-open', status: 'open', created_at: '2026-07-10T00:00:00.000Z' })
    const freshInProgress = task({ id: 'fresh-in-progress', status: 'in_progress', created_at: '2026-07-10T00:00:00.000Z' })

    const ranked = rankTasks([ancientBlocked, freshOpen, freshInProgress], NO_AGENTS)

    expect(ranked.map((t) => t.id)).toEqual(['fresh-in-progress', 'fresh-open', 'ancient-blocked'])
  })
})

describe('rankTasks — anti-starvation (older first within the same status)', () => {
  it('orders open tasks oldest-first', () => {
    const newer = task({ id: 'open-newer', status: 'open', created_at: '2026-07-09T00:00:00.000Z' })
    const older = task({ id: 'open-older', status: 'open', created_at: '2026-07-01T00:00:00.000Z' })

    const ranked = rankTasks([newer, older], NO_AGENTS)

    expect(ranked.map((t) => t.id)).toEqual(['open-older', 'open-newer'])
  })

  it('orders in_progress tasks oldest-first', () => {
    const newer = task({ id: 'ip-newer', status: 'in_progress', created_at: '2026-07-09T00:00:00.000Z' })
    const older = task({ id: 'ip-older', status: 'in_progress', created_at: '2026-07-01T00:00:00.000Z' })

    const ranked = rankTasks([newer, older], NO_AGENTS)

    expect(ranked.map((t) => t.id)).toEqual(['ip-older', 'ip-newer'])
  })

  it('breaks a created_at tie deterministically by id', () => {
    const b = task({ id: 'task-b', status: 'open', created_at: '2026-07-10T00:00:00.000Z' })
    const a = task({ id: 'task-a', status: 'open', created_at: '2026-07-10T00:00:00.000Z' })

    const ranked = rankTasks([b, a], NO_AGENTS)

    expect(ranked.map((t) => t.id)).toEqual(['task-a', 'task-b'])
  })
})

describe('rankTasks — stale_assignee flagging', () => {
  const states = new Map<string, AgentRuntimeState>([
    ['agent-live', 'live'],
    ['agent-stale', 'stale'],
    ['agent-offline', 'offline'],
    ['agent-unattached', 'unattached'],
  ])

  it('is false when the task is unassigned', () => {
    const t = task({ id: 'unassigned', assignee_agent_id: null })
    expect(rankTasks([t], states)[0].stale_assignee).toBe(false)
  })

  it('is false when the assignee is live', () => {
    const t = task({ id: 'live-owner', assignee_agent_id: 'agent-live' })
    expect(rankTasks([t], states)[0].stale_assignee).toBe(false)
  })

  it.each(['agent-stale', 'agent-offline', 'agent-unattached'])(
    'is true when the assignee radar state is %s',
    (agentId) => {
      const t = task({ id: 'flagged', assignee_agent_id: agentId })
      expect(rankTasks([t], states)[0].stale_assignee).toBe(true)
    },
  )

  it('is true when the assignee has no radar entry at all (unknown treated as untrustworthy)', () => {
    const t = task({ id: 'ghost-assignee', assignee_agent_id: 'agent-nowhere-in-radar' })
    expect(rankTasks([t], states)[0].stale_assignee).toBe(true)
  })
})

describe('rankTasks — done and gate-pipeline statuses are excluded from scoring but not dropped', () => {
  it('excludeFromRanking classifies exactly the terminal/gate statuses', () => {
    expect(excludeFromRanking('open')).toBe(false)
    expect(excludeFromRanking('in_progress')).toBe(false)
    expect(excludeFromRanking('blocked')).toBe(false)
    expect(excludeFromRanking('done')).toBe(true)
    expect(excludeFromRanking('review')).toBe(true)
    expect(excludeFromRanking('approved')).toBe(true)
    expect(excludeFromRanking('rejected')).toBe(true)
  })

  it('places done tasks after every ranked task, without dropping them', () => {
    const doneOld = task({ id: 'done-old', status: 'done', created_at: '2020-01-01T00:00:00.000Z' })
    const blocked = task({ id: 'a-blocked', status: 'blocked', created_at: '2026-07-10T00:00:00.000Z' })
    const open = task({ id: 'b-open', status: 'open', created_at: '2026-07-10T00:00:00.000Z' })

    const ranked = rankTasks([doneOld, blocked, open], NO_AGENTS)

    // done is never scored (an ancient created_at does not let it jump the
    // queue), but it is still present in the response — dropping it would
    // silently break any caller that today sees the unfiltered full list.
    expect(ranked.map((t) => t.id)).toEqual(['b-open', 'a-blocked', 'done-old'])
  })

  it('preserves the original relative order among passthrough (non-ranked) statuses', () => {
    const reviewFirst = task({ id: 'review-first', status: 'review', created_at: '2026-07-05T00:00:00.000Z' })
    const doneSecond = task({ id: 'done-second', status: 'done', created_at: '2026-07-01T00:00:00.000Z' })
    const rejectedThird = task({ id: 'rejected-third', status: 'rejected', created_at: '2026-07-09T00:00:00.000Z' })

    // Note: doneSecond has the OLDEST created_at of the three, but passthrough
    // tasks are not re-sorted — they keep the order they arrived in.
    const ranked = rankTasks([reviewFirst, doneSecond, rejectedThird], NO_AGENTS)

    expect(ranked.map((t) => t.id)).toEqual(['review-first', 'done-second', 'rejected-third'])
  })

  it('never drops and never duplicates a task across a full mixed-status set', () => {
    const all: Task[] = [
      task({ id: 't-open', status: 'open' }),
      task({ id: 't-in-progress', status: 'in_progress' }),
      task({ id: 't-blocked', status: 'blocked' }),
      task({ id: 't-done', status: 'done' }),
      task({ id: 't-review', status: 'review' }),
      task({ id: 't-approved', status: 'approved' }),
      task({ id: 't-rejected', status: 'rejected' }),
    ]

    const ranked = rankTasks(all, NO_AGENTS)

    expect(ranked).toHaveLength(all.length)
    expect(new Set(ranked.map((t) => t.id))).toEqual(new Set(all.map((t) => t.id)))
  })
})

describe('rankTasks — purity', () => {
  it('does not mutate the input array or its elements', () => {
    const original = [
      task({ id: 'x', status: 'open', created_at: '2026-07-01T00:00:00.000Z' }),
      task({ id: 'y', status: 'in_progress', created_at: '2026-07-05T00:00:00.000Z' }),
    ]
    const snapshot = JSON.parse(JSON.stringify(original))

    rankTasks(original, NO_AGENTS)

    expect(original).toEqual(snapshot)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Part B — wired integration: GET /api/tasks applies rankTasks end-to-end
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/tasks — ranked output, wired end-to-end', () => {
  // Mixed set: if this were still `ORDER BY created_at DESC` unranked, the
  // response order would be recency: task-open-new, task-blocked-mid,
  // task-in-progress-old, task-open-old. The ranked expectation below proves
  // the wiring, not just the pure function.
  const rows: Task[] = [
    task({ id: 'task-open-new', status: 'open', created_at: '2026-07-10T00:00:00.000Z', assignee_agent_id: null }),
    task({ id: 'task-blocked-mid', status: 'blocked', created_at: '2026-07-05T00:00:00.000Z', assignee_agent_id: null }),
    task({ id: 'task-in-progress-old', status: 'in_progress', created_at: '2026-07-01T00:00:00.000Z', assignee_agent_id: 'agent-dead' }),
    task({ id: 'task-open-old', status: 'open', created_at: '2026-07-02T00:00:00.000Z', assignee_agent_id: 'agent-live' }),
  ]

  function makeEnv() {
    const env = {
      TENANT_SLUG: 'test',
      BRAND: 'Test',
      SESSIONS: {
        get: vi.fn(async (key: string) => {
          if (key !== 'sess:sess1') return null
          return JSON.stringify({
            userId: 'owner-1',
            email: 'owner@test.example',
            role: 'owner',
            createdAt: '2026-07-09T00:00:00.000Z',
          })
        }),
        delete: vi.fn(async () => undefined),
      },
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async first<T>() {
                  return null as T
                },
                async all<T>() {
                  if (sql.includes('FROM tasks')) {
                    return { results: [...rows] } as { results: T[] }
                  }
                  // Agent runtime-state radar query (dashboard/observatory.ts
                  // loadAgentRuntimeStates): agent-dead is attached but its
                  // heartbeat reads 'stopped' (offline); agent-live is
                  // attached and fresh (live).
                  if (sql.includes('FROM agents a')) {
                    return {
                      results: [
                        { agent_id: 'agent-dead', key_member_id: 'member-dead', fleet_status: 'stopped', last_reported_at: null },
                        { agent_id: 'agent-live', key_member_id: 'member-live', fleet_status: 'active', last_reported_at: new Date().toISOString().replace('T', ' ').slice(0, 19) },
                      ],
                    } as { results: T[] }
                  }
                  return { results: [] } as { results: T[] }
                },
              }
            },
          }
        },
      },
    } as unknown as Env
    return env
  }

  it('reorders by status band + staleness, and flags the assignee whose agent has gone dark', async () => {
    const env = makeEnv()
    const res = await tasksApp.fetch(
      new Request('https://pot.test/', { headers: { Cookie: 'mupot_session=sess1' } }),
      env,
    )
    const body = (await res.json()) as { tasks: Array<Task & { stale_assignee: boolean }> }

    expect(res.status).toBe(200)
    // in_progress first, then open oldest-first, then blocked last.
    expect(body.tasks.map((t) => t.id)).toEqual([
      'task-in-progress-old',
      'task-open-old',
      'task-open-new',
      'task-blocked-mid',
    ])

    const byId = Object.fromEntries(body.tasks.map((t) => [t.id, t]))
    expect(byId['task-in-progress-old'].stale_assignee).toBe(true) // agent-dead → offline
    expect(byId['task-open-old'].stale_assignee).toBe(false) // agent-live → live
    expect(byId['task-open-new'].stale_assignee).toBe(false) // unassigned
  })
})
