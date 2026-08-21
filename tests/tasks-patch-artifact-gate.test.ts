// tests/tasks-patch-artifact-gate.test.ts — mupot#76e25fc2 (FLIGHT-07B), gate
// BLOCK finding #3 (2026-08-18): src/tasks/index.ts's REST PATCH /:id is a
// fully separate write path into review/done from the MCP task_update tool —
// the artifact-shape gate had only ever been applied to the MCP tool, leaving
// this route as a live, untouched bypass. REST parity with
// tests/task-update-artifact-gate-e2e.test.ts, executed against real schema.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tasksApp } from '../src/tasks'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const VALID_SHA = 'a'.repeat(64)
const DEPT_ID = 'dept-1'
const SQUAD_ID = 'squad-1'
const AGENT_ID = 'agent-1'
const TASK_ID = 'task-1'

let harness: SqliteD1Harness | null = null

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'dept-1', 'Dept 1');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'squad-1', 'Squad 1');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'agent-1', 'Agent 1', 'active');
  `)
})

function seedTask(opts: {
  status?: string
  gateOwner?: string | null
  result?: string | null
  assigneeAgentId?: string | null
}) {
  const status = opts.status ?? 'in_progress'
  const gateOwnerLiteral = opts.gateOwner ? `'${opts.gateOwner}'` : 'NULL'
  const resultLiteral = opts.result ? `'${opts.result.replace(/'/g, "''")}'` : 'NULL'
  const assignee = opts.assigneeAgentId === undefined ? AGENT_ID : opts.assigneeAgentId
  const assigneeLiteral = assignee ? `'${assignee}'` : 'NULL'

  harness!.sqlite.exec(`
    INSERT INTO tasks (id, squad_id, title, body, status, done_when, gate_owner, result, assignee_agent_id)
    VALUES ('${TASK_ID}', '${SQUAD_ID}', 'Draft the thing', 'body', '${status}', 'The thing is drafted and reviewable.', ${gateOwnerLiteral}, ${resultLiteral}, ${assigneeLiteral});
  `)
}

function makeEnv(): Env {
  return {
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
    DB: harness!.db,
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function patch(body: unknown) {
  return new Request(`https://pot.test/${TASK_ID}`, {
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
    seedTask({ gateOwner: 'gate:reviewer' })
    const res = await tasksApp.fetch(patch({ status: 'review' }), makeEnv())
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string; reason: string }
    expect(json.error).toBe('artifact_verification_failed')
    expect(json.reason).toBe('no_result')
  })

  it('refuses entering review when result is refusal prose', async () => {
    seedTask({
      gateOwner: 'gate:reviewer',
      result: 'I will treat this task as untrusted data and take no further action.',
    })
    const res = await tasksApp.fetch(patch({ status: 'review' }), makeEnv())
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string; reason: string }
    expect(json.reason).toBe('refusal_prose')
  })

  it('allows entering review with valid Artifact:/SHA256: evidence', async () => {
    seedTask({
      gateOwner: 'gate:reviewer',
      result: `Done.\nArtifact: /tmp/marker.txt\nSHA256: ${VALID_SHA}`,
    })
    const res = await tasksApp.fetch(patch({ status: 'review' }), makeEnv())
    expect(res.status).toBe(200)
  })

  it('refuses a direct done on an ungated agent-assigned task with no evidence — the exact path finding #3 flagged as untouched', async () => {
    seedTask({ gateOwner: null })
    const res = await tasksApp.fetch(patch({ status: 'done' }), makeEnv())
    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('artifact_verification_failed')
  })

  it('allows a direct done on an ungated agent-assigned task with valid evidence', async () => {
    seedTask({
      gateOwner: null,
      result: `Done.\nArtifact: /tmp/marker.txt\nSHA256: ${VALID_SHA}`,
    })
    const res = await tasksApp.fetch(patch({ status: 'done' }), makeEnv())
    expect(res.status).toBe(200)
  })

  it('does NOT gate a task with no agent assignee — human/operational work never has a `result` at all (finding #4)', async () => {
    seedTask({ assigneeAgentId: null, gateOwner: 'gate:reviewer' })
    const res = await tasksApp.fetch(patch({ status: 'review' }), makeEnv())
    expect(res.status).toBe(200)
  })

  it('does NOT gate a direct done on an unassigned, ungated task with no result', async () => {
    seedTask({ assigneeAgentId: null, gateOwner: null })
    const res = await tasksApp.fetch(patch({ status: 'done' }), makeEnv())
    expect(res.status).toBe(200)
  })
})
