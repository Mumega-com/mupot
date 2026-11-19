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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs'
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
    // The POSITIVE assertion this test is actually named for: index 0 is PRESENT and
    // correct, not merely "the whole array happens to match" (mupot#1529 round-1 P3 — a
    // prior version of this comment/assertion pair leaned on two negative checks below
    // without ever positively pinning rawArgs[0] itself).
    expect(extra[0]).toBe('--config=wrangler.acme.toml')
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
  // Hardcoded absolute shebang (`process.execPath`, not `/usr/bin/env node`) — a later fake
  // `node` shim on the SAME PATH (see runDeployWithScriptedPublish below) would otherwise
  // shadow the `env node` lookup this script's own shebang depends on.
  writeFileSync(
    npxPath,
    `#!${process.execPath}\n` +
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

  it('THE regression pin: --config=X with NO --skip-reason (and no --skip-bundle-publish at all) reaches wrangler with --config resolved to a canonical --config <path> (was silently dropped at commit 8d8d7af2)', () => {
    // mupot#1529 round-1 P2(2): this test's PREVIOUS body passed `--skip-bundle-publish
    // --skip-reason "..."` despite its own name promising "NO --skip-reason" — the actual
    // P0 scenario (rawArgs.indexOf('--skip-reason') === -1) was never exercised end-to-end.
    // Genuinely omitting BOTH flags here still reaches exit 0 without any real R2/network
    // call: this branch (kasra/pot-bundle-publish-v2) is not a descendant of origin/main,
    // so scripts/deploy.mjs's own auto-skip path (not the explicit-flag path) takes over
    // right after the fake wrangler spawn succeeds — see the assertion on the auto-skip
    // receipt line below, which proves that IS the path taken, not a fluke.
    const { result, recordedArgv } = runDeployWithFakeWrangler(['--config=wrangler.acme.toml'])
    expect(result.status, `deploy.mjs stderr:\n${result.stderr}`).toBe(0)
    expect(recordedArgv).not.toBeNull()
    // scripts/deploy.mjs now resolves the config path ONCE and re-emits it as a canonical
    // `--config <path>` (two tokens) to wrangler, regardless of which spelling the caller
    // used (mupot#1529 round-1 P1-1) — so the ORIGINAL `--config=wrangler.acme.toml` single
    // token is no longer expected verbatim; what matters is wrangler receives the RIGHT
    // path, in the canonical form every downstream consumer (build/publish/verify) also
    // uses.
    const idx = recordedArgv!.indexOf('--config')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(recordedArgv![idx + 1]).toBe('wrangler.acme.toml')
    expect(recordedArgv![0]).toBe('wrangler')
    expect(recordedArgv![1]).toBe('deploy')
    expect(result.stderr).toMatch(/bundle publish skipped automatically/)
  })

  // mupot#1529 round-1 P1-1: scripts/deploy.mjs now resolves the config path ONCE (any of
  // wrangler's five accepted spellings) and re-emits it as a single canonical
  // `--config <path>` to wrangler — never the caller's original spelling. Every spelling
  // below must reach wrangler as the SAME two canonical tokens.
  it.each([
    ['--config X (space-separated)', ['--config', 'wrangler.acme.toml']],
    ['--config=X (single-token)', ['--config=wrangler.acme.toml']],
    ['-c X (short space-separated)', ['-c', 'wrangler.acme.toml']],
    ['-c=X (short single-token)', ['-c=wrangler.acme.toml']],
    ['-cX (short fused, no separator)', ['-cwrangler.acme.toml']],
  ])('%s with --skip-bundle-publish --skip-reason resolves to canonical --config <path> at wrangler', (_label, configArgv) => {
    const { result, recordedArgv } = runDeployWithFakeWrangler([...configArgv, '--skip-bundle-publish', '--skip-reason', 'r'])
    expect(result.status, `deploy.mjs stderr:\n${result.stderr}`).toBe(0)
    const idx = recordedArgv!.indexOf('--config')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(recordedArgv![idx + 1]).toBe('wrangler.acme.toml')
    // Exactly one canonical '--config' token — the original spelling's own token(s) must
    // not additionally survive alongside the canonical rewrite (no double-forwarding).
    expect(recordedArgv!.filter((a) => a === '--config').length).toBe(1)
    expect(recordedArgv).not.toContain('-c')
  })

  it('a --config after a bare -- end-of-options marker is IGNORED, matching real wrangler — never resolved, never stripped', () => {
    const { result, recordedArgv } = runDeployWithFakeWrangler(['--skip-bundle-publish', '--skip-reason', 'r', '--', '--config', 'wrangler.acme.toml'])
    expect(result.status, `deploy.mjs stderr:\n${result.stderr}`).toBe(0)
    // Nothing was resolved as a config, so no canonical --config <path> pair was added —
    // the ONLY '--config' token present is the untouched one after '--', at its original
    // position, forwarded verbatim as plain passthrough (as real wrangler itself treats it).
    const dashDashIdx = recordedArgv!.indexOf('--')
    expect(dashDashIdx).toBeGreaterThanOrEqual(0)
    expect(recordedArgv!.slice(dashDashIdx)).toEqual(['--', '--config', 'wrangler.acme.toml'])
    expect(recordedArgv!.filter((a) => a === '--config').length).toBe(1)
  })

  it('--message m survives alongside --config, with NO --skip-reason and NO --skip-bundle-publish at all', () => {
    // mupot#1529 round-1 P2(2): same mislabel as the regression-pin test above — genuinely
    // omit both flags this time.
    const { result, recordedArgv } = runDeployWithFakeWrangler(['--config=wrangler.acme.toml', '--message', 'a real deploy message'])
    expect(result.status, `deploy.mjs stderr:\n${result.stderr}`).toBe(0)
    expect(recordedArgv).toContain('--message')
    expect(recordedArgv).toContain('a real deploy message')
    // Canonicalized (mupot#1529 round-1 P1-1) — see the regression-pin test's comment above.
    const idx = recordedArgv!.indexOf('--config')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(recordedArgv![idx + 1]).toBe('wrangler.acme.toml')
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

  // mupot#1529 round-1 P2(3), M14: pin the auto-skip warning's FULL content (not just a
  // substring match) — a mutation deleting this console.error call entirely (survived at
  // 134/134 per the round-1 ledger) must go red here. This branch is naturally reachable
  // on this worktree: this feature branch is not (yet) a descendant of origin/main, so
  // `isMainDescendant` is false and `clean` is false without needing --skip-bundle-publish
  // at all.
  it('M14 pin: the auto-skip warning names BOTH no_bundle_source and the exact -dirty-suffixed RELEASE_SHA stamp', () => {
    const { result } = runDeployWithFakeWrangler(['--config=wrangler.acme.toml'])
    expect(result.status, `deploy.mjs stderr:\n${result.stderr}`).toBe(0)
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim()
    expect(result.stderr).toContain('bundle publish skipped automatically (not a clean release)')
    expect(result.stderr).toContain("pot_provision will refuse this RELEASE_SHA")
    expect(result.stderr).toContain(`(${headSha}-dirty)`)
    expect(result.stderr).toContain("'no_bundle_source'")
    expect(result.stdout).toContain('bundle_publish: skipped by')
    expect(result.stdout).toContain(`RELEASE_SHA stamped as '${headSha}-dirty'`)
  })
})

// ── A "clean, on-main" scratch repo — for the two exit-code branches only reachable PAST
// both skip checks (mupot#1529 round-1 P2(3), M20) ────────────────────────────────────
//
// scripts/deploy.mjs's own `capture('git', [...])` calls (and generate-build-info.mjs's)
// read git state relative to the CHILD PROCESS's cwd, not this repo's — so spawning
// scripts/deploy.mjs with `cwd` pointed at a throwaway git repo that genuinely IS on
// `main`, with a clean tree, makes `isMainDescendant` / the dirty check answer `true`/
// `false` for real, without needing to merge or rebase this feature branch onto main.
// Module imports (`./lib/*.mjs`) are unaffected — those resolve against deploy.mjs's own
// file location, not `cwd`.
function makeCleanMainGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mupot-clean-main-repo-'))
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-q', '-b', 'main'])
  // generate-build-info.mjs (run unconditionally at scripts/deploy.mjs's top) writes
  // src/build-info.ts relative to cwd — an UNTRACKED file here would make the very next
  // `git status --porcelain` dirty, defeating the whole point of this scratch repo. Mirror
  // the real repo's own .gitignore rule for this one path.
  writeFileSync(join(dir, '.gitignore'), 'src/build-info.ts\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  git(['add', '.gitignore'])
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init'])
  return dir
}

/**
 * Spawns scripts/deploy.mjs with `cwd` pointed at a clean, on-`main` scratch repo (so
 * `clean` is `true` inside deploy.mjs — past BOTH skip branches) and a fake `node` shim on
 * PATH that intercepts ONLY the `publish-pot-bundle.mjs`/`verify-pot-bundle.mjs` spawns
 * (by argv pattern), returning scripted exit codes/output instead of ever running the real
 * scripts (no real R2/network call). The fake `npx`/wrangler shim is reused unchanged.
 */
function runDeployOnCleanRepoWithScriptedPublish(
  extraArgs: string[],
  opts: { publishExitCode?: number; publishStderr?: string; verifyExitCode?: number } = {},
) {
  const { publishExitCode = 0, publishStderr = '', verifyExitCode = 0 } = opts
  const cleanRepoDir = makeCleanMainGitRepo()
  const shimDir = mkdtempSync(join(tmpdir(), 'mupot-fake-node-'))
  const npxPath = join(shimDir, 'npx')
  const nodePath = join(shimDir, 'node')
  try {
    // Fake wrangler: always "succeeds" — this test is not about the wrangler call itself.
    writeFileSync(npxPath, `#!${process.execPath}\nprocess.exit(0)\n`)
    chmodSync(npxPath, 0o755)
    // Fake node: intercepts ONLY the two scripts deploy.mjs spawns via `node <script>`,
    // by recognizing the script path in argv — anything else (there shouldn't be anything
    // else on this PATH) falls through to the REAL node so nothing else silently breaks.
    writeFileSync(
      nodePath,
      `#!${process.execPath}\n` +
        'const args = process.argv.slice(2)\n' +
        `const PUBLISH_EXIT = ${JSON.stringify(publishExitCode)}\n` +
        `const PUBLISH_STDERR = ${JSON.stringify(publishStderr)}\n` +
        `const VERIFY_EXIT = ${JSON.stringify(verifyExitCode)}\n` +
        'if (args.some((a) => a.includes("publish-pot-bundle.mjs"))) {\n' +
        '  if (PUBLISH_STDERR) process.stderr.write(PUBLISH_STDERR + "\\n")\n' +
        '  process.exit(PUBLISH_EXIT)\n' +
        '}\n' +
        'if (args.some((a) => a.includes("verify-pot-bundle.mjs"))) {\n' +
        '  process.exit(VERIFY_EXIT)\n' +
        '}\n' +
        `import("node:child_process").then(({ spawnSync }) => {\n` +
        `  const r = spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: "inherit" })\n` +
        '  process.exit(r.status ?? 1)\n' +
        '})\n',
    )
    chmodSync(nodePath, 0o755)
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/deploy.mjs'), ...extraArgs], {
      cwd: cleanRepoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        USER: 'deploy-args-test-user',
      },
    })
    return { result, cleanRepoDir }
  } finally {
    rmSync(shimDir, { recursive: true, force: true })
    rmSync(cleanRepoDir, { recursive: true, force: true })
  }
}

describe('scripts/deploy.mjs — exit codes past both skip checks (clean, on-main scratch repo)', () => {
  // mupot#1529 round-1 P2(3), M20: pin the operator-facing message deploy.mjs prints when
  // the publish step exits with BUNDLE_PUBLISH_UNCONFIRMED_EXIT_CODE — deletable whole at
  // 134/134 per the round-1 ledger without any test noticing.
  it('M20 pin: publish exiting with BUNDLE_PUBLISH_UNCONFIRMED_EXIT_CODE (3) prints the unconfirmed-specific message and propagates the exit code', () => {
    const { result } = runDeployOnCleanRepoWithScriptedPublish([], {
      publishExitCode: 3,
      publishStderr: '✘ cannot confirm the publish outcome (scripted by test)',
    })
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('could not be CONFIRMED either way')
    expect(result.stderr).toContain('Recovering from a digest mismatch')
    // Must NOT be conflated with the sha-conflict message (different exit code, different
    // recovery advice — an unconfirmed outcome is not a proven conflict).
    expect(result.stderr).not.toContain('already has a DIFFERENT bundle published')
  })

  it('sha-conflict pin: publish exiting with BUNDLE_SHA_CONFLICT_EXIT_CODE (2) names the real recovery procedure, never "re-run publish" alone', () => {
    const { result } = runDeployOnCleanRepoWithScriptedPublish([], {
      publishExitCode: 2,
      publishStderr: '✘ refusing to publish: a DIFFERENT digest already exists (scripted by test)',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('already has a DIFFERENT bundle published')
    expect(result.stderr).toContain('wrangler r2 object delete')
    expect(result.stderr).toContain('Recovering from a digest mismatch')
  })

  it('a clean deploy with publish AND verify both succeeding prints the final published receipt', () => {
    const { result } = runDeployOnCleanRepoWithScriptedPublish([], { publishExitCode: 0, verifyExitCode: 0 })
    expect(result.status, `deploy.mjs stderr:\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('bundle_publish: published by')
  })
}, 60_000)
