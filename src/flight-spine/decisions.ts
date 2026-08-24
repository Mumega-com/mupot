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
  type AtomicDomainAuditMetadata,
  type PreparedAtomicDomainMutation,
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

export type DecisionCause =
  | 'credential.mint'
  | 'credential.rotate'
  | 'credential.revoke'
  | 'deployment.production'
  | 'migration.production'
  | 'destructive.delete'
  | 'destructive.destroy_runtime'
  | 'spend.increase'
  | 'cross_tenant.expand'
  | 'business.choose'

export interface DecisionOption {
  id: string
  label: string
}

export interface CreateDecisionRequestInput {
  decisionCause: DecisionCause
  dedupeKey: string
  question: string
  options: DecisionOption[]
  consequences: Record<string, string>
  evidence: Record<string, JsonValue>
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
  decisionCause: DecisionCause
  dedupeKey: string
  status: 'open' | 'resolved' | 'expired' | 'cancelled'
  exactAuthorityRequired: 'org:admin' | 'squad:lead'
  question: string
  options: DecisionOption[]
  consequences: Record<string, string>
  evidence: Record<string, JsonValue>
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
  selectedOptionId: string
  consequencesAccepted: true
  resolutionEvidence: Record<string, JsonValue>
}

export interface DecisionResolution {
  id: string
  tenant: string
  decisionRequestId: string
  idempotencyKey: string
  resolvedByPrincipalKind: 'member' | 'agent'
  resolvedByPrincipalId: string
  resolvedByMemberId: string
  selectedOptionId: string
  consequencesAccepted: true
  resolutionEvidence: Record<string, JsonValue>
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
  | 'decision_audit_invalid'
  | 'decision_persistence_conflict'

export class DecisionError extends Error {
  readonly name = 'DecisionError'

  constructor(readonly code: DecisionErrorCode) {
    super(code)
  }
}

interface DecisionPolicy {
  decisionClass: DecisionClass
  authority: 'org:admin' | 'squad:lead'
}

const DECISION_POLICIES: Record<DecisionCause, DecisionPolicy> = {
  'credential.mint': { decisionClass: 'credential', authority: 'org:admin' },
  'credential.rotate': { decisionClass: 'credential', authority: 'org:admin' },
  'credential.revoke': { decisionClass: 'credential', authority: 'org:admin' },
  'deployment.production': {
    decisionClass: 'deployment_or_migration',
    authority: 'org:admin',
  },
  'migration.production': {
    decisionClass: 'deployment_or_migration',
    authority: 'org:admin',
  },
  'destructive.delete': { decisionClass: 'destructive', authority: 'org:admin' },
  'destructive.destroy_runtime': {
    decisionClass: 'destructive',
    authority: 'org:admin',
  },
  'spend.increase': { decisionClass: 'spend', authority: 'squad:lead' },
  'cross_tenant.expand': { decisionClass: 'cross_tenant', authority: 'org:admin' },
  'business.choose': { decisionClass: 'business_choice', authority: 'squad:lead' },
}

interface DecisionRequestRow {
  id: string
  tenant: string
  decision_class: DecisionClass
  decision_cause: DecisionCause
  dedupe_key: string
  status: DecisionRequest['status']
  exact_authority_required: 'org:admin' | 'squad:lead'
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
  is_expired: number
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

interface DecisionAuditRow {
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

interface NormalizedCreateInput extends Omit<CreateDecisionRequestInput,
  'options' | 'consequences' | 'evidence' | 'objectiveId' | 'flightId' | 'taskId'> {
  policy: DecisionPolicy
  options: DecisionOption[]
  optionsJson: string
  consequences: Record<string, string>
  consequencesJson: string
  evidence: Record<string, JsonValue>
  evidenceJson: string
  objectiveId: string | null
  flightId: string | null
  taskId: string | null
}

interface NormalizedResolutionInput extends Omit<ResolveDecisionRequestInput,
  'resolutionEvidence'> {
  resolutionEvidence: Record<string, JsonValue>
  resolutionJson: string
  consequencesAcceptedJson: 'true'
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

const CREATE_KEYS = new Set([
  'decisionCause', 'dedupeKey', 'question', 'options', 'consequences',
  'evidence', 'objectiveId', 'flightId', 'taskId', 'expiresAt',
  'idempotencyKey',
])
const RESOLUTION_KEYS = new Set([
  'decisionRequestId', 'idempotencyKey', 'selectedOptionId',
  'consequencesAccepted', 'resolutionEvidence',
])
const OPTION_KEYS = new Set(['id', 'label'])
const OPTION_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const MIN_EXPIRY_MS = 5 * 60 * 1_000
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_EVIDENCE_BYTES = 16 * 1_024

const REQUEST_COLUMNS = `
  id, tenant, decision_class, decision_cause, dedupe_key, status,
  exact_authority_required, question, options_json, consequences_json,
  evidence_json, objective_id, flight_id, task_id,
  requested_by_principal_kind, requested_by_principal_id,
  requested_by_member_id, expires_at, created_receipt_id, created_at,
  resolved_at,
  CASE WHEN julianday(expires_at) <= julianday('now') THEN 1 ELSE 0 END AS is_expired
`

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

function invalid(): never {
  throw new DecisionError('invalid_decision')
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

function safeJson(value: unknown): { value: JsonValue; json: string } {
  try {
    return canonicalSafeJson(value)
  } catch {
    return invalid()
  }
}

function safeEvidence(value: unknown): {
  value: Record<string, JsonValue>
  json: string
} {
  const safe = safeJson(value)
  if (
    typeof safe.value !== 'object'
    || safe.value === null
    || Array.isArray(safe.value)
    || Object.keys(safe.value).length === 0
    || new TextEncoder().encode(safe.json).byteLength > MAX_EVIDENCE_BYTES
  ) return invalid()
  return { value: safe.value as Record<string, JsonValue>, json: safe.json }
}

function normalizeOptions(value: unknown): { value: DecisionOption[]; json: string } {
  if (!Array.isArray(value) || value.length < 2 || value.length > 10) return invalid()
  const options: DecisionOption[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (
      typeof raw !== 'object'
      || raw === null
      || Array.isArray(raw)
      || Object.keys(raw).length !== 2
      || Object.keys(raw).some((key) => !OPTION_KEYS.has(key))
    ) return invalid()
    const option = raw as Record<string, unknown>
    const id = safeText(option.id, 64)
    const label = safeText(option.label, 200)
    if (!OPTION_ID.test(id) || ids.has(id)) return invalid()
    ids.add(id)
    options.push({ id, label })
  }
  return { value: options, json: canonicalJson(options) }
}

function normalizeConsequences(
  value: unknown,
  options: DecisionOption[],
): { value: Record<string, string>; json: string } {
  const safe = safeJson(value)
  if (typeof safe.value !== 'object' || safe.value === null || Array.isArray(safe.value)) {
    return invalid()
  }
  const record = safe.value as Record<string, JsonValue>
  const keys = Object.keys(record).sort()
  const optionIds = options.map((option) => option.id).sort()
  if (canonicalJson(keys) !== canonicalJson(optionIds)) return invalid()
  const normalized: Record<string, string> = {}
  for (const option of options) {
    normalized[option.id] = safeText(record[option.id], 2_000)
  }
  return { value: normalized, json: canonicalJson(normalized) }
}

function canonicalExpiry(value: unknown): string {
  if (typeof value !== 'string') return invalid()
  const milliseconds = Date.parse(value)
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) return invalid()
  return value
}

function assertNewExpiryWindow(value: string): void {
  const delta = Date.parse(value) - Date.now()
  if (delta < MIN_EXPIRY_MS || delta > MAX_EXPIRY_MS) return invalid()
}

function normalizeCreateInput(input: CreateDecisionRequestInput): NormalizedCreateInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid()
  const required = [
    'decisionCause', 'dedupeKey', 'question', 'options', 'consequences',
    'evidence', 'expiresAt', 'idempotencyKey',
  ]
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
    || Object.keys(input).some((key) => !CREATE_KEYS.has(key))
    || !Object.prototype.hasOwnProperty.call(DECISION_POLICIES, input.decisionCause)
  ) return invalid()
  const policy = DECISION_POLICIES[input.decisionCause]
  const options = normalizeOptions(input.options)
  const consequences = normalizeConsequences(input.consequences, options.value)
  const evidence = safeEvidence(input.evidence)
  return {
    decisionCause: input.decisionCause,
    policy,
    dedupeKey: safeText(input.dedupeKey, 255),
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
    expiresAt: canonicalExpiry(input.expiresAt),
    idempotencyKey: safeText(input.idempotencyKey, 255),
  }
}

function normalizeResolutionInput(input: ResolveDecisionRequestInput): NormalizedResolutionInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid()
  const required = [
    'decisionRequestId', 'idempotencyKey', 'selectedOptionId',
    'consequencesAccepted', 'resolutionEvidence',
  ]
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(input, key))
    || Object.keys(input).some((key) => !RESOLUTION_KEYS.has(key))
    || input.consequencesAccepted !== true
  ) return invalid()
  const selectedOptionId = safeText(input.selectedOptionId, 64)
  if (!OPTION_ID.test(selectedOptionId)) return invalid()
  const evidence = safeEvidence(input.resolutionEvidence)
  return {
    decisionRequestId: safeText(input.decisionRequestId, 255),
    idempotencyKey: safeText(input.idempotencyKey, 255),
    selectedOptionId,
    consequencesAccepted: true,
    resolutionEvidence: evidence.value,
    resolutionJson: canonicalJson({
      resolutionEvidence: evidence.value,
      selectedOptionId,
    }),
    consequencesAcceptedJson: 'true',
  }
}

function policyForRow(row: DecisionRequestRow): DecisionPolicy {
  const policy = DECISION_POLICIES[row.decision_cause]
  if (
    policy === undefined
    || policy.decisionClass !== row.decision_class
    || policy.authority !== row.exact_authority_required
  ) throw new DecisionError('decision_persistence_conflict')
  return policy
}

function mapRequest(row: DecisionRequestRow): DecisionRequest {
  if (row.created_receipt_id === null) throw new DecisionError('decision_persistence_conflict')
  policyForRow(row)
  const options = JSON.parse(row.options_json) as DecisionOption[]
  return {
    id: row.id,
    tenant: row.tenant,
    decisionClass: row.decision_class,
    decisionCause: row.decision_cause,
    dedupeKey: row.dedupe_key,
    status: row.status,
    exactAuthorityRequired: row.exact_authority_required,
    question: row.question,
    options,
    consequences: JSON.parse(row.consequences_json) as Record<string, string>,
    evidence: JSON.parse(row.evidence_json) as Record<string, JsonValue>,
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
  const resolution = JSON.parse(row.resolution_json) as {
    selectedOptionId: string
    resolutionEvidence: Record<string, JsonValue>
  }
  if (row.consequences_accepted_json !== 'true') {
    throw new DecisionError('decision_persistence_conflict')
  }
  return {
    id: row.id,
    tenant: row.tenant,
    decisionRequestId: row.decision_request_id,
    idempotencyKey: row.idempotency_key,
    resolvedByPrincipalKind: row.resolved_by_principal_kind,
    resolvedByPrincipalId: row.resolved_by_principal_id,
    resolvedByMemberId: row.resolved_by_member_id,
    selectedOptionId: resolution.selectedOptionId,
    consequencesAccepted: true,
    resolutionEvidence: resolution.resolutionEvidence,
    resolutionReceiptId: row.resolution_receipt_id,
    resolvedAt: row.resolved_at,
  }
}

async function requestById(env: Env, id: string): Promise<DecisionRequestRow | null> {
  return env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM decision_requests
    WHERE tenant = ?1 AND id = ?2`).bind(env.TENANT_SLUG, id)
    .first<DecisionRequestRow>()
}

async function openRequestByDedupe(
  env: Env,
  dedupeKey: string,
): Promise<DecisionRequestRow | null> {
  return env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM decision_requests
    WHERE tenant = ?1 AND dedupe_key = ?2 AND status = 'open'`)
    .bind(env.TENANT_SLUG, dedupeKey).first<DecisionRequestRow>()
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
  input: { objectiveId: string | null; flightId: string | null; taskId: string | null },
): Promise<DecisionScope> {
  let scope: DecisionScope | null = null
  if (input.objectiveId !== null) {
    const row = await env.DB.prepare(`
      SELECT objective.squad_id, squad.department_id
        FROM objectives objective JOIN squads squad ON squad.id = objective.squad_id
       WHERE objective.tenant = ?1 AND objective.id = ?2
    `).bind(env.TENANT_SLUG, input.objectiveId)
      .first<{ squad_id: string; department_id: string }>()
    if (row === null) return invalid()
    scope = { squadId: row.squad_id, departmentId: row.department_id }
  }
  if (input.flightId !== null) {
    const row = await env.DB.prepare(`
      SELECT objective.id AS objective_id, objective.squad_id, squad.department_id
        FROM flight_objectives link
        JOIN objectives objective
          ON objective.id = link.objective_id AND objective.tenant = link.tenant
        JOIN squads squad ON squad.id = objective.squad_id
       WHERE link.tenant = ?1 AND link.flight_id = ?2
    `).bind(env.TENANT_SLUG, input.flightId)
      .first<{ objective_id: string; squad_id: string; department_id: string }>()
    if (
      row === null
      || (input.objectiveId !== null && row.objective_id !== input.objectiveId)
      || (scope !== null && scope.squadId !== row.squad_id)
    ) return invalid()
    scope = { squadId: row.squad_id, departmentId: row.department_id }
  }
  if (input.taskId !== null) {
    const row = await env.DB.prepare(`
      SELECT task.squad_id, squad.department_id
        FROM tasks task JOIN squads squad ON squad.id = task.squad_id
       WHERE task.id = ?1
    `).bind(input.taskId).first<{ squad_id: string; department_id: string }>()
    if (row === null || (scope !== null && scope.squadId !== row.squad_id)) return invalid()
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
  const tokenId = optionalId(auth.tokenId)
  if (tokenId !== null) {
    const token = await env.DB.prepare(`
      SELECT t.id FROM member_tokens t
       WHERE t.id = ?1 AND t.tenant = ?2 AND t.member_id = ?3
         AND t.agent_id IS ?4 AND ${TOKEN_LIVE_PREDICATE('?5')}
    `).bind(
      tokenId,
      env.TENANT_SLUG,
      principal.memberId,
      principal.agentId,
      nowSqlUtc(),
    ).first<{ id: string }>()
    if (token === null) throw new DecisionError('decision_forbidden')
  }
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
    tokenId,
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
  input: { objectiveId: string | null; flightId: string | null; taskId: string | null },
  scope: DecisionScope,
): Array<string | null> {
  return [
    input.objectiveId, input.objectiveId, env.TENANT_SLUG, scope.squadId,
    input.flightId, env.TENANT_SLUG, input.flightId, scope.squadId,
    input.objectiveId, input.objectiveId,
    input.taskId, input.taskId, scope.squadId,
  ]
}

function createdClaims(input: NormalizedCreateInput): JsonValue {
  return {
    consequences: input.consequences,
    decisionCause: input.decisionCause,
    decisionClass: input.policy.decisionClass,
    dedupeKey: input.dedupeKey,
    evidence: input.evidence,
    exactAuthorityRequired: input.policy.authority,
    expiresAt: input.expiresAt,
    options: input.options.map((option) => ({ id: option.id, label: option.label })),
    question: input.question,
  }
}

function resolvedClaims(
  request: DecisionRequestRow,
  input: NormalizedResolutionInput,
): JsonValue {
  return {
    consequencesAccepted: true,
    decisionCause: request.decision_cause,
    decisionRequestId: request.id,
    resolutionEvidence: input.resolutionEvidence,
    selectedOptionId: input.selectedOptionId,
  }
}

function expectedAuditRow(
  tenant: string,
  audit: AtomicDomainAuditMetadata,
): Omit<DecisionAuditRow, 'recorded_at'> {
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

async function requireExactAudit(env: Env, audit: AtomicDomainAuditMetadata): Promise<void> {
  const row = await env.DB.prepare(`
    SELECT id, tenant, principal_kind, principal_id, member_id, agent_id,
           credential_id, runtime_seat_id, runtime_generation, origin, handler,
           operation, target_kind, target_id, before_digest, after_digest,
           objective_id, flight_id, task_id, request_id, idempotency_key,
           evidence_json, recorded_at
      FROM mutation_audit_entries WHERE tenant = ?1 AND id = ?2
  `).bind(env.TENANT_SLUG, audit.expectedAuditId).first<DecisionAuditRow>()
  if (row === null || row.recorded_at.trim() === '') {
    throw new DecisionError('decision_audit_invalid')
  }
  const { recorded_at: _recordedAt, ...facts } = row
  if (canonicalJson(facts) !== canonicalJson(expectedAuditRow(env.TENANT_SLUG, audit))) {
    throw new DecisionError('decision_audit_invalid')
  }
}

async function createAudit(
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  tokenId: string | null,
  input: NormalizedCreateInput,
  id: string,
): Promise<AtomicDomainAuditMetadata> {
  return flightSpineAudit(auth, principal, {
    expectedAuditId: `audit:${id}:created`,
    credentialId: tokenId,
    handler: 'flight_spine.create_decision_request',
    operation: 'insert',
    targetKind: 'decision_request',
    targetId: id,
    afterDigest: await sha256Hex(canonicalJson(createdClaims(input))),
    objectiveId: input.objectiveId,
    flightId: input.flightId,
    taskId: input.taskId,
    requestId: `decision:${input.idempotencyKey}:create`,
    idempotencyKey: input.idempotencyKey,
    evidence: { decisionCause: input.decisionCause, dedupeKey: input.dedupeKey },
  })
}

async function expireAudit(
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  tokenId: string | null,
  expired: DecisionRequestRow,
  replacementId: string,
  replacementKey: string,
): Promise<AtomicDomainAuditMetadata> {
  return flightSpineAudit(auth, principal, {
    expectedAuditId: `audit:${expired.id}:expired:${replacementId}`,
    credentialId: tokenId,
    handler: 'flight_spine.create_decision_request',
    operation: 'expire',
    targetKind: 'decision_request',
    targetId: expired.id,
    beforeDigest: await sha256Hex(canonicalJson({ status: 'open' })),
    afterDigest: await sha256Hex(canonicalJson({ status: 'expired' })),
    objectiveId: expired.objective_id,
    flightId: expired.flight_id,
    taskId: expired.task_id,
    requestId: `decision:${replacementKey}:expire:${expired.id}`,
    idempotencyKey: replacementKey,
    evidence: { replacementDecisionRequestId: replacementId },
  })
}

async function exactCreateReplay(
  env: Env,
  auth: AuthContext,
  row: DecisionRequestRow,
  input: NormalizedCreateInput,
  principal: FlightSpinePrincipal,
  tokenId: string | null,
): Promise<DecisionRequest> {
  if (
    row.decision_class !== input.policy.decisionClass
    || row.decision_cause !== input.decisionCause
    || row.dedupe_key !== input.dedupeKey
    || row.exact_authority_required !== input.policy.authority
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
  ) throw new DecisionError('idempotency_conflict')
  const mapped = mapRequest(row)
  const receipt = await getExecutionReceipt(env, mapped.createdReceiptId)
  if (
    receipt === null
    || receipt.type !== 'decision.created'
    || receipt.actorKind !== principal.kind
    || receipt.actorId !== principal.id
    || receipt.objectiveId !== input.objectiveId
    || receipt.flightId !== input.flightId
    || receipt.taskId !== input.taskId
    || receipt.idempotencyKey !== `decision:${input.idempotencyKey}:created`
    || receipt.claimsJson !== canonicalJson(createdClaims(input))
    || !(await verifyExecutionReceipt(env, receipt.id)).ok
  ) throw new DecisionError('decision_persistence_conflict')
  await requireExactAudit(env, await createAudit(auth, principal, tokenId, input, row.id))
  return mapped
}

export async function createDecisionRequest(
  env: Env,
  auth: AuthContext,
  rawInput: CreateDecisionRequestInput,
): Promise<DecisionRequest> {
  const input = normalizeCreateInput(rawInput)
  const principal = await resolvePrincipal(env, auth)
  const scope = await resolveDecisionScope(env, input)
  if (input.policy.authority === 'squad:lead' && scope.squadId === null) return invalid()
  const authority = await requireAuthority(env, auth, principal, scope, 'member')
  const id = `decision:${(await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    idempotencyKey: input.idempotencyKey,
  }))).slice(0, 48)}`
  const sameId = await requestById(env, id)
  if (sameId !== null) {
    return exactCreateReplay(env, auth, sameId, input, principal, authority.tokenId)
  }
  assertNewExpiryWindow(input.expiresAt)
  const existingOpen = await openRequestByDedupe(env, input.dedupeKey)
  if (existingOpen !== null && Number(existingOpen.is_expired) !== 1) {
    throw new DecisionError('decision_already_open')
  }
  let expiredAuthority: LiveAuthority | null = null
  if (existingOpen !== null) {
    policyForRow(existingOpen)
    const expiredScope = await resolveDecisionScope(env, {
      objectiveId: existingOpen.objective_id,
      flightId: existingOpen.flight_id,
      taskId: existingOpen.task_id,
    })
    expiredAuthority = await requireAuthority(env, auth, principal, expiredScope, 'member')
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
  const mutations: PreparedAtomicDomainMutation[] = []
  if (existingOpen !== null) {
    if (expiredAuthority === null) throw new DecisionError('decision_persistence_conflict')
    const audit = await expireAudit(
      auth,
      principal,
      expiredAuthority.tokenId,
      existingOpen,
      id,
      input.idempotencyKey,
    )
    mutations.push(prepareAuditedDomainMutation(env.DB, {
      sql: `UPDATE decision_requests SET status = 'expired'
             WHERE id = ? AND tenant = ? AND dedupe_key = ? AND status = 'open'
               AND julianday(expires_at) <= julianday('now')
               AND ${LIVE_AUTHORITY_SQL}`,
      bindings: [
        existingOpen.id, env.TENANT_SLUG, input.dedupeKey,
        ...authorityBindings(env, expiredAuthority),
      ],
      audit,
    }))
  }
  const audit = await createAudit(auth, principal, authority.tokenId, input, id)
  mutations.push(prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO decision_requests (
      id, tenant, decision_class, decision_cause, dedupe_key, status,
      exact_authority_required, question, options_json, consequences_json,
      evidence_json, objective_id, flight_id, task_id,
      requested_by_principal_kind, requested_by_principal_id,
      requested_by_member_id, expires_at, created_receipt_id, created_at
    )
    SELECT ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE julianday(?) >= julianday('now', '+5 minutes')
       AND julianday(?) <= julianday('now', '+30 days')
       AND EXISTS (
         SELECT 1 FROM execution_receipts receipt
          WHERE receipt.id = ? AND receipt.tenant = ?
            AND receipt.type = 'decision.created'
            AND receipt.actor_kind = ? AND receipt.actor_id = ?
            AND receipt.objective_id IS ? AND receipt.flight_id IS ?
            AND receipt.task_id IS ? AND receipt.claims_json = ?
            AND receipt.receipt_hash = ?
       )
       AND ${correlationSql()}
       AND ${LIVE_AUTHORITY_SQL}`,
    bindings: [
      id, env.TENANT_SLUG, input.policy.decisionClass, input.decisionCause,
      input.dedupeKey, input.policy.authority, input.question, input.optionsJson,
      input.consequencesJson, input.evidenceJson, input.objectiveId,
      input.flightId, input.taskId, principal.kind, principal.id,
      principal.memberId, input.expiresAt, receipt.id, receipt.serverTimestamp,
      input.expiresAt, input.expiresAt,
      receipt.id, env.TENANT_SLUG, receipt.actorKind, receipt.actorId,
      input.objectiveId, input.flightId, input.taskId, receipt.claimsJson,
      receipt.receiptHash,
      ...correlationBindings(env, input, scope),
      ...authorityBindings(env, authority),
    ],
    audit,
  }))
  await executePreparedExecutionReceiptBatch(env, prepared, mutations)
  const row = await requestById(env, id)
  if (row === null) throw new DecisionError('decision_persistence_conflict')
  return exactCreateReplay(env, auth, row, input, principal, authority.tokenId)
}

async function resolutionAuthority(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  request: DecisionRequestRow,
): Promise<LiveAuthority> {
  const policy = policyForRow(request)
  const correlation = {
    objectiveId: request.objective_id,
    flightId: request.flight_id,
    taskId: request.task_id,
  }
  const correlatedScope = await resolveDecisionScope(env, correlation)
  if (policy.authority === 'squad:lead') {
    if (correlatedScope.squadId === null) throw new DecisionError('decision_forbidden')
    return requireAuthority(env, auth, principal, correlatedScope, 'lead')
  }
  return requireAuthority(
    env,
    auth,
    principal,
    { squadId: null, departmentId: null },
    'admin',
  )
}

function offeredOption(request: DecisionRequestRow, selectedOptionId: string): boolean {
  const options = JSON.parse(request.options_json) as DecisionOption[]
  return options.some((option) => option.id === selectedOptionId)
}

async function resolutionAudits(
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  tokenId: string | null,
  request: DecisionRequestRow,
  input: NormalizedResolutionInput,
  resolutionId: string,
  receiptId: string,
): Promise<[AtomicDomainAuditMetadata, AtomicDomainAuditMetadata]> {
  const beforeDigest = await sha256Hex(canonicalJson({ status: 'open' }))
  const afterDigest = await sha256Hex(canonicalJson({
    selectedOptionId: input.selectedOptionId,
    status: 'resolved',
  }))
  return [
    flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:${resolutionId}:insert`,
      credentialId: tokenId,
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
      evidence: { decisionRequestId: request.id, resolutionReceiptId: receiptId },
    }),
    flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:${request.id}:resolved`,
      credentialId: tokenId,
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
      evidence: { resolutionId, resolutionReceiptId: receiptId },
    }),
  ]
}

async function exactResolutionReplay(
  env: Env,
  auth: AuthContext,
  row: DecisionResolutionRow,
  request: DecisionRequestRow,
  input: NormalizedResolutionInput,
  principal: FlightSpinePrincipal,
  tokenId: string | null,
): Promise<DecisionResolution> {
  if (
    row.decision_request_id !== input.decisionRequestId
    || row.resolved_by_principal_kind !== principal.kind
    || row.resolved_by_principal_id !== principal.id
    || row.resolved_by_member_id !== principal.memberId
    || row.resolution_json !== input.resolutionJson
    || row.consequences_accepted_json !== input.consequencesAcceptedJson
  ) throw new DecisionError('idempotency_conflict')
  const receipt = await getExecutionReceipt(env, row.resolution_receipt_id)
  if (
    receipt === null
    || receipt.type !== 'decision.resolved'
    || receipt.actorKind !== principal.kind
    || receipt.actorId !== principal.id
    || receipt.objectiveId !== request.objective_id
    || receipt.flightId !== request.flight_id
    || receipt.taskId !== request.task_id
    || receipt.idempotencyKey !== `decision:${input.idempotencyKey}:resolved`
    || receipt.claimsJson !== canonicalJson(resolvedClaims(request, input))
    || !(await verifyExecutionReceipt(env, receipt.id)).ok
  ) throw new DecisionError('decision_persistence_conflict')
  const [insertAudit, updateAudit] = await resolutionAudits(
    auth,
    principal,
    tokenId,
    request,
    input,
    row.id,
    receipt.id,
  )
  await requireExactAudit(env, insertAudit)
  await requireExactAudit(env, updateAudit)
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
    const authority = await resolutionAuthority(env, auth, principal, request)
    return exactResolutionReplay(
      env,
      auth,
      existingResolution,
      request,
      input,
      principal,
      authority.tokenId,
    )
  }
  const request = await requestById(env, input.decisionRequestId)
  if (request === null) throw new DecisionError('decision_not_found')
  if (request.status !== 'open' || Number(request.is_expired) === 1) {
    throw new DecisionError('decision_not_open_or_expired')
  }
  if (!offeredOption(request, input.selectedOptionId)) return invalid()
  const authority = await resolutionAuthority(env, auth, principal, request)
  const prepared = await prepareFreshExecutionReceiptChain(env, auth, [{
    type: 'decision.resolved',
    idempotencyKey: `decision:${input.idempotencyKey}:resolved`,
    claims: resolvedClaims(request, input),
    objectiveId: request.objective_id,
    flightId: request.flight_id,
    taskId: request.task_id,
  }])
  const receipt = prepared.expectedReceipts[0]
  const resolutionId = `decision-resolution:${(await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    idempotencyKey: input.idempotencyKey,
  }))).slice(0, 40)}`
  const correlation = {
    objectiveId: request.objective_id,
    flightId: request.flight_id,
    taskId: request.task_id,
  }
  const correlatedScope = await resolveDecisionScope(env, correlation)
  const [insertAudit, updateAudit] = await resolutionAudits(
    auth,
    principal,
    authority.tokenId,
    request,
    input,
    resolutionId,
    receipt.id,
  )
  const insertMutation = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO decision_request_resolutions (
      id, tenant, decision_request_id, idempotency_key,
      resolved_by_principal_kind, resolved_by_principal_id,
      resolved_by_member_id, resolution_json, consequences_accepted_json,
      resolution_receipt_id, resolved_at
    )
    SELECT ?, ?, decision.id, ?, ?, ?, ?, ?, 'true', ?, ?
      FROM decision_requests decision
     WHERE decision.id = ? AND decision.tenant = ? AND decision.status = 'open'
       AND julianday(decision.expires_at) > julianday('now')
       AND EXISTS (
         SELECT 1 FROM json_each(decision.options_json) option
          WHERE json_extract(option.value, '$.id') = ?
       )
       AND EXISTS (
         SELECT 1 FROM execution_receipts receipt
          WHERE receipt.id = ? AND receipt.tenant = ?
            AND receipt.type = 'decision.resolved'
            AND receipt.actor_kind = ? AND receipt.actor_id = ?
            AND receipt.objective_id IS ? AND receipt.flight_id IS ?
            AND receipt.task_id IS ? AND receipt.claims_json = ?
            AND receipt.receipt_hash = ?
       )
       AND ${correlationSql()}
       AND ${LIVE_AUTHORITY_SQL}`,
    bindings: [
      resolutionId, env.TENANT_SLUG, input.idempotencyKey, principal.kind,
      principal.id, principal.memberId, input.resolutionJson, receipt.id,
      receipt.serverTimestamp, request.id, env.TENANT_SLUG, input.selectedOptionId,
      receipt.id, env.TENANT_SLUG, receipt.actorKind, receipt.actorId,
      request.objective_id, request.flight_id, request.task_id,
      receipt.claimsJson, receipt.receiptHash,
      ...correlationBindings(env, correlation, correlatedScope),
      ...authorityBindings(env, authority),
    ],
    audit: insertAudit,
  })
  const updateMutation = prepareAuditedDomainMutation(env.DB, {
    sql: `UPDATE decision_requests SET status = 'resolved', resolved_at = ?
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
    audit: updateAudit,
  })
  await executePreparedExecutionReceiptBatch(
    env,
    prepared,
    [insertMutation, updateMutation],
  )
  const row = await resolutionByKey(env, input.idempotencyKey)
  if (row === null) throw new DecisionError('decision_persistence_conflict')
  return exactResolutionReplay(
    env,
    auth,
    row,
    request,
    input,
    principal,
    authority.tokenId,
  )
}
