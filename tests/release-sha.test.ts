// tests/release-sha.test.ts — scripts/lib/release-sha.mjs, the single shared
// implementation both deploy entrypoints (scripts/deploy.mjs and
// scripts/mupot-update.mjs) use to stamp RELEASE_SHA. Closes mupot#443 Part A:
// GET /health must never report a stale or hand-maintained commit — this
// covers the logic that keeps a bad value from ever being sent to `wrangler
// deploy` in the first place.
//
// mupot#571 review fixes covered here:
//   1. assertNoCallerReleaseSha — a caller must never be able to inject an
//      arbitrary RELEASE_SHA via forwarded/extra CLI args.
//   2. releaseShaDeployArgs({ clean: false }) / isMainDescendant — a dirty
//      tree or an off-main HEAD must never produce a bare "clean-looking"
//      stamp.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  isFullSha,
  isValidStamp,
  isMainDescendant,
  assertNoCallerReleaseSha,
  releaseShaDeployArgs,
} from '../scripts/lib/release-sha.mjs'

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

  // mupot#571 fix 2 — a dirty tree or off-main HEAD must never advertise a
  // bare, clean-looking sha. The pre-#571-fix signature ignores any 2nd arg
  // entirely and always returns the bare sha — this is the exact regression
  // that let a dirty/off-main deploy look indistinguishable from a real
  // clean release.
  it('stamps a bare sha by default (clean, the common case)', () => {
    const sha = 'c'.repeat(40)
    expect(releaseShaDeployArgs(sha)).toEqual(['--var', `RELEASE_SHA:${sha}`])
  })

  it('appends -dirty when clean:false, so an unverified build can never look like a clean release', () => {
    const sha = 'c'.repeat(40)
    expect(releaseShaDeployArgs(sha, { clean: false })).toEqual(['--var', `RELEASE_SHA:${sha}-dirty`])
  })

  it('stamps a bare sha when clean:true is explicit', () => {
    const sha = 'd'.repeat(40)
    expect(releaseShaDeployArgs(sha, { clean: true })).toEqual(['--var', `RELEASE_SHA:${sha}`])
  })
})

describe('isValidStamp', () => {
  it('accepts a bare full sha', () => {
    expect(isValidStamp('a'.repeat(40))).toBe(true)
  })
  it('accepts a full sha with the -dirty suffix', () => {
    expect(isValidStamp(`${'a'.repeat(40)}-dirty`)).toBe(true)
  })
  it('rejects garbage', () => {
    expect(isValidStamp('not-a-sha')).toBe(false)
    expect(isValidStamp(`${'a'.repeat(39)}-dirty`)).toBe(false)
  })
})

// mupot#571 fix 1 — RELEASE_SHA must be derived from git ONLY. A caller
// forwarding extra CLI args to `wrangler deploy` (scripts/deploy.mjs) must
// never be able to smuggle in its own `--var RELEASE_SHA:...` and have it
// win over the value this module computed from `git rev-parse HEAD`.
describe('assertNoCallerReleaseSha', () => {
  it('allows ordinary forwarded wrangler args through untouched', () => {
    expect(() => assertNoCallerReleaseSha(['--config', 'wrangler.acme.toml', '--message', 'hi'])).not.toThrow()
  })

  it('allows an empty/undefined arg list', () => {
    expect(() => assertNoCallerReleaseSha([])).not.toThrow()
    expect(() => assertNoCallerReleaseSha(undefined)).not.toThrow()
  })

  it('allows a --var that stamps a DIFFERENT key', () => {
    expect(() => assertNoCallerReleaseSha(['--var', 'SOME_OTHER_VAR:x'])).not.toThrow()
  })

  it('refuses a caller-supplied `--var RELEASE_SHA:<forged-sha>` override (the injection this closes)', () => {
    const forged = 'e'.repeat(40)
    expect(() => assertNoCallerReleaseSha(['--var', `RELEASE_SHA:${forged}`])).toThrow(
      /refusing caller-supplied RELEASE_SHA override/,
    )
  })

  it('refuses the --var=KEY:VALUE spelling too', () => {
    const forged = 'f'.repeat(40)
    expect(() => assertNoCallerReleaseSha([`--var=RELEASE_SHA:${forged}`])).toThrow(
      /refusing caller-supplied RELEASE_SHA override/,
    )
  })

  it('refuses regardless of where in the arg list the override appears', () => {
    const forged = '1'.repeat(40)
    expect(() =>
      assertNoCallerReleaseSha(['--config', 'wrangler.acme.toml', '--var', `RELEASE_SHA:${forged}`, '--message', 'hi']),
    ).toThrow(/refusing caller-supplied RELEASE_SHA override/)
  })
})

// mupot#571 fix 2 (off-main half) — isMainDescendant against a REAL git repo,
// not a mock, since this is exactly the git-ancestry logic that decides
// whether a deploy is allowed to claim "clean". Exercises actual `git
// merge-base --is-ancestor` behavior end to end.
describe('isMainDescendant', () => {
  let repo

  function git(...args) {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout.trim()
  }

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
    repo = undefined
  })

  it('is true for main HEAD itself, and false for a commit only on a divergent branch', () => {
    repo = mkdtempSync(join(tmpdir(), 'release-sha-test-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(join(repo, 'a.txt'), '1')
    git('add', '.')
    git('commit', '-q', '-m', 'initial')
    const mainSha = git('rev-parse', 'HEAD')

    expect(isMainDescendant(mainSha, { cwd: repo })).toBe(true)

    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(repo, 'b.txt'), '2')
    git('add', '.')
    git('commit', '-q', '-m', 'feature work')
    const featureSha = git('rev-parse', 'HEAD')

    // Feature commit is NOT on/descended-from main — must fail closed.
    expect(isMainDescendant(featureSha, { cwd: repo })).toBe(false)

    git('checkout', '-q', 'main')
    writeFileSync(join(repo, 'c.txt'), '3')
    git('add', '.')
    git('commit', '-q', '-m', 'second main commit')
    const secondMainSha = git('rev-parse', 'HEAD')

    // A later commit ON main is a descendant of the first main commit... but
    // what matters for a deploy is the OTHER direction: is THIS sha itself
    // reachable from main. Confirm the fresh main tip is on main.
    expect(isMainDescendant(secondMainSha, { cwd: repo })).toBe(true)
    // ...and the stale feature branch commit still isn't, even after main moved.
    expect(isMainDescendant(featureSha, { cwd: repo })).toBe(false)
  })

  it('fails closed (false) for an unresolvable sha', () => {
    repo = mkdtempSync(join(tmpdir(), 'release-sha-test-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(join(repo, 'a.txt'), '1')
    git('add', '.')
    git('commit', '-q', '-m', 'initial')

    expect(isMainDescendant('a'.repeat(40), { cwd: repo })).toBe(false)
  })
})
