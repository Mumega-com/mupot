import type { AuthContext, Capability, Env } from '../types'
import { hasCapability, resolveCapabilities } from '../auth/capability'
import { isEnforceableCap } from '../agents/meter'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import {
  TaskProjectError,
  validateTaskProjectAttribution,
} from '../tasks/service'
import {
  executePreparedExecutionReceiptBatch,
  prepareAuditedDomainMutation,
  prepareFreshExecutionReceiptChain,
  type AtomicDomainAuditMetadata,
} from './receipts'
import type { JsonValue } from './types'

export interface AcceptedObjective {
  id: string
  tenant: string
  squadId: string
  projectId: string | null
  title: string
  successContract: string
  authorityEnvelope: Record<string, unknown>
  policy: Record<string, unknown>
  budgetMicroUsd: number
  payload: Record<string, unknown>
  payloadDigest: string
  acceptedAt: string
  acceptanceReceiptId: string
}

export interface AcceptObjectiveInput {
  squadId: string
  projectId?: string | null
  title: string
  successContract: string
  authorityEnvelope: Record<string, unknown>
  policy: Record<string, unknown>
  budgetMicroUsd: number
  payload: Record<string, unknown>
  idempotencyKey: string
}

export type ObjectiveErrorCode =
  | 'unauthorized_tenant'
  | 'invalid_actor'
  | 'invalid_objective'
  | 'objective_forbidden'
  | 'objective_budget_forbidden'
  | 'objective_budget_exceeds_cap'
  | 'project_access_forbidden'
  | 'idempotency_conflict'
  | 'objective_persistence_conflict'

export class ObjectiveError extends Error {
  readonly name = 'ObjectiveError'

  constructor(
    readonly code: ObjectiveErrorCode,
    readonly detail?: Record<string, unknown>,
  ) {
    super(code)
  }
}

interface ObjectiveRow {
  id: string
  tenant: string
  created_by_principal_kind: 'member' | 'agent'
  created_by_principal_id: string
  created_by_member_id: string
  squad_id: string
  project_id: string | null
  title: string
  success_contract: string
  authority_envelope: string
  policy_json: string
  budget_micro_usd: number
  payload_json: string
  payload_digest: string
  accepted_at: string
  acceptance_receipt_id: string | null
}

interface SquadAuthorityRow {
  id: string
  department_id: string
  budget_cap_cents: number | null
}

export interface FlightSpinePrincipal {
  readonly kind: 'member' | 'agent'
  readonly id: string
  readonly memberId: string
  readonly authorityMemberId: string
  readonly agentId: string | null
  readonly agentBudgetCapCents: number | null
}

interface NormalizedObjectiveInput {
  squadId: string
  projectId: string | null
  title: string
  successContract: string
  authorityEnvelope: Record<string, unknown>
  authorityEnvelopeJson: string
  policy: Record<string, unknown>
  policyJson: string
  budgetMicroUsd: number
  payload: Record<string, unknown>
  payloadJson: string
  payloadDigest: string
  idempotencyKey: string
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') throw new ObjectiveError('invalid_objective')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new ObjectiveError('invalid_objective')
  }
  return normalized
}

function canonicalRecord(value: unknown): { value: Record<string, unknown>; json: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ObjectiveError('invalid_objective')
  }
  try {
    const json = canonicalJson(value)
    return { value: JSON.parse(json) as Record<string, unknown>, json }
  } catch {
    throw new ObjectiveError('invalid_objective')
  }
}

async function normalizeInput(input: AcceptObjectiveInput): Promise<NormalizedObjectiveInput> {
  if (typeof input !== 'object' || input === null) throw new ObjectiveError('invalid_objective')
  const squadId = boundedText(input.squadId, 200)
  const projectId = input.projectId === null || input.projectId === undefined
    ? null
    : boundedText(input.projectId, 200)
  const title = boundedText(input.title, 200)
  const successContract = boundedText(input.successContract, 8_000)
  const idempotencyKey = boundedText(input.idempotencyKey, 180)
  if (!Number.isSafeInteger(input.budgetMicroUsd) || input.budgetMicroUsd < 0) {
    throw new ObjectiveError('invalid_objective')
  }
  const authorityEnvelope = canonicalRecord(input.authorityEnvelope)
  const policy = canonicalRecord(input.policy)
  const payload = canonicalRecord(input.payload)
  return {
    squadId,
    projectId,
    title,
    successContract,
    authorityEnvelope: authorityEnvelope.value,
    authorityEnvelopeJson: authorityEnvelope.json,
    policy: policy.value,
    policyJson: policy.json,
    budgetMicroUsd: input.budgetMicroUsd,
    payload: payload.value,
    payloadJson: payload.json,
    payloadDigest: await sha256Hex(payload.json),
    idempotencyKey,
  }
}

/** Server-derived identity shared by the Task 3 Flight Spine services. */
export async function resolveFlightSpinePrincipal(
  env: Env,
  auth: AuthContext,
): Promise<FlightSpinePrincipal> {
  if (auth.tenant !== env.TENANT_SLUG) throw new ObjectiveError('unauthorized_tenant')
  const memberId = (auth.memberId ?? auth.userId).trim()
  if (memberId === '') throw new ObjectiveError('invalid_actor')
  const member = await env.DB.prepare(`
    SELECT id FROM members
     WHERE id = ?1 AND tenant = ?2 AND status = 'active'
  `).bind(memberId, env.TENANT_SLUG).first<{ id: string }>()
  if (!member) throw new ObjectiveError('invalid_actor')

  const boundAgentId = auth.boundAgentId?.trim() || null
  const authorityMemberId = auth.consentedByMemberId?.trim() || memberId
  if (authorityMemberId !== memberId) {
    const authorityMember = await env.DB.prepare(`
      SELECT id FROM members
       WHERE id = ?1 AND tenant = ?2 AND status = 'active'
    `).bind(authorityMemberId, env.TENANT_SLUG).first<{ id: string }>()
    if (!authorityMember) throw new ObjectiveError('invalid_actor')
  }
  if (boundAgentId === null) {
    return {
      kind: 'member', id: memberId, memberId, authorityMemberId,
      agentId: null, agentBudgetCapCents: null,
    }
  }
  const agent = await env.DB.prepare(`
    SELECT a.id, a.budget_cap_cents
      FROM agents a
      JOIN agent_member_bindings binding
        ON binding.agent_id = a.id
       AND binding.tenant = ?1
       AND binding.member_id = ?2
     WHERE a.id = ?3 AND a.status = 'active'
  `).bind(env.TENANT_SLUG, memberId, boundAgentId)
    .first<{ id: string; budget_cap_cents: number | null }>()
  if (!agent) throw new ObjectiveError('invalid_actor')
  return {
    kind: 'agent',
    id: agent.id,
    memberId,
    authorityMemberId,
    agentId: agent.id,
    agentBudgetCapCents: agent.budget_cap_cents,
  }
}

/** Current, database-backed squad authority; caller-provided grants are never authoritative. */
export async function requireFlightSpineSquadAuthority(
  env: Env,
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  squadId: string,
  minimum: Capability,
): Promise<SquadAuthorityRow> {
  const squad = await env.DB.prepare(`
    SELECT id, department_id, budget_cap_cents FROM squads WHERE id = ?1
  `).bind(squadId).first<SquadAuthorityRow>()
  if (!squad) throw new ObjectiveError('objective_forbidden')

  const legacyAdmin = auth.capabilities === undefined
    && (auth.role === 'owner' || auth.role === 'admin')
  // A defined capability view is the auth layer's effective ambient authority.
  // In particular, [] is the directory ceiling and a narrowed array can be a
  // consent clamp; rereading wider DB grants here would undo both controls.
  const grants = auth.capabilities ?? (await resolveCapabilities(env, principal.authorityMemberId))
  if (!legacyAdmin && !hasCapability(
    grants,
    'squad',
    squad.id,
    minimum,
    squad.department_id,
  )) {
    throw new ObjectiveError(minimum === 'lead'
      ? 'objective_budget_forbidden'
      : 'objective_forbidden')
  }
  if (principal.agentId !== null) {
    const membership = await env.DB.prepare(`
      SELECT capability FROM memberships
       WHERE agent_id = ?1 AND squad_id = ?2
    `).bind(principal.agentId, squad.id).first<{ capability: Capability }>()
    if (!membership || !hasCapability([{
      member_id: principal.memberId,
      scope_type: 'squad',
      scope_id: squad.id,
      capability: membership.capability,
    }], 'squad', squad.id, minimum)) {
      throw new ObjectiveError(minimum === 'lead'
        ? 'objective_budget_forbidden'
        : 'objective_forbidden')
    }
  }
  return squad
}

function originForAuth(auth: AuthContext): AtomicDomainAuditMetadata['origin'] {
  return auth.channel === 'dashboard' ? 'admin_ui' : 'mcp'
}

export function flightSpineAudit(
  auth: AuthContext,
  principal: FlightSpinePrincipal,
  input: Omit<AtomicDomainAuditMetadata,
    'principalKind' | 'principalId' | 'memberId' | 'agentId' | 'origin'>,
): AtomicDomainAuditMetadata {
  return {
    ...input,
    principalKind: principal.kind,
    principalId: principal.id,
    memberId: principal.memberId,
    agentId: principal.agentId,
    origin: originForAuth(auth),
  }
}

function mapObjective(row: ObjectiveRow): AcceptedObjective | null {
  if (row.acceptance_receipt_id === null) return null
  return {
    id: row.id,
    tenant: row.tenant,
    squadId: row.squad_id,
    projectId: row.project_id,
    title: row.title,
    successContract: row.success_contract,
    authorityEnvelope: JSON.parse(row.authority_envelope) as Record<string, unknown>,
    policy: JSON.parse(row.policy_json) as Record<string, unknown>,
    budgetMicroUsd: Number(row.budget_micro_usd),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    payloadDigest: row.payload_digest,
    acceptedAt: row.accepted_at,
    acceptanceReceiptId: row.acceptance_receipt_id,
  }
}

async function objectiveById(env: Env, objectiveId: string): Promise<ObjectiveRow | null> {
  return env.DB.prepare(`
    SELECT objective.id, objective.tenant, objective.created_by_principal_kind,
           objective.created_by_principal_id, objective.created_by_member_id,
           objective.squad_id, objective.project_id, objective.title,
           objective.success_contract, objective.authority_envelope,
           objective.policy_json, objective.budget_micro_usd, objective.payload_json,
           objective.payload_digest, objective.accepted_at,
           acceptance.acceptance_receipt_id
      FROM objectives objective
      LEFT JOIN objective_acceptance_keys acceptance
        ON acceptance.tenant = objective.tenant
       AND acceptance.objective_id = objective.id
     WHERE objective.tenant = ?1 AND objective.id = ?2
     ORDER BY acceptance.created_at
     LIMIT 1
  `).bind(env.TENANT_SLUG, objectiveId).first<ObjectiveRow>()
}

async function objectiveByKey(env: Env, key: string): Promise<ObjectiveRow | null> {
  return env.DB.prepare(`
    SELECT objective.id, objective.tenant, objective.created_by_principal_kind,
           objective.created_by_principal_id, objective.created_by_member_id,
           objective.squad_id, objective.project_id, objective.title,
           objective.success_contract, objective.authority_envelope,
           objective.policy_json, objective.budget_micro_usd, objective.payload_json,
           objective.payload_digest, objective.accepted_at,
           acceptance.acceptance_receipt_id
      FROM objective_acceptance_keys acceptance
      JOIN objectives objective
        ON objective.id = acceptance.objective_id
       AND objective.tenant = acceptance.tenant
     WHERE acceptance.tenant = ?1 AND acceptance.idempotency_key = ?2
  `).bind(env.TENANT_SLUG, key).first<ObjectiveRow>()
}

function sameObjective(row: ObjectiveRow, input: NormalizedObjectiveInput): boolean {
  return row.squad_id === input.squadId
    && row.project_id === input.projectId
    && row.title === input.title
    && row.success_contract === input.successContract
    && row.authority_envelope === input.authorityEnvelopeJson
    && row.policy_json === input.policyJson
    && Number(row.budget_micro_usd) === input.budgetMicroUsd
    && row.payload_json === input.payloadJson
    && row.payload_digest === input.payloadDigest
}

function replayObjective(row: ObjectiveRow, input: NormalizedObjectiveInput): AcceptedObjective {
  if (!sameObjective(row, input)) throw new ObjectiveError('idempotency_conflict')
  const mapped = mapObjective(row)
  if (mapped === null) throw new ObjectiveError('objective_persistence_conflict')
  return mapped
}

function replayObjectiveForPrincipal(
  row: ObjectiveRow,
  input: NormalizedObjectiveInput,
  principal: FlightSpinePrincipal,
): AcceptedObjective {
  if (
    row.created_by_principal_kind !== principal.kind
    || row.created_by_principal_id !== principal.id
    || row.created_by_member_id !== principal.memberId
  ) {
    throw new ObjectiveError('idempotency_conflict')
  }
  return replayObjective(row, input)
}

export async function acceptObjective(
  env: Env,
  auth: AuthContext,
  rawInput: AcceptObjectiveInput,
): Promise<AcceptedObjective> {
  const input = await normalizeInput(rawInput)
  const principal = await resolveFlightSpinePrincipal(env, auth)
  const minimum: Capability = input.budgetMicroUsd > 0 ? 'lead' : 'member'
  const squad = await requireFlightSpineSquadAuthority(
    env,
    auth,
    principal,
    input.squadId,
    minimum,
  )
  if (input.projectId !== null) {
    try {
      await validateTaskProjectAttribution(env, input.projectId, input.squadId)
    } catch (error) {
      if (error instanceof TaskProjectError) throw new ObjectiveError('project_access_forbidden')
      throw error
    }
  }

  if (input.budgetMicroUsd > 0) {
    const sources = [
      principal.agentId === null ? null : {
        kind: 'agent' as const,
        id: principal.agentId,
        cap: principal.agentBudgetCapCents,
      },
      { kind: 'squad' as const, id: squad.id, cap: squad.budget_cap_cents },
    ].filter((value): value is NonNullable<typeof value> => value !== null)
    const configured = sources.filter((source) => isEnforceableCap(source.cap))
    if (configured.length > 0) {
      const binding = configured.reduce((lowest, source) => (
        (source.cap as number) < (lowest.cap as number) ? source : lowest
      ))
      const capMicroUsd = (binding.cap as number) * 10_000
      if (input.budgetMicroUsd > capMicroUsd) {
        throw new ObjectiveError('objective_budget_exceeds_cap', {
          capMicroUsd,
          bindingKind: binding.kind,
          bindingId: binding.id,
        })
      }
    }
  }

  const existing = await objectiveByKey(env, input.idempotencyKey)
  if (existing) {
    return replayObjectiveForPrincipal(existing, input, principal)
  }

  const objectiveIdentityDigest = await sha256Hex(canonicalJson({
    tenant: env.TENANT_SLUG,
    idempotencyKey: input.idempotencyKey,
  }))
  const objectiveId = `objective-${objectiveIdentityDigest.slice(0, 32)}`
  const acceptedAt = new Date().toISOString()
  const requestDigest = await sha256Hex(canonicalJson({
    squadId: input.squadId,
    projectId: input.projectId,
    title: input.title,
    successContract: input.successContract,
    authorityEnvelope: input.authorityEnvelope,
    policy: input.policy,
    budgetMicroUsd: input.budgetMicroUsd,
    payload: input.payload,
  }))
  const prepared = await prepareFreshExecutionReceiptChain(env, auth, [
    {
      type: 'objective.authorized',
      idempotencyKey: `objective:${input.idempotencyKey}:authorized`,
      objectiveId,
      claims: {
        squadId: input.squadId,
        projectId: input.projectId,
        budgetMicroUsd: input.budgetMicroUsd,
        payloadDigest: input.payloadDigest,
      },
    },
    {
      type: 'objective.accepted',
      idempotencyKey: `objective:${input.idempotencyKey}:accepted`,
      objectiveId,
      claims: { accepted: true, payloadDigest: input.payloadDigest },
    },
  ])
  const acceptanceReceipt = prepared.expectedReceipts[1]
  const objectiveMutation = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO objectives (
      id, tenant, created_by_principal_kind, created_by_principal_id,
      created_by_member_id, squad_id, project_id, title, success_contract,
      authority_envelope, policy_json, budget_micro_usd, payload_json,
      payload_digest, accepted_at, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM members member
        WHERE member.id = ? AND member.tenant = ? AND member.status = 'active'
     )
       AND EXISTS (
         SELECT 1 FROM members authority_member
          WHERE authority_member.id = ? AND authority_member.tenant = ?
            AND authority_member.status = 'active'
       )
       AND EXISTS (
         SELECT 1 FROM squads squad
          WHERE squad.id = ?
            AND (? = 0 OR squad.budget_cap_cents IS NULL
              OR squad.budget_cap_cents <= 0
              OR ? <= squad.budget_cap_cents * 10000)
       )
       AND (
         ? = 1
         OR EXISTS (
           SELECT 1
             FROM capabilities capability
             JOIN squads squad ON squad.id = ?
            WHERE capability.member_id = ?
              AND (
                capability.scope_type = 'org'
                OR (capability.scope_type = 'department'
                  AND capability.scope_id = squad.department_id)
                OR (capability.scope_type = 'squad'
                  AND capability.scope_id = squad.id)
              )
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= ?
         )
         OR EXISTS (
           SELECT 1 FROM channel_capability_grants capability
            WHERE capability.member_id = ? AND capability.squad_id = ?
              AND CASE capability.capability
                WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'lead' THEN 3
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= ?
         )
       )
       AND (
         ? IS NULL
         OR EXISTS (
           SELECT 1
             FROM projects project
             JOIN project_squad_access access
               ON access.project_id = project.id AND access.squad_id = ?
            WHERE project.id = ? AND project.status <> 'archived'
              AND access.access_level IN ('write', 'admin')
         )
       )
       AND (
         ? IS NULL
         OR EXISTS (
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
                WHEN 'member' THEN 2 WHEN 'observer' THEN 1 ELSE 0 END >= ?
              AND (? = 0 OR agent.budget_cap_cents IS NULL
                OR agent.budget_cap_cents <= 0
                OR ? <= agent.budget_cap_cents * 10000)
         )
       )`,
    bindings: [
      objectiveId,
      env.TENANT_SLUG,
      principal.kind,
      principal.id,
      principal.memberId,
      input.squadId,
      input.projectId,
      input.title,
      input.successContract,
      input.authorityEnvelopeJson,
      input.policyJson,
      input.budgetMicroUsd,
      input.payloadJson,
      input.payloadDigest,
      acceptedAt,
      acceptedAt,
      principal.memberId,
      env.TENANT_SLUG,
      principal.authorityMemberId,
      env.TENANT_SLUG,
      input.squadId,
      input.budgetMicroUsd,
      input.budgetMicroUsd,
      auth.capabilities === undefined && (auth.role === 'owner' || auth.role === 'admin') ? 1 : 0,
      input.squadId,
      principal.authorityMemberId,
      minimum === 'lead' ? 3 : 2,
      principal.authorityMemberId,
      input.squadId,
      minimum === 'lead' ? 3 : 2,
      input.projectId,
      input.squadId,
      input.projectId,
      principal.agentId,
      env.TENANT_SLUG,
      principal.memberId,
      input.squadId,
      principal.agentId,
      minimum === 'lead' ? 3 : 2,
      input.budgetMicroUsd,
      input.budgetMicroUsd,
    ],
    audit: flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:${objectiveId}:objective`,
      handler: 'flight_spine.accept_objective',
      operation: 'insert',
      targetKind: 'objective',
      targetId: objectiveId,
      afterDigest: requestDigest,
      objectiveId,
      requestId: `objective:${input.idempotencyKey}:objective`,
      idempotencyKey: input.idempotencyKey,
      evidence: { payloadDigest: input.payloadDigest } as JsonValue,
    }),
  })
  const keyMutation = prepareAuditedDomainMutation(env.DB, {
    sql: `INSERT INTO objective_acceptance_keys (
      id, tenant, idempotency_key, objective_id, payload_digest,
      acceptance_receipt_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      crypto.randomUUID(),
      env.TENANT_SLUG,
      input.idempotencyKey,
      objectiveId,
      input.payloadDigest,
      acceptanceReceipt.id,
      acceptedAt,
    ],
    audit: flightSpineAudit(auth, principal, {
      expectedAuditId: `audit:${objectiveId}:acceptance-key`,
      handler: 'flight_spine.accept_objective',
      operation: 'insert',
      targetKind: 'objective_acceptance_key',
      targetId: input.idempotencyKey,
      afterDigest: input.payloadDigest,
      objectiveId,
      requestId: `objective:${input.idempotencyKey}:acceptance-key`,
      idempotencyKey: input.idempotencyKey,
      evidence: { acceptanceReceiptId: acceptanceReceipt.id },
    }),
  })

  try {
    await executePreparedExecutionReceiptBatch(env, prepared, [objectiveMutation, keyMutation])
  } catch (error) {
    const raced = await objectiveByKey(env, input.idempotencyKey)
    if (raced) return replayObjectiveForPrincipal(raced, input, principal)
    throw new ObjectiveError('objective_persistence_conflict', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  const row = await objectiveById(env, objectiveId)
  if (!row) throw new ObjectiveError('objective_persistence_conflict')
  return replayObjective(row, input)
}

export async function getObjective(
  env: Env,
  auth: AuthContext,
  objectiveId: string,
): Promise<AcceptedObjective | null> {
  const id = boundedText(objectiveId, 200)
  const row = await objectiveById(env, id)
  if (!row) return null
  const principal = await resolveFlightSpinePrincipal(env, auth)
  await requireFlightSpineSquadAuthority(env, auth, principal, row.squad_id, 'observer')
  return mapObjective(row)
}
