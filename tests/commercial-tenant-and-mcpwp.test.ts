// tests/commercial-tenant-and-mcpwp.test.ts — Unit and real schema tests for commercialization engine.

import { describe, it, expect } from 'vitest'
import { planClientTenant, deriveClientSlug } from '../src/reseller/client-tenant'
import { formatClientIntakeTask } from '../src/tasks/client-intake-template'
import { formatStripeMeteringReceipt } from '../src/billing/metering-receipt'

describe('Commercial Client Tenant Stand-Up Planner', () => {
  it('derives clean client slugs', () => {
    expect(deriveClientSlug('Viamar Logistics')).toBe('viamar-logistics')
    expect(deriveClientSlug('https://DentalNearYou.ca/')).toBe('dentalnearyou-ca')
    expect(deriveClientSlug('Tech-Parts & Hardware!')).toBe('tech-parts-hardware')
  })

  it('generates a deterministic client tenant stand-up plan', () => {
    const plan = planClientTenant({
      clientName: 'DentalNearYou',
      wordpressUrl: 'https://dentalnearyou.com',
      services: ['seo', 'content', 'aeo'],
      tier: 'pro',
      applicationFeePercent: 20,
      contactEmail: 'billing@dentalnearyou.com',
    })

    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.tenantSlug).toBe('dentalnearyou')
      expect(plan.tier).toBe('pro')
      expect(plan.billing.applicationFeePercent).toBe(20)
      expect(plan.billing.contactEmail).toBe('billing@dentalnearyou.com')
      expect(plan.squads).toHaveLength(2)
      expect(plan.squads[0].slug).toBe('dentalnearyou-core')
      expect(plan.squads[1].slug).toBe('dentalnearyou-mcpwp')
      expect(plan.connectorBindings).toHaveLength(2)
      expect(plan.services).toHaveLength(3)
      expect(plan.execute.stepsRequired.length).toBeGreaterThanOrEqual(4)
    }
  })

  it('rejects invalid inputs cleanly', () => {
    const invalidName = planClientTenant({
      clientName: ' ',
      wordpressUrl: 'https://example.com',
    })
    expect(invalidName.ok).toBe(false)
    if (!invalidName.ok) expect(invalidName.reason).toBe('invalid_client_name')

    const invalidUrl = planClientTenant({
      clientName: 'Client Co',
      wordpressUrl: 'not-a-url',
    })
    expect(invalidUrl.ok).toBe(false)
    if (!invalidUrl.ok) expect(invalidUrl.reason).toBe('invalid_wordpress_url')

    const invalidService = planClientTenant({
      clientName: 'Client Co',
      wordpressUrl: 'https://example.com',
      services: ['non-existent-service-123'],
    })
    expect(invalidService.ok).toBe(false)
    if (!invalidService.ok) expect(invalidService.reason).toBe('unsupported_service')
  })
})

describe('Grok SEO & Client Task Intake Template', () => {
  it('formats an mcpwp-seo task with strict done_when predicates', () => {
    const task = formatClientIntakeTask({
      clientSlug: 'viamar',
      servicePackage: 'mcpwp-seo',
      title: 'Inject High-Intent Freight Meta Tags',
      description: 'Optimize the main freight forwarder page for Ontario commercial queries.',
      targetUrl: 'https://viamar.ca/freight-forwarding',
      targetKeywords: ['toronto freight', 'customs clearance ontario'],
      priority: 'P0',
    })

    expect(task.squadSlug).toBe('viamar-mcpwp')
    expect(task.priority).toBe('P0')
    expect(task.title).toBe('[MCPWP-SEO] Inject High-Intent Freight Meta Tags')
    expect(task.doneWhen).toContain('wp_get_posts/wp_get_pages')
    expect(task.doneWhen).toContain('HTTP and verify')
    expect(task.body).toContain('toronto freight')
    expect(task.suggestedGateOwner).toBe('gate:viamar-gate')
  })

  it('formats an mcpwp-store WooCommerce task', () => {
    const task = formatClientIntakeTask({
      clientSlug: 'techparts',
      servicePackage: 'mcpwp-store',
      title: 'Update Summer Sale Pricing',
      description: 'Apply 15% discount across GPU categories.',
      targetUrl: 'https://techparts.com/store',
    })

    expect(task.squadSlug).toBe('techparts-mcpwp')
    expect(task.doneWhen).toContain('wc_update_product')
  })
})

describe('Stripe Execution Metering & Receipts', () => {
  it('formats execution line items with appropriate margin and minimums', () => {
    const receipt = formatStripeMeteringReceipt({
      tenantSlug: 'viamar',
      clientName: 'Viamar Logistics',
      taskId: 'task-12345678-abcd',
      flightId: 'flight-999',
      servicePackage: 'mcpwp-seo',
      executorSeat: 'cursor-mupot-setup',
      costMicroUsd: 150000, // $0.15 compute cost
      modelTokens: { input: 25000, output: 1200 },
    })

    expect(receipt.tenantSlug).toBe('viamar')
    expect(receipt.rawComputeCostUsd).toBe('$0.1500')
    // 0.15 * 2.5 = 0.375 -> rounded cents = 38 cents -> minimum 50 cents applied
    expect(receipt.billedAmountCents).toBe(50)
    expect(receipt.billedAmountFormatted).toBe('$0.50')
    expect(receipt.tokenUsageSummary).toContain('26,200 tokens')
    expect(receipt.lineItemDescription).toContain('[Mumega Autonomous Service] MCPWP-SEO')
  })
})
