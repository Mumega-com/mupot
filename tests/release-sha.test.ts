// tests/release-sha.test.ts — scripts/lib/release-sha.mjs, the single shared
// implementation both deploy entrypoints (scripts/deploy.mjs and
// scripts/mupot-update.mjs) use to stamp RELEASE_SHA. Closes mupot#443 Part A:
// GET /health must never report a stale or hand-maintained commit — this
// covers the logic that keeps a bad value from ever being sent to `wrangler
// deploy` in the first place.

import { describe, it, expect } from 'vitest'
import { isFullSha, releaseShaDeployArgs } from '../scripts/lib/release-sha.mjs'

describe('isFullSha', () => {
  it('accepts a full 40-hex lowercase commit sha', () => {
    expect(isFullSha('a'.repeat(40))).toBe(true)
  })

  it('accepts a full 40-hex uppercase commit sha (git is case-insensitive here)', () => {
    expect(isFullSha('A'.repeat(40))).toBe(true)
  })

  it('rejects a short sha', () => {
    expect(isFullSha('a1b2c3d')).toBe(false)
  })

  it('rejects a branch name', () => {
    expect(isFullSha('main')).toBe(false)
  })

  it('rejects empty string, undefined, and null', () => {
    expect(isFullSha('')).toBe(false)
    expect(isFullSha(undefined)).toBe(false)
    expect(isFullSha(null)).toBe(false)
  })

  it('rejects a 40-char string with a non-hex character', () => {
    expect(isFullSha('g'.repeat(40))).toBe(false)
  })
})

describe('releaseShaDeployArgs', () => {
  it('returns --var RELEASE_SHA:<sha> for a valid full sha', () => {
    const sha = 'b'.repeat(40)
    expect(releaseShaDeployArgs(sha)).toEqual(['--var', `RELEASE_SHA:${sha}`])
  })

  it('throws rather than silently degrading when the sha is short', () => {
    expect(() => releaseShaDeployArgs('a1b2c3d')).toThrow(/not a full 40-hex commit sha/)
  })

  it('throws when the sha is a branch name (the exact failure mode that shipped commit: null)', () => {
    expect(() => releaseShaDeployArgs('main')).toThrow()
  })

  it('throws when the sha is empty', () => {
    expect(() => releaseShaDeployArgs('')).toThrow()
  })
})
