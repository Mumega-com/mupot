// Bounded Flight 2 control-plane surface. This module intentionally exposes only
// objective acceptance/readback, visible receipt readback, current-token
// attestation, and pending command-seat registration. Lease/process activation,
// host control, artifacts, results, gates, decisions, landing, and controller
// behavior remain outside this MCP surface.

import { resolveCapabilities } from '../auth/capability'
import {
  issueTokenBindingAttestation,
  AttestationError,
} from '../flight-spine/attestations'
import {
  acceptObjective,
  getObjective,
  ObjectiveError,
  type AcceptedObjective,
} from '../flight-spine/objectives'
import {
  getExecutionReceipt,
  verifyExecutionReceipt,
} from '../flight-spine/receipts'
import {
  registerPendingRuntimeSeat,
  RuntimeSeatError,
} from '../flight-spine/seats'
import type { ExecutionReceipt } from '../flight-spine/types'
import { getFlight } from '../flight/service'
import { loadFlightSquads, parseFlightMetaV1, type FlightMetaV1 } from '../flight/meta'
import type { MemberTokenFingerprintEnv } from '../members/service'
import type { AuthContext, Capability, Env } from '../types'
import { readAccess, readableProject } from './projects'
import {
  type ToolOutcome,
  type ToolSpec,
  done,
  fail,
  getAgent,
  hasWorkspaceAdmin,
  memberCanOnSquad,
  str,
} from './index'

const STRING_SCHEMA = { type: 'string' }
const NULLABLE_STRING_SCHEMA = { type: ['string', 'null'] }
const OBJECT_SCHEMA = { type: 'object' }
const NUMBER_SCHEMA = { type: 'number' }

const PUBLIC_RECEIPT_TYPES = new Set<ExecutionReceipt['type']>([
  'objective.authorized',
  'objective.accepted',
  'composition.proposed',
  'flight.materialized',
  'flight.dependency_linked',
  'task.assigned',
])

type BoundWorkspaceIdentity = {
  memberId: string
  tokenId: string
  agentId: string
}

type VisibleFlight = {
  id: string
  projectId: string | null
  meta: FlightMetaV1
}

type VisibleTask = {
  id: string
  squadId: string
  projectId: string | null
}

export interface PublicExecutionReceipt {
  id: string
  type: ExecutionReceipt['type']
  actorKind: ExecutionReceipt['actorKind']
  actorId: string
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
  assignmentEpoch: number | null
  payloadDigest: string
  receiptHash: string
  serverTimestamp: string
}

interface DependencyReceiptClaims {
  dependencyId: string
  parentFlightId: string
  childFlightId: string
}

function boundWorkspaceIdentity(
  auth: AuthContext,
): BoundWorkspaceIdentity | ToolOutcome {
  const memberId = auth.memberId?.trim() ?? ''
  const tokenId = auth.tokenId?.trim() ?? ''
  const agentId = auth.boundAgentId?.trim() ?? ''
  if (
    auth.channel !== 'workspace'
    || memberId === ''
    || tokenId === ''
    || agentId === ''
  ) {
    return fail(403, 'agent_bound_workspace_credential_required')
  }
  return { memberId, tokenId, agentId }
}

function isToolFailure(
  value: BoundWorkspaceIdentity | ToolOutcome,
): value is ToolOutcome {
  return 'ok' in value
}

async function requireCurrentSquadCapability(
  env: Env,
  auth: AuthContext,
  squadId: string,
  minimum: Capability,
): Promise<ToolOutcome | null> {
  const memberId = auth.memberId?.trim() ?? ''
  if (memberId === '') return fail(403, 'agent_bound_workspace_credential_required')

  const legacyAdmin = auth.capabilities === undefined
    && (auth.role === 'owner' || auth.role === 'admin')
  if (legacyAdmin) return null

  const effective = auth.capabilities ?? (await resolveCapabilities(env, memberId))
  if (!(await memberCanOnSquad(env, effective, squadId, minimum))) {
    return fail(403, 'forbidden', { need: minimum, scope: 'squad' })
  }

  // The auth snapshot remains the consent/channel ceiling; a fresh DB read is
  // an additional revocation check, never a way to widen that snapshot.
  const current = await resolveCapabilities(env, memberId)
  if (!(await memberCanOnSquad(env, current, squadId, minimum))) {
    return fail(403, 'forbidden', { need: minimum, scope: 'squad' })
  }
  return null
}

async function requireBoundAgentHomeMember(
  env: Env,
  auth: AuthContext,
): Promise<BoundWorkspaceIdentity | ToolOutcome> {
  const identity = boundWorkspaceIdentity(auth)
  if (isToolFailure(identity)) return identity

  const agent = await getAgent(env, identity.agentId)
  if (!agent.ok || agent.agent.status !== 'active') {
    return fail(403, 'agent_bound_workspace_credential_required')
  }
  const denied = await requireCurrentSquadCapability(env, auth, agent.agent.squad_id, 'member')
  return denied ?? identity
}

function objectiveWriteFailure(error: ObjectiveError): ToolOutcome {
  switch (error.code) {
    case 'invalid_objective':
      return fail(400, error.code)
    case 'idempotency_conflict':
    case 'objective_persistence_conflict':
      return fail(409, error.code)
    case 'unauthorized_tenant':
    case 'invalid_actor':
    case 'objective_forbidden':
    case 'objective_budget_forbidden':
    case 'project_access_forbidden':
      return fail(403, error.code)
    case 'objective_budget_exceeds_cap':
      return fail(403, error.code, error.detail)
  }
}

function attestationFailure(error: AttestationError): ToolOutcome {
  switch (error.code) {
    case 'fingerprint_not_configured':
      return fail(503, error.code)
    case 'workspace_token_required':
      return fail(403, error.code)
    case 'attestation_conflict':
      return fail(409, error.code)
  }
}

function seatFailure(error: RuntimeSeatError): ToolOutcome {
  switch (error.code) {
    case 'invalid_seat':
      return fail(400, error.code)
    case 'workspace_token_required':
    case 'lease_forbidden':
      return fail(403, error.code)
    case 'seat_not_found':
      return fail(404, error.code)
    case 'duplicate_seat':
    case 'seat_registration_conflict':
    case 'seat_not_active':
    case 'seat_revoked':
    case 'stale_generation':
    case 'active_lease_exists':
    case 'stale_lease':
    case 'lease_persistence_conflict':
      return fail(409, error.code)
  }
}

async function visibleObjective(
  env: Env,
  auth: AuthContext,
  objectiveId: string,
): Promise<AcceptedObjective | null> {
  let objective: AcceptedObjective | null
  try {
    objective = await getObjective(env, auth, objectiveId)
  } catch (error) {
    if (error instanceof ObjectiveError) return null
    throw error
  }
  if (!objective) return null
  if (
    objective.projectId !== null
    && !(await readableProject(env, objective.projectId, readAccess(auth)))
  ) {
    return null
  }
  return objective
}

async function visibleFlight(
  env: Env,
  auth: AuthContext,
  flightId: string,
): Promise<VisibleFlight | null> {
  const flight = await getFlight(env, flightId)
  if (!flight) return null

  let rawMeta: unknown
  try {
    rawMeta = JSON.parse(flight.meta)
  } catch {
    return null
  }
  const meta = parseFlightMetaV1(rawMeta)
  if (!meta) return null
  const squads = await loadFlightSquads(env, meta.squad_ids)
  if (squads.length !== meta.squad_ids.length) return null
  if (!hasWorkspaceAdmin(auth)) {
    const grants = auth.capabilities ?? []
    for (const squadId of meta.squad_ids) {
      if (!(await memberCanOnSquad(env, grants, squadId, 'observer'))) return null
    }
  }
  if (
    flight.project_id !== null
    && !(await readableProject(env, flight.project_id, readAccess(auth)))
  ) {
    return null
  }
  return { id: flight.id, projectId: flight.project_id, meta }
}

async function visibleTask(
  env: Env,
  auth: AuthContext,
  taskId: string,
): Promise<VisibleTask | null> {
  const task = await env.DB.prepare(`
    SELECT id, squad_id, project_id FROM tasks WHERE id = ?1
  `).bind(taskId).first<{ id: string; squad_id: string; project_id: string | null }>()
  if (!task) return null
  if (
    !hasWorkspaceAdmin(auth)
    && !(await memberCanOnSquad(env, auth.capabilities ?? [], task.squad_id, 'observer'))
  ) {
    return null
  }
  if (
    task.project_id !== null
    && !(await readableProject(env, task.project_id, readAccess(auth)))
  ) {
    return null
  }
  return { id: task.id, squadId: task.squad_id, projectId: task.project_id }
}

function hasExactPublicTypeShape(receipt: ExecutionReceipt): boolean {
  const objectiveOnly = receipt.objectiveId !== null
    && receipt.flightId === null
    && receipt.taskId === null
    && receipt.assignmentEpoch === null
  const objectiveAndFlight = receipt.objectiveId !== null
    && receipt.flightId !== null
    && receipt.taskId === null
    && receipt.assignmentEpoch === null

  switch (receipt.type) {
    case 'objective.authorized':
    case 'objective.accepted':
      return objectiveOnly
    case 'composition.proposed':
    case 'flight.materialized':
    case 'flight.dependency_linked':
      return objectiveAndFlight
    case 'task.assigned':
      return receipt.objectiveId !== null
        && receipt.flightId !== null
        && receipt.taskId !== null
        && receipt.assignmentEpoch !== null
        && Number.isInteger(receipt.assignmentEpoch)
        && receipt.assignmentEpoch > 0
    default:
      return false
  }
}

function objectiveAndFlightAgree(
  objective: AcceptedObjective,
  flight: VisibleFlight,
): boolean {
  return flight.meta.objective_id === objective.id
    && flight.projectId === objective.projectId
    && flight.meta.squad_ids.includes(objective.squadId)
}

function objectiveAndTaskAgree(
  objective: AcceptedObjective,
  task: VisibleTask,
): boolean {
  return task.projectId === objective.projectId
    && task.squadId === objective.squadId
}

function flightAndTaskAgree(flight: VisibleFlight, task: VisibleTask): boolean {
  return flight.meta.task_ids.includes(task.id)
    && flight.meta.squad_ids.includes(task.squadId)
    && flight.projectId === task.projectId
}

function dependencyClaims(claimsJson: string): DependencyReceiptClaims | null {
  let value: unknown
  try {
    value = JSON.parse(claimsJson)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join('\n') !== 'childFlightId\ndependencyId\nparentFlightId') return null
  const dependencyId = str(record.dependencyId)
  const parentFlightId = str(record.parentFlightId)
  const childFlightId = str(record.childFlightId)
  if (!dependencyId || !parentFlightId || !childFlightId) return null
  return { dependencyId, parentFlightId, childFlightId }
}

async function visibleDependency(
  env: Env,
  auth: AuthContext,
  receipt: ExecutionReceipt,
  objective: AcceptedObjective,
): Promise<boolean> {
  const claims = dependencyClaims(receipt.claimsJson)
  if (
    !claims
    || receipt.objectiveId === null
    || receipt.flightId === null
    || claims.parentFlightId !== receipt.flightId
    || claims.childFlightId === claims.parentFlightId
  ) {
    return false
  }
  const row = await env.DB.prepare(`
    SELECT id FROM flight_dependencies
     WHERE id = ?1 AND tenant = ?2 AND objective_id = ?3
       AND parent_flight_id = ?4 AND child_flight_id = ?5
     LIMIT 1
  `).bind(
    claims.dependencyId,
    env.TENANT_SLUG,
    receipt.objectiveId,
    claims.parentFlightId,
    claims.childFlightId,
  ).first<{ id: string }>()
  if (!row) return false
  const child = await visibleFlight(env, auth, claims.childFlightId)
  return child !== null && objectiveAndFlightAgree(objective, child)
}

function publicExecutionReceipt(receipt: ExecutionReceipt): PublicExecutionReceipt {
  return {
    id: receipt.id,
    type: receipt.type,
    actorKind: receipt.actorKind,
    actorId: receipt.actorId,
    objectiveId: receipt.objectiveId,
    flightId: receipt.flightId,
    taskId: receipt.taskId,
    assignmentEpoch: receipt.assignmentEpoch,
    payloadDigest: receipt.payloadDigest,
    receiptHash: receipt.receiptHash,
    serverTimestamp: receipt.serverTimestamp,
  }
}

async function receiptIsVisible(
  env: Env,
  auth: AuthContext,
  receipt: ExecutionReceipt,
): Promise<boolean> {
  if (
    auth.tenant !== env.TENANT_SLUG
    || receipt.tenant !== env.TENANT_SLUG
    || receipt.issuerKind !== 'mupot'
    || receipt.issuerId !== `mupot:${env.TENANT_SLUG}`
    || !PUBLIC_RECEIPT_TYPES.has(receipt.type)
  ) {
    return false
  }
  // These fields describe runtime/message/lease facts, none of which this
  // bounded reader exposes even when another correlation happens to be visible.
  if (
    receipt.seatId !== null
    || receipt.seatGeneration !== null
    || receipt.messageId !== null
    || receipt.fencingEpoch !== null
    || receipt.leaseTokenHash !== null
    || !hasExactPublicTypeShape(receipt)
  ) {
    return false
  }

  const objective = await visibleObjective(env, auth, receipt.objectiveId as string)
  if (!objective) return false
  if (receipt.flightId === null) return true

  const flight = await visibleFlight(env, auth, receipt.flightId)
  if (!flight || !objectiveAndFlightAgree(objective, flight)) return false
  if (receipt.type === 'flight.dependency_linked') {
    return visibleDependency(env, auth, receipt, objective)
  }
  if (receipt.taskId === null) return true

  const task = await visibleTask(env, auth, receipt.taskId)
  return task !== null
    && objectiveAndTaskAgree(objective, task)
    && flightAndTaskAgree(flight, task)
}

const toolObjectiveAccept: ToolSpec = {
  name: 'objective_accept',
  scope: 'agent-bound workspace objective acceptance',
  min: 'member',
  args: '{ squadId: string, projectId?: string|null, title: string, successContract: string, authorityEnvelope: object, policy: object, budgetMicroUsd: number, payload: object, idempotencyKey: string }',
  inputSchema: {
    type: 'object',
    properties: {
      squadId: STRING_SCHEMA,
      projectId: NULLABLE_STRING_SCHEMA,
      title: STRING_SCHEMA,
      successContract: STRING_SCHEMA,
      authorityEnvelope: OBJECT_SCHEMA,
      policy: OBJECT_SCHEMA,
      budgetMicroUsd: NUMBER_SCHEMA,
      payload: OBJECT_SCHEMA,
      idempotencyKey: STRING_SCHEMA,
    },
    required: [
      'squadId',
      'title',
      'successContract',
      'authorityEnvelope',
      'policy',
      'budgetMicroUsd',
      'payload',
      'idempotencyKey',
    ],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const identity = boundWorkspaceIdentity(auth)
    if (isToolFailure(identity)) return identity
    const squadId = str(args.squadId)
    const title = str(args.title)
    const successContract = str(args.successContract)
    const idempotencyKey = str(args.idempotencyKey)
    const projectId = args.projectId === undefined || args.projectId === null
      ? null
      : str(args.projectId)
    if (
      !squadId
      || !title
      || !successContract
      || !idempotencyKey
      || (args.projectId !== undefined && args.projectId !== null && !projectId)
    ) {
      return fail(400, 'invalid_objective')
    }

    const minimum: Capability = typeof args.budgetMicroUsd === 'number'
      && args.budgetMicroUsd > 0
      ? 'lead'
      : 'member'
    const denied = await requireCurrentSquadCapability(env, auth, squadId, minimum)
    if (denied) return denied

    try {
      const objective = await acceptObjective(env, auth, {
        squadId,
        projectId,
        title,
        successContract,
        authorityEnvelope: args.authorityEnvelope as Record<string, unknown>,
        policy: args.policy as Record<string, unknown>,
        budgetMicroUsd: args.budgetMicroUsd as number,
        payload: args.payload as Record<string, unknown>,
        idempotencyKey,
      })
      return done({ objective })
    } catch (error) {
      if (error instanceof ObjectiveError) return objectiveWriteFailure(error)
      throw error
    }
  },
}

const toolObjectiveGet: ToolSpec = {
  name: 'objective_get',
  scope: 'caller-visible objective squad and project',
  min: 'observer',
  args: '{ objectiveId: string }',
  inputSchema: {
    type: 'object',
    properties: { objectiveId: STRING_SCHEMA },
    required: ['objectiveId'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const objectiveId = str(args.objectiveId)
    if (!objectiveId) return fail(400, 'invalid_args')
    const objective = await visibleObjective(env, auth, objectiveId)
    return objective ? done({ objective }) : fail(404, 'objective_not_found')
  },
}

const toolExecutionReceiptGet: ToolSpec = {
  name: 'execution_receipt_get',
  scope: 'caller-visible objective, flight, and task receipt correlations',
  min: 'observer',
  args: '{ receiptId: string }',
  inputSchema: {
    type: 'object',
    properties: { receiptId: STRING_SCHEMA },
    required: ['receiptId'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const receiptId = str(args.receiptId)
    if (!receiptId) return fail(400, 'invalid_args')
    const receipt = await getExecutionReceipt(env, receiptId)
    if (!receipt || !(await receiptIsVisible(env, auth, receipt))) {
      return fail(404, 'receipt_not_found')
    }
    const verification = await verifyExecutionReceipt(env, receipt.id)
    if (!verification.ok) return fail(409, 'receipt_integrity_failure')
    return done({ receipt: publicExecutionReceipt(receipt) })
  },
}

const toolTokenBindingAttest: ToolSpec = {
  name: 'token_binding_attest',
  scope: 'current agent-bound workspace token',
  min: 'member',
  args: '{}',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async run(auth, env) {
    const identity = await requireBoundAgentHomeMember(env, auth)
    if (isToolFailure(identity)) return identity
    try {
      const attestation = await issueTokenBindingAttestation(
        env as MemberTokenFingerprintEnv,
        auth,
      )
      return done({ attestation })
    } catch (error) {
      if (error instanceof AttestationError) return attestationFailure(error)
      throw error
    }
  },
}

const toolRuntimeSeatRegisterPending: ToolSpec = {
  name: 'runtime_seat_register_pending',
  scope: 'current agent-bound workspace credential; pending command seat only',
  min: 'member',
  args: '{ seatName: string, hostId: string, adapterKind: string, attestationId: string }',
  inputSchema: {
    type: 'object',
    properties: {
      seatName: STRING_SCHEMA,
      hostId: STRING_SCHEMA,
      adapterKind: STRING_SCHEMA,
      attestationId: STRING_SCHEMA,
    },
    required: ['seatName', 'hostId', 'adapterKind', 'attestationId'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const identity = await requireBoundAgentHomeMember(env, auth)
    if (isToolFailure(identity)) return identity
    const seatName = str(args.seatName)
    const hostId = str(args.hostId)
    const adapterKind = str(args.adapterKind)
    const attestationId = str(args.attestationId)
    if (!seatName || !hostId || !adapterKind || !attestationId) {
      return fail(400, 'invalid_seat')
    }

    // Task 4's service issues/replays the binding attestation internally. The
    // public MCP contract is stricter: the caller must first present the exact
    // server-issued ID for this authenticated token/member/agent tuple.
    const correlated = await env.DB.prepare(`
      SELECT id FROM token_binding_attestations
       WHERE id = ?1 AND tenant = ?2 AND token_id = ?3
         AND member_id = ?4 AND agent_id = ?5 AND channel = 'workspace'
       LIMIT 1
    `).bind(
      attestationId,
      env.TENANT_SLUG,
      identity.tokenId,
      identity.memberId,
      identity.agentId,
    ).first<{ id: string }>()
    if (!correlated) return fail(404, 'attestation_not_found')

    try {
      const registered = await registerPendingRuntimeSeat(
        env as MemberTokenFingerprintEnv,
        auth,
        { seatName, hostId, adapterKind },
      )
      return done({ seat: registered.seat, attestation: registered.attestation })
    } catch (error) {
      if (error instanceof RuntimeSeatError) return seatFailure(error)
      if (error instanceof AttestationError) return attestationFailure(error)
      throw error
    }
  },
}

import {
  validateRunSheet,
  getExecutableStages,
  computeArtifactSha256,
  type RunSheetV1,
} from '../flight/run-sheets'

const toolRunSheetValidate: ToolSpec = {
  name: 'run_sheet_validate',
  scope: 'declarative flight run sheet validation',
  min: 'observer',
  args: '{ run_sheet: object }',
  inputSchema: {
    type: 'object',
    properties: {
      run_sheet: OBJECT_SCHEMA,
    },
    required: ['run_sheet'],
    additionalProperties: false,
  },
  async run(_auth, _env, args) {
    const res = validateRunSheet(args.run_sheet)
    if (!res.ok) {
      return fail(400, 'invalid_run_sheet', { errors: res.errors })
    }
    const executable = getExecutableStages(res.runSheet)
    return done({
      valid: true,
      goalId: res.runSheet.goalId,
      stagesCount: res.runSheet.stages.length,
      nextExecutableStages: executable.map((s) => ({ id: s.id, name: s.name, type: s.type, targetSeat: s.targetSeat })),
    })
  },
}

const toolRunSheetArtifactHash: ToolSpec = {
  name: 'run_sheet_artifact_hash',
  scope: 'compute deterministic SHA-256 hash for flight artifact',
  min: 'observer',
  args: '{ content: string }',
  inputSchema: {
    type: 'object',
    properties: {
      content: STRING_SCHEMA,
    },
    required: ['content'],
    additionalProperties: false,
  },
  async run(_auth, _env, args) {
    const content = str(args.content)
    if (content === undefined || content === null) return fail(400, 'invalid_args', 'content is required')
    const sha256 = await computeArtifactSha256(content)
    return done({ sha256, byteLength: new TextEncoder().encode(content).length })
  },
}

export const FLIGHT_SPINE_TOOLS: ToolSpec[] = [
  toolObjectiveAccept,
  toolObjectiveGet,
  toolExecutionReceiptGet,
  toolTokenBindingAttest,
  toolRuntimeSeatRegisterPending,
  toolRunSheetValidate,
  toolRunSheetArtifactHash,
]
