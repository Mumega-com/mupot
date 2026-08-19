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
 * RESIDUAL, stated plainly because the previous comments in this codebase
 * claimed more than they delivered: this loop runs `max(a, b)` times, so the
 * running time still depends on the longer input. Where the caller compares a
 * variable-length secret (a bearer token), an attacker who sends a very short
 * value can still observe work proportional to the secret's length. Closing
 * that completely means digesting both sides to a fixed width before
 * comparing, which is async under Workers' `crypto.subtle` and would change
 * every caller's signature. It has NOT been done here. See the call-site map
 * in `tests/timing-safe-equal.test.ts` for which callers are affected: the
 * five HMAC-hex callers are unaffected either way, because one side is a
 * fixed-width digest and its length is not a secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  // Seed with the length delta instead of returning early on it.
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}
