// Native Telegram Webhook Ingress Subsystem for Mupot
// Edge-native Cloudflare workerd Hono router mounted at /api/integrations/telegram

import { Hono } from 'hono'
import type { Env, BusEvent } from '../types'
import { createBus } from '../bus'
import type { TelegramUpdate, TelegramIngressResult } from './types'

export const SECRET_HEADER_NAME = 'x-telegram-bot-api-secret-token'
export const DEFAULT_BOT_USERNAME = 'River_mumega_bot'

/**
 * Validate incoming Telegram secret token header against expected secret token.
 */
export function validateSecretToken(headerValue: string | null, expectedSecret?: string): boolean {
  if (!expectedSecret) return true // Dev mode fallback
  return headerValue === expectedSecret
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

  if (!validateSecretToken(secretHeader, expectedSecret)) {
    return c.json({ error: 'Unauthorized secret token' }, 401)
  }

  let update: TelegramUpdate
  try {
    update = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
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
      actor: { kind: 'member', id: `telegram:${result.sender}` },
      payload: {
        source: 'telegram',
        chat_id: result.chatId,
        sender: result.sender,
        text: result.text,
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
    text: result.text,
    message_id: result.messageId
  }, 200)
})
