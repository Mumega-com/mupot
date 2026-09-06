// mupot — per-agent Grok Bot webhook doorbell (outbound inbox wake).
//
// After a real agent_messages INSERT, if the recipient has a row here, the pot
// POSTs `{ type: "mupot.inbox.wake", agent_id, seq, message_id, kind }` to that
// https URL with `Authorization: Bearer <decrypted>`. The Bot peeks pot. This
// POST is a hint; the inbox row is the letter.
//
// Storage: D1 mapping + CONNECTOR_MASTER_KEY (see migrations/0147 and
// docs/plugins/grokbot-webhook-spine.md). Ciphertext never logged or returned.

import type { Env } from '../types'
import {
  decryptDomainSecret,
  encryptDomainSecret,
  secretLast4,
} from '../connectors/crypto'

export const DOORBELL_HKDF_INFO = 'mupot_doorbell_v1'
export const DOORBELL_TIMEOUT_MS = 3000
export const INBOX_WAKE_TYPE = 'mupot.inbox.wake'

const MAX_WEBHOOK_URL_CHARS = 2048
const MAX_BEARER_CHARS = 2048

export type WebhookDoorbellWake = {
  agent_id: string
  seq: number
  message_id: string
  kind: string
}

export type PublicWebhookDoorbell = {
  configured: true
  agent_id: string
  webhook_url: string
  auth_last4: string
  updated_at: string
}

export type DoorbellSetFailure =
  | { ok: false; error: 'doorbell_crypto_unavailable' }
  | { ok: false; error: 'invalid_webhook_url'; detail: string }
  | { ok: false; error: 'invalid_bearer'; detail: string }
  | { ok: false; error: 'no_tenant' }

type DoorbellFireOpts = {
  fetch?: typeof fetch
  waitUntil?: (promise: Promise<unknown>) => void
}

type ReceiptStatus = 'posted' | 'failed' | 'skipped'

function logReceipt(
  status: ReceiptStatus,
  fields: {
    agent_id: string
    message_id: string
    seq: number
    http_status?: number
    reason?: string
  },
): void {
  // Safe fields only. Never webhook_url, never Authorization, never bearer.
  const line = {
    agent_id: fields.agent_id,
    message_id: fields.message_id,
    seq: fields.seq,
    ...(fields.http_status !== undefined ? { http_status: fields.http_status } : {}),
    ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
  }
  if (status === 'posted') {
    console.info('[webhook-doorbell] wake posted', line)
    return
  }
  console.warn(`[webhook-doorbell] wake ${status}`, line)
}

export function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return '[redacted-url]'
  }
}

export function validateHttpsWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; detail: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, detail: 'webhook_url required' }
  if (trimmed.length > MAX_WEBHOOK_URL_CHARS) return { ok: false, detail: 'webhook_url too long' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, detail: 'webhook_url must be a valid https URL' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, detail: 'webhook_url must be https' }
  if (parsed.username || parsed.password) {
    return { ok: false, detail: 'webhook_url must not embed credentials' }
  }
  if (!parsed.hostname) return { ok: false, detail: 'webhook_url must be a valid https URL' }
  return { ok: true, url: parsed.toString() }
}

function requireTenant(env: Env): string | null {
  return typeof env.TENANT_SLUG === 'string' && env.TENANT_SLUG.length > 0 ? env.TENANT_SLUG : null
}

function requireMasterKey(env: Env): string | null {
  return typeof env.CONNECTOR_MASTER_KEY === 'string' && env.CONNECTOR_MASTER_KEY.length > 0
    ? env.CONNECTOR_MASTER_KEY
    : null
}

export async function setAgentWebhookDoorbell(
  env: Env,
  input: {
    agentId: string
    webhookUrl: string
    bearer: string
    createdByMemberId: string
    now?: string
  },
): Promise<{ ok: true; doorbell: PublicWebhookDoorbell } | DoorbellSetFailure> {
  const tenant = requireTenant(env)
  if (!tenant) return { ok: false, error: 'no_tenant' }
  const master = requireMasterKey(env)
  if (!master) return { ok: false, error: 'doorbell_crypto_unavailable' }

  const url = validateHttpsWebhookUrl(input.webhookUrl)
  if (!url.ok) return { ok: false, error: 'invalid_webhook_url', detail: url.detail }

  const bearer = input.bearer.trim()
  if (!bearer) return { ok: false, error: 'invalid_bearer', detail: 'bearer required' }
  if (bearer.length > MAX_BEARER_CHARS) return { ok: false, error: 'invalid_bearer', detail: 'bearer too long' }

  const ciphertext = await encryptDomainSecret(master, input.agentId, DOORBELL_HKDF_INFO, bearer)
  const last4 = secretLast4(bearer)
  const updatedAt = input.now ?? new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO agent_webhook_doorbells (
        tenant, agent_id, webhook_url, auth_ciphertext, auth_last4, created_by_member_id, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(tenant, agent_id) DO UPDATE SET
        webhook_url = excluded.webhook_url,
        auth_ciphertext = excluded.auth_ciphertext,
        auth_last4 = excluded.auth_last4,
        created_by_member_id = excluded.created_by_member_id,
        updated_at = excluded.updated_at`,
  ).bind(tenant, input.agentId, url.url, ciphertext, last4, input.createdByMemberId, updatedAt).run()

  return {
    ok: true,
    doorbell: {
      configured: true,
      agent_id: input.agentId,
      webhook_url: redactWebhookUrl(url.url),
      auth_last4: last4,
      updated_at: updatedAt,
    },
  }
}

export async function getAgentWebhookDoorbell(
  env: Env,
  agentId: string,
): Promise<PublicWebhookDoorbell | null> {
  const tenant = requireTenant(env)
  if (!tenant) return null
  const row = await env.DB.prepare(
    `SELECT agent_id, webhook_url, auth_last4, updated_at
       FROM agent_webhook_doorbells
      WHERE tenant = ?1 AND agent_id = ?2`,
  ).bind(tenant, agentId).first<{
    agent_id: string
    webhook_url: string
    auth_last4: string
    updated_at: string
  }>()
  if (!row) return null
  return {
    configured: true,
    agent_id: row.agent_id,
    webhook_url: redactWebhookUrl(row.webhook_url),
    auth_last4: row.auth_last4,
    updated_at: row.updated_at,
  }
}

export async function clearAgentWebhookDoorbell(env: Env, agentId: string): Promise<boolean> {
  const tenant = requireTenant(env)
  if (!tenant) return false
  const result = await env.DB.prepare(
    `DELETE FROM agent_webhook_doorbells WHERE tenant = ?1 AND agent_id = ?2`,
  ).bind(tenant, agentId).run()
  return (result.meta?.changes ?? 0) > 0
}

export async function fireWebhookDoorbell(
  env: Env,
  wake: WebhookDoorbellWake,
  opts: DoorbellFireOpts = {},
): Promise<void> {
  const tenant = requireTenant(env)
  if (!tenant) return

  const row = await env.DB.prepare(
    `SELECT webhook_url, auth_ciphertext
       FROM agent_webhook_doorbells
      WHERE tenant = ?1 AND agent_id = ?2`,
  ).bind(tenant, wake.agent_id).first<{ webhook_url: string; auth_ciphertext: string }>()
  if (!row) return

  const url = validateHttpsWebhookUrl(row.webhook_url)
  if (!url.ok) {
    logReceipt('skipped', { ...wake, reason: 'invalid_url' })
    return
  }

  const master = requireMasterKey(env)
  if (!master) {
    logReceipt('skipped', { ...wake, reason: 'crypto_unavailable' })
    return
  }

  let bearer: string
  try {
    bearer = await decryptDomainSecret(master, wake.agent_id, DOORBELL_HKDF_INFO, row.auth_ciphertext)
  } catch {
    logReceipt('skipped', { ...wake, reason: 'decrypt_failed' })
    return
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), DOORBELL_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: INBOX_WAKE_TYPE,
        agent_id: wake.agent_id,
        seq: wake.seq,
        message_id: wake.message_id,
        kind: wake.kind,
      }),
      signal: ac.signal,
    })
    logReceipt(res.ok ? 'posted' : 'failed', { ...wake, http_status: res.status })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    logReceipt('failed', { ...wake, reason: aborted ? 'timeout' : 'fetch_error' })
  } finally {
    clearTimeout(timer)
  }
}

/** Fail-open schedule. Must never throw to the send path. */
export function scheduleWebhookDoorbell(
  env: Env,
  wake: WebhookDoorbellWake,
  opts: DoorbellFireOpts = {},
): void {
  try {
    const run = fireWebhookDoorbell(env, wake, opts).catch(() => {
      logReceipt('failed', { ...wake, reason: 'unhandled' })
    })
    if (opts.waitUntil) opts.waitUntil(run)
  } catch {
    logReceipt('failed', { ...wake, reason: 'schedule_error' })
  }
}
