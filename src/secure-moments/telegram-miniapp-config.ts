// mupot — Telegram Mini App adapter configuration (secure moments W4). Feature flag OFF by default: unless
// TELEGRAM_MINIAPP is '1' or 'true' AND secure moments are on, every /m/tg* path falls through to the routing that
// existed before this wave (so the flag off is a true no-op), and no helper returns a launch payload.
// Contract: docs/architecture/secure-moments.md (W4).
import type { Env } from '../types'
import { secureMomentsStatus } from './config'
import { TELEGRAM_PROD_PUBKEY_HEX } from './telegram-initdata'

type FlagEnv = Pick<Env, 'TELEGRAM_MINIAPP'>

export function telegramMiniappFlag(env: FlagEnv): boolean {
  const v = env.TELEGRAM_MINIAPP?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

export const MINIAPP_DEFAULT_MAX_AGE_SECONDS = 300
export const MINIAPP_MAX_AGE_CAP_SECONDS = 3600

export type MiniappStatus =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'on'; host: string; botId: string }

/** The numeric bot id a token names (`<id>:<secret>`), or null. */
export function botIdOfToken(token: string | undefined): string | null {
  const m = /^([1-9][0-9]{4,15}):[A-Za-z0-9_-]{20,}$/.exec(token?.trim() ?? '')
  return m ? m[1] : null
}

const BOT_ID_RE = /^[1-9][0-9]{4,15}$/

/** off / misconfigured (fail closed, with the reason) / on. Requires secure moments to be on. */
export function telegramMiniappStatus(env: Env): MiniappStatus {
  if (!telegramMiniappFlag(env)) return { state: 'off' }
  const secure = secureMomentsStatus(env)
  if (secure.state === 'off') return { state: 'misconfigured', reason: 'TELEGRAM_MINIAPP needs SECURE_MOMENTS' }
  if (secure.state === 'misconfigured') return { state: 'misconfigured', reason: `secure moments are misconfigured: ${secure.reason}` }
  const botId = env.TELEGRAM_MINIAPP_BOT_ID?.trim() ?? ''
  if (!BOT_ID_RE.test(botId)) return { state: 'misconfigured', reason: 'TELEGRAM_MINIAPP_BOT_ID must be the numeric id of the DEDICATED bot that launches the Mini App' }
  // The bot token is REQUIRED: the WORKER sends every Mini App button itself, so no harness ever handles a launch URL, and
  // only a bot whose token the worker alone holds can be the root of trust for initData. It must name the configured bot.
  const token = env.TELEGRAM_MINIAPP_BOT_TOKEN?.trim()
  if (!token) return { state: 'misconfigured', reason: 'TELEGRAM_MINIAPP_BOT_TOKEN (worker secret of the dedicated Mini App bot) is required' }
  if (botIdOfToken(token) !== botId) return { state: 'misconfigured', reason: 'TELEGRAM_MINIAPP_BOT_TOKEN does not belong to TELEGRAM_MINIAPP_BOT_ID' }
  // Never the bot the worker already uses for notifications/IM: that bot is shared with other surfaces by design.
  const shared = [env.TELEGRAM_BOT_TOKEN]
  if (shared.some((t) => t !== undefined && (botIdOfToken(t) === botId || t.trim() === token))) {
    return { state: 'misconfigured', reason: 'the Mini App bot must be a DEDICATED bot, not the notification/IM bot (TELEGRAM_BOT_TOKEN)' }
  }
  return { state: 'on', host: secure.host, botId }
}

/** auth_date freshness window: default 5 minutes, hard cap 1 hour, anything unparseable or non-positive = the default. */
export function miniappMaxAgeSeconds(env: Pick<Env, 'TELEGRAM_MINIAPP_MAX_AGE_SECONDS'>): number {
  const raw = env.TELEGRAM_MINIAPP_MAX_AGE_SECONDS?.trim()
  if (!raw || !/^[0-9]{1,6}$/.test(raw)) return MINIAPP_DEFAULT_MAX_AGE_SECONDS
  const n = Number(raw)
  if (n <= 0) return MINIAPP_DEFAULT_MAX_AGE_SECONDS
  return Math.min(n, MINIAPP_MAX_AGE_CAP_SECONDS)
}

/**
 * The Ed25519 keys initData may verify against. PRODUCTION ONLY by default: Telegram's published test-environment key
 * is deliberately absent. A staging pot may add keys through TELEGRAM_MINIAPP_EXTRA_PUBKEYS (comma separated 64-hex);
 * every entry widens who can mint a Telegram identity for this worker, so it is operator config, never request data,
 * and a malformed entry is dropped rather than interpreted.
 */
export function acceptedPublicKeys(env: Pick<Env, 'TELEGRAM_MINIAPP_EXTRA_PUBKEYS'>): string[] {
  const keys = [TELEGRAM_PROD_PUBKEY_HEX]
  for (const part of (env.TELEGRAM_MINIAPP_EXTRA_PUBKEYS ?? '').split(',')) {
    const k = part.trim().toLowerCase()
    if (/^[0-9a-f]{64}$/.test(k) && !keys.includes(k)) keys.push(k)
  }
  return keys
}

/** The dedicated bot's token, ONLY for sending the Mini App button (never for validating initData). */
export function miniappBotToken(env: Pick<Env, 'TELEGRAM_MINIAPP_BOT_TOKEN'>): string | null {
  const t = env.TELEGRAM_MINIAPP_BOT_TOKEN?.trim()
  return t ? t : null
}

/** The Telegram Mini App script, pinned to this ONE URL. The page's CSP allows exactly this source for script-src. */
export const TELEGRAM_WEBAPP_SCRIPT_URL = 'https://telegram.org/js/telegram-web-app.js'

export function miniappUrl(host: string, path: string): string {
  return `https://${host}${path}`
}
