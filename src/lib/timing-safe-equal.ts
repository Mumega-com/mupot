// mupot — shared constant-time string comparison.
//
// Replaces seven hand-rolled helpers in im, events/ingest, channel adapters,
// billing/admin, cc-spend, and integration webhook routes. The shared version
// never early-returns on length mismatch; that timing leak was the audit finding.

/**
 * Constant-time string comparison.
 *
 * Unlike the previous early-return helpers (`if (a.length !== b.length) return false`),
 * this folds the length difference into the accumulator and scans out to the
 * longer byte length. An attacker observing wall time learns nothing about
 * the shorter/equal length of the compared secrets. All code paths branch on
 * public values (the loop bound is max public length of the two strings).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}
