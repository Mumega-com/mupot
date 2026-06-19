// Tests for the reseller provisioning PLANNER (src/reseller/provision.ts).
// Pure function — no env, no I/O. Asserts the recipe shape, every validation branch,
// determinism, and that the agency template's squads + the service catalog flow through.

import { describe, it, expect } from 'vitest'
import {
  planResellerTenant,
  DEFAULT_PLATFORM_FEE_PCT,
  MAX_PLATFORM_FEE_PCT,
  DEFAULT_RESELLER_TIER,
} from '../src/reseller/provision'
import { AgencyModule } from '../src/departments/modules/agency'
import { SERVICE_CATALOG } from '../src/services/catalog'

describe('planResellerTenant — happy path', () => {
  it('builds the full recipe from just a domain', () => {
    const r = planResellerTenant({ resellerDomain: 'digitalmarketingexperts.ca' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.planVersion).toBe('1')
    expect(r.mode).toBe('dry-run')
    expect(r.slug).toBe('digitalmarketingexperts')
    expect(r.domain).toBe('digitalmarketingexperts.ca')
    expect(r.tier).toBe(DEFAULT_RESELLER_TIER)
    // department + squads come straight from the agency manifest
    expect(r.department.key).toBe(AgencyModule.key)
    expect(r.department.squads.map((s) => s.slug)).toEqual(AgencyModule.defaultSquads.map((s) => s.slug))
    // default basket = the whole catalog
    expect(r.catalog.map((o) => o.key)).toEqual(SERVICE_CATALOG.map((o) => o.key))
    expect(r.billing).toEqual({ model: 'stripe_connect', applicationFeePercent: DEFAULT_PLATFORM_FEE_PCT })
    expect(r.ghl).toEqual({ provider: 'ghl', connectorRef: null })
    expect(r.ownerWalk.url).toBe('https://digitalmarketingexperts.mupot.mumega.com/setup')
    expect(r.execute.opsRequired.length).toBeGreaterThan(0)
    expect(r.summary.length).toBeGreaterThan(0)
  })

  it('normalizes a messy domain (scheme/www/path/port/trailing dot/userinfo)', () => {
    const r = planResellerTenant({ resellerDomain: 'HTTPS://user@www.Eztek.ca:8080/path?q=1#x.' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.domain).toBe('eztek.ca')
    expect(r.slug).toBe('eztek')
  })

  it('honours an explicit slug override (sanitized)', () => {
    const r = planResellerTenant({ resellerDomain: 'example.com', slug: 'My Cool Pot!!' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.slug).toBe('my-cool-pot')
  })

  it('restricts the basket to requested services', () => {
    const r = planResellerTenant({ resellerDomain: 'example.com', services: ['aeo', 'seo'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.catalog.map((o) => o.key)).toEqual(['aeo', 'seo'])
  })

  it('accepts a valid GHL ref and a custom fee', () => {
    const r = planResellerTenant({ resellerDomain: 'example.com', ghlConnectorRef: 'loc_ABC-123', applicationFeePercent: 20 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ghl.connectorRef).toBe('loc_ABC-123')
    expect(r.billing.applicationFeePercent).toBe(20)
  })

  it('accepts the scale tier', () => {
    const r = planResellerTenant({ resellerDomain: 'example.com', tier: 'scale' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tier).toBe('scale')
  })
})

describe('planResellerTenant — validation (fail-closed)', () => {
  it('rejects a non-object input', () => {
    // @ts-expect-error — deliberately wrong type at the boundary
    const r = planResellerTenant(null)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid_input')
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['no tld', 'localhost'],
    ['ipv4', '127.0.0.1'],
    ['internal tld', 'box.internal'],
    ['.local', 'printer.local'],
    ['numeric tld', 'foo.123'],
    ['space inside', 'bad domain.com'],
    ['underscore label', 'a_b.com'],
  ])('rejects invalid domain: %s', (_label, domain) => {
    const r = planResellerTenant({ resellerDomain: domain })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid_domain')
  })

  it('rejects a slug that sanitizes to empty', () => {
    const r = planResellerTenant({ resellerDomain: 'example.com', slug: '!!!' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid_slug')
  })

  it.each(['free', 'starter'] as const)('rejects tier_too_low: %s', (tier) => {
    const r = planResellerTenant({ resellerDomain: 'example.com', tier })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('tier_too_low')
  })

  it('coerces an unknown tier to free → tier_too_low', () => {
    // @ts-expect-error — invalid tier at the boundary
    const r = planResellerTenant({ resellerDomain: 'example.com', tier: 'enterprise' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('tier_too_low')
  })

  it('rejects an unknown service key', () => {
    const r = planResellerTenant({ resellerDomain: 'example.com', services: ['aeo', 'nope'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('unknown_service')
  })

  it('rejects a non-array services', () => {
    // @ts-expect-error — wrong type at the boundary
    const r = planResellerTenant({ resellerDomain: 'example.com', services: 'aeo' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid_input')
  })

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['over cap', MAX_PLATFORM_FEE_PCT + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects invalid fee: %s', (_label, fee) => {
    const r = planResellerTenant({ resellerDomain: 'example.com', applicationFeePercent: fee })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid_fee')
  })

  it('accepts a fee exactly at the cap', () => {
    const r = planResellerTenant({ resellerDomain: 'example.com', applicationFeePercent: MAX_PLATFORM_FEE_PCT })
    expect(r.ok).toBe(true)
  })

  it.each([
    ['too long', 'x'.repeat(129)],
    ['bad char', 'loc abc'],
    ['slash', 'loc/abc'],
    ['empty', ''],
  ])('rejects invalid ghl ref: %s', (_label, ref) => {
    const r = planResellerTenant({ resellerDomain: 'example.com', ghlConnectorRef: ref })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('invalid_ghl_ref')
  })
})

describe('planResellerTenant — determinism & purity', () => {
  it('same input → deep-equal output (no clock/randomness)', () => {
    const input = { resellerDomain: 'eztek.ca', services: ['aeo', 'seo'], applicationFeePercent: 12 }
    const a = planResellerTenant(input)
    const b = planResellerTenant(input)
    expect(a).toEqual(b)
  })

  it('does not mutate the agency manifest or catalog', () => {
    const squadsBefore = AgencyModule.defaultSquads.length
    const catBefore = SERVICE_CATALOG.length
    planResellerTenant({ resellerDomain: 'example.com' })
    expect(AgencyModule.defaultSquads.length).toBe(squadsBefore)
    expect(SERVICE_CATALOG.length).toBe(catBefore)
  })

  it('returned plan OWNS its data — mutating nested tiers cannot corrupt the shared catalog or a later call', () => {
    const a = planResellerTenant({ resellerDomain: 'example.com' })
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const globalBefore = SERVICE_CATALOG[0].tiers[0].monthlyCents
    // hostile caller mutates the plan's nested tier object + array
    a.catalog[0].tiers[0].monthlyCents = 999_999_999
    a.catalog[0].tiers.push({ key: 'evil', name: 'evil', monthlyCents: 0 })
    // the shared singleton is untouched
    expect(SERVICE_CATALOG[0].tiers[0].monthlyCents).toBe(globalBefore)
    expect(SERVICE_CATALOG[0].tiers.some((t) => t.key === 'evil')).toBe(false)
    // and a fresh call is uncorrupted
    const b = planResellerTenant({ resellerDomain: 'example.com' })
    if (!b.ok) return
    expect(b.catalog[0].tiers[0].monthlyCents).toBe(globalBefore)
    expect(b.catalog[0].tiers.some((t) => t.key === 'evil')).toBe(false)
  })

  it('plan squads do not alias the agency manifest squads', () => {
    const a = planResellerTenant({ resellerDomain: 'example.com' })
    if (!a.ok) return
    expect(a.department.squads[0]).not.toBe(AgencyModule.defaultSquads[0])
  })
})
