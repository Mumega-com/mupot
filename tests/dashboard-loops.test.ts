// tests/dashboard-loops.test.ts — the /dashboard/loops view loader (#36 polish).
import { describe, expect, it, vi } from 'vitest'
import { loadLoopsView, loopsBody } from '../src/dashboard/loops'
import type { Env } from '../src/types'
import type { LoopManifest } from '../src/loops/manifest'

const ENV = { TENANT_SLUG: 't' } as unknown as Env

const loop = (over: Partial<LoopManifest> = {}): LoopManifest => ({
  id: 'l1', tenant: 't', squad_id: 'sq1', agent_id: null, status: 'active',
  okr: 'book meetings', kpi: { signal: 'positive_replies', target: 5 },
  sources: [], channels: [], gate: { require_approval: true },
  budget: { cap_micro_usd: 5_000_000, window: 'week', effort: 'standard' },
  cadence: {}, stop: {}, created_at: 'x', ...over,
})

describe('loadLoopsView', () => {
  it('maps loops + the prospect funnel counts', async () => {
    const list = vi.fn(async () => [loop()])
    const count = vi.fn(async (_e: Env, s: string) => ({ queued: 3, drafted: 1, sent: 2, replied: 1 } as Record<string, number>)[s] ?? 0)
    const v = await loadLoopsView(ENV, { list, count })
    expect(v.queued).toBe(3)
    expect(v.replied).toBe(1)
    expect(v.loops[0]).toMatchObject({ okr: 'book meetings', status: 'active', ownerKind: 'squad', kpiTarget: 5 })
  })

  it('renders without throwing for an empty pot', async () => {
    const v = await loadLoopsView(ENV, { list: async () => [], count: async () => 0 })
    const out = loopsBody(v)
    expect(out).toBeDefined()
    expect(v.loops).toHaveLength(0)
  })
})
