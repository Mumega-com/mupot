// src/billing/routes.ts — Customer Billing, Checkout, and Stripe Webhook Endpoints.

import { Hono } from 'hono'
import type { Env, AuthContext } from '../types'
import { resolveTier } from './entitlement'
import { PLAN_LIMITS, POT_FEATURES, type PotTier } from './plans'
import {
  createStripeCheckout,
  createStripePortal,
  verifyStripeSignature,
  handleStripeWebhookEvent,
  TIER_PRICING,
  type StripeEvent,
} from './stripe'
import { getJSON } from '../dashboard/settings'
import { hasWorkspaceAdmin } from '../mcp/index'

export const billingRoutesApp = new Hono<{ Bindings: Env; Variables: { auth?: AuthContext } }>()

/**
 * GET /api/billing/status — Returns current plan tier, features, limits, and pricing.
 */
billingRoutesApp.get('/status', async (c) => {
  const tier = await resolveTier(c.env)
  const limits = PLAN_LIMITS[tier]
  const customerId = await getJSON<string>(c.env, 'stripe_customer_id')
  const subscriptionId = await getJSON<string>(c.env, 'stripe_subscription_id')

  return c.json({
    ok: true,
    tenant: c.env.TENANT_SLUG,
    brand: c.env.BRAND || 'Mupot',
    tier,
    limits,
    features: POT_FEATURES,
    pricing: TIER_PRICING,
    has_active_subscription: !!subscriptionId,
    customer_id: customerId || null,
  })
})

/**
 * POST /api/billing/checkout — Creates a Stripe Checkout Session for self-serve upgrade.
 */
billingRoutesApp.post('/checkout', async (c) => {
  let body: { tier?: unknown; interval?: unknown; customer_email?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const tier = typeof body.tier === 'string' ? (body.tier as PotTier) : 'starter'
  const interval = body.interval === 'year' ? 'year' : 'month'
  const customerEmail = typeof body.customer_email === 'string' ? body.customer_email.trim() : undefined
  const origin = new URL(c.req.url).origin

  const result = await createStripeCheckout(c.env, {
    tier,
    interval,
    customerEmail,
    origin,
  })

  if (!result.ok) {
    return c.json({ error: result.error }, 400)
  }

  return c.json({
    ok: true,
    url: result.result.url,
    session_id: result.result.sessionId,
  })
})

/**
 * POST /api/billing/portal — Creates a Stripe Customer Portal link.
 */
billingRoutesApp.post('/portal', async (c) => {
  const customerId = await getJSON<string>(c.env, 'stripe_customer_id')
  if (!customerId) {
    return c.json({ error: 'no_active_stripe_customer', detail: 'No billing record exists yet. Upgrade to a paid plan first.' }, 404)
  }

  const origin = new URL(c.req.url).origin
  const result = await createStripePortal(c.env, customerId, origin)

  if (!result.ok) {
    return c.json({ error: result.error }, 400)
  }

  return c.json({ ok: true, url: result.url })
})

/**
 * POST /webhooks/stripe & /api/billing/webhook — Inbound Stripe Webhook listener.
 */
billingRoutesApp.post('/webhook', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET
  const sigHeader = c.req.header('stripe-signature') || ''

  const rawBody = await c.req.text().catch(() => '')
  if (!rawBody) {
    return c.json({ error: 'empty_payload' }, 400)
  }

  if (secret) {
    const verified = await verifyStripeSignature(rawBody, sigHeader, secret)
    if (!verified) {
      return c.json({ error: 'invalid_stripe_signature' }, 401)
    }
  }

  let event: StripeEvent
  try {
    event = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const result = await handleStripeWebhookEvent(c.env, event)
  return c.json({ ok: true, result })
})
