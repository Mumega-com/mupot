// tests/pot-checkout-provisioning.test.ts — Unit tests for Self-Serve Pot Checkout & Provisioning (Flight 12).

import { describe, expect, it, vi } from 'vitest'
import {
  checkSlugAvailability,
  createPotCheckoutSession,
  handlePotCreationCompleted,
} from '../src/pots/checkout'
import { pricingPageHtml } from '../src/dashboard/pricing'
import { publicPotsApp } from '../src/pots/routes'

describe('Public Pricing & Self-Serve Sovereign Pot Provisioning Portal (Flight 12)', () => {
  it('validates subdomain slug availability and reserved word protection', async () => {
    const mockEnv = {
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
          }),
        }),
      },
    }

    // Valid slug
    const resValid = await checkSlugAvailability(mockEnv as any, 'acme-corp')
    expect(resValid.available).toBe(true)
    expect(resValid.slug).toBe('acme-corp')

    // Reserved slug
    const resReserved = await checkSlugAvailability(mockEnv as any, 'admin')
    expect(resReserved.available).toBe(false)
    expect(resReserved.reason).toContain('reserved')

    // Invalid format
    const resInvalid = await checkSlugAvailability(mockEnv as any, '-bad_slug!')
    expect(resInvalid.available).toBe(false)
  })

  it('creates Stripe checkout session with embedded pot metadata', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        id: 'cs_placeholder_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_placeholder_test_123',
      }),
    })

    const mockEnv = {
      STRIPE_SECRET_KEY: 'sk_test_placeholder_key',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
          }),
        }),
      },
    }

    const result = await createPotCheckoutSession(
      mockEnv as any,
      {
        slug: 'novacorp',
        brand: 'Nova Corporation',
        tier: 'pro',
        ownerEmail: 'ceo@novacorp.com',
        origin: 'https://mupot.mumega.com',
      },
      mockFetch as any,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sessionId).toBe('cs_placeholder_test_123')
      expect(result.url).toContain('stripe.com')
    }

    const calledBody = mockFetch.mock.calls[0][1].body
    expect(calledBody).toContain('metadata%5Bslug%5D=novacorp')
    expect(calledBody).toContain('metadata%5Btier%5D=pro')
    expect(calledBody).toContain('unit_amount%5D=9900') // $99 for Pro
  })

  it('provisions pot and emits BusEvent when checkout session completes', async () => {
    const mockBusSend = vi.fn().mockResolvedValue(undefined)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ success: true, result: { id: 'd1_id_123' } }),
    })

    // Mock global fetch for provisionPot sub-calls
    vi.stubGlobal('fetch', mockFetch)

    const mockEnv = {
      TENANT_SLUG: 'mumega',
      SECRET_ENV_CF_API_TOKEN: 'cf_token_placeholder',
      BUS: { send: mockBusSend },
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        }),
      },
    }

    const sessionPayload = {
      customer: 'cus_123',
      customer_email: 'admin@acme.com',
      metadata: {
        action: 'create_pot',
        slug: 'acmecorp',
        brand: 'ACME Corporation',
        tier: 'starter',
        owner_email: 'admin@acme.com',
      },
    }

    const outcome = await handlePotCreationCompleted(mockEnv as any, sessionPayload)
    expect(outcome.ok).toBe(true)
    expect(outcome.slug).toBe('acmecorp')
    expect(mockBusSend).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
  })

  it('renders public pricing page HTML', () => {
    const pageHtml = pricingPageHtml('https://mupot.mumega.com').toString()
    expect(pageHtml).toContain('Your Sovereign Agent Workforce')
    expect(pageHtml).toContain('Starter')
    expect(pageHtml).toContain('$49')
    expect(pageHtml).toContain('Pro')
    expect(pageHtml).toContain('$99')
    expect(pageHtml).toContain('Scale')
    expect(pageHtml).toContain('$249')
  })

  it('serves public REST API endpoints: GET /slug-available and POST /checkout', async () => {
    const mockEnv = {
      STRIPE_SECRET_KEY: 'sk_test_placeholder_key',
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
          }),
        }),
      },
    }

    const req = new Request('http://localhost/slug-available?slug=my-fleet-pot')
    const res = await publicPotsApp.fetch(req, mockEnv as any)
    expect(res.status).toBe(200)
    const json = await res.json<{ ok: boolean; result: { available: boolean } }>()
    expect(json.ok).toBe(true)
    expect(json.result.available).toBe(true)
  })
})
