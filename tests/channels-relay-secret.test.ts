import { describe, expect, it } from 'vitest'
import { channelsApp } from '../src/channels/index'
import type { Env } from '../src/types'

// mupot#982 — POST /channels/relay compared X-Relay-Secret with `!==`, an ordinary
// early-exit string compare. It must go through the shared constant-time comparator.

const SECRET = 'relay-secret-0123456789'
const env = { HERMES_RELAY_SECRET: SECRET } as unknown as Env // only the one binding the auth step reads

const post = (secret: string | null, body = '{}'): Promise<Response> =>
  Promise.resolve(
    channelsApp.fetch(
      new Request('https://pot.example/relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-relay-secret': secret }) },
        body,
      }),
      env,
    ),
  )

describe('POST /relay secret check', () => {
  it('rejects a missing header', async () => {
    expect((await post(null)).status).toBe(401)
  })
  it('rejects a wrong secret of the same length', async () => {
    expect((await post('relay-secret-0123456780')).status).toBe(401)
  })
  it('rejects a prefix and an over-long value', async () => {
    expect((await post('relay-secret')).status).toBe(401)
    expect((await post(SECRET + 'x')).status).toBe(401)
  })
  it('accepts the right secret (reaches body validation)', async () => {
    expect((await post(SECRET)).status).toBe(400)
  })
  it('is 503 when the relay is not configured', async () => {
    const res = await channelsApp.fetch(new Request('https://pot.example/relay', { method: 'POST', body: '{}' }), {} as unknown as Env)
    expect(res.status).toBe(503)
  })
})

describe('no ad-hoc secret compares remain', () => {
  it('channels/index.ts does not compare the relay header with !== or ===', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/channels/index.ts', 'utf8')
    expect(src).not.toMatch(/X-Relay-Secret'\)\s*[!=]==/)
    expect(src).toMatch(/timingSafeEqual\(/)
  })
})
