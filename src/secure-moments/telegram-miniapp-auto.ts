// mupot — automatic Telegram delivery of a freshly filed approval (secure moments W4 follow-up, mupot#1893).
//
// An agent that files an elevation or a seed attach should not have to know a SECOND tool exists for the human to see it.
// Right after the moment is created, the request tool calls deliverMomentToTelegram, which reuses the SAME pieces the
// `moment_miniapp_link` tool uses (private-chat binding, scope-local authority predicates, the dedicated bot's sender, the
// tg_miniapp_deliveries ledger) and adds only: who the deciding human is, a per-(moment, human) once-only slot, and a bound.
//
// BEST EFFORT, never throws: the request is already filed, and a Telegram problem is a status word beside the plain link.
// It never widens who may decide (the target must already hold the decision authority) and never broadcasts: exactly one
// human is addressed, the one the filing agent's OWNER column names (agents.owner_member_id, 0155), else, for a seed attach,
// the human who filed it. No owner and no human requester = nobody is addressed = 'not_bound' (a reported gap, not a fan-out).
import type { Env } from '../types'
import { buildAuth } from '../access/identity'
import { mayDecideElevation, mayDecideSeed } from '../access/decision-core'
import { loadMoment, momentIsLive } from './store'
import { telegramMiniappStatus } from './telegram-miniapp-config'
import { sendMiniappButton, type FetchFn } from './telegram-miniapp-send'
import { loadLiveSubject } from './telegram-miniapp'
import { privateChatOf } from './telegram-miniapp-binding'
import { finishDelivery, reserveMomentDeliveryOnce } from './telegram-miniapp-store'

export type MomentTelegramStatus = 'sent' | 'not_bound' | 'disabled' | 'failed' | 'rate_limited'

/** How long the tool call waits for Telegram before it answers 'failed' and lets the send finish in the background. */
export const AUTO_DELIVERY_TIMEOUT_MS = 4000

export interface AutoDeliveryOpts {
  fetchFn?: FetchFn
  nowMs?: number
  timeoutMs?: number
  waitUntil?: (promise: Promise<unknown>) => void
}

/** The ONE human a moment is addressed to, or null. Never a population. */
async function decidingHuman(env: Env, requesterAgentId: string | null, requesterMemberId: string | null): Promise<string | null> {
  if (requesterAgentId) {
    const row = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?1 LIMIT 1').bind(requesterAgentId)
      .first<{ owner_member_id: string | null }>()
    if (row?.owner_member_id) return row.owner_member_id
  }
  return requesterMemberId
}

async function deliver(env: Env, momentId: string, requesterMemberId: string | null, opts: AutoDeliveryOpts): Promise<MomentTelegramStatus> {
  const nowMs = opts.nowMs ?? Date.now()
  const m = await loadMoment(env, momentId)
  if (!m || !momentIsLive(m, nowMs)) return 'failed'
  if (m.kind !== 'seed_attach' && m.kind !== 'elevation') return 'disabled'
  const subject = await loadLiveSubject(env, m, nowMs)
  if (!subject) return 'failed'
  const requesterAgentId = subject.kind === 'elevation' ? subject.req.agent_id : subject.row.requester_agent_id
  // A seed's requester member is a fallback only when the filer is a human (privateChatOf below refuses an agent-welded one).
  const target = await decidingHuman(env, requesterAgentId, subject.kind === 'seed_attach' ? subject.row.requester_member_id : requesterMemberId)
  if (!target || (m.decider_member_id !== null && m.decider_member_id !== target)) return 'not_bound'
  const chatId = await privateChatOf(env, target)
  if (!chatId) return 'not_bound'
  const targetAuth = await buildAuth(env, target)
  const mayDecide = subject.kind === 'seed_attach' ? mayDecideSeed(targetAuth) : await mayDecideElevation(env, targetAuth, subject.req)
  if (!mayDecide) return 'not_bound'
  const slot = await reserveMomentDeliveryOnce(env, { momentId: m.id, memberId: target, requestedBy: requesterAgentId ?? requesterMemberId ?? 'unknown' }, nowMs)
  if (slot.state === 'duplicate') return 'sent'
  if (slot.state === 'rate_limited') return 'rate_limited'
  const sent = await sendMiniappButton(env, {
    chatId, path: `/m/tg/${encodeURIComponent(m.id)}`, buttonText: 'Review and decide',
    text: 'A request is waiting for your decision. Open it below; nothing is decided until you confirm with your fingerprint or face.',
  }, opts.fetchFn)
  await finishDelivery(env, slot.id, { status: sent.ok ? 'sent' : 'failed', error: sent.ok ? null : sent.error, messageId: sent.ok ? sent.messageId : null })
  return sent.ok ? 'sent' : 'failed'
}

/**
 * Send the Mini App button for a just-filed moment to its deciding human and say what happened. Never throws and never
 * waits longer than the timeout; the send itself is handed to waitUntil (when the runtime has one) so it can still finish.
 */
export async function deliverMomentToTelegram(
  env: Env,
  input: { momentId: string; requesterMemberId: string | null },
  opts: AutoDeliveryOpts = {},
): Promise<MomentTelegramStatus> {
  if (telegramMiniappStatus(env).state !== 'on') return 'disabled'
  const work: Promise<MomentTelegramStatus> = deliver(env, input.momentId, input.requesterMemberId, opts).catch(() => 'failed' as const)
  try { opts.waitUntil?.(work) } catch { /* no execution context: the race below still bounds the caller */ }
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<MomentTelegramStatus>((resolve) => { timer = setTimeout(() => resolve('failed'), opts.timeoutMs ?? AUTO_DELIVERY_TIMEOUT_MS) })
  try { return await Promise.race([work, bound]) } finally { if (timer !== undefined) clearTimeout(timer) }
}
