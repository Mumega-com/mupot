// tests/flight-spine-dependencies.test.ts — Conformance tests for Flight Spine child flights and consumed child artifacts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptObjective } from '../src/flight-spine/objectives'
import { linkChildFlight, recordConsumedChildArtifact } from '../src/flight-spine/dependencies'
import { appendExecutionReceipt, verifyExecutionReceipt } from '../src/flight-spine/receipts'
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
    INSERT INTO agents (id, squad_id, slug, name, role, status, created_at) VALUES ('agent-parent', 'squad-hadi-mac', 'parent-agent', 'Parent Agent', 'Worker', 'active', datetime('now'));
    INSERT INTO agents (id, squad_id, slug, name, role, status, created_at) VALUES ('agent-child', 'squad-hadi-mac', 'child-agent', 'Child Agent', 'Worker', 'active', datetime('now'));
    INSERT INTO flights (id, tenant, agent, goal, status, created_at) VALUES ('flight-parent', '${TENANT}', 'agent-parent', 'Parent Flight', 'running', 1787504400000);
    INSERT INTO flights (id, tenant, agent, goal, status, created_at) VALUES ('flight-child', '${TENANT}', 'agent-child', 'Child Flight', 'running', 1787504500000);
  `)
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine Dependencies & Child Artifact Consumption', () => {
  async function createTestObjective(): Promise<string> {
    const obj = await acceptObjective(env, memberAuth(), {
      squadId: 'squad-hadi-mac',
      title: 'Parent Objective for Dependency Test',
      successContract: 'Deliver verified child linkage.',
      authorityEnvelope: {},
      policy: {},
      budgetMicroUsd: 1000000,
      payload: { goal: 'parent' },
      idempotencyKey: 'obj-dep-01',
    })
    return obj.id
  }

  it('links a child flight to a parent flight under an accepted objective', async () => {
    const objectiveId = await createTestObjective()

    const link = await linkChildFlight(env, memberAuth(), {
      objectiveId,
      parentFlightId: 'flight-parent',
      childFlightId: 'flight-child',
    })

    expect(link.id).toBeDefined()
    expect(link.tenant).toBe(TENANT)
    expect(link.parentFlightId).toBe('flight-parent')
    expect(link.childFlightId).toBe('flight-child')

    // Verify row in flight_dependencies
    const row = harness.sqlite.prepare(`
      SELECT id, objective_id, parent_flight_id, child_flight_id
        FROM flight_dependencies
       WHERE id = ?
    `).get(link.id) as any

    expect(row).toBeDefined()
    expect(row.parent_flight_id).toBe('flight-parent')
    expect(row.child_flight_id).toBe('flight-child')
  })

  it('rejects self-dependency where parent equals child', async () => {
    const objectiveId = await createTestObjective()

    await expect(linkChildFlight(env, memberAuth(), {
      objectiveId,
      parentFlightId: 'flight-parent',
      childFlightId: 'flight-parent',
    })).rejects.toThrow(/parent_flight_id cannot equal child_flight_id/)
  })

  it('rejects duplicate child flight link for the same parent', async () => {
    const objectiveId = await createTestObjective()

    await linkChildFlight(env, memberAuth(), {
      objectiveId,
      parentFlightId: 'flight-parent',
      childFlightId: 'flight-child',
    })

    await expect(linkChildFlight(env, memberAuth(), {
      objectiveId,
      parentFlightId: 'flight-parent',
      childFlightId: 'flight-child',
    })).rejects.toThrow(/duplicate_dependency/)
  })

  it('records consumed child artifact fact and appends receipt', async () => {
    const objectiveId = await createTestObjective()

    // 1. Link child to parent
    await linkChildFlight(env, memberAuth(), {
      objectiveId,
      parentFlightId: 'flight-parent',
      childFlightId: 'flight-child',
    })

    // Seed task, seat, assignment and artifact for the child flight
    const artifactStorageReceipt = await appendExecutionReceipt(env, memberAuth(), {
      type: 'flight.landed',
      flightId: 'flight-child',
      idempotencyKey: 'art-storage-receipt-01',
      claims: { stored: true },
    })

    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, created_at, updated_at, assignment_epoch)
      VALUES ('task-child-01', 'squad-hadi-mac', 'Child Task', 'Done', 'done', datetime('now'), datetime('now'), 1);

      INSERT INTO runtime_seats (id, tenant, agent_id, seat_name, host_id, adapter_kind, state, current_generation, current_fencing_epoch, created_at, updated_at)
      VALUES ('seat-child-01', '${TENANT}', 'agent-child', 'seat-1', 'host-1', 'node', 'active', 1, 1, datetime('now'), datetime('now'));

      INSERT INTO flight_lanes (id, tenant, flight_id, lane_key, role, task_id, assignment_epoch, agent_id, runtime_seat_id, done_when, dependency_lane_keys_json, created_at)
      VALUES ('lane-child-01', '${TENANT}', 'flight-child', 'w1', 'worker', 'task-child-01', 1, 'agent-child', 'seat-child-01', 'Done', '[]', datetime('now'));

      INSERT INTO flight_task_assignments (id, tenant, flight_id, lane_id, task_id, assignment_epoch, agent_id, runtime_seat_id, assigned_by_principal_kind, assigned_by_principal_id, assigned_at)
      VALUES ('assign-child-01', '${TENANT}', 'flight-child', 'lane-child-01', 'task-child-01', 1, 'agent-child', 'seat-child-01', 'member', 'm-hadi-01', datetime('now'));

      INSERT INTO artifacts (id, tenant, flight_id, producing_assignment_id, producing_task_id, producing_agent_id, producing_runtime_seat_id, assignment_epoch, object_key, digest, size_bytes, visibility, retention_until, storage_receipt_id, created_at)
      VALUES ('art-child-01', '${TENANT}', 'flight-child', 'assign-child-01', 'task-child-01', 'agent-child', 'seat-child-01', 1, 'artifacts/output.json', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 1024, 'tenant', '2026-12-31T00:00:00.000Z', '${artifactStorageReceipt.id}', datetime('now'));
    `)

    // Record consumption by parent flight
    const consumption = await recordConsumedChildArtifact(env, memberAuth(), {
      parentFlightId: 'flight-parent',
      childFlightId: 'flight-child',
      artifactId: 'art-child-01',
    })

    expect(consumption.id).toBeDefined()
    expect(consumption.artifactId).toBe('art-child-01')
    expect(consumption.consumptionReceiptId).toBeDefined()

    // Verify receipt
    const verification = await verifyExecutionReceipt(env, consumption.consumptionReceiptId)
    expect(verification).toEqual({ ok: true })

    // Verify row in flight_dependency_artifacts
    const row = harness.sqlite.prepare(`
      SELECT id, artifact_id, consuming_flight_id, consumption_receipt_id
        FROM flight_dependency_artifacts
       WHERE id = ?
    `).get(consumption.id) as any

    expect(row).toBeDefined()
    expect(row.artifact_id).toBe('art-child-01')
    expect(row.consuming_flight_id).toBe('flight-parent')
  })

  it('rejects artifact consumption when no parent-child flight dependency exists', async () => {
    // No linkChildFlight called
    await expect(recordConsumedChildArtifact(env, memberAuth(), {
      parentFlightId: 'flight-parent',
      childFlightId: 'flight-child',
      artifactId: 'art-child-01',
    })).rejects.toThrow(/dependency_not_found/)
  })
})
