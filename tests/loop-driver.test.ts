// tests/loop-driver.test.ts — the Loop driver (P3, #34). Fan-out logic, injected seams.

import { describe, expect, it, vi } from 'vitest'
import { runLoopsTick, MAX_LOOPS_PER_TICK } from '../src/loops/driver'
import type { LoopManifest } from '../src/loops/manifest'
import type { Env } from '../src/types'

const ENV = { TENANT_SLUG: 't' } as unknown as Env

function makeLoop(id: string): LoopManifest {
  return {
    id, tenant: 't', squad_id: null, agent_id: 'a-' + id, status: 'active',
    okr: 'grow', kpi: { signal: 'x', target: 5 },
    sources: [], channels: [], gate: { require_approval: true },
    budget: {}, cadence: { heartbeat: true }, stop: {}, created_at: 'x',
  }
}

const cycleResult = (over = {}) => ({ ok: true, decided: 'acted' as const, perceived: 1, acted: 1, gated: 0, kpi: 0, ...over })

// no-op dry-round seams so tests don't hit D1; overridden where the pause path is tested.
const dryNoop = { bumpDry: vi.fn(async () => 1), resetDry: vi.fn(async () => {}), pause: vi.fn(async () => true) }

describe('runLoopsTick', () => {
  it('runs a cycle for each active loop and aggregates acted/gated', async () => {
    const list = vi.fn(async () => [makeLoop('1'), makeLoop('2')])
    const runCycle = vi
      .fn()
      .mockResolvedValueOnce(cycleResult({ acted: 1, gated: 0 }))
      .mockResolvedValueOnce(cycleResult({ acted: 0, gated: 2, decided: 'gated_pending' }))
    const r = await runLoopsTick(ENV, { list, runCycle })
    expect(r.ok).toBe(true)
    expect(r.ran).toBe(2)
    expect(r.acted).toBe(1)
    expect(r.gated).toBe(2)
    expect(r.errors).toBe(0)
  })

  it('caps at MAX_LOOPS_PER_TICK', async () => {
    const many = Array.from({ length: MAX_LOOPS_PER_TICK + 10 }, (_, i) => makeLoop(String(i)))
    const list = vi.fn(async () => many)
    const runCycle = vi.fn(async () => cycleResult())
    const r = await runLoopsTick(ENV, { list, runCycle })
    expect(runCycle).toHaveBeenCalledTimes(MAX_LOOPS_PER_TICK)
    expect(r.ran).toBe(MAX_LOOPS_PER_TICK)
  })

  it('a list failure is graceful (ok:false), not thrown', async () => {
    const list = vi.fn(async () => { throw new Error('d1 down') })
    const r = await runLoopsTick(ENV, { list, runCycle: vi.fn() })
    expect(r.ok).toBe(false)
    expect(r.ran).toBe(0)
  })

  it('one erroring cycle is counted and does not abort the sweep', async () => {
    const list = vi.fn(async () => [makeLoop('1'), makeLoop('2'), makeLoop('3')])
    const runCycle = vi
      .fn()
      .mockResolvedValueOnce(cycleResult({ acted: 1 }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(cycleResult({ acted: 1 }))
    const r = await runLoopsTick(ENV, { list, runCycle })
    expect(r.ran).toBe(2) // two completed
    expect(r.errors).toBe(1)
    expect(r.acted).toBe(2)
  })

  it('counts a cycle that returns ok:false as an error', async () => {
    const list = vi.fn(async () => [makeLoop('1')])
    const runCycle = vi.fn(async () => cycleResult({ ok: false, decided: 'budget_exhausted', acted: 0 }))
    const r = await runLoopsTick(ENV, { list, runCycle, ...dryNoop })
    expect(r.errors).toBe(1)
  })

  it('pauses an idle loop at dry_rounds_max', async () => {
    const loop = makeLoop('1')
    loop.stop = { dry_rounds_max: 3 }
    const list = vi.fn(async () => [loop])
    const runCycle = vi.fn(async () => cycleResult({ decided: 'dry', acted: 0 }))
    const bumpDry = vi.fn(async () => 3) // counter reaches the cap
    const pause = vi.fn(async () => true)
    const r = await runLoopsTick(ENV, { list, runCycle, bumpDry, resetDry: dryNoop.resetDry, pause })
    expect(bumpDry).toHaveBeenCalledWith(ENV, '1')
    expect(pause).toHaveBeenCalledWith(ENV, '1')
    expect(r.paused).toBe(1)
  })

  it('resets the dry counter on a productive tick', async () => {
    const list = vi.fn(async () => [makeLoop('1')])
    const runCycle = vi.fn(async () => cycleResult({ decided: 'acted' }))
    const resetDry = vi.fn(async () => {})
    await runLoopsTick(ENV, { list, runCycle, bumpDry: dryNoop.bumpDry, resetDry, pause: dryNoop.pause })
    expect(resetDry).toHaveBeenCalledWith(ENV, '1')
  })
})
