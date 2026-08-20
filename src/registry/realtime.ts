// mupot — gated real-time presence pub/sub (ADR #473).
//
// Query-time roster (listPresence / GET /api/presence) remains the source of truth for
// the coordination loop. This module is the CF-native push channel for surfaces that
// need live roster fan-out: one Durable Object per (tenant, project) with WebSocket
// hibernation — never Cloudflare Pub/Sub (MQTT).
//
// Gate: REALTIME_PRESENCE=1 AND Env.PRESENCE_CHANNEL bound. When off, every helper
// is a no-op / route 404 — the pot behaves exactly as before ADR follow-through #2.

import type { Env } from '../types'
import type { ModulePresence } from './service'

export const REALTIME_PRESENCE_FLAG = '1'

export type RosterPushMessage = {
  type: 'roster'
  project_id: string | null
  modules: ModulePresence[]
  at: string
}

export function isRealtimePresenceEnabled(env: Env): boolean {
  return env.REALTIME_PRESENCE === REALTIME_PRESENCE_FLAG && env.PRESENCE_CHANNEL !== undefined
}

/** Stable DO idFromName key — tenant-scoped so two pots never share a channel. */
export function presenceChannelName(tenant: string, projectId: string | null): string {
  const trimmed = tenant.trim()
  if (!trimmed) throw new Error('presence_channel_tenant_required')
  const projectKey = projectId === null || projectId === '' ? '_' : projectId
  return `${trimmed}:presence:${projectKey}`
}

export function encodeRosterPush(
  projectId: string | null,
  modules: ModulePresence[],
  at: Date,
): string {
  const message: RosterPushMessage = {
    type: 'roster',
    project_id: projectId,
    modules,
    at: at.toISOString(),
  }
  return JSON.stringify(message)
}

export function parseRosterPush(raw: string): RosterPushMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('roster_push_invalid_json')
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('roster_push_invalid_shape')
  const obj = parsed as Record<string, unknown>
  if (obj.type !== 'roster') throw new Error('roster_push_wrong_type')
  if (!(obj.project_id === null || typeof obj.project_id === 'string')) {
    throw new Error('roster_push_invalid_project_id')
  }
  if (!Array.isArray(obj.modules)) throw new Error('roster_push_invalid_modules')
  if (typeof obj.at !== 'string') throw new Error('roster_push_invalid_at')
  return {
    type: 'roster',
    project_id: obj.project_id,
    modules: obj.modules as ModulePresence[],
    at: obj.at,
  }
}

/** Fan-out a string frame to every socket. Returns how many sends succeeded. */
export function fanOutWebSockets(
  sockets: ReadonlyArray<{ send: (data: string) => void }>,
  message: string,
): number {
  let sent = 0
  for (const socket of sockets) {
    try {
      socket.send(message)
      sent += 1
    } catch {
      // Drop dead sockets; hibernation close handlers clean them up.
    }
  }
  return sent
}

/**
 * nextPresenceExpiryMs — earliest wall-clock instant when an currently-online
 * module's heartbeat window ends (last_heartbeat + PRESENCE_STALE_SECONDS).
 * PresenceChannelDO schedules an alarm at this instant so subscribers receive an
 * offline transition without relying on client-side sync. null = nothing online.
 */
export function nextPresenceExpiryMs(
  modules: ReadonlyArray<Pick<ModulePresence, 'status' | 'last_heartbeat'>>,
  nowMs: number,
  staleSeconds: number,
): number | null {
  if (!Number.isFinite(nowMs)) throw new Error('presence_expiry_now_invalid')
  if (!Number.isFinite(staleSeconds) || staleSeconds < 0) {
    throw new Error('presence_expiry_stale_invalid')
  }
  let earliest: number | null = null
  for (const mod of modules) {
    if (mod.status !== 'online') continue
    const heartbeatMs = Date.parse(mod.last_heartbeat)
    if (Number.isNaN(heartbeatMs)) continue
    const expiryMs = heartbeatMs + staleSeconds * 1000
    if (expiryMs <= nowMs) return nowMs
    if (earliest === null || expiryMs < earliest) earliest = expiryMs
  }
  return earliest
}

/**
 * Reserved / abnormal close codes (RFC 6455 §7.4.1) are synthesized by the
 * runtime when no Close frame arrived. Passing them to WebSocket.close()
 * throws RangeError inside the hibernation close handler — map to 1000
 * (same pattern as Cloudflare / PartyServer templates).
 */
const RESERVED_WEBSOCKET_CLOSE_CODES: ReadonlySet<number> = new Set([1005, 1006, 1015])

export function sanitizeWebSocketCloseCode(code: number): number {
  if (RESERVED_WEBSOCKET_CLOSE_CODES.has(code)) return 1000
  return code
}

/** Reciprocate a peer close without feeding reserved codes into ws.close(). */
export function reciprocateWebSocketClose(
  ws: { close: (code: number, reason: string) => void },
  code: number,
  reason: string,
): void {
  ws.close(sanitizeWebSocketCloseCode(code), reason)
}

export type PublishRosterResult =
  | { ok: true; skipped: true; reason: 'disabled' }
  | { ok: true; skipped: false; sent: number }
  | { ok: false; error: string }

/**
 * publishRosterPush — best-effort live roster fan-out. Source of truth stays D1;
 * a failed push never rolls back register/heartbeat/deregister. Disabled gate →
 * skipped (not an error).
 *
 * The Worker does NOT snapshot D1 here. Snapshotting in the caller, then POSTing
 * that body to the DO, races: a later heartbeat can land in D1, then an older
 * offline snapshot can still be disclosed. The DO recomputes the roster itself
 * (single-threaded per channel) so publish order cannot resurrect a stale frame.
 */
export async function publishRosterPush(
  env: Env,
  projectId: string | null,
  _now: Date,
): Promise<PublishRosterResult> {
  if (!isRealtimePresenceEnabled(env)) return { ok: true, skipped: true, reason: 'disabled' }
  const ns = env.PRESENCE_CHANNEL
  if (!ns) return { ok: true, skipped: true, reason: 'disabled' }

  const stub = ns.get(ns.idFromName(presenceChannelName(env.TENANT_SLUG, projectId)))
  try {
    const res = await stub.fetch(
      new Request('https://presence-channel/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'publish', project_id: projectId }),
      }),
    )
    if (!res.ok) return { ok: false, error: `publish_http_${res.status}` }
    const payload = (await res.json()) as { sent?: unknown }
    const sent = typeof payload.sent === 'number' ? payload.sent : 0
    return { ok: true, skipped: false, sent }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'publish_fetch_failed'
    return { ok: false, error: message }
  }
}

const PRESENCE_LIVE_HOP_HEADERS = [
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
] as const

/**
 * Forward a WebSocket upgrade onto PresenceChannelDO without the caller's
 * Authorization (or any other) header. The DO receives member + token_hash on
 * the subscribe URL; a raw hop would leak the bearer into the DO.
 */
export function presenceLiveDoUpgradeRequest(doUrl: URL, incoming: Request): Request {
  const headers = new Headers()
  for (const name of PRESENCE_LIVE_HOP_HEADERS) {
    const value = incoming.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Request(doUrl.toString(), { method: 'GET', headers })
}

/** Worker→DO publish is a trigger, not a roster frame. Stale snapshots are ignored. */
export function parsePublishTrigger(raw: string): { hasProjectId: boolean; projectId: string | null } {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return { hasProjectId: false, projectId: null }
    }
    if (!('project_id' in parsed)) return { hasProjectId: false, projectId: null }
    const projectId = (parsed as { project_id: unknown }).project_id
    if (projectId === null) return { hasProjectId: true, projectId: null }
    if (typeof projectId === 'string') return { hasProjectId: true, projectId }
  } catch {
    // empty or non-JSON body: DO uses stored project id
  }
  return { hasProjectId: false, projectId: null }
}
