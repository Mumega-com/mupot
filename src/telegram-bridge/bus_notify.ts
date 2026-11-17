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
import { safeConsole } from '../lib/log'

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

/**
 * Owner notifications are sent with parse_mode HTML. Caller-supplied text (titles, messages, ids, type) is data,
 * never markup: it is run through this complete escaper before it joins the template, so it can only ever be text.
 * Fixed markup (<b>, <i>, <code>) comes from constants in formatTelegram and nowhere else. No attributes and no links
 * are ever emitted, so `"` needs no special handling inside tags; it is escaped anyway.
 */
export function escapeTelegramHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
  return s.replace(/[&<>"]/g, (c) => map[c] ?? c)
}

/** The same message with the fixed tags dropped and entities decoded: what the plain-text retry and the webhook send. */
export function telegramHtmlToPlain(html: string): string {
  return html
    .replace(/<\/?(?:b|i|code)>/g, '')
    .replace(/&(lt|gt|quot|amp);/g, (_m, e: string) => ({ lt: '<', gt: '>', quot: '"', amp: '&' })[e] ?? _m)
}

const KNOWN_LABELS: ReadonlySet<string> = new Set(['review', 'blocked', 'verdict', 'created', 'completed', 'failed', 'skipped'])

function clip(v: string | undefined, max: number): string | undefined {
  if (v === undefined || v.length <= max) return v
  const cut = v.slice(0, max)
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut // never leave half a surrogate pair
}

function buildHtml(n: TaskNotification, fieldMax: number): string {
  const icons: Record<string, string> = {
    'task.review': '🔍',
    'task.blocked': '🚧',
    'task.verdict': '⚖️',
    'task.created': '📋',
    'task.completed': '✅',
  }
  const isBackup = n.type.startsWith('backup.')
  const icon = isBackup ? '⚠️' : icons[n.type] || '📌'
  const label = n.type.replace('task.', '').replace('backup.', '')
  const e = (v: string): string => escapeTelegramHtml(clip(v, fieldMax) ?? '')

  // <b> holds only constants: a known label is bolded with the noun; anything else follows the bold noun as escaped text.
  const noun = isBackup ? 'Backup' : 'Task'
  const header = KNOWN_LABELS.has(label) ? `<b>${noun} ${label}</b>` : `<b>${noun}</b> ${e(label)}`
  const lines: string[] = [`${icon} ${header}`]
  if (n.title) lines.push(e(n.title))
  if (n.task_id) lines.push(`<code>${e(n.task_id)}</code>`)
  if (n.agent_id) lines.push(`👤 agent: <code>${e(n.agent_id)}</code>`)
  if (n.squad_id) lines.push(`🏠 squad: <code>${e(n.squad_id)}</code>`)
  if (n.project_id) lines.push(`📁 project: <code>${e(n.project_id)}</code>`)
  if (n.message) lines.push(e(n.message))
  if (n.type === 'task.review') lines.push('', '<i>Waiting for your verdict.</i>')
  if (n.type === 'task.blocked') lines.push('', '<i>May need your input.</i>')
  return lines.join('\n')
}

/**
 * HTML for Telegram (parse_mode HTML). Over the length cap, every caller field is clipped (halving) BEFORE escaping so
 * a tag or entity is never cut in half; the notice is appended after.
 */
export function formatTelegram(n: TaskNotification): string {
  let text = buildHtml(n, Number.POSITIVE_INFINITY)
  if (text.length <= TELEGRAM_MAX_CHARS) return text
  let max = 2000
  do {
    text = buildHtml(n, max) + '\n…(truncated)'
    max = Math.floor(max / 2)
  } while (text.length > TELEGRAM_MAX_CHARS && max > 0)
  return text
}

/**
 * Strip a bot token from any string before it reaches a log.
 *
 * The token is in the request URL, so a real fetch failure can embed it in the
 * error message — "failed to fetch https://api.telegram.org/bot<TOKEN>/sendMessage".
 * Never interpolating it ourselves is not sufficient; the runtime does it for us.
 * Flagged by Athena's gate on #767.
 */
export function redactBotToken(s: string): string {
  return s.replace(/bot\d{6,}:[A-Za-z0-9_-]+/g, 'bot<REDACTED>')
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
 * Caller text is HTML-escaped in formatTelegram, so a parse failure should not happen. If Telegram still rejects it
 * (400 "can't parse entities"), we retry once as PLAIN TEXT (tags dropped, entities decoded): a notification that
 * arrives unformatted beats one that vanishes.
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

  for (const attempt of [{ ...base, text, parse_mode: 'HTML' }, { ...base, text: telegramHtmlToPlain(text) }]) {
    let resp: Response
    try {
      resp = await postJson(url, JSON.stringify(attempt), { 'Content-Type': 'application/json' })
    } catch (err) {
      // Never interpolate the token into a log line — the URL contains it.
      safeConsole.error('telegram-bridge: send failed', redactBotToken(String(err)).slice(0, 200))
      return { delivered: false }
    }
    if (resp.ok) {
      safeConsole.log('telegram-bridge: delivered', type, taskId ?? '')
      return { delivered: true }
    }
    const detail = await resp.text().catch(() => '')
    // Only a parse failure is worth retrying; 401/403/429 will not improve on attempt 2.
    if (resp.status === 400 && detail.includes('parse')) {
      safeConsole.warn('telegram-bridge: html rejected, retrying as plain text')
      continue
    }
    safeConsole.error('telegram-bridge: telegram returned', resp.status, detail.slice(0, 200))
    return { delivered: false }
  }
  safeConsole.error('telegram-bridge: plain-text retry also failed')
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
      notification: { ...notification, text: telegramHtmlToPlain(text) },
    })
    const signature = await hmacSign(secret, body)
    try {
      const resp = await postJson(webhookUrl, body, {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
      })
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '')
        safeConsole.error('telegram-bridge: webhook returned', resp.status, detail.slice(0, 200))
        return { delivered: false }
      }
      safeConsole.log('telegram-bridge: delivered via webhook', notification.type, notification.task_id)
      return { delivered: true }
    } catch (err) {
      safeConsole.error('telegram-bridge: webhook fetch failed', redactBotToken(String(err)).slice(0, 200))
      return { delivered: false }
    }
  }

  // Fail closed, and say which knob is missing — "not configured" without a name is
  // what kept this broken.
  safeConsole.error(
    'telegram-bridge: no delivery path configured ' +
      `(TELEGRAM_BOT_TOKEN=${token ? 'set' : 'unset'}, TELEGRAM_CHAT_ID=${chatId ? 'set' : 'unset'})`,
  )
  return { delivered: false }
}
