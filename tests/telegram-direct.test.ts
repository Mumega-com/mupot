// Direct-to-Telegram delivery path (the primary one).
//
// The path this replaces failed silently for its entire life: it signed a payload
// correctly and POSTed it to a hostname serving a different Worker. So these tests
// assert the things that would have caught that — which path was chosen, and that an
// unconfigured bridge makes NO network call rather than a doomed one.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { notifyHadi, formatTelegram, TELEGRAM_MAX_CHARS } from '../src/telegram-bridge/bus_notify'
import type { Env } from '../src/types'

function stubEnv(over: Record<string, unknown> = {}): Env {
  return {
    TELEGRAM_BOT_TOKEN: 'bot-token-abc',
    TELEGRAM_CHAT_ID: '765204057',
    ...over,
  } as unknown as Env
}

const NOTE = { type: 'task.review', task_id: 't-1', title: 'Ship it' }

function okResponse() {
  return { ok: true, status: 200, text: async () => '{"ok":true}' } as unknown as Response
}
function errResponse(status: number, body: string) {
  return { ok: false, status, text: async () => body } as unknown as Response
}

afterEach(() => vi.unstubAllGlobals())

describe('notifyHadi — direct Telegram delivery', () => {
  it('POSTs to the Telegram Bot API with the configured chat id', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await notifyHadi(stubEnv(), NOTE)

    expect(result).toEqual({ delivered: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/botbot-token-abc/sendMessage')
    const body = JSON.parse(init.body as string)
    expect(body.chat_id).toBe('765204057')
    expect(body.text).toContain('Ship it')
  })

  it('prefers the direct path over the webhook when BOTH are configured', async () => {
    // The regression that matters: a misconfigured direct path must not silently
    // fall back to the webhook, because that is how the dead path stayed invisible.
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    await notifyHadi(
      stubEnv({ TELEGRAM_BRIDGE_URL: 'https://webhook.test/events', HERMES_WEBHOOK_SECRET: 's' }),
      NOTE,
    )

    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('api.telegram.org')
    expect(url).not.toContain('webhook.test')
  })

  it('retries as PLAIN TEXT when Telegram rejects the markdown', async () => {
    // Task titles are agent-authored and routinely contain _ * [ — a 400 here must not
    // lose the notification.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(400, "Bad Request: can't parse entities"))
      .mockResolvedValueOnce(okResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await notifyHadi(stubEnv(), { ...NOTE, title: 'weird_title *bold' })

    expect(result).toEqual({ delivered: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).parse_mode).toBe('Markdown')
    expect(JSON.parse((fetchMock.mock.calls[1] as any)[1].body).parse_mode).toBeUndefined()
  })

  it('does NOT retry on 401 — a dead token will not improve on attempt two', async () => {
    const fetchMock = vi.fn(async () => errResponse(401, 'Unauthorized'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await notifyHadi(stubEnv(), NOTE)

    expect(result).toEqual({ delivered: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('makes NO network call when nothing is configured', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await notifyHadi(
      stubEnv({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }),
      NOTE,
    )

    expect(result).toEqual({ delivered: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not engage the webhook path on a HALF-configured webhook', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await notifyHadi(
      stubEnv({
        TELEGRAM_BOT_TOKEN: undefined,
        TELEGRAM_CHAT_ID: undefined,
        TELEGRAM_BRIDGE_URL: 'https://webhook.test/events',
        // HERMES_WEBHOOK_SECRET deliberately absent
      }),
      NOTE,
    )

    expect(result).toEqual({ delivered: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never puts the bot token in a thrown/logged error', async () => {
    const errs: string[] = []
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.join(' ')) })

    await notifyHadi(stubEnv(), NOTE)

    expect(errs.join(' ')).not.toContain('bot-token-abc')
    spy.mockRestore()
  })
})

describe('formatTelegram', () => {
  it('truncates past the Telegram cap instead of producing a 400', async () => {
    const text = formatTelegram({ type: 'task.review', message: 'x'.repeat(9000) })
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS)
    expect(text).toContain('(truncated)')
  })

  it('keeps a short message intact', () => {
    const text = formatTelegram({ type: 'task.blocked', title: 'Needs input' })
    expect(text).toContain('Needs input')
    expect(text).not.toContain('(truncated)')
  })
})
