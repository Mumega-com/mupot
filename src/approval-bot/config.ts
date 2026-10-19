// mupot — the approval bot's configuration ("/muapprove"). OFF unless APPROVAL_BOT_TOKEN is set: with it unset nothing
// here runs, no route answers and request_elevation keeps the approve_url / Mini App path exactly as before.
//
// Three values, none ever written to wrangler.toml with a value (only their NAMES live in wrangler.example.toml):
//   APPROVAL_BOT_TOKEN           worker SECRET, the bot's Bot API token (sendMessage / answerCallbackQuery only)
//   APPROVAL_BOT_WEBHOOK_SECRET  worker SECRET, the setWebhook secret_token Telegram echoes in X-Telegram-Bot-Api-Secret-Token
//   APPROVAL_BOT_USERNAME        the bot's @username, display and /command@bot suffix matching only; carries no authority
//
// DEDICATED: the bot must not be the notification bot (TELEGRAM_BOT_TOKEN), the Mini App bot, or the IM / Hermes decision
// bot (KayHermes): a token or webhook secret shared with another surface would let that surface's holder act as the approver.
import type { Env } from '../types'

export type ApprovalBotStatus =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'on'; username: string; botId: string; token: string }

const TOKEN_RE = /^([1-9][0-9]{4,15}):[A-Za-z0-9_-]{20,}$/
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]$/
/** Telegram's own secret_token alphabet and length (1..256 of A-Za-z0-9_-); a floor of 24 keeps it unguessable. */
const SECRET_RE = /^[A-Za-z0-9_-]{24,256}$/

export function botIdOf(token: string | undefined): string | null {
  const m = TOKEN_RE.exec(token?.trim() ?? '')
  return m ? m[1] : null
}

export function approvalBotStatus(env: Pick<Env, 'APPROVAL_BOT_TOKEN' | 'APPROVAL_BOT_WEBHOOK_SECRET' | 'APPROVAL_BOT_USERNAME' | 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_MINIAPP_BOT_TOKEN' | 'TELEGRAM_MINIAPP_BOT_ID' | 'IM_WEBHOOK_SECRET'>): ApprovalBotStatus {
  const token = env.APPROVAL_BOT_TOKEN?.trim()
  if (!token) return { state: 'off' }
  const botId = botIdOf(token)
  if (!botId) return { state: 'misconfigured', reason: 'APPROVAL_BOT_TOKEN is not a Bot API token' }
  const secret = env.APPROVAL_BOT_WEBHOOK_SECRET?.trim() ?? ''
  if (!SECRET_RE.test(secret)) return { state: 'misconfigured', reason: 'APPROVAL_BOT_WEBHOOK_SECRET must be 24-256 characters of A-Z a-z 0-9 _ -' }
  const username = (env.APPROVAL_BOT_USERNAME ?? '').trim().replace(/^@/, '')
  if (!USERNAME_RE.test(username)) return { state: 'misconfigured', reason: 'APPROVAL_BOT_USERNAME must be the bot @username (ends in "bot")' }
  const others = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_MINIAPP_BOT_TOKEN]
  if (others.some((t) => t !== undefined && t.trim() !== '' && (t.trim() === token || botIdOf(t) === botId))) {
    return { state: 'misconfigured', reason: 'the approval bot must be its own bot, not the notification or Mini App bot' }
  }
  if (env.TELEGRAM_MINIAPP_BOT_ID?.trim() === botId) return { state: 'misconfigured', reason: 'the approval bot must be its own bot, not the Mini App bot' }
  if (env.IM_WEBHOOK_SECRET !== undefined && env.IM_WEBHOOK_SECRET.trim() === secret) {
    return { state: 'misconfigured', reason: 'APPROVAL_BOT_WEBHOOK_SECRET must differ from IM_WEBHOOK_SECRET' }
  }
  return { state: 'on', username, botId, token }
}
