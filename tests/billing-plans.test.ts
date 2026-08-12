// billing-plans.test.ts — pure entitlement gate (no I/O).
import { describe, it, expect } from 'vitest'
import {
  coerceTier,
  entitled,
  entitlementFor,
  isPotTier,
  withinLimit,
  POT_FEATURES,
  PLAN_LIMITS,
} from '../src/billing/plans'

describe('pot tier coercion (fail-closed)', () => {
  it('accepts known tiers', () => {
    expect(coerceTier('pro')).toBe('pro')
    expect(isPotTier('scale')).toBe(true)
  })
  it('coerces unknown/garbage to free', () => {
    expect(coerceTier('enterprise')).toBe('free') // not a pot tier
    expect(coerceTier(null)).toBe('free')
    expect(coerceTier(undefined)).toBe('free')
    expect(coerceTier(42)).toBe('free')
    expect(isPotTier('nope')).toBe(false)
  })
})

describe('feature entitlement by tier', () => {
  it('free unlocks nothing gated above it', () => {
    expect(entitled('free', 'byo_model')).toBe(false)
    expect(entitled('free', 'byo_brain')).toBe(false)
    expect(entitled('free', 'sso')).toBe(false)
  })
  it('starter unlocks starter-min features, not pro/scale', () => {
    expect(entitled('starter', 'byo_model')).toBe(true)
    expect(entitled('starter', 'extra_channels')).toBe(true)
    expect(entitled('starter', 'byo_brain')).toBe(false)
    expect(entitled('starter', 'audit_export')).toBe(false)
  })
  it('pro unlocks pro-min, not scale-only', () => {
    expect(entitled('pro', 'byo_brain')).toBe(true)
    expect(entitled('pro', 'github_paid')).toBe(true)
    expect(entitled('pro', 'sso')).toBe(false)
  })
  it('scale unlocks everything', () => {
    for (const f of Object.keys(POT_FEATURES) as Array<keyof typeof POT_FEATURES>) {
      expect(entitled('scale', f)).toBe(true)
    }
  })
})

describe('numeric limits', () => {
  it('enforces free ceilings', () => {
    expect(withinLimit('free', 'maxAgents', 2)).toBe(true)
    expect(withinLimit('free', 'maxAgents', 3)).toBe(false)
    expect(withinLimit('free', 'maxSquads', 1)).toBe(true)
    expect(withinLimit('free', 'maxSquads', 2)).toBe(false)
  })
  it('treats -1 ceiling (scale) as unlimited', () => {
    expect(withinLimit('scale', 'maxAgents', 9_999)).toBe(true)
    expect(withinLimit('scale', 'monthlyModelBudgetMicroUsd', Number.MAX_SAFE_INTEGER)).toBe(true)
  })
  // mupot#925 P0-N1: maxDepartments did not exist before this — createDepartment
  // had no gate at all. Values follow the same ~2-squads-per-department ratio
  // maxSquads already implies (see the PLAN_LIMITS doc comment).
  it('maxDepartments ceilings ascend with tier and follow the maxSquads ratio', () => {
    expect(withinLimit('free', 'maxDepartments', 1)).toBe(true)
    expect(withinLimit('free', 'maxDepartments', 2)).toBe(false)
    expect(withinLimit('starter', 'maxDepartments', 2)).toBe(true)
    expect(withinLimit('starter', 'maxDepartments', 3)).toBe(false)
    expect(withinLimit('pro', 'maxDepartments', 5)).toBe(true)
    expect(withinLimit('pro', 'maxDepartments', 6)).toBe(false)
    expect(withinLimit('scale', 'maxDepartments', 9_999)).toBe(true)
  })
})

describe('entitlement snapshot', () => {
  it('free snapshot has free limits + no gated features', () => {
    const e = entitlementFor('free')
    expect(e.tier).toBe('free')
    expect(e.limits.maxAgents).toBe(2)
    expect(e.features).toEqual([])
  })
  it('scale snapshot lists all features', () => {
    const e = entitlementFor('scale')
    expect(e.features.length).toBe(Object.keys(POT_FEATURES).length)
  })
})

describe('immutability — a snapshot cannot poison the catalog (Codex RED-1)', () => {
  it('mutating a snapshot does not change the catalog or gates', () => {
    const e = entitlementFor('free')
    e.limits.maxAgents = 999 // snapshot.limits is a copy — isolated
    expect(withinLimit('free', 'maxAgents', 3)).toBe(false) // catalog unchanged
    expect(entitlementFor('free').limits.maxAgents).toBe(2)
  })
  it('the catalog itself is frozen', () => {
    expect(Object.isFrozen(PLAN_LIMITS)).toBe(true)
    expect(Object.isFrozen(PLAN_LIMITS.free)).toBe(true)
    expect(Object.isFrozen(POT_FEATURES)).toBe(true)
    try {
      ;(PLAN_LIMITS.free as { maxAgents: number }).maxAgents = 999 // strict-mode throws; frozen
    } catch {
      /* expected in strict mode */
    }
    expect(PLAN_LIMITS.free.maxAgents).toBe(2)
  })
})
