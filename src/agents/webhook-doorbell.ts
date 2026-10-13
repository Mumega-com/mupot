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

/** Doorbell correlation shared by a dispatch's task.assigned ring and the inbox.wake of its bridge letter. */
export function dispatchDoorbellCorrelation(receiptId: string): string {
  return `dispatch:${receiptId}`
}

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
/** A shorter key is refused: last4 of a short key would reveal most of it. */
export const MIN_BEARER_CHARS = 16
/**
 * Burst cap, not coalescing (gate r2 on #1890): every DISTINCT event rings, so a follow-up message or a task
 * assigned right after a message wake is never stranded. Only (a) the same event ref inside the window and
 * (b) more than WAKE_BURST_LIMIT attempts per agent inside the window are skipped ('coalesced'); the routine's
 * own poll is the backstop for (b).
 */
export const COALESCE_WINDOW_MS = 60_000
export const WAKE_BURST_LIMIT = 6
/** Test pings per agent per window. */
export const TEST_PING_LIMIT = 5
export const TEST_PING_WINDOW_MS = 10 * 60_000
/** Receipts older than this are pruned inline when the same agent next rings. */
export const RECEIPT_RETENTION_MS = 14 * 24 * 60 * 60_000
/** When no waitUntil is available the caller awaits the delivery, bounded (the POST itself aborts at DOORBELL_TIMEOUT_MS). */
const AWAIT_CEILING_MS = DOORBELL_TIMEOUT_MS + 1000

export type WebhookDoorbellWake =
  | { type: typeof INBOX_WAKE_TYPE; agent_id: string; seq: number; message_id: string; kind: string }
  | { type: typeof TASK_ASSIGNED_TYPE; agent_id: string; task_id: string; assignment?: string }
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

/** ctx.waitUntil, threaded to any send that may ring a doorbell so the POST outlives the response instead of being awaited. */
export type DoorbellWaitUntil = (promise: Promise<unknown>) => void

type DoorbellFireOpts = {
  fetch?: typeof fetch
  waitUntil?: (promise: Promise<unknown>) => void
  /**
   * Shared correlation of two wakes that announce the SAME event (task_dispatch's task.assigned and the inbox.wake
   * for its bridge letter share `dispatch:<receiptId>`). It replaces the receipt ref, so whichever rings second
   * is coalesced with the first instead of ringing the Bot twice.
   */
  correlation?: string
  /**
   * Recipients known (from ONE resolveDoorbellRecipients query for a fan-out) to have a doorbell. When present, an
   * agent outside the set returns before any D1 statement: no existence check, no claim.
   */
  recipients?: ReadonlySet<string>
}

/** The receipt / dedupe ref of a wake: the shared correlation, else the event's own id (task wakes add their assignment occurrence). */
function wakeRef(wake: WebhookDoorbellWake, correlation?: string): string {
  if (correlation) return correlation
  if (wake.type === INBOX_WAKE_TYPE) return wake.message_id
  if (wake.type === TASK_ASSIGNED_TYPE) return wake.assignment ? `${wake.task_id}#${wake.assignment}` : wake.task_id
  return 'test'
}

type ReceiptStatus = 'posted' | 'failed' | 'skipped'
type DoorbellKind = 'wake' | 'test'

async function recordReceipt(
  env: Env,
  tenant: string,
  wake: WebhookDoorbellWake,
  status: ReceiptStatus,
  detail: { http_status?: number; reason?: string },
  ref: string,
): Promise<void> {
  // Safe fields only. Never webhook_url, never Authorization, never the bearer.
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
  if (bearer.length < MIN_BEARER_CHARS) return { ok: false, error: 'invalid_bearer', detail: `bearer must be at least ${MIN_BEARER_CHARS} characters` }
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
  // One batch: the mapping and the agent's receipts go together (a cleared doorbell leaves no receipt trail
  // behind; the receipts carry the ref ids of its wakes and have no reader once the doorbell is gone).
  const [result] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM agent_webhook_doorbells WHERE tenant = ?1 AND agent_id = ?2`).bind(tenant, agentId),
    env.DB.prepare(`DELETE FROM agent_webhook_doorbell_receipts WHERE tenant = ?1 AND agent_id = ?2`).bind(tenant, agentId),
  ])
  return (result?.meta?.changes ?? 0) > 0
}

/** Every doorbell of this tenant in ONE query (the dashboard list), keyed by agent id. Never returns a secret. */
export async function listAgentWebhookDoorbells(env: Env): Promise<Map<string, PublicWebhookDoorbell>> {
  const out = new Map<string, PublicWebhookDoorbell>()
  const tenant = requireTenant(env)
  if (!tenant) return out
  const res = await env.DB.prepare(
    `SELECT agent_id, webhook_url, auth_last4, updated_at FROM agent_webhook_doorbells WHERE tenant = ?1`,
  ).bind(tenant).all<{ agent_id: string; webhook_url: string; auth_last4: string; updated_at: string }>()
  for (const row of res.results ?? []) {
    out.set(row.agent_id, {
      configured: true,
      agent_id: row.agent_id,
      webhook_url: redactWebhookUrl(row.webhook_url),
      auth_last4: row.auth_last4,
      updated_at: row.updated_at,
    })
  }
  return out
}

/** D1 caps bound parameters per statement; each id is bound twice (as id and as slug). */
const RECIPIENT_CHUNK = 40

/**
 * Which of these recipients (agents.id or fleet slug, exactly as a send would address them) have a doorbell?
 * ONE IN-list query per chunk of 40, so a fan-out (broadcast) pays one statement instead of one per recipient.
 * Flag off or no master key -> empty set with ZERO statements. An over-inclusive answer (a slug that names two
 * agents) is harmless: the delivery path re-resolves canonically before it POSTs.
 */
export async function resolveDoorbellRecipients(env: Env, toAgents: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>()
  if (!webhookDoorbellEnabled(env) || toAgents.length === 0) return found
  if (typeof env.CONNECTOR_MASTER_KEY !== 'string' || env.CONNECTOR_MASTER_KEY.length === 0) return found
  const tenant = requireTenant(env)
  if (!tenant) return found
  const unique = [...new Set(toAgents)]
  try {
    for (let i = 0; i < unique.length; i += RECIPIENT_CHUNK) {
      const chunk = unique.slice(i, i + RECIPIENT_CHUNK)
      const marks = chunk.map((_, n) => `?${n + 2}`).join(', ')
      const res = await env.DB.prepare(
        `SELECT d.agent_id AS agent_id, a.slug AS slug
           FROM agent_webhook_doorbells d
           JOIN agents a ON a.id = d.agent_id
          WHERE d.tenant = ?1 AND (d.agent_id IN (${marks}) OR a.slug IN (${marks}))`,
      ).bind(tenant, ...chunk).all<{ agent_id: string; slug: string }>()
      const hits = new Set<string>()
      for (const row of res.results ?? []) { hits.add(row.agent_id); hits.add(row.slug) }
      for (const id of chunk) if (hits.has(id)) found.add(id)
    }
  } catch {
    // Fail open for the CALLER's send, but never lose wakes: on a lookup error treat every recipient as a candidate.
    for (const id of unique) found.add(id)
  }
  return found
}

export type DoorbellDelivery = {
  /** `no_doorbell` / `disabled` / `rate_limited`: nothing was attempted. Otherwise the attempt's receipt outcome. */
  outcome: ReceiptStatus | 'no_doorbell' | 'disabled' | 'rate_limited'
  http_status?: number
  reason?: string
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

async function pruneReceipts(env: Env, tenant: string, agentId: string): Promise<void> {
  try {
    await env.DB.prepare(
      'DELETE FROM agent_webhook_doorbell_receipts WHERE tenant = ?1 AND agent_id = ?2 AND attempted_at < ?3',
    ).bind(tenant, agentId, isoAgo(RECEIPT_RETENTION_MS)).run()
  } catch {
    // retention is best-effort
  }
}

/** One delivery attempt: resolve, guard, coalesce, decrypt, POST (no redirects, short timeout), receipt. Never throws. */
async function deliverDoorbell(
  env: Env,
  wake: WebhookDoorbellWake,
  opts: DoorbellFireOpts,
  kind: DoorbellKind = 'wake',
): Promise<DoorbellDelivery> {
  if (!webhookDoorbellEnabled(env)) return { outcome: 'disabled' }
  const tenant = requireTenant(env)
  if (!tenant) return { outcome: 'no_doorbell' }

  // The agent may arrive as agents.id OR as its fleet-row slug (the dispatch bridge delivers to the fleet row's
  // agent_id). Resolve to ONE canonical agents.id FIRST: an exact id always wins, and a slug is used only when no
  // agent has that id and the slug names exactly one agent. Only then look the doorbell up by exact id, so an
  // agent whose slug is shaped like another agent's id can never receive that agent's wakes (gate r2 on #1890).
  // ONE statement (the existence check for the whole send path): resolve to the canonical id, then join the row.
  const row = await env.DB.prepare(
    `SELECT d.agent_id AS agent_id, d.webhook_url AS webhook_url, d.auth_ciphertext AS auth_ciphertext
       FROM agent_webhook_doorbells d
      WHERE d.tenant = ?1
        AND d.agent_id = COALESCE(
          (SELECT a.id FROM agents a WHERE a.id = ?2),
          (SELECT a.id FROM agents a WHERE a.slug = ?2
            AND (SELECT count(*) FROM agents b WHERE b.slug = ?2) = 1))`,
  ).bind(tenant, wake.agent_id).first<{ agent_id: string; webhook_url: string; auth_ciphertext: string }>()
  if (!row) return { outcome: 'no_doorbell' }
  // From here on the canonical id is the identity: receipts, AAD/salt and the payload all use it.
  const canonical: WebhookDoorbellWake = { ...wake, agent_id: row.agent_id }
  const ref = wakeRef(canonical, opts.correlation)

  // Re-assert the guard at fire time: a row written before a rule tightened must not be trusted.
  const url = validateHttpsWebhookUrl(row.webhook_url)
  if (!url.ok) {
    await recordReceipt(env, tenant, canonical, 'skipped', { reason: 'invalid_url' }, ref)
    return { outcome: 'skipped', reason: 'invalid_url' }
  }

  const master = requireMasterKey(env)
  if (!master) {
    await recordReceipt(env, tenant, canonical, 'skipped', { reason: 'crypto_unavailable' }, ref)
    return { outcome: 'skipped', reason: 'crypto_unavailable' }
  }

  let claimId: string | null = null
  if (kind === 'test') {
    // Test pings are rate limited per agent with ONE atomic conditional INSERT of a 'claimed' row, so parallel
    // pings cannot all pass a read-then-post count (gate r2 on #1890). The claimed row is later updated in place
    // to its final outcome, so every test row in the window counts.
    // They neither open nor are blocked by the wake coalescing window.
    claimId = crypto.randomUUID()
    let claimedTest = false
    try {
      const res = await env.DB.prepare(
        `INSERT INTO agent_webhook_doorbell_receipts
           (id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at)
         SELECT ?1, ?2, ?3, ?4, 'test', 'claimed', NULL, NULL, ?5
          WHERE (SELECT count(*) FROM agent_webhook_doorbell_receipts
                  WHERE tenant = ?2 AND agent_id = ?3 AND event_type = ?4
                    AND attempted_at > ?6) < ?7`,
      ).bind(
        claimId, tenant, canonical.agent_id, DOORBELL_TEST_TYPE, new Date().toISOString(),
        isoAgo(TEST_PING_WINDOW_MS), TEST_PING_LIMIT,
      ).run()
      claimedTest = (res.meta?.changes ?? 0) === 1
    } catch {
      return { outcome: 'skipped', reason: 'receipt_unavailable' }
    }
    if (!claimedTest) return { outcome: 'rate_limited', reason: 'test_ping_rate_limited' }
  } else {
    // Claim with ONE atomic conditional INSERT: skip only a repeat of the same event ref, or a burst above the cap.
    // Not claiming at all (DB error) also skips: a doorbell that cannot count must not flood.
    claimId = crypto.randomUUID()
    let claimed = false
    try {
      const res = await env.DB.prepare(
        `INSERT INTO agent_webhook_doorbell_receipts
           (id, tenant, agent_id, event_type, ref_id, outcome, http_status, reason, attempted_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'claimed', NULL, NULL, ?6
          WHERE NOT EXISTS (
                  SELECT 1 FROM agent_webhook_doorbell_receipts
                   WHERE tenant = ?2 AND agent_id = ?3 AND ref_id = ?5
                     AND outcome IN ('claimed', 'posted') AND attempted_at > ?8)
            AND (SELECT count(*) FROM agent_webhook_doorbell_receipts
                  WHERE tenant = ?2 AND agent_id = ?3 AND event_type <> ?7
                    AND outcome IN ('claimed', 'posted', 'failed') AND attempted_at > ?8) < ?9`,
      ).bind(
        claimId, tenant, canonical.agent_id, canonical.type, ref, new Date().toISOString(),
        DOORBELL_TEST_TYPE, isoAgo(COALESCE_WINDOW_MS), WAKE_BURST_LIMIT,
      ).run()
      claimed = (res.meta?.changes ?? 0) === 1
    } catch {
      await recordReceipt(env, tenant, canonical, 'skipped', { reason: 'receipt_unavailable' }, ref)
      return { outcome: 'skipped', reason: 'receipt_unavailable' }
    }
    if (!claimed) {
      await recordReceipt(env, tenant, canonical, 'skipped', { reason: 'coalesced' }, ref)
      return { outcome: 'skipped', reason: 'coalesced' }
    }
  }
  // Retention: prune this agent's old receipts when it rings (wake OR test ping; no cron slot needed; bounded by
  // the agent index). Test pings are in the retention too: a ping-only agent used to grow without bound.
  await pruneReceipts(env, tenant, canonical.agent_id)

  const finish = async (
    status: ReceiptStatus,
    detail: { http_status?: number; reason?: string },
  ): Promise<void> => {
    if (claimId === null) {
      await recordReceipt(env, tenant, canonical, status, detail, ref)
      return
    }
    // Finalize the claimed row in place (same id), so the window row IS the attempt's receipt.
    console[status === 'posted' ? 'info' : 'warn'](`[webhook-doorbell] wake ${status}`, {
      event_type: canonical.type, agent_id: canonical.agent_id, ...detail,
    })
    try {
      await env.DB.prepare(
        'UPDATE agent_webhook_doorbell_receipts SET outcome = ?1, http_status = ?2, reason = ?3 WHERE id = ?4',
      ).bind(status, detail.http_status ?? null, detail.reason ?? null, claimId).run()
    } catch {
      // the claimed row still counts toward the window
    }
  }

  let bearer: string
  try {
    bearer = await decryptConnectorSecret(
      master, canonical.agent_id, 'agent_doorbell', row.auth_ciphertext, doorbellAad(canonical.agent_id),
    )
  } catch {
    await finish('skipped', { reason: 'decrypt_failed' })
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
      body: JSON.stringify(canonical),
      signal: ac.signal,
      // Never follow a redirect: a 3xx would carry the bearer to a host nobody vetted.
      redirect: 'manual',
    })
    // Release the connection; the body is never read.
    try { await res.body?.cancel() } catch { /* nothing to release */ }
    const outcome: ReceiptStatus = res.ok ? 'posted' : 'failed'
    await finish(outcome, { http_status: res.status })
    return { outcome, http_status: res.status }
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'fetch_error'
    await finish('failed', { reason })
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
  return deliverDoorbell(env, { type: DOORBELL_TEST_TYPE, agent_id: agentId }, opts, 'test')
}

/**
 * Fail-open ring. Never throws to the send / task path. Off-flag: returns before any D1 read.
 * With a `waitUntil` the POST outlives the response. WITHOUT one (cron, queue consumer, routine actions...) the
 * returned promise AWAITS the delivery, bounded, so a wake can never be dropped by the runtime tearing the
 * invocation down: callers must `await` this.
 */
export async function scheduleWebhookDoorbell(
  env: Env,
  wake: WebhookDoorbellWake,
  opts: DoorbellFireOpts = {},
): Promise<void> {
  try {
    if (!webhookDoorbellEnabled(env)) return
    // No master key -> cannot decrypt; skip the D1 lookup entirely.
    if (typeof env.CONNECTOR_MASTER_KEY !== 'string' || env.CONNECTOR_MASTER_KEY.length === 0) return
    // A fan-out pre-resolved who has a doorbell (one IN-list query): everyone else costs zero statements here.
    if (opts.recipients && !opts.recipients.has(wake.agent_id)) return
    const run = deliverDoorbell(env, wake, opts).then(() => undefined, () => undefined)
    if (opts.waitUntil) {
      opts.waitUntil(run)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const ceiling = new Promise<void>((resolve) => { timer = setTimeout(resolve, AWAIT_CEILING_MS) })
    try {
      await Promise.race([run, ceiling])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  } catch {
    // never throws to the caller
  }
}

/**
 * Task assigned to an agent: ring its doorbell (mupot#1882). Same fail-open, flag-gated path as the inbox wake.
 * `assignment` names THIS assignment occurrence (the task's updated_at stamp, a dispatch receipt id, ...): the
 * dedupe ref is task_id + assignment, so an A->B->A reassignment or an explicit redispatch inside the window is
 * a new event and rings, while the same occurrence reported by two doors still coalesces.
 */
export async function scheduleTaskAssignedDoorbell(
  env: Env,
  agentId: string | null | undefined,
  taskId: string,
  opts: DoorbellFireOpts & { assignment?: string } = {},
): Promise<void> {
  if (!agentId) return
  const { assignment, ...fire } = opts
  await scheduleWebhookDoorbell(
    env,
    { type: TASK_ASSIGNED_TYPE, agent_id: agentId, task_id: taskId, ...(assignment ? { assignment } : {}) },
    fire,
  )
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
