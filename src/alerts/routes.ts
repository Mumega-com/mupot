// src/alerts/routes.ts — Customer Outbound Webhook & Alert Subscription REST API.

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { getJSON, setJSON } from '../dashboard/settings'
import {
  dispatchOutboundAlert,
  type WebhookSubscription,
  type AlertChannelType,
} from './dispatcher'
// requireAuth is owned by the auth component; it sets c.get('auth').
import { requireAuth } from '../auth'
import { requireOrgCapability } from '../auth/capability'
import { csrf } from 'hono/csrf'

export const alertsApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// P0 (2026-09-02): mounted at /api/alerts with no middleware and no inline check —
// anonymous callers could register an exfiltration sink (events default '*'),
// delete the tenant's real alerting, list sink URLs (a Slack/Discord webhook URL IS
// the credential), and force outbound POSTs. Alert routing is org-admin only.
// CSRF: cookie-authenticated mutations on a top-level mount do not inherit
// dashboardApp's csrf(); SameSite=Lax is site-scoped (mumega.com) and does not
// stop a sibling *.mupot.mumega.com origin. Same convention as tasksApp.
alertsApp.use('*', csrf())
alertsApp.use('*', requireAuth)

/**
 * GET /api/alerts/webhooks — List configured outbound webhook subscriptions (secrets masked).
 */
alertsApp.get('/webhooks', requireOrgCapability('admin'), async (c) => {
  const subscriptions = (await getJSON<WebhookSubscription[]>(c.env, 'alert_webhooks')) || []
  const safe = subscriptions.map((s) => ({
    id: s.id,
    url: s.url,
    channel_type: s.channel_type,
    events: s.events,
    enabled: s.enabled,
    has_secret: !!s.secret,
    created_at: s.created_at,
  }))

  return c.json({ ok: true, webhooks: safe })
})

/**
 * POST /api/alerts/webhooks — Create or update an outbound webhook subscription.
 */
alertsApp.post('/webhooks', requireOrgCapability('admin'), async (c) => {
  let body: {
    url?: unknown
    channel_type?: unknown
    events?: unknown
    secret?: unknown
    enabled?: unknown
  }

  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400)
  }

  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!url.startsWith('https://') && !url.startsWith('http://localhost')) {
    return c.json({ ok: false, error: 'invalid_webhook_url', detail: 'URL must use HTTPS protocol' }, 400)
  }

  const channel_type: AlertChannelType =
    body.channel_type === 'slack' || body.channel_type === 'discord' ? body.channel_type : 'generic'

  const events = Array.isArray(body.events) && body.events.length > 0
    ? body.events.map(String)
    : ['*']

  const secret = typeof body.secret === 'string' ? body.secret.trim() : undefined
  const enabled = body.enabled !== false

  const subscriptions = (await getJSON<WebhookSubscription[]>(c.env, 'alert_webhooks')) || []

  const newSub: WebhookSubscription = {
    id: crypto.randomUUID(),
    url,
    channel_type,
    events,
    secret,
    enabled,
    created_at: new Date().toISOString(),
  }

  subscriptions.push(newSub)
  await setJSON(c.env, 'alert_webhooks', subscriptions)

  return c.json({
    ok: true,
    webhook: {
      id: newSub.id,
      url: newSub.url,
      channel_type: newSub.channel_type,
      events: newSub.events,
      enabled: newSub.enabled,
      has_secret: !!newSub.secret,
      created_at: newSub.created_at,
    },
  })
})

/**
 * DELETE /api/alerts/webhooks/:id — Remove a webhook subscription.
 */
alertsApp.delete('/webhooks/:id', requireOrgCapability('admin'), async (c) => {
  const id = c.req.param('id')
  const subscriptions = (await getJSON<WebhookSubscription[]>(c.env, 'alert_webhooks')) || []
  const filtered = subscriptions.filter((s) => s.id !== id)

  if (filtered.length === subscriptions.length) {
    return c.json({ ok: false, error: 'webhook_not_found' }, 404)
  }

  await setJSON(c.env, 'alert_webhooks', filtered)
  return c.json({ ok: true, deleted: id })
})

/**
 * POST /api/alerts/test — Trigger a test alert to verify notification delivery.
 */
alertsApp.post('/test', requireOrgCapability('admin'), async (c) => {
  let body: { event_type?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    // Optional body
  }

  const results = await dispatchOutboundAlert(c.env, {
    eventId: crypto.randomUUID(),
    eventType: body.event_type || 'test.ping',
    tenant: c.env.TENANT_SLUG || 'default',
    title: 'Mupot Alert Test Ping',
    summary: 'This is an automated test ping verifying real-time webhook delivery from your sovereign agent pot.',
    link: `${c.env.PUBLIC_ORIGIN || 'https://mupot.mumega.com'}/studio`,
    timestamp: Date.now(),
  })

  return c.json({ ok: true, deliveries: results })
})
