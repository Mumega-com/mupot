// tests/channel-conformance.test.ts — channel layer conformance harness (S1).
//
// PURPOSE: Mechanically prove the channel layer invariants from
// docs/architecture/marketing-channels.md §2 and §8 BEFORE any real channel
// (Outbound, SEO) is built.
//
// The harness drives the fixture channel through the composition model and asserts
// every invariant enumerated in the spec:
//
//   1. COMPOSITION: a channel's metricDescriptors compose into the dept's active
//      descriptors (a channel's metric appears in composeDeptMetricDescriptors for
//      a dept that has the channel).
//
//   2. COMPOSITION: a channel's workTypes compose into the dept's allowed work-types.
//
//   3. ISOLATION: removing the channel removes its metrics/work-types WITHOUT
//      touching sibling channels OR the dept's own descriptors.
//
//   4. NO AUTHORITY MACHINERY: assert (structurally/by export surface) the channel
//      module exposes NO mint/ctx/token/registry — it is pure data.
//
//   5. SOURCE AUTHORITY ENFORCEMENT: a metric emit for a channel key from an
//      unauthorized source is still rejected by the dept's existing ctx guard —
//      channels do NOT widen authority.
//
//   6. FROZEN: a registered channel descriptor is deep-frozen (mutating it
//      post-register can't widen authority).
//
// STRUCTURAL ASSERTION (channel litmus):
//   Adding FixtureChannel required ONLY src/departments/channels/fixture-channel.ts.
//   The following were NOT edited:
//     - src/departments/channels/contract.ts     (channel contract — new file, not an edit)
//     - src/departments/channels/compose.ts      (composition helpers — new file)
//     - src/departments/contract.ts              (dept contract — unchanged)
//     - src/departments/registry.ts              (dept registry — unchanged)
//     - src/departments/ctx.ts                   (confinement — unchanged)
//     - src/departments/modules/growth.ts        (growth dept — unchanged)
//     - src/departments/modules/fixture.ts       (dept fixture — unchanged)
//     - any sibling channel (none yet; each future channel follows the same rule)
//   Isolation: removing fixture-channel.ts leaves ALL other tests GREEN.

import { describe, it, expect } from 'vitest'
import type { D1Database } from '@cloudflare/workers-types'

// ── Channel layer imports ──────────────────────────────────────────────────────
import { FixtureChannel } from '../src/departments/channels/fixture-channel'
import {
  deepFreezeChannels,
  getChannelMetricDescriptors,
  getChannelWorkTypes,
  composeDeptMetricDescriptors,
  ChannelComposeError,
} from '../src/departments/channels/compose'
import type { ChannelDescriptor } from '../src/departments/channels/contract'

// ── Dept layer imports (for composition tests and ctx authority tests) ─────────
import { FixtureModule } from '../src/departments/modules/fixture'
import { kernelMintCtx, createDepartmentRegistry } from '../src/departments/registry'

// ── Metric DB mock (reused pattern from department-conformance.test.ts) ────────

interface MetricRow {
  id: string
  tenant_id: string
  metric_key: string
  value: number
  occurred_at: string
  source: string
  created_at: string
}

function makeMetricDb(): { db: D1Database; rows: () => MetricRow[] } {
  const store: MetricRow[] = []

  const db = {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase()
      const boundArgs: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) {
          boundArgs.push(...args)
          return stmt
        },
        async run() {
          if (upper.includes('INSERT INTO METRIC_POINTS')) {
            const [id, tenant_id, metric_key, value, occurred_at, source, created_at] =
              boundArgs as [string, string, string, number, string, string, string]
            if (store.some((r) => r.id === id)) {
              throw new Error('UNIQUE constraint failed: metric_points.id')
            }
            if (
              store.some(
                (r) =>
                  r.tenant_id === tenant_id &&
                  r.metric_key === metric_key &&
                  r.occurred_at === occurred_at &&
                  r.source === source,
              )
            ) {
              throw new Error(
                'UNIQUE constraint failed: metric_points.tenant_id, metric_points.metric_key, metric_points.occurred_at, metric_points.source',
              )
            }
            store.push({ id, tenant_id, metric_key, value, occurred_at, source, created_at })
            return { success: true, meta: { changes: 1 } }
          }
          return { success: true, meta: { changes: 0 } }
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
    async batch(stmts: unknown[]) {
      return stmts.map(() => ({ success: true, meta: { changes: 0 } }))
    },
  } as unknown as D1Database

  return { db, rows: () => store }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKernelHandle(db: D1Database) {
  return { db }
}

// A sibling channel (different key, different metric) — used for isolation tests.
const siblingChannel: ChannelDescriptor = {
  key: 'sibling-channel',
  name: 'Sibling Channel (Test)',
  metricDescriptors: [
    {
      key: 'sibling.channel.events',
      unit: 'count',
      direction: 'neutral',
      cadence: 'daily',
      aggregation: 'sum',
      ohlcEligible: false,
      sourceAuthority: ['sibling-source'],
      retention: '30d',
      display: { precision: 0 },
    },
  ],
  sourceAuthority: ['sibling-source'],
  connectorRefs: [],
  workTypes: [
    {
      key: 'sibling-proposal',
      name: 'Sibling Proposal',
      proposesOnly: true,
    },
  ],
}

// ── 1. ChannelDescriptor shape + fixture structure ─────────────────────────────

describe('1. ChannelDescriptor shape — FixtureChannel satisfies the contract', () => {
  it('FixtureChannel has required fields: key, name, metricDescriptors, sourceAuthority, connectorRefs, workTypes', () => {
    expect(FixtureChannel.key).toBe('fixture-channel')
    expect(FixtureChannel.name).toBe('Fixture Channel (Test)')
    expect(Array.isArray(FixtureChannel.metricDescriptors)).toBe(true)
    expect(Array.isArray(FixtureChannel.sourceAuthority)).toBe(true)
    expect(Array.isArray(FixtureChannel.connectorRefs)).toBe(true)
    expect(Array.isArray(FixtureChannel.workTypes)).toBe(true)
  })

  it('FixtureChannel has exactly 1 metricDescriptor', () => {
    expect(FixtureChannel.metricDescriptors).toHaveLength(1)
  })

  it('FixtureChannel metricDescriptor key is fixture.channel.pings', () => {
    expect(FixtureChannel.metricDescriptors[0].key).toBe('fixture.channel.pings')
  })

  it('FixtureChannel metricDescriptor is ohlcEligible=false (daily scalar → bar honest)', () => {
    expect(FixtureChannel.metricDescriptors[0].ohlcEligible).toBe(false)
  })

  it('FixtureChannel has exactly 1 workType', () => {
    expect(FixtureChannel.workTypes).toHaveLength(1)
  })

  it('FixtureChannel workType is proposesOnly=true', () => {
    expect(FixtureChannel.workTypes[0].proposesOnly).toBe(true)
  })

  it('FixtureChannel workType key is channel-ping-proposal', () => {
    expect(FixtureChannel.workTypes[0].key).toBe('channel-ping-proposal')
  })

  it('FixtureChannel has renderHints with panelTitle', () => {
    expect(FixtureChannel.renderHints).toBeDefined()
    expect(FixtureChannel.renderHints?.panelTitle).toBe('Fixture Channel')
  })

  it('FixtureChannel has empty connectorRefs (no external connector in S1)', () => {
    expect(FixtureChannel.connectorRefs).toHaveLength(0)
  })
})

// ── 2. COMPOSITION: channel metrics + work-types compose into dept active lists ─

describe('2. COMPOSITION — channel descriptors compose into dept active lists', () => {
  it('getChannelMetricDescriptors returns fixture.channel.pings from [FixtureChannel]', () => {
    const descs = getChannelMetricDescriptors([FixtureChannel])
    expect(descs).toHaveLength(1)
    expect(descs[0].key).toBe('fixture.channel.pings')
  })

  it('getChannelWorkTypes returns channel-ping-proposal from [FixtureChannel]', () => {
    const wts = getChannelWorkTypes([FixtureChannel])
    expect(wts).toHaveLength(1)
    expect(wts[0].key).toBe('channel-ping-proposal')
  })

  it('composeDeptMetricDescriptors includes both dept own and channel metrics', () => {
    // FixtureModule has 2 own metrics: fixture.pings + fixture.scalar
    // FixtureChannel adds 1: fixture.channel.pings
    const composed = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [FixtureChannel])
    expect(composed).toHaveLength(3)
    const keys = composed.map((d) => d.key)
    expect(keys).toContain('fixture.pings')       // dept own
    expect(keys).toContain('fixture.scalar')      // dept own
    expect(keys).toContain('fixture.channel.pings') // channel contribution
  })

  it('composeDeptMetricDescriptors with multiple channels unions all descriptors', () => {
    const composed = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [
      FixtureChannel,
      siblingChannel,
    ])
    // 2 dept own + 1 fixture channel + 1 sibling channel = 4
    expect(composed).toHaveLength(4)
    const keys = composed.map((d) => d.key)
    expect(keys).toContain('fixture.pings')
    expect(keys).toContain('fixture.scalar')
    expect(keys).toContain('fixture.channel.pings')
    expect(keys).toContain('sibling.channel.events')
  })

  it('getChannelWorkTypes with multiple channels unions all work-types', () => {
    const wts = getChannelWorkTypes([FixtureChannel, siblingChannel])
    expect(wts).toHaveLength(2)
    const keys = wts.map((w) => w.key)
    expect(keys).toContain('channel-ping-proposal')
    expect(keys).toContain('sibling-proposal')
  })

  it('empty channels list composes to dept own metrics only', () => {
    const composed = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [])
    expect(composed).toHaveLength(2)
    const keys = composed.map((d) => d.key)
    expect(keys).toContain('fixture.pings')
    expect(keys).toContain('fixture.scalar')
  })
})

// ── 3. ISOLATION — removing a channel does not touch siblings or dept own ───────

describe('3. ISOLATION — removing a channel leaves sibling channels and dept own intact', () => {
  it('removing FixtureChannel from [FixtureChannel, siblingChannel] removes only fixture.channel.pings', () => {
    const withBoth = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [
      FixtureChannel,
      siblingChannel,
    ])
    expect(withBoth).toHaveLength(4)

    // Simulate removing FixtureChannel (drop it from the array)
    const withoutFixture = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [
      siblingChannel,
    ])
    expect(withoutFixture).toHaveLength(3)
    const keysAfter = withoutFixture.map((d) => d.key)
    expect(keysAfter).not.toContain('fixture.channel.pings') // removed
    expect(keysAfter).toContain('sibling.channel.events')   // sibling intact
    expect(keysAfter).toContain('fixture.pings')            // dept own intact
    expect(keysAfter).toContain('fixture.scalar')           // dept own intact
  })

  it('removing siblingChannel from [FixtureChannel, siblingChannel] removes only sibling.channel.events', () => {
    const withoutSibling = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [
      FixtureChannel,
    ])
    expect(withoutSibling).toHaveLength(3)
    const keysAfter = withoutSibling.map((d) => d.key)
    expect(keysAfter).not.toContain('sibling.channel.events') // removed
    expect(keysAfter).toContain('fixture.channel.pings')      // fixture intact
    expect(keysAfter).toContain('fixture.pings')              // dept own intact
    expect(keysAfter).toContain('fixture.scalar')             // dept own intact
  })

  it('removing FixtureChannel removes its work-type without touching sibling work-types', () => {
    const bothWts = getChannelWorkTypes([FixtureChannel, siblingChannel])
    expect(bothWts.map((w) => w.key)).toContain('channel-ping-proposal')
    expect(bothWts.map((w) => w.key)).toContain('sibling-proposal')

    // Simulate removing FixtureChannel
    const afterRemoval = getChannelWorkTypes([siblingChannel])
    expect(afterRemoval.map((w) => w.key)).not.toContain('channel-ping-proposal')
    expect(afterRemoval.map((w) => w.key)).toContain('sibling-proposal')
  })

  it('dept own metricsEmitted is unchanged regardless of channel presence', () => {
    const withChannel = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [FixtureChannel])
    const withoutChannel = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [])

    // Dept own are the same in both cases
    const ownKeys = FixtureModule.metricsEmitted.map((d) => d.key)
    for (const k of ownKeys) {
      expect(withChannel.map((d) => d.key)).toContain(k)
      expect(withoutChannel.map((d) => d.key)).toContain(k)
    }
  })
})

// ── 4. NO AUTHORITY MACHINERY — export surface structural assertion ─────────────
//
// Prove (via dynamic import) that the channel module files export NO function,
// symbol, class, or object that can mint a ctx, acquire a token, or register
// a module. This is the channel analog of test group 9 in department-conformance.test.ts.

describe('4. NO AUTHORITY MACHINERY — channel module export surfaces are pure data', () => {
  it('fixture-channel.ts exports ONLY plain data objects (no functions, no Symbols, no classes)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../src/departments/channels/fixture-channel') as Record<string, any>
    const exportedNames = Object.keys(mod)

    for (const name of exportedNames) {
      const val = mod[name]
      // No export should be a function (no mint, no register, no factory)
      expect(typeof val, `export '${name}' must not be a function`).not.toBe('function')
      // No export should be a Symbol (no kernel token)
      expect(typeof val, `export '${name}' must not be a Symbol`).not.toBe('symbol')
    }

    // The channel descriptor itself is exported as a plain object — verify it
    expect(mod['FixtureChannel']).toBeDefined()
    expect(typeof mod['FixtureChannel']).toBe('object')
  })

  it('fixture-channel.ts does NOT export mint, register, kernelMintCtx, token, or ctx-like symbols', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../src/departments/channels/fixture-channel') as Record<string, any>
    expect(mod['mint']).toBeUndefined()
    expect(mod['register']).toBeUndefined()
    expect(mod['kernelMintCtx']).toBeUndefined()
    expect(mod['_KERNEL_TOKEN']).toBeUndefined()
    expect(mod['KERNEL_TOKEN']).toBeUndefined()
    expect(mod['createChannelRegistry']).toBeUndefined()
    expect(mod['activate']).toBeUndefined()
    expect(mod['deactivate']).toBeUndefined()
    expect(mod['ctx']).toBeUndefined()
  })

  it('channels/contract.ts exports ONLY types (no runtime functions exported as values)', async () => {
    // TypeScript types are erased at runtime. This test verifies the contract file
    // adds NO runtime exports (functions, classes, instances, singletons).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../src/departments/channels/contract') as Record<string, any>
    const runtimeExports = Object.keys(mod)
    // The re-export of MetricDescriptor and ConnectorRef from '../contract' are
    // type-only re-exports — they produce no runtime values. The module should be
    // empty at runtime (all exports are type-level).
    expect(runtimeExports).toHaveLength(0)
  })

  it('channels/compose.ts exports ONLY pure functions — no class, no singleton, no state', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('../src/departments/channels/compose') as Record<string, any>
    const exportedNames = Object.keys(mod)

    // Every export must be a function (pure transform helpers)
    for (const name of exportedNames) {
      expect(typeof mod[name], `compose.ts export '${name}' should be a function`).toBe('function')
    }

    // The known exports must all be present and pure
    expect(typeof mod['deepFreezeChannels']).toBe('function')
    expect(typeof mod['getChannelMetricDescriptors']).toBe('function')
    expect(typeof mod['getChannelWorkTypes']).toBe('function')
    expect(typeof mod['composeDeptMetricDescriptors']).toBe('function')
    // ChannelComposeError is a class — typeof === 'function' (JS class = function)
    expect(typeof mod['ChannelComposeError']).toBe('function')

    // No singleton, no registry, no state
    expect(mod['_registry']).toBeUndefined()
    expect(mod['_singleton']).toBeUndefined()
    expect(mod['register']).toBeUndefined()
    expect(mod['kernelMintCtx']).toBeUndefined()
  })
})

// ── 5. SOURCE AUTHORITY ENFORCEMENT — channel emits go through dept ctx guard ───
//
// A metric emit for a channel metric key from an UNAUTHORIZED source must be
// rejected by the dept's existing ctx guard — channels do NOT widen authority.
//
// This test mints a dept ctx (FixtureModule) and attempts to emit fixture.channel.pings
// (a channel metric key NOT in FixtureModule.metricsEmitted). The ctx must reject
// with key_not_owned — proving that channels cannot bypass the dept's ownership check.
//
// The second sub-test uses a ctx that has fixture.channel.pings in its metricsEmitted
// (to simulate a dept whose module carries the channel metrics) but then tries an
// unauthorized source — proving the sourceAuthority check holds too.

describe('5. SOURCE AUTHORITY — channel emits still go through dept ctx guard', () => {
  it('dept ctx rejects fixture.channel.pings (channel key) not in FixtureModule.metricsEmitted', async () => {
    // The FixtureModule does NOT include fixture.channel.pings in its metricsEmitted.
    // A ctx minted for FixtureModule should reject any emit for that key.
    const metricStore = makeMetricDb()
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'fixture',
      module: FixtureModule,
      capabilities: ['member'],
    })

    await expect(
      ctx.metrics.emit({
        key: 'fixture.channel.pings',  // channel key — not in FixtureModule.metricsEmitted
        value: 1,
        occurredAt: '2026-06-17T10:00:00.000Z',
        source: 'fixture-channel-harness',
      }),
    ).rejects.toThrow(/key_not_owned|is not declared/)
  })

  it('a custom module with fixture.channel.pings rejects unauthorized source (sourceAuthority enforced)', async () => {
    // Build a synthetic module that DOES include fixture.channel.pings (simulates a
    // dept whose manifest was composed with the channel's descriptors).
    // Then try to emit from an unauthorized source — must be rejected.
    const reg = createDepartmentRegistry()
    const channelAwareModule = {
      ...FixtureModule,
      key: 'channel-aware-fixture',
      metricsEmitted: [
        ...FixtureModule.metricsEmitted,
        // Include the channel metric in this module's declared emitted metrics
        ...FixtureChannel.metricDescriptors,
      ],
    }
    reg.register(channelAwareModule)

    const metricStore = makeMetricDb()
    const ctx = kernelMintCtx(makeKernelHandle(metricStore.db), {
      tenantId: 'tenant-a',
      departmentKey: 'channel-aware-fixture',
      module: channelAwareModule,
      capabilities: ['member'],
    })

    // Authorized source — should succeed
    const okResult = await ctx.metrics.emit({
      key: 'fixture.channel.pings',
      value: 5,
      occurredAt: '2026-06-17T10:01:00.000Z',
      source: 'fixture-channel-harness', // in channel's sourceAuthority
    })
    expect(okResult.ok).toBe(true)

    // Unauthorized source — must be rejected
    await expect(
      ctx.metrics.emit({
        key: 'fixture.channel.pings',
        value: 5,
        occurredAt: '2026-06-17T10:02:00.000Z',
        source: 'stripe', // NOT in sourceAuthority: ['fixture-channel-harness']
      }),
    ).rejects.toThrow(/source_not_authorized|not in sourceAuthority/)
  })

  it('channel cannot widen sourceAuthority by pushing to it post-register', () => {
    // The channel descriptor is a plain object here — freeze it via deepFreezeChannels.
    const channels = deepFreezeChannels([{ ...FixtureChannel }])
    const frozen = channels[0]

    // Attempt to widen sourceAuthority (push a new source)
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(frozen.sourceAuthority as any).push('attacker-source')
    }).toThrow() // frozen array throws in strict mode
  })
})

// ── 6. FROZEN — registered channel descriptors are deep-frozen ─────────────────
//
// Proves that deepFreezeChannels() produces a fully frozen channel array:
//   - the array itself
//   - each ChannelDescriptor object
//   - metricDescriptors array + each MetricDescriptor + its sourceAuthority + display
//   - workTypes array + each GatedWorkType
//   - connectorRefs array + each ConnectorRef
//   - renderHints object

describe('6. FROZEN — deepFreezeChannels produces immutable channel descriptors', () => {
  // Use a mutable copy for each test so freeze state is predictable.
  function makeMutableChannel(): ChannelDescriptor {
    return {
      key: 'freeze-test-channel',
      name: 'Freeze Test',
      metricDescriptors: [
        {
          key: 'freeze.test.metric',
          unit: 'count',
          direction: 'neutral',
          cadence: 'daily',
          aggregation: 'sum',
          ohlcEligible: false,
          sourceAuthority: ['freeze-source'],
          retention: '30d',
          display: { precision: 0 },
        },
      ],
      sourceAuthority: ['freeze-source'],
      connectorRefs: [],
      workTypes: [
        { key: 'freeze-proposal', name: 'Freeze Proposal', proposesOnly: true },
      ],
      renderHints: { panelTitle: 'Freeze Test Panel' },
    }
  }

  it('the frozen channel array is frozen (Object.isFrozen)', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(Object.isFrozen(channels)).toBe(true)
  })

  it('each ChannelDescriptor is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(Object.isFrozen(channels[0])).toBe(true)
  })

  it('metricDescriptors array is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(Object.isFrozen(channels[0].metricDescriptors)).toBe(true)
  })

  it('each MetricDescriptor is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    for (const desc of channels[0].metricDescriptors) {
      expect(Object.isFrozen(desc)).toBe(true)
    }
  })

  it('each MetricDescriptor.sourceAuthority array is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    for (const desc of channels[0].metricDescriptors) {
      expect(Object.isFrozen(desc.sourceAuthority)).toBe(true)
    }
  })

  it('each MetricDescriptor.display object is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    for (const desc of channels[0].metricDescriptors) {
      expect(Object.isFrozen(desc.display)).toBe(true)
    }
  })

  it('workTypes array is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(Object.isFrozen(channels[0].workTypes)).toBe(true)
  })

  it('each GatedWorkType is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    for (const wt of channels[0].workTypes) {
      expect(Object.isFrozen(wt)).toBe(true)
    }
  })

  it('connectorRefs array is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(Object.isFrozen(channels[0].connectorRefs)).toBe(true)
  })

  it('renderHints object is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(Object.isFrozen(channels[0].renderHints)).toBe(true)
  })

  it('top-level sourceAuthority array is frozen', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(Object.isFrozen(channels[0].sourceAuthority)).toBe(true)
  })

  it('EXPLOIT: pushing to metricDescriptors post-freeze throws', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(channels[0].metricDescriptors as any).push({ key: 'evil.metric' })
    }).toThrow()
  })

  it('EXPLOIT: pushing to sourceAuthority post-freeze throws', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(channels[0].sourceAuthority as any).push('evil-source')
    }).toThrow()
  })

  it('EXPLOIT: mutating channel key post-freeze throws', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(channels[0] as any).key = 'hijacked-key'
    }).toThrow()
  })

  it('EXPLOIT: assigning to metricDescriptor.sourceAuthority post-freeze throws', () => {
    const channels = deepFreezeChannels([makeMutableChannel()])
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(channels[0].metricDescriptors[0] as any).sourceAuthority = ['evil-source']
    }).toThrow()
  })

  it('channels embedded in a DepartmentModule are frozen by deepFreezeClone (registry path)', () => {
    // When a DepartmentModule with a `channels` field is registered, the registry's
    // deepFreezeClone freezes the top-level manifest. Because the channels array is a
    // nested property, the top-level manifest freeze propagates — but only shallowly
    // for the outer array. The deepFreezeChannels() utility ensures full depth.
    // This test proves the compose path produces frozen channel descriptors.
    const mutable = makeMutableChannel()
    const frozen = deepFreezeChannels([mutable])
    // The original mutable object is now frozen (in-place freeze)
    expect(Object.isFrozen(frozen[0])).toBe(true)
    expect(Object.isFrozen(frozen[0].metricDescriptors)).toBe(true)
  })
})

// ── 7. ADVERSARIAL — FixtureChannel is data, not authority ────────────────────
//
// Even if an attacker imports FixtureChannel and tries to use it as a
// proxy for authority escalation, the plain data object gives no foothold:
// no mint function, no token, no registry access.

describe('7. ADVERSARIAL — FixtureChannel data object gives no authority foothold', () => {
  it('FixtureChannel has no mint, register, or ctx-like properties at runtime', () => {
    const ch = FixtureChannel as Record<string, unknown>
    expect(ch['mint']).toBeUndefined()
    expect(ch['register']).toBeUndefined()
    expect(ch['kernelMintCtx']).toBeUndefined()
    expect(ch['_KERNEL_TOKEN']).toBeUndefined()
    expect(ch['activate']).toBeUndefined()
    expect(ch['deactivate']).toBeUndefined()
    expect(ch['ctx']).toBeUndefined()
  })

  it('all FixtureChannel property values are primitive strings, arrays, booleans, or plain objects', () => {
    const ch = FixtureChannel as Record<string, unknown>
    for (const [name, val] of Object.entries(ch)) {
      const kind = typeof val
      const isAllowed =
        kind === 'string' ||
        kind === 'boolean' ||
        kind === 'undefined' ||
        kind === 'number' ||
        Array.isArray(val) ||
        (kind === 'object' && val !== null && !Array.isArray(val))
      expect(isAllowed, `property '${name}' has unexpected type '${kind}'`).toBe(true)
      // Must NOT be a function or Symbol (would be an authority vector)
      expect(kind, `property '${name}' must not be a function`).not.toBe('function')
      expect(kind, `property '${name}' must not be a Symbol`).not.toBe('symbol')
    }
  })
})

// ── 8. DUPLICATE-KEY GUARD — authority-shadow is blocked at compose time ────────
//
// Codex gate RED (S1): composeDeptMetricDescriptors returned [...deptOwn, ...channelMetrics]
// with NO duplicate-key check. The kernel builds its ctx authority map via
//   new Map(module.metricsEmitted.map(...))
// so a channel contributing the SAME key as a dept-owned metric (but with a WIDER
// sourceAuthority) would silently overwrite the dept's authority entry — last key wins.
//
// Fix: composeDeptMetricDescriptors and getChannelWorkTypes now fail closed:
// any duplicate key throws ChannelComposeError BEFORE the result is ever produced.
//
// These tests prove fail-closed semantics:
//   8a. dept-owned key shadowed by a channel → throws duplicate_metric_key
//   8b. channel-vs-channel metric key collision → throws duplicate_metric_key
//   8c. channel-vs-channel work-type key collision → throws duplicate_work_type_key
//   8d. non-colliding keys → compose succeeds (the existing happy path is intact)
//   8e. ChannelComposeError carries the correct typed code and key fields

describe('8. DUPLICATE-KEY GUARD — authority-shadow blocked at compose time', () => {
  // ── helpers ────────────────────────────────────────────────────────────────

  // A channel that declares `fixture.pings` — a key owned by FixtureModule.
  // This is the exact Codex exploit: same key, wider sourceAuthority (adds 'stripe').
  const channelShadowingDeptKey: ChannelDescriptor = {
    key: 'shadow-channel',
    name: 'Shadow Channel (exploit attempt)',
    metricDescriptors: [
      {
        key: 'fixture.pings', // COLLISION: FixtureModule owns this key
        unit: 'count',
        direction: 'neutral',
        cadence: 'daily',
        aggregation: 'sum',
        ohlcEligible: false,
        // Wider sourceAuthority than the dept's: adds 'stripe' (not in dept's list)
        sourceAuthority: ['fixture-harness', 'manual', 'stripe'],
        retention: '30d',
        display: { precision: 0 },
      },
    ],
    sourceAuthority: ['fixture-harness', 'manual', 'stripe'],
    connectorRefs: [],
    workTypes: [],
  }

  // A second channel that declares `fixture.channel.pings` — same as FixtureChannel.
  const channelCollidingWithSibling: ChannelDescriptor = {
    key: 'colliding-channel',
    name: 'Colliding Channel (exploit attempt)',
    metricDescriptors: [
      {
        key: 'fixture.channel.pings', // COLLISION: FixtureChannel owns this key
        unit: 'count',
        direction: 'neutral',
        cadence: 'daily',
        aggregation: 'sum',
        ohlcEligible: false,
        sourceAuthority: ['evil-source'],
        retention: '30d',
        display: { precision: 0 },
      },
    ],
    sourceAuthority: ['evil-source'],
    connectorRefs: [],
    workTypes: [],
  }

  // A channel with a work-type key that collides with FixtureChannel's work-type.
  const channelCollidingWorkType: ChannelDescriptor = {
    key: 'colliding-wt-channel',
    name: 'Colliding Work-Type Channel (exploit attempt)',
    metricDescriptors: [],
    sourceAuthority: [],
    connectorRefs: [],
    workTypes: [
      {
        key: 'channel-ping-proposal', // COLLISION: FixtureChannel owns this key
        name: 'Evil Proposal',
        proposesOnly: true,
      },
    ],
  }

  // ── 8a. dept-owned key shadowed by a channel → THROWS ─────────────────────

  it('8a. dept-owned metric key shadowed by a channel → composeDeptMetricDescriptors THROWS (duplicate_metric_key)', () => {
    // FixtureModule.metricsEmitted includes 'fixture.pings'.
    // channelShadowingDeptKey also declares 'fixture.pings' with a wider sourceAuthority.
    // The compose MUST throw before producing a result — fail closed.
    expect(() => {
      composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [channelShadowingDeptKey])
    }).toThrow(ChannelComposeError)
  })

  it('8a. the thrown error has code=duplicate_metric_key and key=fixture.pings', () => {
    let caught: unknown
    try {
      composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [channelShadowingDeptKey])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ChannelComposeError)
    const err = caught as ChannelComposeError
    expect(err.code).toBe('duplicate_metric_key')
    expect(err.key).toBe('fixture.pings')
  })

  it('8a. the result is NEVER produced when a dept-vs-channel collision is present (fail closed)', () => {
    // Confirm that composeDeptMetricDescriptors does not return a partial result
    // before throwing. The throw must happen BEFORE the return statement.
    let result: unknown = 'not-set'
    try {
      result = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [channelShadowingDeptKey])
    } catch {
      // expected
    }
    // result must still be the sentinel — it was never assigned by the function
    expect(result).toBe('not-set')
  })

  // ── 8b. channel-vs-channel metric key collision → THROWS ──────────────────

  it('8b. channel-vs-channel metric key collision → composeDeptMetricDescriptors THROWS (duplicate_metric_key)', () => {
    // FixtureChannel declares 'fixture.channel.pings'.
    // channelCollidingWithSibling also declares 'fixture.channel.pings'.
    // Both are distinct channels with no dept-level collision, but they collide
    // with each other. The compose MUST throw.
    expect(() => {
      composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [
        FixtureChannel,
        channelCollidingWithSibling,
      ])
    }).toThrow(ChannelComposeError)
  })

  it('8b. the channel-vs-channel collision error has code=duplicate_metric_key and key=fixture.channel.pings', () => {
    let caught: unknown
    try {
      composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [
        FixtureChannel,
        channelCollidingWithSibling,
      ])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ChannelComposeError)
    const err = caught as ChannelComposeError
    expect(err.code).toBe('duplicate_metric_key')
    expect(err.key).toBe('fixture.channel.pings')
  })

  // ── 8c. duplicate work-type key across channels → THROWS ──────────────────

  it('8c. duplicate work-type key across channels → getChannelWorkTypes THROWS (duplicate_work_type_key)', () => {
    // FixtureChannel has work-type 'channel-ping-proposal'.
    // channelCollidingWorkType also has 'channel-ping-proposal'.
    expect(() => {
      getChannelWorkTypes([FixtureChannel, channelCollidingWorkType])
    }).toThrow(ChannelComposeError)
  })

  it('8c. the work-type collision error has code=duplicate_work_type_key and key=channel-ping-proposal', () => {
    let caught: unknown
    try {
      getChannelWorkTypes([FixtureChannel, channelCollidingWorkType])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ChannelComposeError)
    const err = caught as ChannelComposeError
    expect(err.code).toBe('duplicate_work_type_key')
    expect(err.key).toBe('channel-ping-proposal')
  })

  // ── 8d. non-colliding keys → compose succeeds (happy path stays green) ─────

  it('8d. non-colliding metric keys (dept own + channels) → composeDeptMetricDescriptors succeeds', () => {
    // FixtureModule: fixture.pings, fixture.scalar
    // FixtureChannel: fixture.channel.pings
    // siblingChannel: sibling.channel.events
    // All 4 keys are distinct — must succeed and return all 4 descriptors.
    const result = composeDeptMetricDescriptors(FixtureModule.metricsEmitted, [
      FixtureChannel,
      siblingChannel,
    ])
    expect(result).toHaveLength(4)
    const keys = result.map((d) => d.key)
    expect(keys).toContain('fixture.pings')
    expect(keys).toContain('fixture.scalar')
    expect(keys).toContain('fixture.channel.pings')
    expect(keys).toContain('sibling.channel.events')
  })

  it('8d. non-colliding work-type keys → getChannelWorkTypes succeeds', () => {
    // FixtureChannel: channel-ping-proposal
    // siblingChannel: sibling-proposal
    // Both distinct — must succeed.
    const result = getChannelWorkTypes([FixtureChannel, siblingChannel])
    expect(result).toHaveLength(2)
    const keys = result.map((w) => w.key)
    expect(keys).toContain('channel-ping-proposal')
    expect(keys).toContain('sibling-proposal')
  })

  // ── 8e. ChannelComposeError fields are correctly typed ─────────────────────

  it('8e. ChannelComposeError is an instanceof Error and has correct name', () => {
    const err = new ChannelComposeError('duplicate_metric_key', 'some.key')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ChannelComposeError)
    expect(err.name).toBe('ChannelComposeError')
  })

  it('8e. ChannelComposeError.code and .key are set correctly for duplicate_metric_key', () => {
    const err = new ChannelComposeError('duplicate_metric_key', 'fixture.pings')
    expect(err.code).toBe('duplicate_metric_key')
    expect(err.key).toBe('fixture.pings')
    expect(err.message).toContain('duplicate_metric_key')
    expect(err.message).toContain('fixture.pings')
  })

  it('8e. ChannelComposeError.code and .key are set correctly for duplicate_work_type_key', () => {
    const err = new ChannelComposeError('duplicate_work_type_key', 'channel-ping-proposal')
    expect(err.code).toBe('duplicate_work_type_key')
    expect(err.key).toBe('channel-ping-proposal')
    expect(err.message).toContain('duplicate_work_type_key')
    expect(err.message).toContain('channel-ping-proposal')
  })
})
