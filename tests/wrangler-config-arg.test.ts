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
import { matchConfigFlag, peekConfigArg, resolveAndStripConfigArg } from '../scripts/lib/wrangler-config-arg.mjs'

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

  // mupot#1529 round-1 P1-1: real wrangler 4.102.0 accepts FIVE spellings; the matcher
  // (and peekConfigArg) previously covered only three. Verified live against real wrangler
  // (see the "real wrangler dry-run" describe block below): `-c=/x/alt.toml` DOES load
  // alt.toml; `-cwrangler.acme.toml` (a realistic RELATIVE colony path) does NOT — yargs
  // treats the leading letters as bundled short flags — but that quirk is wrangler's own
  // parser, not a reason for THIS matcher to under-recognize the spelling: every consumer
  // here re-emits a canonical `--config <path>` downstream rather than forwarding the
  // fused token raw (see resolveAndStripConfigArg below), so recognizing the caller's
  // INTENT is what matters, not replicating wrangler's own fusion quirk.
  describe('the two previously-missing spellings: -c=<path> and -c<path> (fused)', () => {
    it('matches -c=<path> (short single-token form)', () => {
      expect(peekConfigArg(['-c=wrangler.acme.toml'])).toBe('wrangler.acme.toml')
      expect(matchConfigFlag(['-c=wrangler.acme.toml'], 0)).toEqual({ value: 'wrangler.acme.toml', consumed: 1 })
    })

    it('matches -c<path> (fused, no separator at all)', () => {
      expect(peekConfigArg(['-cwrangler.acme.toml'])).toBe('wrangler.acme.toml')
      expect(matchConfigFlag(['-cwrangler.acme.toml'], 0)).toEqual({ value: 'wrangler.acme.toml', consumed: 1 })
    })

    it('matches -c<path> for an absolute path (the exact shape the round-1 finding demonstrated live against real wrangler)', () => {
      expect(peekConfigArg(['-c/x/alt.toml'])).toBe('/x/alt.toml')
    })

    it('refuses -c= with an empty value', () => {
      expect(matchConfigFlag(['-c='], 0)).toBeNull()
    })

    it('refuses -c-x (fused value itself starts with -) — same dash-value discipline as every other spelling', () => {
      expect(matchConfigFlag(['-c-x'], 0)).toBeNull()
    })

    it('refuses -c=--x (fused-with-equals value starts with -)', () => {
      expect(matchConfigFlag(['-c=--x'], 0)).toBeNull()
    })

    it('does not confuse a bare "-c" (no fused suffix at all) with the fused form — still requires a separate value', () => {
      expect(matchConfigFlag(['-c'], 0)).toBeNull()
    })
  })

  // mupot#1529 round-1 P1-1: `--` end-of-options. Verified live: `wrangler deploy --dry-run
  // -- --config x` does NOT load `x` — everything after a bare `--` is positional/
  // passthrough, never one of wrangler's own flags.
  describe('-- end-of-options boundary', () => {
    it('peekConfigArg ignores a --config appearing AFTER a bare --', () => {
      expect(peekConfigArg(['--', '--config', 'x'])).toBeNull()
    })

    it('peekConfigArg still finds a --config appearing BEFORE a bare --', () => {
      expect(peekConfigArg(['--config', 'real.toml', '--', '--message', 'hi'])).toBe('real.toml')
    })

    it('a bare -- with nothing before or after it resolves to no config', () => {
      expect(peekConfigArg(['--'])).toBeNull()
    })
  })
})

describe('resolveAndStripConfigArg', () => {
  it('returns the config path and strips ONLY its own token(s) — --config <path> (2 tokens)', () => {
    expect(resolveAndStripConfigArg(['--config', 'w.toml', '--message', 'hi'])).toEqual({
      configPath: 'w.toml',
      rest: ['--message', 'hi'],
    })
  })

  it('strips a single-token form (--config=<path>) — exactly 1 token removed', () => {
    expect(resolveAndStripConfigArg(['--message', 'hi', '--config=w.toml'])).toEqual({
      configPath: 'w.toml',
      rest: ['--message', 'hi'],
    })
  })

  it('strips the short fused form (-c<path>) — exactly 1 token removed', () => {
    expect(resolveAndStripConfigArg(['-cw.toml', '--message', 'hi'])).toEqual({
      configPath: 'w.toml',
      rest: ['--message', 'hi'],
    })
  })

  it('returns configPath:null and an untouched copy of argv when no config flag is present', () => {
    const argv = ['--message', 'hi']
    const result = resolveAndStripConfigArg(argv)
    expect(result).toEqual({ configPath: null, rest: ['--message', 'hi'] })
    expect(result.rest).not.toBe(argv) // a copy, not the same array reference
  })

  it('never mutates the input array', () => {
    const argv = ['--config', 'w.toml', '--message', 'hi']
    const snapshot = [...argv]
    resolveAndStripConfigArg(argv)
    expect(argv).toEqual(snapshot)
  })

  it('preserves everything else in original order, including a bare -- and what follows it, byte-identical', () => {
    expect(resolveAndStripConfigArg(['--config', 'w.toml', 'a', '--', '--config', 'b'])).toEqual({
      configPath: 'w.toml',
      rest: ['a', '--', '--config', 'b'],
    })
  })

  it('ignores (and never strips) a --config appearing only AFTER a bare --', () => {
    expect(resolveAndStripConfigArg(['a', '--', '--config', 'w.toml'])).toEqual({
      configPath: null,
      rest: ['a', '--', '--config', 'w.toml'],
    })
  })

  it('last occurrence before -- wins, and only that occurrence is stripped', () => {
    expect(resolveAndStripConfigArg(['--config', 'first.toml', '-c', 'second.toml', '--message', 'hi'])).toEqual({
      configPath: 'second.toml',
      rest: ['--config', 'first.toml', '--message', 'hi'],
    })
  })
})
