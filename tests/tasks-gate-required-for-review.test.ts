// mupot — gate-exit guard: a task may only ENTER 'review' with a gate_owner.
//
// Root-cause fix for the "ungated review zombie": review only exits to
// approved|rejected via the verdict endpoint, which 409s 'no_gate' without a
// gate_owner. A task that reaches review with a NULL gate_owner therefore has
// no legal exit. The PATCH handler must refuse to create one.

import { describe, expect, it, vi } from 'vitest'
import { tasksApp } from '../src/tasks'
import type { Env, Task } from '../src/types'

const inProgressUngated: Task = {
  id: 'task-1',
  squad_id: 'squad-1',
  project_id: null,
  title: 'Draft the thing',
  body: 'body',
  done_when: 'The thing is drafted and reviewable.',
  status: 'in_progress',
  assignee_agent_id: 'agent-1',
  github_issue_url: null,
  // Valid provenance evidence — unrelated to what this file tests (the
  // gate-exit guard), but present so the artifact gate (mupot#76e25fc2,
  // FLIGHT-07B) doesn't interfere with these fixtures now that it also
  // covers this REST route.
  result: `Done.\nArtifact: /tmp/marker.txt\nSHA256: ${'a'.repeat(64)}`,
  completed_at: null,
  gate_owner: null,
  created_at: '2026-07-14T01:00:00.000Z',
  updated_at: '2026-07-14T02:00:00.000Z',
}

function makeEnv(task: Task) {
  const updates: Array<{ sql: string; args: unknown[] }> = []
  const env = {
    TENANT_SLUG: 'mumega',
    BRAND: 'Mupot',
    SESSIONS: {
      get: vi.fn(async (key: string) => {
        if (key !== 'sess:owner-session') return null
        return JSON.stringify({
          userId: 'owner-1',
          email: 'owner@mupot.test',
          role: 'owner',
          createdAt: '2026-07-14T00:00:00.000Z',
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
                if (sql.includes('FROM tasks')) return task as T
                // G-FP1b point 2/3: canActOnSquad now resolves the squad's
                // kind (in addition to its pre-existing department_id lookup)
                // before honouring the legacy-owner bypass, so it can refuse
                // that bypass on a home squad. Every task in this fixture
                // lives on an ordinary work squad.
                if (sql.includes('FROM squads')) return { department_id: 'dept-1', kind: 'work' } as T
                return null as T
              },
              async run() {
                if (sql.includes('UPDATE tasks')) updates.push({ sql, args })
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
  return { env, updates }
}

function patch(body: unknown) {
  return new Request('https://pot.test/task-1', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      Cookie: 'mupot_session=owner-session',
      Origin: 'https://pot.test',
    },
    body: JSON.stringify(body),
  })
}

describe('PATCH /:id — gate-required-for-review guard', () => {
  it('refuses in_progress → review when no gate_owner is set (would be a zombie)', async () => {
    const { env, updates } = makeEnv(inProgressUngated)
    const res = await tasksApp.fetch(patch({ status: 'review' }), env)
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('gate_required_for_review')
    expect(updates).toHaveLength(0) // nothing written
  })

  it('allows in_progress → review when gate_owner is set in the SAME patch', async () => {
    const { env } = makeEnv(inProgressUngated)
    const res = await tasksApp.fetch(
      patch({ status: 'review', gate_owner: 'gate:content' }),
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: Task }
    expect(body.task.status).toBe('review')
    expect(body.task.gate_owner).toBe('gate:content')
  })

  it('allows in_progress → review when the task already carries a gate_owner', async () => {
    const { env } = makeEnv({ ...inProgressUngated, gate_owner: 'gate:content' })
    const res = await tasksApp.fetch(patch({ status: 'review' }), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: Task }
    expect(body.task.status).toBe('review')
  })

  it('refuses when the patch explicitly nulls gate_owner while entering review', async () => {
    const { env } = makeEnv({ ...inProgressUngated, gate_owner: 'gate:content' })
    const res = await tasksApp.fetch(
      patch({ status: 'review', gate_owner: null }),
      env,
    )
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('gate_required_for_review')
  })

  it('lets an owner repair a historical review task with no gate_owner', async () => {
    const { env, updates } = makeEnv({
      ...inProgressUngated,
      status: 'review',
      gate_owner: null,
    })

    const res = await tasksApp.fetch(
      patch({ gate_owner: 'gate:content' }),
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: Task }
    expect(body.task.status).toBe('review')
    expect(body.task.gate_owner).toBe('gate:content')
    expect(updates.some(({ sql }) => sql.includes('UPDATE tasks'))).toBe(true)
  })
})
