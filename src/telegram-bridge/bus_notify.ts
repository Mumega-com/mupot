// mupot → Telegram notification bridge via Hermes webhook.
//
// Called from the bus consumer (routeEvent) for task.* events that need
// Hadi's attention. POSTs to Hermes webhook with an HMAC-signed payload.
// Hermes deliver_only route delivers directly to Hadi's Telegram DM.
//
// Wire into src/bus/consumer.ts:
//   import { notifyHadi } from '../telegram-bridge/bus_notify'
//   case 'task.review': case 'task.blocked':
//     await notifyHadi(env, { type: event.type, task_id, ... })
//     return true

import type { Env } from '../types'

const DEFAULT_WEBHOOK_URL = 'https://hermes.mumega.com/webhooks/mupot-events'
export const FETCH_TIMEOUT_MS = 10_000

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
 * Exported so the test module can call it with a mock crypto.subtle.
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

function formatTelegram(n: TaskNotification): string {
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
  return lines.join('\n')
}

export async function notifyHadi(
  env: Env,
  notification: TaskNotification,
): Promise<{ delivered: boolean }> {
  const webhookUrl = env.TELEGRAM_BRIDGE_URL || DEFAULT_WEBHOOK_URL
  const secret = env.HERMES_WEBHOOK_SECRET
  if (!secret) {
    console.error('telegram-bridge: HERMES_WEBHOOK_SECRET not set')
    return { delivered: false }
  }

  const notificationText = formatTelegram(notification)
  const body = JSON.stringify({
    type: 'task_event',
    notification: { ...notification, text: notificationText },
  })

  // V1 signature: HMAC-SHA256 of raw body, hex-encoded
  const signature = await hmacSign(secret, body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature },
      body,
      signal: controller.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      console.error('telegram-bridge: webhook returned', resp.status, text.slice(0, 200))
      return { delivered: false }
    }
    console.log('telegram-bridge: delivered', notification.type, notification.task_id)
    return { delivered: true }
  } catch (err) {
    console.error('telegram-bridge: fetch failed', err)
    return { delivered: false }
  } finally {
    clearTimeout(timer)
  }
}
