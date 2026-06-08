// tests/metabolism.test.ts — the pot heartbeat (src/agents/metabolism.ts).
//
// runMetabolism is pure orchestration over two seams (selectAgents + kick), so we
// drive it with injected mocks — no Durable Object, no D1. Covers: kicks each
// selected agent; one failing kick does not abort the sweep; empty selection;
// a thrown selection degrades gracefully; the per-tick cap is passed through.

import { describe, expect, it, vi } from 'vitest'
import { runMetabolism, MAX_AGENTS_PER_TICK } from '../src/agents/metabolism'
import type { Env } from '../src/types'

const ENV = {} as Env

describe('runMetabolism', () => {
  it('kicks every selected agent and counts successes', async () => {
    const selectAgents = vi.fn(async () => [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }])
    const kick = vi.fn(async () => true)

    const r = await runMetabolism(ENV, { selectAgents, kick })

    expect(r.ok).toBe(true)
    expect(r.scanned).toBe(3)
    expect(r.kicked).toBe(3)
    expect(r.failed).toBe(0)
    expect(kick).toHaveBeenCalledTimes(3)
    expect(kick).toHaveBeenCalledWith(ENV, 'a1')
    expect(kick).toHaveBeenCalledWith(ENV, 'a3')
  })

  it('a kick returning non-ok is counted failed, sweep continues', async () => {
    const selectAgents = vi.fn(async () => [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }])
    const kick = vi.fn(async (_e: Env, id: string) => id !== 'a2') // a2 fails

    const r = await runMetabolism(ENV, { selectAgents, kick })

    expect(r.kicked).toBe(2)
    expect(r.failed).toBe(1)
    expect(kick).toHaveBeenCalledTimes(3) // a3 still attempted after a2 failed
  })

  it('a kick that THROWS is counted failed, sweep continues', async () => {
    const selectAgents = vi.fn(async () => [{ id: 'a1' }, { id: 'a2' }])
    const kick = vi.fn(async (_e: Env, id: string) => {
      if (id === 'a1') throw new Error('DO unreachable')
      return true
    })

    const r = await runMetabolism(ENV, { selectAgents, kick })

    expect(r.failed).toBe(1)
    expect(r.kicked).toBe(1)
    expect(r.ok).toBe(true)
  })

  it('empty selection → nothing kicked, still ok', async () => {
    const selectAgents = vi.fn(async () => [])
    const kick = vi.fn(async () => true)

    const r = await runMetabolism(ENV, { selectAgents, kick })

    expect(r).toEqual({ ok: true, scanned: 0, kicked: 0, failed: 0 })
    expect(kick).not.toHaveBeenCalled()
  })

  it('a thrown selection degrades gracefully (ok:false, no crash)', async () => {
    const selectAgents = vi.fn(async () => {
      throw new Error('D1 down')
    })
    const kick = vi.fn(async () => true)

    const r = await runMetabolism(ENV, { selectAgents, kick })

    expect(r.ok).toBe(false)
    expect(r.scanned).toBe(0)
    expect(kick).not.toHaveBeenCalled()
  })

  it('passes the per-tick cap to selectAgents', async () => {
    const selectAgents = vi.fn(async () => [])
    await runMetabolism(ENV, { selectAgents, kick: vi.fn(async () => true) })
    expect(selectAgents).toHaveBeenCalledWith(ENV, MAX_AGENTS_PER_TICK)
  })
})
