import { describe, expect, it } from 'vitest'
import type { Capability, CapabilityGrant, CapabilityScopeType } from '../src/types'
import {
  carriesOrgAdmin,
  highestCapability,
  isElevated,
  referencedScopeIds,
  scopeLabel,
  searchHaystack,
  summarizeGrants,
  type ScopeNames,
} from '../src/mcp/consent-view'

const SQUAD_A = '3674d955-067f-4821-86a0-c2fa03e30ff9'
const SQUAD_B = '813ca010-87db-43ff-8422-bada52f255f9'
const DEPT_A = 'eb8a9ed8-0f1f-48dd-bd84-429ebda02a9f'

const names: ScopeNames = {
  squads: new Map([
    [SQUAD_A, 'hadi-mac'],
    [SQUAD_B, 'mumega hq'],
    ['squad-core', 'Core Platform'],
  ]),
  departments: new Map([[DEPT_A, 'Delivery']]),
  org: 'mumega',
}

function grant(scope_type: CapabilityScopeType, scope_id: string | null, capability: Capability): CapabilityGrant {
  return { member_id: 'm1', scope_type, scope_id, capability }
}

describe('elevation — which tiers can grant, revoke and provision', () => {
  it('treats admin and owner as elevated', () => {
    expect(isElevated('admin')).toBe(true)
    expect(isElevated('owner')).toBe(true)
  })

  it('does not treat lead as elevated, however senior it sounds', () => {
    expect(isElevated('lead')).toBe(false)
    expect(isElevated('member')).toBe(false)
    expect(isElevated('observer')).toBe(false)
  })
})

describe('organisation admin — the fact most worth a badge', () => {
  it('detects an org-wide admin grant', () => {
    expect(carriesOrgAdmin([grant('org', 'mumega', 'admin')])).toBe(true)
  })

  it('detects org-wide owner, the tier above admin', () => {
    expect(carriesOrgAdmin([grant('org', 'mumega', 'owner')])).toBe(true)
  })

  it('does not fire on squad admin, which is not organisation-wide', () => {
    expect(carriesOrgAdmin([grant('squad', SQUAD_A, 'admin')])).toBe(false)
  })

  it('does not fire on org-wide member, which is wide but not elevated', () => {
    expect(carriesOrgAdmin([grant('org', 'mumega', 'member')])).toBe(false)
  })

  it('finds it even when buried among many lesser grants', () => {
    expect(
      carriesOrgAdmin([
        grant('squad', SQUAD_A, 'lead'),
        grant('squad', SQUAD_B, 'member'),
        grant('squad', 'squad-core', 'lead'),
        grant('org', 'mumega', 'admin'),
        grant('squad', DEPT_A, 'member'),
      ]),
    ).toBe(true)
  })

  it('returns false for a session carrying nothing', () => {
    expect(carriesOrgAdmin([])).toBe(false)
  })
})

describe('highest capability', () => {
  it('picks owner over admin', () => {
    expect(highestCapability([grant('squad', SQUAD_A, 'admin'), grant('org', null, 'owner')])).toBe('owner')
  })

  it('picks admin over lead regardless of order', () => {
    expect(highestCapability([grant('squad', SQUAD_A, 'admin'), grant('squad', SQUAD_B, 'lead')])).toBe('admin')
    expect(highestCapability([grant('squad', SQUAD_B, 'lead'), grant('squad', SQUAD_A, 'admin')])).toBe('admin')
  })

  it('returns null for no grants', () => {
    expect(highestCapability([])).toBeNull()
  })
})

describe('scope labels — consent against an identifier is not informed consent', () => {
  it('names a squad', () => {
    expect(scopeLabel(grant('squad', SQUAD_A, 'lead'), names)).toBe('hadi-mac')
  })

  it('names a department', () => {
    expect(scopeLabel(grant('department', DEPT_A, 'member'), names)).toBe('Delivery')
  })

  it('names the organisation for an org grant', () => {
    expect(scopeLabel(grant('org', 'mumega', 'admin'), names)).toBe('mumega')
  })

  it('names the organisation even when the org grant carries no scope id', () => {
    expect(scopeLabel(grant('org', null, 'admin'), names)).toBe('mumega')
  })

  it('falls back to the raw id rather than hiding an unnamed grant', () => {
    const unknown = 'ab6d4495-0648-4929-81e9-791455a2f738'
    expect(scopeLabel(grant('squad', unknown, 'admin'), names)).toBe(unknown)
  })

  it('does not resolve a department id through the squad table', () => {
    expect(scopeLabel(grant('squad', DEPT_A, 'member'), names)).toBe(DEPT_A)
  })
})

describe('grant summary — every grant kept, ordered so the dangerous one reads first', () => {
  const realWorld = [
    grant('squad', SQUAD_A, 'lead'),
    grant('squad', SQUAD_B, 'member'),
    grant('squad', 'squad-core', 'lead'),
    grant('org', 'mumega', 'admin'),
  ]

  it('puts the most powerful tier first', () => {
    expect(summarizeGrants(realWorld, names).map((g) => g.capability)).toEqual(['admin', 'lead', 'member'])
  })

  it('loses no scope — every grant still appears exactly once', () => {
    const total = summarizeGrants(realWorld, names).reduce((n, g) => n + g.scopes.length, 0)
    expect(total).toBe(realWorld.length)
  })

  it('groups repeated tiers together with their scopes named', () => {
    const lead = summarizeGrants(realWorld, names).find((g) => g.capability === 'lead')
    expect(lead?.scopes).toEqual(['hadi-mac', 'Core Platform'])
  })

  it('marks the elevated group and the org-wide group', () => {
    const admin = summarizeGrants(realWorld, names).find((g) => g.capability === 'admin')
    expect(admin?.elevated).toBe(true)
    expect(admin?.orgWide).toBe(true)
  })

  it('does not mark a squad-scoped admin as org-wide', () => {
    const [group] = summarizeGrants([grant('squad', SQUAD_A, 'admin')], names)
    expect(group.elevated).toBe(true)
    expect(group.orgWide).toBe(false)
  })

  it('returns nothing for a session carrying nothing', () => {
    expect(summarizeGrants([], names)).toEqual([])
  })

  it('orders every tier correctly when all five are present', () => {
    const all = (['observer', 'member', 'lead', 'admin', 'owner'] as Capability[]).map((c) =>
      grant('squad', SQUAD_A, c),
    )
    expect(summarizeGrants(all, names).map((g) => g.capability)).toEqual([
      'owner',
      'admin',
      'lead',
      'member',
      'observer',
    ])
  })
})

describe('referenced scope ids — name only what is shown', () => {
  it('separates squads from departments and drops nulls', () => {
    expect(
      referencedScopeIds([
        grant('squad', SQUAD_A, 'lead'),
        grant('squad', SQUAD_A, 'member'),
        grant('department', DEPT_A, 'member'),
        grant('org', null, 'admin'),
      ]),
    ).toEqual({ squads: [SQUAD_A], departments: [DEPT_A] })
  })

  it('returns empty lists for no grants', () => {
    expect(referencedScopeIds([])).toEqual({ squads: [], departments: [] })
  })
})

describe('search haystack — what typing into the filter can find', () => {
  const hay = searchHaystack({
    name: 'hadi-grok-desktop',
    slug: 'hadi-grok-desktop',
    squad_name: 'hadi-mac',
    grants: [grant('org', 'mumega', 'admin'), grant('squad', SQUAD_B, 'member')],
    names,
  })

  it('matches on the display name', () => {
    expect(hay).toContain('hadi-grok-desktop')
  })

  it('matches on a squad the seat carries capability on, not just its home squad', () => {
    expect(hay).toContain('mumega hq')
  })

  it('matches on a capability word, so "admin" finds the dangerous seats', () => {
    expect(hay).toContain('admin')
  })

  // This assertion was originally `expect(hay).toBe(hay.toLowerCase())`, which is
  // self-referential: with all-lowercase fixtures it holds whether or not the
  // code lowercases anything, and deleting the .toLowerCase() call left it green.
  // A mutation caught it. The fixture now carries capitals so the behaviour is
  // observable.
  it('lower-cases mixed-case content so matching does not depend on how the user types', () => {
    const mixed = searchHaystack({
      name: 'Hadi GROK Desktop',
      slug: 'Hadi-Grok-Desktop',
      squad_name: 'Core Platform',
      grants: [grant('org', 'mumega', 'admin')],
      names: { ...names, org: 'Mumega' },
    })
    expect(mixed).toContain('hadi grok desktop')
    expect(mixed).toContain('core platform')
    expect(mixed).toContain('mumega')
    expect(mixed).not.toContain('GROK')
    expect(mixed).not.toContain('Core Platform')
  })

  it('never contains a raw scope id once that scope has a name', () => {
    expect(hay).not.toContain(SQUAD_B)
  })
})
