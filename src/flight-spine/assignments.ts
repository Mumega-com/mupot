// src/flight-spine/assignments.ts — Flight Spine composition materialization, lane assignment, and epoch gating.

import type { AuthContext, Env, Task } from '../types'
import { prepareTaskInsert, type CreateTaskInput } from '../tasks/service'
import { appendExecutionReceipt } from './receipts'

export type LaneRole = 'coordinator' | 'worker' | 'integrator' | 'gate'

export interface MaterializeCompositionLaneInput {
  laneKey: string
  role: LaneRole
  task: CreateTaskInput
  assigneeAgentId: string
  runtimeSeatId: string | null
  dependencyLaneKeys: readonly string[]
}

export interface MaterializeCompositionInput {
  objectiveId: string
  flightId: string
  lanes: ReadonlyArray<MaterializeCompositionLaneInput>
}

export interface FlightLane {
  id: string
  tenant: string
  flightId: string
  laneKey: string
  role: LaneRole
  taskId: string
  assignmentEpoch: number
  agentId: string
  runtimeSeatId: string | null
  doneWhen: string
  dependencyLaneKeys: string[]
  createdAt: string
}

export interface MaterializedComposition {
  flightId: string
  objectiveId: string
  tasks: Task[]
  lanes: FlightLane[]
  assignmentReceiptIds: string[]
  materializedReceiptId: string
}

function validateDependencyDag(lanes: ReadonlyArray<MaterializeCompositionLaneInput>): void {
  const laneKeys = new Set<string>()
  for (const lane of lanes) {
    if (laneKeys.has(lane.laneKey)) {
      throw new Error(`duplicate_lane_key: ${lane.laneKey}`)
    }
    laneKeys.add(lane.laneKey)
  }

  // Check all dependencies refer to known lanes
  for (const lane of lanes) {
    for (const depKey of lane.dependencyLaneKeys) {
      if (!laneKeys.has(depKey)) {
        throw new Error(`unknown_dependency_lane: lane ${lane.laneKey} depends on missing lane ${depKey}`)
      }
      if (depKey === lane.laneKey) {
        throw new Error(`self_dependency: lane ${lane.laneKey} cannot depend on itself`)
      }
    }
  }

  // Check for cycles (DFS topological sort)
  const adj = new Map<string, string[]>()
  for (const lane of lanes) {
    adj.set(lane.laneKey, [...lane.dependencyLaneKeys])
  }

  const visited = new Map<string, number>() // 0=unvisited, 1=visiting, 2=visited
  function visit(key: string): void {
    const state = visited.get(key) ?? 0
    if (state === 1) {
      throw new Error(`cycle_detected: circular dependency involving lane ${key}`)
    }
    if (state === 2) return

    visited.set(key, 1)
    for (const dep of adj.get(key) ?? []) {
      visit(dep)
    }
    visited.set(key, 2)
  }

  for (const key of laneKeys) {
    if ((visited.get(key) ?? 0) === 0) {
      visit(key)
    }
  }
}

export async function materializeComposition(
  env: Env,
  auth: AuthContext,
  input: MaterializeCompositionInput,
): Promise<MaterializedComposition> {
  const tenant = env.TENANT_SLUG
  if (!tenant) throw new Error('missing_tenant')

  if (!auth || !auth.memberId) {
    throw new Error('unauthorized: member identity required')
  }

  const objectiveId = input.objectiveId?.trim()
  const flightId = input.flightId?.trim()
  if (!objectiveId) throw new Error('invalid_input: objectiveId required')
  if (!flightId) throw new Error('invalid_input: flightId required')

  const lanes = input.lanes
  if (!lanes || lanes.length === 0) {
    throw new Error('invalid_input: lanes must not be empty')
  }

  // 1. Worker count constraint: 2 to 5 workers
  const workers = lanes.filter((l) => l.role === 'worker')
  if (workers.length < 2 || workers.length > 5) {
    throw new Error(`invalid_composition: worker count must be between 2 and 5 (got ${workers.length})`)
  }

  // 2. Gate count constraint: exactly 1 gate
  const gates = lanes.filter((l) => l.role === 'gate')
  if (gates.length !== 1) {
    throw new Error(`invalid_composition: exactly one gate required (got ${gates.length})`)
  }
  const gate = gates[0]

  // 3. Gate independence: gate agent and seat must differ from coordinator, workers, integrator
  const nonGateLanes = lanes.filter((l) => l.role !== 'gate')
  for (const other of nonGateLanes) {
    if (other.assigneeAgentId === gate.assigneeAgentId) {
      throw new Error(`gate_not_independent: gate agent ${gate.assigneeAgentId} cannot have authorship/worker stake in lane ${other.laneKey}`)
    }
    if (gate.runtimeSeatId && other.runtimeSeatId && gate.runtimeSeatId === other.runtimeSeatId) {
      throw new Error(`gate_not_independent: gate seat ${gate.runtimeSeatId} cannot share hardware seat with lane ${other.laneKey}`)
    }
  }

  // 4. Validate dependency DAG
  validateDependencyDag(lanes)

  // 5. Verify objective existence
  const objective = await env.DB.prepare(`
    SELECT id, squad_id, project_id FROM objectives WHERE tenant = ?1 AND id = ?2
  `).bind(tenant, objectiveId).first<{ id: string; squad_id: string; project_id: string | null }>()

  if (!objective) {
    throw new Error('objective_not_found')
  }

  // 6. Verify flight existence
  const flight = await env.DB.prepare(`
    SELECT id FROM flights WHERE id = ?1
  `).bind(flightId).first<{ id: string }>()

  if (!flight) {
    throw new Error('flight_not_found')
  }

  // Check flight_objectives conflict
  const existingMapping = await env.DB.prepare(`
    SELECT id FROM flight_objectives WHERE tenant = ?1 AND flight_id = ?2
  `).bind(tenant, flightId).first()

  if (existingMapping) {
    throw new Error('flight_already_materialized: flight is already linked to an objective')
  }

  const now = new Date().toISOString()
  const assignmentEpoch = 1

  // 7. Append flight.materialized receipt
  const materializedReceipt = await appendExecutionReceipt(env, auth, {
    type: 'flight.materialized',
    flightId,
    objectiveId,
    idempotencyKey: `flight:${flightId}:materialized`,
    claims: {
      objectiveId,
      flightId,
      laneCount: lanes.length,
      workerCount: workers.length,
      gateAgentId: gate.assigneeAgentId,
      assignmentEpoch,
    },
  })

  // 8. Prepare tasks and assignment receipts
  const preparedTasks: Task[] = []
  const flightLanes: FlightLane[] = []
  const assignmentReceiptIds: string[] = []
  const dbStatements: any[] = []

  for (const lane of lanes) {
    const taskInput: CreateTaskInput = {
      ...lane.task,
      squad_id: objective.squad_id,
      project_id: objective.project_id ?? lane.task.project_id ?? null,
      assignee_agent_id: lane.assigneeAgentId,
      done_when: lane.task.done_when,
    }

    const { task, statement } = await prepareTaskInsert(
      env,
      taskInput,
      { skipEvent: true },
      { assignmentEpoch },
    )
    preparedTasks.push(task)
    dbStatements.push(statement)

    const laneId = crypto.randomUUID()
    const assignmentId = crypto.randomUUID()

    // Append task.assigned receipt
    const taskAssignedReceipt = await appendExecutionReceipt(env, auth, {
      type: 'task.assigned',
      flightId,
      taskId: task.id,
      assignmentEpoch,
      idempotencyKey: `flight:${flightId}:lane:${lane.laneKey}:assigned:epoch:${assignmentEpoch}`,
      claims: {
        flightId,
        laneId,
        laneKey: lane.laneKey,
        role: lane.role,
        taskId: task.id,
        assigneeAgentId: lane.assigneeAgentId,
        runtimeSeatId: lane.runtimeSeatId,
        assignmentEpoch,
      },
    })
    assignmentReceiptIds.push(taskAssignedReceipt.id)

    const dependencyKeysJson = JSON.stringify([...lane.dependencyLaneKeys])

    dbStatements.push(
      env.DB.prepare(`
        INSERT INTO flight_lanes (
          id, tenant, flight_id, lane_key, role, task_id, assignment_epoch,
          agent_id, runtime_seat_id, done_when, dependency_lane_keys_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      `).bind(
        laneId,
        tenant,
        flightId,
        lane.laneKey,
        lane.role,
        task.id,
        assignmentEpoch,
        lane.assigneeAgentId,
        lane.runtimeSeatId,
        task.done_when,
        dependencyKeysJson,
        now,
      ),
    )

    const assignedByPrincipalKind = auth.boundAgentId ? 'agent' : 'member'
    const assignedByPrincipalId = auth.boundAgentId ?? auth.memberId

    dbStatements.push(
      env.DB.prepare(`
        INSERT INTO flight_task_assignments (
          id, tenant, flight_id, lane_id, task_id, assignment_epoch, agent_id,
          runtime_seat_id, assigned_by_principal_kind, assigned_by_principal_id,
          assigned_by_member_id, assignment_receipt_id, assigned_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      `).bind(
        assignmentId,
        tenant,
        flightId,
        laneId,
        task.id,
        assignmentEpoch,
        lane.assigneeAgentId,
        lane.runtimeSeatId,
        assignedByPrincipalKind,
        assignedByPrincipalId,
        auth.memberId,
        taskAssignedReceipt.id,
        now,
      ),
    )

    flightLanes.push({
      id: laneId,
      tenant,
      flightId,
      laneKey: lane.laneKey,
      role: lane.role,
      taskId: task.id,
      assignmentEpoch,
      agentId: lane.assigneeAgentId,
      runtimeSeatId: lane.runtimeSeatId,
      doneWhen: task.done_when,
      dependencyLaneKeys: [...lane.dependencyLaneKeys],
      createdAt: now,
    })
  }

  // Insert flight_objectives
  dbStatements.push(
    env.DB.prepare(`
      INSERT INTO flight_objectives (
        id, tenant, flight_id, objective_id, materialization_receipt_id, linked_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).bind(
      crypto.randomUUID(),
      tenant,
      flightId,
      objectiveId,
      materializedReceipt.id,
      now,
    ),
  )

  await env.DB.batch(dbStatements)

  return {
    flightId,
    objectiveId,
    tasks: preparedTasks,
    lanes: flightLanes,
    assignmentReceiptIds,
    materializedReceiptId: materializedReceipt.id,
  }
}
