// tests/wrangler-config-arg.test.ts — scripts/lib/wrangler-config-arg.mjs, the ONE shared
// matcher for wrangler's `--config`/`-c` flag used by BOTH scripts/deploy.mjs (peek-only,
// forwards argv to wrangler unchanged) and scripts/build-pot-worker-bundle.mjs (allowlists
// its own argv against this shape). Kasra-core round-2 finding (2026-09-22): matching only
// the long `--config <path>` form let a `-c`/`--config=` deploy silently build+publish the
// DEFAULT wrangler.toml's bundle instead of the one actually deployed — this file pins all
// three spellings for both matchConfigFlag and peekConfigArg.

import { describe, it, expect } from 'vitest'
import { matchConfigFlag, peekConfigArg } from '../scripts/lib/wrangler-config-arg.mjs'

describe('matchConfigFlag', () => {
  it('matches the long space-separated form: --config <path>', () => {
    expect(matchConfigFlag(['--config', 'wrangler.acme.toml'], 0)).toEqual({
      value: 'wrangler.acme.toml',
      consumed: 2,
    })
  })

  it('matches the short space-separated form: -c <path>', () => {
    expect(matchConfigFlag(['-c', 'wrangler.acme.toml'], 0)).toEqual({
      value: 'wrangler.acme.toml',
      consumed: 2,
    })
  })

  it('matches the single-token equals form: --config=<path>', () => {
    expect(matchConfigFlag(['--config=wrangler.acme.toml'], 0)).toEqual({
      value: 'wrangler.acme.toml',
      consumed: 1,
    })
  })

  it('returns null for a bare trailing --config with no following value', () => {
    expect(matchConfigFlag(['--config'], 0)).toBeNull()
  })

  it('returns null for a bare trailing -c with no following value', () => {
    expect(matchConfigFlag(['-c'], 0)).toBeNull()
  })

  it('returns null for an unrelated argument', () => {
    expect(matchConfigFlag(['--outdir', '/tmp/x'], 0)).toBeNull()
  })

  it('returns null for --configXYZ (must not fuzzy-match a prefix)', () => {
    expect(matchConfigFlag(['--configXYZ=foo'], 0)).toBeNull()
  })

  it('matches at a non-zero index within a larger argv', () => {
    expect(matchConfigFlag(['--outdir', '/tmp/x', '--config', 'w.toml'], 2)).toEqual({
      value: 'w.toml',
      consumed: 2,
    })
  })
})

describe('peekConfigArg', () => {
  it('finds --config <path> anywhere in argv without needing it to be stripped', () => {
    expect(peekConfigArg(['--message', 'hi', '--config', 'wrangler.acme.toml'])).toBe('wrangler.acme.toml')
  })

  it('finds -c <path>', () => {
    expect(peekConfigArg(['-c', 'wrangler.acme.toml', '--message', 'hi'])).toBe('wrangler.acme.toml')
  })

  it('finds --config=<path>', () => {
    expect(peekConfigArg(['--message', 'hi', '--config=wrangler.acme.toml'])).toBe('wrangler.acme.toml')
  })

  it('returns null when no config flag is present', () => {
    expect(peekConfigArg(['--message', 'hi'])).toBeNull()
  })

  it('returns null for an empty argv', () => {
    expect(peekConfigArg([])).toBeNull()
  })

  it('last occurrence wins when the flag is repeated', () => {
    expect(peekConfigArg(['--config', 'first.toml', '-c', 'second.toml'])).toBe('second.toml')
  })

  it('never mutates the input array (a caller forwards it to wrangler unchanged)', () => {
    const argv = ['--config', 'wrangler.acme.toml', '--message', 'hi']
    const snapshot = [...argv]
    peekConfigArg(argv)
    expect(argv).toEqual(snapshot)
  })

  it('does not treat -c\'s value as itself a flag to re-scan (skips the consumed slot)', () => {
    // If peekConfigArg failed to skip the consumed value, a value that happens to look like
    // '--config' would be mis-parsed as a second flag occurrence.
    expect(peekConfigArg(['-c', '--config', '--message', 'hi'])).toBe('--config')
  })
})
