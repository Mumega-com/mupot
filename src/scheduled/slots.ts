// src/scheduled/slots.ts — which maintenance heartbeat runs on a given cron tick.
//
// Deliberately dependency-free (no cloudflare: imports, no Env) so it can be unit-tested directly.
// It was previously an inline expression in src/index.ts, which is how the defect below survived:
// there was nothing to point a test at.
//
// THE BUG THIS REPLACES. The selector was `scheduledAt.getUTCMinutes() % 15`, and the maintenance
// cron fires only on minutes 0-9, 15-24, 30-39, 45-54. EVERY one of those 40 minutes satisfies
// `minute % 15 ∈ 0..9`, so the selector could only ever address indices 0-9 — while the heartbeat
// array had ELEVEN entries. Slot [10] (`token-expiry-warning`, Flight-002) was unreachable and had
// NEVER RUN in production: the sweep built to warn operators before silent token expiry was itself
// silently disabled. `if (heartbeat)` swallows an undefined slot, so the miss looked exactly like a
// healthy tick and nothing ever failed.

/** The maintenance cron. Single source of truth — the firing minutes below are derived from it. */
export const MAINTENANCE_CRON = '0-9,15-24,30-39,45-54 * * * *'

/**
 * The minutes MAINTENANCE_CRON actually fires on, PARSED FROM THE CRON rather than restated.
 * Restating them is how a selector and its schedule drift apart without anyone noticing.
 */
export const MAINTENANCE_FIRING_MINUTES: readonly number[] = Object.freeze(
  MAINTENANCE_CRON.split(' ')[0]
    .split(',')
    .flatMap((range) => {
      const [lo, hi] = range.split('-').map(Number)
      return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
    }),
)

/**
 * Pick the heartbeat index for this tick.
 *
 * Using the WINDOW as well as the offset gives 4 windows × 10 offsets = 40 addressable ticks per
 * hour, so a heartbeat array of any length up to 40 is fully reachable.
 *
 * DO NOT revert this to a plain modulo of the minute, and DO NOT append a heartbeat without
 * running tests/maintenance-heartbeat-slots.test.ts — it asserts every index is selected by at
 * least one firing minute, which is the only thing that makes "I added a heartbeat" and "the
 * heartbeat runs" the same statement.
 */
export function maintenanceSlot(minuteUtc: number, heartbeatCount: number): number {
  const window = Math.floor(minuteUtc / 15) // 0..3 across the hour
  const offset = minuteUtc % 15 // 0..9 under MAINTENANCE_CRON
  return (window * 10 + offset) % heartbeatCount
}
