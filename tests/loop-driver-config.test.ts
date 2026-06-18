// tests/loop-driver-config.test.ts — the per-loop CONFIG routing (S5).
//
// loopRuntimeConfig picks the reason + KPI seams by loop.kind. Routing is tested with
// INJECTED spy factories so we verify the discriminator without invoking a model.

import { describe, expect, it, vi } from 'vitest'
import { loopRuntimeConfig } from '../src/loops/driver'
import type { LoopConfig, LoopConfigFactories } from '../src/loops/driver'
import type { LoopManifest } from '../src/loops/manifest'

const stub: LoopConfig = { reason: async () => [], observeKpi: async () => 0 }

function spyFactories(): LoopConfigFactories & { _outreach: ReturnType<typeof vi.fn>; _cro: ReturnType<typeof vi.fn> } {
  const _outreach = vi.fn(() => stub)
  const _cro = vi.fn(() => stub)
  return { outreach: _outreach, cro: _cro, _outreach, _cro }
}

const loopWith = (kind?: string) => ({ id: 'l', kind } as unknown as LoopManifest)

describe('loopRuntimeConfig — kind routing', () => {
  it("kind 'cro' selects the cro factory (not outreach)", () => {
    const f = spyFactories()
    loopRuntimeConfig(loopWith('cro'), f)
    expect(f._cro).toHaveBeenCalledOnce()
    expect(f._outreach).not.toHaveBeenCalled()
  })

  it("kind 'outreach' selects the outreach factory", () => {
    const f = spyFactories()
    loopRuntimeConfig(loopWith('outreach'), f)
    expect(f._outreach).toHaveBeenCalledOnce()
    expect(f._cro).not.toHaveBeenCalled()
  })

  it('absent kind defaults to outreach (back-compat with pre-S5 loops)', () => {
    const f = spyFactories()
    loopRuntimeConfig(loopWith(undefined), f)
    expect(f._outreach).toHaveBeenCalledOnce()
    expect(f._cro).not.toHaveBeenCalled()
  })

  it('an unknown kind value falls back to outreach (fail-safe, never crashes the tick)', () => {
    const f = spyFactories()
    loopRuntimeConfig(loopWith('bogus'), f)
    expect(f._outreach).toHaveBeenCalledOnce()
    expect(f._cro).not.toHaveBeenCalled()
  })
})
