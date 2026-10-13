// mupot — per-agent Grok Bot webhook doorbell (outbound inbox wake).
//
// After a real agent_messages INSERT, if the recipient has a row here, the pot
// POSTs `{ type: "mupot.inbox.wake", agent_id, seq, message_id, kind }` to that
// https URL with `Authorization: Bearer <decrypted>`. The Bot peeks pot. This
// POST is a hint; the inbox row is the letter.
//
// A second wake, `mupot.task.assigned { agent_id, task_id }`, rings the same
// doorbell when a task is assigned to an agent that has one (mupot#1882).
//
// Storage: D1 mapping + CONNECTOR_MASTER_KEY (see migrations/0219 and
// docs/plugins/grokbot-webhook-spine.md). Ciphertext never logged or returned.
//
// HARDENING (flag WEBHOOK_DOORBELL, default OFF):
//   - https only, public host only (src/lib/ssrf.ts assertPublicHttpsUrl), port 443 only,
//     re-asserted at FIRE time as well as at set time.
//   - redirects are never followed (`redirect: 'manual'`; a 3xx counts as failed).
//   - short timeout; the POST runs inside ctx.waitUntil so it never blocks the response.
//   - one receipt row per attempt (status code only, never the URL query or the bearer).

import type { Env } from '../types'
import {
  decryptConnectorSecret,
  encryptConnectorSecret,
  secretLast4,
} from '../connectors/crypto'
import { assertPublicHttpsUrl } from '../lib/ssrf'

export const DOORBELL_TIMEOUT_MS = 3000
export const INBOX_WAKE_TYPE = 'mupot.inbox.wake'
export const TASK_ASSIGNED_TYPE = 'mupot.task.assigned'
export const DOORBELL_TEST_TYPE = 'mupot.doorbell.test'

/** Opt-in flag (`"1"` or `"true"`; unset = off). Off: no set, no POST, no DB read on the send path. */
export function webhookDoorbellEnabled(env: Env): boolean {
  const v = env.WEBHOOK_DOORBELL?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

/** AAD binds a ciphertext to its agent row so it cannot be swapped between agents. */
function doorbellAad(agentId: string): string {
  return `doorbell:${agentId}`
}

const MAX_WEBHOOK_URL_CHARS = 2048
const MAX_BEARER_CHARS = 2048

export type WebhookDoorbellWake =
  | { type: typeof INBOX_WAKE_TYPE; agent_id: string; seq: number; message_id: string; kind: string }
  | { type: typeof TASK_ASSIGNED_TYPE; agent_id: string; task_id: string }
  | { type: typeof DOORBELL_TEST_TYPE; agent_id: string }

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
  | { ok: false; error: 'webhook_doorbell_disabled' }

type DoorbellFireOpts = {
  fetch?: typeof fetch
  waitUntil?: (promise: Promise<unknown>) => void
}

type ReceiptStatus = 'posted' | 'failed' | 'skipped'

async function recordReceipt(
  env: Env,
  tenant: string,
  wake: WebhookDoorbellWake,
  status: ReceiptStatus,
  detail: { http_status?: number; reason?: string },
): Promise<void> {
  // Safe fields only. Never webhook_url, never Authorization, never the bearer.
  const ref = wake.type === INBOX_WAKE_TYPE ? wake.message_id : wake.type === TASK_ASSIGNED_TYPE ? wake.task_id : 'test'
  const line = {
    event_type: wake.type,
    agent_id: wake.agent_id,
    ref_id: ref,
    ...(detail.http_status !== undefined ? { http_status: detail.http_status } : {}),
    ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
  }
  if (status === 'posted') console.info('[webhook-doorbell] wake posted', line)
  else console.warn(`[webhook-doorbell] wake ${status}`, line)
  try {
    await env.DB.prepare(
      `INSERT INTO agent_webhook_doorbell_receipts
         (id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      crypto.randomUUID(), tenant, wake.agent_id, wake.type, ref, status,
      detail.http_status ?? null, detail.reason ?? null, new Date().toISOString(),
    ).run()
  } catch {
    // A receipt failure must never surface to the send / task path.
  }
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
    // https + PUBLIC host (loopback / RFC1918 / link-local / metadata / ULA / NAT64 refused).
    parsed = assertPublicHttpsUrl(trimmed)
  } catch (err) {
    const code = err instanceof Error ? err.message : ''
    if (code === 'url_private_host') return { ok: false, detail: 'webhook_url must be a public host' }
    if (code === 'url_not_https') return { ok: false, detail: 'webhook_url must be https' }
    return { ok: false, detail: 'webhook_url must be a valid https URL' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, detail: 'webhook_url must not embed credentials' }
  }
  if (!parsed.hostname) return { ok: false, detail: 'webhook_url must be a valid https URL' }
  if (parsed.port !== '' && parsed.port !== '443') return { ok: false, detail: 'webhook_url must use port 443' }
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
  if (!webhookDoorbellEnabled(env)) return { ok: false, error: 'webhook_doorbell_disabled' }
  const tenant = requireTenant(env)
  if (!tenant) return { ok: false, error: 'no_tenant' }
  const master = requireMasterKey(env)
  if (!master) return { ok: false, error: 'doorbell_crypto_unavailable' }

  const url = validateHttpsWebhookUrl(input.webhookUrl)
  if (!url.ok) return { ok: false, error: 'invalid_webhook_url', detail: url.detail }

  const bearer = input.bearer.trim()
  if (!bearer) return { ok: false, error: 'invalid_bearer', detail: 'bearer required' }
  if (bearer.length > MAX_BEARER_CHARS) return { ok: false, error: 'invalid_bearer', detail: 'bearer too long' }

  const ciphertext = await encryptConnectorSecret(master, input.agentId, 'agent_doorbell', bearer, doorbellAad(input.agentId))
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

export type DoorbellDelivery = {
  /** `no_doorbell` / `disabled`: nothing was attempted (no receipt). Otherwise the attempt's receipt outcome. */
  outcome: ReceiptStatus | 'no_doorbell' | 'disabled'
  http_status?: number
  reason?: string
}

/** One delivery attempt: guard, decrypt, POST (no redirects, short timeout), one receipt row. Never throws. */
async function deliverDoorbell(
  env: Env,
  wake: WebhookDoorbellWake,
  opts: DoorbellFireOpts,
): Promise<DoorbellDelivery> {
  if (!webhookDoorbellEnabled(env)) return { outcome: 'disabled' }
  const tenant = requireTenant(env)
  if (!tenant) return { outcome: 'no_doorbell' }

  const row = await env.DB.prepare(
    `SELECT webhook_url, auth_ciphertext
       FROM agent_webhook_doorbells
      WHERE tenant = ?1 AND agent_id = ?2`,
  ).bind(tenant, wake.agent_id).first<{ webhook_url: string; auth_ciphertext: string }>()
  if (!row) return { outcome: 'no_doorbell' }

  // Re-assert the guard at fire time: a row written before a rule tightened must not be trusted.
  const url = validateHttpsWebhookUrl(row.webhook_url)
  if (!url.ok) {
    await recordReceipt(env, tenant, wake, 'skipped', { reason: 'invalid_url' })
    return { outcome: 'skipped', reason: 'invalid_url' }
  }

  const master = requireMasterKey(env)
  if (!master) {
    await recordReceipt(env, tenant, wake, 'skipped', { reason: 'crypto_unavailable' })
    return { outcome: 'skipped', reason: 'crypto_unavailable' }
  }

  let bearer: string
  try {
    bearer = await decryptConnectorSecret(
      master, wake.agent_id, 'agent_doorbell', row.auth_ciphertext, doorbellAad(wake.agent_id),
    )
  } catch {
    await recordReceipt(env, tenant, wake, 'skipped', { reason: 'decrypt_failed' })
    return { outcome: 'skipped', reason: 'decrypt_failed' }
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
      body: JSON.stringify(wake),
      signal: ac.signal,
      // Never follow a redirect: a 3xx would carry the bearer to a host nobody vetted.
      redirect: 'manual',
    })
    const outcome: ReceiptStatus = res.ok ? 'posted' : 'failed'
    await recordReceipt(env, tenant, wake, outcome, { http_status: res.status })
    return { outcome, http_status: res.status }
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'fetch_error'
    await recordReceipt(env, tenant, wake, 'failed', { reason })
    return { outcome: 'failed', reason }
  } finally {
    clearTimeout(timer)
  }
}

export async function fireWebhookDoorbell(
  env: Env,
  wake: WebhookDoorbellWake,
  opts: DoorbellFireOpts = {},
): Promise<void> {
  await deliverDoorbell(env, wake, opts)
}

/** Human "Send test ping": same guarded path and receipt as a real wake, but awaited so the caller sees the status. */
export async function sendDoorbellTestPing(
  env: Env,
  agentId: string,
  opts: DoorbellFireOpts = {},
): Promise<DoorbellDelivery> {
  return deliverDoorbell(env, { type: DOORBELL_TEST_TYPE, agent_id: agentId }, opts)
}

/** Fail-open schedule. Must never throw to the send / task path. Off-flag: returns before any D1 read. */
export function scheduleWebhookDoorbell(
  env: Env,
  wake: WebhookDoorbellWake,
  opts: DoorbellFireOpts = {},
): void {
  try {
    if (!webhookDoorbellEnabled(env)) return
    // No master key → cannot decrypt; skip the D1 lookup entirely.
    if (typeof env.CONNECTOR_MASTER_KEY !== 'string' || env.CONNECTOR_MASTER_KEY.length === 0) {
      return
    }
    const run = fireWebhookDoorbell(env, wake, opts).catch(() => {
      // already fail-open; nothing safe to add here
    })
    if (opts.waitUntil) opts.waitUntil(run)
  } catch {
    // never throws to the caller
  }
}

/** Task assigned to an agent: ring its doorbell (mupot#1882). Same fail-open, flag-gated path as the inbox wake. */
export function scheduleTaskAssignedDoorbell(
  env: Env,
  agentId: string | null | undefined,
  taskId: string,
  opts: DoorbellFireOpts = {},
): void {
  if (!agentId) return
  scheduleWebhookDoorbell(env, { type: TASK_ASSIGNED_TYPE, agent_id: agentId, task_id: taskId }, opts)
}

/** ctx.waitUntil from a Hono context; `c.executionCtx` throws outside a Worker request (tests), so guard it. */
export function waitUntilFromContext(
  c: { readonly executionCtx: { waitUntil(p: Promise<unknown>): void } },
): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx
    return ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined
  } catch {
    return undefined
  }
}
