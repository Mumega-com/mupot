import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  linkChildFlight,
  recordConsumedChildArtifact,
} from '../src/flight-spine/dependencies'
import { acceptObjective } from '../src/flight-spine/objectives'
import { appendExecutionReceipt } from '../src/flight-spine/receipts'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-flight-dependencies'
const SERVER_TIME = '2026-08-23T16:00:00.000Z'
const MEMBER_ID = 'member-parent'
const SQUAD_ID = 'squad-parent'
const PARENT_AGENT = 'agent-parent'
const CHILD_AGENT = 'agent-child'
const PARENT_FLIGHT = 'flight-parent'
const CHILD_FLIGHT = 'flight-child'

let harness: SqliteD1Harness
let env: Env

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: 'parent@example.test',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: PARENT_AGENT,
    capabilities: [{
      member_id: MEMBER_ID,
      scope_type: 'squad',
      scope_id: SQUAD_ID,
      capability: 'member',
    }],
    ...overrides,
  }
}

async function seedObjectiveAndFlights(): Promise<string> {
  const objective = await acceptObjective(env, auth(), {
    squadId: SQUAD_ID,
    title: 'Create and consume a child flight artifact',
    successContract: 'The parent consumes current evidence from its linked child.',
    authorityEnvelope: { allowedActions: ['flight:link-child', 'artifact:consume'] },
    policy: { childArtifactsRequired: true },
    budgetMicroUsd: 0,
    payload: { child: 'fresh' },
    idempotencyKey: 'objective-dependency-001',
  })
  const acceptedMillis = Date.parse(objective.acceptedAt)
  harness.sqlite.prepare(`
    INSERT INTO flights (
      id, tenant, agent, dispatched_by_agent_id, goal, status, meta, created_at
    ) VALUES (?, ?, ?, ?, ?, 'running', '{}', ?)
  `).run(PARENT_FLIGHT, TENANT, PARENT_AGENT, PARENT_AGENT, 'Parent', acceptedMillis + 1)
  harness.sqlite.prepare(`
    INSERT INTO flights (
      id, tenant, agent, dispatched_by_agent_id, goal, status, meta, created_at
    ) VALUES (?, ?, ?, ?, ?, 'running', '{}', ?)
  `).run(CHILD_FLIGHT, TENANT, CHILD_AGENT, PARENT_AGENT, 'Child', acceptedMillis + 2)
  harness.sqlite.prepare(`
    INSERT INTO flight_objectives (
      id, tenant, flight_id, objective_id, materialization_receipt_id, linked_at
    ) VALUES ('parent-objective-link', ?, ?, ?, NULL, ?)
  `).run(TENANT, PARENT_FLIGHT, objective.id, objective.acceptedAt)
  return objective.id
}

function count(table: string): number {
  return Number((harness.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number
  }).count)
}

async function seedArtifactFacts(dependencyId: string, objectiveId: string): Promise<{
  artifactId: string
  consumptionReceiptId: string
}> {
  harness.sqlite.exec(`
    INSERT INTO tasks (
      id, squad_id, title, done_when, status, assignee_agent_id, assignment_epoch
    ) VALUES
      ('task-child', '${SQUAD_ID}', 'Child output', 'Child artifact exists', 'done', '${CHILD_AGENT}', 1),
      ('task-parent', '${SQUAD_ID}', 'Parent integration', 'Child artifact is consumed', 'open', '${PARENT_AGENT}', 1);
    INSERT INTO runtime_seats (
      id, tenant, agent_id, seat_name, host_id, adapter_kind, state,
      current_generation, current_fencing_epoch, capabilities_json, created_at, updated_at
    ) VALUES
      ('seat-child', '${TENANT}', '${CHILD_AGENT}', 'child', 'host-child', 'test', 'pending', 0, 0, '[]', '${SERVER_TIME}', '${SERVER_TIME}'),
      ('seat-parent', '${TENANT}', '${PARENT_AGENT}', 'parent', 'host-parent', 'test', 'pending', 0, 0, '[]', '${SERVER_TIME}', '${SERVER_TIME}');
    INSERT INTO flight_lanes (
      id, tenant, flight_id, lane_key, role, task_id, assignment_epoch,
      agent_id, runtime_seat_id, done_when, dependency_lane_keys_json, created_at
    ) VALUES
      ('lane-child', '${TENANT}', '${CHILD_FLIGHT}', 'child-worker', 'worker', 'task-child', 1,
       '${CHILD_AGENT}', 'seat-child', 'Child artifact exists', '[]', '${SERVER_TIME}'),
      ('lane-parent', '${TENANT}', '${PARENT_FLIGHT}', 'parent-integrator', 'integrator', 'task-parent', 1,
       '${PARENT_AGENT}', 'seat-parent', 'Child artifact is consumed', '[]', '${SERVER_TIME}');
    INSERT INTO flight_task_assignments (
      id, tenant, flight_id, lane_id, task_id, assignment_epoch, agent_id,
      runtime_seat_id, assigned_by_principal_kind, assigned_by_principal_id,
      assigned_by_member_id, assignment_receipt_id, assigned_at
    ) VALUES
      ('assignment-child', '${TENANT}', '${CHILD_FLIGHT}', 'lane-child', 'task-child', 1,
       '${CHILD_AGENT}', 'seat-child', 'agent', '${PARENT_AGENT}', '${MEMBER_ID}', NULL, '${SERVER_TIME}'),
      ('assignment-parent', '${TENANT}', '${PARENT_FLIGHT}', 'lane-parent', 'task-parent', 1,
       '${PARENT_AGENT}', 'seat-parent', 'agent', '${PARENT_AGENT}', '${MEMBER_ID}', NULL, '${SERVER_TIME}');
  `)
  const storageReceipt = await appendExecutionReceipt(env, auth(), {
    type: 'result.reported',
    idempotencyKey: 'child-artifact-storage-fact',
    objectiveId,
    flightId: CHILD_FLIGHT,
    taskId: 'task-child',
    assignmentEpoch: 1,
    claims: { artifactMetadataRecorded: true },
  })
  const artifactId = 'artifact-child'
  harness.sqlite.prepare(`
    INSERT INTO artifacts (
      id, tenant, flight_id, producing_assignment_id, producing_task_id,
      producing_agent_id, producing_runtime_seat_id, assignment_epoch,
      object_key, digest, size_bytes, visibility, retention_until,
      storage_receipt_id, created_at
    ) VALUES (?, ?, ?, 'assignment-child', 'task-child', ?, 'seat-child', 1,
      'sha256/aa/child-artifact', ?, 128, 'tenant', '2026-09-23T16:00:00.000Z', ?, ?)
  `).run(
    artifactId,
    TENANT,
    CHILD_FLIGHT,
    CHILD_AGENT,
    'a'.repeat(64),
    storageReceipt.id,
    SERVER_TIME,
  )
  const consumptionReceipt = await appendExecutionReceipt(env, auth(), {
    type: 'effect.intent',
    idempotencyKey: 'child-artifact-consumption-fact',
    objectiveId,
    flightId: PARENT_FLIGHT,
    taskId: 'task-parent',
    assignmentEpoch: 1,
    claims: { childArtifactId: artifactId, dependencyId },
  })
  return { artifactId, consumptionReceiptId: consumptionReceipt.id }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(SERVER_TIME))
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name)
      VALUES ('department-parent', 'parent', 'Parent');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${SQUAD_ID}', 'department-parent', 'parent', 'Parent');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES
        ('${PARENT_AGENT}', '${SQUAD_ID}', 'parent', 'Parent', 'member', 'test', 'active'),
        ('${CHILD_AGENT}', '${SQUAD_ID}', 'child', 'Child', 'member', 'test', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES
        ('membership-parent', '${PARENT_AGENT}', '${SQUAD_ID}', 'member'),
        ('membership-child', '${CHILD_AGENT}', '${SQUAD_ID}', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('${MEMBER_ID}', 'Parent Member', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${PARENT_AGENT}', '${MEMBER_ID}', '${SERVER_TIME}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('capability-parent', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
  `)
  env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('Flight Spine parent-child dependencies', () => {
  it('links a post-objective child with server-derived principal and member facts', async () => {
    const objectiveId = await seedObjectiveAndFlights()

    const linked = await linkChildFlight(env, auth(), {
      objectiveId,
      parentFlightId: PARENT_FLIGHT,
      childFlightId: CHILD_FLIGHT,
    })

    expect(linked).toMatchObject({
      tenant: TENANT,
      objectiveId,
      parentFlightId: PARENT_FLIGHT,
      childFlightId: CHILD_FLIGHT,
      createdByPrincipalKind: 'agent',
      createdByPrincipalId: PARENT_AGENT,
      createdByMemberId: MEMBER_ID,
    })
    expect(harness.sqlite.prepare(`
      SELECT created_by_principal_kind, created_by_principal_id, created_by_member_id
        FROM flight_dependencies WHERE id = ?
    `).get(linked.id)).toEqual({
      created_by_principal_kind: 'agent',
      created_by_principal_id: PARENT_AGENT,
      created_by_member_id: MEMBER_ID,
    })

    expect(await linkChildFlight(env, auth(), {
      objectiveId,
      parentFlightId: PARENT_FLIGHT,
      childFlightId: CHILD_FLIGHT,
    })).toEqual(linked)
    await expect(linkChildFlight(env, auth({ tenant: 'other-tenant' }), {
      objectiveId,
      parentFlightId: PARENT_FLIGHT,
      childFlightId: CHILD_FLIGHT,
    })).rejects.toMatchObject({ code: 'unauthorized_tenant' })
    expect(count('flight_dependencies')).toBe(1)
  })

  it('rejects a child created before objective acceptance and a transitive dependency cycle', async () => {
    const objectiveId = await seedObjectiveAndFlights()
    harness.sqlite.prepare(`
      INSERT INTO flights (
        id, tenant, agent, dispatched_by_agent_id, goal, status, meta, created_at
      ) VALUES ('flight-stale-child', ?, ?, ?, 'Stale child', 'running', '{}', ?)
    `).run(TENANT, CHILD_AGENT, PARENT_AGENT, Date.parse(SERVER_TIME) - 1)

    await expect(linkChildFlight(env, auth(), {
      objectiveId,
      parentFlightId: PARENT_FLIGHT,
      childFlightId: 'flight-stale-child',
    })).rejects.toMatchObject({ code: 'child_predates_objective' })

    await linkChildFlight(env, auth(), {
      objectiveId,
      parentFlightId: PARENT_FLIGHT,
      childFlightId: CHILD_FLIGHT,
    })
    harness.sqlite.prepare(`
      INSERT INTO flight_objectives (
        id, tenant, flight_id, objective_id, materialization_receipt_id, linked_at
      ) VALUES ('child-objective-link', ?, ?, ?, NULL, ?)
    `).run(TENANT, CHILD_FLIGHT, objectiveId, SERVER_TIME)
    await expect(linkChildFlight(env, auth(), {
      objectiveId,
      parentFlightId: CHILD_FLIGHT,
      childFlightId: PARENT_FLIGHT,
    })).rejects.toMatchObject({ code: 'dependency_cycle' })
    expect(count('flight_dependencies')).toBe(1)
  })

  it('records an explicit child-artifact consumption fact derived from the dependency', async () => {
    const objectiveId = await seedObjectiveAndFlights()
    const dependency = await linkChildFlight(env, auth(), {
      objectiveId,
      parentFlightId: PARENT_FLIGHT,
      childFlightId: CHILD_FLIGHT,
    })
    const artifact = await seedArtifactFacts(dependency.id, objectiveId)

    const consumed = await recordConsumedChildArtifact(env, auth(), {
      flightDependencyId: dependency.id,
      artifactId: artifact.artifactId,
      consumingTaskId: 'task-parent',
      consumingAssignmentId: 'assignment-parent',
      consumptionReceiptId: artifact.consumptionReceiptId,
    })

    expect(consumed).toMatchObject({
      tenant: TENANT,
      flightDependencyId: dependency.id,
      artifactId: artifact.artifactId,
      consumingFlightId: PARENT_FLIGHT,
      consumingTaskId: 'task-parent',
      consumingAssignmentId: 'assignment-parent',
      consumptionReceiptId: artifact.consumptionReceiptId,
    })
    expect(harness.sqlite.prepare(`
      SELECT consuming_flight_id, consuming_task_id, consuming_assignment_id,
             consumption_receipt_id
        FROM flight_dependency_artifacts WHERE id = ?
    `).get(consumed.id)).toEqual({
      consuming_flight_id: PARENT_FLIGHT,
      consuming_task_id: 'task-parent',
      consuming_assignment_id: 'assignment-parent',
      consumption_receipt_id: artifact.consumptionReceiptId,
    })
    expect(await recordConsumedChildArtifact(env, auth(), {
      flightDependencyId: dependency.id,
      artifactId: artifact.artifactId,
      consumingTaskId: 'task-parent',
      consumingAssignmentId: 'assignment-parent',
      consumptionReceiptId: artifact.consumptionReceiptId,
    })).toEqual(consumed)
    expect(count('flight_dependency_artifacts')).toBe(1)
  })

  it('rejects artifacts outside the linked child and task or assignment facts outside the parent', async () => {
    const objectiveId = await seedObjectiveAndFlights()
    const dependency = await linkChildFlight(env, auth(), {
      objectiveId,
      parentFlightId: PARENT_FLIGHT,
      childFlightId: CHILD_FLIGHT,
    })
    const artifact = await seedArtifactFacts(dependency.id, objectiveId)

    await expect(recordConsumedChildArtifact(env, auth(), {
      flightDependencyId: dependency.id,
      artifactId: artifact.artifactId,
      consumingTaskId: 'task-child',
      consumingAssignmentId: 'assignment-child',
      consumptionReceiptId: artifact.consumptionReceiptId,
    })).rejects.toMatchObject({ code: 'consumer_scope_mismatch' })

    const unrelatedReceipt = await appendExecutionReceipt(env, auth(), {
      type: 'effect.intent',
      idempotencyKey: 'unrelated-parent-effect',
      objectiveId,
      flightId: PARENT_FLIGHT,
      taskId: 'task-parent',
      assignmentEpoch: 1,
      claims: { unrelated: true },
    })
    await expect(recordConsumedChildArtifact(env, auth(), {
      flightDependencyId: dependency.id,
      artifactId: artifact.artifactId,
      consumingTaskId: 'task-parent',
      consumingAssignmentId: 'assignment-parent',
      consumptionReceiptId: unrelatedReceipt.id,
    })).rejects.toMatchObject({ code: 'consumption_receipt_mismatch' })

    // Artifact rows are immutable; seed a mismatched fact by temporarily dropping only the
    // schema trigger in this negative fixture, never in production code.
    harness.sqlite.exec('DROP TRIGGER artifacts_no_update')
    harness.sqlite.prepare('UPDATE artifacts SET flight_id = ? WHERE id = ?')
      .run(PARENT_FLIGHT, artifact.artifactId)
    await expect(recordConsumedChildArtifact(env, auth(), {
      flightDependencyId: dependency.id,
      artifactId: artifact.artifactId,
      consumingTaskId: 'task-parent',
      consumingAssignmentId: 'assignment-parent',
      consumptionReceiptId: artifact.consumptionReceiptId,
    })).rejects.toMatchObject({ code: 'artifact_not_from_child' })
    expect(count('flight_dependency_artifacts')).toBe(0)
  })
})
