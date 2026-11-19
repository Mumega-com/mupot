// mupot — notify kernel: pure policy functions (no I/O, no clock reads; callers pass `now`).
import type { Severity } from './carry'

export const DEDUPE_WINDOW_MS = 10 * 60 * 1000
export const DEFAULT_RATE_CAP_PER_HOUR = 20
export const RATE_WINDOW_MS = 60 * 60 * 1000

/** True when an earlier identical event (same recipient + dedupe key) is still inside the window. */
export function isDuplicate(windowStartMs: number | null, nowMs: number, windowMs: number = DEDUPE_WINDOW_MS): boolean {
  return windowStartMs !== null && nowMs - windowStartMs < windowMs
}

/** Critical is exempt from the cap; everything else is capped once `recentPushCount` reaches `cap`. */
export function isRateCapped(severity: Severity, recentPushCount: number, cap: number = DEFAULT_RATE_CAP_PER_HOUR): boolean {
  if (severity === 'critical') return false
  return recentPushCount >= cap
}
