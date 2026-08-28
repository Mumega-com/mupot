// tests/flight-exec-02-fallback-and-gates.test.ts — FLIGHT EXEC-02 / #1049 & #1030
//
// Transparent Fallback Execution & Self-Gate Deadlock Prevention.
// Real SQLite D1 migration chain schema (0001–0135).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { invokeTool } from '../src/mcp'
import { createTask, persistTaskUpdate, isSelfGatedConflict, TaskSelfGateError, getTask } from '../src/tasks/service'
import { runTaskExecution } from '../src/agents/execute'
import { reportTaskResult } from '../src/tasks/report-result'
import type { AuthContext, Env, Task, Agent } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'mumega'
const DEPT_ID = 'dept-eng'
const SQUAD_A_ID = 'squad-hadi-mac'
const SQUAD_B_ID = 'squad-core'

const RIVER_AGENT_ID = 'agent-river'
const RIVER_MEMBER_ID = 'member-river'
const KASRA_AGENT_ID = 'agent-kasra'
const KASRA_MEMBER_ID = 'member-kasra'
const ADMIN_MEMBER_ID = 'member-admin'

function applyAllMigrations(sqlite: SqliteD1Harness['sqlite']): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    try {
      sqlite.exec(sql)
    } catch (err) {
      const msg = String(err)
      if (!/already exists|duplicate column|no such (function|module)|near "PRAGMA"/i.test(msg)) {
        throw new Error(`migration ${file}: ${msg}`)
      }
    }
  }
}

function seedData(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name)
    VALUES ('${DEPT_ID}', 'eng', 'Engineering');

    INSERT INTO squads (id, department_id, slug, name)
    VALUES
      ('${SQUAD_A_ID}', '${DEPT_ID}', 'hadi-mac', 'Hadi Mac'),
      ('${SQUAD_B_ID}', '${DEPT_ID}', 'squad-core', 'Core Platform');

    INSERT INTO agents (id, squad_id, slug, name, status, role, model)
    VALUES
      ('${RIVER_AGENT_ID}', '${SQUAD_A_ID}', 'river', 'River Lead', 'active', 'lead', 'claude-3-7-sonnet'),
      ('${KASRA_AGENT_ID}', '${SQUAD_B_ID}', 'kasra', 'Kasra Gate', 'active', 'gate', 'claude-3-7-sonnet');

    INSERT INTO members (id, display_name, status, tenant)
    VALUES
      ('${RIVER_MEMBER_ID}', 'River Member', 'active', '${TENANT}'),
      ('${KASRA_MEMBER_ID}', 'Kasra Member', 'active', '${TENANT}'),
      ('${ADMIN_MEMBER_ID}', 'Admin Member', 'active', '${TENANT}');

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES
      ('${TENANT}', '${RIVER_AGENT_ID}', '${RIVER_MEMBER_ID}', '2026-08-28T00:00:00.000Z'),
      ('${TENANT}', '${KASRA_AGENT_ID}', '${KASRA_MEMBER_ID}', '2026-08-28T00:00:00.000Z');

    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
    VALUES
      ('grant-1', 'gate:kasra', 'agent', '${KASRA_AGENT_ID}', 'system', '2026-08-28T00:00:00.000Z'),
      ('grant-2', 'gate:river', 'agent', '${RIVER_AGENT_ID}', 'system', '2026-08-28T00:00:00.000Z');
  `)
}

describe('FLIGHT EXEC-02: Fallback Execution Attribution & Self-Gate Deadlock Prevention', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedData(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      AI: {
        run: async () => ({
          response: 'Artifact: dist/receipt.json\nSHA256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\nExecution completed successfully.',
        }),
      } as any,
    } as unknown as Env
  })

  afterEach(() => {
    harness.close()
  })

  describe('Deliverable 1 (#1049): Transparent Fallback Execution Attribution', () => {
    it('records explicit substitute_executor_id and fallback_reason on in-Worker fallback execution', async () => {
      const agent: Agent = {
        id: RIVER_AGENT_ID,
        squad_id: SQUAD_A_ID,
        slug: 'river',
        name: 'River Lead',
        role: 'lead',
        status: 'active',
        model: 'claude-3-7-sonnet',
        created_at: '2026-08-28T00:00:00.000Z',
        updated_at: '2026-08-28T00:00:00.000Z',
      }

      const created = await createTask(
        env,
        {
          squad_id: SQUAD_A_ID,
          title: 'Implement Warm Cache Architecture',
          done_when: 'All cache tests pass with valid receipts',
          assignee_agent_id: RIVER_AGENT_ID,
          status: 'in_progress',
        },
        { allowDeferredPredicate: true },
      )

      // Run fallback execution simulating seat_unreachable
      const execResult = await runTaskExecution(env, agent, created.id, {
        fallback: true,
        substituteExecutorId: `in-worker:${RIVER_AGENT_ID}`,
        fallbackReason: 'seat_unreachable',
      })

      expect(execResult.ok).toBe(true)

      // Query updated task row directly from SQLite D1
      const updated = await harness.db
        .prepare('SELECT id, status, substitute_executor_id, fallback_reason, gate_owner, result FROM tasks WHERE id = ?')
        .bind(created.id)
        .first<any>()

      expect(updated).not.toBeNull()
      expect(updated.status).toBe('review')
      expect(updated.substitute_executor_id).toBe(`in-worker:${RIVER_AGENT_ID}`)
      expect(updated.fallback_reason).toBe('seat_unreachable')
      expect(updated.gate_owner).toBe('gate:agent-self-completion')
      expect(updated.result).toContain('Artifact: dist/receipt.json')
    })

    it('persists substitute_executor_id and fallback_reason via persistTaskUpdate', async () => {
      const created = await createTask(
        env,
        {
          squad_id: SQUAD_A_ID,
          title: 'Build API bridge',
          done_when: 'Endpoints return 200',
          assignee_agent_id: RIVER_AGENT_ID,
          status: 'open',
        },
      )

      const next: Task = {
        ...created,
        status: 'in_progress',
        substitute_executor_id: `in-worker:${RIVER_AGENT_ID}`,
        fallback_reason: 'no_external_runtime',
        updated_at: new Date().toISOString(),
      }

      await persistTaskUpdate(env, created, next)

      const fetched = await harness.db
        .prepare('SELECT substitute_executor_id, fallback_reason FROM tasks WHERE id = ?')
        .bind(created.id)
        .first<any>()

      expect(fetched.substitute_executor_id).toBe(`in-worker:${RIVER_AGENT_ID}`)
      expect(fetched.fallback_reason).toBe('no_external_runtime')
    })
  })

  describe('Deliverable 2 (#1030): Self-Gate Deadlock Prevention', () => {
    it('detects self-gated conflicts accurately via isSelfGatedConflict', async () => {
      // 1. Exact match on agent id
      expect(await isSelfGatedConflict(env, RIVER_AGENT_ID, RIVER_AGENT_ID)).toBe(true)

      // 2. Exact match on gate:<agent-id>
      expect(await isSelfGatedConflict(env, `gate:${RIVER_AGENT_ID}`, RIVER_AGENT_ID)).toBe(true)

      // 3. Match on slug 'river'
      expect(await isSelfGatedConflict(env, 'gate:river', RIVER_AGENT_ID)).toBe(true)

      // 4. Match on capability granted to agent (grant-2: gate:river -> agent-river)
      expect(await isSelfGatedConflict(env, 'gate:river', RIVER_AGENT_ID)).toBe(true)

      // 5. Allowed exception: gate:agent-self-completion
      expect(await isSelfGatedConflict(env, 'gate:agent-self-completion', RIVER_AGENT_ID)).toBe(false)

      // 6. Legitimate different gate owner (kasra gating river)
      expect(await isSelfGatedConflict(env, 'gate:kasra', RIVER_AGENT_ID)).toBe(false)
      expect(await isSelfGatedConflict(env, `gate:${KASRA_AGENT_ID}`, RIVER_AGENT_ID)).toBe(false)
    })

    it('rejects self-gating at createTask write time with TaskSelfGateError', async () => {
      await expect(
        createTask(env, {
          squad_id: SQUAD_A_ID,
          title: 'Self-gated invalid task',
          done_when: 'Done when verified',
          assignee_agent_id: RIVER_AGENT_ID,
          gate_owner: 'gate:river', // River gating River
        }),
      ).rejects.toThrow(TaskSelfGateError)

      // By agent ID
      await expect(
        createTask(env, {
          squad_id: SQUAD_A_ID,
          title: 'Self-gated invalid task 2',
          done_when: 'Done when verified',
          assignee_agent_id: RIVER_AGENT_ID,
          gate_owner: `gate:${RIVER_AGENT_ID}`,
        }),
      ).rejects.toThrow(TaskSelfGateError)

      // Allows different gate owner
      const valid = await createTask(env, {
        squad_id: SQUAD_A_ID,
        title: 'Valid gated task',
        done_when: 'Done when verified',
        assignee_agent_id: RIVER_AGENT_ID,
        gate_owner: 'gate:kasra', // Kasra gating River
      })
      expect(valid.gate_owner).toBe('gate:kasra')

      // Allows gate:agent-self-completion
      const selfCompletion = await createTask(env, {
        squad_id: SQUAD_A_ID,
        title: 'Valid self-completion task',
        done_when: 'Done when verified',
        assignee_agent_id: RIVER_AGENT_ID,
        gate_owner: 'gate:agent-self-completion',
      })
      expect(selfCompletion.gate_owner).toBe('gate:agent-self-completion')
    })

    it('rejects self-gating in persistTaskUpdate', async () => {
      const created = await createTask(env, {
        squad_id: SQUAD_A_ID,
        title: 'Ungated task',
        done_when: 'Done when verified',
        assignee_agent_id: RIVER_AGENT_ID,
      })

      const updateToSelfGated: Task = {
        ...created,
        gate_owner: 'gate:river',
        updated_at: new Date().toISOString(),
      }

      await expect(persistTaskUpdate(env, created, updateToSelfGated)).rejects.toThrow(TaskSelfGateError)
    })

    it('rejects self-gating via MCP task_update tool with 409 self_gate_conflict', async () => {
      const created = await createTask(env, {
        squad_id: SQUAD_A_ID,
        title: 'MCP task update test',
        done_when: 'Done when verified',
        assignee_agent_id: RIVER_AGENT_ID,
      })

      const auth: AuthContext = {
        userId: 'user-admin',
        memberId: ADMIN_MEMBER_ID,
        role: 'admin',
        capabilities: [
          {
            member_id: ADMIN_MEMBER_ID,
            scope_type: 'squad',
            scope_id: SQUAD_A_ID,
            capability: 'admin',
          },
        ],
      }

      const res = await invokeTool(
        auth,
        env,
        'task_update',
        {
          task_id: created.id,
          gate_owner: 'gate:river', // River is the assignee -> conflict!
        },
      )

      expect(res.ok).toBe(false)
      expect(res.error).toBe('self_gate_conflict')
      expect(res.status).toBe(409)
    })

    it('rejects self-gating via reportTaskResult with 409 self_gate_conflict', async () => {
      const created = await createTask(env, {
        squad_id: SQUAD_A_ID,
        title: 'External report task',
        done_when: 'Done when verified',
        assignee_agent_id: RIVER_AGENT_ID,
        status: 'in_progress',
      })

      const auth: AuthContext = {
        userId: 'user-admin',
        memberId: ADMIN_MEMBER_ID,
        role: 'admin',
        capabilities: [
          {
            member_id: ADMIN_MEMBER_ID,
            scope_type: 'squad',
            scope_id: SQUAD_A_ID,
            capability: 'admin',
          },
        ],
      }

      await expect(
        reportTaskResult(env, auth, {
          taskId: created.id,
          result: 'Artifact: build/out.bin\nSHA256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          status: 'review',
          gateOwner: 'gate:river', // Assignee is River!
        }),
      ).rejects.toMatchObject({
        code: 'self_gate_conflict',
        status: 409,
      })
    })

    it('allows external reportTaskResult with valid different gate owner', async () => {
      const created = await createTask(env, {
        squad_id: SQUAD_A_ID,
        title: 'External report task 2',
        done_when: 'Done when verified',
        assignee_agent_id: RIVER_AGENT_ID,
        status: 'in_progress',
      })

      const auth: AuthContext = {
        userId: 'user-admin',
        memberId: ADMIN_MEMBER_ID,
        role: 'admin',
        capabilities: [
          {
            member_id: ADMIN_MEMBER_ID,
            scope_type: 'squad',
            scope_id: SQUAD_A_ID,
            capability: 'admin',
          },
        ],
      }

      const report = await reportTaskResult(env, auth, {
        taskId: created.id,
        result: 'Artifact: build/out.bin\nSHA256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        status: 'review',
        gateOwner: 'gate:kasra',
      })

      expect(report.ok).toBe(true)
      expect(report.task.status).toBe('review')
      expect(report.task.gate_owner).toBe('gate:kasra')
    })
  })
})
