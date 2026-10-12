// mupot — the WORKER sends the Mini App button itself, from the DEDICATED Mini App bot (secure moments W4).
//
// WHY THE WORKER: BiometricManager tokens are per BOT and initData carries no URL, so any page the bot can launch
// collects both factors. The bot must therefore be one only the worker drives, and no other process may ever hold a
// launch URL or enrolment token. The token below is used ONLY here (sendMessage); it never validates initData.
//
// The button is a web_app inline-keyboard button (Telegram allows it in a PRIVATE chat only) pointing at the secure
// host. The message text is fixed English written here (never agent text), protect_content keeps it from being
// forwarded. The token is never logged, echoed or placed in an error.
import type { Env } from '../types'
import { miniappBotToken, telegramMiniappStatus } from './telegram-miniapp-config'

const API = 'https://api.telegram.org'
const SEND_TIMEOUT_MS = 8000

export type SendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; error: 'not_enabled' | 'send_failed' | 'chat_unreachable' }

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

/** sendMessage with one web_app button to a member's own private chat. `chatId` is the bound private chat id (== the user id). */
export async function sendMiniappButton(
  env: Env,
  input: { chatId: string; path: string; buttonText: string; text: string },
  fetchFn: FetchFn = (u, i) => fetch(u, i),
): Promise<SendResult> {
  const status = telegramMiniappStatus(env)
  const token = miniappBotToken(env)
  if (status.state !== 'on' || !token) return { ok: false, error: 'not_enabled' }
  // A private chat id is a positive integer (group ids are negative): never send a button anywhere else.
  if (!/^[1-9][0-9]{0,15}$/.test(input.chatId)) return { ok: false, error: 'chat_unreachable' }
  const url = `https://${status.host}${input.path}`
  let res: Response
  try {
    res = await fetchFn(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        protect_content: true,
        reply_markup: { inline_keyboard: [[{ text: input.buttonText, web_app: { url } }]] },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: 'send_failed' }
  }
  if (!res.ok) return { ok: false, error: res.status === 403 || res.status === 400 ? 'chat_unreachable' : 'send_failed' }
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'ok' in body && body.ok !== true) return { ok: false, error: 'send_failed' }
    const mid = typeof body === 'object' && body !== null && 'result' in body && typeof body.result === 'object' && body.result !== null && 'message_id' in body.result
      ? body.result.message_id : null
    return { ok: true, messageId: typeof mid === 'number' ? String(mid) : null }
  } catch {
    return { ok: true, messageId: null }
  }
}
