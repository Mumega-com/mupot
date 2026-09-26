// tests/publish-pot-bundle-args.test.ts — scripts/publish-pot-bundle.mjs's own
// `--release-sha`/`--bucket`/`--outdir` argv parsing (mupot#1529 round-1 P2(4)).
//
// THE DEFECT: `opts.releaseSha = argv[++i]` (and the `--bucket`/`--outdir` siblings) were
// UNGUARDED — a missing value (flag at the end of argv, or immediately followed by ANOTHER
// recognized flag) silently became `undefined`. For `--release-sha` specifically, that
// falls through to `process.env.RELEASE_SHA || headSha` — a SILENT, WRONG default instead
// of a loud refusal. Same defect class as the round-2 P0 (scripts/deploy.mjs dropping
// rawArgs[0]). Fixed with `requireFlagValue`, which refuses (never defaults) on a missing
// value OR a value that itself looks like a flag.
//
// `parseArgs` runs BEFORE any git/network call in main() — every case here exits 1 with
// zero side effects, so these are cheap real-process spawns (no dirty-tree gate reached).

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function runScript(args: string[]) {
  return spawnSync(process.execPath, ['scripts/publish-pot-bundle.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

describe('scripts/publish-pot-bundle.mjs argv guards (--release-sha / --bucket / --outdir)', () => {
  it.each([
    ['--release-sha at the end of argv with no value', ['--release-sha']],
    ['--release-sha immediately followed by another flag (never absorbed as the value)', ['--release-sha', '--bucket', 'b']],
    ['--release-sha given a dash-value directly', ['--release-sha', '--not-a-sha']],
    ['--bucket at the end of argv with no value', ['--bucket']],
    ['--bucket given a dash-value directly', ['--bucket', '--not-a-bucket']],
    ['--outdir at the end of argv with no value', ['--outdir']],
    ['--outdir given a dash-value directly', ['--outdir', '--not-a-dir']],
  ])('%s → refuses (never silently defaults), zero side effects', (_label, args) => {
    const result = runScript(args as string[])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/requires a value/)
    expect(result.stdout).toBe('') // never reaches the "building bundle via..." progress line
  })

  it('a bare unrecognized flag is still refused the same way it always was', () => {
    const result = runScript(['--not-a-real-flag'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unrecognized argument/)
  })
})
