// mupot — Bot API calls of the approval bot. The token is read from the status object, used only to build the URL, and never
// logged, echoed or placed in an error. Every call is bounded and returns a result instead of throwing.
import type { ApprovalBotStatus } from './config'

const API = 'https://api.telegram.org'
const TIMEOUT_MS = 8000

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>
export type BotSend = { ok: true; messageId: string | null } | { ok: false; error: 'send_failed' | 'chat_unreachable' }
type OnStatus = Extract<ApprovalBotStatus, { state: 'on' }>

export interface InlineButton { text: string; callback_data: string }

async function call(bot: OnStatus, method: string, body: Record<string, unknown>, fetchFn: FetchFn): Promise<BotSend> {
  let res: Response
  try {
    res = await fetchFn(`${API}/bot${bot.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: 'send_failed' }
  }
  if (!res.ok) return { ok: false, error: res.status === 403 || res.status === 400 ? 'chat_unreachable' : 'send_failed' }
  // A 2xx is not delivery: Telegram answers {ok:true,result:{message_id}}. Anything else (a proxy's HTML page, an empty body, ok:false) is NOT sent.
  try {
    const parsed: unknown = await res.json()
    if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed) || parsed.ok !== true) return { ok: false, error: 'send_failed' }
    const mid = 'result' in parsed && typeof parsed.result === 'object' && parsed.result !== null && 'message_id' in parsed.result ? parsed.result.message_id : null
    return { ok: true, messageId: typeof mid === 'number' ? String(mid) : null }
  } catch {
    return { ok: false, error: 'send_failed' }
  }
}

/** Plain text only (no parse_mode), so nothing an agent wrote can render as markup. A private chat id is a positive integer. */
export function sendBotMessage(
  bot: OnStatus, input: { chatId: string; text: string; buttons?: InlineButton[] }, fetchFn: FetchFn = (u, i) => fetch(u, i),
): Promise<BotSend> {
  if (!/^[1-9][0-9]{0,15}$/.test(input.chatId)) return Promise.resolve({ ok: false, error: 'chat_unreachable' })
  return call(bot, 'sendMessage', {
    chat_id: input.chatId,
    text: input.text.slice(0, 3500),
    protect_content: true,
    disable_web_page_preview: true,
    ...(input.buttons && input.buttons.length > 0 ? { reply_markup: { inline_keyboard: [input.buttons] } } : {}),
  }, fetchFn)
}

/** Replace the text of a message the bot sent and drop its buttons (a decided request offers nothing to tap). */
export function editBotMessage(
  bot: OnStatus, input: { chatId: string; messageId: string; text: string }, fetchFn: FetchFn = (u, i) => fetch(u, i),
): Promise<BotSend> {
  if (!/^[1-9][0-9]{0,15}$/.test(input.chatId) || !/^[1-9][0-9]{0,15}$/.test(input.messageId)) return Promise.resolve({ ok: false, error: 'chat_unreachable' })
  return call(bot, 'editMessageText', {
    chat_id: input.chatId, message_id: Number(input.messageId), text: input.text.slice(0, 3500),
    disable_web_page_preview: true, reply_markup: { inline_keyboard: [] },
  }, fetchFn)
}

export function answerCallback(
  bot: OnStatus, input: { callbackQueryId: string; text: string }, fetchFn: FetchFn = (u, i) => fetch(u, i),
): Promise<BotSend> {
  return call(bot, 'answerCallbackQuery', { callback_query_id: input.callbackQueryId, text: input.text.slice(0, 190) }, fetchFn)
}
