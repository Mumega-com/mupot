import type { Env } from '../types'
import { seatEventsChannelName, isSeatEventsEnabled } from './seat-events'
import { BEARER_LIFETIME_MS } from './seat-events-bearer'
import { validateInboxStreamIdentity, type StreamIdentity, type StreamAuthorization } from './inbox-stream-auth'
import { createInboxPushResponse, type PushSocket } from './inbox-push-stream'
import { readAgentInbox } from './messages'

type Connection = { kind: 'connected'; socket: WebSocket } | { kind: 'unavailable' } | { kind: 'refused'; status: number }
async function connect(env: Env, id: StreamIdentity): Promise<Connection> {
  const abort = new AbortController()
  let ended = false
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<Connection>(resolve => { timer = setTimeout(() => { ended = true; abort.abort(); resolve({ kind: 'unavailable' }) }, 5000) })
  const request = (async (): Promise<Connection> => {
    try {
      const descriptor = { kind: 'bearer', tenant: env.TENANT_SLUG, agent: id.agentId, seat: id.seat,
        credential_id: id.tokenId, member_id: id.memberId, not_after: Date.now() + BEARER_LIFETIME_MS }
      const r = await env.SEAT_EVENTS!.get(env.SEAT_EVENTS!.idFromName(seatEventsChannelName(env.TENANT_SLUG))).fetch(new Request('https://seat-events/bearer-connect', {
        headers: { Upgrade: 'websocket', 'x-mupot-bearer-subscription': JSON.stringify(descriptor) }, signal: abort.signal,
      }))
      if (r.status === 101 && r.webSocket) {
        r.webSocket.accept()
        if (ended) { r.webSocket.close(); return { kind: 'unavailable' } }
        return { kind: 'connected', socket: r.webSocket }
      }
      if (r.status === 503) {
        const data = await r.json().catch(() => null) as { error?: string } | null
        if (data?.error?.startsWith('bearer_') && data.error.endsWith('_capacity')) return { kind: 'refused', status: 503 }
        return { kind: 'unavailable' }
      }
      if (r.status >= 500) return { kind: 'unavailable' }
      return { kind: 'refused', status: r.status === 409 ? 409 : 403 }
    } catch { return { kind: 'unavailable' } }
  })()
  try { return await Promise.race([request, timeout]) } finally { clearTimeout(timer!) }
}

class FallbackSocket extends EventTarget implements PushSocket { readyState = 1; close() { this.readyState = 3 } }

async function validateBounded(env: Env, id: StreamIdentity): Promise<StreamAuthorization> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<StreamAuthorization>(resolve => { timer = setTimeout(() => resolve('error'), 5000) })
  try { return await Promise.race([validateInboxStreamIdentity(env, id), timeout]) }
  finally { clearTimeout(timer!) }
}

/** Subscribe first, then verify the current D1 fence before delivering any bodies. */
export async function openBearerPushStream(env: Env, id: StreamIdentity, since: number, signal: AbortSignal): Promise<Response> {
  if (!isSeatEventsEnabled(env)) return Response.json({ error: 'push_not_configured' }, { status: 503 })
  const connection = await connect(env, id)
  if (connection.kind === 'refused') return Response.json({ error: 'push_subscription_refused' }, { status: connection.status })
  const started = Date.now()
  const auth = await validateBounded(env, id)
  if (auth !== 'valid' || signal.aborted) {
    if (connection.kind === 'connected') connection.socket.close()
    return Response.json({ error: auth === 'error' ? 'authorization_unavailable' : 'authorization_invalid' }, { status: auth === 'error' ? 503 : 403 })
  }
  if (connection.kind === 'connected' && connection.socket.readyState !== 1) {
    connection.socket.close()
    return Response.json({ error: 'push_upstream_closed' }, { status: 503 })
  }
  // auth is a fresh proof of BOTH the exact credential and definitive no eligible grant.
  const fallback = connection.kind === 'unavailable'
  return createInboxPushResponse({
    socket: connection.kind === 'connected' ? connection.socket : new FallbackSocket(),
    authenticatedAt: Math.min(started, Date.now()), since, signal, fallback,
    validate: () => validateInboxStreamIdentity(env, id),
    read: async cursor => {
      const r = await readAgentInbox(env, { agent: id.agentId, seat: id.seat ?? undefined, peek: true, sinceSeq: cursor, limit: 100, skipRemaining: true })
      return r.ok ? { ok: true, messages: r.messages } : { ok: false }
    },
    renewSocket: async () => {
      const next = await connect(env, id)
      if (next.kind !== 'connected') return null
      const valid = await validateBounded(env, id)
      if (valid !== 'valid' || next.socket.readyState !== 1) { next.socket.close(); return null }
      return next.socket
    },
    metric: kind => console.info('[inbox-stream]', { mode: fallback ? 'fallback' : 'push', operation: kind }),
  })
}
