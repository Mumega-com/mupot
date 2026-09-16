// mupot — Telegram channel adapter (LEAF plugin). The microkernel core depends ONLY
// on the ChannelAdapter interface; this file is the single place Telegram-specific
// knowledge lives. Adding/removing Telegram = this file + one registry entry.
//
// Scoping note: Telegram supergroup TOPICS are not per-user access-controlled, so the
// scoped unit is a per-squad GROUP (chat.id = the squad channel). Identity is the
// SENDER (from.id), never the chat or any text field — the core resolves both to a
// binding/member. (src/im/index.ts remains for back-compat; this is the canonical path.)
//
// Secrets: IM_WEBHOOK_SECRET (on Env) authenticates the webhook via Telegram's
// secret_token header; TELEGRAM_BOT_TOKEN (adapter-local) calls the Bot API. Neither is
// ever logged, echoed, or returned.

import type { ChannelAdapter, Env, InboundMessage } from '../../types'
import { timingSafeEqual } from '../../lib/crypto'

interface TelegramSecrets {
  // adapter-local: the Bot API token (wrangler secret), not on the shared Env.
  TELEGRAM_BOT_TOKEN?: string
}
function telegramSecrets(env: Env): TelegramSecrets {
  // documented adapter-local secret seam (same pattern as the Google Chat adapter);
  // widens nothing for the core and never escapes this module.
  return env as unknown as TelegramSecrets
}

const API = 'https://api.telegram.org'

interface TgUpdate {
  message?: {
    chat?: { id?: unknown }
    from?: { id?: unknown }
    text?: unknown
  }
}

function idToString(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  return null
}

const BOT_USERNAME_CACHE_KEY = 'telegram:bot_username:v1'
// Bot usernames essentially never change — 6h bounds getMe call volume across
// every dashboard "Connect Telegram" page render without a real rotation
// staying stale for long.
const BOT_USERNAME_CACHE_TTL_SECONDS = 6 * 60 * 60

/**
 * The bot's own @username, for building a t.me deep link (`https://t.me/
 * <username>?start=<code>`) on the dashboard's Connect Telegram page.
 *
 * mupot#1412 (dashboard Connect Telegram): `TELEGRAM_BOT_USERNAME` was
 * explicitly REMOVED as an Env key (see src/types.ts's own comment — "Do not
 * reintroduce them: a second authorisation model on one surface means the
 * weaker one sets the level"), because it powered the old
 * `/api/integrations/telegram` allowlist. This is a DIFFERENT, display-only
 * use with no bearing on authorization — createProjectInvite/redeemTelegram-
 * ProjectInvite never read it — so rather than reintroduce that key, the
 * username is derived live from the Bot API via `getMe`, using the SAME
 * `TELEGRAM_BOT_TOKEN` secret every other call in this file already uses.
 * Cached in SESSIONS KV (the same general-purpose short-TTL cache other
 * dashboard reads already use, e.g. src/dashboard/brain.ts's PHYSICS_KV_KEY)
 * so a page loaded by many members doesn't call `getMe` on every render.
 *
 * Returns null when the token is unset, the call fails, or the response
 * carries no username — callers must render an honest "not configured"
 * state, never fabricate a link.
 */
export async function getTelegramBotUsername(env: Env): Promise<string | null> {
  const token = telegramSecrets(env).TELEGRAM_BOT_TOKEN
  if (!token) return null
  if (env.SESSIONS) {
    const cached = await env.SESSIONS.get(BOT_USERNAME_CACHE_KEY)
    if (cached) return cached
  }
  try {
    const res = await fetch(`${API}/bot${token}/getMe`)
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; result?: { username?: unknown } }
    const username = typeof data.result?.username === 'string' ? data.result.username.trim() : ''
    if (!username) return null
    if (env.SESSIONS) {
      await env.SESSIONS.put(BOT_USERNAME_CACHE_KEY, username, { expirationTtl: BOT_USERNAME_CACHE_TTL_SECONDS })
    }
    return username
  } catch {
    return null
  }
}

export const telegramAdapter: ChannelAdapter = {
  platform: 'telegram',

  // Fail-closed: the webhook must carry the secret_token registered via setWebhook.
  async verify(req: Request, env: Env): Promise<boolean> {
    if (!env.IM_WEBHOOK_SECRET) return false
    const provided = req.headers.get('X-Telegram-Bot-Api-Secret-Token')
    if (!provided) return false
    return timingSafeEqual(provided, env.IM_WEBHOOK_SECRET)
  },

  async parseInbound(req: Request, _env: Env): Promise<InboundMessage | null> {
    let update: TgUpdate
    try {
      update = (await req.json()) as TgUpdate
    } catch {
      return null
    }
    const externalChannelId = idToString(update.message?.chat?.id) // the squad GROUP
    const externalUserId = idToString(update.message?.from?.id) // the SENDER (identity)
    if (!externalChannelId || !externalUserId) return null
    const text = typeof update.message?.text === 'string' ? update.message.text : ''
    return { platform: 'telegram', externalChannelId, externalUserId, text }
  },

  async post(env: Env, externalChannelId: string, text: string): Promise<void> {
    const token = telegramSecrets(env).TELEGRAM_BOT_TOKEN
    if (!token) throw new Error('telegram: TELEGRAM_BOT_TOKEN not configured')
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: externalChannelId, text }),
    })
    if (!res.ok) {
      // never include the token (it is only in the URL path above, not the message)
      throw new Error(`telegram sendMessage failed: ${res.status}`)
    }
  },

  // Telegram does not expose a full member roster to bots. Best-effort: the chat
  // administrators (reliable). Full membership sync needs the bot to track join/leave
  // events — documented limitation; admins still reconcile correctly.
  async listChannelMembers(env: Env, externalChannelId: string): Promise<string[]> {
    const token = telegramSecrets(env).TELEGRAM_BOT_TOKEN
    if (!token) return []
    try {
      const res = await fetch(`${API}/bot${token}/getChatAdministrators`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: externalChannelId }),
      })
      if (!res.ok) return []
      const data = (await res.json()) as {
        result?: Array<{ user?: { id?: unknown } }>
      }
      const out: string[] = []
      for (const m of data.result ?? []) {
        const id = idToString(m.user?.id)
        if (id) out.push(id)
      }
      return out
    } catch {
      return []
    }
  },
}
