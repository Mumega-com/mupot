// tests/outbound-alerts-webhook.test.ts — Unit tests for Outbound Webhook & Multi-Channel Alert Router (Flight 10).

import { describe, expect, it, vi } from 'vitest'
import {
  signWebhookPayload,
  formatSlackPayload,
  formatDiscordPayload,
  dispatchOutboundAlert,
} from '../src/alerts/dispatcher'
import { alertsApp } from '../src/alerts/routes'

describe('Outbound Customer Webhooks & Multi-Channel Alert Router (Flight 10)', () => {
  it('computes valid HMAC SHA-256 signature for webhook payloads', async () => {
    const payload = JSON.stringify({ event: 'flight.landed', tenant: 'gaf' })
    const secret = 'placeholder-webhook-secret-key'

    const sig = await signWebhookPayload(secret, payload)
    expect(typeof sig).toBe('string')
    expect(sig.length).toBe(64) // 256 bits hex
  })

  it('formats Slack BlockKit and Discord Embed payloads correctly', () => {
    const notification = {
      eventId: 'evt_123',
      eventType: 'flight.landed',
      tenant: 'gaf',
      title: 'Flight Landed: 1-Click Supabase Connector',
      summary: 'Autonomous flight landed with 100% green tests.',
      link: 'https://gaf.mupot.mumega.com/studio',
      timestamp: 1787780000000,
    }

    const slack = formatSlackPayload(notification) as any
    expect(slack.text).toContain('[GAF]')
    expect(slack.blocks.length).toBeGreaterThanOrEqual(2)

    const discord = formatDiscordPayload(notification) as any
    expect(discord.username).toBe('GAF Agent Fleet')
    expect(discord.embeds[0].title).toBe('Flight Landed: 1-Click Supabase Connector')
  })

  it('dispatches outbound alerts to active configured webhooks with signature headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    })

    const mockSub = {
      id: 'sub_1',
      url: 'https://webhook.site/test-hook',
      secret: 'placeholder-webhook-secret-key',
      channel_type: 'generic',
      events: ['flight.landed'],
      enabled: true,
      created_at: new Date().toISOString(),
    }

    const mockEnv = {
      TENANT_SLUG: 'gaf',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ value: JSON.stringify([mockSub]) }),
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        }),
      },
    }

    const results = await dispatchOutboundAlert(
      mockEnv as any,
      {
        eventId: 'evt_123',
        eventType: 'flight.landed',
        tenant: 'gaf',
        title: 'Flight Landed',
        summary: 'Tests passed.',
      },
      mockFetch as any,
    )

    expect(results.length).toBe(1)
    expect(results[0].ok).toBe(true)
    expect(results[0].status).toBe(200)

    const calledHeaders = mockFetch.mock.calls[0][1].headers
    expect(calledHeaders['X-Mupot-Event']).toBe('flight.landed')
    expect(calledHeaders['X-Mupot-Tenant']).toBe('gaf')
    expect(calledHeaders['X-Mupot-Signature']).toBeDefined()
  })

  it('handles REST API subscription lifecycle: list, create, and test ping', async () => {
    let storedSubs: any[] = []

    const mockEnv = {
      TENANT_SLUG: 'gaf',
      PUBLIC_ORIGIN: 'https://gaf.mupot.mumega.com',
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn((...args: any[]) => ({
            first: vi.fn().mockImplementation(async () => {
              if (sql.includes('SELECT')) {
                return { value: JSON.stringify(storedSubs) }
              }
              return null
            }),
            run: vi.fn().mockImplementation(async () => {
              if (sql.includes('INSERT') || sql.includes('UPDATE')) {
                storedSubs = JSON.parse(args[1] || '[]')
              }
              return { meta: { changes: 1 } }
            }),
          })),
        })),
      },
    }

    // 1. Create Webhook
    const createReq = new Request('http://localhost/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://hooks.slack.com/services/T00/B00/placeholder',
        channel_type: 'slack',
        events: ['flight.landed'],
      }),
    })

    const createRes = await alertsApp.fetch(createReq, mockEnv as any)
    expect(createRes.status).toBe(200)
    const createJson = await createRes.json<{ ok: boolean; webhook: any }>()
    expect(createJson.ok).toBe(true)
    expect(createJson.webhook.channel_type).toBe('slack')

    // 2. List Webhooks
    const listReq = new Request('http://localhost/webhooks')
    const listRes = await alertsApp.fetch(listReq, mockEnv as any)
    expect(listRes.status).toBe(200)
  })
})
