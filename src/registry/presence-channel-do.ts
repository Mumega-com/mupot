// mupot — PresenceChannelDO: one Durable Object per (tenant, project) roster channel.
//
// ADR #473 follow-through: real-time pub/sub = Durable Object + WebSocket hibernation
// fan-out (CF-native). Never Cloudflare Pub/Sub MQTT. Gated at the Worker edge by
// REALTIME_PRESENCE=1 (see src/registry/realtime.ts); this class is inert until a
// subscribe/publish request is forwarded by the Worker.
//
// Surface:
//   GET  /subscribe?project=…  — WebSocket upgrade; pushes an initial roster snapshot
//   POST /publish              — fan-out a JSON frame to every attached socket

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import { listPresence } from './service'
import { encodeRosterPush, fanOutWebSockets, reciprocateWebSocketClose } from './realtime'

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
      const sent = fanOutWebSockets(this.ctx.getWebSockets(), body)
      return Response.json({ ok: true, sent })
    }

    if (url.pathname === '/subscribe' && req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const projectRaw = url.searchParams.get('project')
      const projectId = projectRaw === null || projectRaw === '' ? null : projectRaw
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      this.ctx.acceptWebSocket(server, [projectId ?? ''])

      const modules = await listPresence(this.env, { projectId }, new Date())
      server.send(encodeRosterPush(projectId, modules, new Date()))

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

    const tags = this.ctx.getTags(ws)
    const projectId = tags[0] === '' || tags[0] === undefined ? null : tags[0]
    const modules = await listPresence(this.env, { projectId }, new Date())
    ws.send(encodeRosterPush(projectId, modules, new Date()))
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Never pass reserved/abnormal codes (1005/1006/1015) through raw — RangeError.
    reciprocateWebSocketClose(ws, code, reason)
  }
}
