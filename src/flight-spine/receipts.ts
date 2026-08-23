import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { AuthContext, Env } from '../types'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import { rowsWritten } from '../lib/receipt'
import {
  ExecutionReceiptError,
  type ExecutionReceipt,
  type ExecutionReceiptActorKind,
  type ExecutionReceiptDraft,
  type ExecutionReceiptIssuerKind,
  type ExecutionReceiptType,
  type ExecutionReceiptVerification,
  type JsonValue,
  type MupotExecutionReceiptType,
} from './types'

const MUPOT_RECEIPT_TYPES = new Set<ExecutionReceiptType>([
  'objective.authorized',
  'objective.accepted',
  'composition.proposed',
  'flight.materialized',
  'flight.dependency_linked',
  'task.assigned',
  'message.accepted',
  'seat.leased',
  'effect.intent',
  'artifact.consumed',
  'result.reported',
  'task.completed',
  'cost.finalized',
  'recovery.takeover',
  'flight.landed',
  'host_control.requested',
  'decision.created',
  'decision.resolved',
])

const ATOMIC_AUDIT_PRINCIPAL_KINDS = new Set<AtomicDomainAuditPrincipalKind>([
  'member',
  'agent',
  'system',
  'controller',
  'admin',
  'migration',
  'fault_injector',
])
const ATOMIC_AUDIT_ORIGINS = new Set<AtomicDomainAuditOrigin>([
  'mcp',
  'rest',
  'worker_callback',
  'scheduled_job',
  'controller',
  'admin_ui',
  'migration',
])

type ReceiptDb = Pick<D1Database, 'prepare' | 'batch'>

interface ReceiptActor {
  kind: ExecutionReceiptActorKind
  id: string
}

interface ReceiptHeadRow {
  sequence: number
  receipt_id: string
  receipt_hash: string
}

interface ReceiptRow {
  sequence: number
  id: string
  tenant: string
  type: ExecutionReceiptType
  issuer_kind: ExecutionReceiptIssuerKind
  issuer_id: string
  actor_kind: ExecutionReceiptActorKind
  actor_id: string
  seat_id: string | null
  seat_generation: number | null
  objective_id: string | null
  flight_id: string | null
  task_id: string | null
  message_id: string | null
  assignment_epoch: number | null
  fencing_epoch: number | null
  lease_token_hash: string | null
  idempotency_key: string
  claims_json: string
  canonical_payload: string
  payload_digest: string
  predecessor_receipt_id: string | null
  predecessor_hash: string | null
  receipt_hash: string
  server_timestamp: string
}

interface NormalizedDraft {
  type: MupotExecutionReceiptType
  idempotencyKey: string
  claims: JsonValue
  claimsJson: string
  seatId: string | null
  seatGeneration: number | null
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
  messageId: string | null
  assignmentEpoch: number | null
  fencingEpoch: number | null
  leaseTokenHash: string | null
}

type CanonicalReceiptDraft = Omit<NormalizedDraft, 'type'> & {
  readonly type: ExecutionReceiptType
}

const PREPARED_RECEIPT_CHAIN = Symbol('prepared-execution-receipt-chain')
const PREPARED_ATOMIC_DOMAIN_MUTATION = Symbol('prepared-atomic-domain-mutation')

export type PreparedExecutionReceiptFacts = Omit<ExecutionReceipt, 'sequence'>

/** Opaque internal metadata handle. D1 statements remain module-private. */
export interface PreparedExecutionReceiptChain {
  readonly [PREPARED_RECEIPT_CHAIN]: true
  readonly tenant: string
  readonly expectedStartingHeadId: string | null
  readonly expectedReceipts: readonly PreparedExecutionReceiptFacts[]
}

export interface PreparedAtomicDomainMutation {
  readonly [PREPARED_ATOMIC_DOMAIN_MUTATION]: true
  readonly expectedAuditId: string
}

export type AtomicDomainAuditPrincipalKind =
  | 'member'
  | 'agent'
  | 'system'
  | 'controller'
  | 'admin'
  | 'migration'
  | 'fault_injector'

export type AtomicDomainAuditOrigin =
  | 'mcp'
  | 'rest'
  | 'worker_callback'
  | 'scheduled_job'
  | 'controller'
  | 'admin_ui'
  | 'migration'

export interface AtomicDomainAuditMetadata {
  readonly expectedAuditId: string
  readonly principalKind: AtomicDomainAuditPrincipalKind
  readonly principalId: string
  readonly memberId?: string | null
  readonly agentId?: string | null
  readonly credentialId?: string | null
  readonly runtimeSeatId?: string | null
  readonly runtimeGeneration?: number | null
  readonly origin: AtomicDomainAuditOrigin
  readonly handler: string
  readonly operation: string
  readonly targetKind: string
  readonly targetId: string
  readonly beforeDigest?: string | null
  readonly afterDigest?: string | null
  readonly objectiveId?: string | null
  readonly flightId?: string | null
  readonly taskId?: string | null
  readonly requestId: string
  readonly idempotencyKey?: string | null
  readonly evidence: JsonValue
}

export interface AtomicDomainAuditEntry {
  readonly id: string
  readonly tenant: string
  readonly principal_kind: AtomicDomainAuditPrincipalKind
  readonly principal_id: string
  readonly member_id: string | null
  readonly agent_id: string | null
  readonly credential_id: string | null
  readonly runtime_seat_id: string | null
  readonly runtime_generation: number | null
  readonly origin: AtomicDomainAuditOrigin
  readonly handler: string
  readonly operation: string
  readonly target_kind: string
  readonly target_id: string
  readonly before_digest: string | null
  readonly after_digest: string | null
  readonly objective_id: string | null
  readonly flight_id: string | null
  readonly task_id: string | null
  readonly request_id: string
  readonly idempotency_key: string | null
  readonly evidence_json: string
  readonly recorded_at: string
}

export type AtomicDomainSqlBinding = string | number | boolean | null

export interface AtomicDomainMutationInput {
  readonly sql: string
  readonly bindings?: readonly AtomicDomainSqlBinding[]
  readonly audit: AtomicDomainAuditMetadata
}

interface PreparedExecutionReceiptCommit {
  readonly finalSequence: number
  readonly finalReceiptId: string
  readonly finalReceiptHash: string
}

interface PreparedExecutionReceiptPieces {
  readonly receiptAndEdgeStatements: readonly D1PreparedStatement[]
  readonly finalHeadStatement: D1PreparedStatement
}

interface PreparedAtomicDomainMutationPieces {
  readonly database: D1Database
  readonly mutationStatement: D1PreparedStatement
  readonly audit: NormalizedAtomicDomainAuditMetadata
}

interface ResolvedAtomicDomainMutation {
  readonly handle: PreparedAtomicDomainMutation
  readonly pieces: PreparedAtomicDomainMutationPieces
}

interface NormalizedAtomicDomainAuditMetadata {
  readonly expectedAuditId: string
  readonly principalKind: AtomicDomainAuditPrincipalKind
  readonly principalId: string
  readonly memberId: string | null
  readonly agentId: string | null
  readonly credentialId: string | null
  readonly runtimeSeatId: string | null
  readonly runtimeGeneration: number | null
  readonly origin: AtomicDomainAuditOrigin
  readonly handler: string
  readonly operation: string
  readonly targetKind: string
  readonly targetId: string
  readonly beforeDigest: string | null
  readonly afterDigest: string | null
  readonly objectiveId: string | null
  readonly flightId: string | null
  readonly taskId: string | null
  readonly requestId: string
  readonly idempotencyKey: string | null
  readonly evidenceJson: string
  readonly recordedAt: string
}

const PREPARED_RECEIPT_PIECES = new WeakMap<
  PreparedExecutionReceiptChain,
  PreparedExecutionReceiptPieces
>()
const PREPARED_DOMAIN_PIECES = new WeakMap<
  PreparedAtomicDomainMutation,
  PreparedAtomicDomainMutationPieces
>()

const RECEIPT_COLUMNS = `
  sequence, id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
  seat_id, seat_generation, objective_id, flight_id, task_id, message_id,
  assignment_epoch, fencing_epoch, lease_token_hash, idempotency_key,
  claims_json, canonical_payload, payload_digest, predecessor_receipt_id,
  predecessor_hash, receipt_hash, server_timestamp
`

function primaryDb(env: Env): ReceiptDb {
  return typeof env.DB.withSession === 'function' ? env.DB.withSession('first-primary') : env.DB
}

function optionalId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const normalized = value.trim()
  if (normalized === '') throw new ExecutionReceiptError('invalid_draft')
  return normalized
}

function optionalInteger(
  value: number | null | undefined,
  minimum: number,
): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isInteger(value) || value < minimum) {
    throw new ExecutionReceiptError('invalid_draft')
  }
  return value
}

function boundedRequiredText(value: string, maximum: number): string {
  if (typeof value !== 'string') throw new ExecutionReceiptError('invalid_draft')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new ExecutionReceiptError('invalid_draft')
  }
  return normalized
}

function optionalSha256(value: string | null | undefined): string | null {
  const normalized = optionalId(value)
  if (normalized !== null && !/^[0-9a-f]{64}$/.test(normalized)) {
    throw new ExecutionReceiptError('invalid_draft')
  }
  return normalized
}

function normalizeAtomicDomainAuditMetadata(
  input: AtomicDomainAuditMetadata,
): NormalizedAtomicDomainAuditMetadata {
  if (
    !ATOMIC_AUDIT_PRINCIPAL_KINDS.has(input.principalKind)
    || !ATOMIC_AUDIT_ORIGINS.has(input.origin)
  ) {
    throw new ExecutionReceiptError('invalid_draft')
  }
  let evidenceJson: string
  try {
    evidenceJson = canonicalJson(input.evidence)
  } catch {
    throw new ExecutionReceiptError('invalid_draft')
  }
  return Object.freeze({
    expectedAuditId: boundedRequiredText(input.expectedAuditId, 255),
    principalKind: input.principalKind,
    principalId: boundedRequiredText(input.principalId, 255),
    memberId: optionalId(input.memberId),
    agentId: optionalId(input.agentId),
    credentialId: optionalId(input.credentialId),
    runtimeSeatId: optionalId(input.runtimeSeatId),
    runtimeGeneration: optionalInteger(input.runtimeGeneration, 1),
    origin: input.origin,
    handler: boundedRequiredText(input.handler, 255),
    operation: boundedRequiredText(input.operation, 255),
    targetKind: boundedRequiredText(input.targetKind, 120),
    targetId: boundedRequiredText(input.targetId, 2000),
    beforeDigest: optionalSha256(input.beforeDigest),
    afterDigest: optionalSha256(input.afterDigest),
    objectiveId: optionalId(input.objectiveId),
    flightId: optionalId(input.flightId),
    taskId: optionalId(input.taskId),
    requestId: boundedRequiredText(input.requestId, 2000),
    idempotencyKey: optionalId(input.idempotencyKey),
    evidenceJson,
    recordedAt: new Date().toISOString(),
  })
}

function normalizeAtomicDomainMutationInput(input: AtomicDomainMutationInput): {
  readonly sql: string
  readonly bindings: readonly AtomicDomainSqlBinding[]
  readonly audit: NormalizedAtomicDomainAuditMetadata
} {
  if (typeof input !== 'object' || input === null) {
    throw new ExecutionReceiptError('invalid_draft')
  }
  if (typeof input.sql !== 'string') throw new ExecutionReceiptError('invalid_draft')
  const sql = input.sql.trim()
  if (
    sql.length === 0
    || sql.length > 65_536
    || sql.includes(';')
    || sql.includes('--')
    || sql.includes('/*')
    || sql.includes('*/')
  ) {
    throw new ExecutionReceiptError('invalid_draft')
  }
  const firstToken = /^[A-Za-z]+/.exec(sql)?.[0]?.toUpperCase()
  if (firstToken !== 'INSERT' && firstToken !== 'UPDATE' && firstToken !== 'DELETE') {
    throw new ExecutionReceiptError('invalid_draft')
  }

  const rawBindings = input.bindings ?? []
  if (!Array.isArray(rawBindings)) throw new ExecutionReceiptError('invalid_draft')
  const bindings: AtomicDomainSqlBinding[] = []
  for (const value of rawBindings) {
    if (
      value !== null
      && typeof value !== 'string'
      && typeof value !== 'number'
      && typeof value !== 'boolean'
    ) {
      throw new ExecutionReceiptError('invalid_draft')
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ExecutionReceiptError('invalid_draft')
    }
    bindings.push(value)
  }
  return Object.freeze({
    sql,
    bindings: Object.freeze(bindings),
    audit: normalizeAtomicDomainAuditMetadata(input.audit),
  })
}

function normalizeDraft(draft: ExecutionReceiptDraft): NormalizedDraft {
  if (!MUPOT_RECEIPT_TYPES.has(draft.type as ExecutionReceiptType)) {
    throw new ExecutionReceiptError('unsupported_receipt_type')
  }
  const idempotencyKey = typeof draft.idempotencyKey === 'string'
    ? draft.idempotencyKey.trim()
    : ''
  if (idempotencyKey.length === 0 || idempotencyKey.length > 255) {
    throw new ExecutionReceiptError('invalid_draft')
  }

  let claimsJson: string
  try {
    claimsJson = canonicalJson(draft.claims)
  } catch {
    throw new ExecutionReceiptError('invalid_draft')
  }

  const seatId = optionalId(draft.seatId)
  const seatGeneration = optionalInteger(draft.seatGeneration, 1)
  if ((seatId === null) !== (seatGeneration === null)) {
    throw new ExecutionReceiptError('invalid_draft')
  }
  const assignmentEpoch = optionalInteger(draft.assignmentEpoch, 0)
  const fencingEpoch = optionalInteger(draft.fencingEpoch, 1)
  const leaseTokenHash = optionalId(draft.leaseTokenHash)
  if (leaseTokenHash !== null && !/^[0-9a-f]{64}$/.test(leaseTokenHash)) {
    throw new ExecutionReceiptError('invalid_draft')
  }

  return {
    type: draft.type,
    idempotencyKey,
    claims: JSON.parse(claimsJson) as JsonValue,
    claimsJson,
    seatId,
    seatGeneration,
    objectiveId: optionalId(draft.objectiveId),
    flightId: optionalId(draft.flightId),
    taskId: optionalId(draft.taskId),
    messageId: optionalId(draft.messageId),
    assignmentEpoch,
    fencingEpoch,
    leaseTokenHash,
  }
}

function actorFromAuth(env: Env, auth: AuthContext): ReceiptActor {
  if (auth.tenant !== env.TENANT_SLUG) {
    throw new ExecutionReceiptError('unauthorized_tenant')
  }
  const boundAgentId = auth.boundAgentId?.trim()
  if (boundAgentId) return { kind: 'agent', id: boundAgentId }
  const memberId = auth.memberId?.trim() || auth.userId.trim()
  if (!memberId) throw new ExecutionReceiptError('invalid_actor')
  return { kind: 'member', id: memberId }
}

function canonicalPayload(input: {
  tenant: string
  type: ExecutionReceiptType
  issuerKind: ExecutionReceiptIssuerKind
  issuerId: string
  actor: ReceiptActor
  draft: CanonicalReceiptDraft
  predecessorReceiptId: string | null
  predecessorHash: string | null
  serverTimestamp: string
}): string {
  return canonicalJson({
    tenant: input.tenant,
    type: input.type,
    issuer_kind: input.issuerKind,
    issuer_id: input.issuerId,
    actor_kind: input.actor.kind,
    actor_id: input.actor.id,
    seat_id: input.draft.seatId,
    seat_generation: input.draft.seatGeneration,
    objective_id: input.draft.objectiveId,
    flight_id: input.draft.flightId,
    task_id: input.draft.taskId,
    message_id: input.draft.messageId,
    assignment_epoch: input.draft.assignmentEpoch,
    fencing_epoch: input.draft.fencingEpoch,
    lease_token_hash: input.draft.leaseTokenHash,
    idempotency_key: input.draft.idempotencyKey,
    claims: input.draft.claims,
    predecessor_receipt_id: input.predecessorReceiptId,
    predecessor_hash: input.predecessorHash,
    server_timestamp: input.serverTimestamp,
  })
}

function prepareReceiptInsert(
  db: ReceiptDb,
  receipt: PreparedExecutionReceiptFacts,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO execution_receipts (
      id, tenant, type, issuer_kind, issuer_id, actor_kind, actor_id,
      seat_id, seat_generation, objective_id, flight_id, task_id, message_id,
      assignment_epoch, fencing_epoch, lease_token_hash, idempotency_key,
      claims_json, canonical_payload, payload_digest, predecessor_receipt_id,
      predecessor_hash, receipt_hash, server_timestamp
    ) VALUES (
      ?1, ?2, ?3, 'mupot', ?4, ?5, ?6,
      ?7, ?8, ?9, ?10, ?11, ?12,
      ?13, ?14, ?15, ?16,
      ?17, ?18, ?19, ?20,
      ?21, ?22, ?23
    )
  `).bind(
    receipt.id,
    receipt.tenant,
    receipt.type,
    receipt.issuerId,
    receipt.actorKind,
    receipt.actorId,
    receipt.seatId,
    receipt.seatGeneration,
    receipt.objectiveId,
    receipt.flightId,
    receipt.taskId,
    receipt.messageId,
    receipt.assignmentEpoch,
    receipt.fencingEpoch,
    receipt.leaseTokenHash,
    receipt.idempotencyKey,
    receipt.claimsJson,
    receipt.canonicalPayload,
    receipt.payloadDigest,
    receipt.predecessorReceiptId,
    receipt.predecessorHash,
    receipt.receiptHash,
    receipt.serverTimestamp,
  )
}

function preparePredecessorEdge(
  db: ReceiptDb,
  tenant: string,
  fromReceiptId: string,
  toReceiptId: string,
  serverTimestamp: string,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO execution_receipt_edges (
      id, tenant, from_receipt_id, to_receipt_id, relation, created_at
    ) VALUES (?1, ?2, ?3, ?4, 'predecessor', ?5)
  `).bind(crypto.randomUUID(), tenant, fromReceiptId, toReceiptId, serverTimestamp)
}

function prepareFinalHeadCas(
  db: ReceiptDb,
  tenant: string,
  finalReceipt: PreparedExecutionReceiptFacts,
  expectedStartingHeadId: string | null,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO execution_receipt_heads (
      tenant, sequence, receipt_id, receipt_hash, updated_at
    )
    SELECT tenant, sequence, id, receipt_hash, server_timestamp
      FROM execution_receipts
     WHERE tenant = ?1 AND id = ?2
    ON CONFLICT (tenant) DO UPDATE SET
      sequence = CASE
        WHEN execution_receipt_heads.receipt_id IS ?3 THEN excluded.sequence
        ELSE execution_receipt_heads.sequence
      END,
      receipt_id = CASE
        WHEN execution_receipt_heads.receipt_id IS ?3 THEN excluded.receipt_id
        ELSE execution_receipt_heads.receipt_id
      END,
      receipt_hash = CASE
        WHEN execution_receipt_heads.receipt_id IS ?3 THEN excluded.receipt_hash
        ELSE execution_receipt_heads.receipt_hash
      END,
      updated_at = CASE
        WHEN execution_receipt_heads.receipt_id IS ?3 THEN excluded.updated_at
        ELSE execution_receipt_heads.updated_at
      END
    RETURNING sequence, receipt_id, receipt_hash
  `).bind(tenant, finalReceipt.id, expectedStartingHeadId)
}

function prepareAtomicDomainAuditGuard(
  db: ReceiptDb,
  tenant: string,
  audit: NormalizedAtomicDomainAuditMetadata,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO mutation_audit_entries (
      id, tenant, principal_kind, principal_id, member_id, agent_id,
      credential_id, runtime_seat_id, runtime_generation, origin, handler,
      operation, target_kind, target_id, before_digest, after_digest,
      objective_id, flight_id, task_id, request_id, idempotency_key,
      evidence_json, recorded_at
    ) VALUES (
      ?1, ?2,
      CASE WHEN changes() = 1 THEN ?3 ELSE 'invalid_atomic_change_count' END,
      ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
      ?17, ?18, ?19, ?20, ?21, ?22, ?23
    )
    RETURNING id, tenant
  `).bind(
    audit.expectedAuditId,
    tenant,
    audit.principalKind,
    audit.principalId,
    audit.memberId,
    audit.agentId,
    audit.credentialId,
    audit.runtimeSeatId,
    audit.runtimeGeneration,
    audit.origin,
    audit.handler,
    audit.operation,
    audit.targetKind,
    audit.targetId,
    audit.beforeDigest,
    audit.afterDigest,
    audit.objectiveId,
    audit.flightId,
    audit.taskId,
    audit.requestId,
    audit.idempotencyKey,
    audit.evidenceJson,
    audit.recordedAt,
  )
}

/**
 * Prepare a fresh-only receipt chain for composition with domain statements.
 * Existing or repeated idempotency keys are conflicts; replay remains an
 * appendExecutionReceipt concern.
 */
export async function prepareFreshExecutionReceiptChain(
  env: Env,
  auth: AuthContext,
  inputs: readonly ExecutionReceiptDraft[],
): Promise<PreparedExecutionReceiptChain> {
  if (inputs.length === 0) throw new ExecutionReceiptError('invalid_draft')
  const tenant = env.TENANT_SLUG
  const actor = actorFromAuth(env, auth)
  const issuerId = `mupot:${tenant}`
  const drafts = inputs.map(normalizeDraft)
  const seenKeys = new Set<string>()
  for (const draft of drafts) {
    if (seenKeys.has(draft.idempotencyKey)) {
      throw new ExecutionReceiptError('idempotency_conflict')
    }
    seenKeys.add(draft.idempotencyKey)
  }

  const readDb = primaryDb(env)
  const statementDb: ReceiptDb = env.DB
  for (const draft of drafts) {
    if (await receiptByIdempotencyKey(readDb, tenant, issuerId, draft.idempotencyKey)) {
      throw new ExecutionReceiptError('idempotency_conflict')
    }
  }

  const head = await readDb.prepare(`
    SELECT sequence, receipt_id, receipt_hash
      FROM execution_receipt_heads
     WHERE tenant = ?1
  `).bind(tenant).first<ReceiptHeadRow>()
  const expectedStartingHeadId = head?.receipt_id ?? null
  let predecessorReceiptId = expectedStartingHeadId
  let predecessorHash = head?.receipt_hash ?? null
  const serverTimestamp = new Date().toISOString()
  const receiptAndEdgeStatements: D1PreparedStatement[] = []
  const expectedReceipts: PreparedExecutionReceiptFacts[] = []

  for (const draft of drafts) {
    const payloadDigest = await sha256Hex(draft.claimsJson)
    const payload = canonicalPayload({
      tenant,
      type: draft.type,
      issuerKind: 'mupot',
      issuerId,
      actor,
      draft,
      predecessorReceiptId,
      predecessorHash,
      serverTimestamp,
    })
    const receiptHash = await sha256Hex(payload)
    const receipt: PreparedExecutionReceiptFacts = {
      id: crypto.randomUUID(),
      tenant,
      type: draft.type,
      issuerKind: 'mupot',
      issuerId,
      actorKind: actor.kind,
      actorId: actor.id,
      seatId: draft.seatId,
      seatGeneration: draft.seatGeneration,
      objectiveId: draft.objectiveId,
      flightId: draft.flightId,
      taskId: draft.taskId,
      messageId: draft.messageId,
      assignmentEpoch: draft.assignmentEpoch,
      fencingEpoch: draft.fencingEpoch,
      leaseTokenHash: draft.leaseTokenHash,
      idempotencyKey: draft.idempotencyKey,
      claimsJson: draft.claimsJson,
      canonicalPayload: payload,
      payloadDigest,
      predecessorReceiptId,
      predecessorHash,
      receiptHash,
      serverTimestamp,
    }
    receiptAndEdgeStatements.push(prepareReceiptInsert(statementDb, receipt))
    if (predecessorReceiptId !== null) {
      receiptAndEdgeStatements.push(preparePredecessorEdge(
        statementDb,
        tenant,
        predecessorReceiptId,
        receipt.id,
        serverTimestamp,
      ))
    }
    expectedReceipts.push(Object.freeze(receipt))
    predecessorReceiptId = receipt.id
    predecessorHash = receipt.receiptHash
  }

  const finalReceipt = expectedReceipts[expectedReceipts.length - 1]
  const frozenExpectedReceipts = Object.freeze(expectedReceipts)
  const handle: PreparedExecutionReceiptChain = Object.freeze({
    [PREPARED_RECEIPT_CHAIN]: true as const,
    tenant,
    expectedStartingHeadId,
    expectedReceipts: frozenExpectedReceipts,
  })
  PREPARED_RECEIPT_PIECES.set(handle, {
    receiptAndEdgeStatements: Object.freeze(receiptAndEdgeStatements),
    finalHeadStatement: prepareFinalHeadCas(
      statementDb,
      tenant,
      finalReceipt,
      expectedStartingHeadId,
    ),
  })
  return handle
}

/**
 * Validate and internally prepare one direct, single-statement DML mutation.
 * Values arrive only through D1 bindings; callers cannot supply a prepared
 * statement, executable guard, identifier, or table name separately.
 */
export function prepareAuditedDomainMutation(
  db: D1Database,
  input: AtomicDomainMutationInput,
): PreparedAtomicDomainMutation {
  const normalized = normalizeAtomicDomainMutationInput(input)
  const unbound = db.prepare(normalized.sql)
  const mutationStatement = normalized.bindings.length === 0
    ? unbound
    : unbound.bind(...normalized.bindings)
  const handle: PreparedAtomicDomainMutation = Object.freeze({
    [PREPARED_ATOMIC_DOMAIN_MUTATION]: true as const,
    expectedAuditId: normalized.audit.expectedAuditId,
  })
  PREPARED_DOMAIN_PIECES.set(handle, {
    database: db,
    mutationStatement,
    audit: normalized.audit,
  })
  return handle
}

function mapReceipt(row: ReceiptRow): ExecutionReceipt {
  return {
    sequence: Number(row.sequence),
    id: row.id,
    tenant: row.tenant,
    type: row.type,
    issuerKind: row.issuer_kind,
    issuerId: row.issuer_id,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    seatId: row.seat_id,
    seatGeneration: row.seat_generation === null ? null : Number(row.seat_generation),
    objectiveId: row.objective_id,
    flightId: row.flight_id,
    taskId: row.task_id,
    messageId: row.message_id,
    assignmentEpoch: row.assignment_epoch === null ? null : Number(row.assignment_epoch),
    fencingEpoch: row.fencing_epoch === null ? null : Number(row.fencing_epoch),
    leaseTokenHash: row.lease_token_hash,
    idempotencyKey: row.idempotency_key,
    claimsJson: row.claims_json,
    canonicalPayload: row.canonical_payload,
    payloadDigest: row.payload_digest,
    predecessorReceiptId: row.predecessor_receipt_id,
    predecessorHash: row.predecessor_hash,
    receiptHash: row.receipt_hash,
    serverTimestamp: row.server_timestamp,
  }
}

async function receiptById(
  db: ReceiptDb,
  tenant: string,
  id: string,
): Promise<ReceiptRow | null> {
  return db.prepare(`
    SELECT ${RECEIPT_COLUMNS}
      FROM execution_receipts
     WHERE tenant = ?1 AND id = ?2
  `).bind(tenant, id).first<ReceiptRow>()
}

async function receiptByIdempotencyKey(
  db: ReceiptDb,
  tenant: string,
  issuerId: string,
  idempotencyKey: string,
): Promise<ReceiptRow | null> {
  return db.prepare(`
    SELECT ${RECEIPT_COLUMNS}
      FROM execution_receipts
     WHERE tenant = ?1
       AND issuer_kind = 'mupot'
       AND issuer_id = ?2
       AND idempotency_key = ?3
  `).bind(tenant, issuerId, idempotencyKey).first<ReceiptRow>()
}

function sameRequest(row: ReceiptRow, actor: ReceiptActor, draft: NormalizedDraft): boolean {
  return row.type === draft.type
    && row.actor_kind === actor.kind
    && row.actor_id === actor.id
    && row.seat_id === draft.seatId
    && (row.seat_generation === null ? null : Number(row.seat_generation)) === draft.seatGeneration
    && row.objective_id === draft.objectiveId
    && row.flight_id === draft.flightId
    && row.task_id === draft.taskId
    && row.message_id === draft.messageId
    && (row.assignment_epoch === null ? null : Number(row.assignment_epoch)) === draft.assignmentEpoch
    && (row.fencing_epoch === null ? null : Number(row.fencing_epoch)) === draft.fencingEpoch
    && row.lease_token_hash === draft.leaseTokenHash
    && row.claims_json === draft.claimsJson
}

async function verifyRowChain(
  db: ReceiptDb,
  tenant: string,
  initial: ReceiptRow,
): Promise<ExecutionReceiptVerification> {
  const visited = new Set<string>()
  const chain: ReceiptRow[] = []
  let row: ReceiptRow | null = initial
  while (row !== null) {
    if (visited.has(row.id)) return { ok: false, error: 'chain_cycle' }
    visited.add(row.id)
    chain.push(row)
    if (row.predecessor_receipt_id === null) break
    row = await receiptById(db, tenant, row.predecessor_receipt_id)
    if (row === null) return { ok: false, error: 'predecessor_mismatch' }
  }

  for (let index = 0; index < chain.length; index += 1) {
    row = chain[index]
    const predecessor = chain[index + 1] ?? null
    if (row.predecessor_receipt_id === null) {
      if (row.predecessor_hash !== null || predecessor !== null) {
        return { ok: false, error: 'predecessor_mismatch' }
      }
    } else if (
      row.predecessor_hash === null
      || predecessor === null
      || predecessor.id !== row.predecessor_receipt_id
      || predecessor.receipt_hash !== row.predecessor_hash
      || Number(predecessor.sequence) >= Number(row.sequence)
    ) {
      return { ok: false, error: 'predecessor_mismatch' }
    }

    let claims: JsonValue
    let claimsJson: string
    try {
      claims = JSON.parse(row.claims_json) as JsonValue
      claimsJson = canonicalJson(claims)
    } catch {
      return { ok: false, error: 'claims_not_canonical' }
    }
    if (claimsJson !== row.claims_json) return { ok: false, error: 'claims_not_canonical' }
    if (await sha256Hex(claimsJson) !== row.payload_digest) {
      return { ok: false, error: 'payload_digest_mismatch' }
    }

    const expectedPayload = canonicalPayload({
      tenant: row.tenant,
      type: row.type,
      issuerKind: row.issuer_kind,
      issuerId: row.issuer_id,
      actor: { kind: row.actor_kind, id: row.actor_id },
      draft: {
        type: row.type,
        idempotencyKey: row.idempotency_key,
        claims,
        claimsJson,
        seatId: row.seat_id,
        seatGeneration: row.seat_generation === null ? null : Number(row.seat_generation),
        objectiveId: row.objective_id,
        flightId: row.flight_id,
        taskId: row.task_id,
        messageId: row.message_id,
        assignmentEpoch: row.assignment_epoch === null ? null : Number(row.assignment_epoch),
        fencingEpoch: row.fencing_epoch === null ? null : Number(row.fencing_epoch),
        leaseTokenHash: row.lease_token_hash,
      },
      predecessorReceiptId: row.predecessor_receipt_id,
      predecessorHash: row.predecessor_hash,
      serverTimestamp: row.server_timestamp,
    })
    if (expectedPayload !== row.canonical_payload) {
      return { ok: false, error: 'canonical_payload_mismatch' }
    }
    if (await sha256Hex(expectedPayload) !== row.receipt_hash) {
      return { ok: false, error: 'receipt_hash_mismatch' }
    }
  }
  return { ok: true }
}

function requireExactSingleWrite(result: D1Result<unknown> | undefined): void {
  if (result === undefined || rowsWritten(result) !== 1) {
    throw new ExecutionReceiptError('persistence_conflict')
  }
}

function resolveAuditedDomainMutations(
  env: Env,
  domainMutations: readonly PreparedAtomicDomainMutation[],
  allowEmpty: boolean,
): ResolvedAtomicDomainMutation[] {
  if (!allowEmpty && domainMutations.length === 0) {
    throw new ExecutionReceiptError('invalid_draft')
  }
  const resolved: ResolvedAtomicDomainMutation[] = []
  const auditIds = new Set<string>()
  for (const handle of domainMutations) {
    const pieces = PREPARED_DOMAIN_PIECES.get(handle)
    if (
      pieces === undefined
      || pieces.database !== env.DB
      || auditIds.has(handle.expectedAuditId)
    ) {
      throw new ExecutionReceiptError('invalid_draft')
    }
    auditIds.add(handle.expectedAuditId)
    resolved.push({ handle, pieces })
  }
  return resolved
}

function prepareAuditedDomainStatements(
  env: Env,
  tenant: string,
  domainMutations: readonly ResolvedAtomicDomainMutation[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  for (const domain of domainMutations) {
    statements.push(
      domain.pieces.mutationStatement,
      prepareAtomicDomainAuditGuard(env.DB, tenant, domain.pieces.audit),
    )
  }
  return statements
}

function verifyAuditedDomainBatchResults(
  tenant: string,
  domainMutations: readonly ResolvedAtomicDomainMutation[],
  batchResults: readonly D1Result<unknown>[],
  startIndex: number,
): number {
  for (let index = 0; index < domainMutations.length; index += 1) {
    const mutationResultIndex = startIndex + (index * 2)
    const guardResultIndex = mutationResultIndex + 1
    requireExactSingleWrite(batchResults[mutationResultIndex])
    requireExactSingleWrite(batchResults[guardResultIndex])
    const guardRows = batchResults[guardResultIndex].results as Record<string, unknown>[]
    if (
      guardRows.length !== 1
      || guardRows[0]?.id !== domainMutations[index].handle.expectedAuditId
      || guardRows[0]?.tenant !== tenant
    ) {
      throw new ExecutionReceiptError('persistence_conflict')
    }
  }
  return startIndex + (domainMutations.length * 2)
}

function expectedAtomicDomainAuditEntry(
  tenant: string,
  audit: NormalizedAtomicDomainAuditMetadata,
): AtomicDomainAuditEntry {
  return {
    id: audit.expectedAuditId,
    tenant,
    principal_kind: audit.principalKind,
    principal_id: audit.principalId,
    member_id: audit.memberId,
    agent_id: audit.agentId,
    credential_id: audit.credentialId,
    runtime_seat_id: audit.runtimeSeatId,
    runtime_generation: audit.runtimeGeneration,
    origin: audit.origin,
    handler: audit.handler,
    operation: audit.operation,
    target_kind: audit.targetKind,
    target_id: audit.targetId,
    before_digest: audit.beforeDigest,
    after_digest: audit.afterDigest,
    objective_id: audit.objectiveId,
    flight_id: audit.flightId,
    task_id: audit.taskId,
    request_id: audit.requestId,
    idempotency_key: audit.idempotencyKey,
    evidence_json: audit.evidenceJson,
    recorded_at: audit.recordedAt,
  }
}

async function rereadAuditedDomainMutations(
  env: Env,
  tenant: string,
  domainMutations: readonly ResolvedAtomicDomainMutation[],
): Promise<AtomicDomainAuditEntry[]> {
  const readDb = primaryDb(env)
  const audits: AtomicDomainAuditEntry[] = []
  for (const domain of domainMutations) {
    const auditRow = await readDb.prepare(`
      SELECT id, tenant, principal_kind, principal_id, member_id, agent_id,
             credential_id, runtime_seat_id, runtime_generation, origin,
             handler, operation, target_kind, target_id, before_digest,
             after_digest, objective_id, flight_id, task_id, request_id,
             idempotency_key, evidence_json, recorded_at
        FROM mutation_audit_entries
       WHERE tenant = ?1 AND id = ?2
    `).bind(tenant, domain.handle.expectedAuditId).first<AtomicDomainAuditEntry>()
    const expected = expectedAtomicDomainAuditEntry(tenant, domain.pieces.audit)
    if (auditRow === null || canonicalJson(auditRow) !== canonicalJson(expected)) {
      throw new ExecutionReceiptError('integrity_failure')
    }
    audits.push(auditRow)
  }
  return audits
}

function verifyPreparedExecutionReceiptBatchResult(
  prepared: PreparedExecutionReceiptChain,
  receiptPieces: PreparedExecutionReceiptPieces,
  domainMutations: readonly ResolvedAtomicDomainMutation[],
  batchResults: readonly D1Result<unknown>[],
): PreparedExecutionReceiptCommit {
  const receiptWriteCount = receiptPieces.receiptAndEdgeStatements.length
  const expectedResultCount = receiptWriteCount + (domainMutations.length * 2) + 1
  if (batchResults.length !== expectedResultCount) {
    throw new ExecutionReceiptError('persistence_conflict')
  }

  for (let index = 0; index < receiptWriteCount; index += 1) {
    requireExactSingleWrite(batchResults[index])
  }
  const finalResultIndex = verifyAuditedDomainBatchResults(
    prepared.tenant,
    domainMutations,
    batchResults,
    receiptWriteCount,
  )

  const finalExpected = prepared.expectedReceipts[prepared.expectedReceipts.length - 1]
  const finalResult = batchResults[finalResultIndex]
  requireExactSingleWrite(finalResult)
  const finalRows = finalResult.results as Record<string, unknown>[]
  const returned = finalRows[0] as
    | Partial<ReceiptHeadRow>
    | undefined
  const finalSequence = Number(returned?.sequence)
  if (
    finalRows.length !== 1
    || returned === undefined
    || !Number.isInteger(finalSequence)
    || finalSequence <= 0
    || returned.receipt_id !== finalExpected.id
    || returned.receipt_hash !== finalExpected.receiptHash
  ) {
    throw new ExecutionReceiptError('persistence_conflict')
  }
  return {
    finalSequence,
    finalReceiptId: finalExpected.id,
    finalReceiptHash: finalExpected.receiptHash,
  }
}

async function rereadAndVerifyPreparedExecutionReceipts(
  env: Env,
  prepared: PreparedExecutionReceiptChain,
  commit: PreparedExecutionReceiptCommit,
): Promise<ExecutionReceipt[]> {
  if (env.TENANT_SLUG !== prepared.tenant) {
    throw new ExecutionReceiptError('integrity_failure')
  }
  const db = primaryDb(env)
  const rows: ReceiptRow[] = []
  const receipts: ExecutionReceipt[] = []
  for (const expected of prepared.expectedReceipts) {
    const row = await receiptById(db, prepared.tenant, expected.id)
    if (row === null) throw new ExecutionReceiptError('integrity_failure')
    const receipt = mapReceipt(row)
    const actualFacts = { ...receipt } as Record<string, unknown>
    delete actualFacts.sequence
    if (canonicalJson(actualFacts) !== canonicalJson(expected)) {
      throw new ExecutionReceiptError('integrity_failure')
    }
    rows.push(row)
    receipts.push(receipt)
  }

  const finalRow = rows[rows.length - 1]
  if (Number(finalRow.sequence) !== commit.finalSequence) {
    throw new ExecutionReceiptError('integrity_failure')
  }
  const verified = await verifyRowChain(db, prepared.tenant, finalRow)
  if (!verified.ok) throw new ExecutionReceiptError('integrity_failure')
  return receipts
}

async function executePreparedExecutionReceiptBatchInternal(
  env: Env,
  prepared: PreparedExecutionReceiptChain,
  domainMutations: readonly PreparedAtomicDomainMutation[],
  allowNoDomain: boolean,
): Promise<ExecutionReceipt[]> {
  const receiptPieces = PREPARED_RECEIPT_PIECES.get(prepared)
  if (
    receiptPieces === undefined
    || prepared.tenant !== env.TENANT_SLUG
  ) {
    throw new ExecutionReceiptError('invalid_draft')
  }

  const resolvedDomains = resolveAuditedDomainMutations(env, domainMutations, allowNoDomain)

  const statements: D1PreparedStatement[] = [
    ...receiptPieces.receiptAndEdgeStatements,
    ...prepareAuditedDomainStatements(env, prepared.tenant, resolvedDomains),
  ]
  statements.push(receiptPieces.finalHeadStatement)

  const batchResults = await env.DB.batch(statements)
  const commit = verifyPreparedExecutionReceiptBatchResult(
    prepared,
    receiptPieces,
    resolvedDomains,
    batchResults,
  )

  await rereadAuditedDomainMutations(env, prepared.tenant, resolvedDomains)
  return rereadAndVerifyPreparedExecutionReceipts(env, prepared, commit)
}

/**
 * Execute one opaque receipt chain with one or more audited domain statements.
 * Task-specific builders supply strict one-row statements plus bounded audit
 * metadata; the executor owns the adjacent changes()-based CHECK guard.
 */
export function executePreparedExecutionReceiptBatch(
  env: Env,
  prepared: PreparedExecutionReceiptChain,
  domainMutations: readonly PreparedAtomicDomainMutation[],
): Promise<ExecutionReceipt[]> {
  return executePreparedExecutionReceiptBatchInternal(env, prepared, domainMutations, false)
}

/**
 * Execute one or more opaque audited domain projections without creating or
 * advancing any execution receipt, chain head, or semantic receipt edge.
 */
export async function executeAuditedDomainMutations(
  env: Env,
  domainMutations: readonly PreparedAtomicDomainMutation[],
): Promise<AtomicDomainAuditEntry[]> {
  const resolved = resolveAuditedDomainMutations(env, domainMutations, false)
  const statements = prepareAuditedDomainStatements(env, env.TENANT_SLUG, resolved)
  const batchResults = await env.DB.batch(statements)
  if (batchResults.length !== statements.length) {
    throw new ExecutionReceiptError('persistence_conflict')
  }
  const nextResultIndex = verifyAuditedDomainBatchResults(
    env.TENANT_SLUG,
    resolved,
    batchResults,
    0,
  )
  if (nextResultIndex !== batchResults.length) {
    throw new ExecutionReceiptError('persistence_conflict')
  }
  return rereadAuditedDomainMutations(env, env.TENANT_SLUG, resolved)
}

async function replayOrConflict(
  db: ReceiptDb,
  tenant: string,
  issuerId: string,
  actor: ReceiptActor,
  draft: NormalizedDraft,
): Promise<ExecutionReceipt | null> {
  const replay = await receiptByIdempotencyKey(db, tenant, issuerId, draft.idempotencyKey)
  if (replay === null) return null
  if (!sameRequest(replay, actor, draft)) {
    throw new ExecutionReceiptError('idempotency_conflict')
  }
  const verified = await verifyRowChain(db, tenant, replay)
  if (!verified.ok) throw new ExecutionReceiptError('integrity_failure')
  return mapReceipt(replay)
}

export async function appendExecutionReceipt(
  env: Env,
  auth: AuthContext,
  input: ExecutionReceiptDraft,
): Promise<ExecutionReceipt> {
  const tenant = env.TENANT_SLUG
  const actor = actorFromAuth(env, auth)
  const draft = normalizeDraft(input)
  const issuerId = `mupot:${tenant}`
  const db = primaryDb(env)

  const replay = await replayOrConflict(db, tenant, issuerId, actor, draft)
  if (replay !== null) return replay

  let prepared: PreparedExecutionReceiptChain
  try {
    prepared = await prepareFreshExecutionReceiptChain(env, auth, [input])
  } catch (error) {
    if (error instanceof ExecutionReceiptError && error.code === 'idempotency_conflict') {
      const racedReplay = await replayOrConflict(
        primaryDb(env),
        tenant,
        issuerId,
        actor,
        draft,
      )
      if (racedReplay !== null) return racedReplay
    }
    throw error
  }

  let persisted: ExecutionReceipt[]
  try {
    persisted = await executePreparedExecutionReceiptBatchInternal(env, prepared, [], true)
  } catch {
    const recoveryDb = primaryDb(env)
    const racedReplay = await replayOrConflict(recoveryDb, tenant, issuerId, actor, draft)
    if (racedReplay !== null) return racedReplay
    const currentHead = await recoveryDb.prepare(`
      SELECT sequence, receipt_id, receipt_hash
        FROM execution_receipt_heads
       WHERE tenant = ?1
    `).bind(tenant).first<ReceiptHeadRow>()
    if ((currentHead?.receipt_id ?? null) !== prepared.expectedStartingHeadId) {
      throw new ExecutionReceiptError('stale_head')
    }
    throw new ExecutionReceiptError('persistence_conflict')
  }
  if (persisted.length !== 1) throw new ExecutionReceiptError('integrity_failure')
  return persisted[0]
}

export async function getExecutionReceipt(
  env: Env,
  id: string,
): Promise<ExecutionReceipt | null> {
  const row = await receiptById(primaryDb(env), env.TENANT_SLUG, id)
  return row === null ? null : mapReceipt(row)
}

export async function verifyExecutionReceipt(
  env: Env,
  id: string,
): Promise<ExecutionReceiptVerification> {
  const db = primaryDb(env)
  const row = await receiptById(db, env.TENANT_SLUG, id)
  if (row === null) return { ok: false, error: 'not_found' }
  return verifyRowChain(db, env.TENANT_SLUG, row)
}

export type {
  ExecutionReceipt,
  ExecutionReceiptDraft,
  ExecutionReceiptVerification,
} from './types'
export { ExecutionReceiptError } from './types'
