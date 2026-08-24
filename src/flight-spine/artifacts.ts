import type { AuthContext, Env } from '../types'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import {
  executeAuditedProjectionMutations,
  getExecutionReceipt,
  prepareAuditedProjectionMutation,
  verifyExecutionReceipt,
  type AtomicDomainAuditMetadata,
} from './receipts'
import type { ExecutionReceipt } from './types'
import {
  flightSpineAudit,
  requireFlightSpineSquadAuthority,
  resolveFlightSpinePrincipal,
  type FlightSpinePrincipal,
} from './objectives'

export type ArtifactVisibility = 'tenant' | 'gate' | 'public'

export interface RecordArtifactMetadataInput {
  artifactId: string
  producingAssignmentId: string
  storageReceiptId: string
  objectKey: string
  digest: string
  sizeBytes: number
  visibility: ArtifactVisibility
  retentionUntil: string
  repositoryUrl?: string | null
  commitSha?: string | null
  repositoryPath?: string | null
}

export interface ArtifactMetadata {
  id: string
  tenant: string
  flightId: string
  producingAssignmentId: string
  producingTaskId: string
  producingAgentId: string
  producingRuntimeSeatId: string
  assignmentEpoch: number
  objectKey: string
  digest: string
  sizeBytes: number
  visibility: ArtifactVisibility
  retentionUntil: string
  repositoryUrl: string | null
  commitSha: string | null
  repositoryPath: string | null
  storageReceiptId: string
  createdAt: string
}

export interface RecordArtifactRetrievalInput {
  artifactId: string
  retrievalReceiptId: string
  recomputedDigest: string
}

export interface ArtifactRetrieval {
  id: string
  tenant: string
  artifactId: string
  verifierPrincipalKind: 'agent'
  verifierPrincipalId: string
  verifierAgentId: string
  verifierRuntimeSeatId: string
  recomputedDigest: string
  retrievalReceiptId: string
  retrievedAt: string
}

export type ArtifactErrorCode =
  | 'invalid_artifact'
  | 'retention_too_short'
  | 'storage_receipt_not_found'
  | 'storage_receipt_invalid'
  | 'producer_scope_mismatch'
  | 'artifact_not_found'
  | 'artifact_conflict'
  | 'artifact_audit_invalid'
  | 'retrieval_receipt_not_found'
  | 'retrieval_receipt_invalid'
  | 'digest_mismatch'
  | 'verifier_not_independent'
  | 'verifier_scope_mismatch'
  | 'retrieval_conflict'
  | 'retrieval_audit_invalid'

export class ArtifactError extends Error {
  readonly name = 'ArtifactError'

  constructor(readonly code: ArtifactErrorCode) {
    super(code)
  }
}

interface ArtifactRow {
  id: string
  tenant: string
  flight_id: string
  producing_assignment_id: string
  producing_task_id: string
  producing_agent_id: string
  producing_runtime_seat_id: string
  assignment_epoch: number
  object_key: string
  digest: string
  size_bytes: number
  visibility: ArtifactVisibility
  retention_until: string
  repository_url: string | null
  commit_sha: string | null
  repository_path: string | null
  storage_receipt_id: string
  created_at: string
}

interface ArtifactRetrievalRow {
  id: string
  tenant: string
  artifact_id: string
  verifier_principal_kind: 'agent'
  verifier_principal_id: string
  verifier_agent_id: string
  verifier_runtime_seat_id: string
  recomputed_digest: string
  retrieval_receipt_id: string
  retrieved_at: string
}

interface ProjectionAuditRow {
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

interface ProducerContext {
  flightId: string
  taskId: string
  agentId: string
  runtimeSeatId: string
  assignmentEpoch: number
  seatGeneration: number
  squadId: string
}

interface VerifierContext {
  flightId: string
  taskId: string
  agentId: string
  runtimeSeatId: string
  assignmentEpoch: number
  seatGeneration: number
  squadId: string
}

interface NormalizedArtifactInput {
  artifactId: string
  producingAssignmentId: string
  storageReceiptId: string
  objectKey: string
  digest: string
  sizeBytes: number
  visibility: ArtifactVisibility
  retentionUntil: string
  repositoryUrl: string | null
  commitSha: string | null
  repositoryPath: string | null
}

interface NormalizedRetrievalInput {
  artifactId: string
  retrievalReceiptId: string
  recomputedDigest: string
}

const ARTIFACT_COLUMNS = `
  id, tenant, flight_id, producing_assignment_id, producing_task_id,
  producing_agent_id, producing_runtime_seat_id, assignment_epoch,
  object_key, digest, size_bytes, visibility, retention_until,
  repository_url, commit_sha, repository_path, storage_receipt_id, created_at
`

const RETRIEVAL_COLUMNS = `
  id, tenant, artifact_id, verifier_principal_kind, verifier_principal_id,
  verifier_agent_id, verifier_runtime_seat_id, recomputed_digest,
  retrieval_receipt_id, retrieved_at
`

function boundedText(value: unknown, maximum = 255): string {
  if (typeof value !== 'string') throw new ArtifactError('invalid_artifact')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new ArtifactError('invalid_artifact')
  }
  return normalized
}

function optionalCanonicalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ArtifactError('invalid_artifact')
  }
  return value
}

function canonicalGitHubRemote(value: unknown): string | null {
  const remote = optionalCanonicalText(value, 2_048)
  if (remote === null) return null
  if (remote.includes('%')) throw new ArtifactError('invalid_artifact')
  const match = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)$/.exec(remote)
  if (!match) throw new ArtifactError('invalid_artifact')
  const owner = match[1]
  const rawRepository = match[2]
  const repository = rawRepository.endsWith('.git')
    ? rawRepository.slice(0, -4)
    : rawRepository
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)
    || owner.includes('--')
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/.test(repository)
  ) {
    throw new ArtifactError('invalid_artifact')
  }
  return `https://github.com/${owner}/${repository}`
}

function canonicalRepositoryPath(value: unknown): string | null {
  const path = optionalCanonicalText(value, 2_048)
  if (path === null) return null
  if (
    path.startsWith('/')
    || path.endsWith('/')
    || path.includes('\\')
    || path.includes('%')
  ) {
    throw new ArtifactError('invalid_artifact')
  }
  const segments = path.split('/')
  if (segments.some((segment) => (
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || !/^[A-Za-z0-9._-]+$/.test(segment)
  ))) {
    throw new ArtifactError('invalid_artifact')
  }
  return path
}

function assertInputKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): void {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || keys.some((key) => !allowed.has(key))
  ) {
    throw new ArtifactError('invalid_artifact')
  }
}

function canonicalDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ArtifactError('invalid_artifact')
  }
  return value
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new ArtifactError('invalid_artifact')
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ArtifactError('invalid_artifact')
  }
  return value
}

function normalizeArtifactInput(input: RecordArtifactMetadataInput): NormalizedArtifactInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ArtifactError('invalid_artifact')
  }
  assertInputKeys(input, [
    'artifactId',
    'producingAssignmentId',
    'storageReceiptId',
    'objectKey',
    'digest',
    'sizeBytes',
    'visibility',
    'retentionUntil',
  ], ['repositoryUrl', 'commitSha', 'repositoryPath'])
  const digest = canonicalDigest(input.digest)
  const objectKey = boundedText(input.objectKey, 1_024)
  if (objectKey !== `sha256/${digest.slice(0, 2)}/${digest}`) {
    throw new ArtifactError('invalid_artifact')
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new ArtifactError('invalid_artifact')
  }
  if (!['tenant', 'gate', 'public'].includes(input.visibility)) {
    throw new ArtifactError('invalid_artifact')
  }
  const repositoryUrl = canonicalGitHubRemote(input.repositoryUrl)
  const commitSha = optionalCanonicalText(input.commitSha, 64)
  const repositoryPath = canonicalRepositoryPath(input.repositoryPath)
  const repositoryParts = [repositoryUrl, commitSha, repositoryPath]
  if (repositoryParts.some((value) => value === null) && repositoryParts.some((value) => value !== null)) {
    throw new ArtifactError('invalid_artifact')
  }
  if (commitSha !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitSha)) {
    throw new ArtifactError('invalid_artifact')
  }
  return {
    artifactId: boundedText(input.artifactId),
    producingAssignmentId: boundedText(input.producingAssignmentId),
    storageReceiptId: boundedText(input.storageReceiptId),
    objectKey,
    digest,
    sizeBytes: input.sizeBytes,
    visibility: input.visibility,
    retentionUntil: canonicalTimestamp(input.retentionUntil),
    repositoryUrl,
    commitSha,
    repositoryPath,
  }
}

function normalizeRetrievalInput(input: RecordArtifactRetrievalInput): NormalizedRetrievalInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ArtifactError('invalid_artifact')
  }
  assertInputKeys(input, ['artifactId', 'retrievalReceiptId', 'recomputedDigest'], [])
  return {
    artifactId: boundedText(input.artifactId),
    retrievalReceiptId: boundedText(input.retrievalReceiptId),
    recomputedDigest: canonicalDigest(input.recomputedDigest),
  }
}

function metadataClaims(input: NormalizedArtifactInput): Record<string, unknown> {
  return {
    artifactId: input.artifactId,
    producingAssignmentId: input.producingAssignmentId,
    objectKey: input.objectKey,
    digest: input.digest,
    sizeBytes: input.sizeBytes,
    visibility: input.visibility,
    retentionUntil: input.retentionUntil,
    repositoryUrl: input.repositoryUrl,
    commitSha: input.commitSha,
    repositoryPath: input.repositoryPath,
  }
}

function retrievalClaims(input: NormalizedRetrievalInput): Record<string, unknown> {
  return {
    artifactId: input.artifactId,
    recomputedDigest: input.recomputedDigest,
  }
}

function mapArtifact(row: ArtifactRow): ArtifactMetadata {
  return {
    id: row.id,
    tenant: row.tenant,
    flightId: row.flight_id,
    producingAssignmentId: row.producing_assignment_id,
    producingTaskId: row.producing_task_id,
    producingAgentId: row.producing_agent_id,
    producingRuntimeSeatId: row.producing_runtime_seat_id,
    assignmentEpoch: Number(row.assignment_epoch),
    objectKey: row.object_key,
    digest: row.digest,
    sizeBytes: Number(row.size_bytes),
    visibility: row.visibility,
    retentionUntil: row.retention_until,
    repositoryUrl: row.repository_url,
    commitSha: row.commit_sha,
    repositoryPath: row.repository_path,
    storageReceiptId: row.storage_receipt_id,
    createdAt: row.created_at,
  }
}

function mapRetrieval(row: ArtifactRetrievalRow): ArtifactRetrieval {
  return {
    id: row.id,
    tenant: row.tenant,
    artifactId: row.artifact_id,
    verifierPrincipalKind: row.verifier_principal_kind,
    verifierPrincipalId: row.verifier_principal_id,
    verifierAgentId: row.verifier_agent_id,
    verifierRuntimeSeatId: row.verifier_runtime_seat_id,
    recomputedDigest: row.recomputed_digest,
    retrievalReceiptId: row.retrieval_receipt_id,
    retrievedAt: row.retrieved_at,
  }
}

function expectedProjectionAudit(
  tenant: string,
  audit: AtomicDomainAuditMetadata,
): Omit<ProjectionAuditRow, 'recorded_at'> {
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

async function requireProjectionAudit(
  env: Env,
  audit: AtomicDomainAuditMetadata,
  errorCode: 'artifact_audit_invalid' | 'retrieval_audit_invalid',
): Promise<void> {
  const row = await env.DB.prepare(`
    SELECT id, tenant, principal_kind, principal_id, member_id, agent_id,
           credential_id, runtime_seat_id, runtime_generation, origin,
           handler, operation, target_kind, target_id, before_digest,
           after_digest, objective_id, flight_id, task_id, request_id,
           idempotency_key, evidence_json, recorded_at
      FROM mutation_audit_entries
     WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, audit.expectedAuditId).first<ProjectionAuditRow>()
  if (!row || typeof row.recorded_at !== 'string' || row.recorded_at.trim() === '') {
    throw new ArtifactError(errorCode)
  }
  const actual = { ...row } as Partial<ProjectionAuditRow>
  delete actual.recorded_at
  if (canonicalJson(actual) !== canonicalJson(expectedProjectionAudit(env.TENANT_SLUG, audit))) {
    throw new ArtifactError(errorCode)
  }
}

async function requireReceipt(
  env: Env,
  id: string,
  expectedType: 'artifact.stored' | 'artifact.retrieved',
): Promise<ExecutionReceipt> {
  const receipt = await getExecutionReceipt(env, id)
  if (!receipt) {
    throw new ArtifactError(expectedType === 'artifact.stored'
      ? 'storage_receipt_not_found'
      : 'retrieval_receipt_not_found')
  }
  const verified = await verifyExecutionReceipt(env, id)
  if (
    !verified.ok
    || receipt.type !== expectedType
    || receipt.issuerKind !== 'artifact_service'
  ) {
    throw new ArtifactError(expectedType === 'artifact.stored'
      ? 'storage_receipt_invalid'
      : 'retrieval_receipt_invalid')
  }
  return receipt
}

function requireRetentionHorizon(retentionUntil: string): void {
  const minimum = Date.now() + (30 * 24 * 60 * 60 * 1_000)
  if (Date.parse(retentionUntil) < minimum) {
    throw new ArtifactError('retention_too_short')
  }
}

async function requireProducerContext(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  input: NormalizedArtifactInput,
  receipt: ExecutionReceipt,
): Promise<ProducerContext> {
  if (receipt.claimsJson !== canonicalJson(metadataClaims(input))) {
    throw new ArtifactError('storage_receipt_invalid')
  }
  if (
    principal.agentId === null
    || receipt.actorKind !== 'agent'
    || receipt.actorId !== principal.agentId
    || receipt.flightId === null
    || receipt.taskId === null
    || receipt.assignmentEpoch === null
    || receipt.seatId === null
    || receipt.seatGeneration === null
  ) {
    throw new ArtifactError('producer_scope_mismatch')
  }
  const row = await env.DB.prepare(`
    SELECT assignment.flight_id, assignment.task_id, assignment.agent_id,
           assignment.runtime_seat_id, assignment.assignment_epoch,
           seat.current_generation, task.squad_id
      FROM flight_task_assignments assignment
      JOIN flight_lanes lane
        ON lane.id = assignment.lane_id AND lane.tenant = assignment.tenant
       AND lane.flight_id = assignment.flight_id AND lane.task_id = assignment.task_id
       AND lane.assignment_epoch = assignment.assignment_epoch
       AND lane.agent_id = assignment.agent_id
       AND lane.runtime_seat_id = assignment.runtime_seat_id
      JOIN tasks task
        ON task.id = assignment.task_id
       AND task.assignment_epoch = assignment.assignment_epoch
       AND task.assignee_agent_id = assignment.agent_id
      JOIN agents agent ON agent.id = assignment.agent_id AND agent.status = 'active'
      JOIN runtime_seats seat
        ON seat.id = assignment.runtime_seat_id AND seat.tenant = assignment.tenant
       AND seat.agent_id = assignment.agent_id AND seat.state = 'active'
      JOIN runtime_seat_generations generation
        ON generation.tenant = seat.tenant AND generation.runtime_seat_id = seat.id
       AND generation.generation = seat.current_generation
     WHERE assignment.tenant = ?1 AND assignment.id = ?2
       AND assignment.flight_id = ?3 AND assignment.task_id = ?4
       AND assignment.assignment_epoch = ?5 AND assignment.agent_id = ?6
       AND assignment.runtime_seat_id = ?7 AND seat.current_generation = ?8
  `).bind(
    env.TENANT_SLUG,
    input.producingAssignmentId,
    receipt.flightId,
    receipt.taskId,
    receipt.assignmentEpoch,
    receipt.actorId,
    receipt.seatId,
    receipt.seatGeneration,
  ).first<{
    flight_id: string
    task_id: string
    agent_id: string
    runtime_seat_id: string
    assignment_epoch: number
    current_generation: number
    squad_id: string
  }>()
  if (!row) throw new ArtifactError('producer_scope_mismatch')
  await requireFlightSpineSquadAuthority(env, auth, principal, row.squad_id, 'member')
  return {
    flightId: row.flight_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    runtimeSeatId: row.runtime_seat_id,
    assignmentEpoch: Number(row.assignment_epoch),
    seatGeneration: Number(row.current_generation),
    squadId: row.squad_id,
  }
}

async function artifactCandidates(
  env: Env,
  input: NormalizedArtifactInput,
): Promise<ArtifactRow[]> {
  const result = await env.DB.prepare(`
    SELECT ${ARTIFACT_COLUMNS}
      FROM artifacts
     WHERE tenant = ?1
       AND (id = ?2 OR storage_receipt_id = ?3 OR object_key = ?4)
     ORDER BY id
  `).bind(
    env.TENANT_SLUG,
    input.artifactId,
    input.storageReceiptId,
    input.objectKey,
  ).all<ArtifactRow>()
  return result.results ?? []
}

function artifactMatches(
  row: ArtifactRow,
  tenant: string,
  input: NormalizedArtifactInput,
  context: ProducerContext,
  createdAt: string,
): boolean {
  return row.id === input.artifactId
    && row.tenant === tenant
    && row.flight_id === context.flightId
    && row.producing_assignment_id === input.producingAssignmentId
    && row.producing_task_id === context.taskId
    && row.producing_agent_id === context.agentId
    && row.producing_runtime_seat_id === context.runtimeSeatId
    && Number(row.assignment_epoch) === context.assignmentEpoch
    && row.object_key === input.objectKey
    && row.digest === input.digest
    && Number(row.size_bytes) === input.sizeBytes
    && row.visibility === input.visibility
    && row.retention_until === input.retentionUntil
    && row.repository_url === input.repositoryUrl
    && row.commit_sha === input.commitSha
    && row.repository_path === input.repositoryPath
    && row.storage_receipt_id === input.storageReceiptId
    && row.created_at === createdAt
}

async function replayArtifactOrConflict(
  env: Env,
  input: NormalizedArtifactInput,
  context: ProducerContext,
  createdAt: string,
  audit: AtomicDomainAuditMetadata,
): Promise<ArtifactMetadata | null> {
  const rows = await artifactCandidates(env, input)
  if (rows.length === 0) return null
  if (
    rows.length !== 1
    || !artifactMatches(rows[0], env.TENANT_SLUG, input, context, createdAt)
  ) {
    throw new ArtifactError('artifact_conflict')
  }
  await requireProjectionAudit(env, audit, 'artifact_audit_invalid')
  return mapArtifact(rows[0])
}

function legacyAdmin(auth: AuthContext): number {
  return auth.capabilities === undefined && (auth.role === 'owner' || auth.role === 'admin')
    ? 1
    : 0
}

async function artifactAuditDigest(
  input: NormalizedArtifactInput,
  context: ProducerContext,
  receipt: ExecutionReceipt,
): Promise<string> {
  return sha256Hex(canonicalJson({
    id: input.artifactId,
    flightId: context.flightId,
    producingAssignmentId: input.producingAssignmentId,
    producingTaskId: context.taskId,
    producingAgentId: context.agentId,
    producingRuntimeSeatId: context.runtimeSeatId,
    assignmentEpoch: context.assignmentEpoch,
    objectKey: input.objectKey,
    digest: input.digest,
    sizeBytes: input.sizeBytes,
    visibility: input.visibility,
    retentionUntil: input.retentionUntil,
    repositoryUrl: input.repositoryUrl,
    commitSha: input.commitSha,
    repositoryPath: input.repositoryPath,
    storageReceiptId: receipt.id,
  }))
}

async function artifactAuditMetadata(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  input: NormalizedArtifactInput,
  context: ProducerContext,
  receipt: ExecutionReceipt,
): Promise<AtomicDomainAuditMetadata> {
  const requestDigest = await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    artifactId: input.artifactId,
    storageReceiptId: input.storageReceiptId,
  }))
  return flightSpineAudit(auth, principal, {
    expectedAuditId: `audit:artifact:${requestDigest}`,
    handler: 'flight_spine.record_artifact_metadata',
    operation: 'insert',
    targetKind: 'artifact',
    targetId: input.artifactId,
    afterDigest: await artifactAuditDigest(input, context, receipt),
    objectiveId: receipt.objectiveId,
    flightId: context.flightId,
    taskId: context.taskId,
    requestId: input.storageReceiptId,
    idempotencyKey: `artifact:${requestDigest}`,
    runtimeSeatId: context.runtimeSeatId,
    runtimeGeneration: context.seatGeneration,
    evidence: {
      storageReceiptId: input.storageReceiptId,
      digest: input.digest,
      metadataOnly: true,
    },
  })
}

/**
 * Project immutable metadata from a cryptographically verified artifact-service
 * storage receipt. This records no bytes and never changes a task or result.
 */
export async function recordArtifactMetadata(
  env: Env,
  auth: AuthContext,
  rawInput: RecordArtifactMetadataInput,
): Promise<ArtifactMetadata> {
  const input = normalizeArtifactInput(rawInput)
  requireRetentionHorizon(input.retentionUntil)
  const receipt = await requireReceipt(env, input.storageReceiptId, 'artifact.stored')
  const principal = await resolveFlightSpinePrincipal(env, auth)
  const context = await requireProducerContext(env, auth, principal, input, receipt)
  const audit = await artifactAuditMetadata(env, auth, principal, input, context, receipt)
  const replay = await replayArtifactOrConflict(
    env,
    input,
    context,
    receipt.serverTimestamp,
    audit,
  )
  if (replay) return replay

  const claimsJson = canonicalJson(metadataClaims(input))
  const mutation = prepareAuditedProjectionMutation(env.DB, {
    sql: `INSERT INTO artifacts (
      id, tenant, flight_id, producing_assignment_id, producing_task_id,
      producing_agent_id, producing_runtime_seat_id, assignment_epoch,
      object_key, digest, size_bytes, visibility, retention_until,
      repository_url, commit_sha, repository_path, storage_receipt_id, created_at
    )
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
           ?14, ?15, ?16, ?17, ?18
     WHERE julianday(?13) IS NOT NULL
       AND julianday(?13) >= julianday('now', '+30 days')
       AND EXISTS (
         SELECT 1
           FROM flight_task_assignments assignment
           JOIN flight_lanes lane
             ON lane.id = assignment.lane_id AND lane.tenant = assignment.tenant
            AND lane.flight_id = assignment.flight_id AND lane.task_id = assignment.task_id
            AND lane.assignment_epoch = assignment.assignment_epoch
            AND lane.agent_id = assignment.agent_id
            AND lane.runtime_seat_id = assignment.runtime_seat_id
           JOIN tasks task
             ON task.id = assignment.task_id
            AND task.assignment_epoch = assignment.assignment_epoch
            AND task.assignee_agent_id = assignment.agent_id
           JOIN agents agent ON agent.id = assignment.agent_id AND agent.status = 'active'
           JOIN runtime_seats seat
             ON seat.id = assignment.runtime_seat_id AND seat.tenant = assignment.tenant
            AND seat.agent_id = assignment.agent_id AND seat.state = 'active'
            AND seat.current_generation = ?19
           JOIN runtime_seat_generations generation
             ON generation.tenant = seat.tenant AND generation.runtime_seat_id = seat.id
            AND generation.generation = seat.current_generation
           JOIN memberships membership
             ON membership.agent_id = agent.id AND membership.squad_id = task.squad_id
           JOIN agent_member_bindings binding
             ON binding.tenant = assignment.tenant AND binding.agent_id = agent.id
            AND binding.member_id = ?25
           JOIN members member
             ON member.id = binding.member_id AND member.tenant = assignment.tenant
            AND member.status = 'active'
          WHERE assignment.tenant = ?2 AND assignment.id = ?4
            AND assignment.flight_id = ?3 AND assignment.task_id = ?5
            AND assignment.assignment_epoch = ?8 AND assignment.agent_id = ?6
            AND assignment.runtime_seat_id = ?7 AND task.squad_id = ?26
            AND CASE membership.capability
              WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
              WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
       )
       AND EXISTS (
         SELECT 1 FROM execution_receipts receipt
          WHERE receipt.id = ?17 AND receipt.tenant = ?2
            AND receipt.type = 'artifact.stored'
            AND receipt.issuer_kind = 'artifact_service'
            AND receipt.actor_kind = 'agent' AND receipt.actor_id = ?6
            AND receipt.seat_id = ?7 AND receipt.seat_generation = ?19
            AND receipt.objective_id IS ?22 AND receipt.flight_id = ?3
            AND receipt.task_id = ?5 AND receipt.assignment_epoch = ?8
            AND receipt.claims_json = ?24 AND receipt.receipt_hash = ?23
       )
       AND EXISTS (
         SELECT 1 FROM members authority_member
          WHERE authority_member.id = ?27 AND authority_member.tenant = ?2
            AND authority_member.status = 'active'
       )
       AND (
         ?28 = 1
         OR EXISTS (
           SELECT 1 FROM capabilities capability
             JOIN squads squad ON squad.id = ?26
            WHERE capability.member_id = ?27
              AND (capability.scope_type = 'org'
                OR (capability.scope_type = 'department' AND capability.scope_id = squad.department_id)
                OR (capability.scope_type = 'squad' AND capability.scope_id = squad.id))
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
         OR EXISTS (
           SELECT 1 FROM channel_capability_grants capability
            WHERE capability.member_id = ?27 AND capability.squad_id = ?26
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
       )`,
    bindings: [
      input.artifactId,
      env.TENANT_SLUG,
      context.flightId,
      input.producingAssignmentId,
      context.taskId,
      context.agentId,
      context.runtimeSeatId,
      context.assignmentEpoch,
      input.objectKey,
      input.digest,
      input.sizeBytes,
      input.visibility,
      input.retentionUntil,
      input.repositoryUrl,
      input.commitSha,
      input.repositoryPath,
      input.storageReceiptId,
      receipt.serverTimestamp,
      context.seatGeneration,
      null,
      null,
      receipt.objectiveId,
      receipt.receiptHash,
      claimsJson,
      principal.memberId,
      context.squadId,
      principal.authorityMemberId,
      legacyAdmin(auth),
    ],
    audit,
  })

  await executeAuditedProjectionMutations(env, [mutation])
  const persisted = await replayArtifactOrConflict(
    env,
    input,
    context,
    receipt.serverTimestamp,
    audit,
  )
  if (!persisted) throw new ArtifactError('artifact_conflict')
  return persisted
}

async function artifactById(env: Env, artifactId: string): Promise<ArtifactRow | null> {
  return env.DB.prepare(`
    SELECT ${ARTIFACT_COLUMNS}
      FROM artifacts WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, artifactId).first<ArtifactRow>()
}

async function requireVerifierContext(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  artifact: ArtifactRow,
  input: NormalizedRetrievalInput,
  receipt: ExecutionReceipt,
): Promise<VerifierContext> {
  if (receipt.claimsJson !== canonicalJson(retrievalClaims(input))) {
    throw new ArtifactError('retrieval_receipt_invalid')
  }
  if (
    principal.agentId === null
    || receipt.actorKind !== 'agent'
    || receipt.actorId !== principal.agentId
    || receipt.flightId !== artifact.flight_id
    || receipt.taskId === null
    || receipt.assignmentEpoch === null
    || receipt.seatId === null
    || receipt.seatGeneration === null
  ) {
    throw new ArtifactError('verifier_scope_mismatch')
  }
  if (
    receipt.actorId === artifact.producing_agent_id
    || receipt.seatId === artifact.producing_runtime_seat_id
  ) {
    throw new ArtifactError('verifier_not_independent')
  }
  if (input.recomputedDigest !== artifact.digest) throw new ArtifactError('digest_mismatch')
  const row = await env.DB.prepare(`
    SELECT assignment.flight_id, assignment.task_id, assignment.agent_id,
           assignment.runtime_seat_id, assignment.assignment_epoch,
           seat.current_generation, task.squad_id
      FROM flight_task_assignments assignment
      JOIN flight_lanes lane
        ON lane.id = assignment.lane_id AND lane.tenant = assignment.tenant
       AND lane.flight_id = assignment.flight_id AND lane.task_id = assignment.task_id
       AND lane.assignment_epoch = assignment.assignment_epoch
       AND lane.agent_id = assignment.agent_id
       AND lane.runtime_seat_id = assignment.runtime_seat_id
      JOIN tasks task
        ON task.id = assignment.task_id
       AND task.assignment_epoch = assignment.assignment_epoch
       AND task.assignee_agent_id = assignment.agent_id
      JOIN tasks producer_task ON producer_task.id = ?9 AND producer_task.squad_id = task.squad_id
      JOIN agents agent ON agent.id = assignment.agent_id AND agent.status = 'active'
      JOIN runtime_seats seat
        ON seat.id = assignment.runtime_seat_id AND seat.tenant = assignment.tenant
       AND seat.agent_id = assignment.agent_id AND seat.state = 'active'
      JOIN runtime_seat_generations generation
        ON generation.tenant = seat.tenant AND generation.runtime_seat_id = seat.id
       AND generation.generation = seat.current_generation
     WHERE assignment.tenant = ?1 AND assignment.flight_id = ?2
       AND assignment.task_id = ?3 AND assignment.assignment_epoch = ?4
       AND assignment.agent_id = ?5 AND assignment.runtime_seat_id = ?6
       AND seat.current_generation = ?7 AND assignment.agent_id <> ?8
  `).bind(
    env.TENANT_SLUG,
    receipt.flightId,
    receipt.taskId,
    receipt.assignmentEpoch,
    receipt.actorId,
    receipt.seatId,
    receipt.seatGeneration,
    artifact.producing_agent_id,
    artifact.producing_task_id,
  ).first<{
    flight_id: string
    task_id: string
    agent_id: string
    runtime_seat_id: string
    assignment_epoch: number
    current_generation: number
    squad_id: string
  }>()
  if (!row) throw new ArtifactError('verifier_scope_mismatch')
  await requireFlightSpineSquadAuthority(env, auth, principal, row.squad_id, 'member')
  return {
    flightId: row.flight_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    runtimeSeatId: row.runtime_seat_id,
    assignmentEpoch: Number(row.assignment_epoch),
    seatGeneration: Number(row.current_generation),
    squadId: row.squad_id,
  }
}

async function retrievalCandidates(
  env: Env,
  input: NormalizedRetrievalInput,
  context: VerifierContext,
): Promise<ArtifactRetrievalRow[]> {
  const result = await env.DB.prepare(`
    SELECT ${RETRIEVAL_COLUMNS}
      FROM artifact_retrieval_receipts
     WHERE tenant = ?1
       AND (retrieval_receipt_id = ?2
         OR (artifact_id = ?3 AND verifier_principal_kind = 'agent'
           AND verifier_principal_id = ?4))
     ORDER BY id
  `).bind(
    env.TENANT_SLUG,
    input.retrievalReceiptId,
    input.artifactId,
    context.agentId,
  ).all<ArtifactRetrievalRow>()
  return result.results ?? []
}

function retrievalMatches(
  row: ArtifactRetrievalRow,
  tenant: string,
  input: NormalizedRetrievalInput,
  context: VerifierContext,
  retrievedAt: string,
): boolean {
  return row.tenant === tenant
    && row.artifact_id === input.artifactId
    && row.verifier_principal_kind === 'agent'
    && row.verifier_principal_id === context.agentId
    && row.verifier_agent_id === context.agentId
    && row.verifier_runtime_seat_id === context.runtimeSeatId
    && row.recomputed_digest === input.recomputedDigest
    && row.retrieval_receipt_id === input.retrievalReceiptId
    && row.retrieved_at === retrievedAt
}

async function retrievalAuditMetadata(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  input: NormalizedRetrievalInput,
  context: VerifierContext,
  receipt: ExecutionReceipt,
  retrievalId: string,
): Promise<AtomicDomainAuditMetadata> {
  const requestDigest = await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    artifactId: input.artifactId,
    retrievalReceiptId: input.retrievalReceiptId,
  }))
  const afterDigest = await sha256Hex(canonicalJson({
    id: retrievalId,
    artifactId: input.artifactId,
    verifierPrincipalKind: 'agent',
    verifierPrincipalId: context.agentId,
    verifierRuntimeSeatId: context.runtimeSeatId,
    recomputedDigest: input.recomputedDigest,
    retrievalReceiptId: input.retrievalReceiptId,
  }))
  return flightSpineAudit(auth, principal, {
    expectedAuditId: `audit:artifact-retrieval:${requestDigest}`,
    handler: 'flight_spine.record_artifact_retrieval',
    operation: 'insert',
    targetKind: 'artifact_retrieval_receipt',
    targetId: retrievalId,
    afterDigest,
    objectiveId: receipt.objectiveId,
    flightId: context.flightId,
    taskId: context.taskId,
    requestId: input.retrievalReceiptId,
    idempotencyKey: `artifact-retrieval:${requestDigest}`,
    runtimeSeatId: context.runtimeSeatId,
    runtimeGeneration: context.seatGeneration,
    evidence: {
      retrievalReceiptId: input.retrievalReceiptId,
      artifactId: input.artifactId,
      recomputedDigest: input.recomputedDigest,
      metadataOnly: true,
    },
  })
}

async function replayRetrievalOrConflict(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  input: NormalizedRetrievalInput,
  context: VerifierContext,
  receipt: ExecutionReceipt,
): Promise<ArtifactRetrieval | null> {
  const rows = await retrievalCandidates(env, input, context)
  if (rows.length === 0) return null
  if (
    rows.length !== 1
    || !retrievalMatches(rows[0], env.TENANT_SLUG, input, context, receipt.serverTimestamp)
  ) {
    throw new ArtifactError('retrieval_conflict')
  }
  const audit = await retrievalAuditMetadata(
    env,
    auth,
    principal,
    input,
    context,
    receipt,
    rows[0].id,
  )
  await requireProjectionAudit(env, audit, 'retrieval_audit_invalid')
  return mapRetrieval(rows[0])
}

/**
 * Project an independent retrieval fact from an existing, verified
 * artifact-service receipt. No object-store read is performed by this service.
 */
export async function recordArtifactRetrieval(
  env: Env,
  auth: AuthContext,
  rawInput: RecordArtifactRetrievalInput,
): Promise<ArtifactRetrieval> {
  const input = normalizeRetrievalInput(rawInput)
  const artifact = await artifactById(env, input.artifactId)
  if (!artifact) throw new ArtifactError('artifact_not_found')
  const receipt = await requireReceipt(env, input.retrievalReceiptId, 'artifact.retrieved')
  const principal = await resolveFlightSpinePrincipal(env, auth)
  const context = await requireVerifierContext(env, auth, principal, artifact, input, receipt)
  const replay = await replayRetrievalOrConflict(
    env,
    auth,
    principal,
    input,
    context,
    receipt,
  )
  if (replay) return replay

  const id = crypto.randomUUID()
  const claimsJson = canonicalJson(retrievalClaims(input))
  const audit = await retrievalAuditMetadata(
    env,
    auth,
    principal,
    input,
    context,
    receipt,
    id,
  )
  const mutation = prepareAuditedProjectionMutation(env.DB, {
    sql: `INSERT INTO artifact_retrieval_receipts (
      id, tenant, artifact_id, verifier_principal_kind, verifier_principal_id,
      verifier_agent_id, verifier_runtime_seat_id, recomputed_digest,
      retrieval_receipt_id, retrieved_at
    )
    SELECT ?1, ?2, ?3, 'agent', ?4, ?4, ?5, ?6, ?7, ?8
     WHERE EXISTS (
       SELECT 1
         FROM artifacts artifact
         JOIN tasks producer_task ON producer_task.id = artifact.producing_task_id
         JOIN execution_receipts receipt
           ON receipt.id = ?7 AND receipt.tenant = artifact.tenant
          AND receipt.type = 'artifact.retrieved'
          AND receipt.issuer_kind = 'artifact_service'
          AND receipt.actor_kind = 'agent' AND receipt.actor_id = ?4
          AND receipt.seat_id = ?5 AND receipt.seat_generation = ?9
          AND receipt.objective_id IS ?13 AND receipt.flight_id = artifact.flight_id
          AND receipt.task_id = ?10 AND receipt.assignment_epoch = ?11
          AND receipt.claims_json = ?15 AND receipt.receipt_hash = ?14
         JOIN flight_task_assignments assignment
           ON assignment.tenant = artifact.tenant AND assignment.flight_id = receipt.flight_id
          AND assignment.task_id = receipt.task_id
          AND assignment.assignment_epoch = receipt.assignment_epoch
          AND assignment.agent_id = receipt.actor_id
          AND assignment.runtime_seat_id = receipt.seat_id
         JOIN flight_lanes lane
           ON lane.id = assignment.lane_id AND lane.tenant = assignment.tenant
          AND lane.flight_id = assignment.flight_id AND lane.task_id = assignment.task_id
          AND lane.assignment_epoch = assignment.assignment_epoch
          AND lane.agent_id = assignment.agent_id
          AND lane.runtime_seat_id = assignment.runtime_seat_id
         JOIN tasks task
           ON task.id = assignment.task_id AND task.squad_id = producer_task.squad_id
          AND task.assignment_epoch = assignment.assignment_epoch
          AND task.assignee_agent_id = assignment.agent_id
         JOIN agents agent ON agent.id = assignment.agent_id AND agent.status = 'active'
         JOIN runtime_seats seat
           ON seat.id = assignment.runtime_seat_id AND seat.tenant = assignment.tenant
          AND seat.agent_id = assignment.agent_id AND seat.state = 'active'
          AND seat.current_generation = ?9
         JOIN runtime_seat_generations generation
           ON generation.tenant = seat.tenant AND generation.runtime_seat_id = seat.id
          AND generation.generation = seat.current_generation
         JOIN memberships membership
           ON membership.agent_id = agent.id AND membership.squad_id = task.squad_id
         JOIN agent_member_bindings binding
           ON binding.tenant = assignment.tenant AND binding.agent_id = agent.id
          AND binding.member_id = ?16
         JOIN members member
           ON member.id = binding.member_id AND member.tenant = assignment.tenant
          AND member.status = 'active'
        WHERE artifact.id = ?3 AND artifact.tenant = ?2 AND artifact.digest = ?6
          AND artifact.producing_agent_id <> ?4
          AND artifact.producing_runtime_seat_id <> ?5
          AND assignment.task_id = ?10 AND assignment.assignment_epoch = ?11
          AND task.squad_id = ?17
          AND CASE membership.capability
            WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
            WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
     )
       AND EXISTS (
         SELECT 1 FROM members authority_member
          WHERE authority_member.id = ?18 AND authority_member.tenant = ?2
            AND authority_member.status = 'active'
       )
       AND (
         ?19 = 1
         OR EXISTS (
           SELECT 1 FROM capabilities capability
             JOIN squads squad ON squad.id = ?17
            WHERE capability.member_id = ?18
              AND (capability.scope_type = 'org'
                OR (capability.scope_type = 'department' AND capability.scope_id = squad.department_id)
                OR (capability.scope_type = 'squad' AND capability.scope_id = squad.id))
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
         OR EXISTS (
           SELECT 1 FROM channel_capability_grants capability
            WHERE capability.member_id = ?18 AND capability.squad_id = ?17
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= 2
         )
       )`,
    bindings: [
      id,
      env.TENANT_SLUG,
      input.artifactId,
      context.agentId,
      context.runtimeSeatId,
      input.recomputedDigest,
      input.retrievalReceiptId,
      receipt.serverTimestamp,
      context.seatGeneration,
      context.taskId,
      context.assignmentEpoch,
      context.flightId,
      receipt.objectiveId,
      receipt.receiptHash,
      claimsJson,
      principal.memberId,
      context.squadId,
      principal.authorityMemberId,
      legacyAdmin(auth),
    ],
    audit,
  })

  await executeAuditedProjectionMutations(env, [mutation])
  const persisted = await replayRetrievalOrConflict(
    env,
    auth,
    principal,
    input,
    context,
    receipt,
  )
  if (!persisted) throw new ArtifactError('retrieval_conflict')
  return persisted
}
