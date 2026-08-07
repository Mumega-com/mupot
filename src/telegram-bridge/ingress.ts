// Native Telegram Webhook Ingress Subsystem for Mupot
// Edge-native Cloudflare workerd Hono router mounted at /api/integrations/telegram

import { Hono } from 'hono'
import type { Env, BusEvent } from '../types'
import { resolveChannelIdentity, mayDispatch, refusalCode } from '../channels/identity'
import { createBus } from '../bus'
import type { TelegramUpdate, TelegramIngressResult } from './types'

export const SECRET_HEADER_NAME = 'x-telegram-bot-api-secret-token'
/** Cap on attacker-controlled text before it reaches an LLM harness. */
export const MAX_TEXT_CHARS = 4000

export const DEFAULT_BOT_USERNAME = 'River_mumega_bot'

/**
 * Validate incoming Telegram secret token header against expected secret token.
 */
/**
 * Constant-time string compare. Short-circuiting `===` on a secret leaks length and
 * position through timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

/**
 * Verify the Telegram secret-token header.
 *
 * Tri-state, deliberately. The previous shape returned `true` when the secret was
 * unset ("dev mode"), which authorised EVERY request on an unconfigured deploy —
 * and production IS the unset case until someone remembers to set the secret.
 * Absent configuration must REFUSE, and the caller must be able to tell "not
 * configured" (503) from "wrong secret" (401), because those are different
 * operational problems.
 */
export function validateSecretToken(
  headerValue: string | null | undefined,
  expectedSecret?: string,
): 'not_configured' | 'invalid' | 'ok' {
  if (!expectedSecret) return 'not_configured'
  if (!headerValue) return 'invalid'
  return timingSafeEqual(expectedSecret, headerValue) ? 'ok' : 'invalid'
}

/**
 * @deprecated Superseded by channel_identity (#775). Retained ONLY so a stale
 * TELEGRAM_ALLOWED_SENDERS in config cannot silently widen access: it is no longer
 * consulted on the dispatch path. Delete once no environment sets that var.
 */
export function isSenderAllowed(fromId: number | undefined, rawAllow?: string): boolean {
  if (fromId === undefined || !Number.isFinite(fromId)) return false
  if (!rawAllow) return false
  const allowed = rawAllow.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
  return allowed.length > 0 && allowed.includes(String(fromId))
}

/**
 * Check if a text in a group chat matches bot mention criteria.
 */
export function isGroupMentioned(text: string, botUsername: string = DEFAULT_BOT_USERNAME): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return (
    lower.includes(`@${botUsername.toLowerCase()}`) ||
    lower.includes('river') ||
    lower.includes('mupot')
  )
}

/**
 * Process a Telegram Update payload and determine task routing action.
 */
export function parseTelegramIngress(
  update: TelegramUpdate,
  botUsername: string = DEFAULT_BOT_USERNAME,
  mentionOnlyForGroups: boolean = true
): TelegramIngressResult {
  const msg = update.message || update.edited_message || update.channel_post
  if (!msg || (!msg.text && !msg.caption)) {
    return { action: 'empty_payload' }
  }

  const text = msg.text || msg.caption || ''
  const chatType = msg.chat.type

  // Enforce Mention-Only policy for group/supergroup chats
  if ((chatType === 'group' || chatType === 'supergroup') && mentionOnlyForGroups) {
    if (!isGroupMentioned(text, botUsername)) {
      return {
        action: 'ignored_group_unmentioned',
        chatId: msg.chat.id,
        sender: msg.from?.username || msg.from?.first_name || 'User',
        text
      }
    }
  }

  return {
    action: 'dispatched',
    chatId: msg.chat.id,
    sender: msg.from?.username || msg.from?.first_name || 'User',
    text,
    messageId: msg.message_id
  }
}

/**
 * Hono sub-app for Telegram Ingress endpoints
 * Mounted in src/index.ts under app.route('/api/integrations/telegram', telegramIngressApp)
 */
export const telegramIngressApp = new Hono<{ Bindings: Env }>()

telegramIngressApp.get('/webhook', (c) => {
  return c.json({ error: 'Method Not Allowed' }, 405)
})

telegramIngressApp.post('/webhook', async (c) => {
  const secretHeader = c.req.header(SECRET_HEADER_NAME)
  const expectedSecret = c.env.TELEGRAM_WEBHOOK_SECRET

  const verdict = validateSecretToken(secretHeader, expectedSecret)
  if (verdict === 'not_configured') {
    console.error('[telegram-ingress] TELEGRAM_WEBHOOK_SECRET not set — refusing')
    return c.json({ error: 'not_configured' }, 503)
  }
  if (verdict === 'invalid') {
    return c.json({ error: 'Unauthorized secret token' }, 401)
  }

  let update: TelegramUpdate
  try {
    update = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // IDENTITY. Runs BEFORE any parsing decision that could cause a side effect.
  // A mention is a routing hint, never a credential — an attacker in a group can
  // @mention the bot too, so this is not conditional on chat type.
  //
  // Resolves WHO is calling, so dispatch can carry the CALLER's authority rather
  // than the bot's. An unresolvable identity is refused with no side effect —
  // identical fail-closed behaviour to the allowlist it replaces, but now keyed on
  // a deliberate, revocable, audited binding instead of an env var.
  const fromId = (update.message || update.edited_message || update.channel_post)?.from?.id
  const identity = await resolveChannelIdentity(c.env, 'telegram', fromId)
  if (!mayDispatch(identity)) {
    // 503 for an infrastructure failure, 403 for a genuine refusal. Collapsing
    // these would make a database outage indistinguishable from a stranger — and
    // an outage that reads as normal operation is one nobody investigates.
    const status = identity.kind === 'unavailable' ? 503 : 403
    console.warn('[telegram-ingress] refused', refusalCode(identity), 'caller', fromId ?? '<none>')
    return c.json({ error: refusalCode(identity) }, status)
  }

  const botUsername = c.env.TELEGRAM_BOT_USERNAME || DEFAULT_BOT_USERNAME
  const result = parseTelegramIngress(update, botUsername, true)

  if (result.action === 'empty_payload') {
    return c.json({ ok: true, status: 'ignored_empty' }, 200)
  }

  if (result.action === 'ignored_group_unmentioned') {
    return c.json({ ok: true, status: 'ignored_unmentioned' }, 200)
  }

  // Publish BusEvent to Mupot DO Bus (env.BUS via createBus)
  // Fail-Safe: If bus emit throws an error, return 500 error status to caller.
  try {
    const bus = createBus(c.env)
    const event: BusEvent = {
      type: 'agent.wake',
      tenant: c.env.TENANT_SLUG || 'mumega',
      // The resolved MEMBER is the actor — not the bot, and not a display name.
      // This is what makes the dispatch carry the caller's authority: downstream
      // authorisation reads a real member id and applies that member's grants.
      actor: { kind: 'member', id: identity.memberId },
      payload: {
        source: 'telegram',
        chat_id: result.chatId,
        sender: result.sender,
        text: (result.text ?? '').slice(0, MAX_TEXT_CHARS),
        message_id: result.messageId
      },
      ts: new Date().toISOString()
    }
    await bus.emit(event)
  } catch (err) {
    console.error('[telegram-ingress] Bus emit failed:', err)
    return c.json({ error: 'Bus emit failed', details: String(err) }, 500)
  }

  return c.json({
    ok: true,
    status: 'dispatched',
    chat_id: result.chatId,
    sender: result.sender,
    // Capped here too. The bus payload was already capped; echoing the raw text
    // in the response reintroduced the unbounded value on a different surface.
    text: (result.text ?? '').slice(0, MAX_TEXT_CHARS),
    message_id: result.messageId
  }, 200)
})
