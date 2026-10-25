// src/bus/doorbell-delivery.ts — signed webhook doorbell, as a subscription kind on the
// events-delivery path (no second webhook stack, no Durable Object).
//
// message.created (and a task.assigned / test handoff) enqueues ONE
// `mcp.doorbell.delivery` job. The job is a routing hint. This worker re-reads the
// doorbell row and the message or task from D1, signs, POSTs, writes one receipt,
// and schedules the retry with delaySeconds. Attempt numbers come from the receipts
// table, never from the job.
//
// A legacy doorbell row is not delivered here. The inline bearer POST in
// src/agents/webhook-doorbell.ts remains the only ring for delivery_version='legacy'.
// WEBHOOK_DOORBELL_SIGNED off: every function returns before a read.

import type { BusEvent, Env } from '../types'
import { ASSIGNMENT_WAKE_SENDER } from '../agents/system-senders'
import {
  COALESCE_WINDOW_MS,
  DOORBELL_TEST_TYPE,
  DOORBELL_TIMEOUT_MS,
  INBOX_WAKE_TYPE,
  TASK_ASSIGNED_TYPE,
  TEST_PING_LIMIT,
  TEST_PING_WINDOW_MS,
  WAKE_BURST_LIMIT,
  dispatchDoorbellCorrelation,
  validateHttpsWebhookUrl,
  webhookDoorbellEnabled,
  webhookDoorbellSignedEnabled,
  type DoorbellDelivery,
  type WebhookDoorbellWake,
} from '../agents/webhook-doorbell'
import { signedDoorbellBody, signDoorbellAttempt, type SignedDoorbellFields } from '../agents/doorbell-signature'
import { decryptConnectorSecret } from '../connectors/crypto'
import { DISPATCH_INBOX_PREFIX } from './fleet-bridge'
import { backoffDelaySec, MAX_DELIVERY_ATTEMPTS } from './events-delivery'
import { postSigned, validateCallbackUrl } from '../mcp/events-webhook'
import { ROUTINE_ACTOR } from '../routines/running-action'

/** The only fields a job may carry. `attempt` is intentionally absent. */
export interface DoorbellDeliveryJob {
  wake_type: WebhookDoorbellWake['type']
  agent_id: string
  ref_id: string
  assignment?: string
  correlation?: string
}

export type SignedDeliveryResult = {
  outcome: 'delivered' | 'retry' | 'failed' | 'dead_letter' | 'skipped' | 'refused' | 'rate_limited'
  http_status?: number
  reason?: string
}

const WAKE_TYPES = new Set<string>([INBOX_WAKE_TYPE, TASK_ASSIGNED_TYPE, DOORBELL_TEST_TYPE])

function parseJob(v: unknown): DoorbellDeliveryJob | null {
  if (typeof v !== 'object' || v === null) return null
  const j = v as Record<string, unknown>
  if (typeof j.wake_type !== 'string' || !WAKE_TYPES.has(j.wake_type)) return null
  if (typeof j.agent_id !== 'string' || j.agent_id.length === 0 || j.agent_id.length > 200) return null
  if (typeof j.ref_id !== 'string' || j.ref_id.length === 0 || j.ref_id.length > 200) return null
  const assignment = typeof j.assignment === 'string' && j.assignment.length > 0 && j.assignment.length <= 200
    ? j.assignment
    : undefined
  const correlation = typeof j.correlation === 'string' && j.correlation.length > 0 && j.correlation.length <= 200
    ? j.correlation
    : undefined
  return {
    wake_type: j.wake_type as DoorbellDeliveryJob['wake_type'],
    agent_id: j.agent_id,
    ref_id: j.ref_id,
    ...(assignment ? { assignment } : {}),
    ...(correlation ? { correlation } : {}),
  }
}

async function webhookIdFor(agentId: string, eventType: string, ref: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${agentId}\n${eventType}\n${ref}`),
  )
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
  return `msg_${hex}`
}

function toDoorbellDelivery(result: SignedDeliveryResult): DoorbellDelivery {
  if (result.outcome === 'delivered') return { outcome: 'posted', http_status: result.http_status }
  if (result.outcome === 'rate_limited') return { outcome: 'rate_limited', reason: result.reason }
  if (result.outcome === 'skipped' || result.outcome === 'refused') return { outcome: 'skipped', reason: result.reason }
  return { outcome: 'failed', http_status: result.http_status, reason: result.reason ?? result.outcome }
}

/** Queue a signed wake. Direct BUS.send: createBus().emit refuses this internal type. */
export async function enqueueSignedDoorbellJob(
  env: Env,
  wake: WebhookDoorbellWake,
  correlation?: string,
): Promise<void> {
  const job: DoorbellDeliveryJob = {
    wake_type: wake.type,
    agent_id: wake.agent_id,
    ref_id: wake.type === INBOX_WAKE_TYPE ? wake.message_id : wake.type === TASK_ASSIGNED_TYPE ? wake.task_id : 'test',
    ...(wake.type === TASK_ASSIGNED_TYPE && wake.assignment ? { assignment: wake.assignment } : {}),
    ...(correlation ? { correlation } : {}),
  }
  await env.BUS.send({
    type: 'mcp.doorbell.delivery',
    tenant: env.TENANT_SLUG,
    agent_id: wake.agent_id,
    payload: job,
    ts: new Date().toISOString(),
  })
}

/**
 * Signed row, seen from the legacy deliver function: a test ping is delivered
 * here (the human is waiting); every other wake is enqueued and not POSTed inline.
 */
export async function handoffSignedDoorbell(
  env: Env,
  wake: WebhookDoorbellWake,
  correlation: string | undefined,
  kind: 'wake' | 'test',
): Promise<DoorbellDelivery> {
  if (kind === 'test') {
    const result = await deliverSignedDoorbell(env, {
      wake_type: DOORBELL_TEST_TYPE,
      agent_id: wake.agent_id,
      ref_id: 'test',
    }, { timeoutMs: DOORBELL_TIMEOUT_MS })
    return toDoorbellDelivery(result)
  }
  await enqueueSignedDoorbellJob(env, wake, correlation)
  return { outcome: 'skipped', reason: 'queued_signed' }
}

function isRoutineEnvelope(row: { from_agent: string; kind: string; request_id: string | null }): boolean {
  return row.from_agent === ROUTINE_ACTOR
    && row.kind === 'request'
    && typeof row.request_id === 'string'
    && row.request_id.startsWith('routine-run:')
}

/**
 * Fan-out from the message.created consumer. Flag off: no read. Routine-fenced
 * envelopes (re-derived from the row, not from the queue payload) are not queued.
 * A duplicate job is absorbed at delivery time.
 */
export async function enqueueSignedInboxDoorbell(env: Env, event: BusEvent): Promise<number> {
  if (!webhookDoorbellSignedEnabled(env) || !webhookDoorbellEnabled(env)) return 0
  const tenant = env.TENANT_SLUG
  if (!tenant) return 0
  const hint = event.payload as { message_id?: unknown; to_agent?: unknown } | null
  if (!hint || typeof hint.message_id !== 'string' || hint.message_id.length === 0) return 0
  const message = await env.DB.prepare(
    `SELECT id, to_agent, from_agent, kind, request_id FROM agent_messages WHERE id = ?1 AND tenant = ?2`,
  ).bind(hint.message_id, tenant).first<{
    id: string
    to_agent: string
    from_agent: string
    kind: string
    request_id: string | null
  }>()
  if (!message) return 0
  if (isRoutineEnvelope(message)) return 0
  const bell = await env.DB.prepare(
    `SELECT agent_id, delivery_version FROM agent_webhook_doorbells WHERE tenant = ?1 AND agent_id = ?2`,
  ).bind(tenant, message.to_agent).first<{ agent_id: string; delivery_version: string }>()
  if (!bell || bell.delivery_version !== 'signed') return 0
  await enqueueSignedDoorbellJob(env, {
    type: INBOX_WAKE_TYPE,
    agent_id: bell.agent_id,
    seq: 0,
    message_id: message.id,
    kind: message.kind,
  })
  return 1
}

interface DoorbellRow {
  agent_id: string
  webhook_url: string
  auth_ciphertext: string
  delivery_version: string
}

async function loadDoorbell(env: Env, tenant: string, agentHint: string): Promise<DoorbellRow | null> {
  return env.DB.prepare(
    `SELECT d.agent_id AS agent_id, d.webhook_url AS webhook_url, d.auth_ciphertext AS auth_ciphertext,
            d.delivery_version AS delivery_version
       FROM agent_webhook_doorbells d
      WHERE d.tenant = ?1
        AND d.agent_id = COALESCE(
          (SELECT a.id FROM agents a WHERE a.id = ?2),
          (SELECT a.id FROM agents a WHERE a.slug = ?2
            AND (SELECT count(*) FROM agents b WHERE b.slug = ?2) = 1))`,
  ).bind(tenant, agentHint).first<DoorbellRow>()
}

type Facts =
  | { kind: 'wake'; eventType: DoorbellDeliveryJob['wake_type']; ref: string; fields: SignedDoorbellFields }
  | { kind: 'routine' }
  | { kind: 'refuse'; reason: string; ref: string; eventType: DoorbellDeliveryJob['wake_type'] }

async function confirmedDispatchRef(env: Env, tenant: string, agentId: string, taskId: string, receiptId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM task_dispatch_receipts WHERE tenant = ?1 AND id = ?2 AND agent_id = ?3 AND task_id = ?4`,
  ).bind(tenant, receiptId, agentId, taskId).first<{ x: number }>()
  return row !== null
}

async function loadFacts(env: Env, tenant: string, agentId: string, job: DoorbellDeliveryJob): Promise<Facts> {
  if (job.wake_type === DOORBELL_TEST_TYPE) {
    return {
      kind: 'wake',
      eventType: DOORBELL_TEST_TYPE,
      ref: 'test',
      fields: { type: DOORBELL_TEST_TYPE, agent_id: agentId },
    }
  }
  if (job.wake_type === INBOX_WAKE_TYPE) {
    const message = await env.DB.prepare(
      `SELECT seq, to_agent, from_agent, kind, request_id FROM agent_messages WHERE id = ?1 AND tenant = ?2`,
    ).bind(job.ref_id, tenant).first<{
      seq: number
      to_agent: string
      from_agent: string
      kind: string
      request_id: string | null
    }>()
    if (!message) return { kind: 'refuse', reason: 'message_not_found', ref: job.ref_id, eventType: INBOX_WAKE_TYPE }
    if (message.to_agent !== agentId) {
      return { kind: 'refuse', reason: 'message_not_addressed', ref: job.ref_id, eventType: INBOX_WAKE_TYPE }
    }
    if (isRoutineEnvelope(message)) return { kind: 'routine' }
    let ref = job.ref_id
    if (typeof message.request_id === 'string' && message.request_id.startsWith(DISPATCH_INBOX_PREFIX)) {
      const receiptId = message.request_id.slice(DISPATCH_INBOX_PREFIX.length)
      // The bridge letter's request id is the receipt. Confirm that receipt names this agent,
      // then share the ref task.assigned uses (`dispatch:<receiptId>`).
      const owned = await env.DB.prepare(
        `SELECT task_id FROM task_dispatch_receipts WHERE tenant = ?1 AND id = ?2 AND agent_id = ?3`,
      ).bind(tenant, receiptId, agentId).first<{ task_id: string }>()
      if (owned && await confirmedDispatchRef(env, tenant, agentId, owned.task_id, receiptId)) {
        ref = dispatchDoorbellCorrelation(receiptId)
      }
    } else if (message.from_agent === ASSIGNMENT_WAKE_SENDER) {
      const wakes = await env.DB.prepare(
        `SELECT task_id, epoch FROM task_assignment_wakes
          WHERE tenant = ?1 AND agent_id = ?2
            AND (message_seq = ?3 OR (message_seq IS NULL AND outcome IN ('pending', 'sent', 'queued')))`,
      ).bind(tenant, agentId, message.seq).all<{ task_id: string; epoch: string }>()
      const rows = wakes.results ?? []
      if (rows.length === 1) ref = `${rows[0].task_id}#${rows[0].epoch}`
    }
    return {
      kind: 'wake',
      eventType: INBOX_WAKE_TYPE,
      ref,
      fields: {
        type: INBOX_WAKE_TYPE,
        agent_id: agentId,
        seq: Number(message.seq),
        message_id: job.ref_id,
        kind: message.kind,
      },
    }
  }
  const task = await env.DB.prepare(
    `SELECT assignee_agent_id, updated_at FROM tasks WHERE id = ?1`,
  ).bind(job.ref_id).first<{ assignee_agent_id: string | null; updated_at: string }>()
  if (!task || task.assignee_agent_id !== agentId) {
    return { kind: 'refuse', reason: 'task_not_assigned', ref: job.ref_id, eventType: TASK_ASSIGNED_TYPE }
  }
  let ref = job.ref_id
  if (job.correlation?.startsWith('dispatch:')) {
    const receiptId = job.correlation.slice('dispatch:'.length)
    if (await confirmedDispatchRef(env, tenant, agentId, job.ref_id, receiptId)) ref = job.correlation
  } else if (job.assignment) {
    const wake = await env.DB.prepare(
      `SELECT 1 AS x FROM task_assignment_wakes WHERE tenant = ?1 AND task_id = ?2 AND agent_id = ?3 AND epoch = ?4`,
    ).bind(tenant, job.ref_id, agentId, job.assignment).first<{ x: number }>()
    if (wake || task.updated_at === job.assignment) ref = `${job.ref_id}#${job.assignment}`
  }
  return {
    kind: 'wake',
    eventType: TASK_ASSIGNED_TYPE,
    ref,
    fields: { type: TASK_ASSIGNED_TYPE, agent_id: agentId, task_id: job.ref_id },
  }
}

async function insertReceipt(
  env: Env,
  tenant: string,
  agentId: string,
  eventType: string,
  ref: string,
  outcome: string,
  fields: { httpStatus?: number; errorClass?: string; signedAt?: string; attempt?: number },
  nowIso: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_webhook_doorbell_receipts
       (id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at, attempt, error_class, signed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?11)`,
  ).bind(
    crypto.randomUUID(),
    tenant,
    agentId,
    eventType,
    ref,
    outcome,
    fields.httpStatus ?? null,
    nowIso,
    fields.attempt ?? null,
    fields.errorClass ?? null,
    fields.signedAt ?? null,
  ).run()
}

async function finishClaim(
  env: Env,
  claimId: string,
  outcome: string,
  fields: { httpStatus?: number; errorClass?: string; signedAt?: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE agent_webhook_doorbell_receipts
        SET outcome = ?1, http_status = ?2, error_class = ?3, signed_at = ?4
      WHERE id = ?5 AND outcome = 'claimed'`,
  ).bind(outcome, fields.httpStatus ?? null, fields.errorClass ?? null, fields.signedAt ?? null, claimId).run()
}

type Claim =
  | { kind: 'go'; id: string; attempt: number }
  | { kind: 'stop'; result: SignedDeliveryResult }

async function beginAttempt(
  env: Env,
  tenant: string,
  agentId: string,
  eventType: string,
  ref: string,
  nowMs: number,
): Promise<Claim> {
  const nowIso = new Date(nowMs).toISOString()
  const terminal = await env.DB.prepare(
    `SELECT 1 AS x FROM agent_webhook_doorbell_receipts
      WHERE tenant = ?1 AND agent_id = ?2 AND event_type = ?3 AND ref_id = ?4
        AND outcome IN ('posted', 'failed', 'dead_letter', 'skipped') LIMIT 1`,
  ).bind(tenant, agentId, eventType, ref).first<{ x: number }>()
  if (terminal) return { kind: 'stop', result: { outcome: 'skipped', reason: 'terminal' } }

  const prior = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_webhook_doorbell_receipts
      WHERE tenant = ?1 AND agent_id = ?2 AND event_type = ?3 AND ref_id = ?4
        AND outcome IN ('retry', 'claimed')`,
  ).bind(tenant, agentId, eventType, ref).first<{ n: number }>()
  const attempt = Number(prior?.n ?? 0) + 1
  if (attempt > MAX_DELIVERY_ATTEMPTS) {
    return { kind: 'stop', result: { outcome: 'skipped', reason: 'terminal' } }
  }

  if (attempt === 1 && eventType !== DOORBELL_TEST_TYPE) {
    const since = new Date(nowMs - COALESCE_WINDOW_MS).toISOString()
    const burst = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM agent_webhook_doorbell_receipts
        WHERE tenant = ?1 AND agent_id = ?2 AND event_type <> ?3
          AND outcome IN ('claimed', 'posted', 'failed', 'retry', 'dead_letter')
          AND attempted_at > ?4`,
    ).bind(tenant, agentId, DOORBELL_TEST_TYPE, since).first<{ n: number }>()
    if (Number(burst?.n ?? 0) >= WAKE_BURST_LIMIT) {
      await insertReceipt(env, tenant, agentId, eventType, ref, 'skipped', { errorClass: 'coalesced', attempt: 1 }, nowIso)
      return { kind: 'stop', result: { outcome: 'skipped', reason: 'coalesced' } }
    }
  }

  if (eventType === DOORBELL_TEST_TYPE) {
    const since = new Date(nowMs - TEST_PING_WINDOW_MS).toISOString()
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM agent_webhook_doorbell_receipts
        WHERE tenant = ?1 AND agent_id = ?2 AND event_type = ?3 AND attempted_at > ?4`,
    ).bind(tenant, agentId, DOORBELL_TEST_TYPE, since).first<{ n: number }>()
    if (Number(n?.n ?? 0) >= TEST_PING_LIMIT) {
      return { kind: 'stop', result: { outcome: 'rate_limited', reason: 'test_ping_rate_limited' } }
    }
  }

  const id = crypto.randomUUID()
  const inserted = await env.DB.prepare(
    `INSERT INTO agent_webhook_doorbell_receipts
       (id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at, attempt, error_class, signed_at)
     SELECT ?1, ?2, ?3, ?4, ?5, 'claimed', NULL, NULL, ?6, ?7, NULL, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_webhook_doorbell_receipts
         WHERE tenant = ?2 AND agent_id = ?3 AND event_type = ?4 AND ref_id = ?5
           AND (
             outcome IN ('posted', 'failed', 'dead_letter', 'skipped')
             OR attempt = ?7
           )
      )`,
  ).bind(id, tenant, agentId, eventType, ref, nowIso, attempt).run()
  if ((inserted.meta?.changes ?? 0) !== 1) {
    return { kind: 'stop', result: { outcome: 'skipped', reason: 'duplicate' } }
  }
  return { kind: 'go', id, attempt }
}

/**
 * One signed attempt. Returns normally for every recorded outcome. Throws only
 * when the receipt write or the retry enqueue fails, so the queue retries the job.
 */
export async function deliverSignedDoorbell(
  env: Env,
  payload: unknown,
  opts: { nowMs?: number; timeoutMs?: number } = {},
): Promise<SignedDeliveryResult> {
  if (!webhookDoorbellSignedEnabled(env) || !webhookDoorbellEnabled(env)) {
    return { outcome: 'skipped', reason: 'disabled' }
  }
  const job = parseJob(payload)
  if (!job) return { outcome: 'skipped', reason: 'bad_job' }
  const tenant = typeof env.TENANT_SLUG === 'string' && env.TENANT_SLUG.length > 0 ? env.TENANT_SLUG : null
  if (!tenant) return { outcome: 'skipped', reason: 'no_tenant' }
  const nowMs = opts.nowMs ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()

  const row = await loadDoorbell(env, tenant, job.agent_id)
  if (!row || row.delivery_version !== 'signed') return { outcome: 'skipped', reason: 'no_doorbell' }

  const facts = await loadFacts(env, tenant, row.agent_id, job)
  if (facts.kind === 'routine') return { outcome: 'skipped', reason: 'routine_fence' }
  if (facts.kind === 'refuse') {
    const claim = await beginAttempt(env, tenant, row.agent_id, facts.eventType, facts.ref, nowMs)
    if (claim.kind === 'stop') return claim.result
    await finishClaim(env, claim.id, 'failed', { errorClass: facts.reason })
    return { outcome: 'refused', reason: facts.reason }
  }

  const claim = await beginAttempt(env, tenant, row.agent_id, facts.eventType, facts.ref, nowMs)
  if (claim.kind === 'stop') return claim.result

  const url = validateHttpsWebhookUrl(row.webhook_url)
  const allow = url.ok ? validateCallbackUrl(url.url, env) : null
  if (!url.ok || !allow || !allow.ok) {
    const errorClass = !url.ok ? 'invalid_url' : allow && !allow.ok ? allow.reason : 'invalid_url'
    await finishClaim(env, claim.id, 'failed', { errorClass })
    return { outcome: 'failed', reason: errorClass }
  }

  const master = typeof env.CONNECTOR_MASTER_KEY === 'string' && env.CONNECTOR_MASTER_KEY.length > 0
    ? env.CONNECTOR_MASTER_KEY
    : null
  if (!master) {
    await finishClaim(env, claim.id, 'failed', { errorClass: 'secret_unavailable' })
    return { outcome: 'failed', reason: 'secret_unavailable' }
  }
  let secret: string
  try {
    // AAD is the agent id itself (not the legacy `doorbell:` prefix). Another agent's id does not decrypt.
    secret = await decryptConnectorSecret(master, row.agent_id, 'agent_doorbell_hmac', row.auth_ciphertext, row.agent_id)
  } catch {
    await finishClaim(env, claim.id, 'failed', { errorClass: 'decrypt_failed' })
    return { outcome: 'failed', reason: 'decrypt_failed' }
  }

  const nonce = crypto.randomUUID()
  const body = signedDoorbellBody(facts.fields, nonce)
  const webhookId = await webhookIdFor(row.agent_id, facts.eventType, facts.ref)
  const signed = await signDoorbellAttempt(secret, webhookId, body, nowMs)
  const out = await postSigned(allow.url, signed.headers, body, opts.timeoutMs ?? DOORBELL_TIMEOUT_MS)

  const httpStatus = out.kind === 'response' || out.kind === 'redirect' ? out.status : undefined
  const errorClass = out.kind === 'response' ? `http_${out.status}` : out.kind
  if (out.kind === 'response' && out.status >= 200 && out.status < 300) {
    await finishClaim(env, claim.id, 'posted', { httpStatus, signedAt: signed.signedAtIso })
    return { outcome: 'delivered', http_status: out.status }
  }

  const transient =
    out.kind === 'timeout'
    || out.kind === 'network_error'
    || out.kind === 'redirect'
    || (out.kind === 'response' && (out.status >= 500 || out.status === 408 || out.status === 429))
  if (!transient) {
    await finishClaim(env, claim.id, 'failed', { httpStatus, errorClass, signedAt: signed.signedAtIso })
    return { outcome: 'failed', http_status: httpStatus, reason: errorClass }
  }
  if (claim.attempt >= MAX_DELIVERY_ATTEMPTS) {
    await finishClaim(env, claim.id, 'dead_letter', { httpStatus, errorClass, signedAt: signed.signedAtIso })
    return { outcome: 'dead_letter', http_status: httpStatus, reason: errorClass }
  }
  await finishClaim(env, claim.id, 'retry', { httpStatus, errorClass, signedAt: signed.signedAtIso })
  const delaySeconds = backoffDelaySec(claim.attempt)
  // Resend the same hint. The next attempt re-derives the ref from D1 and counts receipts.
  const retryJob: DoorbellDeliveryJob = {
    wake_type: job.wake_type,
    agent_id: row.agent_id,
    ref_id: job.ref_id,
    ...(job.assignment ? { assignment: job.assignment } : {}),
    ...(job.correlation ? { correlation: job.correlation } : {}),
  }
  await env.BUS.send(
    {
      type: 'mcp.doorbell.delivery',
      tenant,
      agent_id: row.agent_id,
      payload: retryJob,
      ts: nowIso,
    },
    { delaySeconds },
  )
  return { outcome: 'retry', http_status: httpStatus, reason: errorClass }
}
