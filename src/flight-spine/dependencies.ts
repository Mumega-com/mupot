import type { AuthContext, Env } from '../types'
import { assertWritten } from '../lib/receipt'
import {
  getObjective,
  requireFlightSpineSquadAuthority,
  resolveFlightSpinePrincipal,
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
  consumingTaskId?: string | null
  consumingAssignmentId?: string | null
  consumptionReceiptId: string
}

export interface ConsumedChildArtifact {
  id: string
  tenant: string
  flightDependencyId: string
  artifactId: string
  consumingFlightId: string
  consumingTaskId: string | null
  consumingAssignmentId: string | null
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
  | 'consumption_receipt_mismatch'

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
  consuming_task_id: string | null
  consuming_assignment_id: string | null
  consumption_receipt_id: string
  consumed_at: string
}

function boundedText(value: unknown, maximum = 255): string {
  if (typeof value !== 'string') throw new DependencyError('invalid_dependency')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new DependencyError('invalid_dependency')
  }
  return normalized
}

function optionalId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return boundedText(value)
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

export async function linkChildFlight(
  env: Env,
  auth: AuthContext,
  input: LinkChildFlightInput,
): Promise<FlightDependency> {
  if (typeof input !== 'object' || input === null) {
    throw new DependencyError('invalid_dependency')
  }
  const objectiveId = boundedText(input.objectiveId, 200)
  const parentFlightId = boundedText(input.parentFlightId)
  const childFlightId = boundedText(input.childFlightId)
  if (parentFlightId === childFlightId) throw new DependencyError('dependency_cycle')

  const objective = await getObjective(env, auth, objectiveId)
  if (!objective) throw new DependencyError('objective_not_found')
  const principal = await resolveFlightSpinePrincipal(env, auth)
  await requireFlightSpineSquadAuthority(env, auth, principal, objective.squadId, 'member')
  const existing = await dependencyByPair(env, parentFlightId, childFlightId)
  if (existing) {
    if (existing.objective_id !== objectiveId) throw new DependencyError('dependency_conflict')
    return mapDependency(existing)
  }

  const parentLink = await env.DB.prepare(`
    SELECT id FROM flight_objectives
     WHERE tenant = ?1 AND flight_id = ?2 AND objective_id = ?3
  `).bind(env.TENANT_SLUG, parentFlightId, objectiveId).first<{ id: string }>()
  if (!parentLink) throw new DependencyError('parent_flight_not_linked')
  const flights = await env.DB.prepare(`
    SELECT id, created_at FROM flights
     WHERE tenant = ?1 AND id IN (?2, ?3)
  `).bind(env.TENANT_SLUG, parentFlightId, childFlightId)
    .all<{ id: string; created_at: number }>()
  const byId = new Map((flights.results ?? []).map((flight) => [flight.id, flight]))
  if (!byId.has(parentFlightId) || !byId.has(childFlightId)) {
    throw new DependencyError('flight_not_found')
  }
  if (Number(byId.get(childFlightId)?.created_at) <= Date.parse(objective.acceptedAt)) {
    throw new DependencyError('child_predates_objective')
  }
  const cycle = await env.DB.prepare(`
    WITH RECURSIVE descendants(flight_id) AS (
      SELECT child_flight_id
        FROM flight_dependencies
       WHERE tenant = ?1 AND parent_flight_id = ?2
      UNION
      SELECT dependency.child_flight_id
        FROM flight_dependencies dependency
        JOIN descendants current
          ON dependency.parent_flight_id = current.flight_id
       WHERE dependency.tenant = ?1
    )
    SELECT 1 AS cycle FROM descendants WHERE flight_id = ?3 LIMIT 1
  `).bind(env.TENANT_SLUG, childFlightId, parentFlightId).first<{ cycle: number }>()
  if (cycle) throw new DependencyError('dependency_cycle')

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  let result
  try {
    result = await env.DB.prepare(`
      INSERT INTO flight_dependencies (
        id, tenant, objective_id, parent_flight_id, child_flight_id,
        created_by_principal_kind, created_by_principal_id,
        created_by_member_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      env.TENANT_SLUG,
      objectiveId,
      parentFlightId,
      childFlightId,
      principal.kind,
      principal.id,
      principal.memberId,
      createdAt,
    ).run()
  } catch (error) {
    const raced = await dependencyByPair(env, parentFlightId, childFlightId)
    if (raced && raced.objective_id === objectiveId) return mapDependency(raced)
    throw error
  }
  assertWritten(result, 'flight_dependencies.insert')
  return {
    id,
    tenant: env.TENANT_SLUG,
    objectiveId,
    parentFlightId,
    childFlightId,
    createdByPrincipalKind: principal.kind,
    createdByPrincipalId: principal.id,
    createdByMemberId: principal.memberId,
    createdAt,
  }
}

async function consumedByIdentity(
  env: Env,
  dependencyId: string,
  artifactId: string,
  consumingFlightId: string,
): Promise<ConsumedArtifactRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, flight_dependency_id, artifact_id, consuming_flight_id,
           consuming_task_id, consuming_assignment_id, consumption_receipt_id,
           consumed_at
      FROM flight_dependency_artifacts
     WHERE tenant = ?1 AND flight_dependency_id = ?2
       AND artifact_id = ?3 AND consuming_flight_id = ?4
  `).bind(env.TENANT_SLUG, dependencyId, artifactId, consumingFlightId)
    .first<ConsumedArtifactRow>()
}

export async function recordConsumedChildArtifact(
  env: Env,
  auth: AuthContext,
  input: RecordConsumedChildArtifactInput,
): Promise<ConsumedChildArtifact> {
  if (typeof input !== 'object' || input === null) {
    throw new DependencyError('invalid_dependency')
  }
  const dependencyId = boundedText(input.flightDependencyId)
  const artifactId = boundedText(input.artifactId)
  const consumingTaskId = optionalId(input.consumingTaskId)
  const consumingAssignmentId = optionalId(input.consumingAssignmentId)
  const consumptionReceiptId = boundedText(input.consumptionReceiptId)
  const dependency = await dependencyById(env, dependencyId)
  if (!dependency) throw new DependencyError('dependency_not_found')
  const objective = await getObjective(env, auth, dependency.objective_id)
  if (!objective) throw new DependencyError('objective_not_found')
  const principal = await resolveFlightSpinePrincipal(env, auth)
  await requireFlightSpineSquadAuthority(env, auth, principal, objective.squadId, 'member')

  const existing = await consumedByIdentity(
    env,
    dependencyId,
    artifactId,
    dependency.parent_flight_id,
  )
  if (existing) {
    if (
      existing.consuming_task_id !== consumingTaskId
      || existing.consuming_assignment_id !== consumingAssignmentId
      || existing.consumption_receipt_id !== consumptionReceiptId
    ) {
      throw new DependencyError('dependency_conflict')
    }
    return mapConsumed(existing)
  }

  const artifact = await env.DB.prepare(`
    SELECT id, flight_id FROM artifacts WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, artifactId).first<{ id: string; flight_id: string }>()
  if (!artifact) throw new DependencyError('artifact_not_found')
  if (artifact.flight_id !== dependency.child_flight_id) {
    throw new DependencyError('artifact_not_from_child')
  }

  let assignmentEpoch: number | null = null
  if (consumingAssignmentId !== null) {
    const assignment = await env.DB.prepare(`
      SELECT assignment.task_id, assignment.assignment_epoch,
             task.assignment_epoch AS current_assignment_epoch
        FROM flight_task_assignments assignment
        JOIN tasks task ON task.id = assignment.task_id
       WHERE assignment.tenant = ?1 AND assignment.id = ?2
         AND assignment.flight_id = ?3
    `).bind(env.TENANT_SLUG, consumingAssignmentId, dependency.parent_flight_id)
      .first<{
        task_id: string
        assignment_epoch: number
        current_assignment_epoch: number
      }>()
    if (
      !assignment
      || consumingTaskId === null
      || assignment.task_id !== consumingTaskId
      || Number(assignment.current_assignment_epoch) !== Number(assignment.assignment_epoch)
    ) {
      throw new DependencyError('consumer_scope_mismatch')
    }
    assignmentEpoch = Number(assignment.assignment_epoch)
  } else if (consumingTaskId !== null) {
    const assignment = await env.DB.prepare(`
      SELECT assignment.assignment_epoch,
             task.assignment_epoch AS current_assignment_epoch
        FROM flight_task_assignments assignment
        JOIN tasks task ON task.id = assignment.task_id
       WHERE assignment.tenant = ?1 AND assignment.flight_id = ?2
         AND assignment.task_id = ?3
       ORDER BY assignment.assignment_epoch DESC LIMIT 1
    `).bind(env.TENANT_SLUG, dependency.parent_flight_id, consumingTaskId)
      .first<{ assignment_epoch: number; current_assignment_epoch: number }>()
    if (
      !assignment
      || Number(assignment.current_assignment_epoch) !== Number(assignment.assignment_epoch)
    ) throw new DependencyError('consumer_scope_mismatch')
    assignmentEpoch = Number(assignment.assignment_epoch)
  }

  const receipt = await env.DB.prepare(`
    SELECT flight_id, task_id, assignment_epoch, claims_json
      FROM execution_receipts WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, consumptionReceiptId)
    .first<{
      flight_id: string | null
      task_id: string | null
      assignment_epoch: number | null
      claims_json: string
    }>()
  let receiptClaims: Record<string, unknown> | null = null
  try {
    const parsed = receipt ? JSON.parse(receipt.claims_json) as unknown : null
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      receiptClaims = parsed as Record<string, unknown>
    }
  } catch {
    receiptClaims = null
  }
  if (
    !receipt
    || receipt.flight_id !== dependency.parent_flight_id
    || receipt.task_id !== consumingTaskId
    || (receipt.assignment_epoch === null ? null : Number(receipt.assignment_epoch)) !== assignmentEpoch
    || receiptClaims?.childArtifactId !== artifactId
    || receiptClaims?.dependencyId !== dependencyId
  ) {
    throw new DependencyError('consumption_receipt_mismatch')
  }

  const id = crypto.randomUUID()
  const consumedAt = new Date().toISOString()
  let result
  try {
    result = await env.DB.prepare(`
      INSERT INTO flight_dependency_artifacts (
        id, tenant, flight_dependency_id, artifact_id, consuming_flight_id,
        consuming_task_id, consuming_assignment_id, consumption_receipt_id,
        consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      env.TENANT_SLUG,
      dependencyId,
      artifactId,
      dependency.parent_flight_id,
      consumingTaskId,
      consumingAssignmentId,
      consumptionReceiptId,
      consumedAt,
    ).run()
  } catch (error) {
    const raced = await consumedByIdentity(
      env,
      dependencyId,
      artifactId,
      dependency.parent_flight_id,
    )
    if (
      raced
      && raced.consuming_task_id === consumingTaskId
      && raced.consuming_assignment_id === consumingAssignmentId
      && raced.consumption_receipt_id === consumptionReceiptId
    ) {
      return mapConsumed(raced)
    }
    throw error
  }
  assertWritten(result, 'flight_dependency_artifacts.insert')
  return {
    id,
    tenant: env.TENANT_SLUG,
    flightDependencyId: dependencyId,
    artifactId,
    consumingFlightId: dependency.parent_flight_id,
    consumingTaskId,
    consumingAssignmentId,
    consumptionReceiptId,
    consumedAt,
  }
}
