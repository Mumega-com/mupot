import type { AuthContext, Env } from '../types'
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
  type AtomicDomainAuditMetadata,
} from './receipts'
import {
  flightSpineAudit,
  requireFlightSpineSquadAuthority,
  resolveFlightSpinePrincipal,
  type FlightSpinePrincipal,
} from './objectives'
import type { ExecutionReceipt, JsonValue } from './types'

export type HostControlAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'signal'
  | 'replace'
  | 'fault_inject'

export interface RecordHostControlFactInput {
  hostId: string
  unitName: string
  runtimeSeatId: string
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
  principalKind: 'agent'
  principalId: string
  credentialId: string
  runtimeSeatId: string
  origin: 'signed_wrapper'
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
  | 'observation_stale'
  | 'observation_receipt_not_found'
  | 'observation_receipt_invalid'
  | 'idempotency_conflict'
  | 'host_control_audit_invalid'
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
  principal_kind: 'agent'
  principal_id: string
  credential_id: string
  runtime_seat_id: string
  origin: 'signed_wrapper'
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

interface HostAuditRow {
  id: string
  tenant: string
  principal_kind: string
  principal_id: string
  member_id: string | null
  agent_id: string | null
  credential_id: string | null
  runtime_seat_id: string | null
  runtime_generation: number | null
  origin: string
  handler: string
  operation: string
  target_kind: string
  target_id: string
  before_digest: string | null
  after_digest: string | null
  objective_id: string | null
  flight_id: string | null
  task_id: string | null
  request_id: string
  idempotency_key: string | null
  evidence_json: string
  recorded_at: string
}

interface NormalizedHostControlInput extends Omit<RecordHostControlFactInput,
  'objectiveId' | 'flightId' | 'taskId'> {
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
}

interface HostSeatAuthority {
  squadId: string
  departmentId: string
}

const ACTIONS = new Set<HostControlAction>([
  'start', 'stop', 'restart', 'signal', 'replace', 'fault_inject',
])
const INPUT_KEYS = new Set([
  'hostId', 'unitName', 'runtimeSeatId', 'processGeneration', 'action',
  'reason', 'objectiveId', 'flightId', 'taskId', 'requestId',
  'idempotencyKey', 'requestSignatureDigest', 'observationSignatureDigest',
  'observedResult', 'observationReceiptId', 'observedAt',
])

function invalid(): never {
  throw new HostControlError('invalid_host_control_fact')
}

function safeText(value: unknown, maximum: number): string {
  try {
    return safeBoundedText(value, maximum)
  } catch {
    return invalid()
  }
}

function optionalId(value: unknown): string | null {
  try {
    return safeOptionalId(value)
  } catch {
    return invalid()
  }
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return invalid()
  return value
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string') return invalid()
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalid()
  }
  return value
}

function normalizeInput(input: RecordHostControlFactInput): NormalizedHostControlInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid()
  const required = [
    'hostId', 'unitName', 'runtimeSeatId', 'processGeneration', 'action',
    'reason', 'requestId', 'idempotencyKey', 'requestSignatureDigest',
    'observationSignatureDigest', 'observedResult', 'observationReceiptId',
    'observedAt',
  ]
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
    || Object.keys(input).some((key) => !INPUT_KEYS.has(key))
    || !ACTIONS.has(input.action)
    || !['succeeded', 'failed'].includes(input.observedResult)
    || !Number.isSafeInteger(input.processGeneration)
    || input.processGeneration <= 0
  ) return invalid()
  return {
    hostId: safeText(input.hostId, 255),
    unitName: safeText(input.unitName, 255),
    runtimeSeatId: safeText(input.runtimeSeatId, 255),
    processGeneration: input.processGeneration,
    action: input.action,
    reason: safeText(input.reason, 2_000),
    objectiveId: optionalId(input.objectiveId),
    flightId: optionalId(input.flightId),
    taskId: optionalId(input.taskId),
    requestId: safeText(input.requestId, 2_000),
    idempotencyKey: safeText(input.idempotencyKey, 255),
    requestSignatureDigest: digest(input.requestSignatureDigest),
    observationSignatureDigest: digest(input.observationSignatureDigest),
    observedResult: input.observedResult,
    observationReceiptId: safeText(input.observationReceiptId, 255),
    observedAt: timestamp(input.observedAt),
  }
}

function assertObservationFresh(input: NormalizedHostControlInput): void {
  const age = Date.now() - Date.parse(input.observedAt)
  if (age < 0 || age > 90_000) throw new HostControlError('observation_stale')
}

function requestClaims(
  input: NormalizedHostControlInput,
  principal: FlightSpinePrincipal,
): JsonValue {
  return {
    action: input.action,
    hostId: input.hostId,
    origin: 'signed_wrapper',
    principalId: principal.id,
    principalKind: 'agent',
    processGeneration: input.processGeneration,
    reason: input.reason,
    requestId: input.requestId,
    requestSignatureDigest: input.requestSignatureDigest,
    runtimeSeatId: input.runtimeSeatId,
    unitName: input.unitName,
  }
}

function observationClaims(
  input: NormalizedHostControlInput,
  principal: FlightSpinePrincipal,
): JsonValue {
  return {
    ...requestClaims(input, principal) as Record<string, JsonValue>,
    observationSignatureDigest: input.observationSignatureDigest,
    observedAt: input.observedAt,
    observedResult: input.observedResult,
  }
}

async function requirePrincipal(
  env: Env,
  auth: AuthContext,
): Promise<{ principal: FlightSpinePrincipal; credentialId: string }> {
  let principal: FlightSpinePrincipal
  try {
    principal = await resolveFlightSpinePrincipal(env, auth)
  } catch {
    throw new HostControlError('host_control_forbidden')
  }
  const credentialId = optionalId(auth.tokenId)
  if (principal.kind !== 'agent' || principal.agentId === null || credentialId === null) {
    throw new HostControlError('host_control_forbidden')
  }
  const token = await env.DB.prepare(`
    SELECT t.id FROM member_tokens t
     WHERE t.id = ?1 AND t.tenant = ?2 AND t.member_id = ?3
       AND t.agent_id = ?4 AND ${TOKEN_LIVE_PREDICATE('?5')}
  `).bind(
    credentialId,
    env.TENANT_SLUG,
    principal.memberId,
    principal.id,
    nowSqlUtc(),
  ).first<{ id: string }>()
  if (token === null) throw new HostControlError('host_control_forbidden')
  return { principal, credentialId }
}

async function requireSeatAuthority(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  input: NormalizedHostControlInput,
): Promise<HostSeatAuthority> {
  const row = await env.DB.prepare(`
    SELECT agent.squad_id, squad.department_id
      FROM runtime_seats seat
      JOIN runtime_seat_generations generation
        ON generation.tenant = seat.tenant
       AND generation.runtime_seat_id = seat.id
       AND generation.generation = ?1
      JOIN agents agent ON agent.id = seat.agent_id AND agent.status = 'active'
      JOIN squads squad ON squad.id = agent.squad_id
     WHERE seat.id = ?2 AND seat.tenant = ?3 AND seat.agent_id = ?4
       AND seat.host_id = ?5 AND seat.state = 'active'
       AND seat.current_generation = ?1
  `).bind(
    input.processGeneration,
    input.runtimeSeatId,
    env.TENANT_SLUG,
    principal.id,
    input.hostId,
  ).first<{ squad_id: string; department_id: string }>()
  if (row === null) throw new HostControlError('host_control_forbidden')
  try {
    await requireFlightSpineSquadAuthority(
      env,
      auth,
      principal,
      row.squad_id,
      'member',
    )
  } catch {
    throw new HostControlError('host_control_forbidden')
  }
  return { squadId: row.squad_id, departmentId: row.department_id }
}

async function requireObservationReceipt(
  env: Env,
  input: NormalizedHostControlInput,
  principal: FlightSpinePrincipal,
): Promise<ExecutionReceipt> {
  const receipt = await getExecutionReceipt(env, input.observationReceiptId)
  if (receipt === null) throw new HostControlError('observation_receipt_not_found')
  const verified = await verifyExecutionReceipt(env, receipt.id)
  if (
    !verified.ok
    || receipt.type !== 'host_control.observed'
    || (receipt.issuerKind !== 'adapter' && receipt.issuerKind !== 'runtime')
    || receipt.actorKind !== 'agent'
    || receipt.actorId !== principal.id
    || receipt.seatId !== input.runtimeSeatId
    || receipt.seatGeneration !== input.processGeneration
    || receipt.objectiveId !== input.objectiveId
    || receipt.flightId !== input.flightId
    || receipt.taskId !== input.taskId
    || receipt.claimsJson !== canonicalJson(observationClaims(input, principal))
  ) {
    throw new HostControlError('observation_receipt_invalid')
  }
  return receipt
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

function expectedAuditRow(
  tenant: string,
  audit: AtomicDomainAuditMetadata,
): Omit<HostAuditRow, 'recorded_at'> {
  return {
    id: audit.expectedAuditId,
    tenant,
    principal_kind: audit.principalKind,
    principal_id: audit.principalId,
    member_id: audit.memberId ?? null,
    agent_id: audit.agentId ?? null,
    credential_id: audit.credentialId ?? null,
    runtime_seat_id: audit.runtimeSeatId ?? null,
    runtime_generation: audit.runtimeGeneration ?? null,
    origin: audit.origin,
    handler: audit.handler,
    operation: audit.operation,
    target_kind: audit.targetKind,
    target_id: audit.targetId,
    before_digest: audit.beforeDigest ?? null,
    after_digest: audit.afterDigest ?? null,
    objective_id: audit.objectiveId ?? null,
    flight_id: audit.flightId ?? null,
    task_id: audit.taskId ?? null,
    request_id: audit.requestId,
    idempotency_key: audit.idempotencyKey ?? null,
    evidence_json: canonicalJson(audit.evidence),
  }
}

async function requireExactAudit(
  env: Env,
  audit: AtomicDomainAuditMetadata,
): Promise<void> {
  const row = await env.DB.prepare(`
    SELECT id, tenant, principal_kind, principal_id, member_id, agent_id,
           credential_id, runtime_seat_id, runtime_generation, origin, handler,
           operation, target_kind, target_id, before_digest, after_digest,
           objective_id, flight_id, task_id, request_id, idempotency_key,
           evidence_json, recorded_at
      FROM mutation_audit_entries WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, audit.expectedAuditId).first<HostAuditRow>()
  if (row === null || row.recorded_at.trim() === '') {
    throw new HostControlError('host_control_audit_invalid')
  }
  const { recorded_at: _recordedAt, ...facts } = row
  if (canonicalJson(facts) !== canonicalJson(expectedAuditRow(env.TENANT_SLUG, audit))) {
    throw new HostControlError('host_control_audit_invalid')
  }
}

async function hostAudit(
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  credentialId: string,
  input: NormalizedHostControlInput,
  factId: string,
  requestReceiptId: string,
): Promise<AtomicDomainAuditMetadata> {
  const afterDigest = await sha256Hex(canonicalSafeJson({
    action: input.action,
    hostId: input.hostId,
    observationReceiptId: input.observationReceiptId,
    observationSignatureDigest: input.observationSignatureDigest,
    observedAt: input.observedAt,
    observedResult: input.observedResult,
    principalId: principal.id,
    processGeneration: input.processGeneration,
    requestReceiptId,
    requestSignatureDigest: input.requestSignatureDigest,
    runtimeSeatId: input.runtimeSeatId,
    unitName: input.unitName,
  }).json)
  return flightSpineAudit(auth, principal, {
    expectedAuditId: `audit:${factId}`,
    credentialId,
    runtimeSeatId: input.runtimeSeatId,
    runtimeGeneration: input.processGeneration,
    handler: 'flight_spine.record_host_control_fact',
    operation: 'insert',
    targetKind: 'host_control_receipt',
    targetId: factId,
    afterDigest,
    objectiveId: input.objectiveId,
    flightId: input.flightId,
    taskId: input.taskId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    evidence: {
      observationReceiptId: input.observationReceiptId,
      observationSignatureDigest: input.observationSignatureDigest,
    },
  })
}

async function exactReplay(
  env: Env,
  auth: AuthContext,
  row: HostControlRow,
  input: NormalizedHostControlInput,
  principal: FlightSpinePrincipal,
  credentialId: string,
): Promise<HostControlFact> {
  const mapped = mapRow(row)
  const expected = {
    tenant: env.TENANT_SLUG,
    principalKind: 'agent',
    principalId: principal.id,
    credentialId,
    runtimeSeatId: input.runtimeSeatId,
    origin: 'signed_wrapper',
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
  const receipt = await getExecutionReceipt(env, requestReceiptId)
  if (
    receipt === null
    || receipt.type !== 'host_control.requested'
    || receipt.actorKind !== principal.kind
    || receipt.actorId !== principal.id
    || receipt.seatId !== input.runtimeSeatId
    || receipt.seatGeneration !== input.processGeneration
    || receipt.objectiveId !== input.objectiveId
    || receipt.flightId !== input.flightId
    || receipt.taskId !== input.taskId
    || receipt.idempotencyKey !== `host-control:${input.idempotencyKey}:requested`
    || receipt.claimsJson !== canonicalJson(requestClaims(input, principal))
    || !(await verifyExecutionReceipt(env, receipt.id)).ok
  ) {
    throw new HostControlError('host_control_persistence_conflict')
  }
  await requireObservationReceipt(env, input, principal)
  await requireExactAudit(
    env,
    await hostAudit(auth, principal, credentialId, input, mapped.id, receipt.id),
  )
  return mapped
}

/**
 * Correlate signed-wrapper digests and immutable receipts only. Flight 2 neither
 * verifies the underlying cryptographic signature nor executes a host action.
 */
export async function recordHostControlFact(
  env: Env,
  auth: AuthContext,
  rawInput: RecordHostControlFactInput,
): Promise<HostControlFact> {
  const input = normalizeInput(rawInput)
  const { principal, credentialId } = await requirePrincipal(env, auth)
  const authority = await requireSeatAuthority(env, auth, principal, input)
  const replay = await factByRequest(env, input.requestId)
  if (replay !== null) {
    return exactReplay(env, auth, replay, input, principal, credentialId)
  }
  assertObservationFresh(input)
  const observationReceipt = await requireObservationReceipt(env, input, principal)
  const prepared = await prepareFreshExecutionReceiptChain(env, auth, [{
    type: 'host_control.requested',
    idempotencyKey: `host-control:${input.idempotencyKey}:requested`,
    claims: requestClaims(input, principal),
    seatId: input.runtimeSeatId,
    seatGeneration: input.processGeneration,
    objectiveId: input.objectiveId,
    flightId: input.flightId,
    taskId: input.taskId,
  }])
  const requestReceipt = prepared.expectedReceipts[0]
  const factId = `host-control:${(await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    requestId: input.requestId,
  }))).slice(0, 48)}`
  const audit = await hostAudit(
    auth,
    principal,
    credentialId,
    input,
    factId,
    requestReceipt.id,
  )
  const mutation = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO host_control_receipts (
      id, tenant, principal_kind, principal_id, credential_id, runtime_seat_id,
      origin, host_id, unit_name, process_generation, action, reason,
      objective_id, flight_id, task_id, request_id, idempotency_key,
      request_signature_digest, observation_signature_digest, observed_result,
      request_receipt_id, observation_receipt_id, observed_at
    )
    SELECT ?, ?, 'agent', ?, ?, ?, 'signed_wrapper', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE julianday(?) <= julianday('now')
       AND julianday(?) >= julianday('now', '-90 seconds')
       AND EXISTS (
         SELECT 1 FROM execution_receipts observation
          WHERE observation.id = ? AND observation.tenant = ?
            AND observation.type = 'host_control.observed'
            AND observation.issuer_kind IN ('adapter', 'runtime')
            AND observation.actor_kind = 'agent' AND observation.actor_id = ?
            AND observation.seat_id = ? AND observation.seat_generation = ?
            AND observation.objective_id IS ? AND observation.flight_id IS ?
            AND observation.task_id IS ? AND observation.claims_json = ?
            AND observation.receipt_hash = ?
       )
       AND EXISTS (
         SELECT 1 FROM execution_receipts request
          WHERE request.id = ? AND request.tenant = ?
            AND request.type = 'host_control.requested'
            AND request.actor_kind = 'agent' AND request.actor_id = ?
            AND request.seat_id = ? AND request.seat_generation = ?
            AND request.objective_id IS ? AND request.flight_id IS ?
            AND request.task_id IS ? AND request.claims_json = ?
            AND request.receipt_hash = ?
       )
       AND EXISTS (
         SELECT 1 FROM members member
          WHERE member.id = ? AND member.tenant = ? AND member.status = 'active'
       )
       AND EXISTS (
         SELECT 1 FROM member_tokens t
          WHERE t.id = ? AND t.tenant = ? AND t.member_id = ?
            AND t.agent_id = ? AND ${TOKEN_LIVE_PREDICATE('?')}
       )
       AND EXISTS (
         SELECT 1
           FROM runtime_seats seat
           JOIN runtime_seat_generations generation
             ON generation.tenant = seat.tenant
            AND generation.runtime_seat_id = seat.id
            AND generation.generation = ?
           JOIN agents agent ON agent.id = seat.agent_id AND agent.status = 'active'
           JOIN agent_member_bindings binding
             ON binding.agent_id = agent.id AND binding.tenant = seat.tenant
            AND binding.member_id = ?
           JOIN memberships membership
             ON membership.agent_id = agent.id AND membership.squad_id = ?
          WHERE seat.id = ? AND seat.tenant = ? AND seat.agent_id = ?
            AND seat.host_id = ? AND seat.state = 'active'
            AND seat.current_generation = ?
            AND CASE membership.capability
              WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
              WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
       )
       AND (
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
       )`,
    bindings: [
      factId, env.TENANT_SLUG, principal.id, credentialId, input.runtimeSeatId,
      input.hostId, input.unitName, input.processGeneration, input.action,
      input.reason, input.objectiveId, input.flightId, input.taskId,
      input.requestId, input.idempotencyKey, input.requestSignatureDigest,
      input.observationSignatureDigest, input.observedResult, requestReceipt.id,
      input.observationReceiptId, input.observedAt,
      input.observedAt, input.observedAt,
      input.observationReceiptId, env.TENANT_SLUG, principal.id,
      input.runtimeSeatId, input.processGeneration, input.objectiveId,
      input.flightId, input.taskId, observationReceipt.claimsJson,
      observationReceipt.receiptHash,
      requestReceipt.id, env.TENANT_SLUG, principal.id, input.runtimeSeatId,
      input.processGeneration, input.objectiveId, input.flightId, input.taskId,
      requestReceipt.claimsJson, requestReceipt.receiptHash,
      principal.memberId, env.TENANT_SLUG,
      credentialId, env.TENANT_SLUG, principal.memberId, principal.id, nowSqlUtc(),
      input.processGeneration, principal.memberId, authority.squadId,
      input.runtimeSeatId, env.TENANT_SLUG, principal.id, input.hostId,
      input.processGeneration,
      principal.authorityMemberId, authority.departmentId, authority.squadId,
      principal.authorityMemberId, authority.squadId,
    ],
    audit,
  })
  await executePreparedExecutionReceiptBatch(env, prepared, [mutation])
  const row = await factByRequest(env, input.requestId)
  if (row === null) throw new HostControlError('host_control_persistence_conflict')
  return exactReplay(env, auth, row, input, principal, credentialId)
}
