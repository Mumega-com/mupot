import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
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

const PREPARED_RECEIPT_CHAIN = Symbol('prepared-execution-receipt-chain')

export type PreparedExecutionReceiptFacts = Omit<ExecutionReceipt, 'sequence'>

/** Internal service contract. Use composePreparedExecutionReceiptBatch to assemble it. */
export interface PreparedExecutionReceiptChain {
  readonly [PREPARED_RECEIPT_CHAIN]: true
  readonly tenant: string
  readonly expectedStartingHeadId: string | null
  readonly receiptAndEdgeStatements: readonly D1PreparedStatement[]
  readonly finalHeadStatement: D1PreparedStatement
  readonly expectedReceipts: readonly PreparedExecutionReceiptFacts[]
}

export interface PreparedExecutionReceiptCommit {
  readonly finalSequence: number
  readonly finalReceiptId: string
  readonly finalReceiptHash: string
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
  return Object.freeze({
    [PREPARED_RECEIPT_CHAIN]: true as const,
    tenant,
    expectedStartingHeadId,
    receiptAndEdgeStatements: Object.freeze(receiptAndEdgeStatements),
    finalHeadStatement: prepareFinalHeadCas(
      statementDb,
      tenant,
      finalReceipt,
      expectedStartingHeadId,
    ),
    expectedReceipts: Object.freeze(expectedReceipts),
  })
}

/** The sole supported assembler: domain writes always precede one final head CAS. */
export function composePreparedExecutionReceiptBatch(
  prepared: PreparedExecutionReceiptChain,
  domainStatements: readonly D1PreparedStatement[] = [],
): D1PreparedStatement[] {
  if (prepared[PREPARED_RECEIPT_CHAIN] !== true) {
    throw new ExecutionReceiptError('invalid_draft')
  }
  return [
    ...prepared.receiptAndEdgeStatements,
    ...domainStatements,
    prepared.finalHeadStatement,
  ]
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

export function verifyPreparedExecutionReceiptBatchResult(
  prepared: PreparedExecutionReceiptChain,
  batchResults: readonly D1Result<unknown>[],
): PreparedExecutionReceiptCommit {
  if (prepared[PREPARED_RECEIPT_CHAIN] !== true) {
    throw new ExecutionReceiptError('persistence_conflict')
  }
  const preparedWriteCount = prepared.receiptAndEdgeStatements.length
  if (batchResults.length < preparedWriteCount + 1) {
    throw new ExecutionReceiptError('persistence_conflict')
  }
  try {
    assertBatchWritten(
      batchResults.slice(0, preparedWriteCount),
      'execution_receipt.prepare',
    )
    assertBatchWritten(
      [batchResults[batchResults.length - 1]],
      'execution_receipt.head_cas',
    )
  } catch {
    throw new ExecutionReceiptError('persistence_conflict')
  }

  const finalExpected = prepared.expectedReceipts[prepared.expectedReceipts.length - 1]
  const returned = batchResults[batchResults.length - 1]?.results?.[0] as
    | Partial<ReceiptHeadRow>
    | undefined
  const finalSequence = Number(returned?.sequence)
  if (
    returned === undefined
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

export async function rereadAndVerifyPreparedExecutionReceipts(
  env: Env,
  prepared: PreparedExecutionReceiptChain,
  batchResults: readonly D1Result<unknown>[],
): Promise<ExecutionReceipt[]> {
  if (env.TENANT_SLUG !== prepared.tenant) {
    throw new ExecutionReceiptError('integrity_failure')
  }
  const commit = verifyPreparedExecutionReceiptBatchResult(prepared, batchResults)
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

  let batchResults: D1Result<unknown>[]
  try {
    batchResults = await env.DB.batch(composePreparedExecutionReceiptBatch(prepared))
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
  const persisted = await rereadAndVerifyPreparedExecutionReceipts(env, prepared, batchResults)
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
