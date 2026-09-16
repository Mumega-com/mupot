import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTelegramBotUsername, telegramAdapter } from '../src/channels/adapters/telegram'
import type { Env } from '../src/types'

function req(secret?: string): Request {
  const headers: Record<string, string> = {}
  if (secret !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = secret
  return new Request('https://pot.example/im/webhook', { method: 'POST', headers })
}

describe('telegramAdapter.verify', () => {
  it('fails closed when IM_WEBHOOK_SECRET is not configured', async () => {
    await expect(telegramAdapter.verify(req('secret'), {} as Env)).resolves.toBe(false)
  })

  it('accepts the configured Telegram webhook secret', async () => {
    const env = { IM_WEBHOOK_SECRET: 'local-im-secret' } as Env
    await expect(telegramAdapter.verify(req('local-im-secret'), env)).resolves.toBe(true)
  })

  it('rejects missing or wrong Telegram webhook secrets', async () => {
    const env = { IM_WEBHOOK_SECRET: 'local-im-secret' } as Env
    await expect(telegramAdapter.verify(req(), env)).resolves.toBe(false)
    await expect(telegramAdapter.verify(req('wrong-secret'), env)).resolves.toBe(false)
  })
})

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

// mupot#1412: the dashboard's Connect Telegram page needs the bot's own
// @username to build a t.me deep link. TELEGRAM_BOT_USERNAME was deliberately
// removed as an Env key (src/types.ts), so this is derived live via getMe —
// display only, never an authorization input.
describe('getTelegramBotUsername', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns null when TELEGRAM_BOT_TOKEN is not configured — never calls the Bot API', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const env = { SESSIONS: kv() } as unknown as Env
    await expect(getTelegramBotUsername(env)).resolves.toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('calls getMe and returns the username on success, then caches it (second call does not re-fetch)', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { username: 'MupotBot' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const env = { TELEGRAM_BOT_TOKEN: 'tok-1', SESSIONS: kv() } as unknown as Env

    await expect(getTelegramBotUsername(env)).resolves.toBe('MupotBot')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/bottok-1/getMe')

    await expect(getTelegramBotUsername(env)).resolves.toBe('MupotBot')
    expect(fetchSpy).toHaveBeenCalledTimes(1) // cached — no second Bot API call
  })

  it('returns null (and never caches) when the Bot API call fails', async () => {
    const fetchSpy = vi.fn(async () => new Response('bad', { status: 401 }))
    vi.stubGlobal('fetch', fetchSpy)
    const env = { TELEGRAM_BOT_TOKEN: 'tok-2', SESSIONS: kv() } as unknown as Env

    await expect(getTelegramBotUsername(env)).resolves.toBeNull()
    await expect(getTelegramBotUsername(env)).resolves.toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(2) // no cache write on failure — retried both times
  })

  it('returns null when the response carries no username, and never throws on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })))
    const env1 = { TELEGRAM_BOT_TOKEN: 'tok-3', SESSIONS: kv() } as unknown as Env
    await expect(getTelegramBotUsername(env1)).resolves.toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const env2 = { TELEGRAM_BOT_TOKEN: 'tok-4', SESSIONS: kv() } as unknown as Env
    await expect(getTelegramBotUsername(env2)).resolves.toBeNull()
  })
})
