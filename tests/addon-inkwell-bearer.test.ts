import { describe, expect, it, vi } from 'vitest'
import { inkwellApp } from '../src/addons/inkwell'
import type { Env } from '../src/types'

const routes = ['/publish', '/internal-content', '/draft']
// Synthetic fixture, deliberately separate from the inbound addon credential.
const publishToken = 'test-outbound-publish-credential'

function request(route: string, fetcher: ReturnType<typeof vi.fn>, token?: string) {
  return inkwellApp.request(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-addon-credential' },
    body: JSON.stringify({ title: 'Title', slug: 'slug', content: 'Content' }),
  }, {
    INKWELL_SECRET: 'test-addon-credential',
    INKWELL_PUBLISH_TOKEN: token,
    INKWELL_SVC: { fetch: fetcher },
  } as unknown as Env)
}

describe.each(routes)('Inkwell outbound bearer on %s', (route) => {
  it.each([undefined, ''])('returns a typed setup result without fetching when token is %s', async (token) => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }))
    const res = await request(route, fetcher, token)
    expect(fetcher).not.toHaveBeenCalled()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      error: 'inkwell_publish_token_unconfigured',
      next_step: 'Ask an admin to set INKWELL_PUBLISH_TOKEN.',
    })
  })

  it('sends the exact outbound bearer and preserves successful results', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }))
    const res = await request(route, fetcher, publishToken)
    expect(res.status).toBe(route === '/draft' ? 200 : 201)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://inkwell-api.internal/api/publish')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${publishToken}`)
    expect(init.redirect).toBe('manual')
    expect(JSON.parse(init.body as string).status).toBe(route === '/draft' ? 'draft' : 'published')
    expect(await res.text()).not.toContain(publishToken)
  })

  it.each([
    [401, 502, 'inkwell_publish_unauthorized', 'Ask an admin to match INKWELL_PUBLISH_TOKEN to Inkwell PUBLISH_TOKEN.'],
    [503, 503, 'inkwell_publish_unconfigured', 'Ask an admin to set PUBLISH_TOKEN on Inkwell.'],
    [500, 500, 'publishing_failed', 'Retry publishing; if it persists, ask an admin to check Inkwell.'],
  ] as const)('maps upstream %i to a safe typed result', async (status, expectedStatus, error, next_step) => {
    const fetcher = vi.fn(async () => new Response(`Upstream echoed ${publishToken}`, { status }))
    const res = await request(route, fetcher, publishToken)
    expect(res.status).toBe(expectedStatus)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ error, next_step })
    expect(text).not.toContain(publishToken)
  })

  it('does not expose credentials from a thrown fetch error', async () => {
    const fetcher = vi.fn(async () => { throw new Error(`Request failed with Bearer ${publishToken}`) })
    const res = await request(route, fetcher, publishToken)
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text).error).toBe('publishing_failed')
    expect(text).not.toContain(publishToken)
  })
})
