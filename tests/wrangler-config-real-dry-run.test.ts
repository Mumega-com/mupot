// tests/wrangler-config-real-dry-run.test.ts — mupot#1529 round-1 P1-1: drives REAL
// `wrangler deploy --dry-run` (no network call — see scripts/build-pot-worker-bundle.mjs's
// own header for why `--dry-run` is safe to run in this sandbox) through all five
// `--config`/`-c` spellings this repo's own matcher recognizes, PLUS the `--`
// end-of-options case, and asserts which config REAL wrangler actually loaded matches what
// `scripts/lib/wrangler-config-arg.mjs` resolved for that same argv.
//
// This is the check the round-1 adversarial gate ran by hand to disprove the matcher's
// "three spellings" claim — cheap enough (a few real dry-run builds, no bundle to keep) to
// keep in the suite permanently rather than as a one-off manual check.
//
// tests/fixtures/alt-colony.wrangler.toml is a copy of wrangler.example.toml with
// `TENANT_SLUG` changed to a distinctive marker string — real wrangler prints
// `env.TENANT_SLUG ("<value>")` in its dry-run bindings table, which is the observable
// signal proving WHICH config file was actually loaded (wrangler's dry-run output does not
// otherwise surface the config file's own path or `name` field).

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { peekConfigArg, resolveAndStripConfigArg } from '../scripts/lib/wrangler-config-arg.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ALT_CONFIG_PATH = 'tests/fixtures/alt-colony.wrangler.toml'
const ALT_MARKER = 'alt-fixture-marker'

function realWranglerDryRunLoadsAltConfig(configArgv: string[]): boolean {
  const outdir = mkdtempSync(join(tmpdir(), 'mupot-wrangler-config-real-dry-run-'))
  try {
    const result = spawnSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', outdir, ...configArgv], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    return `${result.stdout}${result.stderr}`.includes(ALT_MARKER)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
}

describe('real wrangler dry-run vs. this repo\'s own matcher — every spelling must agree', () => {
  it.each([
    ['--config <path>', ['--config', ALT_CONFIG_PATH]],
    ['--config=<path>', [`--config=${ALT_CONFIG_PATH}`]],
    ['-c <path>', ['-c', ALT_CONFIG_PATH]],
    ['-c=<path>', [`-c=${ALT_CONFIG_PATH}`]],
    ['-c<path> (fused, absolute)', [`-c${join(repoRoot, ALT_CONFIG_PATH)}`]],
  ])('%s: real wrangler loads the alt config, and peekConfigArg/resolveAndStripConfigArg agree', (_label, configArgv) => {
    // Ground truth: does REAL wrangler actually load the alt config for this exact argv?
    expect(realWranglerDryRunLoadsAltConfig(configArgv as string[])).toBe(true)

    // This repo's own resolver must ALSO recognize this exact argv as a config flag, and
    // resolveAndStripConfigArg must strip it completely (nothing left in `rest`, since
    // every case here is JUST the config flag with no other args).
    const resolved = peekConfigArg(configArgv as string[])
    expect(resolved).not.toBeNull()
    const { configPath, rest } = resolveAndStripConfigArg(configArgv as string[])
    expect(configPath).toBe(resolved)
    expect(rest).toEqual([])
    // The resolved value is whichever path we asked wrangler to load (relative for the
    // first four spellings, absolute for the fused case).
    expect(configPath!.endsWith(ALT_CONFIG_PATH)).toBe(true)
  })

  it('a --config after a bare -- is IGNORED by real wrangler AND by resolveAndStripConfigArg alike', () => {
    const argv = ['--', '--config', ALT_CONFIG_PATH]
    expect(realWranglerDryRunLoadsAltConfig(argv)).toBe(false)
    const { configPath, rest } = resolveAndStripConfigArg(argv)
    expect(configPath).toBeNull()
    expect(rest).toEqual(argv)
  })

  it('with NO --config at all, real wrangler does NOT load the alt config (negative control)', () => {
    expect(realWranglerDryRunLoadsAltConfig([])).toBe(false)
    expect(peekConfigArg([])).toBeNull()
  })
}, 120_000)
