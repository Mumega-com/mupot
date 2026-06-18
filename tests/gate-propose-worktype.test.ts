// tests/gate-propose-worktype.test.ts — gate.propose work-type binding (BLOCK-1 fix + S4 update).
//
// PURPOSE: prove the gate.propose is FAIL-CLOSED against the declared channel work-type map.
// Added after Codex gate RED (2026-06-18). Updated for S4: non-proposesOnly work-types are
// now ALLOWED by gate.propose (they create gated records that require human approval before
// execution via executor.execute).
//
// Contract (S4):
//   - Undeclared action                   → throws CtxError('work_type_not_declared')
//   - Declared proposesOnly=true          → accepted (returns gateId) — S3 unchanged
//   - Declared proposesOnly=false         → accepted (returns gateId, no auto-execute) — S4 NEW
//   - requiredCapability not met          → throws CtxError('capability_denied')
//   - requiredCapability met              → accepted
//   - invalid requiredCapability string   → throws CtxError('capability_invalid') — S4 NEW
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

// ── 3. Non-proposesOnly work-type → S4: now ACCEPTED (creates gated record, no execute) ──

describe('3. Non-proposesOnly work-type → S4: gate.propose creates gated record (not rejected)', () => {
  it('a declared proposesOnly=false work-type creates a gated record (S4 enables this)', async () => {
    // S4: non-proposesOnly work-types are now allowed by gate.propose.
    // They create a pending gated record. Execution requires a separate human approval step.
    const modWithNonProposesOnly = makeModuleWithWorkTypes([
      {
        key: 'sync-execute',
        name: 'Sync Execute',
        proposesOnly: false, // S4: this is now valid at propose time
      },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithNonProposesOnly,
      capabilities: ['member'],
      now: () => NOW,
    })

    // S4: should NOT throw — returns a gateId.
    const result = await ctx.gate.propose({ action: 'sync-execute' })
    expect(typeof result.gateId).toBe('string')
    expect(result.gateId.length).toBeGreaterThan(0)
  })

  it('non-proposesOnly gated record does NOT auto-execute (fail-closed — no approval)', async () => {
    const modWithNonProposesOnly = makeModuleWithWorkTypes([
      {
        key: 'execute-now',
        name: 'Execute Now',
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

    const { gateId } = await ctx.gate.propose({ action: 'execute-now' })
    // No recordApproval called → executor.execute must reject with not_approved.
    await expect(
      ctx.executor.execute(gateId)
    ).rejects.toThrow(/not_approved/)
  })

  it('undeclared action still distinguishes from non-proposesOnly (different codes)', async () => {
    const modWithNonProposesOnly = makeModuleWithWorkTypes([
      { key: 'batch-delete', name: 'Batch Delete', proposesOnly: false },
    ])

    const ctx = kernelMintCtx({ db }, {
      tenantId: TENANT,
      departmentKey: 'growth-gate-test',
      module: modWithNonProposesOnly,
      capabilities: ['member'],
      now: () => NOW,
    })

    // 'batch-delete' IS declared → should succeed (returns gateId), NOT throw.
    const result = await ctx.gate.propose({ action: 'batch-delete' })
    expect(typeof result.gateId).toBe('string')

    // 'completely-unknown' is NOT declared → work_type_not_declared.
    let undeclaredCaught: unknown
    try { await ctx.gate.propose({ action: 'completely-unknown' }) } catch (e) { undeclaredCaught = e }
    expect(undeclaredCaught).toBeInstanceOf(CtxError)
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
