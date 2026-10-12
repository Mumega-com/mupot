// mupot — "Set up this phone": the WORKER mints the single-use device-enrolment link and sends it as a web_app button to the
// member's own bound private chat (secure moments W4). Kept apart from telegram-miniapp-launch.ts so the dashboard imports
// only light modules. The link is never returned to anyone; the caller gets a delivery receipt.
import type { AuthContext, Env } from '../types'
import { checkEnrolmentSession, type EnrolmentSessionRefusal } from './enrol-mint'
import { telegramMiniappStatus } from './telegram-miniapp-config'
import { sendMiniappButton, type FetchFn } from './telegram-miniapp-send'
import { privateChatOf } from './telegram-miniapp-binding'
import { mintTgEnrolmentToken, recentDeliveryCount, recordDelivery, TG_DELIVERY_MAX_PER_WINDOW } from './telegram-miniapp-store'

export interface DeliveryReceipt {
  delivery_id: string
  status: 'sent'
  sent_at: string
}

export type EnrolDeliveryResult =
  | ({ ok: true } & DeliveryReceipt)
  | EnrolmentSessionRefusal
  | { ok: false; status: 409 | 429 | 502; error: 'telegram_not_bound' | 'rate_limited' | 'send_failed' }

/**
 * "Set up this phone": the SAME session rules as the passkey link (checkEnrolmentSession), then the WORKER mints the
 * single-use link and sends it as a web_app button to the member's own bound private chat. The link is never returned.
 */
export async function requestEnrolDelivery(env: Env, auth: AuthContext, fetchFn?: FetchFn, nowMs: number = Date.now()): Promise<EnrolDeliveryResult> {
  if (telegramMiniappStatus(env).state !== 'on') return { ok: false, status: 404, error: 'not_enabled' }
  const checked = await checkEnrolmentSession(env, auth, nowMs)
  if (!checked.ok) return checked
  const chatId = await privateChatOf(env, checked.memberId)
  if (!chatId) return { ok: false, status: 409, error: 'telegram_not_bound' }
  if ((await recentDeliveryCount(env, checked.memberId, nowMs)) >= TG_DELIVERY_MAX_PER_WINDOW) return { ok: false, status: 429, error: 'rate_limited' }
  const minted = await mintTgEnrolmentToken(env, checked.memberId, checked.identityId, nowMs)
  const sent = await sendMiniappButton(env, {
    chatId, path: `/m/tg/enrol/${encodeURIComponent(minted.token)}`, buttonText: 'Set up this phone',
    text: 'Set up this phone for approvals. Open the button below within 10 minutes and confirm with your fingerprint or face. If you did not ask for this, ignore it.',
  }, fetchFn)
  const receipt = await recordDelivery(env, { kind: 'enrol', subjectId: checked.memberId, memberId: checked.memberId, requestedBy: checked.memberId, status: sent.ok ? 'sent' : 'failed', error: sent.ok ? null : sent.error, messageId: sent.ok ? sent.messageId : null }, nowMs)
  if (!sent.ok) return { ok: false, status: 502, error: 'send_failed' }
  return { ok: true, delivery_id: receipt.id, status: 'sent', sent_at: receipt.createdAt }
}
