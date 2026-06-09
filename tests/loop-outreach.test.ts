// tests/loop-outreach.test.ts — the outreach reason + KPI seams (P4, #35).

import { describe, expect, it, vi } from 'vitest'
import { makeOutreachReason, makeOutreachObserveKpi } from '../src/loops/outreach'
import type { ReasonInput } from '../src/loops/runtime'
import type { LoopManifest } from '../src/loops/manifest'
import type { Env, ModelPort } from '../src/types'

const ENV = { TENANT_SLUG: 't' } as unknown as Env

const loop = { okr: 'sell grant diagnostics', kpi: { signal: 'positive_replies', target: 5 } } as LoopManifest

const okModel = (json: string): ModelPort => ({ chat: vi.fn(async () => json) })

function input(over: Partial<ReasonInput> = {}): ReasonInput {
  return {
    loop,
    budget: 1,
    context: [
      { id: 'p1', title: 'Acme', email: 'sam@acme.com', consent_basis: 'consent', text: 'maker' },
    ],
    ...over,
  }
}

describe('makeOutreachReason', () => {
  it('drafts a gated send_email act for a prospect and CONSUMES it (marks drafted)', async () => {
    const markDrafted = vi.fn(async () => true)
    const reason = makeOutreachReason({ model: okModel('{"subject":"Hi Acme","body":"...\\nunsubscribe"}'), markDrafted })
    const acts = await reason(ENV, input())
    expect(acts).toHaveLength(1)
    expect(acts[0].tool).toBe('send_email')
    expect(acts[0].args).toMatchObject({ to: 'sam@acme.com', subject: 'Hi Acme', prospect_id: 'p1', consent_basis: 'consent' })
    expect(markDrafted).toHaveBeenCalledWith(ENV, 'p1') // dedup: prospect consumed
  })

  it('respects the effort budget (drafts at most `budget` prospects)', async () => {
    const markDrafted = vi.fn(async () => true)
    const reason = makeOutreachReason({ model: okModel('{"subject":"s","body":"b"}'), markDrafted })
    const ctx = [
      { id: 'p1', email: 'a@y.com' }, { id: 'p2', email: 'b@y.com' }, { id: 'p3', email: 'c@y.com' },
    ]
    const acts = await reason(ENV, input({ budget: 2, context: ctx }))
    expect(acts).toHaveLength(2)
    expect(markDrafted).toHaveBeenCalledTimes(2)
  })

  it('skips items with no email (safe for non-prospect sources)', async () => {
    const reason = makeOutreachReason({ model: okModel('{"subject":"s","body":"b"}'), markDrafted: vi.fn() })
    const acts = await reason(ENV, input({ context: [{ id: 'x', text: 'a memory note' }] }))
    expect(acts).toHaveLength(0)
  })

  it('skips a prospect when the model returns unparseable output (no act, no consume)', async () => {
    const markDrafted = vi.fn(async () => true)
    const reason = makeOutreachReason({ model: okModel('sorry I cannot'), markDrafted })
    const acts = await reason(ENV, input())
    expect(acts).toHaveLength(0)
    expect(markDrafted).not.toHaveBeenCalled()
  })
})

describe('makeOutreachObserveKpi', () => {
  it('progress = replied ÷ target × 100', async () => {
    const observe = makeOutreachObserveKpi({ countReplied: async () => 2 })
    expect(await observe(ENV, loop)).toBe(40) // 2/5
  })
  it('clamps to 100', async () => {
    const observe = makeOutreachObserveKpi({ countReplied: async () => 99 })
    expect(await observe(ENV, loop)).toBe(100)
  })
})
