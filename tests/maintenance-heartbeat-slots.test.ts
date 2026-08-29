import { describe, expect, it } from 'vitest'

import { MAINTENANCE_FIRING_MINUTES, maintenanceSlot } from '../src/scheduled/slots'

// Reachability of maintenance heartbeat slots.
//
// WHY THIS FILE EXISTS. The selector was `scheduledAt.getUTCMinutes() % 15`, and the maintenance
// cron fires only on 0-9, 15-24, 30-39, 45-54. Every one of those 40 minutes satisfies
// `minute % 15 ∈ 0..9`, so the selector could only address indices 0-9 — while the array had
// ELEVEN entries. Slot [10] (`token-expiry-warning`, Flight-002) had NEVER RUN in production.
// `if (heartbeat)` swallows an undefined slot, so the miss was indistinguishable from a healthy
// tick and nothing failed for as long as it existed.
//
// The assertion that matters is not "the selector returns a number". It is that EVERY index is
// selected by at least one firing minute — i.e. that "I added a heartbeat" and "the heartbeat
// runs" are the same statement.

/** Every slot index the selector can actually produce, given the cron's real firing minutes. */
function reachableSlots(count: number): Set<number> {
  return new Set(MAINTENANCE_FIRING_MINUTES.map((m) => maintenanceSlot(m, count)))
}

describe('maintenance heartbeat slot selection', () => {
  it('derives the firing minutes from MAINTENANCE_CRON itself, so the two cannot drift', () => {
    // 4 windows × 10 minutes. If the cron is edited, this number moves with it — the point is
    // that the test reads the cron rather than restating it.
    expect(MAINTENANCE_FIRING_MINUTES).toHaveLength(40)
    expect(MAINTENANCE_FIRING_MINUTES).toContain(0)
    expect(MAINTENANCE_FIRING_MINUTES).toContain(54)
    // Minutes the cron does NOT cover must be absent, or a "reachable" claim would be fiction.
    expect(MAINTENANCE_FIRING_MINUTES).not.toContain(10)
    expect(MAINTENANCE_FIRING_MINUTES).not.toContain(25)
  })

  it('reaches EVERY index for an eleven-heartbeat array', () => {
    const slots = reachableSlots(11)
    expect([...slots].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('specifically reaches slot 10 — the token-expiry-warning that never ran', () => {
    // Named on its own because this is the row that was dead in production, and a regression
    // here is not a style issue: it silently disables a security sweep.
    expect(reachableSlots(11).has(10)).toBe(true)
  })

  it('reaches every index for any heartbeat count up to the 40 addressable ticks', () => {
    // Guards the NEXT person who appends. A count that leaves a hole must fail here, not in prod.
    for (let count = 1; count <= 40; count += 1) {
      const slots = reachableSlots(count)
      const missing = Array.from({ length: count }, (_, i) => i).filter((i) => !slots.has(i))
      expect(missing, `heartbeat count ${count} leaves unreachable slots ${missing.join(',')}`)
        .toEqual([])
    }
  })

  it('stays within bounds for every firing minute', () => {
    for (const count of [1, 5, 11, 12, 40]) {
      for (const minute of MAINTENANCE_FIRING_MINUTES) {
        const slot = maintenanceSlot(minute, count)
        expect(Number.isInteger(slot)).toBe(true)
        expect(slot).toBeGreaterThanOrEqual(0)
        expect(slot).toBeLessThan(count)
      }
    }
  })

  it('the OLD `% 15` selector fails these assertions — proving they are load-bearing', () => {
    // A test that passes under both the bug and the fix proves nothing. This pins the exact
    // defect: the previous selector could not address slot 10 for an eleven-entry array, and
    // could not address 10 or 11 for a twelve-entry one.
    const oldSelector = (minute: number, _count: number) => minute % 15
    const oldSlots = new Set(MAINTENANCE_FIRING_MINUTES.map((m) => oldSelector(m, 11)))

    expect(oldSlots.has(10)).toBe(false)
    expect([...oldSlots].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

    // And it would have swallowed a twelfth heartbeat too — which is how wiring the flight
    // watchdog (#1138) as entry [11] would have shipped a fix that never ran.
    const oldSlotsTwelve = new Set(MAINTENANCE_FIRING_MINUTES.map((m) => oldSelector(m, 12)))
    expect(oldSlotsTwelve.has(10)).toBe(false)
    expect(oldSlotsTwelve.has(11)).toBe(false)

    // The new selector covers both cases (12 and 13).
    expect(reachableSlots(12).has(10)).toBe(true)
    expect(reachableSlots(12).has(11)).toBe(true)
    expect(reachableSlots(13).has(12)).toBe(true)
  })
})
