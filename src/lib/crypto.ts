/**
 * Constant-time comparison for secrets and signatures.
 *
 * This is the ONLY constant-time comparator in the codebase outside
 * `src/auth/index.ts:constantTimeEqual`. It used to be one of ten near-identical
 * copies; nine were folded into this one because a security primitive that is
 * cheap to re-type is a primitive that drifts. A tenth copy landed on 2026-08-17
 * (sentinel #1123) while the fix for the other nine was sitting in an unmerged
 * branch — `tests/timing-safe-equal.test.ts` now fails if an eleventh appears.
 *
 * The length difference is folded into the accumulator rather than short-
 * circuiting on it. The old form was:
 *
 *     if (ab.length !== bb.length) return false
 *
 * which answers "wrong length" from a single branch and "wrong bytes" from a
 * full loop. Those two answers take very different amounts of time, so an
 * attacker who can vary the length of what they send and time the response
 * learns the length of the secret — which is exactly the search-space
 * reduction a bearer token's length is supposed to hide.
 *
 * FIXED WIDTH (mupot#982): the loop used to run `max(a, b)` times, so a 1-byte guess against a
 * long secret still took time proportional to the secret's length. It now runs a fixed
 * `CONSTANT_TIME_WIDTH` iterations for any input up to that many bytes, and a whole number of
 * width-sized blocks beyond it. Comparing a guess of any length against a secret of up to
 * 1024 bytes therefore costs the same, which covers every bearer token, webhook key and HMAC
 * hex digest in this codebase. Comparison is over UTF-8 bytes, and TextEncoder maps every lone
 * surrogate to U+FFFD, so two strings differing only in lone surrogates compare equal; all secrets here
 * are ASCII, so this is noted rather than handled. Residual: a secret LONGER than the width still shows its
 * length to the nearest block when the guess is shorter; none of ours are.
 */
export const CONSTANT_TIME_WIDTH = 1024

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  // Seed with the length delta instead of returning early on it.
  let diff = ab.length ^ bb.length
  const longest = Math.max(ab.length, bb.length)
  const len = Math.max(CONSTANT_TIME_WIDTH, Math.ceil(longest / CONSTANT_TIME_WIDTH) * CONSTANT_TIME_WIDTH)
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}
