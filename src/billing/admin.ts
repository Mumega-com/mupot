// mupot — billing admin (the WRITER of the pot's plan tier).
//
// POST /api/billing/plan — the ONLY write path for `org_settings.plan_tier`.
// HMAC-authed (BILLING_PLAN_SECRET, x-mupot-signature over the raw body — same
// constant-time pattern as the event-ingest webhook). Called machine-to-machine
// by the CENTRAL billing source (mumega Stripe webhook / marketplace fulfillment)
// on a subscription event. NEVER owner-session, NEVER self-service — a pot cannot
// raise its own tier; only a verified billing event can.
//
// Verify-before-act: signature is checked before the body is parsed or any write.

import { Hono } from 'hono'
import type { Env } from '../types'
import { setSetting } from '../dashboard/settings'
import { PLAN_TIER_KEY } from './entitlement'
import { isPotTier } from './plans'

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Constant-time compare of two equal-length hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const billingAdminApp = new Hono<{ Bindings: Env }>()

billingAdminApp.post('/plan', async (c) => {
  const secret = c.env.BILLING_PLAN_SECRET
  if (!secret || secret.length === 0) {
    return c.json({ error: 'not_configured', detail: 'BILLING_PLAN_SECRET not set on this pot' }, 503)
  }
  let raw: string
  try {
    raw = await c.req.text()
  } catch {
    return c.json({ error: 'invalid_body' }, 400)
  }
  const sigHeader = (c.req.header('x-mupot-signature') ?? '').toLowerCase()
  if (sigHeader.length === 0 || !timingSafeEqual(await hmacHex(secret, raw), sigHeader)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  let body: { tier?: unknown; reason?: unknown }
  try {
    body = JSON.parse(raw) as { tier?: unknown; reason?: unknown }
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!isPotTier(body.tier)) {
    return c.json({ error: 'invalid_tier', allowed: ['free', 'starter', 'pro', 'scale'] }, 400)
  }
  await setSetting(c.env, PLAN_TIER_KEY, body.tier)
  return c.json({ ok: true, tier: body.tier })
})
