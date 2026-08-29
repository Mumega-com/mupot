// src/billing/stripe.ts — Stripe Checkout, Customer Portal, and Webhook Verification.

import type { Env } from '../types'
import { timingSafeEqual } from '../lib/crypto'
import { isPotTier, type PotTier } from './plans'
import { applyPlanEvent } from './entitlement'
import { setJSON, getJSON } from '../dashboard/settings'
import { createBus } from '../bus'

export interface PlanPriceConfig {
  tier: PotTier
  name: string
  monthlyCents: number
  annualCents: number
}

export const TIER_PRICING: Record<Exclude<PotTier, 'free'>, PlanPriceConfig> = {
  starter: {
    tier: 'starter',
    name: 'Mupot Starter Tier',
    monthlyCents: 4900,
    annualCents: 49000,
  },
  pro: {
    tier: 'pro',
    name: 'Mupot Pro Tier',
    monthlyCents: 9900,
    annualCents: 99000,
  },
  scale: {
    tier: 'scale',
    name: 'Mupot Scale Tier',
    monthlyCents: 24900,
    annualCents: 249000,
  },
}

export interface CreateCheckoutInput {
  tier: PotTier
  interval?: 'month' | 'year'
  customerEmail?: string
  memberId?: string
  origin: string
}

export interface StripeCheckoutResult {
  url: string
  sessionId: string
}

export interface StripeEvent {
  id: string
  type: string
  created: number
  data: {
    object: Record<string, any>
  }
}

/**
 * Creates a Stripe Checkout Session via Stripe REST API.
 */
export async function createStripeCheckout(
  env: Env,
  input: CreateCheckoutInput,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; result: StripeCheckoutResult } | { ok: false; error: string }> {
  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    return { ok: false, error: 'STRIPE_SECRET_KEY not configured on this pot' }
  }

  if (input.tier === 'free' || !isPotTier(input.tier)) {
    return { ok: false, error: 'invalid_plan_tier' }
  }

  const pricing = TIER_PRICING[input.tier as keyof typeof TIER_PRICING]
  if (!pricing) {
    return { ok: false, error: 'tier_pricing_not_found' }
  }

  const interval = input.interval === 'year' ? 'year' : 'month'
  const unitAmount = interval === 'year' ? pricing.annualCents : pricing.monthlyCents

  const params = new URLSearchParams()
  params.set('mode', 'subscription')
  params.set('success_url', `${input.origin}/billing?session_id={CHECKOUT_SESSION_ID}&success=true`)
  params.set('cancel_url', `${input.origin}/billing?canceled=true`)
  params.set('client_reference_id', env.TENANT_SLUG)

  if (input.customerEmail) {
    params.set('customer_email', input.customerEmail)
  }

  params.set('metadata[tenant_slug]', env.TENANT_SLUG)
  params.set('metadata[tier]', input.tier)
  if (input.memberId) {
    params.set('metadata[member_id]', input.memberId)
  }

  params.set('line_items[0][price_data][currency]', 'usd')
  params.set('line_items[0][price_data][product_data][name]', `${pricing.name} (${env.BRAND || 'Mupot'})`)
  params.set('line_items[0][price_data][unit_amount]', String(unitAmount))
  params.set('line_items[0][price_data][recurring][interval]', interval)
  params.set('line_items[0][quantity]', '1')

  try {
    const res = await fetchFn('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { ok: false, error: `Stripe API error: HTTP ${res.status} ${errText}` }
    }

    const session = (await res.json()) as { id: string; url: string }
    return {
      ok: true,
      result: {
        sessionId: session.id,
        url: session.url,
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Creates a Stripe Customer Portal session.
 */
export async function createStripePortal(
  env: Env,
  customerId: string,
  origin: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    return { ok: false, error: 'STRIPE_SECRET_KEY not configured' }
  }

  const params = new URLSearchParams()
  params.set('customer', customerId)
  params.set('return_url', `${origin}/billing`)

  try {
    const res = await fetchFn('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { ok: false, error: `Stripe Portal API error: HTTP ${res.status} ${errText}` }
    }

    const data = (await res.json()) as { url: string }
    return { ok: true, url: data.url }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Verifies Stripe webhook signature using Web Crypto HMAC SHA-256.
 */
export async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
  toleranceSec = 300,
): Promise<boolean> {
  if (!sigHeader || !secret) return false

  const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, item) => {
    const [k, v] = item.trim().split('=')
    if (k && v) acc[k] = v
    return acc
  }, {})

  const timestamp = parts['t']
  const expectedSig = parts['v1']

  if (!timestamp || !expectedSig) return false

  const nowSec = Math.floor(Date.now() / 1000)
  const tsNum = parseInt(timestamp, 10)
  if (isNaN(tsNum) || Math.abs(nowSec - tsNum) > toleranceSec) {
    return false
  }

  const signedPayload = `${timestamp}.${rawBody}`
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload))
  const computedHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  return timingSafeEqual(computedHex, expectedSig)
}

/**
 * Handles incoming Stripe Webhook events and atomically upgrades/downgrades tenant plan.
 */
export async function handleStripeWebhookEvent(
  env: Env,
  event: StripeEvent,
): Promise<{ ok: true; handled: boolean; action?: string; tier?: PotTier }> {
  const bus = createBus(env)

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      const tenantSlug = session.metadata?.tenant_slug || session.client_reference_id
      const tier = isPotTier(session.metadata?.tier) ? (session.metadata.tier as PotTier) : 'starter'
      const customerId = session.customer
      const subscriptionId = session.subscription

      if (tenantSlug === env.TENANT_SLUG) {
        await applyPlanEvent(env, {
          tier,
          eventId: event.id,
          effectiveAt: (event.created || Math.floor(Date.now() / 1000)) * 1000,
        })

        if (customerId) {
          await setJSON(env, 'stripe_customer_id', customerId)
        }
        if (subscriptionId) {
          await setJSON(env, 'stripe_subscription_id', subscriptionId)
        }

        await bus.emit({
          type: 'billing.subscription.created',
          actor: { kind: 'external', id: `stripe:${customerId || 'checkout'}` },
          tenant: env.TENANT_SLUG,
          ts: new Date().toISOString(),
          payload: {
            tier,
            customer_id: customerId,
            subscription_id: subscriptionId,
            event_id: event.id,
          },
        })

        return { ok: true, handled: true, action: 'upgraded', tier }
      }
      return { ok: true, handled: false, action: 'ignored_other_tenant' }
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object
      const storedSubId = await getJSON<string>(env, 'stripe_subscription_id')
      if (storedSubId === sub.id) {
        await applyPlanEvent(env, {
          tier: 'free',
          eventId: event.id,
          effectiveAt: (event.created || Math.floor(Date.now() / 1000)) * 1000,
        })

        await bus.emit({
          type: 'billing.subscription.deleted',
          actor: { kind: 'external', id: `stripe:${sub.customer || 'sub'}` },
          tenant: env.TENANT_SLUG,
          ts: new Date().toISOString(),
          payload: {
            previous_subscription_id: sub.id,
            tier: 'free',
            event_id: event.id,
          },
        })

        return { ok: true, handled: true, action: 'downgraded', tier: 'free' }
      }
      return { ok: true, handled: false, action: 'ignored_unmatched_sub' }
    }

    default:
      return { ok: true, handled: true, action: 'ignored_event_type' }
  }
}
