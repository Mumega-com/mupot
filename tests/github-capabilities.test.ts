// Tests for the GitHub feature capability gate (src/integrations/github-capabilities.ts).
//
// Acceptance criteria:
//   (1) featureEnabled: tier ladder respected (free < pro < team < enterprise)
//   (2) Enterprise-tagged features need BOTH the tier AND the kill switch on
//   (3) kill switch off → ALL enterprise features off regardless of tier
//   (4) enterpriseFeaturesEnabled: truthy parsing, default off
//   (5) resolveGitHubTier: connector meta → env → default 'free' (never assumes enterprise)
//   (6) githubCan: end-to-end async gate
//   (7) ENTERPRISE_FEATURES set matches the registry tags
//   (8) snapshot reflects per-feature enabled state

import { describe, it, expect } from 'vitest'
import {
  featureEnabled,
  enterpriseFeaturesEnabled,
  resolveGitHubTier,
  githubCan,
  githubCapabilitySnapshot,
  isGitHubTier,
  ENTERPRISE_FEATURES,
  GITHUB_FEATURES,
  type GitHubTier,
} from '../src/integrations/github-capabilities'
import type { Env } from '../src/types'

function envWith(overrides: Record<string, unknown> = {}, metaRow: { meta: string | null } | null = null): Env {
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => metaRow,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
  }
  return { TENANT_SLUG: 'cappot', DB: db, ...overrides } as unknown as Env
}

describe('featureEnabled (pure)', () => {
  it('respects the tier ladder for non-enterprise features', () => {
    // coding_agent_assign needs 'pro'
    expect(featureEnabled('free', 'coding_agent_assign', { enterpriseEnabled: false })).toBe(false)
    expect(featureEnabled('pro', 'coding_agent_assign', { enterpriseEnabled: false })).toBe(true)
    expect(featureEnabled('enterprise', 'coding_agent_assign', { enterpriseEnabled: false })).toBe(true)
  })

  it('base features work on any plan', () => {
    for (const tier of ['free', 'pro', 'team', 'enterprise'] as GitHubTier[]) {
      expect(featureEnabled(tier, 'issue_mirror', { enterpriseEnabled: false })).toBe(true)
      expect(featureEnabled(tier, 'app_token_mint', { enterpriseEnabled: false })).toBe(true)
    }
  })

  it('enterprise features need BOTH enterprise tier AND the kill switch on', () => {
    // Enterprise tier but kill switch OFF → still disabled.
    expect(featureEnabled('enterprise', 'org_mcp_allowlist', { enterpriseEnabled: false })).toBe(false)
    // Kill switch ON but tier too low → still disabled.
    expect(featureEnabled('team', 'org_mcp_allowlist', { enterpriseEnabled: true })).toBe(false)
    // Both satisfied → enabled.
    expect(featureEnabled('enterprise', 'org_mcp_allowlist', { enterpriseEnabled: true })).toBe(true)
  })

  it('kill switch off disables every enterprise feature regardless of tier', () => {
    for (const f of ENTERPRISE_FEATURES) {
      expect(featureEnabled('enterprise', f, { enterpriseEnabled: false })).toBe(false)
    }
  })

  it('unknown feature → false', () => {
    expect(featureEnabled('enterprise', 'nope' as never, { enterpriseEnabled: true })).toBe(false)
  })
})

describe('enterpriseFeaturesEnabled', () => {
  it('defaults OFF when unset', () => {
    expect(enterpriseFeaturesEnabled(envWith())).toBe(false)
  })
  it('parses truthy values case-insensitively', () => {
    for (const v of ['on', 'ON', 'true', '1', 'yes', ' Yes ']) {
      expect(enterpriseFeaturesEnabled(envWith({ GITHUB_ENTERPRISE_FEATURES: v }))).toBe(true)
    }
  })
  it('off for falsey/garbage', () => {
    for (const v of ['off', 'false', '0', 'no', '']) {
      expect(enterpriseFeaturesEnabled(envWith({ GITHUB_ENTERPRISE_FEATURES: v }))).toBe(false)
    }
  })
})

describe('resolveGitHubTier', () => {
  it('defaults to free (never assumes enterprise)', async () => {
    expect(await resolveGitHubTier(envWith())).toBe('free')
  })
  it('reads tier from connector meta', async () => {
    const env = envWith({}, { meta: JSON.stringify({ plan_tier: 'enterprise' }) })
    expect(await resolveGitHubTier(env)).toBe('enterprise')
  })
  it('falls back to GITHUB_PLAN_TIER env when no meta', async () => {
    expect(await resolveGitHubTier(envWith({ GITHUB_PLAN_TIER: 'team' }))).toBe('team')
  })
  it('ignores an invalid meta tier and falls through', async () => {
    const env = envWith({ GITHUB_PLAN_TIER: 'pro' }, { meta: JSON.stringify({ plan_tier: 'platinum' }) })
    expect(await resolveGitHubTier(env)).toBe('pro')
  })
  it('survives malformed meta JSON (fail-closed to default)', async () => {
    const env = envWith({}, { meta: '{not json' })
    expect(await resolveGitHubTier(env)).toBe('free')
  })
})

describe('githubCan (async end-to-end)', () => {
  it('enterprise feature off without kill switch, even on enterprise tier', async () => {
    const env = envWith({}, { meta: JSON.stringify({ plan_tier: 'enterprise' }) })
    expect(await githubCan(env, 'org_mcp_allowlist')).toBe(false)
  })
  it('enterprise feature on with tier + kill switch', async () => {
    const env = envWith(
      { GITHUB_ENTERPRISE_FEATURES: 'on' },
      { meta: JSON.stringify({ plan_tier: 'enterprise' }) },
    )
    expect(await githubCan(env, 'org_mcp_allowlist')).toBe(true)
  })
  it('base feature on for a free tenant', async () => {
    expect(await githubCan(envWith(), 'issue_mirror')).toBe(true)
  })
})

describe('registry integrity', () => {
  it('ENTERPRISE_FEATURES matches the enterprise tags in the registry', () => {
    const tagged = (Object.keys(GITHUB_FEATURES) as Array<keyof typeof GITHUB_FEATURES>).filter(
      (f) => GITHUB_FEATURES[f].enterprise,
    )
    expect(new Set(tagged)).toEqual(ENTERPRISE_FEATURES)
    // The three Enterprise-only features.
    expect(ENTERPRISE_FEATURES).toContain('org_mcp_allowlist')
    expect(ENTERPRISE_FEATURES).toContain('audit_log_stream')
    expect(ENTERPRISE_FEATURES).toContain('saml_sso')
  })
  it('isGitHubTier guards the tier set', () => {
    expect(isGitHubTier('enterprise')).toBe(true)
    expect(isGitHubTier('platinum')).toBe(false)
  })
})

describe('githubCapabilitySnapshot', () => {
  it('reports per-feature enabled state for a free tenant, kill switch off', async () => {
    const snap = await githubCapabilitySnapshot(envWith())
    expect(snap.tier).toBe('free')
    expect(snap.enterpriseEnabled).toBe(false)
    const mirror = snap.features.find((f) => f.feature === 'issue_mirror')
    const ent = snap.features.find((f) => f.feature === 'org_mcp_allowlist')
    expect(mirror?.enabled).toBe(true)
    expect(ent?.enabled).toBe(false)
    expect(ent?.enterprise).toBe(true)
  })
  it('lights up enterprise features for an enterprise tenant with the switch on', async () => {
    const env = envWith(
      { GITHUB_ENTERPRISE_FEATURES: '1' },
      { meta: JSON.stringify({ plan_tier: 'enterprise' }) },
    )
    const snap = await githubCapabilitySnapshot(env)
    expect(snap.tier).toBe('enterprise')
    expect(snap.enterpriseEnabled).toBe(true)
    expect(snap.features.every((f) => f.enabled)).toBe(true)
  })
})
