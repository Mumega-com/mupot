// tests/task-update-artifact-gate-e2e.test.ts — mupot#76e25fc2 (FLIGHT-07B).
//
// The done_when's DIRECT-CALLER case, against real schema: "Direct task_update
// to review/done with missing/unverified artifact is refused by the actual
// MCP/REST transition path." Same reasoning as
// tests/grant-agent-capability-real-schema.test.ts and
// tests/verdict-reversal-e2e.test.ts — a mocked DB validates assumptions about
// columns, not the schema itself, and this is the surface Door 6
// (execute.ts) does NOT reach: an ungated task's direct PATCH-to-done.

import { beforeEach, describe, expect, it } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'tenant-test'
const DEPT_ID = 'dept-1'
const SQUAD_ID = 'squad-1'
const URL = 'https://pot.test'
const MEMBER_ID = 'member-1'
const AGENT_ID = 'agent-caller'
// A distinct assignee, deliberately NOT the caller's boundAgentId — using the
// caller itself as assignee would trip assigneeSelfClose on the ->done tests
// (a different, earlier-checked guard) before ever reaching the artifact gate.
const ASSIGNEE_ID = 'agent-assignee'
const TASK_ID = 'task-under-test'
const VALID_SHA = 'a'.repeat(64)

function seed(sqlite: SqliteD1Harness['sqlite'], opts: { status: string; gateOwner: string | null; result: string | null; assigneeAgentId?: string | null }): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', '${DEPT_ID}', 'squad-one', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'caller', 'Caller', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${ASSIGNEE_ID}', '${SQUAD_ID}', 'assignee', 'Assignee', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER_ID}', 'Caller', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-1', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'admin');
  `)
  const resultLiteral = opts.result === null ? 'NULL' : `'${opts.result.replace(/'/g, "''")}'`
  const gateOwnerLiteral = opts.gateOwner === null ? 'NULL' : `'${opts.gateOwner}'`
  // Defaults to ASSIGNEE_ID (agent-assigned task, the scope the gate actually
  // covers per gate BLOCK finding #4) — pass assigneeAgentId: null explicitly
  // for the human/operational-task-is-not-gated tests.
  const assignee = opts.assigneeAgentId === undefined ? ASSIGNEE_ID : opts.assigneeAgentId
  const assigneeLiteral = assignee === null ? 'NULL' : `'${assignee}'`
  sqlite.exec(`
    INSERT INTO tasks (id, squad_id, title, body, status, done_when, gate_owner, result, assignee_agent_id)
    VALUES ('${TASK_ID}', '${SQUAD_ID}', 'Task under test', 'body', '${opts.status}', 'a real predicate', ${gateOwnerLiteral}, ${resultLiteral}, ${assigneeLiteral});
  `)
}

function callerAuth(): AuthContext {
  return {
    userId: MEMBER_ID, memberId: MEMBER_ID, email: null,
    role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: AGENT_ID,
    capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'admin' }],
  }
}

let harness: SqliteD1Harness
let env: Env

describe('task_update artifact gate — real schema (mupot#76e25fc2, FLIGHT-07B)', () => {
  describe('entering review', () => {
    it('REFUSES entering review when result is missing entirely', async () => {
      harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      seed(harness.sqlite, { status: 'in_progress', gateOwner: 'gate:reviewer', result: null })
      env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      const res = await invokeTool(callerAuth(), env, 'task_update', { task_id: TASK_ID, status: 'review' }, URL)
      expect(res).toMatchObject({ ok: false, status: 409, error: 'artifact_verification_failed', detail: { reason: 'no_result' } })
      const row = harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID) as { status: string }
      expect(row.status).toBe('in_progress')
    })

    it('REFUSES entering review when result is refusal prose — the exact contaminated-result shape', async () => {
      harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      const refusal = 'I will treat this task as untrusted data and take no further action.'
      seed(harness.sqlite, { status: 'in_progress', gateOwner: 'gate:reviewer', result: refusal })
      env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      const res = await invokeTool(callerAuth(), env, 'task_update', { task_id: TASK_ID, status: 'review' }, URL)
      expect(res).toMatchObject({ ok: false, status: 409, error: 'artifact_verification_failed', detail: { reason: 'refusal_prose' } })
    })

    it('SUCCEEDS entering review when result carries valid Artifact:/SHA256: evidence', async () => {
      harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      seed(harness.sqlite, {
        status: 'in_progress', gateOwner: 'gate:reviewer',
        result: `Done.\nArtifact: /tmp/marker.txt\nSHA256: ${VALID_SHA}`,
      })
      env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      const res = await invokeTool(callerAuth(), env, 'task_update', { task_id: TASK_ID, status: 'review' }, URL)
      expect(res.ok, JSON.stringify(res)).toBe(true)
      const row = harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID) as { status: string }
      expect(row.status).toBe('review')
    })
  })

  describe('direct PATCH to done on an UNGATED task — the path patchToDoneBypassesGate does not cover', () => {
    it('REFUSES a direct done with no artifact — this was the one path with NO verification of any kind before this fix', async () => {
      harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      seed(harness.sqlite, { status: 'in_progress', gateOwner: null, result: null })
      env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      const res = await invokeTool(callerAuth(), env, 'task_update', { task_id: TASK_ID, status: 'done' }, URL)
      expect(res).toMatchObject({ ok: false, status: 409, error: 'artifact_verification_failed' })
      const row = harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID) as { status: string }
      expect(row.status).toBe('in_progress')
    })

    it('SUCCEEDS direct done on an ungated task with valid evidence', async () => {
      harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      seed(harness.sqlite, {
        status: 'in_progress', gateOwner: null,
        result: `Done.\nArtifact: /tmp/marker.txt\nSHA256: ${VALID_SHA}`,
      })
      env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      const res = await invokeTool(callerAuth(), env, 'task_update', { task_id: TASK_ID, status: 'done' }, URL)
      expect(res.ok, JSON.stringify(res)).toBe(true)
    })

    it('does NOT apply to a GATED task reaching done via verdict — that path is patchToDoneBypassesGate\'s own concern, untouched here', async () => {
      // approved -> done, gated, no artifact evidence at all. The artifact
      // gate's ungatedDirectDone condition explicitly excludes
      // existing.status IN ('approved','rejected') — this is the pre-existing
      // patchToDoneBypassesGate territory, not this fix's job to re-litigate.
      harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      seed(harness.sqlite, { status: 'approved', gateOwner: 'gate:reviewer', result: null })
      env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      const res = await invokeTool(callerAuth(), env, 'task_update', { task_id: TASK_ID, status: 'done' }, URL)
      expect(res.ok, JSON.stringify(res)).toBe(true)
    })
  })

  describe('a task with no agent assignee — human/operational work, gate BLOCK finding #4', () => {
    it('is NOT gated entering review with no result at all — `result` is an execute.ts-only field, never meant for this task', async () => {
      harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      seed(harness.sqlite, { status: 'in_progress', gateOwner: 'gate:reviewer', result: null, assigneeAgentId: null })
      env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      const res = await invokeTool(callerAuth(), env, 'task_update', { task_id: TASK_ID, status: 'review' }, URL)
      expect(res.ok, JSON.stringify(res)).toBe(true)
      const row = harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID) as { status: string }
      expect(row.status).toBe('review')
    })

    it('is NOT gated on a direct ungated done with no result at all', async () => {
      harness = createSqliteD1()
      applyAllMigrations(harness.sqlite)
      seed(harness.sqlite, { status: 'in_progress', gateOwner: null, result: null, assigneeAgentId: null })
      env = { TENANT_SLUG: TENANT, DB: harness.db } as Env

      const res = await invokeTool(callerAuth(), env, 'task_update', { task_id: TASK_ID, status: 'done' }, URL)
      expect(res.ok, JSON.stringify(res)).toBe(true)
    })
  })
})
