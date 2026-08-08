/**
 * Block-level rbac text — server-side strip via :::tier / <Tier>.
 *
 * Proves a public viewer’s payload contains ONLY public blocks; private text
 * is absent (not client-hidden).
 */

import { describe, expect, it } from 'vitest'
import { claimsFromHumanSession } from '../src/docs/content-tier'
import {
  parseTierDirectiveAttrs,
  renderDocPayloadForClaims,
  stripTierBlocks,
  type TierBlockDefaults,
} from '../src/docs/strip-tier-blocks'

const EMPTY_DEFAULTS: TierBlockDefaults = {
  entity_id: undefined,
  created_by: undefined,
}

const DOC_DEFAULTS: TierBlockDefaults = {
  entity_id: 'org-1',
  created_by: 'author-1',
}

const MIXED_DOC = [
  '# Project brief',
  '',
  'This paragraph is public.',
  '',
  ':::tier{private}',
  'SECRET_PRIVATE_TOKEN_alpha',
  'More private detail.',
  ':::',
  '',
  'Public closing note.',
  '',
  '<Tier require="private">',
  'SECRET_PRIVATE_TOKEN_beta',
  '</Tier>',
  '',
  'Still public.',
  '',
].join('\n')

describe('parseTierDirectiveAttrs', () => {
  it('accepts bare tier name :::tier{squad}', () => {
    expect(parseTierDirectiveAttrs('squad')).toEqual({
      tier: 'squad',
      entity_id: undefined,
      created_by: undefined,
      permitted_roles: undefined,
    })
  })

  it('accepts require= / tier= keys and extra attrs', () => {
    expect(parseTierDirectiveAttrs('require=entity entity_id="org-9"')).toEqual({
      tier: 'entity',
      entity_id: 'org-9',
      created_by: undefined,
      permitted_roles: undefined,
    })
    expect(parseTierDirectiveAttrs('private created_by=alice permitted_roles="a,b"')).toEqual({
      tier: 'private',
      entity_id: undefined,
      created_by: 'alice',
      permitted_roles: ['a', 'b'],
    })
  })

  it('rejects unknown tiers', () => {
    expect(() => parseTierDirectiveAttrs('classified')).toThrow(/unknown tier/)
  })
})

describe('stripTierBlocks — public viewer vs mixed doc', () => {
  it('public viewer receives ONLY public blocks; private text absent from payload', () => {
    // Public viewer: no session claims (or claims that satisfy only public).
    const payload = renderDocPayloadForClaims(MIXED_DOC, {
      claims: null,
      defaults: DOC_DEFAULTS,
    })

    expect(payload).toContain('This paragraph is public.')
    expect(payload).toContain('Public closing note.')
    expect(payload).toContain('Still public.')
    expect(payload).toContain('# Project brief')

    // Private markers and secrets must not appear in the payload at all.
    expect(payload).not.toContain('SECRET_PRIVATE_TOKEN_alpha')
    expect(payload).not.toContain('SECRET_PRIVATE_TOKEN_beta')
    expect(payload).not.toContain('More private detail.')
    expect(payload).not.toContain(':::tier')
    expect(payload).not.toContain('<Tier')
    expect(payload).not.toContain('</Tier>')
  })

  it('creator with matching claims keeps private directive + JSX blocks', () => {
    const claims = claimsFromHumanSession({
      user_id: 'author-1',
    })
    const payload = stripTierBlocks(MIXED_DOC, {
      claims,
      defaults: DOC_DEFAULTS,
    })

    expect(payload).toContain('SECRET_PRIVATE_TOKEN_alpha')
    expect(payload).toContain('SECRET_PRIVATE_TOKEN_beta')
    expect(payload).toContain('This paragraph is public.')
    // Markers themselves are unwrap-stripped (body kept, fence removed).
    expect(payload).not.toContain(':::tier')
    expect(payload).not.toContain('<Tier')
  })

  it('strips squad blocks when viewer lacks squad_id', () => {
    const source = [
      'open',
      '',
      ':::tier{squad}',
      'SQUAD_ONLY',
      ':::',
      '',
      'end',
      '',
    ].join('\n')

    const denied = stripTierBlocks(source, {
      claims: claimsFromHumanSession({ user_id: 'u1' }),
      defaults: EMPTY_DEFAULTS,
    })
    expect(denied).toContain('open')
    expect(denied).toContain('end')
    expect(denied).not.toContain('SQUAD_ONLY')

    const allowed = stripTierBlocks(source, {
      claims: claimsFromHumanSession({ user_id: 'u1', squad_id: 's1' }),
      defaults: EMPTY_DEFAULTS,
    })
    expect(allowed).toContain('SQUAD_ONLY')
  })

  it('nests: outer kept, inner private stripped for public viewer', () => {
    const source = [
      ':::tier{public}',
      'outer-public',
      ':::tier{private}',
      'INNER_SECRET',
      ':::',
      'still-outer',
      ':::',
      '',
    ].join('\n')

    const payload = stripTierBlocks(source, {
      claims: null,
      defaults: DOC_DEFAULTS,
    })
    expect(payload).toContain('outer-public')
    expect(payload).toContain('still-outer')
    expect(payload).not.toContain('INNER_SECRET')
  })

  it('fail-closed: private block without created_by is stripped', () => {
    const source = ':::tier{private}\nNO_OWNER_SECRET\n:::\n'
    const payload = stripTierBlocks(source, {
      claims: claimsFromHumanSession({ user_id: 'anyone' }),
      defaults: EMPTY_DEFAULTS,
    })
    expect(payload).not.toContain('NO_OWNER_SECRET')
  })
})
