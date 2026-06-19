// tests/services-catalog.test.ts — the priced service basket + its console view.

import { describe, it, expect } from 'vitest'
import {
  SERVICE_CATALOG,
  formatCents,
  formatTierPrice,
  catalogSize,
  type ServiceTier,
} from '../src/services/catalog'
import { servicesBody } from '../src/dashboard/services'

describe('SERVICE_CATALOG (the basket)', () => {
  it('has the five offerings, each delivered by a squad/skill with ≥1 tier', () => {
    expect(SERVICE_CATALOG.map((s) => s.key)).toEqual(['aeo', 'seo', 'ads', 'content', 'fast-mvp'])
    expect(catalogSize()).toBe(5)
    for (const svc of SERVICE_CATALOG) {
      expect(svc.name.length).toBeGreaterThan(0)
      expect(svc.deliveredBy.length).toBeGreaterThan(0)
      expect(svc.tiers.length).toBeGreaterThan(0)
    }
  })

  it('every price is a non-negative integer number of cents (no float-rounding traps)', () => {
    for (const svc of SERVICE_CATALOG) {
      for (const t of svc.tiers) {
        expect(Number.isInteger(t.monthlyCents) && t.monthlyCents >= 0).toBe(true)
        if (t.setupCents !== undefined) {
          expect(Number.isInteger(t.setupCents) && t.setupCents >= 0).toBe(true)
        }
      }
    }
  })
})

describe('price formatting', () => {
  it('formatCents — whole dollars, thousands separator, $0 floor', () => {
    expect(formatCents(29900)).toBe('$299')
    expect(formatCents(750000)).toBe('$7,500')
    expect(formatCents(0)).toBe('$0')
    expect(formatCents(-5)).toBe('$0')
    expect(formatCents(29950)).toBe('$299.50') // non-integer dollars keep 2dp
  })

  it('formatTierPrice — monthly, setup, both, and Custom', () => {
    expect(formatTierPrice({ key: 'a', name: 'A', monthlyCents: 29900 } as ServiceTier)).toBe('$299/mo')
    expect(formatTierPrice({ key: 'b', name: 'B', monthlyCents: 0, setupCents: 750000 } as ServiceTier)).toBe('$7,500 setup')
    expect(
      formatTierPrice({ key: 'c', name: 'C', monthlyCents: 200000, setupCents: 7500000 } as ServiceTier),
    ).toBe('$75,000 setup + $2,000/mo')
    expect(formatTierPrice({ key: 'd', name: 'D', monthlyCents: 0 } as ServiceTier)).toBe('Custom')
  })
})

describe('servicesBody (console view)', () => {
  it('renders the offerings, draft-pricing badge, and prices', () => {
    const out = String(servicesBody())
    expect(out).toContain('AEO')
    expect(out).toContain('Fast MVP')
    expect(out).toContain('DRAFT pricing') // honest about draft prices
    expect(out).toContain('$299/mo')
    expect(out).toContain('$75,000 setup + $2,000/mo')
    expect(out).toContain('fulfilled by: aeo') // ties each service to its squad
  })
})
