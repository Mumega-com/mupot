import type { AuthContext, Env } from '../types'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import {
  executePreparedExecutionReceiptBatch,
  prepareAuditedDomainMutation,
  prepareFreshExecutionReceiptChain,
} from './receipts'
import {
  flightSpineAudit,
  getObjective,
  requireFlightSpineSquadAuthority,
  resolveFlightSpinePrincipal,
  type FlightSpinePrincipal,
} from './objectives'

export interface LinkChildFlightInput {
  objectiveId: string
  parentFlightId: string
  childFlightId: string
}

export interface FlightDependency {
  id: string
  tenant: string
  objectiveId: string
  parentFlightId: string
  childFlightId: string
  createdByPrincipalKind: 'member' | 'agent'
  createdByPrincipalId: string
  createdByMemberId: string
  createdAt: string
}

export interface RecordConsumedChildArtifactInput {
  flightDependencyId: string
  artifactId: string
  consumingTaskId: string
  consumingAssignmentId: string
}

export interface ConsumedChildArtifact {
  id: string
  tenant: string
  flightDependencyId: string
  artifactId: string
  consumingFlightId: string
  consumingTaskId: string
  consumingAssignmentId: string
  consumptionReceiptId: string
  consumedAt: string
}

export type DependencyErrorCode =
  | 'invalid_dependency'
  | 'objective_not_found'
  | 'parent_flight_not_linked'
  | 'flight_not_found'
  | 'child_predates_objective'
  | 'dependency_cycle'
  | 'dependency_conflict'
  | 'dependency_not_found'
  | 'artifact_not_found'
  | 'artifact_not_from_child'
  | 'consumer_scope_mismatch'
  | 'consumption_conflict'

export class DependencyError extends Error {
  readonly name = 'DependencyError'

  constructor(readonly code: DependencyErrorCode) {
    super(code)
  }
}

interface FlightDependencyRow {
  id: string
  tenant: string
  objective_id: string
  parent_flight_id: string
  child_flight_id: string
  created_by_principal_kind: 'member' | 'agent'
  created_by_principal_id: string
  created_by_member_id: string | null
  created_at: string
}

interface ConsumedArtifactRow {
  id: string
  tenant: string
  flight_dependency_id: string
  artifact_id: string
  consuming_flight_id: string
  consuming_task_id: string
  consuming_assignment_id: string
  consumption_receipt_id: string
  consumed_at: string
}

interface ConsumptionContext {
  objectiveId: string
  parentFlightId: string
  childFlightId: string
  assignmentEpoch: number
  seatId: string
  seatGeneration: number
}

function boundedText(value: unknown, maximum = 255): string {
  if (typeof value !== 'string') throw new DependencyError('invalid_dependency')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new DependencyError('invalid_dependency')
  }
  return normalized
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new DependencyError('invalid_dependency')
  }
}

function mapDependency(row: FlightDependencyRow): FlightDependency {
  return {
    id: row.id,
    tenant: row.tenant,
    objectiveId: row.objective_id,
    parentFlightId: row.parent_flight_id,
    childFlightId: row.child_flight_id,
    createdByPrincipalKind: row.created_by_principal_kind,
    createdByPrincipalId: row.created_by_principal_id,
    createdByMemberId: row.created_by_member_id ?? '',
    createdAt: row.created_at,
  }
}

function mapConsumed(row: ConsumedArtifactRow): ConsumedChildArtifact {
  return {
    id: row.id,
    tenant: row.tenant,
    flightDependencyId: row.flight_dependency_id,
    artifactId: row.artifact_id,
    consumingFlightId: row.consuming_flight_id,
    consumingTaskId: row.consuming_task_id,
    consumingAssignmentId: row.consuming_assignment_id,
    consumptionReceiptId: row.consumption_receipt_id,
    consumedAt: row.consumed_at,
  }
}

async function dependencyByPair(
  env: Env,
  parentFlightId: string,
  childFlightId: string,
): Promise<FlightDependencyRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, objective_id, parent_flight_id, child_flight_id,
           created_by_principal_kind, created_by_principal_id,
           created_by_member_id, created_at
      FROM flight_dependencies
     WHERE tenant = ?1 AND parent_flight_id = ?2 AND child_flight_id = ?3
  `).bind(env.TENANT_SLUG, parentFlightId, childFlightId).first<FlightDependencyRow>()
}

async function dependencyById(env: Env, id: string): Promise<FlightDependencyRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, objective_id, parent_flight_id, child_flight_id,
           created_by_principal_kind, created_by_principal_id,
           created_by_member_id, created_at
      FROM flight_dependencies WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, id).first<FlightDependencyRow>()
}

async function pathExists(env: Env, fromFlightId: string, toFlightId: string): Promise<boolean> {
  return (await env.DB.prepare(`
    WITH RECURSIVE descendants(flight_id) AS (
      SELECT child_flight_id FROM flight_dependencies
       WHERE tenant = ?1 AND parent_flight_id = ?2
      UNION
      SELECT dependency.child_flight_id
        FROM flight_dependencies dependency
        JOIN descendants current ON dependency.parent_flight_id = current.flight_id
       WHERE dependency.tenant = ?1
    )
    SELECT 1 AS found FROM descendants WHERE flight_id = ?3 LIMIT 1
  `).bind(env.TENANT_SLUG, fromFlightId, toFlightId).first<{ found: number }>()) !== null
}

async function linkReceiptExists(
  env: Env,
  key: string,
  dependency: FlightDependencyRow,
): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT type, objective_id, flight_id, claims_json
      FROM execution_receipts
     WHERE tenant = ?1 AND issuer_kind = 'mupot' AND issuer_id = ?2
       AND idempotency_key = ?3
  `).bind(env.TENANT_SLUG, `mupot:${env.TENANT_SLUG}`, key).first<{
    type: string
    objective_id: string | null
    flight_id: string | null
    claims_json: string
  }>()
  return row?.type === 'flight.dependency_linked'
    && row.objective_id === dependency.objective_id
    && row.flight_id === dependency.parent_flight_id
    && row.claims_json === canonicalJson({
      dependencyId: dependency.id,
      parentFlightId: dependency.parent_flight_id,
      childFlightId: dependency.child_flight_id,
    })
}

export async function linkChildFlight(
  env: Env,
  auth: AuthContext,
  input: LinkChildFlightInput,
): Promise<FlightDependency> {
  if (typeof input !== 'object' || input === null) throw new DependencyError('invalid_dependency')
  assertExactKeys(input, ['objectiveId', 'parentFlightId', 'childFlightId'])
  const objectiveId = boundedText(input.objectiveId, 200)
  const parentFlightId = boundedText(input.parentFlightId)
  const childFlightId = boundedText(input.childFlightId)
  if (parentFlightId === childFlightId) throw new DependencyError('dependency_cycle')

  const objective = await getObjective(env, auth, objectiveId)
  if (!objective) throw new DependencyError('objective_not_found')
  const principal = await resolveFlightSpinePrincipal(env, auth)
  await requireFlightSpineSquadAuthority(env, auth, principal, objective.squadId, 'member')
  const keyDigest = await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG, objectiveId, parentFlightId, childFlightId,
  }))
  const receiptKey = `flight-dependency:${keyDigest}`
  const existing = await dependencyByPair(env, parentFlightId, childFlightId)
  if (existing) {
    if (existing.objective_id !== objectiveId || !(await linkReceiptExists(env, receiptKey, existing))) {
      throw new DependencyError('dependency_conflict')
    }
    return mapDependency(existing)
  }

  const parentLink = await env.DB.prepare(`
    SELECT id FROM flight_objectives
     WHERE tenant = ?1 AND flight_id = ?2 AND objective_id = ?3
  `).bind(env.TENANT_SLUG, parentFlightId, objectiveId).first<{ id: string }>()
  if (!parentLink) throw new DependencyError('parent_flight_not_linked')
  const flights = await env.DB.prepare(`
    SELECT id, created_at FROM flights WHERE tenant = ?1 AND id IN (?2, ?3)
  `).bind(env.TENANT_SLUG, parentFlightId, childFlightId).all<{ id: string; created_at: number }>()
  const byId = new Map((flights.results ?? []).map((flight) => [flight.id, flight]))
  if (!byId.has(parentFlightId) || !byId.has(childFlightId)) throw new DependencyError('flight_not_found')
  if (Number(byId.get(childFlightId)?.created_at) <= Date.parse(objective.acceptedAt)) {
    throw new DependencyError('child_predates_objective')
  }
  if (await pathExists(env, childFlightId, parentFlightId)) throw new DependencyError('dependency_cycle')

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const prepared = await prepareFreshExecutionReceiptChain(env, auth, [{
    type: 'flight.dependency_linked',
    idempotencyKey: receiptKey,
    objectiveId,
    flightId: parentFlightId,
    claims: { dependencyId: id, parentFlightId, childFlightId },
  }])
  const receipt = prepared.expectedReceipts[0]
  const mutation = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO flight_dependencies (
      id, tenant, objective_id, parent_flight_id, child_flight_id,
      created_by_principal_kind, created_by_principal_id, created_by_member_id, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1
         FROM objectives objective
         JOIN flight_objectives parent_link
           ON parent_link.tenant = objective.tenant
          AND parent_link.objective_id = objective.id AND parent_link.flight_id = ?
         JOIN flights parent ON parent.id = parent_link.flight_id AND parent.tenant = objective.tenant
         JOIN flights child ON child.id = ? AND child.tenant = objective.tenant
        WHERE objective.id = ? AND objective.tenant = ? AND objective.squad_id = ?
          AND objective.accepted_at = ? AND child.created_at > ?
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
           SELECT 1 FROM capabilities capability JOIN squads squad ON squad.id = ?
            WHERE capability.member_id = ?
              AND (capability.scope_type = 'org'
                OR (capability.scope_type = 'department' AND capability.scope_id = squad.department_id)
                OR (capability.scope_type = 'squad' AND capability.scope_id = squad.id))
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
           SELECT 1 FROM agents agent
             JOIN agent_member_bindings binding
               ON binding.agent_id = agent.id AND binding.tenant = ? AND binding.member_id = ?
             JOIN memberships membership
               ON membership.agent_id = agent.id AND membership.squad_id = ?
            WHERE agent.id = ? AND agent.status = 'active'
              AND CASE membership.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
       )
       AND NOT EXISTS (
         WITH RECURSIVE descendants(flight_id) AS (
           SELECT child_flight_id FROM flight_dependencies
            WHERE tenant = ? AND parent_flight_id = ?
           UNION
           SELECT dependency.child_flight_id FROM flight_dependencies dependency
             JOIN descendants current ON dependency.parent_flight_id = current.flight_id
            WHERE dependency.tenant = ?
         )
         SELECT 1 FROM descendants WHERE flight_id = ?
       )`,
    bindings: [
      id, env.TENANT_SLUG, objectiveId, parentFlightId, childFlightId,
      principal.kind, principal.id, principal.memberId, createdAt,
      parentFlightId, childFlightId, objectiveId, env.TENANT_SLUG,
      objective.squadId, objective.acceptedAt, Date.parse(objective.acceptedAt),
      principal.memberId, env.TENANT_SLUG,
      principal.authorityMemberId, env.TENANT_SLUG,
      auth.capabilities === undefined && (auth.role === 'owner' || auth.role === 'admin') ? 1 : 0,
      objective.squadId, principal.authorityMemberId,
      principal.authorityMemberId, objective.squadId,
      principal.agentId, env.TENANT_SLUG, principal.memberId, objective.squadId, principal.agentId,
      env.TENANT_SLUG, childFlightId, env.TENANT_SLUG, parentFlightId,
    ],
    audit: flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:dependency:${id}`,
      handler: 'flight_spine.link_child_flight',
      operation: 'insert',
      targetKind: 'flight_dependency',
      targetId: id,
      afterDigest: await sha256Hex(canonicalJson({ id, objectiveId, parentFlightId, childFlightId })),
      objectiveId,
      flightId: parentFlightId,
      requestId: receiptKey,
      idempotencyKey: receiptKey,
      evidence: { dependencyReceiptId: receipt.id, childFlightId },
    }),
  })
  try {
    await executePreparedExecutionReceiptBatch(env, prepared, [mutation])
  } catch (error) {
    const raced = await dependencyByPair(env, parentFlightId, childFlightId)
    if (raced && raced.objective_id === objectiveId && await linkReceiptExists(env, receiptKey, raced)) {
      return mapDependency(raced)
    }
    if (await pathExists(env, childFlightId, parentFlightId)) throw new DependencyError('dependency_cycle')
    void error
    throw new DependencyError('dependency_conflict')
  }
  const persisted = await dependencyByPair(env, parentFlightId, childFlightId)
  if (!persisted || persisted.id !== id) throw new DependencyError('dependency_conflict')
  return mapDependency(persisted)
}

async function consumedByIdentity(
  env: Env,
  dependencyId: string,
  artifactId: string,
  consumingFlightId: string,
): Promise<ConsumedArtifactRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, flight_dependency_id, artifact_id, consuming_flight_id,
           consuming_task_id, consuming_assignment_id, consumption_receipt_id, consumed_at
      FROM flight_dependency_artifacts
     WHERE tenant = ?1 AND flight_dependency_id = ?2
       AND artifact_id = ?3 AND consuming_flight_id = ?4
  `).bind(env.TENANT_SLUG, dependencyId, artifactId, consumingFlightId).first<ConsumedArtifactRow>()
}

async function loadConsumptionContext(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  dependency: FlightDependencyRow,
  artifactId: string,
  consumingTaskId: string,
  consumingAssignmentId: string,
): Promise<ConsumptionContext> {
  const objective = await getObjective(env, auth, dependency.objective_id)
  if (!objective) throw new DependencyError('objective_not_found')
  await requireFlightSpineSquadAuthority(env, auth, principal, objective.squadId, 'member')
  const artifact = await env.DB.prepare(`
    SELECT id, flight_id FROM artifacts WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, artifactId).first<{ id: string; flight_id: string }>()
  if (!artifact) throw new DependencyError('artifact_not_found')
  if (artifact.flight_id !== dependency.child_flight_id) throw new DependencyError('artifact_not_from_child')
  if (principal.agentId === null) throw new DependencyError('consumer_scope_mismatch')
  const assignment = await env.DB.prepare(`
    SELECT assignment.assignment_epoch, assignment.agent_id, assignment.runtime_seat_id,
           task.assignment_epoch AS current_assignment_epoch, task.assignee_agent_id,
           seat.current_generation, seat.state
      FROM flight_task_assignments assignment
      JOIN tasks task ON task.id = assignment.task_id
      JOIN runtime_seats seat
        ON seat.id = assignment.runtime_seat_id AND seat.tenant = assignment.tenant
       AND seat.agent_id = assignment.agent_id
      JOIN runtime_seat_generations generation
        ON generation.tenant = seat.tenant AND generation.runtime_seat_id = seat.id
       AND generation.generation = seat.current_generation
     WHERE assignment.tenant = ?1 AND assignment.id = ?2
       AND assignment.flight_id = ?3 AND assignment.task_id = ?4
  `).bind(env.TENANT_SLUG, consumingAssignmentId, dependency.parent_flight_id, consumingTaskId)
    .first<{
      assignment_epoch: number
      agent_id: string
      runtime_seat_id: string | null
      current_assignment_epoch: number
      assignee_agent_id: string | null
      current_generation: number
      state: string
    }>()
  if (!assignment
    || assignment.agent_id !== principal.agentId
    || assignment.assignee_agent_id !== principal.agentId
    || assignment.runtime_seat_id === null
    || assignment.state !== 'active'
    || Number(assignment.current_generation) <= 0
    || Number(assignment.assignment_epoch) !== Number(assignment.current_assignment_epoch)
  ) throw new DependencyError('consumer_scope_mismatch')
  return {
    objectiveId: dependency.objective_id,
    parentFlightId: dependency.parent_flight_id,
    childFlightId: dependency.child_flight_id,
    assignmentEpoch: Number(assignment.assignment_epoch),
    seatId: assignment.runtime_seat_id,
    seatGeneration: Number(assignment.current_generation),
  }
}

async function verifyConsumedReplay(
  env: Env,
  principal: FlightSpinePrincipal,
  row: ConsumedArtifactRow,
  context: ConsumptionContext,
  requestedTaskId: string,
  requestedAssignmentId: string,
): Promise<void> {
  const receipt = await env.DB.prepare(`
    SELECT type, actor_kind, actor_id, seat_id, seat_generation, objective_id,
           flight_id, task_id, assignment_epoch, claims_json
      FROM execution_receipts WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, row.consumption_receipt_id).first<{
    type: string
    actor_kind: string
    actor_id: string
    seat_id: string | null
    seat_generation: number | null
    objective_id: string | null
    flight_id: string | null
    task_id: string | null
    assignment_epoch: number | null
    claims_json: string
  }>()
  if (!receipt
    || row.consuming_task_id !== requestedTaskId
    || row.consuming_assignment_id !== requestedAssignmentId
    || receipt.type !== 'artifact.consumed'
    || receipt.actor_kind !== 'agent'
    || receipt.actor_id !== principal.agentId
    || receipt.seat_id !== context.seatId
    || Number(receipt.seat_generation) !== context.seatGeneration
    || receipt.objective_id !== context.objectiveId
    || receipt.flight_id !== context.parentFlightId
    || receipt.task_id !== requestedTaskId
    || Number(receipt.assignment_epoch) !== context.assignmentEpoch
    || receipt.claims_json !== canonicalJson({
      dependencyId: row.flight_dependency_id,
      childArtifactId: row.artifact_id,
    })
  ) throw new DependencyError('consumption_conflict')
}

export async function recordConsumedChildArtifact(
  env: Env,
  auth: AuthContext,
  input: RecordConsumedChildArtifactInput,
): Promise<ConsumedChildArtifact> {
  if (typeof input !== 'object' || input === null) throw new DependencyError('invalid_dependency')
  assertExactKeys(input, [
    'flightDependencyId', 'artifactId', 'consumingTaskId', 'consumingAssignmentId',
  ])
  const dependencyId = boundedText(input.flightDependencyId)
  const artifactId = boundedText(input.artifactId)
  const consumingTaskId = boundedText(input.consumingTaskId)
  const consumingAssignmentId = boundedText(input.consumingAssignmentId)
  const dependency = await dependencyById(env, dependencyId)
  if (!dependency) throw new DependencyError('dependency_not_found')
  const principal = await resolveFlightSpinePrincipal(env, auth)
  const context = await loadConsumptionContext(
    env, auth, principal, dependency, artifactId, consumingTaskId, consumingAssignmentId,
  )
  const existing = await consumedByIdentity(env, dependencyId, artifactId, dependency.parent_flight_id)
  if (existing) {
    if (existing.consuming_task_id !== consumingTaskId
      || existing.consuming_assignment_id !== consumingAssignmentId
    ) throw new DependencyError('dependency_conflict')
    await verifyConsumedReplay(
      env, principal, existing, context, consumingTaskId, consumingAssignmentId,
    )
    return mapConsumed(existing)
  }

  const keyDigest = await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    dependencyId,
    artifactId,
    consumingTaskId,
    consumingAssignmentId,
    assignmentEpoch: context.assignmentEpoch,
  }))
  const receiptKey = `artifact-consumed:${keyDigest}`
  const prepared = await prepareFreshExecutionReceiptChain(env, auth, [{
    type: 'artifact.consumed',
    idempotencyKey: receiptKey,
    objectiveId: context.objectiveId,
    flightId: context.parentFlightId,
    taskId: consumingTaskId,
    assignmentEpoch: context.assignmentEpoch,
    seatId: context.seatId,
    seatGeneration: context.seatGeneration,
    claims: { dependencyId, childArtifactId: artifactId },
  }])
  const receipt = prepared.expectedReceipts[0]
  const id = crypto.randomUUID()
  const consumedAt = new Date().toISOString()
  const mutation = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO flight_dependency_artifacts (
      id, tenant, flight_dependency_id, artifact_id, consuming_flight_id,
      consuming_task_id, consuming_assignment_id, consumption_receipt_id, consumed_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1
         FROM flight_dependencies dependency
         JOIN objectives objective
           ON objective.id = dependency.objective_id AND objective.tenant = dependency.tenant
         JOIN artifacts artifact
           ON artifact.id = ? AND artifact.tenant = dependency.tenant
          AND artifact.flight_id = dependency.child_flight_id
         JOIN flight_task_assignments assignment
           ON assignment.id = ? AND assignment.tenant = dependency.tenant
          AND assignment.flight_id = dependency.parent_flight_id
          AND assignment.task_id = ? AND assignment.agent_id = ?
         JOIN tasks task
           ON task.id = assignment.task_id
          AND task.assignment_epoch = assignment.assignment_epoch
          AND task.assignee_agent_id = assignment.agent_id
         JOIN runtime_seats seat
           ON seat.id = assignment.runtime_seat_id AND seat.tenant = dependency.tenant
          AND seat.agent_id = assignment.agent_id AND seat.state = 'active'
          AND seat.current_generation = ?
         JOIN runtime_seat_generations generation
           ON generation.tenant = seat.tenant AND generation.runtime_seat_id = seat.id
          AND generation.generation = seat.current_generation
         JOIN agents agent ON agent.id = assignment.agent_id AND agent.status = 'active'
         JOIN memberships membership
           ON membership.agent_id = agent.id AND membership.squad_id = objective.squad_id
         JOIN agent_member_bindings binding
           ON binding.tenant = dependency.tenant AND binding.agent_id = agent.id
          AND binding.member_id = ?
         JOIN members member
           ON member.id = binding.member_id AND member.tenant = dependency.tenant
          AND member.status = 'active'
        WHERE dependency.id = ? AND dependency.tenant = ? AND objective.id = ?
          AND assignment.assignment_epoch = ? AND seat.id = ?
          AND CASE membership.capability
            WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
            WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
     )
       AND EXISTS (
         SELECT 1 FROM members authority_member
          WHERE authority_member.id = ? AND authority_member.tenant = ?
            AND authority_member.status = 'active'
       )
       AND (
         ? = 1
         OR EXISTS (
           SELECT 1 FROM capabilities capability
             JOIN objectives objective ON objective.id = ? AND objective.tenant = ?
             JOIN squads squad ON squad.id = objective.squad_id
            WHERE capability.member_id = ?
              AND (capability.scope_type = 'org'
                OR (capability.scope_type = 'department' AND capability.scope_id = squad.department_id)
                OR (capability.scope_type = 'squad' AND capability.scope_id = squad.id))
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
         OR EXISTS (
           SELECT 1 FROM channel_capability_grants capability
             JOIN objectives objective ON objective.id = ? AND objective.tenant = ?
            WHERE capability.member_id = ? AND capability.squad_id = objective.squad_id
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
       )`,
    bindings: [
      id, env.TENANT_SLUG, dependencyId, artifactId, context.parentFlightId,
      consumingTaskId, consumingAssignmentId, receipt.id, consumedAt,
      artifactId, consumingAssignmentId, consumingTaskId, principal.agentId,
      context.seatGeneration, principal.memberId, dependencyId, env.TENANT_SLUG,
      context.objectiveId, context.assignmentEpoch, context.seatId,
      principal.authorityMemberId, env.TENANT_SLUG,
      auth.capabilities === undefined && (auth.role === 'owner' || auth.role === 'admin') ? 1 : 0,
      context.objectiveId, env.TENANT_SLUG, principal.authorityMemberId,
      context.objectiveId, env.TENANT_SLUG, principal.authorityMemberId,
    ],
    audit: flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:artifact-consumed:${id}`,
      handler: 'flight_spine.record_consumed_child_artifact',
      operation: 'insert',
      targetKind: 'flight_dependency_artifact',
      targetId: id,
      afterDigest: await sha256Hex(canonicalJson({
        id, dependencyId, artifactId, consumingTaskId, consumingAssignmentId,
        receiptId: receipt.id,
      })),
      objectiveId: context.objectiveId,
      flightId: context.parentFlightId,
      taskId: consumingTaskId,
      requestId: receiptKey,
      idempotencyKey: receiptKey,
      runtimeSeatId: context.seatId,
      runtimeGeneration: context.seatGeneration,
      evidence: { artifactConsumedReceiptId: receipt.id, dependencyId, artifactId },
    }),
  })
  try {
    await executePreparedExecutionReceiptBatch(env, prepared, [mutation])
  } catch (error) {
    const raced = await consumedByIdentity(env, dependencyId, artifactId, dependency.parent_flight_id)
    const current = await loadConsumptionContext(
      env, auth, principal, dependency, artifactId, consumingTaskId, consumingAssignmentId,
    )
    if (raced) {
      await verifyConsumedReplay(
        env, principal, raced, current, consumingTaskId, consumingAssignmentId,
      )
      return mapConsumed(raced)
    }
    void error
    throw new DependencyError('consumption_conflict')
  }
  const persisted = await consumedByIdentity(env, dependencyId, artifactId, dependency.parent_flight_id)
  if (!persisted || persisted.id !== id) throw new DependencyError('consumption_conflict')
  await verifyConsumedReplay(
    env, principal, persisted, context, consumingTaskId, consumingAssignmentId,
  )
  return mapConsumed(persisted)
}
