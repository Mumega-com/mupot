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

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
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
