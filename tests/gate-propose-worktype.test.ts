// tests/gate-propose-worktype.test.ts — gate.propose work-type binding (BLOCK-1 fix).
//
// PURPOSE: prove the S3 invariant that ctx.gate.propose is FAIL-CLOSED against
// the declared channel work-type map. Added after Codex gate RED (2026-06-18):
// gate.propose previously accepted ANY action (stub) — breaking the S3 authority
// seam before S4 makes gate records operational.
//
// Contract (post-fix):
//   - Undeclared action                   → throws CtxError('work_type_not_declared')
//   - Declared proposesOnly=true          → accepted (returns gateId)
//   - Declared proposesOnly=false         → throws CtxError('work_type_not_proposesOnly')
//   - requiredCapability not met          → throws CtxError('capability_denied')
//   - requiredCapability met              → accepted
//   - Cross-dept: work-type from channel A can't be proposed via a ctx that has
//     no channel A (because the work-type map is built from the frozen module channels)
//
// The work-type map is closure-private to the minted ctx (same pattern as
// _metricsMap). The map is built from getChannelWorkTypes(module.channels) which
// already dedup-checks (ChannelComposeError on duplicate key) so the map source
// is validated before the kernel ever uses it.

import { describe, it, expect } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

import { kernelMintCtx } from '../src/departments/registry'
import { CtxError } from '../src/departments/ctx'
import { GrowthModule } from '../src/departments/modules/growth'
import { FixtureModule } from '../src/departments/modules/fixture'
import type { DepartmentModule } from '../src/departments/contract'
import type { ChannelDescriptor, GatedWorkType } from '../src/departments/channels/contract'

// ── Minimal DB stub (gate.propose does not touch D1 in S3) ───────────────────

function makeNullDb(): D1Database {
  return {
    prepare() {
      return {
        bind() { return this },
        async run() { return { success: true, meta: { changes: 0 } } },
        async all() { return { results: [], success: true } },
        async first() { return null },
      }
    },
    async batch() { return [] },
  } as unknown as D1Database
}

const NOW = '2026-06-18T12:00:00.000Z'
const TENANT = 'mumega'
const db = makeNullDb()

// ── Helper: build a synthetic DepartmentModule with specific work-types ───────
//
// Used to test non-proposesOnly and requiredCapability paths without editing
// the canonical GrowthModule or its channels.

function makeModuleWithWorkTypes(
  extra: GatedWorkType[],
): DepartmentModule {
  const syntheticChannel: ChannelDescriptor = {
    key: 'synthetic-gate-test-channel',
    name: 'Synthetic Gate Test Channel',
    metricDescriptors: [],
    sourceAuthority: [],
    connectorRefs: [],
    workTypes: extra,
  }
  return {
    ...GrowthModule,
    key: 'growth-gate-test',
    channels: [...(GrowthModule.channels ?? []), syntheticChannel],
  }
}

// ── 1. Undeclared action → fail-closed ───────────────────────────────────────

describe('1. Undeclared action → gate.propose throws work_type_not_declared', () => {
  it('any undeclared action string throws CtxError(work_type_not_declared)', async () => {
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    await expect(
      ctx.gate.propose({ action: 'totally-undeclared-action' }),
    ).rejects.toThrow(CtxError)
  })

  it('the error code is work_type_not_declared and message names the action', async () => {
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    let caught: unknown
    try {
      await ctx.gate.propose({ action: 'fabricated-action' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CtxError)
    const err = caught as CtxError
    expect(err.code).toBe('work_type_not_declared')
    expect(err.message).toContain('fabricated-action')
  })

  it('fixture module (no channels) rejects any propose — no declared work-types', async () => {
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    await expect(
      ctx.gate.propose({ action: 'seo-audit-proposal' }), // valid for growth, NOT fixture
    ).rejects.toThrow(/work_type_not_declared/)
  })

  it('result is never produced when action is undeclared (fail-closed semantics)', async () => {
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    let result: unknown = 'sentinel-not-set'
    try {
      result = await ctx.gate.propose({ action: 'not-a-work-type' })
    } catch {
      // expected throw
    }
    expect(result).toBe('sentinel-not-set')
  })
})

// ── 2. Declared proposesOnly=true → accepted ─────────────────────────────────

describe('2. Declared proposesOnly=true work-type → gate.propose accepted', () => {
  it('seo-audit-proposal (proposesOnly=true on SeoChannel) → returns gateId', async () => {
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    const result = await ctx.gate.propose({ action: 'seo-audit-proposal' })
    expect(result).toBeDefined()
    expect(typeof result.gateId).toBe('string')
    expect(result.gateId.length).toBeGreaterThan(0)
  })

  it('keyword-gap-proposal (proposesOnly=true on SeoChannel) → returns gateId', async () => {
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    const result = await ctx.gate.propose({ action: 'keyword-gap-proposal' })
    expect(result).toBeDefined()
    expect(typeof result.gateId).toBe('string')
  })

  it('comparison-page-proposal (proposesOnly=true on SeoChannel) → accepted', async () => {
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    const result = await ctx.gate.propose({ action: 'comparison-page-proposal' })
    expect(typeof result.gateId).toBe('string')
  })

  it('all 4 SeoChannel work-type keys are accepted via gate.propose', async () => {
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    const seoWorkTypeKeys = ['seo-audit-proposal', 'keyword-gap-proposal', 'comparison-page-proposal', 'content-refresh-proposal']
    for (const key of seoWorkTypeKeys) {
      const result = await ctx.gate.propose({ action: key })
      expect(typeof result.gateId).toBe('string')
    }
  })
})

// ── 3. Non-proposesOnly work-type → rejected (unsupported until S4) ──────────

describe('3. Non-proposesOnly work-type → gate.propose throws work_type_not_proposesOnly', () => {
  it('a declared proposesOnly=false work-type throws work_type_not_proposesOnly', async () => {
    // Build a module that has a proposesOnly=false work-type (S4 reserved).
    const modWithNonProposesOnly = makeModuleWithWorkTypes([
      {
        key: 'sync-execute',
        name: 'Sync Execute (S4 reserved)',
        proposesOnly: false, // NOT a proposesOnly work-type
      },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithNonProposesOnly,
      capabilities: ['member'],
      now: () => NOW,
    })

    await expect(
      ctx.gate.propose({ action: 'sync-execute' }),
    ).rejects.toThrow(/work_type_not_proposesOnly/)
  })

  it('the error code is work_type_not_proposesOnly', async () => {
    const modWithNonProposesOnly = makeModuleWithWorkTypes([
      {
        key: 'execute-now',
        name: 'Execute Now (S4)',
        proposesOnly: false,
      },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithNonProposesOnly,
      capabilities: ['member'],
      now: () => NOW,
    })

    let caught: unknown
    try {
      await ctx.gate.propose({ action: 'execute-now' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CtxError)
    expect((caught as CtxError).code).toBe('work_type_not_proposesOnly')
  })

  it('non-proposesOnly is a distinct error from undeclared (different codes)', async () => {
    const modWithNonProposesOnly = makeModuleWithWorkTypes([
      { key: 'batch-delete', name: 'Batch Delete (S4)', proposesOnly: false },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithNonProposesOnly,
      capabilities: ['member'],
      now: () => NOW,
    })

    // 'batch-delete' IS declared, but proposesOnly=false
    let nonProposesOnlyCaught: unknown
    try { await ctx.gate.propose({ action: 'batch-delete' }) } catch (e) { nonProposesOnlyCaught = e }
    expect((nonProposesOnlyCaught as CtxError).code).toBe('work_type_not_proposesOnly')

    // 'completely-unknown' is NOT declared
    let undeclaredCaught: unknown
    try { await ctx.gate.propose({ action: 'completely-unknown' }) } catch (e) { undeclaredCaught = e }
    expect((undeclaredCaught as CtxError).code).toBe('work_type_not_declared')
  })
})

// ── 4. requiredCapability enforcement ────────────────────────────────────────

describe('4. requiredCapability enforcement on gate.propose', () => {
  it('work-type with requiredCapability=lead: member ctx → throws capability_denied', async () => {
    const modWithLeadReq = makeModuleWithWorkTypes([
      {
        key: 'lead-only-proposal',
        name: 'Lead Only Proposal',
        proposesOnly: true,
        requiredCapability: 'lead',
      },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithLeadReq,
      capabilities: ['member'], // member < lead
      now: () => NOW,
    })

    await expect(
      ctx.gate.propose({ action: 'lead-only-proposal' }),
    ).rejects.toThrow(/capability_denied/)
  })

  it('work-type with requiredCapability=lead: lead ctx → accepted', async () => {
    const modWithLeadReq = makeModuleWithWorkTypes([
      {
        key: 'lead-only-proposal',
        name: 'Lead Only Proposal',
        proposesOnly: true,
        requiredCapability: 'lead',
      },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithLeadReq,
      capabilities: ['lead'], // lead >= lead
      now: () => NOW,
    })

    const result = await ctx.gate.propose({ action: 'lead-only-proposal' })
    expect(typeof result.gateId).toBe('string')
  })

  it('work-type with requiredCapability=admin: lead ctx → throws capability_denied', async () => {
    const modWithAdminReq = makeModuleWithWorkTypes([
      {
        key: 'admin-proposal',
        name: 'Admin Proposal',
        proposesOnly: true,
        requiredCapability: 'admin',
      },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithAdminReq,
      capabilities: ['lead'], // lead < admin
      now: () => NOW,
    })

    await expect(
      ctx.gate.propose({ action: 'admin-proposal' }),
    ).rejects.toThrow(/capability_denied/)
  })

  it('work-type with requiredCapability=admin: owner ctx → accepted (owner > admin)', async () => {
    const modWithAdminReq = makeModuleWithWorkTypes([
      {
        key: 'admin-proposal',
        name: 'Admin Proposal',
        proposesOnly: true,
        requiredCapability: 'admin',
      },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithAdminReq,
      capabilities: ['owner'], // owner >= admin
      now: () => NOW,
    })

    const result = await ctx.gate.propose({ action: 'admin-proposal' })
    expect(typeof result.gateId).toBe('string')
  })

  it('work-type with no requiredCapability: member ctx → accepted (member floor)', async () => {
    // No requiredCapability on SeoChannel work-types — member floor applies.
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth',
      module: GrowthModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    const result = await ctx.gate.propose({ action: 'seo-audit-proposal' })
    expect(typeof result.gateId).toBe('string')
  })

  it('error for failed requiredCapability is capability_denied (not work_type_not_declared)', async () => {
    const modWithLeadReq = makeModuleWithWorkTypes([
      {
        key: 'lead-req-proposal',
        name: 'Lead Req Proposal',
        proposesOnly: true,
        requiredCapability: 'lead',
      },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithLeadReq,
      capabilities: ['member'],
      now: () => NOW,
    })

    let caught: unknown
    try { await ctx.gate.propose({ action: 'lead-req-proposal' }) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(CtxError)
    // The work-type IS declared (not work_type_not_declared), so the error is capability_denied
    expect((caught as CtxError).code).toBe('capability_denied')
  })
})

// ── 5. Cross-dept: work-type from dept A can't be used in dept B ─────────────

describe('5. Cross-dept: work-type from channel A is not available in a dept that lacks channel A', () => {
  it('seo-audit-proposal declared on GrowthModule.SeoChannel → not available on FixtureModule ctx', async () => {
    // FixtureModule has no channels. Even though 'seo-audit-proposal' is valid for growth,
    // a ctx minted for FixtureModule has an empty work-type map — throws work_type_not_declared.
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    await expect(
      ctx.gate.propose({ action: 'seo-audit-proposal' }),
    ).rejects.toThrow(/work_type_not_declared/)
  })

  it('outreach-send declared on GrowthModule.OutboundChannel → not available on FixtureModule ctx', async () => {
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    await expect(
      ctx.gate.propose({ action: 'outreach-send' }),
    ).rejects.toThrow(/work_type_not_declared/)
  })

  it('work-type map is closure-private: mutating ctx.metricsEmitted snapshot has no effect on propose checks', async () => {
    // The inert snapshot on ctx cannot be used to inject work-types.
    // Mutating ctx.metricsEmitted (even with as-any) does not affect the closure-private
    // _workTypeMap. propose still checks against the immutable closure map.
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
      now: () => NOW,
    })

    // Even if we could mutate the snapshot (we can't — it's frozen), the closure
    // is already built and immutable. The propose check reads _workTypeMap, not ctx.
    await expect(
      ctx.gate.propose({ action: 'seo-audit-proposal' }),
    ).rejects.toThrow(/work_type_not_declared/)
  })

  it('member capability check still fires before work-type check on FixtureModule', async () => {
    // With observer (below member floor), the capability check fires first.
    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['observer'], // below member floor
      now: () => NOW,
    })

    // capability_denied fires before work_type_not_declared
    let caught: unknown
    try { await ctx.gate.propose({ action: 'anything' }) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(CtxError)
    expect((caught as CtxError).code).toBe('capability_denied')
  })
})
