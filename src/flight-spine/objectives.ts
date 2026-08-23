// src/flight-spine/objectives.ts — Flight Spine objective acceptance and lifecycle services.

import type { AuthContext, Env } from '../types'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import { appendExecutionReceipt } from './receipts'

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

interface ObjectiveRow {
  id: string
  tenant: string
  created_by_principal_kind: string
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
  created_at: string
}

interface KeyRow {
  objective_id: string
  payload_digest: string
  acceptance_receipt_id: string | null
}

function parseJsonField<T>(field: string, name: string): T {
  try {
    return JSON.parse(field) as T
  } catch {
    throw new Error(`invalid_json_field: ${name}`)
  }
}

export async function acceptObjective(
  env: Env,
  auth: AuthContext,
  input: AcceptObjectiveInput,
): Promise<AcceptedObjective> {
  const tenant = env.TENANT_SLUG
  if (!tenant) throw new Error('missing_tenant')

  if (!auth || !auth.memberId) {
    throw new Error('unauthorized: member identity required')
  }

  const squadId = input.squadId?.trim()
  if (!squadId) throw new Error('invalid_input: squadId required')

  const title = input.title?.trim()
  if (!title || title.length > 200) {
    throw new Error('invalid_input: title must be between 1 and 200 characters')
  }

  const successContract = input.successContract?.trim()
  if (!successContract || successContract.length > 8000) {
    throw new Error('invalid_input: successContract must be between 1 and 8000 characters')
  }

  if (typeof input.budgetMicroUsd !== 'number' || input.budgetMicroUsd < 0 || !Number.isInteger(input.budgetMicroUsd)) {
    throw new Error('invalid_input: budgetMicroUsd must be a non-negative integer')
  }

  const idempotencyKey = input.idempotencyKey?.trim()
  if (!idempotencyKey || idempotencyKey.length > 255) {
    throw new Error('invalid_input: idempotencyKey must be between 1 and 255 characters')
  }

  if (!input.authorityEnvelope || typeof input.authorityEnvelope !== 'object') {
    throw new Error('invalid_input: authorityEnvelope must be a JSON object')
  }
  if (!input.policy || typeof input.policy !== 'object') {
    throw new Error('invalid_input: policy must be a JSON object')
  }
  if (!input.payload || typeof input.payload !== 'object') {
    throw new Error('invalid_input: payload must be a JSON object')
  }

  const payloadCanonical = canonicalJson(input.payload)
  const payloadDigest = await sha256Hex(payloadCanonical)
  const authorityJson = canonicalJson(input.authorityEnvelope)
  const policyJson = canonicalJson(input.policy)

  // Verify squad existence
  const squadRow = await env.DB.prepare('SELECT id FROM squads WHERE id = ?1').bind(squadId).first()
  if (!squadRow) {
    throw new Error('squad_not_found')
  }

  // Idempotency check
  const existingKey = await env.DB.prepare(`
    SELECT objective_id, payload_digest, acceptance_receipt_id
      FROM objective_acceptance_keys
     WHERE tenant = ?1 AND idempotency_key = ?2
  `).bind(tenant, idempotencyKey).first<KeyRow>()

  if (existingKey) {
    if (existingKey.payload_digest !== payloadDigest) {
      throw new Error('idempotency_conflict: payload digest mismatch for idempotency key')
    }
    const existingObj = await getObjective(env, auth, existingKey.objective_id)
    if (existingObj) return existingObj
    throw new Error('integrity_failure: idempotency key exists but objective not found')
  }

  const objectiveId = crypto.randomUUID()
  const now = new Date().toISOString()

  const creatorPrincipalKind = auth.boundAgentId ? 'agent' : 'member'
  const creatorPrincipalId = auth.boundAgentId ?? auth.memberId
  const creatorMemberId = auth.memberId

  // Append objective.authorized receipt
  const authReceipt = await appendExecutionReceipt(env, auth, {
    type: 'objective.authorized',
    idempotencyKey: `${idempotencyKey}:authorized`,
    claims: {
      squadId,
      projectId: input.projectId ?? null,
      budgetMicroUsd: input.budgetMicroUsd,
      authorityEnvelope: input.authorityEnvelope as JsonValue,
      policy: input.policy as JsonValue,
    },
  })

  // Append objective.accepted receipt
  const acceptedReceipt = await appendExecutionReceipt(env, auth, {
    type: 'objective.accepted',
    idempotencyKey: `${idempotencyKey}:accepted`,
    objectiveId,
    claims: {
      squadId,
      projectId: input.projectId ?? null,
      title,
      successContract,
      budgetMicroUsd: input.budgetMicroUsd,
      payloadDigest,
      authorizedReceiptId: authReceipt.id,
    },
  })

  const batchResults = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO objectives (
        id, tenant, created_by_principal_kind, created_by_principal_id, created_by_member_id,
        squad_id, project_id, title, success_contract, authority_envelope, policy_json,
        budget_micro_usd, payload_json, payload_digest, accepted_at, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10, ?11,
        ?12, ?13, ?14, ?15, ?16
      )
    `).bind(
      objectiveId,
      tenant,
      creatorPrincipalKind,
      creatorPrincipalId,
      creatorMemberId,
      squadId,
      input.projectId ?? null,
      title,
      successContract,
      authorityJson,
      policyJson,
      input.budgetMicroUsd,
      payloadCanonical,
      payloadDigest,
      now,
      now,
    ),
    env.DB.prepare(`
      INSERT INTO objective_acceptance_keys (
        id, tenant, idempotency_key, objective_id, payload_digest, acceptance_receipt_id, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).bind(
      crypto.randomUUID(),
      tenant,
      idempotencyKey,
      objectiveId,
      payloadDigest,
      acceptedReceipt.id,
      now,
    ),
  ])

  if (!batchResults || batchResults.length < 2) {
    throw new Error('persistence_failure: objective batch insert failed')
  }

  return {
    id: objectiveId,
    tenant,
    squadId,
    projectId: input.projectId ?? null,
    title,
    successContract,
    authorityEnvelope: input.authorityEnvelope,
    policy: input.policy,
    budgetMicroUsd: input.budgetMicroUsd,
    payload: input.payload,
    payloadDigest,
    acceptedAt: now,
    acceptanceReceiptId: acceptedReceipt.id,
  }
}

export async function getObjective(
  env: Env,
  _auth: AuthContext,
  objectiveId: string,
): Promise<AcceptedObjective | null> {
  const tenant = env.TENANT_SLUG
  if (!tenant || !objectiveId) return null

  const row = await env.DB.prepare(`
    SELECT id, tenant, created_by_principal_kind, created_by_principal_id, created_by_member_id,
           squad_id, project_id, title, success_contract, authority_envelope, policy_json,
           budget_micro_usd, payload_json, payload_digest, accepted_at, created_at
      FROM objectives
     WHERE tenant = ?1 AND id = ?2
  `).bind(tenant, objectiveId).first<ObjectiveRow>()

  if (!row) return null

  const keyRow = await env.DB.prepare(`
    SELECT acceptance_receipt_id
      FROM objective_acceptance_keys
     WHERE tenant = ?1 AND objective_id = ?2
  `).bind(tenant, objectiveId).first<{ acceptance_receipt_id: string | null }>()

  return {
    id: row.id,
    tenant: row.tenant,
    squadId: row.squad_id,
    projectId: row.project_id,
    title: row.title,
    successContract: row.success_contract,
    authorityEnvelope: parseJsonField<Record<string, unknown>>(row.authority_envelope, 'authorityEnvelope'),
    policy: parseJsonField<Record<string, unknown>>(row.policy_json, 'policy'),
    budgetMicroUsd: row.budget_micro_usd,
    payload: parseJsonField<Record<string, unknown>>(row.payload_json, 'payload'),
    payloadDigest: row.payload_digest,
    acceptedAt: row.accepted_at,
    acceptanceReceiptId: keyRow?.acceptance_receipt_id ?? '',
  }
}
