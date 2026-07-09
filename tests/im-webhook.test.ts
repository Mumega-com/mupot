import { describe, expect, it } from 'vitest'
import { IM_WEBHOOK_MAX_BODY_BYTES, imApp } from '../src/im'
import type { Env } from '../src/types'

function env(secret = 'local-im-secret'): Env {
  return { TENANT_SLUG: 'local', IM_WEBHOOK_SECRET: secret } as Env
}

function post(body: string, opts: { secret?: string; contentLength?: string; env?: Env } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (opts.secret !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = opts.secret
  if (opts.contentLength !== undefined) headers['content-length'] = opts.contentLength
  return imApp.fetch(
    new Request('https://pot.example/webhook', {
      method: 'POST',
      headers,
      body,
    }),
    opts.env ?? env(),
  )
}

describe('imApp POST /webhook body cap and auth', () => {
  it('rejects oversized declared Content-Length before auth', async () => {
    const res = await post('{}', {
      contentLength: String(IM_WEBHOOK_MAX_BODY_BYTES + 1),
      env: { TENANT_SLUG: 'local' } as Env,
    })
    const body = await res.json() as { error: string }

    expect(res.status).toBe(413)
    expect(body.error).toBe('payload_too_large')
  })

  it('rejects oversized actual body before JSON parsing', async () => {
    const res = await post('x'.repeat(IM_WEBHOOK_MAX_BODY_BYTES + 1), {
      secret: 'local-im-secret',
    })
    const body = await res.json() as { error: string }

    expect(res.status).toBe(413)
    expect(body.error).toBe('payload_too_large')
  })

  it('keeps bad small secrets unauthorized', async () => {
    const res = await post('{}', { secret: 'wrong-secret' })
    const body = await res.json() as { error: string }

    expect(res.status).toBe(401)
    expect(body.error).toBe('unauthorized')
  })

  it('rejects invalid JSON after a valid small authenticated body', async () => {
    const res = await post('{not-json}', { secret: 'local-im-secret' })
    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toBe('invalid_json')
  })

  it('accepts a small authenticated JSON envelope and validates chat id', async () => {
    const res = await post('{}', { secret: 'local-im-secret' })
    const body = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(body.error).toBe('no_chat_id')
  })
})
