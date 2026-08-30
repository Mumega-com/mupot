// src/alerts/dispatcher.ts — Outbound Customer Webhook Dispatcher & Multi-Channel Alert Router.

import type { Env } from '../types'
import { getJSON } from '../dashboard/settings'

export type AlertChannelType = 'generic' | 'slack' | 'discord'

export interface WebhookSubscription {
  id: string
  url: string
  secret?: string
  channel_type: AlertChannelType
  events: string[]
  enabled: boolean
  created_at: string
}

export interface OutboundNotification {
  eventId: string
  eventType: string
  tenant: string
  title: string
  summary: string
  details?: Record<string, unknown>
  link?: string
  timestamp?: number
}

export interface DeliveryResult {
  subscriptionId: string
  url: string
  status: number
  ok: boolean
  error?: string
}

export async function signWebhookPayload(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function formatSlackPayload(n: OutboundNotification): Record<string, unknown> {
  return {
    text: `*[${n.tenant.toUpperCase()}] ${n.title}*\n${n.summary}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `⚡ ${n.title}`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Event:* \`${n.eventType}\`\n*Tenant:* \`${n.tenant}\`\n\n${n.summary}`,
        },
      },
      ...(n.link
        ? [
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Open in Studio' },
                  url: n.link,
                  style: 'primary',
                },
              ],
            },
          ]
        : []),
    ],
  }
}

export function formatDiscordPayload(n: OutboundNotification): Record<string, unknown> {
  return {
    username: `${n.tenant.toUpperCase()} Agent Fleet`,
    embeds: [
      {
        title: n.title,
        description: n.summary,
        color: 0x22d3ee, // Cyan
        fields: [
          { name: 'Event', value: `\`${n.eventType}\``, inline: true },
          { name: 'Tenant', value: `\`${n.tenant}\``, inline: true },
        ],
        timestamp: new Date(n.timestamp || Date.now()).toISOString(),
        url: n.link || undefined,
      },
    ],
  }
}

export async function dispatchOutboundAlert(
  env: Env,
  notification: OutboundNotification,
  fetchFn: typeof fetch = fetch,
): Promise<DeliveryResult[]> {
  const subscriptions = (await getJSON<WebhookSubscription[]>(env, 'alert_webhooks')) || []
  const activeSubs = subscriptions.filter((s) => s.enabled && (s.events.includes('*') || s.events.includes(notification.eventType)))

  const results: DeliveryResult[] = []

  for (const sub of activeSubs) {
    let bodyString = ''
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mupot-Alert-Dispatcher/1.0',
      'X-Mupot-Event': notification.eventType,
      'X-Mupot-Tenant': notification.tenant,
    }

    if (sub.channel_type === 'slack') {
      bodyString = JSON.stringify(formatSlackPayload(notification))
    } else if (sub.channel_type === 'discord') {
      bodyString = JSON.stringify(formatDiscordPayload(notification))
    } else {
      const payload = {
        version: 'mupot.alert/v1',
        event_id: notification.eventId,
        event_type: notification.eventType,
        tenant: notification.tenant,
        title: notification.title,
        summary: notification.summary,
        details: notification.details || {},
        link: notification.link || null,
        timestamp: notification.timestamp || Date.now(),
      }
      bodyString = JSON.stringify(payload)
    }

    if (sub.secret) {
      const sig = await signWebhookPayload(sub.secret, bodyString)
      headers['X-Mupot-Signature'] = sig
    }

    try {
      const res = await fetchFn(sub.url, {
        method: 'POST',
        headers,
        body: bodyString,
      })

      results.push({
        subscriptionId: sub.id,
        url: sub.url,
        status: res.status,
        ok: res.ok,
      })
    } catch (error) {
      results.push({
        subscriptionId: sub.id,
        url: sub.url,
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return results
}
