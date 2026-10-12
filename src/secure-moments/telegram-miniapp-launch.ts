// mupot — putting the Mini App in front of a human: the WORKER sends the web_app button itself (secure moments W4).
//
// No harness, agent or gateway ever receives a launch URL or an enrolment token: a caller only REQUESTS delivery and
// gets a receipt. The button goes to the target member's own bound PRIVATE chat from the dedicated Mini App bot
// (telegram-miniapp-send.ts). Every attempt leaves a row in tg_miniapp_deliveries, which is also the rate-limit ledger.
import type { AuthContext, Env } from '../types'
import { hasWorkspaceAdmin } from '../auth/capability'
import { buildAuth } from '../access/identity'
import { mayDecideElevation, mayDecideSeed } from '../access/decision-core'
import { loadMoment, momentIsLive } from './store'
import { telegramMiniappStatus } from './telegram-miniapp-config'
import { sendMiniappButton, type FetchFn } from './telegram-miniapp-send'
import { loadLiveSubject } from './telegram-miniapp'
import { privateChatOf } from './telegram-miniapp-binding'
import type { DeliveryReceipt } from './telegram-miniapp-enrol-delivery'
import { finishDelivery, reserveDelivery } from './telegram-miniapp-store'

export type MomentDeliveryResult =
  | ({ ok: true; moment_id: string; expires_at: string } & DeliveryReceipt)
  | { ok: false; status: 403 | 404 | 409 | 429 | 502; error: 'not_enabled' | 'not_found' | 'moment_closed' | 'kind_not_supported' | 'member_required' | 'target_not_reachable' | 'rate_limited' | 'chat_unreachable' | 'send_failed' }

/**
 * Ask the worker to send the Mini App button for a pending moment to `targetMemberId` (default: the moment's named
 * decider). The caller must be the AGENT that filed the moment or an org admin; anyone else reads "not found". The
 * target must be an active human who is bound to Telegram AND whose authority covers this decision right now, so the
 * button never goes to a member who could not decide it. Credential moments are refused (the Mini App carries no secret).
 */
export async function requestMomentDelivery(
  env: Env, auth: AuthContext, momentId: string, targetMemberId: string | undefined, fetchFn?: FetchFn, nowMs: number = Date.now(),
): Promise<MomentDeliveryResult> {
  if (telegramMiniappStatus(env).state !== 'on') return { ok: false, status: 404, error: 'not_enabled' }
  const m = momentId.length <= 64 ? await loadMoment(env, momentId) : null
  const isRequester = m !== null && m.requester_agent_id !== null && m.requester_agent_id === (auth.boundAgentId ?? null)
  if (!m || !(isRequester || hasWorkspaceAdmin(auth))) return { ok: false, status: 404, error: 'not_found' }
  if (m.kind !== 'seed_attach' && m.kind !== 'elevation') return { ok: false, status: 409, error: 'kind_not_supported' }
  if (!momentIsLive(m, nowMs)) return { ok: false, status: 409, error: 'moment_closed' }
  const target = targetMemberId ?? m.decider_member_id ?? undefined
  if (!target || (m.decider_member_id !== null && m.decider_member_id !== target)) return { ok: false, status: 409, error: 'member_required' }
  const subject = await loadLiveSubject(env, m, nowMs)
  if (!subject) return { ok: false, status: 409, error: 'moment_closed' }
  const chatId = await privateChatOf(env, target)
  if (!chatId) return { ok: false, status: 409, error: 'target_not_reachable' }
  const targetAuth = await buildAuth(env, target)
  const mayDecide = subject.kind === 'seed_attach' ? mayDecideSeed(targetAuth) : await mayDecideElevation(env, targetAuth, subject.req)
  if (!mayDecide) return { ok: false, status: 409, error: 'target_not_reachable' }
  const requestedBy = auth.boundAgentId ?? auth.memberId ?? 'unknown'
  // Reserve the slot atomically BEFORE sending (the cap holds under concurrency).
  const receipt = await reserveDelivery(env, { kind: 'moment', subjectId: m.id, memberId: target, requestedBy }, nowMs)
  if (!receipt) return { ok: false, status: 429, error: 'rate_limited' }
  const sent = await sendMiniappButton(env, {
    chatId, path: `/m/tg/${encodeURIComponent(m.id)}`, buttonText: 'Review and decide',
    text: 'A request is waiting for your decision. Open it below; nothing is decided until you confirm with your fingerprint or face.',
  }, fetchFn)
  await finishDelivery(env, receipt.id, { status: sent.ok ? 'sent' : 'failed', error: sent.ok ? null : sent.error, messageId: sent.ok ? sent.messageId : null })
  // chat_unreachable = Telegram refused the chat: almost always the member never pressed Start on the approvals bot.
  if (!sent.ok) return sent.error === 'chat_unreachable' ? { ok: false, status: 409, error: 'chat_unreachable' } : { ok: false, status: 502, error: 'send_failed' }
  return { ok: true, moment_id: m.id, expires_at: m.expires_at, delivery_id: receipt.id, status: 'sent', sent_at: receipt.createdAt }
}
