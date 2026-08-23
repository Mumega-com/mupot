import type { D1Database } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { materializeComposition } from '../src/flight-spine/assignments'
import type {
  MaterializeCompositionInput,
  MaterializeLaneInput,
} from '../src/flight-spine/assignments'
import { acceptObjective } from '../src/flight-spine/objectives'
import { appendExecutionReceipt } from '../src/flight-spine/receipts'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-assignments'
const SERVER_TIME = '2026-08-23T16:00:00.000Z'
const MEMBER_ID = 'member-coordinator'
const SQUAD_ID = 'squad-composition'
const FLIGHT_ID = 'flight-composition'
const AGENTS = {
  coordinator: 'agent-coordinator',
  workerA: 'agent-worker-a',
  workerB: 'agent-worker-b',
  integrator: 'agent-integrator',
  gate: 'agent-gate',
} as const

let harness: SqliteD1Harness
let env: Env

function auth(): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'coordinator@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENTS.coordinator,
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'member',
    }],
  }
}

function lane(
  laneKey: string,
  role: MaterializeLaneInput['role'],
  agentId: string,
  dependencies: readonly string[],
  overrides: Partial<MaterializeLaneInput> = {},
): MaterializeLaneInput {
  return {
    laneKey,
    role,
    assigneeAgentId: agentId,
    runtimeSeatId: `seat-${laneKey}`,
    dependencyLaneKeys: dependencies,
    task: {
      squad_id: SQUAD_ID,
      title: `Task ${laneKey}`,
      body: `Durable work for ${laneKey}`,
      done_when: `${laneKey} produces independently verifiable evidence`,
      gate_owner: role === 'integrator' ? 'gate:independent' : null,
    },
    ...overrides,
  }
}

function validLanes(): MaterializeLaneInput[] {
  return [
    lane('coordinator', 'coordinator', AGENTS.coordinator, []),
    lane('worker-a', 'worker', AGENTS.workerA, ['coordinator']),
    lane('worker-b', 'worker', AGENTS.workerB, ['coordinator']),
    lane('integrator', 'integrator', AGENTS.integrator, ['worker-a', 'worker-b']),
    lane('gate', 'gate', AGENTS.gate, ['integrator']),
  ]
}

async function acceptedObjective(): Promise<string> {
  const objective = await acceptObjective(env, auth(), {
    squadId: SQUAD_ID,
    title: 'Compose fresh Flight Spine lanes',
    successContract: 'Both workers feed an integrated deliverable and independent gate.',
    authorityEnvelope: { allowedActions: ['task:create', 'flight:materialize'] },
    policy: { maxWorkers: 5, maxAttempts: 3 },
    budgetMicroUsd: 0,
    payload: { novel: true, source: 'post-acceptance' },
    idempotencyKey: 'objective-composition-001',
  })
  vi.setSystemTime(new Date(Date.parse(SERVER_TIME) + 1))
  harness.sqlite.prepare(`
    INSERT INTO flights (
      id, tenant, agent, dispatched_by_agent_id, goal, status,
      budget_micro_usd, meta, created_at, started_at
    ) VALUES (?, ?, ?, ?, 'Compose lanes', 'running', 0, '{}', ?, ?)
  `).run(
    FLIGHT_ID,
    TENANT,
    AGENTS.coordinator,
    AGENTS.coordinator,
    Date.now(),
    Date.now(),
  )
  return objective.id
}

function materializeInput(
  objectiveId: string,
  lanes: readonly MaterializeLaneInput[] = validLanes(),
): MaterializeCompositionInput {
  return { objectiveId, flightId: FLIGHT_ID, lanes }
}

function count(table: string, where = '1 = 1'): number {
  return Number((harness.sqlite.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
  ).get() as { count: number }).count)
}

function receiptHead(): { sequence: number; receipt_id: string; receipt_hash: string } {
  return harness.sqlite.prepare(`
    SELECT sequence, receipt_id, receipt_hash
      FROM execution_receipt_heads WHERE tenant = ?
  `).get(TENANT) as { sequence: number; receipt_id: string; receipt_hash: string }
}

function envWithBeforeBatch(mutate: () => void): Env {
  let injected = false
  return {
    ...env,
    DB: {
      prepare: harness.db.prepare.bind(harness.db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        if (!injected) {
          injected = true
          mutate()
        }
        return harness.db.batch(statements)
      },
    } as D1Database,
  }
}

function expectNoMaterialization(before: { receipts: number; audits: number }): void {
  expect(count('flight_objectives')).toBe(0)
  expect(count('flight_lanes')).toBe(0)
  expect(count('flight_task_assignments')).toBe(0)
  expect(count('tasks')).toBe(1)
  expect(count('execution_receipts')).toBe(before.receipts)
  expect(count('mutation_audit_entries')).toBe(before.audits)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(SERVER_TIME))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('department-composition', 'composition', 'Composition');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD_ID}', 'department-composition', 'composition', 'Composition');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES
        ('${AGENTS.coordinator}', '${SQUAD_ID}', 'coordinator', 'Coordinator', 'member', 'test', 'active'),
        ('${AGENTS.workerA}', '${SQUAD_ID}', 'worker-a', 'Worker A', 'member', 'test', 'active'),
        ('${AGENTS.workerB}', '${SQUAD_ID}', 'worker-b', 'Worker B', 'member', 'test', 'active'),
        ('${AGENTS.integrator}', '${SQUAD_ID}', 'integrator', 'Integrator', 'member', 'test', 'active'),
        ('${AGENTS.gate}', '${SQUAD_ID}', 'gate', 'Gate', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES
        ('membership-coordinator', '${AGENTS.coordinator}', '${SQUAD_ID}', 'member'),
        ('membership-worker-a', '${AGENTS.workerA}', '${SQUAD_ID}', 'member'),
        ('membership-worker-b', '${AGENTS.workerB}', '${SQUAD_ID}', 'member'),
        ('membership-integrator', '${AGENTS.integrator}', '${SQUAD_ID}', 'member'),
        ('membership-gate', '${AGENTS.gate}', '${SQUAD_ID}', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Coordinator Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${AGENTS.coordinator}', '${MEMBER_ID}', '${SERVER_TIME}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('capability-coordinator', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
    INSERT INTO gate_grants (
      id, capability, principal_type, principal_id, granted_by, created_at
    ) VALUES (
      'gate-grant-independent', 'gate:independent', 'agent', '${AGENTS.gate}',
      '${MEMBER_ID}', '${SERVER_TIME}'
    );
    INSERT INTO tasks (id, squad_id, title, done_when, status)
      VALUES ('legacy-task', '${SQUAD_ID}', 'Legacy', 'Legacy remains epoch zero', 'open');
  `)
  for (const item of validLanes()) {
    harness.sqlite.prepare(`
      INSERT INTO runtime_seats (
        id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
        current_generation, current_fencing_epoch, capabilities_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'host-test', 'test-adapter', 'pending', 0, 0, '[]', ?, ?)
    `).run(
      item.runtimeSeatId,
      TENANT,
      item.assigneeAgentId,
      item.laneKey,
      SERVER_TIME,
      SERVER_TIME,
    )
  }
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine composition materialization', () => {
  it('atomically links the objective and creates fresh epoch-1 tasks, DAG lanes, assignments and receipts', async () => {
    const objectiveId = await acceptedObjective()
    const auditBefore = count('mutation_audit_entries')

    const result = await materializeComposition(env, auth(), materializeInput(objectiveId))

    expect(result).toMatchObject({
      objectiveId,
      flightId: FLIGHT_ID,
      tasks: expect.arrayContaining(validLanes().map((item) => (
        expect.objectContaining({
          squad_id: SQUAD_ID,
          title: item.task.title,
          assignee_agent_id: item.assigneeAgentId,
        })
      ))),
    })
    expect(result.tasks).toHaveLength(5)
    expect(result.lanes).toHaveLength(5)
    expect(result.assignmentReceiptIds).toHaveLength(5)

    expect(harness.sqlite.prepare(`
      SELECT objective_id, materialization_receipt_id
        FROM flight_objectives WHERE tenant = ? AND flight_id = ?
    `).get(TENANT, FLIGHT_ID)).toEqual({
      objective_id: objectiveId,
      materialization_receipt_id: result.materializedReceiptId,
    })
    expect(harness.sqlite.prepare(`
      SELECT assignment_epoch FROM tasks WHERE id = 'legacy-task'
    `).get()).toEqual({ assignment_epoch: 0 })
    expect(harness.sqlite.prepare(`
      SELECT assignment_epoch, COUNT(*) AS count
        FROM tasks WHERE id <> 'legacy-task' GROUP BY assignment_epoch
    `).all()).toEqual([{ assignment_epoch: 1, count: 5 }])
    expect(harness.sqlite.prepare(`
      SELECT lane_key, role, assignment_epoch, dependency_lane_keys_json
        FROM flight_lanes WHERE flight_id = ? ORDER BY lane_key
    `).all(FLIGHT_ID)).toEqual([
      { lane_key: 'coordinator', role: 'coordinator', assignment_epoch: 1, dependency_lane_keys_json: '[]' },
      { lane_key: 'gate', role: 'gate', assignment_epoch: 1, dependency_lane_keys_json: '["integrator"]' },
      { lane_key: 'integrator', role: 'integrator', assignment_epoch: 1, dependency_lane_keys_json: '["worker-a","worker-b"]' },
      { lane_key: 'worker-a', role: 'worker', assignment_epoch: 1, dependency_lane_keys_json: '["coordinator"]' },
      { lane_key: 'worker-b', role: 'worker', assignment_epoch: 1, dependency_lane_keys_json: '["coordinator"]' },
    ])
    expect(harness.sqlite.prepare(`
      SELECT assignment_receipt_id FROM flight_task_assignments ORDER BY assigned_at, id
    `).all().map((row) => row.assignment_receipt_id).sort()).toEqual(
      [...result.assignmentReceiptIds].sort(),
    )
    expect(harness.sqlite.prepare(`
      SELECT type FROM execution_receipts WHERE flight_id = ? ORDER BY sequence
    `).all(FLIGHT_ID)).toEqual([
      { type: 'composition.proposed' },
      { type: 'flight.materialized' },
      { type: 'task.assigned' },
      { type: 'task.assigned' },
      { type: 'task.assigned' },
      { type: 'task.assigned' },
      { type: 'task.assigned' },
    ])
    // 1 flight-objective link + 5 each of task insert, epoch update, lane and assignment.
    expect(count('mutation_audit_entries') - auditBefore).toBe(21)
  })

  it('rejects invalid worker cardinality, multiple gates, gate collisions and cyclic dependencies before SQL', async () => {
    const objectiveId = await acceptedObjective()
    const baseline = {
      receipts: count('execution_receipts'),
      audits: count('mutation_audit_entries'),
    }
    const invalid: Array<{ lanes: MaterializeLaneInput[]; code: string }> = [
      {
        lanes: validLanes().filter((item) => item.laneKey !== 'worker-b'),
        code: 'invalid_worker_count',
      },
      {
        lanes: [...validLanes(), lane('gate-2', 'gate', AGENTS.workerA, ['integrator'])],
        code: 'invalid_gate_count',
      },
      {
        lanes: validLanes().map((item) => item.role === 'gate'
          ? { ...item, assigneeAgentId: AGENTS.workerA }
          : item),
        code: 'gate_not_independent',
      },
      {
        lanes: validLanes().map((item) => item.role === 'gate'
          ? { ...item, runtimeSeatId: 'seat-worker-a' }
          : item),
        code: 'gate_not_independent',
      },
      {
        lanes: validLanes().map((item) => item.laneKey === 'coordinator'
          ? { ...item, dependencyLaneKeys: ['integrator'] }
          : item),
        code: 'dependency_cycle',
      },
    ]

    for (const item of invalid) {
      await expect(materializeComposition(env, auth(), materializeInput(objectiveId, item.lanes)))
        .rejects.toMatchObject({ code: item.code })
    }
    expect(count('flight_objectives')).toBe(0)
    expect(count('flight_lanes')).toBe(0)
    expect(count('flight_task_assignments')).toBe(0)
    expect(count('tasks')).toBe(1)
    expect(count('execution_receipts')).toBe(baseline.receipts)
    expect(count('mutation_audit_entries')).toBe(baseline.audits)
  })

  it('requires the integrator gate_owner to bind exactly to the predeclared gate agent', async () => {
    const objectiveId = await acceptedObjective()
    const before = {
      receipts: count('execution_receipts'),
      audits: count('mutation_audit_entries'),
    }
    harness.sqlite.prepare("DELETE FROM gate_grants WHERE id = 'gate-grant-independent'").run()
    await expect(materializeComposition(env, auth(), materializeInput(objectiveId)))
      .rejects.toMatchObject({ code: 'invalid_gate_owner' })

    harness.sqlite.prepare(`
      INSERT INTO gate_grants (
        id, capability, principal_type, principal_id, granted_by, created_at
      ) VALUES ('wrong-gate', 'gate:independent', 'agent', ?, ?, ?)
    `).run(AGENTS.workerA, MEMBER_ID, SERVER_TIME)
    await expect(materializeComposition(env, auth(), materializeInput(objectiveId)))
      .rejects.toMatchObject({ code: 'invalid_gate_owner' })
    expectNoMaterialization(before)
  })

  it.each([
    {
      name: 'agent disable',
      mutate: () => harness.sqlite.prepare("UPDATE agents SET status = 'paused' WHERE id = ?")
        .run(AGENTS.workerA),
    },
    {
      name: 'seat transition',
      mutate: () => harness.sqlite.prepare(`
        UPDATE runtime_seats SET state = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?
      `).run(SERVER_TIME, SERVER_TIME, 'seat-worker-a'),
    },
    {
      name: 'gate revoke',
      mutate: () => harness.sqlite.prepare(
        "DELETE FROM gate_grants WHERE id = 'gate-grant-independent'",
      ).run(),
    },
    {
      name: 'flight state change',
      mutate: () => harness.sqlite.prepare("UPDATE flights SET status = 'landed' WHERE id = ?")
        .run(FLIGHT_ID),
    },
  ])('rolls back the whole prepared batch on an in-batch $name', async ({ mutate }) => {
    const objectiveId = await acceptedObjective()
    const before = {
      receipts: count('execution_receipts'),
      audits: count('mutation_audit_entries'),
    }
    const racedEnv = envWithBeforeBatch(mutate)

    await expect(materializeComposition(racedEnv, auth(), materializeInput(objectiveId)))
      .rejects.toMatchObject({ code: 'materialization_conflict' })
    expectNoMaterialization(before)
  })

  it('keeps receipts, objective link, tasks, lanes, assignments and audits atomic on a task insert failure', async () => {
    const objectiveId = await acceptedObjective()
    const before = {
      receipts: count('execution_receipts'),
      audits: count('mutation_audit_entries'),
      head: receiptHead(),
    }
    harness.sqlite.exec(`
      CREATE TRIGGER force_worker_b_failure
      BEFORE INSERT ON tasks WHEN NEW.title = 'Task worker-b'
      BEGIN
        SELECT RAISE(ABORT, 'forced worker task failure');
      END;
    `)

    await expect(materializeComposition(env, auth(), materializeInput(objectiveId)))
      .rejects.toMatchObject({ code: 'materialization_conflict' })

    expect(count('flight_objectives')).toBe(0)
    expect(count('flight_lanes')).toBe(0)
    expect(count('flight_task_assignments')).toBe(0)
    expect(count('tasks')).toBe(1)
    expect(count('execution_receipts')).toBe(before.receipts)
    expect(count('mutation_audit_entries')).toBe(before.audits)
    expect(receiptHead()).toEqual(before.head)
  })

  it('rejects a stale assignment epoch and rolls back the whole prepared batch', async () => {
    const objectiveId = await acceptedObjective()
    const before = {
      receipts: count('execution_receipts'),
      audits: count('mutation_audit_entries'),
      head: receiptHead(),
    }
    harness.sqlite.exec(`
      CREATE TRIGGER force_stale_assignment_epoch
      AFTER INSERT ON tasks WHEN NEW.title = 'Task worker-a'
      BEGIN
        UPDATE tasks SET assignment_epoch = 7 WHERE id = NEW.id;
      END;
    `)

    await expect(materializeComposition(env, auth(), materializeInput(objectiveId)))
      .rejects.toMatchObject({ code: 'stale_assignment_epoch' })

    expect(count('flight_objectives')).toBe(0)
    expect(count('flight_lanes')).toBe(0)
    expect(count('flight_task_assignments')).toBe(0)
    expect(count('tasks')).toBe(1)
    expect(count('execution_receipts')).toBe(before.receipts)
    expect(count('mutation_audit_entries')).toBe(before.audits)
    expect(receiptHead()).toEqual(before.head)
  })

  it('rejects a stale receipt head without leaving prepared domain, receipt or audit rows', async () => {
    const objectiveId = await acceptedObjective()
    const before = {
      receipts: count('execution_receipts'),
      audits: count('mutation_audit_entries'),
    }
    let injected = false
    const racedDb = {
      prepare: harness.db.prepare.bind(harness.db),
      async batch(statements: Parameters<D1Database['batch']>[0]) {
        if (!injected) {
          injected = true
          await appendExecutionReceipt(env, auth(), {
            type: 'effect.intent',
            idempotencyKey: 'competing-head-receipt',
            claims: { competitor: true },
          })
        }
        return harness.db.batch(statements)
      },
    } as D1Database
    const racedEnv = { ...env, DB: racedDb }

    await expect(materializeComposition(racedEnv, auth(), materializeInput(objectiveId)))
      .rejects.toMatchObject({ code: 'stale_receipt_head' })

    expect(count('flight_objectives')).toBe(0)
    expect(count('flight_lanes')).toBe(0)
    expect(count('flight_task_assignments')).toBe(0)
    expect(count('tasks')).toBe(1)
    expect(count('execution_receipts')).toBe(before.receipts + 1)
    expect(count('mutation_audit_entries')).toBe(before.audits)
    expect(receiptHead().receipt_id).toBe(
      (harness.sqlite.prepare(`
        SELECT id FROM execution_receipts WHERE idempotency_key = 'competing-head-receipt'
      `).get() as { id: string }).id,
    )
  })
})
