// tests/wrangler-config-arg.test.ts — scripts/lib/wrangler-config-arg.mjs, the ONE shared
// matcher for wrangler's `--config`/`-c` flag used by BOTH scripts/deploy.mjs (peek-only,
// forwards argv to wrangler unchanged) and scripts/build-pot-worker-bundle.mjs (allowlists
// its own argv against this shape). Kasra-core round-2 finding (2026-09-22): matching only
// the long `--config <path>` form let a `-c`/`--config=` deploy silently build+publish the
// DEFAULT wrangler.toml's bundle instead of the one actually deployed — this file pins all
// three spellings for both matchConfigFlag and peekConfigArg.
//
// mupot#1524 round-2 P2-2 (successor PR): a value that itself starts with `-`
// (`--config --dry-run=false`, `--config=--x`, `-c --help`) is now REFUSED rather than
// accepted as a literal config path — a caller could otherwise smuggle a second flag in as
// if it were `--config`'s value (proved live: `--config --help` used to forward
// `--config --help` to `wrangler deploy --dry-run`, which printed wrangler's own help text
// and exited 0 — looked like a successful dry-run build; built no bundle at all).

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

  // mupot#1524 round-2 P2-2 — a value starting with `-` is refused for every spelling.
  it('returns null for --config --dry-run=false (a flag masquerading as the value)', () => {
    expect(matchConfigFlag(['--config', '--dry-run=false'], 0)).toBeNull()
  })

  it('returns null for --config=--x (single-token form, dash-prefixed value)', () => {
    expect(matchConfigFlag(['--config=--x'], 0)).toBeNull()
  })

  it('returns null for -c --help', () => {
    expect(matchConfigFlag(['-c', '--help'], 0)).toBeNull()
  })

  it('returns null for -c -x (even a short-flag-shaped value)', () => {
    expect(matchConfigFlag(['-c', '-x'], 0)).toBeNull()
  })

  it('still matches a legitimate path that merely CONTAINS a dash (not at the start)', () => {
    expect(matchConfigFlag(['--config', 'wrangler-acme.toml'], 0)).toEqual({
      value: 'wrangler-acme.toml',
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

  it('does not treat a MATCHED flag\'s consumed value as itself a flag to re-scan', () => {
    // '-c wrangler-acme.toml' is matched and its value consumed; peekConfigArg must not
    // then also examine 'wrangler-acme.toml' as if it were its own argv position.
    expect(peekConfigArg(['-c', 'wrangler-acme.toml', '--message', 'hi'])).toBe('wrangler-acme.toml')
  })

  // mupot#1524 round-2 P2-2 (successor PR): this replaces a prior test asserting that
  // `-c --config` matched '--config' AS `-c`'s literal value — that was exactly the
  // "flag masquerading as a value" hole P2-2 closes. Since `matchConfigFlag` now refuses a
  // dash-prefixed value, the malformed `-c` is skipped (no match, nothing consumed), and
  // peekConfigArg's normal per-index scan reaches the SUBSEQUENT `--config` token on its
  // own next iteration and matches IT instead — never treating the rejected value as a
  // literal path.
  it('a malformed -c (dash-prefixed value) does not shadow a real --config flag later in argv', () => {
    expect(peekConfigArg(['-c', '--config', 'real-path.toml', '--message', 'hi'])).toBe('real-path.toml')
  })

  it('never returns a dash-prefixed string as a config value, even at the end of argv', () => {
    expect(peekConfigArg(['--message', 'hi', '--config', '--not-a-path'])).toBeNull()
  })
})
