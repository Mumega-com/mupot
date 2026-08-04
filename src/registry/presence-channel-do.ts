// mupot — PresenceChannelDO: one Durable Object per (tenant, project) roster channel.
//
// ADR #473 follow-through: real-time pub/sub = Durable Object + WebSocket hibernation
// fan-out (CF-native). Never Cloudflare Pub/Sub MQTT. Gated at the Worker edge by
// REALTIME_PRESENCE=1 (see src/registry/realtime.ts); this class is inert until a
// subscribe/publish request is forwarded by the Worker.
//
// Surface:
//   GET  /subscribe?project=…&member=…&token_hash=…  — WebSocket upgrade; initial snapshot
//   POST /publish              — fan-out a JSON frame to every still-authorized socket
//
// mupot#545: each socket retains a (member, token_hash) lease and is revalidated before
// disclosure; DO alarm publishes offline transitions at heartbeat expiry.

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import { listPresence, PRESENCE_STALE_SECONDS } from './service'
import {
  encodeRosterPush,
  nextPresenceExpiryMs,
  reciprocateWebSocketClose,
} from './realtime'
import {
  encodePresenceSocketTags,
  fanOutAuthorizedRoster,
  parsePresenceSocketTags,
  PRESENCE_AUTH_REVOKED_CLOSE_CODE,
  subscriptionStillAuthorized,
} from './presence-subscription-auth'

const PROJECT_ID_STORAGE_KEY = 'projectId'

export class PresenceChannelDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/publish' && req.method === 'POST') {
      const body = await req.text()
      if (!body) return Response.json({ error: 'empty_body' }, { status: 400 })
      const projectId = await this.loadProjectId()
      const sent = await this.discloseRoster(body)
      await this.scheduleExpiryAlarm(projectId, new Date())
      return Response.json({ ok: true, sent })
    }

    if (url.pathname === '/subscribe' && req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const projectRaw = url.searchParams.get('project')
      const projectId = projectRaw === null || projectRaw === '' ? null : projectRaw
      const memberId = url.searchParams.get('member')
      const tokenHash = url.searchParams.get('token_hash')
      if (!memberId || !tokenHash) {
        return Response.json({ error: 'subscription_lease_required' }, { status: 400 })
      }

      const lease = { projectId, memberId, tokenHash }
      const stillOk = await subscriptionStillAuthorized(this.env, lease)
      if (!stillOk) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      this.ctx.acceptWebSocket(server, encodePresenceSocketTags(lease))
      await this.ctx.storage.put(PROJECT_ID_STORAGE_KEY, projectId)

      const now = new Date()
      const modules = await listPresence(this.env, { projectId }, now)
      server.send(encodeRosterPush(projectId, modules, now))
      await this.scheduleExpiryAlarm(projectId, now)

      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response('not found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const type = (parsed as Record<string, unknown>).type
    if (type !== 'sync') return

    const lease = parsePresenceSocketTags(this.ctx.getTags(ws))
    if (!lease) {
      reciprocateWebSocketClose(ws, PRESENCE_AUTH_REVOKED_CLOSE_CODE, 'auth_revoked')
      return
    }
    const stillOk = await subscriptionStillAuthorized(this.env, lease)
    if (!stillOk) {
      reciprocateWebSocketClose(ws, PRESENCE_AUTH_REVOKED_CLOSE_CODE, 'auth_revoked')
      return
    }

    const now = new Date()
    const modules = await listPresence(this.env, { projectId: lease.projectId }, now)
    ws.send(encodeRosterPush(lease.projectId, modules, now))
    await this.scheduleExpiryAlarm(lease.projectId, now)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Never pass reserved/abnormal codes (1005/1006/1015) through raw — RangeError.
    reciprocateWebSocketClose(ws, code, reason)
  }

  /**
   * Heartbeat-expiry publisher: when the earliest online module crosses
   * PRESENCE_STALE_SECONDS, push a fresh roster so subscribers do not retain
   * stale online state indefinitely (mupot#545).
   */
  async alarm(): Promise<void> {
    const projectId = await this.loadProjectId()
    const now = new Date()
    const modules = await listPresence(this.env, { projectId }, now)
    const body = encodeRosterPush(projectId, modules, now)
    await this.discloseRoster(body)
    await this.scheduleExpiryAlarm(projectId, now)
  }

  private async discloseRoster(body: string): Promise<number> {
    return fanOutAuthorizedRoster(
      this.env,
      this.ctx.getWebSockets(),
      (socket) => this.ctx.getTags(socket),
      body,
    )
  }

  private async loadProjectId(): Promise<string | null> {
    const stored = await this.ctx.storage.get<string | null>(PROJECT_ID_STORAGE_KEY)
    if (stored === undefined || stored === null || stored === '') return null
    return stored
  }

  private async scheduleExpiryAlarm(projectId: string | null, now: Date): Promise<void> {
    const modules = await listPresence(this.env, { projectId }, now)
    const nextMs = nextPresenceExpiryMs(modules, now.getTime(), PRESENCE_STALE_SECONDS)
    if (nextMs === null) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    await this.ctx.storage.setAlarm(nextMs)
  }
}
