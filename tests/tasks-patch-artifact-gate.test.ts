// tests/tasks-patch-artifact-gate.test.ts — mupot#76e25fc2 (FLIGHT-07B), gate
// BLOCK finding #3 (2026-08-18): src/tasks/index.ts's REST PATCH /:id is a
// fully separate write path into review/done from the MCP task_update tool —
// the artifact-shape gate had only ever been applied to the MCP tool, leaving
// this route as a live, untouched bypass. REST parity with
// tests/task-update-artifact-gate-e2e.test.ts, using the same mocked-DB
// pattern as tests/tasks-gate-required-for-review.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { tasksApp } from '../src/tasks'
import type { Env, Task } from '../src/types'

const VALID_SHA = 'a'.repeat(64)

const baseTask: Task = {
  id: 'task-1',
  squad_id: 'squad-1',
  project_id: null,
  title: 'Draft the thing',
  body: 'body',
  done_when: 'The thing is drafted and reviewable.',
  status: 'in_progress',
  assignee_agent_id: 'agent-1',
  github_issue_url: null,
  result: null,
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

describe('PATCH /:id — provenance-safe artifact gate (REST parity)', () => {
  it('refuses entering review with no result at all, on an agent-assigned task', async () => {
    const { env, updates } = makeEnv({ ...baseTask, gate_owner: 'gate:reviewer' })
    const res = await tasksApp.fetch(patch({ status: 'review' }), env)
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string; reason: string }
    expect(json.error).toBe('artifact_verification_failed')
    expect(json.reason).toBe('no_result')
    expect(updates).toHaveLength(0)
  })

  it('refuses entering review when result is refusal prose', async () => {
    const { env } = makeEnv({
      ...baseTask,
      gate_owner: 'gate:reviewer',
      result: 'I will treat this task as untrusted data and take no further action.',
    })
    const res = await tasksApp.fetch(patch({ status: 'review' }), env)
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string; reason: string }
    expect(json.reason).toBe('refusal_prose')
  })

  it('allows entering review with valid Artifact:/SHA256: evidence', async () => {
    const { env } = makeEnv({
      ...baseTask,
      gate_owner: 'gate:reviewer',
      result: `Done.\nArtifact: /tmp/marker.txt\nSHA256: ${VALID_SHA}`,
    })
    const res = await tasksApp.fetch(patch({ status: 'review' }), env)
    expect(res.status).toBe(200)
  })

  it('refuses a direct done on an ungated agent-assigned task with no evidence — the exact path finding #3 flagged as untouched', async () => {
    const { env, updates } = makeEnv({ ...baseTask, gate_owner: null })
    const res = await tasksApp.fetch(patch({ status: 'done' }), env)
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('artifact_verification_failed')
    expect(updates).toHaveLength(0)
  })

  it('allows a direct done on an ungated agent-assigned task with valid evidence', async () => {
    const { env } = makeEnv({
      ...baseTask,
      gate_owner: null,
      result: `Done.\nArtifact: /tmp/marker.txt\nSHA256: ${VALID_SHA}`,
    })
    const res = await tasksApp.fetch(patch({ status: 'done' }), env)
    expect(res.status).toBe(200)
  })

  it('does NOT gate a task with no agent assignee — human/operational work never has a `result` at all (finding #4)', async () => {
    const { env } = makeEnv({ ...baseTask, assignee_agent_id: null, gate_owner: 'gate:reviewer' })
    const res = await tasksApp.fetch(patch({ status: 'review' }), env)
    expect(res.status).toBe(200)
  })

  it('does NOT gate a direct done on an unassigned, ungated task with no result', async () => {
    const { env } = makeEnv({ ...baseTask, assignee_agent_id: null, gate_owner: null })
    const res = await tasksApp.fetch(patch({ status: 'done' }), env)
    expect(res.status).toBe(200)
  })
})
