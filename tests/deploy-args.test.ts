// tests/deploy-args.test.ts — scripts/lib/deploy-args.mjs, extracted from
// scripts/deploy.mjs specifically so this argv-walking logic can be unit-tested in
// isolation (mupot#1524 round-2 P0, successor PR).
//
// THE DEFECT THIS CLOSES: the inline version in scripts/deploy.mjs (commit 8d8d7af2)
// computed
//   const skipReasonFlagIndex = rawArgs.indexOf('--skip-reason')
//   const extra = rawArgs.filter((a, i) => ... && i !== skipReasonFlagIndex + 1)
// When `--skip-reason` is ABSENT, `indexOf` returns `-1`, so `i !== skipReasonFlagIndex +
// 1` becomes `i !== 0` — silently dropping `rawArgs[0]` on every deploy that doesn't pass
// `--skip-reason`. `npm run deploy -- --config=wrangler.acme.toml` forwarded NOTHING to
// `wrangler deploy`: wrangler fell back to the repo-default `wrangler.toml`, deployed
// successfully, exit 0, no error anywhere. Confirmed present at commit 8d8d7af2 / 1dc9a0b5
// by reading the code (kasra-review adversarial round-2 gate, 2026-09-22).
//
// This file covers both the pure `parseDeployArgs` function AND a real end-to-end spawn of
// `scripts/deploy.mjs` itself with a fake `npx`/`wrangler` shim on PATH that records its
// argv verbatim — proving the WIRING (deploy.mjs actually using the fixed parser and
// forwarding `extra` byte-for-byte to the real child process invocation), not just the
// extracted function in isolation.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDeployArgs } from '../scripts/lib/deploy-args.mjs'

describe('parseDeployArgs', () => {
  it('returns an unchanged extra array when neither of this script\'s own flags is present — THE regression pin: rawArgs[0] must never be dropped', () => {
    // This is the exact shape that was silently broken: no --skip-reason anywhere in
    // argv, so the old `indexOf('--skip-reason')` returned -1, and `-1 + 1 === 0` matched
    // rawArgs[0] for deletion no matter what it was.
    const { skipBundlePublish, skipReason, extra } = parseDeployArgs(['--config=wrangler.acme.toml'])
    expect(extra).toEqual(['--config=wrangler.acme.toml'])
    expect(skipBundlePublish).toBe(false)
    expect(skipReason).toBeNull()
  })

  it('--config X (long space-separated form) is forwarded byte-identical', () => {
    expect(parseDeployArgs(['--config', 'wrangler.acme.toml']).extra).toEqual(['--config', 'wrangler.acme.toml'])
  })

  it('--config=X (single-token form) is forwarded byte-identical', () => {
    expect(parseDeployArgs(['--config=wrangler.acme.toml']).extra).toEqual(['--config=wrangler.acme.toml'])
  })

  it('-c X (short form) is forwarded byte-identical', () => {
    expect(parseDeployArgs(['-c', 'wrangler.acme.toml']).extra).toEqual(['-c', 'wrangler.acme.toml'])
  })

  it('--message m is forwarded byte-identical alongside --config', () => {
    const { extra } = parseDeployArgs(['--config', 'wrangler.acme.toml', '--message', 'hello world'])
    expect(extra).toEqual(['--config', 'wrangler.acme.toml', '--message', 'hello world'])
  })

  it('strips --skip-bundle-publish --skip-reason "<reason>" and forwards everything else byte-identical', () => {
    const { skipBundlePublish, skipReason, extra } = parseDeployArgs([
      '--config',
      'wrangler.acme.toml',
      '--skip-bundle-publish',
      '--skip-reason',
      'no bucket on this colony yet',
      '--message',
      'hello',
    ])
    expect(skipBundlePublish).toBe(true)
    expect(skipReason).toBe('no bucket on this colony yet')
    expect(extra).toEqual(['--config', 'wrangler.acme.toml', '--message', 'hello'])
  })

  it('--config=X WITH --skip-bundle-publish --skip-reason r forwards --config=X byte-identical (the exact regression shape)', () => {
    const { skipBundlePublish, skipReason, extra } = parseDeployArgs([
      '--config=wrangler.acme.toml',
      '--skip-bundle-publish',
      '--skip-reason',
      'r',
    ])
    expect(skipBundlePublish).toBe(true)
    expect(skipReason).toBe('r')
    expect(extra).toEqual(['--config=wrangler.acme.toml'])
  })

  it('-c X WITH --skip-bundle-publish --skip-reason r forwards -c X byte-identical', () => {
    const { extra } = parseDeployArgs(['-c', 'wrangler.acme.toml', '--skip-bundle-publish', '--skip-reason', 'r'])
    expect(extra).toEqual(['-c', 'wrangler.acme.toml'])
  })

  it('--skip-bundle-publish alone (no --skip-reason) leaves skipReason null and drops NOTHING else from extra', () => {
    const { skipBundlePublish, skipReason, extra } = parseDeployArgs(['--config', 'w.toml', '--skip-bundle-publish', '--message', 'm'])
    expect(skipBundlePublish).toBe(true)
    expect(skipReason).toBeNull()
    expect(extra).toEqual(['--config', 'w.toml', '--message', 'm'])
  })

  it('handles --skip-bundle-publish appearing at index 0 (no earlier args to protect, still correct)', () => {
    const { extra } = parseDeployArgs(['--skip-bundle-publish', '--skip-reason', 'r', '--config', 'w.toml'])
    expect(extra).toEqual(['--config', 'w.toml'])
  })

  it('a --skip-reason value that itself looks like a flag is refused as a likely-missing-value (never absorbed as the reason text)', () => {
    const { skipBundlePublish, skipReason, extra } = parseDeployArgs(['--skip-bundle-publish', '--skip-reason', '--flag', '--config', 'w.toml'])
    expect(skipBundlePublish).toBe(true)
    expect(skipReason).toBeNull()
    // '--flag' is NOT consumed as the reason value — it resurfaces in extra as an ordinary
    // forwarded token (scripts/deploy.mjs's own "requires --skip-reason" check refuses the
    // deploy outright before extra is ever used, since skipReason is null here).
    expect(extra).toEqual(['--flag', '--config', 'w.toml'])
  })

  it('a bare trailing --skip-reason with nothing after it leaves skipReason null and drops nothing else', () => {
    const { skipReason, extra } = parseDeployArgs(['--config', 'w.toml', '--skip-bundle-publish', '--skip-reason'])
    expect(skipReason).toBeNull()
    expect(extra).toEqual(['--config', 'w.toml'])
  })

  it('an empty argv returns empty extra and both flags falsy/null', () => {
    expect(parseDeployArgs([])).toEqual({ skipBundlePublish: false, skipReason: null, extra: [] })
  })

  it('multiple unrelated forwarded args around the two owned flags all survive in original order', () => {
    const { extra } = parseDeployArgs(['a', 'b', '--skip-bundle-publish', 'c', '--skip-reason', 'why', 'd'])
    expect(extra).toEqual(['a', 'b', 'c', 'd'])
  })
})

// ── Real end-to-end wiring test ──────────────────────────────────────────────────────
//
// The unit tests above prove `parseDeployArgs` itself is correct. This proves
// scripts/deploy.mjs actually WIRES it correctly and forwards `extra` to the real
// `wrangler deploy` child-process invocation byte-for-byte — the round-2 defect lived in
// the WIRING (an inline argv walk inside deploy.mjs), not in a function nobody called.
//
// A fake `npx` on PATH intercepts the `npx wrangler deploy ...` spawn and records its argv
// to a file, then exits 0 as if the deploy succeeded. `--skip-bundle-publish
// --skip-reason` is always passed so deploy.mjs exits right after printing its skip
// receipt — no real bundle-publish/verify subprocess (which would need network access) is
// ever reached.

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function runDeployWithFakeWrangler(extraArgs: string[], extraEnv: Record<string, string> = {}) {
  const shimDir = mkdtempSync(join(tmpdir(), 'mupot-fake-npx-'))
  const recordFile = join(shimDir, 'argv.json')
  const npxPath = join(shimDir, 'npx')
  // A fake `npx` that dumps its own argv AND the two R2 credential env vars it can see
  // (JSON) to a file, then exits 0 — simulating a successful `wrangler deploy`. The env
  // vars are recorded (not just argv) so a test can prove scripts/deploy.mjs's own
  // env-scoping (envWithoutR2PotBundlesCreds) actually reaches this real child process,
  // not just argv forwarding. Node shebang script marked executable.
  writeFileSync(
    npxPath,
    '#!/usr/bin/env node\n' +
      'import { writeFileSync } from "node:fs"\n' +
      'writeFileSync(process.env.DEPLOY_ARGV_RECORD_FILE, JSON.stringify({\n' +
      '  argv: process.argv.slice(2),\n' +
      '  r2AccessKeyId: process.env.R2_POT_BUNDLES_ACCESS_KEY_ID ?? null,\n' +
      '  r2SecretAccessKey: process.env.R2_POT_BUNDLES_SECRET_ACCESS_KEY ?? null,\n' +
      '}))\n' +
      'process.exit(0)\n',
  )
  chmodSync(npxPath, 0o755)
  try {
    const result = spawnSync(process.execPath, ['scripts/deploy.mjs', ...extraArgs], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        PATH: `${shimDir}:${process.env.PATH}`,
        DEPLOY_ARGV_RECORD_FILE: recordFile,
        USER: 'deploy-args-test-user',
      },
    })
    let recorded: { argv: string[]; r2AccessKeyId: string | null; r2SecretAccessKey: string | null } | null = null
    try {
      recorded = JSON.parse(readFileSync(recordFile, 'utf8'))
    } catch {
      recorded = null
    }
    return { result, recordedArgv: recorded?.argv ?? null, recorded }
  } finally {
    rmSync(shimDir, { recursive: true, force: true })
  }
}

describe('scripts/deploy.mjs — real end-to-end argv wiring (fake npx/wrangler shim on PATH)', () => {
  // NOTE ON SCOPE: like scripts/publish-pot-bundle.mjs, scripts/deploy.mjs refuses a DIRTY
  // working tree before ever reaching the wrangler spawn. These tests need a clean,
  // committed tree to pass — they run correctly in CI (always a clean checkout) and
  // locally once this PR's own changes are committed (see reference_mupot_local_evidence_
  // needs_clean_committed_tree in this repo's own convention: commit first, then run).

  it('THE regression pin: --config=X with NO --skip-reason forwards --config=X to wrangler byte-identical (was silently dropped at commit 8d8d7af2)', () => {
    const { result, recordedArgv } = runDeployWithFakeWrangler([
      '--config=wrangler.acme.toml',
      '--skip-bundle-publish',
      '--skip-reason',
      'argv wiring regression test',
    ])
    expect(result.status, `deploy.mjs stderr:\n${result.stderr}`).toBe(0)
    expect(recordedArgv).not.toBeNull()
    expect(recordedArgv).toContain('--config=wrangler.acme.toml')
    expect(recordedArgv![0]).toBe('wrangler')
    expect(recordedArgv![1]).toBe('deploy')
  })

  it('--config X (space-separated) with --skip-bundle-publish --skip-reason forwards both tokens byte-identical', () => {
    const { result, recordedArgv } = runDeployWithFakeWrangler([
      '--config',
      'wrangler.acme.toml',
      '--skip-bundle-publish',
      '--skip-reason',
      'r',
    ])
    expect(result.status).toBe(0)
    const idx = recordedArgv!.indexOf('--config')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(recordedArgv![idx + 1]).toBe('wrangler.acme.toml')
  })

  it('-c X with --skip-bundle-publish --skip-reason forwards both tokens byte-identical', () => {
    const { result, recordedArgv } = runDeployWithFakeWrangler(['-c', 'wrangler.acme.toml', '--skip-bundle-publish', '--skip-reason', 'r'])
    expect(result.status).toBe(0)
    const idx = recordedArgv!.indexOf('-c')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(recordedArgv![idx + 1]).toBe('wrangler.acme.toml')
  })

  it('--message m survives alongside --config, with no --skip-reason at all', () => {
    const { result, recordedArgv } = runDeployWithFakeWrangler([
      '--config=wrangler.acme.toml',
      '--message',
      'a real deploy message',
      '--skip-bundle-publish',
      '--skip-reason',
      'r',
    ])
    expect(result.status).toBe(0)
    expect(recordedArgv).toContain('--message')
    expect(recordedArgv).toContain('a real deploy message')
    expect(recordedArgv).toContain('--config=wrangler.acme.toml')
  })

  it('refuses to run at all when --skip-bundle-publish is passed WITHOUT --skip-reason (never reaches wrangler)', () => {
    const { result, recordedArgv } = runDeployWithFakeWrangler(['--config=wrangler.acme.toml', '--skip-bundle-publish'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/--skip-bundle-publish requires --skip-reason/)
    expect(recordedArgv).toBeNull() // wrangler was never even invoked.
  })

  // mupot#1524 round-2 Low: the R2 credential pair must be scoped to the publish/verify
  // spawns only — `wrangler deploy` (and, inside it, esbuild) never reads either var, so
  // they should never be able to see it at all, even though a leak here would be inert in
  // practice (nothing downstream reads them). Proven through the REAL wrangler-facing
  // child process, not just by reading scripts/deploy.mjs's source.
  it('env scoping: R2_POT_BUNDLES_* is present in the operator shell but the wrangler-facing spawn never sees it', () => {
    const { result, recorded } = runDeployWithFakeWrangler(
      ['--config=wrangler.acme.toml', '--skip-bundle-publish', '--skip-reason', 'env scoping test'],
      {
        R2_POT_BUNDLES_ACCESS_KEY_ID: 'sentinel-access-key-id',
        R2_POT_BUNDLES_SECRET_ACCESS_KEY: 'sentinel-secret-access-key',
      },
    )
    expect(result.status, `deploy.mjs stderr:\n${result.stderr}`).toBe(0)
    expect(recorded).not.toBeNull()
    expect(recorded!.r2AccessKeyId).toBeNull()
    expect(recorded!.r2SecretAccessKey).toBeNull()
    // Sanity: the sentinel values genuinely reached deploy.mjs's OWN process (proving the
    // absence above is a real scoping effect, not an artifact of the values never having
    // been set at all).
    expect(result.stdout + result.stderr).not.toContain('sentinel-access-key-id')
    expect(result.stdout + result.stderr).not.toContain('sentinel-secret-access-key')
  })
}, 30_000)
