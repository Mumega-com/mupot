// mupot — connection_check: the full-duplex check an ATTACHED chat runs on request (SEND, RECEIVE, WAKE), and the record the agent page shows.
//
//   SEND     the agent's own message is stored (a row from the agent, found by id) so a peer reading its mail can see it.
//   RECEIVE  the server drops a check message from the fixed system sender into the agent's inbox; the chat peeks it and marks it
//            handled (inbox_mark_handled, the only inbox write an attached chat has). Round-trip = the handled receipt exists.
//   WAKE     is there a live wake path for this agent: native wake (MCP Events subscription), a push host grant (seatlink), or a
//            webhook doorbell. Reported as which one, or none with the one line that enables it.
//
// Everything is derived from the attachment the SERVER resolved; no argument names an agent. The result is appended to agent_audit
// (action 'connection_check') so the panel can read the latest one. Authority: it writes one self-addressed message and one
// system-sender message to the attached agent's OWN inbox and one audit row; it widens nothing.

import type { Env } from '../types'
import { sendAgentMessage } from '../agents/messages'
import { ONBOARDING_SENDER } from '../agents/system-senders'
import { isEventsEnabled } from '../mcp/events'
import { nativeWakeState } from '../bus/events-delivery'
import { activeSeatEventGrant, authorizeSeatDelivery, isSeatEventsEnabled } from '../agents/seat-events'
import { getAgentWebhookDoorbell, webhookDoorbellEnabled } from '../agents/webhook-doorbell'

export type WakePath = 'native_wake' | 'push_host' | 'webhook_doorbell' | 'none'

export const WAKE_ENABLE_LINE = "say 'monitor my mupot inbox' to enable (the chat then checks inbox {peek:true} while it is open), or your human sets up push on the agent page"

export interface ConnectionCheckResult {
  send: { ok: boolean; message_id: string | null }
  receive: { state: 'ok' | 'pending'; message_id: string | null; next: string | null }
  wake: { path: WakePath; live: boolean; enable: string | null }
  summary: string
  checked_at: string
}

/** Pure: the plain one-liner. */
export function summarizeCheck(r: Pick<ConnectionCheckResult, 'send' | 'receive' | 'wake'>): string {
  const wake = r.wake.live ? `wake: ${r.wake.path}` : `wake: none — ${r.wake.enable ?? WAKE_ENABLE_LINE}`
  return `send ${r.send.ok ? '✓' : '✗'} receive ${r.receive.state === 'ok' ? '✓' : 'pending'} ${wake}`
}

export async function wakeLeg(env: Env, agentId: string, nowIso: string): Promise<ConnectionCheckResult['wake']> {
  const tenant = env.TENANT_SLUG
  if (isEventsEnabled(env)) {
    const s = await nativeWakeState(env, tenant, agentId, nowIso).catch(() => null)
    if (s?.state === 'live') return { path: 'native_wake', live: true, enable: null }
  }
  if (isSeatEventsEnabled(env)) {
    const g = await activeSeatEventGrant(env, agentId).catch(() => null)
    if (g && (await authorizeSeatDelivery(env, g.host_agent_id, agentId).catch(() => null)) === 'granted') return { path: 'push_host', live: true, enable: null }
  }
  if (webhookDoorbellEnabled(env)) {
    const d = await getAgentWebhookDoorbell(env, agentId).catch(() => null)
    if (d) return { path: 'webhook_doorbell', live: true, enable: null }
  }
  return { path: 'none', live: false, enable: WAKE_ENABLE_LINE }
}

const SYSTEM_REASON = 'connection_check probe addressed to the attached agent itself, resolved from the live attachment, not caller input'

export async function runConnectionCheck(
  env: Env,
  p: { attachmentId: string; agentId: string; humanMemberId: string; fresh?: boolean },
  nowMs: number = Date.now(),
): Promise<ConnectionCheckResult> {
  const nowIso = new Date(nowMs).toISOString()
  // SEND
  const sendRes = await sendAgentMessage(
    env,
    { fromAgent: p.agentId, fromMember: p.humanMemberId, toAgent: p.agentId, kind: 'message', body: 'connection_check: send probe from this chat (safe to ignore)', requestId: `check-send:${p.attachmentId}:${Math.floor(nowMs / 600000)}` },
    { system: true, reason: SYSTEM_REASON },
  )
  let sendId: string | null = null
  if (sendRes.ok) {
    const row = await env.DB.prepare(`SELECT id FROM agent_messages WHERE id = ?1 AND tenant = ?2 AND from_agent = ?3 LIMIT 1`).bind(sendRes.id, env.TENANT_SLUG, p.agentId).first<{ id: string }>()
    sendId = row?.id ?? null
  }
  // RECEIVE: reuse the newest open probe; once handled, report ok (fresh:true starts a new round).
  const like = `check-recv:${p.attachmentId}:%`
  const latest = await env.DB.prepare(`SELECT id FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2 AND from_agent = ?3 AND request_id LIKE ?4 ORDER BY seq DESC LIMIT 1`)
    .bind(env.TENANT_SLUG, p.agentId, ONBOARDING_SENDER, like).first<{ id: string }>()
  const handled = async (id: string): Promise<boolean> => (await env.DB.prepare(`SELECT 1 AS x FROM agent_attachment_handled WHERE attachment_id = ?1 AND message_id = ?2 LIMIT 1`).bind(p.attachmentId, id).first<{ x: number }>()) !== null
  let recvId = latest?.id ?? null
  let recvOk = recvId !== null && (await handled(recvId))
  if (recvId === null || (recvOk && p.fresh === true)) {
    const round = recvId === null ? 1 : Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2 AND from_agent = ?3 AND request_id LIKE ?4`).bind(env.TENANT_SLUG, p.agentId, ONBOARDING_SENDER, like).first<{ n: number }>())?.n ?? 0) + 1
    const r = await sendAgentMessage(
      env,
      { fromAgent: ONBOARDING_SENDER, fromMember: p.humanMemberId, toAgent: p.agentId, kind: 'message', body: 'connection_check: receive probe. Read it with inbox {peek:true}, then call inbox_mark_handled with this message id, then call connection_check again.', requestId: `check-recv:${p.attachmentId}:${round}` },
      { system: true, reason: SYSTEM_REASON },
    )
    recvId = r.ok ? r.id : null
    recvOk = false
  }
  const wake = await wakeLeg(env, p.agentId, nowIso)
  const partial = {
    send: { ok: sendId !== null, message_id: sendId },
    receive: {
      state: recvOk ? ('ok' as const) : ('pending' as const),
      message_id: recvId,
      next: recvOk || recvId === null ? null : `Call inbox {peek:true}, then inbox_mark_handled {ids:["${recvId}"]}, then call connection_check again.`,
    },
    wake,
  }
  const result: ConnectionCheckResult = { ...partial, summary: summarizeCheck(partial), checked_at: nowIso }
  await env.DB.prepare(
    `INSERT INTO agent_audit (id, agent_id, actor_id, actor_type, action, fields_changed, before_state, after_state) VALUES (?1, ?2, ?3, 'system', 'connection_check', '["connection"]', '{}', ?4)`,
  ).bind(crypto.randomUUID(), p.agentId, p.humanMemberId, JSON.stringify({ attachment_id: p.attachmentId, send: result.send.ok, receive: result.receive.state, wake: wake.path, summary: result.summary })).run().catch(() => undefined)
  return result
}

/** The newest recorded check for this agent (panel). */
export async function latestConnectionCheck(env: Env, agentId: string): Promise<{ summary: string; at: string } | null> {
  const row = await env.DB.prepare(`SELECT after_state AS s, created_at AS at FROM agent_audit WHERE agent_id = ?1 AND action = 'connection_check' ORDER BY seq DESC LIMIT 1`)
    .bind(agentId).first<{ s: string; at: string }>().catch(() => null)
  if (!row) return null
  try {
    const j: unknown = JSON.parse(row.s)
    const summary = typeof j === 'object' && j !== null && 'summary' in j && typeof j.summary === 'string' ? j.summary : null
    return summary ? { summary: summary.slice(0, 300), at: row.at } : null
  } catch {
    return null
  }
}
