// tests/dispatch-delivery-mode.test.ts — resolveDispatchDeliveryMode + hasRegisteredDeliverySurface
// (src/bus/consumer.ts, mupot#1494). Pure and DB-free by design: this is the ONE routing
// predicate task_dispatch's consumer uses to decide "inbox envelope, or in-Worker AgentDO
// execution" — see the functions' own doc comments for the full reasoning. Unit-tested
// directly (no queue, no D1) so the rule itself, not just its side effects, is
// mutation-tested in isolation.
//
// Round 2 (P1-e) correction pinned here: `delivery:'inbox'` forcing used to win
// UNCONDITIONALLY (round 1), which could strand a task in an inbox nobody is known to poll.
// It now wins ONLY when the target has SOME registered delivery surface (poll-registered, or
// a runtime ever declared) — never against a target with literally no fleet row at all.

import { describe, expect, it } from 'vitest'
import { resolveDispatchDeliveryMode, hasRegisteredDeliverySurface, type DispatchDeliveryMode } from '../src/bus/consumer'
import type { FleetAgentRouteInfo } from '../src/fleet/registry'

function route(overrides: Partial<FleetAgentRouteInfo> = {}): Pick<FleetAgentRouteInfo, 'runtime' | 'live' | 'presenceMode'> {
  return { runtime: '', live: false, presenceMode: '', ...overrides }
}

describe('hasRegisteredDeliverySurface (mupot#1494 round 2, P1-e)', () => {
  it('false for a genuinely empty route (no fleet row at all)', () => {
    expect(hasRegisteredDeliverySurface(route())).toBe(false)
  })

  it('true for presence_mode=poll regardless of runtime or liveness', () => {
    expect(hasRegisteredDeliverySurface(route({ presenceMode: 'poll' }))).toBe(true)
    expect(hasRegisteredDeliverySurface(route({ presenceMode: 'poll', runtime: '', live: false }))).toBe(true)
  })

  it('true for ANY declared runtime, even if currently stale (registered != live)', () => {
    expect(hasRegisteredDeliverySurface(route({ runtime: 'claude-code', live: false }))).toBe(true)
  })

  it('false for presence_mode=resident with no runtime declared (a cleared/de-registered row)', () => {
    expect(hasRegisteredDeliverySurface(route({ presenceMode: 'resident', runtime: '' }))).toBe(false)
  })
})

describe('resolveDispatchDeliveryMode (mupot#1494)', () => {
  it('no fleet row at all (no runtime, not live, no presence mode) -> in_worker', () => {
    const mode: DispatchDeliveryMode = resolveDispatchDeliveryMode(route(), false)
    expect(mode).toBe('in_worker')
  })

  it('a live resident runtime (runtime set + live=true) -> inbox — the pre-#1494 condition, unchanged', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: 'claude-code', live: true }), false)
    expect(mode).toBe('inbox')
  })

  it('a STALE resident runtime (runtime set, live=false, no presence mode), UNFORCED -> in_worker — resident semantics unchanged', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: 'claude-code', live: false }), false)
    expect(mode).toBe('in_worker')
  })

  it('a poll-mode agent that is currently LIVE -> inbox', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: '', live: true, presenceMode: 'poll' }), false)
    expect(mode).toBe('inbox')
  })

  it('a poll-mode agent that is currently STALE still -> inbox (its ONLY delivery surface is the inbox — there is no in-Worker fallback that could ever reach it either)', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: '', live: false, presenceMode: 'poll' }), false)
    expect(mode).toBe('inbox')
  })

  it('presenceMode="poll" with an EMPTY runtime still -> inbox (the mode, not the runtime string, is what matters for a poller)', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: '', live: false, presenceMode: 'poll' }), false)
    expect(mode).toBe('inbox')
  })

  // ── round 2 (P1-e): force is eligibility-gated, never unconditional ──────────────────────

  it('forceInbox=true against a GENUINELY EMPTY route (no fleet row at all) -> in_worker — force must NOT strand a task in an unknown inbox', () => {
    const mode = resolveDispatchDeliveryMode(route(), true)
    expect(mode).toBe('in_worker')
  })

  it('forceInbox=true against a STALE-BUT-REGISTERED resident (runtime declared, not live) -> inbox — this is what force is FOR', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: 'claude-code', live: false }), true)
    expect(mode).toBe('inbox')
  })

  it('forceInbox=true against a presence_mode=resident row with no runtime (cleared/de-registered) -> in_worker', () => {
    const mode = resolveDispatchDeliveryMode(route({ presenceMode: 'resident', runtime: '' }), true)
    expect(mode).toBe('in_worker')
  })

  it('forceInbox=false with a live resident runtime still -> inbox via the normal condition (force is additive, never subtractive)', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: 'claude-code', live: true }), false)
    expect(mode).toBe('inbox')
  })

  it('only ever returns "inbox" or "in_worker" — never a third, silent option', () => {
    const allInputs: Array<[Pick<FleetAgentRouteInfo, 'runtime' | 'live' | 'presenceMode'>, boolean]> = [
      [route(), false],
      [route(), true],
      [route({ runtime: 'x', live: true }), false],
      [route({ runtime: 'x', live: false }), false],
      [route({ runtime: 'x', live: false }), true],
      [route({ presenceMode: 'poll' }), false],
      [route({ presenceMode: 'resident' }), false],
    ]
    for (const [r, force] of allInputs) {
      expect(['inbox', 'in_worker']).toContain(resolveDispatchDeliveryMode(r, force))
    }
  })
})
