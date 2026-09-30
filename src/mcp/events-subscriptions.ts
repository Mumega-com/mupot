// src/mcp/events-subscriptions.ts — MCP Events (mupot#1618, PR 2): events/subscribe and
// events/unsubscribe. Flag gating (EVENTS_ENABLED) happens in the caller (handleJsonRpc) BEFORE
// any function here runs; nothing here re-reads the flag.
//
// Only `message.created` (the bound agent's OWN inbox) is subscribable in this PR.

import type { AuthContext, Env } from '../types'
import { decryptConnectorSecret, encryptConnectorSecret } from '../connectors/crypto'
import { capabilityRank, holdsCapabilityFloor, resolveCapabilities } from '../auth/capability'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { resolveConsentedAgentCapabilities } from './oauth-authorize'
import {
  parseWebhookSecret,
  secretFingerprint,
  validateCallbackUrl,
  verifyCallback,
} from './events-webhook'

export const SUBSCRIBABLE_EVENTS: ReadonlySet<string> = new Set(['message.created'])
/** In the catalogue but not subscribable yet. */
export const CATALOGUE_ONLY_EVENTS: ReadonlySet<string> = new Set(['needs_you.created'])

export const TTL_MIN_MS = 5 * 60_000
export const TTL_DEFAULT_MS = 60 * 60_000
export const TTL_MAX_MS = 24 * 60 * 60_000
export const VERIFICATION_CACHE_MS = 10 * 60_000
export const SECRET_ROTATION_WINDOW_MS = 24 * 60 * 60_000
export const MAX_ACTIVE_SUBSCRIPTIONS_PER_AGENT = 10

export interface SubscriptionRow {
  id: string
  tenant: string
  agent_id: string
  member_id: string
  token_id: string
  consented_by_member_id: string | null
  event_name: string
  arguments_json: string
  callback_url: string
  secret_ciphertext: string
  secret_fingerprint: string
  prev_secret_ciphertext: string | null
  prev_secret_expires_at: string | null
  status: 'active' | 'revoked' | 'expired'
  refresh_before: string
  verified_at: string | null
}

export type EventsFailure = {
  ok: false
  code: number
  message: string
  data?: unknown
  status?: number
}
export type EventsSuccess = { ok: true; result: Record<string, unknown> }

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`
}

/** Deterministic subscription id from (principal agent, callback URL, event name, arguments). */
export async function subscriptionId(
  agentId: string,
  callbackUrl: string,
  eventName: string,
  args: unknown,
): Promise<string> {
  const material = ['mcp-events-sub:v1', agentId, callbackUrl, eventName, canonicalJson(args)].join('\n')
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  const hex = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
  return `sub_${hex.slice(0, 32)}`
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function fail(code: number, message: string, data?: unknown, status?: number): EventsFailure {
  return { ok: false, code, message, ...(data !== undefined ? { data } : {}), ...(status !== undefined ? { status } : {}) }
}

/** The principal every events/* write needs: a bound agent that still holds a capability floor.
 *  An unbound or zero-capability session is refused (same floor the catalogue applies). */
export function eventsPrincipal(
  auth: AuthContext,
  floorOk: boolean,
): { ok: true; agentId: string; memberId: string; tokenId: string } | EventsFailure {
  const agentId = auth.boundAgentId
  if (!agentId || !auth.memberId || !auth.tokenId || !floorOk) {
    return fail(-32003, 'forbidden', { reason: 'events_require_bound_agent_with_capability' }, 403)
  }
  return { ok: true, agentId, memberId: auth.memberId, tokenId: auth.tokenId }
}

export function callerFloorOk(auth: AuthContext, hasWorkspaceAdmin: boolean): boolean {
  return hasWorkspaceAdmin || holdsCapabilityFloor(auth, 'observer')
}

interface ParsedTarget {
  name: string
  args: Record<string, unknown>
  url: string
}

/** Shared parse for subscribe/unsubscribe identity fields. `requireHostAllowed` is false for
 *  unsubscribe (tearing down must not depend on the current allowlist). */
function parseTarget(
  env: Env,
  params: Record<string, unknown>,
  requireHostAllowed: boolean,
): { ok: true; t: ParsedTarget } | EventsFailure {
  const name = params.name
  if (typeof name !== 'string' || name.length === 0) return fail(-32602, 'invalid_params', { field: 'name' })
  if (CATALOGUE_ONLY_EVENTS.has(name)) {
    return fail(-32601, 'not_implemented', { method: 'events/subscribe', reason: 'event_not_implemented', name })
  }
  if (!SUBSCRIBABLE_EVENTS.has(name)) return fail(-32602, 'unknown_event', { name })
  const rawArgs = params.arguments
  if (rawArgs !== undefined && rawArgs !== null) {
    const o = asObject(rawArgs)
    if (!o || Object.keys(o).length > 0) {
      return fail(-32602, 'invalid_arguments', { reason: 'message.created takes no arguments' })
    }
  }
  const delivery = asObject(params.delivery)
  if (!delivery || delivery.mode !== 'webhook') return fail(-32602, 'invalid_params', { field: 'delivery.mode' })
  let url: string
  if (requireHostAllowed) {
    const check = validateCallbackUrl(delivery.url, env)
    if (!check.ok) return fail(-32015, 'CallbackEndpointError', { reason: check.reason })
    url = check.url
  } else {
    if (typeof delivery.url !== 'string') return fail(-32602, 'invalid_params', { field: 'delivery.url' })
    try {
      url = new URL(delivery.url).href
    } catch {
      return fail(-32602, 'invalid_params', { field: 'delivery.url' })
    }
  }
  return { ok: true, t: { name, args: {}, url } }
}

function grantTtlMs(raw: unknown): number | EventsFailure {
  if (raw === undefined) return TTL_DEFAULT_MS
  // null asks for "no expiry": this server does not grant that; it grants the maximum instead
  // (and says so through a non-null refreshBefore).
  if (raw === null) return TTL_MAX_MS
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return fail(-32602, 'invalid_params', { field: 'ttlMs' })
  }
  return Math.min(Math.max(Math.floor(raw), TTL_MIN_MS), TTL_MAX_MS)
}

export async function eventsSubscribe(
  env: Env,
  auth: AuthContext,
  floorOk: boolean,
  paramsRaw: unknown,
  nowMs: number = Date.now(),
): Promise<EventsSuccess | EventsFailure> {
  const principal = eventsPrincipal(auth, floorOk)
  if (!principal.ok) return principal
  const params = asObject(paramsRaw)
  if (!params) return fail(-32602, 'invalid_params')

  const parsed = parseTarget(env, params, true)
  if (!parsed.ok) return parsed
  const { name, args, url } = parsed.t

  const delivery = asObject(params.delivery) as Record<string, unknown> // parseTarget proved it is an object
  const secret = delivery.secret
  if (typeof secret !== 'string' || !parseWebhookSecret(secret)) {
    return fail(-32602, 'invalid_params', { field: 'delivery.secret', reason: 'whsec_base64_24_to_64_bytes' })
  }
  const ttl = grantTtlMs(params.ttlMs)
  if (typeof ttl !== 'number') return ttl

  const masterKey = env.CONNECTOR_MASTER_KEY
  if (!masterKey) return fail(-32000, 'secret_storage_unavailable', undefined, 503)

  const id = await subscriptionId(principal.agentId, url, name, args)
  const now = new Date(nowMs).toISOString()
  const fingerprint = await secretFingerprint(secret)

  // Opportunistic expiry sweep for this agent (no cron dependency).
  await env.DB.prepare(
    `UPDATE event_subscriptions SET status = 'expired', revoke_reason = 'expired'
      WHERE tenant = ?1 AND agent_id = ?2 AND status = 'active' AND refresh_before <= ?3`,
  ).bind(env.TENANT_SLUG, principal.agentId, now).run()

  const existing = await env.DB.prepare(
    `SELECT id, status FROM event_subscriptions WHERE id = ?1 AND agent_id = ?2`,
  ).bind(id, principal.agentId).first<{ id: string; status: string }>()
  if (!existing) {
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM event_subscriptions WHERE tenant = ?1 AND agent_id = ?2 AND status = 'active'`,
    ).bind(env.TENANT_SLUG, principal.agentId).first<{ n: number }>()
    if ((count?.n ?? 0) >= MAX_ACTIVE_SUBSCRIPTIONS_PER_AGENT) {
      return fail(-32000, 'subscription_limit', { limit: MAX_ACTIVE_SUBSCRIPTIONS_PER_AGENT }, 429)
    }
  }

  // Verification cache: a SUCCESSFUL verification of the same principal + URL + secret within the
  // window is reused (spec permits a bounded cache). Scoped by secret fingerprint so a new secret
  // is always re-proven.
  const cutoff = new Date(nowMs - VERIFICATION_CACHE_MS).toISOString()
  const cached = await env.DB.prepare(
    `SELECT verified_at FROM event_subscriptions
      WHERE tenant = ?1 AND agent_id = ?2 AND callback_url = ?3 AND secret_fingerprint = ?4
        AND status = 'active' AND verified_at IS NOT NULL AND verified_at > ?5
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, principal.agentId, url, fingerprint, cutoff).first<{ verified_at: string }>()

  let verifiedAt = cached?.verified_at ?? null
  if (!verifiedAt) {
    const v = await verifyCallback(url, secret, id)
    if (!v.ok) return fail(-32015, 'CallbackEndpointError', { reason: v.reason })
    verifiedAt = now
  }

  const ciphertext = await encryptConnectorSecret(masterKey, id, 'mcp_events', secret)
  const refreshBefore = new Date(nowMs + ttl).toISOString()
  const rotationExpiry = new Date(nowMs + SECRET_ROTATION_WINDOW_MS).toISOString()

  await env.DB.prepare(
    `INSERT INTO event_subscriptions
       (id, tenant, agent_id, member_id, token_id, consented_by_member_id, event_name, arguments_json,
        callback_url, secret_ciphertext, secret_fingerprint, status, refresh_before, verified_at,
        created_at, last_refreshed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12, ?13, ?14, ?14)
     ON CONFLICT(id) DO UPDATE SET
       member_id = excluded.member_id,
       token_id = excluded.token_id,
       consented_by_member_id = excluded.consented_by_member_id,
       prev_secret_ciphertext = CASE WHEN event_subscriptions.secret_fingerprint != excluded.secret_fingerprint
                                     THEN event_subscriptions.secret_ciphertext
                                     ELSE event_subscriptions.prev_secret_ciphertext END,
       prev_secret_expires_at = CASE WHEN event_subscriptions.secret_fingerprint != excluded.secret_fingerprint
                                     THEN ?15
                                     ELSE event_subscriptions.prev_secret_expires_at END,
       secret_ciphertext = excluded.secret_ciphertext,
       secret_fingerprint = excluded.secret_fingerprint,
       status = 'active',
       refresh_before = excluded.refresh_before,
       verified_at = excluded.verified_at,
       last_refreshed_at = excluded.last_refreshed_at,
       revoked_at = NULL,
       revoke_reason = NULL
     WHERE event_subscriptions.agent_id = excluded.agent_id`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      principal.agentId,
      principal.memberId,
      principal.tokenId,
      auth.consentedByMemberId ?? null,
      name,
      canonicalJson(args),
      url,
      ciphertext,
      fingerprint,
      refreshBefore,
      verifiedAt,
      now,
      rotationExpiry,
    )
    .run()

  // truthful: message.created is not replayable, so a supplied cursor's history is unavailable.
  const cursorSupplied = params.cursor !== undefined && params.cursor !== null && params.cursor !== ''
  return { ok: true, result: { id, refreshBefore, cursor: null, truncated: cursorSupplied } }
}

/** Revoke ONE subscription, only if it belongs to `agentId`. Returns true iff a live row flipped. */
export async function revokeSubscriptionForAgent(
  env: Env,
  agentId: string,
  id: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE event_subscriptions
        SET status = 'revoked', revoked_at = ?4, revoke_reason = ?3
      WHERE id = ?1 AND agent_id = ?2 AND tenant = ?5 AND status != 'revoked'`,
  ).bind(id, agentId, reason, new Date(nowMs).toISOString(), env.TENANT_SLUG).run()
  return (res.meta?.changes ?? 0) > 0
}

export async function eventsUnsubscribe(
  env: Env,
  auth: AuthContext,
  floorOk: boolean,
  paramsRaw: unknown,
): Promise<EventsSuccess | EventsFailure> {
  const principal = eventsPrincipal(auth, floorOk)
  if (!principal.ok) return principal
  const params = asObject(paramsRaw)
  if (!params) return fail(-32602, 'invalid_params')
  const parsed = parseTarget(env, params, false)
  if (!parsed.ok) return parsed
  const { name, args, url } = parsed.t
  // The id is derived from the CALLER's own agent id, so a caller can only ever address its own
  // subscriptions; revokeSubscriptionForAgent re-asserts ownership in the write's WHERE.
  const id = await subscriptionId(principal.agentId, url, name, args)
  await revokeSubscriptionForAgent(env, principal.agentId, id, 'unsubscribed')
  return { ok: true, result: {} } // idempotent: same result whether or not a live row existed
}

// ── delivery-time access re-check ────────────────────────────────────────────────

export type AccessCheck = { live: true } | { live: false; reason: string }

/**
 * Is the subscribing principal STILL entitled to receive? Re-derived from D1 on every delivery:
 * the creating token is live (not revoked/expired) and still bound to this agent, the member is
 * active, the agent is active, and the principal still holds an observer-or-better capability
 * (for a directory consent session: the consent-clamped grants, re-derived live).
 */
export async function subscriberAccessLive(env: Env, sub: SubscriptionRow): Promise<AccessCheck> {
  const row = await env.DB.prepare(
    `SELECT t.channel AS channel, m.status AS member_status, a.status AS agent_status
       FROM member_tokens t
       JOIN members m ON m.id = t.member_id
       JOIN agents a ON a.id = t.agent_id
      WHERE t.id = ?1 AND t.member_id = ?2 AND t.agent_id = ?3 AND t.tenant = ?4
        AND m.tenant = ?4
        AND ${TOKEN_LIVE_PREDICATE('?5')}
      LIMIT 1`,
  ).bind(sub.token_id, sub.member_id, sub.agent_id, env.TENANT_SLUG, nowSqlUtc())
    .first<{ channel: string; member_status: string; agent_status: string }>()
  if (!row) return { live: false, reason: 'token_not_live' }
  if (row.member_status !== 'active') return { live: false, reason: 'member_inactive' }
  if (row.agent_status !== 'active') return { live: false, reason: 'agent_inactive' }
  const grants = row.channel === 'directory'
    ? await resolveConsentedAgentCapabilities(env, sub.agent_id, sub.consented_by_member_id)
    : await resolveCapabilities(env, sub.member_id)
  if (!grants.some((g) => capabilityRank(g.capability) >= capabilityRank('observer'))) {
    return { live: false, reason: 'no_capability' }
  }
  return { live: true }
}

/** Decrypt the current (+ unexpired previous) signing secrets. Throws on any failure. */
export async function loadSigningSecrets(env: Env, sub: SubscriptionRow, nowMs: number): Promise<string[]> {
  const masterKey = env.CONNECTOR_MASTER_KEY
  if (!masterKey) throw new Error('secret_storage_unavailable')
  const out = [await decryptConnectorSecret(masterKey, sub.id, 'mcp_events', sub.secret_ciphertext)]
  if (sub.prev_secret_ciphertext && sub.prev_secret_expires_at && sub.prev_secret_expires_at > new Date(nowMs).toISOString()) {
    out.push(await decryptConnectorSecret(masterKey, sub.id, 'mcp_events', sub.prev_secret_ciphertext))
  }
  return out
}
