// mupot — POST /im/approve/webhook: Telegram's update feed for the approval bot.
//
// Fail closed: bot off = 404 (the route does not exist), misconfigured = 503, a missing or wrong
// X-Telegram-Bot-Api-Secret-Token = 401 before the body is read or parsed. After the secret, EVERY outcome is a 200 (Telegram
// retries non-200s; a refusal is told to the human in the chat, never to the caller of this route).
import { Hono } from 'hono'
import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'
import { approvalBotStatus } from './config'
import { handleApprovalBotUpdate } from './decide'

export const APPROVAL_WEBHOOK_MAX_BODY_BYTES = 64 * 1024

export const approvalBotApp = new Hono<{ Bindings: Env }>()

approvalBotApp.post('/webhook', async (c) => {
  const bot = approvalBotStatus(c.env)
  if (bot.state === 'off') return c.json({ error: 'not_found' }, 404)
  if (bot.state === 'misconfigured') return c.json({ error: 'approval_bot_not_configured' }, 503)
  const provided = c.req.header('X-Telegram-Bot-Api-Secret-Token')
  // Constant-time compare against the configured secret; the secret is read from env, never echoed.
  if (!provided || !timingSafeEqual(provided, (c.env.APPROVAL_BOT_WEBHOOK_SECRET ?? '').trim())) return c.json({ error: 'unauthorized' }, 401)
  const declared = c.req.header('content-length')
  if (declared && Number(declared) > APPROVAL_WEBHOOK_MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413)
  const raw = await c.req.text()
  if (raw.length > APPROVAL_WEBHOOK_MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413)
  let update: unknown
  try {
    update = JSON.parse(raw)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  try {
    const result = await handleApprovalBotUpdate(c.env, update, { waitUntil: (p) => { try { c.executionCtx.waitUntil(p) } catch { /* no execution context (tests) */ } } })
    return c.json({ ok: true, result: result.kind })
  } catch {
    return c.json({ ok: true, result: 'error' })
  }
})

approvalBotApp.all('*', (c) => c.json({ error: 'not_found' }, 404))
