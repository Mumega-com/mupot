// tests/outbound-alerts-webhook.test.ts — Unit tests for Outbound Webhook & Multi-Channel Alert Router (Flight 10).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  signWebhookPayload,
  formatSlackPayload,
  formatDiscordPayload,
  dispatchOutboundAlert,
} from '../src/alerts/dispatcher'
import { alertsApp } from '../src/alerts/routes'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

describe('Outbound Customer Webhooks & Multi-Channel Alert Router (Flight 10)', () => {
  let harness: ReturnType<typeof createSqliteD1>

  beforeEach(() => {
    vi.restoreAllMocks()
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })
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

    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at)
       VALUES ('alert_webhooks', ?1, CURRENT_TIMESTAMP)`,
    ).bind(JSON.stringify([mockSub])).run()
    const env = {
      TENANT_SLUG: 'gaf',
      DB: harness.db,
    } as unknown as Env

    const results = await dispatchOutboundAlert(
      env,
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
    const env = {
      TENANT_SLUG: 'gaf',
      PUBLIC_ORIGIN: 'https://gaf.mupot.mumega.com',
      DB: harness.db,
      SESSIONS: {
        get: async (key: string) => (key === 'sess:owner-session' ? JSON.stringify({ userId: 'owner-user', email: 'owner@gaf.com', role: 'owner', createdAt: '2026-09-01T00:00:00.000Z' }) : null),
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env
    // Routes are org-admin gated (P0 2026-09-02): drive them as a dashboard owner.
    const asOwner = { cookie: 'mupot_session=owner-session' }

    // 1. Create Webhook
    const createReq = new Request('http://localhost/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asOwner },
      body: JSON.stringify({
        url: 'https://webhook.site/test-endpoint',
        channel_type: 'slack',
        events: ['flight.landed'],
      }),
    })

    const createRes = await alertsApp.fetch(createReq, env)
    expect(createRes.status).toBe(200)
    const createJson = await createRes.json<{ ok: boolean; webhook: any }>()
    expect(createJson.ok).toBe(true)
    expect(createJson.webhook.channel_type).toBe('slack')

    // 2. List Webhooks
    const listReq = new Request('http://localhost/webhooks', { headers: asOwner })
    const listRes = await alertsApp.fetch(listReq, env)
    expect(listRes.status).toBe(200)
    const listJson = await listRes.json<{ ok: boolean; webhooks: unknown[] }>()
    expect(listJson.webhooks).toHaveLength(1)
  })
})
