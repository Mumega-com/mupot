// mupot — the payloads a gateway/plugin needs to put the Mini App in front of a human. PURE shaping plus two
// guarded reads: this worker makes NO Telegram Bot API call (no sendMessage, no answerWebAppQuery); the harness that
// owns the bot sends the button. A launch URL carries only a moment id or an enrolment token; neither is a bearer
// for a decision (the decision still needs a fresh signed initData of the right member plus the device secret).
import type { AuthContext, Env } from '../types'
import { hasWorkspaceAdmin } from '../auth/capability'
import { loadMoment, momentIsLive } from './store'
import { checkEnrolmentSession, type EnrolmentSessionRefusal } from './enrol-mint'
import { miniappUrl, telegramMiniappStatus } from './telegram-miniapp-config'
import { mintTgEnrolmentToken } from './telegram-miniapp-store'

export interface LaunchPayload {
  /** The https URL the Mini App loads. */
  url: string
  /** One Bot API InlineKeyboardButton with web_app (private chats only, a Telegram rule). */
  web_app_button: { text: string; web_app: { url: string } }
  /** A ready reply_markup for sendMessage. */
  reply_markup: { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> }
  /** https://t.me/<bot>/<app>?startapp=<param>, only when TELEGRAM_MINIAPP_BOT_USERNAME + _APP_SHORTNAME are configured. */
  t_me_link: string | null
}

const SHORTNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,31}$/
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/

function shape(env: Env, host: string, path: string, text: string, startParam: string): LaunchPayload {
  const url = miniappUrl(host, path)
  const button = { text, web_app: { url } }
  const bot = env.TELEGRAM_MINIAPP_BOT_USERNAME?.trim().replace(/^@/, '')
  const app = env.TELEGRAM_MINIAPP_APP_SHORTNAME?.trim()
  const tMe = bot && app && USERNAME_RE.test(bot) && SHORTNAME_RE.test(app) && /^[A-Za-z0-9_-]{1,512}$/.test(startParam)
    ? `https://t.me/${bot}/${app}?startapp=${startParam}` : null
  return { url, web_app_button: button, reply_markup: { inline_keyboard: [[button]] }, t_me_link: tMe }
}

export type MomentLaunchResult =
  | { ok: true; launch: LaunchPayload; moment_id: string; expires_at: string }
  | { ok: false; status: 403 | 404 | 409; error: 'not_enabled' | 'not_found' | 'moment_closed' | 'not_requester' | 'kind_not_supported' }

/**
 * The launch payload for a pending moment. The caller must be the AGENT that filed it or an org admin (an
 * unrelated member cannot even confirm a moment id exists). Credential moments are refused: the Mini App never
 * carries a secret.
 */
export async function momentMiniappLaunch(env: Env, auth: AuthContext, momentId: string, nowMs: number = Date.now()): Promise<MomentLaunchResult> {
  const status = telegramMiniappStatus(env)
  if (status.state !== 'on') return { ok: false, status: 404, error: 'not_enabled' }
  const m = momentId.length <= 64 ? await loadMoment(env, momentId) : null
  const isRequester = m !== null && m.requester_agent_id !== null && m.requester_agent_id === (auth.boundAgentId ?? null)
  if (!m || !(isRequester || hasWorkspaceAdmin(auth))) return { ok: false, status: 404, error: 'not_found' }
  if (m.kind !== 'seed_attach' && m.kind !== 'elevation') return { ok: false, status: 409, error: 'kind_not_supported' }
  if (!momentIsLive(m, nowMs)) return { ok: false, status: 409, error: 'moment_closed' }
  return {
    ok: true, moment_id: m.id, expires_at: m.expires_at,
    launch: shape(env, status.host, `/m/tg/${encodeURIComponent(m.id)}`, 'Review and decide', `m_${m.id}`),
  }
}

export type TgEnrolmentLinkResult =
  | { ok: true; url: string; expires_at: string; launch: LaunchPayload }
  | EnrolmentSessionRefusal

/** The Telegram-device enrolment link: the SAME session rules as the passkey link (checkEnrolmentSession). */
export async function mintTgEnrolmentLink(env: Env, auth: AuthContext, nowMs: number = Date.now()): Promise<TgEnrolmentLinkResult> {
  const status = telegramMiniappStatus(env)
  if (status.state !== 'on') return { ok: false, status: 404, error: 'not_enabled' }
  const checked = await checkEnrolmentSession(env, auth, nowMs)
  if (!checked.ok) return checked
  const minted = await mintTgEnrolmentToken(env, checked.memberId, checked.identityId, nowMs)
  const launch = shape(env, status.host, `/m/tg/enrol/${encodeURIComponent(minted.token)}`, 'Set up this device', `e_${minted.token}`)
  return { ok: true, url: launch.url, expires_at: minted.expiresAt, launch }
}
