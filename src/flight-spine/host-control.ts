import type { AuthContext, Env } from '../types'
import { hasCapability } from '../auth/capability'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import {
  canonicalSafeJson,
  safeBoundedText,
  safeOptionalId,
} from './audit'
import {
  executePreparedExecutionReceiptBatch,
  getExecutionReceipt,
  prepareAuditedDomainMutation,
  prepareFreshExecutionReceiptChain,
  verifyExecutionReceipt,
} from './receipts'
import {
  flightSpineAudit,
  requireFlightSpineSquadAuthority,
  resolveFlightSpinePrincipal,
  type FlightSpinePrincipal,
} from './objectives'
import type { ExecutionReceipt, JsonValue } from './types'

export type HostControlPrincipalKind =
  | 'agent'
  | 'system'
  | 'controller'
  | 'fault_injector'

export type HostControlOrigin = 'signed_wrapper' | 'controller' | 'runner'
export type HostControlAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'signal'
  | 'replace'
  | 'fault_inject'

export interface RecordHostControlFactInput {
  principalKind: HostControlPrincipalKind
  principalId: string
  origin: HostControlOrigin
  hostId: string
  unitName: string
  runtimeSeatId?: string | null
  processGeneration: number
  action: HostControlAction
  reason: string
  objectiveId?: string | null
  flightId?: string | null
  taskId?: string | null
  requestId: string
  idempotencyKey: string
  requestSignatureDigest: string
  observationSignatureDigest: string
  observedResult: 'succeeded' | 'failed'
  observationReceiptId: string
  observedAt: string
}

export interface HostControlFact {
  id: string
  tenant: string
  principalKind: HostControlPrincipalKind
  principalId: string
  credentialId: string | null
  runtimeSeatId: string | null
  origin: HostControlOrigin
  hostId: string
  unitName: string
  processGeneration: number
  action: HostControlAction
  reason: string
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
  requestId: string
  idempotencyKey: string
  requestSignatureDigest: string
  observationSignatureDigest: string
  observedResult: 'succeeded' | 'failed'
  requestReceiptId: string
  observationReceiptId: string
  observedAt: string
}

export type HostControlErrorCode =
  | 'invalid_host_control_fact'
  | 'host_control_forbidden'
  | 'observation_receipt_not_found'
  | 'observation_receipt_invalid'
  | 'idempotency_conflict'
  | 'host_control_persistence_conflict'

export class HostControlError extends Error {
  readonly name = 'HostControlError'

  constructor(readonly code: HostControlErrorCode) {
    super(code)
  }
}

interface HostControlRow {
  id: string
  tenant: string
  principal_kind: HostControlPrincipalKind
  principal_id: string
  credential_id: string | null
  runtime_seat_id: string | null
  origin: HostControlOrigin
  host_id: string
  unit_name: string
  process_generation: number
  action: HostControlAction
  reason: string
  objective_id: string | null
  flight_id: string | null
  task_id: string | null
  request_id: string
  idempotency_key: string | null
  request_signature_digest: string
  observation_signature_digest: string
  observed_result: 'succeeded' | 'failed'
  request_receipt_id: string
  observation_receipt_id: string
  observed_at: string
}

interface NormalizedHostControlInput extends Omit<RecordHostControlFactInput,
  'runtimeSeatId' | 'objectiveId' | 'flightId' | 'taskId'> {
  runtimeSeatId: string | null
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
}

interface RecordingAuthority {
  selfAgent: boolean
  squadId: string | null
  departmentId: string | null
}

const PRINCIPAL_KINDS = new Set<HostControlPrincipalKind>([
  'agent',
  'system',
  'controller',
  'fault_injector',
])
const ORIGINS = new Set<HostControlOrigin>(['signed_wrapper', 'controller', 'runner'])
const ACTIONS = new Set<HostControlAction>([
  'start', 'stop', 'restart', 'signal', 'replace', 'fault_inject',
])
const INPUT_KEYS = new Set([
  'principalKind', 'principalId', 'origin', 'hostId', 'unitName',
  'runtimeSeatId', 'processGeneration', 'action', 'reason', 'objectiveId',
  'flightId', 'taskId', 'requestId', 'idempotencyKey',
  'requestSignatureDigest', 'observationSignatureDigest', 'observedResult',
  'observationReceiptId', 'observedAt',
])

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new HostControlError('invalid_host_control_fact')
  }
  return value
}

function safeText(value: unknown, maximum: number): string {
  try {
    return safeBoundedText(value, maximum)
  } catch {
    throw new HostControlError('invalid_host_control_fact')
  }
}

function optionalId(value: unknown): string | null {
  try {
    return safeOptionalId(value)
  } catch {
    throw new HostControlError('invalid_host_control_fact')
  }
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new HostControlError('invalid_host_control_fact')
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
    || milliseconds > Date.now()
  ) {
    throw new HostControlError('invalid_host_control_fact')
  }
  return value
}

function normalizeInput(input: RecordHostControlFactInput): NormalizedHostControlInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HostControlError('invalid_host_control_fact')
  }
  const keys = Object.keys(input)
  const required = [
    'principalKind', 'principalId', 'origin', 'hostId', 'unitName',
    'processGeneration', 'action', 'reason', 'requestId', 'idempotencyKey',
    'requestSignatureDigest', 'observationSignatureDigest', 'observedResult',
    'observationReceiptId', 'observedAt',
  ]
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
    || keys.some((key) => !INPUT_KEYS.has(key))
    || !PRINCIPAL_KINDS.has(input.principalKind)
    || !ORIGINS.has(input.origin)
    || !ACTIONS.has(input.action)
    || !['succeeded', 'failed'].includes(input.observedResult)
    || !Number.isSafeInteger(input.processGeneration)
    || input.processGeneration <= 0
  ) {
    throw new HostControlError('invalid_host_control_fact')
  }
  return {
    principalKind: input.principalKind,
    principalId: safeText(input.principalId, 255),
    origin: input.origin,
    hostId: safeText(input.hostId, 255),
    unitName: safeText(input.unitName, 255),
    runtimeSeatId: optionalId(input.runtimeSeatId),
    processGeneration: input.processGeneration,
    action: input.action,
    reason: safeText(input.reason, 2_000),
    objectiveId: optionalId(input.objectiveId),
    flightId: optionalId(input.flightId),
    taskId: optionalId(input.taskId),
    requestId: safeText(input.requestId, 2_000),
    idempotencyKey: safeText(input.idempotencyKey, 255),
    requestSignatureDigest: sha256(input.requestSignatureDigest),
    observationSignatureDigest: sha256(input.observationSignatureDigest),
    observedResult: input.observedResult,
    observationReceiptId: safeText(input.observationReceiptId, 255),
    observedAt: canonicalTimestamp(input.observedAt),
  }
}

function observationClaims(input: NormalizedHostControlInput): JsonValue {
  return {
    action: input.action,
    hostId: input.hostId,
    observationSignatureDigest: input.observationSignatureDigest,
    observedAt: input.observedAt,
    observedResult: input.observedResult,
    origin: input.origin,
    principalId: input.principalId,
    principalKind: input.principalKind,
    processGeneration: input.processGeneration,
    reason: input.reason,
    requestId: input.requestId,
    requestSignatureDigest: input.requestSignatureDigest,
    runtimeSeatId: input.runtimeSeatId,
    unitName: input.unitName,
  }
}

function requestClaims(input: NormalizedHostControlInput): JsonValue {
  return {
    action: input.action,
    hostId: input.hostId,
    processGeneration: input.processGeneration,
    reason: input.reason,
    requestId: input.requestId,
    requestSignatureDigest: input.requestSignatureDigest,
    runtimeSeatId: input.runtimeSeatId,
    unitName: input.unitName,
  }
}

function expectedObservationActorKind(
  principalKind: HostControlPrincipalKind,
): 'agent' | 'system' | 'controller' {
  return principalKind === 'fault_injector' ? 'controller' : principalKind
}

async function requireObservationReceipt(
  env: Env,
  input: NormalizedHostControlInput,
): Promise<ExecutionReceipt> {
  const receipt = await getExecutionReceipt(env, input.observationReceiptId)
  if (receipt === null) throw new HostControlError('observation_receipt_not_found')
  const verified = await verifyExecutionReceipt(env, receipt.id)
  if (
    !verified.ok
    || receipt.type !== 'host_control.observed'
    || (receipt.issuerKind !== 'adapter' && receipt.issuerKind !== 'runtime')
    || receipt.actorKind !== expectedObservationActorKind(input.principalKind)
    || receipt.actorId !== input.principalId
    || receipt.seatId !== input.runtimeSeatId
    || receipt.seatGeneration !== (input.runtimeSeatId === null ? null : input.processGeneration)
    || receipt.objectiveId !== input.objectiveId
    || receipt.flightId !== input.flightId
    || receipt.taskId !== input.taskId
    || receipt.claimsJson !== canonicalJson(observationClaims(input))
  ) {
    throw new HostControlError('observation_receipt_invalid')
  }
  return receipt
}

async function requireRecordingAuthority(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  input: NormalizedHostControlInput,
): Promise<RecordingAuthority> {
  if (input.principalKind === 'agent' && principal.agentId === input.principalId) {
    const agent = await env.DB.prepare(`
      SELECT agent.squad_id, squad.department_id
        FROM agents agent
        JOIN squads squad ON squad.id = agent.squad_id
       WHERE agent.id = ?1 AND agent.status = 'active'
    `).bind(input.principalId).first<{ squad_id: string; department_id: string }>()
    if (agent === null) throw new HostControlError('host_control_forbidden')
    try {
      await requireFlightSpineSquadAuthority(
        env,
        auth,
        principal,
        agent.squad_id,
        'member',
      )
    } catch {
      throw new HostControlError('host_control_forbidden')
    }
    return { selfAgent: true, squadId: agent.squad_id, departmentId: agent.department_id }
  }
  if (
    auth.capabilities === undefined
    || !hasCapability(auth.capabilities, 'org', null, 'admin')
  ) {
    throw new HostControlError('host_control_forbidden')
  }
  return { selfAgent: false, squadId: null, departmentId: null }
}

function mapRow(row: HostControlRow): HostControlFact {
  if (row.idempotency_key === null) throw new HostControlError('host_control_persistence_conflict')
  return {
    id: row.id,
    tenant: row.tenant,
    principalKind: row.principal_kind,
    principalId: row.principal_id,
    credentialId: row.credential_id,
    runtimeSeatId: row.runtime_seat_id,
    origin: row.origin,
    hostId: row.host_id,
    unitName: row.unit_name,
    processGeneration: Number(row.process_generation),
    action: row.action,
    reason: row.reason,
    objectiveId: row.objective_id,
    flightId: row.flight_id,
    taskId: row.task_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    requestSignatureDigest: row.request_signature_digest,
    observationSignatureDigest: row.observation_signature_digest,
    observedResult: row.observed_result,
    requestReceiptId: row.request_receipt_id,
    observationReceiptId: row.observation_receipt_id,
    observedAt: row.observed_at,
  }
}

async function factByRequest(env: Env, requestId: string): Promise<HostControlRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, principal_kind, principal_id, credential_id,
           runtime_seat_id, origin, host_id, unit_name, process_generation,
           action, reason, objective_id, flight_id, task_id, request_id,
           idempotency_key, request_signature_digest,
           observation_signature_digest, observed_result, request_receipt_id,
           observation_receipt_id, observed_at
      FROM host_control_receipts
     WHERE tenant = ?1 AND request_id = ?2
  `).bind(env.TENANT_SLUG, requestId).first<HostControlRow>()
}

async function exactReplay(
  env: Env,
  row: HostControlRow,
  input: NormalizedHostControlInput,
  credentialId: string | null,
): Promise<HostControlFact> {
  const mapped = mapRow(row)
  const expected = {
    tenant: env.TENANT_SLUG,
    principalKind: input.principalKind,
    principalId: input.principalId,
    credentialId,
    runtimeSeatId: input.runtimeSeatId,
    origin: input.origin,
    hostId: input.hostId,
    unitName: input.unitName,
    processGeneration: input.processGeneration,
    action: input.action,
    reason: input.reason,
    objectiveId: input.objectiveId,
    flightId: input.flightId,
    taskId: input.taskId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    requestSignatureDigest: input.requestSignatureDigest,
    observationSignatureDigest: input.observationSignatureDigest,
    observedResult: input.observedResult,
    observationReceiptId: input.observationReceiptId,
    observedAt: input.observedAt,
  }
  const { id: _id, requestReceiptId, ...actual } = mapped
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new HostControlError('idempotency_conflict')
  }
  const requestReceipt = await getExecutionReceipt(env, requestReceiptId)
  if (
    requestReceipt === null
    || requestReceipt.type !== 'host_control.requested'
    || requestReceipt.idempotencyKey !== `host-control:${input.idempotencyKey}:requested`
    || requestReceipt.claimsJson !== canonicalJson(requestClaims(input))
    || !(await verifyExecutionReceipt(env, requestReceipt.id)).ok
  ) {
    throw new HostControlError('host_control_persistence_conflict')
  }
  await requireObservationReceipt(env, input)
  return mapped
}

/** Record signed observed facts only. This service never invokes a shell, PTY, process, or host API. */
export async function recordHostControlFact(
  env: Env,
  auth: AuthContext,
  rawInput: RecordHostControlFactInput,
): Promise<HostControlFact> {
  const input = normalizeInput(rawInput)
  let principal: FlightSpinePrincipal
  try {
    principal = await resolveFlightSpinePrincipal(env, auth)
  } catch {
    throw new HostControlError('host_control_forbidden')
  }
  const authority = await requireRecordingAuthority(env, auth, principal, input)
  const credentialId = optionalId(auth.tokenId)
  const replay = await factByRequest(env, input.requestId)
  if (replay !== null) return exactReplay(env, replay, input, credentialId)
  const observationReceipt = await requireObservationReceipt(env, input)

  const prepared = await prepareFreshExecutionReceiptChain(env, auth, [{
    type: 'host_control.requested',
    idempotencyKey: `host-control:${input.idempotencyKey}:requested`,
    claims: requestClaims(input),
    seatId: input.runtimeSeatId,
    seatGeneration: input.runtimeSeatId === null ? null : input.processGeneration,
    objectiveId: input.objectiveId,
    flightId: input.flightId,
    taskId: input.taskId,
  }])
  const requestReceipt = prepared.expectedReceipts[0]
  const factId = `host-control:${(await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    requestId: input.requestId,
  }))).slice(0, 48)}`
  const factDigest = await sha256Hex(canonicalSafeJson({
    ...input,
    requestReceiptId: requestReceipt.id,
  }).json)
  const mutation = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO host_control_receipts (
      id, tenant, principal_kind, principal_id, credential_id, runtime_seat_id,
      origin, host_id, unit_name, process_generation, action, reason,
      objective_id, flight_id, task_id, request_id, idempotency_key,
      request_signature_digest, observation_signature_digest, observed_result,
      request_receipt_id, observation_receipt_id, observed_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM execution_receipts observation
        WHERE observation.id = ? AND observation.tenant = ?
          AND observation.type = 'host_control.observed'
          AND observation.issuer_kind IN ('adapter', 'runtime')
          AND observation.actor_kind = ? AND observation.actor_id = ?
          AND observation.seat_id IS ? AND observation.seat_generation IS ?
          AND observation.objective_id IS ? AND observation.flight_id IS ?
          AND observation.task_id IS ? AND observation.claims_json = ?
          AND observation.receipt_hash = ?
     )
       AND EXISTS (
         SELECT 1 FROM execution_receipts request
          WHERE request.id = ? AND request.tenant = ?
            AND request.type = 'host_control.requested'
            AND request.actor_kind = ? AND request.actor_id = ?
            AND request.claims_json = ? AND request.receipt_hash = ?
       )
       AND EXISTS (
         SELECT 1 FROM members member
          WHERE member.id = ? AND member.tenant = ? AND member.status = 'active'
       )
       AND (
         ? IS NULL
         OR EXISTS (
           SELECT 1 FROM member_tokens t
            WHERE t.id = ? AND t.tenant = ? AND t.member_id = ?
              AND t.agent_id IS ? AND ${TOKEN_LIVE_PREDICATE('?')}
         )
       )
       AND (
         (? = 1 AND EXISTS (
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
         ) AND (
           EXISTS (
             SELECT 1 FROM capabilities capability
              WHERE capability.member_id = ?
                AND (capability.scope_type = 'org'
                  OR (capability.scope_type = 'department' AND capability.scope_id = ?)
                  OR (capability.scope_type = 'squad' AND capability.scope_id = ?))
                AND CASE capability.capability
                  WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                  WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
           ) OR EXISTS (
             SELECT 1 FROM channel_capability_grants capability
              WHERE capability.member_id = ? AND capability.squad_id = ?
                AND CASE capability.capability
                  WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                  WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
           )
         ))
         OR (? = 1 AND EXISTS (
           SELECT 1 FROM capabilities capability
            WHERE capability.member_id = ? AND capability.scope_type = 'org'
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 4
         ))
       )
       AND (
         ? IS NULL
         OR EXISTS (
           SELECT 1
             FROM runtime_seats seat
             JOIN runtime_seat_generations generation
               ON generation.tenant = seat.tenant
              AND generation.runtime_seat_id = seat.id
              AND generation.generation = ?
            WHERE seat.id = ? AND seat.tenant = ? AND seat.agent_id = ?
              AND seat.host_id = ? AND seat.state = 'active'
              AND seat.current_generation = ?
         )
       )`,
    bindings: [
      factId, env.TENANT_SLUG, input.principalKind, input.principalId,
      credentialId, input.runtimeSeatId, input.origin, input.hostId, input.unitName,
      input.processGeneration, input.action, input.reason, input.objectiveId,
      input.flightId, input.taskId, input.requestId, input.idempotencyKey,
      input.requestSignatureDigest, input.observationSignatureDigest,
      input.observedResult, requestReceipt.id, input.observationReceiptId,
      input.observedAt,
      input.observationReceiptId, env.TENANT_SLUG,
      expectedObservationActorKind(input.principalKind), input.principalId,
      input.runtimeSeatId, input.runtimeSeatId === null ? null : input.processGeneration,
      input.objectiveId, input.flightId, input.taskId,
      observationReceipt.claimsJson, observationReceipt.receiptHash,
      requestReceipt.id, env.TENANT_SLUG, requestReceipt.actorKind,
      requestReceipt.actorId, requestReceipt.claimsJson, requestReceipt.receiptHash,
      principal.memberId, env.TENANT_SLUG,
      credentialId, credentialId, env.TENANT_SLUG, principal.memberId,
      principal.agentId, nowSqlUtc(),
      authority.selfAgent ? 1 : 0, env.TENANT_SLUG, principal.memberId,
      authority.squadId, input.principalId, principal.authorityMemberId,
      authority.departmentId, authority.squadId, principal.authorityMemberId,
      authority.squadId,
      authority.selfAgent ? 0 : 1, principal.authorityMemberId,
      input.runtimeSeatId, input.processGeneration, input.runtimeSeatId,
      env.TENANT_SLUG, input.principalKind === 'agent' ? input.principalId : null,
      input.hostId, input.processGeneration,
    ],
    audit: flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:${factId}`,
      credentialId,
      runtimeSeatId: input.runtimeSeatId,
      runtimeGeneration: input.runtimeSeatId === null ? null : input.processGeneration,
      handler: 'flight_spine.record_host_control_fact',
      operation: 'insert',
      targetKind: 'host_control_receipt',
      targetId: factId,
      afterDigest: factDigest,
      objectiveId: input.objectiveId,
      flightId: input.flightId,
      taskId: input.taskId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      evidence: {
        observationReceiptId: input.observationReceiptId,
        observationSignatureDigest: input.observationSignatureDigest,
      },
    }),
  })

  try {
    await executePreparedExecutionReceiptBatch(env, prepared, [mutation])
  } catch {
    throw new HostControlError('host_control_persistence_conflict')
  }
  const row = await factByRequest(env, input.requestId)
  if (row === null) throw new HostControlError('host_control_persistence_conflict')
  return exactReplay(env, row, input, credentialId)
}
