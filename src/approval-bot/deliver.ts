// mupot — deliver ONE elevation request to the deciding human through the approval bot.
//
// Same addressing rules as the Mini App delivery (decidingHuman: the filing agent's OWNER column, else the org's approvals
// member, else the tenant's single reachable human owner/admin; an attached chat is addressed to the human who attached it),
// so the bot never widens who may decide and never fans out. Best effort and never throws: the request is already filed, and
// the answer is a status word beside the plain approve_url.
//
// 'unavailable' is internal to request_elevation: the bot is off, or this request is not one the bot may carry, so the
// existing channels (Mini App button, approve_url) run exactly as before.
import type { Env } from '../types'
import { buildAuth } from '../access/identity'
import { mayDecideElevation } from '../access/decision-core'
import { loadAgentSessionById } from '../auth/agent-sessions'
import { loadAttachmentOriginOfSession, type ElevationRequestRecord } from '../auth/elevation'
import { decidingHuman } from '../secure-moments/telegram-miniapp-auto'
import { privateChatOf } from '../secure-moments/telegram-miniapp-binding'
import { approvalBotStatus } from './config'
import { botMayCarry, describeForBot, newShortId } from './policy'
import { sendBotMessage, type FetchFn } from './telegram'

export type ApprovalBotDelivery = 'sent' | 'pending' | 'not_bound' | 'failed' | 'unavailable'

/** How long the tool call waits for Telegram before it answers 'pending' and lets the send finish in the background. */
export const BOT_DELIVERY_TIMEOUT_MS = 4000

export interface BotDeliveryOpts {
  fetchFn?: FetchFn
  nowMs?: number
  timeoutMs?: number
  waitUntil?: (promise: Promise<unknown>) => void
}

/** Assign the short id once (unique per tenant); a collision retries with a fresh one. */
export async function ensureShortId(env: Env, req: ElevationRequestRecord): Promise<string | null> {
  const existing = await env.DB.prepare('SELECT short_id FROM elevation_requests WHERE id = ?1 AND tenant = ?2').bind(req.id, req.tenant).first<{ short_id: string | null }>()
  if (existing?.short_id) return existing.short_id
  for (let i = 0; i < 5; i++) {
    const candidate = newShortId()
    try {
      const r = await env.DB.prepare('UPDATE elevation_requests SET short_id = ?1 WHERE id = ?2 AND tenant = ?3 AND short_id IS NULL').bind(candidate, req.id, req.tenant).run()
      if (Number(r.meta?.changes ?? 0) === 1) return candidate
      const now = await env.DB.prepare('SELECT short_id FROM elevation_requests WHERE id = ?1 AND tenant = ?2').bind(req.id, req.tenant).first<{ short_id: string | null }>()
      if (now?.short_id) return now.short_id
    } catch {
      // UNIQUE collision on the short id: draw again.
    }
  }
  return null
}

async function deliver(env: Env, req: ElevationRequestRecord, opts: BotDeliveryOpts): Promise<ApprovalBotDelivery> {
  const bot = approvalBotStatus(env)
  if (bot.state !== 'on') return 'unavailable'
  if (!botMayCarry(req)) return 'unavailable'
  const nowMs = opts.nowMs ?? Date.now()
  // A request from an ATTACHED chat is approved with a passkey only (the shared decision core refuses a bot tap): never offer it here.
  const session = await loadAgentSessionById(env, req.tenant, req.agent_session_id)
  if (!session) return 'failed'
  const origin = await loadAttachmentOriginOfSession(env, req.tenant, session.credential_id)
  if (origin) return 'unavailable'
  const target = await decidingHuman(env, req.agent_id, null)
  if (!target) return 'not_bound'
  const chatId = await privateChatOf(env, target)
  if (!chatId) return 'not_bound'
  if (!(await mayDecideElevation(env, await buildAuth(env, target), req))) return 'not_bound'
  const shortId = await ensureShortId(env, req)
  if (!shortId) return 'failed'
  // Once-only slot: the UNIQUE(request_id) row is the whole guard, so a retry or a second call sends nothing more.
  const slotId = crypto.randomUUID()
  try {
    await env.DB.prepare(
      `INSERT INTO approval_bot_deliveries (id, tenant, request_id, member_id, chat_id, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'reserved', ?6)`,
    ).bind(slotId, req.tenant, req.id, target, chatId, new Date(nowMs).toISOString()).run()
  } catch {
    return 'sent'
  }
  const sent = await sendBotMessage(bot, {
    chatId,
    text: await describeForBot(env, req, shortId, nowMs),
    buttons: [{ text: 'Approve', callback_data: `ea:${shortId}` }, { text: 'Deny', callback_data: `ed:${shortId}` }],
  }, opts.fetchFn)
  await env.DB.prepare('UPDATE approval_bot_deliveries SET status = ?1, message_id = ?2, error = ?3 WHERE id = ?4')
    .bind(sent.ok ? 'sent' : 'failed', sent.ok ? sent.messageId : null, sent.ok ? null : sent.error, slotId).run()
  return sent.ok ? 'sent' : 'failed'
}

export async function deliverElevationToApprovalBot(env: Env, req: ElevationRequestRecord, opts: BotDeliveryOpts = {}): Promise<ApprovalBotDelivery> {
  if (approvalBotStatus(env).state !== 'on') return 'unavailable'
  const work: Promise<ApprovalBotDelivery> = deliver(env, req, opts).catch(() => 'failed' as const)
  try { opts.waitUntil?.(work) } catch { /* no execution context: the race below still bounds the caller */ }
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<ApprovalBotDelivery>((resolve) => { timer = setTimeout(() => resolve('pending'), opts.timeoutMs ?? BOT_DELIVERY_TIMEOUT_MS) })
  try { return await Promise.race([work, bound]) } finally { if (timer !== undefined) clearTimeout(timer) }
}
