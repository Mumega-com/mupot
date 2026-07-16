// tests/cro-apply-proposer.test.ts — CRO apply-bridge (S5b).
//
// Unit coverage for proposeCroApply (departments/collectors/cro-apply.ts): the
// producer that turns a CRO change intent into a gated 'cro-apply' proposal.
// Mirrors tests/seo-meta-fix-proposer.test.ts's structure/discipline:
//
//   1. HARD-REFUSED change-types (layout/forms/offer/pricing/brand_voice) and any
//      unrecognized value throw CroApplyProposeError('change_type_refused') BEFORE
//      any gate record is persisted.
//   2. A structurally invalid intent (missing slug/value, or a substring change-type
//      missing findText) throws CroApplyProposeError('invalid_cro_apply_intent')
//      BEFORE any gate record is persisted.
//   3. requiredCapability='lead' (channels/seo-channel.ts cro-apply work-type) is
//      enforced — a 'member'-only ctx is denied.
//   4. AUTO-PROPOSABLE change-types round-trip through propose: gateId returned,
//      persisted payload carries mode:'cro-apply-merge', executor:'inkwell-content',
//      flagged:false.
//   5. FLAGGED change-types (body_copy, headline) round-trip too, with flagged:true
//      and a warning string persisted in the payload.

import { describe, it, expect } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'
import { proposeCroApply, CroApplyProposeError, type CroApplyIntent } from '../src/departments/collectors/cro-apply'
import { HARD_REFUSED_CHANGE_TYPES, AUTO_PROPOSABLE_CHANGE_TYPES, FLAGGED_CHANGE_TYPES } from '../src/departments/change-types'
import '../src/departments/modules/growth' // trigger GrowthModule registration

const TENANT = 'mumega'
let _idCtr = 0
const makeId = () => `cro-${++_idCtr}`

/** Minimal D1 stub: records every department_proposals INSERT it sees. */
function makeStubDb(): { db: D1Database; proposalInserts: unknown[][] } {
  const proposalInserts: unknown[][] = []
  const db = {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase()
      const args: unknown[] = []
      const stmt = {
        bind(...a: unknown[]) {
          args.push(...a)
          return stmt
        },
        async run() {
          if (upper.includes('INSERT') && upper.includes('DEPARTMENT_PROPOSALS')) {
            proposalInserts.push([...args])
          }
          return { success: true, meta: { changes: 1 } }
        },
        async all() {
          return { results: [], success: true }
        },
        async first() {
          return null
        },
      }
      return stmt
    },
    async batch() {
      return []
    },
  } as unknown as D1Database
  return { db, proposalInserts }
}

describe('proposeCroApply — change-type allowlist, refused BEFORE gate store', () => {
  for (const bad of HARD_REFUSED_CHANGE_TYPES) {
    it(`hard-refuses changeType '${bad}' — no gate record persisted`, async () => {
      const { db, proposalInserts } = makeStubDb()
      const intent = { slug: 's', changeType: bad, value: 'v' } as unknown as CroApplyIntent
      await expect(proposeCroApply({ db }, TENANT, intent, { idGen: makeId })).rejects.toMatchObject({
        reason: 'change_type_refused',
      })
      expect(proposalInserts.length).toBe(0)
    })
  }

  it('unrecognized/typo change-type is refused (allowlist, not denylist)', async () => {
    const { db, proposalInserts } = makeStubDb()
    const intent = { slug: 's', changeType: 'totally_made_up', value: 'v' } as unknown as CroApplyIntent
    await expect(proposeCroApply({ db }, TENANT, intent, { idGen: makeId })).rejects.toBeInstanceOf(CroApplyProposeError)
    expect(proposalInserts.length).toBe(0)
  })

  it('missing/undefined changeType is refused', async () => {
    const { db, proposalInserts } = makeStubDb()
    const intent = { slug: 's', value: 'v' } as unknown as CroApplyIntent
    await expect(proposeCroApply({ db }, TENANT, intent, { idGen: makeId })).rejects.toMatchObject({
      reason: 'change_type_refused',
    })
    expect(proposalInserts.length).toBe(0)
  })
})

describe('proposeCroApply — structural validation, fail-closed before propose', () => {
  it('missing slug → invalid_cro_apply_intent, no gate record persisted', async () => {
    const { db, proposalInserts } = makeStubDb()
    const intent = { changeType: 'meta_title', value: 'v' } as unknown as CroApplyIntent
    await expect(proposeCroApply({ db }, TENANT, intent, { idGen: makeId })).rejects.toMatchObject({
      reason: 'invalid_cro_apply_intent',
    })
    expect(proposalInserts.length).toBe(0)
  })

  it('empty-string slug → rejected, no gate record persisted', async () => {
    const { db, proposalInserts } = makeStubDb()
    const intent: CroApplyIntent = { slug: '', changeType: 'meta_title', value: 'v' }
    await expect(proposeCroApply({ db }, TENANT, intent, { idGen: makeId })).rejects.toBeInstanceOf(CroApplyProposeError)
    expect(proposalInserts.length).toBe(0)
  })

  it('missing value → invalid_cro_apply_intent, no gate record persisted', async () => {
    const { db, proposalInserts } = makeStubDb()
    const intent = { slug: 's', changeType: 'meta_description' } as unknown as CroApplyIntent
    await expect(proposeCroApply({ db }, TENANT, intent, { idGen: makeId })).rejects.toMatchObject({
      reason: 'invalid_cro_apply_intent',
    })
    expect(proposalInserts.length).toBe(0)
  })

  it('cta_text without findText → invalid_cro_apply_intent, no gate record persisted', async () => {
    const { db, proposalInserts } = makeStubDb()
    const intent: CroApplyIntent = { slug: 's', changeType: 'cta_text', value: 'new cta' }
    await expect(proposeCroApply({ db }, TENANT, intent, { idGen: makeId })).rejects.toMatchObject({
      reason: 'invalid_cro_apply_intent',
    })
    expect(proposalInserts.length).toBe(0)
  })

  it('internal_links without findText → invalid_cro_apply_intent, no gate record persisted', async () => {
    const { db, proposalInserts } = makeStubDb()
    const intent: CroApplyIntent = { slug: 's', changeType: 'internal_links', value: 'new link text' }
    await expect(proposeCroApply({ db }, TENANT, intent, { idGen: makeId })).rejects.toMatchObject({
      reason: 'invalid_cro_apply_intent',
    })
    expect(proposalInserts.length).toBe(0)
  })
})

describe('proposeCroApply — requiredCapability=lead enforced (cro-apply work-type)', () => {
  const validIntent: CroApplyIntent = { slug: 'existing-post', changeType: 'meta_title', value: 'Better Title' }

  it("capabilities:['member'] → capability_denied, no gate record persisted", async () => {
    const { db, proposalInserts } = makeStubDb()
    await expect(
      proposeCroApply({ db }, TENANT, validIntent, { capabilities: ['member'], idGen: makeId }),
    ).rejects.toThrow(/capability_denied/)
    expect(proposalInserts.length).toBe(0)
  })

  it("capabilities:['lead'] (the default) succeeds", async () => {
    const { db } = makeStubDb()
    const result = await proposeCroApply({ db }, TENANT, validIntent, { idGen: makeId })
    expect(typeof result.gateId).toBe('string')
    expect(result.gateId.length).toBeGreaterThan(0)
  })
})

describe('proposeCroApply — persisted payload contract', () => {
  it('AUTO_PROPOSABLE types persist mode:cro-apply-merge, executor:inkwell-content, flagged:false', async () => {
    for (const changeType of AUTO_PROPOSABLE_CHANGE_TYPES) {
      const { db, proposalInserts } = makeStubDb()
      const needsFindText = changeType === 'cta_text' || changeType === 'internal_links'
      const intent: CroApplyIntent = {
        slug: 'existing-post',
        changeType,
        value: 'new value',
        ...(needsFindText ? { findText: 'old value' } : {}),
      }
      const result = await proposeCroApply({ db }, TENANT, intent, { idGen: makeId })
      expect(result.flagged).toBe(false)
      expect(proposalInserts.length).toBe(1)
      const [, , , action, payloadJson] = proposalInserts[0] as [string, string, string, string, string]
      expect(action).toBe('cro-apply')
      const payload = JSON.parse(payloadJson as string)
      expect(payload).toMatchObject({
        executor: 'inkwell-content',
        mode: 'cro-apply-merge',
        slug: 'existing-post',
        changeType,
        value: 'new value',
        flagged: false,
      })
    }
  })

  it('FLAGGED types (body_copy, headline) persist flagged:true + a warning string', async () => {
    for (const changeType of FLAGGED_CHANGE_TYPES) {
      const { db, proposalInserts } = makeStubDb()
      const intent: CroApplyIntent = { slug: 'existing-post', changeType, value: 'a substantive rewrite' }
      const result = await proposeCroApply({ db }, TENANT, intent, { idGen: makeId })
      expect(result.flagged).toBe(true)
      const [, , , , payloadJson] = proposalInserts[0] as [string, string, string, string, string]
      const payload = JSON.parse(payloadJson as string)
      expect(payload.flagged).toBe(true)
      expect(typeof payload.warning).toBe('string')
      expect(payload.warning).toMatch(/FLAGGED/)
    }
  })

  it('cta_text/internal_links persist the findText field', async () => {
    const { db, proposalInserts } = makeStubDb()
    const intent: CroApplyIntent = {
      slug: 'existing-post',
      changeType: 'cta_text',
      findText: 'Old CTA',
      value: 'New CTA',
    }
    await proposeCroApply({ db }, TENANT, intent, { idGen: makeId })
    const [, , , , payloadJson] = proposalInserts[0] as [string, string, string, string, string]
    const payload = JSON.parse(payloadJson as string)
    expect(payload.findText).toBe('Old CTA')
  })

  it('two proposals produce distinct gateIds', async () => {
    const { db } = makeStubDb()
    const intent: CroApplyIntent = { slug: 'existing-post', changeType: 'meta_title', value: 'v' }
    const r1 = await proposeCroApply({ db }, TENANT, intent, { idGen: makeId })
    const r2 = await proposeCroApply({ db }, TENANT, intent, { idGen: makeId })
    expect(r1.gateId).not.toBe(r2.gateId)
  })
})
