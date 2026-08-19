import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { timingSafeEqual } from '../src/lib/crypto'

// mupot#989 / issue #982.
//
// Before this suite existed, the constant-time comparator had NO test of any kind, and
// there were ten near-identical copies of it across src/. That is how a tenth copy landed
// on 2026-08-17 (sentinel #1123) while a fix for the other nine sat in an unmerged branch:
// nothing anywhere could notice.
//
// Three things are pinned here, in increasing order of what they cost to get wrong:
//   1. the comparison still returns the right answers (guards the 9-module refactor)
//   2. a length mismatch does NOT short-circuit (the actual defect)
//   3. there is still exactly ONE implementation (stops copy number eleven)

describe('timingSafeEqual results', () => {
  it('accepts identical strings', () => {
    expect(timingSafeEqual('', '')).toBe(true)
    expect(timingSafeEqual('a', 'a')).toBe(true)
    expect(timingSafeEqual('correct-horse-battery-staple', 'correct-horse-battery-staple')).toBe(true)
  })

  it('rejects same-length strings that differ, at either end', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'zbc')).toBe(false)
    expect(timingSafeEqual('abc', 'axc')).toBe(false)
  })

  it('rejects strings of different length', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
    expect(timingSafeEqual('', 'a')).toBe(false)
    expect(timingSafeEqual('a', '')).toBe(false)
  })

  it('compares bytes, not UTF-16 code units', () => {
    // An accented character is one code unit but two UTF-8 bytes; a code-unit comparator
    // and a byte comparator disagree about the LENGTH of these, which is the axis at issue.
    expect(timingSafeEqual('é', 'é')).toBe(true)
    expect(timingSafeEqual('é', 'e')).toBe(false)
    // Astral-plane character: two UTF-16 code units, four UTF-8 bytes.
    expect(timingSafeEqual('🔑', '🔑')).toBe(true)
  })

  it('a trailing byte cannot be absorbed past the end of a shorter input', () => {
    // The loop reads past the end of the shorter array with `?? 0`. If the length were not
    // folded into the accumulator, a value whose extra bytes happened to XOR to zero would
    // compare equal to its own prefix.
    expect(timingSafeEqual('ab', 'ab\u0000')).toBe(false)
    expect(timingSafeEqual('ab\u0000', 'ab')).toBe(false)
  })
})

describe('a length mismatch does not short-circuit', () => {
  // This is the defect itself, and it is a TIMING property, so it cannot be asserted from
  // a return value. It is measured relatively rather than against a wall-clock threshold:
  // absolute timings vary by machine and make a flaky test, but the RATIO between "differs
  // in length" and "differs in the first byte" is a property of the algorithm.
  //
  //   early-return form : a length mismatch skips the loop entirely -> ratio near 0
  //   folded form       : both cases run the same max-length loop   -> ratio near 1
  //
  // The inputs are large enough that the loop dominates everything else, so the two shapes
  // are separated by orders of magnitude rather than by microseconds.
  const SIZE = 2_000_000
  const big = 'a'.repeat(SIZE)
  const bigDifferentFirstByte = 'b' + 'a'.repeat(SIZE - 1)
  const tiny = 'a'

  const medianMs = (fn: () => void, runs = 7): number => {
    const samples: number[] = []
    for (let i = 0; i < runs; i += 1) {
      const t0 = performance.now()
      fn()
      samples.push(performance.now() - t0)
    }
    samples.sort((x, y) => x - y)
    return samples[Math.floor(runs / 2)] ?? 0
  }

  it('spends comparable time on a length mismatch and a first-byte mismatch', () => {
    // Warm up both shapes, so JIT compilation is not charged to whichever is measured first.
    for (let i = 0; i < 3; i += 1) {
      timingSafeEqual(tiny, big)
      timingSafeEqual(big, bigDifferentFirstByte)
    }

    const lengthMismatch = medianMs(() => { timingSafeEqual(tiny, big) })
    const byteMismatch = medianMs(() => { timingSafeEqual(big, bigDifferentFirstByte) })

    expect(byteMismatch).toBeGreaterThan(0)
    const ratio = lengthMismatch / byteMismatch

    // The threshold is calibrated against measurement, not guessed. Both shapes were run
    // five times on the build host (Node 22, 4 vCPU):
    //
    //     folded    0.775  0.791  0.810  0.811  0.904
    //     early-return  0.090  0.162  0.297  0.297  0.343
    //
    // The early-return form does NOT sit near zero, which is the non-obvious part:
    // TextEncoder.encode runs in both shapes, and a 2 MB encode is a large fixed cost that a
    // skipped loop still pays. So the two distributions are 0.09-0.34 and 0.78-0.90, not
    // 0-and-1.
    //
    // The first draft of this test used 0.4 and was wrong: it left only 17% headroom above
    // the worst defective run, which is a false green waiting for a noisier box. 0.55 sits
    // ~1.6x above the worst defect and ~1.4x below the best fix — the widest margin these
    // two distributions allow. If this ever goes flaky, raise SIZE (which grows the loop
    // faster than the encode) rather than lowering the threshold.
    expect(ratio).toBeGreaterThan(0.55)
  })
})

describe('exactly one constant-time comparator exists', () => {
  // A source-shape assertion, which is a form this codebase has been burned by before
  // (mupot#1174: four authz source-greps that three text-preserving mutations survived).
  // This one is written against the mutation that actually happens - someone re-types the
  // eight-line helper into a new module instead of importing it, which is how the estate
  // reached ten copies - and it is mutation-verified by doing exactly that and watching
  // this test go red.
  //
  // src/auth/index.ts:constantTimeEqual is allowed and is NOT a defect: it already folds
  // the length (`let mismatch = actual.length ^ expected.length`) and predates this helper.
  // It is listed by name so that adding a SECOND exception is a deliberate edit here,
  // rather than something a regex quietly tolerates.
  const ALLOWED = new Set(['src/lib/crypto.ts', 'src/auth/index.ts'])

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (full.endsWith('.ts')) out.push(full)
    }
    return out
  }

  const candidates = (): string[] =>
    walk('src').map((f) => f.replace(/\\/g, '/')).filter((f) => !ALLOWED.has(f))

  it('no module defines its own byte-xor comparison loop', () => {
    // The signature of this primitive in every spelling the copies used: an accumulator
    // OR-assigned an XOR of two indexed reads.
    const XOR_ACCUMULATOR = /\|=\s*\(?\s*\w+(\[\w+\]|\.charCodeAt\(\w+\))/
    const offenders = candidates().filter((f) => XOR_ACCUMULATOR.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('no module declares its own comparator function', () => {
    const NAMED = /^\s*(export\s+)?function\s+\w*(?:[Ss]afeEqual|[Tt]imingSafe\w*|[Cc]onstantTime\w*)\s*\(/m
    const declarations = candidates().filter((f) => NAMED.test(readFileSync(f, 'utf8')))
    expect(declarations).toEqual([])
  })
})
