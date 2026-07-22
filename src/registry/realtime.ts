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
import { listPresence, type ModulePresence } from './service'

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
 */
export async function publishRosterPush(
  env: Env,
  projectId: string | null,
  now: Date,
): Promise<PublishRosterResult> {
  if (!isRealtimePresenceEnabled(env)) return { ok: true, skipped: true, reason: 'disabled' }
  const ns = env.PRESENCE_CHANNEL
  if (!ns) return { ok: true, skipped: true, reason: 'disabled' }

  const modules = await listPresence(env, { projectId }, now)
  const body = encodeRosterPush(projectId, modules, now)
  const stub = ns.get(ns.idFromName(presenceChannelName(env.TENANT_SLUG, projectId)))
  let res: Response
  try {
    res = await stub.fetch(
      new Request('https://presence-channel/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'publish_fetch_failed'
    return { ok: false, error: message }
  }
  if (!res.ok) return { ok: false, error: `publish_http_${res.status}` }
  const payload = (await res.json()) as { sent?: unknown }
  const sent = typeof payload.sent === 'number' ? payload.sent : 0
  return { ok: true, skipped: false, sent }
}
