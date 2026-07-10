import { describe, expect, it } from 'vitest'
import { telegramAdapter } from '../src/channels/adapters/telegram'
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
