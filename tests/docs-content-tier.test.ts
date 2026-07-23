/**
 * Docs content-tier keystone tests.
 *
 * Proves: a human session and an agent mupot token with IDENTICAL claims get
 * IDENTICAL visibility across all 6 tiers, via the SAME checkContentTier path.
 * No parallel agent-RBAC.
 */

import { describe, expect, it } from 'vitest'
import {
  checkContentTier,
  claimsFromAgentToken,
  claimsFromHumanSession,
  type ContentTier,
  type ContentTierContext,
  type TierClaims,
} from '../src/docs/content-tier'

// ── fixtures ─────────────────────────────────────────────────────────────────

const IDENTICAL_CLAIM_BAG = {
  user_id: 'principal-1',
  role: 'member',
  squad_id: 'squad-1',
  project_id: 'proj-1',
  entity_id: 'org-123',
} as const

function humanClaims(overrides: Partial<TierClaims>): TierClaims {
  return claimsFromHumanSession({
    identityId: IDENTICAL_CLAIM_BAG.user_id,
    role: IDENTICAL_CLAIM_BAG.role,
    squad_id: IDENTICAL_CLAIM_BAG.squad_id,
    project_id: IDENTICAL_CLAIM_BAG.project_id,
    entity_id: IDENTICAL_CLAIM_BAG.entity_id,
    ...overrides,
  })
}

function agentClaims(overrides: Partial<TierClaims>): TierClaims {
  return claimsFromAgentToken({
    agent_id: IDENTICAL_CLAIM_BAG.user_id,
    role: IDENTICAL_CLAIM_BAG.role,
    squad_id: IDENTICAL_CLAIM_BAG.squad_id,
    project_id: IDENTICAL_CLAIM_BAG.project_id,
    entity_id: IDENTICAL_CLAIM_BAG.entity_id,
    capabilities: ['docs:read'],
    ...overrides,
  })
}

function ctxForTier(tier: ContentTier): ContentTierContext {
  switch (tier) {
    case 'public':
      return { tier: 'public' }
    case 'squad':
      return { tier: 'squad' }
    case 'project':
      return { tier: 'project' }
    case 'role':
      return { tier: 'role' }
    case 'entity':
      return { tier: 'entity', entity_id: 'org-123' }
    case 'private':
      return { tier: 'private', created_by: 'principal-1' }
    default: {
      const _exhaustive: never = tier
      throw new Error(`unknown tier ${_exhaustive}`)
    }
  }
}

const ALL_TIERS: ContentTier[] = ['public', 'squad', 'project', 'role', 'entity', 'private']

// ── claim normalizers ────────────────────────────────────────────────────────

describe('claimsFromHumanSession / claimsFromAgentToken', () => {
  it('maps identityId and agent_id onto the same user_id field', () => {
    const human = claimsFromHumanSession({ identityId: 'x', role: 'admin' })
    const agent = claimsFromAgentToken({ agent_id: 'x', role: 'admin' })
    expect(human.user_id).toBe('x')
    expect(agent.user_id).toBe('x')
    expect(human.role).toBe(agent.role)
  })

  it('prefers explicit user_id over identityId / agent_id', () => {
    expect(claimsFromHumanSession({ identityId: 'a', user_id: 'b' }).user_id).toBe('b')
    expect(claimsFromAgentToken({ agent_id: 'a', user_id: 'b' }).user_id).toBe('b')
  })
})

// ── keystone: identical claims → identical visibility ────────────────────────

describe('keystone: human and agent with identical claims', () => {
  it('yield identical visibility across all 6 tiers', () => {
    const human = humanClaims({})
    const agent = agentClaims({})

    // Claim bags match on every field the gate reads (capabilities ignored)
    expect(human.user_id).toBe(agent.user_id)
    expect(human.role).toBe(agent.role)
    expect(human.squad_id).toBe(agent.squad_id)
    expect(human.project_id).toBe(agent.project_id)
    expect(human.entity_id).toBe(agent.entity_id)

    for (const tier of ALL_TIERS) {
      const ctx = ctxForTier(tier)
      const humanResult = checkContentTier(ctx, human)
      const agentResult = checkContentTier(ctx, agent)
      expect(agentResult).toEqual(humanResult)
      expect(humanResult.allowed).toBe(true)
    }
  })

  it('yield identical denials when claims are insufficient', () => {
    const human = humanClaims({
      squad_id: undefined,
      project_id: undefined,
      role: undefined,
      entity_id: 'other',
      user_id: 'other',
    })
    const agent = agentClaims({
      squad_id: undefined,
      project_id: undefined,
      role: undefined,
      entity_id: 'other',
      user_id: 'other',
    })

    for (const tier of ALL_TIERS) {
      if (tier === 'public') continue
      const ctx = ctxForTier(tier)
      expect(checkContentTier(ctx, agent)).toEqual(checkContentTier(ctx, human))
      expect(checkContentTier(ctx, human).allowed).toBe(false)
    }
  })

  it('enforce permitted_roles identically for both principals', () => {
    const ctx: ContentTierContext = {
      tier: 'project',
      permitted_roles: ['admin', 'owner'],
    }
    const humanOk = humanClaims({ role: 'admin' })
    const agentOk = agentClaims({ role: 'admin' })
    const humanNo = humanClaims({ role: 'member' })
    const agentNo = agentClaims({ role: 'member' })

    expect(checkContentTier(ctx, humanOk)).toEqual(checkContentTier(ctx, agentOk))
    expect(checkContentTier(ctx, humanOk).allowed).toBe(true)
    expect(checkContentTier(ctx, humanNo)).toEqual(checkContentTier(ctx, agentNo))
    expect(checkContentTier(ctx, humanNo)).toEqual({
      allowed: false,
      reason: 'role_not_permitted',
    })
  })

  it('enforce entity_id claim-match identically for both principals', () => {
    const ctx: ContentTierContext = { tier: 'entity', entity_id: 'org-123' }
    const matchHuman = humanClaims({ entity_id: 'org-123' })
    const matchAgent = agentClaims({ entity_id: 'org-123' })
    const missHuman = humanClaims({ entity_id: 'org-other' })
    const missAgent = agentClaims({ entity_id: 'org-other' })

    expect(checkContentTier(ctx, matchHuman)).toEqual(checkContentTier(ctx, matchAgent))
    expect(checkContentTier(ctx, matchHuman).allowed).toBe(true)
    expect(checkContentTier(ctx, missHuman)).toEqual(checkContentTier(ctx, missAgent))
    expect(checkContentTier(ctx, missHuman)).toEqual({
      allowed: false,
      reason: 'entity_id_mismatch',
    })
  })
})

// ── per-tier behaviour (shared path) ─────────────────────────────────────────

describe('tier: public', () => {
  it('allows with no claims', () => {
    expect(checkContentTier({ tier: 'public' }, null).allowed).toBe(true)
  })

  it('still enforces permitted_roles when set', () => {
    const ctx: ContentTierContext = { tier: 'public', permitted_roles: ['admin'] }
    expect(checkContentTier(ctx, null)).toEqual({
      allowed: false,
      reason: 'role_not_permitted',
    })
    expect(checkContentTier(ctx, humanClaims({ role: 'admin' })).allowed).toBe(true)
  })
})

describe('tier: squad', () => {
  it('denies unauthenticated and missing squad_id', () => {
    expect(checkContentTier({ tier: 'squad' }, null).reason).toBe('unauthenticated')
    expect(
      checkContentTier({ tier: 'squad' }, humanClaims({ squad_id: undefined })).reason,
    ).toBe('missing_squad_membership')
  })

  it('allows with squad_id', () => {
    expect(checkContentTier({ tier: 'squad' }, humanClaims({})).allowed).toBe(true)
  })
})

describe('tier: project', () => {
  it('denies unauthenticated and missing project_id', () => {
    expect(checkContentTier({ tier: 'project' }, null).reason).toBe('unauthenticated')
    expect(
      checkContentTier({ tier: 'project' }, humanClaims({ project_id: undefined })).reason,
    ).toBe('missing_project_membership')
  })

  it('allows with project_id', () => {
    expect(checkContentTier({ tier: 'project' }, humanClaims({})).allowed).toBe(true)
  })
})

describe('tier: role', () => {
  it('denies unauthenticated and missing role', () => {
    expect(checkContentTier({ tier: 'role' }, null).reason).toBe('unauthenticated')
    expect(checkContentTier({ tier: 'role' }, humanClaims({ role: undefined })).reason).toBe(
      'missing_role',
    )
  })

  it('allows with any role; permitted_roles further restricts', () => {
    expect(checkContentTier({ tier: 'role' }, humanClaims({ role: 'member' })).allowed).toBe(
      true,
    )
    const restricted: ContentTierContext = {
      tier: 'role',
      permitted_roles: ['admin'],
    }
    expect(checkContentTier(restricted, humanClaims({ role: 'member' })).reason).toBe(
      'role_not_permitted',
    )
    expect(checkContentTier(restricted, humanClaims({ role: 'admin' })).allowed).toBe(true)
  })
})

describe('tier: entity', () => {
  it('requires content entity_id and exact claim match', () => {
    expect(
      checkContentTier({ tier: 'entity' }, humanClaims({})).reason,
    ).toBe('content_missing_entity_id')
    expect(
      checkContentTier(
        { tier: 'entity', entity_id: 'org-123' },
        humanClaims({ entity_id: 'other' }),
      ).reason,
    ).toBe('entity_id_mismatch')
    expect(
      checkContentTier(
        { tier: 'entity', entity_id: 'org-123' },
        humanClaims({ entity_id: 'org-123' }),
      ).allowed,
    ).toBe(true)
  })
})

describe('tier: private', () => {
  it('requires created_by and user_id match', () => {
    expect(checkContentTier({ tier: 'private' }, humanClaims({})).reason).toBe(
      'content_missing_created_by',
    )
    expect(
      checkContentTier(
        { tier: 'private', created_by: 'principal-1' },
        humanClaims({ user_id: 'other' }),
      ).reason,
    ).toBe('not_creator')
    expect(
      checkContentTier(
        { tier: 'private', created_by: 'principal-1' },
        humanClaims({ user_id: 'principal-1' }),
      ).allowed,
    ).toBe(true)
  })
})

describe('permitted_roles filter', () => {
  it('empty array does not restrict', () => {
    expect(
      checkContentTier({ tier: 'public', permitted_roles: [] }, null).allowed,
    ).toBe(true)
  })

  it('combined entity match + permitted_roles for both principals', () => {
    const ctx: ContentTierContext = {
      tier: 'entity',
      entity_id: 'org-123',
      permitted_roles: ['admin'],
    }
    expect(
      checkContentTier(ctx, humanClaims({ entity_id: 'org-123', role: 'admin' })),
    ).toEqual(
      checkContentTier(ctx, agentClaims({ entity_id: 'org-123', role: 'admin' })),
    )
    expect(
      checkContentTier(ctx, humanClaims({ entity_id: 'org-123', role: 'admin' })).allowed,
    ).toBe(true)
    expect(
      checkContentTier(ctx, agentClaims({ entity_id: 'org-123', role: 'member' })).reason,
    ).toBe('role_not_permitted')
  })
})
