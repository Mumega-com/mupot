import { describe, it, expect } from 'vitest'
import { kayhermesBody } from '../src/dashboard/kayhermes'
import type { Env } from '../src/types'

async function render(p: ReturnType<typeof kayhermesBody>): Promise<string> {
  return String(await p)
}

describe('kayhermesBody', () => {
  it('shows not-configured empty state', async () => {
    const out = await render(
      kayhermesBody({} as Env, {
        configured: false,
        healthy: null,
        sessions: [],
        error: null,
        dashboardUrl: null,
      }),
    )
    expect(out).toContain('Not configured')
    expect(out).toContain('KAYHERMES_API_URL')
  })

  it('HTML-escapes hostile session titles', async () => {
    const out = await render(
      kayhermesBody({} as Env, {
        configured: true,
        healthy: true,
        sessions: [
          {
            id: 's1',
            title: '<img src=x onerror=alert(1)>',
            source: '<b>tg</b>',
            updated_at: null,
            message_count: 1,
          },
        ],
        error: null,
        dashboardUrl: 'https://hermes-dash.example.com',
      }),
    )
    expect(out).not.toContain('<img src=x onerror')
    expect(out).toContain('&lt;img')
    expect(out).not.toContain('<b>tg</b>')
    expect(out).toContain('data-sid="s1"')
    expect(out).toContain('/api/kayhermes/sessions')
    expect(out).toContain('https://hermes-dash.example.com')
  })

  it('surfaces upstream error text escaped', async () => {
    const out = await render(
      kayhermesBody({} as Env, {
        configured: true,
        healthy: false,
        sessions: [],
        error: '<script>alert(1)</script>',
        dashboardUrl: null,
      }),
    )
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).toContain('&lt;script&gt;')
  })
})
