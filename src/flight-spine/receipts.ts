import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { AuthContext, Env } from '../types'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import { assertBatchWritten } from '../lib/receipt'
import {
  ExecutionReceiptError,
  type ExecutionReceipt,
  type ExecutionReceiptActorKind,
  type ExecutionReceiptDraft,
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
  'task.assigned',
  'message.accepted',
  'seat.leased',
  'effect.intent',
  'result.reported',
  'task.completed',
  'cost.finalized',
  'recovery.takeover',
  'flight.landed',
  'host_control.requested',
  'decision.created',
  'decision.resolved',
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
  issuer_kind: 'mupot'
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
  issuerId: string
  actor: ReceiptActor
  draft: NormalizedDraft
  predecessorReceiptId: string | null
  predecessorHash: string | null
  serverTimestamp: string
}): string {
  return canonicalJson({
    tenant: input.tenant,
    type: input.type,
    issuer_kind: 'mupot',
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
      issuerId: row.issuer_id,
      actor: { kind: row.actor_kind, id: row.actor_id },
      draft: {
        type: row.type as MupotExecutionReceiptType,
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

  const head = await db.prepare(`
    SELECT sequence, receipt_id, receipt_hash
      FROM execution_receipt_heads
     WHERE tenant = ?1
  `).bind(tenant).first<ReceiptHeadRow>()
  const predecessorReceiptId = head?.receipt_id ?? null
  const predecessorHash = head?.receipt_hash ?? null
  const serverTimestamp = new Date().toISOString()
  const payloadDigest = await sha256Hex(draft.claimsJson)
  const payload = canonicalPayload({
    tenant,
    type: draft.type,
    issuerId,
    actor,
    draft,
    predecessorReceiptId,
    predecessorHash,
    serverTimestamp,
  })
  const receiptHash = await sha256Hex(payload)
  const receiptId = crypto.randomUUID()
  const statements: D1PreparedStatement[] = [
    db.prepare(`
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
      receiptId,
      tenant,
      draft.type,
      issuerId,
      actor.kind,
      actor.id,
      draft.seatId,
      draft.seatGeneration,
      draft.objectiveId,
      draft.flightId,
      draft.taskId,
      draft.messageId,
      draft.assignmentEpoch,
      draft.fencingEpoch,
      draft.leaseTokenHash,
      draft.idempotencyKey,
      draft.claimsJson,
      payload,
      payloadDigest,
      predecessorReceiptId,
      predecessorHash,
      receiptHash,
      serverTimestamp,
    ),
  ]

  if (predecessorReceiptId !== null) {
    statements.push(db.prepare(`
      INSERT INTO execution_receipt_edges (
        id, tenant, from_receipt_id, to_receipt_id, relation, created_at
      ) VALUES (?1, ?2, ?3, ?4, 'predecessor', ?5)
    `).bind(crypto.randomUUID(), tenant, predecessorReceiptId, receiptId, serverTimestamp))
  }

  statements.push(db.prepare(`
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
  `).bind(tenant, receiptId, predecessorReceiptId))

  let batchResults
  try {
    batchResults = await db.batch<ReceiptHeadRow>(statements)
  } catch {
    const racedReplay = await replayOrConflict(db, tenant, issuerId, actor, draft)
    if (racedReplay !== null) return racedReplay
    const currentHead = await db.prepare(`
      SELECT sequence, receipt_id, receipt_hash
        FROM execution_receipt_heads
       WHERE tenant = ?1
    `).bind(tenant).first<ReceiptHeadRow>()
    if ((currentHead?.receipt_id ?? null) !== predecessorReceiptId) {
      throw new ExecutionReceiptError('stale_head')
    }
    throw new ExecutionReceiptError('persistence_conflict')
  }
  try {
    assertBatchWritten(batchResults, 'execution_receipt.append')
  } catch {
    throw new ExecutionReceiptError('persistence_conflict')
  }
  const committedHead = batchResults[batchResults.length - 1]?.results?.[0]
  if (
    committedHead === undefined
    || committedHead.receipt_id !== receiptId
    || committedHead.receipt_hash !== receiptHash
  ) {
    throw new ExecutionReceiptError('persistence_conflict')
  }

  const persisted = await receiptById(db, tenant, receiptId)
  if (persisted === null) throw new ExecutionReceiptError('integrity_failure')
  if (Number(committedHead.sequence) !== Number(persisted.sequence)) {
    throw new ExecutionReceiptError('integrity_failure')
  }
  const verified = await verifyRowChain(db, tenant, persisted)
  if (!verified.ok) throw new ExecutionReceiptError('integrity_failure')
  return mapReceipt(persisted)
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
