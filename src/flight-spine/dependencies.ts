// src/flight-spine/dependencies.ts — Flight Spine flight dependency DAG, parent-child linking, and consumed child artifacts.

import type { AuthContext, Env } from '../types'
import { appendExecutionReceipt } from './receipts'

export interface LinkChildFlightInput {
  objectiveId: string
  parentFlightId: string
  childFlightId: string
}

export interface LinkChildFlightResult {
  id: string
  tenant: string
  objectiveId: string
  parentFlightId: string
  childFlightId: string
  linkedAt: string
}

export interface RecordConsumedChildArtifactInput {
  parentFlightId: string
  childFlightId: string
  artifactId: string
  consumingTaskId?: string | null
  consumingAssignmentId?: string | null
}

export interface RecordConsumedChildArtifactResult {
  id: string
  tenant: string
  flightDependencyId: string
  artifactId: string
  consumingFlightId: string
  consumptionReceiptId: string
  consumedAt: string
}

export async function linkChildFlight(
  env: Env,
  auth: AuthContext,
  input: LinkChildFlightInput,
): Promise<LinkChildFlightResult> {
  const tenant = env.TENANT_SLUG
  if (!tenant) throw new Error('missing_tenant')

  if (!auth || !auth.memberId) {
    throw new Error('unauthorized: member identity required')
  }

  const objectiveId = input.objectiveId?.trim()
  const parentFlightId = input.parentFlightId?.trim()
  const childFlightId = input.childFlightId?.trim()

  if (!objectiveId) throw new Error('invalid_input: objectiveId required')
  if (!parentFlightId) throw new Error('invalid_input: parentFlightId required')
  if (!childFlightId) throw new Error('invalid_input: childFlightId required')

  if (parentFlightId === childFlightId) {
    throw new Error('invalid_input: parent_flight_id cannot equal child_flight_id')
  }

  // 1. Verify parent flight exists
  const parentFlight = await env.DB.prepare('SELECT id FROM flights WHERE id = ?1').bind(parentFlightId).first()
  if (!parentFlight) throw new Error('parent_flight_not_found')

  // 2. Verify child flight exists
  const childFlight = await env.DB.prepare('SELECT id, created_at FROM flights WHERE id = ?1').bind(childFlightId).first<{ id: string; created_at: string }>()
  if (!childFlight) throw new Error('child_flight_not_found')

  // 3. Verify objective exists and check temporal ordering (child flight created after parent objective accepted)
  const objective = await env.DB.prepare(`
    SELECT id, accepted_at FROM objectives WHERE tenant = ?1 AND id = ?2
  `).bind(tenant, objectiveId).first<{ id: string; accepted_at: string }>()
  if (!objective) throw new Error('objective_not_found')

  // Check temporal sequence if childFlight has created_at
  if (childFlight.created_at && objective.accepted_at) {
    const childCreated = new Date(childFlight.created_at).getTime()
    const parentAccepted = new Date(objective.accepted_at).getTime()
    if (!Number.isNaN(childCreated) && !Number.isNaN(parentAccepted) && childCreated < parentAccepted) {
      throw new Error('invalid_temporal_order: child flight cannot be created prior to parent objective acceptance')
    }
  }

  // 4. Check for duplicate dependency
  const existing = await env.DB.prepare(`
    SELECT id FROM flight_dependencies
     WHERE tenant = ?1 AND parent_flight_id = ?2 AND child_flight_id = ?3
  `).bind(tenant, parentFlightId, childFlightId).first<{ id: string }>()
  if (existing) {
    throw new Error('duplicate_dependency: parent-child link already exists')
  }

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const createdByPrincipalKind = auth.boundAgentId ? 'agent' : 'member'
  const createdByPrincipalId = auth.boundAgentId ?? auth.memberId
  const createdByMemberId = auth.memberId

  await env.DB.prepare(`
    INSERT INTO flight_dependencies (
      id, tenant, objective_id, parent_flight_id, child_flight_id,
      created_by_principal_kind, created_by_principal_id, created_by_member_id,
      created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  `).bind(
    id,
    tenant,
    objectiveId,
    parentFlightId,
    childFlightId,
    createdByPrincipalKind,
    createdByPrincipalId,
    createdByMemberId,
    now,
  ).run()

  return {
    id,
    tenant,
    objectiveId,
    parentFlightId,
    childFlightId,
    linkedAt: now,
  }
}

export async function recordConsumedChildArtifact(
  env: Env,
  auth: AuthContext,
  input: RecordConsumedChildArtifactInput,
): Promise<RecordConsumedChildArtifactResult> {
  const tenant = env.TENANT_SLUG
  if (!tenant) throw new Error('missing_tenant')

  if (!auth || !auth.memberId) {
    throw new Error('unauthorized: member identity required')
  }

  const parentFlightId = input.parentFlightId?.trim()
  const childFlightId = input.childFlightId?.trim()
  const artifactId = input.artifactId?.trim()

  if (!parentFlightId) throw new Error('invalid_input: parentFlightId required')
  if (!childFlightId) throw new Error('invalid_input: childFlightId required')
  if (!artifactId) throw new Error('invalid_input: artifactId required')

  // Verify dependency exists
  const dep = await env.DB.prepare(`
    SELECT id FROM flight_dependencies
     WHERE tenant = ?1 AND parent_flight_id = ?2 AND child_flight_id = ?3
  `).bind(tenant, parentFlightId, childFlightId).first<{ id: string }>()

  if (!dep) {
    throw new Error('dependency_not_found: no parent-child flight dependency found')
  }

  // Verify artifact exists
  const artifact = await env.DB.prepare(`
    SELECT id, digest, flight_id FROM artifacts WHERE tenant = ?1 AND id = ?2
  `).bind(tenant, artifactId).first<{ id: string; digest: string; flight_id: string }>()

  if (!artifact) {
    throw new Error('artifact_not_found')
  }

  const now = new Date().toISOString()
  const consumptionReceipt = await appendExecutionReceipt(env, auth, {
    type: 'effect.intent',
    flightId: parentFlightId,
    taskId: input.consumingTaskId ?? null,
    idempotencyKey: `consume:artifact:${artifactId}:by:flight:${parentFlightId}`,
    claims: {
      artifactId,
      parentFlightId,
      childFlightId,
      digest: artifact.digest,
      consumingTaskId: input.consumingTaskId ?? null,
      consumingAssignmentId: input.consumingAssignmentId ?? null,
    },
  })

  const consumptionId = crypto.randomUUID()
  await env.DB.prepare(`
    INSERT INTO flight_dependency_artifacts (
      id, tenant, flight_dependency_id, artifact_id, consuming_flight_id,
      consuming_task_id, consuming_assignment_id, consumption_receipt_id, consumed_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  `).bind(
    consumptionId,
    tenant,
    dep.id,
    artifactId,
    parentFlightId,
    input.consumingTaskId ?? null,
    input.consumingAssignmentId ?? null,
    consumptionReceipt.id,
    now,
  ).run()

  return {
    id: consumptionId,
    tenant,
    flightDependencyId: dep.id,
    artifactId,
    consumingFlightId: parentFlightId,
    consumptionReceiptId: consumptionReceipt.id,
    consumedAt: now,
  }
}
