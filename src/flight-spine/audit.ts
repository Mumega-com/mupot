import type { Env, AuthContext } from '../types'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import { redactSecretPatterns, redactStructuredDetail } from '../lib/redact'
import { rowsWritten } from '../lib/receipt'
import {
  resolveFlightSpinePrincipal,
  type FlightSpinePrincipal,
} from './objectives'
import type { JsonValue } from './types'

export type MutationAuditPrincipalKind =
  | 'member'
  | 'agent'

export type MutationAuditOrigin =
  | 'mcp'
  | 'rest'
  | 'worker_callback'
  | 'scheduled_job'
  | 'controller'
  | 'admin_ui'
  | 'migration'

export interface MutationAuditInput {
  origin: MutationAuditOrigin
  handler: string
  operation: string
  targetKind: string
  targetId: string
  before?: JsonValue | null
  after?: JsonValue | null
  objectiveId?: string | null
  flightId?: string | null
  taskId?: string | null
  runtimeSeatId?: string | null
  runtimeGeneration?: number | null
  requestId: string
  idempotencyKey?: string | null
  evidence: JsonValue
}

export interface MutationAuditRecord {
  id: string
  tenant: string
  principalKind: MutationAuditPrincipalKind
  principalId: string
  memberId: string
  agentId: string | null
  credentialId: string | null
  runtimeSeatId: string | null
  runtimeGeneration: number | null
  origin: MutationAuditOrigin
  handler: string
  operation: string
  targetKind: string
  targetId: string
  beforeDigest: string | null
  afterDigest: string | null
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
  requestId: string
  idempotencyKey: string | null
  evidence: JsonValue
  recordedAt: string
}

export type MutationAuditErrorCode =
  | 'invalid_audit'
  | 'unauthorized_tenant'
  | 'invalid_actor'
  | 'audit_conflict'
  | 'audit_persistence_conflict'

export class MutationAuditError extends Error {
  readonly name = 'MutationAuditError'

  constructor(readonly code: MutationAuditErrorCode) {
    super(code)
  }
}

interface MutationAuditRow {
  id: string
  tenant: string
  principal_kind: MutationAuditPrincipalKind
  principal_id: string
  member_id: string
  agent_id: string | null
  credential_id: string | null
  runtime_seat_id: string | null
  runtime_generation: number | null
  origin: MutationAuditOrigin
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

interface NormalizedMutationAuditInput {
  origin: MutationAuditOrigin
  handler: string
  operation: string
  targetKind: string
  targetId: string
  beforeDigest: string | null
  afterDigest: string | null
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
  runtimeSeatId: string | null
  runtimeGeneration: number | null
  requestId: string
  idempotencyKey: string | null
  evidence: JsonValue
  evidenceJson: string
}

const AUDIT_ORIGINS = new Set<MutationAuditOrigin>([
  'mcp',
  'rest',
  'worker_callback',
  'scheduled_job',
  'controller',
  'admin_ui',
  'migration',
])

const AUDIT_INPUT_KEYS = new Set([
  'origin',
  'handler',
  'operation',
  'targetKind',
  'targetId',
  'before',
  'after',
  'objectiveId',
  'flightId',
  'taskId',
  'runtimeSeatId',
  'runtimeGeneration',
  'requestId',
  'idempotencyKey',
  'evidence',
])

export function safeBoundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new MutationAuditError('invalid_audit')
  const normalized = value.trim()
  if (
    normalized.length === 0
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || redactSecretPatterns(normalized) !== normalized
  ) {
    throw new MutationAuditError('invalid_audit')
  }
  return normalized
}

export function safeOptionalId(value: unknown, maximum = 2_000): string | null {
  if (value === undefined || value === null) return null
  return safeBoundedText(value, maximum)
}

export function canonicalSafeJson(value: unknown): { value: JsonValue; json: string } {
  try {
    const redacted = redactStructuredDetail(value)
    const json = canonicalJson(redacted)
    return { value: JSON.parse(json) as JsonValue, json }
  } catch (error) {
    if (error instanceof MutationAuditError) throw error
    throw new MutationAuditError('invalid_audit')
  }
}

function assertExactInputKeys(input: object): void {
  const keys = Object.keys(input)
  if (
    !Object.prototype.hasOwnProperty.call(input, 'origin')
    || !Object.prototype.hasOwnProperty.call(input, 'handler')
    || !Object.prototype.hasOwnProperty.call(input, 'operation')
    || !Object.prototype.hasOwnProperty.call(input, 'targetKind')
    || !Object.prototype.hasOwnProperty.call(input, 'targetId')
    || !Object.prototype.hasOwnProperty.call(input, 'requestId')
    || !Object.prototype.hasOwnProperty.call(input, 'evidence')
    || keys.some((key) => !AUDIT_INPUT_KEYS.has(key))
  ) {
    throw new MutationAuditError('invalid_audit')
  }
}

async function optionalFactDigest(value: unknown): Promise<string | null> {
  if (value === undefined || value === null) return null
  const safe = canonicalSafeJson(value)
  return sha256Hex(safe.json)
}

async function normalizeInput(input: MutationAuditInput): Promise<NormalizedMutationAuditInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MutationAuditError('invalid_audit')
  }
  assertExactInputKeys(input)
  if (!AUDIT_ORIGINS.has(input.origin)) throw new MutationAuditError('invalid_audit')
  const runtimeSeatId = safeOptionalId(input.runtimeSeatId, 255)
  const runtimeGeneration = input.runtimeGeneration ?? null
  if (
    (runtimeSeatId === null) !== (runtimeGeneration === null)
    || (runtimeGeneration !== null
      && (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration <= 0))
  ) {
    throw new MutationAuditError('invalid_audit')
  }
  const evidence = canonicalSafeJson(input.evidence)
  return {
    origin: input.origin,
    handler: safeBoundedText(input.handler, 255),
    operation: safeBoundedText(input.operation, 255),
    targetKind: safeBoundedText(input.targetKind, 120),
    targetId: safeBoundedText(input.targetId, 2_000),
    beforeDigest: await optionalFactDigest(input.before),
    afterDigest: await optionalFactDigest(input.after),
    objectiveId: safeOptionalId(input.objectiveId),
    flightId: safeOptionalId(input.flightId),
    taskId: safeOptionalId(input.taskId),
    runtimeSeatId,
    runtimeGeneration,
    requestId: safeBoundedText(input.requestId, 2_000),
    idempotencyKey: safeOptionalId(input.idempotencyKey, 255),
    evidence: evidence.value,
    evidenceJson: evidence.json,
  }
}

function mapRow(row: MutationAuditRow): MutationAuditRecord {
  return {
    id: row.id,
    tenant: row.tenant,
    principalKind: row.principal_kind,
    principalId: row.principal_id,
    memberId: row.member_id,
    agentId: row.agent_id,
    credentialId: row.credential_id,
    runtimeSeatId: row.runtime_seat_id,
    runtimeGeneration: row.runtime_generation === null ? null : Number(row.runtime_generation),
    origin: row.origin,
    handler: row.handler,
    operation: row.operation,
    targetKind: row.target_kind,
    targetId: row.target_id,
    beforeDigest: row.before_digest,
    afterDigest: row.after_digest,
    objectiveId: row.objective_id,
    flightId: row.flight_id,
    taskId: row.task_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    evidence: JSON.parse(row.evidence_json) as JsonValue,
    recordedAt: row.recorded_at,
  }
}

function expectedRecordFacts(
  tenant: string,
  principal: FlightSpinePrincipal,
  credentialId: string | null,
  input: NormalizedMutationAuditInput,
): Omit<MutationAuditRecord, 'id' | 'recordedAt'> {
  return {
    tenant,
    principalKind: principal.kind,
    principalId: principal.id,
    memberId: principal.memberId,
    agentId: principal.agentId,
    credentialId,
    runtimeSeatId: input.runtimeSeatId,
    runtimeGeneration: input.runtimeGeneration,
    origin: input.origin,
    handler: input.handler,
    operation: input.operation,
    targetKind: input.targetKind,
    targetId: input.targetId,
    beforeDigest: input.beforeDigest,
    afterDigest: input.afterDigest,
    objectiveId: input.objectiveId,
    flightId: input.flightId,
    taskId: input.taskId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    evidence: input.evidence,
  }
}

function exactReplay(
  row: MutationAuditRow,
  tenant: string,
  principal: FlightSpinePrincipal,
  credentialId: string | null,
  input: NormalizedMutationAuditInput,
): MutationAuditRecord {
  const mapped = mapRow(row)
  const { id: _id, recordedAt: _recordedAt, ...actual } = mapped
  if (canonicalJson(actual) !== canonicalJson(
    expectedRecordFacts(tenant, principal, credentialId, input),
  )) {
    throw new MutationAuditError('audit_conflict')
  }
  return mapped
}

async function findReplay(
  env: Env,
  input: NormalizedMutationAuditInput,
): Promise<MutationAuditRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, principal_kind, principal_id, member_id, agent_id,
           credential_id, runtime_seat_id, runtime_generation, origin, handler,
           operation, target_kind, target_id, before_digest, after_digest,
           objective_id, flight_id, task_id, request_id, idempotency_key,
           evidence_json, recorded_at
      FROM mutation_audit_entries
     WHERE tenant = ?1 AND request_id = ?2 AND handler = ?3 AND operation = ?4
       AND target_kind = ?5 AND target_id = ?6
  `).bind(
    env.TENANT_SLUG,
    input.requestId,
    input.handler,
    input.operation,
    input.targetKind,
    input.targetId,
  ).first<MutationAuditRow>()
}

function mapPrincipalError(error: unknown): never {
  if (
    error instanceof Error
    && 'code' in error
    && error.code === 'unauthorized_tenant'
  ) {
    throw new MutationAuditError('unauthorized_tenant')
  }
  if (error instanceof Error && 'code' in error && error.code === 'invalid_actor') {
    throw new MutationAuditError('invalid_actor')
  }
  throw error
}

/**
 * Append one standalone mutation fact. Receipt/domain executors keep ownership of
 * their private guard rows and do not call this function, preventing recursive or
 * double audit insertion.
 */
export async function auditMutation(
  env: Env,
  auth: AuthContext,
  rawInput: MutationAuditInput,
): Promise<MutationAuditRecord> {
  const input = await normalizeInput(rawInput)
  let principal: FlightSpinePrincipal
  try {
    principal = await resolveFlightSpinePrincipal(env, auth)
  } catch (error) {
    mapPrincipalError(error)
  }
  const credentialId = safeOptionalId(auth.tokenId, 255)
  const replay = await findReplay(env, input)
  if (replay !== null) {
    return exactReplay(replay, env.TENANT_SLUG, principal, credentialId, input)
  }

  const identityJson = canonicalJson({
    tenant: env.TENANT_SLUG,
    requestId: input.requestId,
    handler: input.handler,
    operation: input.operation,
    targetKind: input.targetKind,
    targetId: input.targetId,
  })
  const id = `audit:${(await sha256Hex(identityJson)).slice(0, 48)}`
  const recordedAt = new Date().toISOString()
  const result = await env.DB.prepare(`
    INSERT INTO mutation_audit_entries (
      id, tenant, principal_kind, principal_id, member_id, agent_id,
      credential_id, runtime_seat_id, runtime_generation, origin, handler,
      operation, target_kind, target_id, before_digest, after_digest,
      objective_id, flight_id, task_id, request_id, idempotency_key,
      evidence_json, recorded_at
    )
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
           ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
     WHERE EXISTS (
       SELECT 1 FROM members member
        WHERE member.id = ?5 AND member.tenant = ?2 AND member.status = 'active'
     )
       AND (
         ?6 IS NULL
         OR EXISTS (
           SELECT 1 FROM agents agent
           JOIN agent_member_bindings binding
             ON binding.agent_id = agent.id AND binding.tenant = ?2
            AND binding.member_id = ?5
          WHERE agent.id = ?6 AND agent.status = 'active'
         )
       )
       AND (
         ?7 IS NULL
         OR EXISTS (
           SELECT 1 FROM member_tokens t
            WHERE t.id = ?7 AND t.tenant = ?2 AND t.member_id = ?5
              AND t.agent_id IS ?6 AND ${TOKEN_LIVE_PREDICATE('?24')}
         )
       )
       AND (
         ?8 IS NULL
         OR EXISTS (
           SELECT 1
             FROM runtime_seats seat
             JOIN runtime_seat_generations generation
               ON generation.tenant = seat.tenant
              AND generation.runtime_seat_id = seat.id
              AND generation.generation = ?9
            WHERE seat.id = ?8 AND seat.tenant = ?2 AND seat.agent_id = ?6
              AND seat.state = 'active' AND seat.current_generation = ?9
         )
       )
  `).bind(
    id,
    env.TENANT_SLUG,
    principal.kind,
    principal.id,
    principal.memberId,
    principal.agentId,
    credentialId,
    input.runtimeSeatId,
    input.runtimeGeneration,
    input.origin,
    input.handler,
    input.operation,
    input.targetKind,
    input.targetId,
    input.beforeDigest,
    input.afterDigest,
    input.objectiveId,
    input.flightId,
    input.taskId,
    input.requestId,
    input.idempotencyKey,
    input.evidenceJson,
    recordedAt,
    nowSqlUtc(),
  ).run()
  if (rowsWritten(result) !== 1) {
    throw new MutationAuditError('audit_persistence_conflict')
  }
  const persisted = await findReplay(env, input)
  if (persisted === null) throw new MutationAuditError('audit_persistence_conflict')
  return exactReplay(persisted, env.TENANT_SLUG, principal, credentialId, input)
}
