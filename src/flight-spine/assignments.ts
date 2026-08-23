import type { CreateTaskInput } from '../tasks/service'
import {
  isValidGateOwnerForm,
  prepareGuardedTaskInsert,
} from '../tasks/service'
import type { AuthContext, Capability, Env, Task } from '../types'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import {
  executePreparedExecutionReceiptBatch,
  prepareAuditedDomainMutation,
  prepareFreshExecutionReceiptChain,
  type PreparedAtomicDomainMutation,
} from './receipts'
import type { ExecutionReceiptDraft, JsonValue } from './types'
import {
  flightSpineAudit,
  getObjective,
  requireFlightSpineSquadAuthority,
  resolveFlightSpinePrincipal,
} from './objectives'

export type LaneRole = 'coordinator' | 'worker' | 'integrator' | 'gate'

export interface MaterializeLaneInput {
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
  lanes: readonly MaterializeLaneInput[]
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

export type AssignmentErrorCode =
  | 'invalid_composition'
  | 'objective_not_found'
  | 'flight_not_found'
  | 'flight_scope_mismatch'
  | 'flight_already_materialized'
  | 'invalid_worker_count'
  | 'invalid_coordinator_count'
  | 'invalid_integrator_count'
  | 'invalid_gate_count'
  | 'gate_not_independent'
  | 'invalid_gate_owner'
  | 'dependency_not_found'
  | 'dependency_cycle'
  | 'agent_not_assignable'
  | 'seat_not_assignable'
  | 'stale_assignment_epoch'
  | 'stale_receipt_head'
  | 'materialization_conflict'

export class AssignmentError extends Error {
  readonly name = 'AssignmentError'

  constructor(readonly code: AssignmentErrorCode) {
    super(code)
  }
}

interface FlightRow {
  id: string
  tenant: string
  agent: string
  status: string
  project_id: string | null
  created_at: number
}

interface NormalizedLane {
  laneKey: string
  role: LaneRole
  task: CreateTaskInput
  assigneeAgentId: string
  runtimeSeatId: string | null
  dependencyLaneKeys: string[]
}

interface PreparedLane extends NormalizedLane {
  laneId: string
  assignmentId: string
  task: CreateTaskInput
  taskRow: Task
  taskInsertSql: string
  taskInsertBindings: readonly (string | number | boolean | null)[]
  createdAt: string
}

const ROLE_SET = new Set<LaneRole>(['coordinator', 'worker', 'integrator', 'gate'])
const CAPABILITY_RANK: Record<Capability, number> = {
  observer: 1,
  member: 2,
  lead: 3,
  admin: 4,
  owner: 5,
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new AssignmentError('invalid_composition')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new AssignmentError('invalid_composition')
  }
  return normalized
}

function normalizeLane(input: MaterializeLaneInput): NormalizedLane {
  if (typeof input !== 'object' || input === null || !ROLE_SET.has(input.role)) {
    throw new AssignmentError('invalid_composition')
  }
  if (!Array.isArray(input.dependencyLaneKeys)) {
    throw new AssignmentError('invalid_composition')
  }
  const dependencies = input.dependencyLaneKeys.map((key) => boundedText(key, 120))
  if (new Set(dependencies).size !== dependencies.length) {
    throw new AssignmentError('invalid_composition')
  }
  const runtimeSeatId = input.runtimeSeatId === null
    ? null
    : boundedText(input.runtimeSeatId, 255)
  return {
    laneKey: boundedText(input.laneKey, 120),
    role: input.role,
    task: input.task,
    assigneeAgentId: boundedText(input.assigneeAgentId, 255),
    runtimeSeatId,
    dependencyLaneKeys: dependencies,
  }
}

function assertDag(lanes: readonly NormalizedLane[]): void {
  const laneKeys = new Set(lanes.map((lane) => lane.laneKey))
  for (const lane of lanes) {
    for (const dependency of lane.dependencyLaneKeys) {
      if (!laneKeys.has(dependency)) throw new AssignmentError('dependency_not_found')
    }
  }
  const state = new Map<string, 'visiting' | 'visited'>()
  const byKey = new Map(lanes.map((lane) => [lane.laneKey, lane]))
  const visit = (laneKey: string): void => {
    const current = state.get(laneKey)
    if (current === 'visiting') throw new AssignmentError('dependency_cycle')
    if (current === 'visited') return
    state.set(laneKey, 'visiting')
    for (const dependency of byKey.get(laneKey)?.dependencyLaneKeys ?? []) visit(dependency)
    state.set(laneKey, 'visited')
  }
  for (const lane of lanes) visit(lane.laneKey)
}

function assertRoleShape(lanes: readonly NormalizedLane[]): void {
  const count = (role: LaneRole) => lanes.filter((lane) => lane.role === role).length
  const workers = count('worker')
  if (workers < 2 || workers > 5) throw new AssignmentError('invalid_worker_count')
  if (count('coordinator') !== 1) throw new AssignmentError('invalid_coordinator_count')
  if (count('integrator') !== 1) throw new AssignmentError('invalid_integrator_count')
  if (count('gate') !== 1) throw new AssignmentError('invalid_gate_count')

  const gate = lanes.find((lane) => lane.role === 'gate') as NormalizedLane
  const executionLanes = lanes.filter((lane) => lane.role !== 'gate')
  if (
    gate.runtimeSeatId === null
    || executionLanes.some((lane) => lane.assigneeAgentId === gate.assigneeAgentId)
    || executionLanes.some((lane) => lane.runtimeSeatId === gate.runtimeSeatId)
  ) {
    throw new AssignmentError('gate_not_independent')
  }
  const integrator = lanes.find((lane) => lane.role === 'integrator') as NormalizedLane
  if (!integrator.task.gate_owner || !isValidGateOwnerForm(integrator.task.gate_owner)) {
    throw new AssignmentError('invalid_gate_owner')
  }
}

async function requireAssignableAgent(
  env: Env,
  agentId: string,
  squadId: string,
): Promise<void> {
  const row = await env.DB.prepare(`
    SELECT agent.status, membership.capability
      FROM agents agent
      LEFT JOIN memberships membership
        ON membership.agent_id = agent.id AND membership.squad_id = ?2
     WHERE agent.id = ?1
  `).bind(agentId, squadId).first<{ status: string; capability: Capability | null }>()
  if (
    !row
    || row.status !== 'active'
    || row.capability === null
    || CAPABILITY_RANK[row.capability] < CAPABILITY_RANK.member
  ) {
    throw new AssignmentError('agent_not_assignable')
  }
}

async function requirePendingSeat(
  env: Env,
  seatId: string | null,
  agentId: string,
): Promise<void> {
  if (seatId === null) return
  const seat = await env.DB.prepare(`
    SELECT id FROM runtime_seats
     WHERE id = ?1 AND tenant = ?2 AND agent_id = ?3 AND state = 'pending'
  `).bind(seatId, env.TENANT_SLUG, agentId).first<{ id: string }>()
  if (!seat) throw new AssignmentError('seat_not_assignable')
}

async function requireLiveGateBinding(
  env: Env,
  lanes: readonly NormalizedLane[],
): Promise<void> {
  const integrator = lanes.find((lane) => lane.role === 'integrator') as NormalizedLane
  const gate = lanes.find((lane) => lane.role === 'gate') as NormalizedLane
  const grant = await env.DB.prepare(`
    SELECT id FROM gate_grants
     WHERE capability = ?1 AND principal_type = 'agent' AND principal_id = ?2
     LIMIT 1
  `).bind(integrator.task.gate_owner, gate.assigneeAgentId).first<{ id: string }>()
  if (!grant) throw new AssignmentError('invalid_gate_owner')
}

function mapAtomicFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('execution receipt head sequence must advance')) {
    throw new AssignmentError('stale_receipt_head')
  }
  if (message.includes('assignment_epoch') || message.includes('assignment epoch')) {
    throw new AssignmentError('stale_assignment_epoch')
  }
  throw new AssignmentError('materialization_conflict')
}

export async function materializeComposition(
  env: Env,
  auth: AuthContext,
  input: MaterializeCompositionInput,
): Promise<MaterializedComposition> {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.lanes)) {
    throw new AssignmentError('invalid_composition')
  }
  const objectiveId = boundedText(input.objectiveId, 200)
  const flightId = boundedText(input.flightId, 120)
  const objective = await getObjective(env, auth, objectiveId)
  if (!objective) throw new AssignmentError('objective_not_found')
  const principal = await resolveFlightSpinePrincipal(env, auth)
  await requireFlightSpineSquadAuthority(env, auth, principal, objective.squadId, 'member')

  const flight = await env.DB.prepare(`
    SELECT id, tenant, agent, status, project_id, created_at
      FROM flights WHERE id = ?1 AND tenant = ?2
  `).bind(flightId, env.TENANT_SLUG).first<FlightRow>()
  if (!flight) throw new AssignmentError('flight_not_found')
  if (
    flight.project_id !== objective.projectId
    || !['preflight', 'running'].includes(flight.status)
    || Number(flight.created_at) <= Date.parse(objective.acceptedAt)
  ) {
    throw new AssignmentError('flight_scope_mismatch')
  }
  const existingLink = await env.DB.prepare(`
    SELECT objective_id FROM flight_objectives
     WHERE tenant = ?1 AND flight_id = ?2
  `).bind(env.TENANT_SLUG, flightId).first<{ objective_id: string }>()
  if (existingLink) throw new AssignmentError('flight_already_materialized')

  const lanes = input.lanes.map(normalizeLane)
  if (new Set(lanes.map((lane) => lane.laneKey)).size !== lanes.length) {
    throw new AssignmentError('invalid_composition')
  }
  assertRoleShape(lanes)
  assertDag(lanes)
  await requireLiveGateBinding(env, lanes)
  const coordinator = lanes.find((lane) => lane.role === 'coordinator') as NormalizedLane
  if (flight.agent !== coordinator.assigneeAgentId) {
    throw new AssignmentError('flight_scope_mismatch')
  }

  for (const lane of lanes) {
    if (
      lane.task.squad_id !== objective.squadId
      || (lane.task.project_id ?? null) !== objective.projectId
      || (lane.task.status !== undefined && lane.task.status !== 'open')
      || (lane.task.assignee_agent_id != null && lane.task.assignee_agent_id !== lane.assigneeAgentId)
      || lane.task.parent_task_id != null
    ) {
      throw new AssignmentError('invalid_composition')
    }
    await requireAssignableAgent(env, lane.assigneeAgentId, objective.squadId)
    await requirePendingSeat(env, lane.runtimeSeatId, lane.assigneeAgentId)
  }

  const createdAt = new Date().toISOString()
  const preparedLanes: PreparedLane[] = []
  for (const lane of lanes) {
    const taskId = crypto.randomUUID()
    const taskInput: CreateTaskInput = {
      ...lane.task,
      squad_id: objective.squadId,
      project_id: objective.projectId,
      status: 'open',
      assignee_agent_id: lane.assigneeAgentId,
    }
    const taskInsert = await prepareGuardedTaskInsert(env, taskInput, {
      id: taskId,
      skipEvent: true,
      skipMirror: true,
    })
    preparedLanes.push({
      ...lane,
      task: taskInput,
      taskRow: taskInsert.task,
      taskInsertSql: taskInsert.sql,
      taskInsertBindings: taskInsert.bindings,
      laneId: crypto.randomUUID(),
      assignmentId: crypto.randomUUID(),
      createdAt,
    })
  }

  const receiptDrafts: ExecutionReceiptDraft[] = [
    {
      type: 'composition.proposed' as const,
      idempotencyKey: `flight:${flightId}:composition`,
      objectiveId,
      flightId,
      claims: {
        lanes: preparedLanes.map((lane) => ({
          laneKey: lane.laneKey,
          role: lane.role,
          agentId: lane.assigneeAgentId,
          runtimeSeatId: lane.runtimeSeatId,
          dependencyLaneKeys: lane.dependencyLaneKeys,
        })),
      },
    },
    {
      type: 'flight.materialized' as const,
      idempotencyKey: `flight:${flightId}:materialized`,
      objectiveId,
      flightId,
      claims: { laneCount: preparedLanes.length, assignmentEpoch: 1 },
    },
    ...preparedLanes.map((lane) => ({
      type: 'task.assigned' as const,
      idempotencyKey: `flight:${flightId}:task:${lane.taskRow.id}:assigned`,
      objectiveId,
      flightId,
      taskId: lane.taskRow.id,
      assignmentEpoch: 1,
      claims: {
        laneKey: lane.laneKey,
        role: lane.role,
        agentId: lane.assigneeAgentId,
        runtimeSeatId: lane.runtimeSeatId,
      },
    })),
  ]
  const preparedReceipts = await prepareFreshExecutionReceiptChain(env, auth, receiptDrafts)
  const materializedReceipt = preparedReceipts.expectedReceipts[1]
  const assignmentReceipts = preparedReceipts.expectedReceipts.slice(2)
  const domainMutations: PreparedAtomicDomainMutation[] = []
  const integratorLane = preparedLanes.find((lane) => lane.role === 'integrator') as PreparedLane
  const gateLane = preparedLanes.find((lane) => lane.role === 'gate') as PreparedLane
  const liveLaneFactsJson = canonicalJson(preparedLanes.map((lane) => ({
    agentId: lane.assigneeAgentId,
    runtimeSeatId: lane.runtimeSeatId,
  })))

  const linkDigest = await sha256Hex(canonicalJson({ objectiveId, flightId }))
  domainMutations.push(prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO flight_objectives (
      id, tenant, flight_id, objective_id, materialization_receipt_id, linked_at
    )
    SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1
         FROM flights flight
         JOIN objectives objective ON objective.id = ? AND objective.tenant = ?
        WHERE flight.id = ? AND flight.tenant = ? AND flight.agent = ?
          AND flight.status IN ('preflight', 'running')
          AND flight.project_id IS ?
          AND objective.squad_id = ? AND objective.project_id IS ?
          AND objective.accepted_at = ?
          AND flight.created_at > ?
     )
       AND EXISTS (
         SELECT 1 FROM members member
          WHERE member.id = ? AND member.tenant = ? AND member.status = 'active'
       )
       AND EXISTS (
         SELECT 1 FROM members authority_member
          WHERE authority_member.id = ? AND authority_member.tenant = ?
            AND authority_member.status = 'active'
       )
       AND (
         ? = 1
         OR EXISTS (
           SELECT 1
             FROM capabilities capability
             JOIN squads squad ON squad.id = ?
            WHERE capability.member_id = ?
              AND (
                capability.scope_type = 'org'
                OR (capability.scope_type = 'department'
                  AND capability.scope_id = squad.department_id)
                OR (capability.scope_type = 'squad' AND capability.scope_id = squad.id)
              )
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
         OR EXISTS (
           SELECT 1 FROM channel_capability_grants capability
            WHERE capability.member_id = ? AND capability.squad_id = ?
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
       )
       AND (
         ? IS NULL
         OR EXISTS (
           SELECT 1
             FROM agents agent
             JOIN agent_member_bindings binding
               ON binding.agent_id = agent.id AND binding.tenant = ?
                AND binding.member_id = ?
             JOIN memberships membership
               ON membership.agent_id = agent.id AND membership.squad_id = ?
            WHERE agent.id = ? AND agent.status = 'active'
              AND CASE membership.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
       )
       AND (
         ? IS NULL
         OR EXISTS (
           SELECT 1
             FROM projects project
             JOIN project_squad_access access
               ON access.project_id = project.id AND access.squad_id = ?
            WHERE project.id = ? AND project.status <> 'archived'
              AND access.access_level IN ('write', 'admin')
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM json_each(?) lane
           LEFT JOIN agents agent
             ON agent.id = json_extract(lane.value, '$.agentId')
            AND agent.status = 'active'
           LEFT JOIN memberships membership
             ON membership.agent_id = agent.id AND membership.squad_id = ?
           LEFT JOIN runtime_seats seat
             ON seat.id = json_extract(lane.value, '$.runtimeSeatId')
            AND seat.tenant = ? AND seat.agent_id = agent.id AND seat.state = 'pending'
          WHERE agent.id IS NULL
             OR CASE membership.capability
               WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
               WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END < 2
             OR (json_extract(lane.value, '$.runtimeSeatId') IS NOT NULL AND seat.id IS NULL)
       )
       AND EXISTS (
         SELECT 1 FROM gate_grants grant_row
          WHERE grant_row.capability = ? AND grant_row.principal_type = 'agent'
            AND grant_row.principal_id = ?
       )`,
    bindings: [
      crypto.randomUUID(), env.TENANT_SLUG, flightId, objectiveId,
      materializedReceipt.id, createdAt,
      objectiveId,
      env.TENANT_SLUG,
      flightId,
      env.TENANT_SLUG,
      coordinator.assigneeAgentId,
      objective.projectId,
      objective.squadId,
      objective.projectId,
      objective.acceptedAt,
      Date.parse(objective.acceptedAt),
      principal.memberId,
      env.TENANT_SLUG,
      principal.authorityMemberId,
      env.TENANT_SLUG,
      auth.capabilities === undefined && (auth.role === 'owner' || auth.role === 'admin') ? 1 : 0,
      objective.squadId,
      principal.authorityMemberId,
      principal.authorityMemberId,
      objective.squadId,
      principal.agentId,
      env.TENANT_SLUG,
      principal.memberId,
      objective.squadId,
      principal.agentId,
      objective.projectId,
      objective.squadId,
      objective.projectId,
      liveLaneFactsJson,
      objective.squadId,
      env.TENANT_SLUG,
      integratorLane.taskRow.gate_owner,
      gateLane.assigneeAgentId,
    ],
    audit: flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:${flightId}:objective-link`,
      handler: 'flight_spine.materialize_composition',
      operation: 'insert',
      targetKind: 'flight_objective',
      targetId: flightId,
      afterDigest: linkDigest,
      objectiveId,
      flightId,
      requestId: `flight:${flightId}:objective-link`,
      idempotencyKey: `flight:${flightId}:materialized`,
      evidence: { materializedReceiptId: materializedReceipt.id },
    }),
  }))

  for (const [index, lane] of preparedLanes.entries()) {
    const assignmentReceipt = assignmentReceipts[index]
    const taskDigest = await sha256Hex(canonicalJson({
      id: lane.taskRow.id,
      squadId: lane.taskRow.squad_id,
      projectId: lane.taskRow.project_id,
      title: lane.taskRow.title,
      doneWhen: lane.taskRow.done_when,
      assigneeAgentId: lane.taskRow.assignee_agent_id,
      gateOwner: lane.taskRow.gate_owner,
    }))
    domainMutations.push(prepareAuditedDomainMutation(env.DB, {
      sql: lane.taskInsertSql,
      bindings: lane.taskInsertBindings,
      audit: flightSpineAudit(auth, principal, {
        expectedAuditId: `audit:${flightId}:task:${lane.taskRow.id}:insert`,
        handler: 'flight_spine.materialize_composition',
        operation: 'insert',
        targetKind: 'task',
        targetId: lane.taskRow.id,
        afterDigest: taskDigest,
        objectiveId,
        flightId,
        taskId: lane.taskRow.id,
        requestId: `flight:${flightId}:task:${lane.taskRow.id}:insert`,
        evidence: { laneKey: lane.laneKey },
      }),
    }))
    domainMutations.push(prepareAuditedDomainMutation(env.DB, {
      sql: `UPDATE tasks
               SET assignment_epoch = CASE WHEN assignment_epoch = 0 THEN 1 ELSE -1 END
             WHERE id = ?`,
      bindings: [lane.taskRow.id],
      audit: flightSpineAudit(auth, principal, {
        expectedAuditId: `audit:${flightId}:task:${lane.taskRow.id}:epoch`,
        handler: 'flight_spine.materialize_composition',
        operation: 'advance_assignment_epoch',
        targetKind: 'task',
        targetId: lane.taskRow.id,
        beforeDigest: await sha256Hex(canonicalJson({ assignmentEpoch: 0 })),
        afterDigest: await sha256Hex(canonicalJson({ assignmentEpoch: 1 })),
        objectiveId,
        flightId,
        taskId: lane.taskRow.id,
        requestId: `flight:${flightId}:task:${lane.taskRow.id}:epoch`,
        evidence: { expectedPreviousEpoch: 0, assignmentEpoch: 1 },
      }),
    }))
    const laneDigest = await sha256Hex(canonicalJson({
      laneKey: lane.laneKey,
      role: lane.role,
      taskId: lane.taskRow.id,
      agentId: lane.assigneeAgentId,
      runtimeSeatId: lane.runtimeSeatId,
      dependencyLaneKeys: lane.dependencyLaneKeys,
    }))
    domainMutations.push(prepareAuditedDomainMutation(env.DB, {
      sql: `INSERT INTO flight_lanes (
        id, tenant, flight_id, lane_key, role, task_id, assignment_epoch,
        agent_id, runtime_seat_id, done_when, dependency_lane_keys_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM flight_objectives
          WHERE tenant = ? AND flight_id = ? AND objective_id = ?
       )
         AND EXISTS (
           SELECT 1
             FROM agents agent
             JOIN memberships membership
               ON membership.agent_id = agent.id AND membership.squad_id = ?
            WHERE agent.id = ? AND agent.status = 'active'
              AND CASE membership.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
         AND (
           ? IS NULL
           OR EXISTS (
             SELECT 1 FROM runtime_seats seat
              WHERE seat.id = ? AND seat.tenant = ? AND seat.agent_id = ?
                AND seat.state = 'pending'
           )
         )
         AND (
           ? <> 'integrator'
           OR EXISTS (
             SELECT 1 FROM gate_grants grant_row
              WHERE grant_row.capability = ? AND grant_row.principal_type = 'agent'
                AND grant_row.principal_id = ?
           )
         )`,
      bindings: [
        lane.laneId,
        env.TENANT_SLUG,
        flightId,
        lane.laneKey,
        lane.role,
        lane.taskRow.id,
        1,
        lane.assigneeAgentId,
        lane.runtimeSeatId,
        lane.taskRow.done_when,
        canonicalJson(lane.dependencyLaneKeys),
        createdAt,
        env.TENANT_SLUG,
        flightId,
        objectiveId,
        objective.squadId,
        lane.assigneeAgentId,
        lane.runtimeSeatId,
        lane.runtimeSeatId,
        env.TENANT_SLUG,
        lane.assigneeAgentId,
        lane.role,
        integratorLane.taskRow.gate_owner,
        gateLane.assigneeAgentId,
      ],
      audit: flightSpineAudit(auth, principal, {
        expectedAuditId: `audit:${flightId}:lane:${lane.laneKey}`,
        handler: 'flight_spine.materialize_composition',
        operation: 'insert',
        targetKind: 'flight_lane',
        targetId: lane.laneId,
        afterDigest: laneDigest,
        objectiveId,
        flightId,
        taskId: lane.taskRow.id,
        requestId: `flight:${flightId}:lane:${lane.laneKey}`,
        evidence: { laneKey: lane.laneKey, assignmentEpoch: 1 },
      }),
    }))
    domainMutations.push(prepareAuditedDomainMutation(env.DB, {
      sql: `INSERT INTO flight_task_assignments (
        id, tenant, flight_id, lane_id, task_id, assignment_epoch, agent_id,
        runtime_seat_id, assigned_by_principal_kind, assigned_by_principal_id,
        assigned_by_member_id, assignment_receipt_id, assigned_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM tasks task
          WHERE task.id = ? AND task.assignment_epoch = 1
            AND task.assignee_agent_id = ?
       )
         AND EXISTS (
           SELECT 1 FROM flight_lanes lane
            WHERE lane.id = ? AND lane.tenant = ? AND lane.flight_id = ?
              AND lane.task_id = ? AND lane.assignment_epoch = 1
         )`,
      bindings: [
        lane.assignmentId,
        env.TENANT_SLUG,
        flightId,
        lane.laneId,
        lane.taskRow.id,
        1,
        lane.assigneeAgentId,
        lane.runtimeSeatId,
        principal.kind,
        principal.id,
        principal.memberId,
        assignmentReceipt.id,
        createdAt,
        lane.taskRow.id,
        lane.assigneeAgentId,
        lane.laneId,
        env.TENANT_SLUG,
        flightId,
        lane.taskRow.id,
      ],
      audit: flightSpineAudit(auth, principal, {
        expectedAuditId: `audit:${flightId}:assignment:${lane.laneKey}`,
        handler: 'flight_spine.materialize_composition',
        operation: 'insert',
        targetKind: 'flight_task_assignment',
        targetId: lane.assignmentId,
        afterDigest: assignmentReceipt.payloadDigest,
        objectiveId,
        flightId,
        taskId: lane.taskRow.id,
        requestId: `flight:${flightId}:assignment:${lane.laneKey}`,
        evidence: {
          laneKey: lane.laneKey,
          assignmentEpoch: 1,
          assignmentReceiptId: assignmentReceipt.id,
        } as JsonValue,
      }),
    }))
  }

  try {
    await executePreparedExecutionReceiptBatch(env, preparedReceipts, domainMutations)
  } catch (error) {
    mapAtomicFailure(error)
  }

  return {
    flightId,
    objectiveId,
    tasks: preparedLanes.map((lane) => lane.taskRow),
    lanes: preparedLanes.map((lane) => ({
      id: lane.laneId,
      tenant: env.TENANT_SLUG,
      flightId,
      laneKey: lane.laneKey,
      role: lane.role,
      taskId: lane.taskRow.id,
      assignmentEpoch: 1,
      agentId: lane.assigneeAgentId,
      runtimeSeatId: lane.runtimeSeatId,
      doneWhen: lane.taskRow.done_when,
      dependencyLaneKeys: [...lane.dependencyLaneKeys],
      createdAt,
    })),
    assignmentReceiptIds: assignmentReceipts.map((receipt) => receipt.id),
    materializedReceiptId: materializedReceipt.id,
  }
}
