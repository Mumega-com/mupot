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
import type { JsonValue } from './types'

export type DecisionClass =
  | 'credential'
  | 'deployment_or_migration'
  | 'destructive'
  | 'spend'
  | 'cross_tenant'
  | 'business_choice'

export interface CreateDecisionRequestInput {
  decisionClass: DecisionClass
  dedupeKey: string
  exactAuthorityRequired: string
  question: string
  options: JsonValue[]
  consequences: JsonValue
  evidence: JsonValue
  objectiveId?: string | null
  flightId?: string | null
  taskId?: string | null
  expiresAt: string
  idempotencyKey: string
}

export interface DecisionRequest {
  id: string
  tenant: string
  decisionClass: DecisionClass
  dedupeKey: string
  status: 'open' | 'resolved' | 'expired' | 'cancelled'
  exactAuthorityRequired: string
  question: string
  options: JsonValue[]
  consequences: JsonValue
  evidence: JsonValue
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
  requestedByPrincipalKind: 'member' | 'agent'
  requestedByPrincipalId: string
  requestedByMemberId: string
  expiresAt: string
  createdReceiptId: string
  createdAt: string
  resolvedAt: string | null
}

export interface ResolveDecisionRequestInput {
  decisionRequestId: string
  idempotencyKey: string
  resolution: JsonValue
  consequencesAccepted: JsonValue
}

export interface DecisionResolution {
  id: string
  tenant: string
  decisionRequestId: string
  idempotencyKey: string
  resolvedByPrincipalKind: 'member' | 'agent'
  resolvedByPrincipalId: string
  resolvedByMemberId: string
  resolution: JsonValue
  consequencesAccepted: JsonValue
  resolutionReceiptId: string
  resolvedAt: string
}

export type DecisionErrorCode =
  | 'invalid_decision'
  | 'decision_forbidden'
  | 'decision_not_found'
  | 'decision_already_open'
  | 'decision_not_open_or_expired'
  | 'idempotency_conflict'
  | 'decision_persistence_conflict'

export class DecisionError extends Error {
  readonly name = 'DecisionError'

  constructor(readonly code: DecisionErrorCode) {
    super(code)
  }
}

interface DecisionRequestRow {
  id: string
  tenant: string
  decision_class: DecisionClass
  dedupe_key: string
  status: DecisionRequest['status']
  exact_authority_required: string
  question: string
  options_json: string
  consequences_json: string
  evidence_json: string
  objective_id: string | null
  flight_id: string | null
  task_id: string | null
  requested_by_principal_kind: 'member' | 'agent'
  requested_by_principal_id: string
  requested_by_member_id: string
  expires_at: string
  created_receipt_id: string | null
  created_at: string
  resolved_at: string | null
}

interface DecisionResolutionRow {
  id: string
  tenant: string
  decision_request_id: string
  idempotency_key: string
  resolved_by_principal_kind: 'member' | 'agent'
  resolved_by_principal_id: string
  resolved_by_member_id: string
  resolution_json: string
  consequences_accepted_json: string
  resolution_receipt_id: string
  resolved_at: string
}

interface NormalizedCreateInput extends Omit<CreateDecisionRequestInput,
  'options' | 'consequences' | 'evidence' | 'objectiveId' | 'flightId' | 'taskId'> {
  options: JsonValue[]
  optionsJson: string
  consequences: JsonValue
  consequencesJson: string
  evidence: JsonValue
  evidenceJson: string
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
}

interface NormalizedResolutionInput extends Omit<ResolveDecisionRequestInput,
  'resolution' | 'consequencesAccepted'> {
  resolution: JsonValue
  resolutionJson: string
  consequencesAccepted: JsonValue
  consequencesAcceptedJson: string
}

interface DecisionScope {
  squadId: string | null
  departmentId: string | null
}

interface LiveAuthority {
  principal: FlightSpinePrincipal
  tokenId: string | null
  scope: DecisionScope
  minimumRank: number
}

const DECISION_CLASSES = new Set<DecisionClass>([
  'credential',
  'deployment_or_migration',
  'destructive',
  'spend',
  'cross_tenant',
  'business_choice',
])
const CREATE_KEYS = new Set([
  'decisionClass', 'dedupeKey', 'exactAuthorityRequired', 'question',
  'options', 'consequences', 'evidence', 'objectiveId', 'flightId',
  'taskId', 'expiresAt', 'idempotencyKey',
])
const RESOLUTION_KEYS = new Set([
  'decisionRequestId', 'idempotencyKey', 'resolution', 'consequencesAccepted',
])

const LIVE_AUTHORITY_SQL = `
  EXISTS (
    SELECT 1 FROM members member
     WHERE member.id = ? AND member.tenant = ? AND member.status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM members authority_member
     WHERE authority_member.id = ? AND authority_member.tenant = ?
       AND authority_member.status = 'active'
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
    ? IS NULL
    OR EXISTS (
      SELECT 1 FROM agents agent
      JOIN agent_member_bindings binding
        ON binding.agent_id = agent.id AND binding.tenant = ?
       AND binding.member_id = ?
     WHERE agent.id = ? AND agent.status = 'active'
    )
  )
  AND (
    (? IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM capabilities capability
         WHERE capability.member_id = ?
           AND (capability.scope_type = 'org'
             OR (capability.scope_type = 'department' AND capability.scope_id = ?)
             OR (capability.scope_type = 'squad' AND capability.scope_id = ?))
           AND CASE capability.capability
             WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
             WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= ?
      ) OR EXISTS (
        SELECT 1 FROM channel_capability_grants capability
         WHERE capability.member_id = ? AND capability.squad_id = ?
           AND CASE capability.capability
             WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
             WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= ?
      )
    ) AND (
      ? IS NULL OR EXISTS (
        SELECT 1 FROM memberships membership
         WHERE membership.agent_id = ? AND membership.squad_id = ?
           AND CASE membership.capability
             WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
             WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= ?
      )
    ))
    OR (? IS NULL AND EXISTS (
      SELECT 1 FROM capabilities capability
       WHERE capability.member_id = ? AND capability.scope_type = 'org'
         AND CASE capability.capability
           WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
           WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= ?
    ))
  )
`

function safeText(value: unknown, maximum: number): string {
  try {
    return safeBoundedText(value, maximum)
  } catch {
    throw new DecisionError('invalid_decision')
  }
}

function optionalId(value: unknown): string | null {
  try {
    return safeOptionalId(value)
  } catch {
    throw new DecisionError('invalid_decision')
  }
}

function safeJson(value: unknown): { value: JsonValue; json: string } {
  try {
    return canonicalSafeJson(value)
  } catch {
    throw new DecisionError('invalid_decision')
  }
}

function canonicalFutureTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw new DecisionError('invalid_decision')
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
    || milliseconds <= Date.now()
  ) {
    throw new DecisionError('invalid_decision')
  }
  return value
}

function normalizeCreateInput(input: CreateDecisionRequestInput): NormalizedCreateInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DecisionError('invalid_decision')
  }
  const required = [
    'decisionClass', 'dedupeKey', 'exactAuthorityRequired', 'question',
    'options', 'consequences', 'evidence', 'expiresAt', 'idempotencyKey',
  ]
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
    || Object.keys(input).some((key) => !CREATE_KEYS.has(key))
    || !DECISION_CLASSES.has(input.decisionClass)
    || !Array.isArray(input.options)
    || input.options.length === 0
    || input.options.length > 20
  ) {
    throw new DecisionError('invalid_decision')
  }
  const options = safeJson(input.options)
  if (!Array.isArray(options.value)) throw new DecisionError('invalid_decision')
  const consequences = safeJson(input.consequences)
  const evidence = safeJson(input.evidence)
  return {
    decisionClass: input.decisionClass,
    dedupeKey: safeText(input.dedupeKey, 255),
    exactAuthorityRequired: safeText(input.exactAuthorityRequired, 2_000),
    question: safeText(input.question, 4_000),
    options: options.value,
    optionsJson: options.json,
    consequences: consequences.value,
    consequencesJson: consequences.json,
    evidence: evidence.value,
    evidenceJson: evidence.json,
    objectiveId: optionalId(input.objectiveId),
    flightId: optionalId(input.flightId),
    taskId: optionalId(input.taskId),
    expiresAt: canonicalFutureTimestamp(input.expiresAt),
    idempotencyKey: safeText(input.idempotencyKey, 255),
  }
}

function normalizeResolutionInput(input: ResolveDecisionRequestInput): NormalizedResolutionInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DecisionError('invalid_decision')
  }
  const required = ['decisionRequestId', 'idempotencyKey', 'resolution', 'consequencesAccepted']
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
    || Object.keys(input).some((key) => !RESOLUTION_KEYS.has(key))
  ) {
    throw new DecisionError('invalid_decision')
  }
  const resolution = safeJson(input.resolution)
  const consequencesAccepted = safeJson(input.consequencesAccepted)
  return {
    decisionRequestId: safeText(input.decisionRequestId, 255),
    idempotencyKey: safeText(input.idempotencyKey, 255),
    resolution: resolution.value,
    resolutionJson: resolution.json,
    consequencesAccepted: consequencesAccepted.value,
    consequencesAcceptedJson: consequencesAccepted.json,
  }
}

function mapRequest(row: DecisionRequestRow): DecisionRequest {
  if (row.created_receipt_id === null) throw new DecisionError('decision_persistence_conflict')
  const options = JSON.parse(row.options_json) as JsonValue
  if (!Array.isArray(options)) throw new DecisionError('decision_persistence_conflict')
  return {
    id: row.id,
    tenant: row.tenant,
    decisionClass: row.decision_class,
    dedupeKey: row.dedupe_key,
    status: row.status,
    exactAuthorityRequired: row.exact_authority_required,
    question: row.question,
    options,
    consequences: JSON.parse(row.consequences_json) as JsonValue,
    evidence: JSON.parse(row.evidence_json) as JsonValue,
    objectiveId: row.objective_id,
    flightId: row.flight_id,
    taskId: row.task_id,
    requestedByPrincipalKind: row.requested_by_principal_kind,
    requestedByPrincipalId: row.requested_by_principal_id,
    requestedByMemberId: row.requested_by_member_id,
    expiresAt: row.expires_at,
    createdReceiptId: row.created_receipt_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

function mapResolution(row: DecisionResolutionRow): DecisionResolution {
  return {
    id: row.id,
    tenant: row.tenant,
    decisionRequestId: row.decision_request_id,
    idempotencyKey: row.idempotency_key,
    resolvedByPrincipalKind: row.resolved_by_principal_kind,
    resolvedByPrincipalId: row.resolved_by_principal_id,
    resolvedByMemberId: row.resolved_by_member_id,
    resolution: JSON.parse(row.resolution_json) as JsonValue,
    consequencesAccepted: JSON.parse(row.consequences_accepted_json) as JsonValue,
    resolutionReceiptId: row.resolution_receipt_id,
    resolvedAt: row.resolved_at,
  }
}

async function requestById(env: Env, id: string): Promise<DecisionRequestRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, decision_class, dedupe_key, status,
           exact_authority_required, question, options_json, consequences_json,
           evidence_json, objective_id, flight_id, task_id,
           requested_by_principal_kind, requested_by_principal_id,
           requested_by_member_id, expires_at, created_receipt_id, created_at,
           resolved_at
      FROM decision_requests
     WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, id).first<DecisionRequestRow>()
}

async function openRequestByDedupe(
  env: Env,
  dedupeKey: string,
): Promise<DecisionRequestRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, decision_class, dedupe_key, status,
           exact_authority_required, question, options_json, consequences_json,
           evidence_json, objective_id, flight_id, task_id,
           requested_by_principal_kind, requested_by_principal_id,
           requested_by_member_id, expires_at, created_receipt_id, created_at,
           resolved_at
      FROM decision_requests
     WHERE tenant = ?1 AND dedupe_key = ?2 AND status = 'open'
  `).bind(env.TENANT_SLUG, dedupeKey).first<DecisionRequestRow>()
}

async function resolutionByKey(
  env: Env,
  idempotencyKey: string,
): Promise<DecisionResolutionRow | null> {
  return env.DB.prepare(`
    SELECT id, tenant, decision_request_id, idempotency_key,
           resolved_by_principal_kind, resolved_by_principal_id,
           resolved_by_member_id, resolution_json,
           consequences_accepted_json, resolution_receipt_id, resolved_at
      FROM decision_request_resolutions
     WHERE tenant = ?1 AND idempotency_key = ?2
  `).bind(env.TENANT_SLUG, idempotencyKey).first<DecisionResolutionRow>()
}

async function resolveDecisionScope(
  env: Env,
  input: Pick<NormalizedCreateInput, 'objectiveId' | 'flightId' | 'taskId'>,
): Promise<DecisionScope> {
  let scope: DecisionScope | null = null
  if (input.objectiveId !== null) {
    scope = await env.DB.prepare(`
      SELECT objective.squad_id, squad.department_id
        FROM objectives objective
        JOIN squads squad ON squad.id = objective.squad_id
       WHERE objective.tenant = ?1 AND objective.id = ?2
    `).bind(env.TENANT_SLUG, input.objectiveId)
      .first<{ squad_id: string; department_id: string }>()
      .then((row) => row && ({ squadId: row.squad_id, departmentId: row.department_id }))
    if (scope === null) throw new DecisionError('invalid_decision')
  }
  if (input.flightId !== null) {
    const row = await env.DB.prepare(`
      SELECT objective.squad_id, squad.department_id, objective.id AS objective_id
        FROM flight_objectives link
        JOIN objectives objective
          ON objective.id = link.objective_id AND objective.tenant = link.tenant
        JOIN squads squad ON squad.id = objective.squad_id
       WHERE link.tenant = ?1 AND link.flight_id = ?2
    `).bind(env.TENANT_SLUG, input.flightId)
      .first<{ squad_id: string; department_id: string; objective_id: string }>()
    if (
      row === null
      || (input.objectiveId !== null && row.objective_id !== input.objectiveId)
      || (scope !== null && scope.squadId !== row.squad_id)
    ) {
      throw new DecisionError('invalid_decision')
    }
    scope = { squadId: row.squad_id, departmentId: row.department_id }
  }
  if (input.taskId !== null) {
    const row = await env.DB.prepare(`
      SELECT task.squad_id, squad.department_id
        FROM tasks task JOIN squads squad ON squad.id = task.squad_id
       WHERE task.id = ?1
    `).bind(input.taskId).first<{ squad_id: string; department_id: string }>()
    if (row === null || (scope !== null && scope.squadId !== row.squad_id)) {
      throw new DecisionError('invalid_decision')
    }
    scope = { squadId: row.squad_id, departmentId: row.department_id }
  }
  return scope ?? { squadId: null, departmentId: null }
}

async function resolvePrincipal(env: Env, auth: AuthContext): Promise<FlightSpinePrincipal> {
  try {
    return await resolveFlightSpinePrincipal(env, auth)
  } catch {
    throw new DecisionError('decision_forbidden')
  }
}

async function requireAuthority(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  scope: DecisionScope,
  minimum: 'member' | 'lead' | 'admin',
): Promise<LiveAuthority> {
  if (scope.squadId !== null) {
    try {
      await requireFlightSpineSquadAuthority(env, auth, principal, scope.squadId, minimum)
    } catch {
      throw new DecisionError('decision_forbidden')
    }
  } else if (
    auth.capabilities === undefined
    || !hasCapability(auth.capabilities, 'org', null, minimum)
  ) {
    throw new DecisionError('decision_forbidden')
  }
  return {
    principal,
    tokenId: optionalId(auth.tokenId),
    scope,
    minimumRank: minimum === 'admin' ? 4 : minimum === 'lead' ? 3 : 2,
  }
}

function authorityBindings(env: Env, authority: LiveAuthority): Array<string | number | null> {
  const { principal, tokenId, scope, minimumRank } = authority
  return [
    principal.memberId, env.TENANT_SLUG,
    principal.authorityMemberId, env.TENANT_SLUG,
    tokenId, tokenId, env.TENANT_SLUG, principal.memberId, principal.agentId,
    nowSqlUtc(),
    principal.agentId, env.TENANT_SLUG, principal.memberId, principal.agentId,
    scope.squadId, principal.authorityMemberId, scope.departmentId, scope.squadId,
    minimumRank, principal.authorityMemberId, scope.squadId, minimumRank,
    principal.agentId, principal.agentId, scope.squadId, minimumRank,
    scope.squadId, principal.authorityMemberId, minimumRank,
  ]
}

function createdClaims(input: NormalizedCreateInput): JsonValue {
  return {
    consequences: input.consequences,
    decisionClass: input.decisionClass,
    dedupeKey: input.dedupeKey,
    evidence: input.evidence,
    exactAuthorityRequired: input.exactAuthorityRequired,
    expiresAt: input.expiresAt,
    options: input.options,
    question: input.question,
  }
}

function resolvedClaims(
  request: DecisionRequestRow,
  input: NormalizedResolutionInput,
): JsonValue {
  return {
    consequencesAccepted: input.consequencesAccepted,
    decisionRequestId: request.id,
    resolution: input.resolution,
  }
}

async function exactCreateReplay(
  env: Env,
  row: DecisionRequestRow,
  input: NormalizedCreateInput,
  principal: FlightSpinePrincipal,
): Promise<DecisionRequest> {
  const mapped = mapRequest(row)
  if (
    row.decision_class !== input.decisionClass
    || row.dedupe_key !== input.dedupeKey
    || row.exact_authority_required !== input.exactAuthorityRequired
    || row.question !== input.question
    || row.options_json !== input.optionsJson
    || row.consequences_json !== input.consequencesJson
    || row.evidence_json !== input.evidenceJson
    || row.objective_id !== input.objectiveId
    || row.flight_id !== input.flightId
    || row.task_id !== input.taskId
    || row.requested_by_principal_kind !== principal.kind
    || row.requested_by_principal_id !== principal.id
    || row.requested_by_member_id !== principal.memberId
    || row.expires_at !== input.expiresAt
  ) {
    throw new DecisionError('idempotency_conflict')
  }
  const receipt = await getExecutionReceipt(env, mapped.createdReceiptId)
  if (
    receipt === null
    || receipt.type !== 'decision.created'
    || receipt.idempotencyKey !== `decision:${input.idempotencyKey}:created`
    || receipt.claimsJson !== canonicalJson(createdClaims(input))
    || !(await verifyExecutionReceipt(env, receipt.id)).ok
  ) {
    throw new DecisionError('decision_persistence_conflict')
  }
  return mapped
}

function correlationSql(): string {
  return `
    (? IS NULL OR EXISTS (
      SELECT 1 FROM objectives objective
       WHERE objective.id = ? AND objective.tenant = ? AND objective.squad_id = ?
    ))
    AND (? IS NULL OR EXISTS (
      SELECT 1 FROM flight_objectives link
      JOIN objectives objective
        ON objective.id = link.objective_id AND objective.tenant = link.tenant
       WHERE link.tenant = ? AND link.flight_id = ? AND objective.squad_id = ?
         AND (? IS NULL OR objective.id = ?)
    ))
    AND (? IS NULL OR EXISTS (
      SELECT 1 FROM tasks task WHERE task.id = ? AND task.squad_id = ?
    ))
  `
}

function correlationBindings(
  env: Env,
  input: Pick<NormalizedCreateInput, 'objectiveId' | 'flightId' | 'taskId'>,
  scope: DecisionScope,
): Array<string | null> {
  return [
    input.objectiveId, input.objectiveId, env.TENANT_SLUG, scope.squadId,
    input.flightId, env.TENANT_SLUG, input.flightId, scope.squadId,
    input.objectiveId, input.objectiveId,
    input.taskId, input.taskId, scope.squadId,
  ]
}

export async function createDecisionRequest(
  env: Env,
  auth: AuthContext,
  rawInput: CreateDecisionRequestInput,
): Promise<DecisionRequest> {
  const input = normalizeCreateInput(rawInput)
  const principal = await resolvePrincipal(env, auth)
  const scope = await resolveDecisionScope(env, input)
  const authority = await requireAuthority(env, auth, principal, scope, 'member')
  const identityDigest = await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    idempotencyKey: input.idempotencyKey,
  }))
  const id = `decision:${identityDigest.slice(0, 48)}`
  const existing = await requestById(env, id)
  if (existing !== null) return exactCreateReplay(env, existing, input, principal)
  if (await openRequestByDedupe(env, input.dedupeKey)) {
    throw new DecisionError('decision_already_open')
  }

  const prepared = await prepareFreshExecutionReceiptChain(env, auth, [{
    type: 'decision.created',
    idempotencyKey: `decision:${input.idempotencyKey}:created`,
    claims: createdClaims(input),
    objectiveId: input.objectiveId,
    flightId: input.flightId,
    taskId: input.taskId,
  }])
  const receipt = prepared.expectedReceipts[0]
  const requestDigest = await sha256Hex(canonicalJson(createdClaims(input)))
  const mutation = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO decision_requests (
      id, tenant, decision_class, dedupe_key, status,
      exact_authority_required, question, options_json, consequences_json,
      evidence_json, objective_id, flight_id, task_id,
      requested_by_principal_kind, requested_by_principal_id,
      requested_by_member_id, expires_at, created_receipt_id, created_at
    )
    SELECT ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE julianday(?) > julianday('now')
       AND EXISTS (
         SELECT 1 FROM execution_receipts receipt
          WHERE receipt.id = ? AND receipt.tenant = ?
            AND receipt.type = 'decision.created'
            AND receipt.actor_kind = ? AND receipt.actor_id = ?
            AND receipt.claims_json = ? AND receipt.receipt_hash = ?
       )
       AND ${correlationSql()}
       AND ${LIVE_AUTHORITY_SQL}`,
    bindings: [
      id, env.TENANT_SLUG, input.decisionClass, input.dedupeKey,
      input.exactAuthorityRequired, input.question, input.optionsJson,
      input.consequencesJson, input.evidenceJson, input.objectiveId,
      input.flightId, input.taskId, principal.kind, principal.id,
      principal.memberId, input.expiresAt, receipt.id, receipt.serverTimestamp,
      input.expiresAt,
      receipt.id, env.TENANT_SLUG, receipt.actorKind, receipt.actorId,
      receipt.claimsJson, receipt.receiptHash,
      ...correlationBindings(env, input, scope),
      ...authorityBindings(env, authority),
    ],
    audit: flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:${id}:created`,
      credentialId: authority.tokenId,
      handler: 'flight_spine.create_decision_request',
      operation: 'insert',
      targetKind: 'decision_request',
      targetId: id,
      afterDigest: requestDigest,
      objectiveId: input.objectiveId,
      flightId: input.flightId,
      taskId: input.taskId,
      requestId: `decision:${input.idempotencyKey}:create`,
      idempotencyKey: input.idempotencyKey,
      evidence: { decisionClass: input.decisionClass, dedupeKey: input.dedupeKey },
    }),
  })
  try {
    await executePreparedExecutionReceiptBatch(env, prepared, [mutation])
  } catch {
    throw new DecisionError('decision_persistence_conflict')
  }
  const row = await requestById(env, id)
  if (row === null) throw new DecisionError('decision_persistence_conflict')
  return exactCreateReplay(env, row, input, principal)
}

function resolutionMinimum(decisionClass: DecisionClass): 'lead' | 'admin' {
  return decisionClass === 'spend' || decisionClass === 'business_choice' ? 'lead' : 'admin'
}

async function resolutionAuthority(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  request: DecisionRequestRow,
): Promise<LiveAuthority> {
  const minimum = resolutionMinimum(request.decision_class)
  const correlation = {
    objectiveId: request.objective_id,
    flightId: request.flight_id,
    taskId: request.task_id,
  }
  const correlatedScope = await resolveDecisionScope(env, correlation)
  const scope = minimum === 'admin'
    ? { squadId: null, departmentId: null }
    : correlatedScope
  return requireAuthority(env, auth, principal, scope, minimum)
}

async function exactResolutionReplay(
  env: Env,
  row: DecisionResolutionRow,
  input: NormalizedResolutionInput,
  principal: FlightSpinePrincipal,
): Promise<DecisionResolution> {
  if (
    row.decision_request_id !== input.decisionRequestId
    || row.resolved_by_principal_kind !== principal.kind
    || row.resolved_by_principal_id !== principal.id
    || row.resolved_by_member_id !== principal.memberId
    || row.resolution_json !== input.resolutionJson
    || row.consequences_accepted_json !== input.consequencesAcceptedJson
  ) {
    throw new DecisionError('idempotency_conflict')
  }
  const request = await requestById(env, row.decision_request_id)
  if (request === null) throw new DecisionError('decision_persistence_conflict')
  const receipt = await getExecutionReceipt(env, row.resolution_receipt_id)
  if (
    receipt === null
    || receipt.type !== 'decision.resolved'
    || receipt.idempotencyKey !== `decision:${input.idempotencyKey}:resolved`
    || receipt.claimsJson !== canonicalJson(resolvedClaims(request, input))
    || !(await verifyExecutionReceipt(env, receipt.id)).ok
  ) {
    throw new DecisionError('decision_persistence_conflict')
  }
  return mapResolution(row)
}

export async function resolveDecisionRequest(
  env: Env,
  auth: AuthContext,
  rawInput: ResolveDecisionRequestInput,
): Promise<DecisionResolution> {
  const input = normalizeResolutionInput(rawInput)
  const principal = await resolvePrincipal(env, auth)
  const existingResolution = await resolutionByKey(env, input.idempotencyKey)
  if (existingResolution !== null) {
    const request = await requestById(env, existingResolution.decision_request_id)
    if (request === null) throw new DecisionError('decision_persistence_conflict')
    await resolutionAuthority(env, auth, principal, request)
    return exactResolutionReplay(env, existingResolution, input, principal)
  }
  const request = await requestById(env, input.decisionRequestId)
  if (request === null) throw new DecisionError('decision_not_found')
  if (request.status !== 'open' || Date.parse(request.expires_at) <= Date.now()) {
    throw new DecisionError('decision_not_open_or_expired')
  }
  const authority = await resolutionAuthority(env, auth, principal, request)
  const receiptClaims = resolvedClaims(request, input)
  const prepared = await prepareFreshExecutionReceiptChain(env, auth, [{
    type: 'decision.resolved',
    idempotencyKey: `decision:${input.idempotencyKey}:resolved`,
    claims: receiptClaims,
    objectiveId: request.objective_id,
    flightId: request.flight_id,
    taskId: request.task_id,
  }])
  const receipt = prepared.expectedReceipts[0]
  const resolutionIdentityDigest = await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    idempotencyKey: input.idempotencyKey,
  }))
  const resolutionId = `decision-resolution:${resolutionIdentityDigest.slice(0, 40)}`
  const beforeDigest = await sha256Hex(canonicalJson({ status: 'open' }))
  const afterDigest = await sha256Hex(canonicalJson({
    status: 'resolved',
    resolution: input.resolution,
  }))
  const correlation = {
    objectiveId: request.objective_id,
    flightId: request.flight_id,
    taskId: request.task_id,
  }
  const correlatedScope = await resolveDecisionScope(env, correlation)
  const insertMutation = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO decision_request_resolutions (
      id, tenant, decision_request_id, idempotency_key,
      resolved_by_principal_kind, resolved_by_principal_id,
      resolved_by_member_id, resolution_json, consequences_accepted_json,
      resolution_receipt_id, resolved_at
    )
    SELECT ?, ?, decision.id, ?, ?, ?, ?, ?, ?, ?, ?
      FROM decision_requests decision
     WHERE decision.id = ? AND decision.tenant = ? AND decision.status = 'open'
       AND julianday(decision.expires_at) > julianday('now')
       AND EXISTS (
         SELECT 1 FROM execution_receipts receipt
          WHERE receipt.id = ? AND receipt.tenant = ?
            AND receipt.type = 'decision.resolved'
            AND receipt.actor_kind = ? AND receipt.actor_id = ?
            AND receipt.claims_json = ? AND receipt.receipt_hash = ?
       )
       AND ${correlationSql()}
       AND ${LIVE_AUTHORITY_SQL}`,
    bindings: [
      resolutionId, env.TENANT_SLUG, input.idempotencyKey, principal.kind,
      principal.id, principal.memberId, input.resolutionJson,
      input.consequencesAcceptedJson, receipt.id, receipt.serverTimestamp,
      request.id, env.TENANT_SLUG,
      receipt.id, env.TENANT_SLUG, receipt.actorKind, receipt.actorId,
      receipt.claimsJson, receipt.receiptHash,
      ...correlationBindings(env, correlation, correlatedScope),
      ...authorityBindings(env, authority),
    ],
    audit: flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:${resolutionId}:insert`,
      credentialId: authority.tokenId,
      handler: 'flight_spine.resolve_decision_request',
      operation: 'insert_resolution',
      targetKind: 'decision_request_resolution',
      targetId: resolutionId,
      afterDigest,
      objectiveId: request.objective_id,
      flightId: request.flight_id,
      taskId: request.task_id,
      requestId: `decision:${input.idempotencyKey}:resolution`,
      idempotencyKey: input.idempotencyKey,
      evidence: { decisionRequestId: request.id, resolutionReceiptId: receipt.id },
    }),
  })
  const updateMutation = prepareAuditedDomainMutation(env.DB, {
    sql: `UPDATE decision_requests
             SET status = 'resolved', resolved_at = ?
           WHERE id = ? AND tenant = ? AND status = 'open'
             AND julianday(expires_at) > julianday('now')
             AND EXISTS (
               SELECT 1 FROM decision_request_resolutions resolution
                WHERE resolution.id = ? AND resolution.tenant = ?
                  AND resolution.decision_request_id = decision_requests.id
                  AND resolution.resolution_receipt_id = ?
             )
             AND ${LIVE_AUTHORITY_SQL}`,
    bindings: [
      receipt.serverTimestamp, request.id, env.TENANT_SLUG,
      resolutionId, env.TENANT_SLUG, receipt.id,
      ...authorityBindings(env, authority),
    ],
    audit: flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:${request.id}:resolved`,
      credentialId: authority.tokenId,
      handler: 'flight_spine.resolve_decision_request',
      operation: 'resolve',
      targetKind: 'decision_request',
      targetId: request.id,
      beforeDigest,
      afterDigest,
      objectiveId: request.objective_id,
      flightId: request.flight_id,
      taskId: request.task_id,
      requestId: `decision:${input.idempotencyKey}:request`,
      idempotencyKey: input.idempotencyKey,
      evidence: { resolutionId, resolutionReceiptId: receipt.id },
    }),
  })
  try {
    await executePreparedExecutionReceiptBatch(
      env,
      prepared,
      [insertMutation, updateMutation],
    )
  } catch {
    throw new DecisionError('decision_persistence_conflict')
  }
  const row = await resolutionByKey(env, input.idempotencyKey)
  if (row === null) throw new DecisionError('decision_persistence_conflict')
  return exactResolutionReplay(env, row, input, principal)
}
