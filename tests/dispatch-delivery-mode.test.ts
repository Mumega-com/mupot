// tests/dispatch-delivery-mode.test.ts — resolveDispatchDeliveryMode (src/bus/consumer.ts,
// mupot#1494). Pure and DB-free by design: this is the ONE routing predicate task_dispatch's
// consumer uses to decide "inbox envelope, or in-Worker AgentDO execution" — see the function's
// own doc comment for the full reasoning. Unit-tested directly (no queue, no D1) so the rule
// itself, not just its side effects, is mutation-tested in isolation.

import { describe, expect, it } from 'vitest'
import { resolveDispatchDeliveryMode, type DispatchDeliveryMode } from '../src/bus/consumer'
import type { FleetAgentRouteInfo } from '../src/fleet/registry'

function route(overrides: Partial<FleetAgentRouteInfo> = {}): Pick<FleetAgentRouteInfo, 'runtime' | 'live' | 'presenceMode'> {
  return { runtime: '', live: false, presenceMode: '', ...overrides }
}

describe('resolveDispatchDeliveryMode (mupot#1494)', () => {
  it('no fleet row at all (no runtime, not live, no presence mode) -> in_worker', () => {
    const mode: DispatchDeliveryMode = resolveDispatchDeliveryMode(route(), false)
    expect(mode).toBe('in_worker')
  })

  it('a live resident runtime (runtime set + live=true) -> inbox — the pre-#1494 condition, unchanged', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: 'claude-code', live: true }), false)
    expect(mode).toBe('inbox')
  })

  it('a STALE resident runtime (runtime set, live=false, no presence mode) -> in_worker — resident semantics unchanged', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: 'claude-code', live: false }), false)
    expect(mode).toBe('in_worker')
  })

  it('a poll-mode agent that is currently LIVE -> inbox', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: 'poll', live: true, presenceMode: 'poll' }), false)
    expect(mode).toBe('inbox')
  })

  it('a poll-mode agent that is currently STALE still -> inbox (its ONLY delivery surface is the inbox — there is no in-Worker fallback that could ever reach it either)', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: 'poll', live: false, presenceMode: 'poll' }), false)
    expect(mode).toBe('inbox')
  })

  it('presenceMode="poll" with an EMPTY runtime still -> inbox (the mode, not the runtime string, is what matters for a poller)', () => {
    const mode = resolveDispatchDeliveryMode(route({ runtime: '', live: false, presenceMode: 'poll' }), false)
    expect(mode).toBe('inbox')
  })

  it('forceInbox=true overrides EVERYTHING, including a genuinely empty route -> inbox', () => {
    const mode = resolveDispatchDeliveryMode(route(), true)
    expect(mode).toBe('inbox')
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
      [route({ presenceMode: 'poll' }), false],
      [route({ presenceMode: 'resident' }), false],
    ]
    for (const [r, force] of allInputs) {
      expect(['inbox', 'in_worker']).toContain(resolveDispatchDeliveryMode(r, force))
    }
  })
})
