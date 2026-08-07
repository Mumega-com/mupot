// mupot → Telegram notification bridge.
//
// Called from the bus consumer (routeEvent) for task.* events that need Hadi's
// attention — see src/bus/consumer.ts.
//
// DELIVERY: direct to the Telegram Bot API. The original design POSTed an
// HMAC-signed payload to a Hermes webhook, which then delivered to Telegram.
// That path was dead end-to-end and could not have worked:
//
//   - `hermes.mumega.com` is the `inkwell-api` Worker, not a Hermes gateway
//     (GET /health → {"service":"inkwell-api"}); /webhooks/mupot-events was 404.
//   - The Hermes gateway that DOES hold a correct `mupot-events` subscription
//     binds loopback only, so nothing on the public internet can reach it.
//
// Setting the missing secret would have made us sign a payload perfectly and POST
// it into a 404 — while `resp.ok` logic reported a clean failure nobody watched.
// Telegram is reachable from a Worker directly, so the gateway hop bought nothing
// and cost three failure modes (shared secret, public hostname, inbound path).
//
// The webhook path is KEPT but is now explicit opt-in: it engages only when BOTH
// TELEGRAM_BRIDGE_URL and HERMES_WEBHOOK_SECRET are set. It is never a silent
// fallback — a fallback that fires on misconfiguration is how the original
// failure stayed invisible.

import type { Env } from '../types'

const TELEGRAM_API = 'https://api.telegram.org'
export const FETCH_TIMEOUT_MS = 10_000
/** Telegram hard-caps message text at 4096 chars; truncate visibly rather than 400. */
export const TELEGRAM_MAX_CHARS = 4000

export interface TaskNotification {
  type: string
  task_id?: string
  title?: string
  squad_id?: string
  agent_id?: string
  project_id?: string
  message?: string
}

/**
 * Return the HMAC-SHA256 hex signature for *body* using *secret*.
 * Retained for the opt-in webhook path and exported for tests.
 */
export async function hmacSign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function formatTelegram(n: TaskNotification): string {
  const icons: Record<string, string> = {
    'task.review': '🔍',
    'task.blocked': '🚧',
    'task.verdict': '⚖️',
    'task.created': '📋',
    'task.completed': '✅',
  }
  const icon = icons[n.type] || '📌'
  const label = n.type.replace('task.', '')

  const lines: string[] = [`${icon} *Task ${label}*`]
  if (n.title) lines.push(`${n.title}`)
  if (n.task_id) lines.push('`' + n.task_id + '`')
  if (n.agent_id) lines.push('👤 agent: `' + n.agent_id + '`')
  if (n.squad_id) lines.push('🏠 squad: `' + n.squad_id + '`')
  if (n.project_id) lines.push('📁 project: `' + n.project_id + '`')
  if (n.message) lines.push(n.message)
  if (n.type === 'task.review') lines.push('', '_Waiting for your verdict._')
  if (n.type === 'task.blocked') lines.push('', '_May need your input._')

  const text = lines.join('\n')
  return text.length > TELEGRAM_MAX_CHARS
    ? text.slice(0, TELEGRAM_MAX_CHARS - 20) + '\n…(truncated)'
    : text
}

async function postJson(url: string, body: string, headers: Record<string, string>) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Send straight to the Telegram Bot API.
 *
 * Task titles are user/agent-authored and routinely contain `_`, `*` and `[`, which
 * Telegram's Markdown parser rejects with a 400 ("can't parse entities"). Rather than
 * escape — which silently mangles the text and is easy to get subtly wrong — we retry
 * once as PLAIN TEXT. A notification that arrives unformatted beats one that vanishes.
 */
async function sendDirect(
  token: string,
  chatId: string,
  text: string,
  type: string,
  taskId?: string,
): Promise<{ delivered: boolean }> {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`
  const base = { chat_id: chatId, disable_web_page_preview: true }

  for (const attempt of [{ ...base, text, parse_mode: 'Markdown' }, { ...base, text }]) {
    let resp: Response
    try {
      resp = await postJson(url, JSON.stringify(attempt), { 'Content-Type': 'application/json' })
    } catch (err) {
      // Never interpolate the token into a log line — the URL contains it.
      console.error('telegram-bridge: send failed', String(err).slice(0, 200))
      return { delivered: false }
    }
    if (resp.ok) {
      console.log('telegram-bridge: delivered', type, taskId ?? '')
      return { delivered: true }
    }
    const detail = await resp.text().catch(() => '')
    // Only a parse failure is worth retrying; 401/403/429 will not improve on attempt 2.
    if (resp.status === 400 && detail.includes('parse')) {
      console.warn('telegram-bridge: markdown rejected, retrying as plain text')
      continue
    }
    console.error('telegram-bridge: telegram returned', resp.status, detail.slice(0, 200))
    return { delivered: false }
  }
  console.error('telegram-bridge: plain-text retry also failed')
  return { delivered: false }
}

export async function notifyHadi(
  env: Env,
  notification: TaskNotification,
): Promise<{ delivered: boolean }> {
  const text = formatTelegram(notification)

  // Primary: direct to Telegram.
  const token = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_CHAT_ID
  if (token && chatId) {
    return sendDirect(token, chatId, text, notification.type, notification.task_id)
  }

  // Opt-in legacy: Hermes webhook. Requires BOTH values — never a silent fallback.
  const webhookUrl = env.TELEGRAM_BRIDGE_URL
  const secret = env.HERMES_WEBHOOK_SECRET
  if (webhookUrl && secret) {
    const body = JSON.stringify({
      type: 'task_event',
      notification: { ...notification, text },
    })
    const signature = await hmacSign(secret, body)
    try {
      const resp = await postJson(webhookUrl, body, {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      })
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '')
        console.error('telegram-bridge: webhook returned', resp.status, detail.slice(0, 200))
        return { delivered: false }
      }
      console.log('telegram-bridge: delivered via webhook', notification.type, notification.task_id)
      return { delivered: true }
    } catch (err) {
      console.error('telegram-bridge: webhook fetch failed', String(err).slice(0, 200))
      return { delivered: false }
    }
  }

  // Fail closed, and say which knob is missing — "not configured" without a name is
  // what kept this broken.
  console.error(
    'telegram-bridge: no delivery path configured ' +
      `(TELEGRAM_BOT_TOKEN=${token ? 'set' : 'unset'}, TELEGRAM_CHAT_ID=${chatId ? 'set' : 'unset'})`,
  )
  return { delivered: false }
}
