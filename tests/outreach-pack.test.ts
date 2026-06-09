// tests/outreach-pack.test.ts — one-click outreach seeder (P5, #36).
import { describe, expect, it, vi } from 'vitest'
import { seedOutreachLoop } from '../src/loops/outreach-pack'
import type { Env, Squad } from '../src/types'

const ENV = { TENANT_SLUG: 't' } as unknown as Env
const okSquad = vi.fn(async () => ({ ok: true as const, value: { id: 'sq-1' } as Squad }))
const resolveDepartmentId = vi.fn(async () => 'dept-1')

describe('seedOutreachLoop', () => {
  it('fails when there is no department', async () => {
    const r = await seedOutreachLoop(ENV, { resolveDepartmentId: vi.fn(async () => null) })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('no_department')
  })

  it('creates the Outreach squad + a GATED outreach loop (queue source, no channels)', async () => {
    const createLoop = vi.fn(async () => ({ ok: true as const, value: { id: 'loop-1' } as never }))
    const r = await seedOutreachLoop(ENV, { createSquad: okSquad, createLoop, resolveDepartmentId })
    expect(r.ok).toBe(true)
    expect(r.squad?.id).toBe('sq-1')
    expect(r.loop?.id).toBe('loop-1')
    expect(okSquad).toHaveBeenCalledWith(ENV, 'dept-1', expect.objectContaining({ slug: 'outreach' }))
    const [, spec] = createLoop.mock.calls[0]
    expect(spec.squad_id).toBe('sq-1')
    expect(spec.gate.require_approval).toBe(true) // every send human-gated
    expect(spec.sources[0].kind).toBe('queue')
    expect(spec.channels).toEqual([]) // send via the gated GHL act pipeline
  })

  it('aborts before the loop when the squad create fails', async () => {
    const createLoop = vi.fn()
    const r = await seedOutreachLoop(ENV, {
      createSquad: vi.fn(async () => ({ ok: false as const, error: 'slug_taken' })),
      createLoop, resolveDepartmentId,
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('slug_taken')
    expect(createLoop).not.toHaveBeenCalled()
  })

  it('reports a loop-create failure but returns the created squad', async () => {
    const createLoop = vi.fn(async () => ({ ok: false as const, error: 'invalid_okr' }))
    const r = await seedOutreachLoop(ENV, { createSquad: okSquad, createLoop, resolveDepartmentId })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_okr')
    expect(r.squad?.id).toBe('sq-1')
  })
})
