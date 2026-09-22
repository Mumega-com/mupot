#!/usr/bin/env node
// scripts/deploy.mjs — the direct-deploy entrypoint for a single pot (`npm run
// deploy`). Wraps `wrangler deploy` and ALWAYS stamps the build with the exact
// commit HEAD is on, via RELEASE_SHA (see scripts/lib/release-sha.mjs and
// src/health.ts / src/dashboard/deployment.ts).
//
// Closes mupot#443 Part A. Before this, GET /health reported `commit: null` in
// production because stamping RELEASE_SHA was a manual step
// (`RELEASE_SHA=$(git rev-parse HEAD) wrangler deploy`) nobody remembered to
// run. Baking it into the tool itself means it is no longer possible to
// forget — every deploy through this entrypoint is stamped, full stop.
//
//   npm run deploy                     # deploy the repo-default wrangler.toml (mumega)
//   npm run deploy -- --config wrangler.acme.toml --message "..."
//
// (any extra args are forwarded to `wrangler deploy` verbatim)
//
// Refuses a dirty working tree by default — the bundle wouldn't correspond to
// any single commit, so the RELEASE_SHA stamp would misreport what's actually
// live. Override with MUPOT_ALLOW_DIRTY_DEPLOY=1 for a deliberate local test
// deploy only; never use this for a real production deploy. Even with the
// override, the stamp is marked non-clean (`-dirty` suffix) — an overridden
// dirty/off-main deploy never gets to look like a verified clean release
// (mupot#571).
//
// RELEASE_SHA is derived from git ONLY. Any extra/forwarded arg that tries to
// smuggle its own `--var RELEASE_SHA:...` is refused outright — see
// assertNoCallerReleaseSha in scripts/lib/release-sha.mjs (mupot#571).
//
// POST-DEPLOY BUNDLE PUBLISH (mupot#1285/#1516 enablement — docs/workflows/
// tenant-provision.md "the actual 'PUT it to R2 after a successful deploy' step in
// scripts/deploy.mjs is the follow-up"). After a successful, CLEAN deploy, this script
// runs scripts/publish-pot-bundle.mjs so the R2 bucket `loadPotWorkerBundle` reads always
// carries THIS deploy's own bundle under its own RELEASE_SHA. A deploy whose bundle fails
// to publish must not report success silently — the publish step's exit code is this
// script's own exit code.
//
// SKIP RECEIPT (Athena round-1 ruling, 2026-09-22). Skipping the publish step is a real
// operational decision, not a no-op — it must be RECEIPTED in the deploy's own output, not
// just left to a comment in this file. `--skip-bundle-publish` REQUIRES a
// `--skip-reason "<why>"` alongside it (refused outright without one, before `wrangler
// deploy` even runs) and prints `bundle_publish: skipped by <actor> reason=<reason>` to
// stdout — `<actor>` is `$USER`, falling back to `git config user.name`. A deploy that is
// not a verified clean release (dirty override, or off-main) skips AUTOMATICALLY, with the
// same receipt line shape but no `--skip-reason` requirement (it is not a human decision —
// its RELEASE_SHA carries a `-dirty` suffix that `assertPublishPreconditions`, scripts/lib/
// pot-bundle-r2.mjs, would refuse anyway).
//
// After a successful publish, this script ALSO runs `scripts/verify-pot-bundle.mjs` before
// ever printing its own "published" receipt (Kasra-core round-2 finding, 2026-09-22) — a
// publish step exiting 0 is not itself proof the object is live and byte-correct; the
// receipt is only as honest as an independent re-GET + digest check makes it.
//
// `--config`/`-c <file>`/`--config=<file>` are all recognized via the SAME
// `scripts/lib/wrangler-config-arg.mjs` matcher `scripts/build-pot-worker-bundle.mjs` uses
// (Kasra-core round-2 finding, 2026-09-22) — matching only the long `--config <file>` form
// let a `-c`/`--config=` deploy silently publish the DEFAULT config's bundle under the
// RELEASE_SHA the RIGHT config's deploy actually stamped.

import { spawnSync } from 'node:child_process'
import { assertNoCallerReleaseSha, isMainDescendant, releaseShaDeployArgs } from './lib/release-sha.mjs'
import { peekConfigArg } from './lib/wrangler-config-arg.mjs'
import { generateBuildInfo } from './generate-build-info.mjs'

// Automatically stamp src/build-info.ts prior to deploy
generateBuildInfo()

function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return (r.stdout || '').trim()
}

/** `$USER`, falling back to `git config user.name`, falling back to 'unknown' — never
 *  throws, never blocks a deploy on identity resolution failing. */
function resolveActor() {
  if (process.env.USER && process.env.USER.trim()) return process.env.USER.trim()
  const name = capture('git', ['config', 'user.name'])
  return name || 'unknown'
}

/** The one place the receipt line's exact shape is built, so the skip path and the
 *  auto-skip path can never drift into two different formats. Printed to STDOUT — this is
 *  a receipt (part of the deploy's own record), not a status message. */
function printBundlePublishSkipReceipt(reason) {
  console.log(`bundle_publish: skipped by ${resolveActor()} reason=${reason}`)
}

const rawArgs = process.argv.slice(2)
const skipBundlePublish = rawArgs.includes('--skip-bundle-publish')
const skipReasonFlagIndex = rawArgs.indexOf('--skip-reason')
const skipReason = skipReasonFlagIndex >= 0 ? rawArgs[skipReasonFlagIndex + 1] : null
// Strip both this script's own flags before forwarding the rest to wrangler — wrangler
// knows neither of them.
const extra = rawArgs.filter((a, i) => a !== '--skip-bundle-publish' && a !== '--skip-reason' && i !== skipReasonFlagIndex + 1)
// Peek-only — NEVER strips --config/-c/--config=<path> from `extra`, which is forwarded to
// `wrangler deploy` byte-for-byte below. Recognizes all three spellings (mupot round-2
// finding, 2026-09-22): matching only the first ('--config') let a `-c`/`--config=` deploy
// silently build+publish the DEFAULT config's bundle instead of the one actually deployed.
const configPath = peekConfigArg(extra)

if (skipBundlePublish && (!skipReason || !skipReason.trim())) {
  console.error(
    '✘ --skip-bundle-publish requires --skip-reason "<why>" — the skip must be receipted, ' +
      'not silent. Example: --skip-bundle-publish --skip-reason "no POT_WORKER_BUNDLE_BUCKET on this colony yet".',
  )
  process.exit(1)
}

try {
  assertNoCallerReleaseSha(extra)
} catch (err) {
  console.error(`✘ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const dirty = capture('git', ['status', '--porcelain']).length > 0
if (dirty && process.env.MUPOT_ALLOW_DIRTY_DEPLOY !== '1') {
  console.error(
    '✘ refusing to deploy from a DIRTY working tree — the deployed bundle would not match ' +
      'any single commit, so RELEASE_SHA (GET /health `commit`) would misreport it. Commit ' +
      'or stash first, or set MUPOT_ALLOW_DIRTY_DEPLOY=1 to override for a deliberate local ' +
      'test deploy (never for production).',
  )
  process.exit(1)
}

const fullSha = capture('git', ['rev-parse', 'HEAD'])
const onMain = isMainDescendant(fullSha)
const clean = !dirty && onMain

if (!clean) {
  console.error(
    `⚠ this deploy is NOT a verified clean release (${dirty ? 'dirty working tree' : "HEAD not on/descended-from 'main'"}) ` +
      "— stamping RELEASE_SHA with a '-dirty' suffix so it can never be mistaken for one.",
  )
}

let releaseArgs
try {
  releaseArgs = releaseShaDeployArgs(fullSha, { clean })
} catch (err) {
  console.error(`✘ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const res = spawnSync('npx', ['wrangler', 'deploy', ...releaseArgs, ...extra], { stdio: 'inherit' })
if (res.status !== 0) {
  // The deploy itself failed — there is no successful build to publish a bundle for.
  process.exit(res.status ?? 1)
}

if (skipBundlePublish) {
  console.error(
    `⚠ bundle publish skipped by explicit flag — pot_provision will refuse this RELEASE_SHA ` +
      `(${fullSha}) with 'no_bundle_source' until a bundle is published for it (unless an ` +
      'explicit worker_js_code fallback is supplied per-call).',
  )
  printBundlePublishSkipReceipt(skipReason)
  process.exit(0)
}

if (!clean) {
  printBundlePublishSkipReceipt(
    `not-a-clean-release (RELEASE_SHA stamped as '${fullSha}-dirty'; publish-pot-bundle.mjs ` +
      'only ever publishes an exact HEAD commit from a clean tree)',
  )
  process.exit(0)
}

const publishArgs = ['scripts/publish-pot-bundle.mjs', '--release-sha', fullSha]
if (configPath) publishArgs.push('--config', configPath)
console.error(`→ deploy succeeded — publishing the bundle: node ${publishArgs.join(' ')}`)
const publish = spawnSync('node', publishArgs, { stdio: 'inherit' })
const retryCmd = `node scripts/publish-pot-bundle.mjs --release-sha ${fullSha}${configPath ? ` --config ${configPath}` : ''}`
if (publish.status !== 0) {
  console.error(
    '✘ the deploy itself succeeded, but publishing its bundle to R2 FAILED (see output ' +
      'above) — this deploy is NOT reporting success, because a tenant provisioned right ' +
      `now would get this RELEASE_SHA's bundle from nowhere. Re-run \`${retryCmd}\` once ` +
      'fixed, or pass --skip-bundle-publish --skip-reason "<why>" if this deploy target ' +
      'deliberately has no bundle bucket wired up.',
  )
  process.exit(publish.status ?? 1)
}

// Kasra-core round-2 finding (2026-09-22): a publish step reporting exit 0 is not itself
// proof the bundle is live and correct — re-verify with an independent re-GET + digest
// check before this script ever prints its own "published" receipt.
console.error(`→ re-verifying the published bundle: node scripts/verify-pot-bundle.mjs ${fullSha}`)
const verify = spawnSync('node', ['scripts/verify-pot-bundle.mjs', fullSha], { stdio: 'inherit' })
if (verify.status !== 0) {
  console.error(
    '✘ the deploy and the publish step both reported success, but the post-publish ' +
      'independent re-verify (re-GET + digest check) FAILED (see output above) — this ' +
      `deploy is NOT reporting success. Re-run \`${retryCmd}\` once fixed.`,
  )
  process.exit(verify.status ?? 1)
}

console.log(`bundle_publish: published by ${resolveActor()} release_sha=${fullSha}`)
process.exit(0)
