// tests/stripe-billing.test.ts — Unit tests for Stripe Checkout, Customer Portal & Subscription Webhook Engine (Flight 7).

import { describe, expect, it, vi } from 'vitest'
import {
  createStripeCheckout,
  createStripePortal,
  verifyStripeSignature,
  handleStripeWebhookEvent,
  TIER_PRICING,
} from '../src/billing/stripe'
import { billingRoutesApp } from '../src/billing/routes'

describe('Stripe Checkout & Subscription Billing Engine (Flight 7)', () => {
  it('defines pricing for starter, pro, and scale tiers', () => {
    expect(TIER_PRICING.starter.monthlyCents).toBe(4900)
    expect(TIER_PRICING.pro.monthlyCents).toBe(9900)
    expect(TIER_PRICING.scale.monthlyCents).toBe(24900)
  })

  it('creates Stripe Checkout session with valid parameters and urlencoded body', async () => {
    const mockSession = {
      id: 'cs_test_session_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_session_123',
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockSession,
    }) as unknown as typeof fetch

    const mockEnv = {
      STRIPE_SECRET_KEY: 'sk_test_placeholder_key_example',
      TENANT_SLUG: 'gaf',
      BRAND: 'GAF Materials',
    }

    const result = await createStripeCheckout(
      mockEnv as any,
      {
        tier: 'scale',
        interval: 'month',
        customerEmail: 'billing@gaf.com',
        origin: 'https://gaf.mupot.mumega.com',
      },
      mockFetch,
    )

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.sessionId).toBe('cs_test_session_123')
      expect(result.result.url).toBe('https://checkout.stripe.com/c/pay/cs_test_session_123')
    }

    const calledBody = (mockFetch as any).mock.calls[0][1].body
    expect(calledBody).toContain('mode=subscription')
    expect(calledBody).toContain('metadata%5Btenant_slug%5D=gaf')
    expect(calledBody).toContain('metadata%5Btier%5D=scale')
    expect(calledBody).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=24900')
  })

  it('creates Stripe Customer Portal session', async () => {
    const mockPortal = {
      url: 'https://billing.stripe.com/p/session/test_portal_123',
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockPortal,
    }) as unknown as typeof fetch

    const mockEnv = {
      STRIPE_SECRET_KEY: 'sk_test_placeholder_key_example',
    }

    const result = await createStripePortal(
      mockEnv as any,
      'cus_test_123',
      'https://gaf.mupot.mumega.com',
      mockFetch,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.url).toBe('https://billing.stripe.com/p/session/test_portal_123')
    }
  })

  it('verifies Stripe webhook signature accurately', async () => {
    const rawBody = JSON.stringify({ id: 'evt_test_123', type: 'checkout.session.completed' })
    const webhookSecret = 'whsec_placeholder_example_key'
    const timestamp = Math.floor(Date.now() / 1000)

    const signedPayload = `${timestamp}.${rawBody}`
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload))
    const validHex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const sigHeader = `t=${timestamp},v1=${validHex}`

    const isValid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret)
    expect(isValid).toBe(true)

    const isInvalid = await verifyStripeSignature(rawBody, `t=${timestamp},v1=invalid_signature_hex`, webhookSecret)
    expect(isInvalid).toBe(false)
  })

  it('processes checkout.session.completed and upgrades tenant to paid tier', async () => {
    const event = {
      id: 'evt_checkout_success_123',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'cs_123',
          customer: 'cus_gaf_999',
          subscription: 'sub_gaf_999',
          client_reference_id: 'gaf',
          metadata: {
            tenant_slug: 'gaf',
            tier: 'scale',
          },
        },
      },
    }

    const mockEnv = {
      TENANT_SLUG: 'gaf',
      BUS: {
        send: vi.fn().mockResolvedValue(undefined),
      },
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        }),
      },
    }

    const result = await handleStripeWebhookEvent(mockEnv as any, event)
    expect(result.ok).toBe(true)
    expect(result.action).toBe('upgraded')
    expect(result.tier).toBe('scale')
  })

  it('serves GET /api/billing/status with current tier and features', async () => {
    const mockEnv = {
      TENANT_SLUG: 'gaf',
      BRAND: 'GAF Materials',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue({ value: JSON.stringify({ tier: 'scale' }) }),
          }),
        }),
      },
    }

    const req = new Request('http://localhost/status')
    const res = await billingRoutesApp.fetch(req, mockEnv as any)
    expect(res.status).toBe(200)

    const json = await res.json<{ ok: boolean; tier: string; brand: string }>()
    expect(json.ok).toBe(true)
    expect(json.tier).toBe('scale')
    expect(json.brand).toBe('GAF Materials')
  })
})
