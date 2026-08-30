import { canOnSquad, resolveCapabilities } from '../auth/capability'
import { canonicalJson, sha256Hex } from '../lib/canonical-json'
import type { AuthContext, Env } from '../types'
import { resolveTaskAssignee } from './assignee'
import { verifyTaskArtifactShape } from './artifact-verification'
import { isValidGateOwnerForm } from './service'

export type TaskDispatchRuntimeStage = 'runtime_consumed' | 'completed' | 'failed'

export interface RecordTaskDispatchRuntimeReceiptInput {
  taskId: string
  dispatchReceiptId: string
  messageId: string
  stage: TaskDispatchRuntimeStage
  runtimeReceiptHash: string
  attempt: number
  artifactRefs?: string[]
  artifactSha256?: string | null
  result?: string | null
  reason?: string | null
}

export interface TaskDispatchRuntimeReceipt {
  id: string
  tenant: string
  dispatch_receipt_id: string
  task_id: string
  agent_id: string
  message_id: string
  member_id: string
  credential_id: string
  stage: TaskDispatchRuntimeStage
  attempt: number
  runtime_address: string
  runtime_receipt_hash: string
  request_digest: string
  artifact_refs: string[]
  artifact_sha256: string | null
  result: string | null
  reason: string | null
  audit_entry_id: string
  created_at: string
}

export interface PublicTaskDispatchRuntimeReceipt {
  stage: TaskDispatchRuntimeStage
  attempt: number
  runtime_address: string
  runtime_receipt_hash: string
  artifact_refs: string[]
  artifact_sha256: string | null
  result: string | null
  reason: string | null
  created_at: string
}

export type TaskDispatchRuntimeReceiptErrorCode =
  | 'agent_bound_workspace_credential_required'
  | 'runtime_receipt_invalid'
  | 'runtime_delivery_not_found'
  | 'runtime_delivery_stale'
  | 'runtime_receipt_forbidden'
  | 'runtime_receipt_conflict'
  | 'runtime_artifact_required'
  | 'runtime_gate_required'
  | 'runtime_receipt_transition_conflict'
  | 'runtime_receipt_persistence_conflict'

export class TaskDispatchRuntimeReceiptError extends Error {
  readonly name = 'TaskDispatchRuntimeReceiptError'

  constructor(readonly code: TaskDispatchRuntimeReceiptErrorCode) {
    super(code)
  }
}

interface DeliveryRow {
  dispatch_consumed_at: string | null
  dispatch_agent_id: string
  dispatch_squad_id: string
  dispatch_project_id: string | null
  task_status: string
  task_assignee_agent_id: string | null
  task_squad_id: string
  task_project_id: string | null
  task_done_when: string
  task_gate_owner: string | null
  agent_status: string
  message_to_agent: string
  message_from_agent: string
  message_request_id: string | null
  message_project_id: string | null
  message_body: string
  message_read_at: string | null
  message_delivery_attempts: number
  message_lease_expires_at: string | null
  message_dead_lettered_at: string | null
}

interface ReceiptRow extends Omit<TaskDispatchRuntimeReceipt, 'artifact_refs'> {
  artifact_refs_json: string
}

const SHA256_RE = /^[0-9a-f]{64}$/
const STAGES = new Set<TaskDispatchRuntimeStage>(['runtime_consumed', 'completed', 'failed'])

function text(value: unknown, maximum = 255): string {
  if (typeof value !== 'string') throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  }
  return normalized
}

function optionalText(value: unknown, maximum: number): string | null {
  return value === undefined || value === null ? null : text(value, maximum)
}

function publicReceipt(row: ReceiptRow): TaskDispatchRuntimeReceipt {
  const refs = JSON.parse(row.artifact_refs_json) as unknown
  if (!Array.isArray(refs) || !refs.every((value) => typeof value === 'string')) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_persistence_conflict')
  }
  const { artifact_refs_json: _artifactRefsJson, ...receipt } = row
  return { ...receipt, artifact_refs: refs }
}

function publicTimelineReceipt(row: ReceiptRow): PublicTaskDispatchRuntimeReceipt {
  const receipt = publicReceipt(row)
  return {
    stage: receipt.stage,
    attempt: receipt.attempt,
    runtime_address: receipt.runtime_address,
    runtime_receipt_hash: receipt.runtime_receipt_hash,
    artifact_refs: receipt.artifact_refs,
    artifact_sha256: receipt.artifact_sha256,
    result: receipt.result,
    reason: receipt.reason,
    created_at: receipt.created_at,
  }
}

async function loadDelivery(
  env: Env,
  input: RecordTaskDispatchRuntimeReceiptInput,
): Promise<DeliveryRow> {
  const row = await env.DB.prepare(`
    SELECT
      dispatch.consumed_at AS dispatch_consumed_at,
      dispatch.agent_id AS dispatch_agent_id,
      dispatch.squad_id AS dispatch_squad_id,
      dispatch.project_id AS dispatch_project_id,
      task.status AS task_status,
      task.assignee_agent_id AS task_assignee_agent_id,
      task.squad_id AS task_squad_id,
      task.project_id AS task_project_id,
      task.done_when AS task_done_when,
      task.gate_owner AS task_gate_owner,
      agent.status AS agent_status,
      message.to_agent AS message_to_agent,
      message.from_agent AS message_from_agent,
      message.request_id AS message_request_id,
      message.project_id AS message_project_id,
      message.body AS message_body,
      message.read_at AS message_read_at,
      message.delivery_attempts AS message_delivery_attempts,
      message.lease_expires_at AS message_lease_expires_at,
      message.dead_lettered_at AS message_dead_lettered_at
    FROM task_dispatch_receipts dispatch
    JOIN tasks task ON task.id = dispatch.task_id
    JOIN agents agent ON agent.id = dispatch.agent_id
    JOIN agent_messages message ON message.id = ?1 AND message.tenant = dispatch.tenant
    WHERE dispatch.tenant = ?2 AND dispatch.id = ?3 AND dispatch.task_id = ?4
      AND dispatch.agent_id = task.assignee_agent_id
      AND dispatch.squad_id = task.squad_id
    LIMIT 1
  `).bind(input.messageId, env.TENANT_SLUG, input.dispatchReceiptId, input.taskId)
    .first<DeliveryRow>()
  if (!row) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_not_found')
  return row
}

function validateEnvelope(
  row: DeliveryRow,
  input: RecordTaskDispatchRuntimeReceiptInput,
  now: string,
  allowAcknowledgedReplay: boolean,
): string {
  if (
    row.dispatch_consumed_at === null
    || row.agent_status !== 'active'
    || row.message_from_agent !== 'mupot-dispatch'
    || row.message_request_id !== `dispatch-inbox:${input.dispatchReceiptId}`
    || row.message_project_id !== row.task_project_id
    || row.dispatch_project_id !== row.task_project_id
    || row.message_dead_lettered_at !== null
    || row.message_delivery_attempts !== input.attempt
    || (!allowAcknowledgedReplay && (
      row.message_read_at !== null
      || row.message_lease_expires_at === null
      || row.message_lease_expires_at <= now
    ))
  ) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_stale')

  let parsed: unknown
  try { parsed = JSON.parse(row.message_body) } catch {
    throw new TaskDispatchRuntimeReceiptError('runtime_delivery_stale')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskDispatchRuntimeReceiptError('runtime_delivery_stale')
  }
  const body = parsed as Record<string, unknown>
  if (
    Object.keys(body).sort().join('\n') !== 'dispatch_receipt_id\nruntime_address\nsquad_id\ntask_id\ntype\nversion'
    || body.version !== 'runtime.dispatch/v1'
    || body.type !== 'task_dispatch'
    || body.task_id !== input.taskId
    || body.dispatch_receipt_id !== input.dispatchReceiptId
    || body.squad_id !== row.task_squad_id
    || body.runtime_address !== row.message_to_agent
  ) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_stale')
  return row.message_to_agent
}

export async function recordTaskDispatchRuntimeReceipt(
  env: Env,
  auth: AuthContext,
  input: RecordTaskDispatchRuntimeReceiptInput,
  options: { origin?: 'mcp' | 'rest' } = {},
): Promise<{ receipt: PublicTaskDispatchRuntimeReceipt; task_status: string }> {
  const memberId = auth.memberId?.trim() ?? ''
  const credentialId = auth.tokenId?.trim() ?? ''
  const agentId = auth.boundAgentId?.trim() ?? ''
  if (
    auth.channel !== 'workspace' || auth.tenant !== env.TENANT_SLUG
    || memberId === '' || credentialId === '' || agentId === ''
  ) throw new TaskDispatchRuntimeReceiptError('agent_bound_workspace_credential_required')
  if (
    !STAGES.has(input.stage)
    || !Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 5
    || !SHA256_RE.test(text(input.runtimeReceiptHash, 64))
  ) throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  text(input.taskId, 200); text(input.dispatchReceiptId, 200); text(input.messageId, 200)
  const artifactRefs = (input.artifactRefs ?? []).map((value) => text(value, 2000))
  if (artifactRefs.length > 20 || new Set(artifactRefs).size !== artifactRefs.length) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  }
  const artifactSha256 = optionalText(input.artifactSha256, 64)
  if (artifactSha256 !== null && !SHA256_RE.test(artifactSha256)) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  }
  const result = optionalText(input.result, 20_000)
  const reason = optionalText(input.reason, 2_000)
  if ((input.stage === 'completed' && result === null) || (input.stage === 'failed' && reason === null)) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_invalid')
  }
  const requestJson = canonicalJson({
    task_id: input.taskId,
    dispatch_receipt_id: input.dispatchReceiptId,
    message_id: input.messageId,
    stage: input.stage,
    runtime_receipt_hash: input.runtimeReceiptHash,
    attempt: input.attempt,
    artifact_refs: artifactRefs,
    artifact_sha256: artifactSha256,
    result,
    reason,
  })
  const requestDigest = await sha256Hex(requestJson)
  const replay = await env.DB.prepare(`
    SELECT * FROM task_dispatch_runtime_receipts
     WHERE tenant = ?1 AND dispatch_receipt_id = ?2 AND stage = ?3 AND attempt = ?4
  `).bind(env.TENANT_SLUG, input.dispatchReceiptId, input.stage, input.attempt).first<ReceiptRow>()

  const now = new Date().toISOString()
  const token = await env.DB.prepare(`
    SELECT id FROM member_tokens
     WHERE id = ?1 AND member_id = ?2 AND agent_id = ?3 AND tenant = ?4
       AND channel = 'workspace' AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?5)
  `).bind(credentialId, memberId, agentId, env.TENANT_SLUG, now).first<{ id: string }>()
  if (!token) throw new TaskDispatchRuntimeReceiptError('agent_bound_workspace_credential_required')

  const delivery = await loadDelivery(env, input)
  if (delivery.dispatch_agent_id !== agentId || delivery.task_assignee_agent_id !== agentId) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_forbidden')
  }
  const grants = await resolveCapabilities(env, memberId)
  const assignee = await resolveTaskAssignee(env, agentId, delivery.task_squad_id)
  if (!(await canOnSquad(env, grants, delivery.task_squad_id, 'member')) || assignee.value !== agentId) {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_forbidden')
  }
  const runtimeAddress = validateEnvelope(delivery, input, now, replay !== null)
  if (
    input.stage === 'completed'
    && (delivery.task_gate_owner === null || !isValidGateOwnerForm(delivery.task_gate_owner))
  ) {
    throw new TaskDispatchRuntimeReceiptError('runtime_gate_required')
  }
  if (
    input.stage === 'completed'
    && (/Artifact:/i.test(delivery.task_done_when) || /SHA256:/i.test(delivery.task_done_when))
  ) {
    const verified = verifyTaskArtifactShape(result)
    if (
      !verified.verified
      || !artifactRefs.includes(verified.path)
      || artifactSha256 !== verified.sha256Claimed
    ) {
      throw new TaskDispatchRuntimeReceiptError('runtime_artifact_required')
    }
  }
  if (replay) {
    if (replay.request_digest !== requestDigest) {
      throw new TaskDispatchRuntimeReceiptError('runtime_receipt_conflict')
    }
    const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1')
      .bind(input.taskId).first<{ status: string }>()
    if (!task) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_not_found')
    return { receipt: publicTimelineReceipt(replay), task_status: task.status }
  }

  const receiptId = crypto.randomUUID()
  const auditId = crypto.randomUUID()
  const requestId = `task-runtime-receipt:${input.dispatchReceiptId}:${input.stage}:${input.attempt}`
  const evidence = canonicalJson({
    dispatch_receipt_id: input.dispatchReceiptId,
    message_id: input.messageId,
    stage: input.stage,
    attempt: input.attempt,
    request_digest: requestDigest,
  })
  try {
    const mutation = input.stage === 'runtime_consumed'
      ? env.DB.prepare(`
          UPDATE tasks SET status = 'in_progress', execution_receipt_id = ?1,
            execution_claim_expires_at = NULL, updated_at = ?2
           WHERE id = ?3 AND assignee_agent_id = ?4
             AND status IN ('open', 'blocked', 'rejected')
             AND (execution_receipt_id IS NULL OR execution_receipt_id = ?1)
             AND NOT EXISTS (
               SELECT 1 FROM task_dispatch_runtime_receipts failed
                WHERE failed.tenant = ?5
                  AND failed.dispatch_receipt_id = ?1
                  AND failed.stage = 'failed'
             )
          RETURNING status
        `).bind(input.dispatchReceiptId, now, input.taskId, agentId, env.TENANT_SLUG)
      : input.stage === 'completed'
        ? env.DB.prepare(`
            UPDATE tasks SET status = 'review', result = ?1, updated_at = ?2
             WHERE id = ?3 AND assignee_agent_id = ?4
               AND status = 'in_progress' AND execution_receipt_id = ?5
               AND gate_owner IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM task_dispatch_runtime_receipts consumed
                  WHERE consumed.tenant = ?6
                    AND consumed.dispatch_receipt_id = ?5
                    AND consumed.stage = 'runtime_consumed'
                    AND consumed.attempt = ?7
               )
            RETURNING status
          `).bind(result, now, input.taskId, agentId, input.dispatchReceiptId,
            env.TENANT_SLUG, input.attempt)
        : env.DB.prepare(`
            UPDATE tasks SET status = 'blocked', result = ?1, updated_at = ?2
             WHERE id = ?3 AND assignee_agent_id = ?4
               AND status IN ('open', 'in_progress', 'blocked', 'rejected')
               AND (execution_receipt_id IS NULL OR execution_receipt_id = ?5)
            RETURNING status
          `).bind(reason, now, input.taskId, agentId, input.dispatchReceiptId)
    await env.DB.batch([
      mutation,
      env.DB.prepare(`
        INSERT INTO mutation_audit_entries (
          id, tenant, principal_kind, principal_id, member_id, agent_id,
          credential_id, origin, handler, operation, target_kind, target_id,
          task_id, request_id, idempotency_key, evidence_json, recorded_at
        ) VALUES (
          ?1, ?2,
          CASE WHEN changes() = 1 THEN 'agent' ELSE 'invalid_runtime_receipt_transition' END,
          ?3, ?4, ?3, ?5, ?6, 'task_dispatch_runtime_receipt',
          ?7, 'task', ?8, ?8, ?9, ?9, ?10, ?11
        )
      `).bind(auditId, env.TENANT_SLUG, agentId, memberId, credentialId,
        options.origin ?? 'mcp', input.stage, input.taskId, requestId, evidence, now),
      env.DB.prepare(`
        INSERT INTO task_dispatch_runtime_receipts (
          id, tenant, dispatch_receipt_id, task_id, agent_id, message_id,
          member_id, credential_id, stage, attempt, runtime_address,
          runtime_receipt_hash, request_digest, artifact_refs_json,
          artifact_sha256, result, reason, audit_entry_id, created_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
      `).bind(receiptId, env.TENANT_SLUG, input.dispatchReceiptId, input.taskId,
        agentId, input.messageId, memberId, credentialId, input.stage, input.attempt,
        runtimeAddress, input.runtimeReceiptHash, requestDigest, JSON.stringify(artifactRefs),
        artifactSha256, result, reason, auditId, now),
    ])
  } catch {
    throw new TaskDispatchRuntimeReceiptError('runtime_receipt_transition_conflict')
  }

  const persisted = await env.DB.prepare('SELECT * FROM task_dispatch_runtime_receipts WHERE id = ?1')
    .bind(receiptId).first<ReceiptRow>()
  const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1')
    .bind(input.taskId).first<{ status: string }>()
  if (!persisted || !task) throw new TaskDispatchRuntimeReceiptError('runtime_receipt_persistence_conflict')
  return { receipt: publicTimelineReceipt(persisted), task_status: task.status }
}

export interface TaskDispatchReceiptTimeline {
  transport: Array<{
    agent_slug: string
    agent_name: string
    dispatched_at: string
    transport_delivered_at: string | null
  }>
  runtime: PublicTaskDispatchRuntimeReceipt[]
  gate: Array<{
    verdict: 'approved' | 'rejected'
    note: string | null
    decided_by_display: string
    decided_at: string
  }>
  task_status: string
}

export async function listTaskDispatchReceiptTimeline(
  env: Env,
  taskId: string,
  limit = 20,
): Promise<TaskDispatchReceiptTimeline> {
  const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 20
  const task = await env.DB.prepare('SELECT status FROM tasks WHERE id = ?1 LIMIT 1')
    .bind(taskId).first<{ status: string }>()
  if (!task) throw new TaskDispatchRuntimeReceiptError('runtime_delivery_not_found')
  const transport = await env.DB.prepare(`
    SELECT agent.slug AS agent_slug, agent.name AS agent_name,
           dispatch.created_at AS dispatched_at,
           dispatch.consumed_at AS transport_delivered_at
      FROM task_dispatch_receipts dispatch
      JOIN agents agent ON agent.id = dispatch.agent_id
     WHERE dispatch.tenant = ?1 AND dispatch.task_id = ?2
     ORDER BY dispatch.created_at, dispatch.id
     LIMIT ?3
  `).bind(env.TENANT_SLUG, taskId, boundedLimit).all<{
    agent_slug: string
    agent_name: string
    dispatched_at: string
    transport_delivered_at: string | null
  }>()
  const runtime = await env.DB.prepare(`
    SELECT * FROM task_dispatch_runtime_receipts
     WHERE tenant = ?1 AND task_id = ?2
     ORDER BY created_at,
       CASE stage WHEN 'runtime_consumed' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
       id
     LIMIT ?3
  `).bind(env.TENANT_SLUG, taskId, boundedLimit).all<ReceiptRow>()
  const gate = await env.DB.prepare(`
    SELECT verdict.verdict, verdict.note,
           COALESCE(NULLIF(agent.name, ''), NULLIF(member.display_name, ''), 'Independent gate')
             AS decided_by_display,
           verdict.decided_at
      FROM task_verdicts verdict
      LEFT JOIN agents agent ON agent.id = verdict.decided_by
      LEFT JOIN members member ON member.id = verdict.decided_by
     WHERE verdict.task_id = ?1
     ORDER BY verdict.decided_at, verdict.id
     LIMIT ?2
  `).bind(taskId, boundedLimit).all<{
    verdict: 'approved' | 'rejected'
    note: string | null
    decided_by_display: string
    decided_at: string
  }>()
  return {
    transport: transport.results ?? [],
    runtime: (runtime.results ?? []).map(publicTimelineReceipt),
    gate: gate.results ?? [],
    task_status: task.status,
  }
}
