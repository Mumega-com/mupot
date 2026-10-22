export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ExecutionReceiptType =
  | 'objective.authorized'
  | 'objective.accepted'
  | 'composition.proposed'
  | 'flight.materialized'
  | 'flight.dependency_linked'
  | 'task.assigned'
  | 'message.accepted'
  | 'seat.leased'
  | 'host.persisted'
  | 'effect.intent'
  | 'runtime.injected'
  | 'runtime.consumed'
  | 'provider.observed'
  | 'provider.reconciled'
  | 'runtime.ack'
  | 'source.ack'
  | 'artifact.stored'
  | 'artifact.retrieved'
  | 'artifact.consumed'
  | 'result.reported'
  | 'gate.verdict'
  | 'task.completed'
  | 'cost.finalized'
  | 'recovery.takeover'
  | 'flight.landed'
  | 'host_control.requested'
  | 'host_control.observed'
  | 'decision.created'
  | 'decision.resolved'

/**
 * Facts the Flight 2 control plane can issue itself. Runtime, host observation,
 * source/provider and artifact storage/retrieval issuers are deferred. `gate.verdict` is issued by the control plane
 * (issuer_kind 'mupot') from the three verdict write paths (writeVerdict, the harness-attested-origin path and the gate:office
 * path, which share buildVerdictStatements), plus the reconcile sweep (seed B4); an independent 'gate' issuer stays deferred. Dependency linking and artifact consumption are control-plane facts.
 */
export type MupotExecutionReceiptType =
  | 'objective.authorized'
  | 'objective.accepted'
  | 'composition.proposed'
  | 'flight.materialized'
  | 'flight.dependency_linked'
  | 'task.assigned'
  | 'message.accepted'
  | 'seat.leased'
  | 'effect.intent'
  | 'artifact.consumed'
  | 'result.reported'
  | 'gate.verdict'
  | 'task.completed'
  | 'cost.finalized'
  | 'recovery.takeover'
  | 'flight.landed'
  | 'host_control.requested'
  | 'decision.created'
  | 'decision.resolved'

export type ExecutionReceiptActorKind = 'member' | 'agent'

export type ExecutionReceiptIssuerKind =
  | 'mupot'
  | 'adapter'
  | 'runtime'
  | 'artifact_service'
  | 'gate'
  | 'provider_verifier'

export interface ExecutionReceiptDraft {
  type: MupotExecutionReceiptType
  idempotencyKey: string
  claims: JsonValue
  seatId?: string | null
  seatGeneration?: number | null
  objectiveId?: string | null
  flightId?: string | null
  taskId?: string | null
  messageId?: string | null
  assignmentEpoch?: number | null
  fencingEpoch?: number | null
  leaseTokenHash?: string | null
}

export interface ExecutionReceipt {
  sequence: number
  id: string
  tenant: string
  type: ExecutionReceiptType
  issuerKind: ExecutionReceiptIssuerKind
  issuerId: string
  actorKind: ExecutionReceiptActorKind
  actorId: string
  seatId: string | null
  seatGeneration: number | null
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
  messageId: string | null
  assignmentEpoch: number | null
  fencingEpoch: number | null
  leaseTokenHash: string | null
  idempotencyKey: string
  claimsJson: string
  canonicalPayload: string
  payloadDigest: string
  predecessorReceiptId: string | null
  predecessorHash: string | null
  receiptHash: string
  serverTimestamp: string
}

export type ExecutionReceiptErrorCode =
  | 'unauthorized_tenant'
  | 'invalid_actor'
  | 'invalid_draft'
  | 'unsupported_receipt_type'
  | 'idempotency_conflict'
  | 'stale_head'
  | 'persistence_conflict'
  | 'integrity_failure'

export class ExecutionReceiptError extends Error {
  readonly name = 'ExecutionReceiptError'

  constructor(readonly code: ExecutionReceiptErrorCode) {
    super(code)
  }
}

export type ExecutionReceiptVerification =
  | { ok: true }
  | {
    ok: false
    error:
      | 'not_found'
      | 'claims_not_canonical'
      | 'payload_digest_mismatch'
      | 'canonical_payload_mismatch'
      | 'receipt_hash_mismatch'
      | 'predecessor_mismatch'
      | 'chain_cycle'
  }
