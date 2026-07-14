// tests/dashboard-header-chips.test.ts — the shared shell's topbar regime +
// spend chips (wired live on /brain and /economy respectively).
//
// Covers the two pure render helpers directly (same pattern as economy/brain
// body tests — pure fn, assert on String(fn(...))):
//   - regimeChipHtml: live regime + C(t) + regime-derived color class when a
//     physics snapshot is passed; honest hidden "no data" state when null/undefined
//   - spendChipHtml: live "$X today" when configured; honest "no spend yet" when
//     cc_spend_daily has never been pushed to (configured: false); honest hidden
//     "not loaded on this page" state when the route didn't pass cost data at all

import { describe, it, expect } from 'vitest'
import { regimeChipHtml, spendChipHtml } from '../src/dashboard/index'
import type { PhysicsSnapshot } from '../src/dashboard/brain'

function snapshot(over: Partial<PhysicsSnapshot> = {}): PhysicsSnapshot {
  return {
    C: 0.842,
    R: 0.9,
    Psi: 0.05,
    ARF: 0.038,
    regime: 'flow',
    raw_C: 0.8,
    completed: 5,
    failed: 0,
    backlog: 2,
    had_signal: true,
    ts: 1_700_000_000,
    ...over,
  }
}

describe('regimeChipHtml', () => {
  it('renders the live regime, C(t), and the regime-derived color class when a snapshot exists', () => {
    const out = String(regimeChipHtml(snapshot({ regime: 'flow', C: 0.842 })))
    expect(out).toContain('regime-chip regime-flow') // reused from brain.ts's regimeBadgeClass
    expect(out).toContain('Flow')
    expect(out).toContain('C(t) 0.842')
    expect(out).not.toContain('display:none')
  })

  it('maps each regime to the color class brain.ts already uses (no re-derivation)', () => {
    expect(String(regimeChipHtml(snapshot({ regime: 'chaos' })))).toContain('regime-chaos')
    expect(String(regimeChipHtml(snapshot({ regime: 'coercion' })))).toContain('regime-coercion')
    expect(String(regimeChipHtml(snapshot({ regime: 'stall' })))).toContain('regime-stall')
  })

  it('renders an honest hidden "no data" state when there is no snapshot (null)', () => {
    const out = String(regimeChipHtml(null))
    expect(out).toContain('display:none')
    expect(out).toContain('—')
    expect(out).not.toContain('regime-flow')
    expect(out).not.toContain('regime-chaos')
  })

  it('renders the same honest hidden state when undefined (route did not wire physics at all)', () => {
    const out = String(regimeChipHtml(undefined))
    expect(out).toContain('display:none')
  })

  it('never fabricates a regime label or C(t) value when the snapshot is absent', () => {
    const out = String(regimeChipHtml(null))
    expect(out).not.toMatch(/C\(t\)\s*0\./) // no fake numeric coherence value
  })
})

describe('spendChipHtml', () => {
  it('renders a live "$X today" figure using the same formatUsd as the rest of the console', () => {
    const out = String(spendChipHtml({ configured: true, todayUsdMicro: 1_230_000 }))
    expect(out).toContain('$1.23 today')
    expect(out).not.toContain('no spend yet')
    expect(out).not.toContain('display:none')
  })

  it('renders an honest $0.00 (not "no data") when spend IS tracked but today is legitimately zero', () => {
    const out = String(spendChipHtml({ configured: true, todayUsdMicro: 0 }))
    expect(out).toContain('$0.00 today')
  })

  it('renders "no spend yet" (not a fabricated $0.00) when cc_spend_daily has never been configured', () => {
    const out = String(spendChipHtml({ configured: false, todayUsdMicro: 0 }))
    expect(out).toContain('no spend yet')
    expect(out).not.toContain('$0.00')
  })

  it('renders an honest hidden state when the route did not wire spend data at all (null/undefined)', () => {
    expect(String(spendChipHtml(null))).toContain('display:none')
    expect(String(spendChipHtml(undefined))).toContain('display:none')
  })
})
