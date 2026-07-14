// tests/dashboard-economy-scalar.test.ts — loadTodaySpendScalar (the LIGHT
// today-spend read used by high-traffic header-chip pages: Overview, Agents,
// Fleet). ONE D1 round trip (a single .first() call), vs loadEconomy's 5
// parallel queries — see economy.ts for the full rationale.

import { describe, it, expect, vi } from 'vitest'
import { loadTodaySpendScalar } from '../src/dashboard/economy'
import type { Env } from '../src/types'

function makeEnv(row: { today_usd_micro: number; has_any: number } | null): { env: Env; prepare: ReturnType<typeof vi.fn> } {
  const stmt = {
    bind: vi.fn((..._args: unknown[]) => stmt),
    first: vi.fn(async () => row),
  }
  const prepare = vi.fn(() => stmt)
  return { env: { DB: { prepare } } as unknown as Env, prepare }
}

describe('loadTodaySpendScalar', () => {
  it('is a single D1 round trip (.prepare called exactly once)', async () => {
    const { env, prepare } = makeEnv({ today_usd_micro: 1_000_000, has_any: 1 })
    await loadTodaySpendScalar(env)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('returns configured: true and the real figure when spend has been tracked', async () => {
    const { env } = makeEnv({ today_usd_micro: 2_500_000, has_any: 1 })
    const r = await loadTodaySpendScalar(env)
    expect(r).toEqual({ configured: true, today_usd_micro: 2_500_000 })
  })

  it('returns configured: true with today_usd_micro: 0 when spend is tracked but zero today (not "unconfigured")', async () => {
    const { env } = makeEnv({ today_usd_micro: 0, has_any: 1 })
    const r = await loadTodaySpendScalar(env)
    expect(r).toEqual({ configured: true, today_usd_micro: 0 })
  })

  it('returns configured: false when cc_spend_daily has never had a row (has_any: 0)', async () => {
    const { env } = makeEnv({ today_usd_micro: 0, has_any: 0 })
    const r = await loadTodaySpendScalar(env)
    expect(r).toEqual({ configured: false, today_usd_micro: 0 })
  })

  it('degrades to the honest-empty default when the query returns no row at all', async () => {
    const { env } = makeEnv(null)
    const r = await loadTodaySpendScalar(env)
    expect(r).toEqual({ configured: false, today_usd_micro: 0 })
  })
})
