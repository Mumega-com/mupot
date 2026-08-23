// tests/flight-spine-assignments.test.ts — Conformance tests for Flight Spine composition materialization and assignment epochs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptObjective } from '../src/flight-spine/objectives'
import { materializeComposition, type MaterializeCompositionInput } from '../src/flight-spine/assignments'
import { verifyExecutionReceipt } from '../src/flight-spine/receipts'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-spine'
const SERVER_TIME = '2026-08-23T17:00:00.000Z'

let harness: SqliteD1Harness
let env: Env

function memberAuth(tenant = TENANT): AuthContext {
  return {
    userId: 'user-hadi',
    email: 'hadi@mumega.com',
    role: 'admin',
    tenant,
    memberId: 'm-hadi-01',
    boundAgentId: null,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(SERVER_TIME))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env

  // Seed baseline entities
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name, created_at) VALUES ('dept-core', 'core', 'Core Systems', datetime('now'));
    INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad-hadi-mac', 'dept-core', 'hadi-mac', 'Hadi Mac Squad', datetime('now'));
    INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES ('m-hadi-01', '${TENANT}', 'Hadi', 'hadi@mumega.com', 'active', datetime('now'));
    INSERT INTO agents (id, squad_id, slug, name, role, status, created_at) VALUES ('agent-coord', 'squad-hadi-mac', 'kasra-coord', 'Kasra Coord', 'Coordinator', 'active', datetime('now'));
    INSERT INTO agents (id, squad_id, slug, name, role, status, created_at) VALUES ('agent-w1', 'squad-hadi-mac', 'river-worker', 'River Worker', 'Worker', 'active', datetime('now'));
    INSERT INTO agents (id, squad_id, slug, name, role, status, created_at) VALUES ('agent-w2', 'squad-hadi-mac', 'cursor-worker', 'Cursor Worker', 'Worker', 'active', datetime('now'));
    INSERT INTO agents (id, squad_id, slug, name, role, status, created_at) VALUES ('agent-gate', 'squad-hadi-mac', 'grok-gate', 'Grok Gate', 'Gatekeeper', 'active', datetime('now'));
    INSERT INTO flights (id, tenant, agent, goal, status, created_at) VALUES ('flight-alpha-01', '${TENANT}', 'agent-coord', 'Test Flight Alpha', 'running', 1700000000000);
  `)
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine Composition & Assignment Materialization', () => {
  async function createTestObjective(): Promise<string> {
    const obj = await acceptObjective(env, memberAuth(), {
      squadId: 'squad-hadi-mac',
      title: 'Valid Objective for Materialization',
      successContract: 'Deliver verified tasks.',
      authorityEnvelope: {},
      policy: {},
      budgetMicroUsd: 2000000,
      payload: { goal: 'test' },
      idempotencyKey: 'obj-mat-01',
    })
    return obj.id
  }

  it('materializes a valid 4-lane composition with 2 workers and 1 independent gate', async () => {
    const objectiveId = await createTestObjective()

    const input: MaterializeCompositionInput = {
      objectiveId,
      flightId: 'flight-alpha-01',
      lanes: [
        {
          laneKey: 'lane-coord',
          role: 'coordinator',
          assigneeAgentId: 'agent-coord',
          runtimeSeatId: null,
          dependencyLaneKeys: [],
          task: {
            squad_id: 'squad-hadi-mac',
            title: 'Coordinate Flight Spine Operations',
            done_when: 'Planning and execution verified.',
          },
        },
        {
          laneKey: 'lane-w1',
          role: 'worker',
          assigneeAgentId: 'agent-w1',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-coord'],
          task: {
            squad_id: 'squad-hadi-mac',
            title: 'Implement Receipts and Invariants',
            done_when: 'Receipts test suite 100% green.',
          },
        },
        {
          laneKey: 'lane-w2',
          role: 'worker',
          assigneeAgentId: 'agent-w2',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-coord'],
          task: {
            squad_id: 'squad-hadi-mac',
            title: 'Implement Runtime Adapter Slice',
            done_when: 'WFP router tests 100% green.',
          },
        },
        {
          laneKey: 'lane-gate',
          role: 'gate',
          assigneeAgentId: 'agent-gate',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-w1', 'lane-w2'],
          task: {
            squad_id: 'squad-hadi-mac',
            title: 'Independent Gate Evaluation',
            done_when: 'Cryptographic PASS verdict issued on full SHA.',
          },
        },
      ],
    }

    const result = await materializeComposition(env, memberAuth(), input)

    expect(result.flightId).toBe('flight-alpha-01')
    expect(result.objectiveId).toBe(objectiveId)
    expect(result.tasks.length).toBe(4)
    expect(result.lanes.length).toBe(4)
    expect(result.assignmentReceiptIds.length).toBe(4)
    expect(result.materializedReceiptId).toBeDefined()

    // Verify task assignment epoch is 1
    const taskRows = harness.sqlite.prepare('SELECT id, assignment_epoch FROM tasks').all() as any[]
    expect(taskRows.length).toBe(4)
    for (const t of taskRows) {
      expect(t.assignment_epoch).toBe(1)
    }

    // Verify flight_lanes and flight_objectives in D1
    const laneRows = harness.sqlite.prepare('SELECT id, lane_key, role, assignment_epoch FROM flight_lanes').all() as any[]
    expect(laneRows.length).toBe(4)
    for (const l of laneRows) {
      expect(l.assignment_epoch).toBe(1)
    }

    const flightObjRow = harness.sqlite.prepare('SELECT objective_id, flight_id FROM flight_objectives').get() as any
    expect(flightObjRow.objective_id).toBe(objectiveId)
    expect(flightObjRow.flight_id).toBe('flight-alpha-01')

    // Verify receipts
    const matVerification = await verifyExecutionReceipt(env, result.materializedReceiptId)
    expect(matVerification).toEqual({ ok: true })
    for (const receiptId of result.assignmentReceiptIds) {
      const v = await verifyExecutionReceipt(env, receiptId)
      expect(v).toEqual({ ok: true })
    }
  })

  it('enforces worker count bounds (requires 2 to 5 workers)', async () => {
    const objectiveId = await createTestObjective()

    // Rejects 1 worker
    await expect(materializeComposition(env, memberAuth(), {
      objectiveId,
      flightId: 'flight-alpha-01',
      lanes: [
        {
          laneKey: 'lane-w1',
          role: 'worker',
          assigneeAgentId: 'agent-w1',
          runtimeSeatId: null,
          dependencyLaneKeys: [],
          task: { squad_id: 'squad-hadi-mac', title: 'Task 1', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-gate',
          role: 'gate',
          assigneeAgentId: 'agent-gate',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-w1'],
          task: { squad_id: 'squad-hadi-mac', title: 'Gate', done_when: 'Gate passed.' },
        },
      ],
    })).rejects.toThrow(/worker count must be between 2 and 5/)
  })

  it('enforces gate count bounds (requires exactly 1 gate)', async () => {
    const objectiveId = await createTestObjective()

    // 0 gates
    await expect(materializeComposition(env, memberAuth(), {
      objectiveId,
      flightId: 'flight-alpha-01',
      lanes: [
        {
          laneKey: 'lane-w1',
          role: 'worker',
          assigneeAgentId: 'agent-w1',
          runtimeSeatId: null,
          dependencyLaneKeys: [],
          task: { squad_id: 'squad-hadi-mac', title: 'Task 1', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-w2',
          role: 'worker',
          assigneeAgentId: 'agent-w2',
          runtimeSeatId: null,
          dependencyLaneKeys: [],
          task: { squad_id: 'squad-hadi-mac', title: 'Task 2', done_when: 'Done.' },
        },
      ],
    })).rejects.toThrow(/exactly one gate required/)
  })

  it('enforces gate independence (rejects gate sharing agent ID with worker)', async () => {
    const objectiveId = await createTestObjective()

    // Gate shares agent ID with worker
    await expect(materializeComposition(env, memberAuth(), {
      objectiveId,
      flightId: 'flight-alpha-01',
      lanes: [
        {
          laneKey: 'lane-w1',
          role: 'worker',
          assigneeAgentId: 'agent-w1',
          runtimeSeatId: null,
          dependencyLaneKeys: [],
          task: { squad_id: 'squad-hadi-mac', title: 'Task 1', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-w2',
          role: 'worker',
          assigneeAgentId: 'agent-w2',
          runtimeSeatId: null,
          dependencyLaneKeys: [],
          task: { squad_id: 'squad-hadi-mac', title: 'Task 2', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-gate',
          role: 'gate',
          assigneeAgentId: 'agent-w1', // VIOLATION: agent-w1 is already worker on lane-w1
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-w1', 'lane-w2'],
          task: { squad_id: 'squad-hadi-mac', title: 'Gate', done_when: 'Gate passed.' },
        },
      ],
    })).rejects.toThrow(/gate_not_independent/)
  })

  it('validates dependency DAG (rejects cycles, missing dependencies, self-dependencies)', async () => {
    const objectiveId = await createTestObjective()

    // Self dependency
    await expect(materializeComposition(env, memberAuth(), {
      objectiveId,
      flightId: 'flight-alpha-01',
      lanes: [
        {
          laneKey: 'lane-w1',
          role: 'worker',
          assigneeAgentId: 'agent-w1',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-w1'], // SELF DEPENDENCY
          task: { squad_id: 'squad-hadi-mac', title: 'Task 1', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-w2',
          role: 'worker',
          assigneeAgentId: 'agent-w2',
          runtimeSeatId: null,
          dependencyLaneKeys: [],
          task: { squad_id: 'squad-hadi-mac', title: 'Task 2', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-gate',
          role: 'gate',
          assigneeAgentId: 'agent-gate',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-w1', 'lane-w2'],
          task: { squad_id: 'squad-hadi-mac', title: 'Gate', done_when: 'Done.' },
        },
      ],
    })).rejects.toThrow(/self_dependency/)

    // Cycle A -> B -> A
    await expect(materializeComposition(env, memberAuth(), {
      objectiveId,
      flightId: 'flight-alpha-01',
      lanes: [
        {
          laneKey: 'lane-w1',
          role: 'worker',
          assigneeAgentId: 'agent-w1',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-w2'], // depends on w2
          task: { squad_id: 'squad-hadi-mac', title: 'Task 1', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-w2',
          role: 'worker',
          assigneeAgentId: 'agent-w2',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-w1'], // depends on w1 -> CYCLE!
          task: { squad_id: 'squad-hadi-mac', title: 'Task 2', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-gate',
          role: 'gate',
          assigneeAgentId: 'agent-gate',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-w1'],
          task: { squad_id: 'squad-hadi-mac', title: 'Gate', done_when: 'Done.' },
        },
      ],
    })).rejects.toThrow(/cycle_detected/)
  })

  it('rejects duplicate materialization on the same flight', async () => {
    const objectiveId = await createTestObjective()

    const validComposition: MaterializeCompositionInput = {
      objectiveId,
      flightId: 'flight-alpha-01',
      lanes: [
        {
          laneKey: 'lane-w1',
          role: 'worker',
          assigneeAgentId: 'agent-w1',
          runtimeSeatId: null,
          dependencyLaneKeys: [],
          task: { squad_id: 'squad-hadi-mac', title: 'Task 1', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-w2',
          role: 'worker',
          assigneeAgentId: 'agent-w2',
          runtimeSeatId: null,
          dependencyLaneKeys: [],
          task: { squad_id: 'squad-hadi-mac', title: 'Task 2', done_when: 'Done.' },
        },
        {
          laneKey: 'lane-gate',
          role: 'gate',
          assigneeAgentId: 'agent-gate',
          runtimeSeatId: null,
          dependencyLaneKeys: ['lane-w1', 'lane-w2'],
          task: { squad_id: 'squad-hadi-mac', title: 'Gate', done_when: 'Done.' },
        },
      ],
    }

    await materializeComposition(env, memberAuth(), validComposition)

    // Second call with same flightId must be rejected
    await expect(materializeComposition(env, memberAuth(), validComposition)).rejects.toThrow(/flight_already_materialized/)
  })
})
