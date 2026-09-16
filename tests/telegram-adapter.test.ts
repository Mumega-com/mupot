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

  // kasra-review AMBER P2 (2026-09-16): the cache key folds in a fingerprint
  // of the CURRENT token, so rotating TELEGRAM_BOT_TOKEN can never keep
  // serving a prior bot's cached username.
  it('rotating TELEGRAM_BOT_TOKEN invalidates the cache — a new getMe call is made and the new bot wins, without evicting the old entry', async () => {
    const sessions = kv()
    const fetchOld = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { username: 'OldBot123' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchOld)
    const envOld = { TELEGRAM_BOT_TOKEN: 'token-old', SESSIONS: sessions } as unknown as Env
    await expect(getTelegramBotUsername(envOld)).resolves.toBe('OldBot123')
    expect(fetchOld).toHaveBeenCalledTimes(1)

    const fetchNew = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { username: 'NewBot456' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchNew)
    const envNew = { TELEGRAM_BOT_TOKEN: 'token-new', SESSIONS: sessions } as unknown as Env
    await expect(getTelegramBotUsername(envNew)).resolves.toBe('NewBot456')
    expect(fetchNew).toHaveBeenCalledTimes(1) // a real Bot API call — not served from the old token's cache entry

    // Rotating BACK to the old token still finds ITS OWN cached entry —
    // proves this is per-token keying, not a blanket cache bust.
    const fetchOldAgain = vi.fn()
    vi.stubGlobal('fetch', fetchOldAgain)
    await expect(getTelegramBotUsername(envOld)).resolves.toBe('OldBot123')
    expect(fetchOldAgain).not.toHaveBeenCalled()
  })

  // kasra-review AMBER Low (2026-09-16): validate the shape of whatever the
  // Bot API returns before trusting it for a deep link.
  it('treats a malformed username in the getMe response as absent — no link, no cache write', async () => {
    for (const badUsername of ['ab', 'bad name', 'bad-name', 'x'.repeat(33), '']) {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { username: badUsername } }), { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)
      const env = { TELEGRAM_BOT_TOKEN: `tok-bad-${badUsername.length}`, SESSIONS: kv() } as unknown as Env
      await expect(getTelegramBotUsername(env)).resolves.toBeNull()
      // Not cached — a second call re-fetches rather than serving a poisoned null forever.
      await expect(getTelegramBotUsername(env)).resolves.toBeNull()
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    }
  })

  it('accepts a well-formed username at both length boundaries (5 and 32 chars)', async () => {
    for (const goodUsername of ['abc12', 'a'.repeat(32), 'my_bot_99']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { username: goodUsername } }), { status: 200 })))
      const env = { TELEGRAM_BOT_TOKEN: `tok-good-${goodUsername}`, SESSIONS: kv() } as unknown as Env
      await expect(getTelegramBotUsername(env)).resolves.toBe(goodUsername)
    }
  })
})
